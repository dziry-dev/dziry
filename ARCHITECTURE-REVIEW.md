# dziri — architecture review

Date: 2026-07-30 · Reviewed against the working tree, before the repo was placed under git.

> **Since the review ran:** `git init` and a `.gitignore` covering `target/`, `native/`, `*.nupkg`,
> `*.zip` and `app/ui.gen.ts` have landed, and nothing large is staged. That closes fix-first item 1
> in Part 1 §3 and the `not-a-git-repo` finding under *Code quality, tests & process*. The rest of
> that finding — no CI, no formatter or linter config — still stands.

**Scope.** The TypeScript compiler, the Rust engine (SDL3 + Taffy + Skia), and the shared-memory protocol between them. Roughly 8,000 lines of TypeScript and 5,000 lines of Rust.

**Method.** Ten independent reviewers, one per dimension, each reading the actual source and required to cite `file:line`. Every finding then went to an adversarial verifier instructed to refute it — claims that could not be substantiated were dropped, and severities were re-assigned by the verifier rather than the finder. A final synthesis pass produced the verdict in Part 1. 21 agents, ~3.3M tokens, 811 tool calls.

| | Count |
| --- | --- |
| Findings surviving verification | 114 |
| — high severity | 15 |
| — medium | 49 |
| — low | 50 |
| Critical (memory unsafety / data corruption / dead end) | 0 |
| Confirmed by the refutation pass | 52 |
| Weakened (real but overstated — severity lowered) | 62 |
| Refuted and dropped | 5 |

Findings are stated as claims with evidence, not as instructions. Where the reviewers disagreed, the disagreement is preserved — see the end of Part 1 and the `Verifier` line on each finding.

**Contents.** [Part 1 — Verdict](#part-1--verdict) · [Part 2 — Findings](#part-2--findings) · 
[Part 3 — What is already right](#part-3--what-is-already-right) · 
[Part 4 — Refuted claims](#part-4--refuted-claims)

---

## The fifteen high-severity findings

Nothing was rated critical: no memory unsafety, no data corruption, no architectural dead end.
These fifteen are the ones that are wrong today.

| Area | Finding |
| --- | --- |
| Protocol & code generation | [Descriptor check compares field COUNT only; same-width reorder or retype corrupts silently](#f-protocol-codegen-descriptor-check-is-count-only) |
| Protocol & code generation | [MAX_FIELDS = 64 is hand-written with no assert; styles is already at 48 and growing](#f-protocol-codegen-max-fields-64-no-static-assert) |
| Compiler: CSS cascade, parsing, variants | [Shorthands apply at their FIRST cascade position, losing to an earlier longhand](#f-compiler-css-cascade-shorthand-insertion-order) |
| Compiler: CSS cascade, parsing, variants | [INITIAL_STYLE.align = FLEX_START; CSS initial `normal` behaves as stretch](#f-compiler-css-align-items-initial-wrong) |
| Compiler: CSS cascade, parsing, variants | [Toggle-introduced state styles are emitted but the node is never made interactive](#f-compiler-css-materialized-state-not-interactive) |
| Compiler: CSS cascade, parsing, variants | [The selector token regex silently turns attribute selectors into a bogus type selector](#f-compiler-css-selector-token-scanner-silently-corrupts) |
| Authoring front-end: JSX runtime & reference resolution | [HTML front-end emits an unparseable ui.gen.ts for any onclick, and reports success](#f-authoring-frontend-html-onclick-emits-invalid-module) |
| Authoring front-end: JSX runtime & reference resolution | [Any list-item expression that is not a bare property read miscompiles silently](#f-authoring-frontend-item-recorder-silent-miscompile) |
| Runtime: signals, patches, dynamic lists | [Paint-only vs relayout is decided three times and enforced nowhere](#f-runtime-reactivity-paint-only-still-relayouts) |
| Engine: layout (Taffy) & table management | [A parent/child cycle through the root stack-overflows Taffy — an abort, not a panic](#f-engine-layout-parent-child-cycle-stack-overflow) |
| Windowing, input & threading | [`SDL_StartTextInput` is never called, so TEXT_INPUT never fires and the IME is inert](#f-window-input-threading-text-input-never-started) |
| Code quality, tests & process | [4,000 lines of compiler with zero unit tests; the cascade is unverified](#f-quality-tests-process-compiler-has-no-unit-tests) |
| Code quality, tests & process | [The variant compiler's correctness oracle guards a duplicate and asserts nothing](#f-quality-tests-process-variant-oracle-unreachable) |
| Code quality, tests & process | [Not a git repo, no .gitignore, ~1 GB of build output and a 79 MB nupkg in the tree](#f-quality-tests-process-no-gitignore-not-a-repo) |
| Code quality, tests & process | [The compiler↔runtime contract is the one thing not typechecked: `as unknown as CompiledUi`](#f-quality-tests-process-generated-module-untypechecked) |

---

# Part 1 — Verdict

**Yes, the architecture is good — with three exceptions.** The six core bets are sound and four of them are better than the doc comments claim. The exceptions are not bets, they are three places where the design's own guarantees are unenforced: (1) the protocol generator generates *layout* but not *identity*, and nothing gates regeneration, so the safety story that justifies the whole shared-memory path is currently a habit; (2) interaction state is a three-column enum that cannot express the variant surface A1 has already committed to — that is the piece that gets torn out; (3) a 4,000-line compiler with zero unit tests has accumulated six silent-wrong-output bugs, and two of them *ship a wrong artifact* rather than failing the build. Fix those three classes and the thesis holds.

---

## 1. The core bets

**(a) Compile-time CSS/cascade → integer IR — KEEP.** Every failure found is an implementation bug in an untested compiler, not a consequence of resolving early; but "a compile error beats a silent approximation" is currently false in at least six places, so the bet's own value proposition is not yet delivered.

**(b) Shared-memory SoA tables instead of FFI calls — KEEP.** The mechanism is right and its real justification is stronger than the stated one — span-wise `commit` + `classify` + `collect_changed_slots` (`tables.rs:498-562`) is what turns "some bytes changed" into a narrow patch, and AoS would make a `hidden` toggle a full rebuild — but the zero-FFI win is currently cancelled downstream, because a colour-only patch still runs Taffy and a repaint is still full-window.

**(c) Rust cdylib (SDL3 + Taffy + Skia raster) from Bun — KEEP.** Taffy and Skia were chosen on measurements and both hold; SDL3 was chosen for IME and `SDL_StartTextInput` is never called (`window.rs:183` consumes `TextInput`, nothing enables it), so the argument that decided the dependency is completely unexercised — a two-line fix, not a wrong bet.

**(d) Signal-object-identity + module-export reverse-mapping — KEEP.** Identity is the only mechanism that turns "is this a signal?" into a compile-time answer without a naming convention, and the "per-instance state is unrepresentable" objection was refuted; what needs work is the diagnostic layer around it, not the mechanism.

**(e) Precompiled interaction-state variants — KEEP-WITH-CHANGES (structural, before A1).** Patching the *style table* per `(field, slot)`, with slots interned over the *vector* of values across all variants (`variant-compile.ts:200-214`), is the single best idea in the compiler and makes the upgrade cheap — but the three fixed roles (`hover`/`active`/`focus`) are the wrong shape, and `paint.rs:96-101` makes hover beat focus outright.

**(f) Fixed-stride arenas for dynamic lists — KEEP-WITH-CHANGES.** Never invalidating a node id (append-and-abandon growth, `list-runtime.ts:75-85`) is exactly right and is why focus survives a reorder — but three of the arena's four claimed properties aren't delivered: the wrapper node breaks grid, the engine throws away link granularity and rebuilds all of Taffy per mutation, and `dataOffset` (the virtualization story) exists only in `ir.ts`.

---

## 2. Solved the wrong way, ranked

1. **Cross-side agreement is checked by counting.** `host.ts:268-272` comments "Identity is generated on both sides" and then compares field *counts* only; `elemSize` is read and never validated (`host.ts:243/257`), `FIELD_NAMES` is generated and never transmitted, `MAX_FIELDS = 64` is a hand-written stride with styles already at 48 (`tables.rs:582`), `PROTOCOL_VERSION` is hand-edited (`schema.ts:327`), and four `#[repr(C)]` boundary structs live outside the schema entirely. **Better:** emit `ELEM_SIZES` and assert per span in the bind loop; emit `MAX_FIELD_COUNT` as the stride (or `const _: () = assert!(…)`); derive `PROTOCOL_VERSION` from a hash of `TABLES`; add `gen-protocol --check` to CI. Note the aliasing direction: `plan()` is table-major, so a 65th styles field is *overwritten* by `states.node` and it is `plan_of(Styles, 64)` that reads state bytes — and only the last table would panic; earlier ones alias silently.
2. **"Make the mistake obvious" used where "make it impossible" was available.** `item-path.ts:22-24` hands out a `toPrimitive` stringifier, which converts what would be a hard `TypeError` into `strings = ["#[item.id] [item.title]"]` with `slotsPerItem: 0` and a success line — every row renders one frozen constant forever. Same pattern in `console.warn` for unsupported properties (`css.ts:685`) and in the emitter interpolating an empty handler name. **Better:** an un-internable sentinel (`\0item:path\0`) that throws if it reaches `internString`; error when a keyed template yields zero item bindings and zero item handlers; a `when(t.done, a, b)` primitive for the untrappable ternary; an identifier regex on every emitted name.
3. **The layout/paint distinction is computed at build time and has no protocol field.** `STYLE_FIELDS[i][3]` knows the answer, `patches.ts:48` computes `Dirty.PAINT`, and nothing consumes it: `tables.rs:542` discards `span.field`, so `bg` is indistinguishable from `padTop`, `resync` pushes the whole `Style`, and `set_style` marks ancestors dirty unconditionally. **Better:** generate `LAYOUT_AFFECTING: [bool; FIELD_COUNT]`, split `diff.styles` into layout/paint, gate `compute` on the layout half. Today's 3-line down payment: guard `apply_style` with taffy's `Style: PartialEq`. (Contested: the cost is ~135µs at 1215 nodes, not a re-shape — the advance cache absorbs measurement — so this is a *correctness-of-the-claim* fix now and a real cost after A2.)
4. **Interaction state as three named columns.** Replicated across `BuiltNode`, `StateTable`, `schema.ts`, `protocol.rs`, `paint.rs::style_for` and `ROLE_NAMES`; expresses "one style per fixed role, pick by precedence" and nothing else, while `Selector.pseudo` is one scalar for the whole selector. **Better:** one variant-mask slot table — per interactive node a dense run indexed by a bitmask of compiler-defined predicates (self:hover/active/focus-visible, group-G-hovered, data-state, viewport≥N), plus a per-node read mask; runtime becomes `slots[node][live & mask[node]]`. Correct hover∧focus merging falls out because `collectDecls(rules, path, ["none","hover","focus"])` already computes it. Move `pseudo` into `Compound` at the same time. (Contested: one reviewer calls this urgent; the refutation pass notes the existing patch mechanism *can* express a foreign predicate, so treat it as scheduled design work, not an unnoticed defect.)
5. **Cascade order carried by `Map` insertion position.** `compile.ts:109-111` uses `winning.set()`, which updates in place, so a shorthand expands at its *first* cascade position — `.card{padding:14px} .card{padding-left:4px} .x .card{padding:2px}` gives `padL=4`, and `style="padding:0"` loses to an earlier longhand, contradicting the doc comments at `compile.ts:365-372`. **Better:** `winning.delete(p); winning.set(p, v);` in both `collectDecls` and `withInline`. One line each.
6. **The CSS front-end validates tokens instead of validating coverage.** `part.match(/[#.:]?[A-Za-z0-9_-]+/g)` with no total-coverage check turns `input[type="text"]` into `{tag:"text"}` and `div[hidden] span` into a *different plausible selector*; `parseCss` finds bounds with `indexOf` and no depth counter, so any rule after a `@media` dies on `could not parse compound selector "}"`; `stripComments` spans a `/*` inside a `url()` and eats the next rule. **Better:** `if (tokens.join("") !== part) throw` today; `css-tree` for selector + block structure before A1 (attribute selectors and `data-[state=]` are on the shadcn critical path), keeping the hand-written value expander — that part carries the project's opinions.
7. **`LIST` as a real wrapper node copying `CONTAINER_FIELDS`.** It fixes `align-items`/`gap` for a flex column and breaks grid entirely — the wrapper is one grid item in one cell with its own N tracks inside, and `justify-content` distributes one shrink-wrapped child. **Better:** no wrapper. `relink` rebuilds child lists from the chains every structural change, so record container + `prevSibling` anchor in the `lists` table and have `updateList` splice `prev.nextSibling → firstRow … lastRow.nextSibling → nextStatic`. Same write count, and `display: contents` stops needing emulation.
8. **Two coarse "something changed" booleans where the index set is already in hand.** `diff.structure` for any link write → full `TaffyTree` rebuild over *capacity*; `diff.node_styles` → `apply_all_styles` over capacity. `collect_changed_slots` is right there and generic. **Better:** `changed_links` / `changed_nodes` vectors + `relink_nodes(&[u32])` and per-node `apply_style`; reserve `rebuild` for `fresh` and capacity changes.

Also concretely better, lower blast radius: `Result<_, EngineError{status, detail}>` instead of `Result<_, String>` (today `tick` reports `LAYOUT` for Skia and SDL failures alike); a generation-indexed handle table instead of raw pointer + magic (fixes the UAF read of the sentinel, makes double-destroy a lookup miss, and supplies the thread-safe handle A0 step 3 needs); an inverse-index `Map` for keyed slot matching instead of an O(items×capacity) scan; `draw_drrect` between border box and padding box instead of an inset stroke (fixes outer/inner radius *and* generalises to per-corner/per-side utilities).

---

## 3. Fix before anything else

**Unsound or wrong today**

1. `git init` + `.gitignore` (`target/`, `node_modules/`, `*.nupkg`, `*.zip`, `native/**/*.dll`), then delete the 79 MB nupkg, the SDL zip and the three dead DLLs in `native/win32-x64/`. Not a code fix; it is first because it is the only item whose cost becomes infinite once history is published — 1.1 GB, 622 MB of it `target/`.
2. **Item-path stringification** (`item-path.ts:22`). The only defect that produces a wrong shipped artifact from valid-looking source with zero diagnostics.
3. **Descriptor identity + the `MAX_FIELDS` const assert.** Three generator lines and one const assert convert an entire future class of wrong-bytes-at-a-valid-offset into a build error.
4. **Cascade ordering** (`compile.ts:109`, `:375`). Inline style not beating the cascade is wrong on a two-level sheet.
5. **Variant correctness holes:** `buildInteractive` must take the variant pointers (`compile.ts:785` vs `:800`) — `body.light .x:hover` currently emits a correct slot and a node that can never be hovered; reject a compound whose classes belong to two different toggles (silently no patch, no warning today); make `variants.warnings` a non-zero exit (`src/compile.ts:82`).
6. **`align: Align.START` → `UNSET`** (`ir.ts:189`). CSS initial `normal` behaves as stretch and the engine already handles `UNSET` correctly. Contested: reviewers split on cost — six `align-items: stretch` workarounds exist in `app.css` (14, 19, 56, 65, 80, 260), four of them flex, so this re-lays-out the whole sample and needs a diffed migration, not a two-line edit.
7. **HTML front-end `onclick`** emits `{ node: 1, fn:  }` and prints a success line (`src/compile.ts:104-106` never calls `resolveRefs`). Guard the emitter with an identifier regex — the guard already exists eleven lines away for text parts — then either wire `resolveRefs` into the HTML path or retire the path.
8. **Parent/child cycle** → process abort. `relink`'s budget is sibling-only (`layout.rs:88-113`); `firstChild[root] = root` reaches `compute_layout` and overflows the stack, which `catch_unwind` cannot contain. One DFS-from-root acyclicity check subsumes all three existing budgeted walks.
9. **Clamp grid inputs** (`layout.rs:467-477`): measured 181 ms and 1.41 s single frames, plus a taffy overflow that panics in debug and *wraps silently in release* — and `package.json:9` is `cargo test --release`.
10. **`SDL_StartTextInput`** + `SDL_SetTextInputArea` + modifier mask in `Event.b`. Plain Latin typing into a shipped editable is broken, not just IME.

**Will have to be torn out later — do it before the work that lands on top**

The mask-based state table before A1. `LAYOUT_AFFECTING` + the diff split before A2 (SkParagraph turns a spurious relayout into a re-shape). The `LIST` wrapper before any grid list or absolute row. `changed_links`/`relink_nodes` before lists get real. `jsxDEV`'s `_source` → `Element.loc` + byte offsets on `CssError` before `--explain` exists (a location added later touches every error site; added now it is one field and one argument). The handle table before A0 step 3. `EngineError` before any host keys recovery on a status. `satisfies CompiledUi`/`StyleTable` emitted into `ui.gen.ts` — 7 `as unknown as` casts delete themselves and `tsc` starts checking the one interface it currently cannot see. Wire `dataOffset` or delete it. `rm -rf native-src/taffy-ffi` (dead, and already diverged from `layout.rs`'s conversion rules).

**Cheap and high-value**

`"test"`, `"check": "tsc --noEmit"` and one CI workflow; rename `engine-smoke.ts` to a `.test.ts` so its FFI round-trip, GC and panic-survival assertions actually run. Table-driven tests for `css.ts`'s value parsers plus golden IR snapshots through the existing `dump()` — highest coverage per line in the repo. Point `verifyCompose` at the production `compileVariants` and delete the duplicated algorithm. `subscribe` on a computed must self-prime (`void self.value`) — today the app works only because `applyX` runs before `subscribeX` in `app.ts`. `tokens.join("") !== part`. The `PartialEq` guard. A viewport reject in `Painter::paint`. `s.border` in `style_of` + `draw_drrect`. `set_edging(SubpixelAntiAlias)` + `set_subpixel(true)`. Fill spare style slots from `INITIAL_STYLE` through the mapping table instead of three hand-listed fields. `.fill()` for uniform typed arrays (15% of `ui.gen.ts`). Writer-reported dirty string slots + incremental byte total + only call `grow` when a count changed — that alone removes a full arena realloc and Taffy rebuild *per keystroke*. `hit_test(root)`. Capacity check before `take_png` (today a short buffer destroys the frame and the retry returns `OK` with zero bytes). UTF-8 boundary truncation in `read_last_error`. `#![deny(unsafe_op_in_unsafe_fn)]` + clippy/fmt.

---

## 4. Already right — protect from well-meaning refactors

- **`Arena` as a bare `*mut u8`, with `&[u8]`/`&mut [u8]` materialised only inside function bodies** (`tables.rs:101-133`). This single detail is why the model is sound: no Rust reference into shared memory is live across a return to Bun. Never store a slice into a struct field. Never "simplify" the arena to a `Vec<u8>` — the comment explaining why (alignment is 1 byte) is load-bearing.
- **The staged/live/bounds split and span-wise `commit`.** This — not monomorphism — is the real argument for struct-of-arrays, and it is the same mechanism that will make the render thread safe. Do not collapse to one arena; do not go AoS.
- **The FFI boundary shape in full:** `catch_unwind`, i32 status never a value, out-pointers, poisoning, magic-number handle check, `panic = "unwind"` pinned in *both* profiles with the reason. Keep the Cargo profile comment.
- **Systematic distrust of host-written table contents:** budgeted iterative walks in `relink`/`read_back`/`paint`/`hit_test`, range-checked child ids, `Tables::string` returning `""` on a bad `(offset, length)` with a negative test. The acyclicity check is a strengthening of this pattern, not a replacement.
- **Style-table patching per `(field, slot)` with slots interned over the value vector across variants.** Do not "simplify" to swapping per-node style pointers — patch-level conflict detection and the mask-table upgrade both depend on this.
- **Resolving each pseudo-state as a full cascade from scratch**, not a patch over the finished base (`compile.ts:84-114`). This is what makes correct per-property hover∧focus merging cheap, and the 10-line argument above it is the reason.
- **Engine-side sentinel decoding:** NaN and ±Inf → auto, grid line 0 → `Auto` (which is what stops taffy's `panic!("Grid line of zero is invalid")`), `UNSET` → Taffy's default. The `align` bug is the compiler failing to *use* this, not the engine being wrong.
- **Deriving instead of restating** where it already happens: `Justify.START = SchemaJustify.FLEX_START` in `ir.ts`, `FIELD_ORDER` sorted out of the generated map in `host.ts:512`. Extend this pattern; that is exactly what §2.1 asks for.
- **Append-and-abandon list growth** — no node id is ever invalidated, which is the only reason focus survives a reorder — and the greedy right-to-left descendant matcher, the collision-free interner key, DynText part merging into one IR node, the bounded advance cache with a test that proves it stays bounded, absolute-path `dlopen` from `import.meta.dir`, and the one TS test locating nodes by computed style rather than index so `app.tsx` can be edited freely.
- **The doc-comment culture that records the rejected alternative and why.** A refactor that tidies these away deletes the only record of why the code is shaped as it is — including the two comments this review used to find bugs.

**Where the verdict is genuinely contested:** the cost and urgency of `align: UNSET` (two lines vs. a corpus migration); whether the three-role state table is a present defect or scheduled design work; and how much the paint-only relayout actually costs today (~135µs, not a re-shape — the "most expensive frame in the app" framing was overstated, and becomes true only after A2). Everything else in §3 survived refutation with its severity intact.

---

# Part 2 — Findings

Grouped by review dimension, severity-ordered within each. `Verifier` records what the adversarial
pass concluded: *confirmed* means it survived intact, *weakened* means real but narrower or cheaper
than first claimed.

## Protocol & code generation

*12 findings — 2 high, 7 medium, 3 low.*

- **high** · [Descriptor check compares field COUNT only; same-width reorder or retype corrupts silently](#f-protocol-codegen-descriptor-check-is-count-only)
- **high** · [MAX_FIELDS = 64 is hand-written with no assert; styles is already at 48 and growing](#f-protocol-codegen-max-fields-64-no-static-assert)
- **medium** · [Nothing forces regeneration when schema.ts changes: no build step, no hash, no CI](#f-protocol-codegen-no-regeneration-gate)
- **medium** · ["Adding an enum value needs no version bump" is unsafe: engine match arms swallow unknowns](#f-protocol-codegen-enum-addition-policy-unsafe)
- **medium** · [IR-to-schema style mapping is a hand-written 46-entry table with an already-stale doc](#f-protocol-codegen-ir-schema-mapping-is-handwritten)
- **medium** · [nodes.style is u16 and nodes.list i16; the compiler truncates into them unchecked](#f-protocol-codegen-u16-style-ceiling-unchecked)
- **medium** · [EngineConfig, Capacities, SpanDesc and Event sit outside the schema, mirrored by hand](#f-protocol-codegen-ffi-structs-outside-the-schema)
- **medium** · [Two descriptor-rebind sites, one notifier: tick()'s rebind never reaches the Uploader](#f-protocol-codegen-two-rebind-sites-one-notifier)
- **medium** · [NodeFlags is hardcoded in the generator, so schema.ts's copy changes nothing](#f-protocol-codegen-nodeflags-hardcoded-in-generator)
- **low** · [close() frees the arenas but leaves every typed-array view live over freed memory](#f-protocol-codegen-close-leaves-dangling-views)
- **low** · [SoA is right for patch and diff, wrong for the stated paint reason; 40 lookups per node](#f-protocol-codegen-soa-argues-the-wrong-thing)
- **low** · [The spare-style-slot unset fill handles 3 of 46 fields, leaving maxWidth: 0 and basis: 0](#f-protocol-codegen-spare-style-slot-fill-covers-3-of-46)

<a id="f-protocol-codegen-descriptor-check-is-count-only"></a>

### HIGH · Descriptor check compares field COUNT only; same-width reorder or retype corrupts silently

`soundness` · `protocol-codegen/descriptor-check-is-count-only`

**Where:** `src/engine/host.ts:272`, `src/engine/host.ts:243`, `src/engine/host.ts:257`, `native-src/dziri-engine/src/tables.rs:50`, `native-src/dziri-engine/src/protocol.rs:135`, `src/protocol/schema.ts:8`

**Claim.** schema.ts claims offsets are "checked against the generated field count", and that is literally all that is checked: the descriptor carries no field name and its `elem_size` is never compared against the schema's, so a same-width reorder or a compatible retype passes every guard and silently reads the wrong bytes.

**Evidence.** `SpanDesc` (tables.rs:50-58) is `{ table: i32, field: i32, ptr: u64, elem_size: u32, capacity: u32 }` — no name. protocol.rs:135 generates `pub const FIELD_NAMES: [&str; FIELD_COUNT] = ["bg", "fg", ...]` and `field_names()` is used only by a Rust-internal test (tests/bounds.rs:410), never transmitted. Host-side, the only assertion is:
```ts
for (const name of TABLE_NAMES) {
  if (seen[name] !== FIELD_COUNTS[name]) { throw ... }
}
```
and `elemSize` is consumed for sizing only, never validated:
```ts
const elemSize = view.getUint32(at + 16, true);
const buffer = toArrayBuffer(address as Pointer, 0, elemSize * capacity);
const Ctor = (FIELD_VIEWS[name] as ...)[field];   // width from TS, not from the engine
```

**Impact.** Swap `minWidth` and `maxWidth` in schema.ts (both f32, indices 34/36) and rebuild only the TS side: counts match (48), widths match (4), indices match. The host writes max-width into the span the engine reads as min-width. No error, wrong pixels — precisely the failure the file's doc comment says the design exists to prevent. A retype is worse: change `gridColumns` u16→u32, styles capacity is 48 (even), so the span is 96 bytes and `new Uint32Array(96)` succeeds with 24 elements; writes to slot 20 land in the engine's slots 40-41. Only an odd capacity makes `new Ctor(buffer)` throw, so the guard that does exist is accidental.

**Recommendation.** Put the identity in the descriptor. Either (a) add `name_hash: u32` (FNV of the generated FIELD_NAMES entry) to `SpanDesc` and have `#bindTables` compare it against a hash the generator emits into generated.ts alongside FIELD_VIEWS, or (b) cheaper and sufficient: emit `ELEM_SIZES` into generated.ts from the same `ELEM_SIZE[f.type]` the Rust side uses and assert `elemSize === ELEM_SIZES[name][field]` per span in the loop at host.ts:238-267. (b) is three generator lines and catches every retype; (a) additionally catches every reorder. Both are strictly better than counting.

**Verifier — confirmed.** I tried to find any width/identity check and there is none. `SpanDesc` is exactly `{table:i32, field:i32, ptr:u64, elem_size:u32, capacity:u32}` (native-src/dziri-engine/src/tables.rs:50-58) — no name, no hash. `protocol::field_names()` exists (protocol.rs:51) but its only consumers are tables.rs:255 (Rust-internal plan building uses `elem_sizes`) and tests/bounds.rs:402-410 — never transmitted, confirmed by grep over src/ and tests/. Host-side, host.ts:243 reads `elemSize` and uses it only for `toArrayBuffer(address, 0, elemSize * capacity)`; the constructor at host.ts:257 comes from `FIELD_VIEWS[name][field]`, i.e. the TS generated schema, and is never compared against the engine's reported width. The only cross-side assertion is the count loop at host.ts:272-279. I also verified the accidental-guard claim: `new Uint32Array(buffer)` over a 96-byte buffer (u16 elem_size 2 x styles capacity 48) yields 24 elements and does not throw; only an odd capacity makes byteLength%4!=0 and raises RangeError. The gen-protocol.ts TS emitter emits `FIELD_VIEWS` but no `ELEM_SIZES` (scripts/gen-protocol.ts:150-155), so recommendation (b) is indeed three lines. The one mitigation the finding omits is the `dziri_protocol_version()` handshake (host.ts:167-174), which would catch a stale binary — but PROTOCOL_VERSION is a hand-edited constant (schema.ts:326-329) with no enforcement, so it is a policy, not a guard. Severity holds.

<a id="f-protocol-codegen-max-fields-64-no-static-assert"></a>

### HIGH · MAX_FIELDS = 64 is hand-written with no assert; styles is already at 48 and growing

`soundness` · `protocol-codegen/max-fields-64-no-static-assert`

**Where:** `native-src/dziri-engine/src/tables.rs:582`, `native-src/dziri-engine/src/tables.rs:291`, `native-src/dziri-engine/src/tables.rs:334`, `native-src/dziri-engine/src/protocol.rs:133`

**Claim.** The (table, field) → span index is a flat array strided by a hand-written `MAX_FIELDS = 64` that is not generated from the schema and not asserted against it. The styles table already has 48 fields, and the roadmap has the compiler "growing into the schema"; the 65th style field silently aliases into the next table's slots.

**Evidence.** ```rust
const MAX_FIELDS: usize = 64;
fn build_index(plan: &[SpanPlan]) -> Vec<i32> {
    let mut index = vec![-1i32; TABLE_COUNT * MAX_FIELDS];
    for (i, span) in plan.iter().enumerate() {
        if span.table >= 0 { index[span.table as usize * MAX_FIELDS + span.field as usize] = i as i32; }
    }
```
and `plan_of`: `let i = self.index[table * MAX_FIELDS + field]; debug_assert!(i >= 0, ...)`. protocol.rs:133: `pub const FIELD_COUNT: usize = 48;` for styles. Nothing relates the two.

**Impact.** Add 17 style properties (the roadmap's stated direction) and `styles` reaches field 64. `build_index` writes `index[1*64 + 64] = index[128]`, which is the slot for table 2 field 0 (`states.node`). `plan_of(States, NODE)` then returns the styles field-64 span — a correctly aligned, in-bounds, wrong-table read. `debug_assert!` never fires because the entry is populated, just by the wrong span. Release builds corrupt silently; this is the same failure class the module's own comment at tables.rs:344-349 celebrates having caught once ("it is *the wrong bytes*, which is exactly the failure mode the whole schema-generation design exists to prevent").

**Recommendation.** Generate the stride. Emit from gen-protocol.ts `pub const MAX_FIELD_COUNT: usize = <max over tables>;` and use it in place of the literal, or keep the literal and add `const _: () = assert!(protocol::MAX_FIELD_COUNT <= MAX_FIELDS);` — a const assert turns this into a compile error. Better still, drop the flat index for `Vec<Vec<i32>>` sized by the real per-table field count, which removes the constant entirely.

**Verifier — confirmed.** I tried to find a guard and there is none: grep for MAX_FIELDS across native-src/dziri-engine returns only tables.rs:291, 294, 334 and the definition at 582 (plus rlib binaries) — no `const _: () = assert!`, no debug_assert relating it to protocol::FIELD_COUNTS, and no test in bounds.rs/boundary.rs. The collision arithmetic checks out exactly as claimed: TABLE_COUNT is 6 so the index vec is 384 entries; with styles (table 1) at 65 fields, build_index writes `index[1*64 + 64] = index[128]`, in bounds and therefore no panic, and `plan_of(2, 0)` — states.node, since the table order is nodes, styles, states, lists, layout, strings — reads `index[128]` and returns the styles field-64 span. `debug_assert!(i >= 0)` at tables.rs:335 cannot fire because the entry is populated, just by the wrong span, and the typed_view! macro (tables.rs:610-630) only debug-asserts size/alignment, both of which a f32 styles span satisfies. Release builds read the wrong table silently. The likelihood argument the finding gives ("the compiler growing into the schema") is actually the wrong citation — upload.ts:5-11 means the compiler emitting the *existing* extras, not new fields — but ROADMAP.md:323 does commit to a "Property sweep: gradients, shadows, transforms, opacity, overflow, space-*, divide-*", which is comfortably 17 more style fields. The fix is one const assert. Severity holds.

<a id="f-protocol-codegen-no-regeneration-gate"></a>

### MEDIUM · Nothing forces regeneration when schema.ts changes: no build step, no hash, no CI

`process` · `protocol-codegen/no-regeneration-gate`

**Where:** `package.json:7`, `package.json:8`, `native-src/dziri-engine/build.rs:4`, `scripts/gen-protocol.ts:8`

**Claim.** `bun run gen:protocol` is a manual, standalone script; no other script depends on it, `build.rs` has no `cargo:rerun-if-changed` on schema.ts, and there is no CI directory. Editing schema.ts and running the app is a silent no-op, which is the exact stale-generated-file failure the generator's own doc comment claims to eliminate.

**Evidence.** package.json: `"gen:protocol": "bun run scripts/gen-protocol.ts"`, `"engine": "cd native-src/dziri-engine && cargo build --release"`, `"dev": "bun run src/compile.ts && bun run src/app.ts"` — `dev` never regenerates, `engine` never regenerates. build.rs (10 lines) only emits Windows link libs. No `.github`. gen-protocol.ts:8 asserts "so nobody edits either output" — but nothing verifies the outputs correspond to the input.

**Impact.** Three distinct silent failures. (1) Edit schema.ts, run `bun run dev`: both generated files are stale but mutually consistent, so every guard passes and the schema change simply has no effect. (2) Run `gen:protocol` but forget `bun run engine`: generated.ts is new, the .dll is old. Caught by the count backstop only if the field count changed. (3) A same-width reorder in case (2) is caught by nothing (see descriptor-check-is-count-only). The design's whole safety argument rests on the generated files being current, and that is currently a habit.

**Recommendation.** Make staleness a build error, two changes. (1) Have the generator embed `export const SCHEMA_DIGEST = "<sha256 of schema.ts>"` in generated.ts and `pub const SCHEMA_DIGEST: &str = "..."` in protocol.rs; add a `bun test` case that hashes `src/protocol/schema.ts` and compares — drift becomes a red test, not wrong pixels. (2) Add to build.rs: `println!("cargo:rerun-if-changed=../../src/protocol/schema.ts")` plus a check that fails with "run bun run gen:protocol" when the digest disagrees. Also make `"dev"`/`"engine"` run `gen:protocol` first — it takes milliseconds.

**Verifier — weakened.** No automatic gate ties the generated files to schema.ts: `dev`/`engine` never regenerate, build.rs has no rerun-if-changed, there is no CI and not even a `test` script. This is a real hole, but the residual risk is narrower than stated — the PROTOCOL_VERSION handshake at host.ts:167-174 catches a stale binary for any table change that was accompanied by the documented version bump, and the pure-staleness case (edit schema.ts, never regenerate) presents as the change having no effect rather than as wrong pixels. Severity medium; CI specifically is roadmap-scheduled (ROADMAP.md:568, 631).

<a id="f-protocol-codegen-enum-addition-policy-unsafe"></a>

### MEDIUM · "Adding an enum value needs no version bump" is unsafe: engine match arms swallow unknowns

`correctness` · `protocol-codegen/enum-addition-policy-unsafe`

**Where:** `src/protocol/schema.ts:206`, `native-src/dziri-engine/src/layout.rs:383`, `native-src/dziri-engine/src/layout.rs:390`, `native-src/dziri-engine/src/layout.rs:396`, `native-src/dziri-engine/src/layout.rs:406`, `native-src/dziri-engine/src/layout.rs:332`

**Claim.** The schema states "adding one does not bump `PROTOCOL_VERSION` — only changing an existing value does", but the engine decodes every u8 enum with a catch-all arm that is load-bearing for `UNSET`. An added value the engine has never heard of is therefore indistinguishable from "the author said nothing", and renders as a default.

**Evidence.** schema.ts:206-208: "Unlike the tables these carry no layout, so adding one does not bump `PROTOCOL_VERSION`". layout.rs:
```rust
s.display = match u8f(f::DISPLAY) { GRID=>Grid, BLOCK=>Block, NONE=>None, _ => Display::Flex };
s.flex_direction = match u8f(f::FLEX_DIRECTION) { COLUMN=>.., ROW_REVERSE=>.., COLUMN_REVERSE=>.., _ => FlexDirection::Row };
s.flex_wrap = match ... { _ => FlexWrap::NoWrap };
s.justify_content = match ... { _ => None };
```
and `align_of` (layout.rs:322-333) with the comment "`UNSET` and anything unrecognised leave Taffy's default" — the two cases are deliberately conflated.

**Impact.** Add `Display.INLINE_FLEX = 4` to schema.ts, regenerate, ship the compiler without rebuilding the engine. PROTOCOL_VERSION is unchanged by policy, the field count is unchanged, the descriptor is unchanged — every guard passes and every `inline-flex` box lays out as `flex`. Same for a new `NodeKind` (paint.rs:213-219 falls through to the plain-text branch), a new `Overflow`, a new `Position`. The break is semantic, invisible, and specifically blessed by the policy comment.

**Recommendation.** Separate "unset" from "unknown". Reserve 255 as the only fall-through and make everything else explicit: `match v { 0..=3 => .., UNSET => None, other => { self.protocol_warning(f::DISPLAY, other); None } }`, surfaced through `dziri_last_error` on first occurrence. Structurally better: have the generator emit `pub const MAX_VALUE: u8` per enum and add an `ENUM_VERSION: u32` to the handshake, bumped automatically from a hash of the ENUMS array — so the policy is enforced by codegen rather than by a comment asking humans to reason about it.

**Verifier — weakened.** The catch-all arms do conflate "unset" with "unknown", and the enum-exemption in the version policy removes the only automatic detector for that class of change. But the consequence is degradation to a documented default (an added Display value lays out as flex), not silent corruption, and it requires a mismatched binary pair or a forgotten arm. Medium, not high.

<a id="f-protocol-codegen-ir-schema-mapping-is-handwritten"></a>

### MEDIUM · IR-to-schema style mapping is a hand-written 46-entry table with an already-stale doc

`architecture` · `protocol-codegen/ir-schema-mapping-is-handwritten`

**Where:** `src/engine/upload.ts:37`, `src/engine/upload.ts:6`, `src/engine/upload.ts:207`, `src/ir.ts:78`, `src/protocol/schema.ts:85`

**Claim.** `NUMBER_FIELDS` in upload.ts is a hand-maintained mapping between two independently hand-maintained lists (`STYLE_FIELDS` in ir.ts, 46 entries; the `styles` table in schema.ts, 48 entries). Nothing verifies it is total, and its surrounding documentation has already drifted from the code it describes — evidence that this list does drift, not that it might.

**Evidence.** upload.ts:37 `const NUMBER_FIELDS: Array<[keyof typeof F.styles, StyleField]> = [ ["bg","bg"], ... ["padTop","padT"], ["marginTop","marT"], ["flexDirection","direction"], ["maxWidth","maxW"], ... ]`. Counted programmatically: STYLE_FIELDS 46, schema styles 48, NUMBER_FIELDS pairs 46, unmapped schema fields `["lineClamp","overflow"]`. Yet upload.ts:6-7 says "`src/ir.ts` has the **25** style fields ... the schema has **48**. The extra 23 are grid, wrap, position, insets, `flex-*`, `lineClamp` and `overflow`" and upload.ts:207 says "including the 23 fields the compiler does not emit". Both numbers are wrong by 21; grid/wrap/position/insets/flex-* are all in STYLE_FIELDS (ir.ts:98-131) and all mapped.

**Impact.** Add a style field to schema.ts and regenerate: both sides get the field, `FIELD_COUNTS` and `elem_sizes` agree, every guard passes — and the column is never written, so the engine reads zero. Zero is a real CSS value; tables.rs:392-396 spells out the consequence ("`width: 0`, not `auto` ... a node silently collapses"). This is a fail-silent hole in the one path the schema-generation design was built to close, and the stale doc shows nobody notices when this list moves.

**Recommendation.** Make the correspondence generated or exhaustive-checked, not written. Cheapest correct fix: put the IR alias in the schema — `{ name: "padTop", type: "f32", ir: "padT" }` — and have gen-protocol.ts emit `export const IR_STYLE_FIELDS: Array<[keyof typeof F.styles, string]>` into generated.ts, with fields lacking an `ir` alias emitted into a separate `UNMAPPED` list so upload.ts must handle them explicitly. Then STYLE_FIELDS in ir.ts derives from the schema (name + ELEM_VIEW) and `Record<StyleField, …>` exhaustiveness makes an unmapped field a TypeScript error rather than a zeroed column.

**Verifier — weakened.** NUMBER_FIELDS is hand-written and unverified, and a newly added schema style field would silently read as zero — that part holds. But the list is currently complete and correct (46 of 46 IR fields mapped, no duplicates), and the only two unmapped schema fields are documented in place at upload.ts:230-232 as deliberate. The drift is in the module's prose (upload.ts:5-7, 203, stale since the IR grew from 25 to 46 fields per ROADMAP.md:679), not in the mapping. Severity medium.

<a id="f-protocol-codegen-u16-style-ceiling-unchecked"></a>

### MEDIUM · nodes.style is u16 and nodes.list i16; the compiler truncates into them unchecked

`correctness` · `protocol-codegen/u16-style-ceiling-unchecked`

**Where:** `src/protocol/schema.ts:66`, `src/protocol/schema.ts:71`, `src/compiler/compile.ts:727`, `src/compiler/compile.ts:900`, `src/compiler/variants.ts:242`

**Claim.** Style ids are written straight into `Uint16Array` with no check that the interned style count fits, so the 65536th style silently aliases style 0. The same applies to `nodes.list` (i16, 32767 arenas). Neither ceiling is asserted at compile time, at emit time, or at upload time.

**Evidence.** compile.ts:727 `style: new Uint16Array(result.nodes.map((n) => n.style))`; compile.ts:900 `style: ${typedArray("Uint16Array", nodeStyle)}`; variants.ts:242-243 `on: new Uint16Array(on), off: new Uint16Array(off)`. Grepping the compiler for `65535|65536|0xffff|32767` finds only colour literals in css.ts. `capacitiesFor` (upload.ts:101-115) passes `styles: Math.max(ui.styles.count, 1)` through with no ceiling either.

**Impact.** The variant compiler compiles the whole document once per toggle combination (`for (let mask = 0; mask < 1 << toggles.length; mask++)`, variants.ts:203) and unions the interned styles, so style count grows roughly multiplicatively in toggles. Eight toggles over a document with a few thousand distinct computed styles crosses 65536. At that point `n.style` wraps modulo 65536 and a node paints and lays out with a completely unrelated style — silent, data-dependent, and appearing only on the largest app anyone builds. Directly against the project's compile-time-first principle: this is a limit the compiler knows and does not check.

**Recommendation.** Derive the ceilings from the schema and assert at emit. Have gen-protocol.ts emit `export const FIELD_MAX = { nodes: { style: 65535, list: 32767, text: 2147483647, ... } }` from `ELEM_SIZE`/signedness, then in `toCompiledUi` and the emit path: `if (result.styles.length > FIELD_MAX.nodes.style) throw new Error(...)`. Widening `nodes.style` to u32 later then raises the check automatically. Cost: one generated table, two throws.

**Verifier — weakened.** The u16 ceiling on nodes.style is genuinely unchecked at compile, emit and upload, and truncation would be silent — but the growth is linear, not multiplicative in toggles. The 2^k loop cited (variants.ts:203) belongs to `analyzeVariants`, a measurement tool whose output is only printed; the production compiler (variant-compile.ts:180-181) does k+1 compiles and interns one slot per (node, role) value-vector, bounding slots at ~4x node count, so >16k nodes are needed to reach 65536. Severity medium; the i16 `nodes.list` ceiling is effectively unreachable.

<a id="f-protocol-codegen-ffi-structs-outside-the-schema"></a>

### MEDIUM · EngineConfig, Capacities, SpanDesc and Event sit outside the schema, mirrored by hand

`soundness` · `protocol-codegen/ffi-structs-outside-the-schema`

**Where:** `src/engine/host.ts:30`, `src/engine/host.ts:179`, `src/engine/host.ts:402`, `native-src/dziri-engine/src/engine.rs:81`, `native-src/dziri-engine/src/tables.rs:65`, `native-src/dziri-engine/src/lib.rs:285`

**Claim.** The schema covers the shared tables but not the structs that cross the FFI boundary. Their layouts are restated in host.ts as literal sizes and typed-array indices, with a comment reasoning about `#[repr(C)]` padding by hand — and `Capacities`/`SpanDesc`/`Event` carry no version or length, so a Rust-side field addition is an out-of-bounds read of a JS ArrayBuffer.

**Evidence.** host.ts:30-34: `const SPAN_SIZE = 24; const CONFIG_SIZE = 64; export const EVENT_SIZE = 56;`. host.ts:179-193 pokes fields by index with a hand-computed offset: `u8v[40] = ...; u8v[41] = ...; /* The title pointer sits at byte 48, not 44: #[repr(C)] aligns it to 8. */ u64v[6] = BigInt(ptr(title)); u32v[14] = title.length;`. host.ts:402-409: `/* Matches Capacities in tables.rs: six u32, no padding. */ const buf = new Uint32Array(6);`. lib.rs:285 dereferences it with no length: `engine.grow(*caps);` — a full 24-byte copy out of a pointer the host sized by hand.

**Impact.** Add a seventh capacity to `Capacities` (plausible: a second arena kind, or a text-scratch capacity) and rebuild the engine only. `*caps` copies 28 bytes from a 24-byte `Uint32Array` — a genuine out-of-bounds read of JS heap, and the seventh capacity is whatever JavaScriptCore had after the buffer. `PROTOCOL_VERSION` cannot catch it: it lives inside `EngineConfig`, not `Capacities`, and the policy comment (schema.ts:326) ties bumps to "the tables above", which `Capacities` is not. `SpanDesc` and `Event` have the same exposure in the other two directions.

**Recommendation.** Put these structs in the schema and generate both sides. gen-protocol.ts already knows `ELEM_SIZE` and `#[repr(C)]` alignment rules; add a `STRUCTS` array (`{ name: "Capacities", fields: [...] }`) and emit the Rust `#[repr(C)]` definitions plus TS `CAPACITIES_SIZE`/`CAPACITIES_OFFSETS` and a writer, so host.ts stops containing `u64v[6]`. Independently and cheaply today: pass a byte length with every struct pointer (`dziri_engine_grow(handle, caps, caps_len)`) and reject `caps_len != size_of::<Capacities>()` with `INVALID_ARGUMENT` — that converts a silent OOB read into a status code.

**Verifier — weakened.** The four boundary structs are indeed mirrored by hand and `Capacities`/`SpanDesc`/`Event` carry no length, so a Rust-side field addition without the matching host edit is an out-of-bounds read. But this is a documented, scheduled deferral (NOTES.md:149-152, "the obvious next candidate for generation if it grows"), the hand-computed offsets are all correct today, and EngineConfig — the one struct where a version could help — does carry and validate protocol_version. Severity medium, not high.

<a id="f-protocol-codegen-two-rebind-sites-one-notifier"></a>

### MEDIUM · Two descriptor-rebind sites, one notifier: tick()'s rebind never reaches the Uploader

`architecture` · `protocol-codegen/two-rebind-sites-one-notifier`

**Where:** `src/engine/host.ts:318`, `src/engine/host.ts:326`, `src/engine/upload.ts:144`, `native-src/dziri-engine/src/tables.rs:701`

**Claim.** `Engine.tick()` re-reads the descriptor and replaces `#tables` whenever the generation moves, but the only consumer that caches views (`Uploader`) refreshes solely inside `ensureCapacity()`. The generation contract is enforced at one of the two places that can break it, and the unenforced one is exactly the growth path the comments describe.

**Evidence.** host.ts:318-327:
```ts
tick(): void {
  check(engine.dziri_engine_tick(this.#handle), "dziri_engine_tick");
  ...
  if (generation[0]! !== this.#generation) this.#bindTables();
}
```
documented as "Re-reads the descriptor when the engine reports a new generation: a list arena regrowing reallocates the tables". upload.ts:144-153 refreshes only when `this.#engine.grow(want)` returns true. tables.rs:701-739 warns "**every pointer from a previous descriptor is dangling**".

**Impact.** Today `Tables::grow` is reachable only from `dziri_engine_grow` (engine.rs:515 is the sole internal caller, invoked from lib.rs:277), so tick's rebind is dead code and nothing breaks. The moment the engine grows during a tick — which host.ts:317 and tables.rs:29-32 both describe as the intended design — `Engine.#tables` is refreshed and `Uploader.#tables` is not, and the very next `uploadStyles()` writes 48 columns into freed Rust arenas. `engine.grow(want)` will then return false (the generation was already consumed), so `ensureCapacity` never notices.

**Recommendation.** Make the generation the trigger rather than the return value of `grow`. Expose `get generation(): bigint` on `Engine` and have `Uploader` compare it at the top of every upload method, re-reading `#tables` and forcing a full re-upload on change — one comparison per frame, correct regardless of which side initiated growth. Alternatively have `Engine` hold a listener list invoked from `#bindTables()`, so every view-holder is notified from the single place that invalidates them.

**Verifier — confirmed.** I tried to find a second notification path and there is none. `Tables::grow` (tables.rs:701-739) has exactly three callers: engine.rs:515 (`Engine::grow`), and two unit tests at tables.rs:850-851; `Engine::grow` in turn has one caller, lib.rs:285 in `dziri_engine_grow`. So growth is host-initiated only and tick's rebind (host.ts:318-327) is currently unreachable — the finding says so itself. Uploader refreshes `#tables` solely inside ensureCapacity, gated on `const grew = this.#engine.grow(want)` (upload.ts:144-153), and `Engine.grow` returns false whenever the generation already matches (host.ts:418) — so the described trap is exact: if tick ever rebinds first, `#generation` has already advanced, the next `grow(want)` returns false, ensureCapacity reports nothing changed, and Uploader keeps writing 48 columns through views into a freed arena. The design does point that way: host.ts:317 and tables.rs:26-32 both describe engine-side growth invalidating every host pointer, and NOTES.md:169-172 has the engine taking over its own frame loop as A0 step 3. Making the generation (not grow's return value) the trigger is the right fix. Latent today, so medium is right.

<a id="f-protocol-codegen-nodeflags-hardcoded-in-generator"></a>

### MEDIUM · NodeFlags is hardcoded in the generator, so schema.ts's copy changes nothing

`cleanliness` · `protocol-codegen/nodeflags-hardcoded-in-generator`

**Where:** `src/protocol/schema.ts:329`, `scripts/gen-protocol.ts:136`, `scripts/gen-protocol.ts:201`, `src/protocol/generated.ts:218`, `native-src/dziri-engine/src/protocol.rs:190`

**Claim.** `schema.ts` exports `NodeFlags` as "shared by both sides", but gen-protocol.ts never imports or reads it — it emits the bit values as literal text into both outputs. There are three hand-written copies of the same two constants, and editing the one in the single source of truth produces no change in either generated file.

**Evidence.** schema.ts:329-333: `/** Node flag bits, shared by both sides. */ export const NodeFlags = { INTERACTIVE: 1 << 0, MEASURABLE: 1 << 1 } as const;`. gen-protocol.ts imports `{ ELEM_SIZE, ELEM_VIEW, ENUMS, PROTOCOL_VERSION, TABLES, type EnumDef, type Table }` — no `NodeFlags`. It then emits literals: gen-protocol.ts:136-139 `pub mod flags { pub const INTERACTIVE: u8 = 1 << 0; pub const MEASURABLE: u8 = 1 << 1; }` and gen-protocol.ts:201-204 `export const NodeFlags = { INTERACTIVE: 1 << 0, MEASURABLE: 1 << 1 } as const;`.

**Impact.** Adding a third flag bit (an editable/focusable/scrollable bit is the obvious next one, and `nodes.flags` is a u8 with six spare bits) means editing schema.ts, seeing the generator report success, and getting neither side updated. The author then hand-edits files that say "Do not edit", or maintains the bit in three places. Small blast radius, but it is a hole in the generator's own guarantee, inside the file whose entire purpose is that guarantee.

**Recommendation.** Import `NodeFlags` in gen-protocol.ts and emit it the way `ENUMS` is emitted: `Object.entries(NodeFlags).map(([k, v]) => \`    pub const ${k}: u8 = ${v};\`)`. Better, fold it into the schema as a `BITFLAGS` array (`{ name: "NodeFlags", field: "nodes.flags", ty: "u8", bits: { INTERACTIVE: 0, MEASURABLE: 1 } }`) so the generator can also assert the bit count fits the field's width — the kind of check the schema is the right place to hold.

**Verifier — confirmed.** Verified all three copies and the missing import. schema.ts:331-334 exports NodeFlags "shared by both sides"; gen-protocol.ts's import list (scripts/gen-protocol.ts:16-24) is exactly `{ ELEM_SIZE, ELEM_VIEW, ENUMS, PROTOCOL_VERSION, TABLES, type EnumDef, type Table }` — no NodeFlags — and it emits literal text in both directions: `pub mod flags { pub const INTERACTIVE: u8 = 1 << 0; pub const MEASURABLE: u8 = 1 << 1; }` (gen-protocol.ts:136-139) and `export const NodeFlags = { INTERACTIVE: 1 << 0, MEASURABLE: 1 << 1 } as const;` (gen-protocol.ts:201-204). Both appear verbatim in the outputs (generated.ts:218-221, protocol.rs:190-193), and the only consumer imports from generated.ts, not the schema (upload.ts:26, 198, 201). So editing schema.ts's NodeFlags is provably a no-op in both outputs while the generator still reports success — a real present-tense hole in the generator's own guarantee, inside the file whose stated purpose is that guarantee. Blast radius is small (two constants, currently identical everywhere) and the finding scopes it that way, so medium/cleanliness is fair. The BITFLAGS suggestion has the extra merit that the generator could then assert the bit count fits `nodes.flags`' u8 width.

<a id="f-protocol-codegen-close-leaves-dangling-views"></a>

### LOW · close() frees the arenas but leaves every typed-array view live over freed memory

`security` · `protocol-codegen/close-leaves-dangling-views`

**Where:** `src/engine/host.ts:498`, `src/engine/host.ts:156`, `src/engine/host.ts:302`, `src/engine/upload.ts:135`

**Claim.** `close()` calls `dziri_engine_destroy` (which drops the three `Arena`s) and then clears `#buffers` — but `#tables` and `#stringBytes` still hold the typed arrays, `get tables()` still returns them, and the `Uploader` holds its own reference. Clearing `#buffers` frees nothing, because `toArrayBuffer` was deliberately called without a finalizer.

**Evidence.** ```ts
close(): void {
  if (!this.#handle) return;
  check(engine.dziri_engine_destroy(this.#handle), "dziri_engine_destroy");
  this.#handle = 0 as Pointer;
  /* Dropped together: every view points into memory the engine just freed. */
  this.#buffers = [];
}
```
The comment is wrong in both halves: the views are not dropped (`#tables` still references them, host.ts:302 still hands them out) and dropping the ArrayBuffer array cannot free anything, since host.ts:210-213 documents that no deallocator is attached. `Uploader` caches `#tables` at construction (upload.ts:135) and is unaffected either way.

**Impact.** Any write through `engine.tables` or a retained `Uploader` after `close()` is a write into freed heap — silent corruption of whatever the allocator hands out next, in-process, with no bounds error. Nothing currently triggers it (src/window-host.ts:219 and src/window-host.ts:290 both close at the end of a path), but `#handle = 0` guards only the FFI calls, so the memory path is unguarded while the call path is guarded — the asymmetry is the bug.

**Recommendation.** Neutralise the views instead of the buffer list. In `close()`, after destroy, retarget every wrapped array to a shared zero-length buffer (`const DEAD = new ArrayBuffer(0)`) by rebuilding `#tables` with `new Ctor(DEAD)` — a stale write becomes a no-op rather than heap corruption. Add `if (!this.#handle) throw new Error("engine is closed")` to the `tables` and `stringBytes` getters, and give `Uploader` a `detach()` the app calls alongside `close()`.

**Verifier — weakened.** close() does leave every typed-array view live over freed Rust memory and the comment at host.ts:502 is wrong on both counts, but there is no reachable trigger (src/window-host.ts:219 exits immediately, src/window-host.ts:290 is the last statement) and no untrusted-input path, so this is a latent robustness defect rather than a security issue. Severity low.

<a id="f-protocol-codegen-soa-argues-the-wrong-thing"></a>

### LOW · SoA is right for patch and diff, wrong for the stated paint reason; 40 lookups per node

`performance` · `protocol-codegen/soa-argues-the-wrong-thing`

**Where:** `native-src/dziri-engine/src/paint.rs:161`, `native-src/dziri-engine/src/layout.rs:374`, `native-src/dziri-engine/src/tables.rs:333`, `native-src/dziri-engine/src/tables.rs:4`

**Claim.** The stated reason for SoA — "a style patch touches one array and paint reads stay monomorphic" — is half right. The patch half is correct and load-bearing. The paint half is not: paint visits style slots in tree order (random), so SoA's sequential-access benefit never materialises, and the per-field access pattern costs three dependent loads plus a slice reconstruction per field per node.

**Evidence.** paint.rs:161-162 builds closures that re-resolve the span on every field read:
```rust
let g = |field: usize| -> f32 { tables.f32s(STYLES, field).get(slot).copied().unwrap_or(0.0) };
```
and `Painter::node` calls them for RADIUS, BG, BORDER_WIDTH, BORDER_COLOR, FONT_SIZE, FG, PAD_LEFT/RIGHT/TOP/BOTTOM plus FONT_WEIGHT — 11 spans per button. layout.rs:374-377 does the same with `u8f/u16f/i16f/f32f` for ~40 fields per node in `style_of`, called for every node from `apply_all_styles`. Each call is `plan_of` → `index[table * MAX_FIELDS + field]` → `plan[i]` → `read_arena` → `from_raw_parts` → bounds-checked `get`.

**Impact.** The cache-line worry is not actually the problem for `styles`: `styles.count` is 48 in app/ui.gen.ts, so all 48 spans total ~6.7 KB and stay L1-resident whatever the layout. The real cost is ~40 × 3 dependent loads plus 40 slice constructions per node per restyle — at 1215 nodes that is ~150k avoidable indirections per full `apply_all_styles`, on any `diff.node_styles`. For the `nodes` table the cache argument does bite (paint touches 6 spans, ~29 KB at 1215 nodes, so 6 lines per node against 1 for AoS) — but there SoA is justified by something the comment does not say: `commit`'s span-wise memcmp plus `classify` (tables.rs:525-562) can only distinguish "structure moved" from "style pointer moved" from "text changed" because each field is its own span. AoS would mark the whole node row dirty and force a Taffy rebuild on a `hidden` toggle.

**Recommendation.** Keep SoA — the diff classification and the zero-FFI patch path both depend on it — but fix the argument and the access pattern. Hoist the spans once per frame into a borrow struct: `struct StyleCols<'a> { f32: [&'a [f32]; N], u8: [&'a [u8]; M], ... }` built from one pass over `plan`, then have `style_of`/`Painter::node` index arrays directly. That removes every `plan_of` from the per-node path for one setup pass, and removes the temptation for the `unwrap_or(0)` fallbacks (layout.rs:374-377), which currently paper over an out-of-range slot as `width: 0`. Also correct tables.rs:4-5 and schema.ts:11-12 to cite the diff rather than monomorphism.

**Verifier — weakened.** The per-field re-resolution is real and hoisting the spans into a per-frame borrow struct would be a genuine improvement, but the "argues the wrong thing" claim misreads "paint reads stay monomorphic" as a cache/sequential-access argument the comment never makes, and the 40-lookups-per-node path is `apply_all_styles`, which resync only runs on fresh/structure/node_styles diffs — a value-only patch takes the narrow apply_style branch (engine.rs:314-330). Unmeasured, off the hot path: low.

<a id="f-protocol-codegen-spare-style-slot-fill-covers-3-of-46"></a>

### LOW · The spare-style-slot unset fill handles 3 of 46 fields, leaving maxWidth: 0 and basis: 0

`correctness` · `protocol-codegen/spare-style-slot-fill-covers-3-of-46`

**Where:** `src/engine/upload.ts:224`, `src/engine/upload.ts:213`, `src/ir.ts:169`, `native-src/dziri-engine/src/tables.rs:392`

**Claim.** `uploadStyles` recognises that a zeroed spare style slot is dangerous and fixes `width`, `height` and `alignSelf` — but `INITIAL_STYLE` names eight more non-zero unset values (`maxW`/`maxH: Infinity`, `basis`, `aspectRatio`, `insetT/R/B/L: NaN`, `justifyItems`/`justifySelf: UNSET`), all of which stay zero in a spare slot.

**Evidence.** ```ts
// Spare slots past the IR's count must not read as `width: 0`.
for (let i = count; i < this.#tables.styles.bg.length; i++) {
  this.#tables.styles.width[i] = NaN;
  this.#tables.styles.height[i] = NaN;
  this.#tables.styles.alignSelf[i] = Align.UNSET;
}
```
against ir.ts:169-221 `INITIAL_STYLE`, which sets `basis: AUTO`, `maxW: Infinity`, `maxH: Infinity`, `aspectRatio: AUTO`, `insetT..insetL: AUTO`, `justifyItems: UNSET`, `justifySelf: UNSET`. A zeroed slot therefore means `max-width: 0`, `flex-basis: 0` (collapses a flex item) and `justify-items: flex-start` — the exact grid collapse the UNSET comment at schema.ts:218-223 exists to prevent.

**Impact.** Unreachable today because `capacitiesFor` returns `styles: Math.max(ui.styles.count, 1)` with no headroom, so there are no spare slots. But `Tables::grow` never shrinks (`styles: self.caps.styles.max(want.styles)`, tables.rs:706), so any later recompile with fewer interned styles — a variant probe, a dev-mode reload, a conditional-class edit — leaves real spare slots, and a stale `nodes.style` pointing at one renders a collapsed, max-width-zero box. The partial fix is more dangerous than none because it reads as handled.

**Recommendation.** Stop hand-listing the exceptions. Route `INITIAL_STYLE` through the same mapping table as the values (see ir-schema-mapping-is-handwritten) and fill spare slots from it: `for (const [schemaField, irField] of NUMBER_FIELDS) for (let i = count; i < cap; i++) dst[schemaField][i] = INITIAL_STYLE[irField]`. That is 46 fields correct by construction in one loop instead of three assignments, and it makes `INITIAL_STYLE` the single answer to "what does an unwritten style mean" on both sides.

**Verifier — confirmed.** Verified precisely. The fill at upload.ts:224-228 sets three columns (width NaN, height NaN, alignSelf UNSET) out of the 46 the same method writes. INITIAL_STYLE (ir.ts:169-221, with AUTO = NaN at ir.ts:65) has non-zero unset values for more fields than the finding even lists: basis AUTO, maxW/maxH Infinity, aspectRatio AUTO, insetT/R/B/L AUTO, justifyItems/justifySelf UNSET, plus direction COLUMN, shrink 1, fontSize 16, fontWeight 400 and fg 0xff000000 — so a zeroed spare slot means max-width 0, flex-basis 0, justify-items flex-start, font-size 0. Reachability is exactly as the finding concedes and I could not find a path to it: capacitiesFor gives `styles: Math.max(ui.styles.count, 1)` with no headroom (upload.ts:108-110), `Tables::grow` only ever takes the max (tables.rs:703-710) so it never shrinks, and app.ts has no watch/recompile path, so today there are no spare style slots at all. That makes it a correctness trap that opens the moment a dev-mode reload or a recompile with fewer interned styles lands, not a present bug — low is the right severity, and the recommendation (fill from INITIAL_STYLE through the same mapping table) is strictly better than three hand-listed exceptions.

---

## FFI boundary soundness & memory safety

*11 findings — 5 medium, 6 low.*

- **medium** · [JS views over engine memory have no lifetime guard; grow() and close() free under them](#f-ffi-soundness-js-views-outlive-rust-memory)
- **medium** · [drain_events and describe build slices from a host capacity that is never bounded above](#f-ffi-soundness-host-lengths-trusted-for-slices)
- **medium** · [SPAN_SIZE / CONFIG_SIZE / EVENT_SIZE are hand-copied and outside the version handshake](#f-ffi-soundness-abi-struct-sizes-not-generated)
- **medium** · [The magic-number handle check dereferences freed memory after destroy](#f-ffi-soundness-magic-check-reads-freed-memory)
- **medium** · [grow() validates no capacity and turns allocation failure into permanent poisoning](#f-ffi-soundness-grow-unvalidated-and-oom-panics)
- **low** · [Tables::grow copies the live string arena into the new staged arena, leaving live zeroed](#f-ffi-soundness-grow-string-arena-asymmetric)
- **low** · [surface_info reports width*4 not Skia's row_bytes, and it and bounds() take no length](#f-ffi-soundness-surface-info-rowbytes-and-arity)
- **low** · [dziri_last_error is the one export with no catch_unwind, and its state is thread-local](#f-ffi-soundness-last-error-unguarded-and-thread-local)
- **low** · [Two independent bump allocators write the same UTF-8 arena with no interlock](#f-ffi-soundness-two-cursors-one-string-arena)
- **low** · [Native addresses round-trip through Number() with no exactness check](#f-ffi-soundness-pointers-through-js-doubles)
- **low** · [Poisoning triggers on the body returning status::PANIC, not on a panic being caught](#f-ffi-soundness-poisoning-keyed-on-return-value)

<a id="f-ffi-soundness-js-views-outlive-rust-memory"></a>

### MEDIUM · JS views over engine memory have no lifetime guard; grow() and close() free under them

`soundness` · `ffi-soundness/js-views-outlive-rust-memory`

**Where:** `src/engine/host.ts:246`, `src/engine/host.ts:498`, `native-src/dziri-engine/src/tables.rs:736`, `src/engine/upload.ts:135`, `src/engine/smoke.test.ts:54`

**Claim.** The magic-number defence covers only the FFI call path; the shared-memory path — which carries essentially every write in the system — has no equivalent, so a stale typed-array view writes into freed heap silently.

**Evidence.** host.ts:246 `const buffer = toArrayBuffer(address as Pointer, 0, elemSize * capacity);` then host.ts:498-504 `close(){ ... engine.dziri_engine_destroy(this.#handle); this.#handle = 0 as Pointer; /* Dropped together: every view points into memory the engine just freed. */ this.#buffers = []; }` — `#buffers = []` drops only *the Engine's* references. `Uploader` holds its own copy (`upload.ts:135 this.#tables = engine.tables;`) and `src/engine/smoke.test.ts:54 const { nodes, styles, variants, layout } = engine.tables;` destructures the views into consts. On the grow path the free happens *inside* the Rust call — `tables.rs:736 *self = grown;` drops the old `Arena`s (tables.rs:136-142 `dealloc`) before `dziri_engine_grow` even returns, so every view the host holds is already dangling by the time host.ts:420 `this.#bindTables()` runs.

**Impact.** `uploader.uploadNodes()` after `engine.close()`, or any holder that did not re-read `engine.tables` after a grow, is a write to freed memory: heap corruption with no status code, no MAGIC mismatch and no diagnostic — the exact failure lib.rs:11-13 says the boundary exists to prevent ("a stale pointer is a magic-number mismatch rather than a segfault, which matters because the host is a scripting language that can easily hold one past `destroy`"). It is latent only because app.ts happens to route every write through `Uploader.ensureCapacity()` and does nothing after `close()`. The generation check is enforced by remembering, not by construction.

**Recommendation.** Retire, do not free. Move superseded `Arena`s into a `Vec<Arena>` graveyard on the `Engine` instead of dropping them in `Tables::grow`, and graveyard (or leak) the arenas in `dziri_engine_destroy` rather than deallocating — an engine is process-lifetime, growth is rare, and the bounded memory cost buys "a stale view writes harmless retired scratch" instead of "a stale view corrupts the heap". Optionally add `dziri_engine_release_generation(n)` so the host can free the graveyard explicitly. On the TS side stop handing out raw views: have `get tables()` return an accessor that captures `#generation` and throws when `#bindTables` has bumped it, and delete `Uploader.#tables` in favour of reading `this.#engine.tables` per use (a field read, not a call). Detaching the old ArrayBuffers with `structuredClone(buf,{transfer:[buf]})` is a cheaper variant that turns stale access into a `TypeError`, if JSC permits transfer of an externally-backed buffer.

**Verifier — weakened.** Stale-view protection on the shared-memory path exists and is structural, not incidental: the generation check lives inside `Engine.tick()`/`Engine.grow()`, which are the only two calls that can invalidate views, and `Uploader` re-reads correctly. The genuine defect is narrower — `Engine.close()` leaves `#tables`/`#stringBytes` pointing at freed arenas instead of clearing them or making the getters throw, so a write after `close()` is a silent write to freed heap.

<a id="f-ffi-soundness-host-lengths-trusted-for-slices"></a>

### MEDIUM · drain_events and describe build slices from a host capacity that is never bounded above

`security` · `ffi-soundness/host-lengths-trusted-for-slices`

**Where:** `native-src/dziri-engine/src/lib.rs:262`, `native-src/dziri-engine/src/lib.rs:209`, `native-src/dziri-engine/src/engine.rs:551`

**Claim.** `drain_events` constructs `&mut [Event]` of exactly the length the host claims, with no validation of any kind, then writes up to that many events — so an over-claimed capacity is a heap overflow write, not a refusal.

**Evidence.** lib.rs:258-265: `if out.is_null() || written.is_null() { return fail(...); } let slice = std::slice::from_raw_parts_mut(out, capacity as usize); *written = engine.drain_events(slice) as u32;` — the only checks are non-null. engine.rs:551 `let n = out.len().min(self.events.len());` then writes `n` events, so with `capacity` larger than the real buffer and more than that many queued events the write runs off the end. `describe` is one step better and still wrong: lib.rs:198 validates `(capacity as usize) < engine.span_count()` (a *lower* bound) then lib.rs:209 `let slice = std::slice::from_raw_parts_mut(out, capacity as usize);` trusts it as an upper bound too — constructing a slice over possibly-invalid memory is UB per `from_raw_parts_mut`'s contract even though only `min(out.len(), plan.len())` is written.

**Impact.** Every other out-pointer path in this file refuses rather than trusting (`read_pixels` lib.rs:397, `take_png` lib.rs:448, `font_family` lib.rs:476 all clamp or fail on length). These two are the exceptions and they are the two that build slices. It is unreachable from today's host.ts only because `EVENT_SIZE`/`SPAN_SIZE` happen to be right — see the sibling finding — and this is the mechanism that turns any drift in those constants into corruption.

**Recommendation.** Never widen a slice to a host-supplied length. In `describe`, build it with the length you will use: `from_raw_parts_mut(out, engine.span_count())` — the capacity check above already proves the buffer is at least that large. In `drain_events`, clamp first: `let n = (capacity as usize).min(engine.pending_events()); let slice = from_raw_parts_mut(out, n);`, and add an absolute ceiling (refuse `capacity > 4096` with `status::CAPACITY`) so a wild value is a status code. Both are one-line changes and both remove the UB even in the correct-host case.

**Verifier — weakened.** Real UB-hardening gap, not a security hole: `capacity` is never attacker-supplied — it is written by host.ts in the same repo and process. Severity is medium (robustness/UB), and note that clamping the slice length does not mitigate the `EVENT_SIZE`-drift scenario the finding uses to justify it; only an exported size handshake does.

<a id="f-ffi-soundness-abi-struct-sizes-not-generated"></a>

### MEDIUM · SPAN_SIZE / CONFIG_SIZE / EVENT_SIZE are hand-copied and outside the version handshake

`soundness` · `ffi-soundness/abi-struct-sizes-not-generated`

**Where:** `src/engine/host.ts:29`, `scripts/gen-protocol.ts:1`, `src/protocol/schema.ts:327`, `native-src/dziri-engine/src/engine.rs:39`, `native-src/dziri-engine/src/tables.rs:48`

**Claim.** The point of `schema.ts` → `gen-protocol.ts` is that no layout is hand-copied, but the three `#[repr(C)]` structs that actually cross the ABI are hand-copied, and `PROTOCOL_VERSION` explicitly excludes them.

**Evidence.** host.ts:29-34: `const SPAN_SIZE = 24; /* Matches SpanDesc in tables.rs */ const CONFIG_SIZE = 64; /* Matches EngineConfig in engine.rs */ export const EVENT_SIZE = 56; /* Matches Event in engine.rs: six 4-byte fields plus 32 inline text bytes */`, plus hand-derived offsets at host.ts:189-193 (`u8v[40]`, `u8v[41]`, `u64v[6]`, `u32v[14]`, with the comment "The title pointer sits at byte 48, not 44"). Grepping `scripts/gen-protocol.ts` finds no `Event`, `SpanDesc`, `EngineConfig` or any struct size — it emits `ELEM_SIZES` for tables only. And schema.ts:325-327 defines the escape hatch away: "Bumped on any change to **the tables above**. `export const PROTOCOL_VERSION = 1;`" — adding a field to `Event` or reordering `EngineConfig` changes neither the tables nor the version.

**Impact.** Add a field to `Event` (a modifier bitmask, a timestamp — both plausible for A3 keyboard work) and: `EVENT_SIZE` stays 56, `drainEvents` allocates `max*56`, passes `max` as capacity, and `drain_events` writes `max*64` bytes into it — the heap overflow from the sibling finding, with a green protocol handshake. Reorder `EngineConfig` and `Engine::new` reads a garbage `windowed` flag and a garbage `title` pointer out of a correctly sized buffer. Both are silent.

**Recommendation.** Two things, both cheap. (1) Export the sizes and check them at `dlopen`: add `dziri_abi_sizes(out: *mut u32)` returning `[size_of::<SpanDesc>(), size_of::<EngineConfig>(), size_of::<Event>(), align_of::<EngineConfig>()]` and assert against the TS constants before the first call — a startup `throw` instead of corruption, ~15 lines. (2) Better, move the three structs into `schema.ts` as first-class records and have `gen-protocol.ts` emit both the Rust `#[repr(C)]` definitions and the TS sizes/offsets, so `EngineConfig`'s 4-byte hole before `title` is computed rather than commented; then fold them into the version rule and fix the schema.ts:325-326 comment to say so.

**Verifier — weakened.** Accurate as a gap, overstated as severity: all three constants and the hand-derived `EngineConfig` offsets in host.ts:189-193 match the Rust `#[repr(C)]` layouts today, so nothing is currently corrupt. This is a latent-on-future-edit hazard (medium) against ROADMAP.md:167-172's own 'generate, do not hand-copy' decision, not a present defect.

<a id="f-ffi-soundness-magic-check-reads-freed-memory"></a>

### MEDIUM · The magic-number handle check dereferences freed memory after destroy

`soundness` · `ffi-soundness/magic-check-reads-freed-memory`

**Where:** `native-src/dziri-engine/src/lib.rs:149`, `native-src/dziri-engine/src/lib.rs:53`, `native-src/dziri-engine/tests/boundary.rs:98`

**Claim.** `destroy` frees the `Handle`, so every later `with()`/`destroy()` reads `magic` out of a deallocated allocation — the advertised safety property depends on reading memory Rust has already returned to the allocator.

**Evidence.** lib.rs:152-155 `(*handle).magic = 0; drop(Box::from_raw(handle));` — the sentinel is written and then freed with it. lib.rs:53-54 then does, on any later call, `let handle = unsafe { &mut *handle }; if handle.magic != MAGIC {` — a read, and in fact a `&mut` construction, over freed memory. boundary.rs:100-105 codifies it as intended: `assert_eq!(unsafe { dziri_engine_destroy(handle) }, status::INVALID_HANDLE); assert_eq!(dziri_engine_tick(handle), status::INVALID_HANDLE);`. The `#[repr(C)] struct Handle { magic: u64, engine: Engine }` part is fine — repr(C) guarantees field order and offset 0 for `magic` even though `Engine`'s layout is unspecified, so the check reads the bytes it means to — but it reads them from a dead allocation.

**Impact.** Textbook use-after-free read: UB, an immediate ASAN/Miri failure, and a fault if the allocator ever returns the page (the `Handle` is large — Skia surface, Taffy tree, several `Vec`s — so a size-class change or a hardened allocator can decommit it). It cannot be made robust by widening the sentinel; the check is unsound at its foundation. And because a test asserts the behaviour, the bug is now load-bearing and will be defended rather than found.

**Recommendation.** Stop handing the host a raw pointer. Keep a process-global handle table — `static ENGINES: Mutex<SlotMap<EngineKey, Box<Engine>>>` (the `slotmap` crate) or a plain `Vec<Option<Box<Engine>>>` plus a per-slot `u32` generation — and hand the host an opaque `u64` of `(index << 32) | generation`. `with()` becomes a bounds check plus a generation compare against memory the engine still owns, so a stale or fabricated handle is a lookup miss with zero dereference and double-destroy is a mismatch by construction. This also supplies the thread-safe handle the render-thread step needs, and it makes the boundary.rs assertions true rather than merely passing.

**Verifier — weakened.** Genuine UB (a UAF read of the sentinel out of the freed `Handle`), but medium rather than high: the `Handle` box is a few hundred bytes of pointers and `Vec` headers, not the large allocation the evidence describes, so the fault-on-decommit scenario is not realistic; lib.rs:32-33 and 49-52 already document the check as a best-effort heuristic; and the handle-table replacement is ROADMAP.md:676's next scheduled step.

<a id="f-ffi-soundness-grow-unvalidated-and-oom-panics"></a>

### MEDIUM · grow() validates no capacity and turns allocation failure into permanent poisoning

`correctness` · `ffi-soundness/grow-unvalidated-and-oom-panics`

**Where:** `native-src/dziri-engine/src/lib.rs:281`, `native-src/dziri-engine/src/tables.rs:113`, `native-src/dziri-engine/src/tables.rs:117`, `native-src/dziri-engine/src/tables.rs:714`

**Claim.** `dziri_engine_grow` accepts any six `u32`s and the allocation path answers an unreasonable request with `assert!`/`expect`, which `with()` converts into a permanently poisoned engine — contradicting the boundary's own rule that failures are status codes.

**Evidence.** lib.rs:281-287 does nothing but a null check: `if caps.is_null() { return fail(...); } engine.grow(*caps); status::OK`. `Tables::grow` calls `Tables::new(caps)` (tables.rs:714), whose arena allocation is `AllocLayout::from_size_align(size, ARENA_ALIGN).expect("arena layout")` (tables.rs:113) and `assert!(!ptr.is_null(), "out of memory allocating {size} bytes")` (tables.rs:117). Span sizing is unbounded: `byte_len` is `elem_size as usize * capacity as usize` (tables.rs:165) accumulated in `plan()`, so `nodes: 4_000_000_000` asks for tens of gigabytes across the node-sized spans, twice (staged and live) — and the *existing* arenas are still alive until tables.rs:736 `*self = grown;`, so peak is old + new.

**Impact.** A capacity request that is merely too large — a runaway list, or a slip in `capacitiesFor` (upload.ts:106 `Math.ceil(ui.nodes.count * NODE_HEADROOM) + 16`) — kills the engine for the rest of the process: `guard` catches the panic, `with()` sets `poisoned = true` (lib.rs:68-70), and every later call including `describe` and `generation` returns `POISONED`. There is no recovery short of `close()` and re-open, and the host cannot tell "you asked for too much" from "the engine has a bug". `grow` is the one entry point where an expected condition (out of memory) sits on the panic path instead of the status path.

**Recommendation.** Validate and return. Give `Capacities` a `fn validate(&self) -> Result<(), String>` with per-field ceilings (nodes/styles/strings ≤ a few million, `string_bytes` ≤ a few hundred MB) and reject with `status::CAPACITY` in `dziri_engine_grow` before touching the allocator. Change `Arena::new` to `try_new(size) -> Result<Self, String>` — `from_size_align(...).map_err(...)?` plus a null check returning `Err` — and thread the `Result` through `Tables::new`/`Tables::grow`/`Engine::grow` so OOM becomes `status::CAPACITY` with a message. While there, drop the 2x peak by growing one arena at a time (allocate new staged, copy, free old, then live) instead of building a whole second `Tables`.

**Verifier — confirmed.** I tried to find a ceiling and there is none. lib.rs:281-287 does only `if caps.is_null()` and then `engine.grow(*caps)`. `Capacities` (tables.rs:65-93) has no `validate`; `Engine::new` (engine.rs:151-158) only applies `.max(1)`; `Tables::grow` (tables.rs:701-714) takes the field-wise max and calls `Tables::new(caps)`, whose allocation path is `AllocLayout::from_size_align(size, ARENA_ALIGN).expect("arena layout")` (tables.rs:113) and `assert!(!ptr.is_null(), "out of memory allocating {size} bytes")` (tables.rs:117). Span sizing is genuinely unbounded (`elem_size as usize * capacity as usize` accumulated in `plan()`, tables.rs:164-167 and 255-285) and the old arenas are still alive until tables.rs:736 `*self = grown`, so peak is old+new as claimed. The poisoning consequence is exactly as described and is the part that makes this more than a crash: `guard` returns `status::PANIC` (error.rs:114), lib.rs:67-70 sets `poisoned = true`, and lib.rs:60-65 then refuses every later call — including `dziri_engine_generation`, which is the one call the host needs to work out whether its views are still valid. So an oversized request is unrecoverable without `close()` and re-open, and the host cannot distinguish 'you asked for too much' from 'the engine has a bug'. `grow` is indeed the one entry point where an expected condition sits on the panic path; `dziri_engine_create` has the same allocation path but there the panic surfaces as a create-time `PANIC` on a handle that never existed, which is benign by comparison. Severity medium is right — reachable only from a runaway `capacitiesFor` (upload.ts:101-115) or a genuinely OOM machine, but silent and terminal when it happens.

<a id="f-ffi-soundness-grow-string-arena-asymmetric"></a>

### LOW · Tables::grow copies the live string arena into the new staged arena, leaving live zeroed

`correctness` · `ffi-soundness/grow-string-arena-asymmetric`

**Where:** `native-src/dziri-engine/src/tables.rs:731`, `native-src/dziri-engine/src/tables.rs:716`

**Claim.** The string-bytes region is the one span `grow` handles by hand, and it is wrong in two directions: host writes staged but not yet committed are discarded, and the new tables' live copy is never populated.

**Evidence.** The span loop skips it — tables.rs:717 `if span.home != Home::Shared || span.table < 0 { continue; }` — because the region has `table == REGION` (-1). The hand-written replacement is tables.rs:731-733: `let string_bytes = self.string_bytes().to_vec(); let n = string_bytes.len().min(grown.staged_string_bytes_mut().len()); grown.staged_string_bytes_mut()[..n].copy_from_slice(&string_bytes[..n]);` — `string_bytes()` reads `self.live` (tables.rs:449-456 `Self::bytes(&self.live, span)`) and the destination is `grown.staged`. Every other span copies staged→staged *and* live→live (tables.rs:723-728), so `grown.live`'s string region stays as `Arena::new` left it: zeroed.

**Impact.** `grow` documents itself as "preserving contents" (tables.rs:701) and does not. Immediately after a grow `tables.string(slot)` reads zeroed live bytes, so every string is NUL padding; and a host that staged new text and *then* discovered it needed to grow has that write replaced by the previous frame's live text. Both are masked purely by ordering luck: `Engine::grow` sets `fresh = true` and `tick()` commits before layout, and src/window-host.ts:181-184 re-uploads everything when `ensureCapacity()` returns true. Nothing enforces either.

**Recommendation.** Make the region a normal span in the copy loop rather than a special case: drop the `span.table < 0` filter and look the region up by `(REGION, REGION_STRING_BYTES)` (or give it a synthetic table index so the existing `index` array covers it), then copy staged→staged and live→live with the same `dst_len` clamp as everything else. Add the regression the suite is one line from: extend `growth_preserves_contents_and_bumps_the_generation` (tables.rs:843) to stage a string, commit, grow, and assert `tables.string(0)` *before* any further commit.

**Verifier — weakened.** Real contract violation of tables.rs:701, but no reachable defect and low severity. The zeroed `grown.live` string region is repaired by the `commit` at engine.rs:270 before the first live read at engine.rs:274 — a structural property of `tick`, not luck. The only latent bug is that staged is refilled from `live`, so an uncommitted staged string write is discarded across a grow.

<a id="f-ffi-soundness-surface-info-rowbytes-and-arity"></a>

### LOW · surface_info reports width*4 not Skia's row_bytes, and it and bounds() take no length

`correctness` · `ffi-soundness/surface-info-rowbytes-and-arity`

**Where:** `native-src/dziri-engine/src/lib.rs:366`, `native-src/dziri-engine/src/lib.rs:374`, `native-src/dziri-engine/src/engine.rs:255`, `src/engine/host.ts:439`

**Claim.** The host sizes its pixel buffer from a stride the engine computes rather than the one Skia actually used, and neither `surface_info` nor `bounds` accepts a length, so their out-pointer arity is enforced by doc comment only.

**Evidence.** lib.rs:371-376: `let (width, height) = engine.size(); *out = width; *out.add(1) = height; *out.add(2) = width * 4; *out.add(3) = engine.frame_count() as u32;` — four `u32` writes, no `len` parameter, stride *derived*. The real stride comes from the pixmap: engine.rs:255-259 `let pixmap = self.surface.peek_pixels()?; let row_bytes = pixmap.row_bytes();`. host.ts:439-447 then does `const [, height, rowBytes] = this.surfaceInfo(); const out = new Uint8Array(height * rowBytes);` while `read_pixels` copies `pixels.len()` = `height * real_row_bytes` after `if (len as usize) < pixels.len()` (lib.rs:397). `dziri_engine_bounds` has the same shape: lib.rs:352 `copy_nonoverlapping(rect.as_ptr(), out, 4)` with the count only in the doc comment (lib.rs:339 "`out` must be writable for four `f32`"). Every other copy-out — `describe`, `read_pixels`, `take_png`, `font_family`, `last_error` — takes a length.

**Impact.** Whenever Skia pads a raster row (`minRowBytes` is width*4 for N32 today, but that is an implementation choice and changes for non-N32 or aligned surfaces), `readPixels()` allocates too little and the call fails with `CAPACITY` — a screenshot path that breaks on a width the tests never used, with an error blaming the host. The missing length is the other half: the two functions with no arity in their signature are the two that cannot be bounds-checked, which is exactly the pattern that becomes an overflow when a caller or a future field count is wrong. (`width * 4` can also wrap in release, though surface allocation fails first at those sizes.)

**Recommendation.** Report the truth and pass the length: add `Engine::row_bytes(&mut self) -> usize` returning `self.surface.peek_pixels().map(|p| p.row_bytes())` and have `surface_info` write that instead of `width * 4`; change both signatures to `surface_info(handle, out: *mut u32, len: u32)` and `bounds(handle, node: u32, out: *mut f32, len: u32)` with a `len < 4` → `status::CAPACITY` check, matching the rest of the file. Every host.ts call site already knows its buffer length, so the TS change is passing `out.length`.

**Verifier — weakened.** No current defect. `width * 4` equals Skia's `row_bytes` for the `raster_n32_premul` surface this engine always creates, and boundary.rs:196-200 pins that equality; a divergent stride would produce a `CAPACITY` refusal (lib.rs:397), not corruption. The missing `len` parameters are a signature-consistency nit with no reachable overflow — both call sites pass exactly four elements. Worth doing as hardening; low severity.

<a id="f-ffi-soundness-last-error-unguarded-and-thread-local"></a>

### LOW · dziri_last_error is the one export with no catch_unwind, and its state is thread-local

`soundness` · `ffi-soundness/last-error-unguarded-and-thread-local`

**Where:** `native-src/dziri-engine/src/lib.rs:90`, `native-src/dziri-engine/src/lib.rs:4`, `native-src/dziri-engine/src/error.rs:88`, `native-src/dziri-engine/src/error.rs:25`

**Claim.** lib.rs opens by asserting every `extern "C"` function cannot unwind; `dziri_last_error` is not wrapped in `guard`, and it is the function the host calls on every failure path.

**Evidence.** lib.rs:4-8: "every one of those functions has the same three properties: 1. **It cannot unwind.** [`error::guard`] catches panics…". But lib.rs:90-93 is `pub unsafe extern "C" fn dziri_last_error(buf: *mut u8, len: u32) -> u32 { error::read_last_error(buf, len) }` — no `guard`. `read_last_error` does `LAST_ERROR.with(|slot| { let text = slot.borrow(); ... })` (error.rs:89-97); `thread_local!`'s `with` panics with `AccessError` when the slot is being destroyed, and `RefCell::borrow` panics on a conflicting borrow. `error::install_hook()` is also called outside the guard (lib.rs:104, before the `guard(||…)` on line 106). Separately both slots are thread-local (error.rs:25-32) while `guard` and the hook assume the panicking thread and the calling thread are the same.

**Impact.** A panic escaping `dziri_last_error` unwinds straight into Bun's C++ frame and aborts the process with no diagnostic — the outcome error.rs:1-7 exists to prevent, on the one path that runs when something has already gone wrong (host.ts:112-119 `lastError()` is called from `check()` on every non-OK status). The thread-locality is a second, scheduled failure: once the engine owns its frame loop (engine.rs:11-17), a panic on the render thread records into that thread's `LAST_PANIC`/`LAST_ERROR` and `dziri_last_error` from Bun's thread returns an empty string — blank exactly when the poisoned-engine message matters. Nothing stops Bun calling these symbols from a Worker today either, and `Engine` is neither `Send` nor `Sync`.

**Recommendation.** Wrap `dziri_last_error` in a `guard` variant that yields 0 on panic (it returns `u32`, not a status), and move `install_hook()` inside `dziri_engine_create`'s `guard`. Then make the error slots process-global rather than thread-local — `static LAST_ERROR: Mutex<String>` and `static LAST_PANIC: Mutex<Option<String>>` — so a panic anywhere in the library is readable from anywhere; record the thread name into the message if per-thread detail is wanted. Cheap, and it removes an assumption the roadmap is about to break.

**Verifier — weakened.** The unguarded export is real but has no reachable panic: `read_last_error` contains no panicking operation given a live thread and no re-entrant borrow, and `install_hook` cannot panic outside a nested panic. The thread-local error slots are documented behaviour (lib.rs:85, error.rs:26-28), and the render-thread case that breaks them is the roadmap step ROADMAP.md:673-676 explicitly defers. Low severity, worth the 3-line guard for invariant hygiene.

<a id="f-ffi-soundness-two-cursors-one-string-arena"></a>

### LOW · Two independent bump allocators write the same UTF-8 arena with no interlock

`architecture` · `ffi-soundness/two-cursors-one-string-arena`

**Where:** `src/engine/host.ts:521`, `src/engine/upload.ts:130`, `src/engine/upload.ts:291`

**Claim.** `host.ts` exports a free function that bump-allocates into the string arena with a caller-managed cursor while `Uploader` bump-allocates into the same arena with a private cursor; using both on one engine silently overwrites strings.

**Evidence.** host.ts:521-540 `export function writeString(target: Engine, slot: number, text: string, cursor: number): number { ... arena.set(bytes, cursor); target.tables.strings.offset[slot] = cursor; ... return cursor + bytes.length; }` versus upload.ts:130 `/** Bump allocator into the UTF-8 arena. */ #cursor = 0;` and upload.ts:289-294 `arena.set(bytes, this.#cursor); slots.offset[i] = this.#cursor; ... this.#cursor += bytes.length;`. Neither knows about the other; engine-smoke.ts uses the former, app.ts the latter. `Uploader.#repack()` resets `#cursor = 0` (upload.ts:310) and rewrites from the start, stomping anything `writeString` placed there.

**Impact.** Not memory-unsafe — JS typed-array writes are bounds-checked — but a silent wrong-text bug waiting for the first caller who mixes the imperative helper with the uploader (an editable field written directly plus a bound string re-uploaded). The arena has one owner conceptually and two in code.

**Recommendation.** Move the cursor into the `Engine`, or into a small `StringArena` the `Engine` owns, as the single allocator; expose `engine.strings.write(slot, text)` and `engine.strings.repack(all)` and reimplement both `writeString` and `Uploader.uploadStrings`/`#repack` on top of it. Then delete the `cursor` parameter from the public helper so the two-allocator shape becomes unexpressible.

**Verifier — confirmed.** Both allocators exist over the same bytes and nothing reconciles them. host.ts:522-540 `writeString` takes a caller-managed `cursor`, writes into `target.stringBytes` and sets `strings.offset/length`; upload.ts:129-130 declares a private `#cursor = 0`, upload.ts:285-295 appends at it into `this.#engine.stringBytes`, and upload.ts:305-311 `#repack()` resets it to 0 and rewrites from the start. `Engine.stringBytes` (host.ts:307-309) is the single `REGION_STRING_BYTES` span for both — tables.rs:458-466 confirms there is exactly one, in `staged`. So a caller mixing the two (imperative field write plus a bound string re-upload) gets silent wrong text, and `#repack` will stomp anything `writeString` placed. Only the caller split keeps them apart: src/engine/smoke.test.ts:96 uses `writeString`, app.ts uses `Uploader`, and nothing uses both. The severity call is right for the reason given — JS typed-array writes are bounds-checked, so the failure mode is wrong text, not memory corruption — and the fix (one owner, drop the `cursor` parameter so the two-allocator shape is unexpressible) is sound.

<a id="f-ffi-soundness-pointers-through-js-doubles"></a>

### LOW · Native addresses round-trip through Number() with no exactness check

`soundness` · `ffi-soundness/pointers-through-js-doubles`

**Where:** `src/engine/host.ts:201`, `src/engine/host.ts:242`

**Claim.** Handle and span addresses are converted from `u64` to a JS double with no assertion, so the protocol quietly assumes every address fits in 53 bits.

**Evidence.** host.ts:201 `const handle = Number(out[0]!) as Pointer;` and host.ts:242 `const address = Number(view.getBigUint64(at + 8, true));`, then host.ts:246 `toArrayBuffer(address as Pointer, 0, ...)`.

**Impact.** True today — user-space addresses are ≤ 2^47 on Windows, Linux and macOS — but a silently rounded address is a typed-array view over the wrong memory, which is the class of bug that cannot be diagnosed from JS at all. The assumption is undocumented and unasserted, and that part is free to fix.

**Recommendation.** Add one guard where the conversion happens — `function addr(v: bigint): Pointer { if (v > 0x1fffffffffffffn) throw new Error(`address ${v.toString(16)} exceeds MAX_SAFE_INTEGER`); return Number(v) as Pointer; }` — and route both call sites through it. Document the 53-bit assumption next to `SPAN_SIZE`, where the other ABI assumptions already live.

**Verifier — confirmed.** Verified verbatim: host.ts:201 `const handle = Number(out[0]!) as Pointer;`, host.ts:242 `const address = Number(view.getBigUint64(at + 8, true));`, feeding host.ts:246 `toArrayBuffer(address as Pointer, 0, elemSize * capacity)`. No exactness check exists anywhere in the file, and there is no comment recording the 53-bit assumption next to the other ABI notes at host.ts:29-34. The severity is right and the finding is honest that it is not exploitable today. One refinement worth carrying: the assumption is imposed by `bun:ffi` itself, whose `Pointer` type is a `number`, so the codebase cannot avoid the narrowing — only detect it. That makes the recommendation exactly right in scope (a guard that throws with a diagnostic, since the alternative is a typed array silently over the wrong memory) and also means the guard matters far more at host.ts:242, which becomes a view, than at host.ts:201, which is only handed straight back to `bun:ffi` as an opaque argument.

<a id="f-ffi-soundness-poisoning-keyed-on-return-value"></a>

### LOW · Poisoning triggers on the body returning status::PANIC, not on a panic being caught

`cleanliness` · `ffi-soundness/poisoning-keyed-on-return-value`

**Where:** `native-src/dziri-engine/src/lib.rs:67`, `native-src/dziri-engine/src/error.rs:104`

**Claim.** `with()` cannot distinguish "guard caught an unwind" from "the body returned -1", so the poisoning invariant rests on no call site ever using `status::PANIC` as an ordinary failure code.

**Evidence.** lib.rs:67-71 `let code = guard(|| body(&mut handle.engine)); if code == status::PANIC { handle.engine.poisoned = true; } code` — the only signal is the integer. `guard` (error.rs:104-117) already knows which branch it took and throws the distinction away by returning `i32` for both.

**Impact.** Harmless today (nothing calls `fail(status::PANIC, …)`), but the first one added for any reason permanently poisons the engine, and the reverse — a `guard` variant that maps some panics to a different code — silently stops poisoning. The property the whole `AssertUnwindSafe` argument depends on (error.rs:11-14) is enforced by a coincidence of numbering.

**Recommendation.** Change `guard` to return `Result<i32, i32>`, or a two-variant `enum Outcome { Returned(i32), Panicked(i32) }`, and have `with()` match on it: `Outcome::Panicked(code) => { handle.engine.poisoned = true; code }`. Five lines, and the invariant becomes structural.

**Verifier — confirmed.** Exactly as described and I found no other signal. lib.rs:67-71 is `let code = guard(|| body(&mut handle.engine)); if code == status::PANIC { handle.engine.poisoned = true; } code` — the integer is the only evidence. `guard` (error.rs:104-117) matches on `catch_unwind`'s `Ok`/`Err` and collapses both arms to `i32`, discarding the distinction it already has. I grepped the whole crate for `status::PANIC`: the only producer is error.rs:114 and the only consumers are lib.rs:68 and boundary.rs:78, so nothing calls `fail(status::PANIC, …)` today and the invariant currently holds — by numbering coincidence, as claimed. The failure modes named are both real: a first ordinary `fail(status::PANIC, …)` would permanently poison a healthy engine (lib.rs:60-65 then refuses every call including `dziri_engine_generation`), and a `guard` variant mapping some panics to another code would silently stop poisoning, which is the property error.rs:9-14's `AssertUnwindSafe` argument rests on. The `Outcome`/`Result` fix is five lines and makes it structural. Low severity is correct — no present misbehaviour.

---

## Compiler: CSS cascade, parsing, variants

*12 findings — 4 high, 7 medium, 1 low.*

- **high** · [Shorthands apply at their FIRST cascade position, losing to an earlier longhand](#f-compiler-css-cascade-shorthand-insertion-order)
- **high** · [INITIAL_STYLE.align = FLEX_START; CSS initial `normal` behaves as stretch](#f-compiler-css-align-items-initial-wrong)
- **high** · [Toggle-introduced state styles are emitted but the node is never made interactive](#f-compiler-css-materialized-state-not-interactive)
- **high** · [The selector token regex silently turns attribute selectors into a bogus type selector](#f-compiler-css-selector-token-scanner-silently-corrupts)
- **medium** · [Style ids emitted as Uint16Array with no bound check; >65535 slots silently wraps](#f-compiler-css-u16-style-id-unchecked)
- **medium** · [hover/active/focus is a fixed 3-column enum baked into the wire protocol and Rust](#f-compiler-css-fixed-three-state-roles)
- **medium** · [parseCss cannot nest blocks: a @media body vanishes and the next rule fails to parse](#f-compiler-css-at-rule-block-nesting)
- **medium** · [border and flex shorthands compute wrong values, not merely approximate ones](#f-compiler-css-shorthand-expansion-vs-spec)
- **medium** · [Invalid lengths become NaN and invalid colours become transparent or black](#f-compiler-css-invalid-values-silently-numeric)
- **medium** · [HTML tag scanner is not quote-aware: '>' in an attribute value truncates the tag](#f-compiler-css-html-attr-value-gt)
- **medium** · [Matching is O(nodes x rules x depth) with 7 full rule scans per element](#f-compiler-css-cascade-complexity-cliff)
- **low** · [Unknown-property warnings use console.warn, bypassing CompileResult.warnings](#f-compiler-css-warn-and-ignore-bypasses-warning-channel)

<a id="f-compiler-css-cascade-shorthand-insertion-order"></a>

### HIGH · Shorthands apply at their FIRST cascade position, losing to an earlier longhand

`correctness` · `compiler-css/cascade-shorthand-insertion-order`

**Where:** `src/compiler/compile.ts:108-113`, `src/compiler/compile.ts:373-377`, `src/compiler/compile.ts:159-168`

**Claim.** `collectDecls` builds the winning declarations with `winning.set(prop, value)` in ascending cascade order, but `Map.set` on an existing key updates the value and keeps the key's original insertion position; `applyDecls` then expands in Map iteration order, so a shorthand declared by a low-cascade rule is expanded at that low position even when a higher-cascade rule redeclared it.

**Evidence.** compile.ts:109-112 `const winning = new Map<string, string>(); for (const c of candidates) { for (const [prop, value] of c.decls) winning.set(prop, value); }`, then applyDecls iterates `for (const [prop, value] of decls)`. Confirmed by running the compiler: CSS `.card{padding:14px} .card{padding-left:4px} .x .card{padding:2px}` on `<body class="x"><div class="card">` yields `padT=2 padL=4`; a browser gives padL=2. The same defect breaks inline-style precedence, because `withInline` (compile.ts:375) also `.set()`s into the already-ordered map: `.card{padding:14px} .card{padding-left:4px}` with `style="padding: 0"` yields `padT=0 padL=4`; a browser gives padL=0.

**Impact.** Any stylesheet interleaving a shorthand and one of its longhands across three cascade levels silently computes the wrong box. That is the shape of app.css today: `.card { padding: 14px }` … `.app.compact .card { padding: 8px }` — add any `padding-left` or `border-color` longhand between them and the compact variant silently keeps the old edge. It also means `style="..."` does not actually beat the cascade, contradicting the doc comments at compile.ts:365-372 and html.ts:43-52 that say it does; inline precedence is the one cascade rule authors rely on absolutely.

**Recommendation.** Stop using a Map for ordering. Collect `[prop, value]` pairs into an array in cascade order, then dedupe keeping each property's last occurrence *and* last position: `for (const [p,v] of pairs) { winning.delete(p); winning.set(p,v); }` is a one-line fix. Apply the same delete-then-set in `withInline`. Add a regression test with three interleaved levels.

**Verifier — confirmed.** Tried to break it and could not. compile.ts:109-112 is exactly as quoted (`const winning = new Map<string,string>(); for (const c of candidates) { for (const [prop,value] of c.decls) winning.set(prop,value); }`) and applyDecls (compile.ts:162) iterates `for (const [prop,value] of decls)`, so expansion order == first-insertion order, not cascade order. Both reproductions replicate exactly. Ran `.card{padding:14px} .card{padding-left:4px} .x .card{padding:2px}` on `<body class="x"><div class="card">`: got `padT=2 padL=4` (browser gives padL=2). Ran the inline case `.card{padding:14px} .card{padding-left:4px}` with `style="padding: 0"`: got `padT=0 padL=4` (browser gives padL=0), because withInline (compile.ts:375) `.set()`s `padding` back into position 0. That directly contradicts the doc comments at compile.ts:365-372 and html.ts:43-52. I also checked the recommended fix against four interleaving orders (higher-spec shorthand vs lower-spec longhand and the reverse, plus same-rule duplicates which parseDeclarations already collapses): delete-then-set reproduces per-longhand cascade semantics in every case, so the recommendation is sound. Two-level stylesheets are safe (the shorthand's first insertion is already after the longhand's), so it needs three cascade levels or inline — which is what the finding says. app.css today is not affected: its only shorthand/longhand interleaving (`.card{border:1px solid} … body.light .card{border-color}`, `.stat` / `.stat.wide` / `body.light .stat.wide`) all have the longhand first appearing at a later position than the shorthand, so order is accidentally correct. That lowers today's blast radius but not the severity — the inline-precedence half is wrong on a two-level sheet and inline precedence is the one rule authors rely on absolutely.

<a id="f-compiler-css-align-items-initial-wrong"></a>

### HIGH · INITIAL_STYLE.align = FLEX_START; CSS initial `normal` behaves as stretch

`correctness` · `compiler-css/align-items-initial-wrong`

**Where:** `src/ir.ts:191`, `src/ir.ts:188-192`, `native-src/dziri-engine/src/layout.rs:409`, `windows/main/index.css:14`

**Claim.** `align: Align.START` is emitted for every node that does not declare `align-items`, and layout.rs converts FLEX_START into `Some(AlignItems::FlexStart)`, forcing start alignment and overriding Taffy's stretch default. CSS's initial value is `normal`, which behaves as `stretch` in flex containers — and block children fill their parent's inline size — so every undeclared container cross-shrink-wraps its children where a browser stretches them.

**Evidence.** ir.ts:191 `align: Align.START,` sits immediately below the comment at ir.ts:189-192 arguing the opposite principle for its neighbours: 'Unset rather than START: these are per-item overrides, and defaulting them to `flex-start` would silently override the parent's `align-items`.' `alignSelf`, `justifyItems`, `justifySelf` all correctly use `UNSET`; `align` does not. layout.rs:409 `s.align_items = align_of(u8f(f::ALIGN_ITEMS));` with layout.rs:328 mapping `align::FLEX_START => Some(AlignItems::FlexStart)`, while layout.rs:329 documents that `UNSET` leaves Taffy's default. `justify` (START) is correct, since `justify-content: normal` does behave as flex-start; `align` is the one that is wrong.

**Impact.** The workaround is all over the sample: app.css writes `align-items: stretch` on `body` (with a 4-line comment explaining that without it 'the whole page shrink-wraps to its content'), `.app`, `.panels`, `.card`, `.stats`, and `.list` — six declarations that exist only to undo a wrong default. Since Tailwind's utility surface is the declared target and Tailwind emits no `items-*` unless asked, every shadcn card, panel and stack authored against this compiler shrink-wraps where the browser stretches.

**Recommendation.** Change ir.ts:191 to `align: UNSET`, which layout.rs already handles as 'leave Taffy's default' (= stretch), then delete the six workaround declarations from app.css and confirm the render is unchanged. Related one-line trap for the same pass: `walk(rootEl, [])` at compile.ts:592 gives the synthetic `#root` an empty ancestor path and `matches` returns false for an empty path (compile.ts:60), so a JSX document whose default export is not literally `<body>` gets a root node no rule can ever style — same shrink-wrap symptom, no diagnostic.

**Verifier — confirmed.** Confirmed, with one citation nit. Substance: INITIAL_STYLE.align is `Align.START` and Align.START resolves to 0 via SchemaAlign.FLEX_START (ir.ts:44-45); layout.rs:409 `s.align_items = align_of(u8f(f::ALIGN_ITEMS))` and layout.rs:328 `align::FLEX_START => Some(AlignItems::FlexStart)` do force flex-start, while layout.rs:329-333 documents that UNSET/unrecognised leaves Taffy's default. I ran the compiler on `<body><div class="a"><div class="b">x</div></div></body>` with an empty rule: every one of the four nodes gets `align=0`, and `alignSelf/justifyItems/justifySelf` are all 255 (UNSET). CSS's initial `align-items: normal` behaves as `stretch` in flex, and the project's own block emulation (display FLEX + direction COLUMN, ir.ts:183-186) makes stretch the value that reproduces block behaviour, so 0 is the wrong default. `justify: START` really is correct by contrast, since `justify-content: normal` does behave as flex-start. The workaround count is exact: `grep -c 'align-items: stretch' app/app.css` = 6, at lines 14, 19, 56, 65, 80, 260, and the four-line comment at windows/main/index.css:10-13 says out loud that without it 'the whole page shrink-wraps to its content'.

Citation nit: `align: Align.START,` is at ir.ts:189, not 191; the comment the finding says it 'sits immediately below' is at ir.ts:190-191 and is actually *below* align, attached to alignSelf. The rhetorical framing is off by two lines; the argument is unaffected.

Secondary claim also confirmed: compile.ts:589-592 passes `[]` as the path when `rootEl.tag === '#root'`, and matches() returns false for an empty path (compile.ts:60 `if (ci < 0 || pi < 0) return false;`), so a synthetic root is unstylable and keeps align=0; the warning at compile.ts:594-598 only fires when there is more than one top-level element. windows/main/index.tsx:30 exports `<body>` so this does not bite today.

<a id="f-compiler-css-materialized-state-not-interactive"></a>

### HIGH · Toggle-introduced state styles are emitted but the node is never made interactive

`correctness` · `compiler-css/materialized-state-not-interactive`

**Where:** `src/compiler/compile.ts:783-800`, `src/compiler/compile.ts:697-703`, `src/compiler/variants.ts:318-326`, `native-src/dziri-engine/src/paint.rs:272`

**Claim.** On the variants path `emit` builds the state table from `hasState(variants, i)` but builds `interactive` from the baseline `nodes` array, so a node whose hover/active/focus slot exists only because a toggle introduces it gets a state row and no INTERACTIVE flag — and `hit_test` gates on that flag, so the node can never become hovered.

**Evidence.** compile.ts:785 `node: nodes.map((_, i) => i).filter((i) => hasState(variants, i))` versus compile.ts:800 `const interactive = buildInteractive(nodes, result.handlers, result.lists);`, where buildInteractive tests `n.hover >= 0 || n.active >= 0 || n.focus >= 0` on the baseline BuiltNode (compile.ts:700). paint.rs:272 `if flags.get(node)... & protocol::flags::INTERACTIVE != 0 { hit = node as i32; }`. Reproduced: with `.panel { background:#111 } body.light .panel:hover { background:#eee }` and `classWhen: { light: sig }` on body, the emitted module contains `states.node = [1]`, `states.hover = [2]`, and `interactive = new Int32Array([])`. variants.ts:320-326 predicted exactly this — 'Their interactivity can no longer be inferred from `hover >= 0`' — and the production path infers it that way.

**Impact.** Any `body.light .x:hover` or `body.dark .x:focus` compiles cleanly, emits a correct style slot, and does nothing at run time. Theming via a conditional class is the flagship dynamic-styling feature and `dark:hover:` is standard Tailwind, so this will be hit as soon as the sample stylesheet grows one such rule. The failure is invisible: no warning, correct-looking IR, wrong behaviour.

**Recommendation.** Make `buildInteractive` take the variant pointers when present: `const stateful = variants ? hasState(variants, i) : (n.hover >= 0 || n.active >= 0 || n.focus >= 0)`, threading `variants` through from `emit`. Then assert that `states.node` is a subset of `interactive` — that invariant is cheap to check and is the real bug detector here.

**Verifier — confirmed.** Reproduced end to end. compile.ts:785 builds `states.node` from `hasState(variants, i)` while compile.ts:800 builds `interactive` from `buildInteractive(nodes, ...)`, whose only state test is compile.ts:700 `const stateful = n.hover >= 0 || n.active >= 0 || n.focus >= 0` on the *baseline* BuiltNode. I built the exact case — a `body` with `classWhen: { light: sig }` over `div.panel`, css `.panel { background:#111 } body.light .panel:hover { background:#eee }` — ran compileTree + findToggles + compileVariants + emit, and the emitted module contains `states = { count: 1, node: new Int32Array([1]), hover: new Int32Array([2]), ... }` next to `export const interactive = new Int32Array([])`. So the style slot exists and the node is not interactive.

The runtime consequence is real and I traced it: upload.ts:198 `if (findRow(interactive, i) >= 0) flags |= NodeFlags.INTERACTIVE`, hit_test only assigns `hit = node` behind `flags & INTERACTIVE` (paint.rs, the FLAGS check inside the traversal), and engine.rs:416-417 / :461 set `state.hovered = hit`. With flag 0 the node is never the hit, never hovered, and style_for's early return at paint.rs:75 fires. variants.ts:318-326 predicted exactly this ('Their interactivity can no longer be inferred from `hover >= 0`') and analyzePatches even counts it as `materializedStates`; the production path in compile.ts ignores that and infers it the wrong way. No warning, correct-looking IR, dead behaviour. The suggested invariant (states.node subset of interactive) is the right detector.

<a id="f-compiler-css-selector-token-scanner-silently-corrupts"></a>

### HIGH · The selector token regex silently turns attribute selectors into a bogus type selector

`correctness` · `compiler-css/selector-token-scanner-silently-corrupts`

**Where:** `src/compiler/css.ts:119-146`, `src/compiler/css.ts:120`, `src/compiler/css.ts:142-145`

**Claim.** `parseSelector` scans each compound with `part.match(/[#.:]?[A-Za-z0-9_-]+/g)` and never checks that the tokens account for the whole string, so unrecognised syntax is silently discarded and its identifier fragments are absorbed as type selectors — the last one winning, because `compound.tag = token` overwrites.

**Evidence.** css.ts:120 `const tokens = part.match(/[#.:]?[A-Za-z0-9_-]+/g);` and css.ts:143-144 `compound.tag = token.toLowerCase(); spec[2]++;`. Measured: `parseSelector('input[type="text"]')` returns `{compounds:[{tag:"text",id:null,classes:[]}],pseudo:"none",specificity:[0,0,3]}` with no error; `a[href]` becomes `{tag:"href"}` spec [0,0,2]; `div[data-state=open]` becomes `{tag:"open"}` spec [0,0,3]. A compound with two type tokens also silently overwrites rather than erroring. By contrast `*`, `:not(.x)` and `>` all throw loudly, so the strictness is inconsistent.

**Impact.** A stylesheet using attribute selectors produces rules that match nothing, contribute inflated specificity to nothing, and emit no diagnostic — the author sees an unstyled component and no clue why. ROADMAP.md:314 puts attribute selectors and `data-[state=open]:` on the critical path for shadcn ('Invisible today'), and this is worse than invisible: it is silently wrong. It also means the parser cannot be extended without first fixing the scanner, and `Compound` (`{tag,id,classes}`, css.ts:30) plus `Element` (html.ts:10-56, which discards every attribute except id/class/onclick/style — `parseAttributes`' result is thrown away at html.ts:187-198) both need an attribute bag, on both front-ends.

**Recommendation.** Immediately: verify total coverage with `if (tokens.join("") !== part) throw new CssError(...)`, and reject a second type token in one compound. Then move the selector side to `css-tree` (build-time-only dependency, already contemplated at css.ts:1-8): it gives a real compound AST with attribute matchers and correct specificity accounting, which is prerequisite work for A1 anyway. Keep the hand-written value expander — that part carries the project's opinions and is worth owning.

**Verifier — confirmed.** Measured, and worse than the write-up in one respect. css.ts:120 is `const tokens = part.match(/[#.:]?[A-Za-z0-9_-]+/g);` with no coverage check, and css.ts:143-144 is `compound.tag = token.toLowerCase(); spec[2]++;` — an assignment, not an accumulate. Running parseSelector: `input[type="text"]` -> `{compounds:[{tag:"text",id:null,classes:[]}],pseudo:"none",specificity:[0,0,3]}`; `a[href]` -> `{tag:"href"}` spec [0,0,2]; `div[data-state=open]` -> `{tag:"open"}` spec [0,0,3]; `[type='text']` -> `{tag:"text"}` spec [0,0,2]. All silent. Two type tokens in one compound silently overwrite (`div|p` -> `{tag:"p"}`). The extra bite: `div[hidden] span` -> `[{tag:"hidden"},{tag:"span"}]` — the *subject-side ancestor* `div` is discarded and replaced by the attribute name, so a descendant selector is rewritten into a different, plausible-looking selector rather than merely being dropped.

The strictness inconsistency is confirmed too: `*` throws ('could not parse compound selector'), `>` throws at css.ts:106-108, `:not(.x)` throws at css.ts:135, and Tailwind's escaped variants throw loudly (`.hover\:bg-red-500:hover` -> 'unsupported pseudo-class ":bg-red-500"', `.md\:flex` -> 'unsupported pseudo-class ":flex"'). Only the attribute-selector path is silent, and it is the one ROADMAP.md:314-316 puts on the critical path for shadcn. The recommended `tokens.join("") !== part` guard is a correct total-coverage check for this token grammar. Impact today is nil (app.css uses no attribute selectors), but 'silently wrong' in a compiler whose pitch is that a compile error beats a silent approximation is the right severity.

<a id="f-compiler-css-u16-style-id-unchecked"></a>

### MEDIUM · Style ids emitted as Uint16Array with no bound check; >65535 slots silently wraps

`soundness` · `compiler-css/u16-style-id-unchecked`

**Where:** `src/compiler/compile.ts:727`, `src/compiler/compile.ts:900`, `src/compiler/compile.ts:867`, `src/ir.ts:231`

**Claim.** `nodes.style` is a `Uint16Array` but nothing asserts `result.styles.length <= 65535` or `variants.slotCount <= 65535`; exceeding it truncates modulo 65536 and silently points nodes at the wrong style.

**Evidence.** compile.ts:727 `style: new Uint16Array(result.nodes.map((n) => n.style))` and compile.ts:900 `style: ${typedArray("Uint16Array", nodeStyle)}`. `grep -rn '65535|0xffff' src/` finds no bound check (only colour masks). Measured: a document with 70000 distinct inline `padding-top` values compiles with no error or warning, reports `styles.count = 70000`, and 4464 nodes point at the wrong style — node 70000 gets style id 4463 (padT=4463) instead of ~65537. `FieldPatch.slots` has the same problem at compile.ts:867 (`typedArray("Uint16Array", e.slots)`), so a large variant table corrupts patch targets too.

**Impact.** Silent IR data corruption uploaded straight into the native engine — wrong colours and wrong geometry with no diagnostic on a page that compiled 'successfully'. The ceiling is not remote for this design: variant-compile.ts:200-214 interns over the *vector* of styles across all variants, so slot count grows with the number of toggles, and the roadmap adds media queries and `data-state` as further variants. A page that fits today can cross the line by adding one toggle.

**Recommendation.** Add an explicit check in both `toCompiledUi` and `emit`: `if (styleCount > 0xffff) throw`, plus the same for patch slot ids. Better still, derive the emitted constructor from the count (`> 0xffff ? "Uint32Array" : "Uint16Array"`) and widen the protocol field — but the assert is the non-negotiable part, since a truncating typed-array write is the same failure class the project already guards against with magic-number handle validation on the FFI boundary.

**Verifier — weakened.** `nodes.style` and `FieldPatch.slots` are emitted as Uint16Array with no bound check, and exceeding 65535 does silently wrap (verified: 70000 styles, node 70000 gets id 4463). But the ceiling is remote, not near: slots are interned per distinct computed-style vector and bounded by 4 x nodeCount, and the 126-node sample uses 48 slots. This is a cheap missing assert (`if (styleCount > 0xffff) throw`), not a live corruption risk, and adding a toggle cannot cross the line on any realistic page.

<a id="f-compiler-css-fixed-three-state-roles"></a>

### MEDIUM · hover/active/focus is a fixed 3-column enum baked into the wire protocol and Rust

`architecture` · `compiler-css/fixed-three-state-roles`

**Where:** `src/ir.ts:243-265`, `src/protocol/schema.ts:144-153`, `native-src/dziri-engine/src/paint.rs:89-101`, `src/compiler/compile.ts:222-232`, `src/compiler/variant-compile.ts:162-163`, `src/compiler/css.ts:32-38`

**Claim.** The interaction-state representation is three named columns replicated across `BuiltNode`, `StateTable`, `schema.ts` (hence generated.ts and protocol.rs), `paint.rs::style_for`, and `ROLE_NAMES`; it can express 'one style per fixed role, pick one by precedence' and nothing else. Every A1 item touching variants — group-*/peer-*, data-[state=], :focus-visible, media queries — needs more predicates or predicates owned by a different node, and `Selector.pseudo` is one scalar for the whole selector rather than per-compound.

**Evidence.** schema.ts:147-152 lists literally `{node},{hover},{active},{focus}`. paint.rs:96-101: `} else if i == state.hovered && hover >= 0 { return hover as usize; } if i == state.focused && focus >= 0 { return focus as usize; }` — hover is checked before focus, so a hovered-and-focused control returns its hover style and loses its focus style entirely. css.ts:137-139 hard-rejects the non-subject case: `if (p !== parts.length - 1) throw new CssError(':${name} is only supported on the subject of a selector')`. ROADMAP.md:321 confirms group-*/peer-* is 'a pseudo-class on a non-subject compound, which the parser currently rejects.'

**Impact.** For shadcn components this is visible today: `focus-visible:ring-2` plus `hover:bg-accent` on the same button means the focus ring vanishes the moment the mouse touches it — the exact failure ROADMAP.md:357 calls 'the difference between polished and broken'. Longer term, `group-hover` means a *different* node's hover changes this node's style, which a one-row-per-node state table cannot express at all; fixing it means editing schema.ts, regenerating TS + Rust, rewriting `style_for`, and rewriting `buildStates`/`compileVariants` roles. That is the thing that gets torn out.

**Recommendation.** Replace the three columns with one variant-mask slot table before A1: per interactive node, a small dense run of style slots indexed by a bitmask of compiler-defined predicates (bit0 self:hover, bit1 self:active, bit2 self:focus-visible, bit3 'group G hovered', bit4 'data-state=open', bit5 'viewport>=768'), plus a per-node mask of which bits it reads. The runtime becomes `slots[node][liveMask & nodeMask[node]]`. This subsumes all four roadmap items in one representation, and correct per-property merging of hover∧focus falls out for free because `collectDecls(rules, path, ["none","hover","focus"])` already computes the exact CSS answer — interning collapses duplicate combinations, so the cost is a few extra `collectDecls` calls per element and a few more sparse rows. Move `pseudo` from `Selector` into `Compound` at the same time.

**Verifier — weakened.** The interaction-state representation is three fixed columns and hover does win over focus in paint.rs:96-101, but that non-merging is explicitly documented as deliberate at ir.ts:250-258 and NOTES.md:415-418, and all four cited variant features are ROADMAP A1/A3 items. The claim that a per-node state table 'cannot express group-hover at all' is wrong: variant-compile.ts:252-279's style-table patch mechanism already expresses 'a predicate owned by another node rewrites these slots', and ROADMAP.md:321-322 nominates precisely that route. Treat as design advice on scheduled work (medium), not as an unnoticed defect.

<a id="f-compiler-css-at-rule-block-nesting"></a>

### MEDIUM · parseCss cannot nest blocks: a @media body vanishes and the next rule fails to parse

`better-alternative` · `compiler-css/at-rule-block-nesting`

**Where:** `src/compiler/css.ts:57-89`, `src/compiler/css.ts:68`, `src/compiler/css.ts:74-78`, `src/compiler/css.ts:53-55`

**Claim.** `parseCss` finds rule bounds with `indexOf("{")`/`indexOf("}")` and has no brace-depth counter, so an at-rule's closing brace is left in the stream; nested rules are discarded with only a warning and the stray `}` is prepended to the following selector, making it a hard parse error with a misleading message.

**Evidence.** css.ts:68 `const close = text.indexOf("}", open);` with no depth tracking, and css.ts:74-78 skipping only the prelude. Measured on `.a { color: red }\n@media (min-width: 700px) { .b { color: blue } }\n.c { color: green }`: output is `warn: ignoring at-rule "@media"` followed by `CssError: could not parse compound selector "}"`. So `.b` silently vanishes and `.c` cannot be reached at all. `stripComments` (css.ts:53-55) has the mirror problem — a regex over the whole file, so `/*` inside a string value is honoured as a comment.

**Impact.** You cannot put any rule after a media query, which makes the parser incompatible with essentially every real stylesheet including Tailwind's own layered `@layer` output. ROADMAP.md:317-320 wants media queries compiled to signals riding the existing style-patch mechanism — a good design — but it is blocked on nesting, and `Rule` (css.ts:40-45) has no field to carry a condition, so `collectDecls` has no way to filter by an active condition set.

**Recommendation.** Replace the scanner with `css-tree` (`csstree.parse(src, { positions: false })`), the build-time-only dependency the file header already nominates; it gives correct block nesting, string/url/comment tokenisation, and an `Atrule` node with a parsed prelude for free. Then add `conditions: number[]` to `Rule` (indices into a table of media predicates), have `collectDecls` take the active condition mask, and synthesise one `Toggle` per condition so media queries reuse `compileVariants` unchanged. Small once nesting exists — foreclosed by the parser, not by the architecture.

**Verifier — confirmed.** Reproduced exactly, plus the stripComments half. css.ts:64-71 uses `indexOf("{")` / `indexOf("}", open)` with no depth counter and css.ts:74-78 `continue`s after warning, leaving the at-rule's own `}` in the stream. On `.a { color: red }\n@media (min-width: 700px) { .b { color: blue } }\n.c { color: green }` the output is `warn: ignoring at-rule "@media"` then `CssError: could not parse compound selector "}"` — `.b` gone, `.c` unreachable, misleading message. I also confirmed the boundary: a media query with nothing after it parses fine (`.a` survives, `.b` silently dropped), and non-nesting at-rules like `@font-face{src:url(a)}` are handled correctly, so the failure is specifically 'any rule after a nested at-rule'.

The stripComments mirror problem is confirmed too, and it is nastier than described. On `.a { background: url("x/*y") ; color: red }\n/* a real comment */\n.b { color: blue }` the regex at css.ts:54 spans from the `/*` inside the url to the real `*/`, producing one bogus rule `.a { background: url("x\n.b { color: blue }` — `color: red` and the whole `.b` rule vanish with no diagnostic at all.

One mild overstatement: the media-query case fails loudly overall (the build dies on the CssError), so 'silently' applies only to the dropped `.b` and to the comment case. Medium is right, and ROADMAP.md:317-320 does want media queries as signals, so this is blocked work rather than a non-goal despite the css.ts:75 comment calling at-rules 'an explicit non-goal'.

<a id="f-compiler-css-shorthand-expansion-vs-spec"></a>

### MEDIUM · border and flex shorthands compute wrong values, not merely approximate ones

`correctness` · `compiler-css/shorthand-expansion-vs-spec`

**Where:** `src/compiler/css.ts:430-440`, `src/compiler/css.ts:535-561`, `src/compiler/css.ts:249-258`

**Claim.** Both shorthands are parsed by scanning tokens rather than by the spec's positional grammar, and neither resets the components it omits, so several common forms produce values that differ visibly from a browser.

**Evidence.** All measured against the compiler. (1) css.ts:430-440, `border` does not reset: `.a{border-width:5px} .a{border:#ff0000}` gives `borderWidth=5, borderColor=ffff0000` — a 5px red border where a browser paints nothing (the shorthand resets style to `none`). (2) `.a{border:2px solid}` gives `borderColor=0` (transparent); CSS uses `currentColor`, and with `body{color:#ff0000}` the compiler still emits 0 while `fg=ffff0000` sits right there. (3) `border: 1px none red` passes `none` through the `continue` at css.ts:434 while the guard at css.ts:438 tests the *whole* string, so a border is drawn where CSS draws none — and `border-style: none` as a longhand (Tailwind's `border-none`) is warn-and-ignored: `.a{border:1px solid #333; border-style:none}` → `borderWidth=1 borderColor=#2f2f37`. (4) css.ts:558, `flex: 1 100px` → `basis=0`, because `parts.find(p => ... && p !== parts[0] && p !== parts[1])` excludes `100px` for *being* parts[1]; spec says grow 1, shrink 1, basis 100px. (5) `flex: 0 0 auto` → `basis=0`; spec says auto. (6) css.ts:250-257, `boxShorthand` silently truncates a 5-value `padding` to the first four (`1 2 3 4`) instead of rejecting the declaration.

**Impact.** (1)-(3) mean the 'style ignored' simplification is not conservative — it paints borders CSS does not — and `border-none` is a standard Tailwind utility. (2) makes every `border: 1px solid` without a colour invisible. (4)-(5) mis-size flex items, and flex basis is the one value whose own comment (css.ts:555-556) argues the difference 'is visible'. The 1-to-4-value mapping itself is correct.

**Recommendation.** Add a `borderStyle` field to STYLE_FIELDS (or, cheaper and honest, force `borderWidth` to 0 whenever the resolved style is `none`) and make `border` a true reset: parse positionally, initialise width=3, style=none, color=currentColor before consuming tokens, and handle `border-style` as a longhand. Rewrite `flex` against CSS Flexbox §7.1.1: first unitless number is grow, a second unitless number is shrink, a `<length>|auto|content` token is basis, the one-value length form means `1 1 <length>`, and default basis to 0 only when omitted. Make `boxShorthand` throw on more than 4 values.

**Verifier — confirmed.** All six sub-claims measured true against the compiler; none are approximations, all are wrong values. (1) `border-width:5px` then `border:#ff0000` -> `{borderWidth:5, borderColor:0xffff0000}`; CSS resets style to `none` so a browser paints nothing. (2) `border:2px solid` -> `{borderWidth:2}` only, leaving INITIAL borderColor 0x00000000 (ir.ts:172) — transparent where CSS uses currentColor, and borderColor is non-inherited (ir.ts:82) so `fg` next door does not help. (3) `border:1px none red` -> `{borderWidth:1, borderColor:red}`: `none` hits the `continue` at css.ts:434 while the reset guard at css.ts:438 tests the whole value string, so a border is painted where CSS paints none; and `border-style:none` as a longhand is `warn: ignoring unsupported property "border-style"` leaving `{borderWidth:1, borderColor:0xff2f2f37}` — that is Tailwind's `border-none` doing nothing. (4) `flex: 1 100px` -> `{grow:1, shrink:1, basis:0}`, because the `p !== parts[1]` exclusion at css.ts:558 rejects `100px` for being parts[1]; spec says basis 100px. (5) `flex: 0 0 auto` -> `basis:0` (and `1 1 auto` likewise) where spec says auto — note `flex: none` is special-cased correctly at css.ts:538-543, which makes the longhand-form divergence more surprising, not less. (6) `padding: 1px 2px 3px 4px 5px` -> `{padT:1,padR:2,padB:3,padL:4}`, silently truncated by the destructure at css.ts:251-257 rather than rejected. The 1-to-4 mapping itself is correct, as claimed. css.ts:555-556's own comment arguing basis 'is visible' does undercut (4)-(5). Medium is right — nothing in app.css hits these today (every `border` there carries a colour), but `border-none` and bare `border: 1px solid` are ordinary Tailwind/shadcn output.

<a id="f-compiler-css-invalid-values-silently-numeric"></a>

### MEDIUM · Invalid lengths become NaN and invalid colours become transparent or black

`correctness` · `compiler-css/invalid-values-silently-numeric`

**Where:** `src/compiler/css.ts:224-231`, `src/compiler/css.ts:208-218`, `src/compiler/css.ts:574-580`

**Claim.** The stated policy is 'unsupported value throws', but `parseLength` accepts `auto` for every property including ones where it is invalid, and `parseColor`'s `rgb()` path does no NaN or range checking, so several invalid declarations silently become numbers that flow into the shared style table and the native layout engine.

**Evidence.** css.ts:226 `if (v === "auto") return AUTO;` is unconditional. Measured: `.a{gap:auto; padding:auto}` compiles clean and yields `gapRow=NaN padT=NaN`, written into a `Float32Array` (ir.ts:107-108, ir.ts:87) and uploaded to Taffy; same for `border-radius: auto` and `font-size: auto`. For colour, css.ts:210 `.map(Number)` with no validation: `rgb(0 0 0 / 50%)` → `0` (fully transparent, silent), `rgb(100%, 0%, 0%)` → `ff000000` (opaque black, silent), `rgb(300,0,0)` → `ff2c0000` (component overflowed into the alpha byte and was masked, silent).

**Impact.** A NaN gap or padding propagates through Taffy into `bounds`, and every NaN comparison in `hit_test` (paint.rs:266 `px < x || py < y || ...`) is false, so a NaN-positioned node swallows every click in its ancestor's box. Percentage alpha and percentage components are ordinary CSS and appear in Tailwind v4 output; silently rendering them transparent or black is the worst possible outcome for a compiler whose pitch is that a compile error beats a silent approximation — exactly the argument css.ts:305-308 makes for grid tracks.

**Recommendation.** Give `parseLength` an `allowAuto` parameter and pass it only from width/height/min/max/margin/inset/flex-basis; everything else rejects `auto`. In `parseColor`, validate after `.map(Number)`: reject non-finite components, support `%` on components and on alpha, and clamp/round to 0-255 before shifting. A single guard over `expandDeclaration`'s output that rejects NaN for any field not on an auto-capable list would catch the whole class.

**Verifier — weakened.** `parseLength` does accept `auto` unconditionally (css.ts:226) and `parseColor`'s rgb() path does no validation (css.ts:210), so `gap:auto`/`padding:auto` silently yield NaN and `rgb(0 0 0 / 50%)`/`rgb(100%,0%,0%)`/`rgb(300,0,0)` silently yield transparent/black/masked-overflow — all verified. But the NaN does not reach Taffy or `bounds`: layout.rs:311-313 (`lp`), :315-320 (`lpa`) and :296-309 (`opt`/`dim`) coerce every non-finite style value to 0.0 or auto before building the Taffy style, so the hit_test click-swallowing scenario cannot occur from gap or padding. The one unsanitized NaN path is `font-size`, which reaches Skia via paint.rs:204 and text.rs:184.

<a id="f-compiler-css-html-attr-value-gt"></a>

### MEDIUM · HTML tag scanner is not quote-aware: '>' in an attribute value truncates the tag

`correctness` · `compiler-css/html-attr-value-gt`

**Where:** `src/compiler/html.ts:159-161`, `src/compiler/html.ts:211-220`

**Claim.** `parseHtml` finds the end of a tag with `src.indexOf(">", lt)` without tracking quotes, so the first `>` inside an attribute value ends the tag; the remaining attributes are dropped and the rest of the tag text is pushed into the tree as a text node.

**Evidence.** html.ts:159 `const gt = src.indexOf(">", lt);`. Measured on `<body><div title="a>b" class="card">hi</div></body>`: the div is produced with `classes: []` (the `class="card"` is gone) and its single child is `{"type":"text","value":"b\" class=\"card\">hi"}` — the markup is painted as visible text. No error, no warning.

**Impact.** Silent tree corruption in the strict parser whose entire justification is that 'unbalanced tags are a compile error, not something to silently repair' (html.ts:1-8). A dropped `class` is a dropped cascade, and the leaked text is rendered. `>` in an attribute value is legal HTML and appears in `title`, `aria-label`, `alt`, and any `data-*` holding an expression. A milder related divergence: `pushText` (html.ts:246-250) trims each run, so `<span>a</span> <span>b</span>` loses the separating space that `white-space: normal` preserves — currently masked by the absence of an inline formatting model.

**Recommendation.** Scan forward from `lt` tracking `"`/`'` state to find the real `>`; about 10 lines, and it preserves the existing strictness since `parseAttributes` (html.ts:213) already handles quoted values correctly. If HTML authoring is no longer on the critical path (src/compile.ts:36-39 defaults to app.tsx), the honest alternative is to make `parseHtml` reject a `>` inside a quoted attribute value with a clear error rather than half-support it.

**Verifier — confirmed.** Reproduced byte for byte. html.ts:159 is `const gt = src.indexOf(">", lt);` with no quote tracking. Parsing `<body><div title="a>b" class="card">hi</div></body>` yields a div with `classes: []` — the `class="card"` is gone — whose single child is `{"type":"text","value":"b\" class=\"card\">hi"}`, so the markup leaks into the tree as paintable text. No error, no warning. That is silent tree corruption in the parser whose header (html.ts:1-8) justifies itself on 'unbalanced tags are a compile error, not something to silently repair', and a dropped `class` is a dropped cascade. parseAttributes (html.ts:213) does handle quoted values correctly, so the 10-line quote-aware scan is the right fix and preserves the existing strictness.

The related pushText claim is confirmed too: html.ts:246-250 collapses then `trim()`s each run and drops whitespace-only runs, so `<span>a</span> <span>b</span>` loses the separating space that `white-space: normal` preserves — currently invisible because there is no inline formatting model. Medium is right; HTML is no longer the default front-end (src/compile.ts:36-39 prefers app.tsx), which caps the blast radius.

<a id="f-compiler-css-cascade-complexity-cliff"></a>

### MEDIUM · Matching is O(nodes x rules x depth) with 7 full rule scans per element

`performance` · `compiler-css/cascade-complexity-cliff`

**Where:** `src/compiler/compile.ts:94-114`, `src/compiler/compile.ts:117-124`, `src/compiler/compile.ts:384-413`, `src/compiler/compile.ts:323`, `src/compiler/variant-compile.ts:182-194`

**Claim.** Every element runs four full `collectDecls` passes plus three full `hasPseudoRule` passes over every rule and every selector, each doing an O(depth) path walk with `classes.includes` linear scans; `hasPseudoRule` costs as much as the work it avoids, and the whole thing is multiplied by (toggles + 1) compiles.

**Evidence.** compile.ts:384-413 issues `collectDecls` at states `[none]`, `[none,hover]`, `[none,hover,active]`, `[none,focus]` plus `hasPseudoRule` three times; `collectDecls` iterates `for (const rule of rules) for (const sel of rule.selectors)` with no filtering (compile.ts:97-103) and `matchCompound` uses `el.classes.includes(cls)` (compile.ts:46). `hasPseudoRule` is pure overhead: without it the state cascade produces the identical style and compile.ts:425-427 already collapses `hoverId === styleId` to -1. Measured on synthetic pages: 1000 nodes / 200 rules / depth 8 = 81ms; 2000/400 = 146ms; 4000/800 = 517ms; 4000/1600 = 871ms; 8000/1600/depth-12 = 1754ms. variant-compile.ts:186 calls `compileTree` once per toggle and `compileTree` re-runs `parseCss(css)` each time (compile.ts:323). The reported 28ms/1215 nodes is not the relevant datum: list arenas are replicated, not cascaded (compile.ts:516-535), so only ~40 elements x ~90 rules actually cascade in the sample.

**Impact.** A purged Tailwind build for a real app is 1000-3000 rules and shadcn pages run to thousands of elements. 4000 nodes x 1600 rules is already 0.9s per pass, so six conditional classes puts a single build near 6s — a dev-loop killer for a compiler whose selling point is that the cost moved to build time.

**Recommendation.** The standard fix is fully available and nothing forecloses it: bucket rules by the rightmost simple selector, which `Selector.compounds[compounds.length-1]` already exposes as `{tag,id,classes}`. Build four maps (byId, byClass, byTag, universal) once per `parseCss` and have `collectDecls` visit only `byId[el.id]`, the union of `byClass[c]`, `byTag[el.tag]` and universal — typically 5-20 candidates instead of 1600. Add an ancestor Bloom filter (a 128-bit hash of every id/class/tag on the path) to reject non-matching descendant selectors before the path walk, as Blink and Servo do. Independently: delete `hasPseudoRule` and collapse `activeId === hoverId` to -1 instead (a one-line dedup), removing 3 of the 7 scans for free; store `el.classes` as a `Set`; and hoist `parseCss` out of `compileTree` so the k+1 variant compiles parse the stylesheet once.

**Verifier — weakened.** Matching is O(nodes x rules x depth) with no rule bucketing and the measured curve is a real dev-loop problem at Tailwind scale (my runs: 471ms at 4000 nodes/1600 rules, 1133ms at 8000/1600, multiplied by toggles+1 because variant-compile.ts:186 recompiles and compile.ts:323 re-parses the CSS each time). Bucket by rightmost compound, add an ancestor Bloom filter, make `el.classes` a Set, and hoist parseCss — all correct and all available. But the per-element cost is 4 scans, not 7, for elements with no pseudo rule (compile.ts:393/400/407 skip the state cascade when hasPseudoRule is false), and deleting hasPseudoRule is a pessimization, not a free win: it swaps 3 allocation-free scans for 3 full collectDecls calls (candidate array + sort + Map) on the common path.

<a id="f-compiler-css-warn-and-ignore-bypasses-warning-channel"></a>

### LOW · Unknown-property warnings use console.warn, bypassing CompileResult.warnings

`process` · `compiler-css/warn-and-ignore-bypasses-warning-channel`

**Where:** `src/compiler/css.ts:684-686`, `src/compiler/css.ts:76`, `src/compiler/compile.ts:309-311`

**Claim.** The warn-for-unknown-property / throw-for-unsupported-value split is defensible — it mirrors CSS's own error handling, where a UA drops declarations it does not understand — but the plumbing is not: the warning is a bare `console.warn` deep in the expander, while `CompileResult` has a `warnings: string[]` channel built for exactly this.

**Evidence.** css.ts:685 `console.warn("  warn: ignoring unsupported property \"${prop}\"")` inside `expandDeclaration`, which has no access to the selector or the element. compile.ts:309-311 declares `/** Diagnostics worth surfacing but not worth failing over. */ warnings: string[]` and src/compile.ts:110 prints it — the expander never uses it. The at-rule warning at css.ts:76 is the same. `applyDecls` already threads a `where` string (compile.ts:159-168) that would locate the diagnostic, and does not pass it down.

**Impact.** The author gets `warn: ignoring unsupported property "text-align"` with no selector, no element, once per matched element (so N duplicates), no way to promote it to an error in CI, and no way to test it. Since the ignored set includes properties that change rendering meaningfully — `border-style`, `text-align`, `line-height`, `overflow`, `opacity`, `box-shadow` — and Tailwind's utility surface is the declared subset, warn-and-ignore is currently how `text-center` and `border-none` silently do nothing.

**Recommendation.** Keep the ignore semantics, fix the channel: pass a `warnings: string[]` sink into `expandDeclaration`, include the `where` string `applyDecls` already holds, dedupe by (property, selector), and add a `--strict` flag that turns the list into a non-zero exit. Then add an explicit `KNOWN_UNSUPPORTED` set of properties the project has consciously skipped — anything not on that list and not implemented becomes an error, which is what catches `paddding: 4px` typos. That buys CSS's forward-compatibility and typo detection at the same time.

**Verifier — confirmed.** Confirmed as stated and correctly scoped as process/low. css.ts:685 is a bare `console.warn` inside expandDeclaration, which receives only `(prop, raw, out)` and so cannot name the selector or element; css.ts:76 does the same for at-rules. compile.ts:309-311 declares `/** Diagnostics worth surfacing but not worth failing over. */ warnings: string[]` and src/compile.ts:110 prints it (`for (const w of result.warnings) console.warn(...)`), and the expander never touches it. applyDecls does hold a `where` string (compile.ts:159-168) built by `describe` (compile.ts:360-363) and does not pass it down. Duplication is real: the expander runs per element, again per state cascade (compile.ts:393-413), and again per toggle compile (variant-compile.ts:186), so one unsupported property warns many times — I saw `warn: ignoring unsupported property "border-style"` emitted from a single declaration in test. The ignored set genuinely includes render-affecting properties (`border-style` warn-and-ignored is measured in the shorthand finding; `text-align`, `line-height`, `overflow`, `opacity`, `box-shadow` have no case in expandDeclaration's switch, css.ts:417-686). Low is right: the diagnostic does reach stderr, so nothing is fully silent — what is missing is location, dedup, testability and a CI gate. The KNOWN_UNSUPPORTED suggestion is a genuine improvement, since today `paddding: 4px` is indistinguishable from a deliberate omission.

---

## Authoring front-end: JSX runtime & reference resolution

*9 findings — 2 high, 2 medium, 5 low.*

- **high** · [HTML front-end emits an unparseable ui.gen.ts for any onclick, and reports success](#f-authoring-frontend-html-onclick-emits-invalid-module)
- **high** · [Any list-item expression that is not a bare property read miscompiles silently](#f-authoring-frontend-item-recorder-silent-miscompile)
- **medium** · [Props.onClick accepts a string that is interpolated verbatim as JS into the artifact](#f-authoring-frontend-onclick-string-injected-as-source)
- **medium** · [Build-time module execution is uncontained; a top-level timer hangs the compile forever](#f-authoring-frontend-build-time-execution-uncontained)
- **low** · [Runtime imports a compiler module and walks string item paths per row](#f-authoring-frontend-runtime-interprets-item-paths)
- **low** · [cn() forwards any truthy non-boolean as a signal, misleading the eventual error](#f-authoring-frontend-cn-accepts-non-signal-conditional)
- **low** · [Child admits Record<string, unknown>, so an object child crashes inside the cascade](#f-authoring-frontend-child-union-admits-any-object)
- **low** · [16% of the generated module is constant arrays the emitter already knows how to compress](#f-authoring-frontend-constant-typed-arrays-bloat-artifact)
- **low** · [Aliased exports resolve to an alphabetically-chosen name, not the one authored](#f-authoring-frontend-aliased-exports-pick-arbitrary-name)

<a id="f-authoring-frontend-html-onclick-emits-invalid-module"></a>

### HIGH · HTML front-end emits an unparseable ui.gen.ts for any onclick, and reports success

`soundness` · `authoring-frontend/html-onclick-emits-invalid-module`

**Where:** `src/compile.ts:104`, `src/compiler/compile.ts:825`, `src/compiler/compile.ts:433`, `src/compiler/compile.ts:814`

**Claim.** The HTML authoring path never calls `resolveRefs`, so every handler keeps its initial `name: ""`, and `emit` interpolates that empty string as an identifier — producing a generated module that cannot be parsed, while the CLI prints a success line.

**Evidence.** src/compile.ts:104-106 — the non-JSX branch is `} else { result = compile(await Bun.file(inputPath).text(), css); }` with no `resolveRefs` call and `imports` left as the empty Map. src/compiler/compile.ts:433 seeds `handlers.push({ node: self, ref: el.onClick, name: "" })`, and src/compiler/compile.ts:825 emits `  { node: ${h.node}, fn: ${h.name} },`. Reproduced with `<body><button class="btn" onclick="addTodo">go</button></body>`: the CLI printed `compiled … -> h1.gen.ts / 2 nodes, 4 unique styles / 4662 bytes of IR` and the file contains `export const handlers = [\n  { node: 1, fn:  },\n];`. Importing it fails: `LOAD ERROR: BuildMessage: Unexpected }`. Note the emitter already has exactly this guard for text parts one line away — `throw new Error("unresolved text binding — resolveRefs was not run")` at src/compiler/compile.ts:814 — but not for handlers, editables or lists. The `typeof handler.ref === "string"` branch written to support this case (src/compiler/resolve-refs.ts:88) is dead on the path it was written for.

**Impact.** `bun run compile app/app.html app/app.css` is a documented entry point (src/compile.ts:5) and any `onclick` attribute in it yields a broken build that reports zero errors; the failure surfaces later as a parse error in a generated file the author is told not to edit.

**Recommendation.** Make `emit` refuse to interpolate an unresolved name: assert `/^[A-Za-z_$][\w$]*$/.test(h.name)` for handlers, editables and `l.exportName` — the same shape of guard already present at compile.ts:814. Then run `resolveRefs` on the HTML path too, passing `sources` built from a sibling `state.ts`, so `onclick="addTodo"` is validated against the export index and produces a real import instead of a bare identifier.

**Verifier — confirmed.** Tried and failed to break it. src/compile.ts:104 is literally `} else { result = compile(await Bun.file(inputPath).text(), css); }` — no resolveRefs, and `imports` stays the empty Map declared at src/compile.ts:52. src/compiler/html.ts:194 sets `onClick: attrs.get("onclick") ?? null`, compile.ts:433 seeds `name: ""`, and the emitter at src/compiler/compile.ts:825 does `  { node: ${h.node}, fn: ${h.name} },` with no guard. Reproduced verbatim with `<body><button class="btn" onclick="addTodo">go</button></body>`: CLI printed `compiled … -> h1.gen.ts / 2 nodes, 2 unique styles, 1 strings / 4299 bytes of IR` (exit 0, zero warnings) and the file contains `export const handlers = [\n  { node: 1, fn:  },\n];`; importing it gives `LOAD ERROR: BuildMessage Unexpected }`. The asymmetry is real: partSource at compile.ts:814 throws `unresolved text binding — resolveRefs was not run` eleven lines above the unguarded handler line. The string branch at resolve-refs.ts:87-91 is dead on the HTML path, since resolveRefs is never invoked there. Attempted mitigations I checked and rejected: the HTML front-end is not a dead path (NOTES.md:261 and NOTES.md:355 claim `app/app.tsx` compiles to byte-identical IR to `app/app.html`, and defaultInput() at src/compile.ts:36-39 falls back to app.html); the only reason nobody has hit it is that the 19-line app/app.html sample happens to contain no `onclick`. Even a valid identifier would break, because `imports` is empty so no import line is emitted — the HTML onclick feature is 100% non-functional while reporting success.

<a id="f-authoring-frontend-item-recorder-silent-miscompile"></a>

### HIGH · Any list-item expression that is not a bare property read miscompiles silently

`correctness` · `authoring-frontend/item-recorder-silent-miscompile`

**Where:** `src/compiler/item-path.ts:23`, `src/compiler/jsx-runtime.ts:325`, `src/compiler/compile.ts:566`

**Claim.** Template literals, string/number concatenation and conditionals on item values coerce the recording proxy to a string or a boolean, so the row template captures a constant instead of a binding — and the compiler reports success with zero item bindings.

**Evidence.** src/compiler/item-path.ts:23-25 hands out a stringifier: `if (prop === Symbol.toPrimitive || prop === "toString" || prop === Symbol.toStringTag) return () => `[item.${path.join(".")}]`;`. Reproduced, all three compiling with a success line and no warning: (a) a template literal `#${t.id} ${t.title}` → `export const strings = ["#[item.id] [item.title]"]` with `slotsPerItem: 0, bindings: []`; (b) `{t.id + 1}` → `strings = ["[item.id]1"]`; (c) `{t.done ? "DONE" : "TODO"}` → `strings = ["DONE"]`, because ToBoolean on a Proxy is not trappable. Every row of every list renders that constant forever. app/state.ts:26-31 documents the ternary hazard in prose but nothing enforces it.

**Impact.** The worst failure mode in the front-end: it ships. A list whose rows all read `#[item.id] [item.title]`, or all read `DONE`, passes compile, passes emit, and is only discovered by looking at pixels. The `toPrimitive` hook, whose comment claims it makes the mistake "obvious", is precisely what downgrades a hard `TypeError` to a silent wrong artifact.

**Recommendation.** Three cheap layered checks, none needing an AST: (1) after `internString`/`reserveSlot`, throw if any emitted string contains the sentinel `[item.` — that alone catches (a) and (b) loudly, and is why the sentinel should be an unlikely marker like `\0item:path\0`; (2) in the `setListBuilder` callback (src/compiler/jsx-runtime.ts:52), warn or error when a template compiles to zero item bindings AND zero item handlers, since a keyed dynamic list with nothing per-row is always a mistake; (3) for the ternary, which no proxy can see, provide the intended primitive — a `when(t.done, "[x]", "[ ]")` helper that records a conditional path — and name it in the error text so the advice in app/state.ts:26 is enforced rather than documented. The general fix is the source-level transform in the next finding.

**Verifier — confirmed.** All three cases reproduced with a success line, exit 0, and zero warnings. src/compiler/item-path.ts:23-25 returns `() => `[item.${path.join(".")}]`` for Symbol.toPrimitive/toString/Symbol.toStringTag. (a) `{`#${t.id} ${t.title}`}` → `export const strings = ["#[item.id] [item.title]"];` with `slotsPerItem: 0` and an empty `bindings`. (b) `{t.id + 1}` → `strings = ["[item.id]1"]`, `slotsPerItem: 0`. (c) `{t.done ? "DONE" : "TODO"}` → `strings = ["DONE"]`, `slotsPerItem: 0` — ToBoolean on a Proxy has no trap, so nothing can see it. Each printed e.g. `compiled .verify/c3.tsx … 19 nodes, 3 unique styles, 1 strings`. I looked for a downstream backstop and found none: flatten (jsx-runtime.ts:325) only special-cases `isRecorder(child)`, so a string that a recorder produced is indistinguishable from an author literal by the time it reaches internString, and the setListBuilder callback (jsx-runtime.ts:52-73) validates the key path and the child count but never that the template produced any per-item binding. The prose at app/state.ts:26-31 documents only case (c) (the ternary); (a) and (b) are undocumented, and the toString hook's own comment ("Make an accidental stringification obvious") is what converts what would be a hard TypeError into a wrong artifact that renders one frozen constant on every row forever. Highest-value finding in the set: it is the only one whose failure mode ships.

<a id="f-authoring-frontend-onclick-string-injected-as-source"></a>

### MEDIUM · Props.onClick accepts a string that is interpolated verbatim as JS into the artifact

`security` · `authoring-frontend/onclick-string-injected-as-source`

**Where:** `src/compiler/jsx-runtime.ts:104`, `src/compiler/resolve-refs.ts:88`, `src/compiler/compile.ts:825`

**Claim.** A string `onClick` bypasses reference resolution entirely and is spliced into the emitted module as an expression, so any string that reaches a JSX `onClick` becomes executable code in the shipped artifact.

**Evidence.** src/compiler/jsx-runtime.ts:104 types it as `onClick?: ((item: any, index: number) => void) | (() => void) | string;`. src/compiler/resolve-refs.ts:88-91: `if (typeof handler.ref === "string") { handler.name = handler.ref; continue; }` — no validation of any kind. Reproduced: `<button className="btn" onClick={"(()=>{throw new Error('pwned')})()"}>go</button>` typechecks cleanly under the project's own tsconfig (tsc reported no error for that line) and emits `export const handlers = [\n  { node: 1, fn: (()=>{throw new Error('pwned')})() },\n];`.

**Impact.** Any string that flows into `onClick` — a config value, a JSON field, a CMS string, a codemod's output — becomes code in `ui.gen.ts`, which the app then imports and runs with full FFI access to the native engine. It is also a correctness trap in the benign case, since no import is recorded for the name (see the sibling finding).

**Recommendation.** Delete `| string` from `Props.onClick` — JSX has no use for it; the HTML attribute path is the only legitimate producer and it flows through `Element.onClick: unknown`, not through `Props`. In `resolveRefs`, keep the string branch only for HTML-sourced handlers, validate against `/^[A-Za-z_$][\w$]*$/`, and resolve the name through the export index so an import is emitted and an unknown name is a compile error.

**Verifier — weakened.** `Props.onClick` needlessly admits `string` (jsx-runtime.ts:104), which the JSX path has no use for — the HTML producer flows through `Element.onClick: unknown` (html.ts:25). A string reaching a JSX `onClick` is spliced into ui.gen.ts as an expression (resolve-refs.ts:88, compile.ts:825), so a name-like string yields an undefined identifier at artifact load and an expression-like string becomes artifact code. This is a type-surface/validation defect (medium), not a security boundary violation: build-time already runs arbitrary author code, so no privilege is gained. Fix is still correct — drop `| string` from Props, and validate the HTML-sourced string against /^[A-Za-z_$][\w$]*$/ and the export index.

<a id="f-authoring-frontend-build-time-execution-uncontained"></a>

### MEDIUM · Build-time module execution is uncontained; a top-level timer hangs the compile forever

`process` · `authoring-frontend/build-time-execution-uncontained`

**Where:** `src/compile.ts:63`, `src/compile.ts:113`, `src/compile.ts:97`

**Claim.** `await import(entry)` executes the entry module and its whole import graph with no isolation and no acknowledgement in the docs, and the CLI never exits, so any pending handle a top-level side effect leaves behind blocks the build after the artifact is already written.

**Evidence.** src/compile.ts:63-70 is the whole mechanism: `const specifier = pathToFileURL(resolve(inputPath)).href; setCompiling(true); try { mod = await import(specifier) } finally { setCompiling(false) }`. Reproduced with a tsx entry containing a top-level `writeFileSync(...)` and `setInterval(() => {}, 1000)`: the file `PWNED.txt` was created at compile time, `f1.gen.ts` was written (4319 bytes), and the process was still alive at a 12s timeout — a successful compile that never returns. There is no `process.exit(0)` after `await Bun.write(outPath, source)` at :113. Separately, `setCompiling(true)` wraps only the entry import; the later `await import(statePath)` at :97 runs outside that window, so if the entry does not itself import `state.ts`, that module's top-level `.value` reads see different semantics than if it does.

**Impact.** The compile-time-execution trade is the load-bearing trick of this design and is the one thing no doc comment argues for. In practice: `bun run dev` can hang with no error, CI can hang, and a dependency with a module-scope `fetch` or analytics timer silently runs during every build.

**Recommendation.** Three things: (1) `process.exit(0)` after the write, or snapshot `setInterval`/`setTimeout` before the import and report survivors with `"app/app.tsx left a pending timer; module-scope side effects run at build time"`; (2) state the contract in src/compile.ts's header — the entry module *and everything it imports* executes at build, so keep side effects out of module scope; (3) since `setCompiling` already proves the pattern, stub `globalThis.fetch` for the duration of the import window so a build-time network call fails with an explanatory message instead of silently succeeding, and move `setCompiling(true)` to wrap both imports.

**Verifier — weakened.** Confirmed: `bun run src/compile.ts` executes the entry module's whole import graph at build time (src/compile.ts:63-70) and never calls `process.exit`, so any surviving handle hangs the CLI after the artifact is already written (reproduced: artifact written, process alive at a 12s timeout). But the contract is partially documented at src/compile.ts:55-58 ("importing the module *is* evaluating the components") — what is missing is the transitive-import warning, not any acknowledgement. And the secondary claim about `setCompiling` not wrapping the `await import(statePath)` at :97 has no reachable consequence: the flag only affects keyed `.map` on an array `.value` read (signal.ts:225-241), and any signal that reaches the tree was necessarily imported by the entry, hence evaluated inside the window.

<a id="f-authoring-frontend-runtime-interprets-item-paths"></a>

### LOW · Runtime imports a compiler module and walks string item paths per row

`better-alternative` · `authoring-frontend/runtime-interprets-item-paths`

**Where:** `src/runtime/list-runtime.ts:15`, `src/runtime/list-runtime.ts:234`, `src/runtime/list-runtime.ts:276`, `src/compiler/compile.ts:845`, `src/compiler/compile.ts:813`

**Claim.** `keyPath: ["id"]` and `parts: [{ path: ["mark"] }]` are emitted as data and interpreted at runtime by a generic property-path walker living in the compiler package — a dynamic lookup on the hot path, and a runtime→compiler dependency, both avoidable because the artifact is a module and can hold closures.

**Evidence.** src/runtime/list-runtime.ts:15 — `import { readPath, type ItemPath } from "../compiler/item-path.ts";` — the shipped runtime depends on the module that exports the recording-Proxy factory. It is called per row per update: `const key = readPath(items[i], ref.keyPath);` (:234), `keys[slot] = readPath(items[i], ref.keyPath);` (:267), and inside the per-part loop `next += "literal" in part ? part.literal : String(readPath(items[i], part.path) ?? "");` (:276). `readPath` is a `for (const step of path)` megamorphic index loop (src/compiler/item-path.ts:64). Meanwhile the emitter already proves it can ship live references — `fn: ${h.name}`, `signal: ${part.export}` (src/compiler/compile.ts:825, :812). ROADMAP.md:551 commits to splitting `compiler` and `runtime` into separate packages.

**Impact.** Against the governing principle: the path is fully known at build time yet stays a string array walked at runtime, so every keyed reconcile and every row text rebuild pays property-lookup dispatch instead of a monomorphic field read. And the package split scheduled at ROADMAP.md:551 will hit an import from `runtime` into `compiler`, forcing either a duplicated `readPath` or a shared package created under deadline.

**Recommendation.** Emit accessor closures instead of paths: `keyOf: (it) => it.id` and `bindings: [{ offset: 2, slotOffset: 0, read: (it) => `${it.mark}` }]`. Building the source is a one-line join over the recorded path (bracket form for numeric steps); it is monomorphic and inlineable by JSC, it folds the literal/dynamic interleave into a single template literal per binding, and it deletes `readPath` from the runtime — removing the runtime→compiler edge for free. Keep the recorded path in the emitted object only if you want it for `--dump` readability.

**Verifier — weakened.** Accurate statement: `readPath` (src/compiler/item-path.ts:64) is imported by the shipped runtime (src/runtime/list-runtime.ts:15), a layering inversion worth fixing by relocating the function into `runtime/` or a shared module ahead of the D1 package split (ROADMAP.md:551). The performance claim is not supported: the same loop already does an O(items × capacity) key-matching scan (list-runtime.ts:233-243) that dominates a length-1 property read by orders of magnitude, so accessor closures would be a micro-optimisation, not a hot-path fix. Severity: low (cleanliness/layering), not medium performance.

<a id="f-authoring-frontend-cn-accepts-non-signal-conditional"></a>

### LOW · cn() forwards any truthy non-boolean as a signal, misleading the eventual error

`correctness` · `authoring-frontend/cn-accepts-non-signal-conditional`

**Where:** `src/compiler/jsx-runtime.ts:255`, `src/compiler/resolve-refs.ts:109`

**Claim.** `cn` resolves booleans and drops nullish values but passes everything else through as a conditional source without checking `isSignal`, so a recorder, a string or a number becomes a phantom toggle whose eventual error blames the wrong thing.

**Evidence.** src/compiler/jsx-runtime.ts:255-263: booleans are folded, `null`/`undefined` skipped, then unconditionally `conditional.push({ name, source })`. Reproduced with `className={cn("todo", { done: t.done })}` inside a `view.map` callback: the error is `the signal driving the conditional class ".done" is not a module-level export of a known state module.\n  Signals and handlers must be declared as exports (e.g. in app/state.ts) so the compiler can name them…`. The value was a recording proxy; exporting it is not the fix and is not possible. The correct advice already exists in prose at app/state.ts:26-31 ("Anything conditional per row has to be *data*").

**Impact.** Sends the author down a dead-end path — they will try to export the item's field — for one of the most natural things to write in a list. The information needed for a good message ("this is a list-item path, not a signal") exists at the `cn` call site and is thrown away there.

**Recommendation.** Validate in `cn`, where the value is still identifiable: if `isRecorder(source)`, throw `cn(): class "done" is driven by a list-item value (item.done). Per-row conditional classes are not supported — compute the class into the item data, as view = computed(() => todos.value.map(t => ({...t, mark: …}))) does`. If the value is neither a signal nor a recorder, throw naming the actual type. This also removes the phantom-toggle path from `findToggles`.

**Verifier — weakened.** cn() (jsx-runtime.ts:255-263) pushes any non-boolean, non-nullish value as a conditional source without an `isSignal` check, so a list-item recorder or a string produces the misleading error "the signal driving the conditional class '.done' is not a module-level export…" (resolve-refs.ts:109 → :66) with advice the author cannot follow. This is a diagnostics defect on a fail-closed path — the compile aborts and no artifact is written — so severity is low, not medium correctness. Fix as recommended: check `isRecorder(source)` (item-path.ts:52) inside cn() and name the actual type otherwise.

<a id="f-authoring-frontend-child-union-admits-any-object"></a>

### LOW · Child admits Record<string, unknown>, so an object child crashes inside the cascade

`correctness` · `authoring-frontend/child-union-admits-any-object`

**Where:** `src/compiler/jsx-runtime.ts:76`, `src/compiler/jsx-runtime.ts:336`, `src/compiler/compile.ts:362`

**Claim.** The `Child` union includes `Record<string, unknown>` so that signals and recorders typecheck, which also admits any plain object; `flatten` then falls through to `out.push(node as Node)` and the object is walked as an Element.

**Evidence.** src/compiler/jsx-runtime.ts:76-85 — `export type Child = Node | ReadonlySignal<unknown> | Record<string, unknown> | string | …`. src/compiler/jsx-runtime.ts:336-343: after the recorder and signal checks, `const node = child as Node; … out.push(node);` with no else. Reproduced with `const user = { name: "ada" }; <div className="a">{user}</div>`: tsc reports no error, and the compile dies with `TypeError: undefined is not an object (evaluating 'e.classes.map') at describe (src/compiler/compile.ts:362)` — a stack in the cascade with no mention of JSX.

**Impact.** A `{obj}` typo — forgetting `.value`, forgetting to call a helper, passing props where children were meant — produces an error about `e.classes.map` in the style code, with nothing pointing at the markup.

**Recommendation.** Add the else branch `flatten` is missing: after the signal/recorder checks, require `typeof (node as Node).type === "string"` and otherwise throw `"{…} is not a valid child: expected an element, a signal, a string or a number, got a plain object. Did you mean to interpolate a property?"`. Narrow `Child` and drop `Record<string, unknown>` — recorders can be typed via a branded interface so they still satisfy the union without opening it to every object.

**Verifier — confirmed.** Reproduced precisely and could not find a guard anywhere on the path. src/compiler/jsx-runtime.ts:76-85 includes `Record<string, unknown>` in `Child`; flatten (jsx-runtime.ts:310-344) returns early for nullish/boolean, arrays, string/number, `isRecorder`, and the fragment tag, then ends with an unconditional `out.push(node)` where `const node = child as Node` — there is no `else` and no check that `node.type === "element"`. With `const user = { name: "ada" }; <div className="row">{user}</div>`, tsc under the project's own flags reported no error, and the compile died with `TypeError: undefined is not an object (evaluating 'e.classes.map')` — stack `at describe (compile.ts:362) → walk (:381) → walk (:449) → walk (:449) → compileTree (:591) → src/compile.ts:75`. Exactly as claimed: a cascade-internal stack with no mention of JSX or of which markup produced it. Low severity is the right call — it fails closed at build with no artifact — and the suggested else-branch is the correct minimal fix; note the union genuinely does need to admit recorder proxies, so narrowing `Child` requires the branded-interface step the finding mentions.

<a id="f-authoring-frontend-constant-typed-arrays-bloat-artifact"></a>

### LOW · 16% of the generated module is constant arrays the emitter already knows how to compress

`performance` · `authoring-frontend/constant-typed-arrays-bloat-artifact`

**Where:** `src/compiler/compile.ts:764`, `src/compiler/compile.ts:905`, `app/ui.gen.ts:25`

**Claim.** `typedArray()` always spells out every element, so fields that are uniform across all slots are emitted in full — even though the same `emit` uses `new Int16Array(n).fill(-1)` for the node tables a few lines later.

**Evidence.** src/compiler/compile.ts:764-766: `return `new ${ctor}([${values.map(num).join(",")}])`;` — unconditional. Measured over app/ui.gen.ts: array literals account for 11413 of 18220 source bytes, and 19 of them are single-valued — `marT=0 marR=0 marB=0 marL=0 shrink=1 gridRows=0 gridColStart=0 gridRowStart=0 gridRowSpan=0 justifyItems=255 justifySelf=255 minW=0 maxW=Infinity minH=0 maxH=Infinity` plus the single-row list tables — totalling 2883 bytes (16% of the file) of zero information. Contrast src/compiler/compile.ts:905-906, which already does the right thing: `list: new Int16Array(${nodes.length}).fill(-1), hidden: new Uint8Array(${nodes.length}),`.

**Impact.** Grows as fields × slots. At 2000 style slots roughly 15 uniform fields cost well over 100 KB of JavaScript source that JSC must tokenize on every app start, and it makes diffs noisier for a reviewer trying to see what a CSS change did.

**Recommendation.** In `typedArray()`, if every value is identical emit `new Ctor(n)` when the value is 0 and `new Ctor(n).fill(v)` otherwise (guarding NaN via `Number.isNaN`, since `Float32Array(n)` is already zero-filled and `.fill(NaN)` is explicit). One conditional, no format change for the runtime. If the artifact later outgrows JS source, the scaling path is a binary sidecar for the numeric tables plus a loader, keeping only the import-bound references in the module — but `.fill` buys the first order of magnitude for free.

**Verifier — confirmed.** Independently measured and it holds, with minor numeric drift. src/compiler/compile.ts:764-766 is `return `new ${ctor}([${values.map(num).join(",")}])`;` with no uniform-value branch, and compile.ts:905-906 in the very same emit does `list: new Int16Array(${nodes.length}).fill(-1), hidden: new Uint8Array(${nodes.length}),` — the contrast is exactly as described. Scanning app/ui.gen.ts I get 18234 total bytes, 87 array-literal declarations totalling 13964 bytes, of which 15 are single-valued across all 48 slots totalling 2712 bytes: marT/marR/marB/marL=0, shrink=1, gridRows/gridColStart/gridRowStart/gridRowSpan=0, justifyItems/justifySelf=255, minW/minH=0, maxW/maxH=Infinity. That is 14.9% of the file, versus their 2883/19/16% (my regex misses the multi-line list tables they counted) — same conclusion. One overstatement: the extrapolation to "well over 100 KB" at 2000 slots is optimistic-in-their-favour; 15 fields x 2000 slots at ~2 bytes per `0,` is ~60 KB, reaching ~90 KB once `Infinity,` fields are counted. Low severity is right, the `.fill()` fix is one conditional with no format change, and the `Number.isNaN` guard they flag is genuinely needed because `num()` (compile.ts:757-762) emits bare `NaN`.

<a id="f-authoring-frontend-aliased-exports-pick-arbitrary-name"></a>

### LOW · Aliased exports resolve to an alphabetically-chosen name, not the one authored

`cleanliness` · `authoring-frontend/aliased-exports-pick-arbitrary-name`

**Where:** `src/compiler/resolve-refs.ts:34`

**Claim.** `buildRefIndex` keys by object identity with first-writer-wins over an ESM namespace object, whose keys are specified to be sorted, so the generated module imports whichever alias sorts first rather than the name the author wrote.

**Evidence.** src/compiler/resolve-refs.ts:34-36: `// First writer wins, so an earlier module's name is preferred when the same object is re-exported. if (!index.has(value)) index.set(value, { specifier: source.specifier, name });`. Reproduced with `export const zebra = signal(0); export const alpha = zebra;` and `{zebra}` in the markup: the artifact contains `import { alpha } from "./c4-alias.tsx";` and `parts: [{ signal: alpha }]`.

**Impact.** Behaviourally identical (same object), so this is a reviewability cost rather than a bug: a reviewer reading `ui.gen.ts` sees a name that appears nowhere in the markup, and adding or removing an unrelated alias can rewrite the import list and every binding line in the diff.

**Recommendation.** Keep all names per value (`Map<unknown, ResolvedRef[]>`), emit the first *declared* one by reading declaration order rather than the sorted namespace (or simply prefer the shortest), and push a `warnings` entry naming the aliases — `"signal exported as both `alpha` and `zebra`; ui.gen.ts will import `zebra`"` — so the choice is visible instead of implicit.

**Verifier — confirmed.** Reproduced exactly. src/compiler/resolve-refs.ts:34-36 is `// First writer wins… if (!index.has(value)) index.set(value, { specifier: source.specifier, name });` over `Object.entries(source.exports)` (:31) — and an ESM namespace object's keys are spec-sorted, so first-writer-wins over it means alphabetically-first-wins, not declaration order. With `export const zebra = signal(0); export const alpha = zebra;` and `{zebra}` in the markup, the artifact contains `import { alpha } from "./state.ts";` at line 8 and `{ node: 2, slot: 0, parts: [{ signal: alpha }] }` at line 90 — the name `alpha` appears nowhere in the markup. Correctly self-scoped as a reviewability cost rather than a bug (same object, identical behaviour), and correctly rated low. The secondary point is the sharper one: because the choice is order-dependent on sorted keys, adding an unrelated alias can rewrite the import line and every binding line in a ui.gen.ts diff. Note the comment's stated rationale ("an earlier module's name is preferred when the same object is re-exported") does hold across sources, since sources are iterated in order — it is only the within-module tiebreak that is arbitrary.

---

## Runtime: signals, patches, dynamic lists

*12 findings — 1 high, 5 medium, 6 low.*

- **high** · [Paint-only vs relayout is decided three times and enforced nowhere](#f-runtime-reactivity-paint-only-still-relayouts)
- **medium** · [Any child-chain change discards and rebuilds the entire Taffy tree](#f-runtime-reactivity-structural-diff-rebuilds-whole-taffy-tree)
- **medium** · [Keyed slot assignment is O(items × capacity): a linear scan per item](#f-runtime-reactivity-keyed-slot-assignment-quadratic)
- **medium** · [subscribe() on a never-read computed is silently a no-op](#f-runtime-reactivity-computed-subscribe-before-read-is-dead)
- **medium** · [A rule needing two conditional classes at once compiles to no patch, no warning](#f-runtime-reactivity-two-toggle-combination-rules-silently-dropped)
- **medium** · [String upload and capacity sizing are O(all slots) per frame; slots never reclaimed](#f-runtime-reactivity-strings-uploaded-o-total-per-frame)
- **low** · [The loop polls at 125 Hz and every tick memcmps the whole shared arena](#f-runtime-reactivity-frame-loop-polls-and-memcmps-everything)
- **low** · [batch() flushes at depth 0: a write inside a subscriber is unbatched and unguarded](#f-runtime-reactivity-batch-flush-reentrancy)
- **low** · [A computed's dependency edges are add-only, so it leaks and over-invalidates](#f-runtime-reactivity-computed-dependency-edges-never-removed)
- **low** · [Cached hovered/pressed/focused ids survive a relink, so input sticks to wrong rows](#f-runtime-reactivity-engine-input-state-not-invalidated-on-relink)
- **low** · [dataOffset is missing from the protocol and the lists table is read by nobody](#f-runtime-reactivity-dataoffset-absent-lists-table-unread)
- **low** · [Tables::grow copies live string bytes into the new staged arena, leaving live zeroed](#f-runtime-reactivity-grow-string-arena-asymmetry)

<a id="f-runtime-reactivity-paint-only-still-relayouts"></a>

### HIGH · Paint-only vs relayout is decided three times and enforced nowhere

`architecture` · `runtime-reactivity/paint-only-still-relayouts`

**Where:** `native-src/dziri-engine/src/engine.rs:273`, `native-src/dziri-engine/src/engine.rs:299`, `native-src/dziri-engine/src/engine.rs:311`, `native-src/dziri-engine/src/tables.rs:542`, `native-src/dziri-engine/src/layout.rs:124`, `src/runtime/patches.ts:48`, `src/window-host.ts:90`

**Claim.** `affectsLayout` is resolved at build time and carried into the patch, but nothing downstream consumes it: the engine's diff drops style *field* identity, `resync` pushes every affected node's style into Taffy (which marks it dirty), and `tick` runs `compute` on `diff.any`. A colour-only theme toggle forces a full relayout and re-measure.

**Evidence.** engine.rs:299-302 promises "a colour-only theme patch touches no geometry, so it reaches paint without Taffy hearing about it at all." The code below does the opposite. tables.rs:542-546 `if span.table as usize == styles { diff.styles = true; self.collect_changed_slots(span, &mut diff.changed_styles); return; }` — `span.field` is in scope and discarded, so the Diff cannot tell `bg` from `padTop`. engine.rs:314-330 `} else if diff.styles && !diff.changed_styles.is_empty() { … for node in affected { self.tree.apply_style(&self.tables, node)?; } }`. layout.rs:126 `self.tree.set_style(self.ids[node], style)`. taffy-0.9 taffy_tree.rs:831 `pub fn set_style(&mut self, node, style) { self.nodes[node.into()].style = style; self.mark_dirty(node)?; }` and mark_dirty clears the cache up the whole ancestor chain. Then engine.rs:273 `if self.fresh || diff.any { self.tree.compute(…) }`. TS side discards it too: patches.ts:48 computes `Dirty.PAINT`, src/window-host.ts:90-93 ignores the return, and `changedNodes` (src/window-host.ts:118) is pushed to and cleared and never read.

**Impact.** `isLight` is `affectsLayout: false` with 77 writes across 47 of the 48 style slots (app/ui.gen.ts:119-124). Toggling it dirties essentially every node, so Taffy re-runs full layout and re-shapes every text node through SkParagraph — the frame the design specifically claims is cheap is the most expensive one in the app. The "32 writes instead of 1215" win (variant-compile.ts:14) buys nothing, because the 32 writes still cost a 1215-node relayout.

**Recommendation.** Carry the bit that already exists in `STYLE_FIELDS[i][3]` across the boundary: add `affectsLayout` to `Field` in src/protocol/schema.ts, emit `pub const AFFECTS_LAYOUT: [bool; FIELD_COUNT]` from gen-protocol.ts into protocol.rs, then split the styles case in `classify` into `diff.layout_styles` / `diff.paint_styles` with separate changed-slot vectors. `resync` calls `apply_style` only for layout-affecting slots; paint-only just sets `needs_paint = true`. Gate engine.rs:273 on `diff.structure || diff.node_styles || diff.text || diff.layout_styles`. Then either delete `Dirty`/`changedNodes` or make `upload()` use them.

**Verifier — confirmed.** Two numbers are off but do not change the verdict: the union of isLight's touched slots is 42 of 48, not 47 (bg 18 + fg 40 + borderColor 19 = 77 writes; slots 5, 13, 17, 42, 43, 44 are untouched), and the "32 writes" / "1215 nodes" figures are variant-compile.ts's benchmark-page numbers, not this app's (126 nodes, 77 writes).

<a id="f-runtime-reactivity-structural-diff-rebuilds-whole-taffy-tree"></a>

### MEDIUM · Any child-chain change discards and rebuilds the entire Taffy tree

`architecture` · `runtime-reactivity/structural-diff-rebuilds-whole-taffy-tree`

**Where:** `native-src/dziri-engine/src/engine.rs:304`, `native-src/dziri-engine/src/layout.rs:62`, `native-src/dziri-engine/src/tables.rs:529`, `src/runtime/list-runtime.ts:290`

**Claim.** `diff.structure` is span-granular — it says "some firstChild/nextSibling byte changed" and nothing more — so every list append, delete or reorder allocates a brand-new `TaffyTree` with one leaf per node, re-`set_children` for every node, and re-pushes every style, turning an O(1) relink into O(all nodes).

**Evidence.** tables.rs:531 `n::KIND | n::PARENT | n::FIRST_CHILD | n::NEXT_SIBLING | n::LIST => diff.structure = true` — no index collection, though `collect_changed_slots` (tables.rs:566) is generic and already used for styles and strings. engine.rs:304-309 `if self.fresh || diff.structure || … { self.tree.rebuild(&self.tables, self.root)?; self.tree.apply_all_styles(&self.tables)?; }`. layout.rs:66-78 `self.tree = TaffyTree::with_capacity(count); … for i in 0..count { … new_leaf_with_context(Style::default(), i as u32) … }` where `count = tables.capacities().nodes` — capacity, i.e. `ceil(count * 1.5) + 16` (upload.ts:106), not the live count. Meanwhile list-runtime.ts:290 is careful: "Chain the live slots in data order. Nodes do not move; only links change."

**Impact.** The list runtime's central claim — "a reorder is a permutation of the child chain plus a slot-value rewrite, never a node move" (list-runtime.ts:6-8) — is true on the Bun side and completely undone on the Rust side. Adding one todo to a 2000-row list (12000 nodes, ~18000 with headroom) allocates 18000 taffy leaves, calls `set_children` 18000 times and `set_style` 18000 times, and relayouts everything. This is exactly the scaling wall the arena design exists to avoid.

**Recommendation.** Report which parents changed: in `classify`, run `collect_changed_slots` for FIRST_CHILD/NEXT_SIBLING into `changed_links: Vec<u32>` and keep `diff.structure` for KIND/PARENT/LIST only. Add `LayoutTree::relink_nodes(&Tables, &[u32])` that re-runs `set_children` for the parents of the changed indices (a nextSibling change at i affects `parent[i]`) and leaves the tree, ids and cached measurements alive. Reserve full `rebuild` for a generation bump.

**Verifier — weakened.** Accurate statement: `classify` collapses all five structural node fields into one boolean, so any child-chain write forces `LayoutTree::rebuild` — a fresh TaffyTree with one leaf per *capacity* slot, plus `set_children` and `set_style` for every slot. This is O(capacity) per list mutation where the Bun-side relink is O(changed links), and the recommended fix (a `changed_links` vector + a `relink_nodes` that re-runs `set_children` only for affected parents) is right. But it violates no documented invariant, and the impact is medium, not high: at the current 126-node app it is negligible, and the cited 12000-node case is already outside the ~1000-live-node ceiling NOTES.md:365-366 sets for unvirtualized lists.

<a id="f-runtime-reactivity-keyed-slot-assignment-quadratic"></a>

### MEDIUM · Keyed slot assignment is O(items × capacity): a linear scan per item

`performance` · `runtime-reactivity/keyed-slot-assignment-quadratic`

**Where:** `src/runtime/list-runtime.ts:233`, `src/runtime/list-runtime.ts:246`

**Claim.** For every data item the reconciler scans the whole slot-key array looking for its key, so one list update is quadratic in list length.

**Evidence.** ```
for (let i = 0; i < items.length; i++) {
  const key = readPath(items[i], ref.keyPath);
  for (let s = 0; s < capacity; s++) {
    if (!taken[s] && keys[s] !== undefined && Object.is(keys[s], key)) {
```
`capacity >= items.length` always (list-runtime.ts:215 grows otherwise), so this is Θ(n²), with a `readPath` walk (item-path.ts:64) per outer iteration — and `readPath(items[i], ref.keyPath)` is computed a second time at line 267.

**Impact.** `view` is a computed that rebuilds its array on every todo toggle (app/state.ts:32-37), so every checkbox click re-runs this. At 2000 rows that is 4M `Object.is` comparisons per click; at the 100k rows the ROADMAP contemplates it is 10^10 comparisons and the update never returns. The doc comment sells this loop as the cheap part ("Nothing is allocated, no id is invalidated"), which hides that it is the asymptotically dominant part of a list update.

**Recommendation.** Build the inverse index once per update: `const bySlot = new Map(); for (let s=0;s<capacity;s++) if (keys[s] !== EMPTY) bySlot.set(keys[s], s);` then one `bySlot.get(key)` per item, deleting on claim so duplicate keys still fall through to the free-slot scan. O(items + capacity), one reused Map, ~15 lines. Hoist the duplicated `readPath` into the same pass. While there, replace `undefined` as the empty-slot sentinel with a module-private `Symbol` or a separate occupancy `Uint8Array` — today an item whose key path resolves to `undefined` makes its slot read as free on the next update, so its identity (and focus) churns every frame.

**Verifier — weakened.** Accurate statement: the keyed match is Θ(n²) in list length with a duplicated `readPath` per item, and the `undefined` empty-slot sentinel makes a row with an undefined key lose its slot identity every update. The recommended inverse-index fix is correct and cheap. Severity is medium, not high: nothing in the current app or at the project's documented ~1000-live-row ceiling makes this the dominant cost, and the 10^10-comparison scenario requires 100k unvirtualized live rows, which the architecture already rules out.

<a id="f-runtime-reactivity-computed-subscribe-before-read-is-dead"></a>

### MEDIUM · subscribe() on a never-read computed is silently a no-op

`correctness` · `runtime-reactivity/computed-subscribe-before-read-is-dead`

**Where:** `src/runtime/signal.ts:146`, `src/runtime/signal.ts:162`, `src/window-host.ts:121`

**Claim.** A `computed` registers its invalidator with its sources only inside the `.value` getter, so `subscribe()` on a computed that has never been read attaches a callback to a node nothing will ever invalidate.

**Evidence.** signal.ts:148-161 `get value() { if (stale) { … listener = invalidate; cached = compute(); … } if (listener) subs.add(listener); … }` — `invalidate` reaches `source.subs` only by `compute()` actually running. signal.ts:162-165 `subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }` never touches `.value`. The app works only because of an undocumented ordering: src/window-host.ts:121-123 (`applyTextBindings`, `updateLists`, `applyStylePatches`, all of which read `.value`) runs before src/window-host.ts:80-93 (`subscribeBindings`, `subscribeLists`, `subscribeStylePatches`).

**Impact.** Silent dead reactivity with no error: the first frame renders correctly and the UI simply never updates again. Any future entry point that subscribes before the first apply — a hot-reload path, a test harness, or the engine-owned frame loop of A0 step 3 that subscribes at setup and applies on first tick — breaks invisibly. It also applies to a `stylePatch` whose signal is a computed, which the type permits (`ReadonlySignal<boolean>`, patches.ts:24).

**Recommendation.** Make `subscribe` on a computed self-priming — `subscribe(fn) { void self.value; subs.add(fn); return () => subs.delete(fn); }`. One line, and it removes the ordering dependency entirely; preact/signals gets this free because `subscribe` starts an effect that reads the value.

**Verifier — confirmed.** I tried to find a priming path and there is none. In `computed` (signal.ts:132-173), `invalidate` reaches a source's `subs` set only via `listener = invalidate; cached = compute()` inside the `.value` getter (:150-157) — that is the sole assignment to the module-level `listener` for a computed. `subscribe` (:162-165) is `subs.add(fn); return () => subs.delete(fn)` and never touches `.value`, so on a never-read computed the subscriber joins a set that nothing can ever notify: the source has no edge to `invalidate`, and even if it did, `invalidate` opens with `if (stale) return` and a never-read computed is born `stale = true`. The app's correctness genuinely rests on an undocumented ordering — src/window-host.ts:121-123 (applyTextBindings / updateLists / applyStylePatches, all of which read `.value`) runs before src/window-host.ts:80-93 (subscribeBindings / subscribeLists / subscribeStylePatches). The exposure is not hypothetical either: `ListBindingRef.signal` is `ReadonlySignal<unknown[]>` and app/state.ts:32 makes `view` a computed, so the list path is already computed-backed; `StylePatchRef.signal` is `ReadonlySignal<boolean>` (patches.ts:24), so a computed-driven toggle is type-legal too. Failure mode is silent — first frame correct, then frozen — which is the class of bug this project's generated-protocol and compile-time-first discipline exists to eliminate, and the fix is the one line proposed (`void self.value` in `subscribe`). Severity medium is right: no live defect, but a silent trap in the reactivity core guarded only by statement order in one file.

<a id="f-runtime-reactivity-two-toggle-combination-rules-silently-dropped"></a>

### MEDIUM · A rule needing two conditional classes at once compiles to no patch, no warning

`correctness` · `runtime-reactivity/two-toggle-combination-rules-silently-dropped`

**Where:** `src/compiler/variant-compile.ts:182`, `src/compiler/variant-compile.ts:283`, `src/compiler/css.ts:110`

**Claim.** Variants are compiled one toggle at a time (k+1 compiles, never combinations) and the conflict detector only looks for the same (field, slot) written by two patches — so a compound selector that matches only when both classes are present contributes to no variant and collides with nothing.

**Evidence.** variant-compile.ts:182-194 `const variants: CompileResult[] = [baseline]; for (const toggle of toggles) { … applyToggle(tree, toggle); … variants.push(result); }` — variant i+1 carries toggle i's classes and no others; patches are `changedFields(slotStyles[slot][0], slotStyles[slot][i+1])` (lines 256-267). Detection is pairwise overlap only: line 285 `for (const s of e.slots) keys.add(`${e.field}#${s}`)`. Compound class selectors parse fine — css.ts:117-129 does `compound.classes.push(token.slice(1))` per `.name` in one compound — so `.light.compact { color: red }` matches nothing in variant 1 or variant 2, produces no `fg` entry in either patch, and raises no warning.

**Impact.** The module doc claims the opposite: "Two toggles conflict only if they write the same *field* of the same *slot*… it is detected and reported rather than silently producing the wrong cascade" (variant-compile.ts:16-19). The AND case is a third failure mode the model cannot see — the author writes a valid rule, the compiler accepts it, and the pixels never show it. Detected conflicts are also only `console.warn` (src/compile.ts:82), never fatal, so even the caught case ships.

**Recommendation.** Detect it in the compiler rather than compiling 2^k combinations: after parsing, reject any rule whose compound `classes` contains two or more class names owned by *different* toggles — `findToggles` already builds the source→className map, so this is a set intersection over `Rule.compounds[].classes` — and fail the build quoting the selector. Separately make a non-empty `variants.warnings` exit non-zero in src/compile.ts.

**Verifier — confirmed.** I attacked this from the parser end and it holds all the way through. css.ts:117-129 builds one `Compound` per whitespace-separated part and pushes *every* `.name` token into `compound.classes`, so `.light.compact` parses cleanly into a single compound with two classes. src/compiler/compile.ts:42-49 `matchCompound` then ANDs them: `for (const cls of c.classes) { if (!el.classes.includes(cls)) return false; }`. variant-compile.ts:182-194 compiles `[baseline, ...one variant per toggle]`, and `applyToggle` (:116-132) adds only the classes belonging to that one toggle, so no compile ever has two toggles' classes on the same element — the compound rule matches in none of the k+1 compiles. Patches are `changedFields(slotStyles[slot][0], slotStyles[slot][i+1])` (:255-268), so the declaration contributes to no `FieldPatch`, and detection at :283-300 only intersects `${field}#${slot}` keys across patches, which for a rule that produced no entries is the empty set — no warning. The module doc at variant-compile.ts:16-19 claims conflicts are "detected and reported rather than silently producing the wrong cascade", which is precisely the guarantee that fails here. And src/compile.ts:82 is `for (const w of variants.warnings) console.warn(...)` with no non-zero exit, so even detected conflicts ship. Silent wrong pixels from a valid, accepted stylesheet, in the compiler that is the project's whole thesis: medium is right, and the proposed compile-time rejection (intersect `Rule.compounds[].classes` against `findToggles`' source→className map) is the cheap correct fix.

<a id="f-runtime-reactivity-strings-uploaded-o-total-per-frame"></a>

### MEDIUM · String upload and capacity sizing are O(all slots) per frame; slots never reclaimed

`performance` · `runtime-reactivity/strings-uploaded-o-total-per-frame`

**Where:** `src/engine/upload.ts:269`, `src/engine/upload.ts:101`, `src/runtime/list-runtime.ts:146`, `src/window-host.ts:181`

**Claim.** The one upload documented as "must not be O(all strings)" walks every slot twice per frame, `ensureCapacity()` walks them a third time, and the slots orphaned by each arena regrowth are never freed.

**Evidence.** upload.ts:275-278 `for (let i = 0; i < strings.length; i++) { if (force || this.#uploaded[i] !== strings[i]) needed += strings[i]!.length * 3; }` then upload.ts:285 loops every slot again. `capacitiesFor` runs every frame via `ensureCapacity()` (src/window-host.ts:181) and opens with upload.ts:102 `for (const s of ui.strings) bytes += s.length * 3;`. Orphans: list-runtime.ts:146-150 `for (const binding of ref.bindings) { ui.strings.push(""); … }` mints `capacity * bindings.length` new slots per growth while the previous arena's slots stay in `ui.strings` forever (`ref.slotStart` just moves past them). The doc at upload.ts:266-268 claims "Dynamic text mints a new string on every keystroke, so this is the one upload that must not be O(all strings)."

**Impact.** Three full passes over the string table per frame at 125 Hz, plus one `dziri_engine_grow` FFI call per frame that returns false. A 100k-row list with 2 bindings is ~200k live slots plus ~200k orphans from the doubling history: ~600k string comparisons and a `.length` sum over 400k strings every frame, to discover that one draft slot changed.

**Recommendation.** Have the writers report: `applyTextBindings` (bindings.ts:35) and `updateList` (list-runtime.ts:280) already know the exact slot indices they mutated — push them onto a shared `dirtySlots` array that `uploadStrings` consumes and clears, making the steady state O(changed). Maintain `capacitiesFor`'s byte total incrementally at the same sites instead of recomputing, and call `engine.grow` only when `ui.nodes.count`/`ui.strings.length` actually changed — both change only in `growArena`.

**Verifier — weakened.** Accurate statement: on every frame that a signal changed (not every frame — `upload()` is gated on `dirty` at src/window-host.ts:240), the string path makes three O(all slots) passes plus an O(all string characters) byte sum, and issues a no-op `grow` FFI round trip; slots orphaned by arena growth are never reclaimed, settling at ~2x live slots. The recommendation (writer-reported dirty slots, incrementally maintained byte total, call `grow` only when counts actually changed) is right. Idle frames cost nothing here, so the 125 Hz framing is wrong; severity medium on the strength of the per-keystroke cost at long-list scale.

<a id="f-runtime-reactivity-frame-loop-polls-and-memcmps-everything"></a>

### LOW · The loop polls at 125 Hz and every tick memcmps the whole shared arena

`performance` · `runtime-reactivity/frame-loop-polls-and-memcmps-everything`

**Where:** `src/window-host.ts:239`, `src/window-host.ts:288`, `native-src/dziri-engine/src/tables.rs:498`, `src/engine/host.ts:329`, `src/engine/host.ts:318`

**Claim.** `commit()` is the engine's only change detection and it is O(total shared bytes) per tick; the host ticks unconditionally every 8 ms even when its own `dirty` flag is false, and drains events exactly once per frame with no re-drain when the buffer fills.

**Evidence.** src/window-host.ts:239-287 `while (running) { if (dirty) { upload(); dirty = false; } engine.tick(); … for (const event of engine.drainEvents()) {…} await Bun.sleep(8); }` — one `drainEvents()` (default `max = 32`, host.ts:329) per iteration; the "call again while written equals capacity" loop is *not* written. tables.rs:503-519 iterates every span and `if self.staged.as_slice()[range.clone()] == self.live.as_slice()[range.clone()] { continue; }` regardless of whether Bun wrote anything. src/window-host.ts:285-286 concedes only half: "an idle frame costs an event-queue drain." It also costs a whole-arena memcmp, two FFI round-trips (tick + generation, host.ts:318-327) and a fresh `ArrayBuffer(32*56)` plus `BigUint64Array(1)` per frame.

**Impact.** Idle CPU is proportional to total table size, not to change. At 12000 nodes that is ~550 KB compared 125×/sec; at 600k nodes (a 100k-row list) it is ~14 MB per tick, ~1.7 GB/s of pure memcmp — which erases the "a style patch is a plain typed-array write with zero FFI cost" economy the shared-memory design exists for. Events are not dropped (`self.events` is an unbounded `Vec<Event>`, engine.rs:112) but there is no backpressure and `pending_events()` is unused by the host, so a burst adds unbounded input latency instead.

**Recommendation.** Let Bun say what it wrote: add a per-span (or per-table) `u32` epoch region to schema.ts that each `uploadX()` bumps, and have `commit` skip spans whose epoch is unchanged — `upload()` (src/window-host.ts:178-192) already calls the tables by name. Gate the commit on `dirty` as well. For events, `let evts; do { evts = engine.drainEvents(64); … } while (evts.length === 64);`.

**Verifier — weakened.** Accurate statement: two small pieces are genuinely loose — `drainEvents` has no re-drain-while-full loop despite a fixed 32-event window, and the engine already exposes `has_staged_changes()` and `pending_events()` which the host never calls. Everything else (unconditional tick at 125 Hz, whole-arena memcmp per tick, per-frame scratch allocations) is either the documented A0 step 3 deferral (ROADMAP.md:53-70, src/window-host.ts:285-286, engine.rs:11-17) or the documented purpose of the staged/live split, and is negligible at the current arena size. Severity low.

<a id="f-runtime-reactivity-batch-flush-reentrancy"></a>

### LOW · batch() flushes at depth 0: a write inside a subscriber is unbatched and unguarded

`soundness` · `runtime-reactivity/batch-flush-reentrancy`

**Where:** `src/runtime/signal.ts:176`, `src/runtime/signal.ts:66`

**Claim.** `depth` is decremented *before* the pending queue is drained, so a subscriber that writes a signal re-enters `notify` at depth 0 and runs subscribers synchronously and recursively, with no cycle detection and no iteration cap.

**Evidence.** ```
export function batch<T>(fn: () => T): T {
  depth++;
  try { return fn(); }
  finally {
    depth--;
    if (depth === 0) {
      const queued = [...pending];
      pending.clear();
      for (const s of queued) s();   // depth === 0 here
    }
  }
}
```
with notify (line 71) `} else if (depth > 0) { pending.add(s); } else { s(); }`.

**Impact.** Two effects that write each other's inputs recurse to `RangeError: Maximum call stack size exceeded`, thrown from `dispatch()` inside the frame loop (src/window-host.ts:262) with no handler — the window dies on a click. Less dramatically, `batch`'s documented guarantee ("one user action should cost one repaint", bindings.ts:115-119) does not hold for cascaded writes. Relatedly, glitches *do* occur on an unbatched multi-signal write (writing `todos` runs the binding effect once per dependent computed, and the first run reads a still-fresh stale sibling computed) — they are unobservable today only because the sole effect is idempotent and the sole observer is the next frame, which is a property of this app, not of the primitive. None of this is tested: `src/engine/upload.test.ts` is the only TS test in the repo, so signal.ts, patches.ts, bindings.ts and list-runtime.ts have zero coverage — the simple design is not proven correct by shallowness, it is unproven.

**Recommendation.** Drain inside the batch, as preact/signals' `endBatch` does: `finally { if (depth === 1) { let rounds = 0; while (pending.size) { const q = [...pending]; pending.clear(); for (const s of q) s(); if (++rounds > 100) throw new Error("signal cycle detected"); } } depth--; }`. Add a signal test file covering diamond dependencies, a reentrant write, a cycle, and an unbatched two-signal write.

**Verifier — weakened.** Accurate statement: `batch` drains at depth 0 rather than depth 1, so a signal written from inside a subscriber is unbatched and recursion is unbounded — worth the ~5-line fix and a test file. But no code path in the repo writes a signal from a subscriber (the only subscribers are src/window-host.ts:80-93, which set a flag), and the compile-time-first design does not expose `subscribe` as an authoring primitive, so 'the window dies on a click' cannot happen as described. Severity low (latent robustness), not medium soundness.

<a id="f-runtime-reactivity-computed-dependency-edges-never-removed"></a>

### LOW · A computed's dependency edges are add-only, so it leaks and over-invalidates

`soundness` · `runtime-reactivity/computed-dependency-edges-never-removed`

**Where:** `src/runtime/signal.ts:86`, `src/runtime/signal.ts:159`

**Claim.** `subs.add(listener)` is the only edge operation and there is no back-pointer from a computed to the subscriber sets it joined, so an edge can never be pruned — not when a conditional dependency stops being read, and not when the computed becomes garbage.

**Evidence.** signal.ts:85-88 `get value(): T { if (listener) subs.add(listener); return readValue(self, current); }` and the identical line at signal.ts:159. The only removal anywhere is the closure returned by the public `subscribe` (`() => subs.delete(fn)`), which a computed's own `invalidate` never goes through.

**Impact.** Two consequences. (1) `computed(() => flag.value ? a.value : b.value)` keeps `b`'s edge after `flag` flips, so every later write to `b` invalidates and recomputes it forever — correct results, unbounded wasted work as the graph ages. (2) Any dynamically created computed is retained for the process lifetime by every signal it ever read, along with its closure and cached value. Today every computed is module-level (app/state.ts:32-40) so nothing leaks, but the design has no way to *stop* leaking, which forecloses per-row derived values — the obvious next step given item templates cannot contain conditionals (app/state.ts:26-31 explains that per-row conditionals must become data, i.e. must be derived somewhere).

**Recommendation.** Track edges bidirectionally as Solid (`sources`/`sourceSlots`) and preact (`_sources`/`_targets`) do: give each computed a `sources: Set<Set<Subscriber>>` populated during compute and cleared before each recompute (`for (const s of sources) s.delete(invalidate); sources.clear();`). ~8 lines and the graph becomes prunable. If dynamic computeds are deliberately out of scope, say so in the module doc and make `computed` throw when called after `setCompiling(false)` — the compile-time-first principle would justify that.

**Verifier — weakened.** Accurate statement: a computed's dependency edges are add-only, so a conditional dependency's edge is never pruned. Today no computed in the codebase has a conditional dependency and all are module-level, and dynamically created computeds are effectively excluded by the compile-time reference-resolution design (signal.ts:1-13, app/state.ts:1-8), so neither the over-invalidation nor the retention manifests. This is a documentation/guard-rail gap (say the constraint in the module doc, or reject `computed` after `setCompiling(false)`) rather than a medium soundness bug. Severity low.

<a id="f-runtime-reactivity-engine-input-state-not-invalidated-on-relink"></a>

### LOW · Cached hovered/pressed/focused ids survive a relink, so input sticks to wrong rows

`correctness` · `runtime-reactivity/engine-input-state-not-invalidated-on-relink`

**Where:** `native-src/dziri-engine/src/engine.rs:414`, `native-src/dziri-engine/src/engine.rs:303`, `src/runtime/list-runtime.ts:196`

**Claim.** `InputState` holds raw node ids and is recomputed only on a mouse event; nothing in `commit`/`resync` re-resolves it when the tree that gave those ids meaning changes underneath.

**Evidence.** engine.rs:414-428 updates `self.state.hovered` only inside `RawInput::MouseMotion`; `resync` (engine.rs:303-351) rebuilds, restyles and re-measures but never touches `self.state`. On the Bun side a slot's node id is *reused*: list-runtime.ts:246-251 hands a freed slot to whatever item needs one, and list-runtime.ts:193-198 `lists.arenaStart[ref.list] = newStart; … slotKeys.delete(ref);` moves every row to brand-new ids on growth ("Slot identity is meaningless in a new arena").

**Impact.** Delete the row under the cursor and the rows below slide up, but `state.hovered` still names the deleted row's node — now either off the child chain (nothing highlighted) or handed to a different todo (the wrong row lights up with the cursor nowhere near it). The painter reads `&self.state` directly, so these are visible, reproducible pixels. Growth is worse: appending the 9th todo to the capacity-8 arena repoints the list at a new arena, so `state.focused` — the exact thing keys exist to protect (list-runtime.ts:10-13) — points into the dead arena and the text field loses focus mid-typing.

**Recommendation.** Re-resolve after layout instead of on input: at the end of `tick`, when the diff was structural, `self.state.hovered = hit_test(&self.tables, self.tree.bounds(), last_x, last_y)` (store the last cursor position `pump_input` already sees), and clear `pressed`/`focused` when the id is no longer reachable from the root. For growth, have `growArena` return the old→new node-id delta (it is exactly `newStart - oldStart` per slot index) and remap focus through `setInputState`. Also process a drained event batch against the slot mapping it was hit-tested against: today two clicks in one drain resolve their second (slot, offset) against the `slotData` the *first* click's handler already rewrote (list-runtime.ts:347), so a fast double-click on delete removes the wrong todo.

**Verifier — weakened.** Accurate statement: `InputState` holds raw node ids and is refreshed only on mouse motion, so after a structural list change the hover/press/focus styles can be stale — most visibly when a freed slot is later reclaimed by a new item and paints a hover or focus ring with the cursor elsewhere. Re-resolving hovered at the end of a structural tick is the right fix. The growth scenario is not reachable (the editable is node 32, outside the arena at 38, and node ids below `arenaStart` survive `growArena` and `Tables::grow` unchanged), and the double-click scenario needs two CLICK events inside one 8 ms drain. Severity low (cosmetic, self-correcting on the next mouse move).

<a id="f-runtime-reactivity-dataoffset-absent-lists-table-unread"></a>

### LOW · dataOffset is missing from the protocol and the lists table is read by nobody

`architecture` · `runtime-reactivity/dataoffset-absent-lists-table-unread`

**Where:** `src/ir.ts:305`, `src/protocol/schema.ts:156`, `src/engine/upload.ts:249`, `native-src/dziri-engine/src/tables.rs:525`

**Claim.** The arena shape does admit O(visible) virtualization, but none of the three required pieces exists: the field is absent from the shared schema, the reconciler is O(all items) not O(visible), and the engine never reads the list table at all.

**Evidence.** ir.ts:317-321 claims "`dataOffset` makes virtualization the same mechanism rather than a second one: cap `capacity` at the visible count and scrolling is an integer write, since slots are recomputed from `items[dataOffset + i]`" and ir.ts:322 declares the field. schema.ts:160-166 lists only `node, arenaStart, stride, capacity, active`; `grep -rn dataOffset src/protocol/generated.ts native-src/dziri-engine/src/*.rs` returns nothing, and `uploadLists` (upload.ts:249-258) does not upload it. `updateList` never reads it and always iterates all of `items` (lines 233, 265, 295). `grep -rn 'Table::Lists|lists::' native-src/dziri-engine/src/` matches only protocol.rs metadata — layout.rs and paint.rs traverse `firstChild`/`nextSibling` exclusively. `classify` (tables.rs:525-562) has no Lists branch, so a list-table-only change sets `diff.any = true` with no category and buys a full `compute()` for nothing.

**Impact.** The ROADMAP promise is not one integer write away: it needs the protocol field, an `items[dataOffset + i]` rewrite of a reconciler whose matching loop is over all items, engine-side clipping (`overflow` is in the schema at schema.ts:138 and unimplemented) and a scroll event. Meanwhile five spans are copied and memcmp'd every frame for no consumer, and the missing `classify` case is a live trap: the moment the engine does read `lists.active`, `resync` will not be told it changed.

**Recommendation.** Either implement it — add `dataOffset` to schema.ts LISTS, regenerate, add a `classify` case splitting Lists into structural (arenaStart/stride/capacity) vs window (active/dataOffset), and have `updateList` match only over `items.slice(dataOffset, dataOffset + capacity)` — or delete `dataOffset` from ir.ts, drop `uploadLists` from the per-frame path, and downgrade the ir.ts comment to a stated plan. A field present in one of the two IRs and a promise in a doc comment is exactly the drift the generated-protocol design exists to prevent.

**Verifier — weakened.** Accurate statement: `dataOffset` exists in src/ir.ts (declared at :321, sold at :305-307) and in the emitted module, but not in schema.ts, generated.ts, the Rust protocol or `uploadLists`, and no reconciler or engine code reads it — so ROADMAP.md:366's "existing dataOffset virtualization" describes something that does not exist. The engine also never reads the lists table at all, and `classify` has no Lists branch. This is documentation/IR drift plus a latent trap, worth fixing by deleting the field or wiring it, but the concrete runtime cost is 20 bytes of memcmp and the unreachable classify gap — and the virtualization work itself is scheduled A4, not a gap. Severity low.

<a id="f-runtime-reactivity-grow-string-arena-asymmetry"></a>

### LOW · Tables::grow copies live string bytes into the new staged arena, leaving live zeroed

`soundness` · `runtime-reactivity/grow-string-arena-asymmetry`

**Where:** `native-src/dziri-engine/src/tables.rs:731`, `native-src/dziri-engine/src/tables.rs:716`

**Claim.** Every table span is copied staged→staged and live→live, but the string byte region is copied live→staged only, so growth discards whatever Bun had staged and starts the new live arena empty.

**Evidence.** tables.rs:716-729 copies both arenas per span: `grown.staged_mut(t, f)[..dst_len].copy_from_slice(&self.staged_bytes(t, f)[..dst_len]); let live = self.live_bytes(t, f)[..dst_len].to_vec(); … grown.live.as_mut_slice()[range].copy_from_slice(&live);`. Then tables.rs:731-733 `let string_bytes = self.string_bytes().to_vec();` — and `string_bytes()` (tables.rs:449-456) reads `Self::bytes(&self.live, span)` — `grown.staged_string_bytes_mut()[..n].copy_from_slice(&string_bytes[..n]);`. Nothing writes `grown`'s live string region.

**Impact.** Latent rather than live: the host's discipline masks it (host.ts:394-422 grow → generation bump → src/window-host.ts:181-184 `uploadAll()` → `uploadStrings(true)` → `#repack()` rewrites every slot). But the invariant the three-arena split rests on — live is what the engine is rendering — is violated for one region across a grow, the next `commit` reports a spurious whole-table `diff.text` and re-measures the entire tree, and any tick between grow and a full re-upload paints empty text.

**Recommendation.** Mirror the table path: copy `self.staged` string bytes into `grown.staged` and `self.live` string bytes into `grown.live` — simplest by handling REGION spans inside the existing `for span in &self.plan` loop (drop the `span.table < 0` filter and use the region's byte length) rather than as a special case afterwards. Add a `grow_preserves_strings` case to the tables.rs test module, which today covers only node-table preservation (tables.rs:843-861).

**Verifier — confirmed.** Verified line by line, including the asymmetry the title names. tables.rs:716-729 copies both arenas for every table span — `grown.staged_mut(t, f)[..dst_len].copy_from_slice(&self.staged_bytes(t, f)[..dst_len])` and then a live→live copy through a temporary — but the loop skips the string region via `if span.home != Home::Shared || span.table < 0 { continue }`, and REGION is `-1` (tables.rs:39). The special case at :731-733 reads `self.string_bytes()`, which is `Self::bytes(&self.live, span)` (:449-456), and writes it into `grown.staged_string_bytes_mut()` (:458-466, `&mut self.staged...`). Nothing anywhere writes `grown`'s live string region, and `Arena::new` zeroes (:116) while `prefill_links` (:221-238) touches only node link fields — so post-grow live string bytes are all zero and staged holds the *old live* bytes, discarding whatever Bun had staged. The consequences are as the finding states and no worse: the slot table was copied live→live, so live offsets point into zeros and `string()` returns "" (:473-491) rather than garbage, and there is no tick between grow and re-upload because `upload()` runs `ensureCapacity()` → `uploadAll()` → `uploadStrings(true)` → `#repack()` synchronously before `engine.tick()` (src/window-host.ts:181-184, 190; upload.ts:280-281). The next commit does see a whole-region difference and sets `diff.text` for everything, though `grow` also sets `fresh = true` (engine.rs:518) so a rebuild was happening regardless. The test-coverage claim is right too: tables.rs:842-861 asserts only node-table STYLE preservation and layout span length. Severity low, self-described as latent, is exactly right.

---

## Engine: layout (Taffy) & table management

*12 findings — 1 high, 8 medium, 3 low.*

- **high** · [A parent/child cycle through the root stack-overflows Taffy — an abort, not a panic](#f-engine-layout-parent-child-cycle-stack-overflow)
- **medium** · [The engine relayouts on paint-only patches: LAYOUT_FIELDS never crosses the boundary](#f-engine-layout-paint-only-patch-forces-relayout)
- **medium** · [Any structural change rebuilds the whole Taffy tree and discards the measure cache](#f-engine-layout-structural-change-rebuilds-whole-tree)
- **medium** · [Hover/focus/active styles never reach layout, but paint reads padding from them](#f-engine-layout-interaction-styles-bypass-layout)
- **medium** · [The engine's UNSET fix is defeated by INITIAL_STYLE setting align/justify to 0](#f-engine-layout-initial-style-defeats-unset)
- **medium** · [The LIST transparent-wrapper workaround breaks grid placement entirely](#f-engine-layout-list-wrapper-breaks-grid)
- **medium** · [Unclamped grid geometry from host memory: 1.3 s frames and a Taffy overflow panic](#f-engine-layout-unclamped-grid-inputs-reach-taffy)
- **medium** · [native-src/taffy-ffi is dead code and a diverged second copy of the conversion](#f-engine-layout-taffy-ffi-dead-divergent-copy)
- **medium** · [bounds.rs tests flex only: grid, absolute, dirty paths and hostile inputs untested](#f-engine-layout-layout-test-coverage-gaps)
- **low** · [Repointing `nodes.text` at an unchanged slot skips mark_dirty, leaving a stale size](#f-engine-layout-text-repoint-misses-mark-dirty)
- **low** · [A `hidden` toggle re-pushes every node's style, dirtying the whole tree](#f-engine-layout-hidden-toggle-restyles-every-node)
- **low** · [`Tables::grow` does not carry the live string arena or the bounds arena across](#f-engine-layout-grow-leaves-live-string-and-bounds-arenas-stale)

<a id="f-engine-layout-parent-child-cycle-stack-overflow"></a>

### HIGH · A parent/child cycle through the root stack-overflows Taffy — an abort, not a panic

`soundness` · `engine-layout/parent-child-cycle-stack-overflow`

**Where:** `native-src/dziri-engine/src/layout.rs:88`, `native-src/dziri-engine/src/layout.rs:94`, `native-src/dziri-engine/src/layout.rs:201`, `native-src/dziri-engine/tests/bounds.rs:334`

**Claim.** `relink`'s budget only detects cycles in the `nextSibling` chain; a cycle in the *parent/child* direction (`firstChild[root] = root`) passes relink untouched and then recurses forever inside `compute_layout`, overflowing the render thread's stack — which `catch_unwind` cannot contain.

**Evidence.** layout.rs:96-113 walks only siblings: `let mut c = first.get(i)...; while c >= 0 { ...; children.push(self.ids[ci]); c = next.get(ci)... }` with `budget = count.saturating_mul(2) + 16`. With `firstChild[0] = 0` and `nextSibling[0] = -1` the chain has length 1, so the budget is never touched. I built a 4-node harness mirroring `rebuild` + `relink` exactly against taffy 0.9.2: relink succeeded (`children[0] = [NodeId(4294967297)]`) and then `compute_layout_with_measure` died with `thread 'main' has overflowed its stack / exit code 0xc00000fd (STATUS_STACK_OVERFLOW)`. The cycle survives specifically when it passes through the root, because taffy's `set_children` (taffy_tree.rs:702-726) detaches a child from its *previous* parent and the root has none. `read_back`'s budget (layout.rs:257) would catch it, but `read_back` runs after `compute`.

**Impact.** One wrong integer in a host typed-array write — `nodes.firstChild[root] = root`, or `firstChild[1] = 0` on the normal root/first-child pair, both reachable from the list relink path — kills the Bun process with no diagnostic. This defeats the documented threat model ("Bun owns those chains and can write anything into them, so the walk is budgeted: a cycle would otherwise hang the render thread with no way for the host to find out") and the Cargo.toml promise that `panic = "unwind"` exists so "a bad grid definition" is not "a segfault Bun cannot report". A stack overflow is not an unwind.

**Recommendation.** Replace both ad-hoc budgets with one real acyclicity check. After building the children lists in `relink`, do a single DFS from `self.root` with a `visited: Vec<bool>` sized `count`: any node reached twice, or reached while on the current path, is an `Err` before `compute_layout` is ever called. That is O(n), subsumes the sibling-cycle budget, makes `read_back`'s budget unnecessary, and lets `read_back`/`paint`/`hit_test` share one validated traversal instead of three independent budgeted walks (paint.rs:123, paint.rs:252 — note paint.rs:252 also hardcodes `vec![0usize]` as the root while the engine takes `root` from `EngineConfig`).

**Verifier — weakened.** A cycle through the parent/child direction (e.g. firstChild[root]=root) passes relink's sibling-only budget and stack-overflows taffy inside compute_layout — reproduced against taffy 0.9.2 — which catch_unwind cannot contain, so it breaks ROADMAP.md:85-88's "never a hang or a crash" invariant. It is not reachable from the list relink path (updateList only ever links arena roots, which are always numbered above the LIST node); it requires a compiler bug or a stray write, so severity is high rather than critical. The recommended one-pass DFS-from-root acyclicity check is correct and cheaper than the three existing budgeted walks.

<a id="f-engine-layout-paint-only-patch-forces-relayout"></a>

### MEDIUM · The engine relayouts on paint-only patches: LAYOUT_FIELDS never crosses the boundary

`architecture` · `engine-layout/paint-only-patch-forces-relayout`

**Where:** `native-src/dziri-engine/src/tables.rs:542`, `native-src/dziri-engine/src/engine.rs:273`, `native-src/dziri-engine/src/engine.rs:314`, `native-src/dziri-engine/src/layout.rs:124`, `src/ir.ts:142`

**Claim.** The compiler's `affectsLayout` classification is never transmitted to the engine, and the engine's commit diff throws away the field index — so a colour-only conditional class re-pushes the whole `Style` and unconditionally dirties the node and every ancestor up to the root. `LAYOUT_FIELDS` is a lie as far as the engine is concerned.

**Evidence.** tables.rs:542-546 discards `span.field` for the styles table entirely: `if span.table as usize == styles { diff.styles = true; self.collect_changed_slots(span, &mut diff.changed_styles); return; }` — bg/fg/borderColor/borderWidth/radius are indistinguishable from width/padding/gap. engine.rs:314-329 then calls `self.tree.apply_style(...)` for every node wearing a changed slot, and layout.rs:126 calls `set_style`, which in taffy 0.9.2 (taffy_tree.rs:831-835) is `self.nodes[node].style = style; self.mark_dirty(node)?;` — dirty unconditionally — and `mark_dirty` (taffy_tree.rs:870-887) walks to the root. engine.rs:273 then runs `compute` for any `diff.any`. Nothing in native-src/dziri-engine/src/protocol.rs carries a layout/paint flag; the classification exists only at src/ir.ts:142 and dies at src/runtime/patches.ts:48 (`dirty = patch.affectsLayout ? Dirty.LAYOUT : ... Dirty.PAINT`), whose result the host cannot pass to the engine — there is no such FFI entry point in lib.rs.

**Impact.** A hover-driven `.primary` background toggle clears the measure cache on the whole ancestor chain, so Skia re-measures that node's text every time. A theme change touching one colour field across many slots dirties most of the tree. The staging/diff machinery earns its memory precisely on this claim ("a colour-only theme patch touches no geometry, so it reaches paint without Taffy hearing about it at all", engine.rs:300-302) and it does not hold.

**Recommendation.** Two fixes. (1) Immediate, 2 lines: taffy's `Style` derives `PartialEq` (style/mod.rs:360), so guard `apply_style` with `if self.tree.style(id).map(|s| *s != style).unwrap_or(true) { self.tree.set_style(...) }` — a paint-only patch then produces an identical Style and never dirties anything. (2) Structural: add `affectsLayout` per field in src/protocol/schema.ts (the declared single source of truth) and have scripts/gen-protocol.ts emit `pub const LAYOUT_AFFECTING: [bool; FIELD_COUNT]` into protocol.rs; `classify` then sets `diff.styles` only for layout-affecting fields and a new `diff.paint` otherwise, and engine.rs:273 becomes `if self.fresh || diff.needs_layout`.

**Verifier — weakened.** affectsLayout genuinely never crosses the FFI boundary and a colour-only patch does dirty the node plus its ancestors, so the engine.rs:300-302 comment and NOTES.md:649 are both false for the Rust engine. But the cost is ~135µs of extra Taffy work at 1215 nodes on the toggle frame (measured), not a Skia re-measure — text.rs's advance cache absorbs the measurement. Severity medium; the two-line PartialEq guard is the right fix.

<a id="f-engine-layout-structural-change-rebuilds-whole-tree"></a>

### MEDIUM · Any structural change rebuilds the whole Taffy tree and discards the measure cache

`performance` · `engine-layout/structural-change-rebuilds-whole-tree`

**Where:** `native-src/dziri-engine/src/engine.rs:304`, `native-src/dziri-engine/src/layout.rs:62`, `native-src/dziri-engine/src/tables.rs:531`

**Claim.** The tree is kept incrementally across frames (there is a persistent index→NodeId map), but `diff.structure` — what a dynamic-list append or reorder produces — discards the whole `TaffyTree` and rebuilds it from zero, re-measuring every text node through Skia.

**Evidence.** tables.rs:531 maps `n::KIND | n::PARENT | n::FIRST_CHILD | n::NEXT_SIBLING | n::LIST` to `diff.structure = true`. engine.rs:304-308: `if self.fresh || diff.structure || ... { self.tree.rebuild(&self.tables, self.root)?; self.tree.apply_all_styles(&self.tables)?; ... return Ok(()); }`. layout.rs:66-79 is `self.tree = TaffyTree::with_capacity(count); ... for i in 0..count { new_leaf_with_context(...) } ... self.relink(tables)`. At the documented 1215-node scale that is 1215 slotmap inserts, 1215 `set_children`, 1215 `style_of` + `set_style`, and — because the new tree has no cache — a full SkParagraph re-measure of every `MEASURABLE` node. NOTES.md records text measurement as the single expensive part of the A0 spike. A targeted `relink` alone would not help as written either, because taffy's `set_children` marks the parent dirty (taffy_tree.rs:723) and layout.rs:96 calls it for all `count` nodes.

**Impact.** Adding one todo to the sample app's list re-measures every label in the document. The engine's own justification for choosing Taffy is that it is "faster than the hand-written engine when nothing is dirty (0.050 ms vs 0.162 ms on 1203 nodes)"; a list append is the common case and it pays the cold-start cost every time.

**Recommendation.** `commit` already knows which rows moved — `collect_changed_slots` (tables.rs:566) is right there but is only called for the styles and strings tables. Extend `classify` to collect changed *node indices* for `FIRST_CHILD`/`NEXT_SIBLING`/`LIST` into `diff.changed_links`, make `LayoutTree::relink_nodes(&[usize])` public, and in `resync` call `set_children` only for the parents implicated (for a changed `nextSibling[i]`, the parent is `nodes.parent[i]`). Reserve full `rebuild` for `fresh` and a capacity change. The `ids` map is already persistent, so no NodeId churn is involved — only the dirty set shrinks from N to what the patch touched.

**Verifier — weakened.** Any structural change does discard the whole TaffyTree and pay a cold layout — measured at ~1.9ms for 1215 nodes versus 50µs clean — but it does not re-measure text through Skia: the Measurer's advance cache lives on Engine and survives the rebuild, so unchanged rows are a hash lookup. Severity medium (a per-change-frame hiccup), and the incremental relink_nodes recommendation stands.

<a id="f-engine-layout-interaction-styles-bypass-layout"></a>

### MEDIUM · Hover/focus/active styles never reach layout, but paint reads padding from them

`correctness` · `engine-layout/interaction-styles-bypass-layout`

**Where:** `native-src/dziri-engine/src/layout.rs:368`, `native-src/dziri-engine/src/paint.rs:65`, `native-src/dziri-engine/src/paint.rs:221`, `native-src/dziri-engine/src/engine.rs:332`

**Claim.** `style_of` always resolves a node's *base* `nodes.style` slot, while `Painter::node` resolves the state slot via `style_for`. Any interaction declaration touching a layout field is silently half-applied: the box keeps its base geometry while the label is positioned using the hover slot's padding and font size.

**Evidence.** layout.rs:368-372 reads `nodes::STYLE` and nothing else — `InputState` is not even a parameter of `style_of`/`apply_style`. paint.rs:66-100 `style_for` returns `active`/`hover`/`focus` slots, and paint.rs:221-227 computes the label box from that slot: `let box_w = w - g(f::PAD_LEFT) - g(f::PAD_RIGHT); let tx = x + g(f::PAD_LEFT) + (box_w - advance) / 2.0;` where `w`/`h` came from the layout table (base slot) but `g(f::PAD_*)` came from the state slot. `Engine::resync` (engine.rs:332) has no branch for `diff.states`, and an `InputState` change (engine.rs:414-445) only sets `needs_paint = true`.

**Impact.** `.btn:hover { padding: 12px }` or `:focus { font-size: 15px }` compiles cleanly, interns a style slot, and produces a label that jumps inside an unchanged box. The compiler already computes `affectsLayout` for pseudo-state deltas (src/compiler/variants.ts:244) and prints it (src/variants.ts:175), so the information to reject or honour this exists on both sides and is used on neither.

**Recommendation.** Honour it: thread `InputState` into `style_of` using the same precedence `paint::style_for` implements (factor that resolution into one shared function so the two cannot drift), and when `InputState` changes call `mark_dirty` on the at most six nodes involved (old and new hovered/pressed/focused). That is the cheapest possible dirty set. If that is too much for A0, the compile-time-first alternative is a hard build error in src/compiler/variants.ts when a `:hover`/`:focus`/`:active` delta intersects `LAYOUT_FIELDS` — the runtime cannot honour it, so the compiler should refuse it.

**Verifier — weakened.** Documented at NOTES.md:463-464 as a known current limitation, and latent in the sample app (every :hover/:focus rule in app.css is paint-only). The genuinely new observation is that paint mixes the state slot's padding/font-size with the base slot's box, so the result is a mis-centred label rather than the clean paint-only effect the note implies — and nothing rejects a layout-affecting pseudo-state delta at compile time. Severity medium, not high.

<a id="f-engine-layout-initial-style-defeats-unset"></a>

### MEDIUM · The engine's UNSET fix is defeated by INITIAL_STYLE setting align/justify to 0

`correctness` · `engine-layout/initial-style-defeats-unset`

**Where:** `src/ir.ts:188`, `src/ir.ts:189`, `native-src/dziri-engine/src/layout.rs:322`, `native-src/dziri-engine/src/layout.rs:409`, `windows/main/index.css:56`

**Claim.** Every `u8` enum field in `style_of` handles `UNSET` correctly — including all four of `alignItems`/`alignSelf`/`justifyItems`/`justifySelf`, which all route through `align_of` — but the compiler never emits `UNSET` for `align` or `justify`, so grid items are still coerced to `flex-start` and never stretch. This is the exact regression the code comment claims was fixed.

**Evidence.** layout.rs:322-334 `align_of` returns `None` for `UNSET` and anything unrecognised, with the comment "Coercing to variant 0 is what silently collapsed grid items in the spike, whose default is `stretch` rather than `flex-start`"; layout.rs:409-412 applies it to all four fields, and `justify_content` (layout.rs:399-407) does the same. The other u8 fields have no UNSET variant in src/protocol/schema.ts and their fallbacks match Taffy's defaults (`display → Flex`, `flexDirection → Row`, `flexWrap → NoWrap`, `position → Relative`), so the engine side is clean. But src/ir.ts:188-189 is `justify: Justify.START, align: Align.START` — 0, not `UNSET` — while the neighbouring `alignSelf: UNSET` (ir.ts:192) carries the correct comment explaining why. Every grid container in the sample stylesheet then carries the workaround: `.panels { align-items: stretch }` (windows/main/index.css:56), `.card` (windows/main/index.css:65), `.stats` (windows/main/index.css:81). tests/bounds.rs:206 documents it from the other side: "The compiler's `INITIAL_STYLE` says `flex-start`, so real IR looks like this rather than like Taffy's default."

**Impact.** `grid grid-cols-4 gap-2` written in Tailwind idiom — no `items-stretch` — produces top-aligned, shrink-wrapped cells instead of equal-height cells filling their row. CSS's initial `align-items: normal` behaves as `stretch` for both grid items and the flex cross axis, so the compiler's default is strictly less CSS-correct than leaving the field unset, and every grid in the app has been hand-patched around it. (`minW: 0` / `minH: 0` at ir.ts:209-211 is the same class of divergence: CSS's initial `min-width` is `auto`, i.e. min-content for flex items, and forcing 0 removes the automatic minimum size Taffy would apply.)

**Recommendation.** Set `justify: UNSET` and `align: UNSET` in `INITIAL_STYLE` and let the engine's existing `None` path deliver Taffy's defaults, which already match CSS (`justify_content: None → FlexStart`, `align_items: None → Stretch`). Then delete the three `align-items: stretch` workarounds from app/app.css so the stylesheet stops hiding the bug, and add a bounds.rs test asserting a grid item with `align: UNSET` fills its row height while `align: FLEX_START` does not — that missing assertion is why this survived.

**Verifier — weakened.** The compiler does emit variant 0 rather than UNSET for align/justify (ir.ts:188-189), and no CSS path can produce UNSET for them, so the engine's UNSET handling is unreachable for these two fields and Tailwind-idiom `grid grid-cols-4` gets flex-start instead of stretch. But the divergence spans flex as well as grid: six `align-items: stretch` declarations work around it (windows/main/index.css:14, 19, 56, 65, 80, 260), and only two of those are grids — .card/.app/body/.list are flex. Changing INITIAL_STYLE therefore re-lays-out the entire corpus, which bounds.rs:200-207 documents as a deliberate carry-over from the hand-written engine, so it is a medium-severity conformance divergence needing a migration rather than a two-line fix.

<a id="f-engine-layout-list-wrapper-breaks-grid"></a>

### MEDIUM · The LIST transparent-wrapper workaround breaks grid placement entirely

`architecture` · `engine-layout/list-wrapper-breaks-grid`

**Where:** `src/compiler/compile.ts:467`, `src/compiler/compile.ts:153`, `src/ir.ts:155`, `native-src/dziri-engine/src/layout.rs:88`

**Claim.** A LIST node is a real child node between the container and the rows, and it copies `display`/`gridCols`/`gridRows` from the container. Inside a grid container that makes the wrapper a single grid item occupying one cell, with a second nested grid inside it — grid placement of the rows is not approximate, it is wrong by a factor of the track count. `justify-content` on a list container is likewise a no-op.

**Evidence.** src/compiler/compile.ts:466-475 pushes a `NodeKind.LIST` node with `style: styles.intern(passThrough(parentStyle))`, then compiles the template as its child (`walkChild(node.template, path, parentStyle, self)`); the rows are children of the wrapper, not of the container. `passThrough` (compile.ts:153-156) copies `CONTAINER_FIELDS` = `display, direction, wrap, justify, align, gapRow, gapCol, gridCols, gridRows, justifyItems` (src/ir.ts:155-166). So for `display: grid; grid-template-columns: repeat(3, 1fr)` the container has three tracks and exactly one item (the wrapper), which auto-places into column 1; the wrapper then has its own three tracks inside 1/3 of the width. The doc comment argues only about `align-items` and `gap` ("Without that, the container's `align-items` and `gap` apply to the wrapper instead of to the rows") — true, and it works for a flex column, which is why the sample app's `.list` (windows/main/index.css:258, no `display`, so flex-column) looks right. It does not address grid, and it does not address the main axis: the wrapper is one flex item with `grow: 0`, so a container's `justify-content: space-between` distributes one child while the copied `justify` inside the shrink-wrapped wrapper has no free space to distribute either.

**Impact.** A dynamic list inside any `display: grid` container renders every row inside a single cell. Latent today only because app.tsx puts its one list inside a flex column; it fires the first time someone writes a list of grid cards. The wrapper also silently becomes the containing block for any `position: absolute` row, since Taffy positions absolute children against their immediate parent — windows/main/index.css:193-197 documents that choice for authored markup, but not for a node the author never wrote.

**Recommendation.** Drop the wrapper node. `LayoutTree::relink` (layout.rs:88) rebuilds every child list from `firstChild`/`nextSibling` on each structural change, so the arena rows can be children of the container directly. Record two anchors in the `lists` table — the container node plus the `prevSibling` the row chain splices in after (`-1` meaning "container's firstChild") — and have `updateList` (src/runtime/list-runtime.ts:290-305) link `prev.nextSibling → firstRow … lastRow.nextSibling → nextStatic` instead of rewriting `firstChild[listNode]`. Same number of typed-array writes, no wrapper, no `CONTAINER_FIELDS` copy, and `display: contents` stops being something that needs emulating.

**Verifier — confirmed.** Every element checks out. compile.ts:456-475 pushes a real NodeKind.LIST node with `style: styles.intern(passThrough(parentStyle))` and then compiles the template as its child (`walkChild(node.template, path, parentStyle, self)`), so rows are children of the wrapper. passThrough (compile.ts:143-156) is `inheritFrom(parent)` plus CONTAINER_FIELDS, and ir.ts:155-166 includes display, gridCols, gridRows, justify and justifyItems — so a `display: grid; grid-template-columns: repeat(3, 1fr)` container ends up with exactly one item (the wrapper) auto-placed into column 1, with its own three tracks inside that cell. Because grow is not in CONTAINER_FIELDS, the wrapper inherits INITIAL_STYLE's `grow: 0` (ir.ts:193), so the main-axis argument holds too: a container's `justify-content: space-between` distributes one shrink-wrapped item, and the copied `justify` inside the wrapper has no free space. The doc comment at compile.ts:144-152 does argue only about align-items and gap. Latency is as stated: windows/main/index.css:258-261 `.list` has no `display`, so it is a flex column, which is why the sample app looks right. The absolute-positioning consequence is also real given windows/main/index.css:193-197's documented "Taffy positions an absolute child against its own parent". The recommendation is plausible — relink (layout.rs:88-121) rebuilds every child list from the chains each structural change, so rows can hang off the container directly — though it also needs growArena's `nodes.parent[dst] = listNode` (list-runtime.ts:137) and dispatchItem's arena-range test updated, which the write-up glosses.

<a id="f-engine-layout-unclamped-grid-inputs-reach-taffy"></a>

### MEDIUM · Unclamped grid geometry from host memory: 1.3 s frames and a Taffy overflow panic

`security` · `engine-layout/unclamped-grid-inputs-reach-taffy`

**Where:** `native-src/dziri-engine/src/layout.rs:337`, `native-src/dziri-engine/src/layout.rs:467`, `native-src/dziri-engine/src/layout.rs:476`

**Claim.** `gridColumns`/`gridRows` (full u16) and `gridColumnStart`/`gridRowStart`/`*Span` (full i16) are passed to Taffy verbatim from host-writable memory. The 0-sentinel guard is correct and load-bearing, but nothing bounds the magnitudes: I measured 211 ms and 1.33 s single-frame layouts, and reproduced an `attempt to add with overflow` panic inside Taffy.

**Evidence.** layout.rs:467-477: `let cols = u16f(f::GRID_COLUMNS); if cols > 0 { s.grid_template_columns = vec![minmax(length(0.0_f32), fr(1.0_f32)); cols as usize]; }` and `s.grid_column = placement(i16f(f::GRID_COLUMN_START), i16f(f::GRID_COLUMN_SPAN));`. Against taffy 0.9.2 in `--release`, with 2x2 explicit tracks: `gridColumnStart = gridRowStart = -32768` → `compute_layout` returns `Ok` in **211.7 ms**; `gridColumnSpan = gridRowSpan = 32767` → `Ok` in **1.3256 s**. The cost is taffy's dense `CellOccupancyMatrix` — `Grid::new(rows.len(), columns.len())` (cell_occupancy.rs:69-71) sized from `TrackCounts::len()` = `(negative_implicit + explicit + positive_implicit) as usize` (grid_track_counts.rs:57-59), a **u16** sum. With `gridColumns = 65535` plus any negative start, `explicit_line_count = explicit_track_count + 1` overflows: I reproduced `panicked at taffy-0.9.2/src/compute/grid/types/coordinates.rs:34: attempt to add with overflow` in a debug build, and in release that line silently wraps to 0 and `explicit_line_count as i16` goes negative.

**Impact.** A compiler bug or a stray typed-array write turns one frame into 1.3 seconds, or panics Taffy — which `with()` (lib.rs:66-70) catches but converts into `poisoned = true`, permanently bricking the engine handle. Note `package.json:9` runs `cargo test --release`, where the overflow wraps silently instead of panicking, so the project's own test command cannot see it. This is the one input class that gets none of the validation the child chains get, and Tailwind's surface bounds it to ~1-12 anyway.

**Recommendation.** Clamp in `style_of`, next to the existing `is_finite` guards: `let cols = u16f(f::GRID_COLUMNS).min(1024)` (same for rows), and clamp placement against the resolved track count — `start.clamp(-(tracks as i16 + 1), tracks as i16 + 1)` and `span.clamp(0, tracks as i16)`, passing that count into `placement`. Nothing in the Tailwind subset (`grid-cols-1..12`, `col-span-1..12`) loses anything, and it closes the last unvalidated host-input path in the layout stage.

**Verifier — confirmed.** Reproduced. layout.rs:467-477 passes u16f(GRID_COLUMNS)/u16f(GRID_ROWS) and i16f(GRID_*_START/SPAN) straight through, with the 0-sentinel in placement (layout.rs:337-350) as the only guard — and that sentinel is genuinely load-bearing, since taffy's into_origin_zero_line panics on line 0 (coordinates.rs:34-40). Against taffy 0.9.2 in --release with 2x2 explicit tracks (scratchpad/cyc/src/bin/grid.rs), replicating layout.rs's exact placement(): sane 4-track case 91µs; gridColumnStart = gridRowStart = -32768 → Ok in 181.6ms; gridColumnSpan = gridRowSpan = 32767 → Ok in 1.4117s. Both within noise of the reviewer's 211ms/1.33s. The overflow is real too: cols = 65535 with gridColumnStart = -1 panics in a debug build at exactly the cited site — `panicked at taffy-0.9.2/src/compute/grid/types/coordinates.rs:34:35: attempt to add with overflow` — and in release wraps silently (12.7ms, Ok), because explicit_track_count + 1 is a u16 add (coordinates.rs:34) feeding TrackCounts::len()'s u16 sum (grid_track_counts.rs:57-59). package.json:9 is `cargo test --release`, where overflow-checks are off, so the project's own test command cannot see it, and lib.rs:44-72's `with()` converts a caught panic into `poisoned = true` for the life of the handle. Severity medium is right: it needs a host-side bug to reach, and Tailwind's grid-cols-1..12 bounds the legitimate range, but it is the one input class with none of the validation the child chains get.

<a id="f-engine-layout-taffy-ffi-dead-divergent-copy"></a>

### MEDIUM · native-src/taffy-ffi is dead code and a diverged second copy of the conversion

`cleanliness` · `engine-layout/taffy-ffi-dead-divergent-copy`

**Where:** `native-src/taffy-ffi/src/lib.rs:44`, `native-src/taffy-ffi/src/lib.rs:251`, `native-src/taffy-ffi/src/lib.rs:370`, `NOTES.md:180`

**Claim.** The crate has no callers, is not in any workspace or build script, and duplicates `layout.rs`'s conversion rules — which have already diverged. It is also the only FFI surface in the repo with no `catch_unwind`, unchecked indexing, and an unchecked out-buffer.

**Evidence.** The only references anywhere are its own Cargo.toml, a stale `target/` directory, and the historical note at NOTES.md:180 ("The A0 spike wrapped Taffy in a C ABI (`native-src/taffy-ffi`)"); package.json only builds `native-src/dziri-engine`, and there is no root workspace manifest. The rules have drifted: taffy-ffi's `opt()` (lib.rs:44-50) treats only NaN as auto, while layout.rs:296 also treats Infinity as auto — so `maxW: Infinity` from `INITIAL_STYLE` would become `Dimension::length(inf)` here; its `lp()` (lib.rs:60) does not guard Infinity; `align_self` (lib.rs:125-130) has no `BASELINE` and coerces differently from `align_of`. Soundness: `taffy_new_node` does `.unwrap()` (lib.rs:251), `taffy_add_child` does `ctx.nodes[parent as usize]` on an unvalidated i32 (lib.rs:260), `taffy_set_styles` reads `STYLE_FIELDS * count` f32s from a raw pointer (lib.rs:293), and `taffy_read_layout` writes `4 * count` f32s into the caller's buffer with no capacity check (lib.rs:372) — all in `extern "C"` fns with no unwind guard, so any panic aborts the process.

**Impact.** Two implementations of the same NaN/UNSET/grid-placement contract that must agree and no longer do. Anyone reading it to understand the conversion rules learns the wrong ones, and any future "just reuse the spike" reintroduces a cdylib with no panic guard into a codebase whose stated invariant is that every `extern "C"` fn has one.

**Recommendation.** `rm -rf native-src/taffy-ffi`. Its conclusion is already recorded in prose at NOTES.md:180 and its measurements in ROADMAP's A0 section; the code adds nothing the note does not. If a reproducible benchmark is the reason to keep it, move the measurement into `native-src/dziri-engine/benches/` against the real `LayoutTree`, which is what would actually catch a regression.

**Verifier — confirmed.** Verified end to end. The only reference to the crate anywhere outside its own directory is NOTES.md:180 ("The A0 spike wrapped Taffy in a C ABI (native-src/taffy-ffi)"); package.json:8-12 only builds and tests native-src/dziri-engine; there is no native-src/Cargo.toml and no Cargo.toml at the repo root, so no workspace includes it (each of dziri-engine, skia-probe, taffy-ffi has its own manifest and lockfile). The divergences are all present: taffy-ffi's opt() (lib.rs:44-50) tests only is_nan, so INITIAL_STYLE's `maxW: Infinity` (ir.ts:210) would become Dimension::length(inf) rather than auto as in layout.rs:296-302; its lp() (lib.rs:59-61) is `if v.is_nan() { 0.0 } else { v }` with no infinity guard, unlike layout.rs:311-313; its align_self mapping (lib.rs:125-130) has no BASELINE arm and folds 4 to None, where align_of (layout.rs:322-334) returns Baseline; its align_items arm coerces unrecognised values to FlexStart, i.e. exactly the UNSET bug the engine documents as fixed. The soundness claims hold too: taffy_new_node unwraps (lib.rs:251), taffy_add_child indexes ctx.nodes with an unvalidated i32 (lib.rs:260-262), taffy_set_styles reads STYLE_FIELDS * count f32s from a raw pointer (lib.rs:293-295), taffy_read_layout writes 4*count f32s into the caller's buffer with no capacity check (lib.rs:370-372) — none inside a catch_unwind, unlike lib.rs:44-72 in the engine. Medium for cleanliness is defensible in a repo whose thesis is one generated source of truth; the code is unreachable, so it carries no runtime risk, only the risk of being read or revived.

<a id="f-engine-layout-layout-test-coverage-gaps"></a>

### MEDIUM · bounds.rs tests flex only: grid, absolute, dirty paths and hostile inputs untested

`testing` · `engine-layout/layout-test-coverage-gaps`

**Where:** `native-src/dziri-engine/tests/bounds.rs:111`, `native-src/dziri-engine/tests/bounds.rs:334`, `native-src/dziri-engine/tests/bounds.rs:270`

**Claim.** The nine integration tests cover flex column/row, absolute-bounds accumulation, text measurement, `hidden`, a style patch, a relink, one sibling cycle and hit-testing. Everything else in `style_of` — most of it — has zero coverage, including every behaviour named as load-bearing in the file's own comments.

**Evidence.** Reading all 421 lines: no test constructs `display::GRID`. `placement()` (layout.rs:337), the `repeat(N, minmax(0,1fr))` track generation (layout.rs:467-474), the 0-sentinel that prevents taffy's `panic!("Grid line of zero is invalid")`, and span semantics are all unexercised — while windows/main/index.css:53 and :78 depend on them and windows/main/index.css:93 uses `grid-column: span 2`. No test asserts the `UNSET`-vs-`FLEX_START` difference the layout.rs:329-331 comment says was a real regression (init_style writes `align::UNSET` at bounds.rs:51-54 but nothing asserts what it produces). No test for margin, min/max size, aspect-ratio, flex-grow/shrink/basis, flex-wrap, or `position: absolute` + insets — so `.chips` and `.badge` have no Rust coverage. `a_cycle_in_the_child_chain_is_an_error_not_a_hang` (bounds.rs:334) covers only the `nextSibling` direction, which is exactly why the parent/child cycle stack overflow survives. Nothing changes a string and re-ticks, so the `changed_strings` mark_dirty path (engine.rs:332-348) never executes. Nothing calls `grow()` then `tick()`. Nothing runs with `root != 0`. `a_style_patch_relays_out_without_touching_the_tree` (bounds.rs:270) asserts a layout field *does* reach layout, and there is no test — and no exposed counter — asserting a paint-only field does *not*.

**Impact.** Every finding above sits in an untested path. Concretely: the grid conversion can be broken by a Taffy minor upgrade with a green suite; the paint-only optimisation can regress invisibly because nothing observes it; and `cargo test --release` (package.json:9) additionally hides Taffy's debug overflow checks.

**Recommendation.** Four targeted additions in the existing headless-engine style. (1) A grid test: 4 tracks, one child with `gridColumnSpan = 2`, one with `gridColumnStart = 4`, asserting hand-computed x/width — pins `placement`, the track vector and the 0 sentinel at once. (2) An UNSET test: same grid, one slot `align::UNSET` and one `align::FLEX_START`, asserting the first fills the row height and the second does not. (3) A hostile-input test per input class: `firstChild[0] = 0` (must be `Err`, not a crash), `gridColumns = 65535` with `gridColumnStart = -1`, `gridColumnSpan = 32767` — each asserting `tick()` errors or completes under a time budget. (4) Expose `Engine::relayout_count()` (incremented where `set_style` actually fires) and assert it does not advance across a bg-only patch — the optimisation is unverifiable until something can observe it.

**Verifier — confirmed.** Every specific claim verified against the whole test corpus (bounds.rs 421 lines, boundary.rs 209 lines, the tables.rs and text.rs unit tests — 9 unit, 9 bounds, 8 boundary, matching ROADMAP.md:56). No test anywhere constructs display::GRID: `placement()` (layout.rs:337-350), the repeat(N, minmax(0,1fr)) generation (layout.rs:467-474) and the 0-sentinel that prevents taffy's `panic!("Grid line of zero is invalid")` (coordinates.rs:37) are entirely unexercised, while windows/main/index.css:53, 77 and 93 (`grid-column: span 2`) depend on them. init_style writes align::UNSET at bounds.rs:51-54 but nothing asserts what UNSET produces versus FLEX_START, which is precisely the regression layout.rs:329-331 says was real. No margin, min/max size, aspect-ratio, grow/shrink/basis, flex-wrap or position:absolute+inset test exists. bounds.rs:333-355 covers only the nextSibling direction — and I confirmed by reproduction that the parent/child direction is the uncovered one that aborts the process. No test changes a string and re-ticks, so engine.rs:332-348 never executes (the first tick returns early from resync via `fresh`). tables.rs:844-862 calls grow() but never tick(). root is 0 in every config (bounds.rs:32, boundary.rs:24, examples/window.rs:133). There is no relayout counter anywhere in the engine, so the paint-only claim is unobservable. And package.json:9's `cargo test --release` does hide the debug overflow check — I reproduced the taffy grid panic in debug and its silent wrap in release. Medium (testing) is the right weight: every other finding in this batch sits in one of these gaps.

<a id="f-engine-layout-text-repoint-misses-mark-dirty"></a>

### LOW · Repointing `nodes.text` at an unchanged slot skips mark_dirty, leaving a stale size

`correctness` · `engine-layout/text-repoint-misses-mark-dirty`

**Where:** `native-src/dziri-engine/src/tables.rs:537`, `native-src/dziri-engine/src/engine.rs:339`

**Claim.** `classify` sets `diff.text` when the `nodes.text` span changes but records *which nodes* changed nowhere, and `resync` then filters by `changed_strings`. A node whose text pointer moved to a slot whose bytes did not change is therefore never re-measured.

**Evidence.** tables.rs:537 is just `n::TEXT => diff.text = true` — no `collect_changed_slots`, unlike the styles branch (tables.rs:544) and the strings branch (tables.rs:560). engine.rs:339-344 then computes the stale set as `slot >= 0 && (changed.is_empty() || changed.binary_search(&(slot as u32)).is_ok())`. When the strings table also changed in the same commit, `changed` is non-empty, so a node whose `text` was repointed to a slot outside `changed` is filtered out — its cached measured size survives even though the string it renders is different.

**Impact.** Reachable through the list path: `updateList` re-asserts `nodes.text[itemBase + binding.offset] = stringSlot` (src/runtime/list-runtime.ts:286) for every row, and `growArena` (list-runtime.ts:148) repoints every node at brand-new slots. A node repointed at a still-empty new slot (offset 0, length 0 — bytes unchanged from zero-init) keeps the width it measured from its old text, so a row renders at the wrong size until something else dirties it. Silent and intermittent.

**Recommendation.** Call the existing helper on the TEXT span: `n::TEXT => { diff.text = true; self.collect_changed_slots(span, &mut diff.changed_text_nodes); }` — the span is indexed by node, so the "slots" it returns *are* node indices. In `resync`, mark dirty the union of `changed_text_nodes` and the nodes whose slot is in `changed_strings`, and drop the `changed.is_empty()` catch-all — with both lists populated it is no longer needed, which also removes the current whole-document re-measure whenever the string byte arena is rewritten in place.

**Verifier — weakened.** The classify gap is real but the cited vector is not: updateList's nodes.text write is idempotent for a fixed arena, and growArena always co-occurs with structural changes that force a full tree rebuild, so no stale cache survives. The actually reachable stale-measure path is a same-byte-length string change through Uploader.#repack (upload.ts:305-329), which leaves the slot's (offset,length) row unchanged and therefore outside changed_strings while another slot's change suppresses the is_empty() catch-all. Severity low; the recommended fix (collect changed TEXT node indices, drop the catch-all) should be paired with marking dirty on region-span changes.

<a id="f-engine-layout-hidden-toggle-restyles-every-node"></a>

### LOW · A `hidden` toggle re-pushes every node's style, dirtying the whole tree

`performance` · `engine-layout/hidden-toggle-restyles-every-node`

**Where:** `native-src/dziri-engine/src/tables.rs:535`, `native-src/dziri-engine/src/engine.rs:311`

**Claim.** `nodes.hidden`, `nodes.style` and `nodes.flags` all collapse to a single `node_styles` flag, and `resync` answers it with `apply_all_styles` — N `set_style` calls, each marking its node and ancestors dirty, so the entire measure cache is cleared to show or hide one subtree.

**Evidence.** tables.rs:535: `n::STYLE | n::HIDDEN | n::FLAGS => diff.node_styles = true`. engine.rs:311-313: `if diff.node_styles { self.tree.apply_all_styles(&self.tables)?; }` with the comment "Which node points where changed; every node's style is suspect" — true only for the `nodes.style` span, and even there only for the rows that differ. `apply_all_styles` (layout.rs:131-136) loops `0..self.ids.len()`, i.e. node *capacity*, including every unreachable list-arena row.

**Impact.** Toggling one conditional `hidden` bit — the mechanism behind every show/hide in the app — costs a full restyle plus a full text re-measure, the same as a structural rebuild. At 1215 nodes with headroom capacity that is thousands of wasted `set_style` calls.

**Recommendation.** `collect_changed_slots` already returns exactly the changed row indices and the nodes table is indexed by node, so make `classify` collect them into `diff.changed_nodes` for `STYLE`/`HIDDEN`/`FLAGS` and have `resync` call `apply_style` only for those. Combined with the `Style: PartialEq` guard from the paint-only finding, a `hidden` toggle then dirties exactly one subtree root.

**Verifier — weakened.** The apply_all_styles-over-capacity behaviour is real and worth fixing before conditional visibility lands, but nothing in the compiler or runtime writes nodes.hidden or nodes.style today (only zero-fill and bulk upload), and FLAGS changes only alongside structural changes that take the rebuild branch — so diff.node_styles is presently unreachable and the "mechanism behind every show/hide in the app" does not exist. Severity low, as a latent inefficiency rather than a live cost.

<a id="f-engine-layout-grow-leaves-live-string-and-bounds-arenas-stale"></a>

### LOW · `Tables::grow` does not carry the live string arena or the bounds arena across

`correctness` · `engine-layout/grow-leaves-live-string-and-bounds-arenas-stale`

**Where:** `native-src/dziri-engine/src/tables.rs:716`, `native-src/dziri-engine/src/tables.rs:731`, `native-src/dziri-engine/src/tables.rs:663`

**Claim.** Growth preserves contents for every table span in both arenas, but the string byte region is copied into `staged` only, and the `Bounds` arena is skipped entirely — so after a grow the engine's live string arena is zeroed and the published bounds are zeroed until the next commit and layout.

**Evidence.** tables.rs:716-717 skips the region span: `if span.home != Home::Shared || span.table < 0 { continue; }` — the string arena has `table == REGION` (-1) — and skips the layout table (`home == Bounds`). tables.rs:731-733 then copies the region one-directionally: `let string_bytes = self.string_bytes().to_vec();` (that reads *live*) into `grown.staged_string_bytes_mut()`, with nothing written to `grown.live`. Nothing restores the bounds arena, and `Engine::grow` (engine.rs:514-520) only sets `fresh = true`.

**Impact.** Self-healing rather than broken: the next `commit` sees the region differ and copies staged→live before layout runs. But it is correct by accident, and the window is observable — `Tables::bounds_of`/`Engine::bounds_of` back the host's imperative `rect()` and hit-testing, and between `dziri_engine_grow` and the next `tick` they return all-zero rects rather than the previous frame's. Relatedly, `bounds_of` (tables.rs:671) and `write_bounds` (tables.rs:654) hardcode a 4-byte element (`span.offset + node * 4`, `bytes.len() / 4`) instead of `span.elem_size`, so a schema change to the layout table's width would silently misread rather than fail.

**Recommendation.** Copy the region symmetrically in `grow` (write the live bytes into `grown.live` at the region's new offset, exactly as the table loop does) and memcpy the old bounds arena into the grown one — capacity only ever increases, so the prefix is valid. Replace the hardcoded `4`s with `span.elem_size as usize` plus a `debug_assert_eq!(span.elem_size, 4)` so the f32 cast states its assumption instead of burying it.

**Verifier — weakened.** Growth does leave grown.live's string region and the whole bounds arena zeroed, and the region copy is asymmetric — but there is no observable window: the only bounds path the host has (dziri_engine_bounds → Engine::bounds_of → LayoutTree's own Vec) is unaffected by Tables::grow, Tables::bounds_of has zero callers, and commit always runs before any live-string read inside tick. What remains is latent fragility plus the hardcoded 4-byte element width in write_bounds/bounds_of. Severity low.

---

## Engine: paint, text & Skia

*12 findings — 5 medium, 7 low.*

- **medium** · [Full-window raster plus two full-frame copies per repaint; no damage tracking](#f-engine-paint-text-full-window-repaint-and-two-full-frame-copies)
- **medium** · [Colour-only style patch forces a Taffy relayout; the doc comment is false](#f-engine-paint-text-colour-only-patch-forces-a-taffy-relayout)
- **medium** · [Inset stroke inflates the border's outer corner radius by half the border width](#f-engine-paint-text-border-outer-radius-does-not-match-css)
- **medium** · [borderWidth is excluded from layout, so content is not inset by the border](#f-engine-paint-text-border-width-excluded-from-layout)
- **medium** · [Greyscale AA and integer glyph positioning: text will not look native on Windows](#f-engine-paint-text-greyscale-aa-text-on-a-desktop-framework)
- **low** · [Paragraph seam returns a size, so A2 will re-shape every text node every frame](#f-engine-paint-text-paragraph-seam-returns-a-size-not-a-paragraph)
- **low** · [Advance cache keys on a bare FNV of the text and omits available_width](#f-engine-paint-text-advance-cache-key-is-a-bare-fnv-and-omits-width)
- **low** · [faces and typefaces are unbounded caches keyed on host-writable shared memory](#f-engine-paint-text-unbounded-font-caches-keyed-on-host-memory)
- **low** · [HiDPI is a five-file sweep, and two of those files already contain latent DPR bugs](#f-engine-paint-text-hidpi-is-a-sweep-not-a-local-change)
- **low** · [GPU move is not foreclosed, but three pixel paths hard-code CPU raster](#f-engine-paint-text-gpu-migration-path-and-peek-pixels)
- **low** · [take_png destroys the frame before the capacity check; readback copies twice](#f-engine-paint-text-png-and-pixel-readback-error-paths)
- **low** · [hit_test walks from node 0 while paint walks from config.root](#f-engine-paint-text-hit-test-hardcodes-node-zero-as-root)

<a id="f-engine-paint-text-full-window-repaint-and-two-full-frame-copies"></a>

### MEDIUM · Full-window raster plus two full-frame copies per repaint; no damage tracking

`performance` · `engine-paint-text/full-window-repaint-and-two-full-frame-copies`

**Where:** `native-src/dziri-engine/src/engine.rs:353-366`, `native-src/dziri-engine/src/engine.rs:285-292`, `native-src/dziri-engine/src/window.rs:122-133`, `native-src/dziri-engine/src/paint.rs:122-146`

**Claim.** `needs_paint` is a single bool, so any change repaints the entire window from the root and then re-uploads and re-blits the entire surface; three of the four full-frame costs per frame are independent of how much actually changed.

**Evidence.** engine.rs:353-357 `fn draw(&mut self) { let canvas = self.surface.canvas(); canvas.clear(Color::BLACK); self.painter.paint(canvas, ..., self.root); }` — no rect argument, no clip. engine.rs:285 `if !self.needs_paint { ... return Ok(()); }` is the only granularity there is; engine.rs:420 sets `self.needs_paint = true;` for a one-pixel hover change. window.rs:123 `self.texture.update(None, pixels, pitch)` and window.rs:129 `self.canvas.copy(&self.texture, None, None)` both pass `None` = whole frame. paint.rs:126-146 walks every node with no viewport test — the only rejection is `if node >= count || hidden...`.

**Impact.** At 3840x2160 one full-surface pass is 33.2 MB. A frame does at least four: `canvas.clear` (33 MB write), the root `body` background fill (33 MB), `SDL_UpdateTexture` into the streaming texture (33 MB read + 33 MB write), and `SDL_RenderTexture` (33 MB PCIe upload). At ~10 GB/s that is ~10-13 ms before a single button is drawn, against a 16.6 ms budget at 60 Hz — so 4K/60 is already marginal and 4K/120 is out of reach, while 1080p (8.3 MB/pass, ~3-4 ms) is comfortable. Moving the mouse across a 4K window at 120 Hz motion-event rate pays all of it per event batch. Worse, the TS side's headline optimisation is exactly wrong-shaped: a compile-time style patch that touches only `bg` still costs a full-window raster and two full-frame copies, so the 'zero-FFI style patch' saves 1 microsecond of call overhead against ~10 ms of pixels. And once `shadow-*`, `opacity-*` and gradients land (Tailwind's utility surface is the committed CSS subset, and src/protocol/schema.ts has no field for any of them yet) the raster cost jumps another order of magnitude: a blur is a separable convolution and `opacity` forces a `saveLayer` offscreen plus a full composite. For a 10,000-row list arena with 20 rows visible, paint still issues 10,000 `draw_rect` and `draw_str` calls for Skia to reject one at a time.

**Recommendation.** Do the three cheap things before considering GPU, and do them together because any one alone is wasted. (1) Viewport-cull in `Painter::paint`: before `self.node(...)`, `if x >= win_w || y >= win_h || x + w <= 0.0 || y + h <= 0.0 { continue; }` — three lines that prune whole subtrees and make long lists O(visible). (2) When you add damage rects, pair them with `canvas.clip_rect(damage)` AND `texture.update(Some(damage_rect), &pixels[row_offset..], pitch)` AND `canvas.copy(&texture, Some(damage), Some(damage))` — the SDL calls are the two-thirds of the cost, so a Skia-only dirty rect changes nothing. (3) Eliminate the `SDL_UpdateTexture` copy entirely by inverting ownership: `SDL_LockTexture` the streaming texture and wrap its pixels with `skia_safe::surfaces::wrap_pixels(&ImageInfo::new_n32_premul(...), locked_pixels, Some(pitch), None)` so Skia rasterises directly into SDL's staging memory. That is precisely the `sk_surface_new_raster_direct` design NOTES.md:249-252 already argues for ('the pixel buffer is allocated in JS... the *same* buffer handed to SDL_UpdateTexture. No readback') and which the Rust port silently dropped when it chose an owned `surfaces::raster_n32_premul`. It removes 33 MB of memcpy per frame and costs only the window.rs comment 'Deliberately knows nothing about Skia'.

**Verifier — weakened.** Accurate statement: paint and present are whole-surface by documented design (NOTES.md:511-513, 771), and at the shipped 1040x560 that is ~2.3 MB/pass — the measurement NOTES.md requires before damage tracking has not been taken, and `last_frame_ms` is already there to take it. Motion inside a node triggers no repaint at all (engine.rs:416). The genuinely undocumented gap is the absence of a viewport reject in `Painter::paint` (paint.rs:132), which makes an off-screen list pay full draw-call cost; that is a 3-line fix worth doing independently of any damage-rect work.

<a id="f-engine-paint-text-colour-only-patch-forces-a-taffy-relayout"></a>

### MEDIUM · Colour-only style patch forces a Taffy relayout; the doc comment is false

`performance` · `engine-paint-text/colour-only-patch-forces-a-taffy-relayout`

**Where:** `native-src/dziri-engine/src/engine.rs:299-330`, `native-src/dziri-engine/src/tables.rs:544-546`, `native-src/dziri-engine/src/layout.rs:124-129`

**Claim.** `Diff::changed_styles` records changed style *slots*, not changed *fields*, so a `bg`-only patch routes through `apply_style` -> Taffy `set_style` -> `mark_dirty`, which is exactly what the code says cannot happen.

**Evidence.** engine.rs:299-302 asserts 'The whole point of staging is here: a colour-only theme patch touches no geometry, so it reaches paint without Taffy hearing about it at all.' But tables.rs:544-546 classifies *any* differing span of the styles table identically: `if span.table as usize == styles { diff.styles = true; self.collect_changed_slots(span, &mut diff.changed_styles); return; }` — BG, FG, BORDER_COLOR and RADIUS all land here. engine.rs:314-329 then does `for node in affected { self.tree.apply_style(&self.tables, node)?; }`, and layout.rs:126 `self.tree.set_style(self.ids[node], style)` reaches taffy-0.9.2/src/tree/taffy_tree.rs:831-834 `self.nodes[node.into()].style = style; self.mark_dirty(node)?;` — unconditional, and Taffy's `mark_dirty` propagates to every ancestor up to the root.

**Impact.** The signature optimisation of the whole staged-tables design does not fire. A theme toggle, a hover-driven `bg` change written by Bun, or any conditional-class patch dirties the changed node's entire ancestor chain, so `tree.compute` at engine.rs:274 re-runs flex/grid for that path and re-invokes the measure closure on the dirtied subtree's text nodes instead of hitting Taffy's 0.050 ms clean-tree path that ROADMAP.md:110 says won the architecture argument. Once the measure closure becomes SkParagraph (see the paragraph-seam finding) this turns a paint-only patch into full re-shaping.

**Recommendation.** Two fixes, take both. Cheap and immediate: `Style` derives `PartialEq` in taffy-0.9.2/src/style/mod.rs:360, so guard the write — `let new = style_of(tables, node); if self.tree.style(self.ids[node]).map(|s| s != &new).unwrap_or(true) { self.tree.set_style(...)?; }`. That is 3 lines and makes the doc comment true for every field. The thesis-aligned fix: partition the styles table's fields into LAYOUT and PAINT groups in src/protocol/schema.ts and have scripts/gen-protocol.ts emit an `IS_LAYOUT_FIELD: [bool; MAX_FIELDS]` table, then `classify` sets `diff.styles` only for layout fields and a new `diff.paint_only` otherwise — the compiler already knows which field is which, so this is a compile-time answer to a runtime question, which is the project's own governing rule.

**Verifier — confirmed.** I tried to find the guard and there is none. tables.rs:542-546 classifies the whole styles table uniformly: `if span.table as usize == styles { diff.styles = true; self.collect_changed_slots(...); return; }` — the styles table is struct-of-arrays with one span per field (schema.ts:87-91 `bg`,`fg`,`borderColor`,`borderWidth`,`radius`), so a `bg`-only patch differs in the `bg` span and still lands in that branch with no field discrimination. engine.rs:314-329 then calls `self.tree.apply_style(&self.tables, node)` for every node wearing the changed slot, layout.rs:126-128 calls `set_style`, and taffy-0.9.2/src/tree/taffy_tree.rs:831-834 is unconditional: `self.nodes[node.into()].style = style; self.mark_dirty(node)?;`. taffy_tree.rs:870-893 `mark_dirty_recursive` walks `parents` to the root. So engine.rs:300-302's 'a colour-only theme patch … reaches paint without Taffy hearing about it at all' is false. It is in fact false twice over: engine.rs:273 gates layout on `self.fresh || diff.any`, and `diff.any` is set by tables.rs:514 for *any* differing shared span, so `compute` runs on a colour patch regardless of dirtiness — the difference the guard would buy is Taffy's 0.050 ms clean-tree path (ROADMAP.md:110) versus recomputing the dirtied ancestor chain and re-invoking the measure closure on the dirtied leaf. The proposed 3-line `PartialEq` guard also checks out: taffy Style derives PartialEq and `tree.style()` returns `&Style` (taffy_tree.rs:838-840). Medium is right — it is wasted work per patch frame, not incorrect output.

<a id="f-engine-paint-text-border-outer-radius-does-not-match-css"></a>

### MEDIUM · Inset stroke inflates the border's outer corner radius by half the border width

`correctness` · `engine-paint-text/border-outer-radius-does-not-match-css`

**Where:** `native-src/dziri-engine/src/paint.rs:179-188`

**Claim.** The stroke inset is correct for the straight edges but not for the corners: stroking a radius-`r` path with width `t` produces an outer boundary of radius `r + t/2`, while the background fill underneath has radius `r`, so the fill pokes outside the border at each corner and the whole box's outer radius is wrong relative to CSS.

**Evidence.** paint.rs:170-173 fills `Rect::from_xywh(x, y, w, h)` with `draw_round_rect(rect, radius, radius, &self.fill)`. paint.rs:183-187 then draws the border as `let half = border_width / 2.0; let rect = Rect::from_xywh(x + half, y + half, w - border_width, h - border_width); ... canvas.draw_round_rect(rect, radius, radius, &self.stroke)` with `set_stroke_width(border_width)`. Concretely for `border-radius: 8px; border: 6px`: the border path's corner arc is centred at (x+11, y+11) with radius 8, so the stroke's outer edge is an arc of radius 11 — equivalent to a round rect of radius 11 at (x, y, w, h). Along the 45-degree diagonal the fill boundary sits at 8 - 8/sqrt(2) = 2.34 px from the corner while the border's outer edge starts at 11 - 11/sqrt(2) = 3.22 px, so ~0.9 px of background colour is painted *outside* the border. CSS gives outer radius 8 and inner radius max(0, 8-6) = 2.

**Impact.** Every bordered rounded box is geometrically wrong. app/app.css uses `border: 1px` throughout (half = 0.5 px), which is why this is invisible today — it hides under anti-aliasing. From Tailwind's `border-2` upward it is a visible 1-3 px crescent of the wrong colour at each of the four corners, and with `border-radius: 2px; border: 6px` the outer radius becomes 5 versus CSS's 2, which reads as a completely different shape. It is also silently self-correcting for pills (`border-radius: 999px`) because Skia clamps both radii to half the height, which is exactly the kind of coincidence that keeps a bug alive.

**Recommendation.** Replace the stroked path with the CSS border-box primitive Skia already provides: `canvas.draw_drrect(&RRect::new_rect_xy(Rect::from_xywh(x, y, w, h), r, r), &RRect::new_rect_xy(Rect::from_xywh(x+t, y+t, w-2.0*t, h-2.0*t), (r-t).max(0.0), (r-t).max(0.0)), &self.fill)`. One call, a Fill paint instead of a Stroke paint, exact CSS outer/inner radius semantics, and no `set_stroke_width` mutation per node. It also generalises: `RRect::new_rect_radii` takes four corner radii, so it is the same call site when src/protocol/schema.ts:89-91 grows from one `radius`/`borderWidth` to Tailwind's per-corner (`rounded-t-lg`) and per-side (`border-b-2`) utilities, whereas the stroked-path approach cannot express either.

**Verifier — confirmed.** I re-derived the geometry and it holds. paint.rs:170-173 fills the full box `Rect::from_xywh(x, y, w, h)` at radius `r`; paint.rs:183-187 strokes `Rect::from_xywh(x + t/2, y + t/2, w - t, h - t)` at the *same* radius `r` with `set_stroke_width(t)`. The stroked path's corner arc is centred at (x + t/2 + r, y + t/2 + r) with radius r, so the outer edge of a centred stroke is radius r + t/2 about that centre — i.e. the composite outer boundary is a round rect of radius r + t/2 on the border box, where CSS specifies r. For r=8, t=6: centre (x+11, y+11), outer arc radius 11, so along the diagonal the border's outer edge sits 11√2 - 11 = 4.56 px from the corner while the fill's boundary sits 8√2 - 8 = 3.31 px from it — the fill is nearer the corner, so ~1.25 px of background is painted outside the border ring at each corner. The inner edge is r - t/2 = 5 where CSS gives max(0, r - t) = 2. The pill self-correction is real too: at r=999 Skia clamps to half the *inset* rect's height (h-t)/2, and (h-t)/2 + t/2 = h/2, which is exactly the CSS pill. `draw_drrect` and `RRect::new_rect_xy`/`new_rect_radii` exist in skia-safe 0.87 as recommended. Only mitigation: app/app.css uses `border: 1px` everywhere (lines 61, 85, 123, 148, 202, 231, 274, 296), so the error is 0.5 px today — which the finding already states. Medium stands because the compiler accepts arbitrary CSS border widths, not just 1px.

<a id="f-engine-paint-text-border-width-excluded-from-layout"></a>

### MEDIUM · borderWidth is excluded from layout, so content is not inset by the border

`correctness` · `engine-paint-text/border-width-excluded-from-layout`

**Where:** `native-src/dziri-engine/src/layout.rs:352-357`, `native-src/dziri-engine/src/paint.rs:179-188`, `native-src/dziri-engine/src/paint.rs:223-227`

**Claim.** The border paints inside the node's box but layout does not reserve room for it, so the border band overlaps the padding box; this matches neither CSS content-box nor Tailwind's border-box.

**Evidence.** layout.rs:354-356: 'Note what is *not* here: `borderWidth`. Borders are stroked inset by the painter, so they do not change the box — the same decision the TypeScript runtime made, kept so the migration stays pixel-comparable.' `style_of` sets `s.padding`, `s.margin`, `s.inset` (layout.rs:437-460) and never touches `s.border`, which taffy-0.9.2/src/style/mod.rs:415 provides as `pub border: Rect<LengthPercentage>`. Paint then places the button label at `x + g(f::PAD_LEFT) + ...` (paint.rs:226) and non-button text at plain `x` (paint.rs:234), measuring from the border box.

**Impact.** A `border: 4px` + `padding: 2px` element draws its 4 px border band over [0,4] px and its text starting at 2 px — the glyphs are painted under the border. Under Tailwind's preflight (`box-sizing: border-box`, which the project accepts as its CSS subset) the content box should be `size - border - padding`, so every bordered element is 2*borderWidth too large in its content area and children are misplaced by borderWidth. The stated justification is migration fidelity to the TypeScript prototype, not correctness — and the roadmap's own purpose is to replace that prototype, so preserving its bug is preserving the wrong thing. It also compounds the corner-radius finding: the border is wrong in both geometry and box model.

**Recommendation.** Set `s.border = Rect { top: lp(bw), right: lp(bw), bottom: lp(bw), left: lp(bw) }` in `style_of` — six lines, and Taffy implements border-box content shrinking natively so nothing else changes. Then paint the border with `draw_drrect` between the border box and the padding box (see the corner-radius finding), and drop the `borderWidth` term from paint's text origin arithmetic since Taffy's reported box already accounts for it. If pixel-comparability with the TypeScript prototype is genuinely required for the migration, gate it behind a one-frame diff harness rather than a permanent geometry decision.

**Verifier — confirmed.** Verified end to end. layout.rs:352-356 documents the omission and `style_of` (layout.rs:357-480) sets `padding`, `margin`, `inset`, `size`, `min_size`, `max_size`, `gap`, `aspect_ratio`, grid — and never `s.border`, which taffy exposes as `pub border: Rect<LengthPercentage>` and implements natively. I checked the compiler for a build-time compensation and there is none: src/compiler/css.ts:435-442 only parses `border-width` into `out.borderWidth`, with no `box-sizing` handling anywhere in the file, so nothing subtracts the border from `width`/`height` upstream either. Consequence is exactly as described: Taffy's content box is `size - padding`, children are placed at the padding offset, and paint.rs:223-227 computes the button label's box as `w - PAD_LEFT - PAD_RIGHT` with no border term, so a bordered box's label and child text are laid over the border band. This is a documented deliberate decision, but it is a temporary migration-fidelity choice, not a committed non-goal — border widths are squarely inside Tailwind's utility surface, which the project accepts as its CSS subset. Today's corpus is 1px borders so the visible error is 1 px of misplacement and 2 px of content-box inflation; medium is defensible because the fix is ~6 lines and gets more expensive once app CSS uses `border-2`+.

<a id="f-engine-paint-text-greyscale-aa-text-on-a-desktop-framework"></a>

### MEDIUM · Greyscale AA and integer glyph positioning: text will not look native on Windows

`correctness` · `engine-paint-text/greyscale-aa-text-on-a-desktop-framework`

**Where:** `native-src/dziri-engine/src/text.rs:126-150`, `native-src/dziri-engine/src/paint.rs:229-234`

**Claim.** Every `Font` is built with SkFont's defaults, which are greyscale AA and no subpixel positioning, so all text is noticeably lighter and blurrier than every other application on the same Windows desktop, where ClearType subpixel AA is the norm.

**Evidence.** text.rs:129-137 constructs fonts with `Font::from_typeface(tf, size)` or `Font::default()` + `set_size(size)` and never touches edging, subpixel or hinting; skia-safe-0.87.0/src/core/font.rs:132 and 156 expose exactly `set_subpixel` and `set_edging`, and SkFont's defaults are `Edging::AntiAlias` (greyscale) with `subpixel = false`. The surface is opaque (`raster_n32_premul` with a `canvas.clear(Color::BLACK)` at engine.rs:357), which is the precondition that makes subpixel AA valid. `set_anti_alias(true)` on the Paint (paint.rs:51) governs geometry, not glyph rasterisation, so it does not cover this.

**Impact.** For a framework whose entire pitch is 'renders natively', text is the first thing a reviewer looks at and the one thing that will read as wrong side by side with a real Win32 or Electron app: stems land on integer pixel boundaries so inter-letter spacing is irregular at 12-14 px, and greyscale AA makes light-on-dark text look thin. It also silently changes measurement fidelity — with `subpixel = false` the advances Skia reports are the fractional ones but glyph placement is rounded, so `measure_str` and the drawn result diverge by up to half a pixel per glyph, which accumulates across a label and defeats the button centring at paint.rs:226.

**Recommendation.** Two lines in `Measurer::face` before the font is cached: `font.set_edging(skia_safe::font::Edging::SubpixelAntiAlias); font.set_subpixel(true);` — and add `font.set_hinting(FontHinting::Slight)` to match what DirectWrite does. Verify against the golden-image harness (`encode_png`) rather than by eye, since this changes every text pixel. If you later add a translucent or layered window, gate `SubpixelAntiAlias` on the surface being opaque, because subpixel AA is invalid when compositing over unknown pixels.

**Verifier — weakened.** Accurate statement: fonts inherit SkFont's greyscale-AA, integer-positioning defaults, so Windows text will read lighter and less evenly spaced than ClearType neighbours; `set_edging(SubpixelAntiAlias)` + `set_subpixel(true)` in `Measurer::face` fixes it and the opaque surface makes it valid. Drop the measurement-fidelity argument: measurement and drawing share one SkFont, so they agree by construction, and per-glyph position rounding does not accumulate.

<a id="f-engine-paint-text-paragraph-seam-returns-a-size-not-a-paragraph"></a>

### LOW · Paragraph seam returns a size, so A2 will re-shape every text node every frame

`architecture` · `engine-paint-text/paragraph-seam-returns-a-size-not-a-paragraph`

**Where:** `native-src/dziri-engine/src/text.rs:184-186`, `native-src/dziri-engine/src/text.rs:15-18`, `native-src/dziri-engine/src/paint.rs:221-234`, `native-src/dziri-engine/src/layout.rs:229`

**Claim.** The doc comment claims the current signature is the one SkParagraph needs, but only its *inputs* are right; the *output* is a size, and a paragraph's laid-out state is what paint must draw, so with this seam paint has no choice but to build and layout a second paragraph for every text node every frame.

**Evidence.** text.rs:184 `pub fn measure(&mut self, text: &str, size: f32, weight: u16, _available_width: f32) -> (f32, f32) { (self.advance(...), self.line_height(...)) }`, justified at text.rs:15-18 as 'the signature is already the one SkParagraph needs, so A2 changes the body and not the callers'. Paint draws with `canvas.draw_str(text, (tx, ty), font, &self.fill)` (paint.rs:229, 234) — a glyph-run API that has no way to consume a `Paragraph`. Under SkParagraph, paint must instead call `paragraph.paint(canvas, x, y)`, and the only `Paragraph` in existence was dropped inside `measure`. There is no paragraph cache, no `FontCollection` field, and no glyph-run cache anywhere in `Measurer` (text.rs:53-63 holds exactly `font_mgr`, `family`, `typefaces`, `faces`, `advances`, `advance_order`).

**Impact.** Taffy calls the measure closure with MinContent (0.0), MaxContent (inf) and Definite(w) for the same node in one pass, and `layout.rs:229` calls it from inside `compute_layout_with_measure` — so a text node gets 2-3 shaping passes per layout, and then paint adds one more. `ParagraphBuilder::new` + `add_text` + `build` + `layout(width)` is full ICU word-breaking, bidi resolution, HarfBuzz shaping and line breaking: order 10-50 microseconds for a short label, versus the ~50 nanoseconds a `Font::measure_str` cache hit costs today. For a 200-label UI that is 8-40 ms per frame of pure shaping, on the render thread, for text that did not change — the exact cliff ROADMAP.md:337 lists as 'Glyph and paragraph caching inside the engine' and which this seam guarantees you will hit first and diagnose second. `_available_width` being ignored is not the honest limitation the comment says it is; the dishonest part is the return type.

**Recommendation.** Change the seam now, while there is one caller. Add `paragraphs: HashMap<ParaKey, Paragraph>` to `Measurer` keyed on `(text_slot, size_bits, weight, width_bits, max_lines)`, and make the API `fn paragraph(&mut self, ...) -> &Paragraph` returning a laid-out paragraph; `measure` becomes `let p = self.paragraph(...); (p.longest_line(), p.height())` and paint becomes `self.measurer.paragraph(...).paint(canvas, x, y)`. Both callers then share one layout. Hold the `FontCollection` on `Measurer` too (`FontCollection::new()` + `set_default_font_manager`), because rebuilding it per node — as native-src/skia-probe/src/main.rs:68-69 does, constructing a second `FontCollection` for the ellipsis case — re-resolves the whole fallback chain each time. Bound the paragraph cache FIFO the way `advances` already is, and invalidate on `diff.changed_strings`, which `engine.rs:332-348` already computes.

**Verifier — weakened.** Accurate statement: `measure` returning a size is the right shape for its only current caller (Taffy's measure closure, layout.rs:202-234, which must return a `Size`). When A2 lands SkParagraph, paint will need a second entry point returning a laid-out `Paragraph`, plus the paragraph cache ROADMAP.md:341 already commits to — a two-call-site change, not an architectural trap. The doc comment at text.rs:15-18 should say 'A2 changes the body and adds a paint-side accessor', which is a comment-accuracy nit.

<a id="f-engine-paint-text-advance-cache-key-is-a-bare-fnv-and-omits-width"></a>

### LOW · Advance cache keys on a bare FNV of the text and omits available_width

`correctness` · `engine-paint-text/advance-cache-key-is-a-bare-fnv-and-omits-width`

**Where:** `native-src/dziri-engine/src/text.rs:157-173`, `native-src/dziri-engine/src/text.rs:184-186`, `native-src/dziri-engine/src/text.rs:196-203`

**Claim.** Two defects in one key: the cached string is never stored so a hash collision silently returns another string's width, and the key does not include the available width, so the moment `measure` stops ignoring `_available_width` the cache starts returning measurements taken at a different width.

**Evidence.** text.rs:157 `let key = (size.to_bits(), weight, hash_str(text)); if let Some(&w) = self.advances.get(&key) { return w; }` — nothing compares `text` against the entry that produced it, and `hash_str` (text.rs:196-203) is FNV-1a, which is trivially collidable by construction, over content that comes from the host-writable string arena. Separately, text.rs:184 takes `_available_width` and drops it, while layout.rs:223-227 passes three genuinely different values for the same node in one pass (`Definite(v)`, `f32::INFINITY` for MaxContent, `0.0` for MinContent).

**Impact.** The collision path is a wrong text width — a visual glitch, not unsafety — and at 4096 entries the accidental probability is negligible, but the arena content is host-controlled so it is constructible rather than merely unlikely, and 'this label is 40 px wide for no reason' is a bug nobody will ever find. The width omission is the serious half: today it is correct because single-line measurement genuinely ignores width, so the key is honest; the instant A2 makes `measure` width-aware, `(size, weight, hash)` becomes a *wrong* key and the same node will be handed the MinContent measurement it computed two calls earlier. That is a silent layout corruption introduced by a change in a different file, with no test that can catch it because the cache is behaviour-invisible.

**Recommendation.** Stop hashing content. The text already lives in an arena addressed by slot, and `resync` already computes `diff.changed_strings` (engine.rs:332-348), so key the cache on `(text_slot: u32, size_bits: u32, weight: u16, width_bits: u32)` and invalidate the affected entries on commit. That removes the FNV hash from the per-measure path entirely (Taffy calls it 2-3x per node per pass), removes collisions by construction, and makes the width part of the key before it needs to be. Change `measure`'s signature to take the slot rather than `&str` so the wrong key cannot be built; if you keep content hashing as an interim, store `Box<str>` in the value and compare on hit.

**Verifier — weakened.** Accurate statement: the key is honest for what `measure` currently computes (single-line advance, width-independent), and a 64-bit FNV collision inside a 4096-entry cache is a ~5e-13 cosmetic risk with no unsafety and no panic path. The real content is a note-to-self for A2: whoever makes `measure` width-aware must add width to the key. Keying on `text_slot` instead of a content hash is a good idea for the per-measure cost (it removes an FNV pass Taffy triggers 2-3x per text node per layout), but sell it on that, not on collisions.

<a id="f-engine-paint-text-unbounded-font-caches-keyed-on-host-memory"></a>

### LOW · faces and typefaces are unbounded caches keyed on host-writable shared memory

`security` · `engine-paint-text/unbounded-font-caches-keyed-on-host-memory`

**Where:** `native-src/dziri-engine/src/text.rs:53-63`, `native-src/dziri-engine/src/text.rs:109-150`

**Claim.** The advance cache is bounded with a documented rationale, but the two caches next to it are not, and both keys come straight out of the host-writable styles table — so a Bun-side bug or a font-size animation grows platform font objects without limit.

**Evidence.** text.rs:56-58 `typefaces: HashMap<u16, Typeface>, faces: HashMap<(u32, u16), Face>, advances: HashMap<(u32, u16, u64), f32>` — only `advances` has an eviction path (`ADVANCE_LIMIT`, text.rs:51 and 166-170). `face` (text.rs:126-150) inserts unconditionally on miss, keyed on `size.to_bits()`, and `typeface` (text.rs:109-122) inserts unconditionally keyed on the raw `u16` weight. Both keys are read straight from shared memory: layout.rs:220-221 `font_size.get(style)` / `font_weight.get(style)` and paint.rs:204-209 do the same, and tables.rs's own doc comment for `string` acknowledges the threat model — 'the slot table is host-written memory, so a wrong value is a Bun-side bug that must not be able to panic the render thread'.

**Impact.** A signal-driven `font-size` transition writing 16.0, 16.1, 16.2... into `styles.fontSize` mints a new `Face` (an SkFont plus a Typeface ref, plus Skia's own internal per-(typeface, size) glyph cache and rasterised glyph masks) on every distinct float, forever — hundreds of megabytes over a long session, and the glyph masks are the expensive part. The `typefaces` map is worse in kind: writing weights 0..65535 makes the engine allocate up to 65536 platform typeface objects (DirectWrite/CoreText handles), and because DirectWrite snaps any weight to the nearest available face, weights 400 and 401 store two entries pointing at the same physical font. Both are reachable from a shared-memory write with no FFI call and no validation.

**Recommendation.** Quantise the keys before they become keys, which the compile-time-first principle argues for anyway: clamp weight to the nine CSS weights with `let weight = (weight.clamp(100, 900) / 100) * 100;` (the compiler only emits those, so this is free and caps `typefaces` at 9), and quantise size to a sixteenth of a pixel with `let bits = (size * 16.0).round() as u32;` — which also fixes the stated rationale backwards, since keeping 16.0 and 16.000001 distinct is a cost, not a feature. Then bound `faces` with the same `VecDeque` FIFO the advance cache already uses, and add the equivalent of the existing `the_advance_cache_stays_bounded` test (text.rs:226-232) for it.

**Verifier — weakened.** Accurate statement: `typefaces` and `faces` are unbounded in principle, and clamping weight to the nine CSS steps plus quantising size (and bounding `faces` with the VecDeque FIFO already used for advances) is a cheap hardening worth doing. But the leak is bounded in practice — Skia dedupes typefaces internally and bounds glyph masks in its own global strike cache (skia-safe graphics.rs:7-27) — the per-entry cost is tens of bytes, and no mechanism in the shipped runtime mints novel font sizes. This is low-severity hygiene, not a security finding.

<a id="f-engine-paint-text-hidpi-is-a-sweep-not-a-local-change"></a>

### LOW · HiDPI is a five-file sweep, and two of those files already contain latent DPR bugs

`architecture` · `engine-paint-text/hidpi-is-a-sweep-not-a-local-change`

**Where:** `native-src/dziri-engine/src/window.rs:143-148`, `native-src/dziri-engine/src/window.rs:97-99`, `native-src/dziri-engine/src/lib.rs:366-378`, `native-src/dziri-engine/src/layout.rs:242-248`, `native-src/dziri-engine/src/engine.rs:522-548`

**Claim.** The painter itself would take a one-line `canvas.scale(dpr, dpr)`, but the surrounding code has already baked `scale = 1` into the event model, the surface descriptor and the layout rounding, so adding a device pixel ratio touches window.rs, engine.rs, layout.rs, lib.rs and paint's origin arithmetic.

**Evidence.** window.rs:143-147 collapses two semantically different SDL events into one variant: `WindowEvent::PixelSizeChanged(w, h) | WindowEvent::Resized(w, h) => out.push(RawInput::Resized { width: ..., height: ... })` — `Resized` reports points and `PixelSizeChanged` reports pixels, and engine.rs:401 keeps only the last (`RawInput::Resized { width, height } => resize = Some((width, height))`). `size_in_pixels()` exists at window.rs:97-99 and is called from nowhere in engine.rs. lib.rs:374 synthesises `*out.add(2) = width * 4;` as rowBytes while `Engine::pixels` (engine.rs:256-258) returns the pixmap's real `row_bytes()`. layout.rs:242-286 `read_back` has no access to a scale factor, and ROADMAP.md:89-91 notes Taffy rounds to whole pixels by default.

**Impact.** On a 150% Windows display SDL emits both events with different numbers on every resize, so the engine nondeterministically sizes its surface to points or to pixels depending on delivery order — a real bug the moment `scale = 1` stops being true, hidden today only because the two numbers are equal. `surface_info`'s `width * 4` and the pixmap's real stride also diverge as soon as the surface is device-sized while `self.width` stays logical: `readPixels()` in src/engine/host.ts:440-441 sizes its buffer from `surfaceInfo()`, so it would allocate 1/dpr^2 of what is needed and `dziri_engine_read_pixels` would fail with CAPACITY. And Taffy's whole-logical-pixel rounding stops helping: at dpr = 1.5 a whole logical pixel is 1.5 device pixels, so every box lands on a half-device-pixel edge and every edge goes soft — the roadmap's proposed remedy, `disable_rounding`, makes that worse by removing rounding entirely rather than moving it to the right grid.

**Recommendation.** Do the four things that make it local, before the sweep gets bigger. (1) Split the event: `RawInput::Resized { points }` and `RawInput::PixelSizeChanged { pixels }`, and have `Engine::resize` take logical size and derive device size from `window.size_in_pixels()` — the accessor is already there. (2) Store `scale: f32` on `Engine`, size the surface at `(w * scale, h * scale)`, and put `canvas.scale(self.scale, self.scale)` in `draw()` immediately after `clear` so paint, `bounds`, `hit_test` and the mouse coordinates all stay in logical space and need no change at all. (3) Report the pixmap's real `row_bytes()` from `surface_info` instead of computing `width * 4`, plus the device width/height as two extra u32s — it is already an out-array. (4) Keep Taffy's rounding off (`TaffyTree::disable_rounding`) and round in `read_back` to the device grid instead: `let snap = |v: f32| (v * scale).round() / scale;`, which needs `read_back` to take the scale — that is the one genuinely non-local change, and doing it now is a two-line signature edit versus a correctness hunt later.

**Verifier — weakened.** Accurate statement: HiDPI is a documented deferral, and the two SDL events cannot disagree until the window opts into `high_pixel_density()` (sdl3 video.rs:1528), so today's collapsed `Resized` variant is latent, not a live bug. `surface_info`'s `width * 4` also matches Skia's raster `row_bytes()` exactly for `raster_n32_premul`. The useful residue is small and cheap: split the two SDL events now, and report the real `row_bytes()` rather than recomputing it — both are pre-emptive hygiene for scheduled work, worth low severity.

<a id="f-engine-paint-text-gpu-migration-path-and-peek-pixels"></a>

### LOW · GPU move is not foreclosed, but three pixel paths hard-code CPU raster

`architecture` · `engine-paint-text/gpu-migration-path-and-peek-pixels`

**Where:** `native-src/dziri-engine/src/engine.rs:240-259`, `native-src/dziri-engine/src/engine.rs:368-383`, `native-src/dziri-engine/src/window.rs:70-74`, `native-src/dziri-engine/Cargo.toml:19`

**Claim.** The painter survives a GPU move untouched because it takes `&Canvas`, but every path that reads pixels goes through `Surface::peek_pixels`, which returns `None` on any GPU surface, and `window.rs` commits the window to SDL's renderer API, which cannot coexist with a raw GL/Vulkan context on the same window.

**Evidence.** Three call sites: engine.rs:256 `let pixmap = self.surface.peek_pixels()?;`, engine.rs:372 `let Some(pixmap) = self.surface.peek_pixels() else { return Err(...) };`, and engine.rs:244 `let data = image.encode(None, skia_safe::EncodedImageFormat::PNG, 100)?` — with the comment at engine.rs:242-243 'No GPU context: this surface is CPU raster', and `None` is precisely the `DirectContext` argument that a GPU-backed image requires. window.rs:70-73 `let canvas = window.into_canvas(); let creator = canvas.texture_creator(); ... create_texture_streaming(PixelFormat::ARGB8888, ...)` consumes the SDL Window into a renderer. Cargo.toml:19 enables only `features = ["textlayout"]` — no `gl`, `vulkan`, `d3d` or `metal`, so `skia_safe::gpu` is not even compiled in.

**Impact.** The migration is real work, not a flag flip: a full Skia rebuild from source with a GPU feature added, replacing `surfaces::raster_n32_premul` with `gpu::surfaces::wrap_backend_render_target`, replacing all of `Window::present`/`resize`/the texture with `SDL_GL_CreateContext` + `gl_swap_window`, and rewriting the three readback sites — of which two (`present` for the window, `pixels`/`encode_png` for the golden-image harness) fail *silently to an error path* rather than at compile time, so a GPU port that builds will produce a black window and a broken screenshot suite. The honest reading is 'reversible at a cost concentrated in one file plus three call sites', which is defensible for A0 but should not be discovered under deadline.

**Recommendation.** Make the readback backend-neutral now, at zero cost to the raster path: introduce `fn read_frame(&mut self, dst: &mut Vec<u8>) -> Option<usize>` on `Engine` that tries `peek_pixels` and falls back to `Surface::read_pixels(&ImageInfo::new(dims, ColorType::RGBA8888, AlphaType::Unpremul, None), dst, row_bytes, IPoint::new(0,0))` — which works on both backends — and route `pixels()` and `encode_png` through it, keeping the direct `peek_pixels` fast path only in `present`. Hold an `Option<gpu::DirectContext>` field on `Engine` from the start and pass `self.context.as_mut()` to `image.encode(...)` instead of a literal `None`, so the GPU path is a value change rather than a code change. And write down in window.rs that `into_canvas()` is the line that forecloses a GL context, since that is the one decision a future reader will not reconstruct.

**Verifier — weakened.** Accurate statement: the three `peek_pixels`/`encode(None, …)` sites and `into_canvas()` are the concrete places a GPU port touches, and they fail at runtime rather than at compile time — worth a comment in window.rs and a backend-neutral `read_frame` helper. But GPU is an explicitly deferred milestone (NOTES.md:768, 516) and the finding's own conclusion matches the documented position, so this is a low-severity hygiene note, not an architecture defect.

<a id="f-engine-paint-text-png-and-pixel-readback-error-paths"></a>

### LOW · take_png destroys the frame before the capacity check; readback copies twice

`correctness` · `engine-paint-text/png-and-pixel-readback-error-paths`

**Where:** `native-src/dziri-engine/src/lib.rs:443-456`, `native-src/dziri-engine/src/engine.rs:240-259`, `native-src/dziri-engine/src/lib.rs:380-406`

**Claim.** Three defects in the two-call PNG/pixel protocol: a too-small buffer loses the frame irrecoverably instead of being retryable, each export copies the full frame twice, and `read_pixels` hands out premultiplied bytes documented as plain BGRA_8888.

**Evidence.** lib.rs:447-452: `let png = engine.take_png();` runs *before* `if (len as usize) < png.len() { return fail(status::CAPACITY, ...) }` — and `take_png` is `std::mem::take(&mut self.png)` (engine.rs:251), so on the failure path the `Vec` is dropped at the end of the closure and the encoded frame is gone. Contrast lib.rs:397-402, where `read_pixels` checks capacity before copying and is therefore retryable. `encode_png` does `self.png = data.as_bytes().to_vec()` (engine.rs:245) — SkData already owns those bytes, so that is one full copy, and `dziri_engine_take_png` then copies again into the host buffer. Same for pixels: `pixmap.bytes()?.to_vec()` (engine.rs:258) then `copy_nonoverlapping` (lib.rs:403). And the surface is `raster_n32_premul` (engine.rs:160) while lib.rs:380 and src/engine/host.ts:438 both say only 'BGRA_8888'.

**Impact.** The `take_png` ordering means a host that under-allocates gets `CAPACITY` and then, on retry, an empty buffer with `status::OK` — a zero-byte PNG written to disk with no error, which is the worst possible failure mode for a golden-image harness. The double copy is 2x33 MB per 4K screenshot for pixels (and the encoded PNG is retained on `Engine` for its entire remaining lifetime after the last `encode_png` if `take_png` is never called — bounded, since each encode overwrites, but several megabytes held indefinitely). The premultiplication label is the invisible one: every pixel is currently opaque because `draw` clears to opaque black, so it cannot be observed today, but the first golden-image comparison against an RGBA reference or the first translucent window will produce wrong colours on every semi-transparent pixel with nothing in the code to point at.

**Recommendation.** Move the capacity check above `take_png` (`if (len as usize) < engine.png_len() { return fail(...) }`), which makes the protocol retryable and matches what `read_pixels` already does correctly. Keep the `Data` from Skia rather than `to_vec()`-ing it (`png: Option<skia_safe::Data>`) and copy once, straight to the host pointer. For pixels, copy from the pixmap to `out` directly instead of materialising a `Vec`. And make the host-facing pixel format explicit by using `Surface::read_pixels` with `ImageInfo::new(dims, ColorType::RGBA8888, AlphaType::Unpremul, None)` — Skia unpremultiplies and swizzles for free, the bytes then match what PNG and every image-diff tool expect, and the doc comment stops being a claim nobody verified.

**Verifier — confirmed.** All three sub-claims check out and the first is a genuine, undocumented bug. lib.rs:447 `let png = engine.take_png();` executes before the capacity check at lib.rs:448-453, and engine.rs:250-252 `take_png` is `std::mem::take(&mut self.png)`, so on the CAPACITY path the moved `Vec` drops at the end of the closure and the encoded frame is unrecoverable — a retry then copies zero bytes and returns `status::OK`, i.e. a zero-byte PNG with no error. The contrast the finding draws is exact: lib.rs:394-403 checks capacity before copying and is retryable. Double copy confirmed: engine.rs:245 `self.png = data.as_bytes().to_vec()` then lib.rs:454 `copy_nonoverlapping`, and engine.rs:258 `pixmap.bytes()?.to_vec()` then lib.rs:403. Retention confirmed: `png: Vec<u8>` (engine.rs:132) is held until the next encode or a take. Premultiplication label confirmed: engine.rs:160 `raster_n32_premul` versus lib.rs:380 and host.ts:438 both saying only 'BGRA_8888'. The one mitigation, which the finding does not mention, is that the shipped host cannot trigger the destructive path: host.ts:459-468 `readPng()` allocates exactly `size[0]` from `encode_png`, so `len == png.len()`. That keeps it at low — which is the severity claimed.

<a id="f-engine-paint-text-hit-test-hardcodes-node-zero-as-root"></a>

### LOW · hit_test walks from node 0 while paint walks from config.root

`correctness` · `engine-paint-text/hit-test-hardcodes-node-zero-as-root`

**Where:** `native-src/dziri-engine/src/paint.rs:252`, `native-src/dziri-engine/src/engine.rs:574-576`, `native-src/dziri-engine/src/engine.rs:181`

**Claim.** The root node index is configurable and threaded through paint and layout read-back, but `hit_test` ignores it and starts its traversal at a literal 0.

**Evidence.** paint.rs:252 `let mut stack = vec![0usize];` versus paint.rs:122 `let mut stack = vec![root];` in `paint`, which receives `self.root` from engine.rs:365. `Engine::hit_test` (engine.rs:574-576) calls `hit_test(&self.tables, self.tree.bounds(), x, y)` with no root argument at all, while `Engine::root` is set from `config.root as usize` (engine.rs:181) and `dziri_engine_create` accepts it from the host (src/engine/host.ts:188 `u32v[9] = options.root ?? 0`, and src/ir.ts:366 declares `root: number`).

**Impact.** Latent rather than live — app/ui.gen.ts:173 currently emits `root = 0` — but the moment a compiler change or a second entry point makes the root non-zero, every mouse event resolves against a different subtree than the one on screen: hover and click land on whatever node 0 happens to be, and `hit_test`'s bounds check against `bounds[0]` (which is `[0,0,0,0]` for an unlaid-out node) rejects immediately, so hit testing returns -1 for the entire window and the UI becomes unclickable with no error anywhere.

**Recommendation.** Give `hit_test` the same `root: usize` parameter `paint` already has and pass `self.root` from `Engine::hit_test`, then add a bounds test in native-src/dziri-engine/tests/bounds.rs that builds a tree with `root = 1` and asserts a click resolves — the divergence is only cheap to fix while it is still theoretical.

**Verifier — confirmed.** Exactly as described, and I could not find a compensating path. paint.rs:252 `let mut stack = vec![0usize];` in `hit_test` versus paint.rs:122 `let mut stack = vec![root];` in `paint`, which receives `self.root` from engine.rs:364. `Engine::hit_test` (engine.rs:574-576) and the three `pump_input` call sites (engine.rs:415, 432, 448) all call the free function with no root argument, while `Engine::root` comes from `config.root as usize` (engine.rs:181) and the host passes it through (`u32v[9] = options.root ?? 0`, host.ts:188; `root?: number`, host.ts:134). The failure mode is also right: layout.rs:242-256 zero-fills `bounds` and walks from `self.root`, so with root != 0 `bounds[0]` stays `[0,0,0,0]`, `px >= x + w` rejects at paint.rs:266, the stack empties, and every hit test returns -1 — an unclickable window with no error. Latent only because app/ui.gen.ts:173 `export const root = 0`. Low is the right severity and the one-parameter fix plus a `root = 1` bounds test is the right remedy.

---

## Windowing, input & threading

*11 findings — 1 high, 2 medium, 8 low.*

- **high** · [`SDL_StartTextInput` is never called, so TEXT_INPUT never fires and the IME is inert](#f-window-input-threading-text-input-never-started)
- **medium** · [SDL3 pins pump AND present to the main thread, so A0 step 3's render thread cannot exist](#f-window-input-threading-sdl3-main-thread-forecloses-render-thread)
- **medium** · [Every test is headless, so window/input/present is untested; two drivers duplicate it](#f-window-input-threading-windowed-path-has-zero-coverage-two-drivers)
- **low** · [No thread identity is recorded or checked; the FFI handle erases the engine's `!Send`](#f-window-input-threading-no-thread-identity-assertion)
- **low** · [A failed `Window::resize` desynchronizes surface and texture sizes without poisoning](#f-window-input-threading-failed-resize-desyncs-surface-and-texture)
- **low** · [`unsafe_textures` is avoidable: `SDL_GetWindowSurface` has no texture lifetime at all](#f-window-input-threading-unsafe-textures-avoidable-via-window-surface)
- **low** · [hovered/pressed/focused ids survive growth, relinks, hiding and focus loss unvalidated](#f-window-input-threading-stale-input-state-never-invalidated)
- **low** · [`hit_test` hardcodes node 0 as the root while `paint` uses the configured root](#f-window-input-threading-hit-test-ignores-configured-root)
- **low** · [Motion coalesced on node change loses cursor position; the queue is an unbounded Vec](#f-window-input-threading-mouse-move-coalesced-on-node-identity)
- **low** · [Static SDL's feature set is host-dependent, Skia downloads binaries, no notice file](#f-window-input-threading-static-sdl-build-reproducibility-and-notices)
- **low** · [15 MB of retired-prototype DLLs sit in the engine's own load directory, unreferenced](#f-window-input-threading-dead-prebuilt-natives-in-load-path)

<a id="f-window-input-threading-text-input-never-started"></a>

### HIGH · `SDL_StartTextInput` is never called, so TEXT_INPUT never fires and the IME is inert

`correctness` · `window-input-threading/text-input-never-started`

**Where:** `native-src/dziri-engine/src/window.rs:183`, `native-src/dziri-engine/src/engine.rs:479`, `src/window-host.ts:268`, `native-src/dziri-engine/Cargo.toml:21`

**Claim.** SDL3 does not deliver text-input events until `SDL_StartTextInput(window)` is called, and the engine never calls it, so `SdlEvent::TextInput` never fires, `EventKind.TEXT_INPUT` is never queued, and the whole editable-text path in the host is dead code.

**Evidence.** The pinned header is explicit (sdl3-sys-0.6.7+SDL-3.4.12 keyboard.rs:468): "Text input events are not received by default." for `SDL_StartTextInput`. A grep for `start_text_input|StartTextInput|text_input` across native-src/dziri-engine/src and examples finds only window.rs:183 `SdlEvent::TextInput { text, .. } => out.push(RawInput::Text { text })` — the consumer, never the enabler. The safe wrapper exists and is unused: sdl3-0.18.4 keyboard/mod.rs:224 `#[doc(alias = "SDL_StartTextInput")]`. Meanwhile Cargo.toml:21-23 justifies the whole dependency choice on this: "SDL3 rather than winit: winit's IME is documented as unstable for CJK, and an input abstraction cannot fix events that never arrive", and window.rs:8-12 repeats it.

**Impact.** `typeInto(editables, event.node, ...)` (src/window-host.ts:269) can never run, so every editable in the compiled app silently ignores typing; only BACKSPACE and ESCAPE work, because those arrive as KEY_DOWN. More seriously, the argument that decided SDL3 over winit — CJK users being able to type — is completely unexercised: `SDL_StartTextInput` is also what activates the platform IME, and `SDL_SetTextInputArea` (the call that positions the candidate window at the caret) is likewise absent, so even once text input is enabled a CJK composition popup will render in the wrong place. The dependency was chosen for a capability the code does not yet reach.

**Recommendation.** Call `sdl3::keyboard::start_text_input(window)` in `Window::new` (or, better, on focus acquisition so the on-screen keyboard is not summoned on mobile-ish backends), and call `SDL_SetTextInputArea` with the focused node's bounds whenever `state.focused` changes — the engine already has the rect from `tree.bounds_of`. Then handle `SDL_EVENT_TEXT_EDITING` too: composition preedit is currently dropped by window.rs:185's `_ => {}`, which means a CJK user sees nothing until commit. While there: `Event.b` is unused for KEY_DOWN (engine.rs:472-477) while SDL's `keymod` is right there in the event, so Ctrl+A is indistinguishable from A — fill `b` with the modifier mask.

**Verifier — confirmed.** I tried hard to break this and could not. window.rs:183 consumes SdlEvent::TextInput; nothing in the repo ever enables it — grep for text_input/StartTextInput across native-src/dziri-engine/src, examples, tests and src/ returns only the consumer, protocol constants and src/window-host.ts:268. The safe wrapper is present and unused (sdl3-0.18.4 keyboard/mod.rs:224 TextInputUtil::start, reached via VideoSubsystem::text_input(); note the recommendation's `sdl3::keyboard::start_text_input(window)` is not the real API name). The header is explicit: "Text input events are not received by default." (sdl3-sys keyboard.rs:468). SDL's own Windows backend proves the gate: WM_CHAR and WM_UNICHAR only call SDL_SendKeyboardText when SDL_TextInputActive(window) (SDL_windowsevents.c:1629, 1640), and raw-key delivery also branches on window->text_input_active (SDL_windowsevents.c:1615). So EventKind.TEXT_INPUT can never be queued, and src/window-host.ts:269-274's typeInto path over generated editables (app/ui.gen.ts:105-107, node 32 bound to `draft`) is dead — only BACKSPACE/ESCAPE work via KEY_DOWN. SDL_SetTextInputArea is likewise absent. This is not fully covered by the documented deferral: ROADMAP.md:66 defers the *IME proof* and NOTES.md:171 claims "Text input is decoded but no IME work has been done" — the latter is inaccurate, since plain Latin typing into a shipped editable is also broken.

<a id="f-window-input-threading-sdl3-main-thread-forecloses-render-thread"></a>

### MEDIUM · SDL3 pins pump AND present to the main thread, so A0 step 3's render thread cannot exist

`architecture` · `window-input-threading/sdl3-main-thread-forecloses-render-thread`

**Where:** `native-src/dziri-engine/src/engine.rs:9`, `native-src/dziri-engine/src/window.rs:122`, `native-src/dziri-engine/src/window.rs:102`, `native-src/dziri-engine/src/window.rs:136`

**Claim.** The engine's stated next architectural step — moving the frame loop onto its own thread so "a resize or a caret blink repaints while Bun is busy" — is foreclosed by SDL3, because not just event pumping but every renderer and texture call in `Window` is documented main-thread-only.

**Evidence.** engine.rs:11-17 commits to the move: "The roadmap has the engine owning the frame loop on its own thread, so a resize or a caret blink repaints while Bun is busy — [`Tables`]'s staged/live split is already the mechanism that makes that safe... That move is A0's step 3". But every SDL entry point `Window` uses carries the same restriction in the pinned headers (sdl3-sys-0.6.7+SDL-3.4.12): SDL_PumpEvents (events.rs:2090) "This function should only be called on the main thread."; SDL_PollEvent (events.rs:2403) same; SDL_UpdateTexture (render.rs:2002) same; SDL_RenderTexture (render.rs:3332) same; SDL_CreateTexture (render.rs:1032) same; SDL_DestroyTexture (render.rs:3825) same. `Window::present` calls three of those (`self.texture.update(...)`, `self.canvas.copy(...)`, `self.canvas.present()`, window.rs:123-131) and `Window::resize` calls the other two (window.rs:106-115).

**Impact.** The staged/live split solves the *data* half of the concurrency problem and none of the *thread affinity* half. A render thread built on this design would call SDL_UpdateTexture/SDL_RenderTexture off the main thread; on macOS that is AppKit-from-a-secondary-thread, i.e. a crash or a silent hang inside Cocoa, and on Windows/Linux it is undefined-but-usually-works, which is worse because it will pass local testing and fail on one user's machine. The concrete consequence *today* is the mirror of the problem the roadmap identified: during a live window drag, macOS and Windows run a nested modal event loop inside SDL_PumpEvents, so the whole `while (running)` loop in src/window-host.ts:239 blocks there — no JS runs, no timers fire, and the window shows a stale frame. The fix the roadmap names cannot remove that.

**Recommendation.** Invert the ownership rather than adding a thread. Either (a) the engine takes the process main thread via SDL3's callback entry points (`SDL_EnterAppMainCallbacks` / `SDL_AppIterate`, sdl3-sys init.rs:380-449) and calls *into* Bun per frame, so pump+present are on thread 0 by construction; or (b) keep pump+present on the main thread and confine the "render thread" to commit+layout+paint into an off-screen Skia surface, marshalling the present with `SDL_RunOnMainThread` (sdl3-sys init.rs:685, available since SDL 3.2 and present in the pinned 3.4.12). Option (b) preserves the current FFI shape; option (a) is what actually delivers caret blink and resize repaint without Bun. Whichever is chosen, the comment at engine.rs:11-17 should stop promising the version that cannot work.

**Verifier — weakened.** Renderer/texture/pump calls are main-thread-only, but SDL3's "main thread" is the SDL_Init(VIDEO) thread on every non-Apple platform, so an engine-owned frame-loop thread that owns SDL init is supported and defined on Windows/Linux. The real constraint is macOS-specific (main() thread), where the roadmap's step 3 needs SDL_EnterAppMainCallbacks or an event-watch design — and neither a render thread nor SDL_RunOnMainThread removes the live-resize modal-loop stall, since RunOnMainThread callbacks are dispatched during event processing.

<a id="f-window-input-threading-windowed-path-has-zero-coverage-two-drivers"></a>

### MEDIUM · Every test is headless, so window/input/present is untested; two drivers duplicate it

`testing` · `window-input-threading/windowed-path-has-zero-coverage-two-drivers`

**Where:** `native-src/dziri-engine/tests/bounds.rs:34`, `native-src/dziri-engine/tests/boundary.rs:25`, `src/engine/upload.test.ts:56`, `src/engine/smoke.test.ts:184`, `native-src/dziri-engine/examples/window.rs:255`

**Claim.** All three test suites construct the engine with `windowed: 0`/`false`, and `pump_input` early-returns when there is no window, so `Window::new`, `poll`, `present`, `resize`, CLICK synthesis, focus acquisition and the texture destroy have no coverage of any kind — and the only two things that exercise them are two divergent hand-written loops.

**Evidence.** tests/bounds.rs:34 `windowed: 0`, tests/boundary.rs:25 `windowed: 0`, src/engine/upload.test.ts:56 `windowed: false`. `pump_input` opens with `let Some(window) = self.window.as_mut() else { return Ok(()) };` (engine.rs:387-389), so headless ticks never reach any input code. src/engine/smoke.test.ts:184 even asserts the absence: `expect(engine.drainEvents().length).toBe(0)`. The two drivers are examples/window.rs:255-280 and src/window-host.ts:239-288, and they are near-duplicates of the same logic — drain 32 events, switch on QUIT/CLICK/RESIZE, sleep 8ms — with different subsets handled (the example handles RESIZE and prints it; app.ts handles TEXT_INPUT and KEY_DOWN and ignores RESIZE). There is no CI: the repo has no `.github` directory, so neither driver runs anywhere but on the author's Windows machine.

**Impact.** Every finding above about `present`, `resize`, CLICK, focus and event ordering is unfalsifiable by the test suite — including the texture-lifetime reasoning at window.rs:192-195, which is the justification for `unsafe_textures`. The two drivers will drift (they already have: five of the eight event kinds — MOUSE_MOVE, MOUSE_DOWN, MOUSE_UP, FOCUS, RESIZE — have no consumer in app.ts at all, so the engine synthesizes and queues events nobody reads, and `RawInput::FocusChanged`'s stated purpose, "a caret should stop blinking" at window.rs:37, has no implementation on either side). The example is the more complete driver and the app is the shipped one.

**Recommendation.** Two things. (1) Make the input pipeline testable without a window by splitting `pump_input` into `poll` (SDL, untestable) and `apply(&mut self, inputs: Vec<RawInput>)` (pure, testable) — then drive `apply` with synthetic `RawInput` sequences in tests/bounds.rs and assert CLICK-on-same-node, click-then-drag-off cancels, focus acquisition, and resize coalescing. That is the single highest-value test addition available and it needs no display. (2) Delete the duplicated loop: make `examples/window.rs` construct the tables and then hand off to one shared `run(engine)` driver in the crate, so the example and any future Rust host cannot drift from each other. Add a GitHub Actions matrix (windows/macos/ubuntu) that at minimum runs `cargo test`, `cargo build --example window` and `bun run engine:smoke` — the macOS leg would have caught the threading question before it became an architecture.

**Verifier — confirmed.** Every element verified. tests/bounds.rs:34 and tests/boundary.rs:25 use `windowed: 0`; src/engine/upload.test.ts:56 and src/engine/smoke.test.ts:49 use `windowed: false`; pump_input early-returns with no window (engine.rs:387-389); src/engine/smoke.test.ts:184 asserts `events cross the boundary as data`. So Window::new, poll, present, resize, CLICK synthesis (engine.rs:451-459), focus acquisition (engine.rs:435-436) and the unsafe destroy (window.rs:115) have zero automated coverage — including the texture-lifetime reasoning at window.rs:192-195 that Cargo.toml:25-28 rests on. The two drivers are near-duplicates with divergent coverage (examples/window.rs:263-273 handles QUIT/CLICK/RESIZE; src/window-host.ts:253-281 handles QUIT/CLICK/TEXT_INPUT/KEY_DOWN), so MOUSE_MOVE, MOUSE_DOWN, MOUSE_UP, FOCUS and RESIZE have no consumer in the shipped host, and RawInput::FocusChanged's stated purpose (window.rs:37 'a caret should stop blinking') is unimplemented on both sides. There is no .github directory and native/ contains only win32-x64, so nothing runs on macOS or Linux. The split-pump_input-into-poll+apply recommendation is sound and would have made findings 3, 4, 7 and 9 falsifiable.

<a id="f-window-input-threading-no-thread-identity-assertion"></a>

### LOW · No thread identity is recorded or checked; the FFI handle erases the engine's `!Send`

`soundness` · `window-input-threading/no-thread-identity-assertion`

**Where:** `native-src/dziri-engine/src/lib.rs:44`, `native-src/dziri-engine/src/window.rs:53`, `native-src/dziri-engine/src/error.rs:25`, `src/engine/host.ts:84`

**Claim.** There is no thread assertion anywhere in the engine: `with()` validates a magic number and a poison flag but not thread identity, so any thread holding the `*mut Handle` can call `dziri_engine_tick` and drive SDL from the wrong thread with no diagnostic.

**Evidence.** `with()` (lib.rs:44-72) checks exactly three things — null, `handle.magic != MAGIC`, `handle.engine.poisoned` — and nothing else. A grep for `thread` across native-src/dziri-engine/src returns only doc-comment prose ("render thread's stack") plus `error.rs`'s `thread_local!`; there is no `ThreadId`, no `SDL_IsMainThread`, no `debug_assert`. `Engine` is *implicitly* `!Send` because it owns `Sdl`, `EventPump` and `WindowCanvas` (window.rs:41-50), but lib.rs:53 launders it through `&mut *handle` from a raw pointer, which discards that guarantee entirely — Rust's checker never sees the cross-thread call. Compounding it, error.rs:25-32 keeps `LAST_ERROR` in a `thread_local!`, and `dziri_last_error` (lib.rs:91) reads the *calling* thread's copy.

**Impact.** A Bun `Worker`, or any future refactor that moves `tick()` off the entry thread, compiles and runs and then dies inside AppKit on macOS with no message — and because `LAST_ERROR` is thread-local, even the failures that *are* caught report an empty string to the host, so the one diagnostic channel goes silent exactly when it is needed. There is no macOS or Linux CI in the repo (no `.github` directory; `native/` contains only `win32-x64`), so this path has never been executed on the platform where it is fatal.

**Recommendation.** Two cheap, immediate additions. (1) Store `std::thread::current().id()` in `Engine::new` and compare it at the top of `with()`, returning a new `status::WRONG_THREAD` on mismatch — that turns an AppKit crash into a status code the host can print. (2) When `config.windowed != 0`, call `sdl3_sys::init::SDL_IsMainThread()` before `sdl3::init()` and refuse to create the window if it returns false, so the failure lands at startup with a clear message rather than at the first present. Also move `LAST_ERROR` to a `Mutex<String>` (or store the message on the `Handle`) so a wrong-thread failure is still reportable.

**Verifier — weakened.** There is genuinely no thread assertion and adding one (ThreadId compare in with(), SDL_IsMainThread before window creation on Apple) is cheap hardening — but this is a documented not-yet-thread-safe engine (ROADMAP.md:92, NOTES.md:168-170) with no caller that can trip it, and the thread-local LAST_ERROR is read on the same thread that failed, so the 'empty error message' impact does not occur.

<a id="f-window-input-threading-failed-resize-desyncs-surface-and-texture"></a>

### LOW · A failed `Window::resize` desynchronizes surface and texture sizes without poisoning

`soundness` · `window-input-threading/failed-resize-desyncs-surface-and-texture`

**Where:** `native-src/dziri-engine/src/engine.rs:529`, `native-src/dziri-engine/src/window.rs:102`, `native-src/dziri-engine/src/window.rs:122`

**Claim.** `Engine::resize` replaces `self.surface` before resizing the window and updates `self.width/height` only after both succeed, so if `SDL_CreateTexture` fails the engine keeps a new-size Skia surface, an old-size SDL texture and old-size layout dimensions — and returns a recoverable status rather than poisoning.

**Evidence.** engine.rs:529-539:
```rust
self.surface = surfaces::raster_n32_premul((width as i32, height as i32))
    .ok_or_else(...)?;
if let Some(window) = self.window.as_mut() {
    window.resize(width, height)?;   // <-- bails here, surface already replaced
}
self.width = width;
self.height = height;
```
`Window::resize` returns `Err` when `create_texture_streaming` fails (window.rs:106-109) leaving `self.texture`, `self.width`, `self.height` at the old values. `present` then does `self.texture.update(None, pixels, pitch)` (window.rs:123) where `pixels`/`pitch` come from the *new* surface (engine.rs:372-382). SDL_UpdateTexture reads `pitch * texture_height` bytes from the caller's pointer; `catch_unwind` in lib.rs cannot see a read past the end of a Skia pixmap. `dziri_engine_resize` maps the error to `status::SDL` (lib.rs:292-295), and only `status::PANIC` sets `poisoned` (lib.rs:68-70), so the engine remains willing to tick.

**Impact.** Reachable via the public `dziri_engine_resize` entry point or an OS resize to a size exceeding the renderer's max texture dimension (dragging across a 4K monitor), plus OOM. If the new surface is *shorter* than the old texture, the next `present` reads out of bounds past the Skia pixmap — an out-of-bounds read that no guard catches. Both drivers currently abort on a non-OK tick (src/window-host.ts:245 throws via `check`, examples/window.rs:256 breaks), so it is latent rather than live; but the FFI contract advertises errors as recoverable, and any host that logs-and-continues gets the OOB read.

**Recommendation.** Resize the window first and the Skia surface second, so a texture failure leaves everything at the old size and the operation is genuinely atomic; or keep the order and set `self.poisoned = true` on any partial failure. Better still, make `present` defensive: it already has both sizes in hand, so `debug_assert_eq!((self.width, self.height), texture_size)` plus an early `Err` when they disagree costs nothing per frame and makes the invariant explicit rather than assumed.

**Verifier — weakened.** The ordering is non-atomic and a failed Window::resize does leave surface/texture/layout sizes disagreeing without poisoning, and sdl3's Texture::update does no length check (render.rs:2537-2597) — but the OOB read needs SDL_CreateTexture to fail on a shrink *and* a host that ignores the returned status, and both current drivers abort on a non-OK tick. Severity is low/latent; swapping the two statements or poisoning on partial failure is the fix.

<a id="f-window-input-threading-unsafe-textures-avoidable-via-window-surface"></a>

### LOW · `unsafe_textures` is avoidable: `SDL_GetWindowSurface` has no texture lifetime at all

`better-alternative` · `window-input-threading/unsafe-textures-avoidable-via-window-surface`

**Where:** `native-src/dziri-engine/Cargo.toml:25`, `native-src/dziri-engine/src/window.rs:41`, `native-src/dziri-engine/src/window.rs:106`

**Claim.** The self-referential borrow the feature works around only exists because the code chose SDL's *renderer* API to blit CPU pixels; SDL's window-surface API has no texture, no texture creator, and therefore no lifetime to erase — and it is the API intended for exactly this job.

**Evidence.** Cargo.toml:25-28 argues: "`unsafe_textures` drops the lifetime linking a texture to its creator. Without it, the canvas, the texture creator and the texture cannot live in one struct — the classic self-referential borrow — and the workarounds are worse than owning one `destroy` call on resize." The premise is that all three must be stored (window.rs:45-47: `canvas`, `creator`, `texture`). But sdl3-0.18.4 video.rs:2279 exposes `pub fn surface<'a>(&'a self, _e: &'a EventPump) -> Result<WindowSurfaceRef<'a>, Error>` — SDL_GetWindowSurface — and video.rs:71 `update_window_rects(&self, rects: &[Rect])` — SDL_UpdateWindowSurfaceRects. With that, `Window` stores only `Sdl`, `VideoSubsystem`, `Window` and `EventPump`; the surface is borrowed per frame and dropped, so there is nothing self-referential and `resize` becomes a no-op (SDL reallocates the window surface itself).

**Impact.** One `unsafe` block and a hand-managed SDL object lifetime persist in the windowing layer for no gain. The current management is in fact correct — `mem::replace` then destroy exactly once (window.rs:111-115), no per-resize leak, and no `Drop` for the final texture because SDL destroys renderer-owned textures with the renderer (window.rs:192-195, correct reasoning) — but the correctness is unverified by any test (every test is `windowed: 0`), so the invariant rests entirely on the comment.

**Recommendation.** Switch `present` to `let mut s = self.window.surface(&self.events)?; /* copy rows */ s.update_window_rects(&damage)?;` and delete `creator`, `texture`, `Window::resize`, the `unsafe { old.destroy() }` at window.rs:115, and the `unsafe_textures` feature. Two bonuses: the borrow signature `surface(&'a self, _e: &'a EventPump)` is SDL's own way of encoding "you must hold exclusive access to the event pump", which is a *stronger* invariant than what the code has now; and `update_window_rects` is precisely the partial-repaint primitive NOTES.md defers ("Damage-rect / partial repaint... Real damage tracking only after a measurement"), so it arrives for free instead of needing a second design. The honest cost: the window-surface path is a software framebuffer with no GPU scaling, so if HiDPI upscaling is ever wanted from the renderer, this closes that door. If the renderer must stay, the safe alternative is to keep only `WindowCanvas` and build a short-lived `Texture` from `canvas.texture_creator()` inside `present` — one SDL_CreateTexture per *painted* frame (already gated by `needs_paint`, engine.rs:285) in exchange for zero `unsafe`.

**Verifier — weakened.** The window-surface API does exist and would remove the self-referential borrow and the one unsafe block, so Cargo.toml:25-28's "the workarounds are worse" is arguably too strong — but this is a tradeoff proposal, not a defect: the current code is correct, and the surface path gives up the guaranteed ARGB8888/n32 byte-identity (window.rs:14-18, 73) plus GPU present, so it needs per-frame format negotiation the finding does not account for.

<a id="f-window-input-threading-stale-input-state-never-invalidated"></a>

### LOW · hovered/pressed/focused ids survive growth, relinks, hiding and focus loss unvalidated

`correctness` · `window-input-threading/stale-input-state-never-invalidated`

**Where:** `native-src/dziri-engine/src/engine.rs:431`, `native-src/dziri-engine/src/engine.rs:497`, `native-src/dziri-engine/src/engine.rs:514`, `native-src/dziri-engine/src/window.rs:154`, `src/engine/upload.ts:144`

**Claim.** `InputState` holds three bare `i32` node ids that are set once and never re-validated: `grow()` does not reset them, hiding a node does not clear them, a list relink can point them at a different item, and window focus loss leaves `pressed` latched.

**Evidence.** `state.pressed = hit; state.focused = hit;` on mouse down (engine.rs:434-435) and nothing clears them afterwards except another mouse event. `grow` (engine.rs:514-520) sets `self.fresh = true` and returns — `self.state` is untouched, even though the host's response to a regrow is `uploader.uploadAll()` (src/window-host.ts:181-184) which rewrites every node row. `RawInput::FocusChanged` only queues an event (engine.rs:497-501): the window can lose focus mid-press and `pressed` stays set. `WindowEvent::Leave`/mouse-leave is dropped by window.rs:154 `_ => {}`, so `hovered` also survives the cursor leaving the window. KEY_DOWN and TEXT_INPUT then ship the stale id straight to the host (engine.rs:474 `node: self.state.focused`, engine.rs:482 same), where src/window-host.ts:269 resolves it by identity: `editables.find((e) => e.node === focused)`.

**Impact.** Three reproducible defects. (1) Alt-tab away while holding the mouse on a button: the button renders `:active` forever, because no MouseUp arrives and FocusLost does not clear `pressed`. (2) Move the cursor off a hovered button by leaving the window: it stays hovered. (3) The architectural one — node ids are list-arena slots that the keyed list runtime recycles, so after a relink or a regrow a focus id captured before the change addresses a *different item*, and keystrokes land in the wrong row's signal. Nothing is memory-unsafe (paint and hit-test both guard with `.get()`, paint.rs:161-162 and 272), but the wrongness is silent.

**Recommendation.** Re-validate the three ids once per tick, immediately after `commit()`, against the live tables: clear any that is `>= node count`, has `hidden != 0`, or has lost `flags::INTERACTIVE`. That is three array lookups per frame and it fixes the relink and hide cases together. Clear `hovered` and `pressed` on `RawInput::FocusChanged { focused: false }` and on `WindowEvent::MouseLeave` (add the arm at window.rs:154). Longer term, the real fix is that focus should not be a raw slot index at all: give focusable nodes a compiler-assigned stable identity (the same keyed identity the list runtime already computes) and resolve it to a slot per frame, so recycling a slot cannot silently redirect keyboard input.

**Verifier — weakened.** Real: pressed stays latched while the window is unfocused (cleared on refocus by SDL's WIN_CheckAsyncMouseRelease) and hovered survives the cursor leaving the window (window.rs:154 drops MouseLeave); focused can point at a hidden or orphaned node. Not real: the list runtime deliberately never recycles node ids and keeps slot-key identity across relinks (list-runtime.ts:10-12, 75-84, 228-237), so a relink or regrow does not silently redirect keystrokes to a different visible item, and engine.rs's grow() leaving state alone is consistent with that design.

<a id="f-window-input-threading-hit-test-ignores-configured-root"></a>

### LOW · `hit_test` hardcodes node 0 as the root while `paint` uses the configured root

`correctness` · `window-input-threading/hit-test-ignores-configured-root`

**Where:** `native-src/dziri-engine/src/paint.rs:244`, `native-src/dziri-engine/src/paint.rs:252`, `native-src/dziri-engine/src/engine.rs:181`

**Claim.** `EngineConfig.root` is honoured by paint and layout but not by hit-testing, which always walks from node 0.

**Evidence.** `paint` takes `root: usize` and starts there — paint.rs:122 `let mut stack = vec![root];`. `hit_test` takes no root at all — paint.rs:244 `pub fn hit_test(tables: &Tables, bounds: &[[f32; 4]], px: f32, py: f32) -> i32` — and paint.rs:252 hardcodes `let mut stack = vec![0usize];`. Meanwhile `Engine` stores the configured value (engine.rs:181 `root: config.root as usize`), passes it to paint (engine.rs:364) and to `tree.rebuild` (engine.rs:305), but calls hit-testing without it in all three call sites (engine.rs:415, 432, 448, 575).

**Impact.** Any `root != 0` gives a UI that paints one tree and hit-tests another: hover, press, click and focus all resolve against whatever subtree hangs off node 0. It is dormant only because `app/ui.gen.ts:173` currently emits `export const root = 0`. The moment the compiler emits a non-zero root — a wrapper node, a portal, a per-window subtree — input silently targets the wrong tree, and because paint still looks right the bug presents as "clicks do nothing".

**Recommendation.** Add a `root: usize` parameter to `hit_test` and pass `self.root` from all four call sites; the signature change makes the omission impossible to repeat. Then add a regression test in tests/bounds.rs that builds a tree with `root: 1` and asserts a hit inside the root subtree resolves, since nothing today would catch this.

**Verifier — confirmed.** Correct as stated, but exposure is lower than implied: the compiler's pre-order numbering (src/compiler/compile.ts:419-431) makes root == 0 a structural property, not a coincidence, so only a hand-written host passing EngineConfig.root != 0 can trip it.

<a id="f-window-input-threading-mouse-move-coalesced-on-node-identity"></a>

### LOW · Motion coalesced on node change loses cursor position; the queue is an unbounded Vec

`architecture` · `window-input-threading/mouse-move-coalesced-on-node-identity`

**Where:** `native-src/dziri-engine/src/engine.rs:414`, `native-src/dziri-engine/src/engine.rs:112`, `native-src/dziri-engine/src/engine.rs:551`, `src/window-host.ts:252`, `src/window-host.ts:288`

**Claim.** The engine emits a MOUSE_MOVE only when the hit node changes, which discards every intra-node position; and the queue it emits into is an unbounded `Vec<Event>` drained 32-at-a-time by hosts that never call again.

**Evidence.** engine.rs:416-427:
```rust
let hit = hit_test(...);
if hit != self.state.hovered {
    self.state.hovered = hit;
    self.needs_paint = true;
    self.events.push(Event { kind: event_kind::MOUSE_MOVE, node: hit, x, y, ..Default::default() });
}
```
So `x`/`y` are only ever the coordinates of a boundary crossing. The queue is `events: Vec<Event>` (engine.rs:112) with no cap; `drain_events` moves `out.len().min(self.events.len())` (engine.rs:552). lib.rs:246-247 documents the contract — "`*written` is how many were moved; call again while it equals `capacity`" — and neither driver does: src/window-host.ts:252 is a single `for (const event of engine.drainEvents())` (default max 32, host.ts:329), and examples/window.rs:261 is a single `engine.drain_events(&mut events)` over a 32-slot buffer. ROADMAP.md specifies an "event ring buffer"; this is neither ring nor bounded.

**Impact.** Coalescing on node identity forecloses everything that needs a position stream: drag, resize handles, text selection, slider thumbs, tooltips that follow the cursor, and hover effects keyed to position within a node — all of which A3 needs and none of which can be built on "one event when you cross a boundary". Separately, the unbounded queue plus a non-looping 32-per-frame drain means a burst over 32 events defers the rest by a frame, including QUIT, so a close click during a busy frame appears to be ignored; and if the host ever stalls (a long synchronous compile, a GC pause), the queue grows without limit at 56 bytes an entry with no drop policy and no diagnostic. Pacing compounds it: there is no vsync (sdl3 0.18.4 does not even wrap `SDL_SetRenderVSync` — only GL swap interval, video.rs:637), so `present` returns immediately and both drivers hand-roll a spin: `await Bun.sleep(8)` (src/window-host.ts:288) and `thread::sleep(8ms)` (examples/window.rs:279). The process wakes 125 times a second forever, even fully idle, and frames are presented mid-scanout.

**Recommendation.** Coalesce on the *frame*, not on the node: keep the latest `(x, y)` in a scratch field during `pump_input` and emit exactly one MOUSE_MOVE per tick carrying that position plus the resolved node. That preserves position for drag and selection, bounds the queue by construction (at most one move event per tick), and is strictly less work than today. Then make the queue a genuine bounded ring (`VecDeque` with a capacity, or a fixed `[Event; N]`) with an explicit policy — drop-oldest and set an `overflowed` flag the host can read — so "the queue filled" is observable rather than either silent or unbounded. For pacing, call `sdl3_sys::render::SDL_SetRenderVSync(renderer, 1)` (render.rs:4018; the safe wrapper omits it) so present blocks on the compositor and the sleep-spin can go away, or adopt the window-surface path where pacing is the compositor's problem.

**Verifier — weakened.** MOUSE_MOVE carrying only boundary-crossing coordinates and the drain-32-once pattern are real and worth fixing (one coalesced move per tick; loop the drain), and the no-vsync sleep-spin is confirmed. But the queue cannot grow unboundedly during a host stall — pumping happens only inside tick() — and 'foreclosed' overstates a change confined to engine.rs:414-428.

<a id="f-window-input-threading-static-sdl-build-reproducibility-and-notices"></a>

### LOW · Static SDL's feature set is host-dependent, Skia downloads binaries, no notice file

`process` · `window-input-threading/static-sdl-build-reproducibility-and-notices`

**Where:** `native-src/dziri-engine/Cargo.toml:29`, `native-src/dziri-engine/build.rs:4`

**Claim.** The "one artifact" distribution story rests on a build that is reproducible in its *sources* but not in its *capabilities*, requires network access, and ships statically-linked BSD-3 and zlib code with no accompanying notices.

**Evidence.** Cargo.toml:29 `sdl3 = { version = "0.18", features = ["build-from-source-static", "unsafe_textures"] }`. The SDL source itself is pinned (`sdl3-src 3.4.12` appears in native-src/dziri-engine/Cargo.lock:421), which is good — but SDL's CMake build enables backends by probing the *build machine*: an SDL built on a box without `libwayland-dev`/`libdecor-dev` silently produces a binary with no Wayland support, and nothing in the artifact records which backends it got. Separately, skia-bindings 0.87 fetches prebuilt binaries over the network keyed by target+feature set — skia-bindings-0.87.0/build.rs:108 `let build_skia = build_support::binary_cache::try_prepare_download(&binaries_config);` — falling back to a full depot_tools/GN/ninja Skia build if no matching release exists. Neither the download nor its checksum is in Cargo.lock. And there is no LICENSE, NOTICE or THIRD-PARTY file anywhere in the repo (checked at root and one level down).

**Impact.** Three separate costs. (1) A Linux user's IME — the entire reason for choosing SDL3 (Cargo.toml:21) — depends on whether the CI runner happened to have fcitx/ibus headers, and there is no way to tell from the shipped `.so`. (2) `cargo build` is not hermetic: a GitHub release going away, or a feature-flag change that has no prebuilt Skia, turns a 3-minute build into a multi-hour Skia-from-source build on all three platforms — with `lto = true` and `codegen-units = 1` (Cargo.toml:33-34) on top. (3) Static linking is exactly the case where notice obligations bite: Skia is BSD-3-Clause, which requires reproducing the copyright notice and disclaimer in materials distributed with a binary; SDL's zlib licence is satisfied by not misrepresenting origin but the bundled Rust crates are MIT/Apache-2.0, and Apache-2.0 §4 requires the NOTICE file be carried. Shipping today would be a licence violation, and it is trivially fixable now versus awkwardly later.

**Recommendation.** (1) Pin the SDL feature surface explicitly rather than letting CMake probe: pass the SDL CMake options you require (`SDL_WAYLAND=ON`, `SDL_X11=ON`, `SDL_IBUS=ON`, ...) so a build machine missing a header *fails* instead of silently degrading, and add a `dziri_engine_backends()` FFI call that reports `SDL_GetCurrentVideoDriver()` plus IME availability so a bug report can say which build it is. (2) Build the engine in a container per platform and record the toolchain versions alongside the artifact; check the resolved skia-binaries URL and SHA into the repo and set `SKIA_BINARIES_URL`/offline mode in CI so a build cannot silently become a source build. (3) Add `cargo-about` or `cargo-deny --license` to CI and generate a `THIRD-PARTY.md` from the lockfile; ROADMAP.md:567-569 already flags signing and notarization as prerequisites, and notices belong in the same batch.

**Verifier — weakened.** Substantively right that SDL backends are auto-probed (sdl3-sys passes no explicit CMake backend options) and that skia-bindings downloads unpinned prebuilt binaries by default (binary-cache in default features), but build.rs:4 is mis-cited — the local build.rs only links Windows system libs. Notices/hermetic CI are D2 prerequisites already scheduled in ROADMAP.md and nothing ships yet, so this is a process to-do, not a live violation.

<a id="f-window-input-threading-dead-prebuilt-natives-in-load-path"></a>

### LOW · 15 MB of retired-prototype DLLs sit in the engine's own load directory, unreferenced

`cleanliness` · `window-input-threading/dead-prebuilt-natives-in-load-path`

**Where:** `native/win32-x64/libSkiaSharp.dll:1`, `native/win32-x64/taffy_ffi.dll:1`, `native/win32-x64/SDL3.dll:1`, `src/engine/host.ts:74`

**Claim.** `native/win32-x64/` holds `libSkiaSharp.dll` (12.3 MB), `SDL3.dll` (2.8 MB), `taffy_ffi.dll` (0.4 MB) and `probe.json`, none of which any code loads — and that same directory is the fallback search path for the real engine binary.

**Evidence.** `libraryPath()` (host.ts:64-82) looks only for `dziri_engine.dll`/`libdziri_engine.dylib`/`libdziri_engine.so` in two candidates, the second being `native/${process.platform}-${process.arch}/` (host.ts:74). A grep across all .ts/.json/.md/.toml/.rs for `libSkiaSharp|taffy_ffi|probe.json|SDL3.dll` finds only prose in NOTES.md and ROADMAP.md plus doc comments in the retired probe crates — no loader. NOTES.md:481-482 confirms the intent: "`bun run natives`, `bun run probe` and `bun run m1` are gone: nothing fetches `libSkiaSharp` or `SDL3.dll` any more, because the engine links its own." The scripts that produced them are gone too — `scripts/` contains only `gen-protocol.ts`, and package.json has no `natives`/`probe`/`m1` entries. Also stale: `SDL3-3.4.12-win32-x64.zip` and `skiasharp.nativeassets.win32.4.150.1.nupkg` at the repo root, an empty `.natives-tmp/`, and the `native-src/taffy-ffi` and `native-src/skia-probe` crates (both with their own Cargo.lock).

**Impact.** Mostly weight — 15 MB of binaries plus a ~30 MB zip and nupkg in a repo whose thesis is smallness. But there is a real footgun: `native/win32-x64/` is where `dziri_engine.dll` gets copied for distribution, and Windows resolves a DLL's dependencies from its own directory first. Today the engine links SDL statically so the adjacent `SDL3.dll` is inert; the moment anything links SDL dynamically (a debug build, a future `--features build-from-source` variant), a months-old SDL3 3.4.12 binary is sitting there ready to be picked up in preference to the intended one, and the resulting version skew would be invisible.

**Recommendation.** Delete `native/win32-x64/{libSkiaSharp.dll,taffy_ffi.dll,SDL3.dll,probe.json}`, the root-level `SDL3-*.zip` and `skiasharp.nativeassets.*.nupkg`, and `.natives-tmp/`; keep the `native/<target>/` directory as the engine's distribution slot and add a `.gitignore` for `*.dll`/`*.so`/`*.dylib` under it so a stale binary cannot be committed again. Keep `native-src/skia-probe` — NOTES.md:216 and ROADMAP.md:45 both cite it as the evidence for the skia-safe pin, and text.rs:214-220 still asserts against its number — but retire `native-src/taffy-ffi`: its purpose was the A0 spike measuring Taffy over a C ABI, that measurement is recorded in ROADMAP.md:110-125, and Taffy is now linked directly into the engine.

**Verifier — confirmed.** Accurate on substance; sizes are off (nupkg is 79.5 MB, zip 1.1 MB, so the dead weight is larger than claimed) and the .gitignore advice does not apply — the directory is not a git repo.

---

## Security & supply chain

*11 findings — 2 medium, 9 low.*

- **medium** · [Typed text forces a native realloc + full Taffy rebuild per keystroke, monotonically](#f-security-supplychain-untrusted-text-drives-unbounded-native-realloc)
- **medium** · [No VCS, 95 MB of unverified vendored binaries, no cargo-deny/audit, no CI](#f-security-supplychain-supply-chain-no-vcs-no-audit-no-ci)
- **low** · [No validation of host-written tables; safety rests on scattered `.get().unwrap_or()` sites](#f-security-supplychain-no-single-validation-pass-at-the-commit-boundary)
- **low** · [Unvalidated u16 `gridColumns`/`gridRows` multiply into a per-node Vec allocation](#f-security-supplychain-gridcolumns-u16-allocation-amplification)
- **low** · [The `faces` font cache is unbounded and keyed on host-written f32 bit patterns](#f-security-supplychain-unbounded-font-face-cache)
- **low** · [Cdylib is not one artifact: it imports VCRUNTIME140/MSVCP140, not KnownDLLs](#f-security-supplychain-cdylib-not-self-contained-msvc-runtime)
- **low** · [`app/ui.gen.ts` is an executable artifact with no input stamp; `bun run app` never checks](#f-security-supplychain-generated-artifact-unstamped-and-unchecked)
- **low** · [`dziri_last_error` truncates mid-codepoint; no message leaks memory](#f-security-supplychain-last-error-truncation-splits-utf8)
- **low** · [Untrusted text reaches Skia uncapped and unclipped; A2 and A5 widen the surface](#f-security-supplychain-untrusted-text-to-skia-no-cap)
- **low** · [Capacity requests have no ceiling; allocation failure is an `assert!` that poisons](#f-security-supplychain-capacity-requests-unbounded-oom-poisons)
- **low** · [`hit_test` hardcodes node 0 as root while layout and paint honour the configured root](#f-security-supplychain-hit-test-ignores-configured-root)

<a id="f-security-supplychain-untrusted-text-drives-unbounded-native-realloc"></a>

### MEDIUM · Typed text forces a native realloc + full Taffy rebuild per keystroke, monotonically

`security` · `security-supplychain/untrusted-text-drives-unbounded-native-realloc`

**Where:** `src/engine/upload.ts:101`, `src/engine/upload.ts:144`, `src/window-host.ts:181`, `src/runtime/bindings.ts:95`, `native-src/dziri-engine/src/tables.rs:701`, `native-src/dziri-engine/src/engine.rs:514`

**Claim.** The only genuinely attacker-influenced runtime input (typed text) feeds directly into the engine's capacity request, which is recomputed from live mutable state every frame, is monotonic, and whose satisfaction reallocates three arenas and rebuilds the entire Taffy tree.

**Evidence.** upload.ts:101-114 `export function capacitiesFor(ui: CompiledUi) { let bytes = 0; for (const s of ui.strings) bytes += s.length * 3; ... stringBytes: Math.max(bytes * ARENA_HEADROOM, 4096) }` — `ui.strings` is the live mutable array that `applyTextBindings` writes into (bindings.ts:35 `ui.strings[binding.slot] = next`). src/window-host.ts:181 calls `uploader.ensureCapacity()` on every dirty frame, which does `const want = capacitiesFor(this.#ui); const grew = this.#engine.grow(want)`. bindings.ts:95-99 `if (input.text) { batch(() => { target.signal.value += input.text; }); }` — no length cap anywhere. tables.rs:701-739 `grow` takes `self.caps.string_bytes.max(want.string_bytes)` (never shrinks), builds `let mut grown = Tables::new(caps)` (three fresh `Arena::new`), copies span by span, bumps the generation; engine.rs:518 then sets `self.fresh = true`, so engine.rs:304 takes the `self.tree.rebuild(...)` branch — a `new_leaf_with_context` per node plus `apply_all_styles`. Measured against the real artifact: 48 strings, 1269 worst-case bytes, cap 5076 — already past the 4096 floor, so every single typed character changes the requested capacity by 12 bytes and therefore triggers grow().

**Impact.** Holding a key down in the sample app reallocates ~all engine memory and rebuilds the whole layout tree once per character, and native memory ratchets upward forever because `grow` never shrinks — deleting the text does not give it back. There is no cap, so a paste or an autorepeat burst is an unbounded native allocation loop from ordinary user input. It also silently defeats the incremental string upload the file argues for at upload.ts:22-23: `capacitiesFor` and the `needed` loop at upload.ts:275-278 both walk every string every frame in front of it.

**Recommendation.** Three concrete changes: (1) cap `typeInto` (and every `bindValue` sink) at a documented maximum — e.g. 64 KiB per slot — and drop the keystroke rather than growing; (2) make capacity hysteretic rather than exact: request `nextPowerOfTwo(bytes * ARENA_HEADROOM)` so growth is O(log n) events, not one per character, and only call `grow` when the *current* arena is actually short (track the live cursor instead of recomputing from the IR); (3) track `bytes` incrementally in the `Uploader` as slots change instead of re-scanning `ui.strings` each frame, which also restores the incremental-upload win.

**Verifier — weakened.** Typed text does force a full arena realloc, full re-upload and full Taffy rebuild on every keystroke (verified: stringBytes 5124 -> 5136 -> 5148), and the growth is unnecessary because the arena has 12x headroom. This is a medium-severity performance defect, not a high-severity security issue: there is no network or clipboard input path anywhere in src/, each SDL text event is hard-capped at 32 bytes (engine.rs:50, 479-489), and the 8ms poll loop bounds the ratchet to ~12 KB/s of capacity, so 'unbounded native allocation loop' is wrong.

<a id="f-security-supplychain-supply-chain-no-vcs-no-audit-no-ci"></a>

### MEDIUM · No VCS, 95 MB of unverified vendored binaries, no cargo-deny/audit, no CI

`process` · `security-supplychain/supply-chain-no-vcs-no-audit-no-ci`

**Where:** `package.json:20`, `package.json:23`, `bun.lock:1`, `native-src/dziri-engine/Cargo.toml:19`

**Claim.** The build's integrity story has no floor: there is no repository, no ignore file, no checksum for any vendored binary, no dependency audit for either ecosystem, and the one unpinned dependency re-resolves on every clean install.

**Evidence.** `ls -d .git` → no such file; no `.gitignore`. At repo root: `skiasharp.nativeassets.win32.4.150.1.nupkg` (79,528,972 bytes) and `SDL3-3.4.12-win32-x64.zip` (1,161,314 bytes), with no `.sha256`/`CHECKSUMS` beside them. `native/win32-x64/` holds `libSkiaSharp.dll` (12.2 MB), `SDL3.dll` (2.8 MB), `taffy_ffi.dll` (416 KB) — prebuilt, unsigned-by-us, no provenance record. `native-src/dziri-engine/target/` is in the tree with ~30 build-script `.exe`s and a full SDL3 CMake tree; with no `.gitignore`, a first `git add .` commits all of it. package.json:20 `"@types/bun": "latest"` — bun.lock currently pins `1.3.14` with an integrity hash, but `latest` means a clean `bun install` re-resolves. package.json:23 pins `packageManager: pnpm@10.29.3+sha512...` while every one of the nine scripts invokes `bun` — the corepack guarantee is inert and there is no pnpm lockfile. Cargo.toml:19-29 pulls `skia-safe 0.87` (which builds Skia from source or downloads a prebuilt binary from a third-party release) and `sdl3 0.18` with `build-from-source-static`, i.e. C/C++ compilation of two large upstreams on every dev machine, with no `cargo-deny`, no `cargo audit`, and no CI to run either.

**Impact.** Nothing here is exploited today — the trust boundary is a single developer's machine — but there is currently no way to answer "did this DLL change?", "which Skia commit is in the binary I shipped?", or "does any dependency have a known advisory?". `skia-safe` + `build-from-source-static` means a compromised crates.io release or a compromised skia-binaries GitHub release executes `build.rs` and a C++ toolchain with full user privileges at `cargo build` time, with no record of the change. The 79 MB nupkg and the three DLLs are also *dead*: the built `dziri_engine.dll` imports neither `SDL3.dll` nor `libSkiaSharp.dll` (verified from its import table), and `grep -rn 'libSkiaSharp|SDL3.dll|taffy_ffi' src/ scripts/ app/` returns nothing — so they are 95 MB of unverified binary with no consumer.

**Recommendation.** In order of value per minute: (1) `git init` plus a `.gitignore` covering `target/`, `node_modules/`, `.natives-tmp/`, `*.nupkg`, `*.zip` — everything else here depends on having a baseline; (2) delete the nupkg, the zip, and `native/win32-x64/*.dll` — they are dead, and deleting beats checksumming; (3) pin `@types/bun` to `1.3.14` exactly and either delete `packageManager` or change it to the `bun@x.y.z` actually in use; (4) add a `deny.toml` and one GitHub Action running `cargo deny check advisories bans sources`, `cargo test --release`, `bun test`, and `bun run gen:protocol && git diff --exit-code` (which also catches a hand-edited generated file — the thing gen-protocol.ts:8 asks nobody to do); (5) for A5/D2, pin `skia-safe` to an exact `=0.87.x` and record the `skia-binaries` release SHA-256 in the repo, verified by the build.

**Verifier — confirmed.** I re-checked every factual claim and all of them hold. `ls -d .git` and `ls .gitignore` and `ls -d .github` all fail — no repository, no ignore file, no CI. `skiasharp.nativeassets.win32.4.150.1.nupkg` is 79,528,972 bytes and `SDL3-3.4.12-win32-x64.zip` is 1,161,314 bytes at the root; `native/win32-x64/` holds `SDL3.dll` (2,840,576), `libSkiaSharp.dll` (12,254,048), `taffy_ffi.dll` (416,256); `ls *.sha256 CHECKSUMS*` finds nothing, and there is no `deny.toml` anywhere. `native-src/dziri-engine/target` is 622 MB in-tree with 38 build-script directories, so a first `git add .` with no ignore file would indeed commit it. `package.json:20` is `"@types/bun": "latest"` while `bun.lock` pins `@types/bun@1.3.14` with a sha512 — so a clean install re-resolves. `package.json:23` pins `pnpm@10.29.3+sha512...` while all nine scripts invoke `bun` and there is no pnpm lockfile, making the corepack guarantee inert. `Cargo.toml:19-29` is `skia-safe = { version = "0.87" }` (caret, so 0.87.x floats) and `sdl3 = { version = "0.18", features = ["build-from-source-static", ...] }`, i.e. a C++ toolchain plus either a source build or a third-party prebuilt download running `build.rs` with full user privileges at every `cargo build`. I independently parsed the import table of the built `dziri_engine.dll` and confirmed the three DLLs are dead weight: it imports neither SDL3.dll nor libSkiaSharp.dll, and `grep -rn 'libSkiaSharp|SDL3.dll|taffy_ffi' src/ scripts/ app/` finds only comments. The severity is right for what it is: the trust boundary is one developer's machine and nothing is exploited, but there is genuinely no way to answer 'did this DLL change' or 'is any dependency advisory-affected', and every other item depends on `git init` first. One correction to the recommendation only, not the finding: `native/<platform>-<arch>/` is a live engine-load fallback (`host.ts:73-74`), so delete the three stale DLLs inside it, not the directory.

<a id="f-security-supplychain-no-single-validation-pass-at-the-commit-boundary"></a>

### LOW · No validation of host-written tables; safety rests on scattered `.get().unwrap_or()` sites

`soundness` · `security-supplychain/no-single-validation-pass-at-the-commit-boundary`

**Where:** `native-src/dziri-engine/src/tables.rs:498`, `native-src/dziri-engine/src/layout.rs:368`, `native-src/dziri-engine/src/layout.rs:374`, `native-src/dziri-engine/src/paint.rs:161`, `native-src/dziri-engine/src/paint.rs:79`, `native-src/dziri-engine/src/layout.rs:102`

**Claim.** `Tables::commit` validates nothing — it memcmps and copies. Memory safety against arbitrary host writes is real but is an emergent property of every read site independently remembering `.get(...).unwrap_or(default)`, and the chosen defaults are semantically wrong, so a host bug silently renders the wrong pixels instead of failing.

**Evidence.** tables.rs:498-522 `pub fn commit(&mut self) -> Diff` compares each span and `copy_from_slice`s it; there is no range check on any field. Every consumer then defends individually: layout.rs:368-372 `let slot = tables.u16s(NODES, protocol::nodes::STYLE).get(node).copied().unwrap_or(0) as usize;` then layout.rs:377 `let f32f = |field: usize| -> f32 { tables.f32s(STYLES, field).get(slot).copied().unwrap_or(0.0) };` — an out-of-range style slot yields `width: 0.0`, and tables.rs:220 documents that zero is a real value (`width: 0`, not `auto`, which is NaN). Unvalidated fields, exhaustively: `nodes.style` (u16, never checked against `caps.styles`); `nodes.kind` (paint.rs:212 `.unwrap_or(node_kind::BOX)`, no check against NodeKind variants); `styles.display/flexDirection/flexWrap/justifyContent/alignItems/alignSelf/justifyItems/justifySelf/position` (layout.rs:379-454, every one a `match ... _ => default` that silently absorbs a bad enum — deliberate per the comment at layout.rs:329-332, but indistinguishable from corruption); `styles.gridColumns/gridRows` (see the separate finding); `states.node` (paint.rs:80 `ids.binary_search(&i)` *assumes sorted*, never verified — unsorted rows silently miss); `states.hover/active/focus` (style slots, unchecked); `strings.offset/length` (checked, correctly, at tables.rs:473-491); `nodes.parent` and `nodes.list` are **never read by the engine at all** (`grep -n 'nodes::PARENT' src/*.rs` returns nothing), and the entire `lists` table — `arenaStart/stride/capacity/active` — is likewise never read (only `plan_of(nodes, n::LIST)` at tables.rs:233 and the `classify` arm at tables.rs:531), so the list-consistency question has no engine-side answer: list arenas are a pure Bun-side construct expressed only through `firstChild`/`nextSibling`/`hidden`. Policy is also inconsistent for identical malformed data: layout.rs:102 returns `Err` for an out-of-range child, layout.rs:277-279 `break`s (silently truncating the rest of the sibling chain), paint.rs:140 just stops pushing.

**Impact.** Today this is not a memory-safety hole — I could not find a single unguarded index of a host-derived value, so the hypothesis that any host bug is an OOB is refuted. But the invariant is unwritten and untested: `tests/bounds.rs` and `tests/boundary.rs` contain no case for an out-of-range style slot, an unsorted states table, or a bad enum. The next read site added in A2/A5 that writes `tables.f32s(STYLES, f).get(slot).unwrap()` or indexes directly is an OOB panic or worse, and nothing in CI (there is no CI) would catch it. Meanwhile the current behaviour converts host bugs into invisible wrong renders — a collapsed node instead of a diagnostic.

**Recommendation.** Add `Tables::validate(&self, diff: &Diff) -> Result<(), String>` called from `Engine::tick` immediately after `commit`, driven by the diff so it costs nothing when nothing changed: check `nodes.style < caps.styles`, `nodes.kind <= node_kind::LIST`, `nodes.text < caps.strings`, each `styles.*` enum against its variant set, `states.node` strictly ascending, and `states.{hover,active,focus} < caps.styles`. Return `status::INVALID_ARGUMENT` with the offending (table, field, index) — a Bun-side bug then surfaces at the frame it was introduced. Then replace the `.get().unwrap_or(default)` idiom with plain indexing (or a `#[inline] fn checked(...)` helper) so the validated invariant is load-bearing rather than duplicated 30 times.

**Verifier — weakened.** Accurate that `commit()` validates nothing and that safety is an emergent property of ~30 `.get().unwrap_or()` sites with no test covering an out-of-range style slot, unsorted states, or a bad enum. But the enum-defaulting is documented deliberate design (layout.rs:329-333), string slots are already validated with the exact rationale claimed to be missing (tables.rs:492-511), unsorted states require a compiler bug given upload.ts:236-247, and no unguarded index exists (I checked paint.rs:87-89 and layout.rs:104/302). This is a low-severity hardening/test-coverage gap, not a medium soundness defect.

<a id="f-security-supplychain-gridcolumns-u16-allocation-amplification"></a>

### LOW · Unvalidated u16 `gridColumns`/`gridRows` multiply into a per-node Vec allocation

`security` · `security-supplychain/gridcolumns-u16-allocation-amplification`

**Where:** `native-src/dziri-engine/src/layout.rs:467`, `src/protocol/schema.ts:115`

**Claim.** A single 2-byte write into shared memory turns into a 65535-element Vec per node, re-allocated on every style application.

**Evidence.** schema.ts:115-116 `{ name: "gridColumns", type: "u16", ... }, { name: "gridRows", type: "u16" }`. layout.rs:467-474: `let cols = u16f(f::GRID_COLUMNS); if cols > 0 { s.grid_template_columns = vec![minmax(length(0.0_f32), fr(1.0_f32)); cols as usize]; }` — `cols` is whatever the host wrote, with no ceiling, and `style_of` runs for every node in `apply_all_styles` (layout.rs:131-136), which `resync` calls on any `diff.node_styles` (engine.rs:311).

**Impact.** `gridColumns = 65535` on a style slot worn by the 126-node sample tree allocates ~8M track-sizing functions (hundreds of MB) and hands Taffy a 65535-track grid to place items into, on every restyle. It is not reachable from app *text* today, but it is reachable from any host-side style-patch bug and from any future runtime-computed grid, and it is exactly the shape of amplification a validation pass exists to stop.

**Recommendation.** Cap it in the schema's contract and enforce it in the validation pass: `const MAX_GRID_TRACKS: u16 = 1024;` — reject (or clamp with a recorded error) anything larger. Tailwind's `grid-cols-{n}` tops out at 12, so 1024 is already three orders of magnitude of headroom. Better still, since the tracks are uniform, cache one `Vec` per distinct `cols` value instead of rebuilding it per node.

**Verifier — weakened.** Correct that layout.rs:467-475 allocates an unbounded per-node Vec from an unvalidated u16, but the value is only ever written from compile-time constants: patches.ts:37-46 writes precomputed on/off values and the sole origin is css.ts:309-331 parseTracks over the developer's own stylesheet. No runtime or input path can set it, so this is a low-severity build-time footgun / hardening item, not a medium security issue.

<a id="f-security-supplychain-unbounded-font-face-cache"></a>

### LOW · The `faces` font cache is unbounded and keyed on host-written f32 bit patterns

`security` · `security-supplychain/unbounded-font-face-cache`

**Where:** `native-src/dziri-engine/src/text.rs:57`, `native-src/dziri-engine/src/text.rs:126`, `native-src/dziri-engine/src/text.rs:51`

**Claim.** `Measurer` bounds its advance cache at 4096 entries and explains why, then keeps a second cache — holding Skia `Font` objects — with no bound at all, keyed on a value the host controls.

**Evidence.** text.rs:51 `const ADVANCE_LIMIT: usize = 4096;` with the reasoning at text.rs:48-50 ("Advance widths are cached because dynamic text makes the key space unbounded"), and eviction at text.rs:166-170. But text.rs:57 `faces: HashMap<(u32, u16), Face>` and text.rs:126-150 `pub fn face(&mut self, size: f32, weight: u16) -> &Face { let key = (size.to_bits(), weight); if !self.faces.contains_key(&key) { ... self.faces.insert(key, Face { font, ascent, descent }); }` — never evicted. The key is `size.to_bits()`, and the comment at text.rs:124-125 makes the unboundedness explicit: "Keyed on the size's bit pattern so `16.0` and `16.000001` stay distinct rather than silently merging." `size` comes straight from `styles.fontSize` (f32, host-written: layout.rs:169, paint.rs:204). `typefaces: HashMap<u16, Typeface>` (text.rs:56) is likewise unbounded up to 65536 platform typefaces.

**Impact.** Any animated or per-row font size — a scale transition, a fluid type ramp, a list where rows compute their own size — mints a new Skia `Font` and its metrics per distinct f32 and holds it for the process lifetime. 4 billion possible keys. The same reasoning that produced `ADVANCE_LIMIT` applies verbatim; it was applied to the cheap cache and skipped on the expensive one.

**Recommendation.** Give `faces` the same FIFO bound as `advances` (a shared `BoundedCache<K, V>` with a `VecDeque` of insertion order is ~20 lines and removes the duplication), sized far smaller — 64 faces is generous. Additionally quantise the size key: `((size * 64.0).round() as i32, weight)` gives 1/64-px resolution, finer than Skia's own hinting grid, and collapses the key space by ~7 orders of magnitude without the merging the comment worries about.

**Verifier — weakened.** The faces and typefaces caches are indeed unbounded while advances is capped at 4096 (text.rs:51 vs 57/126-150), and giving faces the same FIFO bound is worth doing. But the key space is not open: fontSize/fontWeight are read only from the styles table (layout.rs:169-170, paint.rs:204-209), whose only writers are compile-time constants (upload.ts:203-223, patches.ts:37-46), so distinct keys are bounded by the compiled style-slot count (48 today). Low, latent until runtime-computed font sizes exist.

<a id="f-security-supplychain-cdylib-not-self-contained-msvc-runtime"></a>

### LOW · Cdylib is not one artifact: it imports VCRUNTIME140/MSVCP140, not KnownDLLs

`security` · `security-supplychain/cdylib-not-self-contained-msvc-runtime`

**Where:** `native-src/dziri-engine/Cargo.toml:29`, `src/engine/host.ts:64`, `src/engine/host.ts:84`

**Claim.** Cargo.toml's distribution claim holds for SDL3 and Skia but not for the MSVC runtime, so D2 must either require the VC++ redistributable or ship two hijackable DLLs next to the app.

**Evidence.** Cargo.toml:26-29: "Built from source and linked statically so distribution stays one artifact." Parsing the import table of the actual built `native-src/dziri-engine/target/release/dziri_engine.dll` (7.8 MB) confirms the static part — there is no `SDL3.dll` and no `libSkiaSharp.dll` import — but the full list is: ADVAPI32, GDI32, IMM32, KERNEL32, **MSVCP140.dll**, OLEAUT32, SETUPAPI, SHELL32, USER32, **VCRUNTIME140.dll**, VERSION, WINMM, ole32, ntdll, bcryptprimitives, and eight api-ms-win-crt-* api-sets. `MSVCP140.dll`, `VCRUNTIME140.dll` and `WINMM.dll` are not in the KnownDLLs registry key, so they resolve through the standard search order, which searches the *process's* directory before System32.

**Impact.** Two consequences for roadmap D2. First, correctness of the claim: shipping `dziri_engine.dll` alone is not sufficient — a machine without the VC++ 2015-2022 redistributable fails to load it with a diagnostic Bun will report poorly. Second, the usual fix (copying `MSVCP140.dll`/`VCRUNTIME140.dll` into the app directory) makes that directory a DLL-planting target: anyone who can write to the install directory gets code execution inside the app process, the standard Windows local-privilege/persistence pattern. Neither is a vulnerability today — the engine is loaded from a dev build tree — but both are decided by how D2 packages.

**Recommendation.** Build with a static CRT so the claim becomes true: `RUSTFLAGS="-C target-feature=+crt-static"` for the Rust objects plus `/MT` for the Skia and SDL C++ objects (SDL's CMake takes `-DSDL_FORCE_STATIC_VCRT=ON`; skia-safe honours extra cflags) — verify by re-checking the import table for the absence of MSVCP140. If a shared CRT is unavoidable, call `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32 | LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR)` before the first `dlopen`, install to a directory non-admins cannot write, and Authenticode-sign the cdylib. Worth stating what is already right: host.ts:72-84 builds two **absolute** candidate paths from `import.meta.dir`, `existsSync`-checks them, and `dlopen`s the absolute result — the primary library is never PATH- or CWD-resolved, so the obvious hijack is already closed.

**Verifier — weakened.** The import table is exactly as reported (I re-parsed it: MSVCP140/VCRUNTIME140/WINMM present, no SDL3.dll or libSkiaSharp.dll) and the KnownDLLs absence is confirmed, so 'shipping dziri_engine.dll alone needs the VC++ redist' is a valid documentation correction. But the Cargo.toml claim is scoped to SDL3 and holds; the DLL-planting concern is entirely conditional on unmade D2 packaging decisions and is a generic Windows side-by-side-CRT topic; and dependency resolution for an absolute-path dlopen searches bun.exe's directory, not the cdylib's. Low/informational.

<a id="f-security-supplychain-generated-artifact-unstamped-and-unchecked"></a>

### LOW · `app/ui.gen.ts` is an executable artifact with no input stamp; `bun run app` never checks

`process` · `security-supplychain/generated-artifact-unstamped-and-unchecked`

**Where:** `src/compile.ts:63`, `src/compile.ts:96`, `app/ui.gen.ts:1`, `src/window-host.ts:45`, `package.json:15`

**Claim.** Importing and executing app modules at build time is the same privilege as running the build and is not a vulnerability; the real gap is that its output is an executable module carrying no proof of which inputs produced it, and the run script never recompiles or verifies.

**Evidence.** compile.ts:63-70 `const specifier = pathToFileURL(resolve(inputPath)).href; setCompiling(true); mod = (await import(specifier)) ...` and compile.ts:96-98 does the same for `state.ts`, with the reasoning at compile.ts:56-58 ("importing the module *is* evaluating the components. Nothing is executed at run time") — accurate, and no different from a Vite config or a webpack loader. But the emitted artifact is a real module: `app/ui.gen.ts:8` is `import { addTodo, clearDraft, ... } from "./state.ts";`, and src/window-host.ts:45 does `import * as generated from "../app/ui.gen.ts";`. Its header (ui.gen.ts:1-6) records only source *paths* and node counts — no content hash of `app.tsx`/`app.css`/`schema.ts`, and no `PROTOCOL_VERSION`. package.json:15 `"app": "bun run src/app.ts"` does not recompile; only `"dev"` (line 14) does.

**Impact.** `bun run app` silently runs whatever `ui.gen.ts` is on disk. A stale artifact renders yesterday's UI with no warning (the schema handshake at host.ts:166 and the field-count check at host.ts:272 catch engine/schema skew, but nothing catches artifact/source skew). A tampered artifact runs arbitrary code with full process privilege, and since there is no VCS there is no diff to notice it in. Cheap to close, and steadily more valuable as the artifact grows.

**Recommendation.** Have `emit()` append `export const inputHash = "<sha256>"` over the concatenated bytes of the input `.tsx`/`.html`, the `.css`, and `src/protocol/schema.ts`, plus `export const protocolVersion = PROTOCOL_VERSION`. `src/app.ts` recomputes the hash from the same three files at startup (`Bun.CryptoHasher`, three `Bun.file().bytes()`) and refuses to start on a mismatch with "run `bun run compile`". One mechanism catches both staleness and tampering, ~15 lines and one millisecond.

**Verifier — weakened.** Accurate that ui.gen.ts carries no input stamp and that `bun run app` never recompiles or verifies (package.json:15 vs 14). But the tampering half adds nothing — whoever can write app/ui.gen.ts can write src/app.ts, and an input hash stored in the artifact is rewritten by the same actor, so it catches staleness only. Stamping PROTOCOL_VERSION is also misdirected: ui.gen.ts encodes IR, not protocol layout, and host.ts:165-171/260-280 already handshake that. Low DX/staleness gap, no security dimension.

<a id="f-security-supplychain-last-error-truncation-splits-utf8"></a>

### LOW · `dziri_last_error` truncates mid-codepoint; no message leaks memory

`correctness` · `security-supplychain/last-error-truncation-splits-utf8`

**Where:** `native-src/dziri-engine/src/error.rs:88`, `native-src/dziri-engine/src/lib.rs:476`, `src/engine/host.ts:112`, `native-src/dziri-engine/src/error.rs:25`

**Claim.** The buffer-length protocol is correct (returns the needed length, copies min) but truncation can split a UTF-8 sequence — the one thing the event path explicitly gets right and this path does not; separately, no message leaks memory contents, and the thread-local becomes wrong at A0 step 3.

**Evidence.** error.rs:92-95 `if !buf.is_null() && len > 0 { let n = bytes.len().min(len as usize); std::ptr::copy_nonoverlapping(bytes.as_ptr(), buf, n); }` — no char-boundary walk-back. Compare engine.rs:486-491, which does exactly that and says why: "Truncated on a UTF-8 boundary rather than mid-codepoint: a split sequence would reach Bun as broken text" — `while n > 0 && !text.is_char_boundary(n) { n -= 1; }`. lib.rs:476-479 (`dziri_engine_font_family`) has the same gap. host.ts:108-115 uses a 1024-byte buffer and `decoder.decode(errorBuf.subarray(0, Math.min(len, errorBuf.length)))`, and `TextDecoder` is non-fatal by default, so the symptom is a U+FFFD, not a throw. On the disclosure question: every `fail()` site interpolates integers and static text only — lib.rs:355 `format!("no node {node}")`, lib.rs:400 `format!("frame is {} bytes, was given {len}", pixels.len())`, layout.rs:102 `format!("node {i} has child {c}, past the {count}-node table")` — never arena bytes, never a pointer, and `read_last_error` copies `min(len, actual)` so there is no read past the buffer either. error.rs:25-32 declares `LAST_ERROR` in `thread_local!`.

**Impact.** Today: a >1024-byte error message ends in a replacement character. Tomorrow: engine.rs:9-17 schedules the engine owning its own render thread (A0 step 3), at which point a panic recorded on the render thread is invisible to `dziri_last_error` called from Bun's thread — the host gets `""` alongside a `PANIC` status, precisely the silent-failure mode error.rs:1-8 exists to prevent.

**Recommendation.** Extract the boundary walk-back from engine.rs:488-491 into `fn truncate_utf8(s: &str, len: usize) -> &[u8]` and use it in `read_last_error` and `dziri_engine_font_family`. For the threading change, move `LAST_ERROR` from `thread_local!` to a `Mutex<String>` on the `Handle` — the message becomes per-engine rather than per-thread, which is the identity the host actually has — and make the switch when step 3 lands rather than after the first invisible panic.

**Verifier — confirmed.** All four code claims check out. `error.rs:88-98 read_last_error` does `let n = bytes.len().min(len as usize); copy_nonoverlapping(...)` with no char-boundary walk-back, and `lib.rs:470-480 dziri_engine_font_family` has the identical gap, while `engine.rs:479-489` does exactly the walk-back for event text with the reasoning spelled out ('a split sequence would reach Bun as broken text'). So the inconsistency the finding names is genuinely there and the extract-a-helper fix is four lines. The disclosure analysis is also right: I checked the `fail()` sites and they interpolate integers and static text only (`lib.rs:355` 'no node {node}', `lib.rs:400` 'frame is {} bytes, was given {len}', `layout.rs:102` 'node {i} has child {c}, past the {count}-node table'), never arena bytes or pointers, and `host.ts:112-115` reads with a 1024-byte buffer and `Math.min(len, errorBuf.length)`, so there is no over-read. Reachability today is close to nil — every message is far under 1024 bytes and font family names are short — and TextDecoder is non-fatal so the worst symptom is one U+FFFD, which is precisely why the finding filed it as low. The thread-local half is explicitly forward-looking about A0 step 3 rather than a present defect, and it is framed that way. I tried to find a reason to downgrade below low and could not: it is a small, correct, cheap consistency defect at the same severity claimed.

<a id="f-security-supplychain-untrusted-text-to-skia-no-cap"></a>

### LOW · Untrusted text reaches Skia uncapped and unclipped; A2 and A5 widen the surface

`security` · `security-supplychain/untrusted-text-to-skia-no-cap`

**Where:** `src/runtime/bindings.ts:80`, `native-src/dziri-engine/src/text.rs:184`, `native-src/dziri-engine/src/paint.rs:229`, `src/engine/upload.ts:231`

**Claim.** The current text path is narrow enough that adversarial Unicode is a cost problem rather than a safety one, but there is no length cap anywhere and no clipping, and the two roadmap items that widen the surface are the two most historically CVE-dense parts of Skia.

**Evidence.** bindings.ts:80-103 `typeInto` appends without limit. The string reaches text.rs:184 `pub fn measure(&mut self, text: &str, size: f32, weight: u16, _available_width: f32) -> (f32, f32) { (self.advance(text, size, weight), self.line_height(size, weight)) }` → `font.measure_str(text, None)` (text.rs:162), and paint.rs:229/234 `canvas.draw_str(text, (tx, ty), font, &self.fill)` — the whole string, no clip rect, no `saveLayer`. upload.ts:231-233 states plainly: "`lineClamp` and `overflow` are in the schema but not in the IR, because the engine does not implement clipping or paragraph clamping yet." Per-frame cost is worse than it looks: text.rs:196-203 `hash_str` walks the whole string on every cache lookup, and the miss path re-shapes it.

**Impact.** A 100 KB single-line string is hashed, shaped, measured and drawn as one unclipped run — slow, and it paints outside its box because nothing clips. That is the ceiling today. It rises sharply at A2: SkParagraph brings bidi, grapheme clustering and font fallback, where malformed or pathological Unicode has historically produced real memory bugs, and it runs on the render thread with no sandbox. A5's PNG decode adds an actual attacker-facing binary parser (image bytes are untrusted even from a local file) in the same process with the same lack of isolation.

**Recommendation.** Decide the caps now, while they are one line each: cap every text-binding sink at a documented maximum (`MAX_TEXT_BYTES`, enforced in `typeInto` and re-checked in the engine's `validate` pass so a host bug cannot bypass it), and land `overflow: hidden` as `canvas.save()/clip_rect()/restore()` in `Painter::node` before A2 rather than after. For A5, use `SkCodec` with explicit `getInfo()` dimension limits and a total-pixel budget checked *before* decoding, reject anything larger, and treat the decoder as the one component worth fuzzing (`cargo-fuzz` over the decode entry point) since it is the only one that will parse an untrusted byte stream.

**Verifier — weakened.** Correct that there is no text length cap and no clipping anywhere in the crate (zero clip_rect/save call sites; OVERFLOW/LINE_CLAMP defined in protocol.rs:130-131 and unread). But the missing clipping is documented as pending A2 work at the very line cited (upload.ts:231-233), the '100 KB single-line string' is unreachable — 32 bytes per input event (engine.rs:50) and no clipboard/file/network path — and advance results are memoised, so the per-frame hash-and-shape is amortised. Low/informational, mostly forward-looking advice about A2/A5.

<a id="f-security-supplychain-capacity-requests-unbounded-oom-poisons"></a>

### LOW · Capacity requests have no ceiling; allocation failure is an `assert!` that poisons

`security` · `security-supplychain/capacity-requests-unbounded-oom-poisons`

**Where:** `native-src/dziri-engine/src/tables.rs:117`, `native-src/dziri-engine/src/tables.rs:113`, `native-src/dziri-engine/src/engine.rs:151`, `native-src/dziri-engine/src/lib.rs:69`

**Claim.** Both `create` and `grow` take host u32 capacities with no ceiling and turn them straight into an allocation whose failure path is a panic, so an over-large request kills the engine irrecoverably instead of returning a status.

**Evidence.** engine.rs:151-158 `let caps = Capacities { nodes: config.node_capacity.max(1), styles: config.style_capacity.max(1), ... }` — `.max(1)` is the only check. tables.rs:701-713 `grow` likewise only takes `.max()` against current. Those flow into tables.rs:112-118: `let layout = AllocLayout::from_size_align(size, ARENA_ALIGN).expect("arena layout"); let ptr = unsafe { alloc_zeroed(layout) }; assert!(!ptr.is_null(), "out of memory allocating {size} bytes");` — both `expect` and `assert!` panic. The panic is caught by `guard` (error.rs:104), but lib.rs:67-71 then does `if code == status::PANIC { handle.engine.poisoned = true; }` and lib.rs:60-65 fails every subsequent call with `POISONED`.

**Impact.** `nodes: 0xFFFFFFFF` (reachable from a Bun-side arithmetic slip — `capacitiesFor` feeds `Math.ceil` results into a `Uint32Array`, so a NaN or a negative silently becomes a large u32) asks for ~100 GB across three arenas. Best case the allocator refuses and the engine is permanently poisoned mid-session — a recoverable capacity error turned into a dead window. Worst case on an overcommitting OS it succeeds and `alloc_zeroed` touches every page.

**Recommendation.** Add `const MAX_NODES: u32`, `MAX_STYLES`, `MAX_STRING_BYTES` (generous — 1<<22 nodes, 1<<28 arena bytes) and reject anything larger from `dziri_engine_create`/`dziri_engine_grow` with `fail(status::CAPACITY, ...)` before any allocation. Then make `Arena::new` fallible — `fn try_new(size: usize) -> Result<Self, String>` returning `Err` on a null pointer or a bad layout, propagated through `Tables::new`/`grow` — so an honest OOM is a `CAPACITY` status the host can act on. `grow` already has the right shape: it builds the new `Tables` before swapping, so a failure can leave the old ones intact.

**Verifier — weakened.** Accurate that create/grow apply only `.max()` and that allocation failure is an `expect`/`assert!` which poisons the engine via lib.rs:66-71. But the cited trigger is wrong: `Uint32Array[i] = NaN` is 0 in JS, not a large u32 (and 0 becomes 1 via `.max(1)`), and nothing in capacitiesFor can produce a negative, so there is no reachable path to an over-large request. On Windows the request simply fails and the engine reports POISONED with a message. Low-severity robustness nit, not a security issue.

<a id="f-security-supplychain-hit-test-ignores-configured-root"></a>

### LOW · `hit_test` hardcodes node 0 as root while layout and paint honour the configured root

`correctness` · `security-supplychain/hit-test-ignores-configured-root`

**Where:** `native-src/dziri-engine/src/paint.rs:252`, `native-src/dziri-engine/src/paint.rs:122`, `native-src/dziri-engine/src/layout.rs:160`, `app/ui.gen.ts:173`

**Claim.** The engine accepts a host-supplied root, threads it through layout and paint, then ignores it in the third walker — working today only by the accident that the root happens to be 0.

**Evidence.** paint.rs:244-252 `pub fn hit_test(tables: &Tables, bounds: &[[f32; 4]], px: f32, py: f32) -> i32 { ... let mut stack = vec![0usize];` — no `root` parameter at all, and all three call sites (engine.rs:415, 432, 448) plus `Engine::hit_test` (engine.rs:574) pass none. Compare paint.rs:106-122 `pub fn paint(&mut self, ..., root: usize) { ... let mut stack = vec![root];` and layout.rs:160-163 `let root = *self.ids.get(self.root).ok_or_else(...)`. `app/ui.gen.ts:173` is `export const root = 0;`, and src/window-host.ts:66 passes it, so the two agree by luck.

**Impact.** Any non-zero root — a compiler change that wraps the document, a sub-tree render, a future multi-root case — makes every click and hover walk a subtree whose bounds were never computed from that origin. The symptom is silently dead interaction, not a crash, and `tests/bounds.rs:358 hit_testing_finds_the_deepest_interactive_node` would keep passing because its fixture also uses root 0.

**Recommendation.** Give `hit_test` a `root: usize` parameter and pass `self.root` from all four call sites, exactly as `paint` already does. Add the regression the current test cannot catch: a fixture with `root: 1` asserting that paint and hit-test agree and that node 0 is never returned.

**Verifier — confirmed.** Verified line by line and I could not find a defence. `paint.rs:244-249`: `pub fn hit_test(tables: &Tables, bounds: &[[f32; 4]], px: f32, py: f32) -> i32 { let count = bounds.len(); ... let mut stack = vec![0usize];` — no `root` parameter exists, and `grep -n hit_test native-src/dziri-engine/src/*.rs` shows all four call sites (engine.rs:415, 432, 448 and `Engine::hit_test` at engine.rs:574-576) pass none, while `paint.rs:106-122 paint(...)` does take `root: usize` and seeds `vec![root]`, and `layout.rs:160-163` resolves `self.ids.get(self.root)`. So the engine threads a host-supplied root through two of three walkers and drops it in the third. It works only by coincidence: `app/ui.gen.ts:173` is `export const root = 0;` (src/window-host.ts:66 passes it), and `compile.ts:589-592` derives `rootIndex` from the first node walked, so the compiler always emits 0 today — including in the synthetic `#root` wrapper case. The consequence is stated correctly: with a non-zero root, hit-testing would walk from node 0, a node that may not even be in the painted subtree, and the symptom is silently dead interaction rather than a crash. The note that `tests/bounds.rs:358 hit_testing_finds_the_deepest_interactive_node` cannot catch it is right — its fixture also roots at 0 (config() in bounds.rs sets no non-zero root). Latent, unreachable today, cheap to fix, and low is the correct severity.

---

## Code quality, tests & process

*12 findings — 4 high, 6 medium, 2 low.*

- **high** · [4,000 lines of compiler with zero unit tests; the cascade is unverified](#f-quality-tests-process-compiler-has-no-unit-tests)
- **high** · [The variant compiler's correctness oracle guards a duplicate and asserts nothing](#f-quality-tests-process-variant-oracle-unreachable)
- **high** · [Not a git repo, no .gitignore, ~1 GB of build output and a 79 MB nupkg in the tree](#f-quality-tests-process-no-gitignore-not-a-repo)
- **high** · [The compiler↔runtime contract is the one thing not typechecked: `as unknown as CompiledUi`](#f-quality-tests-process-generated-module-untypechecked)
- **medium** · [`jsxDEV` receives the author's file and line and discards it, foreclosing diagnostics](#f-quality-tests-process-jsx-source-location-discarded)
- **medium** · [Unsupported CSS properties warn once per matching node, or not at all](#f-quality-tests-process-compiler-warnings-to-stderr)
- **medium** · [String-typed engine errors force a guessed status: tick() reports LAYOUT for Skia/SDL](#f-quality-tests-process-engine-tick-status-lies)
- **medium** · [`MAX_FIELDS = 64` strides the span index with no compile-time guard; styles is at 48](#f-quality-tests-process-max-fields-flat-index-unguarded)
- **medium** · [`PROTOCOL_VERSION` is the one hand-maintained value in a generated protocol](#f-quality-tests-process-protocol-version-hand-maintained)
- **medium** · [No CI, no `test` script, no lint/format config, and a hand-rolled second test framework](#f-quality-tests-process-no-ci-no-lint-second-test-framework)
- **low** · [19 `unsafe extern "C"` fns are wholly implicit unsafe blocks; no `unsafe_op_in_unsafe_fn`](#f-quality-tests-process-unsafe-op-in-unsafe-fn)
- **low** · [Retired spikes and the old runtime's DLLs still on disk; 378 MB of it is build output](#f-quality-tests-process-retired-spikes-still-on-disk)

<a id="f-quality-tests-process-compiler-has-no-unit-tests"></a>

### HIGH · 4,000 lines of compiler with zero unit tests; the cascade is unverified

`testing` · `quality-tests-process/compiler-has-no-unit-tests`

**Where:** `src/compiler/css.ts:1`, `src/compiler/compile.ts:94`, `src/compiler/compile.ts:56`, `src/engine/upload.test.ts:1`

**Claim.** The only TypeScript test file is one 313-line integration test (12 tests, 58 assertions) that drives the whole engine through the checked-in `app/ui.gen.ts`; every pure, branch-dense function in the compiler — the cheapest and highest-risk thing in the repo to test — has no test at all.

**Evidence.** `bun test src/engine/upload.test.ts` → `12 pass … 58 expect() calls`. That file's own header says what it does NOT cover: "Layout correctness is Taffy's and is covered by the engine's own Rust tests; what only these can cover is the path from the compiler's IR, through the field mapping, into shared memory". Meanwhile `collectDecls` carries a 10-line argument for its own subtlety — "While hovering, `.btn:hover` (0,2,0) and `.btn.primary` (0,2,0) tie on specificity and source order decides — so hover declarations do not automatically beat base ones. Resolving hover as a patch over the finished base style would get that backwards." (compile.ts:84-93) — and nothing asserts it. Same for `matches()` right-to-left greedy descendant walk (compile.ts:56-80), `parseSelector`'s specificity tuple (css.ts:104-152), `compareCascade` (css.ts:155), `parseColor`'s 7 branches (css.ts:183), `parseLength`'s unit table (css.ts:224), `boxShorthand`'s 1-to-4 expansion (css.ts:250), `parseTracks` (css.ts:309), `parsePlacement`'s `2 / 5` → `[2, 3]` (css.ts:348-371), the `flex` shorthand's basis sniffing (css.ts:558), `StyleInterner`'s NaN/Infinity-safe key (compile.ts:206), `walkList`'s arena replication and slot re-pointing (compile.ts:499-535), and `buildInteractive` (compile.ts:680).

**Impact.** Every one of these produces an integer written into a shared-memory table. A wrong integer is a wrong-looking frame, not an exception — exactly the failure class the protocol codegen was built to eliminate, reintroduced one layer up. `parsePlacement` returning `span = n - start` off by one, or the `flex` shorthand picking `1` as a basis instead of a shrink factor, silently ships. Regressions are only caught if they happen to change the layout of the one demo page, and the assertions are deliberately loose (`toBeGreaterThan(100)`, `±1px`).

**Recommendation.** Write tests in this order, most risk removed first. (1) Table-driven tests for `css.ts` value parsers: `parseColor` (`#abc`, `#abcd`, `#aabbcc`, `#aabbccdd`, `rgb()`, `rgba()` alpha clamping, named, malformed→throws), `parseLength` (px/pt/rem/em/auto/`0`/`%`→throws), `boxShorthand` all four arities, `parseTracks`, `parsePlacement`, and `expandDeclaration` for the `flex`/`border`/`gap` shorthands — ~150 lines of test covering ~400 lines of the highest-consequence code. (2) `parseSelector` specificity + `compareCascade` + `matches(selector, path)` as a truth table, then `collectDecls` with a hover/base specificity tie to pin the argument at compile.ts:84 in place. (3) Golden IR snapshots: `dump(compile(html, css))` over ~10 fixture pages, checked in — `dump()` (compile.ts:1010) already exists and is described as "M2a's verification artifact", so this is the cheapest coverage per line of test in the repo. (4) Property tests with `fast-check` over the parser: for any generated declaration, `expandDeclaration` either throws `CssError` or leaves every touched field a number that is finite or NaN — never `undefined`, never a silent 0. (5) `signal.ts` batching and computed invalidation — the double-notify case its own comment names at signal.ts:54-61. (6) `list-runtime.ts` slot assignment across reorder/insert/delete and `growArena` past capacity, asserting chain integrity, sortedness of `states.node` and `interactive`, and per-slot string ownership. (7) Rust `proptest` over `Tables::grow`: arbitrary capacity sequences preserve contents, spans never overlap, generation is monotone — the existing test asserts one case. (8) The headless-Chrome `getComputedStyle` oracle the roadmap already plans (ROADMAP.md:304) last — highest value but highest setup cost, and its failures are only interpretable once 1-3 exist.

**Verifier — confirmed.** Two small inaccuracies in the recommendation, not the claim: boxShorthand, parseTracks, parsePlacement, matches and collectDecls are module-private (src/compiler/css.ts has only 6 exported functions, compile.ts does not export matches/collectDecls), so the table-driven tests need exports added first. parsePlacement's documented `2 / 5` -> [2,3] behaviour is actually correct (verified by execution); the two real off-spec results are in the `flex` shorthand and rgb() clamping.

<a id="f-quality-tests-process-variant-oracle-unreachable"></a>

### HIGH · The variant compiler's correctness oracle guards a duplicate and asserts nothing

`testing` · `quality-tests-process/variant-oracle-unreachable`

**Where:** `src/compiler/variants.ts:454`, `src/compiler/variants.ts:61`, `src/compiler/variant-compile.ts:71`, `src/compiler/variant-compile.ts:252`, `src/variants.ts:24`

**Claim.** `analyzePatches` contains an exhaustive proof that sequencing per-toggle patches reproduces the compiler's own output for all 2^k combinations — the single strongest test in the codebase — but it validates a *second copy* of the algorithm rather than the production `compileVariants`, it only prints its result, and the CLI that reaches it is broken by default.

**Evidence.** src/compiler/variants.ts:454-496: "The real test: does sequencing patches reproduce the compiler's own output for every combination?" … `composeFailures.push({ mask, toggles, mismatches })`. The only consumer is src/variants.ts:188-196, which `console.log`s `"    ${p.composeFailures.length}/${a.combos.length} combinations WRONG:"` and exits 0 regardless. And `bun run variants` cannot run: `const inputPath = argv[0] ?? join(ROOT, "app", "todo.tsx")` (src/variants.ts:24) — `app/` contains only `app.tsx`; I ran it and got `ENOENT: … app\todo.css`. Meanwhile the production path is `compileVariants` (variant-compile.ts:171-303), a near-verbatim reimplementation: `cloneTree` is byte-identical in both files (variants.ts:61-72 vs variant-compile.ts:71-82), `changedFields` is duplicated (variants.ts:167 vs variant-compile.ts:138), and the slot-vector interning appears a third and fourth time (variants.ts:344 `internSlot`, variant-compile.ts:200 `internSlot`, alongside compile.ts:202 `StyleInterner.intern` and variants.ts:121 `GlobalStyles.intern` — four copies of "build a key by concatenating STYLE_FIELDS"). For contrast, `src/compile.ts` vs `src/compiler/compile.ts` and `src/variants.ts` vs `src/compiler/variants.ts` are *not* duplication — they are CLI-over-library, confirmed by package.json:13-16; the real duplication is variants.ts vs variant-compile.ts.

**Impact.** `compileVariants` derives the style-table patches that every conditional class in every shipped app depends on, and the one mechanism that could prove it correct is pointed at a different function. A divergence between the two implementations — or a regression in `compileVariants` alone — passes silently, and the symptom is a theme toggle that resolves the cascade wrongly in a specific combination of two toggles: the exact case the code warns about at variant-compile.ts:293-298 but never verifies.

**Recommendation.** Delete the duplicated algorithm. Move the composition check out of `analyzePatches` into a `verifyCompose(doc, css, baseline, toggles): Mismatch[]` that replays `compileVariants`'s own `table` + `patches` against `compileTree` for all 2^k combinations (k is already capped at 16 at variants.ts:185), and call it from a `src/compiler/variant-compile.test.ts` over `app/app.tsx` plus two or three synthetic fixtures with deliberately colliding toggles. Keep `src/compiler/variants.ts` as a pure *measurement* report (it is honest research and worth keeping) but have it import the production interner instead of restating it, and factor the STYLE_FIELDS key-builder into one exported `styleKey(style)` in `src/ir.ts`. Fix or drop the `app/todo.tsx` default in src/variants.ts:24.

**Verifier — confirmed.** Two details off: the STYLE_FIELDS key-builder appears three times, not four — compile.ts:206, variants.ts:123 and variant-compile.ts:203; variants.ts:344-356 `internSlot` keys on combination *style ids*, not on STYLE_FIELDS. And cloneTree is code-identical but not byte-identical: the doc comments differ (variants.ts:65-66 vs variant-compile.ts:75-76).

<a id="f-quality-tests-process-no-gitignore-not-a-repo"></a>

### HIGH · Not a git repo, no .gitignore, ~1 GB of build output and a 79 MB nupkg in the tree

`process` · `quality-tests-process/no-gitignore-not-a-repo`

**Where:** `package.json:1`, `native-src/dziri-engine/target/.rustc_info.json:1`, `skiasharp.nativeassets.win32.4.150.1.nupkg:1`, `native/win32-x64/libSkiaSharp.dll:1`

**Claim.** For a project that intends to be public, the single most urgent process gap is that the first `git init && git add .` will commit roughly a gigabyte of regenerable artifacts, and there is no `.gitignore` to stop it.

**Evidence.** `git rev-parse --is-inside-work-tree` → `fatal: not a git repository (or any of the parent directories): .git`. `ls -la .gitignore` → `No such file or directory`. `du -sh`: `native-src/dziri-engine/target` 622M, `native-src/skia-probe` 350M, `node_modules` 30M, `native` 15M, `native-src/taffy-ffi` 13M — 1.1 GB total. Loose in the root: `skiasharp.nativeassets.win32.4.150.1.nupkg` (79,528,972 bytes), `SDL3-3.4.12-win32-x64.zip` (1,161,314 bytes), `engine-demo.png`, `engine-demo-light.png`. `app/ui.gen.ts` (18 KB of generated typed arrays) is also present and is a build product of `bun run compile`.

**Impact.** A 1 GB initial commit is effectively permanent — git history cannot be shrunk after publication without a rewrite that invalidates every clone and fork. It also makes `git status` useless (622 MB of churning fingerprint JSON), makes CI checkout minutes-long, and means the 79 MB SkiaSharp nupkg — a dependency of the *retired* TypeScript runtime — becomes a permanent part of the project's identity.

**Recommendation.** Before `git init`: write `.gitignore` with `node_modules/`, `target/`, `.natives-tmp/`, `*.nupkg`, `*.zip`, `native/**/*.dll`, `native/**/*.so`, `native/**/*.dylib`, `engine-frame.png`. Decide deliberately about `app/ui.gen.ts` — commit it (it is the artifact the README will show, and `upload.test.ts:22` imports it) but add a `bun run compile && git diff --exit-code app/ui.gen.ts` check so a stale generated file is a CI failure rather than a silent divergence. Delete the nupkg and the SDL zip; record their versions in NOTES.md instead, which already documents the toolchain floor.

**Verifier — confirmed.** Every number checks out. `git rev-parse --is-inside-work-tree` -> `fatal: not a git repository`; no .gitignore (`ls: cannot access '.gitignore'`). `du -sh` gives 1.1G total, native-src/dziri-engine/target 622M, native-src/skia-probe 350M, native-src/taffy-ffi 13M, node_modules 30M, native 15M. Root listing confirms skiasharp.nativeassets.win32.4.150.1.nupkg at exactly 79,528,972 bytes, SDL3-3.4.12-win32-x64.zip at 1,161,314, engine-demo.png and engine-demo-light.png, plus app/ui.gen.ts at 18,234 bytes. The nupkg really is dead weight: NOTES.md:481 states "nothing fetches libSkiaSharp or SDL3.dll any more, because the engine links its own", and ROADMAP.md:183 lists both DLLs as retired. Public intent is explicit, so this is not a hypothetical repo — ROADMAP.md:7 "Open source, with `create-dziri` scaffolding and a `dziri` CLI" and ROADMAP.md:19 "P0 · Prerequisites — before any public work" (npm names, GitHub org). ui.gen.ts is a build product of `bun run compile` (src/compile.ts writes it) and is imported by src/window-host.ts:45 and src/engine/upload.test.ts:22, so the commit-plus-drift-check recommendation is the right shape. Severity is carried by irreversibility, not by present breakage: the fix is a ten-line file, and it stops being possible the moment history is published.

<a id="f-quality-tests-process-generated-module-untypechecked"></a>

### HIGH · The compiler↔runtime contract is the one thing not typechecked: `as unknown as CompiledUi`

`soundness` · `quality-tests-process/generated-module-untypechecked`

**Where:** `src/window-host.ts:77`, `src/engine/upload.test.ts:33`, `src/compiler/compile.ts:881`, `app/ui.gen.ts:1`

**Claim.** `ui.gen.ts` is emitted as a string with no type annotation and every consumer launders it through `as unknown as`, so the interface between the two halves of the system — in a project whose entire thesis is "resolve it at compile time" — is the only interface the compiler does not check.

**Evidence.** src/window-host.ts:77-88: `const ui: CompiledUi = { strings: generated.strings, styles: generated.styles, … } as unknown as CompiledUi;` followed by `generated.stylePatches as unknown as StylePatchRef[]`, `generated.listBindings as unknown as ListBindingRef[]`, `generated.editables as unknown as EditableRef[]`. Identical four casts in the test (upload.test.ts:33-48). `emit()` (compile.ts:881-967) writes `export const strings = …; export const styles = { … };` with no `satisfies` and no `import type`; `grep -n "satisfies|: CompiledUi|import type" app/ui.gen.ts` returns nothing. `tsc --noEmit` exits 0 — because the casts guarantee it always will. There are 17 `as unknown as` in the tree, and 12 of them are on this one seam.

**Impact.** The emitter and `src/ir.ts` can drift with no diagnostic. `textBindings` is emitted as `{ signal: … }` or `{ path: … }` depending on whether `resolveRefs` ran (compile.ts:810-815); `listBindings` carries `slotsPerItem` and `itemHandlers` that `ListBindingRef` must match field-for-field; `stylePatches[].entries[].slots` must be a `Uint16Array` while `on`/`off` are `Float64Array`. Any mismatch is a `TypeError` at frame 1 or, worse, an `undefined` coerced to `NaN` in a typed-array write — silently `width: 0`, exactly what upload.ts:212 warns about. The strictness elsewhere is real (`strict` + `noUncheckedIndexedAccess`, tsconfig.json:9-10, and `tsc` is clean), which makes this hole the one that matters.

**Recommendation.** Have `emit()` write the contract into the artifact: prepend `import type { CompiledUi, StyleTable, NodeTable } from "../src/ir.ts";` and emit `export const styles = { … } satisfies StyleTable;`, `export const nodes = { … } satisfies NodeTable;`, and typed `StylePatchRef[]` / `ListBindingRef[]` / `EditableRef[]` annotations on the four binding arrays. `app/` is already in tsconfig's `include`, so `tsc --noEmit` then validates every compile's output for free, and all 12 casts in `app.ts` and `upload.test.ts` delete themselves. Add `"check": "tsc --noEmit"` to package.json — it does not exist today.

**Verifier — confirmed.** Cast counts are overstated. There are 17 `as unknown as` in the tree but only 7 on this seam (src/window-host.ts:106,109,110,111 and src/engine/upload.test.ts:43,45,48) — not 12; the test has three seam casts, not "identical four" (it never casts `editables`). The remaining ten are unrelated patterns (Record-keying styles in upload.ts:214-215, patches.ts:41, host.ts:291, signal.ts:242) and would survive the fix. One mitigation the finding omits: tsc does catch a *missing or renamed* export, since every consumer reads `generated.<name>` by name; only shape mismatches inside an existing export are invisible.

<a id="f-quality-tests-process-jsx-source-location-discarded"></a>

### MEDIUM · `jsxDEV` receives the author's file and line and discards it, foreclosing diagnostics

`architecture` · `quality-tests-process/jsx-source-location-discarded`

**Where:** `src/compiler/jsx-dev-runtime.ts:18`, `src/compiler/jsx-dev-runtime.ts:6`, `src/compiler/html.ts:10`, `src/compiler/compile.ts:166`, `src/compiler/css.ts:69`

**Claim.** The only channel by which a build-time-erased JSX tree can carry a source location is `jsxDEV`'s `_source` argument, and it is discarded with a comment arguing it has no use — while the roadmap lists "Compiler diagnostics with source locations pointing at the author's TSX, never generated code" as a commitment, twice.

**Evidence.** src/compiler/jsx-dev-runtime.ts:13-22: `export function jsxDEV(type, props, key?, _isStaticChildren?, _source?, _self?) { return jsx(type, props, key); }`, justified at :6-8 — "The extra arguments carry debug info we have no use for — the compiler reports errors against selectors and tags, not JSX call sites". What it reports instead: `throw new Error("${where}: ${prop}: ${value} — ${message}")` where `where` is `path.map(e => e.tag + (e.id ? "#"+e.id : "") + …).join(" > ")` (compile.ts:166, :360-363). I probed it: `padding: 3quux` on `.a span` reports `div.a > span: padding: 3quux — bad length "3quux"` — no file, no line, no snippet, and for a JSX author no way to find the element among N identical `div.a > span`. CSS errors are worse: `parseCss` throws `unclosed rule for selector "…"` (css.ts:69), `declaration without a colon` (:97), `empty selector` (:105) with no byte offset at all — the tokenizer tracks `i` but never records it — so the author gets a raw Bun stack trace into `src/compiler/css.ts`. ROADMAP.md:261 and :268 both commit to the opposite.

**Impact.** This is the finding that gets torn out later. Adding a location after the fact means threading one through `Element` (html.ts:10-56 has no field for it), through `jsx()`'s three `Element` constructors (jsx-runtime.ts:426, :429, :454) and `toDocument` (:471), through `cloneTree` in *two* files (variants.ts:61, variant-compile.ts:71), through `parseHtml`'s element construction (html.ts:188), through `describe()` and every `where` string, and through a new `offset` on every `CssError` — a change touching eight files and every error site, versus one field and one argument threaded now. `_source` is `{ fileName, lineNumber, columnNumber }` and it is free today: Bun already computes it.

**Recommendation.** Add `loc: { file: string; line: number; col: number } | null` to `Element` now, populate it from `_source` in `jsxDEV` (pass it through `jsx` as an optional fifth parameter, `null` from `parseHtml`), and carry it in `describe()` so the message becomes `windows/main/pages/features.tsx:49:7  <span class="a">: padding: 3quux — bad length "3quux"`. Separately, give the CSS tokenizer offsets: record `open`/`close` per rule in `Rule` (css.ts:81-85 already has them in scope as locals) and attach `{ line, col, snippet }` to `CssError` by counting newlines lazily on throw. Introduce one `Diagnostic = { severity, message, loc, snippet }` type and have `compile()` return diagnostics instead of throwing bare `Error`s, so `src/compile.ts` can render them — that is also the shape `--explain` (ROADMAP.md:270) will need.

**Verifier — weakened.** Accurate statement: jsxDEV discards the `_source` argument Bun already computes, and today's compiler and CSS errors carry no file, line or byte offset — a real DX gap against a stated roadmap commitment. But the retrofit cost is small, not eight-file: the two cloneTree functions spread their input by deliberate design and need no change, so the change is Element + jsx() + parseHtml + describe(), plus offsets on CssError. Severity medium (deferred cheap groundwork), not high (architecture).

<a id="f-quality-tests-process-compiler-warnings-to-stderr"></a>

### MEDIUM · Unsupported CSS properties warn once per matching node, or not at all

`cleanliness` · `quality-tests-process/compiler-warnings-to-stderr`

**Where:** `src/compiler/css.ts:685`, `src/compiler/css.ts:76`, `src/compiler/compile.ts:309`

**Claim.** `expandDeclaration` writes to `console.warn` from inside a pure compiler function, so a `box-shadow` on a class matching 300 rows prints 300 identical warnings, a rule matching nothing warns zero times, and none of it reaches the `warnings` channel the compiler already has.

**Evidence.** css.ts:684-686: `default: console.warn("  warn: ignoring unsupported property \"${prop}\"")`. I verified both halves. Five matching elements: five identical stderr lines, and `result.warnings` is `[]`. A rule matching nothing (`.nope { box-shadow: …; transform: … }` against `<div/>`): `warnings: []` and no output whatsoever — the author is told nothing about two dropped properties. `CompileResult.warnings` exists and is documented as "Diagnostics worth surfacing but not worth failing over" (compile.ts:309-310) and is drained by the CLI (src/compile.ts:110), but the property expander never uses it. `parseCss` has the same problem for at-rules (css.ts:76).

**Impact.** The two failure modes are the two that matter: noise that trains the author to ignore warnings, and silence about a stylesheet the compiler quietly ignored half of. "Tailwind's utility surface defines the CSS subset" means the *set of unsupported properties encountered* is the project's own coverage metric — and it is currently unrecoverable from the compiler's output. Writing to stderr from a pure function also makes `expandDeclaration` untestable without capturing globals, which is part of why it has no tests.

**Recommendation.** Change `expandDeclaration(prop, raw, out)` to take a `warn: (msg: string) => void` (or return `{ unsupported: string[] }`) and have `applyDecls` collect into a `Set` keyed by property so each is reported once, with the *rule* that declared it and its source offset. Report at the rule level too: after `parseCss`, walk every rule's declarations once against the known property set and emit one warning per (property, selector) pair, so a rule matching nothing still tells the author it was dropped. Route everything through `result.warnings`.

**Verifier — confirmed.** Reproduced both halves exactly. src/compiler/css.ts:684-685 is `default: console.warn("  warn: ignoring unsupported property ...")` inside expandDeclaration. Compiling `<div class="a"><span>x</span><span>y</span></div>` against `.a span { box-shadow: 0 0 2px red; transform: none }` printed four stderr lines (two per matching element) and `result.warnings` was `[]`; compiling the same declarations under `.nope` printed nothing at all and `warnings` was again `[]` — the author is told nothing about two dropped properties. CompileResult.warnings exists and is documented at src/compiler/compile.ts:309-310 ("Diagnostics worth surfacing but not worth failing over") and is drained at src/compile.ts:110 (`for (const w of result.warnings) console.warn(...)`), so the channel is there and unused by the expander. parseCss has the same shape for at-rules at css.ts:76. The testability point is real too — expandDeclaration is exported (css.ts:410) but cannot be asserted on without capturing console.

<a id="f-quality-tests-process-engine-tick-status-lies"></a>

### MEDIUM · String-typed engine errors force a guessed status: tick() reports LAYOUT for Skia/SDL

`correctness` · `quality-tests-process/engine-tick-status-lies`

**Where:** `native-src/dziri-engine/src/lib.rs:239`, `native-src/dziri-engine/src/engine.rs:263`, `native-src/dziri-engine/src/engine.rs:368`, `native-src/dziri-engine/src/lib.rs:291`

**Claim.** Every internal fallible operation returns `Result<_, String>`, which carries a message but not a category, so `lib.rs` must pick one status per entry point — and the picks are wrong for most of the paths that can actually fail.

**Evidence.** lib.rs:239-244: `match engine.tick() { Ok(()) => status::OK, Err(message) => fail(status::LAYOUT, message) }`. But `tick()` (engine.rs:263-297) propagates from four sources: `pump_input()?` → `resize()?` → `"Skia could not allocate a {width}x{height} raster surface"` (engine.rs:530) and `window.resize()?` → `"SDL_CreateTexture on resize: {e}"` (window.rs:109); `resync()?` and `compute()?` → genuine Taffy errors; and `present()?` → `"Skia surface has no readable pixels"` (engine.rs:373, :377) and `"SDL_UpdateTexture: {e}"` (window.rs:125). All five reach the host as `status::LAYOUT`. Symmetrically `dziri_engine_resize` (lib.rs:291-296) maps everything to `status::SDL`, including the Skia surface-allocation failure. The `Status` enum the schema generates for exactly this purpose (schema.ts:306-319: `SDL: -6, SKIA: -7, LAYOUT: -8`) is therefore decorative on the frame path.

**Impact.** The host's only structured signal is the status code — host.ts:117-120 renders `${STATUS_NAMES[code]} — ${lastError()}`, so a user out of video memory is told "dziri_engine_tick failed: LAYOUT". Any host-side recovery keyed on the code (retry a resize on SDL, refuse to render on LAYOUT, surface a driver message on SKIA) is impossible, and this is the one place where the codebase's own rule — "returns a status, never a value" so failure is machine-distinguishable (lib.rs:8-10) — is satisfied in form but not substance. `String` errors also `format!`-allocate on every failure path, on the render thread.

**Recommendation.** `String` is defensible for the *detail* — it is only ever read by a human through `dziri_last_error`, and a `thiserror` hierarchy would buy little across an i32 boundary. But the *category* must travel with the error. Define `pub struct EngineError { pub status: i32, pub detail: String }` with `::skia(...)`, `::sdl(...)`, `::layout(...)`, `::capacity(...)` constructors, change the internal signatures to `Result<T, EngineError>`, and reduce every `lib.rs` arm to `Err(e) => fail(e.status, e.detail)`. That is ~20 call sites, it deletes the guessing, and `boundary.rs` gains a test worth writing: force a surface-allocation failure and assert the code is SKIA, not LAYOUT.

**Verifier — confirmed.** One impact detail is overstated: the human is not left with a bare "LAYOUT". host.ts:117-120 appends the detail string, so an out-of-VRAM user sees `dziri_engine_tick failed: LAYOUT — Skia could not allocate a 1920x1080 raster surface`. What is actually lost is machine classification (any code-keyed recovery), not the diagnosis.

<a id="f-quality-tests-process-max-fields-flat-index-unguarded"></a>

### MEDIUM · `MAX_FIELDS = 64` strides the span index with no compile-time guard; styles is at 48

`soundness` · `quality-tests-process/max-fields-flat-index-unguarded`

**Where:** `native-src/dziri-engine/src/tables.rs:582`, `native-src/dziri-engine/src/tables.rs:291`, `native-src/dziri-engine/src/tables.rs:334`, `src/protocol/schema.ts:85`

**Claim.** The (table, field) → span lookup is a flat array strided by a hardcoded 64, so a schema that grows any table past 64 fields silently aliases into the next table's row rather than failing to build — the precise failure class the generated-schema design exists to prevent.

**Evidence.** tables.rs:291 `let mut index = vec![-1i32; TABLE_COUNT * MAX_FIELDS];` and :294 `index[span.table as usize * MAX_FIELDS + span.field as usize] = i as i32;`, read back at :334 `let i = self.index[table * MAX_FIELDS + field];` guarded only by `debug_assert!(i >= 0, …)` (:335) — a no-op in the release build the host loads. `MAX_FIELDS: usize = 64` (:582). Generated field counts (protocol.rs:76-184): nodes 9, **styles 48**, states 4, lists 5, layout 4, strings 2. Sixteen more style fields — and `lineClamp`/`overflow` are already in the schema unimplemented (schema.ts:137-138), with gradients, shadows, transforms and opacity queued in A1 (ROADMAP.md:322) — puts field 64 of `styles` at `index[1*64 + 64] == index[2*64 + 0]`, which is `states.node`. `plan_of(States, NODE)` then returns the *style* span. Nothing in the build fails: `build_index` writes in bounds because the vector is `TABLE_COUNT * 64` long.

**Impact.** A schema addition would make the engine read `states.node` out of a style span — the wrong bytes at a valid offset, in release, with no error. tables.rs:343-349 documents this exact class of bug from experience: "Reading a `Bounds` span out of the `live` arena is not a crash … it is *the wrong bytes*, which is exactly the failure mode the whole schema-generation design exists to prevent. It shipped here for about ten minutes." Same trap, one indirection away, still armed.

**Recommendation.** Make it a build error. `gen-protocol.ts` already knows every field count, so emit `pub const MAX_FIELD_COUNT: usize = <max over tables>;` into `protocol.rs` and use that as the stride, deleting the magic 64 entirely. If a literal is preferred, add a const assertion that cannot be skipped: `const _: () = { let mut i = 0; while i < TABLE_COUNT { assert!(protocol::FIELD_COUNTS[i] <= MAX_FIELDS); i += 1; } };`. Also promote the `debug_assert!` at :335 to a real panic — it is inside `catch_unwind`, so a panic there is a POISONED status with a message, strictly better than reading wrong bytes.

**Verifier — confirmed.** The direction of the aliasing is backwards. plan() builds spans table-major in schema order (tables.rs:247-272) and build_index writes them in plan order (tables.rs:290-297), so a 65th styles field writes index[1*64+64] = index[128] *first* and states field 0 then overwrites it. `plan_of(States, NODE)` therefore stays correct; it is `plan_of(Styles, <field 64>)` that returns the states.node span — a style read landing on state bytes. Also worth adding: only the last table (strings) would panic out of bounds; a growth in any earlier table aliases silently.

<a id="f-quality-tests-process-protocol-version-hand-maintained"></a>

### MEDIUM · `PROTOCOL_VERSION` is the one hand-maintained value in a generated protocol

`process` · `quality-tests-process/protocol-version-hand-maintained`

**Where:** `src/protocol/schema.ts:327`, `scripts/gen-protocol.ts:94`, `src/engine/host.ts:165`

**Claim.** The schema's stated reason for existing is that a human keeping two files in sync "stays in sync until they don't, and the failure mode is silent memory corruption" — and the version number that guards exactly that is a hand-edited integer with no test, no checksum, and no `--check` mode in the generator.

**Evidence.** schema.ts:326-327: "Bumped on any change to the tables above" / `export const PROTOCOL_VERSION = 1;`. gen-protocol.ts:94 copies it verbatim into Rust. The startup handshake (host.ts:165-171) compares it, and `#bindTables` additionally checks *field counts* (host.ts:272-279). But field counts do not cover a field *type* change: flip `list` from `i16` to `i32` in schema.ts:71 and forget the bump, and against a stale engine binary the count still matches while `FIELD_VIEWS` hands Bun an `Int32Array` over a buffer the engine sized at `elemSize=2 * capacity` — half-length, misread values, no error. There is also no way to detect a stale *generated file*: `gen-protocol.ts` only writes, so a schema edited without re-running the generator leaves `generated.ts` and `protocol.rs` consistent with each other and both wrong.

**Impact.** Both drift modes land as wrong pixels, the outcome the design document says is unacceptable. It gets materially worse the moment the IR is versioned for third parties — ROADMAP.md:249-252 makes "IR version stamped into generated modules, checked by the engine at load" a commitment, and the same manual-bump discipline would then govern release compatibility.

**Recommendation.** Derive it. In `gen-protocol.ts`, hash the canonical serialization of `TABLES` (name, sizedBy, and each field's name+type in order) with `Bun.hash` or a 4-line FNV and emit `PROTOCOL_VERSION = <hash & 0x7fffffff>`, plus a human-readable `SCHEMA_REVISION` for release notes. The version then cannot fail to change when the layout does. Add a `--check` flag that regenerates into memory and exits non-zero if either output file differs — that is the CI gate for a stale generated file, ~10 lines. Keep the field-count handshake as the belt-and-braces it already is.

**Verifier — confirmed.** Minor: the i16->i32 drift is silent only when the capacity is even. `new Int32Array(buffer)` over an engine-sized 2*N-byte buffer throws RangeError when 2*N is not a multiple of 4, so for odd capacities the host fails loudly rather than reading half-length values.

<a id="f-quality-tests-process-no-ci-no-lint-second-test-framework"></a>

### MEDIUM · No CI, no `test` script, no lint/format config, and a hand-rolled second test framework

`process` · `quality-tests-process/no-ci-no-lint-second-test-framework`

**Where:** `package.json:6`, `src/engine-smoke.ts` (since deleted), `src/compiler/jsx-runtime.ts:103`, `native-src/dziri-engine/Cargo.toml:1`

**Claim.** Everything that runs the tests requires knowing what to type: `bun test` is in no script, `engine-smoke.ts` reimplements assertions instead of being a test file, and there is no `.github/`, `rustfmt.toml`, `clippy.toml`, or eslint/biome config — while the source already carries an eslint directive for a linter that was never configured.

**Evidence.** package.json:6-18 has `gen:protocol`, `engine`, `engine:test`, `engine:smoke`, `engine:window`, `engine:shot`, `compile`, `dev`, `app`, `variants`, `shot` — no `test`, no `check`, no `lint`, no `fmt`. `ls .github rustfmt.toml clippy.toml .eslintrc* eslint.config* .prettierrc* biome.json` → all absent. src/engine-smoke.ts (:18-30, since deleted) defines its own `check()` and `near()` with a `failures` counter and `process.exit(failures === 0 ? 0 : 1)` (:190) — 190 lines that would be ~120 as a `.test.ts`, and because it is not one, `bun test` never runs the FFI round-trip, the forced-GC deallocator check (:161-169), or the panic-survival check (:176-181), which are among the most valuable assertions in the project. jsx-runtime.ts:103: `// eslint-disable-next-line @typescript-eslint/no-explicit-any` — the only `any` in 8,000 lines, suppressing a rule from a linter that does not exist. `packageManager: "pnpm@10.29.3+…"` (package.json:23) while every script runs `bun` and the lockfile is `bun.lock`.

**Impact.** Nothing is enforced, so nothing stays true. Concretely today: `bun run variants` is broken and no one noticed; `app/ui.gen.ts` can be stale against `app/app.tsx` with no signal, and `upload.test.ts:22` imports it, so the whole TS suite can silently be testing an old compile. `packageManager: pnpm` will make a contributor run `pnpm install` and produce a second lockfile. Rust has no clippy or fmt gate on a crate with 19 `extern "C"` entry points, where `missing_safety_doc`, `not_unsafe_ptr_arg_deref` and `cast_possible_truncation` are exactly the lints that matter (tables.rs alone has 63 `as` casts).

**Recommendation.** Four small things, in order. (1) `"test": "bun test && bun run engine:test"`, `"check": "tsc --noEmit"`, and rename `src/engine-smoke.ts` → `src/engine/smoke.test.ts` using `bun:test`'s `expect`, deleting `check`/`near`/the exit code. (2) One `.github/workflows/ci.yml` on a Windows runner (the only verified toolchain, ROADMAP.md:39-41): `bun install --frozen-lockfile`, `bun run gen:protocol --check`, `bun run check`, `cargo fmt --check`, `cargo clippy -- -D warnings`, `bun run compile && git diff --exit-code app/ui.gen.ts`, `bun run test`. (3) Delete `packageManager` or set it to `bun@…`. (4) Either add eslint with `@typescript-eslint` (almost nothing would need fixing — `tsc` is already clean under `strict` + `noUncheckedIndexedAccess`) or delete the orphan directive and replace the `any` with a generic `<Item>` on `Props`.

**Verifier — confirmed.** Two counts are off: the crate has 21 `extern "C"` entry points (16 of them `unsafe`), not 19, and tables.rs contains 71 ` as ` casts, not 63. Neither changes the conclusion.

**Since this review (2026-08-01).** Recommendation (1) is done, in `28fa0b4`: `test`, `check` and `lint` scripts exist, and the second test framework is gone — `src/engine-smoke.ts` is now `src/engine/smoke.test.ts`, a `bun:test` file using `expect`, so the FFI round-trip, the forced-GC deallocator check and the panic-survival check run under `bun test` instead of needing to be typed. (4) is half done: the orphan eslint directive is deleted, but the `any` it was suppressing is still there (`src/compiler/jsx-runtime.ts:107`) and no linter was added. (2) and (3) are untouched — no `.github/`, no `rustfmt.toml`/`clippy.toml`, and `packageManager` is still pnpm (`package.json:47`). So the title now overstates: two of its four clauses are fixed. The evidence above is left as written, because it is what was true when the review was taken.

<a id="f-quality-tests-process-unsafe-op-in-unsafe-fn"></a>

### LOW · 19 `unsafe extern "C"` fns are wholly implicit unsafe blocks; no `unsafe_op_in_unsafe_fn`

`soundness` · `quality-tests-process/unsafe-op-in-unsafe-fn`

**Where:** `native-src/dziri-engine/src/lib.rs:1`, `native-src/dziri-engine/src/lib.rs:209`, `native-src/dziri-engine/src/lib.rs:262`, `native-src/dziri-engine/src/lib.rs:366`, `native-src/dziri-engine/Cargo.toml:4`

**Claim.** The crate is edition 2021 with no lint attributes, so every raw-pointer dereference and `from_raw_parts_mut` inside the FFI entry points is unmarked — there is no syntactic distinction between the one line that is genuinely unsafe and the fifty around it that are not.

**Evidence.** `edition = "2021"` (Cargo.toml:4) and lib.rs has no `#![deny(...)]` or `#![warn(...)]` at all. The pattern repeats 19 times: lib.rs:188-213 `pub unsafe extern "C" fn dziri_engine_describe(...)` contains `let slice = std::slice::from_raw_parts_mut(out, capacity as usize);` (:209) with no `unsafe {}` and no `// SAFETY:`; lib.rs:262 the same in `drain_events`; lib.rs:372-375 four raw `*out.add(n) = …` writes in `surface_info`; lib.rs:352, :403, :454, :478 `copy_nonoverlapping`. By contrast the code that *does* mark its unsafety documents it well — `with()` (lib.rs:49-53), `Arena` (tables.rs:113-140), `read_title` (engine.rs:583-585), `old.destroy()` (window.rs:112-115) all carry real SAFETY comments. The FFI layer is the exception, and it is the layer where it matters most.

**Impact.** Two costs. Reviewability: in `dziri_engine_describe` the reader cannot see that `from_raw_parts_mut(out, capacity)` trusts a host-supplied length — note it uses `capacity`, not the already-validated `engine.span_count()`, so a host passing a large `capacity` with a small buffer gets a slice over memory it does not own; the `# Safety` doc states the contract but the body does not mark where it is relied upon. Migration: `unsafe_op_in_unsafe_fn` is deny-by-default in edition 2024, as is bare `#[no_mangle]` (all 19 need `#[unsafe(no_mangle)]`), so this is required work deferred rather than avoided.

**Recommendation.** Add `#![deny(unsafe_op_in_unsafe_fn)]` to lib.rs now and fix the ~25 resulting errors by wrapping each pointer operation in `unsafe { }` with a one-line `// SAFETY:` naming the documented precondition it relies on. While doing it, clamp `describe` and `drain_events` to `min(capacity, span_count())` / `min(capacity, events.len())` so an over-large `capacity` cannot produce an out-of-bounds slice even if the host lies. Then add `#![deny(clippy::undocumented_unsafe_blocks, clippy::cast_possible_truncation)]`; the second will fire on some of tables.rs's 63 `as` casts (`elem_size as u32`, `capacity as usize`, `slot as u32`) and each hit is a u32/usize boundary that deserves an explicit `try_into().expect()` inside the panic guard.

**Verifier — weakened.** There are 16 `pub unsafe extern "C" fn` in lib.rs (21 `extern "C" fn` and 21 `#[no_mangle]` in total), not 19; the pattern repeats 16 times. And the claim that "a host passing a large capacity with a small buffer gets a slice over memory it does not own" overstates it: describe and drain_events both clamp their writes to the real element count (tables.rs:313, engine.rs:552), so nothing is written out of range. The accurate framing is code-hygiene plus edition-2024 migration debt on the FFI layer — worth doing, but not a live unsoundness.

<a id="f-quality-tests-process-retired-spikes-still-on-disk"></a>

### LOW · Retired spikes and the old runtime's DLLs still on disk; 378 MB of it is build output

`cleanliness` · `quality-tests-process/retired-spikes-still-on-disk`

**Where:** `native-src/taffy-ffi/src/lib.rs:1`, `native-src/skia-probe/src/main.rs:1`, `native/win32-x64/libSkiaSharp.dll:1`, `src/runtime/list-runtime.ts:357`

**Claim.** `taffy-ffi` and `skia-probe` are finished spikes referenced only in prose, each with its own `Cargo.lock` and target directory, and `native/win32-x64/` still holds the three DLLs the retired TypeScript runtime needed — none of which any current code path loads.

**Evidence.** `grep -rn "taffy-ffi|taffy_ffi|skia-probe"` over `src app scripts native-src/dziri-engine package.json` finds only prose: Cargo.toml:17 ("Pinned to what `native-src/skia-probe` verified"), build.rs:3, text.rs:16, plus NOTES.md:180/216 and ROADMAP.md:45. No `[workspace]` in any manifest, so they are three independent crates. `du -sh`: skia-probe 350M, taffy-ffi 13M. `native/win32-x64/` holds `libSkiaSharp.dll` (12.2 MB), `SDL3.dll` (2.8 MB), `taffy_ffi.dll` (416 KB) and `probe.json`; host.ts:64-82 only ever looks for `dziri_engine.{dll,dylib,so}`, and SDL3 is `build-from-source-static` (Cargo.toml:29) so the loose `SDL3.dll` cannot be needed either. Smaller vestige in the same class: src/runtime/list-runtime.ts:357 ends with a bare `void findRow;` although `findRow` is genuinely used at :97 and :106.

**Impact.** Compounds the repository-size finding — 378 MB of the 1.1 GB is spike build output. A newcomer reading `native-src/` sees three crates and cannot tell which is the product, and ROADMAP.md's "What survives, what retires" section (line 176) does not name these. `probe.json` in the same directory implies the probe is still part of the build.

**Recommendation.** Move both spikes to `docs/spikes/` with their `src/` and manifests but no lockfile or target, or delete them and keep only their measured conclusions — which NOTES.md:180-216 already records in more useful form than the code does. Delete `native/win32-x64/{libSkiaSharp,SDL3,taffy_ffi}.dll` and `probe.json`; keep the directory as a documented drop location for a prebuilt `dziri_engine`, since host.ts:74 searches it. Delete the `void findRow;` line.

**Verifier — confirmed.** Small nuance: the DLLs *are* named as retired in ROADMAP.md:183 ("Retires: ... plus `libSkiaSharp.dll` and `SDL3.dll` as shipped artifacts") and NOTES.md:481 — they are documented-retired-but-undeleted rather than undocumented. It is the two spike *crates* that the "What survives, what retires" section never names.

---

# Part 3 — What is already right

Collected from the reviewers independently, before synthesis. These are the decisions to protect from well-meaning refactors; Part 1 §4 explains why each one is load-bearing.

**Protocol & code generation**

- Sentinel decoding on the engine side is genuinely complete and correctly reasoned: `opt()` folds NaN *and* ±Infinity to `None` so both the compiler's `AUTO` and `INITIAL_STYLE`'s `maxW: Infinity` decode as auto (native-src/dziri-engine/src/layout.rs:295), `placement()` treats 0 as `GridPlacement::Auto` keeping CSS lines 1-based (layout.rs:387), and `align_of` leaves Taffy's default rather than coercing to variant 0 (layout.rs:322) — every sentinel in the schema survives the typed-array round trip.
- Reporting absolute per-span pointers instead of (base, byteOffset) is the right call and the doc argues it correctly: three arenas would make "which base" one more thing to agree about, and `toArrayBuffer(ptr, 0, elemSize * capacity)` leaves no arithmetic on either side to get wrong (native-src/dziri-engine/src/tables.rs:18).
- The staged/live/bounds three-arena split earns its memory through `commit`'s span-wise memcmp: `classify` turns "this span differs" into structure-vs-style-vs-text, and `collect_changed_slots` narrows a theme patch to the slots that moved (native-src/dziri-engine/src/tables.rs:525) — this is the real justification for struct-of-arrays, stronger than the monomorphism claim the comments lead with.
- `prefill_links` filling 0xff into text/parent/firstChild/nextSibling/list in *both* arenas, with the explicit reasoning that node 0 is a valid id so a zeroed `firstChild` makes every node its own child (native-src/dziri-engine/src/tables.rs:221) — correct, and it keeps the first commit a genuine no-op.
- `FIELD_ORDER` in the host is derived from the generated `F` map by sorting on index rather than restated as a name list (src/engine/host.ts:512) — exactly the discipline the rest of the protocol should follow, and it does eliminate that particular drift.
- Deriving the IR's encodings from the generated protocol instead of restating them — `export const Justify = { START: SchemaJustify.FLEX_START, ... }` renames without re-encoding (src/ir.ts:34) — so the compiler and engine cannot disagree that `justify-content: center` is 1.

**FFI boundary soundness & memory safety**

- `Arena` stores a bare `*mut u8` and materialises `&[u8]`/`&mut [u8]` only inside function bodies (native-src/dziri-engine/src/tables.rs:101-133) — the single detail that keeps today's model sound: no Rust reference into shared memory is live across a return to Bun, and `&mut Engine` from `with()` does not cover the arena bytes.
- `#[repr(C)]` on `Handle` is used correctly for what it can do: it guarantees field order and `magic` at offset 0 even though `Engine`'s own layout is unspecified, so the sentinel check reads the bytes it intends to (native-src/dziri-engine/src/lib.rs:36-40).
- `describe` refuses a short buffer before writing anything and zeroes `written` first, so a partial descriptor is impossible (native-src/dziri-engine/src/lib.rs:198-207), and the behaviour is pinned by a test (native-src/dziri-engine/tests/boundary.rs:119-144).
- Host-written *table contents* are consistently distrusted: `relink` range-checks every child id and budgets the walk against cycles (native-src/dziri-engine/src/layout.rs:88-113), and `string()` returns "" rather than panicking on a bad (offset, length) (native-src/dziri-engine/src/tables.rs:473-491).
- Both length-taking copy-outs clamp with `min(bytes.len(), len)` and accept a null buffer as a pure size query, which is the correct C idiom (native-src/dziri-engine/src/error.rs:88-98, native-src/dziri-engine/src/lib.rs:474-479).
- `panic = "unwind"` is pinned in both profiles with a comment explaining that `catch_unwind` depends on it (native-src/dziri-engine/Cargo.toml:32-40), so the boundary's failure story cannot be defeated by a profile edit.

**Compiler: CSS cascade, parsing, variants**

- The greedy right-to-left descendant matcher is provably correct, and the doc comment's argument holds: with only descendant combinators the compounds are independent predicates, so taking the nearest matching ancestor maximises the remaining prefix (standard exchange argument). No backtracking needed. src/compiler/compile.ts:51-80
- Resolving each pseudo-class state as a *full cascade from scratch* rather than a patch over the finished base style is the right call, and is the specific thing that makes correct per-property state merging cheap to add later: `collectDecls(rules, path, ["none","hover","focus"])` already computes the exact CSS answer for hover∧focus. src/compiler/compile.ts:84-114
- Patching the *style table* rather than swapping node style pointers, with conflicts detected per (field, slot) instead of per node, is the correct insight and is documented with the measurement that justified it. src/compiler/variant-compile.ts:1-20, src/compiler/variant-compile.ts:281-300
- The interner's hand-built key is genuinely collision-free: every value is a number, `String(number)` can never contain the `|` separator, and NaN/NaN interning together is the desired behaviour rather than an accident. src/compiler/compile.ts:202-215
- `parseTracks` rejecting `auto-fit`/`auto-fill` and mixed track sizes loudly, with the reason (unverified in Taffy, inexpressible in one integer), is exactly the right failure mode for this project's thesis. src/compiler/css.ts:299-339
- `Element` is the right seam between the two front-ends: nothing downstream branches on provenance, `onClick: unknown` absorbs both a function and a name string, and the JSX-only fields are simply hardcoded null by html.ts rather than needing a variant type. src/compiler/compile.ts:317-322

**Authoring front-end: JSX runtime & reference resolution**

- The `Tag` union plus the absence of `key` in `Props` makes `<dvi/>` and `key={1}` real type errors — verified with tsc: `error TS2339: Property 'dvi' does not exist on type 'JSX.IntrinsicElements'` and `Property 'key' does not exist on type 'Props'` (src/compiler/jsx-runtime.ts:491).
- DynText part merging is exactly right: `{remaining} of {total} left · …` collapses to ONE IR text node with interleaved literal/signal parts rather than five flex items — verified at app/ui.gen.ts:93 (src/compiler/jsx-runtime.ts:354).
- Object destructuring inside a map callback works and records the correct path — `({ title }) => <div>{title}</div>` compiles to `parts: [{ path: ["title"] }]`, because named destructuring is a plain Get on the recorder (src/compiler/item-path.ts:19).
- The `ownKeys` trap converting `<Row {...t}/>` from a silently-blank row into a loud error that names the fix is a good use of a Proxy invariant, and the doc comment explains precisely why the default was worse (src/compiler/item-path.ts:38).
- `compileTimeArray` hijacking `.map` only when `options.key` is present is the correct discrimination: it keeps `computed(() => todos.value.map(…))` a legitimate build-time map instead of turning derived data into a compile error (src/runtime/signal.ts:231).
- Inline `style={{ color: someSignal }}` is rejected at the authoring site with the right advice rather than silently dropped — verified error text names the property and points to `cn({…})` (src/compiler/jsx-runtime.ts:175).

**Runtime: signals, patches, dynamic lists**

- Interning a style slot over the *vector* of its values across every variant (src/compiler/variant-compile.ts:200-214) makes patching a shared style entry safe by construction — two nodes share a slot only if they agree in the baseline and in every toggle — so the feared interaction is genuinely a non-issue: app/ui.gen.ts:122 and :131 show both patches writing slot 16 with no interference.
- The engine does not trust the host's `(offset, length)`: `Tables::string` (native-src/dziri-engine/src/tables.rs:473-491) checks the slot index, uses `saturating_add`, rejects `end > arena.len()` and falls back on invalid UTF-8, returning `""` rather than panicking — with a regression test asserting exactly that (tables.rs:830-840).
- Both tree walks are explicitly stacked and budgeted against a hostile `firstChild`/`nextSibling` written from JS (native-src/dziri-engine/src/layout.rs:94-113 and :256-262), so a cycle or out-of-range child is a returned error, not a hung or blown render thread.
- Growing a list arena by appending a fresh larger one and abandoning the old region (src/runtime/list-runtime.ts:75-85) is the right call given focus is a node id: no existing id is invalidated, which growing in place would have made impossible, and doubling bounds the waste at 2×.
- The "~20 KB runtime" claim measures out: host + upload + the four runtime modules + ir.ts + the generated protocol bundles to 22.5 KB minified / 8.0 KB gzipped (`bun build --minify --target=bun`, 10 modules), and tree-shaking correctly drops the compiler-only `recorder`/`ItemSpreadError` that list-runtime.ts drags in via item-path.ts; app/ui.gen.ts (18 KB) is data, not runtime.
- Patch application is idempotent and cheap to re-run: the `applied` WeakMap (src/runtime/patches.ts:30-39) skips a patch already in the requested state and the `Object.is` guard on writes (src/runtime/signal.ts:90) means a re-toggled boolean costs zero writes and zero notifications.

**Engine: layout (Taffy) & table management**

- `Arena` refuses `Vec<u8>` and allocates with an explicit 16-byte alignment plus `assert!(!ptr.is_null())`, so every span's 8-aligned offset guarantees the u16/u32/f32 casts by construction and an OOM is a catchable panic rather than Vec's abort — native-src/dziri-engine/src/tables.rs:101.
- The `start == 0 → GridPlacement::Auto` guard is genuinely load-bearing, not defensive noise: taffy 0.9.2 does `panic!("Grid line of zero is invalid")` at coordinates.rs:38, so this one branch is what keeps a zeroed style slot from poisoning the engine — native-src/dziri-engine/src/layout.rs:337.
- NaN-as-auto and Infinity-as-none are applied consistently and no non-finite value reaches Taffy arithmetic: `dim`/`lpa` map both to `auto`, `lp` coerces to 0 where `auto` is meaningless, and `flex_grow`/`flex_shrink`/`aspect_ratio` each carry their own `is_finite` fallback to the CSS initial value — native-src/dziri-engine/src/layout.rs:296.
- `hidden → Display::None` with an early return really does exclude the subtree: taffy's `compute_hidden_layout` zeroes the node and recurses into all children (compute/mod.rs:266), and paint and hit_test both `continue` before pushing children, so the subtree is neither drawn nor hittable — native-src/dziri-engine/src/layout.rs:362.
- The root's window-size write is guarded by an equality check on `s.size` before `set_style`, precisely because `set_style` marks the node dirty — the one place in the engine that already understands the dirty-propagation cost this review found missing everywhere else — native-src/dziri-engine/src/layout.rs:183.
- `Home::Shared` vs `Home::Bounds` forces every access through `read_arena`/`write_arena` rather than a raw offset, and the doc comment names the exact bug it prevents and admits it shipped once — a design that encodes the failure mode instead of warning about it — native-src/dziri-engine/src/tables.rs:350.

**Engine: paint, text & Skia**

- Colour is correct end to end and I could not break it: `parseColor` emits `(a<<24)|(r<<16)|(g<<8)|b` (src/compiler/css.ts:196) which is exactly SkColor's unpremultiplied 0xAARRGGBB, `Color::from(u32)` is a `#[repr(transparent)]` no-op wrapper (skia-safe-0.87.0/src/core/color.rs:19), and the `bg >> 24 != 0` alpha test reads the right byte (native-src/dziri-engine/src/paint.rs:169).
- SkPaint is hoisted out of the hot loop rather than constructed per node: `Painter { fill, stroke }` is built once (native-src/dziri-engine/src/paint.rs:43-59) and the loop only calls `set_color`/`set_stroke_width`; `draw_round_rect` builds its SkRRect on the stack and `draw_str` takes `&str` bytes directly, so there is no Path, RRect, Vec, String or CString allocation per node anywhere in `Painter::node`.
- Both tree walks are iterative with an explicit budget, so a host-written `firstChild`/`nextSibling` cycle cannot blow or hang the render thread (native-src/dziri-engine/src/paint.rs:122-130 and 251-259).
- The advance cache is deliberately bounded FIFO at 4096 with the reason stated and a test that proves it stays bounded under minted-per-frame strings (native-src/dziri-engine/src/text.rs:51 and 226-232).
- Presenting is genuinely swizzle-free and copy-free on the Skia side: n32 is byte-identical to SDL's ARGB8888 on little-endian (native-src/dziri-engine/src/window.rs:14-18) and `peek_pixels()` borrows the surface rather than snapshotting it (native-src/dziri-engine/src/engine.rs:372).
- `Painter::paint` takes `&Canvas`, not `&mut Surface`, so the painter itself is backend-agnostic and would survive a Ganesh/Graphite move unchanged (native-src/dziri-engine/src/paint.rs:106-114).

**Windowing, input & threading**

- The reasoning for having no `Drop` on the texture is correct and hard-won: SDL destroys a renderer's textures with the renderer, and `destroy` after the canvas is gone is UB — so dropping the canvas is the right teardown and `resize` is the only place a texture is orphaned early enough to destroy by hand (native-src/dziri-engine/src/window.rs:192).
- Both tree walks over host-written link fields are iterative and budgeted, so a hostile or half-written `firstChild`/`nextSibling` chain from Bun cannot hang or blow the stack — a real threat model for shared-memory input, taken seriously (native-src/dziri-engine/src/paint.rs:120, paint.rs:253).
- Pumping input *before* commit, so a click staged by Bun last frame and a click arriving this frame are never resolved against different layouts, is the right ordering and the comment explains why (native-src/dziri-engine/src/engine.rs:266).
- IME text is truncated on a UTF-8 char boundary rather than mid-codepoint before being copied into the fixed 32-byte inline field, which is exactly the bug most fixed-buffer event structs ship with (native-src/dziri-engine/src/engine.rs:486).
- `needs_paint` gating means an idle tick is an event-queue drain and no pixels at all, and the comment correctly notes that not presenting is not the same as presenting nothing — the window keeps its last frame (native-src/dziri-engine/src/engine.rs:285).
- The `n32` / packed `ARGB8888` byte-identity is verified rather than assumed, which removes a per-pixel swizzle from the present path and is the kind of ABI fact this project consistently measures instead of guessing (native-src/dziri-engine/src/window.rs:14).

**Security & supply chain**

- Every tree walk in the engine is iterative with an explicit visit budget and a bounds check on every child index, so a cyclic or out-of-range parent/child chain written by the host is an `Err` or a skipped node rather than a stack overflow or an OOB read — layout.rs:88-121 (relink, budget `count*2+16`), layout.rs:256-283 (read_back, "a deep tree from a hostile table must not blow the render thread's stack"), paint.rs:122-146, paint.rs:251-282 — and tests/bounds.rs:334 `a_cycle_in_the_child_chain_is_an_error_not_a_hang` proves it.
- `Tables::string` is the model the rest of the boundary should copy: slot range check, `saturating_add` on the length, arena bound, and a checked `from_utf8`, with the reason stated — "the slot table is host-written memory, so a wrong value is a Bun-side bug that must not be able to panic the render thread" (tables.rs:473-491) — plus a negative test at tables.rs:831 `a_bad_slot_cannot_panic_the_render_thread`.
- The staged/live/bounds three-arena split (tables.rs:7-16, commit at tables.rs:498-522) means layout and paint never observe a half-written frame, so a torn host write costs a stale frame rather than a corrupt one — and it is the same mechanism that will make the A0-step-3 render thread safe, a rare case of a safety property bought once and spent twice.
- The FFI boundary is genuinely disciplined and tested: `catch_unwind` + magic-number handle validation + poisoning + status-only returns with out-parameters (lib.rs:44-72), with `tests/boundary.rs:73 a_panic_becomes_a_status_code_and_poisons_the_engine` and `:98 a_destroyed_handle_is_refused_rather_than_dereferenced`; Cargo.toml:35-38 explicitly refuses `panic = "abort"` and says why.
- `toArrayBuffer` is called with no finalizer and the reason is documented as the thing that would otherwise be a double free — "the memory belongs to Rust, and a JS-side deallocator would free it out from under the engine" (host.ts:206-213) — as is the rule that `ptr()` is taken at each use and never cached, with the hour it cost written down (host.ts:91-103).
- The library is loaded from an absolute path built from `import.meta.dir` and `existsSync`-checked before `dlopen` (host.ts:64-84), so the primary DLL is never resolved through PATH or the CWD — the obvious Windows search-order hijack is closed by construction rather than by luck.

**Code quality, tests & process**

- The Rust engine is the better-tested half and its tests are chosen for consequence, not coverage: a panic becomes a status code and poisons the engine, a destroyed handle is refused rather than double-freed, and a short descriptor buffer writes nothing — the three failures a scripting host actually causes (native-src/dziri-engine/tests/boundary.rs:73).
- `tests/bounds.rs` runs a whole headless engine against hand-computed bounds and includes the adversarial case, not just the happy path: a cycle in `firstChild`/`nextSibling` written by a hostile host must be an error and not a hang (native-src/dziri-engine/tests/bounds.rs:334).
- `tables.rs`'s inline tests assert invariants rather than outputs: spans never overlap and are aligned, a colour-only patch reports exactly one changed slot and no structural change, growth preserves contents and bumps the generation, and a corrupt string slot returns `""` instead of panicking the render thread (native-src/dziri-engine/src/tables.rs:759).
- TypeScript strictness is real and currently clean: `strict` plus `noUncheckedIndexedAccess` and `verbatimModuleSyntax`, one `any` in 8,000 lines, `tsc --noEmit` exits 0 — and the 200+ non-null assertions are almost all the mechanical `arr[i]!` that `noUncheckedIndexedAccess` demands after an explicit bounds check, which is the right trade (tsconfig.json:9).
- Doc comments consistently record the rejected alternative and why, which is what makes the code reviewable at all: `Vec<u8>` rejected for the arena because its alignment is only 1 byte (native-src/dziri-engine/src/tables.rs:95), `@preact/signals-core` rejected because the compiler must recognise signals by identity (src/runtime/signal.ts:1), a JS finalizer on `toArrayBuffer` rejected because the memory belongs to Rust (src/engine/host.ts:206).
- The one TS test file makes the right structural choice for a moving target — nodes are located by what their computed style *is* (the node with four grid tracks, the ones with `position: absolute`), so editing `app.tsx` renumbers every node without breaking an assertion (src/engine/upload.test.ts:66).

---

# Part 4 — Refuted claims

Raised by a reviewer and dropped by the refutation pass. Recorded so they are not re-raised: each one is a plausible-sounding concern that the code does not support.

### commit() takes &[u8] over the host-written staged arena; a render thread makes that a race

*Dimension: `ffi-soundness`*

**Why it does not hold.** The finding refutes itself on today's code and then assigns 'high (architecture)' to a step that is not built. Its own evidence is correct: `Arena` holds only `ptr: *mut u8` (tables.rs:101-104) and materialises slices inside function bodies (tables.rs:125-133), so no `&`/`&mut` into an arena is live across a return to Bun and no aliasing claim ever overlaps a JS write. The residual claim is that engine.rs:11-17 asserts the split is *sufficient* for a render thread. It does not. The sentence the finding quotes is immediately followed, in the same paragraph, by 'That move is A0's step 3 and is deliberately not made yet: a render thread with a synchronous descriptor and no thread-safe handle would be a second unfinished thing rather than a finished first one' — i.e. it names two other blockers. ROADMAP.md:64 marks step 3 'half', and ROADMAP.md:673-676 says outright 'what is missing is a thread-safe handle and a published-snapshot swap' — which is exactly the mechanism the finding recommends. So this reports a roadmap-scheduled item as a present architecture defect. The one thing that survives is a clause of prose.

### Reverse-mapping by export name makes per-instance component state unrepresentable

*Dimension: `authoring-frontend`*

**Why it does not hold.** The headline claim — "two instances of the same component are forced to share one exported signal, so they cannot have independent state" and "per-instance component state is unrepresentable" — is factually wrong, and I disproved it by building the exact case. Two `<Accordion open={…} onClick={…}/>` instances driven by two module-level signals (`openA`, `openB`) compiled cleanly to `7 nodes, 4 style slots (3 baseline)`, `2 conditional class(es): .open 5 writes +relayout, .open 5 writes +relayout`, node style pointers `new Uint16Array([0,1,2,2,3,2,2])` (distinct slots 1 and 3), and two independent patches in `stylePatches` — `signal: openA` at line 113 and `signal: openB` at line 124. Per-instance state works today; the variant compiler interns per-slot exactly as the finding itself concedes. Their lockstep repro used the *same* signal for both instances, which is the author's choice and would behave identically in React (one useState hoisted into the parent). What is actually true is narrower and already documented as the deliberate contract, not a defect: state must be *named* at module scope, so a signal created inside a component throws (I reproduced `a signal interpolated into node 2 is not a module-level export of a known state module` from resolve-refs.ts:66) and inline arrows cannot be handlers. That contract is spelled out three times in prose — src/compiler/resolve-refs.ts:1-13, app/state.ts:4-7, src/compiler/html.ts:18-24. The remaining kernel (component-*owned*, i.e. uncontrolled, state) is a Phase C item: ROADMAP.md:441 lists "Controlled/uncontrolled state" under C1, and ROADMAP.md:465 already records that Bun hides the AST. Reporting a Phase-C prerequisite as a present high-severity architecture defect is reporting a roadmap-scheduled item as a gap.

### Reference errors say "node 34" while jsx-dev-runtime discards Bun's source location

*Dimension: `authoring-frontend`*

**Why it does not hold.** The premise is false: Bun does not hand the dev runtime a source location, so nothing is being discarded. I probed it three ways. (1) `new Bun.Transpiler({loader:"tsx"}).transformSync(...)` emits `jsxDEV_7x81h0kn("div", {...}, undefined, false, undefined, this)` — the 5th argument (`_source`) is the literal `undefined`. (2) A shim jsx-dev-runtime pointed at by `@jsxImportSource` and imported through the real Bun runtime logged `jsxDEV args: {"type":"div","isStatic":false} self: undefined` — i.e. source and self both undefined, under default env and under NODE_ENV=development. (3) `bun build` output is `jsxDEV("div", {...}, undefined, false, undefined, this)`. Also tried target:browser, target:bun and jsxOptimizationInline:false — all identical. So the justification comment at src/compiler/jsx-dev-runtime.ts:5-8 is not throwing away file/line/column; there is nothing there to throw away, and the headline recommendation ("Thread `_source` from `jsxDEV` onto `Element` as `loc: { file, line, col }`") cannot be implemented as written and would silently produce `undefined:undefined:undefined`. The residual is much smaller than claimed: the messages built at resolve-refs.ts:80/91/96/100/104 do say "node N", and for handlers `typeof value === "function" && value.name` really is available and unused. Improving them means threading the `describe()` selector path (compile.ts:360-363) or the function name through BuiltHandler/BuiltTextBinding — not "one nullable field", and not the cheapest large improvement in the front-end (that is the item-recorder sentinel check).

### `type` is accepted and discarded, when it is the compile-time semantics data C1 commits to

*Dimension: `authoring-frontend`*

**Why it does not hold.** This reports a documented deliberate stub whose successor is roadmap-scheduled, which is the exclusion the brief names. The code comment at src/compiler/jsx-runtime.ts:107-110 states the intent in full: "Accepted and ignored. There are no form widgets yet, so `<input>` compiles to an empty box — these exist so markup written against HTML habits typechecks." The behaviour matches the documentation exactly: `<input className="row" type="checkbox" name="ok" />` compiled to `2 nodes` with `kind: new Uint8Array([0,0])`. The semantics table the finding wants `type` folded into is ROADMAP.md:444-447 under C1, and the widgets that would read it are ROADMAP.md:455 Tier 1 ("Needs A3 and A5's text input") — both future phases, and the engine is at A0 with "steps 3-6 remain". The finding also concedes erroring would be wrong, so the entire actionable content reduces to "add a build warning and pre-emptively store a field for a consumer that does not exist" — speculative generality, and against the governing principle of not carrying data nothing reads. Nor is the re-plumbing cost real: `type` is a prop on Props already, and adding it to `Element` when the first widget lands is a one-line change with no migration. The `name` half is also weak: the finding wants it deleted while the comment gives the reason it exists (HTML habits typecheck), and both goals cannot hold at once.

### `PixelSizeChanged` and `Resized` are conflated despite carrying different units

*Dimension: `window-input-threading`*

**Why it does not hold.** The code is quoted correctly (window.rs:143-148 unions PixelSizeChanged and Resized; engine.rs:399-404 keeps only the last; size_in_pixels/size at window.rs:90-99 have no callers anywhere in src, examples or tests). The *impact* does not exist, for two independent reasons. (1) Pixel size differs from point size only under SDL_WINDOW_HIGH_PIXEL_DENSITY, which is opt-in (sdl3-0.18.4 video.rs:1528 high_pixel_density) and is never requested — window.rs:57-64 only calls position_centered()/resizable()/borderless(). SDL's Cocoa backend converts to backing coordinates solely under that flag (SDL_cocoawindow.m:1247-1250, 2290-2293), and the Windows backend does no DPI scaling of window coordinates at all (WIN_GetWindowSizeInPixels returns the client rect, SDL_windowswindow.c:1012-1029). So today both events carry identical numbers on every platform. (2) Even with the flag, ordering is deterministic and favourable, not a race: SDL_SendWindowEvent pushes RESIZED and then synchronously calls SDL_OnWindowResized (SDL_windowevents.c:272-274), which calls SDL_CheckWindowPixelSizeChanged (SDL_video.c:4291-4294) and pushes PIXEL_SIZE_CHANGED *after* it — so "keep the last in the batch" always lands on the pixel size, i.e. the correct value for the Skia surface. The claimed 'blurry window that alternates with a sharp one depending on timing' cannot happen.

---

# Appendix — reproducing this review

The audit ran as a workflow script. To re-run it, or to re-run one dimension after fixes:

```
script:  .claude/.../workflows/scripts/skia-proto-architecture-audit-wf_99d23a84-ba3.js
run id:  wf_99d23a84-ba3
raw:     tasks/wdfgfzlv8.output   (full JSON: verdict, 114 findings, 60 strengths, 5 refuted)
```

The script holds the ten dimension prompts verbatim, so a dimension can be re-pointed at the same files after a fix and the two results diffed. Unchanged agents replay from cache on resume.
