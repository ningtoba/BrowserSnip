#!/usr/bin/env python3
"""Read the `pdf-crop` unit outputs back out of the files, with an outside tool.

    python3 docs/research/crop-units-read.py
    python3 docs/research/crop-units-read.py /tmp/deployed/crop-units-pt.pdf ...

Nothing here uses this app's object model: `pypdf` parses the file and reports the page
boxes, so a helper that is wrong in the same way twice cannot hide a defect. With no
arguments this reads the files `tests/pdf/crop-units.test.ts` writes into
`docs/research/`; a probe that cropped on the deployed site passes the downloads it
saved and asks the same questions of them.

The four unit files are **one physical region** — 21.6 / 28.8 / 43.2 / 57.6 pt off the
top / right / bottom / left — declared once per unit:

    pt  21.6   28.8   43.2   57.6
    mm  7.62   10.16  15.24  20.32
    cm  0.762  1.016  1.524  2.032
    in  0.3    0.4    0.6    0.8

each exact in its own unit, because an inch is 72 pt and 25.4 mm. They crop a four-sheet
document: a 500 x 970 page whose `/MediaBox` starts at 18,24, an A4 sheet, a US Letter
sheet, and a 400 x 700 sheet carrying `/Rotate 90`. A file named `*panel*` is the other
case — the crop panel with the unit set to millimetres and 5 / 10 / 15 / 20 typed into
the four boxes of a 500 x 900 sheet — and it must equal that region in points.

Why those sheets: on a square page a top/left transposition cancels itself out, and a
margin mixed up between 72 pt-per-inch and 25.4 mm-per-inch reads plausible on US Letter
and wrong on A4. So every sheet is checked against its own expected box, corner by
corner, and the four margins are pairwise distinct so an edge swap cannot hide in an area.

Why a tolerance: `pdf-crop` writes the box rounded to a tenth of a point, so two runs
that agree can still print differently in the last bit of a double. TOLERANCE is that
rounding — a unit that was ignored moves a corner by tens of points.
"""

import sys
from pathlib import Path

from pypdf import PdfReader

SIDES = ("top", "right", "bottom", "left")
# One region, declared four ways. Every row converts to the first.
DECLARED = {
    "pt": (21.6, 28.8, 43.2, 57.6),
    "mm": (7.62, 10.16, 15.24, 20.32),
    "cm": (0.762, 1.016, 1.524, 2.032),
    "in": (0.3, 0.4, 0.6, 0.8),
}
PT_PER = {"pt": 1.0, "mm": 72 / 25.4, "cm": 72 / 2.54, "in": 72.0}
# originX, originY, width, height of each sheet's own /MediaBox, in file order.
SHEETS = [(18, 24, 500, 970), (0, 0, 595.28, 841.89), (0, 0, 612, 792), (0, 0, 400, 700)]
# The panel case: 5 / 10 / 15 / 20 mm typed on a single 500 x 900 sheet.
PANEL_SHEET = (0, 0, 500, 900)
PANEL_MM = (5.0, 10.0, 15.0, 20.0)
TOLERANCE = 0.06

HERE = Path(__file__).resolve().parent
LOCAL = [HERE / f"crop-units-{unit}.pdf" for unit in DECLARED] + [HERE / "crop-units-panel.pdf"]


def unit_of(path: Path) -> str:
    """Which spelling this file carries: a unit, or `panel` for the typed entry."""
    if "panel" in path.name:
        return "panel"
    for unit in DECLARED:
        if path.name.endswith(f"{unit}.pdf"):
            return unit
    raise SystemExit(f"{path.name}: the name says neither pt/mm/cm/in nor panel")


def expectation(path: Path) -> tuple[list[float], list[tuple[int, int, int, int]]]:
    """The margins in points this file should show, and the sheets it was applied to."""
    unit = unit_of(path)
    if unit == "panel":
        return [value * PT_PER["mm"] for value in PANEL_MM], [PANEL_SHEET]
    return [value * PT_PER[unit] for value in DECLARED[unit]], SHEETS


