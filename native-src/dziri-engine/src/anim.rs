//! Transitions and keyframe animations: the clock, the tween state, and the curve.
//!
//! Everything that moves per frame is here, and everything that *decides* what moves
//! was decided at build time. The compiler resolved both endpoints of every
//! transition into interned style rows and both endpoints of every keyframe segment
//! the same way; what is left is a `t`, an easing evaluation, and a read that
//! interpolates two rows of a table already in shared memory.
//!
//! So the per-frame trace of an animating page is: one `advance` over a handful of
//! live tweens, and a lerp inside the reads paint was doing anyway. No allocation, no
//! style object, and nothing at all in Bun — the host's whole contribution is the
//! `engine.tick()` it was calling regardless.
//!
//! `dt` is a **parameter** everywhere in here rather than read from a clock, exactly
//! as `advance_scrolls` is and for the same reason: a frame has to be reproducible at
//! an exact `t` for a golden to be able to screenshot one.

use crate::protocol;
use crate::tables::Tables;

const STYLES: usize = protocol::Table::Styles as usize;
const NODES: usize = protocol::Table::Nodes as usize;
const VARIANTS: usize = protocol::Table::Variants as usize;
const VARIANT_SLOTS: usize = protocol::Table::VariantSlots as usize;
const TWEENS: usize = protocol::Table::Tweens as usize;
const KEYFRAMES: usize = protocol::Table::Keyframes as usize;

/// "This node has never been looked at", distinct from any real style row.
///
/// Load-bearing on the first frame after a commit: a node whose last target is
/// unknown records the target and starts **nothing**. Treating unknown as a real
/// previous row would animate every transition-carrying node from row 0 the moment
/// the page appeared.
const UNKNOWN: u16 = u16::MAX;

/// A single step of a step function, below which nothing is worth a repaint.
///
/// Same idea as `SCROLL_SNAP_PX`: an easing curve approaches its endpoint and a
/// transition 0.001 of the way from done is a repaint for a difference nothing can
/// display. Unlike the scroll glide this is not needed for termination — `t` is
/// clamped and arrives exactly — it only stops the last frame being spent twice.
const T_EPSILON: f32 = 1.0e-4;

// ---------------------------------------------------------------------------
// The curve
// ---------------------------------------------------------------------------

/// An easing curve: elapsed fraction in, progress out, both nominally 0..1.
///
/// Flat rather than an enum with payloads because it is read straight out of five
/// table columns, and the match is on one `u8`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Curve {
    pub kind: u8,
    pub a: f32,
    pub b: f32,
    pub c: f32,
    pub d: f32,
}

impl Curve {
    pub const LINEAR: Self = Self {
        kind: protocol::easing::LINEAR,
        a: 0.0,
        b: 0.0,
        c: 0.0,
        d: 0.0,
    };

    /// Progress at elapsed fraction `x`.
    ///
    /// Not clamped to 0..1 on the way *out*, deliberately: a `cubic-bezier` whose `y`
    /// control points fall outside the unit square legitimately overshoots, which is
    /// how an anticipation or a bounce curve is written. CSS only bounds the `x`
    /// coordinates, and the parser is where that is enforced.
    pub fn at(&self, x: f32) -> f32 {
        let x = x.clamp(0.0, 1.0);
        match self.kind {
            protocol::easing::CUBIC_BEZIER => bezier_at(self.a, self.b, self.c, self.d, x),
            protocol::easing::STEPS => steps_at(self.a, self.b, x),
            // `LINEAR`, and anything a stale table might hold. Falling through to the
            // identity means a nonsense curve animates plainly rather than freezing.
            _ => x,
        }
    }
}

/// `y` on the cubic bezier `(0,0) (a,b) (c,d) (1,1)` at the point where `x(s) = x`.
///
/// Two stages, because a CSS easing bezier is a function of *time* and the parameter
/// is not time. Solve `x(s) = x` for `s`, then evaluate `y(s)`.
///
/// Newton–Raphson first, because it converges in two or three iterations over almost
/// the whole domain, with bisection as the fallback — Newton stalls where `x'(s)` is
/// near zero, which is exactly what a control point at `x = 0` or `x = 1` produces,
/// and `ease-in`'s `(0.42, 0, 1, 1)` has one. Without the fallback the standard
/// keywords are the cases that fail.
///
/// The measured progress table in BROWSER-FACTS.md is what this is checked against;
/// `ease-in-out` reading exactly 0.5 at the midpoint is the cheap half of that.
fn bezier_at(x1: f32, y1: f32, x2: f32, y2: f32, x: f32) -> f32 {
    // Polynomial coefficients of the Bernstein form, so each evaluation is Horner
    // rather than four `powi` calls.
    let cx = 3.0 * x1;
    let bx = 3.0 * (x2 - x1) - cx;
    let ax = 1.0 - cx - bx;
    let cy = 3.0 * y1;
    let by = 3.0 * (y2 - y1) - cy;
    let ay = 1.0 - cy - by;

    let sample_x = |s: f32| ((ax * s + bx) * s + cx) * s;
    let sample_y = |s: f32| ((ay * s + by) * s + cy) * s;
    let slope_x = |s: f32| (3.0 * ax * s + 2.0 * bx) * s + cx;

    // The identity curve solves exactly, and `linear` reaches here whenever an author
    // spells it `cubic-bezier(0, 0, 1, 1)`.
    if x <= 0.0 || x >= 1.0 {
        return x;
    }

    let mut s = x;
    for _ in 0..8 {
        let err = sample_x(s) - x;
        if err.abs() < 1.0e-6 {
            return sample_y(s);
        }
        let slope = slope_x(s);
        if slope.abs() < 1.0e-6 {
            break;
        }
        s -= err / slope;
    }

    // Bisection, which cannot stall: `x(s)` is monotonic on 0..1 for any curve CSS
    // admits, because both control-point `x` values are in that range.
    let (mut lo, mut hi) = (0.0f32, 1.0f32);
    let mut s = x.clamp(lo, hi);
    for _ in 0..32 {
        let at = sample_x(s);
        if (at - x).abs() < 1.0e-6 {
            break;
        }
        if at < x {
            lo = s;
        } else {
            hi = s;
        }
        s = (lo + hi) * 0.5;
    }
    sample_y(s)
}

