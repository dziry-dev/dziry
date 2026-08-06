//! Form-control state: which controls are on, and what a press does to them.
//!
//! # Why this is engine state at all
//!
//! Almost nothing in dziri is. The compile-time-first rule says a feature stays
//! dynamic only when it can be shown that it must, and for a checkbox the showing is
//! short: **nobody declared the answer.** An `<input type="checkbox">` with no
//! binding still ticks when you click it, and there is no signal to be the authority
//! for whether it is ticked — exactly as there is no signal for which node the
//! pointer is over. So checkedness sits beside `hovered`, `pressed` and `focused`,
//! and for the same reason.
//!
//! That is question 4 of the gate answered "no", and it is answered as narrowly as
//! possible: one bit per control. Everything *else* about a control is compile-time
//! and already in the tables — which node is a checkbox, which group a radio is in,
//! what a checked one looks like. The style for `:checked` was interned at build time
//! like every other variant, so this file's whole contribution to a frame is to make
//! one predicate bit true.
//!
//! # Why the state is dense and the table is sparse
//!
//! The `controls` table has a row per control, a dozen on a busy page. `resolve_slot`
//! asks "is this node checked" for every node it paints, so that question has to be
//! an indexed load rather than a binary search. The two are reconciled here: the
//! table is the compiler's sparse statement, `state` is the dense array this builds
//! from it on rescan. The same split `Anims` makes, for the same reason.
//!
//! # Why rescan does not re-read `checked`
//!
//! Bun republishes the tables whenever *any* signal changes. A rescan that re-seeded
//! checkedness from the table would un-tick a box because an unrelated counter
//! incremented — a bug that only appears on pages busy enough that nobody is watching
//! the checkbox. So `seen` records which controls have been initialised, and a
//! control is seeded exactly once. `DISABLED` is re-read every time, because that one
//! genuinely is compile-time: it comes from the attribute and the user cannot change
//! it.

use crate::protocol::{self, control_flags, control_kind};
use crate::tables::Tables;

const NODES: usize = protocol::Table::Nodes as usize;
const CONTROLS: usize = protocol::Table::Controls as usize;

/// What a press on a node did, so the caller knows which events to queue.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Activation {
    /// The control that was operated.
    pub node: i32,
    /// Its state afterwards.
    pub checked: bool,
    /// Whether that is a *change* — false for re-clicking a checked radio, which
    /// fires `click` and no `change`. Measured; see BROWSER-FACTS.md.
    pub changed: bool,
}

#[derive(Default)]
pub struct Controls {
    /// Per node, `ControlFlags`. Dense, engine-owned, rebuilt on rescan.
    state: Vec<u8>,
    /// Per node, whether `CHECKED` has ever been seeded from the table.
    seen: Vec<bool>,
    /// Whether the page has any controls at all, so the common case costs one branch.
    any: bool,
}

impl Controls {
    pub fn new() -> Self {
        Self::default()
    }

    /// Rebuilds the dense state from the controls table. Called when a commit changed
    /// the tables.
    ///
    /// Seeds `CHECKED` only for controls it has not seen before — see the module
    /// note. `DISABLED` is refreshed unconditionally.
    pub fn rescan(&mut self, tables: &Tables, node_count: usize) {
        self.state.resize(node_count, 0);
        self.seen.resize(node_count, false);
        // Not cleared: the resize preserves what is already there, which is the whole
        // point. Only the disabled bit is rebuilt, and only where a row says so.
        for slot in self.state.iter_mut() {
            *slot &= control_flags::CHECKED;
        }

        let ids = tables.i32s(CONTROLS, protocol::controls::NODE);
        let flags = tables.u8s(CONTROLS, protocol::controls::FLAGS);
        self.any = false;

        for (row, &node) in ids.iter().enumerate() {
            // A spare row is `i32::MAX`, which this rejects by the same bound that
            // rejects a row past the node table — untrusted host memory, so out of
            // range is a skip rather than a panic on the render thread.
            if node < 0 || node as usize >= node_count {
                continue;
            }
            self.any = true;
            let n = node as usize;
            let authored = flags.get(row).copied().unwrap_or(0);

            if !self.seen[n] {
                self.seen[n] = true;
                self.state[n] |= authored & control_flags::CHECKED;
            }
            self.state[n] |= authored & control_flags::DISABLED;
        }
    }

