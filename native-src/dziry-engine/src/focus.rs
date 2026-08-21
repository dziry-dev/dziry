//! Keyboard focus: which nodes Tab can reach, and where it goes next.
//!
//! ROADMAP A3, and the module exists because the answer splits cleanly in two and the
//! halves live on opposite sides of the boundary:
//!
//! - **The set** is compile-time. A node is a tab stop because of what it is — a
//!   `<button>`, an `<a href>`, a form control — and no reordering changes that. The
//!   compiler emits `NodeFlags::TAB_STOP` and this module never re-derives it.
//! - **The order** is a live walk of the tree, because document order is a property of
//!   the tree at this instant. Node ids happen to be in document order today (measured:
//!   0 of 984 nodes on the demo has a child id below its parent), so a sorted table
//!   would look right and would break the first time a keyed list reorders. That is
//!   exactly the case A3's own bullet warns about, and the reason the walk is here
//!   rather than a `Vec` built once at rescan.
//!
//! Three things remove a node from the order at run time, none of which the compiler
//! can see, and each is a different mechanism:
//!
//! 1. `:disabled` — a live predicate bit the engine already owns.
//! 2. Not laid out or route-hidden — the same two tests paint makes, so a `display:none`
//!    subtree and a route that is not showing are both skipped for free.
//! 3. Being the wrong member of a radio group — a group is **one** stop, and it is the
//!    checked member. Live state by definition.
//!
//! # What is deliberately not here
//!
//! Anything about what a key *does* once focus has landed. Tab moves focus; Enter and
//! Space activate; arrows navigate inside a group. Only the first is this module's, and
//! keeping activation in `controls.rs` is what stops "focus" and "input" becoming one
//! sprawling file — the shape the user asked for when they asked whether the
//! accessibility model could be built to make new cases easy.
//!
//! # This is keyboard operability, not accessibility
//!
//! WCAG 2.1 SC 2.1.1 and 2.4.3, which is the half dziry claims. Assistive technology —
//! UIAutomation, NSAccessibility, AT-SPI — is a separate surface that does not exist
//! yet. A tab order does not make an app screen-reader accessible and nothing here
//! should be described as though it does.

use crate::paint::{Geometry, InputState, Painter};
use crate::protocol::{self, control_flags, control_kind};
use crate::tables::Tables;

const NODES: usize = protocol::Table::Nodes as usize;

/// Collects every node Tab can reach, in document order.
///
/// The walk is the *whole* tree once per press, which is O(nodes) — about 984 on the
/// demo, for an event that happens at human speed. Caching it would mean invalidating on
/// every republish, every route change and every list splice, and being wrong in exactly
/// the case the order exists to handle.
///
/// The overlay skip is not here on purpose. A `<select>`'s picker is not tabbable — its
/// options carry no `TAB_STOP` — but its subtree still has to be *walked*, because an
/// overlay can in principle contain a stop, and the tab order a user perceives is
/// document order regardless of paint order.
pub fn tab_stops(
    painter: &Painter,
    tables: &Tables,
    geometry: Geometry,
    state: &InputState,
    root: usize,
    out: &mut Vec<i32>,
) {
    focusable_nodes(painter, tables, geometry, state, root, out);
    collapse_radio_groups(painter, tables, out);
}

/// The members of one radio group, in document order.
///
/// The list arrows walk inside a group, and it is deliberately built from the same source
/// as the tab order rather than from the controls table directly: a member that is
/// disabled, `display:none` or inside a hidden route is not focusable, so an arrow must
/// not land on it either. Reading the table would find those members and reading the walk
/// cannot, which is the kind of divergence that produces focus on an invisible node.
///
/// This is the *pre-collapse* list — every member, not the one that carries the tab stop.
/// Collapsing is what makes the group one stop; arrows are what move within it, and they
/// need the whole thing.
pub fn group_members(
    painter: &Painter,
    tables: &Tables,
    geometry: Geometry,
    state: &InputState,
    root: usize,
    group: i32,
    out: &mut Vec<i32>,
) {
    focusable_nodes(painter, tables, geometry, state, root, out);
    out.retain(|&node| {
        painter.control_kind(tables, node) == control_kind::RADIO
            && painter.control_group(tables, node) == group
    });
}