/// A step function's progress at `x`.
///
/// The `+ 1` for `jump-start` is measured rather than reasoned: `steps(4, start)`
/// reads **0.5** at x=0.25, not 0.25, so the step is `floor(x·n) + 1` and not
/// `ceil(x·n)` — the two differ exactly on the boundaries, which is where a step
/// function spends its time. `steps(4, end)` reads 0 at x=0.1 and 0.75 at x=0.9,
/// which is the pair that tells the two apart. See BROWSER-FACTS.md.
fn steps_at(count: f32, position: f32, x: f32) -> f32 {
    let n = count.max(1.0);
    let pos = position as u8;

    // How many distinct output values there are, which is not always the step count:
    // `jump-both` adds one because it emits both 0 and 1, and `jump-none` drops one
    // because it emits neither end.
    let jumps = match pos {
        protocol::step_position::JUMP_BOTH => n + 1.0,
        protocol::step_position::JUMP_NONE => (n - 1.0).max(1.0),
        _ => n,
    };

    let mut step = (x * n).floor();
    if pos == protocol::step_position::JUMP_START || pos == protocol::step_position::JUMP_BOTH {
        step += 1.0;
    }
    (step / jumps).clamp(0.0, 1.0)
}

// ---------------------------------------------------------------------------
// Reading an interpolated style
// ---------------------------------------------------------------------------

/// Which two interned style rows a node is between, and how far along.
///
/// This is what replaced a bare `slot: usize` at every style read in `paint.rs`, and
/// the reason it could is that those reads were already funnelled through two or
/// three closures per function. A node that is not animating is `solid`, whose `t` is
/// 1 and whose mask is empty, so every accessor degenerates to the single read it
/// used to be.
///
/// The alternative — a scratch style row per animating node, written each frame —
/// was rejected for two reasons. Interned rows are **shared**, so there is no row to
/// write into and the scratch pool would be an allocator on the frame path. And the
/// styles table is the staged/live pair `commit` memcmps: an engine write into it
/// would either be undone by the next commit or report a diff every frame and relay
/// out the document forever.
#[derive(Clone, Copy, Debug)]
pub struct Blend {
    /// The row being left. Equal to `to` when nothing is moving.
    pub from: usize,
    /// The row being approached, and what every field **outside** `mask` reads.
    pub to: usize,
    /// Progress, already eased. 0 is `from` exactly, 1 is `to` exactly.
    pub t: f32,
    /// Animatable-field bits that may move; see the generated `styles::ANIM_BIT`.
    pub mask: u32,
}

impl Blend {
    /// A node wearing one row outright, which is almost every node on every frame.
    pub fn solid(slot: usize) -> Self {
        Self {
            from: slot,
            to: slot,
            t: 1.0,
            mask: 0,
        }
    }

    /// Whether `field` is one this blend moves. `false` is the fast path.
    fn moves(&self, field: usize) -> bool {
        if self.mask == 0 || self.t >= 1.0 || self.from == self.to {
            return false;
        }
        match protocol::styles::ANIM_BIT.get(field) {
            Some(&bit) if bit != 255 => self.mask & (1u32 << bit) != 0,
            _ => false,
        }
    }

    /// An `f32` field, interpolated when this blend moves it.
    pub fn f32(&self, tables: &Tables, field: usize, dflt: f32) -> f32 {
        self.f32_at(tables.f32s(STYLES, field), field, dflt)
    }

    /// The same, from a column the caller already resolved.
    ///
    /// `Tables::f32s` is not a field access — it resolves a span plan through two
    /// dependent loads, matches the arena, bounds-checks a byte range and casts it —
    /// so a caller reading many fields off one node should pay that once per column
    /// per frame rather than once per field per node. `paint` does exactly that for
    /// the node table already; this is what lets it do the same for the style table.
    pub fn f32_at(&self, column: &[f32], field: usize, dflt: f32) -> f32 {
        let to = column.get(self.to).copied().unwrap_or(dflt);
        if !self.moves(field) {
            return to;
        }
        let from = column.get(self.from).copied().unwrap_or(dflt);
        // A non-finite endpoint is a sentinel — `auto`, `none`, unset — and has no
        // midpoint. CSS interpolates such a pair discretely, and lerping would
        // produce `NaN` for the whole run rather than for one endpoint.
        if !from.is_finite() || !to.is_finite() {
            return if self.t < 0.5 { from } else { to };
        }
        from + (to - from) * self.t
    }

