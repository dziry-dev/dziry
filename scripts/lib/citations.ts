/**
 * Resolving `file.ext:LINE` citations against the repo.
 *
 * Extracted from `scripts/doc-lint.ts` so the docs site can enforce the same rule
 * at build time. Two callers, one resolver: `bun run doc-lint` sweeps every
 * Markdown file in the tree, and the remark plugin in `docs/src/remark/citations.ts`
 * resolves each citation as it renders — turning it into a source link, and failing
 * `docs:build` if it does not resolve.
 *
 * Deliberately free of `Bun.*`. doc-lint runs under Bun, but Docusaurus runs under
 * Node, and a resolver that only worked in one of them would have to be written
 * twice — which is the duplication this module exists to prevent.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

/**
 * `vendor` matters as much as `node_modules`: `mdn:sync` puts ~1,500 Markdown files
 * there, and they were both being linted *and* added to the basename index — so an
 * MDN file could shadow a repo file when resolving a citation.
 *
 * `build` and `.docusaurus` are the docs site's generated output. The source pages
 * under `docs/docs` are still swept — they carry citations like everything else —
 * but indexing a built copy would let it shadow the file a citation actually means.
 */
export const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  "native",
  "dist",
  "golden",
  "vendor",
  "build",
  ".docusaurus",
]);

/**
 * A versioned crate or package directory — `skia-bindings-0.87.0/build.rs`,
 * `taffy-0.9.2/src/...`. These are citations into dependency source and are never in
 * this repo, but their *basenames* often are: `build.rs` resolved to
 * `native-src/dziry-engine/build.rs` and reported a false out-of-range. Match the
 * path shape before trusting the basename.
 */
export const VERSIONED_DEP = /(^|\/)[a-z0-9_-]+-\d+\.\d+(\.\d+)?([-+][\w.]+)?\//i;

/** `name.ext:12` or `name.ext:12-40` or `name.ext:86,159` */
export const CITATION_SOURCE =
  "\\b([A-Za-z0-9_./\\\\-]+\\.(?:ts|tsx|js|jsx|rs|css|html|json|toml)):(\\d+(?:[-,]\\d+)*)";

/** Fresh each call — a global regex carries `lastIndex` between uses. */
export const citationRe = (): RegExp => new RegExp(CITATION_SOURCE, "g");

export type Resolution =
  /** Resolved to a real file, and the cited line fits inside it. */
  | { kind: "ok"; path: string; line: number; ambiguous: boolean }
  /** Resolved to a real file, but the cited line is past its end. */
  | { kind: "out-of-range"; path: string; line: number; total: number }
  /** Git tracked this path once and it no longer resolves. A dangling reference. */
  | { kind: "rot"; why: string }
  /** Never in this repo — dependency source quoted as research, or a typo. */
  | { kind: "external"; why: string };

/**
 * The repo, indexed for citation resolution.
 *
 * Building the basename index and reading git history are the expensive parts, so a
 * Resolver is built once and reused across every citation. The remark plugin builds
 * one per `docs:build`, not one per page.
 */
export class Resolver {
  readonly root: string;
  /** basename -> every absolute path in the tree with that name */
  private readonly index = new Map<string, string[]>();
  /** Paths (and basenames) git has ever added or deleted. */
  private readonly tracked = new Set<string>();
  private readonly lineCounts = new Map<string, number>();

  constructor(root: string) {
    this.root = root;
    this.buildIndex(root);
    this.readGitHistory();
  }

  private buildIndex(dir: string): void {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) this.buildIndex(p);
      else {
        const list = this.index.get(e.name) ?? [];
        list.push(p);
        this.index.set(e.name, list);
      }
    }
  }

  /**
   * Files git has ever known about. This is what separates *rot* from a citation
   * into a dependency's source: the docs quote Taffy, skia-safe, SDL3 and Blitz
   * internals as research, and those were never in this repo, so "not found" is
   * expected. A path git once tracked and no longer resolves is a real dangling
   * reference.
   */
  private readGitHistory(): void {
    let text = "";
    try {
      text = execFileSync(
        "git",
        ["log", "--all", "--pretty=format:", "--name-only", "--diff-filter=AD"],
        { cwd: this.root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
      );
    } catch {
      // No git, or a repo with no commits. Everything unresolved then reads as
      // external rather than rot, which is the safe direction: the docs build
      // stays green instead of failing on a fact we cannot establish.
      return;
    }
    for (const line of text.split("\n")) {
      const p = line.trim();
      if (p) {
        this.tracked.add(p);
        this.tracked.add(basename(p));
      }
    }
  }

  lineCount(path: string): number {
    let n = this.lineCounts.get(path);
    if (n === undefined) {
      n = readFileSync(path, "utf8").split("\n").length;
      this.lineCounts.set(path, n);
    }
    return n;
  }

  /** Repo-relative, forward-slashed — the form used in links and messages. */
  rel(path: string): string {
    return relative(this.root, path).replace(/\\/g, "/");
  }

  /**
   * @param rawPath the path as written in the doc, e.g. `src/runtime/signal.ts`
   * @param rawLines the line part, e.g. `86`, `86,159` or `115-118`
   */
  resolve(rawPath: string, rawLines: string): Resolution {
    const name = basename(rawPath);
    const norm = rawPath.replace(/\\/g, "/");

    // Check the path shape before the basename, or a dependency citation gets
    // resolved to an unrelated repo file that happens to share a filename.
    if (VERSIONED_DEP.test(norm)) {
      return { kind: "external", why: "dependency source (versioned package path)" };
    }

    let candidates = this.index.get(name) ?? [];

    // If the citation carries directories, prefer paths that end with it.
    if (norm.includes("/")) {
      const narrowed = candidates.filter((c) => this.rel(c).endsWith(norm));
      if (narrowed.length) candidates = narrowed;
    }

    if (candidates.length === 0) {
      // A path given relative to root that the index missed (e.g. generated).
      const direct = join(this.root, norm);
      if (existsSync(direct) && statSync(direct).isFile()) candidates = [direct];
    }

    if (candidates.length === 0) {
      const known = this.tracked.has(norm) || this.tracked.has(name);
      return known
        ? { kind: "rot", why: "git tracked this path once — the file was deleted or moved" }
        : { kind: "external", why: "never in this repo (dependency source, or a typo)" };
    }

    const worst = Math.max(...rawLines.split(/[-,]/).map(Number));

    // Ambiguous basenames are common here — `compile.ts` is both `src/compile.ts`
    // and `src/compiler/compile.ts`. Picking the first match reported dozens of
    // false "out of range" hits. Prefer a candidate the line actually fits in; only
    // if none fits is the citation genuinely out of range.
    const ambiguous = candidates.length > 1;
    let target = candidates[0]!;
    if (ambiguous) {
      for (const c of candidates) {
        if (worst <= this.lineCount(c)) {
          target = c;
          break;
        }
      }
    }

    const total = this.lineCount(target);
    if (worst > total) return { kind: "out-of-range", path: target, line: worst, total };
    // The first cited line is what a link should jump to; `worst` only decides fit.
    const first = Number(rawLines.split(/[-,]/)[0]);
    return { kind: "ok", path: target, line: first, ambiguous };
  }
}

/** Every Markdown file in the tree, for the sweep doc-lint does. */
export function walkMarkdown(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") && e.name !== ".claude") continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkMarkdown(p, out);
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}
