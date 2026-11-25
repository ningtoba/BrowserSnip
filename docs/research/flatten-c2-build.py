#!/usr/bin/env python3
"""Fixtures for the flatten-pdf re-audit (security lane, chunk 2).

Three files, one per question the round-brief asks of this tool:

  mix.pdf    every interactive thing in one run: 15 markup annotations across two
             pages (highlight, underline, strikeout, squiggle, note+popup,
             free-text, ink, square, circle, polygon, polyline, caret, stamp),
             two links and four form fields (text, checkbox, radio, combobox).
             The count the card gives must equal the number of objects the bytes
             actually gave up, per kind.
  rot.pdf    four pages, /Rotate 0/90/180/270, each carrying the same three marks
             and the same text field in the same *displayed* place. A bake that
             forgets the turn puts the ink somewhere else.
  nested.pdf hand-written PDF: an appearance that is a Form XObject which itself
             `Do`s another Form XObject and an image, where the page's own
             resources hold a DIFFERENT object under the same name `/Inner`
             (magenta) — so an adoption that fails to rename shows up as magenta
             ink, not as a passing check. Plus an appearance with no /Resources
             at all (it inherits the page's), and a link with no appearance.

PyMuPDF (MuPDF 1.28) is the producer — it writes appearances the way a viewer
paints them — and pikepdf (libqpdf 12.3) reads the structure back.
"""

from __future__ import annotations

import os
import sys

import fitz  # PyMuPDF 1.28 / MuPDF 1.28
import pikepdf


# --------------------------------------------------------------------------- mix
def page_text(page: fitz.Page, lines: list[str], size: float = 14) -> None:
    """Paper that must survive unchanged, so a pixel diff has something to hold still."""
    y = 60.0
    for line in lines:
        page.insert_text((40, y), line, fontsize=size, fontname="helv", color=(0, 0, 0))
        y += size + 12


def add_marks_up(page: fitz.Page) -> list[str]:
    """The markup kinds, each with an appearance MuPDF itself drew. Returns kinds."""
    kinds: list[str] = []

    hl = page.add_highlight_annot(fitz.Rect(40, 160, 300, 178))
    hl.set_colors(stroke=(1, 1, 0))
    hl.update()
    kinds.append("Highlight")

    ul = page.add_underline_annot(fitz.Rect(40, 190, 300, 208))
    ul.update()
    kinds.append("Underline")

    so = page.add_strikeout_annot(fitz.Rect(40, 220, 300, 238))
    so.update()
    kinds.append("StrikeOut")

    sq = page.add_squiggly_annot(fitz.Rect(40, 250, 300, 268))
    sq.update()
    kinds.append("Squiggly")

    note = page.add_text_annot((420, 160), "sticky note body")
    note.set_info(title="lane-security", content="sticky note body", subject="Note")
    note.set_popup(fitz.Rect(430, 160, 560, 240))
    note.update()
    kinds.append("Text+Popup")

    ft = page.add_freetext_annot(
        fitz.Rect(40, 300, 320, 332), "FREETEXT-BAKED-WORD", fontsize=16, fontname="helv",
        text_color=(0.8, 0, 0), fill_color=(1, 1, 0.8),
    )
    ft.update()
    kinds.append("FreeText")

    ink = page.add_ink_annot([[[40, 380], [120, 420], [200, 370], [300, 430]]])
    ink.set_colors(stroke=(0, 0, 1))
    ink.set_border(width=3)
    ink.update()
    kinds.append("Ink")

    box = page.add_rect_annot(fitz.Rect(340, 360, 480, 440))
    box.set_colors(stroke=(0, 0.6, 0), fill=(0.8, 1, 0.8))
    box.set_border(width=2)
    box.update()
    kinds.append("Square")

    cir = page.add_circle_annot(fitz.Rect(340, 460, 480, 540))
    cir.set_colors(stroke=(0.6, 0, 0.6))
    cir.set_border(width=2)
    cir.update()
    kinds.append("Circle")

    poly = page.add_polygon_annot([[60, 500], [160, 480], [200, 570], [80, 580]])
    poly.set_colors(stroke=(0, 0.5, 0.5), fill=(0.8, 1, 1))
    poly.set_border(width=2)
    poly.update()
    kinds.append("Polygon")

    line = page.add_polyline_annot([[240, 500], [320, 560], [400, 490]])
    line.set_colors(stroke=(0.5, 0.5, 0))
    line.set_border(width=2)
    line.update()
    kinds.append("PolyLine")

    caret = page.add_caret_annot(fitz.Point(420, 570))
    caret.update()
    kinds.append("Caret")

    stamp = page.add_stamp_annot(fitz.Rect(380, 620, 520, 670), stamp=2)
    stamp.set_opacity(0.5)
    stamp.update()
    kinds.append("Stamp")

    # a translucent highlight: the bake has to carry /CA into the page state
    wash = page.add_highlight_annot(fitz.Rect(40, 600, 300, 618))
    wash.set_colors(stroke=(0, 1, 1))
    wash.set_opacity(0.4)
    wash.update()
    kinds.append("Highlight/CA=0.4")
    return kinds


