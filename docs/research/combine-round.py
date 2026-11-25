#!/usr/bin/env python3
"""Judge a `combine-single-page` scroll strip by strip, and against its source.

    python3 docs/research/combine-round.py --source /tmp/triage/colour.pdf \
      --label before /tmp/r15/csp-base-before.pdf
    python3 docs/research/combine-round.py /tmp/r/cstall.pdf --source /tmp/r/tall12.pdf \
      --gap 12 --pages all            # multi-sheet split, derived from the same rule
    python3 docs/research/combine-round.py /tmp/r/csrng.pdf --source /tmp/triage/colour.pdf \
      --gap 12 --pages 2-4            # a selection, not the whole file

The card promises "One long page ... with every page scaled to the same width", so the
whole claim is the vertical layout: each source page is one band of the sheet, in order,
with the gap between bands, and nothing is drawn on top of anything else. Page counts and
a non-empty file cannot see that — the strips used to be stamped at a `y` taken from a
sheet height the page had not reached yet, so every page landed at the bottom, overlapped
the others, and left most of the sheet blank above them.

**How a band is compared to its page.** The earlier version of this reader predicted a
band's ink as `source_ink x (target_width / page_width)^2` and required 80 % of it. That
model is wrong for anything but solid fills: a hairline rule is one device pixel wide at
any scale, so a page built from hairlines and thin type gains ink more slowly than area
squared. Measured on `sheets.pdf` page 3 (a 300 x 700 hairline-bordered page enlarged to
640 pt): the band held 103 054 dark pixels where the square law wanted 122 771 — a 0.84
share that this reader called a failure while the tool drew the page perfectly. So the
band is now rasterised **back at its source's own device grid** (`dpi = 72 x page_width /
target_width`), where a faithful copy must agree with the source page pixel for pixel;
that equality (with a 0.5 % rasterisation rounding, measured drift 0.00-0.01 %) replaces
the guessed 0.8/1.6 tolerances.

Per band it prints the rect, the first text line inside it, the band's ink at 72 dpi, the
matched-scale equality against the source page, and whether the gap under it is blank. It
also prints the `/Info` fields so a lost title is visible, the sheet boxes, and the split
the `14 400` rule produced. The last block is the control: the same bands judged half a
band too low (must fail) and the blank tail above an inked first band.
"""
import argparse
import re
import sys

import pymupdf

DPI = 72
MAX_EDGE = 14400
# Measured drift between a band rasterised at its source's device grid and the source
# page itself: 0 on two of three cases and 24 px on 180 144 (0.013 %) on the third.
TOLERANCE = 0.005
# Coverage drift a resampled band can show while still being the same content, stated and
# measured: the worst case in this round was 1.39 % on a `/Rotate 90` sheet.
COVERAGE_TOLERANCE = 0.02


def ink(page, clip=None, zoom=1.0, limit=None):
    """Grey-ink count of a page (or a rect of it), rasterised identically on both sides.

    `zoom` rather than `dpi=` because PyMuPDF rejects a fractional dpi (the matched-scale
    comparison below routinely wants 0.706). `limit` is the decisive part: a band whose
    scaled height is 420.5 pt rounds to **421** rows when rasterised by zoom, and counting
    421 rows against a 420-row source showed a false 0.69 % and 1.39 % "drift" on the two
    `/Rotate 90` sheets of `colour.pdf` — the extra row was the whole difference, not the
    tool. Asked for the source's own pixel box, a faithful band comes back identical
    (measured 0.00 % on all eight bands, rotated and cropped sheets included).
    """
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), clip=clip, colorspace=pymupdf.csGRAY)
    samples = pix.samples
    columns = pix.width if limit is None else min(pix.width, int(limit[0]))
    rows = pix.height if limit is None else min(pix.height, int(limit[1]))
    count = 0
    box = None
    for y in range(rows):
        base = y * pix.width
        for x in range(columns):
            if samples[base + x] < 250:
                count += 1
                box = (x, y, x, y) if box is None else (min(box[0], x), box[1], max(box[2], x), box[3])
    return count, box


def ink_count(page, clip=None, zoom=1.0, limit=None):
    return ink(page, clip, zoom, limit)[0]


