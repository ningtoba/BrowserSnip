#!/usr/bin/env python3
"""Measure what `compare-pdfs` marked, and where — out of the exported file itself.

  python3 docs/research/compare-measure.py --src /tmp/compare/a.pdf \
      --out /tmp/compare/export.pdf --page 1 --rect 40,60,380,100 --tol 2
  python3 docs/research/compare-measure.py --src /tmp/compare/a.pdf \
      --out /tmp/compare/same.pdf --page 1 --no-rect

The campaign's question for this tool is not "is there ink" — the audit row already
answered that with **0.13 % on every page, including the one the source leaves
empty**, which is paper wearing a plausible file name. What settles the row is
**localisation**: a difference planted at a known rectangle has to come back at that
rectangle, in the page's own points, and a pair with no planted difference has to
come back with no marks anywhere. "Everything differs" fails the second half as
hardly as "nothing differs" fails the first.

Coordinates are reported from the **top-left of the produced page as displayed**, in
points (x right, y down) — the space `docs/research/compare-fixture.mjs` plants in
and the space the pane's verdict speaks. PyMuPDF rasterises a page as displayed, so
the mapping is a division by the raster density and a y-flip, nothing else.

Every page is also measured for ink against **its own source sheet at the same
density**, which is the assertion that catches the failure mode a highlight-bbox
check alone cannot see: a tool that marks the right place over a page of paper.
Exits 1 on any failed claim.
"""
import argparse
import json
import sys

import pymupdf

DPI = 150
INK_WHITE = 245       # "non-white", exactly as rail-measure.py counts it
RED_MIN = 60          # R - max(G,B): the highlight is red over paper or over ink
LABEL_INK = 0.35      # pp: the "Page N — comparison" line every export page carries


def ink_and_mark(page, dpi):
    """(non-white %, red-highlight %, red bbox in displayed points) for one sheet."""
    pix = page.get_pixmap(dpi=dpi)
    n = pix.n
    s = pix.samples
    total = pix.width * pix.height
    scale = 72.0 / dpi
    dark = 0
    mark = 0
    x0 = y0 = 10 ** 9
    x1 = y1 = -1
    for y in range(pix.height):
        row = y * pix.width * n
        for x in range(pix.width):
            at = row + x * n
            r, g, b = s[at], s[at + 1], s[at + 2]
            if r < INK_WHITE or g < INK_WHITE or b < INK_WHITE:
                dark += 1
            if r - max(g, b) > RED_MIN:
                mark += 1
                if x < x0:
                    x0 = x
                if x > x1:
                    x1 = x
                if y < y0:
                    y0 = y
                if y > y1:
                    y1 = y
    box = None
    if mark:
        box = (x0 * scale, y0 * scale, (x1 + 1) * scale, (y1 + 1) * scale)
    return {
        "ink": 100.0 * dark / total,
        "mark": 100.0 * mark / total,
        "mark_px": mark,
        "box": box,
        "images": len(page.get_images(full=True)),
        "box_pts": (round(page.rect.width, 1), round(page.rect.height, 1)),
    }


def near(got, want, tol):
    return all(abs(g - w) <= tol for g, w in zip(got, want, strict=True))