/// Every node claiming `autofocus` that is actually showing, in document order.
///
/// The first one wins and the rest are fallbacks, which is measured rather than assumed:
/// `probes/autofocus-hidden.html` put three claims in one document, the first two
/// unfocusable, and Chromium focused the third. So an unfocusable claim does not abort
/// autofocus and does not win it — the list is walked.
///
/// **dziry needs the fallback far more than a browser does.** A page here has fourteen
/// routes and thirteen of them are hidden on the first frame, so "every route's form
/// focuses its own first field" — the obvious thing to write — produces fourteen claims of
/// which exactly one is showing. Picking the first claim in the markup would focus an
/// invisible node on thirteen of the fourteen routes; picking the first *showing* one is
/// right on all fourteen, and needs no rule about routes at all.
///
/// That is also why the compiler emits every candidate instead of resolving to one. Which
/// claim is showable is runtime state, and it is the only part of `autofocus` that is.
pub fn autofocus_candidates(
    painter: &Painter,
    tables: &Tables,
    geometry: Geometry,
    state: &InputState,
    root: usize,
    out: &mut Vec<i32>,
) {
    showing_nodes(
        painter,
        tables,
        geometry,
        state,
        root,
        protocol::flags::AUTOFOCUS,
        out,
    );
}

/// Whether the user can still see `node` — the bottom-up twin of the walk below.
///
/// The walk asks "which nodes can focus land on"; this asks "may focus *stay* where
/// it is", each tick, for one node. Walking up the parent chain checks the same two
/// exclusions the top-down walk applies to whole subtrees — a `hidden` byte (a route
/// switched away, a `<Show>` closed, a Suspense boundary flipped) and `display:none`
/// anywhere above — without the O(nodes) sweep, because an ancestor chain is as deep
/// as the tree, not as wide.
///
/// This is the enforcement half of the API's focus doctrine: focus clears when a node
/// becomes unreachable, so a hidden field cannot keep eating keystrokes. It is also a
/// deliberate divergence from Chromium, which leaves focus on a `display:none` element
/// (measured, BROWSER-FACTS.md) — a WCAG 2.4.3/2.4.7 defect every focus library works
/// around, and the one place the browser's observable contract is not matched.
///
/// Deliberately *not* checked: `:disabled` (not in the doctrine — a control disabling
/// itself mid-interaction keeping focus is at worst harmless, and clearing it is a
/// behaviour nobody measured), and scroll-out (the node still exists; only its row was
/// recycled — the doctrine says retained).
pub fn is_reachable(painter: &Painter, tables: &Tables, state: &InputState, node: i32) -> bool {
    let hidden = tables.u8s(NODES, protocol::nodes::HIDDEN);
    let parent = tables.i32s(NODES, protocol::nodes::PARENT);
    let count = hidden.len();
    if node < 0 || node as usize >= count {
        return false;
    }

    let mut current = node;
    // A parent chain longer than the node count is a cycle in Bun-written memory —
    // untrusted input, so it is an answer ("unreachable") rather than a hang.
    let mut budget = count + 1;
    while current >= 0 && (current as usize) < count {
        if budget == 0 {
            return false;
        }
        budget -= 1;

        if hidden[current as usize] != 0 {
            return false;
        }
        if painter.display_is_none(tables, current as usize, state) {
            return false;
        }
        current = parent[current as usize];
    }
    true
}

/// Every focusable node in document order, before a group is collapsed to one stop.
fn focusable_nodes(
    painter: &Painter,
    tables: &Tables,
    geometry: Geometry,
    state: &InputState,
    root: usize,
    out: &mut Vec<i32>,
) {
    showing_nodes(
        painter,
        tables,
        geometry,
        state,
        root,
        protocol::flags::TAB_STOP,
        out,
    );
}

