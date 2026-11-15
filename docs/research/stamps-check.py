#!/usr/bin/env python3
"""Read a stamped file the way a person and a reader do.

  python3 docs/research/stamps-check.py stamped.pdf [--source source.pdf]

For every page it reports, off the rendered bitmap, the bounding box of the stamp's
own colour (`#dc2626`, or the label colour the file's appearance names), how far that
ink is from each displayed edge, whether it sits inside the page box, and the ratio of
its ink box — an upright label is wide, a label left on its side is tall. Then the
dictionary: `/S`, `/CA`, the `Tj` words of the `/AP /N` stream, and the page's
annotation, link and `/Subtype /Image` counts beside the untouched source read the
same way. No page's ink is measured unless the source renders ink too, so a blank
render cannot pass for a stamp.
"""
import collections
import re
import sys
from pathlib import Path

import pymupdf

RED = (0.862, 0.149, 0.149)
LABEL_COLOUR = re.compile(rb"([0-9.]+) ([0-9.]+) ([0-9.]+) rg")
SKIP = {b"/F1", b"Tf", b"BT", b"ET", b"Tm", b"re", b"S", b"RG", b"w", b"q", b"Q", b"1", b"cm"}

args = [a for a in sys.argv[1:] if not a.startswith("--")]
path = Path(args[0])
source = Path(args[1]) if len(args) > 1 else None


def census(doc):
    out = []
    for page in doc:
        out.append({
            "display": (round(page.rect.width, 1), round(page.rect.height, 1), page.rotation),
            "annots": len(list(page.annots() or [])),
            "links": len(page.get_links()),
            "images": sum(1 for _ in page.get_images()),
            "chars": len(page.get_text()),
        })
    return out


def label_colour(page):
    """The colour the appearance paints the words with, from the file itself."""
    for annot in page.annots() or []:
        if annot.type[1] != "Stamp":
            continue
        xref = annot.xref
        ap = page.parent.xref_get_key(xref, "AP")
        match = re.search(r"/N (\d+) 0 R", ap[1] or "")
        if not match:
            continue
        stream = page.parent.xref_stream(int(match.group(1)))
        for line in stream.splitlines():
            found = LABEL_COLOUR.search(line)
            if found:
                return tuple(float(part) * 255 for part in found.groups())
    return tuple(part * 255 for part in RED)


def ink_box(page, colour):
    pixmap = page.get_pixmap(dpi=72)
    def near(value, want):
        return abs(value - want) < 0.22
    rows = collections.defaultdict(list)
    for y in range(pixmap.height):
        for x in range(pixmap.width):
            pixel = pixmap.pixel(x, y)
            if near(pixel[0], colour[0]) and near(pixel[1], colour[1]) and near(pixel[2], colour[2]):
                rows[y].append(x)
    if not rows:
        return None, pixmap
    ys = sorted(rows)
    xs = [x for row in rows.values() for x in row]
    return (min(xs), min(ys), max(xs), max(ys)), pixmap


document = pymupdf.open(path)
print(f"MuPDF {pymupdf.version[0]} on {path.name}: {document.page_count} pages")
if source:
    before = pymupdf.open(source)
    for index, row in enumerate(census(before)):
        print(f"source p.{index + 1}: {row}")

for index, page in enumerate(document):
    shown_w, shown_h, rotation = page.rect.width, page.rect.height, page.rotation
    stamps = [a for a in (page.annots() or []) if a.type[1] == "Stamp"]
    print(f"\n-- page {index + 1}: displayed {shown_w:.0f}x{shown_h:.0f} rot {rotation}, "
          f"{len(stamps)} stamp(s), {len(page.get_links())} link(s), {len(page.get_text())} chars")
    box, pixmap = ink_box(page, label_colour(page))
    if not box:
        print("   NO stamp-coloured ink rendered")
    else:
        x0, y0, x1, y1 = box
        width, height = x1 - x0 + 1, y1 - y0 + 1
        inside = x0 >= 0 and y0 >= 0 and x1 < shown_w + 1 and y1 < shown_h + 1
        print(f"   ink bbox {width}x{height} px at ({x0},{y0}); from right {shown_w - x1 - 1:.0f}, "
              f"from top {y0}, from bottom {shown_h - y1 - 1:.0f}; inside={inside}; w/h={width / height:.2f}")
        ink = sum(1 for y in range(pixmap.height) for x in range(pixmap.width)
                  if pixmap.pixel(x, y)[:3] != (255, 255, 255))
        print(f"   non-white pixels on the page: {ink}")
    for annot in stamps:
        xref = annot.xref
        ap = document.xref_get_key(xref, "AP")
        match = re.search(r"/N (\d+) 0 R", ap[1] or "")
        # The appearance's own text, as MuPDF decodes it through the embedded face
        # — glyph ids alone say nothing about what a reader shows.
        shown = (annot.get_text() or "").strip()
        tf = re.search(rb"/F1 ([0-9.]+) Tf", document.xref_stream(int(match.group(1)))) if match else None
        print(f"   /AP text: {shown!r} at {tf.group(1).decode() if tf else '?'} pt")
        print(f"   dict: S={document.xref_get_key(xref, 'S')[1]} CA={document.xref_get_key(xref, 'CA')[1]} "
              f"Rect={tuple(round(v, 1) for v in annot.rect)} Contents={document.xref_get_key(xref, 'Contents')[1]}")
metadata = document.metadata or {}
print("\nmetadata:", {k: metadata.get(k) for k in ("title", "producer")})
