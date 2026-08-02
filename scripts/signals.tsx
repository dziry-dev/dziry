/** @jsxImportSource ../src/compiler */

/**
 * What the compiler sees when a signal reaches JSX.
 *
 *   bun run signals
 *   bun run signals --verbose     # print the full node, not just the summary
 *
 * A bench, not a test — though it doubles as one. Every row is an authoring form
 * and what compiling it actually produces, so a change to `readValue`, `flatten` or
 * `normalize` shows up here as a row flipping rather than as a golden diff three
 * scripts away.
 *
 * The `want` column is the design, written down. It is what makes this readable as
 * a spec: rows marked `bind` that report `text` are the *silent* failures — a
 * frozen initial value that renders once, correctly, and never updates while the
 * build prints success. That failure is the reason the recorders and sentinels
 * exist at all, and this file is where the remaining holes in them are visible.
 *
 * Add a case by adding a line to `CASES`. Nothing else needs touching.
 */
import { computed, setCompiling, signal } from "../src/runtime/signal.ts";
import { jsx, type Child } from "../src/compiler/jsx-runtime.ts";
import { useRouter, withWindowRoute, routePathBehind } from "../src/compiler/route.ts";
import { buildRefIndex, resolveRefs } from "../src/compiler/resolve-refs.ts";
import type { CompileResult } from "../src/compiler/compile.ts";
import type { DynText, Element, Node, TextPart } from "../src/compiler/html.ts";

const VERBOSE = process.argv.includes("--verbose");

// ---------------------------------------------------------------------------
// The state under test. Module-level exports, because that is the rule today:
// the artifact imports every signal by name, so one created inside a component
// has nowhere to live.
// ---------------------------------------------------------------------------

const count = signal(7);
const label = signal("hi");
const items = signal(["a", "b"]);
const isBig = computed(() => count.value > 3);
const route = signal("products/new");

/** What a form is supposed to compile to. */
type Want =
  /** A live binding — the node updates when the signal changes. */
  | "bind"
  /** A constant, correctly: nothing reactive was mentioned. */
  | "static"
  /** A named build error, because there is nowhere to put a subscription. */
  | "error";

type Case = {
  form: string;
  want: Want;
  /** Returns the children of one element, or throws. */
  run: () => Node[];
  note?: string;
};

/**
 * Compiles `children` the way an element would, and hands back the result.
 *
 * `children` is `unknown` and cast on the way in, because some cases here are forms
 * the authoring types deliberately refuse — `RoutePath` is opaque so it cannot be
 * compared, and `{router.path.value}` is not a `Child` as far as `tsc` is concerned.
 * A harness whose job is to show what the *compiler* does with a form cannot also be
 * where the authoring types are enforced.
 */
const el = (children: unknown): Node[] =>
  (jsx("div", { children: children as Child }) as Element).children;

const CASES: Case[] = [
  // -- the sugar, which works -------------------------------------------------
  { form: "{count}", want: "bind", run: () => el(count) },
  { form: "{isBig}", want: "bind", run: () => el(isBig) },
  { form: "count: {count}", want: "bind", run: () => el(["count: ", count]) },
  { form: "{count} of {items}", want: "bind", run: () => el([count, " of ", items]) },

  // -- the explicit form, which is the point of this file ---------------------
  {
    form: "{count.value}",
    want: "bind",
    run: () => el(count.value),
    note: "the read a reader expects to be transparent",
  },
  {
    form: "{label.value}",
    want: "bind",
    run: () => el(label.value),
    note: "a string, so a frozen answer looks completely plausible",
  },
  {
    form: "{isBig.value}",
    want: "bind",
    run: () => el(isBig.value),
    note: "a boolean — JSX drops those, so a freeze renders *nothing*",
  },
  {
    form: "`n is ${count.value}`",
    want: "bind",
    run: () => el(`n is ${count.value}`),
    note: "interpolation has to survive, or the literals are lost",
  },

  // -- the route, which already does this -------------------------------------
  {
    form: "{router.path}",
    want: "bind",
    run: () => withWindowRoute(route, () => el(useRouter().path)),
  },
  {
    form: "{router.path.value}",
    want: "bind",
    run: () => withWindowRoute(route, () => el(useRouter().path.value)),
    note: "the marker mechanism, working — this is the shape to generalise",
  },
  {
    form: "`at ${router.path.value}`",
    want: "bind",
    run: () => withWindowRoute(route, () => el(`at ${useRouter().path.value}`)),
  },
  {
    form: "{router.matches('products')}",
    want: "bind",
    run: () => withWindowRoute(route, () => el(useRouter().matches("products"))),
  },

  // -- expressions: no marker survives an operator ----------------------------
  {
    form: "{count.value > 3}",
    want: "error",
    run: () => el(count.value > 3),
    note: "`>` coerces, so we are called — but learn the hint, not the operator",
  },
  {
    form: "{count.value === 7}",
    want: "error",
    run: () => el(count.value === 7),
    note: "`===` calls nothing at all. The one shape no runtime trick reaches",
  },
  {
    form: "{count.value * 2}",
    want: "error",
    run: () => el(count.value * 2),
  },
  {
    form: "{items.value.length}",
    want: "bind",
    run: () => el(items.value.length),
    note: "a property path, which a recorder *can* capture",
  },

  // -- the escape hatch, and whether it works inline --------------------------
  {
    form: "{computed(() => count.value === 7)}",
    want: "bind",
    run: () => el(computed(() => count.value === 7)),
    note: "author supplies the function; toString() could supply the text",
  },

  // -- genuinely static, and must stay that way ------------------------------
  { form: '{"hello"}', want: "static", run: () => el("hello") },
  { form: "{1 + 1}", want: "static", run: () => el(1 + 1) },
  {
    form: "{count.peek?.() ?? 7}",
    want: "static",
    run: () => el(7),
    note: "a deliberate snapshot stays a snapshot",
  },
];

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

