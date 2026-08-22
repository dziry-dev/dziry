//! Fonts and measurement — the reason the engine exists.
//!
//! The A0 spike measured Taffy at 2.9–3.4 ms per relayout, and *all* of the
//! difference from 1.39 ms was 2,703 text-measure callbacks crossing into Bun at
//! ~1.1 µs each. Here the measure function is an ordinary Rust call into Skia, so
//! that cost is gone rather than reduced.
//!
//! # Measurement is paragraph layout
//!
//! Measurement used to be single-line: `Font::measure_str` for the advance, font
//! metrics for the height, and `available_width` accepted and ignored. A string
//! longer than its box overflowed at any width, which is what made a narrow
//! window look broken.
//!
//! It is now **SkParagraph**, which brings line breaking, and with it bidi and
//! font fallback, from the same call. The seam did not move: [`Measurer::measure`]
//! already received the available width, so this changed the body and not the
//! callers.
//!
//! # What a paragraph costs, and what is cached
//!
//! The cache holds *measurements*, not paragraphs — `Paragraph` owns shaped
//! glyphs and is not cheap to keep, and paint needs a live one to draw anyway. So
//! layout hits the cache and paint builds. The key gained the width, because that
//! is now an input to the answer: the same string at 200 px and at 600 px are
//! different measurements, and a key that omitted the width would return the
//! first one forever.
//!
//! `lineClamp` is one field away from working — it exists in the wire schema
//! (`0 = unlimited; drives SkParagraph maxLines`) and is what
//! `ParagraphStyle::set_max_lines` takes. What it still lacks is an entry in the
//! IR's `STYLE_FIELDS`, which is why `schema.test.ts` still pins it as unmapped.

use std::collections::HashMap;

use crate::error::EngineError;
use crate::protocol;
use skia_safe::font::Edging;
use skia_safe::font_style::{Slant, Weight, Width};
use skia_safe::textlayout::{
    FontCollection, Paragraph, ParagraphBuilder, ParagraphStyle, TextAlign, TextStyle,
};
use skia_safe::{Canvas, FontMgr, FontStyle, Paint, Point};

/// Tried in order. A missing font family is not a crash: the last resort is
/// whatever the platform considers its default sans-serif.
#[cfg(target_os = "windows")]
const FAMILIES: &[&str] = &["Segoe UI", "Arial", "Tahoma"];
#[cfg(target_os = "macos")]
const FAMILIES: &[&str] = &["SF Pro Text", "Helvetica Neue", "Helvetica", "Arial"];
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
const FAMILIES: &[&str] = &["DejaVu Sans", "Liberation Sans", "Noto Sans", "Arial"];

/// The face `font-family: monospace` resolves to, tried in order like [`FAMILIES`].
/// Falls back to the default family rather than erroring: text in the wrong face
/// beats no text, and the platform lists here make a total miss unlikely.
#[cfg(target_os = "windows")]
const MONO_FAMILIES: &[&str] = &["Cascadia Mono", "Consolas", "Courier New"];
#[cfg(target_os = "macos")]
const MONO_FAMILIES: &[&str] = &["SF Mono", "Menlo", "Monaco", "Courier New"];
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
const MONO_FAMILIES: &[&str] = &["DejaVu Sans Mono", "Liberation Mono", "Noto Sans Mono"];

/// Stands in for "no constraint" when Taffy asks for a max-content width.
///
/// `Paragraph::layout` takes a finite scalar. Passing `f32::INFINITY` is not
/// specified to do anything useful, and the intrinsic widths are the supported way
/// to ask the question: lay out unconstrained, then read `max_intrinsic_width`.
/// A million pixels is past any surface this will ever run on.
const MAX_LAYOUT_WIDTH: f32 = 1.0e6;

