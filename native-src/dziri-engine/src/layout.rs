//! Taffy over the shared tables.
//!
//! Taffy earned its place in the A0 spike by being *faster than the hand-written
//! engine when nothing is dirty* (0.050 ms vs 0.162 ms on 1203 nodes) and by
//! supporting CSS Grid, which the hand-written one never would. The only thing
//! that made it slow was the text-measure callback crossing into Bun; here it
//! calls [`crate::text::Measurer`] directly.
//!
//! # Absolute bounds, not Taffy's
//!
//! Taffy reports each node's location **relative to its parent**. Paint,
//! hit-testing and the imperative `rect()` API all want absolute coordinates, so
//! the read-back walks the tree once and accumulates offsets. Getting this wrong
//! is invisible until a nested node is off by its ancestors' padding.

use taffy::prelude::*;
use taffy::style::{
    AlignContent, AlignItems, AlignSelf, BoxSizing, Dimension, Display, FlexDirection, FlexWrap,
    GridPlacement, LengthPercentage, LengthPercentageAuto, Overflow, Position, Style,
};
use taffy::{Point, Rect, Size, TaffyTree};

use crate::error::EngineError;
use crate::protocol::{
    self, align, control_kind, display as display_enum, flex_direction, flex_wrap, justify,
};
use crate::tables::Tables;
use crate::text::{FontSpec, Measurer};

const NODES: usize = protocol::Table::Nodes as usize;
const STYLES: usize = protocol::Table::Styles as usize;
const VARIANTS: usize = protocol::Table::Variants as usize;
const VARIANT_SLOTS: usize = protocol::Table::VariantSlots as usize;

/// Names a Taffy failure as a layout failure.
///
/// The category is stated once for the module rather than at every call site,
/// because it is a property of the stage: everything that can go wrong in here
/// is either Taffy refusing, or the host-written tree not being a tree. What the
/// *host* needs from that distinction is only that it is not Skia and not SDL —
/// it means "the tree is wrong", so do not retry.
///
/// Takes `&'static str` rather than a formatted message so nothing allocates on
/// the success path — `set_children` and `set_style` run once per node.
fn taffy(what: &'static str) -> impl FnOnce(taffy::TaffyError) -> EngineError {
    move |e| EngineError::layout(format!("{what}: {e:?}"))
}

/// The same, for the calls that are per-node and want to say which.
fn taffy_at(what: &'static str, node: usize) -> impl FnOnce(taffy::TaffyError) -> EngineError {
    move |e| EngineError::layout(format!("{what} on node {node}: {e:?}"))
}

pub struct LayoutTree {
    tree: TaffyTree<u32>,
    /// Our node index -> Taffy's id. Index is the identity everywhere else in
    /// the system, so this is the only place the mapping exists.
    ids: Vec<NodeId>,
    /// Absolute bounds, row-major, published to the layout table after compute.
    bounds: Vec<[f32; 4]>,
    /// Per node, how far its content reaches past its own box: `[x, y]`, never
    /// negative.
    ///
    /// This is what bounds a scroll — the offset can go from 0 to exactly this — and
    /// it comes from Taffy's `content_size` rather than from walking children,
    /// because Taffy already knows and a walk would disagree about margins.
    overflow: Vec<[f32; 2]>,
    /// Who this tree last linked each node under, or `-1`.
    ///
    /// Deliberately **not** `nodes.parent`. Nothing in the engine reads that
    /// column — the chains are the tree — and letting host memory decide *which*
    /// node to relink would turn one wrong integer into a Taffy tree silently
    /// disagreeing with the chains. This is the engine's own record of what it
    /// did, so it cannot be wrong about it.
    parents: Vec<i32>,
    root: usize,
    /// Global predicates currently satisfied — media queries today.
    ///
    /// Layout needs its own copy because `style_of` resolves a node's variant run
    /// with it, and layout runs from callers that never see the painter.
    globals: u32,
    /// The surface the current styles were resolved against, `[width, height]`.
    ///
    /// Viewport-relative lengths (`100vh`, `calc(100vw - 4rem)`) are summed into
    /// the Taffy style when it is built, so a resize is a *restyle* whenever any
    /// style uses them — see `compute`. Zeroed until the first compute, which
    /// is itself a size change, so the first layout restyles rather than
    /// laying out against a zero-sized window.
    surface: [f32; 2],
}

impl Default for LayoutTree {
    fn default() -> Self {
        Self::new()
    }
}

/// Every `TaffyTree` in this file, so none of them can be built unconfigured.
///
/// Taffy rounds laid-out boxes to whole pixels by default, as
/// `round(x + w) - round(x)`. Browsers do not: they keep sub-pixel layout and let
/// rasterisation deal with it. Rounding cost dziri a visible bug rather than just
/// fidelity — a box one pixel narrower than the text it was measured for makes
/// paint break the last glyph onto a second line, inside a box whose height was
/// computed for one, which is what turned "Clear" into "Clea/r".
///
/// It is a function and not a line in `new` because `rebuild` **replaces** the
/// tree, and the first attempt at this configured only `new` — so the setting was
/// discarded the moment anything relaid out, and the experiment silently measured
/// the unchanged engine. Two constructors, one of them the real one.
fn new_tree(capacity: usize) -> TaffyTree<u32> {
    let mut tree = TaffyTree::with_capacity(capacity);
    tree.disable_rounding();
    tree
}

impl LayoutTree {
    pub fn new() -> Self {
        Self {
            tree: new_tree(0),
            ids: Vec::new(),
            bounds: Vec::new(),
            overflow: Vec::new(),
            parents: Vec::new(),
            root: 0,
            globals: 0,
            surface: [0.0; 2],
        }
    }

    pub fn bounds(&self) -> &[[f32; 4]] {
        &self.bounds
    }

    pub fn bounds_of(&self, node: usize) -> Option<[f32; 4]> {
        self.bounds.get(node).copied()
    }

    /// How far this node's content reaches past its box, per axis. `[0, 0]` when it
    /// fits, which is also the answer for a node that does not exist.
    pub fn overflow_of(&self, node: usize) -> [f32; 2] {
        self.overflow.get(node).copied().unwrap_or([0.0, 0.0])
    }

    /// The same, for every node at once — what a walk needs alongside `bounds`.
    pub fn overflow(&self) -> &[[f32; 2]] {
        &self.overflow
    }

