//! SVG, as a renderer and not a DOM.
//!
//! # Why a subset, and why it is honest
//!
//! skia-safe's `svg` feature is Skia's whole SVG DOM — and there is no prebuilt
//! binary for the `textlayout+svg` feature pair, so enabling it means building
//! Skia from source: ninja, depot_tools, an hour of compile, for everyone, to
//! render an icon. That trade was tried and reverted (see Cargo.toml). What
//! remains is what SVG actually is to a UI toolkit: paths, shapes, groups,
//! transforms and paint. That subset — `<path>`, `<rect>`, `<circle>`,
//! `<ellipse>`, `<line>`, `<polyline>`, `<polygon>`, `<g>`/`<svg>` with
//! `transform`, and the `fill` / `stroke` / `stroke-width` / `*opacity`
//! presentation attributes — covers the overwhelming majority of real-world
//! inline SVG (icon fonts, illustrations, charts-as-paths), and what it refuses
//! it refuses *visibly*: unsupported elements simply do not draw, like an image
//! that failed to load, rather than misrendering.
//!
//! `currentColor` resolves at paint time from the node's `color`, which is what
//! makes an icon tint with its button — the one piece of CSS SVG genuinely
//! participates in.
//!
//! # Sizing
//!
//! The intrinsic size is the `width`/`height` attribute pair, else the
//! `viewBox`'s. With neither there is no answer and the caller falls back to
//! CSS's replaced-element default (300x150, applied by the layout side).
//! Painting is `preserveAspectRatio="xMidYMid meet"` — the spec default — scaled
//! into the content box, because that is what a browser does with both an
//! inline `<svg>` and an `<img>` of one, and "the icon fills its box, stretched"
//! reads as a bug even when the box is the wrong shape.

use skia_safe::{Canvas, Color, Matrix, Paint, PaintStyle, Path, PathDirection, Point, Rect};

/// A colour as SVG says it: a concrete value, or the text colour of wherever
/// the icon sits.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Ink {
    Rgba(u32),
    CurrentColor,
}

/// One drawing operation: a path, what to fill and stroke it with, and the
/// transform its ancestors accumulated.
///
/// Flat rather than a tree: groups exist only to inherit paint and transforms
/// through, so both are resolved during the parse and nothing tree-shaped
/// survives — which is also what makes drawing a simple forward pass.
///
/// The `f32` beside each paint is its *alpha factor*: `fill-opacity` and
/// `stroke-opacity` multiply the colour's own alpha, and carrying the factor
/// rather than folding it in is what keeps `currentColor` working — the colour
/// is not known until paint, so nothing can be folded at parse time.
struct Draw {
    path: Path,
    fill: Option<(Ink, f32)>,
    stroke: Option<(Ink, f32, f32)>,
    opacity: f32,
    transform: Matrix,
}

/// The inherited painting context, per the SVG cascade: presentation attributes
/// inherit, so a `fill` on `<g>` reaches its paths unless they say otherwise.
#[derive(Clone, Copy)]
struct Ctx {
    fill: Option<(Ink, f32)>,
    stroke: Option<(Ink, f32, f32)>,
    opacity: f32,
    transform: Matrix,
}

/// A parsed SVG: its viewport and its drawing list.
pub struct Svg {
    /// The `viewBox`, or the box the width/height attributes imply.
    view_box: [f32; 4],
    draws: Vec<Draw>,
}

/// The fallback viewport for a document with no size at all: 300 wide, which
/// with the 2:1 of the CSS replaced-element default (300x150) keeps the two
/// agreeing by construction.
const DEFAULT_VIEWBOX: f32 = 300.0;