/// The width paint adds before laying a paragraph out again.
///
/// Paint must never wrap earlier than the layout pass did. Layout measured the
/// string, Taffy sized a box from that measurement, and paint then subtracts border
/// and padding back off to recover the width it was measured at — a float round trip
/// that lands a fraction of a *thousandth* of a pixel low often enough to matter.
/// Skia takes "fits in exactly this width" literally, so a hair under is a break, and
/// the last glyph drops onto a second line inside a box sized for one. That is what
/// "Clear" rendering as "Clea/r" was, and it hit every short label in the demo.
///
/// So the tolerance is one-sided, which is the same asymmetry the old single-line
/// centring documented: erring wide is invisible, erring narrow is a broken word.
/// A twentieth of a pixel is far above float round-trip error and far below the
/// width of any glyph, so it cannot change where a line actually breaks — a break
/// decision would have to be balanced within 0.05 px to flip.
///
/// It is applied here rather than to the measurement on purpose. Slack in the
/// *measurement* becomes slack in the box, which every downstream box inherits and
/// which `layout-diff` reports as up to a pixel of disagreement with Chrome per text
/// node. Slack in paint costs nothing outside this function.
const PAINT_SLACK: f32 = 0.05;

/// Measurements are cached because dynamic text makes the key space unbounded —
/// a counter alone mints a new string on every increment. The TypeScript runtime
/// bounded the same cache at 4096 entries.
const MEASURE_LIMIT: usize = 4096;

/// The glyph [`Measurer::line_height`] measures a line with.
///
/// Any character would do — a single line's height is ascent + descent + line gap and
/// does not depend on what is on it — and `x` is chosen for being present in every font
/// this could fall back to. It goes through the ordinary measure cache, so a page full of
/// empty fields at one font size costs one Skia layout in total.
const STRUT: &str = "x";

/// `(font size bits, weight, style|family, leading bits, text hash, available width bits)`.
///
/// Sizes and widths are keyed on their bit pattern so `16.0` and `16.000001` stay
/// distinct rather than silently merging, and so infinity is an ordinary key.
/// Style and family share one byte — two flags today, and the packing is private
/// to this key.
type MeasureKey = (u32, u16, u8, u32, u64, u32);

/// Everything the style table says about type selection, as one copyable value.
///
/// Exists because the third and fourth axes arrived: `(size, weight)` threaded
/// through nine call sites, and threading four positionals through the same nine
/// is how arguments get transposed. The field order is the column order.
#[derive(Clone, Copy, PartialEq)]
pub struct FontSpec {
    pub size: f32,
    pub weight: u16,
    /// `protocol::font_style` — `NORMAL` or `ITALIC`.
    pub style: u8,
    /// `protocol::font_family` — a *generic*: `DEFAULT` or `MONOSPACE`.
    pub family: u8,
    /// The `line-height` multiplier, already folded: a px value arrives divided
    /// by the size. 0 is `normal` — the paragraph is never told anything.
    pub leading: f32,
}

impl FontSpec {
    pub fn new(size: f32, weight: u16, style: u8, family: u8) -> Self {
        Self {
            size,
            weight,
            style,
            family,
            leading: 0.0,
        }
    }

    /// The default face at this size and weight — what every caller that predates
    /// `font-style`/`font-family` meant, and what controls' own chrome still means.
    pub fn plain(size: f32, weight: u16) -> Self {
        Self::new(size, weight, 0, 0)
    }

    /// Sets the `line-height` multiplier. A method rather than a fifth positional,
    /// because most construction sites have no opinion.
    pub fn with_leading(mut self, leading: f32) -> Self {
        self.leading = leading;
        self
    }

    fn key_byte(self) -> u8 {
        (self.style & 0x0f) | (self.family << 4)
    }
}

pub struct Measurer {
      /// Kept for `decoration_metrics`, which needs a raw typeface where the
      /// paragraph path goes through the collection.
      mgr: FontMgr,
      family: String,
    /// What `font-family: monospace` resolves to. Falls back to `family` when the
    /// platform knows none of [`MONO_FAMILIES`], so index 1 always names a face.
    mono_family: String,
    /// Owns font fallback. One collection, reused: building one per paragraph
    /// would re-resolve the platform font manager on every measure.
    fonts: FontCollection,
    measured: HashMap<MeasureKey, (f32, f32)>,
    /// Insertion order for the measurement cache, so eviction is FIFO-by-first-use.
    /// Cheaper than true LRU and, for text that changes every frame, identical in
    /// effect: the churn is in recently minted strings either way.
    order: std::collections::VecDeque<MeasureKey>,
}