    /// The `ControlFlags` live for `node` right now.
    ///
    /// The hot path: called once per painted node, so the empty case is one bool and
    /// the rest is an indexed load.
    #[inline]
    pub fn state(&self, node: i32) -> u8 {
        if !self.any || node < 0 {
            return 0;
        }
        self.state.get(node as usize).copied().unwrap_or(0)
    }

    #[inline]
    pub fn is_disabled(&self, node: i32) -> bool {
        self.state(node) & control_flags::DISABLED != 0
    }

    /// Whether a press on `node` is swallowed entirely.
    ///
    /// Measured: a disabled control receives no `mousedown`, no `mouseup` and no
    /// `click` — not a click that gets ignored. So this is asked *before* the press is
    /// recorded, not after.
    ///
    /// Note it tests the node itself and not what it activates. The label of a
    /// disabled control is not disabled: it still presses, still joins the `:active`
    /// chain, and simply forwards nothing. Also measured.
    pub fn press_is_swallowed(&self, node: i32) -> bool {
        self.is_disabled(node)
    }

    /// Runs the activation behaviour for a press on `node`, if it operates a control.
    ///
    /// `node` is the node that was hit; the control comes from `nodes.activates`,
    /// which the compiler filled — for a control that is itself, for a label the
    /// control it labels, and for a label's descendants the same. So the forwarding a
    /// browser does by dispatching a second click is a table lookup here.
    ///
    /// Returns `None` when nothing was operated: no target, the target is disabled, or
    /// the row says `NONE`.
    pub fn activate(&mut self, tables: &Tables, node: i32) -> Option<Activation> {
        let target = self.target_of(tables, node)?;
        if self.is_disabled(target) {
            return None;
        }

        let row = self.row_of(tables, target)?;
        let kind = tables
            .u8s(CONTROLS, protocol::controls::KIND)
            .get(row)
            .copied()
            .unwrap_or(control_kind::NONE);

        match kind {
            control_kind::CHECKBOX => {
                let now = self.state(target) & control_flags::CHECKED == 0;
                self.set(target, now);
                Some(Activation {
                    node: target,
                    checked: now,
                    changed: true,
                })
            }
            // An option commits on the **release**, which is why it is here beside the
            // radio rather than on the press with its select. The gesture is one motion —
            // press the select, drag down, let go over a choice — so the open happens on
            // the way down and the commit on the way up, and a click on an already-open
            // picker takes the same path.
            //
            // Sharing the radio arm is not a shortcut: committing an option *is* checking
            // one member of a group and clearing the rest, down to "re-committing the
            // current choice is not a change". Everything that differs — closing the
            // picker, restoring focus, repointing the label — is the select layer's, and
            // none of it is checkedness.
            control_kind::RADIO | control_kind::OPTION => {
                // A radio cannot be unchecked by pointer, so a press on a checked one
                // is not a change — it fires `click` and nothing else. Measured.
                if self.state(target) & control_flags::CHECKED != 0 {
                    return Some(Activation {
                        node: target,
                        checked: true,
                        changed: false,
                    });
                }

                let group = tables
                    .i32s(CONTROLS, protocol::controls::GROUP)
                    .get(row)
                    .copied()
                    .unwrap_or(-1);
                self.clear_group(tables, group, target);
                self.set(target, true);
                Some(Activation {
                    node: target,
                    checked: true,
                    changed: true,
                })
            }
            // A `SELECT` deliberately does nothing here, and it is the one kind that
            // reaches this arm rather than being absent from the table. Its behaviour is
            // on the **press**: measured, `probes/select-picker.html` — the press alone
            // opened the picker before any release, which is the opposite of a checkbox,
            // whose bit flips during the click. So `Engine::mouse_down` opens it and this
            // function, which runs on the release, has nothing left to do.
            //
            // Putting it here anyway would make a select feel a frame late in exactly the
            // gesture people use most, and would then *close* on the release of the press
            // that opened it.
            _ => None,
        }
    }