/// Nodes carrying `want`, in document order, skipping everything the user cannot reach.
///
/// The walk is shared by the tab order and by `autofocus` because the *exclusions* are the
/// same question — a hidden route, a `display:none` subtree and a disabled control are
/// unreachable whoever is asking — and only the flag differs. Keeping them one function is
/// what stops the two answers drifting, which would show up as focus landing somewhere Tab
/// swears is not in the order.
fn showing_nodes(
    painter: &Painter,
    tables: &Tables,
    geometry: Geometry,
    state: &InputState,
    root: usize,
    want: u8,
    out: &mut Vec<i32>,
) {
    out.clear();
    let count = geometry.bounds.len();
    let hidden = tables.u8s(NODES, protocol::nodes::HIDDEN);
    let flags = tables.u8s(NODES, protocol::nodes::FLAGS);
    let first = tables.i32s(NODES, protocol::nodes::FIRST_CHILD);
    let next = tables.i32s(NODES, protocol::nodes::NEXT_SIBLING);

    // Explicit stack with children pushed reversed so they pop in document order — the
    // same shape and the same reason as the paint walk: a hostile table must not be able
    // to recurse the render thread's stack away.
    let mut stack: Vec<usize> = vec![root];
    let mut kids: Vec<usize> = Vec::new();
    let mut budget = count.saturating_mul(2) + 16;

    while let Some(node) = stack.pop() {
        if budget == 0 {
            break;
        }
        budget -= 1;

        // A route that is not showing, and everything under it. Without this the demo's
        // thirteen hidden routes are in the tab order, and Tab walks into pages the user
        // cannot see — which is the classic keyboard trap, arrived at by omission.
        if node >= count || hidden.get(node).copied().unwrap_or(0) != 0 {
            continue;
        }

        // `display: none` takes the subtree out of the order, exactly as it takes it out
        // of paint. Read from the *resolved* slot rather than the base one, because
        // `display` can differ per predicate and a node hidden only in its hovered state
        // is a real thing to express.
        if painter.display_is_none(tables, node, state) {
            continue;
        }

        if flags.get(node).copied().unwrap_or(0) & want != 0
            && !painter.control_is_disabled(node as i32)
        {
            out.push(node as i32);
        }

        kids.clear();
        let mut child = first.get(node).copied().unwrap_or(-1);
        while child >= 0 && (child as usize) < count {
            kids.push(child as usize);
            child = next.get(child as usize).copied().unwrap_or(-1);
            if kids.len() > count {
                break;
            }
        }
        for &kid in kids.iter().rev() {
            stack.push(kid);
        }
    }
}

/// Reduces every radio group in `stops` to the single stop it is.
///
/// Measured, `probes/tab-order.html`: a group with nothing checked stops on its **first**
/// member, and a group with a checked member stops on **that** one, skipping earlier
/// siblings. This is ARIA's roving tabindex, arrived at from the platform rather than
/// from the pattern, and it is the first of the five controls ROADMAP A3 wants it for.
///
/// In place and order-preserving, because `stops` is already in document order and the
/// surviving member has to stay where it sits in that order rather than where the group
/// began. Two passes rather than a map: the first finds each group's winner, the second
/// drops everyone else. Groups are tiny and there are few of them, so the quadratic
/// lookup is cheaper than a hash map's allocation on a path that runs per keystroke.
fn collapse_radio_groups(painter: &Painter, tables: &Tables, stops: &mut Vec<i32>) {
    // `(group, winner)`, one entry per group present among the stops.
    let mut winners: Vec<(i32, i32)> = Vec::new();

    for &node in stops.iter() {
        if painter.control_kind(tables, node) != control_kind::RADIO {
            continue;
        }
        let group = painter.control_group(tables, node);
        if group < 0 {
            // A radio with no group is its own stop. HTML says an unnamed radio is not in
            // any group, so there is nothing to collapse it against.
            continue;
        }
        let checked = painter.control_state(node) & control_flags::CHECKED != 0;
        match winners.iter_mut().find(|(g, _)| *g == group) {
            // The first member seen wins provisionally; a checked one later in the group
            // takes it. Only one member can be checked, so this never has to choose
            // between two.
            Some(entry) => {
                if checked {
                    entry.1 = node;
                }
            }
            None => winners.push((group, node)),
        }
    }

    if winners.is_empty() {
        return;
    }

    stops.retain(|&node| {
        if painter.control_kind(tables, node) != control_kind::RADIO {
            return true;
        }
        let group = painter.control_group(tables, node);
        match winners.iter().find(|(g, _)| *g == group) {
            Some(&(_, winner)) => node == winner,
            None => true,
        }
    });
}

