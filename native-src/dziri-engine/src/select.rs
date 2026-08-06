//! The open picker: which `<select>` is showing one, and what its button reads.
//!
//! # Why this is engine state
//!
//! The same argument `controls.rs` makes for checkedness, and it is short for the same
//! reason: **nobody declared the answer.** A `<select>` with no binding still opens when
//! you press it, and there is no signal to be the authority for whether it is open — as
//! there is none for which node the pointer is over. So openness sits beside `hovered`,
//! `pressed` and `focused`.
//!
//! It is answered as narrowly as the fact allows, which turns out to be narrower than
//! checkedness: **one integer for the whole document**, not one bit per select. Only one
//! picker can be open at a time — measured, `probes/select-picker.html` — so a second
//! opening closes the first, and there is nothing per-select to store.
//!
//! # Why the pending highlight is not here
//!
//! The obvious design gives a picker two pieces of state: the committed selection and a
//! highlight that Escape throws away. ROADMAP B1 says so, from the measurement.
//!
//! Both already exist. The committed selection is `CHECKED` on an option, which is
//! `Controls`, because committing one *is* a radio set — check it, clear its group. And
//! the highlight is **focus**: while a picker is open Chromium's `activeElement` is an
//! `<option>`, not the select, which is measured and is the whole reason to look. So
//! arrowing through a picker moves `state.focused` and nothing else, `option:focus` is
//! how a stylesheet draws the highlight, and Escape discards it by doing what closing
//! always does — putting focus back on the select. Two pieces of state, zero new fields.
//!
//! # What `label` is for
//!
//! Committing an option has to change what the closed control reads, and the engine
//! cannot write the string: Bun owns the tables. So this holds a per-node **redirect** —
//! "when you want this node's text, read that node's slot instead" — and a commit points
//! the `<selectedcontent>`'s run at the chosen option's. Paint and layout both go through
//! [`text_slot`], which is the only reason it works in one place rather than two.

use crate::controls::Controls;
use crate::protocol::{self, control_kind, flags};
use crate::tables::Tables;

const NODES: usize = protocol::Table::Nodes as usize;
const CONTROLS: usize = protocol::Table::Controls as usize;

#[derive(Default)]
pub struct Selects {
    /// The `<select>` whose picker is showing, or -1.
    open: i32,
    /// That select's picker box, so paint does not re-derive it per frame.
    picker: i32,
    /// Per node, the node whose text slot to read instead of its own, or -1.
    ///
    /// Empty until something commits, which is what keeps a document with no select —
    /// and a select nobody has used — paying a single length check.
    label: Vec<i32>,
}

impl Selects {
    pub fn new() -> Self {
        Self {
            open: -1,
            picker: -1,
            label: Vec::new(),
        }
    }

    /// Keeps the redirects and drops anything the tables no longer have room for.
    ///
    /// Deliberately does **not** re-seed from the tables, for the reason
    /// `Controls::rescan` does not re-read `checked`: Bun republishes on any signal
    /// change, so re-seeding would put the closed control back to its authored label
    /// because an unrelated counter incremented. There is nothing to seed anyway — the
    /// compiler bakes the initially-selected option's text into the `<selectedcontent>`,
    /// so at rest the redirect is correctly absent.
    pub fn rescan(&mut self, node_count: usize) {
        if !self.label.is_empty() {
            self.label.resize(node_count, -1);
        }
        if self.open >= node_count as i32 {
            self.close();
        }
    }

    /// The select whose picker is open, or -1.
    #[inline]
    pub fn open(&self) -> i32 {
        self.open
    }

    /// Its picker box, or -1. The node an overlay walk starts at.
    #[inline]
    pub fn picker(&self) -> i32 {
        self.picker
    }

    /// Shows `select`'s picker, closing whatever was open.
    ///
    /// Returns false when the select has no picker box, which means the compiler emitted
    /// no `::picker(select)` for it — an `<option>`-less `<select>` still gets one, so in
    /// practice this is a `<select>` from a table dziri did not compile.
    pub fn show(&mut self, tables: &Tables, select: i32, node_count: usize) -> bool {
        let picker = picker_of(tables, select, node_count);
        if picker < 0 {
            return false;
        }
        self.open = select;
        self.picker = picker;
        true
    }

