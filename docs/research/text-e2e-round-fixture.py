#!/usr/bin/env python3
"""The multi-block CV the text editor's ticket needed: the campaign's CV text
re-cut so the big paragraph and the `Keywords:` line are separate pane blocks
(the shipped `sample.pdf` fixture clusters to one), with a paragraph below both
so a re-flow has a real neighbour to fit against.

    python3 docs/research/text-e2e-round-fixture.py /tmp/er   # -> /tmp/er/sample.pdf

Used by `text-campaign-repro.mjs` (big and small block halves) and
`text-e2e-round.mjs` (the load → edit → export → reload → dark round).
"""
import os
import sys

import pymupdf

BIG = (
    "Built the reporting pipeline for the analytics group and shipped it in six "
    "weeks, then rewrote the ingest layer so nightly loads finished before the "
    "morning standup. The team adopted the dashboards across three product lines "
    "and support tickets about stale numbers dropped by forty percent within a "
    "quarter of the launch, which the review called exemplary."
)


def wrap(text, width=72):
    lines, cur = [], ""
    for word in text.split(" "):
        candidate = (cur + " " + word).strip()
        if len(candidate) > width:
            lines.append(cur)
            cur = word
        else:
            cur = candidate
    if cur:
        lines.append(cur)
    return lines


def main(out):
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, "sample.pdf")
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_text((50, 92), "Talently Self-Assessment", fontsize=16, fontname="hebo")
    page.insert_text((50, 130), "Muhammad Luqman Hakim Razlan", fontsize=11, fontname="helv")
    page.insert_text((50, 156), "Submitted May 18, 2026 - 04:12 PM", fontsize=11, fontname="helv")
    y = 210
    for line in wrap(BIG):
        page.insert_text((50, y), line, fontsize=11, fontname="helv")
        y += 26
    bottom = y - 26 + 13
    # 44 pt below the big block: past the clusterer's 2.2-em join, so the
    # Keywords line starts its own paragraph — the second block the ticket names.
    page.insert_text((50, bottom + 44), "Keywords: PDF, text layer, kerning, subsetting, Form XObject, Type3 glyphs.", fontsize=11, fontname="helv")
    page.insert_text((50, bottom + 44 + 30), "Experience: BrowserSnip, Talently, freelance PDF tooling.", fontsize=11, fontname="helv")
    page.insert_text((50, bottom + 44 + 56), "Available for new projects.", fontsize=11, fontname="helv")
    doc.save(path, garbage=3, deflate=True)
    doc.close()
    probe = pymupdf.open(path)
    print(
        path,
        os.path.getsize(path),
        "bytes,",
        len(probe[0].get_text("blocks")),
        "PyMuPDF blocks (pane clusters them differently by design)",
    )


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/er")
