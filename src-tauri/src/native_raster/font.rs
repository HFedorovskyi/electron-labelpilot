use ab_glyph::{Font, FontArc, PxScale};
use rustybuzz::{Face, GlyphBuffer, UnicodeBuffer};
use std::ops::Deref;
use std::sync::OnceLock;

pub(super) struct RasterFont {
    outline: FontArc,
    shaper: Face<'static>,
}

impl RasterFont {
    fn embedded(bytes: &'static [u8]) -> Self {
        Self {
            outline: FontArc::try_from_slice(bytes).expect("embedded label outline font"),
            shaper: Face::from_slice(bytes, 0).expect("embedded label OpenType font"),
        }
    }

    pub(super) fn shape(&self, text: &str) -> GlyphBuffer {
        let mut buffer = UnicodeBuffer::new();
        buffer.push_str(text);
        // Apply the same OpenType positioning and ligatures as browser text.
        // Inter has GPOS kerning, not the legacy `kern` table read by ab_glyph.
        buffer.guess_segment_properties();
        rustybuzz::shape(&self.shaper, &[], buffer)
    }
}

impl Deref for RasterFont {
    type Target = FontArc;
    fn deref(&self) -> &Self::Target {
        &self.outline
    }
}

struct FontCatalog {
    inter_regular: RasterFont,
    inter_bold: RasterFont,
    montserrat: RasterFont,
    roboto: RasterFont,
    ubuntu_regular: RasterFont,
    ubuntu_bold: RasterFont,
}

fn fonts() -> &'static FontCatalog {
    static FONTS: OnceLock<FontCatalog> = OnceLock::new();
    FONTS.get_or_init(|| FontCatalog {
        inter_regular: RasterFont::embedded(include_bytes!(
            "../../../resources/fonts/Inter-Regular.ttf"
        )),
        inter_bold: RasterFont::embedded(include_bytes!("../../../resources/fonts/Inter-Bold.ttf")),
        montserrat: RasterFont::embedded(include_bytes!(
            "../../../resources/fonts/Montserrat-Variable.ttf"
        )),
        roboto: RasterFont::embedded(include_bytes!(
            "../../../resources/fonts/Roboto-Variable.ttf"
        )),
        ubuntu_regular: RasterFont::embedded(include_bytes!(
            "../../../resources/fonts/Ubuntu-Regular.ttf"
        )),
        ubuntu_bold: RasterFont::embedded(include_bytes!(
            "../../../resources/fonts/Ubuntu-Bold.ttf"
        )),
    })
}

pub(crate) fn warmup_static_assets() -> usize {
    let fonts = fonts();
    [
        &fonts.inter_regular,
        &fonts.inter_bold,
        &fonts.montserrat,
        &fonts.roboto,
        &fonts.ubuntu_regular,
        &fonts.ubuntu_bold,
    ]
    .len()
}

pub(super) fn font_for(family: &str, bold: bool) -> &'static RasterFont {
    let fonts = fonts();
    match family.trim().to_ascii_lowercase().as_str() {
        "montserrat" => &fonts.montserrat,
        "roboto" => &fonts.roboto,
        "ubuntu" if bold => &fonts.ubuntu_bold,
        "ubuntu" => &fonts.ubuntu_regular,
        _ if bold => &fonts.inter_bold,
        _ => &fonts.inter_regular,
    }
}

/// CSS px are pixels per em; ab_glyph's PxScale is ascent minus descent.
/// Keep this conversion at the font boundary, not in label coordinates or DPI.
pub(super) fn css_px_scale(font: &RasterFont, pixels_per_em: f32) -> PxScale {
    PxScale::from(
        pixels_per_em * font.height_unscaled()
            / font
                .units_per_em()
                .expect("embedded label font units per em"),
    )
}