    pub fn close(&mut self) {
        self.open = -1;
        self.picker = -1;
    }

    /// Points `select`'s label at `option`'s, so the closed control reads the new choice.
    ///
    /// The redirect names a *node*, not a slot, which is what makes it survive a
    /// republish: the option's own text may be re-uploaded to a different slot by a
    /// commit — a dynamic option label, or the arena repacking — and a stored slot index
    /// would then point at whatever moved into it. A node id is stable.
    ///
    /// An option with no run of its own redirects to the option element, whose text slot
    /// is -1 and whose string is therefore empty. That is the honest answer for
    /// `<option></option>` and it needs no sentinel: without it the button would keep
    /// showing the *previous* choice, which reads as the commit having failed.
    ///
    /// **Returns the node it repointed, or -1**, and the caller must mark that node dirty
    /// for layout. This is not a convenience — it is the whole reason the return value
    /// exists. Taffy caches a leaf's measurement and only re-runs the measure callback for
    /// a node it considers dirty, and a redirect changes *neither* the node's style nor its
    /// string: `nodes.text[dest]` is the same integer it always was, and the string in that
    /// slot has not moved. So nothing about the tables says this measurement went stale.
    /// Without the mark the button keeps the width it was laid out with and paint draws the
    /// new label into a box measured for the old one — which is exactly how this was found.
    pub fn commit_label(
        &mut self,
        tables: &Tables,
        select: i32,
        option: i32,
        node_count: usize,
    ) -> i32 {
        let dest = label_of(tables, select);
        if dest < 0 {
            return -1;
        }
        let src = match label_of(tables, option) {
            run if run >= 0 => run,
            _ => option,
        };
        if self.label.is_empty() {
            self.label = vec![-1; node_count];
        }
        if let Some(slot) = self.label.get_mut(dest as usize) {
            *slot = src;
        }
        dest
    }

    /// The redirects, for [`text_slot`]. Empty when nothing has committed.
    #[inline]
    pub fn labels(&self) -> &[i32] {
        &self.label
    }
}

/// Which string slot holds `node`'s text, honouring a select's label redirect.
///
/// Every read of a node's text goes through this — paint's own, and layout's measure
/// callback. Both, and that is the point: the closed control's *width* comes from the
/// committed option's label as much as its pixels do, so a version of this that only
/// paint used would draw the new text inside a box measured for the old one.
///
/// `labels` is empty for a document that has never committed a selection, which is the
/// overwhelming majority of frames — so the common path is a length check.
#[inline]
pub fn text_slot(tables: &Tables, labels: &[i32], node: usize) -> i32 {
    let text = tables.i32s(NODES, protocol::nodes::TEXT);
    let from = match labels.get(node) {
        Some(&src) if src >= 0 => src as usize,
        _ => node,
    };
    text.get(from).copied().unwrap_or(-1)
}

/// The overlay box among `select`'s children, or -1.
///
/// A chain walk rather than a table lookup because a select has two or three children and
/// the picker is one of them, so there is nothing a column would save. It is found by the
/// `OVERLAY` flag rather than by position, since the compiler pushes it last today and
/// that is an ordering nothing should depend on — the picker is out of both flow and the
/// paint walk, so where it sits among its siblings is deliberately not meaningful.
pub fn picker_of(tables: &Tables, select: i32, node_count: usize) -> i32 {
    if select < 0 || select as usize >= node_count {
        return -1;
    }
    let first = tables.i32s(NODES, protocol::nodes::FIRST_CHILD);
    let next = tables.i32s(NODES, protocol::nodes::NEXT_SIBLING);
    let node_flags = tables.u8s(NODES, protocol::nodes::FLAGS);

    let mut child = first.get(select as usize).copied().unwrap_or(-1);
    let mut budget = node_count + 1;
    while child >= 0 && (child as usize) < node_count {
        if budget == 0 {
            break;
        }
        budget -= 1;
        if node_flags.get(child as usize).copied().unwrap_or(0) & flags::OVERLAY != 0 {
            return child;
        }
        child = next.get(child as usize).copied().unwrap_or(-1);
    }
    -1
}

