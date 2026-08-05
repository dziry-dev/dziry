//! Where the caret is, and whether it is currently visible.
//!
//! # Why this is engine state
//!
//! Same argument `controls.rs` makes for checkedness, one step further. A caret index is
//! not merely undeclared — it is *unbounded* and depends on where the user clicked, so it
//! fails the compile-time gate at question 3 with nothing to enumerate. NOTES.md carries
//! the ledger entry; this file is the thing it describes.
//!
//! What it deliberately is **not** is a signal. The value a field holds is app state and
//! belongs to Bun; the caret is a property of the *pointer and keyboard*, in the same
//! category as `hovered` and `focused`, and giving it to JS would mean a round trip per
//! arrow key for something nothing in the app can observe.
//!
//! # Why the blink is here and not on a JS timer
//!
//! Visible or not is one bit, and the phase derives from a clock the frame loop already
//! reads. So a blink is `advance` returning true and a repaint of a rect — and crucially
//! it keeps blinking while Bun is busy, which a `setInterval` in the app's thread cannot
//! promise. That is the same reasoning that put transition interpolation in Rust.
//!
//! **The rate is not measured, and cannot be.** A caret is browser chrome: it has no
//! element, no computed style and nothing script can read, so `probes/caret-and-selection.html`
//! measures every rule *around* it — where a click puts it, what arrows do — and is silent
//! on how fast it flashes. 500 ms per phase is the conventional figure and it is a guess;
//! if it ever matters, it wants a screen recording rather than a probe.

/// Seconds per phase. Half a blink: on for this long, then off for this long.
const PHASE_SECONDS: f32 = 0.5;

#[derive(Default)]
pub struct Carets {
    /// Per node, the caret's index in characters. `-1` means "no caret here".
    ///
    /// Dense for the same reason `Controls::state` is: paint asks "is there a caret in
    /// this node" while drawing, so the answer has to be an indexed load rather than a
    /// search.
    index: Vec<i32>,
    /// Whether the caret is in its visible phase right now.
    visible: bool,
    /// Seconds accumulated in the current phase.
    elapsed: f32,
}

impl Carets {
    pub fn new() -> Self {
        Self {
            index: Vec::new(),
            visible: true,
            elapsed: 0.0,
        }
    }

    /// Makes room for `count` nodes, preserving what is already there.
    ///
    /// Preserving matters for the same reason it does in `Controls::rescan`: Bun
    /// republishes the tables whenever any signal changes, and a caret reset by an
    /// unrelated counter would jump to the start of the field mid-edit.
    pub fn resize(&mut self, count: usize) {
        self.index.resize(count, -1);
    }

    /// Puts the caret in `node` at `index`, and restarts the blink.
    ///
    /// Restarting is not decoration. A caret that happened to be mid-off-phase when you
    /// clicked would leave the field looking unfocused for up to half a second after a
    /// deliberate action, which reads as the click having missed.
    pub fn place(&mut self, node: usize, index: usize) {
        if node >= self.index.len() {
            self.index.resize(node + 1, -1);
        }
        for slot in self.index.iter_mut() {
            *slot = -1;
        }
        self.index[node] = index as i32;
        self.visible = true;
        self.elapsed = 0.0;
    }

    /// The caret's index in `node`, or `None` if it is not there.
    pub fn index_of(&self, node: usize) -> Option<usize> {
        match self.index.get(node).copied() {
            Some(i) if i >= 0 => Some(i as usize),
            _ => None,
        }
    }

    /// Whether a caret should be drawn this frame at all.
    pub fn visible(&self) -> bool {
        self.visible
    }

    /// Whether any node has a caret, so the common case costs one branch.
    pub fn any(&self) -> bool {
        self.index.iter().any(|&i| i >= 0)
    }

    /// Moves the blink `dt` seconds on. Returns whether the phase flipped.
    ///
    /// The return value is what schedules a repaint, so an idle frame with no caret stays
    /// free — and a frame *with* one costs a repaint twice a second rather than sixty
    /// times, because nothing else about it changed.
    pub fn advance(&mut self, dt: f32) -> bool {
        if !self.any() {
            return false;
        }
        self.elapsed += dt;
        if self.elapsed < PHASE_SECONDS {
            return false;
        }
        // Modulo rather than subtraction, so a long stall — a slow first frame, a
        // debugger pause — advances to the right phase instead of queueing up flips and
        // strobing through them one per frame.
        let phases = (self.elapsed / PHASE_SECONDS).floor();
        self.elapsed -= phases * PHASE_SECONDS;
        if (phases as i64) % 2 == 1 {
            self.visible = !self.visible;
        }
        true
    }

