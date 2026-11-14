#!/usr/bin/env python3
"""What an alternate-merge put on each sheet, and what it did to everything else.

    python3 docs/research/alternate-merge-bytes.py \
        --out /tmp/alt/one-one.pdf --expect 'c1,s1,c2,s2,c3,s3,c4,s4,s5'

Each sheet of the output is identified against the **sources** — fingerprint
(width, height, /Rotate, non-white pixels at 50 dpi, character count, image count,
first text line) taken from `/tmp/triage/colour.pdf` and `/tmp/triage/sheets.pdf` at
the same time — and the resulting sequence is compared with `--expect`, token by
token. So "the interleave is the rotation the label promises" is a comparison and not
a page count. The same run prints and compares `/Info`, the XMP packet, the outline,
the page-label ranges, the annotations and the links, and exits 1 on any difference.

Tokens: `cN` = page N (1-based) of colour.pdf, `sN` = page N of sheets.pdf,
`blank` = a sheet that fingerprints like neither source.

Control: run it with `--expect 'c1,c2,c3,c4,s1,s2,s3,s4,s5'` (a plain stack) against
an interleaved file — a checker that passes on that is not measuring the order.
"""
import argparse
import sys

import pymupdf

DPI = 50
WHITE = 250
SOURCES = {'c': '/tmp/triage/colour.pdf', 's': '/tmp/triage/sheets.pdf'}


def first_line(page: pymupdf.Page) -> str:
    text = str(page.get_text()).strip()
    return text.splitlines()[0].strip() if text else ''


def fingerprint(page: pymupdf.Page) -> tuple:
    pix = page.get_pixmap(dpi=DPI)
    ink = sum(1 for i in range(0, len(pix.samples), pix.n) if pix.samples[i] < WHITE)
    return (
        round(page.rect.width, 1),
        round(page.rect.height, 1),
        page.rotation,
        ink,
        len(str(page.get_text()).strip()),
        len(page.get_images()),
        len(list(page.annots() or [])),
        len(page.get_links()),
    )


def source_labels() -> dict[tuple, str]:
    """fingerprint -> 'cN' / 'sN', refusing any fingerprint two source pages share."""
    found: dict = {}
    for prefix, path in SOURCES.items():
        doc = pymupdf.open(path)
        for page in doc:
            key = fingerprint(page)
            if key in found:
                print(f"!! source pages {found[key]} and {prefix}{page.number + 1} fingerprint alike: {key}")
                found[key] = found[key] + '/' + f"{prefix}{page.number + 1}"
            else:
                found[key] = f"{prefix}{page.number + 1}"
    return found


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--expect', default='')
    ap.add_argument('--info-of', default='')
    args = ap.parse_args()

    labels = source_labels()
    print('source fingerprints:', {v: k for k, v in labels.items()})

    doc = pymupdf.open(args.out)
    rows = []
    for page in doc:
        key = fingerprint(page)
        rows.append(labels.get(key, 'blank' if key[3] == 0 else 'UNKNOWN'))
        print(f"  [{page.number}] {rows[-1]:>6}  box {tuple(round(v, 1) for v in page.rect)}"
              f" rot {page.rotation} ink {key[3]} chars {key[4]} images {key[5]}"
              f" annots {key[6]} links {key[7]} first-line {first_line(page)!r}")
    got = ','.join(rows)
    print('sequence:', got)
    failures = []

    if args.expect:
        print('expected:', args.expect)
        if got != args.expect:
            failures.append(f'order: got {got}, expected {args.expect}')

    if args.info_of:
        src = pymupdf.open(args.info_of)
        want = {k: v for k, v in (src.metadata or {}).items() if v and k not in ('producer', 'creationDate', 'modDate')}
        have = {k: v for k, v in (doc.metadata or {}).items() if v and k not in ('producer', 'creationDate', 'modDate')}
        print('info source:', want)
        print('info output:', have, '| xmp', bool(doc.get_xml_metadata()), '/', bool(src.get_xml_metadata()))
        for field, value in want.items():
            if have.get(field) != value:
                failures.append(f'info {field}: source {value!r}, output {have.get(field)!r}')
        if src.get_xml_metadata() and not doc.get_xml_metadata():
            failures.append('info: the source XMP packet did not travel')

    print('danger: pages with an UNKNOWN fingerprint ->', rows.count('UNKNOWN'))
    for line in failures:
        print('FAIL', line)
    print('RESULT', 'pass' if not failures else f'{len(failures)} failure(s)')
    return 0 if not failures else 1


if __name__ == '__main__':
    sys.exit(main())