def build_mix(path: str) -> None:
    doc = fitz.open()
    p1 = doc.new_page(width=595, height=842)
    page_text(p1, ["MIX PAGE ONE", "highlight this word", "underline this word",
                   "strike this word", "squiggle this word", "wash this word",
                   "the rest of this sheet is paper that must not move"])
    kinds = add_marks_up(p1)

    p2 = doc.new_page(width=595, height=842)
    page_text(p2, ["MIX PAGE TWO", "second sheet stays put"])
    hl2 = p2.add_highlight_annot(fitz.Rect(60, 120, 300, 140))
    hl2.update()
    note2 = p2.add_text_annot((400, 120), "second popup")
    note2.set_popup(fitz.Rect(410, 120, 540, 190))
    note2.update()
    kinds += ["Highlight", "Text+Popup"]


    p1 = doc[0]  # a fresh handle: MuPDF drops the parent link on the old one
    tf = fitz.Widget()
    tf.field_name = "answer.text"
    tf.field_value = "TYPED ANSWER"
    tf.rect = fitz.Rect(320, 700, 520, 722)
    tf.field_type = fitz.PDF_WIDGET_TYPE_TEXT
    tf.text_fontsize = 12
    tf.border_color = (0, 0, 0)
    tf.text_font = "Helv"
    p1.add_widget(tf)

    cb = fitz.Widget()
    cb.field_name = "answer.tick"
    cb.field_value = True
    cb.rect = fitz.Rect(320, 730, 336, 746)
    cb.field_type = fitz.PDF_WIDGET_TYPE_CHECKBOX
    cb.button_states = (["Yes"], ["Off"])
    cb.on_state_value = "Yes"
    cb.border_color = (0, 0, 0)
    p1.add_widget(cb)

    p2 = doc[1]
    rd = fitz.Widget()
    rd.field_name = "answer.pick"
    # a fresh radio in an in-memory doc cannot be switched on (PyMuPDF reads its
    # own /Parent/Kids before it has one), so it starts Off and is ticked in the
    # reopen pass, where the widget has a real xref
    rd.field_value = "Off"
    rd.rect = fitz.Rect(360, 730, 376, 746)
    rd.field_type = fitz.PDF_WIDGET_TYPE_RADIOBUTTON
    rd.button_value = "Two"
    rd.button_states = (["One", "Two", "Three"], None)
    rd.border_color = (0, 0, 0)
    p2.add_widget(rd)

    p2 = doc[1]
    ch = fitz.Widget()
    ch.field_name = "answer.choice"
    ch.field_value = "Beta"
    ch.rect = fitz.Rect(60, 780, 220, 800)
    ch.field_type = fitz.PDF_WIDGET_TYPE_COMBOBOX
    ch.choice_values = ["Alpha", "Beta", "Gamma"]
    ch.text_fontsize = 12
    ch.border_color = (0, 0, 0)
    ch.text_font = "Helv"
    p2.add_widget(ch)

    # MuPDF only lets a link be inserted into a page that came off disk, so the
    # sheet is saved, reopened, given its two links, and saved again.
    doc.save(path + ".tmp", deflate=True)
    doc.close()
    again = fitz.open(path + ".tmp")
    again[0].insert_text((40, 714), "EXAMPLE LINK", fontsize=12, fontname="helv")
    again[0].insert_text((40, 744), "GOTO LINK", fontsize=12, fontname="helv")
    again[0].insert_link({"kind": fitz.LINK_URI, "from": fitz.Rect(40, 700, 300, 720),
                          "uri": "https://example.invalid/target"})
    again[0].insert_link({"kind": fitz.LINK_GOTO, "from": fitz.Rect(40, 730, 300, 750), "page": 1})
    for w in again[1].widgets():
        if w.field_name == "answer.pick":
            w.field_value = "Two"
            w.button_value = "Two"
            w.update()
    again.set_toc([[1, "Second sheet", 2]])
    again.save(path, deflate=True)
    again.close()
    os.remove(path + ".tmp")
    with pikepdf.open(path) as pd:
        kinds_out = {}
        for page in pd.pages:
            for annot in page.get('/Annots') or []:
                k = str(annot.get("/Subtype", "?"))
                kinds_out[k] = kinds_out.get(k, 0) + 1
        fields = len(pd.Root.AcroForm.Fields) if "/AcroForm" in pd.Root else 0
    print("mix: pages=2 fields=%d annots_by_kind=%s" % (fields, kinds_out))
    print("mix: written kinds=%d %s" % (len(kinds), kinds))


