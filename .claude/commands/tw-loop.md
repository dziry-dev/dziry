---
description: Grow Tailwind class coverage until tailwind-coverage stops improving
---

Grow the fraction of Tailwind that works in dziri until `tailwind-coverage` stops improving.

Run this with `/loop /tw-loop` to self-pace it, or plain `/tw-loop` for a single pass.

Sibling of `/ua-loop`, and the same shape: measure, take the top item, implement, re-measure,
revert if the number did not move. The difference is blast radius — ua-loop edits one file, and
this one can reach `src/ir.ts`, the wire protocol and Rust paint code. Read **Two tiers** before
picking work.

## Each pass

1. Run `bun run tailwind-coverage --what-if`. Note the `classes N/M work today` figure. The run
   compiles all 23k classes through the real Tailwind CLI and takes a minute or two — one run per
   pass, not one per idea.
2. **Pick from the cumulative `--what-if` list, never the ranked blocker list.** See
   *The ranked list is a trap*.
3. Check the item against **Two tiers** and against ROADMAP. If it is Tier B, that is the whole
   pass. If it is Tier A, two or three related aliases in one pass is fine.
4. Implement it. A new property is a `case` in `expandDeclaration()` in `src/compiler/css.ts`;
   check whether it can reuse an existing `STYLE_FIELDS` entry before adding one.
5. Re-run `bun run tailwind-coverage`. **If the class count did not rise, revert the edit** and
   try the next item. A property nobody's classes can use is a property nobody asked for.
6. Verify, in this order — stop at the first failure rather than pressing on:
   - `bun run check`
   - `bun test src/compiler/`
   - `bun run conformance` — the oracle for whether the property computes what Chrome computes.
     A new property that parses but computes wrongly is worse than an unsupported one, because
     the coverage number now claims it works.
   - `bun run characterize`
   - Tier B only: `bun run protocol-guard`, then `bun run golden`.

   Drift in characterize or golden is allowed but must be re-blessed deliberately and called out —
   never regenerated on autopilot.
7. Commit with a pathspec: `git commit -- src/compiler/css.ts <other touched files> <baselines>`.

## The ranked list is a trap

The ranked blocker list counts, for each blocker, how many classes it blocks. Classes usually have
several blockers, so those counts overlap and the top entry is often nearly worthless. From the
2026-08-02 run:

```
  6268  property: mask-composite     <- ranked #1
  6265  property: mask-image

  +   4  ->  9023/23286 (38.7%)  after property: mask-composite   <- what it actually unblocks
  +5887  ->  14910/23286 (64.0%)  after property: mask-image
```

`mask-composite` ranks first and unblocks **four** classes, because almost every class it blocks is
also blocked by `mask-image`. Ordering by the ranked list would spend a pass on a rounding error.
`--what-if` walks the list cumulatively and reports classes that end up with no blockers left,
which is the only figure a pass can be planned against.

`--what-if <a,b>` answers non-prefix questions — `--what-if "color-mix,translate"` for "these two,
not masks". Use it when ROADMAP removes something from the middle of the list.

## Two tiers

**Tier A — `src/compiler/css.ts` only.** Logical-property aliases onto fields that already exist,
and value-syntax work. Cheap, self-contained, no protocol change. `inset-inline-start`
(`src/compiler/css.ts:1402`) is the precedent: map the logical name onto the physical field and
return.

Prefer Tier A when the class counts are close; a pass that lands beats a pass that spans three
files.

**The logical border family is *not* Tier A, though it looks like it.** An earlier version of this
file claimed `border-inline-color` and friends fold onto the single `borderColor` field for ~1,746
easy classes. They do not. dziri has *one* `borderColor` and *one* `borderWidth`
(`src/ir.ts:124-129`), and `paint.rs:987-1018` strokes a single uniform border — one width
subtracted equally on all four sides. Folding `border-inline-width` onto that makes `border-x-2`
paint all four edges, and `border-2 border-x-red-500` colour all four red. There is no `borderStyle`
field at all, so `border-inline-style` has nothing to fold onto either.

The family is real and it is the largest non-mask item on the board — `--what-if
"border-inline,border-block"` is +1,781 classes — but it is Tier B and it is *eight* fields (four
colours, four widths) plus a paint rewrite from one stroke to four edges. `borderWidth` is a
`LAYOUT_FIELD`, so per-side widths change the Taffy box maths too. Same shape as per-corner
border-radius (`078bd11`, "four fields, because that is what CSS has") and bigger. It needs its own
plan, not a loop pass.

**Tier B — a new `STYLE_FIELDS` entry.** `fill`, `stroke`, `accent-color`, `caret-color`,
`text-decoration-color` and `outline-color` have no field to fold onto, so each one touches
`src/ir.ts`, `src/protocol/schema.ts`, the Rust paint code, and `INITIAL_STYLE`/`INHERITED_FIELDS`.
Rules:

- One Tier B property per pass. Never two.
- `bun run spec-audit` after editing `INITIAL_STYLE` or `INHERITED_FIELDS` — the initial value and
  the inheritance flag both come from the spec, not from what looks reasonable.
- `bun run protocol-guard` before committing. A field that exists on one side of the boundary only
  produces wrong pixels at a valid offset, which is the worst failure mode this repo has.
- If the property has no paint implementation yet, adding the field is not progress — it makes
  `tailwind-coverage` claim a class works when it renders nothing. Implement the paint or skip it.

## Masks are a scope call, not a backlog item

