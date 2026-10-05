// Report PDF resource tests (included from report_pdf.rs).
use super::*;
use std::io::Read as _;

fn inflate(data_base64: &str) -> Vec<u8> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .unwrap();
    let mut out = vec![];
    flate2::read::ZlibDecoder::new(&data[..])
        .read_to_end(&mut out)
        .unwrap();
    out
}

fn cps(text: &str) -> Vec<u32> {
    text.chars().map(u32::from).collect()
}

#[test]
fn fallback_fonts_cover_greek_cyrillic_cjk_and_symbols() {
    for ch in ['Ω', 'λ', 'Ж', 'я', '→', '✓', '∑', '≤', 'ő', 'Ł'] {
        assert_eq!(
            glyph_for(ch.into()).map(|g| g.0),
            Some(0),
            "{ch} in DejaVu Sans"
        );
    }
    for ch in ['漢', '字', 'あ', 'カ', '中'] {
        assert_eq!(
            glyph_for(ch.into()).map(|g| g.0),
            Some(1),
            "{ch} in Droid Sans Fallback"
        );
    }
    // Helvetica prints WinAnsi; right-to-left scripts and controls are not drawn.
    for ch in ['A', 'é', '€', '—', '\u{1}', 'א', 'ع'] {
        assert_eq!(glyph_for(ch.into()), None, "{ch:?} has no fallback glyph");
    }
}

#[test]
fn font_subsets_embed_only_used_glyphs_deterministically() {
    let text = cps("Ωμέγα Жук 漢字 → Ω");
    let fonts = font_subsets(&text).unwrap();
    assert_eq!(
        fonts,
        font_subsets(&text).unwrap(),
        "same input, same bytes"
    );
    assert_eq!(
        fonts.iter().map(|f| f.index).collect::<Vec<_>>(),
        vec![0, 1]
    );
    let dejavu = &fonts[0];
    assert!(dejavu.base_font.ends_with("+DejaVuSans"));
    assert_eq!(dejavu.base_font.find('+'), Some(6));
    // Ω appears twice in the input but once in the subset.
    let used: Vec<u32> = dejavu.glyphs.iter().map(|g| g.code_point).collect();
    assert_eq!(used, cps("ΩέαγμЖку→"));
    let cids: Vec<u16> = dejavu.glyphs.iter().map(|g| g.cid).collect();
    assert!(cids.iter().all(|&c| c > 0), "no glyph maps to .notdef");
    let program = inflate(&dejavu.data_base64);
    assert_eq!(program.len(), dejavu.length1);
    let face = ttf_parser::Face::parse(&program, 0).unwrap();
    // .notdef, nine glyphs, and the components of composite glyphs (έ).
    assert!((10..20).contains(&face.number_of_glyphs()));
    assert!(program.len() < 20_000, "subset, not the whole font");
    let cjk = &fonts[1];
    assert_eq!(
        cjk.glyphs.iter().map(|g| g.width).collect::<Vec<_>>(),
        vec![1000, 1000]
    );
    assert!(font_subsets(&cps("plain ASCII")).unwrap().is_empty());
}

#[test]
fn glyph_widths_use_the_font_advance_in_thousandths() {
    let (font, gid) = glyph_for('Ω'.into()).unwrap();
    let face = &faces()[font];
    let advance = face.glyph_hor_advance(ttf_parser::GlyphId(gid)).unwrap();
    assert_eq!(
        glyph_width(font, gid),
        (f64::from(advance) * 1000.0 / 2048.0).round() as i32
    );
    assert_eq!(per_mille(1, 2048), 0);
    assert_eq!(per_mille(-205, 256), -801);
}