def check_verdict(args, verdict):
    """Judge the pane's own numbers against the planted rectangle.

    `read` is the first thing checked, because the defect this row found was a verdict
    of “nothing differs” published by a comparison that never reached a canvas: with
    no `read` flag, 0 changed pixels meant two opposite things and the panel chose the
    reassuring one.
    """
    notes = []
    fails = []
    areas = verdict.get("areas") or []
    pixels = verdict.get("pixels")
    if not verdict.get("read"):
        fails.append("the pane published no verdict: it says its sheets were never read")
    if args.rect and not args.no_rect:
        rx0, ry0, rx1, ry1 = (float(v) for v in args.rect.split(","))
        want = (rx0, ry0, rx1, ry1)
        if not pixels:
            fails.append(f"the verdict reports 0 changed pixels against a difference planted at {want}")
        if not areas:
            fails.append("the verdict names no changed area, so the user cannot check where it looked")
        else:
            got = tuple(areas[0])
            worst = max(abs(g - w) for g, w in zip(got, want, strict=True))
            notes.append(f"   verdict area {got} against the planted {want} — edges off by {worst:.1f} pt")
            if not near(got, want, args.tol):
                fails.append(f"the verdict's area is not where the difference was planted: {got} vs {want}")
    if args.no_rect:
        if pixels:
            fails.append(f"the verdict says {pixels} pixels differ on a pair that is the same file twice")
        if areas:
            fails.append(f"the verdict invented {len(areas)} changed area(s) where there are none: {areas}")
    for line in notes:
        print(line)
    print(f"   verdict: read={bool(verdict.get('read'))} pixels={pixels} areas={len(areas)} "
          f"counts={verdict.get('counts')} percent={verdict.get('panelPercent')}")
    return fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="document A of the pair that was compared")
    ap.add_argument("--out", required=True, help="the exported comparison file")
    ap.add_argument("--page", type=int, required=True, help="1-based sheet of --src to judge against")
    ap.add_argument("--out-page", type=int, default=0, help="sheet of --out (default: --page)")
    ap.add_argument("--rect", default="", help="planted difference x0,y0,x1,y1 in displayed points")
    ap.add_argument("--tol", type=float, default=2.0)
    ap.add_argument("--no-rect", action="store_true", help="assert nothing is marked anywhere on the page")
    ap.add_argument("--blank", action="store_true", help="the source sheet is empty: ink must stay at the label")
    ap.add_argument("--min-ink-frac", type=float, default=0.85,
                    help="produced ink must reach this share of the source sheet's own ink")
    ap.add_argument("--verdict", default="", help="the pane's published verdict, from compare-rail.mjs")
    ap.add_argument("--label", default="compare")
    args = ap.parse_args()

    src = pymupdf.open(args.src)
    out = pymupdf.open(args.out)
    out_index = (args.out_page or args.page) - 1
    if out_index >= len(out):
        print(f"{args.label}: FAIL — the export has {len(out)} page(s), asked for sheet {out_index + 1}")
        return 1
    got = ink_and_mark(out[out_index], DPI)
    want = ink_and_mark(src[args.page - 1], DPI)
    print(f"{args.label}: out page {out_index + 1} box {got['box_pts'][0]}x{got['box_pts'][1]} pt, "
          f"{got['images']} image XObject(s), ink {got['ink']:.2f} % (source sheet {want['ink']:.2f} %), "
          f"highlight {got['mark']:.2f} % ({got['mark_px']} px), bbox "
          + (f"{tuple(round(v, 1) for v in got['box'])}" if got["box"] else "none"))

    fails = []
    if args.verdict:
        with open(args.verdict, encoding="utf-8") as handle:
            fails += check_verdict(args, json.load(handle))
    if args.rect:
        rx0, ry0, rx1, ry1 = (float(v) for v in args.rect.split(","))
        if got["box"] is None:
            fails.append(f"nothing is marked, but a difference was planted at {rx0},{ry0}-{rx1},{ry1} pt")
        elif not near(got["box"], (rx0, ry0, rx1, ry1), args.tol):
            fails.append(
                "the mark is not where the difference was planted: "
                f"got {tuple(round(v, 1) for v in got['box'])}, wanted "
                f"({rx0}, {ry0}, {rx1}, {ry1}) ±{args.tol} pt"
            )
        else:
            worst = max(abs(g - w) for g, w in zip(got["box"], (rx0, ry0, rx1, ry1), strict=True))
            print(f"   localised: {tuple(round(v, 1) for v in got['box'])} against the planted "
                  f"({rx0}, {ry0}, {rx1}, {ry1}) — edges off by {worst:.2f} pt")
        planted = (rx1 - rx0) * (ry1 - ry0)
        area = (got["box"][2] - got["box"][0]) * (got["box"][3] - got["box"][1]) if got["box"] else 0.0
        print(f"   marked area {area:.0f} pt² against the planted {planted:.0f} pt² "
              f"({100.0 * area / planted:.1f} % of it)")
    elif args.no_rect and got["mark_px"] > 0:
        fails.append(
            f"{got['mark_px']} px are marked on a page whose two sources are the same sheet "
            f"(bbox {tuple(round(v, 1) for v in (got['box'] or (0, 0, 0, 0)))})"
        )
    if args.blank:
        if got["ink"] > want["ink"] + LABEL_INK + 0.2:
            fails.append(f"an empty sheet came back with {got['ink']:.2f} % ink; the label alone is {LABEL_INK} %")
    elif want["ink"] > 0.5 and got["ink"] < args.min_ink_frac * want["ink"]:
        # The page image must be the page, not paper beside a plausible mark.
        fails.append(
            f"the page carries {got['ink']:.2f} % ink against its own source sheet's "
            f"{want['ink']:.2f} % — {100.0 * got['ink'] / want['ink']:.0f} % of it, under the "
            f"{100 * args.min_ink_frac:.0f} % floor"
        )

    if fails:
        for line in fails:
            print(f"   FAIL: {line}")
        return 1
    print("   OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
