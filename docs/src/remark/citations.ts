/**
 * Resolves `file.ext:LINE` citations in the docs at build time.
 *
 * The docs inherit this repo's habit of citing code by line — `signal.ts:140`,
 * `reactive-transform.ts:1-40`. `bun run doc-lint` already checks that those still
 * resolve across every Markdown file in the tree; this plugin applies the *same*
 * resolver (`scripts/lib/citations.ts`) as the site renders, so a citation that has
 * rotted fails `bun run docs:build` instead of shipping as a confident-looking lie.
 *
 * A resolved citation also becomes useful rather than decorative: with `sourceUrl`
 * set it links to the line; without one — this repo has no git remote yet — it keeps
 * its code styling and gains a tooltip naming the file it resolved to.
 *
 * What it deliberately does not do is check that the cited line still *says* what
 * the prose claims. That is the failure that actually caused damage here, and no
 * plugin can catch it. See the note in `.claude/skills/docs/SKILL.md`.
 */
import { citationRe, Resolver, type Resolution } from "../../../scripts/lib/citations.ts";

export type CitationOptions = {
  /** Repo root. Citations resolve against this tree. */
  root: string;
  /**
   * Link target for a resolved citation, e.g.
   * `https://github.com/you/dziri/blob/main/{path}#L{line}`.
   * Omitted — as it is today, the repo having no remote — renders a tooltip instead.
   */
  sourceUrl?: string;
  /** Report but do not fail. For `docs start`, where a hard stop is hostile. */
  warnOnly?: boolean;
};

type Node = {
  type: string;
  value?: string;
  children?: Node[];
  [k: string]: unknown;
};

/** A tiny walker, so the plugin needs no dependency to traverse the tree. */
function walk(node: Node, visit: (node: Node, parent: Node | null, index: number) => void, parent: Node | null = null, index = 0): void {
  visit(node, parent, index);
  const kids = node.children;
  if (!kids) return;
  // Backwards: a visitor may splice `kids`, and walking down keeps earlier
  // indices valid while it does.
  for (let i = kids.length - 1; i >= 0; i--) walk(kids[i]!, visit, node, i);
}

/** Built once per process, not once per page — indexing the tree is the slow part. */
let shared: Resolver | undefined;
function resolverFor(root: string): Resolver {
  if (!shared) shared = new Resolver(root);
  return shared;
}

function linkFor(opts: CitationOptions, rel: string, line: number): string | null {
  if (!opts.sourceUrl) return null;
  return opts.sourceUrl.replace("{path}", rel).replace("{line}", String(line));
}

/**
 * `code` for the citation text, wrapped in a link when we have somewhere to point.
 * External citations (dependency source quoted as research) are left exactly as
 * they were — they are not ours to link, and doc-lint does not fail on them either.
 */
function render(text: string, r: Resolution, resolver: Resolver, opts: CitationOptions): Node | null {
  if (r.kind !== "ok") return null;
  const rel = resolver.rel(r.path);
  const code: Node = { type: "inlineCode", value: text };
  const href = linkFor(opts, rel, r.line);
  if (!href) {
    // No remote to link to. Keep the code node but say what it resolved to, which
    // is the ambiguous-basename case made visible: `compile.ts:40` is two files.
    return { type: "inlineCode", value: text, data: { hProperties: { title: `${rel}:${r.line}` } } };
  }
  return { type: "link", url: href, title: `${rel}:${r.line}`, children: [code] };
}

export default function remarkCitations(opts: CitationOptions) {
  const resolver = resolverFor(opts.root);

  return function transformer(tree: Node, file: { path?: string; history?: string[] }): void {
    const where = file.path ?? file.history?.[0] ?? "<unknown>";
    const broken: string[] = [];

    const check = (text: string): Resolution | null => {
      const m = citationRe().exec(text);
      if (!m) return null;
      return resolver.resolve(m[1]!, m[2]!);
    };

    walk(tree, (node, parent, index) => {
      // A fenced code block is illustrative, not a citation of this repo — the same
      // rule doc-lint applies. `inlineCode` is where the docs put real citations.
      if (node.type === "code") return;

      if (node.type === "inlineCode" && typeof node.value === "string") {
        const text = node.value;
        const re = citationRe();
        const m = re.exec(text);
        // Only when the backticks hold the citation and nothing else. A sentence in
        // code style is prose, and rewriting part of it would mangle the node.
        if (!m || m[0] !== text.trim()) return;

        const r = resolver.resolve(m[1]!, m[2]!);
        if (r.kind === "rot") broken.push(`${text} — ${r.why}`);
        else if (r.kind === "out-of-range")
          broken.push(`${text} — ${resolver.rel(r.path)} has ${r.total} lines`);

        const replacement = render(text, r, resolver, opts);
        if (replacement && parent?.children) parent.children[index] = replacement;
        return;
      }

      // Plain prose. Only *report* here — splitting text nodes mid-sentence is not
      // worth the AST risk, and the docs' convention is to backtick citations.
      if (node.type === "text" && typeof node.value === "string") {
        const r = check(node.value);
        if (r?.kind === "rot") broken.push(`${node.value.trim().slice(0, 80)} — ${r.why}`);
        else if (r?.kind === "out-of-range")
          broken.push(`${node.value.trim().slice(0, 80)} — ${resolver.rel(r.path)} has ${r.total} lines`);
      }
    });

    if (!broken.length) return;
    const msg = [
      `${broken.length} broken code citation(s) in ${where}:`,
      ...broken.map((b) => `  ${b}`),
      "",
      "A citation that no longer resolves is worse than none — it reads as verified.",
      "Fix the line number, or drop the citation and say so in the prose.",
    ].join("\n");

    if (opts.warnOnly) console.warn(`\n[citations] ${msg}\n`);
    else throw new Error(msg);
  };
}
