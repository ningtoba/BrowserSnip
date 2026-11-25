#!/usr/bin/env python3
"""Fixtures + aiming data for the redact-pdf re-audit (security lane, chunk 2).

    python3 docs/research/redact-c3-build.py /tmp/lane-security

Writes `redact.pdf` — four sheets, each answering one question the round asks —
and prints the `DRAGS` JSON the live driver needs, computed by **searching the
words in the file itself** so a drag lands on the glyph box and not on a guess:

  sheet 1  vector text, MuPDF-written (hex `<…> TJ`), with a highlight over one
           word and a sticky note (icon + popup) inside the band to be marked:
           does redaction delete the text *under* markup annotations, and take
           the annotations themselves out of `/Annots`?
  sheet 2  the page that is NOT marked in the first run — page-range control.
  sheet 3  `/Rotate 90`: coordinates arrive from the pane in displayed space.
  sheet 4  a scanned sheet: the word lives in an image, so no glyph can be
           deleted and only a painted-over pixel guarantee is true.

Every word is unique and absent from the paper elsewhere, so `get_text()` and a
raw grep of the inflated content streams ask the same question and must agree.
"""

from __future__ import annotations

import json
import os
import sys

import fitz
import pikepdf

TARGETS = {
    1: ["BRAVO", "CHARLIE"],   # marked in run A, with a highlight + note on top
    2: ["INDIA"],              # the page-range control: marked only in run B
    3: ["NOVEMBER"],           # on the /Rotate 90 sheet
    4: ["WHISKEY"],            # inside the bitmap — no glyph to delete
}
PAPER = {
    1: ["ALPHA one BRAVO CHARLIE", "DELTA two ECHO three", "FOXTROT four GOLF five"],
    2: ["HOTEL six INDIA seven", "JULIET eight KILO nine"],
    3: ["MIKE ten NOVEMBER eleven", "OSCAR twelve PAPA thirteen"],
    4: ["SIERRA fourteen TANGO fifteen"],
}
SCAN_LINE = "UNIFORM VICTOR WHISKEY XRAY"


def build(path: str) -> None:
    _ = path
    doc = fitz.open()
    for sheet in (1, 2, 3):
        page = doc.new_page(width=595, height=842)
        y = 120.0
        for line in PAPER[sheet]:
            page.insert_text((60, y), line, fontsize=16, fontname="helv", color=(0, 0, 0))
            y += 34
        if sheet == 1:
            # a highlight over the first target word, and a note whose icon sits in
            # the same band, with its popup parked lower down the sheet
            hit = page.search_for(TARGETS[1][1])[0]
            hl = page.add_highlight_annot(hit)
            hl.set_colors(stroke=(1, 1, 0))
            hl.update()
            note = page.add_text_annot((fitz.Rect(hit.x1 + 4, hit.y0, hit.x1 + 24, hit.y1 + 4)).tl,
                                       "comment under the bar")
            note.set_popup(fitz.Rect(80, 600, 260, 680))
            note.update()
        if sheet == 3:
            page.set_rotation(90)
    # sheet 4: a real bitmap with the word drawn into it, scaled over the sheet
    stamp = fitz.open()
    sp = stamp.new_page(width=595, height=200)
    sp.insert_text((60, 100), SCAN_LINE, fontsize=28,
                   fontname="helv", color=(0, 0, 0))
    png = os.path.join(os.path.dirname(path), "_redact_scan.png")
    sp.get_pixmap(dpi=144).save(png)
    stamp.close()
    page4 = doc.new_page(width=595, height=842)
    page4.insert_image(fitz.Rect(0, 0, 595, 400), filename=png, keep_proportion=False)
    page4.insert_text((60, 700), PAPER[4][0], fontsize=12, fontname="helv")
    doc.save(path, deflate=True, garbage=3)
    doc.close()


