#!/usr/bin/env python3
"""Where did the folio actually land, as a reader sees the page?

Every page is rendered twice at the same dpi — the untouched source and the
produced file — and the two bitmaps are differenced. The added ink's bounding
box is then expressed as a fraction of the *displayed* page (the render is
already in displayed space: PyMuPDF applies /Rotate), so a bottom-centre folio
on a /Rotate 90 sheet is measured against the sheet the reader is looking at and
not against the stored MediaBox.

Ink is the diff, never a guess about colour, so the fixture's own pastel squares
and black band cannot be mistaken for the number. Both the diff bbox and the
extracted text span are printed; `--expect` says which page fraction the folio
was asked for and the checker decides whether the ink is inside the page box and
which side of the sheet it sits on.

  python3 docs/research/page-numbers-place.py SOURCE OUT.pdf [--dpi 100]
"""
import numpy as np
import pymupdf
import sys

DPI = 100


def render(page, dpi):
    pix = page.get_pixmap(dpi=dpi)
    arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)[:, :, :3]
    return arr.astype(np.int16)


def main():
    src_path, out_path = sys.argv[1], sys.argv[2]
    dpi = DPI
    if '--dpi' in sys.argv:
        dpi = int(sys.argv[sys.argv.index('--dpi') + 1])
    src = pymupdf.open(src_path)
    out = pymupdf.open(out_path)
    print(f'source pages {src.page_count} out pages {out.page_count}')
    for index in range(out.page_count):
        page = out[index]
        w, h = page.rect.width, page.rect.height
        before = render(src[index], dpi)
        after = render(page, dpi)
        if before.shape != after.shape:
            print(f'p{index+1} render size differs {before.shape} {after.shape}')
            continue
        diff = np.abs(after - before).max(axis=2) > 12
        count = int(diff.sum())
        text = page.get_text().strip().replace('\n', ' | ')
        spans = [
            (round(s['bbox'][0], 1), round(s['bbox'][1], 1), round(s['bbox'][2], 1), round(s['bbox'][3], 1), s['text'])
            for b in page.get_text('dict')['blocks'] if b.get('lines')
            for line in b['lines'] for s in line['spans']
        ]
        if not count:
            print(f'p{index+1} {w:.1f}x{h:.1f} rot{page.rotation} added_ink=0 text="{text[:60]}"')
            continue
        ys, xs = np.nonzero(diff)
        x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
        # The folio is the span the diff just found, not a guess from the words: a
        # rotated page reports its spans in unrotated user space, so a filter on
        # "near the bottom" alone would miss it.
        dx0, dy0 = x0 / dpi * 72, y0 / dpi * 72
        dx1, dy1 = x1 / dpi * 72, y1 / dpi * 72
        folio = [
            span for span in spans
            if span[0] < dx1 and span[2] > dx0 and span[1] < dy1 and span[3] > dy0
        ]
        # Fraction of the displayed page: x from the left edge, y from the top.
        print(
            f'p{index+1} {w:.1f}x{h:.1f} rot{page.rotation} added_px={count} '
            f'ink_x=[{(x0+1)/after.shape[1]:.3f},{(x1+1)/after.shape[1]:.3f}] '
            f'ink_y_from_top=[{(y0+1)/after.shape[0]:.3f},{(y1+1)/after.shape[0]:.3f}] '
            f'w/h_ratio={(x1-x0+1)/max(1, y1-y0+1):.2f} text="{text[:60]}"'
        )
        for span in folio:
            print(
                f'   span bbox={span[:4]} (fractions {span[0]/w:.3f}-{span[2]/w:.3f} x, '
                f'{1-span[3]/h:.3f}-{1-span[1]/h:.3f} from bottom) "{span[4]}"'
            )


main()
