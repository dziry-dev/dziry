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

### 3a. `computed.ts` has no test driving it — the biggest gap

Of the seven modules extracted, four have a test importing them and three do not:

| module | exports | test drives it? |
|---|---|---|
| `matcher.ts` | 6 | **yes** — `matcher.test.ts`, 22 tests, mutation-checked |
| `values.ts` | 21 | yes, via `css.test.ts` |
| `properties.ts` | 5 | yes, via `css.test.ts` |
| `diagnostics.ts` | 3 | yes, via `css.test.ts` and `stylesheet.test.ts` |
| **`computed.ts`** | **8** | **no — only reachable through `compile()`** |
| `window-state.ts` | 4 | no |
| `single.ts` | 4 | no unit test, but four harnesses call it |

**Do not count `values`/`properties`/`diagnostics` as work done.** `git log` on
`css.test.ts` shows only import repointing: those tests already drove `parseColor`,
`parseLength`, `expandDeclaration` and `CssError` directly. The split revealed they were
seam tests; it did not create them.

This matters because the review's entire argument for lifting the cascade out of
`compileTree` was that asserting one integer required driving an HTML parse, the UA
sheet, `@property` merging, keyframes, every variant cascade and ten typed-array builds.
The seam now exists and the matcher half has tests. The computed half does not, so the
stated benefit is half delivered — and nothing surfaces that: `bun test` is green and
`arch:check` does not look for it.

The work: a `computed.test.ts` driving those 8 exports — `applyDecls`
(`src/compiler/computed.ts:73`) with a declaration map and a `VarEnv`, `resolveTiming`
against a stub `AnimContext` (cheap, since it takes the interners as parameters),
`coerceOverflow`'s two-axis rule, `inheritFrom`. That is the ~35 `cascade.test.ts`
pipeline tests the review said should become unit tests. **Keep `cascade.test.ts`** — it
covers that the seam is wired up, which a unit test cannot.

### 3b. Paint is ~76% over `bench`'s baseline at 8000 nodes, cause unattributed

`bun run bench` showed paint **+129%** against `bench/baseline.json` at 8000 nodes,
reproducible to three decimals across runs while layout held — so not thermal. Per node
paint had gone 0.040 → 0.091 µs: a multiplicative factor at every size from 1000 up, not
a new superlinear term.

A quarter was found and fixed. `transform_of`
(`native-src/dziri-engine/src/paint.rs:395`) called `Tables::f32s` nine times per node
*before* the early-out that decides a node has no transform, and `opacity_of` a tenth.
`f32s` resolves a span plan through two dependent loads, matches the arena, bounds-checks
a byte range and casts it — cheap once, not ten times per node per frame. `StyleCols`
(`native-src/dziri-engine/src/paint.rs:355`) hoists the fourteen columns once per frame,
which `paint()` already did for `hidden`/`first`/`next`. Result: 0.729 → 0.562 ms at
8000, and `paint/layout` 0.095 → 0.068.

`Blend` and `blend.f32` both arrived in one commit — `07742e5`, the animations one — so
that is where the indirection came from.

**Still open: the remaining ~76%.** Seven commits touched `paint.rs` since the baseline:
`bbb5ec4`, `05f1cd4`, `07742e5`, `14fca2d`, `379e14a`, `60321d4`, `2a2039f`. Attributing
it needs a measurement per commit, and `git worktree add` rather than a checkout — the
protocol changed, so old Rust will not run against new TS.

### 3c. `bench/baseline.json` lies about its own date

`--bless` stamps `new Date()` (`scripts/bench.ts:355`), yet `recorded` reads
`2026-08-01` while the 10/100/1000 rows were changed and three rows added. Those numbers
were not produced by a bless run at that date.

**Deliberately not re-blessed**: doing so folds the figures in 3b into a green run and
the regression stops being visible anywhere. Attribute it first.

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
  described `dziriSupported()` as scanning for `case "name":` three commits after that
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
