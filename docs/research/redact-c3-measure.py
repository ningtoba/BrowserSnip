#!/usr/bin/env python3
"""Judge a redact-pdf download against the untouched sheet, letter by letter.

    python3 docs/research/redact-c3-measure.py SRC.pdf OUT.pdf [dpi]

A redaction is only true of the bytes, and a file hides a word in more than one
place, so every word is looked for four ways per page: MuPDF's `get_text()`, the
ASCII spelling in the inflated content streams, the per-glyph `<42>` cells
pdf-lib/MuPDF write inside a `TJ` array, and the contiguous hex of the whole word.
The run's own fill rectangles are read back out of the page content and compared
with the **user-space box MuPDF reports for each word** — MuPDF's `get_text`
already answers unrotated, so the boxes are only flipped to the content stream's
bottom-left origin, never derotated again — which is how a turned sheet is judged:
a bar at the mirrored y deletes nothing and the card cannot notice. Annotation
kinds per page show whether a comment under the bar went with the text.
"""

from __future__ import annotations

import json
import re
import sys

import fitz
import numpy as np
import pikepdf

GLYPH = re.compile(r"<([0-9A-Fa-f]{2})>")
FILL = re.compile(r"(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re\s*\n?f")


def page_streams(pd: pikepdf.Pdf) -> list[str]:
    out = []
    for pg in pd.pages:
        contents = pg.get("/Contents")
        items = list(contents) if isinstance(contents, pikepdf.Array) else ([] if contents is None else [contents])
        body = ""
        for item in items:
            obj = item if hasattr(item, "read_bytes") else pd.get_object(item.objgen)
            try:
                body += obj.read_bytes().decode("latin-1", "replace")
            except Exception:
                body += str(obj)
        out.append(body)
    return out


def annot_kinds(pd: pikepdf.Pdf) -> list[dict[str, int]]:
    out = []
    for pg in pd.pages:
        kinds: dict[str, int] = {}
        for a in pg.get("/Annots") or []:
            k = str(a.get("/Subtype", "?"))
            kinds[k] = kinds.get(k, 0) + 1
        out.append(kinds)
    return out


def glyph_cells(body: str) -> set[str]:
    return {m.group(1).upper() for m in GLYPH.finditer(body)}


def main() -> None:
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit(2)
    src, out = sys.argv[1], sys.argv[2]
    dpi = int(sys.argv[3]) if len(sys.argv) > 3 else 150

    with pikepdf.open(src) as pd:
        s_streams, s_annots = page_streams(pd), annot_kinds(pd)
    with pikepdf.open(out) as pd:
        o_streams, o_annots = page_streams(pd), annot_kinds(pd)

    sd, od = fitz.open(src), fitz.open(out)
    report = {"source": src, "produced": out, "dpi": dpi, "reopens": od.page_count > 0, "pages": []}
    for i in range(max(len(s_streams), len(o_streams))):
        spage, opage = sd[i], od[i]
        # MuPDF's word boxes are already **unrotated** (its `get_text` answers in the
        # cropbox's own space, y from the top), so the only step left to compare them
        # with a content-stream `x y w h re` is the origin flip. Derotating them again
        # — which this probe used to do — turned a correct `/Rotate 90` band into a
        # 490 pt "error" and a correct redaction into a phantom one.
        unrotated = spage.cropbox
        height = unrotated.height
        src_words = [(w[4], fitz.Rect(w[0], height - w[3], w[2], height - w[1]))
                     for w in spage.get_text("words")]
        out_text = opage.get_text()
        lost = [w for w, _ in src_words if w not in out_text]
        # Which letters of a lost word still have a hex cell anywhere in the
        # content. Weak on purpose: a cell shared with a surviving word shows up
        # here (`<45>` E stays because MIKE and eleven spell it), so this column
        # only says a letter *could* be left — `words_out` is what decides.
        residue: dict[str, list[str]] = {}
        for word, _ in src_words:
            if word not in lost:
                continue
            left = [ch for ch in set(word) if f"<{ord(ch):02X}>" in o_streams[i]]
            if left:
                residue[word] = sorted(left)
        # `x y w h re` → the corner form the word boxes are reported in.
        fills = [[round(float(v), 2) for v in m] for m in FILL.findall(o_streams[i])]
        bars = [[x, y, x + w, y + h] for x, y, w, h in fills]
        report["pages"].append({
            "page": i + 1,
            "rotation": [spage.rotation, opage.rotation],
            "words_src": [w for w, _ in src_words],
            "words_out": out_text.split(),
            "lost_words": lost,
            "cells_of_lost_words_present_anywhere_in_content": residue,
            "user_boxes_src": {w: [round(v, 1) for v in r] for w, r in src_words},
            "fill_rects_user_space": bars,
            "annots_src_to_out": [s_annots[i], o_annots[i]],
            "tj_ops_src_to_out": [len(re.findall(r"\bTj\b|\bTJ\b", s_streams[i])),
                                  len(re.findall(r"\bTj\b|\bTJ\b", o_streams[i]))],
        })
    # A painted bar that matches no word's user-space box is a misplaced redaction;
    # the closest box and its gap is what a rotated-page bug measures in points.
    for page in report["pages"]:
        for rect in page["fill_rects_user_space"]:
            best = None
            for word, box in page["user_boxes_src"].items():
                gap = max(abs(rect[0] - box[0]), abs(rect[1] - box[1]),
                          abs(rect[2] - box[2]), abs(rect[3] - box[3]))
                if best is None or gap < best[1]:
                    best = (word, round(gap, 1))
            page.setdefault("fill_nearest_word", []).append({"rect": rect, "nearest": best[0], "gap_pt": best[1]})
    sd.close()
    od.close()
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
