#!/usr/bin/env python3
"""Measure the skew a PDF file actually carries — not the angle a tool reported.

  python3 docs/research/deskew-residual.py [--straight [--tol 0.3] | --expect DEG]
         file.pdf [more.pdf …]

Three numbers per page, all read off the file itself:

* ``lines``  — the median text-line angle, from PyMuPDF's ``dir`` vectors.
* ``profile``— a projection-profile estimate over the **rasterised pixels**
  (100 dpi), independent of any text layer, so a scanned page still answers.
* ``ink``    — non-white coverage, because this campaign's failure mode is a
  plausible file with nothing painted in it.

Both angles use the bitmap convention: y runs **down**, so a page whose text
rises to the right (counterclockwise as it is viewed, i.e. a positive PDF
user-space rotation) reports a **negative** angle. That is the same convention
``core/measure.ts:detectSkew`` answers in, and the sign the deskew bug turned on.

On a page carrying ``/Rotate 90`` or ``270`` the two halves measure different
things and are expected to disagree: PyMuPDF reports text directions in the
*content* frame while the pixels are the *displayed* page, so a 3°-tilted fixture
rotated 90° reads ``lines=+3.00`` and ``profile=-7.80`` (the profile is pinned at
the edge of its ±8° window because the lines run vertically). Read the pixels
there; deskew's own estimate reads them too.

``--straight`` exits 1 unless every page measures within ``--tol`` degrees of 0;
``--expect`` exits 1 unless every page measures within ``--tol`` of DEG. It is a
check, not a printout.
"""
import argparse
import math
import sys
from typing import Any

import numpy as np
import pymupdf

DPI = 100
MAX_ANGLE = 8.0
STEP = 0.1


def line_angles(page: pymupdf.Page):
    """Text-line angles in degrees, bitmap convention (y down)."""
    out = []
    raw = page.get_text("dict")
    if isinstance(raw, str):  # the typed overload; the dict form is what we ask for
        raise SystemExit("get_text('dict') answered with a string")
    data: Any = raw
    for block in data["blocks"]:
        for line in block.get("lines", []):
            ux, uy = line.get("dir") or (1.0, 0.0)
            if abs(ux) < 1e-6 and abs(uy) < 1e-6:
                continue
            angle = math.degrees(math.atan2(uy, ux))
            # Fold to (-90, 90]: a line is undirected.
            if angle > 90:
                angle -= 180
            elif angle <= -90:
                angle += 180
            out.append(angle)
    return out


def raster(page: pymupdf.Page):
    """One grayscale row-major array of the page at ``DPI``, from its pixels."""
    pix = page.get_pixmap(dpi=DPI, colorspace=pymupdf.csGRAY)
    flat = np.frombuffer(pix.samples, dtype=np.uint8)
    per_row = len(flat) // pix.height
    return flat.reshape(pix.height, per_row)[:, : pix.width]


def profile_angle(gray) -> float:
    """Peakiness-maximising angle over the dark pixels, y-down convention."""
    ys, xs = np.nonzero(gray < 200)
    if xs.size < 64:
        return float("nan")
    dx = (xs - xs.mean()).astype(np.float64)
    dy = (ys - ys.mean()).astype(np.float64)
    best_angle, best_score = 0.0, -1.0
    for cand in np.arange(-MAX_ANGLE, MAX_ANGLE + 1e-9, STEP):
        rad = math.radians(cand)
        row = np.round(-dx * math.sin(rad) + dy * math.cos(rad)).astype(np.int64)
        hist = np.bincount(row - row.min())
        mean = hist.mean()
        if mean <= 0:
            continue
        score = float(((hist - mean) ** 2).mean() / (mean * mean))
        if score > best_score:
            best_score, best_angle = score, float(cand)
    return best_angle


def describe(path: str):
    doc = pymupdf.open(path)
    report = []
    for index in range(doc.page_count):
        page = doc[index]
        angles = line_angles(page)
        gray = raster(page)
        ink = float((gray < 245).mean() * 100.0)
        med = float(np.median(angles)) if angles else float("nan")
        prof = profile_angle(gray)
        spread = (max(angles) - min(angles)) if angles else float("nan")
        report.append({"page": index + 1, "lines": med, "spread": spread, "profile": prof, "ink": ink,
                       "count": len(angles)})
        print(f"  p{index + 1:<3} lines={med:6.2f} spread={spread:5.2f} n={len(angles):<4} "
              f"profile={prof:6.2f} ink={ink:5.2f}%")
    doc.close()
    return report


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--straight", action="store_true", help="assert every page measures ~0°")
    ap.add_argument("--expect", type=float, default=None, help="assert every page measures this many degrees")
    ap.add_argument("--tol", type=float, default=0.3)
    ap.add_argument("--min-ink", type=float, default=0.2, help="%% non-white required for a painted page")
    args = ap.parse_args()

    bad = []
    for path in args.files:
        print(f"== {path}")
        for row in describe(path):
            measured = row["lines"] if row["count"] else row["profile"]
            target = 0.0 if args.straight else args.expect
            if target is not None:
                if not math.isfinite(measured) or abs(measured - target) > args.tol:
                    bad.append(f"{path} p{row['page']}: line angle {measured:.2f}°, "
                               f"want {target:.2f}° ± {args.tol}")
                if not math.isfinite(row["profile"]) or abs(row["profile"] - target) > max(args.tol, 0.6):
                    bad.append(f"{path} p{row['page']}: pixel profile {row['profile']:.2f}°, "
                               f"want {target:.2f}° ± {max(args.tol, 0.6)} (text and pixels must agree)")
            if row["ink"] < args.min_ink:
                bad.append(f"{path} p{row['page']}: only {row['ink']:.2f}% ink — nothing was painted")

    if args.straight or args.expect is not None:
        if bad:
            print("FAIL")
            for line in bad:
                print("  " + line)
            return 1
        print(f"OK: every page measures as asked (tol {args.tol}°)")
    elif bad:
        print("FAIL\n  " + "\n  ".join(bad))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