    /// A packed `0xAARRGGBB` colour, interpolated **premultiplied**.
    pub fn u32(&self, tables: &Tables, field: usize) -> u32 {
        let column = tables.u32s(STYLES, field);
        let to = column.get(self.to).copied().unwrap_or(0);
        if !self.moves(field) {
            return to;
        }
        let from = column.get(self.from).copied().unwrap_or(0);
        mix(from, to, self.t)
    }

    /// A `u8` field. Always the destination: every one of them is an enum.
    ///
    /// CSS calls these discrete and mostly says they are not animatable at all, and
    /// the schema agrees — none carries an `interp`, so none has a mask bit and no
    /// mask can ask for one. Taking `to` outright rather than flipping at the
    /// halfway point is the difference that matters here: `display` reaching `none`
    /// halfway through a fade would take the element out of paint before it had
    /// finished fading.
    pub fn u8(&self, tables: &Tables, field: usize, dflt: u8) -> u8 {
        tables
            .u8s(STYLES, field)
            .get(self.to)
            .copied()
            .unwrap_or(dflt)
    }

    /// A `u16` field. Discrete, as `u8` is — `fontWeight` is layout-affecting.
    pub fn u16(&self, tables: &Tables, field: usize, dflt: u16) -> u16 {
        tables
            .u16s(STYLES, field)
            .get(self.to)
            .copied()
            .unwrap_or(dflt)
    }
}

/// Two packed colours mixed at `t`, per channel in sRGB, premultiplied by alpha.
///
/// Premultiplied is measured, not chosen: opaque red to transparent blue reads
/// `rgba(255, 0, 0, 0.5)` halfway in Chromium, where a plain per-channel lerp gives
/// `rgba(128, 0, 128, 0.5)`. The difference is the whole visible behaviour of a fade
/// out — premultiplied keeps the colour and loses the alpha, per-channel drifts
/// through a colour that is in neither endpoint.
///
/// sRGB rather than linear-light or oklab, also measured: black to white reads
/// `rgb(128,128,128)` at the midpoint and `rgb(64,64,64)` at a quarter, which is a
/// plain lerp of the gamma-encoded bytes. `color-mix()` is the contrast — it *does*
/// use oklab, and its midpoint is a visibly lighter grey.
fn mix(from: u32, to: u32, t: f32) -> u32 {
    let t = t.clamp(0.0, 1.0);
    let alpha_of = |c: u32| ((c >> 24) & 0xff) as f32 / 255.0;
    let chan = |c: u32, shift: u32| ((c >> shift) & 0xff) as f32;

    let (fa, ta) = (alpha_of(from), alpha_of(to));
    let alpha = fa + (ta - fa) * t;
    if alpha <= 0.0 {
        // Fully transparent: every channel is multiplied by zero, so there is no
        // colour to recover and dividing by the alpha to try would be a `NaN`.
        return 0;
    }

    let mut out = ((alpha * 255.0).round() as u32).min(255) << 24;
    for shift in [16, 8, 0] {
        // Into premultiplied space, lerp, and back out. `round` rather than truncate,
        // or a channel drifts one value low across the whole run.
        let f = chan(from, shift) * fa;
        let s = chan(to, shift) * ta;
        let mixed = (f + (s - f) * t) / alpha;
        out |= ((mixed.round().clamp(0.0, 255.0)) as u32) << shift;
    }
    out
}

// ---------------------------------------------------------------------------
// The live tweens
// ---------------------------------------------------------------------------

/// One tween in flight.
///
/// Real tween state — a from, a to, and how far — rather than the exponential
/// approach `advance_scrolls` uses, and the divergence is deliberate. A wheel
/// retargets mid-flight and an exponential has no start, which is what makes it the
/// right shape there. A CSS transition is a fixed-duration traversal, and CSS has
/// explicit rules for interrupting one that only a tween can express.
///
/// Nothing here is per-frame allocated: the vector changes when a *predicate*
/// changes, not when a frame passes.
#[derive(Clone, Copy, Debug)]
struct Live {
    node: u32,
    /// The interned row being left. For an animation this is unused — the endpoints
    /// come from the keyframe list — and holds the base row for diagnostics.
    from: u16,
    /// The row being approached. For a transition this is always the node's currently
    /// resolved slot, kept in step by `retarget`.
    to: u16,
    /// Row in the `tweens` table: the mask, the timing and the curve.
    spec: u16,
    /// Whether the endpoints are keyframe rows rather than `from`/`to`.
    keyframed: bool,
    /// Seconds still to wait before moving, from `transition-delay`.
    wait: f32,
    /// Unbased progress, 0..1. A transition traverses it; an animation ignores it.
    t: f32,
    /// `1.0` heading to `to`, `-1.0` rewinding to `from`. Always `1.0` for an
    /// animation.
    dir: f32,
    /// Seconds since the animation started, delay included. Unused by a transition.
    elapsed: f32,
}