    /// Adopts a new set of global predicates, restyling if they moved.
    ///
    /// Layout has to participate in predicates, not just paint. The variant
    /// machinery was paint-only until now, which was invisible while the only
    /// predicates were `:hover`, `:active` and `:focus` — those are usually
    /// colours — and becomes the whole point with `@media`, where a breakpoint
    /// exists precisely to change a layout.
    ///
    /// Restyling everything on a change rather than tracking which nodes read
    /// which bit: globals only move when the window crosses a threshold, so this
    /// is O(nodes) per *breakpoint crossing*, not per frame. Tracking would buy
    /// nothing at that rate and would need its own invalidation.
    ///
    /// Returns without touching Taffy when the bits are unchanged, which is every
    /// frame that is not a crossing.
    pub fn set_globals(&mut self, tables: &Tables, globals: u32) -> Result<(), EngineError> {
        if globals == self.globals {
            return Ok(());
        }
        self.globals = globals;
        self.apply_all_styles(tables)
    }

    /// Who this tree linked `node` under, or `None` at the root.
    ///
    /// The tree's own record, not `nodes.parent`: host memory does not get to decide
    /// which box a scroll gesture escapes into.
    pub fn parent_of(&self, node: usize) -> Option<usize> {
        match self.parents.get(node).copied() {
            Some(parent) if parent >= 0 => Some(parent as usize),
            _ => None,
        }
    }

    /// Rebuilds the tree's shape from `nodes.firstChild` / `nextSibling`.
    ///
    /// Reserved for the first commit and for a capacity change: growth appends a
    /// fresh, larger arena past the end of the node arrays, so every id has to
    /// exist before anything can be linked to it. An ordinary structural change
    /// goes through [`relink_nodes`](Self::relink_nodes) instead — this
    /// allocates a whole `TaffyTree`, and its caller then pushes a style per
    /// node, both over table *capacity*.
    pub fn rebuild(&mut self, tables: &Tables, root: usize) -> Result<(), EngineError> {
        let count = tables.capacities().nodes as usize;
        self.root = root;

        self.tree = new_tree(count);
        self.ids = Vec::with_capacity(count);
        self.bounds = vec![[0.0; 4]; count];
        self.overflow = vec![[0.0; 2]; count];
        self.parents = vec![-1; count];

        for i in 0..count {
            let id = self
                .tree
                .new_leaf_with_context(Style::default(), i as u32)
                .map_err(taffy("taffy new_leaf"))?;
            self.ids.push(id);
        }

        validate_tree(tables, root, count)?;
        self.relink(tables)?;
        Ok(())
    }

    /// Rewrites every node's child list from the table's chains.
    ///
    /// [`validate_tree`] has already proved the *reachable* tree is acyclic; the
    /// budget here covers the rest, because this walks every node including
    /// unreachable ones — spare capacity and abandoned arena regions, which a bad
    /// write could still have left a sibling cycle in.
    fn relink(&mut self, tables: &Tables) -> Result<(), EngineError> {
        let count = self.ids.len();
        let first = tables.i32s(NODES, protocol::nodes::FIRST_CHILD);
        let next = tables.i32s(NODES, protocol::nodes::NEXT_SIBLING);

        let mut children: Vec<NodeId> = Vec::with_capacity(16);
        let mut budget = count.saturating_mul(2) + 16;

        for i in 0..count {
            self.relink_one(first, next, i, &mut children, &mut budget)?;
        }

        Ok(())
    }

    /// Rewrites only the child lists a commit could have moved.
    ///
    /// The set is `changed` plus, for each of them, the parent *this tree* last
    /// linked them under — [`Self::parents`], never the host's `nodes.parent`.
    ///
    /// That it is sufficient is the part worth arguing, because a missed parent
    /// is a Taffy tree quietly disagreeing with the chains. A node's child list
    /// can only differ if its own `firstChild` moved — it is then in `changed`
    /// itself — or if some node already on its chain got a new `nextSibling`,
    /// and that node's recorded parent is exactly this one. A node *joining* a
    /// chain is the same argument backwards: either the parent's `firstChild`
    /// was rewritten, or a node already in the chain was, and both are covered.
    ///
    /// Note what this deliberately does *not* do: style the nodes it links. A
    /// node linked for the first time already carries its real style, because
    /// [`Self::apply_all_styles`] walks table capacity rather than the reachable
    /// tree. That is the invariant this rests on; the comment there says so.
    pub fn relink_nodes(&mut self, tables: &Tables, changed: &[u32]) -> Result<(), EngineError> {
        let count = self.ids.len();
        if count == 0 {
            return Ok(());
        }

        // Not skippable on this path. It is the only thing between
        // `firstChild[root] = root` and a stack overflow inside
        // `compute_layout`, which `catch_unwind` cannot contain — and the walk
        // is a DFS over the live tree, which is what a rebuild cost *before*
        // allocating anything.
        validate_tree(tables, self.root, count)?;

        let mut affected: Vec<usize> = Vec::with_capacity(changed.len() * 2);
        for &node in changed {
            let node = node as usize;
            if node >= count {
                return Err(EngineError::layout(format!(
                    "changed node {node} is past the {count}-node table"
                )));
            }
            affected.push(node);
            // Read before the relink loop overwrites it: this has to be the
            // parent as of the *last* link, so a node leaving a chain still
            // relinks the chain it left.
            if self.parents[node] >= 0 {
                affected.push(self.parents[node] as usize);
            }
        }
        affected.sort_unstable();
        affected.dedup();

        let first = tables.i32s(NODES, protocol::nodes::FIRST_CHILD);
        let next = tables.i32s(NODES, protocol::nodes::NEXT_SIBLING);
        let mut children: Vec<NodeId> = Vec::with_capacity(16);
        let mut budget = count.saturating_mul(2) + 16;

        for node in affected {
            self.relink_one(first, next, node, &mut children, &mut budget)?;
        }

        Ok(())
    }

    /// One node's child list, from its chain. The buffers are the caller's so a
    /// full relink does not allocate per node.
    fn relink_one(
        &mut self,
        first: &[i32],
        next: &[i32],
        node: usize,
        children: &mut Vec<NodeId>,
        budget: &mut usize,
    ) -> Result<(), EngineError> {
        let count = self.ids.len();
        children.clear();

        let mut c = first.get(node).copied().unwrap_or(-1);
        while c >= 0 {
            let ci = c as usize;
            if ci >= count {
                return Err(EngineError::layout(format!(
                    "node {node} has child {c}, past the {count}-node table"
                )));
            }
            if *budget == 0 {
                return Err(EngineError::layout(format!(
                    "child chain from node {node} exceeded its budget — a cycle in \
                     firstChild/nextSibling"
                )));
            }
            *budget -= 1;
            children.push(self.ids[ci]);
            self.parents[ci] = node as i32;
            c = next.get(ci).copied().unwrap_or(-1);
        }

        self.tree
            .set_children(self.ids[node], children)
            .map_err(taffy_at("taffy set_children", node))
    }