impl Measurer {
    pub fn new() -> Result<Self, EngineError> {
        let font_mgr = FontMgr::new();

        let mut family = String::new();
        for name in FAMILIES {
            if font_mgr
                .match_family_style(name, FontStyle::normal())
                .is_some()
            {
                family = (*name).to_string();
                break;
            }
        }

        if family.is_empty() {
            // The platform font manager exists but knows none of our names —
            // still usable, just not with a name we can report.
            let count = font_mgr.count_families();
            if count == 0 {
                // Skia's own font manager found nothing, so this is Skia's
                // failure rather than a bad tree or a windowing problem.
                return Err(EngineError::skia(format!(
                    "no usable font family (tried {}); the platform font manager reports none",
                    FAMILIES.join(", ")
                )));
            }
            family = font_mgr.family_name(0);
        }

        let mono_family = MONO_FAMILIES
            .iter()
            .find(|name| {
                font_mgr
                    .match_family_style(name, FontStyle::normal())
                    .is_some()
            })
            .map(|name| (*name).to_string())
            .unwrap_or_else(|| family.clone());

        let mut fonts = FontCollection::new();
        fonts.set_default_font_manager(FontMgr::new(), None);

        Ok(Self {
            mgr: font_mgr,
            family,
            mono_family,
            fonts,
            measured: HashMap::new(),
            order: std::collections::VecDeque::new(),
        })
    }

    pub fn family(&self) -> &str {
        &self.family
    }

    /// The paragraph style for one run of text.
    ///
    /// `apply_rounding_hack(false)` turns off Skia's habit of rounding line widths
    /// up to whole pixels. It is on by default and browsers do not do it, so
    /// leaving it on costs up to a pixel of disagreement per line for nothing —
    /// checked against Chrome with `bun run layout-diff` rather than assumed.
    fn style(&self, spec: FontSpec, align: TextAlign) -> ParagraphStyle {
        let mut text_style = TextStyle::new();
        text_style.set_font_size(spec.size);
        let family = if spec.family == protocol::font_family::MONOSPACE {
            self.mono_family.as_str()
        } else {
            self.family.as_str()
        };
        text_style.set_font_families(&[family]);
        if spec.leading > 0.0 && spec.leading.is_finite() {
            // `height_override` is what makes the multiplier bind every line,
            // first included — CSS applies `line-height` to the whole block, and
            // SkParagraph's default without the override only honours it from the
            // second line on.
            text_style.set_height(spec.leading);
            text_style.set_height_override(true);
        }
        text_style.set_font_style(FontStyle::new(
            Weight::from(spec.weight as i32),
            Width::NORMAL,
            // Italic, not Oblique: for a face with a true italic Skia picks it, and
            // for one without the platform synthesizes a slant either way. The
            // compiler folds `oblique` into this value on the same grounds.
            if spec.style == protocol::font_style::ITALIC {
                Slant::Italic
            } else {
                Slant::Upright
            },
        ));

        let mut para = ParagraphStyle::new();
        para.set_text_style(&text_style);
        para.set_text_align(align);
        para.set_apply_rounding_hack(false);
        para
    }

    fn build(&mut self, text: &str, style: &ParagraphStyle) -> Paragraph {
        let mut builder = ParagraphBuilder::new(style, self.fonts.clone());
        builder.add_text(text);
        builder.build()
    }

    /// A laid-out paragraph, for paint to draw.
    ///
    /// Not cached, and deliberately: a `Paragraph` owns its shaped glyphs, and the
    /// measurement cache exists so that *layout* — which runs over every node,
    /// including ones paint will skip — never builds one.
    ///
    /// Laid out to `width + PAINT_SLACK`; see that constant for why exact is wrong.
    pub fn paragraph(
        &mut self,
        text: &str,
        spec: FontSpec,
        width: f32,
        align: TextAlign,
    ) -> Paragraph {
        let para_style = self.style(spec, align);
        let mut paragraph = self.build(text, &para_style);
        // A non-finite or negative width would be a caller bug rather than a
        // constraint, and Skia has no defined answer for it.
        paragraph.layout(if width.is_finite() && width > 0.0 {
            width + PAINT_SLACK
        } else {
            MAX_LAYOUT_WIDTH
        });
        paragraph
    }

