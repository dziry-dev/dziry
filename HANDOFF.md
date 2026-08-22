# Handoff — branch `host-window-state`

Written 2026-08-04. **16 commits, no upstream, nothing pushed.** Every harness green
except `arch:check`, which fails on four problems that predate this branch.

This branch closed all eight candidates from an architecture review whose report was
written to the OS temp directory and will not survive. What that review found, what was
done about it, and what is still open is below. Read §3 before starting anything.

---

## 1. What changed

The compiler's two large files became eight modules. `compile.ts` went 3066 → 2069 lines
and `css.ts` 4003 → 1442.

| module | lines | owns |
|---|---|---|
| `src/compiler/matcher.ts` | 463 | selector matching, specificity, the cascade → `Map<property, value>` |
| `src/compiler/computed.ts` | 599 | that map → an interned `ComputedStyle`, **and** transitions/`@keyframes` |
| `src/compiler/css.ts` | 1442 | CSS *syntax*: tokenizer, rule and selector parsing |
| `src/compiler/values.ts` | 1302 | what a declaration's right-hand side means |
| `src/compiler/properties.ts` | 1262 | the `PROPERTIES` table — **a new CSS property is a row here** |
| `src/compiler/diagnostics.ts` | 71 | `CssError`, `formatCssError`, `warnOnce` |
| `src/compiler/single.ts` | 100 | `compileSnippet({html, css})`, one document, in-process |
| `src/compiler/compile.ts` | 2069 | the tree walk, flattening, `emit`, `dump` |
| `src/host/window-state.ts` | 146 | the window setup both hosts shared by hand |

The dependency order is one-way and load-bearing:

```
diagnostics  ←  values  ←  css
                  ↑
        properties, computed
```

`diagnostics.ts` exists as its own 71 lines for exactly one reason: extracting the
selector front-end first is a **cycle**. It needs `parseLength` from below, while 70-odd
uses of `CssError` point back up at it. Three declarations on the wrong side of a
boundary were the whole obstacle.

Deleted: `src/window-host.ts`, `src/compiler/variants.ts`, `src/variants.ts`,
`src/protocol/schema.test.ts`.

Two decisions worth not re-litigating:

- **Timing lives in `computed.ts`, not beside the emitter.** A `ComputedStyle` *has*
  `transition` and `animation` fields and each is a side-table index, so resolving them
  is part of producing a style row rather than a pass over one. The alternative — a
  callback so the cascade knows nothing about timing — allocates a closure per node per
  predicate combination and moves the wiring to callers who can forget it.
  `AnimContext` (`src/compiler/computed.ts:312`) already takes the interners as
  parameters, so no dependency needed inverting.
- **`properties.ts` is split from `css.ts` because it is the part that grows.** The rest
  of that file changes when the CSS *grammar* does; `PROPERTIES`
  (`src/compiler/properties.ts:689`) changes whenever the supported surface does, which
  is far more often and for unrelated reasons.

---

## 2. How to verify a change

```
bun run neutral --save --label pre-x     # BEFORE touching anything
…make the change…
bun run neutral
```

Compares all 22 scenario renders as PNG bytes and three emitted artifacts as text
against a baseline taken minutes earlier, in `.baseline/` (gitignored).

**`golden` cannot answer "did my refactor move the output".** Its references are PNGs
committed to the repo, so they are a claim about *the demo*: edit a demo page and all 22
go red, and restoring the signal means deciding by eye whether 22 changed frames are a
fix or a regression. `neutral` renders the same working tree on both sides, so the demo
can be anything.

It hashes `windows/**` and `src/**` + the engine's Rust separately and reports what a
difference *means*: demo-only changed → `golden --accept` is safe; code-only → the change
is not neutral; neither changed but output did → nondeterminism.

**Its measured limit.** Deleting `winning.delete(prop)` from `collectDecls`
(`src/compiler/matcher.ts:304`) is a real regression that fails two unit tests, and it
leaves all 22 frames and all 3 artifacts **byte-identical** — the demo never authors a
shorthand outranking a longhand it already set. A green `neutral` proves the output did
not move *for what the scenarios reach*. Run `bun test` as well; neither replaces the
other.