    /// What kind of control `node` is, or `NONE` for "not one".
    ///
    /// Public because the select layer asks it of nodes it is walking past — "is this an
    /// option" is the same question as "does it have a row saying OPTION", and the binary
    /// search that answers it already lives here. A second copy over there would be a
    /// second place to get the sortedness contract wrong.
    pub fn kind_of(&self, tables: &Tables, node: i32) -> u8 {
        if node < 0 {
            return control_kind::NONE;
        }
        match self.row_of(tables, node) {
            Some(row) => tables
                .u8s(CONTROLS, protocol::controls::KIND)
                .get(row)
                .copied()
                .unwrap_or(control_kind::NONE),
            None => control_kind::NONE,
        }
    }

    /// The group `node` belongs to, or -1 for "none" — a checkbox, or an unnamed radio.
    ///
    /// The same column `activate` reads to clear a group, asked as a question instead of
    /// inline, because the tab walk needs it for a different reason: a group is one tab
    /// stop, so the walk has to know which stops belong to the same one before it can
    /// decide which single member survives.
    pub fn group_of(&self, tables: &Tables, node: i32) -> i32 {
        match self.row_of(tables, node) {
            Some(row) => tables
                .i32s(CONTROLS, protocol::controls::GROUP)
                .get(row)
                .copied()
                .unwrap_or(-1),
            None => -1,
        }
    }

    /// The control a press on `node` operates, or `None`.
    fn target_of(&self, tables: &Tables, node: i32) -> Option<i32> {
        if !self.any || node < 0 {
            return None;
        }
        let target = tables
            .i32s(NODES, protocol::nodes::ACTIVATES)
            .get(node as usize)
            .copied()
            .unwrap_or(-1);
        if target < 0 {
            None
        } else {
            Some(target)
        }
    }

    /// The controls-table row for a node, by binary search on the sorted `node`
    /// column.
    ///
    /// The sortedness is the uploader's to maintain, and it is why spare rows are
    /// padded with `i32::MAX` rather than `-1` or left at zero: padding sits at the
    /// *end* of the table, so only a sentinel above every real node keeps the column
    /// ordered. See `NO_CONTROL_NODE` in `upload.ts`.
    fn row_of(&self, tables: &Tables, node: i32) -> Option<usize> {
        tables
            .i32s(CONTROLS, protocol::controls::NODE)
            .binary_search(&node)
            .ok()
    }

    /// Unchecks every other member of a radio group.
    ///
    /// Group `-1` means "no group", which needs no special case: nothing else is in
    /// it, so the scan finds nothing. That is what a nameless radio does in a browser.
    fn clear_group(&mut self, tables: &Tables, group: i32, keep: i32) {
        if group < 0 {
            return;
        }
        let ids = tables.i32s(CONTROLS, protocol::controls::NODE);
        let groups = tables.i32s(CONTROLS, protocol::controls::GROUP);
        for (row, &other) in ids.iter().enumerate() {
            if other < 0 || other == keep {
                continue;
            }
            if groups.get(row).copied().unwrap_or(-1) != group {
                continue;
            }
            self.set(other, false);
        }
    }

    fn set(&mut self, node: i32, checked: bool) {
        if node < 0 {
            return;
        }
        let Some(slot) = self.state.get_mut(node as usize) else {
            return;
        };
        if checked {
            *slot |= control_flags::CHECKED;
        } else {
            *slot &= !control_flags::CHECKED;
        }
    }