    /// Gives every `LISTBOX` a height of `controls.rows` rows.
    ///
    /// The *only* part of a list box's box that is here. Stacking and clipping —
    /// `display: block` and `overflow-y: scroll` — are ordinary UA declarations in
    /// `ua-sheet.ts`, matched through the `data-dziri-listbox` attribute the compiler
    /// stamps. They belong there because they are what a list box looks like, so an
    /// author's own rule should beat them; this one cannot go there at all.
    ///
    /// # Why this is here and not in the style table
    ///
    /// It is the one box dziri cannot compile. Measured across a 4x font-size range
    /// (`probes/select-listbox.html`), a list box's content height is `size` times the
    /// option's own row height — a *ratio*, so the 17px it looks like at the default font
    /// is an instance and not a constant. And a row height is [`Measurer::line_height`]:
    /// ascent + descent + line gap, from Skia, at the resolved size. The compiler has no
    /// access to that and CSS has no `lh` unit here, so the row *count* crosses the
    /// boundary in `controls.rows` and the multiplication happens where both numbers exist,
    /// which is this function and nowhere else.
    ///
    /// # Why inside `compute` rather than in `style_of`
    ///
    /// `apply_style` rewrites a node's whole style from the tables whenever a patch touches
    /// it, so an override applied there would be silently dropped by the next conditional
    /// class. Running it at the top of every layout instead means the last word is always
    /// this, whatever else has been written since.
    ///
    /// The `set_style` calls are guarded on the value actually differing, and that guard is
    /// load-bearing rather than an optimisation: `set_style` marks a node dirty, so an
    /// unguarded version would relayout the list box — and thus its ancestors — every
    /// single frame. This is the case the warning on [`Self::apply_style`] exempts, because
    /// unlike a style patch, everything this writes is recomputed here from its inputs.
    ///
    /// The font is read from the **list box's** own style rather than an option's, since
    /// options inherit it. An author who sets `font-size` on one option gets a box sized
    /// for the others, which is the same approximation a browser makes.
    fn size_listboxes(
        &mut self,
        tables: &Tables,
        measurer: &mut Measurer,
    ) -> Result<(), EngineError> {
        const CONTROLS: usize = protocol::Table::Controls as usize;

        let ids = tables.i32s(CONTROLS, protocol::controls::NODE);
        let kinds = tables.u8s(CONTROLS, protocol::controls::KIND);
        let rows_col = tables.i32s(CONTROLS, protocol::controls::ROWS);
        let style_of_node = tables.u16s(NODES, protocol::nodes::STYLE);
        let font_size = tables.f32s(STYLES, protocol::styles::FONT_SIZE);
        let font_weight = tables.u16s(STYLES, protocol::styles::FONT_WEIGHT);
        let font_style = tables.u8s(STYLES, protocol::styles::FONT_STYLE);
        let font_family = tables.u8s(STYLES, protocol::styles::FONT_FAMILY);

        for (row, &node) in ids.iter().enumerate() {
            // A spare row is `i32::MAX` and this is untrusted host memory, so out of range
            // is a skip rather than a panic on the render thread.
            if node < 0 || node as usize >= self.ids.len() {
                continue;
            }
            if kinds.get(row).copied().unwrap_or(0) != control_kind::LISTBOX {
                continue;
            }
            let rows = rows_col.get(row).copied().unwrap_or(0);
            if rows <= 0 {
                continue;
            }

            let node = node as usize;
            // A row is one **option's** box, not one line of the list box's own font. The
            // demo found the difference immediately: its options carry `padding: 6px 8px`
            // and `font-size: 13px`, so four rows of the select's 16px line height held
            // two and a half options and clipped the third mid-word. A browser's row is
            // the option's content plus its padding — measured, `optH` 17 for a 16px line
            // with `padding: 0 2px 1px 2px` — so that is what this adds up.
            //
            // Taken from the *first* option, so a list whose options are styled unevenly
            // is sized for the first one. Same approximation a browser makes, and the same
            // one the font choice below already commits to.
            let sample = Self::first_option(tables, node, self.ids.len()).unwrap_or(node);
            let slot = style_of_node.get(sample).copied().unwrap_or(0) as usize;
            let spec = FontSpec::new(
                font_size.get(slot).copied().unwrap_or(16.0),
                font_weight.get(slot).copied().unwrap_or(400),
                font_style.get(slot).copied().unwrap_or(0),
                font_family.get(slot).copied().unwrap_or(0),
            )
            .with_leading(
                tables
                    .f32s(STYLES, protocol::styles::LINE_HEIGHT)
                    .get(slot)
                    .map(|v| if v.is_finite() && *v > 0.0 { *v } else { 0.0 })
                    .unwrap_or(0.0),
            );
            let pad = |field: usize| -> f32 {
                tables
                    .f32s(STYLES, field)
                    .get(slot)
                    .copied()
                    .filter(|v| v.is_finite())
                    .unwrap_or(0.0)
            };
            // An authored `height` on the option wins over the font. Not measured — the
            // probe never styled an option — but it is the same correctness condition the
            // padding above is: a box sized for rows that are not the rows on screen shows
            // a different number of them than it says, and the author's height is the more
            // specific statement about how tall a row is.
            let content = match tables.f32s(STYLES, protocol::styles::HEIGHT).get(slot) {
                Some(&h) if h.is_finite() => h,
                _ => measurer.line_height(spec),
            };
            // Padding and border are added either way, because an option is a
            // `content-box` like every non-root node here — so `height` names the content
            // and the box is taller than it by both. Adding them only on the measured
            // branch is the bug this spells out: it would size the list for content boxes
            // while the rows on screen are border boxes.
            let row = content
                + pad(protocol::styles::PAD_TOP)
                + pad(protocol::styles::PAD_BOTTOM)
                + pad(protocol::styles::BORDER_TOP_WIDTH)
                + pad(protocol::styles::BORDER_BOTTOM_WIDTH);
            let want = Dimension::length(row * rows as f32);

            let id = self.ids[node];
            let current = self.tree.style(id).map_err(taffy_at("taffy style", node))?;
            if current.size.height == want {
                continue;
            }

            let mut style = current.clone();
            style.size.height = want;
            self.tree
                .set_style(id, style)
                .map_err(taffy_at("taffy set_style on a list box", node))?;
        }
        Ok(())
    }

