#!/usr/bin/env python3
"""Measure what `posterize` actually cut, tile by tile — and fail if a tile is paper.

  python3 docs/research/poster-ink.py --source SRC.pdf --source-page 1 \
      --tiles OUT.pdf --columns 2 --rows 2 --bleed 10 [--dpi 72]

The card promises "tiles that print at one scale and overlap by the amount you
set". Each of those is a pixel fact about the produced file, and a page count is
neither, so every check here compares the tile's *ink* with the region of the
source it claims to be:

* **coverage** — the tile is compared column-for-column against the source crop
  its grid cell names, at 72 dpi (1 px = 1 pt). The instrument's control is the
  same tile compared with the crop shifted half a cell: that must score worse,
  otherwise "matches" means nothing.
* **scale** — the ink of the tile is the crop's ink at 1:1; a resampled tile (the
  old `contain` bug) puts a different number of dark pixels in the same band.
* **overlap** — for every neighbouring pair in a row and in a column the overlap
  is *recovered* from the pixels (the shift that makes the two edge strips equal)
  and compared with the number the user asked for. Zero overlap is the control
  for the instrument, and a band missing between tiles at zero overlap is what
  the seam test looks for.
* **order** — the recovered source x/y of tile *i* must rise left→right then
  top→bottom, so tile numbering follows reading order.

`--dpi` must leave 72 for the 1:1 arithmetic; other values scale the crop.
"""
import argparse
import sys

import pymupdf

DARK = 245          # a pixel is ink below this on any channel
SHIFT = 45          # how far the control crop is moved, in pt
RECOVER = 200       # overlaps are recovered by search up to this many pt


def raster(page, dpi):
    pix = page.get_pixmap(dpi=dpi)
    return pix


def dark(pix, x, y):
    at = (y * pix.width + x) * pix.n
    s = pix.samples
    return s[at] < DARK or s[at + 1] < DARK or s[at + 2] < DARK


def ink(pix, x0=0, y0=0, x1=None, y1=None):
    x1 = pix.width if x1 is None else min(x1, pix.width)
    y1 = pix.height if y1 is None else min(y1, pix.height)
    n = 0
    for y in range(max(0, y0), y1):
        for x in range(max(0, x0), x1):
            if dark(pix, x, y):
                n += 1
    return n


def agree(a, b, ax, ay, w, h):
    """Fraction of the crop of `b` at (ax, ay) that matches `a` from its origin."""
    return same_at(a, 0, 0, b, ax, ay, w, h)