The full sweep: `bun run check` · `bun test` · `bun run neutral` · `bun run characterize`
· `bun run golden` · `bun run doc-lint` · `bun run lint` (Rust) · `bun run conformance`
and `bun run layout-diff` (need Chrome).

---

## 3. Open work

### 3a. ~~`computed.ts` has no test driving it~~ — done

`computed.test.ts` now drives all eight exports directly: `applyDecls` with a declaration
map and a `VarEnv`, timing against a stub `AnimContext` (the parameter-list seam, no
pipeline), `coerceViewportOverflow`'s root rule, the two-axis overflow coercion,
`inheritFrom`, `textStyle`, and both interners — including NaN-as-`auto` interning, which
JSON keys would have folded into a collision. `cascade.test.ts` stays as it was: it covers
that the seam is wired up, which a unit test cannot.

`window-state.ts` has since grown `window-state.test.ts` (hot reload's dump/restore), and
`single.ts` still has no unit test but four harnesses call it.

### 3b. Paint regression — **attributed and reduced** (2026-08-20)

Bisected with per-commit worktrees (`git worktree`, each building its own engine —
the protocol changed, so old Rust cannot run against new TS), `scene()` verified
byte-identical across the range first, `bench --sizes 8000` per commit:

| commit | paint @8000 | |
|---|---|---|
| `adc1e7b` (2026-08-02, pre-range) | 0.373 | reference |
| `bbb5ec4` transforms | 0.542 | **+45%** |
| `05f1cd4` hit-test space | 0.529 | flat |
| `14fca2d` tween table | — | bench broken at that commit (`ui.tweens` absent) |
| `07742e5` animation clock | 0.706 | **+33%** |
| `379e14a`, `60321d4` | 0.713, 0.723 | flat |
| `f974e11` span-plan hoist | 0.651 | the quarter §3b already knew |

Two costs, both of the shape "feature machinery paid by nodes that do not use the
feature", fixed:

1. **`transform_of`/`opacity_of` read 15 style fields per node per frame** to learn
   the answer is "identity" (`bbb5ec4`; `f974e11` had hoisted the span plans but the
   reads remained). Now a per-row trait memo (`Painter::slot_traits`, invalidated per
   commit) — rows are interned and handfuls, so the question is asked per *row*.
   The ring bands in `node()` are behind the same memo's `RING` bit (worth ~nothing —
   the columns were cache-hot; kept because the mechanism already exists).
2. **`rescan_animations` ran four O(nodes) subsystem rescans on every commit with any
   diff** (`07742e5` and followers). `anims.rescan` now scans the interned style rows
   first and returns early when no row carries a tween; `controls.rescan` clears
   `DISABLED`/`INVALID` only on the nodes recorded as holding them; `images.rescan`
   skips its dense rebuild when the table has no real rows (every reader gates on
   `any` or `get`, so a stale `dense` is unobservable).

Result on this machine: 0.631 → ~0.52 ms at 8000 nodes (paint/layout 0.100 → 0.082).
**Remaining +~60% over the recorded baseline is diffuse**, ablation-measured: ~0.066
walk bookkeeping (Step growth, flags reads, blend construction), ~0.058 draw-path
accumulation, and commit-side span growth (idle 0.013 → 0.016). No single hotspot
left at that granularity.

Also fixed while verifying: `--route products/1` was rejected at startup —
`requireRoute` matched exactly and the pattern matcher only served *navigation*.
`requireRouteMatch` binds params at startup now, and the `route-param` golden
scenario drives a concrete id (its golden was stale since `8a8252f`; re-blessed).

### 3c. `guards/bench/baseline.json` lies about its own date

`--bless` stamps `new Date()` (`scripts/bench.ts:355`), yet `recorded` reads
`2026-08-01` while the 10/100/1000 rows were changed and three rows added. Those numbers
were not produced by a bless run at that date.