def wanted_box(sheet: tuple[int, int, int, int], margins: list[float]) -> list[float]:
    """The box one set of point margins leaves of one sheet: [x0, y0, x1, y1]."""
    ox, oy, width, height = sheet
    top, right, bottom, left = margins
    return [ox + left, oy + bottom, ox + width - right, oy + height - top]


def boxes_of(path: Path) -> list[tuple[list[float], list[float]]]:
    """`(/MediaBox, /CropBox)` per page, as corners — the extent form hides a bad origin."""
    return [
        ([float(v) for v in page.mediabox], [float(v) for v in page.cropbox])
        for page in PdfReader(path).pages
    ]


def flatten(pages: list[tuple[list[float], list[float]]]) -> list[float]:
    return [value for media, crop in pages for value in (*media, *crop)]


def check(path: Path) -> tuple[list[str], list[float]]:
    """Print one file's answer; return its failures and its boxes for the cross-check."""
    unit = unit_of(path)
    margins, sheets = expectation(path)
    want = [wanted_box(sheet, margins) for sheet in sheets]
    got = boxes_of(path)
    spelled = "the panel, with millimetres typed" if unit == "panel" else f"declared in {unit}"
    print(f"{path.name} — {spelled}: {[round(v, 2) for v in margins]} pt off each edge")
    problems: list[str] = []
    if len(got) != len(want):
        problems.append(f"{len(got)} sheets in the file, {len(want)} expected")
    for index, ((media, crop), want_box) in enumerate(zip(got, want, strict=False)):
        drift = max((abs(a - b) for a, b in zip(media, want_box, strict=True)), default=0.0)
        split = max((abs(a - b) for a, b in zip(media, crop, strict=True)), default=0.0)
        print(
            f"   sheet {index + 1}: /MediaBox {media}  /CropBox {crop}  "
            f"worst corner {drift:.3f} pt  "
            + ("/MediaBox = /CropBox" if split == 0 else f"the two boxes differ by {split:.2f} pt")
        )
        if drift > TOLERANCE:
            problems.append(f"sheet {index + 1} is {drift:.2f} pt away from the region asked for")
        if split > 0:
            problems.append(f"sheet {index + 1}: /CropBox is not the box /MediaBox holds")
    return [f"{path.name}: {problem}" for problem in problems], flatten(got)


def main() -> int:
    paths = [Path(argument) for argument in sys.argv[1:]] or LOCAL
    failures: list[str] = []
    seen: dict[str, list[float]] = {}
    for path in paths:
        if not path.exists():
            failures.append(f"{path} is missing")
            continue
        problems, values = check(path)
        failures += problems
        unit = unit_of(path)
        if unit == "panel":
            continue
        # The claim the routing pass asked to be proved: one region, four spellings, one
        # box. Compared against the first spelling as well as against the arithmetic, so a
        # wrong expectation cannot flatter all four at once.
        for first_unit, first in seen.items():
            drift = max(
                (abs(a - b) for a, b in zip(values, first, strict=False)),
                default=float("inf"),
            )
            if len(values) != len(first) or drift > TOLERANCE:
                failures.append(f"{path.name} differs from the {first_unit} run by {drift:.2f} pt")
        seen.setdefault(unit, values)

    print()
    if failures:
        print("FAIL")
        for line in failures:
            print(f"  {line}")
        return 1
    print(
        f"OK: {len(paths)} file(s) read back as asked. The unit spellings of one region "
        f"wrote the same /MediaBox and /CropBox on all {len(SHEETS)} sheets (an offset "
        "page, A4, US Letter and a /Rotate 90 sheet), within the file's own rounding of "
        f"{TOLERANCE} pt, and the panel's millimetre entry wrote the same region "
        "converted to points."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