/// Every `<option>` under `picker`, in document order, appended to `out`.
///
/// A full subtree walk rather than a child scan, because an `<option>` inside an
/// `<optgroup>` is two levels down and is still one of the select's options. A
/// direct-child scan reads as correct and quietly makes a grouped select unarrowable.
pub fn options_of(
    tables: &Tables,
    controls: &Controls,
    picker: i32,
    node_count: usize,
    out: &mut Vec<i32>,
) {
    out.clear();
    if picker < 0 || picker as usize >= node_count {
        return;
    }
    let first = tables.i32s(NODES, protocol::nodes::FIRST_CHILD);
    let next = tables.i32s(NODES, protocol::nodes::NEXT_SIBLING);

    // Explicit stack, and children pushed reversed so they pop in document order — the
    // same shape and the same reason as the paint walk: a hostile table must not be able
    // to recurse the render thread's stack away.
    let mut stack: Vec<i32> = vec![picker];
    let mut kids: Vec<i32> = Vec::new();
    let mut budget = node_count.saturating_mul(2) + 16;

    while let Some(node) = stack.pop() {
        if budget == 0 {
            break;
        }
        budget -= 1;
        if node < 0 || node as usize >= node_count {
            continue;
        }
        if node != picker && controls.kind_of(tables, node) == control_kind::OPTION {
            out.push(node);
        }

        kids.clear();
        let mut child = first.get(node as usize).copied().unwrap_or(-1);
        while child >= 0 && (child as usize) < node_count {
            kids.push(child);
            child = next.get(child as usize).copied().unwrap_or(-1);
            if kids.len() > node_count {
                break;
            }
        }
        while let Some(child) = kids.pop() {
            stack.push(child);
        }
    }
}

/// The `controls.label` of a node, or -1 for "no row, or nothing to mirror".
fn label_of(tables: &Tables, node: i32) -> i32 {
    if node < 0 {
        return -1;
    }
    let ids = tables.i32s(CONTROLS, protocol::controls::NODE);
    match ids.binary_search(&node) {
        Ok(row) => tables
            .i32s(CONTROLS, protocol::controls::LABEL)
            .get(row)
            .copied()
            .unwrap_or(-1),
        Err(_) => -1,
    }
}

