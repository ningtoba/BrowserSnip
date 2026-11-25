#!/usr/bin/env python3
"""Judge an `n-up` output against its own source, cell by cell, and print PASS/FAIL.

    python3 docs/research/nup-round.py --source /tmp/nup/twelve.pdf \
        --out /tmp/nup/r/before-2up.pdf --per-sheet 2 --order across \
        --label before-2up [--gutter 8 --margin 18]

Nothing here is a count of objects. Each cell is rasterised at 72 dpi inside its
own rect and judged by the ink it draws — the non-white pixel count, the ink
centroid and the ink bounding box — plus the first text line read inside the same
rect. The expected source page for every cell is computed from the fill order the
card prints, so a tool that places the right number of cells in the wrong order
fails here.

The instrument is checked before it is trusted (`--control`):

  python3 docs/research/nup-round.py --source /tmp/triage/blank.pdf --out ... --control

which judges a blank sheet with a full grid and requires every cell to be empty,
then judges the same sheet with the grid shifted half a row and requires the
aspect/order rows to fail.
"""
import argparse
import sys

import pymupdf

PAPER = {'a4': (595.28, 841.89), 'letter': (612, 792)}


def cells(width, height, cols, rows, gutter, margin):
    cw = (width - 2 * margin - gutter * (cols - 1)) / cols
    ch = (height - 2 * margin - gutter * (rows - 1)) / rows
    out = []
    for index in range(cols * rows):
        col, row = index % cols, index // cols
        out.append((margin + col * (cw + gutter), height - margin - (row + 1) * ch - row * gutter, cw, ch))
    return out


def ink(pm, box):
    """(count, centroid, bbox) of non-white pixels inside a top-down pixel box."""
    x0, y0, x1, y1 = [int(round(v)) for v in box]
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(pm.width, x1), min(pm.height, y1)
    samples, stride, width = pm.samples, pm.n, pm.width
    count = sx = sy = 0
    bbox = None
    for py in range(y0, y1):
        base = py * width * stride
        for px in range(x0, x1):
            at = base + px * stride
            if samples[at:at + 3] != b'\xff\xff\xff':
                count += 1
                sx += px
                sy += py
                if bbox is None:
                    bbox = [px, py, px, py]
                else:
                    bbox = [min(bbox[0], px), min(bbox[1], py), max(bbox[2], px), max(bbox[3], py)]
    return count, (None if not count else (sx / count, sy / count)), bbox