/// Every tween on the page, plus what it takes to notice one should start.
pub struct Anims {
    /// At most one per node. A node carrying both a transition and an animation runs
    /// the animation — see `retarget`.
    live: Vec<Live>,
    /// Per node, the style row it last resolved to. `UNKNOWN` before the first look.
    ///
    /// This is the whole detection mechanism, and it is why a transition costs nothing
    /// to declare: a transition can only start when a node's resolved slot *changes*,
    /// and comparing one `u16` per watched node per frame is the entire test.
    last: Vec<u16>,
    /// Nodes that could ever animate, rebuilt when the tables change.
    ///
    /// Not every node, because the retarget pass runs every frame. A page of 900
    /// nodes with transitions on its dozen buttons walks a dozen entries.
    watched: Vec<u32>,
    /// Whether any tween is still in flight, so an idle frame stays free.
    running: bool,
}

impl Default for Anims {
    fn default() -> Self {
        Self::new()
    }
}

impl Anims {
    pub fn new() -> Self {
        Self {
            live: Vec::new(),
            last: Vec::new(),
            watched: Vec::new(),
            running: false,
        }
    }

    pub fn running(&self) -> bool {
        self.running || !self.live.is_empty()
    }

    /// Rebuilds the watch list from the tables. Called when a commit changed them.
    ///
    /// Once per commit rather than once per frame, and over the *style* rows a node
    /// could wear rather than over the node's current one — a node whose transition
    /// only exists in its `:hover` variant still has to be watched while it is not
    /// hovered, or the hover would never be noticed.
    ///
    /// Live tweens are dropped, because the rows they name may not mean what they did.
    /// A commit that repointed a node at a different style is exactly the case where
    /// continuing to interpolate towards a remembered row would be interpolating
    /// towards someone else's colour.
    pub fn rescan(&mut self, tables: &Tables, node_count: usize) {
        self.live.clear();
        self.running = false;
        self.watched.clear();
        self.last.clear();
        self.last.resize(node_count, UNKNOWN);

        let styles = nodes_style(tables);
        let ids = tables.i32s(VARIANTS, protocol::variants::NODE);

        for (node, &base) in styles.iter().enumerate().take(node_count) {
            if self.node_animates(tables, ids, node, base) {
                self.watched.push(node as u32);
            }
        }
    }

    /// Whether any style row this node could wear carries a tween.
    fn node_animates(&self, tables: &Tables, ids: &[i32], node: usize, base: u16) -> bool {
        if has_tween(tables, base as usize) {
            return true;
        }

        let Ok(row) = ids.binary_search(&(node as i32)) else {
            return false;
        };
        let mask = tables.u32s(VARIANTS, protocol::variants::MASK)[row];
        let start = tables.i32s(VARIANTS, protocol::variants::RUN_START)[row];
        if start < 0 {
            return false;
        }

        let slots = tables.u16s(VARIANT_SLOTS, protocol::variant_slots::STYLE);
        let len = 1usize << mask.count_ones().min(16);
        slots
            .iter()
            .skip(start as usize)
            .take(len)
            .any(|&slot| has_tween(tables, slot as usize))
    }

    /// What `node` should be painted as, given the row it currently resolves to.
    ///
    /// The resolved row is passed in rather than looked up, because the caller has
    /// just computed it — `style_for` is a binary search and paint asks several times
    /// per node.
    pub fn blend(&self, tables: &Tables, node: usize, slot: usize) -> Blend {
        let Some(tw) = self.live.iter().find(|t| t.node as usize == node) else {
            return Blend::solid(slot);
        };

        let spec = Spec::read(tables, tw.spec as usize);
        if tw.keyframed {
            return self.keyframe_blend(tables, tw, &spec, slot);
        }

        // Before the delay has run out the node still wears the row it came from, and
        // `dir` decides which that is: a reversal's `from` is where it is going.
        if tw.wait > 0.0 {
            let held = if tw.dir < 0.0 { tw.to } else { tw.from };
            return Blend::solid(held as usize);
        }

        Blend {
            from: tw.from as usize,
            to: tw.to as usize,
            t: spec.curve.at(tw.t),
            mask: spec.mask,
        }
    }

    /// Where an animation is: which two keyframe rows, and how far between them.
    fn keyframe_blend(&self, tables: &Tables, tw: &Live, spec: &Spec, slot: usize) -> Blend {
        let phase = (tw.elapsed - spec.delay) / spec.duration;
        // Before the delay, and after the last iteration, the element wears its own
        // style — which is `animation-fill-mode: none`, CSS's default and the only one
        // dziri implements. The compiler warns about the others by name.
        if phase < 0.0 || phase >= spec.iterations {
            return Blend::solid(slot);
        }

        // `fract` on the iteration count, so `infinite` and `3` are the same code path
        // and an animation that has just crossed into a new iteration restarts at 0.
        let local = phase.fract();
        let offsets = tables.f32s(KEYFRAMES, protocol::keyframes::OFFSET);
        let rows = tables.u16s(KEYFRAMES, protocol::keyframes::STYLE);

        let first = spec.first_segment;
        let count = spec.segment_count;
        if first < 0 || count < 2 {
            return Blend::solid(slot);
        }
        let first = first as usize;

        // Linear from the front rather than a binary search: a keyframe list is two to
        // five rows, and `bounce` — the longest thing Tailwind ships — is three.
        let mut i = 0usize;
        while i + 2 < count {
            let next = offsets.get(first + i + 1).copied().unwrap_or(1.0);
            if local < next {
                break;
            }
            i += 1;
        }

        let (lo, hi) = (first + i, first + i + 1);
        let (o0, o1) = (
            offsets.get(lo).copied().unwrap_or(0.0),
            offsets.get(hi).copied().unwrap_or(1.0),
        );
        let span = o1 - o0;
        // Two keyframes at the same offset are a jump, not a division by zero. CSS
        // allows it and uses it to hold a value across a boundary.
        let seg_t = if span > 0.0 { (local - o0) / span } else { 1.0 };

        // The segment's own curve, or the animation's when the keyframe named none.
        // Measured: a keyframe's `animation-timing-function` governs the segment
        // *leaving* it, so the curve comes from `lo` and the last row's is never read.
        let curve = segment_curve(tables, lo).unwrap_or(spec.curve);

        Blend {
            from: rows.get(lo).copied().unwrap_or(0) as usize,
            to: rows.get(hi).copied().unwrap_or(0) as usize,
            t: curve.at(seg_t.clamp(0.0, 1.0)),
            mask: spec.mask,
        }
    }

