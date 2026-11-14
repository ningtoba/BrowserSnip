#!/usr/bin/env python3
"""fix-page-size byte check: what the produced sheets are, not how many there are.

Round 018. Every claim about this tool is one of two readings on a real file, and
this script is both:

  * **the box** — `MediaBox`, `CropBox`, `/Rotate` and the ink bounding box, per
    sheet, so "every output sheet is the chosen paper" and "the displayed box is
    the paper" are numbers rather than a look.
  * **the ink** — non-white pixels at 72 dpi with annotations off, their bounding
    box, and that box's aspect. Ink counted *with* annotations on is the trap:
    a text-annotation icon alone moved a source's box by 30 pt in the first pass.

Read the aspect against the same measurement of the source page: a "fit inside"
or "fill" run must land within a pixel of the source's, a "stretch" run must not.

    python3 docs/research/fix-page-size-bytes.py SRC BEFORE AFTER [--more FILE]

`--more` adds a case, so one invocation carries the whole matrix: the source, the
before build, the after build, and the controls that have to disagree (a blank
sheet with no ink, a page left at its own size).
"""
import argparse
import sys

import pymupdf


def ink(page):
    """(x0, y0, x1, y1, aspect, width, height) of the non-white pixels, or None."""
    pix = page.get_pixmap(dpi=72, annots=False)
    samples, stride, n, width = pix.samples, pix.stride, pix.n, pix.width
    xs, ys = [], []
    for y in range(pix.height):
        row = samples[y * stride:y * stride + width * n]
        for x in range(width):
            if any(v != 255 for v in row[x * n:x * n + 3]):
                xs.append(x)
                ys.append(y)
    if not xs:
        return None
    w, h = max(xs) - min(xs) + 1, max(ys) - min(ys) + 1
    return (min(xs), min(ys), max(xs), max(ys), round(w / h, 3), pix.width, pix.height)


def report(label, path):
    doc = pymupdf.open(path)
    meta = doc.metadata or {}
    print(f"== {label} {path}")
    print(f"   pages {doc.page_count} title {meta.get('title')!r} producer {meta.get('producer')!r}"
          f" author {meta.get('author')!r} outline {len(doc.get_toc())}")
    for page in doc:
        box = ink(page)
        print(f"   p{(page.number or 0) + 1} box {tuple(round(v, 1) for v in page.mediabox)}"
              f" crop {tuple(round(v, 1) for v in page.cropbox)} rotate {page.rotation}"
              f" annots {len(list(page.annots() or []))} text {len(page.get_text())}"
              f" ink {box}")
    doc.close()


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("before")
    ap.add_argument("after")
    ap.add_argument("--more", nargs="*", default=[], help="extra files, labelled by path")
    args = ap.parse_args(argv)
    report("source", args.source)
    report("before", args.before)
    report("after", args.after)
    for extra in args.more:
        report("case", extra)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
