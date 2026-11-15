#!/usr/bin/env python3
"""Do the header and the footer land inside the sheet, and does the content survive?

Every page is rendered twice at one dpi — the untouched source and the produced
file — and the two bitmaps are differenced, so the fixture's own colour squares
and black band can never pass for the header text. PyMuPDF renders in *displayed*
space (it applies /Rotate), so a mark on the turned sheet is measured against the
sheet the reader is looking at.

Reported per page:

* `added_px` and the ink bbox as a fraction of the displayed page;
* `edge_rows` / `edge_cols` — ink pixels sitting in the outermost pixel row and
  column of each edge, which is where a descender on `margin: 0` shows up;
* the row clusters of the mask (`.bands`), in points from the top edge, so the
  header band, the footer band and their hairlines are separate numbers: `gap=`
  is the empty distance between the lowest header pixel and the highest footer
  pixel, negative when the two bands overlap;
* `content_lost` — source ink pixels that are no longer the same in the output
  and sit *outside* the band rows. A band paints over what is under it; the rest
  of the sheet has no business changing.
* every diff bbox that is not explained by a text span, so a rule drawn in the
  wrong place is visible as ink with no words.

The spans themselves (font, size, colour, bbox) are printed from
`page.get_text('dict')` so the face, size and colour in the file can be compared
with what the card asked for.

  python3 docs/research/header-footer-bands.py SOURCE OUT.pdf [--dpi 100]
"""
import sys

import numpy as np
import pymupdf

DPI = 100
THRESH = 12


def render(page, dpi):
    pix = page.get_pixmap(dpi=dpi)
    arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)[:, :, :3]
    return arr.astype(np.int16)


def luma(arr):
    return arr[:, :, 0] * 0.299 + arr[:, :, 1] * 0.587 + arr[:, :, 2] * 0.114


def row_clusters(rows, min_gap=2):
    out = []
    for y in rows:
        if out and y - out[-1][1] <= min_gap:
            out[-1][1] = y
        else:
            out.append([y, y])
    return out


def main():
    src_path, out_path = sys.argv[1], sys.argv[2]
    dpi = DPI
    if '--dpi' in sys.argv:
        dpi = int(sys.argv[sys.argv.index('--dpi') + 1])
    src = pymupdf.open(src_path)
    out = pymupdf.open(out_path)
    scale = 72.0 / dpi
    print(f'source pages {src.page_count} out pages {out.page_count}')
    for index in range(out.page_count):
        page = out[index]
        w, h = page.rect.width, page.rect.height
        before = render(src[index], dpi)
        after = render(page, dpi)
        if before.shape != after.shape:
            print(f'p{index+1} render size differs {before.shape} {after.shape}')
            continue
        diff = np.abs(after - before).max(axis=2) > THRESH
        count = int(diff.sum())
        src_ink = int((luma(before) < 245).sum())
        spans = [
            (round(s['bbox'][0], 1), round(s['bbox'][1], 1), round(s['bbox'][2], 1), round(s['bbox'][3], 1),
             s['font'], round(s['size'], 1), s['color'], s['text'])
            for b in page.get_text('dict')['blocks'] if b.get('lines')
            for line in b['lines'] for s in line['spans']
        ]
        if not count:
            print(f'p{index+1} {w:.1f}x{h:.1f} rot{page.rotation} added_ink=0 source_ink={src_ink} '
                  f'text="{page.get_text().strip()[:60]}"')
            continue
        ys, xs = np.nonzero(diff)
        x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
        edges = {
            'top': int(diff[0].sum()),
            'bottom': int(diff[-1].sum()),
            'left': int(diff[:, 0].sum()),
            'right': int(diff[:, -1].sum()),
        }
        rows = np.nonzero(diff.any(axis=1))[0]
        clusters = row_clusters(rows)
        header = [c for c in clusters if (c[0] + c[1]) / 2 < after.shape[0] / 2]
        footer = [c for c in clusters if (c[0] + c[1]) / 2 >= after.shape[0] / 2]
        header_end = max((c[1] for c in header), default=-1)
        footer_start = min((c[0] for c in footer), default=after.shape[0])
        gap_px = footer_start - header_end - 1
        band_rows = np.zeros(after.shape[0], dtype=bool)
        for a, b in clusters:
            band_rows[a:b + 1] = True
        off_band = diff & ~band_rows[:, None]
        lost_outside = int((off_band & (np.abs(after - before).max(axis=2) > THRESH)).sum())
        coloured = int((np.abs(luma(after) - luma(before)) > THRESH)[~band_rows].sum()) - lost_outside
        print(
            f'p{index+1} {w:.1f}x{h:.1f} rot{page.rotation} added_px={count} source_ink={src_ink} '
            f'ink_x=[{(x0+1)/after.shape[1]:.3f},{(x1+1)/after.shape[1]:.3f}] '
            f'ink_y_from_top=[{(y0+1)/after.shape[0]:.3f},{(y1+1)/after.shape[0]:.3f}] '
            f'edge=' + ','.join(f'{k}:{v}' for k, v in edges.items())
        )
        print(f'   bands={[[round(a*scale,1), round(b*scale,1)] for a,b in clusters]} '
              f'hdr_bottom={round(header_end*scale,1)} ftr_top={round(footer_start*scale,1)} '
              f'gap={round(gap_px*scale,1)}pt content_lost_outside_bands={lost_outside} '
              f'other_offband_change={coloured}')
        for span in spans:
            print(f'   span bbox={span[:4]} font={span[4]} size={span[5]} color=#{span[6]:06X} "{span[7]}"')


main()