    /// Notices slot changes and moves every live tween `dt` seconds forward.
    ///
    /// Returns whether anything moved, which is what decides a repaint — the same
    /// two-answers-not-one split `advance_scrolls` documents. `running` says whether
    /// to keep ticking; the return value says whether this frame is stale.
    ///
    /// `resolve` is how a node's current style row is found. Passed in because the
    /// answer lives in the painter's predicate machinery and this module has no
    /// business knowing about hover.
    pub fn advance(
        &mut self,
        tables: &Tables,
        dt: f32,
        mut resolve: impl FnMut(usize) -> usize,
    ) -> bool {
        // A pathological `dt` — a debugger pause, a first frame, a suspended window —
        // must not skip a whole animation or produce a `NaN`. One second is already
        // "arrive now" for any transition anybody writes.
        let dt = if dt.is_finite() {
            dt.clamp(0.0, 1.0)
        } else {
            1.0
        };

        let hidden = tables.u8s(NODES, protocol::nodes::HIDDEN);
        let mut changed = false;

        // Retarget first, so a slot that changed this frame is already moving by the
        // time the advance below runs. Doing it after would cost every transition one
        // frame of standing still, which reads as lag on a hover.
        for index in 0..self.watched.len() {
            let node = self.watched[index] as usize;
            if hidden.get(node).copied().unwrap_or(0) != 0 {
                continue;
            }
            let slot = resolve(node);
            let previous = self.last.get(node).copied().unwrap_or(UNKNOWN);
            if previous == slot as u16 {
                // The slot is unchanged, but an animation is still a reason to be here:
                // it runs on the clock rather than on a predicate.
                continue;
            }
            self.last[node] = slot as u16;
            if self.retarget(tables, node, previous, slot) {
                changed = true;
            }
        }

        let mut moving = false;
        let mut i = 0;
        while i < self.live.len() {
            let (alive, moved) = advance_one(&mut self.live[i], tables, dt);
            changed |= moved;
            if alive {
                moving = true;
                i += 1;
            } else {
                // Swap-removed: order carries no meaning, there is at most one tween
                // per node, and the alternative is an O(n) shift on the frame path.
                self.live.swap_remove(i);
            }
        }

        self.running = moving;
        changed
    }

    /// Starts, redirects or cancels the tween for a node whose slot just changed.
    ///
    /// Returns whether the frame is now stale. The three interesting arms are the
    /// measured ones — see BROWSER-FACTS.md, "How a transition is interrupted".
    fn retarget(&mut self, tables: &Tables, node: usize, previous: u16, slot: usize) -> bool {
        let target = slot as u16;
        let existing = self.live.iter().position(|t| t.node as usize == node);

        // An animation is not a response to a slot change: it keeps its clock across
        // one. What it *does* need is the new row's spec, because the compiler resolved
        // this animation's keyframes against whichever style combination is live — a
        // hovered spinner's keyframes are built from its hover row.
        let animation = tween_ref(tables, slot, protocol::styles::ANIMATION);
        if let Some(spec) = animation {
            match existing {
                Some(i) if self.live[i].keyframed => {
                    self.live[i].spec = spec;
                    self.live[i].to = target;
                    return true;
                }
                Some(i) => {
                    self.live.swap_remove(i);
                }
                None => {}
            }
            self.live.push(Live {
                node: node as u32,
                from: target,
                to: target,
                spec,
                keyframed: true,
                wait: 0.0,
                t: 0.0,
                dir: 1.0,
                elapsed: 0.0,
            });
            return true;
        }

        // The transition's spec comes from the row being moved **to**, which is what
        // CSS says: transition properties are read from the after-change style. So
        // hovering out is governed by the base rule's `transition`, not the hover
        // rule's — and a node whose target row declares none simply jumps.
        let Some(spec_row) = tween_ref(tables, slot, protocol::styles::TRANSITION) else {
            if let Some(i) = existing {
                self.live.swap_remove(i);
            }
            return true;
        };
        let spec = Spec::read(tables, spec_row as usize);
        if spec.duration <= 0.0 || spec.mask == 0 {
            if let Some(i) = existing {
                self.live.swap_remove(i);
            }
            return true;
        }

        match existing {
            // Already heading there. Nothing to do, and *not* a restart: a second
            // mouse-move inside a hovered button must not reset the clock.
            Some(i) if self.live[i].to == target && self.live[i].dir > 0.0 => false,

            // A reversal: the target is the row this tween came from, so it is the
            // *same pair* traversed backwards from wherever `t` has got to. Measured —
            // interrupted at t=0.4, the way back takes 400 ms rather than 1000, and it
            // starts from the value already reached. Both fall out of flipping `dir`,
            // with no row holding an interpolated value and nothing allocated.
            Some(i) if self.live[i].from == target => {
                self.live[i].dir = -1.0;
                self.live[i].spec = spec_row;
                // A delay applies to the way back too, and it has to be re-armed:
                // `wait` was consumed on the way out.
                self.live[i].wait = spec.delay;
                true
            }

            // A third row, which is the one case dziri cannot express exactly: the
            // value it is leaving is an interpolation, and there is no interned row
            // holding it. Starting afresh from the row it was heading to is right
            // whenever the previous tween had settled — which is the common shape,
            // hover then press — and gives the full duration CSS also gives. A
            // retarget caught genuinely mid-flight jumps by the residual. See API.md.
            Some(i) => {
                let tw = &mut self.live[i];
                tw.from = tw.to;
                tw.to = target;
                tw.spec = spec_row;
                tw.keyframed = false;
                tw.t = 0.0;
                tw.dir = 1.0;
                tw.wait = spec.delay;
                true
            }

            // Nothing in flight. The row left behind is the one recorded last frame,
            // and `UNKNOWN` means there was no last frame — a page that has just been
            // uploaded must appear, not fade in from row zero.
            None => {
                if previous == UNKNOWN {
                    return false;
                }
                self.live.push(Live {
                    node: node as u32,
                    from: previous,
                    to: target,
                    spec: spec_row,
                    keyframed: false,
                    wait: spec.delay,
                    t: 0.0,
                    dir: 1.0,
                    elapsed: 0.0,
                });
                true
            }
        }
    }
}

