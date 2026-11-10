#!/usr/bin/env python3
"""Read the `pdf-crop` unit outputs back out of the files, with an outside tool.

The pinned test (`tests/pdf/crop-units.test.ts`) writes these five files; this
script answers the same question through `pypdf` rather than through this app's own
object model, so a helper wrong in the same way twice cannot hide it.

    python3 docs/research/crop-units-read.py

Four of the files are one physical region — 21.6 / 14.4 / 28.8 / 36 pt off the
top / right / bottom / left of three sheets (a 500x900 page whose /MediaBox starts
at 18,24, an A4 sheet, a US Letter sheet) — declared once per unit. They must agree
box for box. The fifth came from the crop panel with the unit set to millimetres and
5 / 10 / 15 / 20 typed into the four boxes; it must agree with the same region
converted the same way.
"""

import sys
from pathlib import Path

from pypdf import PdfReader

HERE = Path(__file__).resolve().parent
REGION_PT = {"top": 21.6, "right": 14.4, "bottom": 28.8, "left": 36.0}
SHEETS = [(18, 24, 500, 900), (0, 0, 595.28, 841.89), (0, 0, 612, 792)]
UNITS = ["pt", "mm", "cm", "in"]
# The panel run: 5 / 10 / 15 / 20 mm on a 500x900 sheet, at the page's own origin.
PANEL_MM = {"top": 5.0, "right": 10.0, "bottom": 15.0, "left": 20.0}
MM_TO_PT = 72 / 25.4


def boxes(name: str):
    reader = PdfReader(HERE / f"crop-units-{name}.pdf")
    out = []
    for page in reader.pages:
        media, crop = page.mediabox, page.cropbox
        out.append(([float(v) for v in media], [float(v) for v in crop]))
    return out


def expected(ox: float, oy: float, width: float, height: float, top: float, right: float, bottom: float, left: float):
    # PDF boxes are [x, y, x1, y1]: the origin moves by the left/bottom margins, the
    # far corner by the right/top ones. Top is never a width and left is never a height.
    return [ox + left, oy + bottom, ox + width - right, oy + height - top]


def close(a, b, at_most=0.05):
    return all(abs(x - y) <= at_most for x, y in zip(a, b, strict=True))


failures = []
reference = None
for unit in UNITS:
    got = boxes(unit)
    want = [
        (
            expected(*sheet, **REGION_PT),
            expected(*sheet, **REGION_PT),
        )
        for sheet in SHEETS
    ]
    print(f"{unit}:")
    for index, (media, crop) in enumerate(got):
        print(f"  sheet {index + 1}  /MediaBox {media}  /CropBox {crop}")
        if not close(media, want[index][0]) or not close(crop, want[index][1]):
            failures.append(f"{unit} sheet {index + 1}: got {media}, expected {want[index][0]}")
    if reference is not None and got != reference:
        failures.append(f"{unit}: its boxes differ from the {UNITS[0]} run — the unit moved the crop")
    reference = got if reference is None else reference

panel = boxes("panel")
want = [
    (
        expected(0, 0, 500, 900, **{k: v * MM_TO_PT for k, v in PANEL_MM.items()}),
        expected(0, 0, 500, 900, **{k: v * MM_TO_PT for k, v in PANEL_MM.items()}),
    )
]
print("panel (unit=mm, typed 5/10/15/20):")
for media, crop in panel:
    print(f"  /MediaBox {media}  /CropBox {crop}")
if not close(panel[0][0], want[0][0], at_most=0.1):
    failures.append(f"panel: got {panel[0][0]}, expected {want[0][0]}")

print()
if failures:
    print("FAIL")
    for line in failures:
        print(f"  {line}")
    sys.exit(1)
print(
    "OK: one region declared in pt, mm, cm and in wrote the same /MediaBox and /CropBox on "
    "all three sheets, and the panel's millimetre entry wrote the same region in points."
)
