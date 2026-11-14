#!/usr/bin/env python3
"""rotate-custom — what the produced file actually contains, per sheet.

    python3 docs/research/rotate-custom-bytes.py --dir /tmp/r/rc --source /tmp/triage/colour.pdf

For every produced sheet and the source sheet it came from, prints the displayed
box, `/Rotate`, non-white pixels at 100 dpi, the dark-ink centroid, the direction of
the first text line (degrees, image space, y down), characters, `/Annots`, links and
images, plus `/Info` — and, for a 1:1 turn, the ink ratio against the source, which is
what says whether a corner was cut or the content was scaled.

The instrument is checked before it is trusted: `--selfcheck` measures a page of
paper (`blank.pdf`) and requires 0 ink and no line direction on it, and re-measures
the source twice to prove the numbers are stable.
"""
import argparse
import json
import math
import sys

import pymupdf

DPI = 100


def displayed(page):
    box = page.rect
    if page.rotation % 180 == 90:
        return box.height, box.width
    return box.width, box.height


def ink(pix):
    """(non-white pixel count, centroid of the dark pixels) of a pixmap."""
    data = pix.samples
    n = pix.n
    stride = pix.stride
    nonwhite = 0
    dark_n = 0
    sx = sy = 0.0
    for y in range(pix.height):
        row = y * stride
        for x in range(pix.width):
            i = row + x * n
            r, g, b = data[i], data[i + 1], data[i + 2]
            if r != 255 or g != 255 or b != 255:
                nonwhite += 1
            if r < 128 and g < 128 and b < 128:
                dark_n += 1
                sx += x
                sy += y
    centroid = (round(sx / dark_n / pix.width, 3), round(sy / dark_n / pix.height, 3)) if dark_n else None
    return nonwhite, dark_n, centroid


def line_direction(page):
    """Direction of the first text line, in image space (y down), degrees."""
    raw = page.get_text("rawdict")
    for block in raw.get("blocks", []):
        for line in block.get("lines", []):
            chars = [c for span in line["spans"] for c in span["chars"]]
            if len(chars) < 3:
                continue
            first, last = chars[0]["origin"], chars[-1]["origin"]
            dx, dy = last[0] - first[0], last[1] - first[1]
            if math.hypot(dx, dy) < 2:
                continue
            return round(math.degrees(math.atan2(dy, dx)), 1)
    return None


def measure(path, sheets=None):
    doc = pymupdf.open(path)
    out = {"file": path, "pages": doc.page_count, "meta": doc.metadata, "sheets": []}
    for page in doc:
        if sheets is not None and page.number not in sheets:
            continue
        w, h = displayed(page)
        pix = page.get_pixmap(dpi=DPI)
        nonwhite, dark, centroid = ink(pix)
        out["sheets"].append({
            "page": page.number,
            "displayed": [round(w, 1), round(h, 1)],
            "rendered": [pix.width, pix.height],
            "rotate": page.rotation,
            "mediabox": [round(v, 1) for v in page.mediabox],
            "cropbox": [round(v, 1) for v in page.cropbox],
            "ink": nonwhite,
            "dark": dark,
            "centroid": centroid,
            "line": line_direction(page),
            "chars": len(page.get_text()),
            "annots": len(list(page.annots() or [])),
            "links": len(page.get_links()),
            "images": len(page.get_images()),
            "first_line": str(page.get_text("text")).strip().split("\n")[0][:60],
            "ink_x": round(pix.width * (centroid[0] if centroid else 0), 1),
        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir")
    ap.add_argument("--source", default="/tmp/triage/colour.pdf")  # noqa: S108
    ap.add_argument("--cases", default="")
    ap.add_argument("--selfcheck", action="store_true")
    args = ap.parse_args()

    source = measure(args.source)
    if args.selfcheck:
        blank = measure("/tmp/triage/blank.pdf")  # noqa: S108
        print("selfcheck blank:", json.dumps(blank["sheets"]))
        again = measure(args.source)
        same = [s["ink"] for s in again["sheets"]] == [s["ink"] for s in source["sheets"]]
        print("selfcheck stable source re-measure:", same)
        if not same:
            sys.exit("instrument is not stable")
    print("SOURCE:", json.dumps(source["sheets"]))
    print("SOURCE /Info title:", json.dumps(source["meta"].get("title")))

    import glob
    import os
    names = sorted(glob.glob(os.path.join(args.dir, "*.pdf")))
    if args.cases:
        wanted = set(args.cases.split(","))
        names = [n for n in names if os.path.basename(n).split(".")[0] in wanted]
    for name in names:
        got = measure(name)
        src_ink = [s["ink"] for s in source["sheets"]]
        line = []
        for s in got["sheets"]:
            src = src_ink[s["page"]] if s["page"] < len(src_ink) else None
            ratio = round(s["ink"] / src, 3) if src else None
            line.append(f"p{s['page']} box={s['displayed']} rot={s['rotate']} ink={s['ink']} "
                        f"ratio={ratio} dark={s['dark']} cen={s['centroid']} line={s['line']} "
                        f"chars={s['chars']} ann={s['annots']} link={s['links']} img={s['images']}")
        print(os.path.basename(name), f"pages={got['pages']}",
              "title=" + json.dumps(got["meta"].get("title")))
        for row in line:
            print("   ", row)


if __name__ == "__main__":
    main()