impl Svg {
    /// Parses `text` as SVG. `None` for something that is not SVG at all — no
    /// root element, or a root that is not `<svg>` — so the image pipeline can
    /// fall back to raster decode without the two sniffing each other's input.
    ///
    /// An `<svg>` with no drawable content is still SVG: it parses, and paints
    /// nothing, which is what it would do in a browser.
    pub fn parse(text: &str) -> Option<Svg> {
        let doc = roxmltree::Document::parse(text).ok()?;
        let root = doc.root_element();
        if !root.is_element() || !root.tag_name().name().eq_ignore_ascii_case("svg") {
            return None;
        }

        let width = root.attribute("width").and_then(parse_length);
        let height = root.attribute("height").and_then(parse_length);
        // A document with no size anywhere still parses: the viewport is the
        // CSS replaced-element default, so the box and the coordinate space
        // agree with what a browser would draw. (An svg whose content is all
        // percentage lengths still draws nothing — those resolve against a
        // viewport only a browser's layout can see, which `parse_length`
        // refuses.)
        let view_box = root
            .attribute("viewBox")
            .or_else(|| root.attribute("viewbox"))
            .and_then(parse_view_box)
            .or_else(|| match (width, height) {
                (Some(w), Some(h)) => Some([0.0, 0.0, w, h]),
                _ => None,
            })
            .unwrap_or([0.0, 0.0, DEFAULT_VIEWBOX, DEFAULT_VIEWBOX * 0.5]);

        let mut draws = Vec::new();
        let ctx = Ctx {
            // SVG's initial values: black fill, no stroke, full opacity.
            fill: Some((Ink::Rgba(0xff000000), 1.0)),
            stroke: None,
            opacity: 1.0,
            transform: Matrix::default(),
        };
        walk(&root, ctx, &mut draws);
        Some(Svg { view_box, draws })
    }

    /// The intrinsic size: explicit `width`/`height` first, then the viewBox's
    /// dimensions. `None` when the document says nothing, and the caller
    /// substitutes the replaced-element default.
    pub fn intrinsic_size(&self) -> Option<(f32, f32)> {
        let [.., w, h] = self.view_box;
        if w > 0.0 && h > 0.0 {
            Some((w, h))
        } else {
            None
        }
    }

    /// Draws into `rect`, meet-fitted and centred — `xMidYMid meet`, the spec
    /// default, rather than a stretch.
    ///
    /// `color` is the node's text colour, for `currentColor`. This is the one
    /// inheritance that crosses the boundary: an icon in a button takes the
    /// button's `color`, which is how every icon system on the web works.
    pub fn render(&self, canvas: &Canvas, rect: Rect, color: u32) {
        let [vx, vy, vw, vh] = self.view_box;
        if vw <= 0.0 || vh <= 0.0 || rect.width() <= 0.0 || rect.height() <= 0.0 {
            return;
        }

        let scale = (rect.width() / vw).min(rect.height() / vh);
        let dx = rect.left + (rect.width() - vw * scale) / 2.0 - vx * scale;
        let dy = rect.top + (rect.height() - vh * scale) / 2.0 - vy * scale;

        canvas.save();
        canvas.translate((dx, dy));
        canvas.scale((scale, scale));

        let mut paint = Paint::default();
        paint.set_anti_alias(true);
        for draw in &self.draws {
            let alpha = |c: u32, factor: f32| -> u32 {
                let a = (((c >> 24) & 0xff) as f32 * factor * draw.opacity).round() as u32;
                ((a & 0xff) << 24) | (c & 0x00ff_ffff)
            };
            canvas.save();
            canvas.concat(&draw.transform);
            if let Some((fill, fa)) = draw.fill {
                paint.set_style(PaintStyle::Fill);
                paint.set_color(Color::from(alpha(resolve(fill, color), fa)));
                canvas.draw_path(&draw.path, &paint);
            }
            if let Some((stroke, width, sa)) = draw.stroke {
                paint.set_style(PaintStyle::Stroke);
                paint.set_stroke_width(width);
                paint.set_color(Color::from(alpha(resolve(stroke, color), sa)));
                canvas.draw_path(&draw.path, &paint);
            }
            canvas.restore();
        }
        canvas.restore();
    }
}

fn resolve(paint: Ink, color: u32) -> u32 {
    match paint {
        Ink::Rgba(c) => c,
        Ink::CurrentColor => color,
    }
}