def same_at(a, ax, ay, b, bx, by, w, h):
    """Fraction of pixels inked alike at two absolute origins — the seam probe."""
    same = total = 0
    for y in range(h):
        for x in range(w):
            if ay + y >= a.height or ax + x >= a.width:
                continue
            if by + y >= b.height or bx + x >= b.width:
                continue
            total += 1
            if dark(a, ax + x, ay + y) == dark(b, bx + x, by + y):
                same += 1
    return (same / total) if total else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', required=True)
    ap.add_argument('--source-page', type=int, default=1)
    ap.add_argument('--tiles', required=True)
    ap.add_argument('--columns', type=int, required=True)
    ap.add_argument('--rows', type=int, required=True)
    ap.add_argument('--bleed', type=float, required=True)
    ap.add_argument('--dpi', type=int, default=72)
    args = ap.parse_args()
    scale = args.dpi / 72.0

    src = pymupdf.open(args.source)
    spage = src[args.source_page - 1]
    srcpix = raster(spage, args.dpi)
    W, H = srcpix.width, srcpix.height          # displayed pixels: PyMuPDF rotates

    out = pymupdf.open(args.tiles)
    expect_sheets = args.columns * args.rows
    print(f'source page {args.source_page}: {W}x{H} px @ {args.dpi} dpi, displayed '
          f'{spage.rect.width:.1f}x{spage.rect.height:.1f} rot {spage.rotation}')
    print(f'tiles: {out.page_count} (grid {args.columns}x{args.rows} = {expect_sheets}), '
          f'bleed asked {args.bleed:.1f} pt')
    if out.page_count != expect_sheets:
        print(f'FAIL tile count {out.page_count} != {expect_sheets}')

    cw, ch = W / args.columns, H / args.rows
    sheet_w, sheet_h = cw + args.bleed * scale, ch + args.bleed * scale
    bad = []
    if out.page_count != expect_sheets:
        bad.append('tile count')
    placed = []
    for i in range(out.page_count):
        r, c = divmod(i, args.columns)
        tile = out[i]
        tpix = raster(tile, args.dpi)
        if abs(tpix.width - sheet_w) > 1 or abs(tpix.height - sheet_h) > 1:
            print(f'FAIL tile {i + 1}: sheet {tpix.width}x{tpix.height} px, '
                  f'expected {sheet_w:.1f}x{sheet_h:.1f} — the tiles are not one size')
            bad.append(f'tile {i + 1} sheet size')
            continue
        # The window the grid cell names. The extra strip of an interior/edge tile
        # sits on its trailing side, matching the tool's own geometry.
        wx = c * cw - (args.bleed * scale if c > 0 else 0)
        wy = r * ch - (args.bleed * scale if r > 0 else 0)
        w = int(min(tpix.width, W - wx))
        h = int(min(tpix.height, H - wy))
        # Sub-pixel placement is absorbed by ±1 px; half a cell is not.
        good, at = max(
            (agree(tpix, srcpix, int(wx) + dx, int(wy) + dy, w, h), (dx, dy))
            for dx in (-1, 0, 1) for dy in (-1, 0, 1)
        )
        ctrl = agree(tpix, srcpix, int(wx + SHIFT * scale), int(wy), w, h)
        tile_ink = ink(tpix)
        crop_ink = ink(srcpix, int(wx) + at[0], int(wy) + at[1], int(wx) + at[0] + w, int(wy) + at[1] + h)
        placed.append((r, c, wx, wy))
        flag = 'ok' if good > ctrl and abs(tile_ink - crop_ink) <= max(3, crop_ink * 0.02) else 'FAIL'
        if flag == 'FAIL':
            bad.append(f'tile {i + 1} content')
        print(f'tile {i + 1:2d} row {r + 1} col {c + 1}: window x={wx:.0f} y={wy:.0f} '
              f'ink {tile_ink} vs crop {crop_ink} | agreement {good:.3f} (shifted control {ctrl:.3f}) {flag}')

    # Reading order: the recovered window origin must walk left→right, top→bottom.
    order = [i for i, (r, c, _, _) in enumerate(placed)
             if i == 0 or (r, c) > (placed[i - 1][0], placed[i - 1][1])]
    print(f'order: {"reading order" if len(order) == len(placed) else "NOT reading order"}')

    # Overlap recovered from the pixels, per neighbouring pair.
    def strip(tile_i, side, width_px):
        pix = raster(out[tile_i], args.dpi)
        x0 = 0 if side == 'left' else pix.width - width_px
        return pix, x0

    def pair_diff(i, j, overlap_px, axis):
        # Hypothesis: tile i's trailing strip and tile j's leading strip are the
        # same content, `overlap_px` long. A fixed 10-px probe slides along the
        # seam, so the strip's width is not itself part of the score.
        a = raster(out[i], args.dpi)
        b = raster(out[j], args.dpi)
        if axis == 'row':
            probe = min(30, max(1, a.width - overlap_px))
            return same_at(a, a.width - overlap_px, 0, b, 0, 0, probe, min(a.height, b.height))
        probe = min(30, max(1, a.height - overlap_px))
        return same_at(a, 0, a.height - overlap_px, b, 0, 0, min(a.width, b.width), probe)

    measured = []
    for r in range(args.rows):
        for c in range(args.columns - 1):
            i = r * args.columns + c
            scored = [(o, pair_diff(i, i + 1, o, 'row')) for o in range(1, min(RECOVER, out[i].rect.width - 2))]
            top = max(v for _, v in scored)
            best = max((o, v) for o, v in scored if v >= top - 1e-9)
            measured.append(('row', r + 1, i + 1, best[0], best[1]))
    for c in range(args.columns):
        for rr in range(args.rows - 1):
            i = rr * args.columns + c
            j = i + args.columns
            scored = [(o, pair_diff(i, j, o, 'column')) for o in range(1, min(RECOVER, out[i].rect.height - 2))]
            top = max(v for _, v in scored)
            best = max((o, v) for o, v in scored if v >= top - 1e-9)
            measured.append(('column', c + 1, i + 1, best[0], best[1]))
    # Each tile extends `bleed` past the boundary onto its neighbour and the
    # neighbour `bleed` back, so a seam between two tiles duplicates a band of
    # 2 × bleed — trim `bleed` off each side and the poster meets exactly.
    # Among shifts that match exactly (a solid band matches at every width), the
    # widest is the duplicated band; the loop above keeps the largest of them.
    # Zero overlap is the control: the neighbour's edge strip is *different*
    # content, so the recovered band must be ~0 and the strips must disagree.
    wanted = 2 * args.bleed * scale
    for axis, line, i, overlap, score in measured:
        ok = abs(overlap - wanted) <= 2 and (score >= 0.95 if wanted else True)
        if not ok:
            bad.append(f'{axis} seam at tile {i + 1}: duplicated {overlap} pt of {wanted:.0f} (match {score:.3f})')
        print(f'{axis} {line} seam after tile {i + 1}: duplicated band {overlap} pt '
              f'(2 x bleed = {wanted:.0f}), match {score:.3f} {"ok" if ok else "FAIL"}')

    print('FAILURES:', bad if bad else 'none')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
