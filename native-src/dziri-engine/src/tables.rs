//! The shared-memory tables: allocation, the descriptor Bun reads them through,
//! and the staged→live commit.
//!
//! Struct-of-arrays throughout, so a style patch touches one contiguous span and
//! paint reads stay monomorphic.
//!
//! # Three arenas, not one
//!
//! - **staged** — Bun writes here, freely and without an FFI call. Nothing reads
//!   it except [`Tables::commit`].
//! - **live** — the engine's view. Only `commit` writes it, so layout and paint
//!   never observe a half-written frame. This is what makes the engine safe to
//!   render on its own schedule.
//! - **bounds** — layout output. The engine writes, Bun reads for hit-testing and
//!   the imperative API. It is deliberately *not* staged: the flow is one-way, so
//!   there is nothing to tear across.
//!
//! # Why the descriptor reports pointers, not offsets
//!
//! The roadmap says `(byteOffset, elemSize, capacity)`, which assumes one base
//! pointer. Three arenas means three bases, and "which base" is one more thing to
//! agree about — so each span reports its own absolute address instead. Bun does
//! `toArrayBuffer(ptr, 0, elemSize * capacity)` and there is no arithmetic on
//! either side to get wrong.
//!
//! # Growth
//!
//! A list arena regrowing raises the node count, which resizes every
//! `sizedBy: "nodes"` span and therefore invalidates every pointer Bun holds.
//! [`Tables::generation`] is bumped on any reallocation; Bun re-reads the
//! descriptor whenever it changes, and views built against an older generation
//! must be dropped.

use std::alloc::{alloc_zeroed, dealloc, Layout as AllocLayout};

use crate::protocol::{self, TABLE_COUNT};

/// A span belonging to a named region rather than a table field.
pub const REGION: i32 = -1;
/// The UTF-8 byte arena the string slot table points into.
pub const REGION_STRING_BYTES: i32 = 0;

/// One contiguous field span, as reported to Bun.
///
/// `#[repr(C)]` with explicit padding order: 8-byte `ptr` first would be natural,
/// but keeping the two `i32` identifiers first makes the record read the same way
/// on both sides — table, field, then where it lives.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct SpanDesc {
    /// Table index, or [`REGION`] when this is a named region.
    pub table: i32,
    /// Field index within the table, or a `REGION_*` code.
    pub field: i32,
    pub ptr: u64,
    pub elem_size: u32,
    pub capacity: u32,
}

/// How many elements each table holds.
///
/// `#[repr(C)]` because the host passes one by pointer to ask for growth: a list
/// arena outgrowing its capacity raises the node count, and the sparse state and
/// interactive tables grow with it.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Capacities {
    pub nodes: u32,
    pub styles: u32,
    pub variants: u32,
    pub variant_slots: u32,
    pub media: u32,
    pub lists: u32,
    pub tweens: u32,
    pub keyframes: u32,
    pub controls: u32,
    pub strings: u32,
    pub string_bytes: u32,
    pub images: u32,
}

impl Capacities {
    /// Resolves a table's element count from its schema `sizedBy`.
    fn for_table(&self, table: usize) -> u32 {
        match protocol::SIZED_BY[table] {
            "nodes" => self.nodes,
            "styles" => self.styles,
            "strings" => self.strings,
            // `own`: sized by its own request. `states` and `lists` are the only
            // two, and they are matched by name because the schema does not say
            // which "own" is which.
            _ => match protocol::TABLE_NAMES[table] {
                "variants" => self.variants,
                "variantSlots" => self.variant_slots,
                "media" => self.media,
                "lists" => self.lists,
                "tweens" => self.tweens,
                "keyframes" => self.keyframes,
                "controls" => self.controls,
                "images" => self.images,
                other => unreachable!("table {other} has no capacity rule"),
            },
        }
    }
}

/// A 16-byte-aligned block of bytes.
///
/// `Vec<u8>` would be wrong here: its allocation is only guaranteed 1-byte
/// aligned, and every span in it is reinterpreted as `u32`/`f32`. In practice the
/// allocator over-aligns, which is exactly the kind of thing that works until it
/// doesn't on one machine.
struct Arena {
    ptr: *mut u8,
    size: usize,
}

const ARENA_ALIGN: usize = 16;

impl Arena {
    fn new(size: usize) -> Self {
        // A zero-sized allocation is UB, and an engine with no nodes is a
        // legitimate (if useless) state, so round up.
        let size = size.max(ARENA_ALIGN);
        let layout = AllocLayout::from_size_align(size, ARENA_ALIGN).expect("arena layout");
        // SAFETY: non-zero size, valid alignment. Zeroed so an unwritten field
        // reads as 0 rather than as whatever the allocator last held.
        let ptr = unsafe { alloc_zeroed(layout) };
        assert!(!ptr.is_null(), "out of memory allocating {size} bytes");
        Self { ptr, size }
    }

