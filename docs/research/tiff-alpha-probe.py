#!/usr/bin/env python3
"""Who is wrong about a TIFF's alpha: the writer of the PDF or the reader of it?

    python3 docs/research/tiff-alpha-probe.py                       # the semantics table
    python3 docs/research/tiff-alpha-probe.py SRC.tif OUT.pdf [sheet]  # the ±2 cross-prove

**The table** builds seven one-page PDFs — a white sheet with one masked pixel of
colour `C` and `/SMask` value `A` — and asks MuPDF what it paints. If `/SMask` were
*associated* (premultiplied) alpha the answer would be `C + (1−a)·255`; if it is the
*separated* alpha PDF defines (ISO 32000-1 §11.3.3.4 composites a source colour with a
separate α) the answer is `C·a + 255·(1−a)`. Every pair answers the second way, so a
writer that ships already-premultiplied colour beside a mask charges the alpha twice.

**The cross-prove** takes the source TIFF and the PDF this app made from it and
compares them where the two can be compared: MuPDF's render of the produced page at
72 dpi (one pixel per image pixel — the rail sizes the sheet from the pixels) against
PIL's flatten of the source onto white, pixel for pixel, printing the worst channel
difference and how many pixels are off by more than 2.

The app's own bytes come from a real tab:

    DIR=/tmp/r73 CASES=alpha TAG=after PORT=9821 \
      node docs/research/tiff-to-pdf-round.mjs

which writes `/tmp/r73/after-alpha.pdf` from `/tmp/r73/alpha-assoc.tif` (built by
`docs/research/tiff-to-pdf-fixtures.py`; `alpha-plain.tif` is the same pixels tagged
`ExtraSamples = 2`, the control that must *not* be corrected).
"""
from __future__ import annotations

import os
import re
import sys
import tempfile

import fitz  # PyMuPDF
import numpy as np
from PIL import Image

PAIRS = [(200, 200), (128, 128), (255, 200), (200, 255), (51, 51), (204, 102), (220, 200)]


def masked_page(path: str, colour: int, mask: int) -> None:
    """A 2×2 pt white page drawing one 2×2 px image with a `/SMask` of `mask`."""
    import zlib

    def stream(data: bytes) -> bytes:
        return zlib.compress(data)

    ci, cm = stream(bytes([colour]) * 12), stream(bytes([mask]) * 4)
    content = b"1 1 1 rg 0 0 2 2 re f\nq 1 0 0 1 0 0 cm /Im0 Do Q\n"
    body = [
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
        b"<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /BitsPerComponent 8"
        b" /ColorSpace /DeviceRGB /SMask 3 0 R /Filter /FlateDecode /Length %d >>\nstream\n" % len(ci)
        + ci + b"\nendstream",
        b"<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /BitsPerComponent 8"
        b" /ColorSpace /DeviceGray /Filter /FlateDecode /Length %d >>\nstream\n" % len(cm)
        + cm + b"\nendstream",
        b"<< /XObject << /Im0 2 0 R >> >>",
        b"<< /Type /Page /Parent 6 0 R /MediaBox [0 0 2 2] /Contents 1 0 R /Resources 4 0 R >>",
        b"<< /Type /Pages /Kids [5 0 R] /Count 1 >>",
        b"<< /Type /Catalog /Pages 6 0 R >>",
    ]
    out = bytearray(b"%PDF-1.7\n")
    starts = []
    for index, chunk in enumerate(body, start=1):
        starts.append(len(out))
        out += b"%d 0 obj\n" % index + chunk + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n" % (len(body) + 1) + b"0000000000 65535 f \n"
    for offset in starts:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 7 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(body) + 1, xref)
    open(path, "wb").write(bytes(out))


def semantics() -> None:
    print("C    A  | MuPDF paints | separated C*a+255*(1-a) | associated C+(1-a)*255")
    with tempfile.TemporaryDirectory() as tmp:
        for colour, mask in PAIRS:
            path = os.path.join(tmp, f"sm-{colour}-{mask}.pdf")
            masked_page(path, colour, mask)
            doc = fitz.open(path)
            # The 2×2 pt sheet holds one image pixel per device pixel at 288 dpi; the
            # painted corner is the darkest one (paper elsewhere).
            pix = doc[0].get_pixmap(dpi=288, colorspace=fitz.csGRAY, clip=doc[0].rect)
            seen = int(np.frombuffer(pix.samples, dtype=np.uint8).min())
            a = mask / 255
            separated = round(colour * a + 255 * (1 - a))
            associated = min(255, round(colour + 255 * (1 - a)))
            verdict = "separated" if abs(seen - separated) <= 2 else (
                "associated" if abs(seen - associated) <= 2 else "neither")
            print(f"{colour:3} {mask:3} | {seen:12} | {separated:23} | {associated:24}  -> {verdict}")


def compare(source: str, produced: str, sheet: int = 1, dpi: int = 72) -> None:
    """One sheet of the produced PDF against the source TIFF flattened onto white."""
    image = Image.open(source).convert("RGBA")
    paper = Image.new("RGB", image.size, (255, 255, 255))
    paper.paste(image, (0, 0), image)
    want = np.asarray(paper).astype(int)
    doc = fitz.open(produced)
    print(f"{source} -> {produced} sheet {sheet} of {doc.page_count}: source {image.size[0]}x{image.size[1]}")
    page = doc[sheet - 1]
    pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csRGB, clip=page.rect)
    got = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)[..., :3].astype(int)
    if got.shape[:2] != want.shape[:2]:
        print(f"  size {got.shape[1]}x{got.shape[0]} vs source {want.shape[1]}x{want.shape[0]} "
              f"— the sheet is not one point per pixel, compare at the sheet's own dpi")
        return
    delta = np.abs(got - want).max(axis=2)
    print(f"  max channel diff {int(delta.max())} | pixels off by >2: {int((delta > 2).sum())} of {delta.size}"
          f" | paints {tuple(int(v) for v in got[0, 0])} where the source flattens to "
          f"{tuple(int(v) for v in want[0, 0])}")


if __name__ == "__main__":
    semantics()
    if len(sys.argv) > 2:
        compare(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 1)
    else:
        print("pass SRC.tif OUT.pdf to cross-prove a produced file (see the header)")
