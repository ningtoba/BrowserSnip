#!/usr/bin/env python3
"""Read a PDF's page boxes with readers that are not this app.

Used by `cbz-page-size-proof.mjs`: the browser produces the files, this names the
geometry. `/MediaBox`, the effective `/CropBox` and the rectangle each picture is
drawn into are printed per page from two independent readers (pymupdf, pypdf),
because the fix being checked is exactly a claim about those boxes.

    python3 docs/research/cbz-page-size-boxes.py /tmp/org/cbz-page-size-fit.pdf ...
"""
import sys

import pymupdf
import pypdf

for path in sys.argv[1:]:
    print(path)
    doc = pymupdf.open(path)
    for index in range(doc.page_count):
        page = doc[index]
        w, h = round(page.rect.width, 2), round(page.rect.height, 2)
        crop = page.cropbox
        print(f"  pymupdf page {index + 1}: mediabox/canvas {w}x{h}  cropbox "
              f"{round(crop.width, 2)}x{round(crop.height, 2)}  "
              f"images {len(page.get_images(full=True))}  "
              f"drawn image bbox {[tuple(round(v, 1) for v in (b['bbox'])) for b in page.get_image_info()]}")
    doc.close()
    reader = pypdf.PdfReader(path)
    for index, page in enumerate(reader.pages):
        # Asked FIRST, on purpose: reading `.cropbox` makes pypdf write a `/CropBox`
        # into the page object when the file left the entry out, so checking after
        # the fact reports the reader's default as if it were the writer's.
        written = "/CropBox" in page
        media = page.mediabox
        crop = page.cropbox
        # `/CropBox` is optional (ISO 32000-1 §14.11.2): a page that leaves it out is
        # visible in its `/MediaBox`, which is the box both readers print.
        print(f"  pypdf    page {index + 1}: media {float(media.width):.2f}x{float(media.height):.2f}  "
              f"crop {float(crop.width):.2f}x{float(crop.height):.2f}  "
              f"(/CropBox on the page: {written})")
