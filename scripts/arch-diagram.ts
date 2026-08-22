#!/usr/bin/env bun
/**
 * Architecture diagrams for dziry — C4 levels 1-3 from the model, level 4 read
 * out of the source, and the refactor queries that use the same graph.
 *
 *   bun run arch-diagram                 # validate the model, emit guards/diagrams/
 *   bun run arch-diagram --check         # validate only, exit 1 on drift
 *   bun run arch-diagram context         # a single diagram, to stdout
 *   bun run arch-diagram blast src/ir.ts # what breaks if I change this?
 *
 * The split matters. Levels 1-3 answer "what is this for", which no tool can
 * derive, so they are hand-written in `lib/arch-model.ts` and every path they
 * cite is checked against the repo. Level 4 — every module and every edge — is
 * parsed out of the imports on each run and is never written down, because a
 * module graph maintained by hand is wrong within a week and is read with the
 * same confidence as one that is right.
 *
 * Nothing here imports `guards/architecture/`. The one thing it does import from `src/`
 * is the protocol schema, and that is deliberate: the boundary diagram *is* the
 * schema, so it cannot disagree with it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseSync } from "oxc-parser";
import {
  CONTAINER_RELS,
  CONTAINERS,
  COMPONENT_RELS,
  COMPONENTS,
  DOCS,
  EXTERNALS,
  FLOWS,
  LAYERS,
  PEOPLE,
  RULES,
  type LayerId,
} from "./lib/arch-model.ts";
import { ELEM_SIZE, PROTOCOL_VERSION, TABLES } from "../src/protocol/schema.ts";

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "guards", "diagrams");

// ---------------------------------------------------------------------------
// Walking the tree
// ---------------------------------------------------------------------------

/** Never source, whatever they contain. `guards/architecture/` is a separate viewer, not the framework. */
const SKIP_DIRS = new Set([
  "node_modules",
  "target",
  ".git",
  "vendor",
  "native",
  ".natives-tmp",
  "architecture",
  "dist",
  "docs",
  "characterize",
  "golden",
  "css-coverage",
  "runtime-surface",
  "bench",
  "probes",
  "diagrams",
]);

/** Where the framework lives. `packages/` is a scaffolding template kept in sync by `template:sync`. */
const SCAN_ROOTS = ["src", "windows", "scripts", "native-src"];

const SOURCE_EXT = [".ts", ".tsx", ".rs"];

export type Node = {
  path: string;
  layer: LayerId | null;
  lang: "ts" | "rs";
  lines: number;
  test: boolean;
  /** Compiler output. Real, and architecturally interesting, but nobody wrote it. */
  generated: boolean;
};

export type Edge = {
  from: string;
  to: string;
  /** `type` edges vanish at run time; `dynamic` is an `import()`. */
  kind: "value" | "type" | "dynamic";
};

const slash = (p: string) => p.replaceAll("\\", "/");
const rel = (full: string) => slash(relative(ROOT, full));

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXT.some((e) => entry.endsWith(e))) out.push(full);
  }
}

function layerOf(path: string): LayerId | null {
  let best: { id: LayerId; len: number } | null = null;
  for (const layer of LAYERS) {
    for (const root of layer.roots) {
      if (path === root || path.startsWith(root)) {
        if (!best || root.length > best.len) best = { id: layer.id, len: root.length };
      }
    }
  }
  return best?.id ?? null;
}

// ---------------------------------------------------------------------------
// Resolving specifiers
// ---------------------------------------------------------------------------

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  name: string;
  exports: Record<string, string>;
};

/**
 * The self-reference is not cosmetic: the emitter writes `dziry/host/main.ts`
 * into generated entry points, and the demo under `windows/` imports the package
 * by name so that it *is* the scaffolding template rather than something a
 * codemod rewrites. Resolving it is what connects those halves of the graph.
 */