    /// How tall one line of this font is, with no text in it — CSS's *strut*.
    ///
    /// What an empty editable field is worth. Measured, `guards/probes/text-field-box.html`:
    /// an `<input>`'s content box is 15.0px at 13.3333px Arial whether it holds nothing,
    /// one character or forty, so the height is a property of the **font** and content
    /// has no say. A `contenteditable` div agrees; a plain block box does not, which is
    /// why the caller checks a flag rather than applying this to every empty run.
    ///
    /// Taken from a one-line paragraph rather than from raw font metrics because that is
    /// the number the *filled* field will report a keystroke later, and the two have to
    /// agree exactly or the box jumps by a fraction of a pixel the first time anyone
    /// types — which is the bug being fixed here, only smaller and harder to see. The
    /// glyph is irrelevant: a single line's height comes from ascent + descent + line
    /// gap, so any character measures the same.
    pub fn line_height(&mut self, spec: FontSpec) -> f32 {
        self.measure(STRUT, spec, f32::INFINITY).1
    }

    /// The size a text node wants, given whatever space Taffy is offering.
    ///
    /// `available_width` is now honoured, which is the whole of this milestone:
    /// infinity asks for max-content, zero or less asks for min-content, and a
    /// definite width asks what the text does when wrapped to it.
    pub fn measure(&mut self, text: &str, spec: FontSpec, available_width: f32) -> (f32, f32) {
        if text.is_empty() {
            return (0.0, 0.0);
        }

        let key = (
            spec.size.to_bits(),
            spec.weight,
            spec.key_byte(),
            spec.leading.to_bits(),
            hash_str(text),
            available_width.to_bits(),
        );
        if let Some(&wh) = self.measured.get(&key) {
            return wh;
        }

        let style = self.style(spec, TextAlign::Left);
        let mut paragraph = self.build(text, &style);

        let raw = if available_width.is_finite() && available_width > 0.0 {
            paragraph.layout(available_width);
            (paragraph.longest_line(), paragraph.height())
        } else if available_width.is_finite() {
            // Min-content: the narrowest the text can be without overflowing, which
            // is its longest unbreakable run. Laid out *at* that width rather than
            // at 0, so the height reported is the height it would really take —
            // `min_intrinsic_width` alone says nothing about how tall the result is.
            paragraph.layout(MAX_LAYOUT_WIDTH);
            let min = paragraph.min_intrinsic_width();
            paragraph.layout(min);
            (paragraph.longest_line(), paragraph.height())
        } else {
            // Max-content: unwrapped, however wide that is.
            paragraph.layout(MAX_LAYOUT_WIDTH);
            (paragraph.max_intrinsic_width(), paragraph.height())
        };

        // Returned exactly as Skia reported it, with no rounding of any kind.
        //
        // An earlier version ceiled both numbers, to stop Taffy's whole-pixel rounding
        // making a box narrower than the text it was measured for. That worked, and it
        // was treating the symptom: it cost up to a pixel of width against Chrome on
        // every text node, and it left the box a pixel wider than the text really is.
        // Taffy's rounding is off now (see `new_tree`), so there is nothing to defend
        // against here, and paint carries the one-sided tolerance instead — which is
        // where it belongs, because it costs nothing outside paint.
        let wh = raw;

        self.measured.insert(key, wh);
        self.order.push_back(key);
        if self.order.len() > MEASURE_LIMIT {
            if let Some(old) = self.order.pop_front() {
                self.measured.remove(&old);
            }
        }

        wh
    }

    /// Diagnostics: confirms the cache stays bounded under dynamic text.
    pub fn measure_cache_len(&self) -> usize {
        self.measured.len()
    }
}

/// Draws a laid-out paragraph, with this engine's glyph rasterisation rather than
/// Skia's default.
///
/// `Paragraph::paint` would be one line, and it draws **greyscale**-antialiased
/// text: SkParagraph builds its own `SkFont` per run and exposes no edging control
/// anywhere in `ParagraphStyle` or `TextStyle`, so the `SubpixelAntiAlias` this
/// engine sets is silently dropped. That is not cosmetic — it is the shipped fix
/// for text reading thin and unevenly spaced next to every other window on the
/// same desktop, and `tests/paint_geometry.rs` pins it by counting coloured glyph
/// edges. Switching to `paragraph.paint` took that count from nonzero to exactly 0.
///
/// So the paragraph decides *where* each glyph goes and this decides *how* it is
/// rasterised: `visit` hands back every run's font, glyph ids and positions, and
/// they are redrawn through a font configured the way the rest of the engine wants.
///
/// The subpixel-AA precondition still holds here and still belongs next to the
/// call: it is only valid over known pixels, and the surface is opaque because
/// `raster_n32_premul` clears to opaque black every frame. A translucent or layered
/// window would have to fall back to `Edging::AntiAlias`.
pub fn paint_paragraph(paragraph: &mut Paragraph, canvas: &Canvas, at: Point, paint: &Paint) {
    paragraph.visit(|_line, info| {
        // `None` marks the end of a line rather than an error.
        let Some(info) = info else { return };
        if info.count() == 0 {
            return;
        }

        let mut font = info.font().clone();
        font.set_edging(Edging::SubpixelAntiAlias);
        font.set_subpixel(true);

        // `positions` are relative to the run's `origin`, which is itself relative
        // to the paragraph — so the block's own position is added on top. Verified
        // by rendering: treating them as absolute doubles the offset and the text
        // walks down and to the right of its box.
        canvas.draw_glyphs_at(
            info.glyphs(),
            info.positions(),
            at + info.origin(),
            &font,
            paint,
        );
    });
}