type Got = { kind: Want; detail: string; unresolved?: string };

/**
 * The exports the generated module could import, as the real build sees them.
 *
 * This is the half a JSX-only harness would miss. `flatten` producing a binding is
 * not success: the binding holds a signal *object*, and `ui.gen.ts` can only contain
 * a *name*, so `resolve-refs` has to find that object among some module's exports.
 * A `computed()` written inside a component passes the first stage and fails the
 * second, which is why every row is run through both.
 */
const EXPORTS = { count, label, items, isBig, route };
const refIndex = buildRefIndex([{ specifier: "./state.ts", exports: EXPORTS }]);

/** An otherwise-empty result, so `resolveRefs` can be run on one node's bindings. */
const asResult = (parts: TextPart[]): CompileResult =>
  ({
    textBindings: [{ node: 0, slot: 0, parts }],
    handlers: [],
    editables: [],
    lists: [],
  }) as unknown as CompileResult;

const partText = (p: TextPart): string => {
  if ("literal" in p) return JSON.stringify(p.literal);
  if ("item" in p) return `item(${p.item.join(".")})`;
  if ("export" in p) return `export(${p.export})`;
  // Identity is what resolves to an import name. `router.path` arrives wrapped, so
  // unwrap for display — otherwise the row shows the marker its `.value` returns
  // and reads as though the route were bound to a literal.
  const source = (routePathBehind(p.source) ?? p.source) as { value?: unknown } | null;
  const named = Object.entries(EXPORTS).find(([, v]) => v === source)?.[0];
  return named ? `signal ${named}` : `signal<${JSON.stringify(source?.value)}>`;
};

function classify(run: () => Node[]): Got {
  let children: Node[];
  try {
    children = run();
  } catch (error) {
    const e = error as Error;
    return { kind: "error", detail: `${e.name}: ${e.message.split("\n")[0]}` };
  }

  if (children.length === 0) return { kind: "static", detail: "(nothing)" };

  const [node] = children;
  if (node?.type === "dyntext") {
    const parts = (node as DynText).parts;
    const detail = `dyntext ${parts.map(partText).join(" + ")}`;
    const live = parts.some((p) => "source" in p || "item" in p);
    if (!live) return { kind: "static", detail };

    // Stage two: can the artifact name what this binding holds?
    try {
      resolveRefs(asResult(parts.map((p) => ({ ...p }))), refIndex);
    } catch (error) {
      return { kind: "error", detail, unresolved: (error as Error).message.split("\n")[0] };
    }
    return { kind: "bind", detail };
  }
  if (node?.type === "text") return { kind: "static", detail: `text ${JSON.stringify(node.value)}` };
  return { kind: "static", detail: node?.type ?? "?" };
}

setCompiling(true);

const rows = CASES.map((c) => ({ ...c, got: classify(c.run) }));

setCompiling(false);

const widest = Math.max(...rows.map((r) => r.form.length));
const holes: typeof rows = [];

console.log("");
console.log(`  ${"form".padEnd(widest)}  want    got     compiles to`);
console.log(`  ${"-".repeat(widest)}  ------  ------  ${"-".repeat(40)}`);

for (const row of rows) {
  const ok = row.got.kind === row.want;
  if (!ok) holes.push(row);

  // A `want: bind` that reports `static` is the dangerous one: it renders, once,
  // and looks right. Marked so it cannot be skimmed past.
  const mark = ok ? " " : row.want === "bind" && row.got.kind === "static" ? "!" : "~";

  console.log(
    `${mark} ${row.form.padEnd(widest)}  ${row.want.padEnd(6)}  ${row.got.kind.padEnd(6)}  ${row.got.detail}`,
  );
  const pad = `  ${" ".repeat(widest)}          `;
  if (row.got.unresolved) console.log(`${pad}resolve-refs: ${row.got.unresolved}`);
  if (row.note && (VERBOSE || !ok)) console.log(`${pad}${row.note}`);
}

console.log("");

if (holes.length === 0) {
  console.log(`  every form compiles to what it should — ${rows.length} case(s)`);
} else {
  const frozen = holes.filter((h) => h.want === "bind" && h.got.kind === "static");
  console.log(`  ${holes.length} of ${rows.length} form(s) do not compile to what they should`);
  if (frozen.length > 0) {
    console.log(
      `  ${frozen.length} of those render a frozen value and say nothing — the failure ` +
        `this project treats as worse than a crash:`,
    );
    for (const f of frozen) console.log(`      ${f.form}  ->  ${f.got.detail}`);
  }
}

console.log("");