    fn base(&self) -> *mut u8 {
        self.ptr
    }

    fn as_slice(&self) -> &[u8] {
        // SAFETY: the allocation is `size` bytes and outlives the borrow.
        unsafe { std::slice::from_raw_parts(self.ptr, self.size) }
    }

    fn as_mut_slice(&mut self) -> &mut [u8] {
        // SAFETY: as above, and `&mut self` makes the borrow exclusive.
        unsafe { std::slice::from_raw_parts_mut(self.ptr, self.size) }
    }
}

impl Drop for Arena {
    fn drop(&mut self) {
        let layout = AllocLayout::from_size_align(self.size, ARENA_ALIGN).expect("arena layout");
        // SAFETY: allocated by us with this exact layout.
        unsafe { dealloc(self.ptr, layout) }
    }
}

/// Where a span lives, resolved when the descriptor is built.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Home {
    /// Staged (Bun-written) and live (engine-read) arenas, same offset in both.
    Shared,
    /// Layout output, one arena, one direction.
    Bounds,
}

#[derive(Clone, Copy)]
struct SpanPlan {
    table: i32,
    field: i32,
    home: Home,
    offset: usize,
    elem_size: u32,
    capacity: u32,
}

impl SpanPlan {
    fn byte_len(&self) -> usize {
        self.elem_size as usize * self.capacity as usize
    }
}

/// Spans are 8-aligned inside the arena, which covers every element type in the
/// schema up to `f64`.
const SPAN_ALIGN: usize = 8;

fn align_up(n: usize, to: usize) -> usize {
    (n + to - 1) & !(to - 1)
}

pub struct Tables {
    plan: Vec<SpanPlan>,
    staged: Arena,
    live: Arena,
    bounds: Arena,
    caps: Capacities,
    generation: u64,
    /// Index into `plan` per (table, field), so lookups are not a linear scan in
    /// the paint path.
    index: Vec<i32>,
}

impl Tables {
    pub fn new(caps: Capacities) -> Self {
        let (plan, shared_size, bounds_size) = Self::plan(caps);
        let index = Self::build_index(&plan);

        let mut tables = Self {
            plan,
            staged: Arena::new(shared_size),
            live: Arena::new(shared_size),
            bounds: Arena::new(bounds_size),
            caps,
            generation: 1,
            index,
        };
        tables.prefill_links();
        tables
    }

    /// Sets every link field to `-1` — "no link" — in both arenas.
    ///
    /// Zero is a valid node id, so a zeroed `firstChild` says every node is its
    /// own first child, and the cycle detector correctly refuses to lay that out.
    /// The IR has always spelled "none" as `-1`; the allocation should agree
    /// rather than making an untouched table malformed.
    ///
    /// Both arenas get it, so the first commit still sees no difference. Node
    /// capacity is headroom for list growth, and the spare rows stay unreachable
    /// from the root, which is what makes them free.
    ///
    /// Note this covers *links only*. Style values stay zeroed, and zero is a
    /// real value there: `width: 0`, not `auto`. `auto` is `NaN`, so every style
    /// field the compiler emits must actually be written.
    fn prefill_links(&mut self) {
        use protocol::nodes as n;
        let nodes = protocol::Table::Nodes as usize;

        for field in [n::TEXT, n::PARENT, n::FIRST_CHILD, n::NEXT_SIBLING] {
            let span = *self.plan_of(nodes, field);
            for arena in [&mut self.staged, &mut self.live] {
                let range = span.offset..span.offset + span.byte_len();
                arena.as_mut_slice()[range].fill(0xff); // -1 in two's complement
            }
        }

        let list = *self.plan_of(nodes, n::LIST);
        for arena in [&mut self.staged, &mut self.live] {
            let range = list.offset..list.offset + list.byte_len();
            arena.as_mut_slice()[range].fill(0xff);
        }
    }

    /// Lays every span out in schema order, which keeps a table's fields adjacent
    /// and makes the descriptor readable when it is dumped for debugging.
    fn plan(caps: Capacities) -> (Vec<SpanPlan>, usize, usize) {
        let mut plan = Vec::new();
        let mut shared = 0usize;
        let mut bounds = 0usize;

        for table in 0..TABLE_COUNT {
            let home = if protocol::TABLE_NAMES[table] == "layout" {
                Home::Bounds
            } else {
                Home::Shared
            };
            let capacity = caps.for_table(table);

            for (field, &elem_size) in protocol::elem_sizes(table).iter().enumerate() {
                let cursor = match home {
                    Home::Shared => &mut shared,
                    Home::Bounds => &mut bounds,
                };
                let offset = align_up(*cursor, SPAN_ALIGN);
                let span = SpanPlan {
                    table: table as i32,
                    field: field as i32,
                    home,
                    offset,
                    elem_size: elem_size as u32,
                    capacity,
                };
                *cursor = offset + span.byte_len();
                plan.push(span);
            }
        }

        // The UTF-8 arena the string slots address. Not a table: it has no
        // element structure, only offsets and lengths.
        let offset = align_up(shared, SPAN_ALIGN);
        plan.push(SpanPlan {
            table: REGION,
            field: REGION_STRING_BYTES,
            home: Home::Shared,
            offset,
            elem_size: 1,
            capacity: caps.string_bytes,
        });
        shared = offset + caps.string_bytes as usize;

        (plan, shared, bounds)
    }