**Still not re-blessed, deliberately.** Attribution (3b) is done and the fix landed,
but paint is still ~60% over the recorded figure; blessing now would fold the
remainder into a green run. Bless when the remainder is either fixed or accepted in
writing here.

### 3d. Two demo files were reformatted; nothing in the repo arbitrates

`f2432ce` reformatted `windows/main/Nav.tsx` and `windows/main/pages/reactivity.tsx` from
two-space double-quoted to four-space single-quoted. `windows/main/pages/features.tsx`
and the rest are still two-space. There is no `.prettierrc`, no `.editorconfig` and no
`prettier` key in `package.json`, so the next editor to open either file will reformat it
back. Formatting does not reach the pixels, so it was left alone.

### 3e. `arch:check`'s four problems, all pre-existing

`tweens`, `keyframes` and `controls` have no `TABLE_ROLES` entry; `src/find-row.ts` and
`src/css.d.ts` belong to no layer. Unchanged by this branch — both new compiler modules
land in an existing layer root.

---

## 4. Traps this branch walked into

- **`grep` without `-a` silently truncates on a NUL byte.** `compile.ts` contained a raw
  NUL typed straight into a template literal as a group-key separator, which made the
  file *binary* to every text tool: `grep` printed "binary file matches" and suppressed
  line numbers. It hid the surviving use of `soleStyle` and a deletion went in believing
  it was dead. Now written as an escape (`src/compiler/compile.ts:475`). If a search of a
  source file comes back suspiciously empty, re-run with `grep -a`.
- **A scripted text transformation of a large function fails silently; an `Edit` against
  exact text fails loudly.** Two attempts to convert `css.ts`'s 736-line switch by script
  both produced compiling-but-wrong output — one left the old switch's tail, the other
  mangled 106 bodies containing an inner block. Both reverted. Doing it by hand in six
  batches with `bun run check` between each worked first time. For a *move*, the safe
  method is `sed`-extract plus a piecewise reassembly proof that the remainder is
  byte-identical.
- **`bench` must not compile in-process.** `compileSnippet` exists so harnesses can, and
  `conformance`, `layout-diff` and `html-coverage` all moved to it. `bench` tried and
  moved back: compiling an 8000-node tree in-process leaves that much garbage on Bun's
  heap, and what `bench` measures at 8000 nodes is cache behaviour. Measured — 8000 alone
  gives paint 0.571, but 8000 after 1000/2000/4000 gives 0.621–0.695. The reasoning and
  the numbers are in its `compile()` docblock (`scripts/bench.ts:83`). Do not "finish the
  migration" there.
- **`doc-lint` green does not mean a document is true.** It proves a cited line is in
  range, not that the line still says what the prose claims. `.claude/commands/tw-loop.md`
  described `dzirySupported()` as scanning for `case "name":` three commits after that
  became `Object.keys(PROPERTIES)`; only the out-of-range line number was flagged.
- **The architecture review's correctness claim about the harnesses was wrong.** It said
  they "measure a pipeline that does not ship" because the HTML branch skips
  `findToggles`/`compileVariants`/`resolveRefs`. It skips exactly the JSX-only steps:
  `parseHtml` sets `classWhen: null` at all three of its construction sites, so an HTML
  document cannot express a conditional class and no re-interning happens. The style
  indices those harnesses read were correct all along. Candidate 2 was a duplication fix,
  not a correctness one.

---

## 5. Tree state

Nothing pushed; no upstream is configured. These files are **other sessions'
uncommitted work** and were deliberately left untouched throughout:

```
 M .claude/settings.json
 M .claude/skills/doc-lint/SKILL.md
 M NOTES.md
 M data-layer-design.md
 D framework-design.md
 M src/host/main.ts
?? scripts/arch-diagram.ts
?? scripts/lib/arch-model.ts
```

The convention in this repo is `git commit -- <explicit pathspec>`, never `git add -A`
and never `git stash`, because sessions share one working tree.
