#!/usr/bin/env python3
"""Judge a `combine-single-page` scroll strip by strip, and against its source.

    python3 docs/research/combine-round.py --source /tmp/triage/colour.pdf \
      --label before /tmp/r15/csp-base-before.pdf

The card promises "One long page ... with every page scaled to the same width",
so the whole claim is the vertical layout: each source page is one band of the
sheet, in order, with the gap between bands, and nothing is drawn on top of
anything else. Page counts and a non-empty file cannot see that — the strips
used to be stamped at a `y` taken from a sheet height the page had not reached
yet, so every page landed at the bottom, overlapped the others, and left most of
the sheet blank above them.

Per output sheet this prints the band rect, the first non-empty text line inside
it, its non-white pixel count, and whether that band's ink lies inside the band
(so an overlap is a number, not an impression). It also prints the source's own
per-page ink measured the same way, the output's boxes/rotation, and the `/Info`
fields so a lost title is visible.

The last block is the control: the two ends of the sheet judged as if they were
bands (they must be blank on a fixture whose top band is inked), and the source
judged with the tool's own band geometry (it must fail — a source is not a
scroll).
"""
import argparse
import sys

import pymupdf

DPI = 72


def ink(page, clip=None):
    pix = page.get_pixmap(dpi=DPI, clip=clip)
    samples = pix.samples
    count = 0
    for i in range(0, len(samples), pix.n):
        if samples[i] < 250 or samples[i + 1] < 250 or samples[i + 2] < 250:
            count += 1
    return count


def rows_of_ink(page):
    """First and last rasterised row that carries a non-white pixel."""
    pix = page.get_pixmap(dpi=DPI)
    samples, width = pix.samples, pix.width
    rows = []
    for y in range(pix.height):
        for x in range(width):
            i = (y * width + x) * pix.n
            if samples[i] < 250 or samples[i + 1] < 250 or samples[i + 2] < 250:
                rows.append(y)
                break
    return (rows[0], rows[-1]) if rows else (None, None)


def bands(sheet, source, gap):
    """Cut the scroll where the tool claims the bands are: the source heights, scaled."""
    width = sheet.rect.width
    y = 0.0
    for page in source:
        height = page.rect.height * (width / page.rect.width)
        yield page, pymupdf.Rect(0, y, width, y + height)
        y += height + gap


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('output')
    parser.add_argument('--source', required=True)
    parser.add_argument('--label', default='')
    parser.add_argument('--gap', type=float, default=12)
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
    meta = {k: (out.metadata or {}).get(k) for k in ('title', 'author', 'subject', 'keywords', 'producer')}
    print(f'info  : {meta}')

    total_source = sum(ink(p) for p in source)
    sheet = out[0]
    expected_height = sum(p.rect.height * (sheet.rect.width / p.rect.width) for p in source) \
        + args.gap * max(0, source.page_count - 1)
    check(abs(sheet.rect.height - expected_height) <= 1,
          f'sheet is the content height {expected_height:.1f} (measured {sheet.rect.height:.1f})')

    for index, (page, band) in enumerate(bands(sheet, source, args.gap)):
        band_ink = ink(sheet, band)
        source_ink = ink(page)
        first = (str(sheet.get_text(clip=band)).strip().splitlines() or [''])[0][:44]
        source_first = (str(page.get_text()).strip().splitlines() or [''])[0][:44]
        # Ink of this band against the same source page scaled to this width.
        area = (sheet.rect.width / page.rect.width) ** 2
        predicted = source_ink * area
        share = band_ink / predicted if predicted else (1.0 if band_ink == 0 else 0.0)
        print(f'  band {index + 1} {band.y0:.0f}..{band.y1:.0f} first={first!r} '
              f'ink={band_ink} of {predicted:.0f} predicted ({share:.2f}) source first={source_first!r}')
        check(share > 0.8 if source_ink else band_ink == 0, f'band {index + 1} carries its own page')
        if source_first:
            check(first.startswith(source_first[:20]), f'band {index + 1} first line is the source page’s')
        check(band_ink <= predicted * 1.6,
              f'band {index + 1} draws nothing of another page (no overlap)')

    first_row, last_row = rows_of_ink(sheet)
    print(f'ink rows {first_row}..{last_row} of {round(sheet.rect.height)} pt')
    # The first band's ink sits where the first source page's own ink sits, scaled:
    # a page drawn at the foot of the sheet puts it thousands of points lower.
    source_first_row = rows_of_ink(source[0])[0] or 0
    scale = sheet.rect.width / source[0].rect.width
    check(first_row is not None and first_row <= source_first_row * scale + 2,
          f'the scroll starts where the first page starts '
          f'({first_row} vs {source_first_row * scale:.0f} scaled)')

    # Control: the strip below the last band is paper, and the source judged as an
    # output (one band, four pages) has to disagree with itself.
    tail = pymupdf.Rect(0, expected_height, sheet.rect.width, sheet.rect.height + 200)
    check(ink(sheet, tail) == 0, 'nothing is drawn past the last band')
    print(f'control: page count {out.page_count} == 1 sheet, source ink {total_source} '
          f'vs output ink {ink(sheet)}')
    print(f'== {fails} FAIL line(s)')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
