//! Proves the pieces the Rust engine needs, before committing to the rewrite:
//!
//!   1. skia-safe builds and links.
//!   2. A raster surface can be created and drawn into.
//!   3. **SkParagraph is available** — the reason to prefer skia-safe over calling
//!      libSkiaSharp's C API from Rust. This is what would solve A2's text
//!      wrapping, ellipsis, bidi and font fallback rather than hand-rolling them.

use skia_safe::textlayout::{FontCollection, ParagraphBuilder, ParagraphStyle, TextStyle};
use skia_safe::{surfaces, Color, Font, FontMgr, FontStyle, Paint, Rect};

fn main() {
    println!("skia-safe probe\n");

    // 1 & 2 — raster surface and basic drawing.
    let mut surface = surfaces::raster_n32_premul((320, 160)).expect("raster surface");
    let canvas = surface.canvas();
    canvas.clear(Color::from_argb(255, 24, 24, 27));

    let mut paint = Paint::default();
    paint.set_anti_alias(true);
    paint.set_color(Color::from_argb(255, 59, 130, 246));
    canvas.draw_round_rect(Rect::from_xywh(16.0, 16.0, 120.0, 40.0), 8.0, 8.0, &paint);
    println!("  ok    raster surface + rounded rect");

    // Text metrics through the plain font API.
    let mgr = FontMgr::new();
    let typeface = mgr
        .match_family_style("Segoe UI", FontStyle::normal())
        .or_else(|| mgr.match_family_style("Arial", FontStyle::normal()))
        .expect("a system typeface");
    let font = Font::new(typeface.clone(), 16.0);
    let (advance, _) = font.measure_str("Hello", Some(&paint));
    println!("  ok    font manager + measure_str(\"Hello\") = {advance:.2}px");

    // 3 — SkParagraph: the actual reason for choosing skia-safe.
    let mut fonts = FontCollection::new();
    fonts.set_default_font_manager(FontMgr::new(), None);

    let mut para_style = ParagraphStyle::new();
    let mut text_style = TextStyle::new();
    text_style.set_font_size(14.0);
    text_style.set_font_families(&["Segoe UI", "Arial"]);
    para_style.set_text_style(&text_style);

    let mut builder = ParagraphBuilder::new(&para_style, fonts);
    builder.add_text(
        "SkParagraph handles line breaking, ellipsis, bidi and font fallback — \
         which is most of the hard part of text layout.",
    );

    let mut paragraph = builder.build();
    paragraph.layout(280.0);

    println!(
        "  ok    SkParagraph: {} lines, height {:.1}px, longest line {:.1}px",
        paragraph.line_number(),
        paragraph.height(),
        paragraph.longest_line(),
    );

    // Ellipsis, which A2 needs and we would otherwise hand-roll.
    let mut clip_style = ParagraphStyle::new();
    clip_style.set_text_style(&text_style);
    clip_style.set_max_lines(1);
    clip_style.set_ellipsis("…");

    let mut fonts2 = FontCollection::new();
    fonts2.set_default_font_manager(FontMgr::new(), None);
    let mut b2 = ParagraphBuilder::new(&clip_style, fonts2);
    b2.add_text("A very long single line that should be truncated with an ellipsis");
    let mut p2 = b2.build();
    p2.layout(160.0);
    println!(
        "  ok    ellipsis: {} line, height {:.1}px, exceeded max lines = {}",
        p2.line_number(),
        p2.height(),
        p2.did_exceed_max_lines(),
    );

    println!("\nverdict: skia-safe usable, SkParagraph available");
}