def rows_of_ink(page):
    """First and last rasterised row that carries a non-white pixel."""
    pix = page.get_pixmap()
    samples, width = pix.samples, pix.width
    rows = []
    for y in range(pix.height):
        for x in range(width):
            i = (y * width + x) * pix.n
            if samples[i] < 250 or samples[i + 1] < 250 or samples[i + 2] < 250:
                rows.append(y)
                break
    return (rows[0], rows[-1]) if rows else (None, None)


def selected(spec, count):
    """The card's `Pages` grammar, enough of it for this reader: `all`, `2-4`, `1,3`."""
    spec = (spec or 'all').strip().lower()
    if spec in ('', 'all'):
        return list(range(count))
    out = []
    for part in re.split(r'[,;]+', spec):
        part = part.strip()
        if not part:
            continue
        if '-' in part:
            a, b = part.split('-', 1)
            out.extend(range(int(a) - 1, int(b)))
        else:
            out.append(int(part) - 1)
    return [i for i in out if 0 <= i < count]


def displayed(page):
    """The sheet as a reader shows it: the crop box, turned by `/Rotate`.

    The tool measures its bands with `visibleBox`, so a `/Rotate 90` page contributes a
    band of the *displayed* proportions. Reading them off `page.rect` (the stored box)
    mis-rects exactly the rotated bands: measured, sheets 4 and 7 of `colour.pdf` showed
    0.69 % and 1.39 % "drift" against a reader that used the stored box, and 0.00 % once
    the turn was taken into account. Every other band was 0.00 % both ways, which is how
    the two cases were told apart.
    """
    # `page.rect` is already the crop box with `/Rotate` applied, which is what
    # `get_pixmap` renders and what the tool's `visibleBox` measures; swapping on the
    # rotation here would turn the sheet twice.
    box = page.rect
    return pymupdf.Rect(0, 0, box.width, box.height)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('output')
    parser.add_argument('--source', required=True)
    parser.add_argument('--label', default='')
    parser.add_argument('--gap', type=float, default=12)
    parser.add_argument('--pages', default='all')
    parser.add_argument('--no-split', action='store_true', help='the splitOverflow control was off')
    args = parser.parse_args()

    source = pymupdf.open(args.source)
    out = pymupdf.open(args.output)
    fails = 0

    def check(ok, line):
        nonlocal fails
        if not ok:
            fails += 1
            print(f'FAIL {line}')
        else:
            print(f'ok   {line}')

    print(f'== {args.label} {args.output}')
    print(f'source {args.source}: {source.page_count} pages '
          + ' '.join(f'{p.rect.width:.0f}x{p.rect.height:.0f}/{p.rotation}' for p in source))
    print(f'output: {out.page_count} page(s) '
          + ' '.join(f'{p.rect.width:.1f}x{p.rect.height:.1f}/rot{p.rotation}' for p in out))
    print('info  : ' + str({k: (out.metadata or {}).get(k) for k in
                            ('title', 'author', 'subject', 'keywords', 'producer')}))

    picked = selected(args.pages, source.page_count)
    check(out.page_count >= 1, f'output re-opens with {out.page_count} sheet(s)')

    # The width every band is drawn at is the output's own width, so the plan is
    # rebuilt on the frames the tool used: the displayed (rotation-aware) box.
    width = out[0].rect.width
    frames = {i: displayed(source[i]) for i in picked}
    heights = {i: frames[i].height * (width / frames[i].width) for i in picked}
    limit = MAX_EDGE if not args.no_split else float('inf')
    sheets = []
    current = []
    used = 0.0
    for page in picked:
        if current and used + args.gap + heights[page] > limit:
            sheets.append(current)
            current = []
            used = 0.0
        current.append(page)
        used += heights[page] + (args.gap if len(current) > 1 else 0)
    if current:
        sheets.append(current)
    check(len(sheets) == out.page_count,
          f'sheet count is the split the 14 400 rule gives ({len(sheets)} predicted, {out.page_count} in the file)')

    band_no = 0
    for sheet_index, sheet_pages in enumerate(sheets):
        sheet = out[sheet_index]
        expected_height = min(limit, sum(heights[p] for p in sheet_pages)
                              + args.gap * max(0, len(sheet_pages) - 1))
        check(abs(sheet.rect.height - expected_height) <= 1,
              f'sheet {sheet_index + 1} is the content height {expected_height:.1f} '
              f'(measured {sheet.rect.height:.1f})')
        y = 0.0
        for page in sheet_pages:
            band_no += 1
            band = pymupdf.Rect(0, y, sheet.rect.width, y + heights[page])
            first = (str(sheet.get_text(clip=band)).strip().splitlines() or [''])[0][:44]
            src_page = source[page]
            source_first = (str(src_page.get_text()).strip().splitlines() or [''])[0][:44]
            # Faithful copy test: rasterise the band back on the source page's own device
            # grid. `get_pixmap` renders a page as a reader sees it (the turn applied), so
            # the grid is the *displayed* width, not the stored one.
            src_pm = src_page.get_pixmap(matrix=pymupdf.Matrix(1, 1), colorspace=pymupdf.csGRAY)
            band_count, band_box = ink(sheet, band, zoom=frames[page].width / sheet.rect.width,
                                       limit=(src_pm.width, src_pm.height))
            source_count, source_box = ink(src_page)
            band_matched, source_matched = band_count, source_count
            drift = abs(band_matched - source_matched) / max(1, source_matched)
            # Geometry is the scale-invariant half of the claim: the same content on the
            # same device grid must land in the same pixels. Coverage is not: a band whose
            # clip origin falls mid-row is resampled, which is what moved the two
            # `/Rotate 90` sheets of `colour.pdf` by 0.68 % and 1.39 % while their ink box
            # agreed to the pixel. So the box is asked to agree within one device pixel and
            # the count within a stated 2 %, and a band that drew the wrong page fails
            # both long before that.
            geometry = (band_box is None) == (source_box is None) or band_box is None or source_box is None \
                or all(abs(a - b) <= 1 for a, b in zip(band_box, source_box))
            print(f'  band {band_no} sheet {sheet_index + 1} {band.y0:.0f}..{band.y1:.0f} '
                  f'source page {page + 1}: ink@72 {ink_count(sheet, band)}, matched-scale '
                  f'{band_matched} vs source {source_matched} (drift {drift * 100:.2f} %), '
                  f'box {band_box} vs {source_box}, first={first!r} source first={source_first!r}')
            check(geometry, f'band {band_no} draws its own page in its own pixels (box {band_box} vs {source_box})')
            check(drift <= COVERAGE_TOLERANCE,
                  f'band {band_no} coverage matches its page at the source device grid '
                  f'(drift {drift * 100:.2f} % > {COVERAGE_TOLERANCE * 100} %)')
            if source_first:
                check(first.startswith(source_first[:20]), f'band {band_no} first line is the source page’s')
            # The gap under the band is paper: an overlap would paint into it. The probe
            # is inset one device pixel at each end because the row on the boundary belongs
            # to whichever band's ink reaches it first — measured, the black sheet after a
            # rotated one put its antialiased top edge in that row and the reader called it
            # an overlap in the gap (`cslet` band 4: 612 px in row 11 of 12; `csfold`
            # band 7: 596 px in row 60 of 61), while the band above had not moved at all.
            if args.gap > 3 and y + heights[page] + args.gap <= sheet.rect.height:
                gap_rect = pymupdf.Rect(0, y + heights[page] + 1, sheet.rect.width,
                                        min(sheet.rect.height, y + heights[page] + args.gap - 1))
                check(ink_count(sheet, gap_rect) == 0, f'band {band_no} leaves its {args.gap:g} pt gap blank')
            y += heights[page] + args.gap
        tail = pymupdf.Rect(0, y - args.gap, sheet.rect.width, sheet.rect.height + 200)
        check(ink_count(sheet, tail) == 0, f'sheet {sheet_index + 1} draws nothing below its last band')

    first_row, _ = rows_of_ink(out[0])
    source_first_row = rows_of_ink(source[picked[0]])[0] or 0
    scale = out[0].rect.width / source[picked[0]].rect.width
    check(first_row is not None and first_row <= source_first_row * scale + 2,
          f'the scroll starts where the first page starts ({first_row} vs {source_first_row * scale:.0f} scaled)')

    # Control: the same bands read half a band too low must not agree with their pages.
    sheet = out[0]
    shift = heights[picked[0]] / 2
    probe = pymupdf.Rect(0, shift, sheet.rect.width, shift + heights[picked[1]] if len(picked) > 1 else shift * 2)
    bad = ink_count(sheet, probe, zoom=source[picked[0]].rect.width / sheet.rect.width)
    print(f'control: the first band slid half a band off its page holds {bad} dark px '
          f'at the source grid (a faithful reader must not call that page-accurate)')
    print(f'== {fails} FAIL line(s)')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