    /// Forces a control's checkedness, for tests and for a future host-driven bind.
    #[cfg(test)]
    pub fn set_checked(&mut self, node: i32, checked: bool) {
        self.any = true;
        if self.state.len() <= node as usize {
            self.state.resize(node as usize + 1, 0);
            self.seen.resize(node as usize + 1, false);
        }
        self.set(node, checked);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::control_kind;
    use crate::tables::{Capacities, Tables};

    const NODE_COUNT: usize = 8;

    fn tables() -> Tables {
        let mut t = Tables::new(Capacities {
            nodes: NODE_COUNT as u32,
            styles: 2,
            variants: 1,
            variant_slots: 1,
            media: 1,
            lists: 1,
            tweens: 1,
            keyframes: 1,
            controls: 4,
            strings: 1,
            string_bytes: 64,
        });

        // Every node operates nothing until a row below says otherwise.
        for n in 0..NODE_COUNT {
            t.set_i32(NODES, protocol::nodes::ACTIVATES, n, -1);
        }
        // Spare rows exactly as the uploader writes them: `i32::MAX`, which keeps the
        // column sorted with the padding at the end. Padding with `-1` here is what
        // the first version of these tests did, and every one of them failed —
        // `[1, -1, -1]` is not sorted, so the binary search found nothing.
        for row in 0..4 {
            t.set_i32(CONTROLS, protocol::controls::NODE, row, i32::MAX);
            t.set_i32(CONTROLS, protocol::controls::GROUP, row, -1);
        }
        t
    }

    /// Rows must be written ascending by node — the engine binary-searches them.
    fn control(t: &mut Tables, row: usize, node: i32, kind: u8, group: i32, flags: u8) {
        t.set_i32(CONTROLS, protocol::controls::NODE, row, node);
        t.set_u8(CONTROLS, protocol::controls::KIND, row, kind);
        t.set_i32(CONTROLS, protocol::controls::GROUP, row, group);
        t.set_u8(CONTROLS, protocol::controls::FLAGS, row, flags);
        t.set_i32(NODES, protocol::nodes::ACTIVATES, node as usize, node);
    }

    #[test]
    fn a_checkbox_toggles_and_keeps_toggling() {
        let mut t = tables();
        control(&mut t, 0, 1, control_kind::CHECKBOX, -1, 0);

        t.commit();
        let mut c = Controls::new();
        c.rescan(&t, NODE_COUNT);
        assert_eq!(c.state(1) & control_flags::CHECKED, 0);

        let first = c.activate(&t, 1).expect("activated");
        assert!(first.checked && first.changed);
        assert_ne!(c.state(1) & control_flags::CHECKED, 0);

        let second = c.activate(&t, 1).expect("activated");
        assert!(!second.checked && second.changed, "and back off again");
        assert_eq!(c.state(1) & control_flags::CHECKED, 0);
    }

    /// The measured rule: a radio sets itself, clears its group, and re-clicking it is
    /// not a change.
    #[test]
    fn a_radio_clears_its_group_and_cannot_be_unchecked() {
        let mut t = tables();
        control(&mut t, 0, 1, control_kind::RADIO, 7, control_flags::CHECKED);
        control(&mut t, 1, 2, control_kind::RADIO, 7, 0);
        // Same shape, different group — must be untouched by either of the above.
        control(&mut t, 2, 3, control_kind::RADIO, 9, control_flags::CHECKED);

        t.commit();
        let mut c = Controls::new();
        c.rescan(&t, NODE_COUNT);
        assert_ne!(c.state(1) & control_flags::CHECKED, 0, "authored checked");

        let picked = c.activate(&t, 2).expect("activated");
        assert!(picked.checked && picked.changed);
        assert_eq!(c.state(1) & control_flags::CHECKED, 0, "group-mate cleared");
        assert_ne!(
            c.state(3) & control_flags::CHECKED,
            0,
            "another group is not touched"
        );

        let again = c.activate(&t, 2).expect("click still happened");
        assert!(again.checked, "still checked");
        assert!(
            !again.changed,
            "but not a change — measured, no `change` event"
        );
    }

    /// A press on a label operates the control the compiler pointed it at, and the
    /// label itself never becomes a control.
    #[test]
    fn a_label_operates_the_control_it_points_at() {
        let mut t = tables();
        control(&mut t, 0, 2, control_kind::CHECKBOX, -1, 0);
        // Node 4 is a label, node 5 a span inside it. Both aim at the checkbox.
        t.set_i32(NODES, protocol::nodes::ACTIVATES, 4, 2);
        t.set_i32(NODES, protocol::nodes::ACTIVATES, 5, 2);

        t.commit();
        let mut c = Controls::new();
        c.rescan(&t, NODE_COUNT);

        assert_eq!(c.activate(&t, 4).map(|a| a.node), Some(2), "via the label");
        assert_ne!(c.state(2) & control_flags::CHECKED, 0);
        assert_eq!(c.activate(&t, 5).map(|a| a.node), Some(2), "via its span");
        assert_eq!(c.state(2) & control_flags::CHECKED, 0, "toggled back");
        assert_eq!(c.state(4), 0, "the label is not itself a control");
    }

    #[test]
    fn a_disabled_control_swallows_the_press() {
        let mut t = tables();
        control(
            &mut t,
            0,
            1,
            control_kind::CHECKBOX,
            -1,
            control_flags::DISABLED,
        );
        // And a label aimed at it, which is *not* itself disabled.
        t.set_i32(NODES, protocol::nodes::ACTIVATES, 4, 1);

        t.commit();
        let mut c = Controls::new();
        c.rescan(&t, NODE_COUNT);

        assert!(c.press_is_swallowed(1), "the control takes no press at all");
        assert!(!c.press_is_swallowed(4), "its label still presses");
        assert_eq!(c.activate(&t, 1), None);
        assert_eq!(c.activate(&t, 4), None, "and the label forwards nothing");
        assert_eq!(c.state(1) & control_flags::CHECKED, 0);
    }

    /// The correctness condition from the module note, as a test: a republish must not
    /// reset what the user did.
    #[test]
    fn a_rescan_does_not_untick_a_box_the_user_ticked() {
        let mut t = tables();
        control(&mut t, 0, 1, control_kind::CHECKBOX, -1, 0);
        control(
            &mut t,
            1,
            2,
            control_kind::CHECKBOX,
            -1,
            control_flags::CHECKED,
        );

        t.commit();
        let mut c = Controls::new();
        c.rescan(&t, NODE_COUNT);

        c.activate(&t, 1).expect("ticked by the user");
        c.activate(&t, 2)
            .expect("and this one unticked by the user");

        // Bun republishes because some unrelated signal changed. The table still says
        // what the *author* wrote, which is the opposite of the truth in both cases.
        c.rescan(&t, NODE_COUNT);

        assert_ne!(
            c.state(1) & control_flags::CHECKED,
            0,
            "still ticked, though the table says it was authored unticked"
        );
        assert_eq!(
            c.state(2) & control_flags::CHECKED,
            0,
            "still unticked, though the table says it was authored ticked"
        );
    }

    /// A page with no controls must not pay for this, and must not find a control
    /// where there is none — a spare row left at zero would name node 0.
    #[test]
    fn a_page_with_no_controls_activates_nothing() {
        let mut t = tables();
        t.commit();
        let mut c = Controls::new();
        c.rescan(&t, NODE_COUNT);

        for node in 0..NODE_COUNT as i32 {
            assert_eq!(c.activate(&t, node), None);
            assert_eq!(c.state(node), 0);
            assert!(!c.press_is_swallowed(node));
        }
    }
}