/// Moves one tween forward. Returns `(still alive, moved this frame)`.
fn advance_one(tw: &mut Live, tables: &Tables, dt: f32) -> (bool, bool) {
    let spec = Spec::read(tables, tw.spec as usize);

    if tw.keyframed {
        tw.elapsed += dt;
        let phase = (tw.elapsed - spec.delay) / spec.duration;
        // Finished, and with no fill mode the element goes back to its own style — so
        // the last frame of an animation is a change like any other.
        if spec.duration <= 0.0 || phase >= spec.iterations {
            return (false, true);
        }
        // Moving whenever it is past its delay. An animation inside its delay is alive
        // but shows nothing new, which is the one case where "alive" and "moved" come
        // apart in the same direction a scroll glide's last frame does.
        return (true, phase >= 0.0);
    }

    if spec.duration <= 0.0 {
        return (false, true);
    }

    if tw.wait > 0.0 {
        tw.wait -= dt;
        // The overshoot is carried into `t` rather than dropped, or a delay shorter
        // than a frame would cost a whole frame and a 16 ms delay would behave like 32.
        if tw.wait > 0.0 {
            return (true, false);
        }
        let spill = -tw.wait;
        tw.wait = 0.0;
        tw.t += tw.dir * spill / spec.duration;
    } else {
        tw.t += tw.dir * dt / spec.duration;
    }

    if tw.t >= 1.0 - T_EPSILON {
        tw.t = 1.0;
        // Arrived. Dropping the tween rather than keeping it settled is what makes a
        // later reversal start from `t = 0` on the flipped pair and so take the full
        // duration — which is what CSS gives a transition that was not interrupted.
        return (false, true);
    }
    if tw.t <= T_EPSILON {
        tw.t = 0.0;
        return (false, true);
    }
    (true, true)
}

/// One row of the `tweens` table, read once per use rather than per field.
struct Spec {
    mask: u32,
    duration: f32,
    delay: f32,
    iterations: f32,
    first_segment: i32,
    segment_count: usize,
    curve: Curve,
}

impl Spec {
    fn read(tables: &Tables, row: usize) -> Self {
        use protocol::tweens as f;
        let f32_at =
            |field: usize, dflt: f32| tables.f32s(TWEENS, field).get(row).copied().unwrap_or(dflt);
        Self {
            mask: tables.u32s(TWEENS, f::MASK).get(row).copied().unwrap_or(0),
            duration: f32_at(f::DURATION, 0.0),
            delay: f32_at(f::DELAY, 0.0),
            iterations: f32_at(f::ITERATIONS, 1.0),
            first_segment: tables
                .i32s(TWEENS, f::FIRST_SEGMENT)
                .get(row)
                .copied()
                .unwrap_or(-1),
            segment_count: tables
                .u16s(TWEENS, f::SEGMENT_COUNT)
                .get(row)
                .copied()
                .unwrap_or(0) as usize,
            curve: Curve {
                kind: tables
                    .u8s(TWEENS, f::EASING)
                    .get(row)
                    .copied()
                    .unwrap_or(protocol::easing::LINEAR),
                a: f32_at(f::EASE_A, 0.0),
                b: f32_at(f::EASE_B, 0.0),
                c: f32_at(f::EASE_C, 0.0),
                d: f32_at(f::EASE_D, 0.0),
            },
        }
    }
}