/// The parse walk: inherits the painting context down the tree and appends a
/// `Draw` per shape. Unknown elements are walked *through* rather than skipped
/// — a `<g>`-shaped unknown (a `<defs>` nobody referenced) may still wrap real
/// shapes, and skipping the subtree would lose them.
fn walk(el: &roxmltree::Node, ctx: Ctx, out: &mut Vec<Draw>) {
    let mut inner = ctx;
    if let Some(fill) = el.attribute("fill").and_then(parse_paint) {
        inner.fill = fill.map(|p| (p, fill_alpha_of(inner.fill)));
    }
    if let Some(stroke) = el.attribute("stroke").and_then(parse_paint) {
        inner.stroke = stroke.map(|p| (p, stroke_width_of(el), stroke_alpha_of(inner.stroke)));
    }
    if let Some(width) = el.attribute("stroke-width").and_then(parse_length) {
        inner.stroke = inner.stroke.map(|(p, _, a)| (p, width, a));
    }
    if let Some(o) = el.attribute("opacity").and_then(parse_number) {
        inner.opacity *= o;
    }
    // fill-opacity / stroke-opacity multiply their own paint's alpha factor;
    // the fold happens at draw time, when currentColor has a colour to land on.
    if let Some(o) = el.attribute("fill-opacity").and_then(parse_number) {
        inner.fill = inner.fill.map(|(p, a)| (p, a * o.clamp(0.0, 1.0)));
    }
    if let Some(o) = el.attribute("stroke-opacity").and_then(parse_number) {
        inner.stroke = inner.stroke.map(|(p, w, a)| (p, w, a * o.clamp(0.0, 1.0)));
    }
    if let Some(t) = el.attribute("transform").and_then(parse_transform) {
        inner.transform = Matrix::concat(&ctx.transform, &t);
    }

    let path = match el.tag_name().name() {
        "path" => el.attribute("d").and_then(parse_path),
        "rect" => rect_path(el),
        "circle" => circle_path(el, false),
        "ellipse" => circle_path(el, true),
        "line" => line_path(el),
        "polyline" => poly_path(el, false),
        "polygon" => poly_path(el, true),
        _ => None,
    };
    if let Some(path) = path {
        out.push(Draw {
            path,
            fill: inner.fill,
            stroke: inner.stroke,
            opacity: inner.opacity,
            transform: inner.transform,
        });
    }

    for child in el.children().filter(|c| c.is_element()) {
        walk(&child, inner, out);
    }
}

fn stroke_width_of(el: &roxmltree::Node) -> f32 {
    el.attribute("stroke-width")
        .and_then(parse_length)
        .unwrap_or(1.0)
}

/// A new `fill` keeps the inherited *factor*: `fill-opacity` on an ancestor
/// still applies to a child's own colour, because the two are separate
/// properties in SVG's cascade and opacity is not reset by a fill.
fn fill_alpha_of(inherited: Option<(Ink, f32)>) -> f32 {
    inherited.map(|(_, a)| a).unwrap_or(1.0)
}

fn stroke_alpha_of(inherited: Option<(Ink, f32, f32)>) -> f32 {
    inherited.map(|(_, _, a)| a).unwrap_or(1.0)
}

// ---------------------------------------------------------------------------
// Attribute grammars
// ---------------------------------------------------------------------------

/// A plain length: a number, optionally suffixed `px`. Percentages are refused
/// — they resolve against the viewport, which is a paint-time value here.
fn parse_length(text: &str) -> Option<f32> {
    let t = text.trim().strip_suffix("px").unwrap_or(text.trim());
    let v: f32 = t.parse().ok()?;
    if v.is_finite() {
        Some(v)
    } else {
        None
    }
}

fn parse_number(text: &str) -> Option<f32> {
    let v: f32 = text.trim().parse().ok()?;
    if v.is_finite() {
        Some(v)
    } else {
        None
    }
}

/// `x y w h`, any run of comma/space between.
fn parse_view_box(text: &str) -> Option<[f32; 4]> {
    let parts: Vec<f32> = text
        .split([',', ' ', '\t'])
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect();
    match parts.as_slice() {
        [x, y, w, h] if *w > 0.0 && *h > 0.0 => Some([*x, *y, *w, *h]),
        _ => None,
    }
}

/// `fill` / `stroke`: `none`, a colour, or `currentColor`. The double Option is
/// the difference between "not written" (None — inherit) and "none" (Some(None)
/// — do not paint).
fn parse_paint(text: &str) -> Option<Option<Ink>> {
    let t = text.trim();
    if t.eq_ignore_ascii_case("none") {
        return Some(None);
    }
    if t.eq_ignore_ascii_case("currentcolor") {
        return Some(Some(Ink::CurrentColor));
    }
    parse_color(t).map(|c| Some(Ink::Rgba(c)))
}

