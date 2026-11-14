#!/usr/bin/env python3
"""Judge a `booklet` output against its own source, cell by cell, and print PASS/FAIL.

    python3 docs/research/booklet-round.py --source /tmp/bk/xmp12.pdf \
        --out /tmp/bk/r/before-12.pdf --sheets 3 --gutter 12 --margin 12 \
        --label before-12

The expected imposition is derived, not stored: a saddle-stitched signature of
`4k` booklet pages holds, for the i-th of its k sheets, the front pair
`(4k-2i, 1+2i)` and the back pair `(2+2i, 4k-1-2i)` — left page first, because
the left half of a side is the one that lands *after* the fold when the stack is
nested (for 8 pages the published table is 8|1 / 2|7 / 6|3 / 4|5; every pair sums
to `4k+1`). Each produced PDF page is one printed *side*.

Nothing here is a count of objects. Every cell is rasterised at 72 dpi inside its
own rect and judged by the first text line read there, the non-white pixel count,
and the ink bounding box: its centre against the cell centre (the placement is
centred, so the centre is where the cell is), and its aspect against the same
source page's *displayed* aspect (so a quarter-turned sheet has to arrive turned).

The instrument is checked before it is trusted (`--control`): the same produced
file is judged with the cells slid half a cell sideways, then the *source* is
judged as if it were already imposed (reader order, not printer order). Both must
produce FAIL lines.
"""
import argparse
import sys

import pymupdf

PAPER = {'a4': (595.28, 841.89), 'letter': (612, 792)}


def cells(width, height, gutter, margin):
    """The two cells of a landscape sheet, gutter at the fold, margin outside."""
    cw = width / 2 - gutter - margin
    return [(margin, margin, cw, height - 2 * margin),
            (width / 2 + gutter, margin, cw, height - 2 * margin)]


def ink(pm, box):
    """(count, bbox) of non-white pixels inside a top-down pixel box."""
    x0, y0, x1, y1 = [int(round(v)) for v in box]
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(pm.width, x1), min(pm.height, y1)
    samples, stride, width = pm.samples, pm.n, pm.width
    count = 0
    bbox = None
    for py in range(y0, y1):
        base = py * width * stride
        for px in range(x0, x1):
            at = base + px * stride
            if samples[at:at + 3] != b'\xff\xff\xff':
                count += 1
                bbox = [px, py, px, py] if bbox is None else [
                    min(bbox[0], px), min(bbox[1], py), max(bbox[2], px), max(bbox[3], py)]
    return count, bbox


def source_measure(path):
    """Per source page: first text line, displayed ink aspect."""
    doc = pymupdf.open(path)
    pages = []
    for page in doc:
        pm = page.get_pixmap(dpi=72)
        count, bbox = ink(pm, (0, 0, pm.width, pm.height))
        aspect = None if not bbox or not count else (bbox[2] - bbox[0]) / max(1, (bbox[3] - bbox[1]))
        text = str(page.get_text() or '')
        first = (text.strip().split('\n') or [''])[0][:34]
        pages.append({'first': first, 'aspect': aspect, 'ink': count, 'rot': page.rotation,
                      'w': pm.width, 'h': pm.height,
                      'cx': None if not bbox else (bbox[0] + bbox[2]) / 2,
                      'cy': None if not bbox else (bbox[1] + bbox[3]) / 2})
    return pages


