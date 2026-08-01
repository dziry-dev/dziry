/**
 * Route parameters, as build-time recorders.
 *
 * `useRoute("products/$id")` runs during compilation, where no product id
 * exists — so `args.id` cannot be a value. It is the same problem list items
 * have, and it gets the same answer as `item-path.ts`: hand back a proxy that
 * *records* the read, so `{args.id}` reaches the compiler as "this node's text is
 * the id parameter" rather than as a string that got frozen into the tree.
 *
 * Deliberately parallel to `item-path.ts` rather than shared with it. Both record
 * a read, but a list item's read is a path into a row and a parameter's read is a
 * name bound by the matcher; giving them one brand would let the compiler mistake
 * one for the other in exactly the place where the difference decides where the
 * value comes from.
 */

const PARAM = Symbol.for("skia-proto.routeParam");

/**
 * The `$` segments of a route path, `$` stripped, in order.
 *
 * One definition, used by both halves: the scan derives a route's parameters from
 * its file path, and `useRoute` derives the same set from the string the page
 * repeated. Two copies of this would let the two disagree about a path they both
 * accept.
 */
export function paramsOfPath(path: string): string[] {
  if (path === "/") return [];
  return path
    .split("/")
    .filter((s) => s.startsWith("$"))
    .map((s) => s.slice(1));
}

/**
 * The marker a stringified parameter produces.
 *
 * NUL-free but un-internable for the same reason as the item marker: `internString`
 * refuses it, so computing with a parameter fails the build instead of freezing one
 * constant into the page.
 */
const SENTINEL_MARK = " dziri:param ";

function sentinel(name: string): string {
  return `${SENTINEL_MARK}${name}${SENTINEL_MARK}`;
}

/** A single parameter read — `args.id`. */
function param(name: string): Record<string | symbol, unknown> {
  return new Proxy(Object.create(null) as Record<string, unknown>, {
    get(_target, prop) {
      if (prop === PARAM) return name;

      if (prop === Symbol.toPrimitive || prop === "toString" || prop === Symbol.toStringTag) {
        return () => sentinel(name);
      }

      // Any other symbol is someone else's brand check — `isRecorder` reads its
      // own symbol off whatever it is handed, and `isSignal` uses `in`. Throwing
      // at a probe would make this proxy unable to travel through the code that
      // has to identify it.
      if (typeof prop === "symbol") return undefined;

      // A parameter is a string the matcher bound; it has no properties worth
      // recording, so `args.id.length` is a computation rather than a read and
      // the error is more useful than a nested recorder would be.
      throw new ParamExpressionError(sentinel(name));
    },

    ownKeys() {
      throw new ParamExpressionError(sentinel(name));
    },
  });
}

/**
 * `args` for a route with these parameters.
 *
 * Reading a name the route does not have throws rather than yielding `undefined`.
 * The type already rejects it; this catches the case where the type was widened —
 * a `Record<string, string>` prop, a dynamic key — and would otherwise render
 * blank.
 */
export function routeArgs(path: string, names: readonly string[]): Record<string, unknown> {
  const declared = new Set(names);

  return new Proxy(Object.create(null) as Record<string, unknown>, {
    get(_target, prop) {
      if (typeof prop === "symbol") return undefined;
      if (!declared.has(prop)) {
        throw new UnknownParamError(path, prop, names);
      }
      return param(prop);
    },

    has(_target, prop) {
      return typeof prop === "string" && declared.has(prop);
    },

    ownKeys() {
      return [...declared];
    },

    getOwnPropertyDescriptor() {
      return { enumerable: true, configurable: true };
    },
  });
}

export class UnknownParamError extends Error {
  constructor(path: string, name: string, declared: readonly string[]) {
    const has =
      declared.length === 0
        ? `"${path}" has no parameters`
        : `"${path}" has ${declared.map((d) => `$${d}`).join(", ")}`;
    super(
      `useRoute("${path}") has no parameter "${name}" — ${has}.\n` +
        `  Parameters come from the file path: a $segment in windows/*/pages/** is one,\n` +
        `  and nothing else is.`,
    );
    this.name = "UnknownParamError";
  }
}

/** True if `value` is text produced by stringifying a parameter recorder. */
export function isParamSentinel(value: string): boolean {
  return value.includes(SENTINEL_MARK);
}

export function isRouteParam(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<symbol, unknown>)[PARAM] === "string"
  );
}

export function paramNameOf(value: unknown): string {
  const name = (value as Record<symbol, unknown>)[PARAM];
  if (typeof name !== "string") throw new Error("not a route parameter");
  return name;
}

/**
 * A bare `{args.id}`, which is right and does not work yet.
 *
 * Its own error rather than `ParamExpressionError`, because the diagnosis differs:
 * nothing was computed, so telling the author to use `computed()` would be advice
 * for a mistake they did not make. The recorder reaches the tree exactly as it
 * should and the emitter has nothing to do with it, which is a hole in the
 * compiler and should read as one.
 */
export class ParamNotEmittedError extends Error {
  constructor(name: string) {
    super(
      `a route parameter cannot be rendered yet (args.${name}).\n` +
        `  useRoute types its args and the compiler checks the path against the file, but\n` +
        `  turning a parameter read into a text binding is the next piece of the router and\n` +
        `  is not built. Until it is, a page can name its route but not display the value.`,
    );
    this.name = "ParamNotEmittedError";
  }
}

/**
 * Turns a leaked sentinel into the error the author needs.
 *
 * Every route that reaches here computed with a parameter instead of reading it.
 * The advice differs from the list-item case: a row can carry a derived field,
 * but a parameter is bound by the matcher at navigation, so the derivation has to
 * happen in the page rather than in the data.
 */
export class ParamExpressionError extends Error {
  constructor(text: string) {
    const name = text.split(SENTINEL_MARK)[1] ?? "<unknown>";
    super(
      `a route parameter was used in an expression, not read as a value (args.${name}).\n` +
        `  useRoute runs at build time, where no parameter has a value yet — it can record\n` +
        `  \`{args.${name}}\`, a bare read, but not anything computed from one.\n` +
        `    not:  {\`#\${args.${name}}\`}      {args.${name}.toUpperCase()}      {Number(args.${name})}\n` +
        `    but:  #{args.${name}}          {args.${name}}\n` +
        `  A value derived from a parameter belongs in a computed() that reads it, so the\n` +
        `  derivation happens per navigation rather than once at build time.`,
    );
    this.name = "ParamExpressionError";
  }
}