    /// The first `<option>` under `node`, in document order, or `None`.
    ///
    /// A subtree walk rather than a child scan, because an option inside an `<optgroup>` is two
    /// levels down and is still the list's first row — the same reason `select::options_of` walks
    /// rather than scans, and the same failure if it did not: a grouped list would be sized from
    /// the group box instead of from an option.
    ///
    /// Here rather than borrowed from `select.rs` because that one needs `Controls`, which layout
    /// does not have and should not: this reads the same `controls` table directly, and the only
    /// thing it wants from a row is its kind.
    fn first_option(tables: &Tables, node: usize, node_count: usize) -> Option<usize> {
        const CONTROLS: usize = protocol::Table::Controls as usize;
        let ids = tables.i32s(CONTROLS, protocol::controls::NODE);
        let kinds = tables.u8s(CONTROLS, protocol::controls::KIND);
        let first = tables.i32s(NODES, protocol::nodes::FIRST_CHILD);
        let next = tables.i32s(NODES, protocol::nodes::NEXT_SIBLING);

        // Explicit stack with children pushed reversed, so they pop in document order — the
        // shape every walk over host memory here uses, and budgeted for the same reason: a
        // cycle in the chains must cost a frame rather than the render thread.
        let mut stack = vec![node as i32];
        let mut kids: Vec<i32> = Vec::new();
        let mut budget = node_count.saturating_mul(2) + 16;

        while let Some(at) = stack.pop() {
            if budget == 0 {
                return None;
            }
            budget -= 1;
            if at < 0 || at as usize >= node_count {
                continue;
            }
            if at as usize != node
                && ids
                    .binary_search(&at)
                    .is_ok_and(|row| kinds.get(row).copied() == Some(control_kind::OPTION))
            {
                return Some(at as usize);
            }

            kids.clear();
            let mut child = first.get(at as usize).copied().unwrap_or(-1);
            while child >= 0 && (child as usize) < node_count && kids.len() <= node_count {
                kids.push(child);
                child = next.get(child as usize).copied().unwrap_or(-1);
            }
            while let Some(child) = kids.pop() {
                stack.push(child);
            }
        }
        None
    }

    /// Pushes a node's resolved style into Taffy.
    ///
    /// **Do not guard this with `Style: PartialEq`.** It is the obvious saving
    /// and it is wrong: `set_style` is also what marks the node dirty, and two
    /// of the things that change a node's laid-out size do not appear in `Style`
    /// at all. `fontSize` and `fontWeight` are read by the measure callback, and
    /// the `MEASURABLE` flag decides whether that callback runs — so all three
    /// produce a byte-identical `Style` and a different result on screen. A
    /// no-op guard would skip them, and the symptom is text laid out at the old
    /// size with nothing in the diff to blame.
    ///
    /// The saving that *is* safe is upstream, in `classify`: a field that layout
    /// never reads produces no entry, so this is not called at all.
    pub fn apply_style(&mut self, tables: &Tables, node: usize) -> Result<(), EngineError> {
        let style = style_of(tables, node, self.globals, self.surface);
        self.tree
            .set_style(self.ids[node], style)
            .map_err(taffy_at("taffy set_style", node))
    }

    /// Pushes the resolved style of each listed node, and nothing else.
    pub fn apply_styles_of(&mut self, tables: &Tables, nodes: &[u32]) -> Result<(), EngineError> {
        for &node in nodes {
            let node = node as usize;
            // Every caller derives these from a span whose capacity is the node
            // capacity, and a capacity change rebuilds instead — so this is an
            // engine invariant, not host data, and it fails loudly in debug.
            debug_assert!(node < self.ids.len(), "node {node} is past the tree");
            if node < self.ids.len() {
                self.apply_style(tables, node)?;
            }
        }
        Ok(())
    }

    /// Styles every node in the table, **including unreachable ones**.
    ///
    /// Walking the reachable tree instead looks like an obvious saving and is
    /// not one: spare capacity is where a list's next rows come from, and
    /// [`Self::relink_nodes`] links them without styling them. It is entitled to
    /// do that only because they were styled here, back when they were spare.
    /// A row whose `nodes.style` never changes — appended into a slot that
    /// already held the same value — would otherwise lay out with Taffy's
    /// `Style::default()` and no write anywhere to blame.
    pub fn apply_all_styles(&mut self, tables: &Tables) -> Result<(), EngineError> {
        for i in 0..self.ids.len() {
            self.apply_style(tables, i)?;
        }
        Ok(())
    }

    /// Marks a node's measured size stale — a text change, nothing else.
    pub fn mark_dirty(&mut self, node: usize) {
        if let Some(id) = self.ids.get(node) {
            let _ = self.tree.mark_dirty(*id);
        }
    }

    pub fn node_count(&self) -> usize {
        self.ids.len()
    }