`mask-image` is the single largest item on the list at 5,887 classes — 38.7% to 64.0% in one
feature. It is also ~6,000 classes of a subsystem that may be out of scope, and
`css-coverage`'s `OUT_OF_SCOPE_GROUPS` does **not** currently list CSS Masking either way.

Do not start a masking pass on the loop's own authority. Ask, get an explicit scope decision, and
record it in ROADMAP and in `css-coverage`'s out-of-scope list so the two tools agree. Until then,
read the ranked list with masks removed: `bun run tailwind-coverage --what-if "calc,translate,color-mix"`.

## Hard constraints

- **Never add a `case` that does not implement the property.** `dziriSupported()`
  (`scripts/tailwind-coverage.ts:40-58`) detects support by scanning for `case "name":` inside
  `expandDeclaration()`. An empty case, or one that parses a value and drops it, raises the
  coverage number while changing nothing on screen. This is the one way to make this tool lie, it
  is a single line, and it is never acceptable.
- **Check what the value parsers do with the values Tailwind actually emits, before adding the
  `case`.** Support is measured per *property*, but `parseLength` and `parseColor` reject whole
  classes of *value*. Adding a `case` for a property whose values dziri cannot parse converts
  "warned and ignored" (`css.ts:1705`) into a fatal build error, because `compile.ts:290` rethrows
  `CssError` — and the coverage number goes *up* while the class goes from silently inert to
  breaking the build. `parseLength` throws on every percentage (`css.ts:1044`), which is why
  `inset` is not the free +125 it looks like: `inset-1/2` is `inset: 50%`. Run the value through
  the parser in a scratch script first.
- **Never delete or widen a `VALUE_FEATURES` entry to move the number.** When `var()` and foldable
  `calc()` landed, the `calc()` entry was *narrowed* to the part that genuinely cannot be folded
  (`scripts/tailwind-coverage.ts:145-152`) rather than removed. The number moves because the
  feature landed, not because the measuring stick got shorter.
- **Never** add an entry to any `KNOWN` table to make a run green. That table records decisions
  made elsewhere; using it to silence a finding is the one thing it must not do.
- **Always commit with a pathspec.** The git index is shared with other sessions — a bare
  `git add` has already swept another session's staged work into a commit once.
- **Coordinate on `css.ts`.** Unlike `ua-sheet.ts`, this file is live territory for other sessions.
  Check `git status` before starting and keep the diff to the `case` arms you added.
- Everything here is compile-time work and must stay that way. A property that needs runtime state
  to work is a `/compile-time-gate` conversation, not a coverage pass.

## Stop condition

Stop when the class count fails to rise for two consecutive passes. Report the starting count, the
final count, and which blockers remain and why — separating "not done yet" from "waiting on a scope
call" from "needs paint work first".

## Watch for

- **Per-corner and per-side properties are not one field.** Border radius took four fields
  (`078bd11`) because that is what CSS has. Check the shape of the existing field before assuming a
  shorthand folds onto one slot.
- **Style interning shifts indices.** Giving an element a non-inherited property can stop it
  sharing a style slot with its own text run, renumbering every later slot and failing
  `cascade.test.ts`. That is the interner working; explain it in the snapshot rather than
  renumbering silently.
- **`em` does not mean what Chrome means.** `css.ts:1056-1059` resolves both `rem` and `em` against
  the root's 16px default; nested `em` is out of scope. Relevant to any Tailwind utility whose value
  Tailwind writes in `em`.
- **The denominator moves.** It is derived from the *installed* `tailwindcss`, so a version bump
  changes both numbers. `22763` here is v4.3.3. Record the version alongside any count.
- **v4 emits things its docs do not describe.** `shadow-lg` is `--tw-shadow` plus `color-mix()`,
  not a tidy `box-shadow`. Implement against `--sample <prefix>` output, never against recall or
  the docs.

## History

| Pass | Result |
|---|---|
| baseline (2026-08-02, tailwindcss 4.3.3) | 8253/22763 (36.3%) — overstated, see below |
| fix the stick (2026-08-02) | 8162/22763 (35.9%) — added the `percentage length` blocker; no properties implemented |
| `color-mix()` against transparent (2026-08-02) | 8162 → 8495 (37.3%) as measured, **+0 real classes** — see below |
| fix the corpus (2026-08-02) | **9019/23286 (38.7%)** — phantoms removed, 872 lost classes recovered, denominator now whole |

Every figure above the last line was measured with a broken corpus. Three passes in, the loop's
entire net contribution to *coverage* is zero: pass 1 corrected the stick, pass 2's `color-mix()` was
real work that the corpus could not show (opacity modifiers are not enumerated by `getClassList()`),
and the corpus fix moved the number only by measuring correctly. What the loop actually produced was
three measurement bugs found and fixed, which is worth more than 333 classes would have been — but it
is not what the History column is for, so it is spelled out rather than left to look like progress.

Pass one raised no coverage on purpose. The first thing it found was that the baseline was wrong:
`VALUE_FEATURES` had no entry for a bare percentage, so every class Tailwind emits as a plain `%`
length counted as working — `w-full` and `h-full` among them, which are `width: 100%` and
`height: 100%` and throw a fatal `CssError`. 91 classes were being reported as supported while the
compiler refused to build them. Correcting that *lowers* the number, and that is the only honest
direction; the two candidate items it had queued up (`inset`, the logical border family) both turned
out to be blocked by findings above, so nothing was implemented.