    /// Drops every caret, for a blur or a commit.
    pub fn clear(&mut self) {
        for slot in self.index.iter_mut() {
            *slot = -1;
        }
    }

    /// The node holding the caret, and its index. `None` when there is no caret.
    pub fn current(&self) -> Option<(usize, usize)> {
        self.index
            .iter()
            .position(|&i| i >= 0)
            .map(|node| (node, self.index[node] as usize))
    }

    /// Moves the caret within a run of `chars` characters. Returns whether it moved.
    ///
    /// `false` means the frame needs no repaint *and* the key was still consumed — an
    /// arrow at the end of the text is handled and does nothing, which is the measured
    /// behaviour: `probes/caret-and-selection.html` shows ArrowRight at the length and
    /// ArrowLeft at 0 both leaving the caret exactly where it was.
    ///
    /// Restarts the blink on every move, for the reason `place` does: a caret mid-off-phase
    /// while the user is holding an arrow down looks like the key stopped working.
    pub fn move_to(&mut self, node: usize, to: Motion, chars: usize) -> bool {
        let Some(index) = self.index_of(node) else {
            return false;
        };
        // Clamped on the way in, not just on the way out. `shift` deliberately does not
        // bound the caret from above — see the note there — so it can be sitting past the
        // end of a string the host refused to grow. This is where that heals: the first
        // arrow key pulls it back onto the text, rather than stepping from an index that
        // was never in it.
        let from = index.min(chars);
        let next = match to {
            Motion::Left => from.saturating_sub(1),
            Motion::Right => (from + 1).min(chars),
            Motion::Start => 0,
            Motion::End => chars,
        };
        self.visible = true;
        self.elapsed = 0.0;
        // Against the *stored* index, not against `from`: End on a caret already past the
        // end has `next == from` while the stored value is still out of range, and
        // returning early there would leave it there.
        if next == index {
            return false;
        }
        self.index[node] = next as i32;
        true
    }

    /// Shifts the caret by an edit of `delta` characters.
    ///
    /// Typing moves the caret past what was inserted; a backspace moves it back over what
    /// was removed. The engine does this arithmetic itself rather than waiting to be told,
    /// because the alternative is a round trip to Bun before the caret catches up — and a
    /// caret that lags the text it is in is the one thing a text field cannot do.
    ///
    /// # Why there is no upper bound here
    ///
    /// There used to be one — the length of the string in the tables — and it made typing
    /// quickly move the caret *backwards*. The value is a signal, so the tables hold the
    /// string as of Bun's last publish; two keystrokes inside one frame both measure the
    /// same pre-edit length, and the second one clamped to it. Typing "ab" into an empty
    /// field left the caret at 1 with two characters in front of it, which is exactly the
    /// off-by-one a fast typist sees.
    ///
    /// An insertion of `delta` characters puts the caret `delta` further along by
    /// definition, so no length is needed to say where it goes. The bound only ever guarded
    /// the case where the host *refuses* the keystroke at `MAX_SLOT_CHARS`; that now heals
    /// at the next arrow or click, both of which clamp, and paint clamps meanwhile because
    /// it takes a prefix rather than a slice.
    pub fn shift(&mut self, node: usize, delta: i32) {
        let Some(from) = self.index_of(node) else {
            return;
        };
        let next = (from as i64 + delta as i64).max(0);
        self.index[node] = next as i32;
        self.visible = true;
        self.elapsed = 0.0;
    }
}

/// Where a caret key wants to go.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Motion {
    Left,
    Right,
    Start,
    End,
}