    fn build_index(plan: &[SpanPlan]) -> Vec<i32> {
        let mut index = vec![-1i32; TABLE_COUNT * MAX_FIELDS];
        for (i, span) in plan.iter().enumerate() {
            if span.table >= 0 {
                index[span.table as usize * MAX_FIELDS + span.field as usize] = i as i32;
            }
        }
        index
    }

    pub fn capacities(&self) -> Capacities {
        self.caps
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn span_count(&self) -> usize {
        self.plan.len()
    }

    /// Fills `out` with the descriptor. Returns the number of spans written.
    pub fn describe(&self, out: &mut [SpanDesc]) -> usize {
        let n = out.len().min(self.plan.len());
        for (slot, span) in out.iter_mut().zip(self.plan.iter()).take(n) {
            let base = match span.home {
                // Bun writes the staged arena and never sees `live`.
                Home::Shared => self.staged.base(),
                Home::Bounds => self.bounds.base(),
            };
            *slot = SpanDesc {
                table: span.table,
                field: span.field,
                // SAFETY: offset is within the arena by construction.
                ptr: unsafe { base.add(span.offset) } as u64,
                elem_size: span.elem_size,
                capacity: span.capacity,
            };
        }
        n
    }

    fn plan_of(&self, table: usize, field: usize) -> &SpanPlan {
        let i = self.index[table * MAX_FIELDS + field];
        debug_assert!(i >= 0, "no span for table {table} field {field}");
        &self.plan[i as usize]
    }

    fn bytes<'a>(arena: &'a Arena, span: &SpanPlan) -> &'a [u8] {
        &arena.as_slice()[span.offset..span.offset + span.byte_len()]
    }

    /// Which arena a span's offset is measured in.
    ///
    /// Every read and write must go through this. Reading a `Bounds` span out of
    /// the `live` arena is not a crash — the offset is in range — it is *the
    /// wrong bytes*, which is exactly the failure mode the whole schema-generation
    /// design exists to prevent. It shipped here for about ten minutes and the
    /// integration tests caught it as NaN bounds.
    fn read_arena(&self, home: Home) -> &Arena {
        match home {
            Home::Shared => &self.live,
            Home::Bounds => &self.bounds,
        }
    }

    fn write_arena(&mut self, home: Home) -> &mut Arena {
        match home {
            // Writes from the host land in `staged`; only `commit` moves them.
            Home::Shared => &mut self.staged,
            Home::Bounds => &mut self.bounds,
        }
    }

    /// The engine's read view of a field.
    fn live_bytes(&self, table: usize, field: usize) -> &[u8] {
        let span = self.plan_of(table, field);
        Self::bytes(self.read_arena(span.home), span)
    }

    /// Bun's write view of a field — only [`Self::commit`] and the tests read it.
    fn staged_bytes(&self, table: usize, field: usize) -> &[u8] {
        let span = self.plan_of(table, field);
        match span.home {
            Home::Shared => Self::bytes(&self.staged, span),
            Home::Bounds => Self::bytes(&self.bounds, span),
        }
    }

    /// Bun's write view, for tests and for the host-side helpers that seed a
    /// table before the first commit.
    pub fn staged_mut(&mut self, table: usize, field: usize) -> &mut [u8] {
        let span = *self.plan_of(table, field);
        let range = span.offset..span.offset + span.byte_len();
        &mut self.write_arena(span.home).as_mut_slice()[range]
    }

    /// Writes one element of a staged field.
    ///
    /// Bun does this through typed-array views with no call at all; these exist
    /// for the Rust tests and for anything that drives the engine in-process.
    ///
    /// A note that matters more than it looks: the arenas start **zeroed**, and
    /// zero is a real value — `width: 0`, not `auto`. `auto` is `NaN`. Every
    /// style field the compiler emits must actually be written, or a node
    /// silently collapses.
    fn set_bytes(&mut self, table: usize, field: usize, index: usize, value: &[u8]) {
        let span = *self.plan_of(table, field);
        debug_assert_eq!(
            span.elem_size as usize,
            value.len(),
            "wrong width for field"
        );
        if index >= span.capacity as usize {
            return;
        }
        let at = span.offset + index * value.len();
        self.write_arena(span.home).as_mut_slice()[at..at + value.len()].copy_from_slice(value);
    }

    pub fn set_u8(&mut self, table: usize, field: usize, index: usize, value: u8) {
        self.set_bytes(table, field, index, &value.to_le_bytes());
    }

    pub fn set_u16(&mut self, table: usize, field: usize, index: usize, value: u16) {
        self.set_bytes(table, field, index, &value.to_le_bytes());
    }

    pub fn set_i16(&mut self, table: usize, field: usize, index: usize, value: i16) {
        self.set_bytes(table, field, index, &value.to_le_bytes());
    }

    pub fn set_u32(&mut self, table: usize, field: usize, index: usize, value: u32) {
        self.set_bytes(table, field, index, &value.to_le_bytes());
    }

    pub fn set_i32(&mut self, table: usize, field: usize, index: usize, value: i32) {
        self.set_bytes(table, field, index, &value.to_le_bytes());
    }

    pub fn set_f32(&mut self, table: usize, field: usize, index: usize, value: f32) {
        self.set_bytes(table, field, index, &value.to_le_bytes());
    }

    /// Stages a string: appends UTF-8 to the arena and points a slot at it.
    /// Returns the slot, or `None` when the arena is full.
    pub fn push_string(&mut self, slot: usize, text: &str, cursor: &mut u32) -> Option<u32> {
        let bytes = text.as_bytes();
        let start = *cursor as usize;
        let arena = self.staged_string_bytes_mut();
        if start + bytes.len() > arena.len() {
            return None;
        }
        arena[start..start + bytes.len()].copy_from_slice(bytes);
        *cursor += bytes.len() as u32;

        let strings = protocol::Table::Strings as usize;
        self.set_u32(strings, protocol::strings::OFFSET, slot, start as u32);
        self.set_u32(strings, protocol::strings::LENGTH, slot, bytes.len() as u32);
        Some(slot as u32)
    }

    pub fn string_bytes(&self) -> &[u8] {
        let span = self
            .plan
            .iter()
            .find(|s| s.table == REGION && s.field == REGION_STRING_BYTES)
            .expect("string arena");
        Self::bytes(&self.live, span)
    }

    pub fn staged_string_bytes_mut(&mut self) -> &mut [u8] {
        let span = *self
            .plan
            .iter()
            .find(|s| s.table == REGION && s.field == REGION_STRING_BYTES)
            .expect("string arena");
        let range = span.offset..span.offset + span.byte_len();
        &mut self.staged.as_mut_slice()[range]
    }

    /// Reads a string slot out of the arena.
    ///
    /// Returns `""` rather than failing on a bad `(offset, length)`: the slot
    /// table is host-written memory, so a wrong value is a Bun-side bug that must
    /// not be able to panic the render thread.
    pub fn string(&self, slot: i32) -> &str {
        if slot < 0 {
            return "";
        }
        let offsets = self.u32s(protocol::Table::Strings as usize, protocol::strings::OFFSET);
        let lengths = self.u32s(protocol::Table::Strings as usize, protocol::strings::LENGTH);
        let slot = slot as usize;
        if slot >= offsets.len() {
            return "";
        }

        let start = offsets[slot] as usize;
        let end = start.saturating_add(lengths[slot] as usize);
        let arena = self.string_bytes();
        if end > arena.len() {
            return "";
        }
        std::str::from_utf8(&arena[start..end]).unwrap_or("")
    }

    /// Replaces the live tables with what Bun staged, and reports what changed.
    ///
    /// The diff is the whole reason the split earns its memory: comparing spans
    /// is a `memcmp` over a few tens of kilobytes, and it tells the layout stage
    /// which nodes to re-measure instead of re-measuring all of them.
    pub fn commit(&mut self) -> Diff {
        let mut diff = Diff::default();
        let nodes = protocol::Table::Nodes as usize;
        let styles = protocol::Table::Styles as usize;

        for i in 0..self.plan.len() {
            let span = self.plan[i];
            if span.home != Home::Shared {
                continue;
            }

            let range = span.offset..span.offset + span.byte_len();
            if self.staged.as_slice()[range.clone()] == self.live.as_slice()[range.clone()] {
                continue;
            }

            diff.any = true;
            self.classify(&span, &mut diff, nodes, styles);

            let (dst, src) = (&mut self.live, &self.staged);
            dst.as_mut_slice()[range.clone()].copy_from_slice(&src.as_slice()[range]);
        }

        diff
    }

    /// Turns "this span differs" into "this is what the engine must redo".
    ///
    /// Each arm names the *narrowest* consequence, because the engine can now
    /// act on an index set rather than a verb. Two of these used to be wrong in
    /// the expensive direction: `kind` is read by paint and by nothing in
    /// layout, and `list` is read by nobody at all, yet both were filed as
    /// structural and so cost a whole new Taffy tree.
    fn classify(&self, span: &SpanPlan, diff: &mut Diff, nodes: usize, styles: usize) {
        use protocol::nodes as n;

        if span.table as usize == nodes {
            match span.field as usize {
                // The chains *are* the tree. `parent` is not read here either —
                // relink derives everything from `firstChild`/`nextSibling` —
                // but a host that moves a node writes it, and counting it keeps
                // "rewrite the description, the engine re-derives" true for the
                // price of relinking one extra node.
                n::FIRST_CHILD | n::NEXT_SIBLING | n::PARENT => {
                    self.collect_changed_slots(span, &mut diff.changed_links)
                }
                // `hidden` maps to `display: none`, which is a style, not a shape.
                n::STYLE | n::HIDDEN | n::FLAGS => {
                    self.collect_changed_slots(span, &mut diff.changed_nodes)
                }
                // Repointing a node at a *different* slot changes its measured
                // size even when no string moved, so this is its own set rather
                // than a flag folded into the string one.
                n::TEXT => self.collect_changed_slots(span, &mut diff.changed_texts),
                // Paint-only, and read-by-nobody, respectively. `any` is already
                // true, and that is what schedules the repaint.
                n::KIND | n::LIST => {}
                _ => {}
            }
            return;
        }

        if span.table as usize == styles {
            // A paint-only field needs no entry at all. Paint reads this table
            // out of live memory every frame, so recolouring is finished the
            // moment `commit` copies the bytes — and `any` has already asked for
            // the repaint. Taffy never hears about it.
            //
            // This is what `resync`'s doc comment has always claimed and what the
            // code did not do: the compiler classifies `.light` as paint-only and
            // says so on every build, and the engine relaid out the document
            // anyway, because `classify` discarded `span.field`.
            if protocol::styles::LAYOUT_AFFECTING[span.field as usize] {
                self.collect_changed_slots(span, &mut diff.changed_styles);
            }
            return;
        }

        if span.table as usize == protocol::Table::Variants as usize
            || span.table as usize == protocol::Table::VariantSlots as usize
        {
            diff.variants = true;
            return;
        }

        if span.table == REGION && span.field == REGION_STRING_BYTES {
            diff.string_bytes = true;
            return;
        }

        if span.table as usize == protocol::Table::Strings as usize {
            self.collect_changed_slots(span, &mut diff.changed_strings);
        }
    }

    /// Which entries of a span differ, so a one-colour theme patch does not
    /// invalidate every style slot.
    fn collect_changed_slots(&self, span: &SpanPlan, out: &mut Vec<u32>) {
        let width = span.elem_size as usize;
        let base = span.offset;
        for slot in 0..span.capacity as usize {
            let range = base + slot * width..base + (slot + 1) * width;
            if self.staged.as_slice()[range.clone()] != self.live.as_slice()[range] {
                out.push(slot as u32);
            }
        }
        out.sort_unstable();
        out.dedup();
    }
}

