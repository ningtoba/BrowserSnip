"""Judge a divide-pages output against its source, piece by piece, in display space.

    python3 /tmp/dv/measure.py SRC DIVIDED AXIS N [--grid CxR]

For every source sheet in selection order and every tile in the tool's own order
(rows outer, columns inner) it compares:

  * the produced page's box against the tile's *displayed* size (the sheet is
    rendered rotated, so a `/Rotate 90` sheet is judged as the viewer sees it);
  * the produced page's pixels against that same region of the source at the same
    dpi (identity ratio, so a swapped pair or a wrong strip shows up);
  * the produced page's first word run against the words inside that region.

Control column: the same piece against the sheet's *next tile*, so a checker that
always says "identical" is visible.
"""
import sys

import pymupdf

DPI = 144
TOL = 0.6


def ink(pix):
    n = 0
    for y in range(pix.height):
        for x in range(pix.width):
            if pix.pixel(x, y) != (255, 255, 255):
                n += 1
    return n


def crop(pix, rect):
    """Crop a pixmap to `rect` (in points) so two renders can be compared 1:1,
    rounding the edges because a third of 595 is 198.33 — not a whole pixel."""
    s = DPI / 72.0
    x0, y0 = round(rect.x0 * s), round(rect.y0 * s)
    x1, y1 = round(rect.x1 * s), round(rect.y1 * s)
    x1 = min(x1, pix.width)
    y1 = min(y1, pix.height)
    return pymupdf.Pixmap(pix, pymupdf.IRect(x0, y0, max(x1, x0 + 1), max(y1, y0 + 1)))


def identity(a, b):
    w = min(a.width, b.width)
    h = min(a.height, b.height)
    same = tot = 0
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            tot += 1
            if a.pixel(x, y) == b.pixel(x, y):
                same += 1
    return same / tot if tot else 0.0


def to_display(page, rect):
    """A word box from `get_text("words")` (unrotated, y down) into the frame a
    viewer shows, so it can be matched against a tile of the *displayed* sheet."""
    rot = page.rotation % 360
    w, h = page.mediabox.width, page.mediabox.height  # unrotated, like the words
    if rot == 0:
        return (rect.x0, rect.y0, rect.x1, rect.y1)
    if rot == 180:
        return (w - rect.x1, rect.y0, w - rect.x0, rect.y1)
    x0, y0, x1, y1 = rect
    # 90° clockwise: the page's vertical axis becomes the display's horizontal
    # one (reversed), the page's horizontal axis becomes the display's vertical.
    if rot == 90:
        return (h - y1, x0, h - y0, x1)
    return (y0, w - x1, y1, w - x0)


def text_in(page, tile):
    """The words a viewer sees inside `tile`, read in the displayed frame."""
    found = []
    for w in page.get_text("words"):
        box = to_display(page, pymupdf.Rect(w[:4]))
        if pymupdf.Rect(box).intersects(tile):
            found.append((box[1], box[0], w[4]))
    return [t for _, _, t in sorted(found)]


def tiles(width, height, axis, n, grid):
    if grid:
        cols, rows = grid
    elif axis == "horizontal":
        cols, rows = 1, n
    else:
        cols, rows = n, 1
    tw, th = width / cols, height / rows
    out = []
    for r in range(rows):
        for c in range(cols):
            out.append(pymupdf.Rect(c * tw, r * th, (c + 1) * tw, (r + 1) * th))
    return out


def main():
    src_path, out_path, axis, parts = sys.argv[1:5]
    grid = None
    if "--grid" in sys.argv:
        c, r = sys.argv[sys.argv.index("--grid") + 1].split("x")
        grid = (int(c), int(r))
    src = pymupdf.open(src_path)
    out = pymupdf.open(out_path)
    parts = int(parts)

    plan = []
    for page in src:
        disp = page.rect  # already /Rotate-applied
        for tile in tiles(disp.width, disp.height, axis, parts, grid):
            plan.append((page.number, tile, tile.width, tile.height))
    print(f"source sheets {src.page_count} → expected pieces {len(plan)}; output pages {out.page_count}")

    bad = 0
    worst = 1.0
    blank_expected = 0
    for i, (pno, tile, tw, th) in enumerate(plan):
        if i >= out.page_count:
            print(f"piece {i + 1}: MISSING (output has {out.page_count})")
            bad += 1
            continue
        got = out[i]
        src_page = src[pno]
        # Control: the *next tile of the same sheet* (wrapping), so the tone bands
        # differ even when two sheets look alike.
        other_tile = plan[(i + 1) % len(plan)][1] if len(plan) > 1 else tile
        if plan[(i + 1) % len(plan)][0] != pno:
            other_tile = plan[(i + 1) % len(plan)][1]
        exp = src_page.get_pixmap(dpi=DPI, clip=tile)
        ctl = src_page.get_pixmap(dpi=DPI, clip=other_tile)
        gotpix = got.get_pixmap(dpi=DPI)
        ident = identity(gotpix, exp)
        ctl_ident = identity(gotpix, ctl)
        worst = min(worst, ident)
        want_text = text_in(src_page, tile)
        got_text = str(got.get_text("text")).split()
        box_ok = abs(got.rect.width - tw) < TOL and abs(got.rect.height - th) < TOL
        size_ok = ident > 0.98 and abs(gotpix.width - exp.width) <= 1 and abs(gotpix.height - exp.height) <= 1
        if ink(exp) == 0:
            blank_expected += 1
        # Word sets, not reading order: on a rotated sheet the words of one line
        # land in different halves and the stream order is not the reading order.
        text_ok = sorted(want_text) == sorted(got_text)
        if not (box_ok and size_ok and text_ok):
            bad += 1
        print(
            f"piece {i + 1:>2} ← sheet {pno + 1} tile {tile.width:.0f}x{tile.height:.0f}"
            f" | out {got.rect.width:.1f}x{got.rect.height:.1f} rot {got.rotation}"
            f" | box {'ok' if box_ok else 'WRONG'}"
            f" | pix {ident:.3f} (control {ctl_ident:.3f})"
            f" | text {sorted(want_text)!r} vs {sorted(got_text)!r} {'ok' if text_ok else 'WRONG'}"
            f" | ink out {ink(gotpix)} exp {ink(exp)}"
        )
    print(f"\nbad pieces {bad} / {len(plan)}; worst pixel identity {worst:.3f};"
          f" expected-blank tiles {blank_expected}")



main()
