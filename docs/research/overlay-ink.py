#!/usr/bin/env python3
"""Overlay ink: does the stamp's ink arrive *and* does the base's ink survive?

Every claim about `overlay-pdf` is made here, on pixels rendered from the files
themselves, against the untouched fixtures measured the same way. Regions are
derived from the two inputs, never guessed: `stamp-only` is dark in the stamp and
white in the base, `base-only` the reverse, `both` dark in both.

    python3 docs/research/overlay-ink.py --base B --stamp S --out O --page 1
    python3 docs/research/overlay-ink.py --base B --out O --identical
    python3 docs/research/overlay-ink.py --base B --stamp S --out O --page 4 --bbox

`--identical` is the control for an empty stamp page: every pixel of every page of
the output must equal the base's, at the same dpi.

Ink is "grey below 200" on a white sheet, counted on a `get_pixmap` render, so a
blank sheet counts 0 and a 0 that is not distinguished from a blank render is not
an instrument.
"""
import argparse
import json
import sys

import pymupdf

DARK = 200


def render(path, page):
    doc = pymupdf.open(path)
    pix = doc[page].get_pixmap(dpi=72, colorspace=pymupdf.csGRAY)
    return pix


def mask(pix):
    s = pix.samples
    w = pix.width
    return [[s[y * w + x] < DARK for x in range(w)] for y in range(pix.height)]


def bbox(m):
    xs = [x for row in m for x, v in enumerate(row) if v]
    ys = [y for y, row in enumerate(m) if any(row)]
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def ink(m, box=None):
    n = 0
    for y, row in enumerate(m):
        for x, v in enumerate(row):
            if not v:
                continue
            if box and not (box[0] <= x <= box[2] and box[1] <= y <= box[3]):
                continue
            n += 1
    return n


def grey_mean(pix, box):
    """Mean ink level inside a box (255 = paper, 0 = solid), for opacity work."""
    vals = []
    for y in range(box[1], box[3] + 1):
        for x in range(box[0], box[2] + 1):
            vals.append(pix.samples[y * pix.width + x])
    return round(sum(vals) / max(1, len(vals)), 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base")
    ap.add_argument("--stamp")
    ap.add_argument("--out", required=True)
    ap.add_argument("--page", type=int, default=0)
    ap.add_argument("--identical", action="store_true")
    ap.add_argument("--bbox", action="store_true")
    ap.add_argument("--region", help="x0,y0,x1,y1: report ink and mean level inside it")
    args = ap.parse_args()

    if args.identical:
        base = pymupdf.open(args.base)
        out = pymupdf.open(args.out)
        rows = []
        for i in range(base.page_count):
            a = base[i].get_pixmap(dpi=72, colorspace=pymupdf.csGRAY)
            b = out[i].get_pixmap(dpi=72, colorspace=pymupdf.csGRAY)
            same = a.samples == b.samples
            diff = sum(1 for x, y in zip(a.samples, b.samples, strict=True) if abs(x - y) > 8)
            rows.append({"page": i + 1, "size_match": (a.width, a.height) == (b.width, b.height),
                         "pixel_identical": same, "pixels_off": diff})
        print(json.dumps({"case": "identical", "pages": rows}))
        return 0 if all(r["pixel_identical"] for r in rows) else 1

    base_pix = render(args.base, args.page)
    out_pix = render(args.out, args.page)
    if base_pix.width != out_pix.width or base_pix.height != out_pix.height:
        print(json.dumps({"case": "geometry", "base": (base_pix.width, base_pix.height),
                          "out": (out_pix.width, out_pix.height)}))
        return 2
    base_m = mask(base_pix)
    out_m = mask(out_pix)

    if args.region:
        box = tuple(int(n) for n in args.region.split(","))
        print(json.dumps({"case": "region", "box": box, "base_ink": ink(base_m, box),
                          "out_ink": ink(out_m, box), "base_mean": grey_mean(base_pix, box),
                          "out_mean": grey_mean(out_pix, box)}))
        return 0

    if args.bbox:
        print(json.dumps({"case": "bbox", "base": bbox(base_m), "out": bbox(out_m)}))
        return 0

    stamp_pix = render(args.stamp, args.page)
    stamp_m = mask(stamp_pix)

    # The base page is the frame the tool draws into, but the stamp's own sheet can
    # be any size: measured, `colour.pdf`'s `/Rotate 90` side renders 595 × 420 px at
    # 72 dpi while `sheets.pdf` page 4 is 420 × 595, and indexing the base mask by the
    # stamp's row length raised `IndexError` — the checker died instead of reporting.
    # Walk the shared raster and count the stamp's overhang separately, so a size
    # mismatch is a number in the report rather than a crash or a silently dropped band.
    regions = {"stamp_only": [], "base_only": [], "both": []}
    overhang = 0
    for y, row in enumerate(stamp_m):
        for x, v in enumerate(row):
            if y >= len(base_m) or x >= len(base_m[y]):
                overhang += 1 if v else 0
                continue
            if v and not base_m[y][x]:
                regions["stamp_only"].append((x, y))
            elif base_m[y][x] and not v:
                regions["base_only"].append((x, y))
            elif base_m[y][x] and v:
                regions["both"].append((x, y))

    def hits(points, m):
        return sum(1 for x, y in points if y < len(m) and x < len(m[y]) and m[y][x])

    report = {
        "case": "regions",
        "page": args.page + 1,
        "base_raster": [base_pix.width, base_pix.height],
        "stamp_raster": [stamp_pix.width, stamp_pix.height],
        "stamp_pixels_outside_base_raster": overhang,
    }
    for name, pts in regions.items():
        report[name] = {
            "n": len(pts),
            "base": hits(pts, base_m),
            "out": hits(pts, out_m),
            "stamp": hits(pts, stamp_m) if name != "base_only" else 0,
        }
    sb = bbox(stamp_m)
    report["stamp_bbox"] = sb
    report["out_bbox"] = bbox(out_m)
    if sb:
        report["paper_mean_inside_stamp_bbox"] = grey_mean(out_pix, sb)
    print(json.dumps(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