/// The largest field count across all tables, so the (table, field) index is a
/// flat array rather than a map.
///
/// **Generated, not chosen.** This was hand-written as `64` while `styles` was
/// already at 48 and growing. Because [`Tables::plan`] is table-major, exceeding
/// the stride would not have overflowed the index — it would have made
/// `plan_of(Styles, 64)` return the span belonging to `states.node`, aliasing
/// two tables onto each other at a valid offset. Only the very last table would
/// have panicked; every earlier one would have read the wrong bytes in silence.
const MAX_FIELDS: usize = protocol::MAX_FIELD_COUNT;

// The index is `TABLE_COUNT * MAX_FIELDS` entries with `MAX_FIELDS` as the
// stride, so this is the invariant that makes `plan_of` sound. It is checked at
// compile time rather than trusted, because the failure mode is silent.
const _: () = {
    let mut table = 0;
    while table < TABLE_COUNT {
        assert!(
            protocol::FIELD_COUNTS[table] <= MAX_FIELDS,
            "a table has more fields than MAX_FIELDS; regenerate the protocol"
        );
        table += 1;
    }
};

/// What a commit changed, in the terms the engine acts on.
///
/// Three of these were bare booleans, and a boolean leaves the engine no
/// response but "redo everything, over table *capacity*": a fresh `TaffyTree`
/// with a leaf per node, then a style push per node. One appended list row paid
/// for the whole document, and the routing plan's twenty resident routes would
/// have paid for twenty on every relink.
///
/// The index set was already in hand. [`Tables::collect_changed_slots`] computed
/// it for style slots and string slots and is generic over spans; these are the
/// same call against the node columns.
#[derive(Default, Debug)]
pub struct Diff {
    pub any: bool,
    /// Nodes whose child-chain description moved. Relink these, and whoever
    /// last owned them.
    pub changed_links: Vec<u32>,
    /// Nodes whose own Taffy style is stale: `style`, `hidden` or `flags`.
    pub changed_nodes: Vec<u32>,
    /// Style *slots* whose values moved; every node wearing one is stale.
    pub changed_styles: Vec<u32>,
    /// Nodes repointed at a different string slot.
    pub changed_texts: Vec<u32>,
    /// String slots whose `(offset, length)` moved.
    pub changed_strings: Vec<u32>,
    /// The string arena's bytes moved. On its own — with no slot entry changing
    /// — it means content was rewritten *underneath* unchanged slots, which is
    /// the one text case no index set narrows.
    pub string_bytes: bool,
    /// No consumer, deliberately: paint reads the variant tables out of live
    /// memory every frame, so a change to them needs exactly the repaint that
    /// `any` already schedules. Recorded because the alternative is a silent
    /// arm in `classify` that reads as an oversight.
    pub variants: bool,
}

