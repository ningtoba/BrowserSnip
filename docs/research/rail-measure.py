#!/usr/bin/env python3
"""Measure what a PDF actually contains, page by page.

  python3 docs/research/rail-measure.py /tmp/probe/out/merge-00-x.pdf [more.pdf …]

Prints, per file: page count, each page's identifying first line (so order is
read, not counted), text length, image count, link count, form fields, and the
non-white pixel coverage of the page rasterised at 100 dpi — ink off the pixels,
never inferred from an object count. Pass --brief for one line per page field
set without the raster, or --no-ink to skip the pixels.
"""
import os
import sys

import pymupdf

DPI = 100
STRIDE = 7


def ink(page):
    """Non-white coverage, sampled off the rasterised bitmap."""
    pix = page.get_pixmap(dpi=DPI, colorspace=pymupdf.csRGB)
    buf = pix.samples
    step = pix.n * STRIDE
    sampled = 0
    dark = 0
    for i in range(0, max(len(buf) - (pix.n - 1), 0), step):
        sampled += 1
        if buf[i] < 245 or buf[i + 1] < 245 or buf[i + 2] < 245:
            dark += 1
    return 100.0 * dark / max(sampled, 1)


def describe(path, show_ink=True, full=True):
    if not os.path.exists(path):
        print(f"{path}: MISSING")
        return
    with open(path, "rb") as handle:
        raw = handle.read()
    try:
        doc = pymupdf.open(path)
    except Exception as exc:  # noqa: BLE001
        print(f"{path}: UNOPENABLE {type(exc).__name__}: {exc}")
        return
    meta = doc.metadata or {}
    print(f"== {path}: pages={doc.page_count} bytes={len(raw)} "
          f"encrypted={meta.get('encryption')} needs_pass={doc.needs_pass} toc={len(doc.get_toc())}")
    for index in range(doc.page_count):
        page = doc[index]
        text = str(page.get_text())
        words = [ln for ln in text.strip().splitlines() if ln.strip()]
        first = words[0][:52] if words else "(no text)"
        links = len(page.get_links())
        annots = len(list(page.annots() or []))
        widgets = len(list(page.widgets() or []))
        imgs = len(page.get_images(full=True))
        draws = len(page.get_drawings())
        paint = f"ink={ink(page):5.2f}%" if show_ink else "ink=  skip"
        print(f"  p{index + 1:<3} {paint} chars={len(text):5} "
              f"imgs={imgs:<3} links={links:<2} annots={annots:<2} widgets={widgets:<2} "
              f"draw={draws:<4} | {first}")
        if not full:
            break
    doc.close()


if __name__ == "__main__":
    paths = [a for a in sys.argv[1:] if not a.startswith("--")]
    for one in paths:
        describe(one, show_ink="--no-ink" not in sys.argv, full="--brief" not in sys.argv)