# ---------------------------------------------------------------------------- rot
def build_rot(path: str) -> None:
    doc = fitz.open()
    for turn in (0, 90, 180, 270):
        page = doc.new_page(width=595, height=842)
        page.set_rotation(turn)
        # Everything below is in DISPLAYED space: MuPDF derotates, so the same
        # coordinates land in the same visual spot on all four sheets.
        page.insert_text((220, 400), f"ROT-{turn}", fontsize=24, fontname="helv")
        box = page.add_rect_annot(fitz.Rect(60, 80, 200, 160))
        box.set_colors(stroke=(1, 0, 0), fill=(1, 0.9, 0.9))
        box.set_border(width=3)
        box.update()
        ink = page.add_ink_annot([[[320, 480], [430, 540], [360, 620]]])
        ink.set_colors(stroke=(0, 0, 1))
        ink.set_border(width=4)
        ink.update()
        ft = page.add_freetext_annot(
            fitz.Rect(60, 650, 300, 690), f"FREETEXT-ROT-{turn}", fontsize=14,
            fontname="helv", text_color=(0, 0.45, 0), fill_color=(1, 1, 1),
        )
        ft.update()
        tf = fitz.Widget()
        tf.field_name = f"f.turn.{turn}"
        tf.field_value = f"ANSWER-{turn}"
        tf.rect = fitz.Rect(320, 90, 500, 114)
        tf.field_type = fitz.PDF_WIDGET_TYPE_TEXT
        tf.text_fontsize = 12
        tf.border_color = (0, 0, 0)
        tf.text_font = "Helv"
        page.add_widget(tf)
    doc.save(path, deflate=True)
    doc.close()
    with pikepdf.open(path) as pd:
        print("rot: pages=%d rotations=%s annots=%s fields=%d" % (
            len(pd.pages),
            [int(p.get("/Rotate", 0)) for p in pd.pages],
            [len(p.get("/Annots") or []) for p in pd.pages],
            len(pd.Root.AcroForm.Fields) if "/AcroForm" in pd.Root else 0,
        ))