def signature(total):
    """The imposition: [side][left, right] of page numbers, 1-based, 0 = blank."""
    sides = []
    for i in range(total // 4):
        sides.append([total - 2 * i, 1 + 2 * i])
        sides.append([2 + 2 * i, total - 1 - 2 * i])
    return sides


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--sheets', type=int, default=0, help='expected printed sides')
    ap.add_argument('--gutter', type=float, default=12)
    ap.add_argument('--margin', type=float, default=12)
    ap.add_argument('--paper', default='a4')
    ap.add_argument('--label', default='run')
    ap.add_argument('--control', action='store_true')
    args = ap.parse_args()

    failures = 0

    def judge(ok, what, got, want):
        nonlocal failures
        if not ok:
            failures += 1
        print(f"{'PASS' if ok else 'FAIL'} {what} (got {got}, want {want})")

    src = source_measure(args.source)
    pad = -(-len(src) // 4) * 4
    want = signature(pad)
    want_w, want_h = PAPER[args.paper]
    want_w, want_h = want_h, want_w  # the rail's Landscape sheet defaults on

    doc = pymupdf.open(args.out)
    judge(doc.page_count == (args.sheets or len(want)), 'printed side count',
          doc.page_count, args.sheets or len(want))
    for index, side in enumerate(want):
        if index >= doc.page_count:
            break
        page = doc[index]
        number = index + 1
        judge(abs(page.rect.width - want_w) < 0.6 and abs(page.rect.height - want_h) < 0.6,
              f'side {number} box', (round(page.rect.width, 1), round(page.rect.height, 1)),
              (round(want_w, 1), round(want_h, 1)))
        judge(int(page.rotation or 0) == 0, f'side {number} /Rotate', page.rotation, 0)
        width, height = float(page.rect.width), float(page.rect.height)
        pm = page.get_pixmap(dpi=72)
        if args.control:
            band = cells(width, height, args.gutter, args.margin)
            band = [(x + width / 4, y, w, h) for (x, y, w, h) in band]
        else:
            band = cells(width, height, args.gutter, args.margin)
        for cell, (x, y, w, h) in enumerate(band):
            box = pymupdf.Rect(x, height - y - h, x + w, height - y)
            first = page.get_textbox(box).strip().split('\n')[0][:34]
            count, bbox = ink(pm, (x, height - y - h, x + w, height - y))
            target = side[cell]
            # A page number past the end of the source is padding the tool added
            # to reach a whole signature; it has to be blank paper like a zero.
            if target == 0 or target > len(src):
                judge(count == 0, f'side {number} cell {cell} is the blank filler', count, 0)
                continue
            source = src[target - 1]
            judge(first == source['first'],
                  f'side {number} cell {cell} carries source page {target}',
                  repr(first), repr(source['first']))
            judge(count > 0 if source['ink'] else count == 0,
                  f'side {number} cell {cell} inked like its source', count,
                  '> 0' if source['ink'] else 0)
            if bbox:
                # The source page box is centred in its cell and scaled by the
                # smaller of the two fits, so the ink centre is the cell centre
                # plus the source ink's own offset from the source page centre,
                # scaled the same way. That is derived from the geometry, not
                # guessed: the two cells are half a sheet (210 pt) apart and the
                # antialiased edge is under 2 pt, so a 2 pt band is decisive.
                scale = min(w / source['w'], h / source['h'])
                cx = (bbox[0] + bbox[2]) / 2
                cy = (bbox[1] + bbox[3]) / 2
                want_cx = x + w / 2 + (source['cx'] - source['w'] / 2) * scale
                want_cy = (height - y - h / 2) + (source['cy'] - source['h'] / 2) * scale
                judge(abs(cx - want_cx) < 2 and abs(cy - want_cy) < 2,
                      f'side {number} cell {cell} ink centred in its cell',
                      (round(cx, 1), round(cy, 1)), (round(want_cx, 1), round(want_cy, 1)))
                if source['aspect']:
                    aspect = (bbox[2] - bbox[0]) / max(1, (bbox[3] - bbox[1]))
                    judge(abs(aspect - source['aspect']) / source['aspect'] < 0.02,
                          f'side {number} cell {cell} keeps the source aspect',
                          round(aspect, 3), f"{source['aspect']:.3f} ±2%")
    if args.control:
        # Second control: the source judged as if it were already imposed, i.e.
        # reader order 1|2, 3|4 on every side. Order rows must fail.
        for index, page in enumerate([doc[i] for i in range(doc.page_count)]):
            width, height = float(page.rect.width), float(page.rect.height)
            pm = page.get_pixmap(dpi=72)
            for cell, (x, y, w, h) in enumerate(cells(width, height, args.gutter, args.margin)):
                box = pymupdf.Rect(x, height - y - h, x + w, height - y)
                first = page.get_textbox(box).strip().split('\n')[0][:34]
                reader = 2 * index + cell + 1
                if reader <= len(src):
                    judge(first == src[reader - 1]['first'],
                          f'control: side {index + 1} cell {cell} in reader order',
                          repr(first), repr(src[reader - 1]['first']))
                else:
                    count, bbox = ink(pm, (x, height - y - h, x + w, height - y))
                    judge(count == 0, f'control: side {index + 1} cell {cell} past the source is paper',
                          count, 0)
    src_doc = pymupdf.open(args.source)
    src_info = src_doc.metadata or {}
    info = doc.metadata or {}
    packet = bool(src_doc.get_xml_metadata())
    judge(info.get('title') == src_info.get('title'), '/Info title carried',
          repr(info.get('title')), repr(src_info.get('title')))
    judge(info.get('author') == src_info.get('author'), '/Info author carried',
          repr(info.get('author')), repr(src_info.get('author')))
    judge(info.get('subject') == src_info.get('subject'), '/Info subject carried',
          repr(info.get('subject')), repr(src_info.get('subject')))
    judge(info.get('producer') == 'BrowserSnip', 'producer', repr(info.get('producer')), 'BrowserSnip')
    judge(bool(doc.get_xml_metadata()) == packet, 'XMP packet carried like the source',
          bool(doc.get_xml_metadata()), packet)
    print(f'\n{failures} failure(s) [{args.label}]')
    return failures


if __name__ == '__main__':
    sys.exit(1 if main() else 0)