/// Packed 0xAARRGGBB, the convention every style field in the protocol uses.
fn parse_color(text: &str) -> Option<u32> {
    let t = text.trim();
    if let Some(hex) = t.strip_prefix('#') {
        let v = u32::from_str_radix(hex, 16).ok()?;
        return match hex.len() {
            3 => {
                let r = (v >> 8) & 0xf;
                let g = (v >> 4) & 0xf;
                let b = v & 0xf;
                Some(0xff000000 | (r * 0x11) << 16 | (g * 0x11) << 8 | (b * 0x11))
            }
            6 => Some(0xff000000 | v),
            8 => {
                // #RRGGBBAA, per css-color-4, onto the AARRGGBB the protocol packs.
                let rgb = v >> 8;
                let a = v & 0xff;
                Some(a << 24 | rgb)
            }
            _ => None,
        };
    }
    if let Some(args) = t.strip_prefix("rgb(").and_then(|s| s.strip_suffix(')')) {
        let parts: Vec<f32> = args
            .split([',', ' '])
            .filter(|s| !s.is_empty())
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        if let [r, g, b] = parts.as_slice() {
            let c = |v: f32| (v.clamp(0.0, 255.0) as u32) & 0xff;
            return Some(0xff000000 | c(*r) << 16 | c(*g) << 8 | c(*b));
        }
        return None;
    }
    // The handful of keywords an icon actually uses; the full CSS named-colour
    // table belongs to the CSS parser, not to here.
    Some(match t.to_ascii_lowercase().as_str() {
        "black" => 0xff000000,
        "white" => 0xffffffff,
        "red" => 0xffff0000,
        "green" => 0xff008000,
        "blue" => 0xff0000ff,
        "yellow" => 0xffffff00,
        "gray" | "grey" => 0xff808080,
        "transparent" => 0x00000000,
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

fn num_attr(el: &roxmltree::Node, name: &str) -> Option<f32> {
    el.attribute(name).and_then(parse_length)
}

fn rect_path(el: &roxmltree::Node) -> Option<Path> {
    let x = num_attr(el, "x").unwrap_or(0.0);
    let y = num_attr(el, "y").unwrap_or(0.0);
    let w = num_attr(el, "width")?;
    let h = num_attr(el, "height")?;
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    let rx = num_attr(el, "rx")
        .or_else(|| num_attr(el, "ry"))
        .unwrap_or(0.0);
    let rect = Rect::from_xywh(x, y, w, h);
    if rx > 0.0 {
        let rrect = skia_safe::RRect::new_rect_xy(rect, rx.min(w / 2.0), rx.min(h / 2.0));
        Some(Path::rrect(&rrect, PathDirection::CW))
    } else {
        Some(Path::rect(&rect, PathDirection::CW))
    }
}

fn circle_path(el: &roxmltree::Node, ellipse: bool) -> Option<Path> {
    let cx = num_attr(el, "cx").unwrap_or(0.0);
    let cy = num_attr(el, "cy").unwrap_or(0.0);
    let (rx, ry) = if ellipse {
        (num_attr(el, "rx")?, num_attr(el, "ry")?)
    } else {
        let r = num_attr(el, "r")?;
        (r, r)
    };
    if rx <= 0.0 || ry <= 0.0 {
        return None;
    }
    Some(Path::oval(
        &Rect::from_xywh(cx - rx, cy - ry, rx * 2.0, ry * 2.0),
        PathDirection::CW,
    ))
}

fn line_path(el: &roxmltree::Node) -> Option<Path> {
    let mut p = Path::new();
    p.move_to(Point::new(
        num_attr(el, "x1").unwrap_or(0.0),
        num_attr(el, "y1").unwrap_or(0.0),
    ));
    p.line_to(Point::new(
        num_attr(el, "x2").unwrap_or(0.0),
        num_attr(el, "y2").unwrap_or(0.0),
    ));
    Some(p)
}

fn poly_path(el: &roxmltree::Node, close: bool) -> Option<Path> {
    let numbers: Vec<f32> = el
        .attribute("points")?
        .split([',', ' ', '\t'])
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse().ok())
        .collect();
    if numbers.len() < 4 {
        return None;
    }
    let mut p = Path::new();
    p.move_to(Point::new(numbers[0], numbers[1]));
    for pair in numbers[1..].chunks_exact(2) {
        p.line_to(Point::new(pair[0], pair[1]));
    }
    if close {
        p.close();
    }
    Some(p)
}

// ---------------------------------------------------------------------------
// transform="…"
// ---------------------------------------------------------------------------

fn parse_transform(text: &str) -> Option<Matrix> {
    let mut matrix = Matrix::default();
    let mut rest = text.trim();
    let mut any = false;
    while let Some(open) = rest.find('(') {
        let name = rest[..open].trim();
        let close = rest[open..].find(')')?;
        let args: Vec<f32> = rest[open + 1..open + close]
            .split([',', ' ', '\t'])
            .filter(|s| !s.is_empty())
            .filter_map(|s| s.parse().ok())
            .collect();
        let m = match (name, args.as_slice()) {
            ("matrix", [a, b, c, d, e, f]) => {
                Matrix::new_all(*a, *c, *e, *b, *d, *f, 0.0, 0.0, 1.0)
            }
            ("translate", [x, y, ..]) => Matrix::translate((*x, *y)),
            ("translate", [x]) => Matrix::translate((*x, 0.0)),
            ("scale", [x, y, ..]) => Matrix::scale((*x, *y)),
            ("scale", [x]) => Matrix::scale((*x, *x)),
            ("rotate", [deg, cx, cy, ..]) => {
                let pivot = Matrix::translate((*cx, *cy));
                let back = Matrix::translate((-*cx, -*cy));
                Matrix::concat(&pivot, &Matrix::concat(&Matrix::rotate_deg(*deg), &back))
            }
            ("rotate", [deg]) => Matrix::rotate_deg(*deg),
            ("skewX", [deg]) => Matrix::skew((deg.to_radians().tan(), 0.0)),
            ("skewY", [deg]) => Matrix::skew((0.0, deg.to_radians().tan())),
            _ => return None,
        };
        // Transforms apply left to right: each post-multiplies the running one.
        matrix = Matrix::concat(&matrix, &m);
        any = true;
        rest = rest[open + close + 1..].trim();
    }
    if any {
        Some(matrix)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// path d="…" — the full command set, arcs included
// ---------------------------------------------------------------------------

struct PathParser<'a> {
    bytes: &'a [u8],
    pos: usize,
    path: Path,
    /// The pen, and where the current subpath started (for `Z`).
    cur: Point,
    start: Point,
    /// The previous curve's control point, for the smooth commands.
    ctrl: Option<Point>,
    prev_cmd: u8,
}

pub fn parse_path(d: &str) -> Option<Path> {
    let mut p = PathParser {
        bytes: d.as_bytes(),
        pos: 0,
        path: Path::new(),
        cur: Point::new(0.0, 0.0),
        start: Point::new(0.0, 0.0),
        ctrl: None,
        prev_cmd: 0,
    };
    p.run();
    // An empty path is a legitimate parse of an empty `d`; a path that never
    // moved is not an error either — it draws nothing, which is what it says.
    Some(p.path)
}

impl<'a> PathParser<'a> {
    fn run(&mut self) {
        let mut cmd: u8 = 0;
        loop {
            self.skip_sep();
            if self.pos >= self.bytes.len() {
                return;
            }
            let b = self.bytes[self.pos];
            if b.is_ascii_alphabetic() {
                cmd = b;
                self.pos += 1;
            } else if cmd == 0 {
                return; // data before any command: not a path
            }
            // Per the spec, implicit repetition after M is L (and m is l).
            let c = match (cmd, b.is_ascii_alphabetic()) {
                (b'M', false) => b'L',
                (b'm', false) => b'l',
                _ => cmd,
            };
            if !self.step(c) {
                return;
            }
            self.prev_cmd = c;
        }
    }

    fn skip_sep(&mut self) {
        while self.pos < self.bytes.len()
            && matches!(self.bytes[self.pos], b' ' | b'\t' | b'\n' | b'\r' | b',')
        {
            self.pos += 1;
        }
    }

    /// One number, sign and exponent included. Malformed input ends the parse
    /// rather than guessing — a truncated path draws its complete prefix, which
    /// is what a browser does with a bad `d`.
    fn number(&mut self) -> Option<f32> {
        self.skip_sep();
        let start = self.pos;
        let mut seen_digit = false;
        let mut seen_dot = false;
        let mut seen_e = false;
        while self.pos < self.bytes.len() {
            let b = self.bytes[self.pos];
            match b {
                b'0'..=b'9' => seen_digit = true,
                b'.' if !seen_dot && !seen_e => seen_dot = true,
                b'e' | b'E' if !seen_e && seen_digit => {
                    seen_e = true;
                    // A sign may follow the exponent.
                    if self.pos + 1 < self.bytes.len()
                        && matches!(self.bytes[self.pos + 1], b'+' | b'-')
                    {
                        self.pos += 1;
                    }
                }
                b'+' | b'-' if self.pos == start => {}
                _ => break,
            }
            self.pos += 1;
        }
        if !seen_digit {
            return None;
        }
        std::str::from_utf8(&self.bytes[start..self.pos])
            .ok()?
            .parse()
            .ok()
    }

    fn flag(&mut self) -> Option<bool> {
        self.skip_sep();
        let b = *self.bytes.get(self.pos)?;
        self.pos += 1;
        match b {
            b'0' => Some(false),
            b'1' => Some(true),
            _ => None,
        }
    }

    fn point(&mut self, relative: bool) -> Option<Point> {
        let x = self.number()?;
        let y = self.number()?;
        Some(if relative {
            Point::new(self.cur.x + x, self.cur.y + y)
        } else {
            Point::new(x, y)
        })
    }

    fn step(&mut self, cmd: u8) -> bool {
        let relative = cmd.is_ascii_lowercase();
        let keep_ctrl = matches!(cmd, b'C' | b'c' | b'S' | b's' | b'Q' | b'q' | b'T' | b't');
        let ok = match cmd {
            b'M' | b'm' => match self.point(relative) {
                Some(p) => {
                    self.path.move_to(p);
                    self.cur = p;
                    self.start = p;
                    true
                }
                None => false,
            },
            b'L' | b'l' => match self.point(relative) {
                Some(p) => {
                    self.path.line_to(p);
                    self.cur = p;
                    true
                }
                None => false,
            },
            b'H' | b'h' => match self.number() {
                Some(x) => {
                    let x = if relative { self.cur.x + x } else { x };
                    self.path.line_to(Point::new(x, self.cur.y));
                    self.cur.x = x;
                    true
                }
                None => false,
            },
            b'V' | b'v' => match self.number() {
                Some(y) => {
                    let y = if relative { self.cur.y + y } else { y };
                    self.path.line_to(Point::new(self.cur.x, y));
                    self.cur.y = y;
                    true
                }
                None => false,
            },
            b'C' | b'c' => match (
                self.point(relative),
                self.point(relative),
                self.point(relative),
            ) {
                (Some(c1), Some(c2), Some(p)) => {
                    self.path.cubic_to(c1, c2, p);
                    self.ctrl = Some(c2);
                    self.cur = p;
                    true
                }
                _ => false,
            },
            // Smooth cubic: the first control point mirrors the previous one.
            b'S' | b's' => match (self.point(relative), self.point(relative)) {
                (Some(c2), Some(p)) => {
                    let c1 = match (self.prev_cmd, self.ctrl) {
                        (b'C' | b'c' | b'S' | b's', Some(c)) => {
                            Point::new(2.0 * self.cur.x - c.x, 2.0 * self.cur.y - c.y)
                        }
                        _ => self.cur,
                    };
                    self.path.cubic_to(c1, c2, p);
                    self.ctrl = Some(c2);
                    self.cur = p;
                    true
                }
                _ => false,
            },
            b'Q' | b'q' => match (self.point(relative), self.point(relative)) {
                (Some(c), Some(p)) => {
                    self.path.quad_to(c, p);
                    self.ctrl = Some(c);
                    self.cur = p;
                    true
                }
                _ => false,
            },
            b'T' | b't' => match self.point(relative) {
                Some(p) => {
                    let c = match (self.prev_cmd, self.ctrl) {
                        (b'Q' | b'q' | b'T' | b't', Some(c)) => {
                            Point::new(2.0 * self.cur.x - c.x, 2.0 * self.cur.y - c.y)
                        }
                        _ => self.cur,
                    };
                    self.path.quad_to(c, p);
                    self.ctrl = Some(c);
                    self.cur = p;
                    true
                }
                None => false,
            },
            b'A' | b'a' => {
                let parsed = (
                    self.number(),
                    self.number(),
                    self.number(),
                    self.flag(),
                    self.flag(),
                    self.point(relative),
                );
                match parsed {
                    (Some(rx), Some(ry), Some(rot), Some(large), Some(sweep), Some(p)) => {
                        arc_to(&mut self.path, self.cur, rx, ry, rot, large, sweep, p);
                        self.cur = p;
                        true
                    }
                    _ => false,
                }
            }
            b'Z' | b'z' => {
                self.path.close();
                self.cur = self.start;
                true
            }
            _ => false,
        };
        if !keep_ctrl {
            self.ctrl = None;
        }
        ok
    }
}

/// Endpoint-to-centre arc conversion (SVG F.6.5), then out as cubics.
///
/// Skia's `Path::arc_to` takes a bounding oval and angles, so the endpoint
/// parameterisation SVG specifies has to be converted first — this is the
/// standard algebra, and it is why `A` is the expensive command in every SVG
/// implementation.
fn arc_to(
    path: &mut Path,
    from: Point,
    rx: f32,
    ry: f32,
    rot_deg: f32,
    large: bool,
    sweep: bool,
    to: Point,
) {
    if from == to {
        return; // the spec: a zero-length arc draws nothing
    }
    let (mut rx, mut ry) = (rx.abs(), ry.abs());
    if rx == 0.0 || ry == 0.0 {
        // Degenerate radius: the spec says this is a straight line.
        path.line_to(to);
        return;
    }

    let phi = rot_deg.to_radians();
    let (sin, cos) = phi.sin_cos();
    let dx = (from.x - to.x) / 2.0;
    let dy = (from.y - to.y) / 2.0;
    let x1p = cos * dx + sin * dy;
    let y1p = -sin * dx + cos * dy;

    // Scale radii up when they cannot reach (F.6.6).
    let lambda = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry);
    if lambda > 1.0 {
        let s = lambda.sqrt();
        rx *= s;
        ry *= s;
    }

    let num = (rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p).max(0.0);
    let den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let sign = if large == sweep { -1.0 } else { 1.0 };
    let co = sign * (num / den).sqrt();
    let cxp = co * rx * y1p / ry;
    let cyp = -co * ry * x1p / rx;

    let cx = cos * cxp - sin * cyp + (from.x + to.x) / 2.0;
    let cy = sin * cxp + cos * cyp + (from.y + to.y) / 2.0;

    let angle = |ux: f32, uy: f32, vx: f32, vy: f32| -> f32 {
        let dot = ux * vx + uy * vy;
        let len = (ux * ux + uy * uy).sqrt() * (vx * vx + vy * vy).sqrt();
        let mut a = (dot / len).clamp(-1.0, 1.0).acos();
        if ux * vy - uy * vx < 0.0 {
            a = -a;
        }
        a
    };

    let theta = angle(1.0, 0.0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let mut delta = angle(
        (x1p - cxp) / rx,
        (y1p - cyp) / ry,
        (-x1p - cxp) / rx,
        (-y1p - cyp) / ry,
    );
    let full = std::f32::consts::TAU;
    if !sweep && delta > 0.0 {
        delta -= full;
    } else if sweep && delta < 0.0 {
        delta += full;
    }

    // Approximate the arc with cubic segments, at most 90 degrees each — the
    // standard quarter-circle bound, under which the error is sub-pixel.
    let segments = (delta.abs() / (full / 4.0)).ceil().max(1.0);
    let step = delta / segments;
    let mut t = theta;
    for _ in 0..segments as usize {
        let t2 = t + step;
        let k = 4.0 / 3.0 * (step / 4.0).tan();
        let (s1, c1) = t.sin_cos();
        let (s2, c2) = t2.sin_cos();
        let map = |c: f32, s: f32| {
            Point::new(
                cx + rx * (cos * c) - ry * (sin * s),
                cy + rx * (sin * c) + ry * (cos * s),
            )
        };
        let p1 = Point::new(c1 - k * s1, s1 + k * c1);
        let p2 = Point::new(c2 + k * s2, s2 - k * c2);
        path.cubic_to(map(p1.x, p1.y), map(p2.x, p2.y), map(c2, s2));
        t = t2;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_document_and_reports_its_intrinsic_size() {
        let svg = Svg::parse(
            r#"<svg viewBox="0 0 24 24"><path d="M0 0 L24 24" stroke="black" fill="none"/></svg>"#,
        )
        .expect("parses");
        assert_eq!(svg.intrinsic_size(), Some((24.0, 24.0)));
        assert_eq!(svg.draws.len(), 1);
    }

    #[test]
    fn width_and_height_imply_the_view_box() {
        let svg = Svg::parse(r#"<svg width="40" height="20"><rect width="40" height="20"/></svg>"#)
            .expect("parses");
        assert_eq!(svg.intrinsic_size(), Some((40.0, 20.0)));
    }

    #[test]
    fn not_svg_is_none_so_the_caller_can_fall_back_to_raster() {
        assert!(Svg::parse("<div/>").is_none());
        assert!(Svg::parse("not xml at all").is_none());
        assert!(
            Svg::parse(&[0x89u8, 0x50].map(|b| b as char).iter().collect::<String>()).is_none()
        );
    }

    #[test]
    fn group_fill_inherits_and_a_child_overrides() {
        let svg = Svg::parse(
            r##"<svg viewBox="0 0 10 10"><g fill="#ff0000"><rect width="5" height="5"/><rect x="5" width="5" height="5" fill="#0000ff"/></g></svg>"##,
        )
        .expect("parses");
        assert_eq!(svg.draws.len(), 2);
        assert_eq!(svg.draws[0].fill, Some((Ink::Rgba(0xffff0000), 1.0)));
        assert_eq!(svg.draws[1].fill, Some((Ink::Rgba(0xff0000ff), 1.0)));
    }

    #[test]
    fn fill_none_means_no_fill_not_black() {
        let svg = Svg::parse(
            r#"<svg viewBox="0 0 10 10"><rect width="5" height="5" fill="none"/></svg>"#,
        )
        .expect("parses");
        assert_eq!(svg.draws[0].fill, None);
    }

    #[test]
    fn the_path_commands_all_parse() {
        let p = parse_path(
            "M0 0 l10 0 h5 v5 C0 0 1 1 2 2 S3 3 4 4 Q1 1 2 2 T5 5 A5 5 0 0 1 10 10 Z m1 1",
        )
        .expect("parses");
        assert!(p.is_finite());
        assert!(p.compute_tight_bounds().width() > 0.0);
    }

    #[test]
    fn arcs_land_on_their_endpoint() {
        // A semicircle from (0,0) to (10,0): whatever the conversion does, the
        // path must *end* at the endpoint or everything after it drifts.
        // sweep=1 is the *upper* arc — SVG's y axis points down, so the
        // "positive direction" reads counter-clockwise on screen (MDN's arcs
        // example bulges upward for exactly this flag).
        let p = parse_path("M0 0 A5 5 0 0 1 10 0").expect("parses");
        let b = p.compute_tight_bounds();
        assert!((b.right - 10.0).abs() < 0.01, "bounds {b:?}");
        assert!((b.top + 5.0).abs() < 0.01, "sweep up to y=-5: {b:?}");
        assert!(b.bottom.abs() < 0.01, "bounds {b:?}");
    }

    #[test]
    fn a_zero_length_arc_draws_nothing() {
        let p = parse_path("M5 5 A5 5 0 0 1 5 5 L10 10").expect("parses");
        let b = p.compute_tight_bounds();
        assert_eq!(b.width(), 5.0);
        assert_eq!(b.height(), 5.0);
    }

    #[test]
    fn transforms_compose_left_to_right() {
        // translate then scale: the translation is scaled, because it happened first.
        let m = parse_transform("translate(10, 0) scale(2)").expect("parses");
        let p = m.map_point((0.0, 0.0));
        assert_eq!(p, Point::new(10.0, 0.0));
        let p2 = m.map_point((5.0, 0.0));
        assert_eq!(p2, Point::new(20.0, 0.0));
    }

    #[test]
    fn hex_colours_parse_in_all_three_widths() {
        assert_eq!(parse_color("#fff"), Some(0xffffffff));
        assert_eq!(parse_color("#ff0000"), Some(0xffff0000));
        assert_eq!(parse_color("#ff000080"), Some(0x80ff0000));
        assert_eq!(parse_color("rgb(255, 0, 0)"), Some(0xffff0000));
    }
}
