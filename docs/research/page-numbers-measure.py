#!/usr/bin/env python3
"""page-numbers / bates / header-footer folio checker — bytes half of the round.

Reads a produced PDF and prints, per page, the mark text PyMuPDF extracts, the
span size and fill colour, and the mark's box **in the space a viewer shows**
(PyMuPDF's unrotated extraction space is mapped through /Rotate first). A folio
whose right margin is negative runs off the page; a mark on a page the selection
excluded is a count defect.

    python3 docs/research/page-numbers-measure.py out.pdf --pat 'Page \\d+'

Lane note: `get_text("dict")` reports coordinates PRE-rotation; this script
applies the /Rotate transform itself, so the printed box is what a viewer draws.
"""
import argparse
import re
import sys

import pymupdf


def displayed_box(page, bbox):
    """Map a dict-span bbox (unrotated, y-down in PyMuPDF space) to displayed space."""
    rot = page.rotation % 360
    r = page.rect  # rotation-aware page rect (PyMuPDF)
    x0, y0, x1, y1 = bbox
    # PyMuPDF dict coords live in the UNrotated sheet (y-down, origin top-left).
    w, h = page.mediabox.width, page.mediabox.height
    if rot == 90:      # viewer turns the sheet 90 CW: (x,y) -> (h - y, x)
        return (h - y1, x0, h - y0, x1)
    if rot == 180:
        return (w - x1, h - y1, w - x0, h - y0)
    if rot == 270:
        return (y0, w - x1, y1, w - x0)
    return (x0, y0, x1, y1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--pat", default=r"(?i)(page[\s.]*\d|^\d+$|[IVXLC]+|[A-Z]{1,3}|no\.\s*\d)")
    ap.add_argument("--dpi", type=int, default=0, help="also render page pixmaps to this dpi")
    args = ap.parse_args()

    doc = pymupdf.open(args.pdf)
    pat = re.compile(args.pat)
    total = 0
    for i, page in enumerate(doc):
        dw, dh = page.rect.width, page.rect.height
        for block in page.get_text("dict")["blocks"]:
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    text = span["text"].strip()
                    if not text or not pat.search(text):
                        continue
                    # skip body text we did not stamp when a strict pattern was given
                    bx = displayed_box(page, span["bbox"])
                    c = span["color"]
                    left, top = round(bx[0], 1), round(bx[1], 1)
                    right_gap, bottom_gap = round(dw - bx[2], 1), round(dh - bx[3], 1)
                    total += 1
                    print(f"p{i+1} rot={page.rotation} disp={round(dw)}x{round(dh)} "
                          f"text={text!r} size={round(span['size'],2)} "
                          f"colour=#{(c >> 16) & 255:02x}{(c >> 8) & 255:02x}{c & 255:02x} "
                          f"box=({left},{top},{round(bx[2],1)},{round(bx[3],1)}) "
                          f"gaps l={left} t={top} r={right_gap} b={bottom_gap}")
    print(f"# {total} matching runs on {doc.page_count} pages", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