/// A keyframe's own curve, or `None` when it deferred to the animation's.
fn segment_curve(tables: &Tables, row: usize) -> Option<Curve> {
    use protocol::keyframes as f;
    let kind = tables.u8s(KEYFRAMES, f::EASING).get(row).copied()?;
    if kind == protocol::easing::INHERIT {
        return None;
    }
    let at = |field: usize| {
        tables
            .f32s(KEYFRAMES, field)
            .get(row)
            .copied()
            .unwrap_or(0.0)
    };
    Some(Curve {
        kind,
        a: at(f::EASE_A),
        b: at(f::EASE_B),
        c: at(f::EASE_C),
        d: at(f::EASE_D),
    })
}

fn nodes_style(tables: &Tables) -> &[u16] {
    tables.u16s(NODES, protocol::nodes::STYLE)
}

/// The tween row a style field points at, or `None` for "no tween here".
///
/// The `- 1` is the whole reason the field is stored as index-plus-one: a style table
/// starts out zeroed, and row 0 is a perfectly good tween.
fn tween_ref(tables: &Tables, slot: usize, field: usize) -> Option<u16> {
    let raw = tables.u16s(STYLES, field).get(slot).copied().unwrap_or(0);
    if raw == 0 {
        None
    } else {
        Some(raw - 1)
    }
}