/// How far to move a picker so it hangs below its select, `[dx, dy]`.
///
/// This is anchor positioning, done with the two rects layout already produced. Taffy
/// puts an absolutely positioned child at its parent's content-box origin, so a picker
/// starts *inside* its select; what it should do is sit under the select's border box,
/// left edges aligned.
///
/// The spec spells that `top: anchor(bottom); left: anchor(left)` and dziri's nearest
/// spelling would be `top: 100%`, which `css.ts` refuses along with every other
/// percentage length. Hence here, where both boxes are known numbers — and it costs
/// nothing, being two subtractions on the one frame a picker is open.
///
/// The offset is a *delta*, which is what keeps an author's own `top`/`left` working:
/// those moved where Taffy placed the box, and this shifts it from wherever that was
/// rather than overriding it. So `select::picker(select) { top: 4px }` is a 4px gap.
///
/// **No collision handling.** A picker near the bottom of the window hangs off it rather
/// than flipping above the select, and a wide one runs off the right edge. That is
/// ROADMAP B2's job — `@floating-ui/core` is the adapter named for it — and doing a
/// half-version here would be a second placement engine to delete later.
pub fn anchor_offset(bounds: &[[f32; 4]], select: i32, picker: i32) -> [f32; 2] {
    let (Some(&[sx, sy, _, sh]), Some(&[px, py, _, _])) = (
        bounds.get(usize::try_from(select).unwrap_or(usize::MAX)),
        bounds.get(usize::try_from(picker).unwrap_or(usize::MAX)),
    ) else {
        return [0.0, 0.0];
    };
    [sx - px, (sy + sh) - py]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tables::{Capacities, Tables};

    const NODE_COUNT: usize = 12;

    /// A select at node 1 with a picker at 2 holding options 3 and 4, and an optgroup at
    /// 5 holding option 6 — so the group walk is exercised by every test that arrows.
    fn tables() -> (Tables, Controls) {
        let mut t = Tables::new(Capacities {
            nodes: NODE_COUNT as u32,
            styles: 2,
            variants: 1,
            variant_slots: 1,
            media: 1,
            lists: 1,
            tweens: 1,
            keyframes: 1,
            controls: 8,
            strings: 8,
            string_bytes: 128,
        });

        for n in 0..NODE_COUNT {
            t.set_i32(NODES, protocol::nodes::FIRST_CHILD, n, -1);
            t.set_i32(NODES, protocol::nodes::NEXT_SIBLING, n, -1);
            t.set_i32(NODES, protocol::nodes::TEXT, n, -1);
            t.set_i32(NODES, protocol::nodes::ACTIVATES, n, -1);
        }
        for row in 0..8 {
            t.set_i32(CONTROLS, protocol::controls::NODE, row, i32::MAX);
            t.set_i32(CONTROLS, protocol::controls::GROUP, row, -1);
            t.set_i32(CONTROLS, protocol::controls::LABEL, row, -1);
        }

        // select 1 -> button 7, picker 2. picker 2 -> option 3, option 4, optgroup 5.
        // optgroup 5 -> option 6. Each option carries its label run: 8, 9, 10.
        t.set_i32(NODES, protocol::nodes::FIRST_CHILD, 1, 7);
        t.set_i32(NODES, protocol::nodes::NEXT_SIBLING, 7, 2);
        t.set_u8(NODES, protocol::nodes::FLAGS, 2, flags::OVERLAY);
        t.set_i32(NODES, protocol::nodes::FIRST_CHILD, 2, 3);
        t.set_i32(NODES, protocol::nodes::NEXT_SIBLING, 3, 4);
        t.set_i32(NODES, protocol::nodes::NEXT_SIBLING, 4, 5);
        t.set_i32(NODES, protocol::nodes::FIRST_CHILD, 5, 6);

        // The button's own run, which is what a commit repoints.
        t.set_i32(NODES, protocol::nodes::FIRST_CHILD, 7, 11);
        t.set_i32(NODES, protocol::nodes::TEXT, 11, 0);
        t.set_i32(NODES, protocol::nodes::TEXT, 8, 1);
        t.set_i32(NODES, protocol::nodes::TEXT, 9, 2);
        t.set_i32(NODES, protocol::nodes::TEXT, 10, 3);

        // Rows ascending by node — the engine binary-searches this column.
        let rows: [(usize, i32, u8, i32); 4] = [
            (0, 1, control_kind::SELECT, 11),
            (1, 3, control_kind::OPTION, 8),
            (2, 4, control_kind::OPTION, 9),
            (3, 6, control_kind::OPTION, 10),
        ];
        for (row, node, kind, label) in rows {
            t.set_i32(CONTROLS, protocol::controls::NODE, row, node);
            t.set_u8(CONTROLS, protocol::controls::KIND, row, kind);
            t.set_i32(CONTROLS, protocol::controls::GROUP, row, 0);
            t.set_i32(CONTROLS, protocol::controls::LABEL, row, label);
        }

        t.commit();
        let mut c = Controls::new();
        c.rescan(&t, NODE_COUNT);
        (t, c)
    }

    /// The keycodes the picker matches on are SDL's own.
    ///
    /// Same argument as `caret.rs`'s version of this test, and the same failure mode: by the
    /// time the engine sees a key there is nothing left to match on but the number, so one
    /// wrong constant is an Escape that silently does not close.
    ///
    /// Return and Escape are the ones worth checking. Both are **unmasked** ASCII control
    /// characters while both arrows beside them are masked scancodes — exactly the trap
    /// Delete was, which is why they are checked against the dependency rather than
    /// recalled.
    #[test]
    fn the_picker_keycodes_are_the_ones_sdl_sends() {
        use sdl3::keyboard::Keycode;

        const SCANCODE_MASK: i32 = 1 << 30;
        assert_eq!(Keycode::Down.to_ll().0 as i32, SCANCODE_MASK | 81);
        assert_eq!(Keycode::Up.to_ll().0 as i32, SCANCODE_MASK | 82);

        assert_eq!(Keycode::Return.to_ll().0 as i32, 13);
        assert_eq!(Keycode::Escape.to_ll().0 as i32, 27);
    }

    #[test]
    fn the_picker_is_found_by_its_flag_not_its_position() {
        let (t, _) = tables();
        assert_eq!(picker_of(&t, 1, NODE_COUNT), 2);
        // The button is first in the chain and must not be mistaken for it.
        assert_eq!(picker_of(&t, 7, NODE_COUNT), -1);
        assert_eq!(picker_of(&t, -1, NODE_COUNT), -1);
        assert_eq!(picker_of(&t, 99, NODE_COUNT), -1);
    }

    /// The measured rule this exists for: an option inside an `<optgroup>` is still one
    /// of the select's options, so a direct-child scan would make it unreachable.
    #[test]
    fn options_are_collected_through_an_optgroup_in_document_order() {
        let (t, c) = tables();
        let mut out = Vec::new();
        options_of(&t, &c, 2, NODE_COUNT, &mut out);
        assert_eq!(out, vec![3, 4, 6]);
    }

    #[test]
    fn a_commit_repoints_the_buttons_run_at_the_chosen_options() {
        let (t, _) = tables();
        let mut s = Selects::new();

        // Nothing committed: the button reads its own baked slot.
        assert_eq!(text_slot(&t, s.labels(), 11), 0);

        s.commit_label(&t, 1, 4, NODE_COUNT);
        assert_eq!(text_slot(&t, s.labels(), 11), 2, "now the option's slot");
        // And the option itself is untouched — the redirect is one-way.
        assert_eq!(text_slot(&t, s.labels(), 9), 2);

        s.commit_label(&t, 1, 6, NODE_COUNT);
        assert_eq!(text_slot(&t, s.labels(), 11), 3, "the grouped option too");
    }

    /// An `<option></option>` must blank the button rather than leave the last choice up,
    /// which reads as the commit having failed.
    #[test]
    fn an_option_with_no_run_commits_an_empty_label() {
        let (mut t, _) = tables();
        t.set_i32(CONTROLS, protocol::controls::LABEL, 2, -1);
        t.commit();

        let mut s = Selects::new();
        s.commit_label(&t, 1, 4, NODE_COUNT);
        assert_eq!(text_slot(&t, s.labels(), 11), -1, "no slot, so no text");
        assert_eq!(t.string(-1), "");
    }

    #[test]
    fn opening_a_second_picker_closes_the_first() {
        let (t, _) = tables();
        let mut s = Selects::new();
        assert_eq!(s.open(), -1);

        assert!(s.show(&t, 1, NODE_COUNT));
        assert_eq!((s.open(), s.picker()), (1, 2));

        // Node 7 is the button, which has no picker: the attempt fails and — the part
        // worth asserting — leaves the open one alone rather than half-closing it.
        assert!(!s.show(&t, 7, NODE_COUNT));
        assert_eq!((s.open(), s.picker()), (1, 2));

        s.close();
        assert_eq!((s.open(), s.picker()), (-1, -1));
    }

    /// A commit survives the republish that follows it. Same correctness condition as
    /// `a_rescan_does_not_untick_a_box_the_user_ticked`, and the same cause: Bun
    /// republishes on *any* signal change.
    #[test]
    fn a_rescan_keeps_a_committed_label() {
        let (t, _) = tables();
        let mut s = Selects::new();
        s.commit_label(&t, 1, 4, NODE_COUNT);
        s.rescan(NODE_COUNT);
        assert_eq!(text_slot(&t, s.labels(), 11), 2);
    }

    /// A picker starts inside its select and has to end up under it.
    #[test]
    fn the_anchor_offset_puts_the_picker_under_the_selects_border_box() {
        // select at (40, 100) 120x32; Taffy placed the picker at its content origin,
        // inset by a 1px border and 6px of padding.
        let bounds = vec![
            [0.0, 0.0, 0.0, 0.0],
            [40.0, 100.0, 120.0, 32.0],
            [47.0, 107.0, 120.0, 60.0],
        ];
        assert_eq!(anchor_offset(&bounds, 1, 2), [-7.0, 25.0]);

        // Which lands its top-left exactly on the select's bottom-left.
        let [dx, dy] = anchor_offset(&bounds, 1, 2);
        assert_eq!((bounds[2][0] + dx, bounds[2][1] + dy), (40.0, 132.0));

        // A node outside the table moves nothing rather than panicking: these are
        // indices into host-sized memory.
        assert_eq!(anchor_offset(&bounds, 1, 99), [0.0, 0.0]);
        assert_eq!(anchor_offset(&bounds, -1, 2), [0.0, 0.0]);
    }
}