# ----------------------------------------------------------------------------- nested
INNER_AP = b"BT /F1 10 Tf 2 4 Td (INNER-FORM-TEXT) Tj ET\n0.2 0.6 0.9 rg 2 22 90 12 re f\n"
OUTER_AP = (
    b"BT /F1 12 Tf 4 58 Td (OUTER-FORM-TEXT) Tj ET\n"
    b"q 1 0 0 1 4 14 cm /Inner Do Q\n"
    b"q 120 0 0 26 120 26 cm /Pic Do Q\n"
)
INHERIT_AP = b"BT /F1 11 Tf 4 20 Td (INHERITED-RES-TEXT) Tj ET\nq 1 0 0 1 120 0 cm /Inner Do Q\n"
PAGE_OPS = (
    b"BT /F1 16 Tf 60 700 Td (NESTED PAGE PAPER) Tj ET\n"
    b"0 0.4 0 RG 4 w 60 60 m 200 160 l S\n"
)
# The page's OWN /Inner: a magenta block. If the baked appearance draws this
# instead of its own inner form, the check sees magenta where cyan belongs.
PAGE_INNER = b"1 0 1 rg 0 0 100 40 re f\nBT /F1 9 Tf 2 14 Td (PAGE-INNER) Tj ET\n"
WHITE_PIC = bytes([0xFF, 0, 0, 0, 0xFF, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0xFF])


def build_nested(path: str) -> None:
    """Four annotations: nested forms + image, inherited resources, bare text, no-AP link."""
    objs: list[bytes] = []

    def add(body: bytes) -> int:
        objs.append(body)
        return len(objs)  # 1-based object number

    font_f1 = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    page_inner_x = add(
        b"<< /Type /XObject /Subtype /Form /BBox [0 0 100 40] /Resources << /Font %d 0 R >>"
        b" /Length %d >>\nstream\n" % (font_f1, len(PAGE_INNER)) + PAGE_INNER + b"\nendstream"
    )
    page_res = add(
        b"<< /Font << /F1 %d 0 R >> /XObject << /Inner %d 0 R >> >>" % (font_f1, page_inner_x)
    )
    pic = add(
        b"<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB"
        b" /BitsPerComponent 8 /Length %d >>\nstream\n" % len(WHITE_PIC) + WHITE_PIC + b"\nendstream"
    )
    inner = add(
        b"<< /Type /XObject /Subtype /Form /BBox [0 0 100 40] /Resources << /Font %d 0 R >>"
        b" /Length %d >>\nstream\n" % (font_f1, len(INNER_AP)) + INNER_AP + b"\nendstream"
    )
    outer = add(
        b"<< /Type /XObject /Subtype /Form /BBox [0 0 260 80] /Matrix [1 0 0 1 0 0]"
        b" /Resources << /Font << /F1 %d 0 R >> /XObject << /Inner %d 0 R /Pic %d 0 R >> >>"
        b" /Length %d >>\nstream\n" % (font_f1, inner, pic, len(OUTER_AP)) + OUTER_AP + b"\nendstream"
    )
    inherit_ap = add(
        b"<< /Type /XObject /Subtype /Form /BBox [0 0 260 60] /Length %d >>\nstream\n"
        % len(INHERIT_AP) + INHERIT_AP + b"\nendstream"
    )
    annot_nested = add(
        b"<< /Type /Annot /Subtype /Square /Rect [60 520 320 600] /Border [0 0 1]"
        b" /AP << /N %d 0 R >> >>" % outer
    )
    annot_inherit = add(
        b"<< /Type /Annot /Subtype /FreeText /Rect [60 430 320 490] /Border [0 0 1]"
        b" /DA (/F1 11 Tf) /Contents (INHERITED-RES-TEXT) /AP << /N %d 0 R >> >>" % inherit_ap
    )
    annot_no_ap = add(
        b"<< /Type /Annot /Subtype /Text /Rect [420 520 440 540] /Contents (NO-APPEARANCE-NOTE) >>"
    )
    annot_link = add(
        b"<< /Type /Annot /Subtype /Link /Rect [60 350 300 370] /Border [0 0 1]"
        b" /A << /S /URI /URI (https://example.invalid/nested) >> >>"
    )
    contents = add(b"<< /Length %d >>\nstream\n" % len(PAGE_OPS) + PAGE_OPS + b"\nendstream")
    page = add(
        b"<< /Type /Page /Parent 0 R /MediaBox [0 0 595 842] /Contents %d 0 R"
        b" /Resources %d 0 R /Annots [%d 0 R %d 0 R %d 0 R %d 0 R] >>"
        % (contents, page_res, annot_nested, annot_inherit, annot_no_ap, annot_link)
    )
    pages = add(b"<< /Type /Pages /Kids [%d 0 R] /Count 1 >>" % page)
    catalog = add(b"<< /Type /Catalog /Pages %d 0 R >>" % pages)
    # patch /Parent now that the pages object number is known
    objs[page - 1] = objs[page - 1].replace(b"/Parent 0 R", b"/Parent %d 0 R" % pages)

    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    starts = []
    for num, body in enumerate(objs, start=1):
        starts.append(len(out))
        out += b"%d 0 obj\n" % num + body + b"\nendobj\n"
    xref = len(out)
    n = len(objs) + 1
    out += b"xref\n0 %d\n" % n + b"0000000000 65535 f \n"
    for off in starts:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (n, catalog, xref)
    with open(path, "wb") as fh:
        fh.write(bytes(out))

    with pikepdf.open(path) as pd:
        annots = list(pd.pages[0].get("/Annots") or [])
        outer = annots[0]["/AP"]["/N"]
        print("nested: annots=%d kinds=%s ap_keys=%s ap_xobjects=%s page_xobjects=%s" % (
            len(annots),
            [str(a.get("/Subtype", "?")) for a in annots],
            sorted(str(k) for k in outer.keys()),
            sorted(str(k) for k in outer["/Resources"]["/XObject"].keys()),
            sorted(str(k) for k in pd.pages[0]["/Resources"]["/XObject"].keys()),
        ))