/// Where Tab goes from `from`, or -1 if there is nowhere to go.
///
/// Wraps at both ends. A browser does not — it hands focus to the address bar, which
/// this measured as one stop on `BODY` before the cycle restarted — and dziry has no
/// browser chrome to hand it to. Wrapping is the deliberate divergence rather than the
/// oversight it would look like: the alternative is focus vanishing at the end of the
/// document with no way to bring it back from the keyboard.
///
/// **Focus that is nowhere is not an error.** Nothing is focused when a window opens, and
/// the first Tab has to land on the first stop; the first Shift+Tab on the last. Same for
/// focus sitting on a node that is not a stop — an `<option>` in an open picker, a node a
/// pointer press focused — where "the next one after it" is not defined by this list, so
/// the walk starts from the end it is coming from.
pub fn step(stops: &[i32], from: i32, backward: bool) -> i32 {
    step_within(stops, from, !backward, true)
}

/// Moves one place through an ordered list of nodes. The whole of "arrows inside".
///
/// ROADMAP A3's "one tab stop, arrows inside it" reduced to the part that is genuinely
/// shared. A tab order, a radio group and a `<select>` picker are three lists a key walks,
/// and having measured all three the *only* thing that differs between the walks is
/// whether they wrap:
///
/// | list | wrap | measured in |
/// |---|---|---|
/// | tab order | yes (dziry; a browser leaves for its chrome) | `tab-order.html` |
/// | radio group | **yes** | `keyboard-activation.html` |
/// | picker options | **no — clamps** | `select-picker.html` |
///
/// That a group wraps and a picker clamps under the same arrow keys is exactly why the
/// flag is a parameter rather than a policy baked in here. Everything else that varies —
/// which nodes are in the list, whether landing on one activates it, which keys count as
/// forward — belongs to the caller, because those are facts about the control and this is
/// a walk over a slice.
///
/// **Not being in the list is not an error.** Nothing is focused when a window opens, and
/// focus can sit on a node no list contains. Entering from the end you are coming from is
/// what makes the first Tab land on the first stop and a first ArrowUp into a fresh picker
/// land on its last option.
pub fn step_within(members: &[i32], from: i32, forward: bool, wrap: bool) -> i32 {
    if members.is_empty() {
        return -1;
    }
    let last = members.len() - 1;
    match members.iter().position(|&n| n == from) {
        Some(0) if !forward => members[if wrap { last } else { 0 }],
        Some(i) if !forward => members[i - 1],
        Some(i) if i == last => members[if wrap { 0 } else { last }],
        Some(i) => members[i + 1],
        None if forward => members[0],
        None => members[last],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn step_walks_forward_and_wraps() {
        let stops = [3, 7, 9];
        assert_eq!(step(&stops, 3, false), 7);
        assert_eq!(step(&stops, 7, false), 9);
        assert_eq!(step(&stops, 9, false), 3, "forward off the end wraps");
    }

    #[test]
    fn step_walks_backward_and_wraps() {
        let stops = [3, 7, 9];
        assert_eq!(step(&stops, 9, true), 7);
        assert_eq!(step(&stops, 7, true), 3);
        assert_eq!(step(&stops, 3, true), 9, "backward off the start wraps");
    }

    /// The two cases that are not "move one along", and both really happen: nothing is
    /// focused when a window opens, and focus sits on an `<option>` — which is not a tab
    /// stop — for as long as a picker is open.
    #[test]
    fn an_unknown_focus_enters_from_the_end_it_is_coming_from() {
        let stops = [3, 7, 9];
        assert_eq!(step(&stops, -1, false), 3);
        assert_eq!(step(&stops, -1, true), 9);
        assert_eq!(
            step(&stops, 42, false),
            3,
            "a node outside the set enters at the top"
        );
        assert_eq!(step(&stops, 42, true), 9);
    }

    #[test]
    fn nowhere_to_go_is_minus_one_rather_than_a_panic() {
        assert_eq!(step(&[], 5, false), -1);
        assert_eq!(step(&[], -1, true), -1);
    }

    /// One stop is a fixed point in both directions, which is the degenerate case a
    /// modulo-based implementation gets right by accident and an index-comparison one
    /// gets wrong by reaching for `i - 1`.
    #[test]
    fn a_single_stop_wraps_to_itself() {
        assert_eq!(step(&[4], 4, false), 4);
        assert_eq!(step(&[4], 4, true), 4);
    }
}
