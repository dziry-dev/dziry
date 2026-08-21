//! Where the caret is, and whether it is currently visible.
//!
//! # Why this is engine state
//!
//! Same argument `controls.rs` makes for checkedness, one step further. A caret index is
//! not merely undeclared — it is *unbounded* and depends on where the user clicked, so it
//! fails the compile-time gate at question 3 with nothing to enumerate. The **selection**
//! is the same thing twice over: two unbounded indices instead of one.
//!
//! ROADMAP A5 asks for a NOTES.md ledger entry naming both, in the same terms as the ones
//! already there, and **it is still owed** — this header claimed it existed, which it did
//! not. The argument is here in the meantime; the entry is the debt.
//!
//! What it deliberately is **not** is a signal. The value a field holds is app state and
//! belongs to Bun; the caret is a property of the *pointer and keyboard*, in the same
//! category as `hovered` and `focused`, and giving it to JS would mean a round trip per
//! arrow key for something nothing in the app can observe. A drag makes that concrete: the
//! focus moves on every pointer motion, and a signal would mean a round trip per pixel.
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
    /// Per node, the **focus** — the end that moves, and where the caret is drawn.
    /// `-1` means "no caret here".
    ///
    /// Dense for the same reason `Controls::state` is: paint asks "is there a caret in
    /// this node" while drawing, so the answer has to be an indexed load rather than a
    /// search.
    index: Vec<i32>,
    /// Per node, the **anchor** — the end a Shift or a drag leaves where it was.
    ///
    /// `(anchor, focus)` rather than `(start, end)`, and that is measured rather than
    /// preferred. From a caret at 5, `probes/caret-and-selection.html` shows Shift+ArrowLeft
    /// walking `5..6`, `5..5`, then **`4..5 backward`** — the anchor stays at 5 *through* the
    /// reversal. With an ordered pair, "extend" has no way to know which end to move once
    /// the two have crossed. Shift+click reverses the same way, from the pointer side.
    ///
    /// Equal to `index` means collapsed, which is an ordinary caret; there is no separate
    /// "no selection" state to keep in step.
    anchor: Vec<i32>,
    /// Whether the caret is in its visible phase right now.
    visible: bool,
    /// Seconds accumulated in the current phase.
    elapsed: f32,
}