/// What a `text-decoration` needs from the font, per line: where each line goes
/// and how thick it is.
///
/// From the font's own metrics where it has them — Segoe UI does — and from the
/// heuristics CSS's own spec text names where it does not: a thickness of
/// 1/12em and the underline just below the baseline. `ascent` is the *positive*
/// magnitude (Skia reports it negative), because that is the form the overline
/// arithmetic wants.
#[derive(Clone, Copy)]
pub struct DecoMetrics {
    pub underline_pos: f32,
    pub underline_thick: f32,
    pub strikeout_pos: f32,
    pub strikeout_thick: f32,
    pub ascent: f32,
}

impl Measurer {
    /// The decoration metrics for a spec. Not cached: paint calls it once per
    /// decorated run, and decorated runs are the rare kind.
    pub fn decoration_metrics(&self, spec: FontSpec) -> DecoMetrics {
        let family = if spec.family == protocol::font_family::MONOSPACE {
            self.mono_family.as_str()
        } else {
            self.family.as_str()
        };
        let style = FontStyle::new(
            Weight::from(spec.weight as i32),
            Width::NORMAL,
            if spec.style == protocol::font_style::ITALIC {
                Slant::Italic
            } else {
                Slant::Upright
            },
        );
        let fallback = DecoMetrics {
            underline_pos: spec.size * 0.1,
            underline_thick: spec.size / 12.0,
            strikeout_pos: -spec.size * 0.25,
            strikeout_thick: spec.size / 12.0,
            ascent: spec.size * 0.8,
        };
        let Some(tf) = self.mgr.match_family_style(family, style) else {
            return fallback;
        };
        let font = skia_safe::Font::from_typeface(tf, spec.size);
        let (_, m) = font.metrics();
        DecoMetrics {
            underline_pos: m.underline_position().unwrap_or(fallback.underline_pos),
            underline_thick: m.underline_thickness().unwrap_or(fallback.underline_thick),
            strikeout_pos: m.strikeout_position().unwrap_or(fallback.strikeout_pos),
            strikeout_thick: m.strikeout_thickness().unwrap_or(fallback.strikeout_thick),
            ascent: -m.ascent,
        }
    }
}

/// What the style table says about a decoration, resolved for paint: the colour
/// already fell back to the run's `fg` when nothing was said, and `thickness` of
/// 0 has become the font's own metric by then.
pub struct Decoration<'a> {
    pub line: u8,
    pub colour: u32,
    pub style: u8,
    pub thickness: f32,
    /// NaN is auto — the font's metric position, unshifted.
    pub offset: f32,
    pub metrics: &'a DecoMetrics,
}