/// The character boundary a click at `dx` past the run's origin lands on.
///
/// Measured, `probes/caret-and-selection.html`: a click resolves to the **nearest**
/// boundary rather than to the character under the pointer — 0.4 of a character lands at
/// 0 and 0.6 lands at 1 — and a point past the end clamps to the text's length rather
/// than to the box.
///
/// Flooring instead would put the caret before a character whose right half you clicked,
/// which reads as the click having been ignored.
///
/// `width_to` gives the advance of the first *n* characters, which is how this stays
/// correct for proportional text: the boundaries are not evenly spaced, so the nearest
/// one cannot be arithmetic on an average width.
pub fn boundary_at(dx: f32, chars: usize, mut width_to: impl FnMut(usize) -> f32) -> usize {
    if dx <= 0.0 {
        return 0;
    }
    let mut best = 0;
    let mut best_gap = f32::INFINITY;
    for n in 0..=chars {
        let gap = (width_to(n) - dx).abs();
        // `<` rather than `<=`, so an exact tie keeps the earlier boundary — which is the
        // one a left-to-right reader is pointing at.
        if gap < best_gap {
            best_gap = gap;
            best = n;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The keycodes the editing path matches on are SDL's own.
    ///
    /// Both sides of the boundary depend on these: `engine.rs` matches the arrows, Home,
    /// End and Backspace, and `host/worker.ts` matches Backspace and Delete — so this test
    /// is the oracle for the numbers written down over there too.
    ///
    /// Written from memory first, which is the thing this repo keeps proving is not good
    /// enough — so they are checked against the dependency rather than against a
    /// recollection. `window.rs` flattens a `Keycode` to `i32` at the boundary, so by the
    /// time the engine sees one there is nothing left to match on but the number, and a
    /// number that is wrong by one gives an arrow key that silently does nothing.
    #[test]
    fn the_caret_keycodes_are_the_ones_sdl_sends() {
        use sdl3::keyboard::Keycode;

        const SCANCODE_MASK: i32 = 1 << 30;
        assert_eq!(Keycode::Left.to_ll().0 as i32, SCANCODE_MASK | 80);
        assert_eq!(Keycode::Right.to_ll().0 as i32, SCANCODE_MASK | 79);
        assert_eq!(Keycode::Home.to_ll().0 as i32, SCANCODE_MASK | 74);
        assert_eq!(Keycode::End.to_ll().0 as i32, SCANCODE_MASK | 77);

        // Backspace and Delete are *not* masked, because both are ASCII control
        // characters — which is why the host can match them as plain 8 and 127. Delete
        // being 127 rather than a scancode is the whole reason it is easy to get wrong:
        // every other editing key in this list is masked.
        assert_eq!(Keycode::Backspace.to_ll().0 as i32, 8);
        assert_eq!(Keycode::Delete.to_ll().0 as i32, 127);
    }

    /// Even spacing, so the expected answers are readable: 10px per character.
    fn even(n: usize) -> f32 {
        n as f32 * 10.0
    }

    #[test]
    fn a_click_lands_on_the_nearest_boundary() {
        // The measured rule, at the measured fractions.
        assert_eq!(boundary_at(0.0, 10, even), 0);
        assert_eq!(
            boundary_at(4.0, 10, even),
            0,
            "0.4 of a character rounds down"
        );
        assert_eq!(
            boundary_at(6.0, 10, even),
            1,
            "0.6 of a character rounds up"
        );
        assert_eq!(boundary_at(34.0, 10, even), 3);
        assert_eq!(boundary_at(36.0, 10, even), 4);

        // Past the end clamps to the length, not to the box.
        assert_eq!(boundary_at(4000.0, 10, even), 10);

        // Before the origin — a click in the left padding — is the start.
        assert_eq!(boundary_at(-5.0, 10, even), 0);

        // An exact boundary is itself, and an exact midpoint keeps the earlier one.
        assert_eq!(boundary_at(20.0, 10, even), 2);
        assert_eq!(
            boundary_at(25.0, 10, even),
            2,
            "a tie keeps the earlier boundary"
        );
    }

    #[test]
    fn proportional_text_is_not_arithmetic_on_an_average() {
        // Widths of "il" then "W": narrow, narrow, wide. An average-width implementation
        // would put a click at 7px near boundary 1; the real boundaries are 0, 3, 6, 26.
        let widths = |n: usize| [0.0, 3.0, 6.0, 26.0][n];
        assert_eq!(
            boundary_at(7.0, 3, widths),
            2,
            "6 is nearer to 7 than 26 is"
        );
        assert_eq!(
            boundary_at(20.0, 3, widths),
            3,
            "26 is nearer to 20 than 6 is"
        );
    }

    /// The measured movement rules, from `probes/caret-and-selection.html`.
    #[test]
    fn arrows_move_one_boundary_and_stop_dead_at_the_ends() {
        let mut carets = Carets::new();
        carets.resize(2);
        carets.place(1, 5);

        assert!(carets.move_to(1, Motion::Left, 10));
        assert_eq!(carets.index_of(1), Some(4));
        assert!(carets.move_to(1, Motion::Right, 10));
        assert_eq!(carets.index_of(1), Some(5));

        assert!(carets.move_to(1, Motion::Start, 10));
        assert_eq!(carets.index_of(1), Some(0));
        assert!(carets.move_to(1, Motion::End, 10));
        assert_eq!(carets.index_of(1), Some(10));

        // Measured: ArrowRight at the length and ArrowLeft at 0 both leave the caret put.
        // `false` is "did not move" and the key is still consumed — the caller must not
        // forward it, or the host acts on a key the engine already claimed.
        assert!(!carets.move_to(1, Motion::Right, 10), "no move at the end");
        assert_eq!(carets.index_of(1), Some(10));
        carets.move_to(1, Motion::Start, 10);
        assert!(!carets.move_to(1, Motion::Left, 10), "no move at 0");
        assert_eq!(carets.index_of(1), Some(0));

        // A node with no caret is not something to move.
        assert!(!carets.move_to(0, Motion::Right, 10));
    }

    #[test]
    fn an_edit_carries_the_caret_with_it() {
        let mut carets = Carets::new();
        carets.resize(2);
        carets.place(1, 3);

        // Typing two characters at 3 leaves the caret after them.
        carets.shift(1, 2);
        assert_eq!(carets.index_of(1), Some(5));

        // A backspace takes it back over what was removed.
        carets.shift(1, -1);
        assert_eq!(carets.index_of(1), Some(4));

        // Clamped at 0, so a host that accepted fewer deletions than the engine assumed
        // cannot walk the caret to a negative index.
        carets.shift(1, -99);
        assert_eq!(carets.index_of(1), Some(0));
    }

    /// The bug this replaced: typing quickly moved the caret **backwards**.
    ///
    /// `shift` used to clamp to the length of the string in the tables, and the tables hold
    /// the value as of Bun's last publish. Two keystrokes inside one frame therefore both
    /// measured the same pre-edit length, and the second one clamped to it — so the caret
    /// ended up one behind the text, which is what a fast typist reported seeing.
    ///
    /// Mutation check: restoring the clamp — `next.min(chars)` for any `chars` the tables
    /// could supply here, which is 0 for an empty field — makes the second assertion read
    /// `Some(1)` instead of `Some(2)`.
    #[test]
    fn two_keystrokes_in_one_frame_do_not_clamp_against_the_stale_string() {
        let mut carets = Carets::new();
        carets.resize(2);
        carets.place(1, 0);

        // An empty field. Bun has published nothing, so the tables still say 0 characters.
        carets.shift(1, 1);
        assert_eq!(carets.index_of(1), Some(1));
        carets.shift(1, 1);
        assert_eq!(
            carets.index_of(1),
            Some(2),
            "the second keystroke of a burst must not be clamped to the pre-burst length"
        );

        // And the first arrow key heals an index that ran past the text — which is the only
        // case the removed clamp was actually guarding.
        assert!(carets.move_to(1, Motion::Left, 1));
        assert_eq!(
            carets.index_of(1),
            Some(0),
            "clamped to 1, then stepped left"
        );
        carets.shift(1, 9);
        assert!(carets.move_to(1, Motion::End, 4));
        assert_eq!(carets.index_of(1), Some(4), "End pulls it onto the text");
    }

    #[test]
    fn the_blink_flips_on_the_phase_and_survives_a_stall() {
        let mut carets = Carets::new();
        carets.resize(4);

        // No caret anywhere: nothing to blink, and no repaint asked for.
        assert!(!carets.advance(10.0), "a page with no caret must stay idle");

        carets.place(2, 3);
        assert_eq!(carets.index_of(2), Some(3));
        assert!(carets.visible(), "a freshly placed caret is solid");

        // Short of a phase: no flip, no repaint.
        assert!(!carets.advance(0.2));
        assert!(carets.visible());

        // Past it: flipped.
        assert!(carets.advance(0.4));
        assert!(!carets.visible());

        // A long stall advances to the *right* phase rather than strobing. 2.05s is four
        // phases, so an even number of flips: back to where it was.
        assert!(carets.advance(2.05));
        assert!(!carets.visible(), "four phases is an even number of flips");

        // Placing it again restarts solid, which is what stops a click looking like a miss.
        carets.place(2, 0);
        assert!(carets.visible());

        // One caret at a time: placing in another node clears the first.
        carets.place(3, 1);
        assert_eq!(carets.index_of(2), None);
        assert_eq!(carets.index_of(3), Some(1));
    }
}
