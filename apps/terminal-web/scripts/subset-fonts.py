#!/usr/bin/env python3
"""Makes the web app's own font files (apps/terminal-web/src/fonts), served from Aviary's origin.

Archivo (wdth and wght axes, upright and italic) and Literata (opsz and wght) are taken whole from
Google Fonts' repository (https://github.com/google/fonts at 06bfe0d, ofl/archivo and ofl/literata), under the
SIL Open Font License 1.1, and cut to the characters Aviary writes: Latin, general punctuation, the
subscript digits that prices count their zeros with ("0.0₇2307"), arrows and a few signs. Every
OpenType feature is kept, tabular figures included.

    python3 scripts/subset-fonts.py <folder holding the four downloaded files>

needs fonttools and brotli (pip install fonttools brotli).
"""
import pathlib
import sys

from fontTools import subset

UNICODES = (
    "U+0000-00FF,U+0100-017F,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,"
    "U+0304,U+0308,U+0329,U+2000-206F,U+2080-2089,U+20AC,U+2122,U+2190-2193,U+2212,U+2215,"
    "U+FEFF,U+FFFD"
)

FONTS = {
    "Archivo[wdth,wght].ttf": "archivo-upright.woff2",
    "Archivo-Italic[wdth,wght].ttf": "archivo-italic.woff2",
    "Literata[opsz,wght].ttf": "literata-upright.woff2",
}


def main() -> None:
    source = pathlib.Path(sys.argv[1])
    out = pathlib.Path(__file__).resolve().parent.parent / "src" / "fonts"
    for name, target in FONTS.items():
        options = subset.Options()
        options.flavor = "woff2"
        options.layout_features = ["*"]
        options.name_IDs = ["*"]
        options.notdef_outline = True
        font = subset.load_font(str(source / name), options)
        subsetter = subset.Subsetter(options)
        subsetter.populate(unicodes=subset.parse_unicodes(UNICODES))
        subsetter.subset(font)
        subset.save_font(font, str(out / target), options)
        print(f"{target}: {(out / target).stat().st_size} bytes")


if __name__ == "__main__":
    main()
