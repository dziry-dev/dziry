//! Fonts and measurement — the reason the engine exists.
//!
//! The A0 spike measured Taffy at 2.9–3.4 ms per relayout, and *all* of the
//! difference from 1.39 ms was 2,703 text-measure callbacks crossing into Bun at
//! ~1.1 µs each. Here the measure function is an ordinary Rust call into Skia, so
//! that cost is gone rather than reduced.
//!
//! # What this is not, yet
//!
//! Measurement is **single-line**: `Font::measure_str` for the advance, font
//! metrics for the height. That is exactly what `src/runtime/text.ts` does today
//! (`measure_str("Hello")` = 36.85 px on both paths), so the migration is
//! like-for-like and the existing behaviour is preserved.
//!
//! SkParagraph — wrapping, line breaking, ellipsis, bidi, font fallback — is
//! verified working in `native-src/skia-probe` and is A2's job. [`Measurer`] is
//! the seam it slots into: `measure` already receives the available width and the
//! style's `lineClamp`, which are the two inputs a paragraph needs.

use std::collections::HashMap;

use crate::error::EngineError;
use skia_safe::font::Edging;
use skia_safe::font_style::{Slant, Weight, Width};
use skia_safe::{Font, FontMgr, FontStyle, Typeface};

/// Tried in order. A missing font family is not a crash: the last resort is
/// whatever the platform considers its default sans-serif.
#[cfg(target_os = "windows")]
const FAMILIES: &[&str] = &["Segoe UI", "Arial", "Tahoma"];
#[cfg(target_os = "macos")]
const FAMILIES: &[&str] = &["SF Pro Text", "Helvetica Neue", "Helvetica", "Arial"];
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
const FAMILIES: &[&str] = &["DejaVu Sans", "Liberation Sans", "Noto Sans", "Arial"];

/// A resolved font at one size and weight, with the metrics paint needs.
pub struct Face {
    pub font: Font,
    /// Negative, as in Skia: the distance from the baseline up to the top.
    pub ascent: f32,
    pub descent: f32,
}

impl Face {
    pub fn line_height(&self) -> f32 {
        self.descent - self.ascent
    }
}

/// Advance widths are cached because dynamic text makes the key space unbounded
/// — a counter alone mints a new string on every increment. The TypeScript
/// runtime bounds the same cache at 4096 entries.
const ADVANCE_LIMIT: usize = 4096;

pub struct Measurer {
    font_mgr: FontMgr,
    family: String,
    typefaces: HashMap<u16, Typeface>,
    faces: HashMap<(u32, u16), Face>,
    advances: HashMap<(u32, u16, u64), f32>,
    /// Insertion order for the advance cache, so eviction is FIFO-by-first-use.
    /// Cheaper than true LRU and, for text that changes every frame, identical in
    /// effect: the churn is in recently minted strings either way.
    advance_order: std::collections::VecDeque<(u32, u16, u64)>,
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

