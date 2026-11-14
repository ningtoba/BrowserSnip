#!/usr/bin/env python3
"""What a merge did to the papers it was given, and to everything that is not a page.

    python3 docs/research/merge-round-bytes.py /tmp/triage/colour.pdf /tmp/triage/sheets.pdf /tmp/merge/after.pdf

For each file: the document info and XMP, the outline, the page-label ranges, the
embedded files, then per sheet its displayed box, `/MediaBox`, `/CropBox`,
`/Rotate`, character count, non-white pixel count at 50 dpi, annotations, links and
images. Non-white ink is counted off a real raster, so a page of paper and a page
of text are told apart; the same measurement is taken of the sources, which is what
makes "the merged pages are the source pages, in order" a comparison rather than a
guess.
"""
import sys

import pymupdf

DPI = 50
WHITE = 250


def ink(page: pymupdf.Page) -> int:
    pix = page.get_pixmap(dpi=DPI)
    return sum(1 for i in range(0, len(pix.samples), pix.n) if pix.samples[i] < WHITE)


def report(path: str) -> None:
    doc = pymupdf.open(path)
    info = {k: v for k, v in (doc.metadata or {}).items() if v}
    print(f"== {path}")
    print(f"   pages {doc.page_count}  encrypted {doc.is_encrypted}")
    print(f"   info {info}")
    print(f"   xmp {bool(doc.get_xml_metadata())}  outline {len(doc.get_toc())}  labels {doc.get_page_labels()}  embfiles {doc.embfile_count()}")
    for page in doc:
        rect = tuple(round(v, 1) for v in page.rect)
        media = tuple(round(v, 1) for v in page.mediabox)
        crop = tuple(round(v, 1) for v in page.cropbox)
        print(
            f"   [{page.number}] box {rect} media {media} crop {crop} rot {page.rotation}"
            f" chars {len(page.get_text())} ink {ink(page)}"
            f" annots {len(list(page.annots()))} links {len(page.get_links())} images {len(page.get_images())}"
        )


for target in sys.argv[1:]:
    report(target)
