#!/usr/bin/env python3
"""Where did the watermark actually land, and how dark is it?

The same read `page-numbers-place.py` uses: every page is rendered twice at one
dpi — the untouched source and the produced file — and the two bitmaps are
differenced, so the fixture's own squares and bands can never pass for the mark.
PyMuPDF renders in *displayed* space (it applies /Rotate), so the added ink's
bounding box is reported as a fraction of the page the reader is looking at and
`inside=` says whether every stroke is inside that box.

Opacity is read off the same diff mask: the mean luminance of the added pixels
against the page's own paper, so 1.0 / 0.5 / 0.1 is a number, not a claim.

Tiling is read by projecting the mask onto the axes and clustering the runs: the
step between clusters is the pattern spacing the writer chose, and the width of
the last cluster against the first says whether the edge tile was clipped.

  python3 docs/research/watermark-mark.py SOURCE OUT.pdf [--dpi 100]
"""
import pymupdf
import numpy as np
import sys

DPI = 100
THRESH = 12


def render(page, dpi):
    pix = page.get_pixmap(dpi=dpi)
    arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)[:, :, :3]
    return arr.astype(np.int16)


def luma(arr):
    return arr[:, :, 0] * 0.299 + arr[:, :, 1] * 0.587 + arr[:, :, 2] * 0.114


def clusters(profile, min_gap=2):
    """Runs of non-zero cells, as [start, end] index pairs."""
    out = []
    start = None
    gap = 0
    for i, v in enumerate(profile):
        if v:
            if start is None:
                start = i
            gap = 0
        elif start is not None:
            gap += 1
            if gap >= min_gap:
                out.append([start, i - gap])
                start = None
    if start is not None:
        out.append([start, len(profile) - 1])
    return out


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
        diff = np.abs(after - before).max(axis=2) > THRESH
        count = int(diff.sum())
        imgs = len(list(page.get_images()))
        text = page.get_text().strip().replace('\n', ' | ')
        if not count:
            # A faint mark can sit entirely under the difference threshold (0.1 on
            # paper differs by ten levels), so report the sub-threshold count too
            # rather than calling an invisible page empty.
            faint = int((np.abs(after - before).max(axis=2) > 2).sum())
            low = float(luma(after).min())
            print(f'p{index+1} {w:.1f}x{h:.1f} rot{page.rotation} added_px=0 faint_px={faint} darkest={low:.1f} imgs={imgs} text="{text[:50]}"')
            continue
        ys, xs = np.nonzero(diff)
        x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
        rows, cols = after.shape[0], after.shape[1]
        fx0, fx1 = (x0 + 1) / cols, (x1 + 1) / cols
        fy0, fy1 = (y0 + 1) / rows, (y1 + 1) / rows
        inside = fx0 >= 0 and fx1 <= 1.0 and fy0 >= 0 and fy1 <= 1.0
        edge = int(diff[:, cols - 2:].sum()) + int(diff[rows - 2:, :].sum())
        # Paper: the pixels the mark did not touch. Ink: the mark's own pixels.
        la = luma(after)
        paper = float(np.median(la[~diff])) if (~diff).any() else 255.0
        ink = float(la[diff].mean())
        darkest = float(la[diff].min())
        # Opacity is read off the mark's own *area*, not off the pixels that beat the
        # threshold: at 0.1 the surviving pixels are the darkest of the mark and their
        # mean flatters it. `box_luma` is the mean over the box the diff spans and
        # `faint` is the count of pixels differing by even 2 levels, so 1.0 / 0.5 / 0.1
        # compare on the same footing.
        box_luma = float(la[y0:y1 + 1, x0:x1 + 1].mean())
        faint = int((np.abs(after - before).max(axis=2) > 2).sum())
        # Anything the diff found *outside* the mark box is damage to the page.
        outside = diff.copy()
        outside[y0:y1 + 1, x0:x1 + 1] = False
        print(
            f'p{index+1} {w:.1f}x{h:.1f} rot{page.rotation} added_px={count} imgs={imgs} '
            f'ink_x=[{fx0:.3f},{fx1:.3f}] ink_y_from_top=[{fy0:.3f},{fy1:.3f}] '
            f'inside={inside} edge_px={edge} overflow_px={int(outside.sum())} '
            f'ink_luma={ink:.1f} box_luma={box_luma:.1f} faint_px={faint} paper_luma={paper:.1f} darkest={darkest:.1f} '
            f'w/h_ratio={(x1 - x0 + 1) / max(1, y1 - y0 + 1):.2f} text="{text[:44]}"'
        )
        colc = clusters(diff.sum(axis=0) > 0)
        rowc = clusters(diff.sum(axis=1) > 0)
        if len(colc) > 2 or len(rowc) > 2:
            cw = [c[1] - c[0] + 1 for c in colc]
            steps = [round((colc[i + 1][0] - colc[i][0]) / dpi * 72, 1) for i in range(len(colc) - 1)]
            rsteps = [round((rowc[i + 1][0] - rowc[i][0]) / dpi * 72, 1) for i in range(len(rowc) - 1)]
            print(
                f'   tile cols={len(colc)} rows={len(rowc)} '
                f'step_x={steps[:6]} step_y={rsteps[:6]} '
                f'first_w={cw[0]} last_w={cw[-1]} clipped_edge={cw[-1] < cw[0]}'
            )
        if '--no-spans' in sys.argv:
            continue
        for block in page.get_text('dict')['blocks']:
            for line in block.get('lines', []):
                for span in line['spans']:
                    b = span['bbox']
                    if b[0] < (x1 + 1) / dpi * 72 and b[2] > x0 / dpi * 72 and b[1] < (y1 + 1) / dpi * 72 and b[3] > y0 / dpi * 72:
                        print(f'   span font={span["font"]} size={span["size"]:.1f} colour={span["color"]:#08x} bbox={[round(v,1) for v in b]} "{span["text"][:40]}"')


main()
