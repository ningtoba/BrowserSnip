#!/usr/bin/env python3
"""Byte side of `text-subset-ink.mjs`: per-character ink from a MuPDF paint,
plus a fontTools parse of the embedded subset program. Ink 0 with the text
still extracting is the §3.1 signature; a `glyf` unpack crash is its other face.

    python3 docs/research/text-subset-ink.py /tmp/subset-ink.pdf
"""
import json
import sys

import pymupdf

path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/subset-ink.pdf"
cells = json.load(open(f"{path}.cells.json"))

doc = pymupdf.open(path)
page = doc[0]
pix = page.get_pixmap(dpi=150)
scale = 150 / 72


def ink_in(rect):
    x0, y0, x1, y1 = (int(v * scale) for v in rect)
    count = 0
    for yy in range(y0, y1):
        row = yy * pix.width * pix.n
        for xx in range(x0, x1):
            if pix.samples[row + xx * pix.n] < 200:
                count += 1
    return count


for cell in cells:
    rect = (cell["x"] - 2, 842 - 700 - 30, cell["x"] + cell["w"], 842 - 700 + 12)
    print(f"{cell['ch']!r} ink {ink_in(rect)}")
print("extract:", repr(page.get_text().strip()))

try:
    from fontTools.ttLib import TTFont
    import io

    for x in range(1, doc.xref_length()):
        if doc.xref_get_key(x, "Length1")[0] != "null":
            font = TTFont(io.BytesIO(doc.xref_stream(x)), fontNumber=0)
            glyf, loca = font["glyf"], font["loca"]
            orders = font.getGlyphOrder()
            contours = []
            for name in orders:
                glyph = glyf[name]
                contours.append("comp" if glyph.isComposite() else (glyph.numberOfContours or 0))
            print(
                "fontTools:",
                f"numGlyphs={len(orders)}",
                f"locaFormat={font['head'].indexToLocFormat}",
                f"contours={contours}",
            )
            break
except ImportError:
    print("fontTools not installed — MuPDF ink above is the bar")