# --------------------------------------------------------------------------- rotmark
TURN_OPS = b"BT /F1 14 Tf 4 22 Td (ROT-MARK-TEXT) Tj ET\n1 0 0 RG 3 w 4 4 m 96 4 l S\n"


def build_turn(path: str) -> None:
    """`/Rot` on the mark itself: upright, turned 90, and turned 90 on a turned page.

    A widget carrying `/Rot 90` is the same question asked of the form bake.
    """
    objs: list[bytes] = []

    def add(body: bytes) -> int:
        objs.append(body)
        return len(objs)

    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    ap = add(
        b"<< /Type /XObject /Subtype /Form /BBox [0 0 100 30] /Matrix [1 0 0 1 0 0]"
        b" /Resources << /Font << /F1 %d 0 R >> >> /Length %d >>\nstream\n" % (font, len(TURN_OPS))
        + TURN_OPS + b"\nendstream"
    )
    widget_ap = add(
        b"<< /Type /XObject /Subtype /Form /BBox [0 0 120 24] /Matrix [1 0 0 1 0 0]"
        b" /Resources << /Font << /F1 %d 0 R >> >> /Length 46 >>\nstream\n"
        b"BT /F1 12 Tf 2 6 Td (WIDGET-ROT-90) Tj ET\n" % font
        + b"endstream"
    )
    order = [((60, 700, 160, 730), 0, "PAGE_A"), ((200, 700, 230, 800), 90, "PAGE_A"),
             ((60, 700, 160, 730), 90, "PAGE_B")]
    handles = []
    for rect, rot, which in order:
        extra_rot = b"" if rot == 0 else b" /Rot %d" % rot
        num = add(
            b"<< /Type /Annot /Subtype /Square /Rect [%d %d %d %d] /Border [0 0 1]%s"
            b" /AP << /N %d 0 R >> >>" % (rect[0], rect[1], rect[2], rect[3], extra_rot, ap)
        )
        handles.append((num, which))
    widget = add(
        b"<< /Type /Annot /Subtype /Widget /FT /Tx /T (turn.field) /V (WIDGET-ROT-90)"
        b" /Rect [300 600 420 624] /Rot 90 /F 4 /AP << /N %d 0 R >> >>" % widget_ap
    )
    content_a = b"BT /F1 14 Tf 40 780 Td (TURN PAGE A) Tj ET\n"
    content_b = b"BT /F1 14 Tf 40 780 Td (TURN PAGE B ROT90) Tj ET\n"
    ca = add(b"<< /Length %d >>\nstream\n" % len(content_a) + content_a + b"\nendstream")
    cb = add(b"<< /Length %d >>\nstream\n" % len(content_b) + content_b + b"\nendstream")
    res = add(b"<< /Font << /F1 %d 0 R >> >>" % font)
    a_list = " ".join("%d 0 R" % n for n, w in handles if w == "PAGE_A").encode()
    b_list = " ".join("%d 0 R" % n for n, w in handles if w == "PAGE_B").encode()
    page_a = add(b"<< /Type /Page /MediaBox [0 0 595 842] /Contents %d 0 R /Resources %d 0 R"
                 b" /Annots [%s] >>" % (ca, res, a_list))
    page_b = add(b"<< /Type /Page /MediaBox [0 0 595 842] /Contents %d 0 R /Resources %d 0 R"
                 b" /Rotate 90 /Annots [%s %d 0 R] >>" % (cb, res, b_list, widget))
    pages = add(b"<< /Type /Pages /Kids [%d 0 R %d 0 R] /Count 2 >>" % (page_a, page_b))
    for num in (page_a, page_b):
        objs[num - 1] = objs[num - 1].replace(b"/Type /Page ", b"/Type /Page /Parent %d 0 R " % pages)
    add(b"<< /Type /Catalog /Pages %d 0 R /AcroForm << /Fields [%d 0 R] /DA (/F1 12 Tf) >> >>"
        % (pages, widget))

    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    starts = []
    for num, body in enumerate(objs, start=1):
        starts.append(len(out))
        out += b"%d 0 obj\n" % num + body + b"\nendobj\n"
    xref = len(out)
    n = len(objs) + 1
    out += b"xref\n0 %d\n" % n + b"0000000000 65535 f \n"
    for off in starts:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (n, len(objs), xref)
    with open(path, "wb") as fh:
        fh.write(bytes(out))
    with pikepdf.open(path) as pd:
        print("turn: pages=%d annots=%s rots=%s" % (
            len(pd.pages),
            [[str(a.get("/Subtype", "?")) + ("/Rot" + str(int(a["/Rot"])) if "/Rot" in a else "")
              for a in (pg.get("/Annots") or [])] for pg in pd.pages],
            [int(pg.get("/Rotate", 0)) for pg in pd.pages],
        ))