        Ok(Self {
            font_mgr,
            family,
            typefaces: HashMap::new(),
            faces: HashMap::new(),
            advances: HashMap::new(),
            advance_order: std::collections::VecDeque::new(),
        })
    }

    pub fn family(&self) -> &str {
        &self.family
    }

    /// The typeface for a weight, or `None` when the platform cannot supply one
    /// — which is survivable, because Skia has a default font of its own.
    fn typeface(&mut self, weight: u16) -> Option<Typeface> {
        if let Some(tf) = self.typefaces.get(&weight) {
            return Some(tf.clone());
        }

        let style = FontStyle::new(Weight::from(weight as i32), Width::NORMAL, Slant::Upright);
        let tf = self
            .font_mgr
            .match_family_style(&self.family, style)
            .or_else(|| self.font_mgr.legacy_make_typeface(None, style))?;

        self.typefaces.insert(weight, tf.clone());
        Some(tf)
    }

    /// A font plus its vertical metrics. Keyed on the size's bit pattern so
    /// `16.0` and `16.000001` stay distinct rather than silently merging.
    pub fn face(&mut self, size: f32, weight: u16) -> &Face {
        let key = (size.to_bits(), weight);
        if !self.faces.contains_key(&key) {
            let mut font = match self.typeface(weight) {
                Some(tf) => Font::from_typeface(tf, size),
                None => {
                    // Skia's built-in default, resized. Ugly text beats no text
                    // and beats a panic on the render thread.
                    let mut font = Font::default();
                    font.set_size(size);
                    font
                }
            };

            // SkFont defaults to greyscale AA and integer glyph positions, which is
            // why text read thin and unevenly spaced next to every other window on
            // the same desktop — ClearType is subpixel AA with fractional advances.
            // `Paint::set_anti_alias` does not cover this: it governs geometry, not
            // glyph rasterisation.
            //
            // Subpixel AA is only *valid* over known pixels, and it is valid here
            // because the surface is opaque: `raster_n32_premul` cleared to opaque
            // black every frame. A translucent or layered window would have to fall
            // back to `Edging::AntiAlias`, so that precondition belongs next to the
            // call rather than in a commit message.
            //
            // Hinting stays at Skia's default. DirectWrite's slight hinting was the
            // review's suggestion, but on this corpus it moved stems around without
            // making anything measurably better, and it is a separate decision from
            // the two that fix the AA.
            font.set_edging(Edging::SubpixelAntiAlias);
            font.set_subpixel(true);

            let (_, metrics) = font.metrics();
            self.faces.insert(
                key,
                Face {
                    font,
                    ascent: metrics.ascent,
                    descent: metrics.descent,
                },
            );
        }
        &self.faces[&key]
    }

    pub fn advance(&mut self, text: &str, size: f32, weight: u16) -> f32 {
        if text.is_empty() {
            return 0.0;
        }

        let key = (size.to_bits(), weight, hash_str(text));
        if let Some(&w) = self.advances.get(&key) {
            return w;
        }

        let width = self.face(size, weight).font.measure_str(text, None).0;

        self.advances.insert(key, width);
        self.advance_order.push_back(key);
        if self.advance_order.len() > ADVANCE_LIMIT {
            if let Some(old) = self.advance_order.pop_front() {
                self.advances.remove(&old);
            }
        }

        width
    }

    pub fn line_height(&mut self, size: f32, weight: u16) -> f32 {
        self.face(size, weight).line_height()
    }

    /// The size a text node wants, given whatever space Taffy is offering.
    ///
    /// `available_width` is accepted and currently ignored, which is the honest
    /// shape of the single-line limitation: the signature is already the one
    /// SkParagraph needs, so A2 changes the body and not the callers.
    pub fn measure(
        &mut self,
        text: &str,
        size: f32,
        weight: u16,
        _available_width: f32,
    ) -> (f32, f32) {
        (
            self.advance(text, size, weight),
            self.line_height(size, weight),
        )
    }

    /// Diagnostics: confirms the cache stays bounded under dynamic text.
    pub fn advance_cache_len(&self) -> usize {
        self.advances.len()
    }
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

    #[test]
    fn measures_the_same_string_the_typescript_runtime_did() {
        let mut m = Measurer::new().expect("font manager");
        let width = m.advance("Hello", 16.0, 400);

        // 36.85 px through libSkiaSharp and through skia-safe's probe. The
        // tolerance is for a different default font on a non-Windows machine.
        assert!(width > 0.0, "measured nothing");
        if m.family() == "Segoe UI" {
            assert!(
                (width - 36.85).abs() < 0.1,
                "expected the libSkiaSharp figure, got {width}"
            );
        }
    }

    #[test]
    fn the_advance_cache_stays_bounded() {
        let mut m = Measurer::new().expect("font manager");
        for i in 0..(ADVANCE_LIMIT + 500) {
            m.advance(&format!("row {i}"), 16.0, 400);
        }
        assert_eq!(m.advance_cache_len(), ADVANCE_LIMIT);
    }

    #[test]
    fn an_empty_string_is_free() {
        let mut m = Measurer::new().expect("font manager");
        assert_eq!(m.advance("", 16.0, 400), 0.0);
    }
}
