#!/usr/bin/env python3
"""Fixtures for the `edit-pdf-text` re-flow question.

  python3 docs/research/text-reflow-fixture.py /tmp/rf

Two documents, because the question is a collision and a collision needs a
neighbour:

  reflow.pdf   page 1 is a stack: a heading, a **two-line** target paragraph
               (`TARGET ALPHA bravo charlie ...`), and directly under it a
               second paragraph (`FOLLOWING HOTEL sierra ...`) only one line
               gap away, then far content near the page foot. A replacement
               that needs more lines than the target came from has nowhere to
               go but over the paragraph below. Page 2 is the same kind of
               stack on a `595x842` sheet stored `/Rotate 90`, so the viewer's
               idea of "down" is the content stream's idea of "along".
               `/Info` carries a title and an author and page 1 carries two
               annotations and a link, so the same run also answers whether an
               in-place edit keeps them.

  control.pdf  one block with 200 pt of clear paper under it: a replacement
               that does not grow must not move, and one that fits inside the
               gap must not shrink.

Text is Helvetica at 10 pt, one `(text) Tj` per line, so every line's own box
is readable from the file.
"""
import json
import os
import sys
import tempfile

import pymupdf

TARGET_1 = "TARGET ALPHA bravo charlie delta echo foxtrot golf"
TARGET_2 = "hotel india juliet kilo lima mike november"
FOLLOW_1 = "FOLLOWING HOTEL sierra tango uniform victor whiskey"
FOLLOW_2 = "xray yankee zulu and more words under the block"
FAR = "FAR FOOT LINE nothing should reach this"


def stack(page, x, y, lines, size=10, step=13):
    for index, line in enumerate(lines):
        page.insert_text((x, y + index * step), line, fontsize=size, fontname="helv")


def build_reflow(path):
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    stack(page, 50, 80, ["HEADING ONE"], size=18, step=24)
    stack(page, 50, 140, [TARGET_1, TARGET_2], step=16)
    # One line gap wider than the block's own leading, so the neighbour is its own
    # paragraph rather than part of the block that is being rewritten.
    stack(page, 50, 190, [FOLLOW_1, FOLLOW_2])
    stack(page, 50, 780, [FAR])
    # Two annotations and a link, all clear of the stack, so a surviving
    # `/Annots` array is readable back out of the exported file.
    page.add_highlight_annot(pymupdf.Rect(50, 60, 200, 75))
    page.add_text_annot((480, 120), "a sticky note", icon="Note")
    page.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(50, 700, 200, 714), "uri": "https://example.com/x"})
    # The rotated sheet: the same two-line target with the same neighbour, the
    # page stored 90 degrees clockwise so a viewer paints the stack sideways.
    turned = doc.new_page(width=595, height=842)
    stack(turned, 50, 140, [TARGET_1, TARGET_2], step=16)
    stack(turned, 50, 190, [FOLLOW_1, FOLLOW_2])
    turned.set_rotation(90)
    doc.set_metadata({"title": "Reflow fixture: a two-line block over its neighbour", "author": "campaign", "producer": "pymupdf"})
    doc.save(path, garbage=3, deflate=True)
    doc.close()
    return path


def build_control(path):
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    stack(page, 50, 140, [TARGET_1, TARGET_2])
    # 200 pt of clear paper, then a line far below it.
    stack(page, 50, 480, [FAR])
    doc.set_metadata({"title": "Reflow control: a block with room under it"})
    doc.save(path, garbage=3, deflate=True)
    doc.close()
    return path


def main(out):
    os.makedirs(out, exist_ok=True)
    made = [build_reflow(os.path.join(out, "reflow.pdf")), build_control(os.path.join(out, "control.pdf"))]
    probe = pymupdf.open(made[0])
    page = probe[0]
    structure = {
        "files": made,
        "target": [TARGET_1, TARGET_2],
        "follow": [FOLLOW_1, FOLLOW_2],
        "target_lines": [list(page.search_for(line)[0]) for line in (TARGET_1, TARGET_2)],
        "follow_top": list(page.search_for(FOLLOW_1)[0]),
        "annots": len(list(page.annots() or [])),
        "links": len(page.get_links()),
        "rotations": [p.rotation for p in probe],
        "title": probe.metadata.get("title"),
    }
    probe.close()
    print(json.dumps(structure, indent=2))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "rf"))