# -------------------------------------------------------------------------- linkap
LINK_AP = b"0 0 0 RG 1 w [3 2] 0 d 4 6 m 196 6 l S\n0.6 0.2 0 RG 1 w 4 20 m 196 20 l S\n"
NOTE_AP = b"1 1 0 rg 0 0 20 20 re f\n0 0 0 RG 1 w 4 16 m 16 4 l S\n4 4 m 16 16 l S\n"
POPUP_OPS = b""  # a popup carries no appearance of its own, ever


def build_linkap(path: str) -> None:
    """A link that stores dashes, and a note whose popup is listed in `/Annots`.

    `keepLinks` off has to bake the first link's dashes and take its target away;
    the note's popup has to leave with the note. Both are on one sheet so a run
    counts them in the same breath.
    """
    objs: list[bytes] = []

    def add(body: bytes) -> int:
        objs.append(body)
        return len(objs)

    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    link_ap = add(
        b"<< /Type /XObject /Subtype /Form /BBox [0 0 200 30] /Length %d >>\nstream\n" % len(LINK_AP)
        + LINK_AP + b"\nendstream"
    )
    note_ap = add(
        b"<< /Type /XObject /Subtype /Form /BBox [0 0 20 20] /Length %d >>\nstream\n" % len(NOTE_AP)
        + NOTE_AP + b"\nendstream"
    )
    link = add(
        b"<< /Type /Annot /Subtype /Link /Rect [60 700 260 730] /Border [1 1 1]"
        b" /A << /S /URI /URI (https://example.invalid/with-appearance) >> /AP << /N %d 0 R >> >>" % link_ap
    )
    popup = add(b"<< /Type /Annot /Subtype /Popup /Rect [320 640 460 720] /Parent 0R /F 4 >>")
    note = add(
        b"<< /Type /Annot /Subtype /Text /Rect [280 700 300 720] /Contents (note with a popup)"
        b" /Popup %d 0 R /AP << /N %d 0 R >> >>" % (popup, note_ap)
    )
    objs[popup - 1] = objs[popup - 1].replace(b"/Parent 0R", b"/Parent %d 0 R" % note)
    ops = b"BT /F1 14 Tf 60 760 Td (LINKAP PAGE PAPER) Tj ET\n60 706 m 260 706 l S\n"
    contents = add(b"<< /Length %d >>\nstream\n" % len(ops) + ops + b"\nendstream")
    res = add(b"<< /Font << /F1 %d 0 R >> >>" % font)
    page = add(b"<< /Type /Page /MediaBox [0 0 595 842] /Contents %d 0 R /Resources %d 0 R"
               b" /Annots [%d 0 R %d 0 R %d 0 R] >>" % (contents, res, link, note, popup))
    pages = add(b"<< /Type /Pages /Kids [%d 0 R] /Count 1 >>" % page)
    objs[page - 1] = objs[page - 1].replace(b"/Type /Page ", b"/Type /Page /Parent %d 0 R " % pages)
    add(b"<< /Type /Catalog /Pages %d 0 R >>" % pages)

    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    starts = []
    for num, body in enumerate(objs, start=1):
        starts.append(len(out))
        out += b"%d 0 obj\n" % num + body + b"\nendobj\n"
    xref = len(out)
    n = len(objs) + 1
    out += b"xref\n0 %d\n" % n + b"0000000000 65535 f \n"
    for off in starts:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (n, len(objs), xref)
    with open(path, "wb") as fh:
        fh.write(bytes(out))
    with pikepdf.open(path) as pd:
        annots = list(pd.pages[0].get("/Annots") or [])
        print("linkap: annots=%s link_has_ap=%s popup_parent=%s" % (
            [str(a.get("/Subtype", "?")) for a in annots],
            "/AP" in annots[0],
            str((annots[2].get("/Parent") or {}).get("/Subtype", "?")),
        ))


def main() -> None:
    root = sys.argv[1] if len(sys.argv) > 1 else "/tmp/lane-security"
    os.makedirs(root, exist_ok=True)
    build_mix(f"{root}/mix.pdf")
    build_rot(f"{root}/rot.pdf")
    build_nested(f"{root}/nested.pdf")
    build_turn(f"{root}/turn.pdf")
    build_linkap(f"{root}/linkap.pdf")
    for name in ("mix.pdf", "rot.pdf", "nested.pdf", "turn.pdf", "linkap.pdf"):
        d = fitz.open(f"{root}/{name}")
        n = sum(len(list(p.annots() or [])) for p in d)
        links = sum(len(p.get_links()) for p in d)
        widgets = sum(len(list(p.widgets() or [])) for p in d)
        print(f"{name}: pages={d.page_count} annots={n} links={links} widgets={widgets} "
              f"rotations={[p.rotation for p in d]}")
        d.close()


if __name__ == "__main__":
    main()