def drags(path: str) -> dict[int, list[dict[str, float]]]:
    """Drag rectangles as fractions of each sheet's *displayed* canvas.

    MuPDF's `search_for` answers in **unrotated** page space (its word boxes carry
    the mediabox's own height), while the pane drags in the space the sheet is
    *painted* in. For a `/Rotate 90` sheet the two differ by a quarter turn: the
    line MuPDF boxes at `x 130.3..221.8, y 102.8..124.8` is painted as a vertical
    strip at `x 717.2..739.2, y 130.3..221.8` (measured on the rendered sheet: the
    ink of those lines spans x 687..733). Dividing the unrotated numbers by the
    displayed size — what this function used to do — aimed every turned-sheet drag
    at blank paper, and the pane's "no words under that box" was its own instrument
    being wrong, not the tool's. `page.rotation_matrix` is the reader's own
    unrotated → displayed mapping, so the fractions now land on the glyphs.
    """
    out: dict[int, list[dict[str, float]]] = {}
    doc = fitz.open(path)
    for sheet, words in TARGETS.items():
        page = doc[sheet - 1]
        canvas = page.rect  # displayed space (rotation folded in)
        turn = page.rotation_matrix
        steps = []
        for word in words:
            found = page.search_for(word)
            if not found:
                # the scanned sheet keeps its word inside the bitmap
                continue
            r = found[0] * turn
            steps.append({"x0": round((r.x0 - canvas.x0) / canvas.width, 4),
                          "y0": round((r.y0 - canvas.y0) / canvas.height - 0.004, 4),
                          "x1": round((r.x1 - canvas.x0) / canvas.width, 4),
                          "y1": round((r.y1 - canvas.y0) / canvas.height + 0.004, 4)})
        if steps:
            out[sheet] = steps
    # sheet 4 has no searchable text: aim at where the bitmap drew the word
    page4 = doc[3]
    canvas = page4.rect
    spot = page4.rect
    x0 = 60.0 * (spot.width / 595.0)
    y0 = 76.0 * (spot.height / 842.0)
    out.setdefault(4, []).append({"x0": round(x0 / canvas.width, 4), "y0": round(y0 / canvas.height, 4),
                                  "x1": round((x0 + 220 * (spot.width / 595.0)) / canvas.width, 4),
                                  "y1": round((y0 + 38 * (spot.height / 842.0)) / canvas.height, 4)})
    doc.close()
    return out


def main() -> None:
    root = sys.argv[1] if len(sys.argv) > 1 else "/tmp/lane-security"
    os.makedirs(root, exist_ok=True)
    path = f"{root}/redact.pdf"
    build(path)
    with pikepdf.open(path) as pd:
        print("redact.pdf pages=%d annots=%s" % (
            len(pd.pages), [[str(a.get("/Subtype", "?")) for a in (p.get("/Annots") or [])] for p in pd.pages]))
    d = fitz.open(path)
    print("rotations=%s" % [p.rotation for p in d])
    for sheet in range(1, 5):
        page = d[sheet - 1]
        print(f"  sheet {sheet} displayed={page.rect.width:.0f}x{page.rect.height:.0f} "
              f"text={page.get_text().split()[:6]}")
    d.close()
    plan = drags(path)
    steps = [{"page": sheet, "drags": steps_} for sheet, steps_ in sorted(plan.items())]
    print("DRAGS=" + json.dumps(steps))
    # The same rectangles in the two spaces the tool and the judge speak, so a pin
    # can quote the reader instead of a hand-worked flip: `displayed` is what the
    # pane paints and drags in (MuPDF's box under `rotation_matrix`), `user` is the
    # bottom-left-origin box the content stream has to be cut in.
    aimed = fitz.open(path)
    for sheet, steps_ in sorted(plan.items()):
        page = aimed[sheet - 1]
        height = page.cropbox.height
        for step in steps_:
            dx = round(step["x0"] * page.rect.width, 1)
            dy = round(step["y0"] * page.rect.height, 1)
            dw = round((step["x1"] - step["x0"]) * page.rect.width, 1)
            dh = round((step["y1"] - step["y0"]) * page.rect.height, 1)
            # The band in the content stream’s own space: the reader’s derotation
            # back to the unrotated sheet, then the origin flip. This is the pair a
            # pin compares against `viewerRectToUserSpace`.
            back = fitz.Rect(dx, dy, dx + dw, dy + dh) * page.derotation_matrix
            print("AIM sheet %d rot=%d displayed=%s user=%s" % (
                sheet, page.rotation,
                [dx, dy, round(dx + dw, 1), round(dy + dh, 1)],
                [round(back.x0, 1), round(height - back.y1, 1),
                 round(back.x1, 1), round(height - back.y0, 1)]))
    aimed.close()


if __name__ == "__main__":
    main()