/// Width runs the TS layout engine measures with (src/reports/engine/fallback-metrics.ts).
fn metrics_source() -> String {
    let mut runs: Vec<(u32, u32, usize, i32)> = vec![];
    for cp in 0x100..=0x10ffff_u32 {
        let Some((font, gid)) = glyph_for(cp) else {
            continue;
        };
        let width = glyph_width(font, gid);
        match runs.last_mut() {
            Some(r) if r.0 + r.1 == cp && r.2 == font && r.3 == width => r.1 += 1,
            _ => runs.push((cp, 1, font, width)),
        }
    }
    let mut end = 0;
    let encoded: Vec<String> = runs
        .iter()
        .map(|&(start, len, font, width)| {
            let gap = start - end;
            end = start + len;
            [gap, len, font as u32, width as u32]
                .iter()
                .map(|v| radix36(*v))
                .collect::<Vec<_>>()
                .join(",")
        })
        .collect();
    format!(
        "/**\n * Generated from src-tauri/fonts by `UPDATE_GOLDENS=1 cargo test --lib report_pdf`;\n * do not edit. Characters outside WinAnsi that the bundled fallback fonts\n * print, as runs of consecutive code points with one font and one advance\n * width. Each run is `gap,length,font,width` in base 36: `gap` counts code\n * points since the previous run ended (the first run counts from 0), `font`\n * indexes FALLBACK_FONTS, and `width` is in 1/1000 em.\n */\nexport const FALLBACK_FONTS = [{FONTS}] as const;\n\nexport const FALLBACK_RUNS =\n  \"{}\";\n",
        encoded.join(" "),
        FONTS = FONTS
            .iter()
            .map(|(name, _)| format!("\"{name}\""))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

fn radix36(mut v: u32) -> String {
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = vec![];
    loop {
        out.push(digits[(v % 36) as usize]);
        v /= 36;
        if v == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

#[test]
fn layout_metrics_table_matches_the_bundled_fonts() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../src/reports/engine/fallback-metrics.ts");
    let expected = metrics_source();
    if std::env::var("UPDATE_GOLDENS").as_deref() == Ok("1") {
        std::fs::write(&path, &expected).unwrap();
    }
    let actual = std::fs::read_to_string(&path)
        .unwrap()
        .replace("\r\n", "\n");
    assert!(
        actual == expected,
        "fallback-metrics.ts is stale; run UPDATE_GOLDENS=1 cargo test --lib report_pdf"
    );
}

fn encode_png(color: png::ColorType, depth: png::BitDepth, w: u32, h: u32, data: &[u8]) -> Vec<u8> {
    encode_png_with(color, depth, w, h, data, |_| {})
}

fn encode_png_with(
    color: png::ColorType,
    depth: png::BitDepth,
    w: u32,
    h: u32,
    data: &[u8],
    setup: impl FnOnce(&mut png::Encoder<&mut Vec<u8>>),
) -> Vec<u8> {
    let mut out = vec![];
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(color);
        enc.set_depth(depth);
        setup(&mut enc);
        let mut writer = enc.write_header().unwrap();
        writer.write_image_data(data).unwrap();
    }
    out
}

#[test]
fn rgba_png_splits_into_color_and_soft_mask() {
    let pixels = [255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 9, 9, 9, 255];
    let bytes = encode_png(png::ColorType::Rgba, png::BitDepth::Eight, 2, 2, &pixels);
    let img = decode_png(&bytes).unwrap();
    assert_eq!((img.width, img.height, img.colors), (2, 2, 3));
    assert_eq!(
        inflate(&img.color_base64),
        vec![255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]
    );
    assert_eq!(
        inflate(img.alpha_base64.as_deref().unwrap()),
        vec![255, 128, 0, 255]
    );
    assert_eq!(decode_png(&bytes), Some(img), "deterministic");
}

#[test]
fn opaque_and_gray_alpha_pngs() {
    let opaque = encode_png(
        png::ColorType::Rgba,
        png::BitDepth::Eight,
        1,
        1,
        &[1, 2, 3, 255],
    );
    let img = decode_png(&opaque).unwrap();
    assert_eq!(img.alpha_base64, None, "no mask when every pixel is opaque");
    assert_eq!(inflate(&img.color_base64), vec![1, 2, 3]);

    let gray = encode_png(
        png::ColorType::GrayscaleAlpha,
        png::BitDepth::Sixteen,
        1,
        1,
        &[0x80, 0x01, 0x40, 0x02],
    );
    let img = decode_png(&gray).unwrap();
    assert_eq!(img.colors, 1);
    assert_eq!(
        inflate(&img.color_base64),
        vec![0x80],
        "16-bit samples keep the high byte"
    );
    assert_eq!(inflate(img.alpha_base64.as_deref().unwrap()), vec![0x40]);
}

#[test]
fn palette_png_with_transparency_expands_to_rgb_and_mask() {
    let bytes = encode_png_with(
        png::ColorType::Indexed,
        png::BitDepth::Eight,
        2,
        1,
        &[0, 1],
        |enc| {
            enc.set_palette(vec![10, 20, 30, 40, 50, 60]);
            enc.set_trns(vec![0]);
        },
    );
    let img = decode_png(&bytes).unwrap();
    assert_eq!(img.colors, 3);
    assert_eq!(inflate(&img.color_base64), vec![10, 20, 30, 40, 50, 60]);
    assert_eq!(inflate(img.alpha_base64.as_deref().unwrap()), vec![0, 255]);
    assert_eq!(decode_png(b"not a png"), None);
}