/// Draws a paragraph's text decorations, line by line.
///
/// A separate pass from [`paint_paragraph`] because that one redraws every run's
/// glyphs by hand — SkParagraph's own `paint` would draw decorations for free
/// and loses subpixel AA doing it, so the decorations are re-derived here from
/// the line metrics: each line's left edge, width and baseline are exactly what
/// a decoration line is drawn from.
pub fn paint_decorations(paragraph: &Paragraph, canvas: &Canvas, at: Point, deco: &Decoration) {
    if deco.line == 0 {
        return;
    }
    let mut paint = Paint::default();
    paint.set_color(skia_safe::Color::from(deco.colour));
    paint.set_anti_alias(true);

    for line in paragraph.get_line_metrics().iter() {
        let x0 = at.x + line.left as f32;
        let w = line.width as f32;
        if w <= 0.0 {
            continue;
        }
        let baseline = at.y + line.baseline as f32;

        // (y of the line's centre, thickness) per decoration kind. The underline
        // is the font's position plus any authored offset; the overline hugs the
        // ascent; the strikeout is the font's strikeout metric.
        let mut strokes: Vec<(f32, f32)> = Vec::with_capacity(3);
        if deco.line & 1 != 0 {
            let y = baseline
                + deco.metrics.underline_pos
                + if deco.offset.is_finite() { deco.offset } else { 0.0 };
            strokes.push((y, deco.thickness));
        }
        if deco.line & 2 != 0 {
            strokes.push((baseline - deco.metrics.ascent, deco.thickness));
        }
        if deco.line & 4 != 0 {
            strokes.push((baseline + deco.metrics.strikeout_pos, deco.thickness));
        }

        for (y, thick) in strokes {
            draw_deco_line(canvas, &paint, x0, y, w, thick.max(0.5), deco.style);
        }
    }
}

/// One decoration stroke in the style asked for. `double` splits the thickness
/// into two lines a thickness apart; `dashed` and `dotted` are dash effects;
/// `wavy` is a sine path, the only one that is not a straight line at all.
fn draw_deco_line(canvas: &Canvas, paint: &Paint, x0: f32, y: f32, w: f32, thickness: f32, style: u8) {
    use protocol::decoration_style as ds;
    match style {
        ds::DOUBLE => {
            let t = (thickness / 2.0).max(0.5);
            for dy in [0.0, t * 2.0] {
                canvas.draw_line((x0, y + dy), (x0 + w, y + dy), &stroke(paint, t, None));
            }
        }
        ds::DASHED | ds::DOTTED => {
            // Dotted is a dash whose marks are points: near-zero on-interval and
            // round caps, which Skia renders as circles of the stroke's width.
            let (on, off, round) = if style == ds::DOTTED {
                (0.1, thickness * 1.5, true)
            } else {
                (thickness * 3.0, thickness * 2.0, false)
            };
            let effect = skia_safe::PathEffect::dash(&[on, off], 0.0);
            let mut p = stroke(paint, thickness, effect);
            if round {
                p.set_stroke_cap(skia_safe::paint::Cap::Round);
            }
            canvas.draw_line((x0, y), (x0 + w, y), &p);
        }
        ds::WAVY => {
            // A sine with a wavelength twice the thickness and an amplitude of
            // half of one — the proportions every platform's wavy underline has.
            let amp = (thickness / 2.0).max(0.5);
            let wavelength = (thickness * 2.0).max(4.0);
            let mut path = skia_safe::Path::new();
            path.move_to((x0, y));
            let mut x = 0.0f32;
            let mut up = true;
            while x < w {
                let nx = (x + wavelength / 2.0).min(w);
                let mid = (x + nx) / 2.0;
                path.quad_to(
                    (x0 + mid, if up { y - amp } else { y + amp }),
                    (x0 + nx, y),
                );
                x = nx;
                up = !up;
            }
            canvas.draw_path(&path, &stroke(paint, amp, None));
        }
        _ => {
            canvas.draw_line((x0, y), (x0 + w, y), &stroke(paint, thickness, None));
        }
    }
}

fn stroke(paint: &Paint, width: f32, effect: Option<skia_safe::PathEffect>) -> Paint {
    let mut p = paint.clone();
    p.set_style(skia_safe::paint::Style::Stroke);
    p.set_stroke_width(width);
    p.set_path_effect(effect);
    p
}