impl Carets {
    pub fn new() -> Self {
        Self {
            index: Vec::new(),
            anchor: Vec::new(),
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
        self.anchor.resize(count, -1);
    }

    /// Grows both columns so `node` is addressable.
    fn reserve(&mut self, node: usize) {
        if node >= self.index.len() {
            self.index.resize(node + 1, -1);
            self.anchor.resize(node + 1, -1);
        }
    }

    /// Puts a **collapsed** caret in `node` at `index`, and restarts the blink.
    ///
    /// Collapsed because this is what a plain click does, and a click that left the previous
    /// selection standing would be a field you cannot deselect.
    ///
    /// Restarting the blink is not decoration. A caret that happened to be mid-off-phase when
    /// you clicked would leave the field looking unfocused for up to half a second after a
    /// deliberate action, which reads as the click having missed.
    pub fn place(&mut self, node: usize, index: usize) {
        self.reserve(node);
        for slot in self.index.iter_mut() {
            *slot = -1;
        }
        for slot in self.anchor.iter_mut() {
            *slot = -1;
        }
        self.index[node] = index as i32;
        self.anchor[node] = index as i32;
        self.visible = true;
        self.elapsed = 0.0;
    }

    /// Moves the focus to `to`, leaving the anchor where it is.
    ///
    /// A drag and a Shift+click, which are the same gesture as far as this is concerned. No
    /// effect on a node with no caret: there is no anchor to extend from, and inventing one
    /// at 0 would select from the start of the field on a stray drag.
    pub fn extend(&mut self, node: usize, to: usize) -> bool {
        if self.index_of(node).is_none() {
            return false;
        }
        self.visible = true;
        self.elapsed = 0.0;
        if self.index[node] == to as i32 {
            return false;
        }
        self.index[node] = to as i32;
        true
    }

    /// Selects `anchor..focus` outright, for a word or a whole value.
    ///
    /// Takes the two ends in gesture order rather than document order, so a caller that
    /// selects backwards keeps the direction — the same reason the pair is stored this way.
    pub fn select(&mut self, node: usize, anchor: usize, focus: usize) {
        self.reserve(node);
        self.anchor[node] = anchor as i32;
        self.index[node] = focus as i32;
        self.visible = true;
        self.elapsed = 0.0;
    }

    /// The caret's index in `node` — the **focus** — or `None` if it is not there.
    pub fn index_of(&self, node: usize) -> Option<usize> {
        match self.index.get(node).copied() {
            Some(i) if i >= 0 => Some(i as usize),
            _ => None,
        }
    }

    /// The selected range in `node`, **in document order**, or `None` when collapsed.
    ///
    /// Ordered here and not in storage: every consumer — painting a band, splicing a
    /// string — wants `start <= end`, and none of them cares which end the user dragged
    /// from. Only `move_to` needs the direction, and it reads the raw pair.
    pub fn range_of(&self, node: usize) -> Option<(usize, usize)> {
        let focus = self.index_of(node)?;
        let anchor = match self.anchor.get(node).copied() {
            Some(a) if a >= 0 => a as usize,
            _ => return None,
        };
        if anchor == focus {
            return None;
        }
        Some((anchor.min(focus), anchor.max(focus)))
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
        for slot in self.anchor.iter_mut() {
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

    /// Moves the caret within a run of `chars` characters. Returns whether anything changed.
    ///
    /// `false` means the frame needs no repaint *and* the key was still consumed — an
    /// arrow at the end of the text is handled and does nothing, which is the measured
    /// behaviour: `probes/caret-and-selection.html` shows ArrowRight at the length and
    /// ArrowLeft at 0 both leaving the caret exactly where it was.
    ///
    /// `extend` is Shift held. It moves the focus and leaves the anchor, which is the whole
    /// of keyboard selection; without it, the anchor follows and the result is a caret.
    ///
    /// # A plain arrow with a live selection collapses it, and does not then step
    ///
    /// Measured: with `2..6` selected, ArrowLeft gives `2..2` and ArrowRight gives `6..6` —
    /// the *matching* end, and no further movement. Collapsing to the near end and then
    /// stepping would land one character out, in the direction the user is looking. Home and
    /// End are exempt because they are absolute: they go to 0 and to the length either way.
    ///
    /// Restarts the blink on every move, for the reason `place` does: a caret mid-off-phase
    /// while the user is holding an arrow down looks like the key stopped working.
    pub fn move_to(&mut self, node: usize, to: Motion, chars: usize, extend: bool) -> bool {
        let Some(index) = self.index_of(node) else {
            return false;
        };
        self.visible = true;
        self.elapsed = 0.0;

        // Clamped on the way in, not just on the way out. `shift` deliberately does not
        // bound the caret from above — see the note there — so it can be sitting past the
        // end of a string the host refused to grow. This is where that heals: the first
        // arrow key pulls it back onto the text, rather than stepping from an index that
        // was never in it.
        let from = index.min(chars);

        if !extend {
            if let Some((start, end)) = self.range_of(node) {
                let collapse = match to {
                    Motion::Left => Some(start.min(chars)),
                    Motion::Right => Some(end.min(chars)),
                    // Absolute, so there is nothing to collapse *to* — they take the caret
                    // to a place that does not depend on where the selection was.
                    Motion::Start | Motion::End => None,
                };
                if let Some(at) = collapse {
                    self.index[node] = at as i32;
                    self.anchor[node] = at as i32;
                    return true;
                }
            }
        }

        let next = match to {
            Motion::Left => from.saturating_sub(1),
            Motion::Right => (from + 1).min(chars),
            Motion::Start => 0,
            Motion::End => chars,
        };

        // Against the *stored* index, not against `from`: End on a caret already past the
        // end has `next == from` while the stored value is still out of range, and
        // returning early there would leave it there.
        //
        // And the anchor is part of "changed": a plain arrow on a collapsed caret at the end
        // of the text moves nothing, but a plain arrow after a Shift selection has to drag
        // the anchor back onto the focus even when the focus itself stays put.
        let anchor_moves = !extend && self.anchor.get(node).copied() != Some(next as i32);
        if next == index && !anchor_moves {
            return false;
        }
        self.index[node] = next as i32;
        if !extend {
            self.anchor[node] = next as i32;
        }
        true
    }

    /// Shifts the caret by an edit that inserted `inserted` characters, `delta` net.
    ///
    /// Typing moves the caret past what was inserted; a backspace moves it back over what
    /// was removed. The engine does this arithmetic itself rather than waiting to be told,
    /// because the alternative is a round trip to Bun before the caret catches up — and a
    /// caret that lags the text it is in is the one thing a text field cannot do.
    ///
    /// # An edit over a live selection lands somewhere `delta` cannot express
    ///
    /// Measured: typing `X` over `2..6` gives `abXghij` with the caret at **3** — the start
    /// of what was replaced, plus what was inserted. That is not `focus + delta` from either
    /// end, so the range case is separate arithmetic rather than a smaller `delta`. Backspace
    /// and Delete over a range both land at the range's start, which is the same rule with
    /// `inserted` = 0.
    ///
    /// Either way the caret ends up **collapsed**, because the characters the selection
    /// covered no longer exist.
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
    pub fn shift(&mut self, node: usize, delta: i32, inserted: usize) {
        let Some(from) = self.index_of(node) else {
            return;
        };
        let next = match self.range_of(node) {
            Some((start, _)) => (start + inserted) as i64,
            None => (from as i64 + delta as i64).max(0),
        };
        self.index[node] = next as i32;
        self.anchor[node] = next as i32;
        self.visible = true;
        self.elapsed = 0.0;
    }
}

/// What a double click treats as one unit.
///
/// Three classes, and the measurement is what says three: `probes/selection-editing.html`
/// shows `bb  ` selected as a word plus its whole run of trailing spaces, `  ` selected alone
/// when the pointer is in it, and the *second* comma of `,,` selected by itself — so a run of
/// punctuation is not a unit while a run of letters and a run of spaces both are.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Class {
    Word,
    Space,
    Punct,
}

/// Which class a character belongs to.
///
/// `is_alphanumeric` rather than `is_alphabetic`, and `_` folded in with it: only letters were
/// measured, so this is the editor convention rather than a finding. It is the same rule ICU's
/// word segmentation uses for the cases that matter here, and the alternative — digits as
/// punctuation — would make a double click in `2026` select one digit.
fn class_of(c: char) -> Class {
    if c.is_whitespace() {
        Class::Space
    } else if c.is_alphanumeric() || c == '_' {
        Class::Word
    } else {
        Class::Punct
    }
}

/// The range a double click at `boundary` selects: one segment, plus trailing whitespace.
///
/// Measured against Chromium 151 over four fixtures, thirteen rows, recorded in
/// BROWSER-FACTS.md. The rule:
///
/// 1. Take the segment containing the character **at** `boundary` — not the character under
///    the pointer. This is the part that is easy to get wrong and was: a pointer in the right
///    half of the hyphen in `quick-brown` rounds up to the boundary where `brown` starts, and
///    the browser selects `brown ` rather than the hyphen it is hovering. Implementing it from
///    the pointer instead would pick the wrong segment for every click past a character's
///    midpoint.
/// 2. At the end of the text nothing starts, so take the segment ending there — which is what
///    makes a double click past the end select the last word.
/// 3. A run of word characters is one segment and a run of whitespace is one segment, but a
///    single punctuation character is its own: `,,` is two.
/// 4. Unless the segment is whitespace, extend over the whole whitespace run that follows it.
///    `"the "` includes its space; `"quick"` does not include the hyphen after it, because a
///    hyphen is not whitespace.
///
/// `boundary` comes from [`boundary_at`], so a double click and a single click agree about
/// where the pointer is — which is the reason rule 1 works out.
pub fn word_at(boundary: usize, chars: &[char]) -> (usize, usize) {
    if chars.is_empty() {
        return (0, 0);
    }
    let at = boundary.min(chars.len());
    // Rule 2: at the very end there is no character *at* the boundary, so look behind it.
    let pivot = if at < chars.len() { at } else { at - 1 };
    let class = class_of(chars[pivot]);

    let (start, mut end) = if class == Class::Punct {
        // Rule 3: one character, not the run.
        (pivot, pivot + 1)
    } else {
        let mut s = pivot;
        while s > 0 && class_of(chars[s - 1]) == class {
            s -= 1;
        }
        let mut e = pivot + 1;
        while e < chars.len() && class_of(chars[e]) == class {
            e += 1;
        }
        (s, e)
    };

    // Rule 4.
    if class != Class::Space {
        while end < chars.len() && class_of(chars[end]) == Class::Space {
            end += 1;
        }
    }

    (start, end)
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

        // And `a` is its own scalar, which is what makes Ctrl+A matchable at all. SDL reports
        // the *lower-case* keycode whether or not Shift or Ctrl is held, so matching 0x41
        // would never fire.
        assert_eq!(Keycode::A.to_ll().0 as i32, 0x61);

        // The clipboard trio, same rule.
        assert_eq!(Keycode::C.to_ll().0 as i32, 0x63);
        assert_eq!(Keycode::V.to_ll().0 as i32, 0x76);
        assert_eq!(Keycode::X.to_ll().0 as i32, 0x78);
    }

    /// So are the modifier bits `engine.rs` masks with.
    ///
    /// Same argument as the keycodes above, and a sharper one: `window.rs` flattens SDL's
    /// `Mod` to a `u16`, so by the time the engine sees it there is nothing left to call
    /// `.intersects()` on and the numbers are written out by hand. A wrong bit gives a Shift
    /// that never extends — a feature that silently does nothing rather than an error.
    #[test]
    fn the_modifier_bits_are_the_ones_sdl_sends() {
        use sdl3::keyboard::Mod;

        // Both sides of each pair: a user may hold either, and masking only the left one is
        // a bug nobody testing with their usual hand would find.
        assert_eq!(
            Mod::LSHIFTMOD.bits() | Mod::RSHIFTMOD.bits(),
            0x0001 | 0x0002
        );
        assert_eq!(Mod::LCTRLMOD.bits() | Mod::RCTRLMOD.bits(), 0x0040 | 0x0080);

        // The GUI pair is ⌘ on macOS — the command modifier there, where Ctrl is
        // everywhere else. Asserted here rather than written from memory for the same
        // reason as the pairs above: a wrong bit is a ⌘C that silently types nothing.
        assert_eq!(Mod::LGUIMOD.bits() | Mod::RGUIMOD.bits(), 0x0400 | 0x0800);
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

        assert!(carets.move_to(1, Motion::Left, 10, false));
        assert_eq!(carets.index_of(1), Some(4));
        assert!(carets.move_to(1, Motion::Right, 10, false));
        assert_eq!(carets.index_of(1), Some(5));

        assert!(carets.move_to(1, Motion::Start, 10, false));
        assert_eq!(carets.index_of(1), Some(0));
        assert!(carets.move_to(1, Motion::End, 10, false));
        assert_eq!(carets.index_of(1), Some(10));

        // Measured: ArrowRight at the length and ArrowLeft at 0 both leave the caret put.
        // `false` is "did not move" and the key is still consumed — the caller must not
        // forward it, or the host acts on a key the engine already claimed.
        assert!(
            !carets.move_to(1, Motion::Right, 10, false),
            "no move at the end"
        );
        assert_eq!(carets.index_of(1), Some(10));
        carets.move_to(1, Motion::Start, 10, false);
        assert!(!carets.move_to(1, Motion::Left, 10, false), "no move at 0");
        assert_eq!(carets.index_of(1), Some(0));

        // A node with no caret is not something to move.
        assert!(!carets.move_to(0, Motion::Right, 10, false));
    }

    #[test]
    fn an_edit_carries_the_caret_with_it() {
        let mut carets = Carets::new();
        carets.resize(2);
        carets.place(1, 3);

        // Typing two characters at 3 leaves the caret after them.
        carets.shift(1, 2, 0);
        assert_eq!(carets.index_of(1), Some(5));

        // A backspace takes it back over what was removed.
        carets.shift(1, -1, 0);
        assert_eq!(carets.index_of(1), Some(4));

        // Clamped at 0, so a host that accepted fewer deletions than the engine assumed
        // cannot walk the caret to a negative index.
        carets.shift(1, -99, 0);
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
        carets.shift(1, 1, 0);
        assert_eq!(carets.index_of(1), Some(1));
        carets.shift(1, 1, 0);
        assert_eq!(
            carets.index_of(1),
            Some(2),
            "the second keystroke of a burst must not be clamped to the pre-burst length"
        );

        // And the first arrow key heals an index that ran past the text — which is the only
        // case the removed clamp was actually guarding.
        assert!(carets.move_to(1, Motion::Left, 1, false));
        assert_eq!(
            carets.index_of(1),
            Some(0),
            "clamped to 1, then stepped left"
        );
        carets.shift(1, 9, 0);
        assert!(carets.move_to(1, Motion::End, 4, false));
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

    // -----------------------------------------------------------------------------------
    // Selection
    // -----------------------------------------------------------------------------------

    /// The Shift+Arrow table from `probes/caret-and-selection.html`, row for row.
    ///
    /// The measured sequence from a collapsed caret at 5 is `5..6`, `5..7`, `5..6`, `5..5`,
    /// then **`4..5 backward`** — the anchor stays at 5 through the reversal. That last row is
    /// the whole reason the pair is `(anchor, focus)`: an implementation storing `(start, end)`
    /// has no way to know which end Shift+ArrowLeft should move once they have crossed, and
    /// would give `4..4` or `4..6`.
    #[test]
    fn shift_extension_keeps_the_anchor_through_a_reversal() {
        let mut carets = Carets::new();
        carets.resize(2);
        carets.place(1, 5);
        assert_eq!(carets.range_of(1), None, "a fresh caret is collapsed");

        let step = |c: &mut Carets, to: Motion| {
            c.move_to(1, to, 10, true);
            c.range_of(1)
        };

        assert_eq!(step(&mut carets, Motion::Right), Some((5, 6)));
        assert_eq!(step(&mut carets, Motion::Right), Some((5, 7)));
        assert_eq!(step(&mut carets, Motion::Left), Some((5, 6)), "shrinks");
        assert_eq!(
            step(&mut carets, Motion::Left),
            None,
            "back to 5, collapsed"
        );
        assert_eq!(
            step(&mut carets, Motion::Left),
            Some((4, 5)),
            "through the anchor"
        );
        // Backward: the focus is the *low* end now, which is what a plain arrow reads.
        assert_eq!(carets.index_of(1), Some(4));

        assert_eq!(step(&mut carets, Motion::Start), Some((0, 5)), "Shift+Home");
        assert_eq!(
            step(&mut carets, Motion::End),
            Some((5, 10)),
            "Shift+End, still at 5"
        );

        // A plain arrow collapses it, and the anchor has to come with the focus or the next
        // Shift+Arrow would extend from a stale 5.
        carets.move_to(1, Motion::Left, 10, false);
        assert_eq!(carets.range_of(1), None);
        assert_eq!(
            carets.index_of(1),
            Some(5),
            "collapsed to the low end of 5..10"
        );
    }

    /// A plain arrow with a range live collapses to the *matching* end and stops there.
    ///
    /// Measured: with `2..6` selected, ArrowLeft gives `2..2` and ArrowRight gives `6..6` —
    /// no further step. Mutation check: collapsing and then stepping gives 1 and 7.
    #[test]
    fn an_arrow_collapses_a_selection_to_the_end_it_points_at() {
        let mut carets = Carets::new();
        carets.resize(2);

        carets.select(1, 2, 6);
        assert!(carets.move_to(1, Motion::Left, 10, false));
        assert_eq!(
            carets.index_of(1),
            Some(2),
            "the low end, and no step past it"
        );
        assert_eq!(carets.range_of(1), None);

        carets.select(1, 2, 6);
        assert!(carets.move_to(1, Motion::Right, 10, false));
        assert_eq!(carets.index_of(1), Some(6), "the high end");

        // Backward selections collapse the same way — by document order, not by which end
        // the user dragged from.
        carets.select(1, 6, 2);
        carets.move_to(1, Motion::Right, 10, false);
        assert_eq!(carets.index_of(1), Some(6));

        // Home and End are absolute, so there is nothing to collapse *to*: they go where they
        // always go regardless of the selection.
        carets.select(1, 2, 6);
        carets.move_to(1, Motion::Start, 10, false);
        assert_eq!(carets.index_of(1), Some(0));
        carets.select(1, 2, 6);
        carets.move_to(1, Motion::End, 10, false);
        assert_eq!(carets.index_of(1), Some(10));
    }

    /// A drag keeps the anchor the press put down, in both directions.
    #[test]
    fn a_drag_extends_from_the_press_and_keeps_its_direction() {
        let mut carets = Carets::new();
        carets.resize(2);

        // Forward: press at 2, drag to 6.
        carets.place(1, 2);
        assert!(carets.extend(1, 6));
        assert_eq!(carets.range_of(1), Some((2, 6)));
        assert_eq!(
            carets.index_of(1),
            Some(6),
            "the focus is the end being dragged"
        );

        // Backward: press at 8, drag back to 3. The measured answer is `3..8`, ordered, with
        // the direction carried separately — which is what `range_of` and `index_of` are.
        carets.place(1, 8);
        assert!(carets.extend(1, 3));
        assert_eq!(carets.range_of(1), Some((3, 8)));
        assert_eq!(
            carets.index_of(1),
            Some(3),
            "dragged backwards, focus at the low end"
        );

        // A drag that does not cross a boundary changes nothing and says so, so a frame is
        // not repainted for a pointer that moved two pixels.
        assert!(!carets.extend(1, 3));

        // And a node with no caret has no anchor to extend from. Inventing one at 0 would
        // select from the start of the field on a stray drag.
        assert!(!carets.extend(0, 4));
        assert_eq!(carets.range_of(0), None);
    }

    /// An edit over a range collapses to the start plus what was inserted.
    ///
    /// Measured: `X` over `2..6` leaves the caret at **3**, which is neither end plus one —
    /// so this cannot be expressed as a `delta` and is separate arithmetic. Backspace and
    /// Delete over a range both land at the start, the same rule with `inserted` = 0.
    #[test]
    fn an_edit_over_a_selection_lands_at_the_start_plus_what_was_inserted() {
        let mut carets = Carets::new();
        carets.resize(2);

        carets.select(1, 2, 6);
        carets.shift(1, 1, 1);
        assert_eq!(carets.index_of(1), Some(3), "typed one character over 2..6");
        assert_eq!(
            carets.range_of(1),
            None,
            "and the range is gone with the characters"
        );

        // Backspace over a range: the start, *not* one before it. Mutation check: reusing the
        // collapsed path here would give 1.
        carets.select(1, 2, 6);
        carets.shift(1, -1, 0);
        assert_eq!(carets.index_of(1), Some(2));

        // Delete over a range: the same place. The direction stops mattering once there is a
        // range, which is measured and is why the two keys share this call.
        carets.select(1, 2, 6);
        carets.shift(1, 0, 0);
        assert_eq!(carets.index_of(1), Some(2));

        // A backward range edits identically — the arithmetic is on document order.
        carets.select(1, 6, 2);
        carets.shift(1, 1, 1);
        assert_eq!(carets.index_of(1), Some(3));

        // And a collapsed caret still takes the `delta` path.
        carets.place(1, 4);
        carets.shift(1, -1, 0);
        assert_eq!(carets.index_of(1), Some(3));
    }

    /// The word-boundary table, every row from `probes/selection-editing.html`.
    ///
    /// Four fixtures, thirteen rows, one rule. The rows are grouped by fixture rather than by
    /// what they prove, so a reader can check them against the probe's own output.
    #[test]
    fn a_double_click_selects_a_segment_plus_its_trailing_whitespace() {
        let word = |text: &str, boundary: usize| {
            let chars: Vec<char> = text.chars().collect();
            let (s, e) = word_at(boundary, &chars);
            (s, e, text.chars().skip(s).take(e - s).collect::<String>())
        };

        //  0123456789012345678
        // "the quick-brown fox"
        let f = "the quick-brown fox";
        assert_eq!(word(f, 1), (0, 4, "the ".into()), "trailing space included");
        assert_eq!(word(f, 6), (4, 9, "quick".into()), "the hyphen is not");
        assert_eq!(
            word(f, 10),
            (10, 16, "brown ".into()),
            "the boundary, not the pointer"
        );
        assert_eq!(word(f, 12), (10, 16, "brown ".into()));
        assert_eq!(
            word(f, 4),
            (4, 9, "quick".into()),
            "a boundary between two segments"
        );
        assert_eq!(
            word(f, 17),
            (16, 19, "fox".into()),
            "nothing follows, nothing appended"
        );
        assert_eq!(
            word(f, 19),
            (16, 19, "fox".into()),
            "at the very end, look behind"
        );

        //  0123456789
        // "a,, bb  cc"
        let h = "a,, bb  cc";
        assert_eq!(word(h, 2), (2, 4, ", ".into()), "one comma, not the run");
        assert_eq!(
            word(h, 5),
            (4, 8, "bb  ".into()),
            "the whole run of two spaces"
        );
        assert_eq!(word(h, 7), (6, 8, "  ".into()), "whitespace selects alone");

        //  0123456789012
        // "a-b c,d e - f"
        let i = "a-b c,d e - f";
        assert_eq!(
            word(i, 1),
            (1, 2, "-".into()),
            "punctuation between letters"
        );
        assert_eq!(word(i, 5), (5, 6, ",".into()));
        assert_eq!(word(i, 10), (10, 12, "- ".into()), "and its trailing space");

        // An empty run has no word in it, and must not index out of bounds.
        assert_eq!(word_at(0, &[]), (0, 0));

        // Digits and underscores are word characters. Not measured — only letters were — but
        // the alternative makes a double click in `2026` select one digit.
        assert_eq!(word("x 2026_ y", 4), (2, 8, "2026_ ".into()));
    }
}