    /// Lays out into `width` x `height` and publishes absolute bounds.
    ///
    /// `labels` is the select layer's text redirect — see [`crate::select::text_slot`].
    /// Layout needs it and not only paint, because a closed `<select>`'s *width* comes
    /// from the committed option's label as much as its pixels do: without it the new text
    /// would be drawn inside a box measured for the old one, which is at its worst when
    /// the two labels differ most. Empty for a document that has never committed a
    /// selection, so the common case is a length check per measured node.
    pub fn compute(
        &mut self,
        tables: &Tables,
        measurer: &mut Measurer,
        labels: &[i32],
        width: f32,
        height: f32,
    ) -> Result<(), EngineError> {
        if self.ids.is_empty() {
            return Ok(());
        }

        // Viewport-relative lengths (`h-screen`, `calc(100vw - 4rem)`) are summed
        // into the Taffy style when the style is built, so a resize while any are
        // in use is a restyle as well as a relayout. The scan is over *styles* —
        // interned rows, six columns of a small table — and only on a frame where
        // the size actually moved, which is every resize and nothing else.
        //
        // This also covers the first layout: `surface` starts zeroed, so a tree
        // whose styles were built before the window's size was known is restyled
        // against the real one rather than laid out at zero.
        let surface = [width, height];
        if surface != self.surface && has_viewport_lengths(tables) {
            // First, so the restyle below resolves against the new size.
            self.surface = surface;
            self.apply_all_styles(tables)?;
        }
        self.surface = surface;

        let root = *self.ids.get(self.root).ok_or_else(|| {
            EngineError::layout(format!("root node {} is outside the table", self.root))
        })?;

        // Borrowed before the closure so it captures the tables, not `self`.
        let flags = tables.u8s(NODES, protocol::nodes::FLAGS);
        let style_of_node = tables.u16s(NODES, protocol::nodes::STYLE);
        let font_size = tables.f32s(STYLES, protocol::styles::FONT_SIZE);
        let font_weight = tables.u16s(STYLES, protocol::styles::FONT_WEIGHT);
        let font_style = tables.u8s(STYLES, protocol::styles::FONT_STYLE);
        let font_family = tables.u8s(STYLES, protocol::styles::FONT_FAMILY);

        // The root receives the window rect, rather than shrink-wrapping its
        // content. This is what makes `body { background: … }` fill the window
        // the way an author expects — the same decision the compiler documents
        // when it makes `body` the root node rather than a child of one.
        //
        // And it receives it as a **border** box, which is why the root alone keeps
        // Taffy's default while `style_of` gives every other node CSS's `content-box`.
        // The window is the outer edge of the root's box: a root with padding has to
        // take that padding out of the window, not add it and overflow the surface. A
        // browser treats the initial containing block the same way.
        //
        // Only written when it differs, because `set_style` marks the node dirty
        // and would otherwise force a full relayout every single frame. The
        // comparison covers `box_sizing` as well as `size` — `rebuild` re-derives the
        // root's style from `style_of`, so checking the size alone would let a
        // rebuild-without-resize leave the root on `content-box` permanently.
        let want = Size {
            width: Dimension::length(width),
            height: Dimension::length(height),
        };
        let stale = match self.tree.style(root) {
            Ok(s) => s.size != want || s.box_sizing != BoxSizing::BorderBox,
            Err(_) => true,
        };
        if stale {
            let mut style = self
                .tree
                .style(root)
                .map_err(taffy("taffy style on root"))?
                .clone();
            style.size = want;
            style.box_sizing = BoxSizing::BorderBox;
            self.tree
                .set_style(root, style)
                .map_err(taffy("taffy set_style on root"))?;
        }

        self.size_listboxes(tables, measurer)?;

        let space = Size {
            width: AvailableSpace::Definite(width),
            height: AvailableSpace::Definite(height),
        };

        self.tree
            .compute_layout_with_measure(root, space, |known, available, _id, context, _style| {
                let node = match context {
                    Some(i) => *i as usize,
                    None => return Size::ZERO,
                };

                let node_flags = flags.get(node).copied().unwrap_or(0);
                let editable = node_flags & protocol::flags::EDITABLE != 0;

                let style = style_of_node.get(node).copied().unwrap_or(0) as usize;
                let spec = FontSpec::new(
                    font_size.get(style).copied().unwrap_or(16.0),
                    font_weight.get(style).copied().unwrap_or(400),
                    font_style.get(style).copied().unwrap_or(0),
                    font_family.get(style).copied().unwrap_or(0),
                )
                .with_leading(
                    tables
                        .f32s(STYLES, protocol::styles::LINE_HEIGHT)
                        .get(style)
                        .map(|v| if v.is_finite() && *v > 0.0 { *v } else { 0.0 })
                        .unwrap_or(0.0),
                );

                // A text field is one line high with nothing in it, and an empty
                // anything else is nothing at all. Measured both ways,
                // `probes/text-field-box.html`: an `<input>` and a `contenteditable` div
                // are 15.0px high empty, with one character and with forty, while
                // `<div></div>` is 0. Without this an empty field rendered as a bare
                // line and jumped to full height on the first keystroke.
                //
                // **Before the `MEASURABLE` gate, deliberately.** An *unbound* `<input>`
                // has no text run at all, so its `text` slot is -1 and it is not
                // measurable — and it still has to be one line high, because a browser
                // does not ask who owns the value before sizing the box. A bound field
                // reaches this through its generated run instead; both are leaves, which
                // is what makes one branch serve both.
                // `mut` because `line_height` goes through the measure cache, which it
                // may fill — the closure borrows `measurer` mutably.
                let mut strut = || Size {
                    width: known.width.unwrap_or(0.0),
                    height: known.height.unwrap_or(measurer.line_height(spec)),
                };

                // Leaves with no text never reach Skia at all.
                if node_flags & protocol::flags::MEASURABLE == 0 {
                    return if editable { strut() } else { Size::ZERO };
                }

                let content = tables.string(crate::select::text_slot(tables, labels, node));

                if content.is_empty() {
                    return if editable { strut() } else { Size::ZERO };
                }

                let avail = match available.width {
                    AvailableSpace::Definite(v) => v,
                    AvailableSpace::MaxContent => f32::INFINITY,
                    AvailableSpace::MinContent => 0.0,
                };

                let (w, h) = measurer.measure(content, spec, avail);
                Size {
                    width: known.width.unwrap_or(w),
                    height: known.height.unwrap_or(h),
                }
            })
            .map_err(taffy("taffy compute_layout"))?;

        self.read_back(tables)
    }

    /// Walks the tree accumulating parent offsets, turning Taffy's relative
    /// locations into the absolute rects everything downstream expects.
    fn read_back(&mut self, tables: &Tables) -> Result<(), EngineError> {
        let count = self.ids.len();
        if self.bounds.len() != count {
            self.bounds = vec![[0.0; 4]; count];
            self.overflow = vec![[0.0; 2]; count];
        } else {
            self.bounds.fill([0.0; 4]);
            self.overflow.fill([0.0; 2]);
        }

        let first = tables.i32s(NODES, protocol::nodes::FIRST_CHILD);
        let next = tables.i32s(NODES, protocol::nodes::NEXT_SIBLING);

        // Explicit stack: a deep tree from a hostile table must not blow the
        // render thread's stack, and recursion here would be the easiest way to
        // let it.
        let mut stack: Vec<(usize, f32, f32)> = vec![(self.root, 0.0, 0.0)];
        let mut budget = count.saturating_mul(2) + 16;

        while let Some((node, ox, oy)) = stack.pop() {
            if budget == 0 {
                return Err(EngineError::layout(
                    "layout read-back exceeded its budget — a cycle in the tree",
                ));
            }
            budget -= 1;

            let l = self
                .tree
                .layout(self.ids[node])
                .map_err(taffy_at("taffy layout", node))?;

            let x = ox + l.location.x;
            let y = oy + l.location.y;
            self.bounds[node] = [x, y, l.size.width, l.size.height];

            // How far a scroll may go, straight from Taffy. `scroll_width`/
            // `scroll_height` are `content_size - (size - border - scrollbar)`
            // clamped at zero, which is exactly the definition of scrollable extent
            // — and it is zero for a node whose overflow is `Visible`, because
            // content only *contributes* to a scroll region on a container that
            // contains it.
            self.overflow[node] = [l.scroll_width(), l.scroll_height()];

            let mut c = first.get(node).copied().unwrap_or(-1);
            while c >= 0 {
                let ci = c as usize;
                if ci >= count {
                    break;
                }
                stack.push((ci, x, y));
                c = next.get(ci).copied().unwrap_or(-1);
            }
        }

        Ok(())
    }
}