fn has_tween(tables: &Tables, slot: usize) -> bool {
    tween_ref(tables, slot, protocol::styles::TRANSITION).is_some()
        || tween_ref(tables, slot, protocol::styles::ANIMATION).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The measured progress table from BROWSER-FACTS.md, which is what a curve
    /// implementation is *for*. Four decimal places is what the probe reported, and
    /// this asserts to 0.001 — enough to catch a wrong control point or a Newton
    /// iteration that stalled, which is the failure this exists to find.
    #[test]
    fn the_keyword_curves_reproduce_the_measured_table() {
        let ease = Curve {
            kind: protocol::easing::CUBIC_BEZIER,
            a: 0.25,
            b: 0.1,
            c: 0.25,
            d: 1.0,
        };
        let ease_in = Curve {
            kind: protocol::easing::CUBIC_BEZIER,
            a: 0.42,
            b: 0.0,
            c: 1.0,
            d: 1.0,
        };
        let ease_out = Curve {
            kind: protocol::easing::CUBIC_BEZIER,
            a: 0.0,
            b: 0.0,
            c: 0.58,
            d: 1.0,
        };
        let ease_in_out = Curve {
            kind: protocol::easing::CUBIC_BEZIER,
            a: 0.42,
            b: 0.0,
            c: 0.58,
            d: 1.0,
        };
        let tw = Curve {
            kind: protocol::easing::CUBIC_BEZIER,
            a: 0.4,
            b: 0.0,
            c: 0.2,
            d: 1.0,
        };

        let cases: &[(&str, Curve, [f32; 5])] = &[
            ("linear", Curve::LINEAR, [0.1, 0.25, 0.5, 0.75, 0.9]),
            ("ease", ease, [0.0948, 0.4085, 0.8024, 0.9605, 0.9943]),
            ("ease-in", ease_in, [0.0170, 0.0935, 0.3154, 0.6219, 0.8394]),
            (
                "ease-out",
                ease_out,
                [0.1606, 0.3781, 0.6846, 0.9065, 0.9830],
            ),
            (
                "ease-in-out",
                ease_in_out,
                [0.0197, 0.1292, 0.5000, 0.8708, 0.9803],
            ),
            (
                "cubic-bezier(0.4,0,0.2,1)",
                tw,
                [0.0259, 0.2366, 0.7756, 0.9594, 0.9944],
            ),
        ];

        for (name, curve, expected) in cases {
            for (x, want) in [0.1f32, 0.25, 0.5, 0.75, 0.9].iter().zip(expected) {
                let got = curve.at(*x);
                assert!(
                    (got - want).abs() < 0.001,
                    "{name} at t={x}: got {got}, Chromium measured {want}"
                );
            }
        }
    }

    /// `ease-out` is `ease-in` mirrored and `ease-in-out` is exactly 0.5 at the
    /// midpoint — the two identities BROWSER-FACTS.md names as the cheap check.
    #[test]
    fn the_curves_hold_their_own_identities() {
        let ease_in = Curve {
            kind: protocol::easing::CUBIC_BEZIER,
            a: 0.42,
            b: 0.0,
            c: 1.0,
            d: 1.0,
        };
        let ease_out = Curve {
            kind: protocol::easing::CUBIC_BEZIER,
            a: 0.0,
            b: 0.0,
            c: 0.58,
            d: 1.0,
        };
        let ease_in_out = Curve {
            kind: protocol::easing::CUBIC_BEZIER,
            a: 0.42,
            b: 0.0,
            c: 0.58,
            d: 1.0,
        };

        assert!((ease_out.at(0.1) - (1.0 - ease_in.at(0.9))).abs() < 0.001);
        assert!((ease_in_out.at(0.5) - 0.5).abs() < 0.0005);
        // Both ends are exact for every curve, which Newton alone does not guarantee.
        for c in [ease_in, ease_out, ease_in_out] {
            assert_eq!(c.at(0.0), 0.0);
            assert_eq!(c.at(1.0), 1.0);
        }
    }

    /// The measured step tables. `steps(4, start)` reading 0.5 at t=0.25 is what
    /// separates `floor(x·n) + 1` from `ceil(x·n)`, and the two agree everywhere else.
    #[test]
    fn the_step_functions_reproduce_the_measured_table() {
        let end = Curve {
            kind: protocol::easing::STEPS,
            a: 4.0,
            b: 0.0,
            c: 0.0,
            d: 0.0,
        };
        let start = Curve {
            kind: protocol::easing::STEPS,
            a: 4.0,
            b: 1.0,
            c: 0.0,
            d: 0.0,
        };

        let xs = [0.1f32, 0.25, 0.5, 0.75, 0.9];
        for (x, want) in xs.iter().zip([0.0, 0.25, 0.5, 0.75, 0.75]) {
            assert!((end.at(*x) - want).abs() < 1.0e-6, "steps(4, end) at {x}");
        }
        for (x, want) in xs.iter().zip([0.25, 0.5, 0.75, 1.0, 1.0]) {
            assert!(
                (start.at(*x) - want).abs() < 1.0e-6,
                "steps(4, start) at {x}"
            );
        }
    }

    /// A one-step curve is what `step-start` and `step-end` normalise to, and the
    /// distinction is the whole behaviour: `step-end` holds the start value until the
    /// very end, which is what makes it useful inside a keyframe.
    #[test]
    fn one_step_holds_a_segment_at_one_end() {
        let end = Curve {
            kind: protocol::easing::STEPS,
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 0.0,
        };
        let start = Curve {
            kind: protocol::easing::STEPS,
            a: 1.0,
            b: 1.0,
            c: 0.0,
            d: 0.0,
        };
        for x in [0.0f32, 0.25, 0.49, 0.5, 0.99] {
            assert_eq!(end.at(x), 0.0, "step-end at {x}");
            assert_eq!(start.at(x), 1.0, "step-start at {x}");
        }
        assert_eq!(end.at(1.0), 1.0);
    }

    /// Colours mix per channel in sRGB, **premultiplied** — the row a naive
    /// implementation fails. Chromium's numbers, from `probes/animation-semantics.html`.
    #[test]
    fn colours_mix_premultiplied_in_srgb() {
        let black = 0xff00_0000u32;
        let white = 0xffff_ffffu32;
        assert_eq!(mix(black, white, 0.5), 0xff80_8080, "midpoint grey is 128");
        assert_eq!(mix(black, white, 0.25), 0xff40_4040, "a quarter is 64");
        assert_eq!(
            mix(black, white, 0.75),
            0xffbf_bfbf,
            "three quarters is 191"
        );

        let red = 0xffff_0000u32;
        let blue = 0xff00_00ffu32;
        assert_eq!(mix(red, blue, 0.5), 0xff80_0080, "sRGB, not oklab");

        // The measured case: opaque red to *transparent* blue stays red.
        let clear_blue = 0x0000_00ffu32;
        let half = mix(red, clear_blue, 0.5);
        assert_eq!(half >> 24, 128, "alpha is the plain lerp");
        assert_eq!(
            half & 0x00ff_ffff,
            0x00ff_0000,
            "premultiplied keeps the colour; a per-channel lerp would give 0x800080"
        );

        // Fully transparent has no colour to recover, and must not be a NaN.
        assert_eq!(mix(0x0000_0000, 0x0000_00ff, 0.5), 0);
    }

    /// A blend with an empty mask is the single read it replaced, which is what makes
    /// this free for the nodes that never animate.
    #[test]
    fn a_solid_blend_moves_nothing() {
        let b = Blend::solid(3);
        assert_eq!(b.from, 3);
        assert_eq!(b.to, 3);
        assert!(!b.moves(protocol::styles::OPACITY));
        // Even with a mask, an arrived tween reads the destination outright.
        let arrived = Blend {
            from: 1,
            to: 2,
            t: 1.0,
            mask: u32::MAX,
        };
        assert!(!arrived.moves(protocol::styles::OPACITY));
    }

    /// Every animatable field has a mask bit and no other field does — the invariant
    /// the generator enforces, asserted from the side that reads it.
    #[test]
    fn only_animatable_fields_carry_a_mask_bit() {
        use protocol::styles as f;
        assert_ne!(f::ANIM_BIT[f::OPACITY], 255);
        assert_ne!(f::ANIM_BIT[f::BG], 255);
        assert_ne!(f::ANIM_BIT[f::ROTATE], 255);
        // Layout-affecting, so not animatable: only paint reads a blend.
        assert_eq!(f::ANIM_BIT[f::WIDTH], 255);
        assert_eq!(f::ANIM_BIT[f::PAD_TOP], 255);
        assert_eq!(f::ANIM_BIT[f::FONT_SIZE], 255);
        // Discrete, and the two tween references themselves — a transition must not
        // be able to transition its own duration, which `transition-property: all`
        // would otherwise ask for.
        assert_eq!(f::ANIM_BIT[f::DISPLAY], 255);
        assert_eq!(f::ANIM_BIT[f::TRANSITION], 255);
        assert_eq!(f::ANIM_BIT[f::ANIMATION], 255);

        for (field, &bit) in f::ANIM_BIT.iter().enumerate() {
            if bit == 255 {
                assert_eq!(
                    f::INTERP[field],
                    protocol::interp::NONE,
                    "{}",
                    f::FIELD_NAMES[field]
                );
            } else {
                assert_ne!(
                    f::INTERP[field],
                    protocol::interp::NONE,
                    "{}",
                    f::FIELD_NAMES[field]
                );
                assert_eq!(f::ANIM_FIELDS[bit as usize], field);
            }
        }
    }
}
