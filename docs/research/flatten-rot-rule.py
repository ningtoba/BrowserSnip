#!/usr/bin/env python3
"""Which entry turns an annotation's appearance, and does the page's turn add to it?

    python3 docs/research/flatten-rot-rule.py [OUTDIR]

Writes `rot-rule.pdf` — six marks, each carrying a readable-appearance quarter-turn
declaration — and answers the question twice: once out of **MuPDF's own bake** (the
`cm` it writes in the page's unrotated content, plus the `/Matrix` of the appearance it
reuses) and once out of **MuPDF's own render** of the live file (the ink profile of each
mark's displayed box, which says whether the words stood up or were squeezed).

The six cases are the cross-product that the flatten bake has to place correctly:
`/Rot` (PDF 1.3–1.7) and `/Rotate` (PDF 2.0) as the declaring key, on a flat sheet and
on a `/Rotate 90` one, as a `Square` (the comment bake) and as a `Widget` (the form
bake). The appearance is deliberately wide and short (100×30, 120×24) so a fit alone
and a fit plus a quarter turn are not the same picture.

What it printed for this lane (MuPDF 1.28):

    sheet 1 (/Rotate 0)   Square /Rot 90     [0.3, 0.0, 0.0, 3.3333333, 60.0, 700.0]
    sheet 1 (/Rotate 0)   Square /Rotate 90  [0.3, 0.0, 0.0, 3.3333333, 120.0, 700.0]
    sheet 1 (/Rotate 0)   Widget /Rot 90     [1.0, 0.0, 0.0, 1.0, 200.0, 700.0]
    sheet 2 (/Rotate 90)  Square /Rot 90     [1.0, 0.0, 0.0, 1.0, 60.0, 600.0]
    sheet 2 (/Rotate 90)  Square /Rotate 90  [1.0, 0.0, 0.0, 1.0, 60.0, 540.0]
    sheet 2 (/Rotate 90)  Widget /Rot 90     [1.0, 0.0, 0.0, 1.0, 300.0, 600.0]

Every one of them is the fit with no turn in it — the tall boxes hold squeezed words,
not stood-up ones (`spanX` covers the full crop width there while `spanY` does not), and
the render of a `/Rot 90` mark on the turned sheet shows the words running with the page
exactly as the same mark on a flat sheet runs across it. MuPDF applies neither key;
pdf.js applies `/Rotate` (and `/MK /R`) and never reads `/Rot` at all. `appearanceTurn`
in `core/content.ts` is that second, narrower rule, shared by both bakes, and
`tests/pdf/flatten-truth.test.ts` pins it.
"""
from __future__ import annotations

import os
import re
import sys

import fitz  # PyMuPDF
import numpy as np

MARK_AP = b"BT /F1 14 Tf 4 8 Td (MARK-TEXT) Tj ET\n1 0 0 RG 3 w 4 4 m 96 4 l S\n"
WIDGET_AP = b"BT /F1 12 Tf 2 6 Td (WIDGET-TEXT) Tj ET\n"

# (page, rect, declaring key, kind) — the appearance boxes are 100x30 (marks) and
# 120x24 (widgets), so a tall rect can only be filled by a squeeze or by a turn.
CASES = [
    (0, (60, 700, 90, 800), "/Rot 90", "Square"),
    (0, (120, 700, 150, 800), "/Rotate 90", "Square"),
    (0, (200, 700, 320, 724), "/Rot 90", "Widget"),
    (1, (60, 600, 160, 630), "/Rot 90", "Square"),
    (1, (60, 540, 160, 570), "/Rotate 90", "Square"),
    (1, (300, 600, 420, 624), "/Rot 90", "Widget"),
]


def build(path: str) -> None:
    """A two-sheet PDF carrying `CASES`, written by hand so nothing interprets it."""
    objs: list[bytes] = []

    def add(body: bytes) -> int:
        objs.append(body)
        return len(objs)

    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    def appearance(ops: bytes, bbox: tuple[int, int, int, int]) -> int:
        return add(
            b"<< /Type /XObject /Subtype /Form /BBox [%d %d %d %d] /Matrix [1 0 0 1 0 0]"
            b" /Resources << /Font << /F1 %d 0 R >> >> /Length %d >>\nstream\n"
            % (*bbox, font, len(ops)) + ops + b"\nendstream"
        )

    mark_ap = appearance(MARK_AP, (0, 0, 100, 30))
    widget_ap = appearance(WIDGET_AP, (0, 0, 120, 24))
    handles: list[tuple[int, int, str]] = []
    for i, (page, rect, key, kind) in enumerate(CASES):
        if kind == "Widget":
            body = (b"<< /Type /Annot /Subtype /Widget /FT /Tx /T (w%d) /V (WIDGET-TEXT)"
                    b" /Rect [%d %d %d %d] %s /F 4 /P PAGE_REF /AP << /N %d 0 R >> >>"
                    % (i, *rect, key.encode(), widget_ap))
        else:
            body = (b"<< /Type /Annot /Subtype /Square /Rect [%d %d %d %d] /Border [0 0 1]"
                    b" /P PAGE_REF %s /AP << /N %d 0 R >> >>" % (*rect, key.encode(), mark_ap))
        handles.append((add(body), page, kind))
    contents = [b"BT /F1 14 Tf 40 780 Td (ROT-RULE FLAT) Tj ET\n",
                b"BT /F1 14 Tf 40 780 Td (ROT-RULE PAGE ROT90) Tj ET\n"]
    cres = [add(b"<< /Length %d >>\nstream\n" % len(c) + c + b"\nendstream") for c in contents]
    res = add(b"<< /Font << /F1 %d 0 R >> >>" % font)
    kids = []
    for p in (0, 1):
        listed = b" ".join(b"%d 0 R" % n for n, pg, _ in handles if pg == p)
        body = (b"<< /Type /Page /MediaBox [0 0 595 842] /Contents %d 0 R /Resources %d 0 R"
                b" /Annots [%s]" % (cres[p], res, listed))
        if p:
            body += b" /Rotate 90"
        kids.append(add(body + b" >>"))
    pages = add(b"<< /Type /Pages /Kids [%s] /Count 2 >>" % b" ".join(b"%d 0 R" % k for k in kids))
    for n, pg, _ in handles:
        objs[n - 1] = objs[n - 1].replace(b"PAGE_REF", b"%d 0 R" % kids[pg])
    for k in kids:
        objs[k - 1] = objs[k - 1].replace(b"/Type /Page ", b"/Type /Page /Parent %d 0 R " % pages)
    widgets = b" ".join(b"%d 0 R" % n for n, _, kind in handles if kind == "Widget")
    root = add(b"<< /Type /Catalog /Pages %d 0 R /AcroForm << /Fields [%s] /DA (/F1 12 Tf) >> >>"
               % (pages, widgets))
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    starts = []
    for body in objs:
        starts.append(len(out))
        out += b"%d 0 obj\n" % (len(starts)) + body + b"\nendobj\n"
    xref = len(out)
    size = len(objs) + 1
    out += b"xref\n0 %d\n" % size + b"0000000000 65535 f \n"
    for off in starts:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (size, root, xref)
    open(path, "wb").write(bytes(out))