// ---------------------------------------------------------------------------
// Typed views
//
// Every span is a whole number of elements at an 8-aligned offset in a 16-aligned
// arena, so the casts below are aligned by construction. They are checked in
// debug builds anyway, because "by construction" is exactly the claim that stops
// being true when someone edits the plan.
// ---------------------------------------------------------------------------

macro_rules! typed_view {
    ($name:ident, $ty:ty) => {
        impl Tables {
            pub fn $name(&self, table: usize, field: usize) -> &[$ty] {
                let bytes = self.live_bytes(table, field);
                debug_assert_eq!(bytes.len() % std::mem::size_of::<$ty>(), 0);
                debug_assert_eq!(bytes.as_ptr() as usize % std::mem::align_of::<$ty>(), 0);
                // SAFETY: aligned by the span plan, and the element size came
                // from the same schema that produced the field index.
                unsafe {
                    std::slice::from_raw_parts(
                        bytes.as_ptr() as *const $ty,
                        bytes.len() / std::mem::size_of::<$ty>(),
                    )
                }
            }
        }
    };
}

typed_view!(u8s, u8);
typed_view!(u16s, u16);
typed_view!(i16s, i16);
typed_view!(u32s, u32);
typed_view!(i32s, i32);
typed_view!(f32s, f32);