/// FNV-1a. Short strings, no allocation, and no dependency for something this
/// small.
fn hash_str(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The figure the single-line path produced, which max-content has to agree
    /// with: an unwrapped short string is the same measurement by another route.
    #[test]
    fn max_content_agrees_with_what_measure_str_reported() {
        let mut m = Measurer::new().expect("font manager");
        let (width, height) = m.measure("Hello", FontSpec::plain(16.0, 400), f32::INFINITY);

        assert!(width > 0.0, "measured nothing");
        assert!(height > 0.0, "no line height");
        if m.family() == "Segoe UI" {
            // 36.85 px through libSkiaSharp, skia-safe's probe, and `measure_str`.
            // The tolerance is wider than the old test's 0.1 because a paragraph
            // reports the shaped advance rather than the sum of glyph advances.
            assert!(
                (width - 36.85).abs() < 1.0,
                "expected the libSkiaSharp figure, got {width}"
            );
        }
    }

    /// The bug this milestone closes, as one assertion.
    #[test]
    fn a_long_string_wraps_and_gets_taller() {
        let mut m = Measurer::new().expect("font manager");
        let text = "The quick brown fox jumps over the lazy dog near the river bank";

        let (wide_w, wide_h) = m.measure(text, FontSpec::plain(16.0, 400), f32::INFINITY);
        let (narrow_w, narrow_h) = m.measure(text, FontSpec::plain(16.0, 400), 200.0);

        assert!(
            narrow_w <= 200.0,
            "wrapped text should fit its width, got {narrow_w}"
        );
        assert!(
            narrow_w < wide_w,
            "wrapping should narrow the box: {narrow_w} vs {wide_w}"
        );
        assert!(
            narrow_h > wide_h * 2.0,
            "200px of a {wide_w}px string is at least three lines, got {narrow_h} vs {wide_h}"
        );
    }

    /// Regression for the cache key. With the width left out, the second call
    /// returns the first call's answer and wrapping silently stops working.
    #[test]
    fn the_same_string_measures_differently_at_different_widths() {
        let mut m = Measurer::new().expect("font manager");
        let text = "The quick brown fox jumps over the lazy dog near the river bank";

        let narrow = m.measure(text, FontSpec::plain(16.0, 400), 200.0);
        let wider = m.measure(text, FontSpec::plain(16.0, 400), 400.0);
        let narrow_again = m.measure(text, FontSpec::plain(16.0, 400), 200.0);

        assert_ne!(narrow, wider, "width is not part of the key");
        assert_eq!(narrow, narrow_again, "the cache changed its mind");
    }

    /// A token with no break opportunity is **broken by cluster**, not overflowed.
    ///
    /// Measured, and it is not what CSS says: `overflow-wrap: normal` leaves such a
    /// token on one line and lets it stick out of its box, which is what Chrome
    /// does. Skia's line breaker falls back to breaking anywhere once a word cannot
    /// fit — Flutter's behaviour, since this is Flutter's text stack.
    ///
    /// Pinned rather than fixed because it is not adjustable from `ParagraphStyle`:
    /// changing it means `overflow-wrap`/`word-break` as real properties. Recorded
    /// in BROWSER-FACTS.md so it is a known divergence and not a surprise.
    #[test]
    fn an_unbreakable_token_is_broken_by_cluster_not_overflowed() {
        let mut m = Measurer::new().expect("font manager");
        let (w, h) = m.measure(
            "Unbreakablesupercalifragilistic",
            FontSpec::plain(16.0, 400),
            40.0,
        );
        let (_, one_line) = m.measure("x", FontSpec::plain(16.0, 400), f32::INFINITY);

        assert!(w <= 40.0, "Skia breaks the token to fit, got {w}");
        assert!(
            h > one_line * 2.0,
            "so it takes several lines: {h} vs a single {one_line}"
        );
    }

    #[test]
    fn min_content_is_the_longest_word() {
        let mut m = Measurer::new().expect("font manager");
        let (min_w, min_h) = m.measure("aaa bbbbbbbbbbbb cc", FontSpec::plain(16.0, 400), 0.0);
        let (word_w, _) = m.measure("bbbbbbbbbbbb", FontSpec::plain(16.0, 400), f32::INFINITY);

        assert!(
            (min_w - word_w).abs() < 1.0,
            "min-content should be the longest word: {min_w} vs {word_w}"
        );
        assert!(min_h > 0.0, "min-content still has a height");
    }

    #[test]
    fn the_measure_cache_stays_bounded() {
        let mut m = Measurer::new().expect("font manager");
        for i in 0..(MEASURE_LIMIT + 500) {
            m.measure(
                &format!("row {i}"),
                FontSpec::plain(16.0, 400),
                f32::INFINITY,
            );
        }
        assert_eq!(m.measure_cache_len(), MEASURE_LIMIT);
    }

    #[test]
    fn an_empty_string_is_free() {
        let mut m = Measurer::new().expect("font manager");
        assert_eq!(
            m.measure("", FontSpec::plain(16.0, 400), f32::INFINITY),
            (0.0, 0.0)
        );
    }
}