def matrix_of(doc: fitz.Document, pno: int, needle: str) -> list[list[float]]:
    """Every `a b c d e f cm` written before a `/AnnotN Do` on one page of a bake."""
    found = []
    for ref in doc[pno].get_contents():
        stream = doc.xref_stream(ref)
        for m in re.finditer(rb"(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm\s*/(Annot\d+) Do", stream):
            found.append([float(v) for v in m.group(1, 2, 3, 4, 5, 6)])
    return found


def profile(path: str, pno: int, index: int, dpi: int = 150) -> dict:
    """Ink spread of one annotation's own box, as the live file paints it."""
    doc = fitz.open(path)
    page = doc[pno]
    xref = [e[0] for e in (doc.page_annot_xrefs(pno) or [])][index]
    raw = re.sub(r"\s+", " ", doc.xref_object(xref))
    rect = fitz.Rect(*[float(v) for v in re.search(r"/Rect \[([^\]]*)\]", raw).group(1).split()][:4])
    shown = (rect * page.transformation_matrix * page.rotation_matrix) & page.rect
    pix = page.get_pixmap(dpi=dpi, colorspace=fitz.csRGB, clip=shown)
    ink = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)[..., :3].min(axis=2) < 240
    return {"key": "Rotate" if "/Rotate" in raw else "Rot", "kind": raw.split("/Subtype ")[1].split()[0].lstrip("/"),
            "crop": (pix.width, pix.height), "spanX": int((ink.sum(axis=0) > 0).sum()),
            "spanY": int((ink.sum(axis=1) > 0).sum())}


def main() -> None:
    outdir = sys.argv[1] if len(sys.argv) > 1 else "/tmp/rot-rule"
    os.makedirs(outdir, exist_ok=True)
    source = os.path.join(outdir, "rot-rule.pdf")
    build(source)
    print("built", source)
    baked = fitz.open(source)
    baked.bake()
    bake_path = os.path.join(outdir, "rot-rule-mupdf-bake.pdf")
    baked.save(bake_path)
    read = fitz.open(bake_path)
    for pno in range(read.page_count):
        for placed in matrix_of(read, pno, ""):
            turned = "TURNED" if abs(placed[1]) > 1e-6 or abs(placed[2]) > 1e-6 else "unturned"
            print(f"bake sheet {pno + 1} (/Rotate {read[pno].rotation}): "
                  f"{[round(v, 7) for v in placed]} -> {turned}")
    live = fitz.open(source)
    print("live sheets:", [p.rotation for p in live], "| /Rotate on sheet 2 kept:",
          "/Rotate 90" in live.xref_object(live[1].xref))
    for pno in range(live.page_count):
        for index in range(len(live.page_annot_xrefs(pno) or [])):
            print("render", pno + 1, index, profile(source, pno, index))
    print("crop PNGs of the live render (for the eye):", os.path.join(outdir, "crops"))
    crops = os.path.join(outdir, "crops")
    os.makedirs(crops, exist_ok=True)
    for pno in range(live.page_count):
        for index, x in enumerate([e[0] for e in (live.page_annot_xrefs(pno) or [])]):
            raw = re.sub(r"\s+", " ", live.xref_object(x))
            rect = fitz.Rect(*[float(v) for v in re.search(r"/Rect \[([^\]]*)\]", raw).group(1).split()][:4])
            shown = (rect * live[pno].transformation_matrix * live[pno].rotation_matrix) & live[pno].rect
            live[pno].get_pixmap(dpi=150, colorspace=fitz.csRGB, clip=shown).save(
                os.path.join(crops, f"sheet{pno + 1}-r{live[pno].rotation}-{index}-"
                                    f"{'Rotate' if '/Rotate' in raw else 'Rot'}-"
                                    f"{raw.split('/Subtype ')[1].split()[0].lstrip('/')}.png"))


if __name__ == "__main__":
    main()