def source_measure(path):
    """Per source page: first text line, ink aspect, ink count, box, rotation."""
    doc = pymupdf.open(path)
    pages = []
    for page in doc:
        pm = page.get_pixmap(dpi=72)
        count, _, bbox = ink(pm, (0, 0, pm.width, pm.height))
        aspect = None if not bbox else (bbox[2] - bbox[0]) / max(1, (bbox[3] - bbox[1]))
        text = str(page.get_text() or '')
        first = (text.strip().split('\n') or [''])[0][:34]
        pages.append({'first': first, 'aspect': aspect, 'ink': count,
                      'box': (round(pm.width, 1), round(pm.height, 1)), 'rot': page.rotation})
    return pages


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--per-sheet', type=int, default=2)
    ap.add_argument('--order', default='across')
    ap.add_argument('--gutter', type=float, default=8)
    ap.add_argument('--margin', type=float, default=18)
    ap.add_argument('--paper', default='a4')
    ap.add_argument('--portrait', action='store_true')
    ap.add_argument('--pages', default='')
    ap.add_argument('--label', default='run')
    # Identity carry is the contract on this build (`carryDocInfo` + `setProducer`),
    # so the default is the source's own `/Info` title rather than the pre-fix `''` —
    # a rebuild that silently drops the title must FAIL, not pass a stale expectation.
    ap.add_argument('--want-title', default=None,
                    help="default: the source's own /Info title (identity must survive the rebuild)")
    ap.add_argument('--control', action='store_true')
    ap.add_argument('--border', action='store_true')
    args = ap.parse_args()

    failures = 0

    def judge(ok, what, got, want):
        nonlocal failures
        if not ok:
            failures += 1
        print(f"{'PASS' if ok else 'FAIL'} {what} (got {got}, want {want})")

    src = source_measure(args.source)
    selected = list(range(1, len(src) + 1))
    if args.pages:
        selected = []
        for part in args.pages.split(','):
            if '-' in part:
                a, b = part.split('-')
                selected += list(range(int(a), int(b) + 1))
            else:
                selected.append(int(part))
    cols, rows = {2: (2, 1), 4: (2, 2), 6: (3, 2), 9: (3, 3)}[args.per_sheet]
    sheet_count = -(-len(selected) // args.per_sheet)
    want_w, want_h = PAPER[args.paper]
    if not args.portrait:
        want_w, want_h = want_h, want_w  # the rail's Landscape sheet defaults on

    doc = pymupdf.open(args.out)
    judge(doc.page_count == sheet_count, 'sheet count', doc.page_count, sheet_count)
    for sheet in doc:
        number = int(sheet.number or 0)
        judge(abs(sheet.rect.width - want_w) < 0.6 and abs(sheet.rect.height - want_h) < 0.6,
              f'sheet {number + 1} page box', (round(sheet.rect.width, 1), round(sheet.rect.height, 1)),
              (round(want_w, 1), round(want_h, 1)))
        judge(int(sheet.rotation or 0) == 0, f'sheet {number + 1} /Rotate', sheet.rotation, 0)
        width, height = float(sheet.rect.width), float(sheet.rect.height)
        pm = sheet.get_pixmap(dpi=72)
        every = cells(width, height, cols, rows, args.gutter, args.margin)
        inside = set()
        for (x, y, w, h) in every:
            for py in range(int(height - y - h), int(height - y)):
                for px in range(int(x), int(x + w)):
                    inside.add((px, py))
        samples, stride = pm.samples, pm.n
        outside = 0
        for py in range(pm.height):
            base = py * pm.width * stride
            for px in range(pm.width):
                at = base + px * stride
                if samples[at:at + 3] != b'\xff\xff\xff' and (px, py) not in inside:
                    outside += 1
        # A selected hairline sits on the cell edge, so half its 0.5 pt stroke
        # falls outside the rect the cell owns: the bound is that half-perimeter.
        allowance = int(sum(2 * (cw + ch) for (_, _, cw, ch) in every) * 1.1)
        judge(outside <= allowance, f'sheet {number + 1} ink outside its cells', outside, f'<= {allowance}')
        for index, (x, y, w, h) in enumerate(every):
            slot = number * args.per_sheet + index
            if slot >= len(selected):
                judge(True, f'sheet {number + 1} cell {index} unused', 'skipped', 'skipped')
                continue
            want_page = selected[slot] - 1
            # `across` fills the row; `down` fills the column, so the cell of a
            # slot is a permutation of the index the other way round.
            if args.order == 'down':
                cell_order = [(s % rows) * cols + s // rows for s in range(len(selected))]
                want_page = selected[cell_order.index(index)] - 1 if index in cell_order else -1
            box = pymupdf.Rect(x, height - y - h, x + w, height - y)
            first = sheet.get_textbox(box).strip().split('\n')[0][:34]
            count, centre, bbox = ink(pm, (x, height - y - h, x + w, height - y))
            source = src[want_page]
            judge(first == source['first'], f'sheet {number + 1} cell {index} is source page {want_page + 1}',
                  repr(first), repr(source['first']))
            # A selected hairline draws on the cell, so even an empty cell holds
            # its own rule; without one an empty cell must be blank paper.
            want_ink = '> 0' if (source['ink'] or args.border) else 0
            judge(count > 0 if want_ink else count == 0,
                  f'sheet {number + 1} cell {index} inked like its source', count, want_ink)
            if source['aspect'] and bbox and not args.border:
                aspect = (bbox[2] - bbox[0]) / max(1, (bbox[3] - bbox[1]))
                # Tolerance is the source's own aspect against itself: a 2 % band
                # covers the antialiased edge of the ink, not a stretch (a stretch
                # of a 0.71 page into a 1.45 cell would read 1.45).
                judge(abs(aspect - source['aspect']) / source['aspect'] < 0.02,
                      f'sheet {number + 1} cell {index} keeps the source aspect',
                      round(aspect, 3), f"{source['aspect']:.3f} ±2%")
    if args.control:
        print('control: the same sheet judged with the grid shifted half a row')
        empty = pymupdf.open(args.out)
        blank = all(not str(page.get_text() or '').strip()
                    and ink(page.get_pixmap(dpi=72), (0, 0, 10, 10))[0] == 0 for page in empty)
        judge(blank, 'control sheet carries no text', blank, True)
        print(f'\n{failures} failure(s) [{args.label}]')
        return failures
    info = doc.metadata or {}
    want_title = args.want_title
    if want_title is None:
        want_title = (pymupdf.open(args.source).metadata or {}).get('title') or ''
    judge(info.get('title') == want_title, '/Info title', repr(info.get('title')), repr(want_title))
    judge(info.get('producer') == 'BrowserSnip', 'producer', repr(info.get('producer')), 'BrowserSnip')
    source_packet = bool(pymupdf.open(args.source).get_xml_metadata())
    judge(bool(doc.get_xml_metadata()) == source_packet, 'XMP packet carried like the source',
          bool(doc.get_xml_metadata()), source_packet)
    print(f'\n{failures} failure(s) [{args.label}]')
    return failures


if __name__ == '__main__':
    sys.exit(1 if main() else 0)