impl Tables {
    /// Scatters computed bounds into the layout table's four spans.
    ///
    /// Taking `&mut` on four spans at once would need four disjoint borrows of
    /// one arena, so the engine computes into a row-major scratch and this writes
    /// it out — which is also the only place layout output is published.
    pub fn write_bounds(&mut self, rows: &[[f32; 4]]) {
        let table = protocol::Table::Layout as usize;
        for field in 0..protocol::layout::FIELD_COUNT {
            let span = *self.plan_of(table, field);
            let count = rows.len().min(span.capacity as usize);
            let start = span.offset;
            let bytes = &mut self.bounds.as_mut_slice()[start..start + span.byte_len()];
            debug_assert_eq!(bytes.as_ptr() as usize % 4, 0);
            // SAFETY: the layout table is all `f32` by schema, and the span is
            // 8-aligned in a 16-aligned arena.
            let out = unsafe {
                std::slice::from_raw_parts_mut(bytes.as_mut_ptr() as *mut f32, bytes.len() / 4)
            };
            for (i, row) in rows.iter().enumerate().take(count) {
                out[i] = row[field];
            }
        }
    }

    /// Reads bounds back, for hit-testing and for tests asserting on layout.
    pub fn bounds_of(&self, node: usize) -> [f32; 4] {
        let table = protocol::Table::Layout as usize;
        let mut out = [0.0f32; 4];
        for (field, slot) in out.iter_mut().enumerate() {
            let span = *self.plan_of(table, field);
            if node >= span.capacity as usize {
                continue;
            }
            let start = span.offset + node * 4;
            let raw = &self.bounds.as_slice()[start..start + 4];
            *slot = f32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]);
        }
        out
    }

    /// True when Bun has staged bytes that differ from what the engine is
    /// rendering. Cheap enough to call per frame: it stops at the first
    /// difference.
    pub fn has_staged_changes(&self) -> bool {
        self.plan
            .iter()
            .filter(|s| s.home == Home::Shared)
            .any(|s| {
                let range = s.offset..s.offset + s.byte_len();
                self.staged.as_slice()[range.clone()] != self.live.as_slice()[range]
            })
    }

    /// Grows any table that is smaller than `want`, preserving contents.
    ///
    /// This is the list-arena growth path: outgrowing a list appends a larger
    /// arena past the end of the node arrays, which raises the node count and
    /// drags every `sizedBy: "nodes"` span with it. The sparse state table grows
    /// too, because the new rows need interaction styles.
    ///
    /// Returns whether anything moved. When it did, **every pointer from a
    /// previous descriptor is dangling** and the host must re-read it — which is
    /// what the generation counter is for.
    pub fn grow(&mut self, want: Capacities) -> bool {
        let caps = Capacities {
            nodes: self.caps.nodes.max(want.nodes),
            styles: self.caps.styles.max(want.styles),
            variants: self.caps.variants.max(want.variants),
            variant_slots: self.caps.variant_slots.max(want.variant_slots),
            media: self.caps.media.max(want.media),
            lists: self.caps.lists.max(want.lists),
            tweens: self.caps.tweens.max(want.tweens),
            keyframes: self.caps.keyframes.max(want.keyframes),
            controls: self.caps.controls.max(want.controls),
            strings: self.caps.strings.max(want.strings),
            string_bytes: self.caps.string_bytes.max(want.string_bytes),
            images: self.caps.images.max(want.images),
        };
        if caps == self.caps {
            return false;
        }

        let mut grown = Tables::new(caps);
        // Copy staged and live across span by span: offsets move, contents do not.
        for span in &self.plan {
            if span.home != Home::Shared || span.table < 0 {
                continue;
            }
            let (t, f) = (span.table as usize, span.field as usize);
            let len = span.byte_len();
            let dst_len = grown.plan_of(t, f).byte_len().min(len);
            grown.staged_mut(t, f)[..dst_len].copy_from_slice(&self.staged_bytes(t, f)[..dst_len]);
            let live = self.live_bytes(t, f)[..dst_len].to_vec();
            let dst = grown.plan_of(t, f);
            let range = dst.offset..dst.offset + dst_len;
            grown.live.as_mut_slice()[range].copy_from_slice(&live);
        }

        let string_bytes = self.string_bytes().to_vec();
        let n = string_bytes
            .len()
            .min(grown.staged_string_bytes_mut().len());
        grown.staged_string_bytes_mut()[..n].copy_from_slice(&string_bytes[..n]);

        let generation = self.generation + 1;
        *self = grown;
        self.generation = generation;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Table;

    fn caps() -> Capacities {
        Capacities {
            nodes: 8,
            styles: 4,
            variants: 2,
            variant_slots: 8,
            media: 2,
            lists: 1,
            tweens: 2,
            keyframes: 4,
            controls: 4,
            strings: 4,
            string_bytes: 64,
            images: 1,
        }
    }

    #[test]
    fn spans_do_not_overlap_and_are_aligned() {
        let tables = Tables::new(caps());
        let mut descs = vec![
            SpanDesc {
                table: 0,
                field: 0,
                ptr: 0,
                elem_size: 0,
                capacity: 0
            };
            tables.span_count()
        ];
        assert_eq!(tables.describe(&mut descs), tables.span_count());

        let mut seen: Vec<(u64, u64)> = Vec::new();
        for d in &descs {
            let len = d.elem_size as u64 * d.capacity as u64;
            assert_eq!(d.ptr % d.elem_size.max(1) as u64, 0, "span misaligned");
            for (start, end) in &seen {
                assert!(d.ptr >= *end || d.ptr + len <= *start, "spans overlap");
            }
            seen.push((d.ptr, d.ptr + len));
        }
    }

    #[test]
    fn commit_reports_only_what_changed() {
        let mut tables = Tables::new(caps());
        // Both arenas start zeroed, so an untouched stage is genuinely a no-op.
        // The engine does not lean on this: its first tick builds the tree from
        // `fresh`, not from the diff, so an all-zero table still lays out once.
        assert!(!tables.commit().any, "an unchanged stage commits nothing");

        // A colour-only theme patch: one field of one style slot. It reaches the
        // live table and schedules a repaint, and it schedules no Taffy work at
        // all, because paint reads `bg` straight out of live memory.
        let bg = tables.staged_mut(Table::Styles as usize, protocol::styles::BG);
        bg[4..8].copy_from_slice(&0xff112233u32.to_le_bytes());

        let diff = tables.commit();
        assert!(diff.any, "the frame still repaints");
        assert!(diff.changed_styles.is_empty(), "a colour cannot move a box");
        assert!(
            diff.changed_links.is_empty(),
            "a style value is not a structural change"
        );
        assert_eq!(
            tables.u32s(Table::Styles as usize, protocol::styles::BG)[1],
            0xff112233
        );

        // The same patch shape, on a field layout *does* read, names the slot.
        let width = tables.staged_mut(Table::Styles as usize, protocol::styles::WIDTH);
        width[4..8].copy_from_slice(&64.0f32.to_le_bytes());

        let diff = tables.commit();
        assert_eq!(diff.changed_styles, vec![1], "only slot 1 moved");
    }

    #[test]
    fn every_styles_field_is_classified() {
        // The generator refuses a partially tagged table, so this cannot fail by
        // omission — it exists to catch the array being emitted at the wrong
        // length, which would read a neighbouring field's answer.
        assert_eq!(
            protocol::styles::LAYOUT_AFFECTING.len(),
            protocol::styles::FIELD_COUNT
        );
        // Spot-check both ends of the classification against what the engine
        // actually reads: `style_of` never looks at `radius`, and cannot lay out
        // without `width`.
        assert!(!protocol::styles::LAYOUT_AFFECTING[protocol::styles::RADIUS_TOP_LEFT]);
        assert!(protocol::styles::LAYOUT_AFFECTING[protocol::styles::WIDTH]);
        // The two halves of a border part ways here, and this pair is the reason
        // the classification is per-field rather than per-table: recolouring a
        // border is finished when `commit` copies the bytes, while *widening* it
        // moves every descendant, because `style_of` reserves it in Taffy's box.
        assert!(!protocol::styles::LAYOUT_AFFECTING[protocol::styles::BORDER_TOP_COLOR]);
        assert!(protocol::styles::LAYOUT_AFFECTING[protocol::styles::BORDER_TOP_WIDTH]);
        // Not because Taffy reads it — it does not — but because the measure
        // callback does.
        assert!(protocol::styles::LAYOUT_AFFECTING[protocol::styles::FONT_SIZE]);
    }

    #[test]
    fn relinking_children_names_the_node_that_moved() {
        let mut tables = Tables::new(caps());
        tables.commit();

        let first = tables.staged_mut(Table::Nodes as usize, protocol::nodes::FIRST_CHILD);
        first[0..4].copy_from_slice(&3i32.to_le_bytes());

        let diff = tables.commit();
        assert_eq!(diff.changed_links, vec![0], "node 0's chain, and no other");
        assert!(diff.changed_styles.is_empty());
        assert!(diff.changed_nodes.is_empty());
    }

    #[test]
    fn a_paint_only_node_column_is_not_a_relink() {
        let mut tables = Tables::new(caps());
        tables.commit();

        // `kind` is read by paint and by nothing in layout; `list` by nobody at
        // all. Both used to be filed as structural, which cost a whole new Taffy
        // tree and a style push per node.
        let kind = tables.staged_mut(Table::Nodes as usize, protocol::nodes::KIND);
        kind[2] = protocol::node_kind::BUTTON;
        let list = tables.staged_mut(Table::Nodes as usize, protocol::nodes::LIST);
        list[0..2].copy_from_slice(&1i16.to_le_bytes());

        let diff = tables.commit();
        assert!(diff.any, "the frame still repaints");
        assert!(diff.changed_links.is_empty(), "neither column is a chain");
        assert!(diff.changed_nodes.is_empty(), "nor a Taffy style");
    }

    #[test]
    fn repointing_a_node_at_another_slot_is_a_text_change() {
        let mut tables = Tables::new(caps());
        tables.commit();

        // The string arena is untouched, so nothing narrows this except the
        // node column itself — which is why it needs its own set rather than a
        // flag shared with the string slots.
        let text = tables.staged_mut(Table::Nodes as usize, protocol::nodes::TEXT);
        text[4..8].copy_from_slice(&2i32.to_le_bytes());

        let diff = tables.commit();
        assert_eq!(diff.changed_texts, vec![1]);
        assert!(diff.changed_strings.is_empty());
        assert!(!diff.string_bytes);
    }

    #[test]
    fn strings_read_through_the_arena() {
        let mut tables = Tables::new(caps());
        let text = b"Hello";
        tables.staged_string_bytes_mut()[..text.len()].copy_from_slice(text);

        let offsets = tables.staged_mut(Table::Strings as usize, protocol::strings::OFFSET);
        offsets[0..4].copy_from_slice(&0u32.to_le_bytes());
        let lengths = tables.staged_mut(Table::Strings as usize, protocol::strings::LENGTH);
        lengths[0..4].copy_from_slice(&(text.len() as u32).to_le_bytes());

        tables.commit();
        assert_eq!(tables.string(0), "Hello");
        assert_eq!(tables.string(-1), "", "a node with no text");
        assert_eq!(tables.string(99), "", "out of range is empty, not a panic");
    }

    #[test]
    fn a_bad_slot_cannot_panic_the_render_thread() {
        let mut tables = Tables::new(caps());
        let offsets = tables.staged_mut(Table::Strings as usize, protocol::strings::OFFSET);
        offsets[0..4].copy_from_slice(&60u32.to_le_bytes());
        let lengths = tables.staged_mut(Table::Strings as usize, protocol::strings::LENGTH);
        lengths[0..4].copy_from_slice(&999u32.to_le_bytes());

        tables.commit();
        assert_eq!(tables.string(0), "");
    }

    #[test]
    fn growth_preserves_contents_and_bumps_the_generation() {
        let mut tables = Tables::new(caps());
        let style = tables.staged_mut(Table::Nodes as usize, protocol::nodes::STYLE);
        style[0..2].copy_from_slice(&7u16.to_le_bytes());
        tables.commit();

        let before = tables.generation();
        assert!(tables.grow(Capacities {
            nodes: 64,
            ..caps()
        }));
        assert!(!tables.grow(caps()), "shrinking is not growth");

        assert!(
            tables.generation() > before,
            "Bun must re-read the descriptor"
        );
        assert_eq!(tables.capacities().nodes, 64);
        assert_eq!(
            tables.u16s(Table::Nodes as usize, protocol::nodes::STYLE)[0],
            7
        );
        assert_eq!(
            tables
                .u32s(Table::Layout as usize, protocol::layout::X)
                .len(),
            64,
            "layout tracks the node count"
        );
    }
}
