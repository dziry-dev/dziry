/**
 * Recording proxies for route data and error — the two cells a route object's
 * loader fills.
 *
 * A route object declares 'component' (reads 'data') and 'errorComponent'
 * (reads 'error'). The compiler calls each against a proxy that *records* the
 * access path instead of returning a value, so {data.title} reaches the tree
 * as "this node's text is the title read out of the loader's success value"
 * rather than as a string frozen at build time. This is the same trick
 * item-path.ts uses for list rows and route-args.ts uses for parameters, and
 * the same reason the kinds stay distinct: a list item's read is a path into
 * a row, a parameter's is a name the matcher binds, and these two are paths
 * into the loader's exit — three values that arrive at the same functions and
 * mean different things. One shared brand would let the compiler mistake one
 * for another exactly where the difference decides where the value comes from.
 *
 * Data and error are themselves kept apart rather than one "cell" kind,
 * because they resolve against different runtime storage: applyDataBindings
 * reads the success value, applyErrorBindings reads the failure value. A
 * loader that fails does not also write success, so a component that read one
 * of them as the other would render blank forever and never say why.
 */
import { sentinel } from "./sentinel.ts";
import type { ItemPath } from "./item-path.ts";

const DATA = Symbol.for("skia-proto.routeData");
const ERROR = Symbol.for("skia-proto.routeError");

const DATA_MARK = sentinel("routeData");
const ERROR_MARK = sentinel("routeError");

type Kind = "data" | "error";

function record(kind: Kind, path: ItemPath = []): Record<string, unknown> {
  const brand = kind === "data" ? DATA : ERROR;
  const mark = kind === "data" ? DATA_MARK : ERROR_MARK;

  return new Proxy(Object.create(null) as Record<string, unknown>, {
    get(_target, prop) {
      if (prop === brand) return path;

      // An accidental stringification must not produce a *usable* string — the same
      // un-internable marker item-path.ts and route-args.ts already rely on, so a
      // leak is a build error naming the path rather than a constant frozen in.
      if (prop === Symbol.toPrimitive || prop === "toString" || prop === Symbol.toStringTag) {
        return () => mark.wrap(path.join(".") || "<root>");
      }

      // Any other symbol is someone else's brand check — isSignal reads its own
      // symbol off whatever it is handed, and isRecorder/isRouteParam do the
      // same. Answering here would let the proxy nest under a probe, so it yields
      // undefined, which is the "not mine" every one of those checks wants.
      if (typeof prop === "symbol") return undefined;

      const key = prop;
      return record(kind, [...path, /^\d+$/.test(key) ? Number(key) : key]);
    },

    /**
     * Spreading records nothing: a recorder has no keys, because no loader exit
     * exists yet. Left to the default this fails silently — <Row {...data} />
     * yields empty props and the row renders blank.
     */
    ownKeys() {
      throw new RouteDataSpreadError(kind, path);
    },
  });
}

/** The 'data' prop a route object's 'component' is called with. */
export function dataRecorder(): Record<string, unknown> {
  return record("data");
}

/** The 'error' prop a route object's 'errorComponent' is called with. */
export function errorRecorder(): Record<string, unknown> {
  return record("error");
}

export function isRouteData(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as Record<symbol, unknown>)[DATA])
  );
}

export function isRouteError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as Record<symbol, unknown>)[ERROR])
  );
}

export function routeDataPath(value: unknown): ItemPath {
  return (value as Record<symbol, ItemPath>)[DATA] ?? [];
}

export function routeErrorPath(value: unknown): ItemPath {
  return (value as Record<symbol, ItemPath>)[ERROR] ?? [];
}

export class RouteDataSpreadError extends Error {
  constructor(kind: Kind, path: ItemPath) {
    super(
      `cannot spread route ${kind} (\`{...${kind}}\` at ${kind}.${path.join(".") || "<root>"}).\n` +
        `  The component runs once against a recording proxy, so the ${kind} keys are not\n` +
        `  known at build time. Read the properties you need explicitly:\n` +
        `    <Row title={${kind}.title} />`,
    );
    this.name = "RouteDataSpreadError";
  }
}