/// Proves the tree reachable from `root` is a tree: acyclic, single-parent.
///
/// This is the one host-written-data check that cannot be a budget. A budgeted
/// walk catches a cycle *along a chain* — `nextSibling` looping back — because
/// that chain never ends. It cannot catch a cycle through the *parent* relation:
/// `firstChild[root] = root` gives every node a chain of length one, so `relink`
/// completes happily and hands Taffy a structure where root is its own child.
/// `compute_layout` then recurses until the stack is gone.
///
/// A stack overflow is not a panic. `catch_unwind` cannot contain it, poisoning
/// never happens, and the host sees the process disappear — the exact failure the
/// whole boundary design exists to prevent, reachable from a single bad integer.
///
/// Visiting each node at most once also rules out a node appearing under two
/// parents, which is not a tree either and which Taffy would silently accept.
fn validate_tree(tables: &Tables, root: usize, count: usize) -> Result<(), EngineError> {
    if count == 0 {
        return Ok(());
    }
    if root >= count {
        return Err(EngineError::layout(format!(
            "root node {root} is outside the {count}-node table"
        )));
    }

    let first = tables.i32s(NODES, protocol::nodes::FIRST_CHILD);
    let next = tables.i32s(NODES, protocol::nodes::NEXT_SIBLING);

    let mut seen = vec![false; count];
    let mut stack = vec![root];
    seen[root] = true;

    while let Some(node) = stack.pop() {
        let mut child = first.get(node).copied().unwrap_or(-1);
        while child >= 0 {
            let ci = child as usize;
            if ci >= count {
                return Err(EngineError::layout(format!(
                    "node {node} has child {child}, past the {count}-node table"
                )));
            }
            if seen[ci] {
                return Err(EngineError::layout(format!(
                    "node {ci} is reachable twice from the root — firstChild/nextSibling \
                     describe a cycle or a shared child, which is not a tree"
                )));
            }
            seen[ci] = true;
            stack.push(ci);
            child = next.get(ci).copied().unwrap_or(-1);
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Style conversion
// ---------------------------------------------------------------------------

/// `NaN` is `auto`, matching how the compiler already encodes it. `Infinity`
/// reaches us from `INITIAL_STYLE`'s `maxW`/`maxH` and means "no limit", which is
/// also `auto`.
fn opt(v: f32) -> Option<f32> {
    if v.is_nan() || v.is_infinite() {
        None
    } else {
        Some(v)
    }
}

fn dim(v: f32) -> Dimension {
    match opt(v) {
        Some(px) => Dimension::length(px),
        None => Dimension::auto(),
    }
}

/// A sizing dimension with its two dynamic channels.
///
/// A length on the wire is a *sum*: px the compiler resolved, plus `pct` — a
/// fraction of the containing block, which Taffy resolves natively — plus `vp`,
/// a fraction of the window on this axis, resolved here because the window's
/// size is the one input this function has. The compiler never writes a
/// percentage alongside a px or viewport part (Taffy takes a percent *or* a
/// length, and has no calc to sum them), so the channels are checked rather
/// than combined.
fn dimc(px: f32, pct: f32, vp: f32, surface_axis: f32) -> Dimension {
    if pct != 0.0 {
        return Dimension::percent(pct);
    }
    if vp != 0.0 {
        return Dimension::length(if px.is_finite() { px } else { 0.0 } + vp * surface_axis);
    }
    dim(px)
}

/// `dimc` without the viewport channel — `flex-basis` has no use for one.
fn dimp(px: f32, pct: f32) -> Dimension {
    if pct != 0.0 {
        return Dimension::percent(pct);
    }
    dim(px)
}

fn lp(v: f32) -> LengthPercentage {
    LengthPercentage::length(if v.is_finite() { v } else { 0.0 })
}

fn lpa(v: f32) -> LengthPercentageAuto {
    match opt(v) {
        Some(px) => LengthPercentageAuto::length(px),
        None => LengthPercentageAuto::auto(),
    }
}

/// An inset with its percentage channel. The percentage is the containing
/// block's, as CSS resolves `top: 50%` — which is what Taffy's percent does.
fn lpap(px: f32, pct: f32) -> LengthPercentageAuto {
    if pct != 0.0 {
        return LengthPercentageAuto::percent(pct);
    }
    lpa(px)
}

/// True if any style row uses a viewport unit — the trigger for `compute`'s
/// restyle-on-resize. Over styles, not nodes: the rows are interned, so this is
/// six columns of a table whose count is in the hundreds, not the thousands.
fn has_viewport_lengths(tables: &Tables) -> bool {
    use protocol::styles as f;
    const VP: [usize; 6] = [
        f::WIDTH_VP,
        f::HEIGHT_VP,
        f::MIN_WIDTH_VP,
        f::MIN_HEIGHT_VP,
        f::MAX_WIDTH_VP,
        f::MAX_HEIGHT_VP,
    ];
    VP.iter()
        .any(|&field| tables.f32s(STYLES, field).iter().any(|&v| v != 0.0))
}

fn overflow_of(v: u8) -> Overflow {
    match v {
        // `ELLIPSIS` is `text-overflow` wearing this field's name — a schema wart
        // kept for wire compatibility. For layout it contains its content, like
        // `hidden`, which is the closest true thing.
        protocol::overflow::HIDDEN | protocol::overflow::ELLIPSIS => Overflow::Hidden,
        protocol::overflow::SCROLL => Overflow::Scroll,
        // `CLIP` differs from `HIDDEN` in exactly one way that matters here: it is not
        // a scroll container. Taffy models that distinction natively, and the compiler
        // relies on it — the `visible`-to-`auto` coercion must skip `clip`.
        protocol::overflow::CLIP => Overflow::Clip,
        // `VISIBLE` and anything unrecognised: spill, which is CSS's default and the
        // only answer that cannot hide content.
        _ => Overflow::Visible,
    }
}

fn align_of(v: u8) -> Option<AlignItems> {
    match v {
        align::CENTER => Some(AlignItems::Center),
        align::FLEX_END => Some(AlignItems::FlexEnd),
        align::STRETCH => Some(AlignItems::Stretch),
        align::BASELINE => Some(AlignItems::Baseline),
        align::FLEX_START => Some(AlignItems::FlexStart),
        // `UNSET` and anything unrecognised leave Taffy's default. Coercing to
        // variant 0 is what silently collapsed grid items in the spike, whose
        // default is `stretch` rather than `flex-start`.
        _ => None,
    }
}

/// The most tracks or spanned lines a grid is allowed to declare.
///
/// Bounds the cost of host-written integers. Grid work scales with tracks × items
/// and taffy's own arithmetic overflows well before `u16::MAX`.
const MAX_TRACKS: u16 = 1024;

/// `0` means "not placed", so grid lines stay 1-based as in CSS.
///
/// Both values are clamped: a line index beyond the track count makes taffy
/// materialise implicit tracks up to it, so a stray `grid-row: 30000` costs the
/// same as declaring 30,000 rows.
fn placement(start: i16, span: i16) -> Line<GridPlacement> {
    let start = start.clamp(-(MAX_TRACKS as i16), MAX_TRACKS as i16);
    let span = span.clamp(0, MAX_TRACKS as i16);

    Line {
        start: if start == 0 {
            GridPlacement::Auto
        } else {
            GridPlacement::from_line_index(start)
        },
        end: if span <= 0 {
            GridPlacement::Auto
        } else {
            GridPlacement::Span(span as u16)
        },
    }
}

/// Resolves one node's Taffy style from the tables.
///
/// `borderWidth` used to be excluded here, on the argument that the painter
/// stroked borders inset so the box never changed — the TypeScript runtime's
/// decision, kept while the migration wanted pixel-comparable frames. It was
/// wrong as CSS: content overlapped the border band and a bordered box's content
/// box was 2×width too big in each axis. Taffy implements border-box shrinking
/// natively, so this is one `Rect` and paint drops the compensation it never had.
/// The rejected alternative was subtracting the border from `width`/`height` in
/// the compiler: that only works for definite sizes, and silently does nothing
/// for `auto`, percentages and flex bases.
/// The style slot a node wears under the given global predicates.
///
/// The same resolution `Painter::style_for` does, minus the per-node input state:
/// hover, active and focus are deliberately *not* consulted here. Including them
/// would mean a relayout on every pointer move over an interactive node, and no
/// rule in this codebase changes layout on hover. Media bits are the opposite —
/// they exist to change layout — so they are.
///
/// That asymmetry is a real limitation and worth naming: `:hover { padding: … }`
/// will repaint at the new padding without relaying out. It is the same gap that
/// existed before media queries, just now visible from one side.
fn style_slot(tables: &Tables, node: usize, globals: u32) -> usize {
    let base = tables
        .u16s(NODES, protocol::nodes::STYLE)
        .get(node)
        .copied()
        .unwrap_or(0) as usize;

    if globals == 0 {
        return base;
    }

    let ids = tables.i32s(VARIANTS, protocol::variants::NODE);
    let Ok(row) = ids.binary_search(&(node as i32)) else {
        return base;
    };

    let mask = tables.u32s(VARIANTS, protocol::variants::MASK)[row];
    let selected = globals & mask;
    if selected == 0 {
        return base;
    }

    let run_start = tables.i32s(VARIANTS, protocol::variants::RUN_START)[row];
    if run_start < 0 {
        return base;
    }

    let index = compact_bits(selected, mask) as usize;
    tables
        .u16s(VARIANT_SLOTS, protocol::variant_slots::STYLE)
        .get(run_start as usize + index)
        .copied()
        .map(|s| s as usize)
        .unwrap_or(base)
}

/// Gathers the bits of `value` set in `mask` down to a dense index.
///
/// Duplicated from paint's `compact` rather than shared, because the two are the
/// same three lines and moving them into a common module would put a
/// predicate-resolution helper in neither of the files that resolve predicates.
fn compact_bits(value: u32, mask: u32) -> u32 {
    let mut out = 0;
    let mut bit = 0;
    let mut remaining = mask;
    while remaining != 0 {
        let lowest = remaining & remaining.wrapping_neg();
        if value & lowest != 0 {
            out |= 1 << bit;
        }
        bit += 1;
        remaining &= remaining - 1;
    }
    out
}

fn style_of(tables: &Tables, node: usize, globals: u32, surface: [f32; 2]) -> Style {
    use protocol::styles as f;

    // Taffy's `Style::default()` is `BoxSizing::BorderBox`; CSS's initial value for
    // `box-sizing` is `content-box`. Taken from Taffy's default, `width: 400px` with
    // `padding: 12px` produced a 400 px box where a browser gives 424 — measured by
    // `layout-diff`'s no-text control scenario, which differed by exactly the padding
    // and nothing else.
    //
    // **The root is deliberately excluded**, in `compute`: the window rect is the
    // outer edge of the root's box, so a padded root has to take that padding out of
    // the window rather than growing past it. Three `tests/bounds.rs` cases pin that
    // invariant, and they were right to fail when this was applied to every node.
    //
    // dziri has no `box-sizing` *field* yet, so this sets the initial value rather
    // than implementing the property. That is the whole of the gap for hand-written
    // CSS and it is not the whole of the gap for Tailwind, whose preflight sets
    // `box-sizing: border-box` on every element — meaning Tailwind's own layouts now
    // need the property that A1 has to add, where before they accidentally worked.
    //
    // Spelled as a struct update rather than `let mut` + assignment: clippy's
    // `field_reassign_with_default` rejects the assignment when it sits next to the
    // `default()` call it corrects, and moving it away from that call would separate
    // it from the reason it exists.
    let mut s = Style {
        box_sizing: BoxSizing::ContentBox,
        ..Style::default()
    };

    let hidden = tables.u8s(NODES, protocol::nodes::HIDDEN);
    if hidden.get(node).copied().unwrap_or(0) != 0 {
        s.display = Display::None;
        return s;
    }

    let slot = style_slot(tables, node, globals);

    let u8f = |field: usize| -> u8 { tables.u8s(STYLES, field).get(slot).copied().unwrap_or(0) };
    let u16f = |field: usize| -> u16 { tables.u16s(STYLES, field).get(slot).copied().unwrap_or(0) };
    let i16f = |field: usize| -> i16 { tables.i16s(STYLES, field).get(slot).copied().unwrap_or(0) };
    let f32f =
        |field: usize| -> f32 { tables.f32s(STYLES, field).get(slot).copied().unwrap_or(0.0) };

    s.display = match u8f(f::DISPLAY) {
        display_enum::GRID => Display::Grid,
        display_enum::BLOCK => Display::Block,
        display_enum::NONE => Display::None,
        _ => Display::Flex,
    };

    s.flex_direction = match u8f(f::FLEX_DIRECTION) {
        flex_direction::COLUMN => FlexDirection::Column,
        flex_direction::ROW_REVERSE => FlexDirection::RowReverse,
        flex_direction::COLUMN_REVERSE => FlexDirection::ColumnReverse,
        _ => FlexDirection::Row,
    };

    s.flex_wrap = match u8f(f::FLEX_WRAP) {
        flex_wrap::WRAP => FlexWrap::Wrap,
        flex_wrap::WRAP_REVERSE => FlexWrap::WrapReverse,
        _ => FlexWrap::NoWrap,
    };

    s.justify_content = match u8f(f::JUSTIFY_CONTENT) {
        justify::CENTER => Some(AlignContent::Center),
        justify::FLEX_END => Some(AlignContent::FlexEnd),
        justify::SPACE_BETWEEN => Some(AlignContent::SpaceBetween),
        justify::SPACE_AROUND => Some(AlignContent::SpaceAround),
        justify::SPACE_EVENLY => Some(AlignContent::SpaceEvenly),
        justify::FLEX_START => Some(AlignContent::FlexStart),
        _ => None,
    };

    s.align_items = align_of(u8f(f::ALIGN_ITEMS));
    s.justify_items = align_of(u8f(f::JUSTIFY_ITEMS));

    // `taffy::AlignSelf` is a type *alias* for `AlignItems` today, so clippy is
    // right that these convert nothing. They stay because the field being written
    // is the self axis, and if taffy ever makes them distinct types this is
    // already the correct code — at which point the lint stops firing and
    // `expect` says so, which is the reminder to drop the attribute.
    #[expect(
        clippy::useless_conversion,
        reason = "AlignSelf is an alias for AlignItems in taffy 0.9, not a distinct type"
    )]
    {
        s.align_self = align_of(u8f(f::ALIGN_SELF)).map(AlignSelf::from);
        s.justify_self = align_of(u8f(f::JUSTIFY_SELF)).map(AlignSelf::from);
    }

    let grow = f32f(f::FLEX_GROW);
    s.flex_grow = if grow.is_finite() { grow } else { 0.0 };
    let shrink = f32f(f::FLEX_SHRINK);
    s.flex_shrink = if shrink.is_finite() { shrink } else { 1.0 };
    s.flex_basis = dimp(f32f(f::FLEX_BASIS), f32f(f::FLEX_BASIS_PCT));

    s.gap = Size {
        width: lp(f32f(f::GAP_COLUMN)),
        height: lp(f32f(f::GAP_ROW)),
    };
    s.size = Size {
        width: dimc(
            f32f(f::WIDTH),
            f32f(f::WIDTH_PCT),
            f32f(f::WIDTH_VP),
            surface[0],
        ),
        height: dimc(
            f32f(f::HEIGHT),
            f32f(f::HEIGHT_PCT),
            f32f(f::HEIGHT_VP),
            surface[1],
        ),
    };
    s.min_size = Size {
        width: dimc(
            f32f(f::MIN_WIDTH),
            f32f(f::MIN_WIDTH_PCT),
            f32f(f::MIN_WIDTH_VP),
            surface[0],
        ),
        height: dimc(
            f32f(f::MIN_HEIGHT),
            f32f(f::MIN_HEIGHT_PCT),
            f32f(f::MIN_HEIGHT_VP),
            surface[1],
        ),
    };
    s.max_size = Size {
        width: dimc(
            f32f(f::MAX_WIDTH),
            f32f(f::MAX_WIDTH_PCT),
            f32f(f::MAX_WIDTH_VP),
            surface[0],
        ),
        height: dimc(
            f32f(f::MAX_HEIGHT),
            f32f(f::MAX_HEIGHT_PCT),
            f32f(f::MAX_HEIGHT_VP),
            surface[1],
        ),
    };

    s.padding = Rect {
        top: lp(f32f(f::PAD_TOP)),
        right: lp(f32f(f::PAD_RIGHT)),
        bottom: lp(f32f(f::PAD_BOTTOM)),
        left: lp(f32f(f::PAD_LEFT)),
    };
    // Per side, as CSS has them — `border-t-2` reserves room on the top alone.
    // `lp` maps the non-finite sentinels to 0, which is what "no border" means
    // here — unlike `margin`, where non-finite means `auto` — and `max` rejects a
    // negative width from a hostile table, which Taffy would otherwise treat as
    // room it can hand back to the content.
    s.border = Rect {
        top: lp(f32f(f::BORDER_TOP_WIDTH).max(0.0)),
        right: lp(f32f(f::BORDER_RIGHT_WIDTH).max(0.0)),
        bottom: lp(f32f(f::BORDER_BOTTOM_WIDTH).max(0.0)),
        left: lp(f32f(f::BORDER_LEFT_WIDTH).max(0.0)),
    };
    s.margin = Rect {
        top: lpa(f32f(f::MARGIN_TOP)),
        right: lpa(f32f(f::MARGIN_RIGHT)),
        bottom: lpa(f32f(f::MARGIN_BOTTOM)),
        left: lpa(f32f(f::MARGIN_LEFT)),
    };

    // `scrollbar_width` stays 0, which makes Taffy treat `Scroll` exactly like
    // `Hidden` for sizing. Deliberate: reserving a gutter is only honest once a
    // scrollbar is drawn into it.
    s.overflow = Point {
        x: overflow_of(u8f(f::OVERFLOW_X)),
        y: overflow_of(u8f(f::OVERFLOW_Y)),
    };

    s.position = if u8f(f::POSITION) == protocol::position::ABSOLUTE {
        Position::Absolute
    } else {
        Position::Relative
    };
    s.inset = Rect {
        top: lpap(f32f(f::INSET_TOP), f32f(f::INSET_TOP_PCT)),
        right: lpap(f32f(f::INSET_RIGHT), f32f(f::INSET_RIGHT_PCT)),
        bottom: lpap(f32f(f::INSET_BOTTOM), f32f(f::INSET_BOTTOM_PCT)),
        left: lpap(f32f(f::INSET_LEFT), f32f(f::INSET_LEFT_PCT)),
    };

    s.aspect_ratio = opt(f32f(f::ASPECT_RATIO));

    // Uniform `repeat(N, minmax(0, 1fr))`, which is what Tailwind's
    // `grid-cols-{n}` / `grid-rows-{n}` generate. `repeat(auto-fit, …)` needs
    // intrinsic sizing and is deliberately not claimed yet.
    //
    // Clamped, because these are host-written integers and grid cost is
    // multiplicative: the field is a `u16`, so `grid-cols-65535` is expressible
    // and allocates 65,535 tracks per grid node. Measured single frames of 181 ms
    // and 1.41 s, and a track count large enough to overflow taffy's own
    // arithmetic — which panics in debug and **wraps silently in release**, which
    // is how this ships.
    //
    // The limit is a real one rather than a guard value: a grid with more than
    // `MAX_TRACKS` columns has no legible cells at any window size, so anything
    // past it is a bad write, not an ambitious layout.
    let cols = u16f(f::GRID_COLUMNS).min(MAX_TRACKS);
    if cols > 0 {
        s.grid_template_columns = vec![minmax(length(0.0_f32), fr(1.0_f32)); cols as usize];
    }
    let rows = u16f(f::GRID_ROWS).min(MAX_TRACKS);
    if rows > 0 {
        s.grid_template_rows = vec![minmax(length(0.0_f32), fr(1.0_f32)); rows as usize];
    }

    s.grid_column = placement(i16f(f::GRID_COLUMN_START), i16f(f::GRID_COLUMN_SPAN));
    s.grid_row = placement(i16f(f::GRID_ROW_START), i16f(f::GRID_ROW_SPAN));

    s
}