function resolveSelfRef(spec: string): string | null {
  const subpath = spec === pkg.name ? "." : spec.startsWith(`${pkg.name}/`) ? `./${spec.slice(pkg.name.length + 1)}` : null;
  if (subpath === null) return null;

  const exact = pkg.exports[subpath];
  if (typeof exact === "string") return exact.replace(/^\.\//, "");

  for (const [pattern, target] of Object.entries(pkg.exports)) {
    if (!pattern.includes("*") || typeof target !== "string") continue;
    const [pre, post] = pattern.split("*");
    if (subpath.startsWith(pre!) && subpath.endsWith(post ?? "")) {
      const star = subpath.slice(pre!.length, subpath.length - (post ?? "").length);
      return target.replace("*", star).replace(/^\.\//, "");
    }
  }
  return null;
}

type Resolution =
  | { kind: "internal"; path: string }
  | { kind: "external"; name: string }
  | { kind: "missing"; spec: string };

function resolve(spec: string, fromFile: string, known: Set<string>): Resolution {
  if (spec.startsWith("node:") || spec.startsWith("bun:")) {
    return { kind: "external", name: spec };
  }

  let candidate: string | null = null;
  if (spec.startsWith(".")) {
    candidate = slash(join(dirname(fromFile), spec));
  } else {
    const self = resolveSelfRef(spec);
    if (self !== null) candidate = self;
    else return { kind: "external", name: spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/") };
  }

  if (known.has(candidate)) return { kind: "internal", path: candidate };
  // Extensionless and directory specifiers are rare here — the repo writes `.ts`
  // explicitly — but the generated entry points and a few scripts do not.
  for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    if (known.has(candidate + suffix)) return { kind: "internal", path: candidate + suffix };
  }
  if (existsSync(join(ROOT, candidate))) return { kind: "internal", path: candidate };
  return { kind: "missing", spec: candidate };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type RawImport = { spec: string; kind: Edge["kind"] };

function scanTs(path: string, code: string): RawImport[] {
  const out: RawImport[] = [];
  let parsed;
  try {
    parsed = parseSync(path, code);
  } catch {
    return out;
  }

  for (const imp of parsed.module.staticImports) {
    // No entries at all is a side-effect import (`import "./x.css"`) — a value edge.
    const allType = imp.entries.length > 0 && imp.entries.every((e) => e.isType);
    out.push({ spec: imp.moduleRequest.value, kind: allType ? "type" : "value" });
  }
  for (const exp of parsed.module.staticExports) {
    for (const entry of exp.entries) {
      if (entry.moduleRequest) out.push({ spec: entry.moduleRequest.value, kind: "value" });
    }
  }
  for (const dyn of parsed.module.dynamicImports) {
    const raw = code.slice(dyn.moduleRequest.start, dyn.moduleRequest.end);
    const literal = /^\s*(['"`])(.*)\1\s*$/.exec(raw);
    if (literal) out.push({ spec: literal[2]!, kind: "dynamic" });
  }
  return out;
}

/**
 * Rust, by regex rather than a parser. The crate is nine flat modules, so the
 * only forms that occur are `mod x;` and `use crate::x::…`; a `use` behind a
 * `cfg` or inside a function body still names a real dependency, which is what
 * the graph wants.
 */
function scanRust(path: string, code: string): string[] {
  const mods = new Set<string>();
  const isRoot = path.endsWith("/lib.rs") || path.endsWith("/main.rs");

  if (isRoot) {
    for (const m of code.matchAll(/^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+([a-z_][a-z0-9_]*)[ \t]*;/gm)) {
      mods.add(m[1]!);
    }
  }
  for (const m of code.matchAll(/\buse[ \t]+(?:crate|dziry_engine)::([\s\S]*?);/g)) {
    const tail = m[1]!.trim();
    if (tail.startsWith("{")) {
      // `use crate::{tables::X, error::Y}` — take the head of each top-level item.
      let depth = 0;
      let current = "";
      for (const ch of tail.slice(1)) {
        if (ch === "{") depth++;
        else if (ch === "}" && depth > 0) depth--;
        else if (ch === "}" && depth === 0) break;
        if ((ch === "," && depth === 0) || ch === "}") {
          const head = /^[a-z_][a-z0-9_]*/.exec(current.trim());
          if (head) mods.add(head[0]);
          current = "";
        } else current += ch;
      }
      const head = /^[a-z_][a-z0-9_]*/.exec(current.trim());
      if (head) mods.add(head[0]);
    } else {
      const head = /^[a-z_][a-z0-9_]*/.exec(tail);
      if (head) mods.add(head[0]);
    }
  }
  return [...mods];
}

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

export type Graph = {
  nodes: Map<string, Node>;
  edges: Edge[];
  /** Bare package names, per file. */
  externals: Map<string, Set<string>>;
  missing: { from: string; spec: string }[];
  out: Map<string, Set<string>>;
  in: Map<string, Set<string>>;
};

function build(): Graph {
  const paths: string[] = [];
  for (const dir of SCAN_ROOTS) walk(join(ROOT, dir), paths);

  const nodes = new Map<string, Node>();
  const source = new Map<string, string>();

  for (const full of paths) {
    const path = rel(full);
    const code = readFileSync(full, "utf8");
    source.set(path, code);
    nodes.set(path, {
      path,
      layer: layerOf(path),
      lang: path.endsWith(".rs") ? "rs" : "ts",
      lines: code.length === 0 ? 0 : code.split("\n").length - (code.endsWith("\n") ? 1 : 0),
      test: /\.test\.tsx?$/.test(path) || /\/tests\/[^/]+\.rs$/.test(path),
      generated: /\.gen\.tsx?$/.test(path) || path === "src/protocol/generated.ts",
    });
  }

  const known = new Set(nodes.keys());
  const edges: Edge[] = [];
  const externals = new Map<string, Set<string>>();
  const missing: { from: string; spec: string }[] = [];
  const seen = new Set<string>();

  const addEdge = (from: string, to: string, kind: Edge["kind"]) => {
    // A specifier can resolve to a real file that is not a graph node — a `.css`
    // import, or something under a skipped directory. Real, but not a module.
    if (from === to || !known.has(from) || !known.has(to)) return;
    const key = `${from} ${to}`;
    // A pair imported twice, once for types and once for values, is a value edge.
    const prior = seen.has(key) ? edges.find((e) => e.from === from && e.to === to) : null;
    if (prior) {
      if (kind === "value") prior.kind = "value";
      return;
    }
    seen.add(key);
    edges.push({ from, to, kind });
  };

  for (const [path, code] of source) {
    if (path.endsWith(".rs")) {
      const dir = dirname(path);
      for (const mod of scanRust(path, code)) {
        for (const candidate of [`${dir}/${mod}.rs`, `${dir}/${mod}/mod.rs`]) {
          if (known.has(candidate)) addEdge(path, candidate, "value");
        }
      }
      continue;
    }

    for (const { spec, kind } of scanTs(path, code)) {
      const r = resolve(spec, path, known);
      if (r.kind === "internal") addEdge(path, r.path, kind);
      else if (r.kind === "external") {
        if (!externals.has(path)) externals.set(path, new Set());
        externals.get(path)!.add(r.name);
      } else missing.push({ from: path, spec: r.spec });
    }
  }

  const out = new Map<string, Set<string>>();
  const inn = new Map<string, Set<string>>();
  for (const p of known) {
    out.set(p, new Set());
    inn.set(p, new Set());
  }
  for (const e of edges) {
    out.get(e.from)!.add(e.to);
    inn.get(e.to)!.add(e.from);
  }

  return { nodes, edges, externals, missing, out, in: inn };
}

// ---------------------------------------------------------------------------
// Analyses
// ---------------------------------------------------------------------------

/**
 * Tarjan. Any component of size > 1 is an import cycle.
 *
 * `valueOnly` is the difference between a real problem and a false alarm. A cycle
 * held together by an `import type` edge does not exist after erasure — nothing
 * loads in a circle at run time, and breaking it buys nothing. Reporting the two
 * at the same severity is how a checker gets ignored.
 */
function cycles(g: Graph, valueOnly = false): string[][] {
  const adj = new Map<string, Set<string>>();
  for (const p of g.nodes.keys()) adj.set(p, new Set());
  for (const e of g.edges) {
    if (valueOnly && e.kind === "type") continue;
    adj.get(e.from)!.add(e.to);
  }

  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: string[][] = [];

  const strongconnect = (v: string) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      if (comp.length > 1) found.push(comp.sort());
    }
  };

  for (const v of g.nodes.keys()) if (!idx.has(v)) strongconnect(v);
  return found;
}

/** Everything that transitively reaches `start` — the set a change can break. */
function cone(g: Graph, start: string, dir: "in" | "out", depth: number): Map<string, number> {
  const seen = new Map<string, number>([[start, 0]]);
  let frontier = [start];
  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const n of frontier) {
      for (const m of (dir === "in" ? g.in : g.out).get(n) ?? []) {
        if (!seen.has(m)) {
          seen.set(m, d);
          next.push(m);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

type Violation = { from: string; to: string; rule: (typeof RULES)[number]; kind: Edge["kind"] };

function violations(g: Graph): Violation[] {
  const found: Violation[] = [];
  for (const e of g.edges) {
    const a = g.nodes.get(e.from)?.layer;
    const b = g.nodes.get(e.to)?.layer;
    if (!a || !b) continue;
    for (const rule of RULES) {
      if (rule.from !== a || rule.to !== b) continue;
      if (rule.valueOnly && e.kind === "type") continue;
      // Tests reach across layers on purpose; they ship nothing.
      if (g.nodes.get(e.from)!.test) continue;
      found.push({ from: e.from, to: e.to, rule, kind: e.kind });
    }
  }
  return found;
}

/** Fan-in, fan-out, and Martin's instability. Refactor candidates, ranked. */
function hotspots(g: Graph) {
  return [...g.nodes.values()]
    .filter((n) => !n.test && !n.generated)
    .map((n) => {
      const ca = [...(g.in.get(n.path) ?? [])].filter((p) => !g.nodes.get(p)!.test).length;
      const ce = (g.out.get(n.path) ?? new Set()).size;
      return {
        ...n,
        ca,
        ce,
        instability: ca + ce === 0 ? 1 : ce / (ca + ce),
        /** Fan-in times size: a big file many others depend on is the expensive one to get wrong. */
        weight: ca * n.lines,
      };
    })
    .sort((a, b) => b.weight - a.weight);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validate(g: Graph): string[] {
  const problems: string[] = [];

  for (const c of CONTAINERS) {
    for (const f of c.files) {
      if (!existsSync(join(ROOT, f))) problems.push(`container "${c.id}" cites ${f}, which does not exist`);
    }
  }
  for (const c of COMPONENTS) {
    if (!CONTAINERS.some((x) => x.id === c.container)) {
      problems.push(`component "${c.id}" belongs to container "${c.container}", which is not defined`);
    }
    for (const f of c.files) {
      if (!existsSync(join(ROOT, f))) problems.push(`component "${c.id}" cites ${f}, which does not exist`);
    }
  }
  for (const d of DOCS) {
    if (!existsSync(join(ROOT, d.path))) problems.push(`DOCS lists ${d.path}, which does not exist`);
  }

  const ids = new Set([...PEOPLE, ...EXTERNALS, ...CONTAINERS].map((x) => x.id));
  for (const r of CONTAINER_RELS) {
    if (!ids.has(r.from)) problems.push(`CONTAINER_RELS references unknown "${r.from}"`);
    if (!ids.has(r.to)) problems.push(`CONTAINER_RELS references unknown "${r.to}"`);
  }
  const compIds = new Set(COMPONENTS.map((c) => c.id));
  for (const r of COMPONENT_RELS) {
    if (!compIds.has(r.from)) problems.push(`COMPONENT_RELS references unknown component "${r.from}"`);
    if (!compIds.has(r.to)) problems.push(`COMPONENT_RELS references unknown component "${r.to}"`);
  }

  for (const layer of LAYERS) {
    for (const root of layer.roots) {
      if (![...g.nodes.keys()].some((p) => p === root || p.startsWith(root))) {
        problems.push(`layer "${layer.id}" claims root ${root}, which matches no source file`);
      }
    }
  }

  const orphans = [...g.nodes.values()].filter((n) => n.layer === null);
  if (orphans.length > 0) {
    problems.push(
      `${orphans.length} source file(s) belong to no layer — add a root to LAYERS in scripts/lib/arch-model.ts:\n` +
        orphans.map((n) => `      ${n.path}`).join("\n"),
    );
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

const id = (s: string) => s.replace(/[^A-Za-z0-9]/g, "_");
/** Mermaid takes `#quot;` inside a quoted label; a raw `"` ends it. */
const esc = (s: string) => s.replaceAll('"', "#quot;");
const fence = (body: string) => "```mermaid\n" + body.trim() + "\n```";

function contextDiagram(): string {
  const l: string[] = ["C4Context", "  title dziry — system context", ""];
  for (const p of PEOPLE) l.push(`  Person(${p.id}, "${esc(p.label)}", "${esc(p.descr)}")`);
  l.push("");
  l.push(`  System(dziry, "dziry", "A UI framework that resolves CSS, the cascade and every interaction state before the app runs, then hands a native engine shared memory instead of a call surface.")`);
  l.push("");
  for (const e of EXTERNALS) l.push(`  System_Ext(${e.id}, "${esc(e.label)}", "${esc(e.descr)}")`);
  l.push("");
  l.push(`  Rel(author, dziry, "writes windows/, runs the CLI")`);
  l.push(`  Rel(dziry, tailwind, "reads generated CSS at build time", "file")`);
  l.push(`  Rel(dziry, os, "window, input, clipboard, fonts", "SDL3")`);
  l.push(`  Rel(dziry, gpu, "presents frames", "Skia raster")`);
  l.push(`  Rel(enduser, dziry, "clicks, types, resizes")`);
  l.push(`  Rel(chrome, dziry, "measured against, in the guards only", "CDP")`);
  l.push("");
  l.push(`  UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")`);
  return l.join("\n");
}

function containerDiagram(): string {
  const l: string[] = ["C4Container", "  title dziry — containers", ""];
  for (const p of PEOPLE) l.push(`  Person(${p.id}, "${esc(p.label)}", "${esc(p.descr)}")`);
  for (const e of EXTERNALS.filter((x) => x.id !== "chrome")) {
    l.push(`  System_Ext(${e.id}, "${esc(e.label)}", "${esc(e.descr)}")`);
  }
  l.push("");

  for (const [phase, title] of [
    ["build", "Build time — runs once, ships nothing"],
    ["run", "Run time — the shipped app"],
  ] as const) {
    l.push(`  System_Boundary(${phase}, "${title}") {`);
    for (const c of CONTAINERS.filter((x) => x.phase === phase)) {
      const kind = c.db ? "ContainerDb" : "Container";
      l.push(`    ${kind}(${c.id}, "${esc(c.label)}", "${esc(c.tech)}", "${esc(c.descr)}")`);
    }
    l.push("  }");
    l.push("");
  }

  for (const r of CONTAINER_RELS) {
    l.push(`  Rel(${r.from}, ${r.to}, "${esc(r.label)}"${r.tech ? `, "${esc(r.tech)}"` : ""})`);
  }
  l.push("");
  l.push(`  UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")`);
  return l.join("\n");
}

function componentDiagram(containerId?: string): string {
  const targets = CONTAINERS.filter(
    (c) => COMPONENTS.some((x) => x.container === c.id) && (!containerId || c.id === containerId),
  );
  const l: string[] = ["C4Component", `  title dziry — components${containerId ? ` (${containerId})` : ""}`, ""];
  for (const c of targets) {
    l.push(`  Container_Boundary(b_${c.id}, "${esc(c.label)}") {`);
    for (const comp of COMPONENTS.filter((x) => x.container === c.id)) {
      l.push(`    Component(${comp.id}, "${esc(comp.label)}", "${esc(comp.files[0] ?? "")}", "${esc(comp.descr)}")`);
    }
    l.push("  }");
    l.push("");
  }
  const shown = new Set(COMPONENTS.filter((c) => targets.some((t) => t.id === c.container)).map((c) => c.id));
  for (const r of COMPONENT_RELS) {
    if (shown.has(r.from) && shown.has(r.to)) l.push(`  Rel(${r.from}, ${r.to}, "${esc(r.label)}")`);
  }
  l.push("");
  l.push(`  UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="2")`);
  return l.join("\n");
}

/** C4 level 4, derived: layer to layer, with the number of real imports on each edge. */
function layerDiagram(g: Graph): string {
  const counts = new Map<string, { value: number; type: number }>();
  const stats = new Map<LayerId, { files: number; lines: number }>();

  for (const n of g.nodes.values()) {
    if (!n.layer || n.test) continue;
    const s = stats.get(n.layer) ?? { files: 0, lines: 0 };
    s.files++;
    s.lines += n.lines;
    stats.set(n.layer, s);
  }
  for (const e of g.edges) {
    const a = g.nodes.get(e.from)!;
    const b = g.nodes.get(e.to)!;
    if (!a.layer || !b.layer || a.layer === b.layer || a.test) continue;
    const key = `${a.layer} ${b.layer}`;
    const c = counts.get(key) ?? { value: 0, type: 0 };
    if (e.kind === "type") c.type++;
    else c.value++;
    counts.set(key, c);
  }

  const l: string[] = ["flowchart LR"];
  for (const layer of LAYERS) {
    const s = stats.get(layer.id) ?? { files: 0, lines: 0 };
    l.push(`  ${layer.id}["<b>${layer.label}</b><br/>${s.files} files · ${s.lines.toLocaleString("en-US")} lines"]`);
  }
  l.push("");
  for (const [key, c] of [...counts].sort((a, b) => b[1].value + b[1].type - (a[1].value + a[1].type))) {
    const [a, b] = key.split(" ") as [LayerId, LayerId];
    const label = c.type > 0 ? `${c.value + c.type} (${c.type} type-only)` : `${c.value}`;
    l.push(c.value === 0 ? `  ${a} -.->|"${label}"| ${b}` : `  ${a} -->|"${label}"| ${b}`);
  }
  l.push("");
  const palette: Record<LayerId, string> = {
    authoring: "#e8f0fe",
    cli: "#e3f2fd",
    compiler: "#e6f4ea",
    ir: "#fff3e0",
    runtime: "#fef7e0",
    protocol: "#fce8e6",
    host: "#f3e8fd",
    engine: "#e0f2f1",
    tooling: "#f1f3f4",
  };
  for (const layer of LAYERS) {
    l.push(`  style ${layer.id} fill:${palette[layer.id]},stroke:#5f6368,color:#202124`);
  }
  return l.join("\n");
}

/** The modules of one layer, clustered by directory, plus their edges out. */
function moduleDiagram(g: Graph, layerId: LayerId, opts: { tests: boolean }): string {
  const inLayer = [...g.nodes.values()]
    .filter((n) => n.layer === layerId && (opts.tests || !n.test))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (inLayer.length === 0) return `flowchart TD\n  empty["no files in layer ${layerId}"]`;

  const members = new Set(inLayer.map((n) => n.path));
  const byDir = new Map<string, Node[]>();
  for (const n of inLayer) {
    const d = dirname(n.path);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d)!.push(n);
  }

  const l: string[] = ["flowchart TD"];
  for (const [dir, files] of [...byDir].sort()) {
    l.push(`  subgraph ${id(dir)}["${dir}/"]`);
    for (const f of files) {
      const name = f.path.slice(dir.length + 1);
      l.push(`    ${id(f.path)}["${name}<br/><small>${f.lines}</small>"]`);
    }
    l.push("  end");
  }
  l.push("");

  const outside = new Set<LayerId>();
  for (const e of g.edges) {
    if (members.has(e.from) && members.has(e.to)) {
      l.push(e.kind === "type" ? `  ${id(e.from)} -.-> ${id(e.to)}` : `  ${id(e.from)} --> ${id(e.to)}`);
    } else if (members.has(e.from)) {
      const other = g.nodes.get(e.to)?.layer;
      if (other && other !== layerId) outside.add(other);
    }
  }
  if (outside.size > 0) {
    l.push("");
    for (const o of outside) {
      const label = LAYERS.find((x) => x.id === o)!.label;
      l.push(`  ext_${o}(["${label}"])`);
      l.push(`  style ext_${o} fill:#f1f3f4,stroke-dasharray: 4 4`);
    }
    for (const e of g.edges) {
      if (!members.has(e.from)) continue;
      const other = g.nodes.get(e.to)?.layer;
      if (other && other !== layerId) l.push(`  ${id(e.from)} --> ext_${other}`);
    }
  }
  return l.join("\n");
}

/** The boundary, straight out of the schema — so it cannot disagree with it. */
function boundaryDiagram(): string {
  const l: string[] = ["flowchart LR"];
  l.push(`  writer["<b>App thread</b><br/>src/host/worker.ts"]`);
  l.push(`  reader["<b>Engine</b><br/>native-src/dziry-engine/src/tables.rs"]`);
  l.push(`  subgraph shared["Shared memory · protocol v${PROTOCOL_VERSION} · struct-of-arrays"]`);
  for (const t of TABLES) {
    const bytes = t.fields.reduce((n, f) => n + ELEM_SIZE[f.type], 0);
    l.push(`    t_${id(t.name)}["<b>${t.name}</b><br/>${t.fields.length} fields · ${bytes} B/elem<br/><small>sized by ${t.sizedBy}</small>"]`);
  }
  l.push("  end");
  l.push("");
  for (const t of TABLES) {
    l.push(`  writer --> t_${id(t.name)}`);
    l.push(`  t_${id(t.name)} --> reader`);
  }
  return l.join("\n");
}

function flowDiagram(flowId: string): string {
  const flow = FLOWS.find((f) => f.id === flowId);
  if (!flow) throw new Error(`no flow "${flowId}" — try ${FLOWS.map((f) => f.id).join(", ")}`);
  // A `;` terminates a statement in a sequence diagram, so a semicolon in prose
  // silently truncates the label and then fails to parse two lines later.
  const seq = (s: string) => s.replaceAll(";", "#59;");
  const l: string[] = ["sequenceDiagram", `  autonumber`];
  for (const [alias, label] of flow.actors) l.push(`  participant ${alias} as ${seq(label)}`);
  for (const [from, to, label] of flow.steps) {
    if (from === to) l.push(`  Note over ${from}: ${seq(label)}`);
    else l.push(`  ${from}->>${to}: ${seq(label)}`);
  }
  return l.join("\n");
}

function blastDiagram(g: Graph, target: string, depth: number): string {
  const reached = cone(g, target, "in", depth);
  const l: string[] = ["flowchart BT"];
  for (const [path, d] of [...reached].sort((a, b) => a[1] - b[1])) {
    const n = g.nodes.get(path)!;
    const shape = path === target ? `[["${path}"]]` : n.test ? `(["${path}"])` : `["${path}"]`;
    l.push(`  ${id(path)}${shape}`);
    if (d === 0) l.push(`  style ${id(path)} fill:#fce8e6,stroke:#c5221f,stroke-width:2px`);
    else if (n.test) l.push(`  style ${id(path)} fill:#f1f3f4,stroke-dasharray: 3 3`);
  }
  l.push("");
  for (const e of g.edges) {
    if (reached.has(e.from) && reached.has(e.to)) {
      l.push(e.kind === "type" ? `  ${id(e.from)} -.-> ${id(e.to)}` : `  ${id(e.from)} --> ${id(e.to)}`);
    }
  }
  return l.join("\n");
}

function depsDiagram(g: Graph, target: string, depth: number): string {
  const reached = cone(g, target, "out", depth);
  const l: string[] = ["flowchart TD"];
  for (const [path, d] of [...reached].sort((a, b) => a[1] - b[1])) {
    l.push(`  ${id(path)}["${path}"]`);
    if (d === 0) l.push(`  style ${id(path)} fill:#e8f0fe,stroke:#1967d2,stroke-width:2px`);
  }
  l.push("");
  for (const e of g.edges) {
    if (reached.has(e.from) && reached.has(e.to)) {
      l.push(e.kind === "type" ? `  ${id(e.from)} -.-> ${id(e.to)}` : `  ${id(e.from)} --> ${id(e.to)}`);
    }
  }
  return l.join("\n");
}

// ---------------------------------------------------------------------------
// Finding the file someone meant
// ---------------------------------------------------------------------------

function findFile(g: Graph, query: string): string {
  const q = slash(query);
  if (g.nodes.has(q)) return q;
  const matches = [...g.nodes.keys()].filter((p) => p === q || p.endsWith(`/${q}`) || p.includes(q));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`no source file matches "${query}"`);
  const exact = matches.filter((p) => p.endsWith(`/${q}`));
  if (exact.length === 1) return exact[0]!;
  throw new Error(`"${query}" is ambiguous:\n${matches.map((m) => `  ${m}`).join("\n")}`);
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

function doc(title: string, intro: string, body: string): string {
  return `# ${title}\n\n> Generated by \`bun run arch-diagram\`. Do not edit — regenerate.\n\n${intro}\n\n${body}\n`;
}

function emitAll(g: Graph): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const write = (name: string, content: string) => {
    writeFileSync(join(OUT_DIR, name), content.replaceAll("\r\n", "\n"));
    return name;
  };

  const written: string[] = [];

  written.push(
    write(
      "01-context.md",
      doc(
        "Context",
        "Who uses dziry and what it touches. Note where Chrome sits: it is an oracle the guards measure against, not something the framework depends on.",
        fence(contextDiagram()),
      ),
    ),
  );

  written.push(
    write(
      "02-containers.md",
      doc(
        "Containers",
        "The processes, threads and memory the system is made of. The build/run split is the whole design: everything above the line runs once and ships nothing.",
        fence(containerDiagram()) +
          "\n\n## What each one is\n\n" +
          CONTAINERS.map((c) => `- **${c.label}** *(${c.tech}, ${c.phase} time)* — ${c.descr}\n  <br>\`${c.files.join("`, `")}\``).join("\n"),
      ),
    ),
  );

  written.push(
    write(
      "03-components.md",
      doc(
        "Components",
        "Inside the three containers with enough moving parts to be worth opening: the compiler, the app thread, and the engine.",
        ["compiler", "appThread", "engine"]
          .map((c) => `## ${CONTAINERS.find((x) => x.id === c)!.label}\n\n${fence(componentDiagram(c))}`)
          .join("\n\n"),
      ),
    ),
  );

  written.push(
    write(
      "04-layers.md",
      doc(
        "Layers",
        "Level 4, derived. Every edge is a real import counted from the source; dashed edges are type-only and disappear at run time. Test files are excluded — they reach across layers on purpose.",
        fence(layerDiagram(g)) +
          "\n\n## What each layer is\n\n" +
          LAYERS.map((l) => `- **${l.label}** — ${l.blurb}\n  <br>\`${l.roots.join("`, `")}\``).join("\n"),
      ),
    ),
  );

  written.push(
    write(
      "05-modules.md",
      doc(
        "Modules",
        "Every module in the repo, by layer, with the real import edges between them. Solid is a value import, dashed is type-only. Numbers under a name are lines.",
        LAYERS.map((l) => `## ${l.label}\n\n${fence(moduleDiagram(g, l.id, { tests: false }))}`).join("\n\n"),
      ),
    ),
  );

  written.push(
    write(
      "06-boundary.md",
      doc(
        "The shared-memory boundary",
        `Read directly from \`src/protocol/schema.ts\`, so it cannot disagree with the protocol. Version ${PROTOCOL_VERSION}.`,
        fence(boundaryDiagram()) +
          "\n\n| Table | Fields | Bytes/elem | Sized by |\n| --- | --- | --- | --- |\n" +
          TABLES.map(
            (t) =>
              `| \`${t.name}\` | ${t.fields.length} | ${t.fields.reduce((n, f) => n + ELEM_SIZE[f.type], 0)} | ${t.sizedBy} |`,
          ).join("\n"),
      ),
    ),
  );

  written.push(
    write(
      "07-flows.md",
      doc(
        "Flows",
        "The sequences that are easier to watch than to read.",
        FLOWS.map((f) => `## ${f.title}\n\n*${f.question}*\n\n${fence(flowDiagram(f.id))}`).join("\n\n"),
      ),
    ),
  );

  const cyc = cycles(g, true);
  const typeCyc = cycles(g).filter((c) => !cyc.some((r) => r.join() === c.join()));
  const vio = violations(g);
  const hot = hotspots(g).slice(0, 20);
  written.push(
    write(
      "08-health.md",
      doc(
        "Structural health",
        "Derived every run. This is the page to read before planning a refactor.",
        [
          `## Layering rules\n\n${
            vio.length === 0
              ? "No violations. Every rule in `scripts/lib/arch-model.ts` holds."
              : vio
                  .map((v) => `- \`${v.from}\` → \`${v.to}\` (${v.kind}) breaks **${v.rule.from} ⇏ ${v.rule.to}**\n  <br>${v.rule.why}`)
                  .join("\n")
          }`,
          `## Import cycles\n\nOnly cycles that survive type erasure are real: a loop held together by an \`import type\` edge does not exist at run time.\n\n${
            cyc.length === 0
              ? "**None that survive erasure.**"
              : cyc.map((c) => `- ${c.map((p) => `\`${p}\``).join(" ↔ ")}`).join("\n")
          }${
            typeCyc.length === 0
              ? ""
              : `\n\nType-only, informational — erased, and safe to leave:\n\n${typeCyc
                  .map((c) => `- ${c.map((p) => `\`${p}\``).join(" ↔ ")}`)
                  .join("\n")}`
          }`,
          `## Coupling hotspots\n\nRanked by fan-in × size — the files that are expensive to get wrong. Instability is Ce/(Ca+Ce): 0 is depended upon and hard to change, 1 depends on others and is safe to change.\n\n| File | Lines | Fan-in | Fan-out | Instability |\n| --- | ---: | ---: | ---: | ---: |\n${hot
            .map((h) => `| \`${h.path}\` | ${h.lines} | ${h.ca} | ${h.ce} | ${h.instability.toFixed(2)} |`)
            .join("\n")}`,
        ].join("\n\n"),
      ),
    ),
  );

  const totals = { ts: 0, rs: 0 };
  for (const n of g.nodes.values()) {
    if (n.test || n.generated) continue;
    if (n.lang === "ts") totals.ts += n.lines;
    else totals.rs += n.lines;
  }

  written.push(
    write(
      "README.md",
      `# dziry — architecture diagrams\n\n` +
        `> Generated by \`bun run arch-diagram\`. Do not edit these files — regenerate them.\n\n` +
        `C4 levels 1–3 come from \`scripts/lib/arch-model.ts\`, which is hand-written and whose every ` +
        `citation is checked against the repo. Level 4 — layers, modules, health — is parsed out of the ` +
        `imports on each run and is never written down.\n\n` +
        `${g.nodes.size} source files · ${totals.ts.toLocaleString("en-US")} lines TypeScript · ` +
        `${totals.rs.toLocaleString("en-US")} lines Rust · ${g.edges.length} import edges · protocol v${PROTOCOL_VERSION}\n\n` +
        `| Diagram | Answers |\n| --- | --- |\n` +
        `| [Context](01-context.md) | Who uses this, and what does it touch? |\n` +
        `| [Containers](02-containers.md) | What processes and threads exist, and what is shared? |\n` +
        `| [Components](03-components.md) | What is inside the compiler, the app thread, the engine? |\n` +
        `| [Layers](04-layers.md) | Which layers depend on which, and how heavily? |\n` +
        `| [Modules](05-modules.md) | Every file and every import edge. |\n` +
        `| [Boundary](06-boundary.md) | What crosses into shared memory? |\n` +
        `| [Flows](07-flows.md) | What happens over time — a build, a frame, a slow handler? |\n` +
        `| [Health](08-health.md) | Cycles, layering violations, coupling hotspots. |\n\n` +
        `## Queries\n\n` +
        `\`\`\`bash\nbun run arch-diagram blast src/ir.ts     # what breaks if I change this\n` +
        `bun run arch-diagram deps src/host/worker.ts\nbun run arch-diagram cycles\n` +
        `bun run arch-diagram hotspots\n\`\`\`\n\n` +
        `## Long-form sources\n\n` +
        DOCS.map((d) => `- \`${d.path}\` — ${d.what}`).join("\n") +
        "\n",
    ),
  );

  console.log(`wrote ${written.length} files to guards/diagrams/`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const positional = argv.filter((a) => !a.startsWith("--"));
const flagValue = (name: string, fallback: number) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split("=")[1]) : fallback;
};

const graph = build();
const problems = validate(graph);

if (problems.length > 0) {
  console.error(`the architecture model is out of date with the repo:\n`);
  for (const p of problems) console.error(`  · ${p}`);
  console.error(`\n${problems.length} problem(s). Fix scripts/lib/arch-model.ts, or the code.`);
  if (flags.has("--check") || positional.length === 0) process.exit(1);
  console.error(`\n(continuing anyway — the diagram below may be wrong)\n`);
}

if (graph.missing.length > 0 && (flags.has("--check") || flags.has("--verbose"))) {
  console.error(`\n${graph.missing.length} unresolved import(s):`);
  for (const m of graph.missing.slice(0, 20)) console.error(`  ${m.from} → ${m.spec}`);
}

const command = positional[0] ?? "";
const depth = flagValue("depth", 3);

switch (command) {
  case "": {
    if (flags.has("--check")) {
      const v = violations(graph);
      const c = cycles(graph, true);
      if (v.length > 0 || c.length > 0) {
        for (const x of v) console.error(`layering violation: ${x.from} → ${x.to} — ${x.rule.why}`);
        for (const x of c) console.error(`import cycle (survives erasure): ${x.join(" ↔ ")}`);
        process.exit(1);
      }
      console.log(
        `architecture ok — ${graph.nodes.size} files, ${graph.edges.length} edges, ` +
          `${CONTAINERS.length} containers, ${COMPONENTS.length} components, no cycles, no violations`,
      );
      break;
    }
    emitAll(graph);
    break;
  }

  case "context":
    console.log(contextDiagram());
    break;
  case "container":
  case "containers":
    console.log(containerDiagram());
    break;
  case "component":
  case "components":
    console.log(componentDiagram(positional[1]));
    break;
  case "layers":
    console.log(layerDiagram(graph));
    break;
  case "modules": {
    const layer = (positional[1] ?? "compiler") as LayerId;
    if (!LAYERS.some((l) => l.id === layer)) {
      console.error(`unknown layer "${layer}" — try ${LAYERS.map((l) => l.id).join(", ")}`);
      process.exit(1);
    }
    console.log(moduleDiagram(graph, layer, { tests: flags.has("--tests") }));
    break;
  }
  case "boundary":
    console.log(boundaryDiagram());
    break;
  case "flow":
    console.log(flowDiagram(positional[1] ?? "frame"));
    break;

  case "blast": {
    const target = findFile(graph, positional[1] ?? "");
    const reached = cone(graph, target, "in", depth);
    reached.delete(target);
    const byLayer = new Map<string, string[]>();
    for (const p of reached.keys()) {
      const l = graph.nodes.get(p)!.layer ?? "none";
      if (!byLayer.has(l)) byLayer.set(l, []);
      byLayer.get(l)!.push(p);
    }
    const tests = [...reached.keys()].filter((p) => graph.nodes.get(p)!.test);
    console.log(
      `# ${target}\n\nChanging this reaches **${reached.size} file(s)** across ` +
        `**${byLayer.size} layer(s)** within ${depth} hop(s); ${tests.length} are tests.\n`,
    );
    for (const [l, files] of [...byLayer].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`**${l}** (${files.length})`);
      for (const f of files.sort()) console.log(`  ${f}${graph.nodes.get(f)!.test ? "  · test" : ""}`);
      console.log();
    }
    console.log(fence(blastDiagram(graph, target, depth)));
    break;
  }

  case "deps": {
    const target = findFile(graph, positional[1] ?? "");
    const reached = cone(graph, target, "out", depth);
    reached.delete(target);
    console.log(`# ${target}\n\nDepends on **${reached.size} file(s)** within ${depth} hop(s).\n`);
    const ext = graph.externals.get(target);
    if (ext?.size) console.log(`External: ${[...ext].sort().map((e) => `\`${e}\``).join(", ")}\n`);
    console.log(fence(depsDiagram(graph, target, depth)));
    break;
  }

  case "cycles": {
    const real = cycles(graph, true);
    const typeOnly = cycles(graph).filter((c) => !real.some((r) => r.join() === c.join()));
    if (typeOnly.length > 0) {
      console.log(`${typeOnly.length} type-only cycle(s) — erased at run time, safe to leave:\n`);
      for (const c of typeOnly) console.log(`  ${c.join(" ↔ ")}`);
      console.log();
    }
    if (real.length === 0) {
      console.log("No cycles survive type erasure.");
      break;
    }
    console.log(`${real.length} cycle(s) that survive erasure:\n`);
    for (const c of real) console.log(`  ${c.join(" ↔ ")}`);
    process.exit(1);
  }

  case "hotspots": {
    const rows = hotspots(graph).slice(0, flagValue("top", 25));
    console.log(`| File | Layer | Lines | Fan-in | Fan-out | Instability |`);
    console.log(`| --- | --- | ---: | ---: | ---: | ---: |`);
    for (const h of rows) {
      console.log(
        `| \`${h.path}\` | ${h.layer} | ${h.lines} | ${h.ca} | ${h.ce} | ${h.instability.toFixed(2)} |`,
      );
    }
    break;
  }

  case "violations": {
    const found = violations(graph);
    if (found.length === 0) {
      console.log("No layering violations.");
      break;
    }
    for (const v of found) {
      console.log(`${v.from} → ${v.to}  (${v.kind})\n  breaks: ${v.rule.from} ⇏ ${v.rule.to}\n  ${v.rule.why}\n`);
    }
    process.exit(1);
  }

  case "json":
    console.log(
      JSON.stringify(
        {
          nodes: [...graph.nodes.values()],
          edges: graph.edges,
          cycles: cycles(graph, true),
          typeOnlyCycles: cycles(graph).filter(
            (c) => !cycles(graph, true).some((r) => r.join() === c.join()),
          ),
          violations: violations(graph).map((v) => ({ from: v.from, to: v.to, why: v.rule.why })),
        },
        null,
        2,
      ),
    );
    break;

  default:
    console.error(
      `unknown command "${command}"\n\n` +
        `  (none)        validate and emit guards/diagrams/\n` +
        `  --check       validate only, exit 1 on drift, cycles or violations\n` +
        `  context | containers | components [id]\n` +
        `  layers | modules <layer> | boundary | flow <id>\n` +
        `  blast <file> [--depth=N]   what breaks if I change this\n` +
        `  deps <file> [--depth=N]    what this needs\n` +
        `  cycles | hotspots [--top=N] | violations | json\n`,
    );
    process.exit(1);
}
