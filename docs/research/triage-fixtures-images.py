#!/usr/bin/env python3
"""The non-PDF and derived-PDF fixtures for the whole-catalogue triage.

  python3 docs/research/triage-fixtures-images.py --dir /tmp/triage

`triage-fixtures.mjs` writes the inputs that the existing campaign fixtures and
the `tests/pdf/convert-to-harness.ts` builders already produce; this half writes
what needs a real encoder or a real PDF writer behind it:

  in/photo.{png,jpg,webp,bmp}, in/photo.tif   two-page TIFF
      High-frequency halftone over a solid bar, so a rasterising tool has ink and
      detail to lose. A 1×1 or a flat-grey swatch passes "is there an image" while
      telling nothing about what was done to it.
  in/tiny.png
      24×24, for a "smallest image to keep" style field.
  in/clip.mp4
      3 s, 320x240, moving content + a tone, so the eight video tools have a file
      with a duration, a bitrate and metadata to change.
  in/form.pdf, in/annot.pdf, in/attach.pdf, in/layers.pdf, in/js.pdf, in/meta.pdf
  in/locked.pdf, in/heavy.pdf
      Variants of the campaign's 4-sheet colour fixture (text, colour blocks, an
      empty sheet and a /Rotate 90 sheet) carrying exactly one kind of extra
      furniture each, because a tool that only acts on form fields has to be shown
      a file with form fields — and one that claims to strip XMP has to be shown a
      file that has it.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
import zipfile

import pymupdf
from PIL import Image, ImageDraw


def ink_image(w: int, h: int, seed: int = 0) -> Image.Image:
    """A picture with real high-frequency detail plus flat dark and light areas."""
    img = Image.new("RGB", (w, h), (250, 250, 248))
    draw = ImageDraw.Draw(img)
    # Halftone field: every pixel a tone, the way a scan of a photograph lands.
    px = img.load()
    if px is None:  # PIL types the loader as Optional; a fresh image always has one
        raise SystemExit("PIL gave no pixel accessor for a new image")
    for y in range(h):
        for x in range(w):
            if y < h // 3:
                continue
            v = (x * 7 + y * 13 + seed * 29) % 256
            px[x, y] = (v, (v + 40) % 256, 255 - v)
    draw.rectangle([0, 0, w, h // 6], fill=(8, 8, 8))
    draw.rectangle([w // 10, h // 6, w - w // 10, h // 3], fill=(235, 235, 235))
    for step in range(0, w, 17):
        draw.line([(step, h * 2 // 3), (step + 40, h)], fill=(20, 20, 20), width=2)
    return img


def write_images(out: str) -> None:
    big = ink_image(420, 300)
    big.save(os.path.join(out, "photo.png"))
    big.save(os.path.join(out, "photo.jpg"), quality=93)
    big.save(os.path.join(out, "photo.webp"), quality=90)
    big.save(os.path.join(out, "photo.bmp"))
    frames = ink_image(300, 220, seed=3)
    frames.save(
        os.path.join(out, "photo.tif"),
        save_all=True,
        append_images=[ink_image(300, 220, seed=7)],
    )
    tiny = ink_image(24, 24)
    tiny.save(os.path.join(out, "tiny.png"))
    # Two more distinct sizes so a multi-image run cannot be one page repeated.
    ink_image(640, 200, seed=11).save(os.path.join(out, "wide.png"))


def source_pdf(triage: str) -> pymupdf.Document:
    """The campaign's colour sheet, opened (4 pages: text, colour, empty, turned)."""
    path = os.path.join(triage, "colour.pdf")
    if not os.path.exists(path):
        raise SystemExit(f"{path} missing — run triage-fixtures.mjs first")
    return pymupdf.open(path)


def stamp(page: pymupdf.Page, text: str, y: float = 60) -> None:
    page.insert_text((40, y), text, fontsize=13, color=(0, 0, 0))


# PyMuPDF's generated stubs type these module constants and Widget fields as
# `None`, so each read is annotated rather than worked around — the runtime values
# are what `form.pdf` and `locked.pdf` are built from.
WIDGET_TEXT = pymupdf.PDF_WIDGET_TYPE_TEXT  # type: ignore[attr-defined]
WIDGET_COMBOBOX = pymupdf.PDF_WIDGET_TYPE_COMBOBOX  # type: ignore[attr-defined]
WIDGET_CHECKBOX = pymupdf.PDF_WIDGET_TYPE_CHECKBOX  # type: ignore[attr-defined]
ENCRYPT_AES_256 = pymupdf.PDF_ENCRYPT_AES_256  # type: ignore[attr-defined]
ENCRYPT_AES_128 = pymupdf.PDF_ENCRYPT_AES_128  # type: ignore[attr-defined]
ENCRYPT_RC4_128 = pymupdf.PDF_ENCRYPT_RC4_128  # type: ignore[attr-defined]


def write_pdfs(triage: str, out: str) -> None:
    # form.pdf — AcroForm widgets of three kinds, so a filler has fields to fill,
    # a flattener has fields to flatten and a choice field has values to keep.
    doc = source_pdf(triage)
    page = doc[0]
    kinds = [
        ("q1.name", WIDGET_TEXT, "", None),
        ("q1.pick", WIDGET_COMBOBOX, "Alpha", ["Alpha", "Beta"]),
        ("q1.on", WIDGET_CHECKBOX, True, None),
    ]
    for index, (name, kind, value, choices) in enumerate(kinds):
        field = pymupdf.Widget()
        field.field_name = name  # type: ignore[attr-defined]
        field.field_type = kind  # type: ignore[attr-defined]
        field.field_value = value  # type: ignore[attr-defined]
        field.rect = pymupdf.Rect(60, 500 + index * 40, 240, 520 + index * 40)  # type: ignore[attr-defined]
        if choices:
            field.choice_values = choices  # type: ignore[attr-defined]
        page.add_widget(field)
    doc.save(os.path.join(out, "form.pdf"))
    doc.close()

    # annot.pdf — annotation types other than widgets, so a "remove annotations"
    # tool has something to remove and a "keep annotated pages" rule has a reason.
    doc = source_pdf(triage)
    page = doc[0]
    note = page.add_text_annot((200, 200), "A sticky note for the reviewer")
    note.set_info(title="triage", content="A sticky note for the reviewer")
    note.update()
    rect = pymupdf.Rect(60, 120, 300, 150)
    free = page.add_freetext_annot(rect, "A free-text note sitting on the page", fontsize=10)
    free.update()
    page.add_highlight_annot(pymupdf.Rect(60, 90, 260, 104))
    page.insert_link(
        {"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(60, 300, 200, 316), "uri": "https://example.com"}
    )
    doc.save(os.path.join(out, "annot.pdf"))
    doc.close()

    # attach.pdf — one embedded file.
    doc = source_pdf(triage)
    doc.embfile_add(
        "note.txt",
        b"An attachment planted by the triage fixture.\n",
        filename="note.txt",
        ufilename="note.txt",
        desc="the fixture note",
    )
    doc.save(os.path.join(out, "attach.pdf"))
    doc.close()

    # layers.pdf — two optional content groups, one drawn on, one off.
    doc = source_pdf(triage)
    page = doc[0]
    on = doc.add_ocg("LayerOn", on=True)
    off = doc.add_ocg("LayerOff", on=False)
    page.insert_text((40, 400), "Text on the visible layer", fontsize=12, oc=on)
    page.insert_text((40, 430), "Text on the hidden layer", fontsize=12, oc=off)
    doc.save(os.path.join(out, "layers.pdf"))
    doc.close()

    # js.pdf — document-level JavaScript, plus one annotation action.
    doc = source_pdf(triage)
    root = doc.pdf_catalog()
    doc.xref_set_key(root, "OpenAction", "<< /S /JavaScript /JS (app.alert('triage')) >>")
    doc.save(os.path.join(out, "js.pdf"))
    doc.close()

    # meta.pdf — Info dictionary, XMP and a language, each of which a metadata
    # tool claims to read or drop.
    doc = source_pdf(triage)
    doc.set_metadata(
        {
            "title": "Triage metadata title",
            "author": "Triage Fixture",
            "subject": "A subject worth removing",
            "keywords": "alpha, beta, gamma",
            "creator": "triage-fixtures-images.py",
            "producer": "PyMuPDF",
            "creationDate": "D:20260101010101Z00'00'",
            "modDate": "D:20260102010101Z00'00'",
        }
    )
    doc.set_language("en-GB")
    doc.set_xml_metadata(
        "<x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF "
        'xmlns:dc="http://purl.org/dc/elements/1.1/"><rdf:Description>'
        "<dc:title><rdf:Alt><rdf:li xml:lang='x-default'>XMP title</rdf:li></rdf:Alt></dc:title>"
        "</rdf:Description></rdf:RDF></x:xmpmeta>"
    )
    doc.save(os.path.join(out, "meta.pdf"))
    doc.close()

    # locked.pdf — user and owner passwords, so unlock/change-permissions have a
    # file that really is restricted.
    doc = source_pdf(triage)
    stamp(doc[1], "This page is inside an encrypted document.")
    doc.save(
        os.path.join(out, "locked.pdf"),
        encryption=ENCRYPT_AES_256,
        owner_pw="owner-pass",
        user_pw="reader-pass",
        permissions=-4 & ~(1 << 3) & ~(1 << 11),  # no printing, no copying
    )
    doc.close()

    # locked128.pdf / lockedrc4.pdf — the same document under the other two
    # encryption schemes, so "the password is not correct" can be told apart from
    # "this reader cannot do AES-256": one cause, three very different answers.
    for name, mode in (("locked128.pdf", ENCRYPT_AES_128), ("lockedrc4.pdf", ENCRYPT_RC4_128)):
        variant = source_pdf(triage)
        stamp(variant[1], "This page is inside an encrypted document.")
        variant.save(
            os.path.join(out, name),
            encryption=mode,
            owner_pw="owner-pass",
            user_pw="reader-pass",
        )
        variant.close()

    # heavy.pdf — six photo pages at 220 dpi, so a compressor has bytes to spend.
    doc = source_pdf(triage)
    while doc.page_count > 1:
        doc.delete_page(1)
    page = doc[0]
    page.insert_text((40, 280), "Six photo pages for a compressor", fontsize=11)
    for _index in range(5):
        new = doc.new_page(width=420, height=300)
        with open(os.path.join(out, "photo.jpg"), "rb") as handle:
            new.insert_image(new.rect, stream=handle.read())
    doc.save(os.path.join(out, "heavy.pdf"), deflate=True, garbage=3)
    doc.close()

    # corruptish.pdf — a repair target: valid header, damaged xref offset.
    # corruptish.pdf — a repair target: the xref start marker is broken, which is
    # the damage `repair` claims to answer, and a copy of a clean file would let it
    # pass by doing nothing.
    with open(os.path.join(triage, "colour.pdf"), "rb") as handle:
        raw = handle.read()
    head = raw[:12]
    with open(os.path.join(out, "repaired-target.pdf"), "wb") as handle:
        handle.write(head + b"\n% damaged by triage\n" + raw[12:-40] + b"\n%%EO\n")


def write_video(triage: str, out: str) -> None:
    path = os.path.join(out, "clip.mp4")
    if os.path.exists(path) and os.path.getsize(path) > 20_000:
        return
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15:duration=3",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
        "-c:a", "aac", "-b:a", "48k", "-pix_fmt", "yuv420p",
        "-metadata", "title=Triage clip", "-metadata", "comment=gps=00.000000",
        "-movflags", "+faststart", path,
    ]
    subprocess.run(cmd, check=True)


def write_table(out: str) -> None:
    """table.pdf — a real ruled grid with text in the cells.

    `pdf-to-csv`, `extract-tables` and `pdf-to-excel` answer "no tables here" on a
    text page, which is true but proves nothing. On this file a table they find can
    be counted row by row against the fixture, and a table they miss is a defect
    rather than an empty document.
    """
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    cols = [60, 180, 280, 400]
    rows = [70, 100, 130, 160, 190, 220]
    for x in cols:
        page.draw_line((x, rows[0]), (x, rows[-1]), color=(0, 0, 0), width=0.7)
    for y in rows:
        page.draw_line((cols[0], y), (cols[-1], y), color=(0, 0, 0), width=0.7)
    cells = [
        ["Item", "Qty", "Price", "Total"],
        ["Widget", "3", "9.99", "29.97"],
        ["Gizmo", "12", "4.50", "54.00"],
        ["Sprocket", "7", "1.25", "8.75"],
        ["Flange", "2", "18.00", "36.00"],
    ]
    for r, row in enumerate(cells):
        for c, text in enumerate(row):
            page.insert_text((cols[c] + 4, rows[r] + 19), text, fontsize=10)
    doc.save(os.path.join(out, "table.pdf"), deflate=True)
    doc.close()


def write_bookmarked(triage: str, out: str) -> None:
    """bookmarked.pdf — the colour fixture with a real outline.

    `bookmarks`, `table-of-contents` and the outline-preserving warnings all read
    `/Outlines`; a file without one only ever exercises their refusal.
    """
    doc = source_pdf(triage)
    doc.set_toc([[1, "Chapter One", 1], [2, "Section One.A", 2], [1, "Chapter Two", 4]])
    doc.save(os.path.join(out, "bookmarked.pdf"), deflate=True)
    doc.close()


def write_uncompressed(triage: str, out: str) -> None:
    """uncompressed.pdf — the colour fixture with its streams stored raw.

    `optimize-pdf` answered three of its toggles with "no uncompressed stream was
    large enough to be worth compressing", which is true of a file that has none.
    Without this sibling the same sentence covers an inert control and an honest
    no-op, and only one of those is a defect.
    """
    doc = source_pdf(triage)
    doc.save(os.path.join(out, "uncompressed.pdf"), deflate=False)
    doc.close()


def write_blanks(triage: str, out: str) -> None:
    """blanks.pdf — the eight-sheet shape `remove-blank-pages` was fixed against.

    The campaign's row for that tool lists the ink each sheet must carry: text,
    empty, a full-page scan, text drawn invisible, a link-only sheet, one hairline
    vector stroke, white-on-white text and text again. A page whose only ink is one
    0.1 pt stroke, or one that carries only a link, is what a "blank" rule gets
    wrong, so the fixture has to hold both.
    """
    doc = source_pdf(triage)
    while doc.page_count > 1:
        doc.delete_page(doc.page_count - 1)
    page = doc[0]
    page.insert_text((40, 80), "One: a page with body copy on it.", fontsize=12)

    doc.new_page(width=420, height=595)  # empty

    scan = doc.new_page(width=420, height=595)
    with open(os.path.join(out, "photo.jpg"), "rb") as handle:
        scan.insert_image(scan.rect, stream=handle.read())

    invisible = doc.new_page(width=420, height=595)
    invisible.insert_text(
        (40, 90), "Invisible OCR layer text", fontsize=11, render_mode=3
    )

    link_only = doc.new_page(width=420, height=595)
    link_only.insert_link(
        {"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(60, 60, 200, 80), "uri": "https://example.com"}
    )

    hairline = doc.new_page(width=420, height=595)
    shape = hairline.new_shape()
    shape.draw_line(pymupdf.Point(40, 300), pymupdf.Point(300, 300))
    shape.finish(color=(0, 0, 0), width=0.1)
    shape.commit()

    white = doc.new_page(width=420, height=595)
    white.draw_rect(white.rect, color=None, fill=(1, 1, 1))
    white.insert_text((40, 90), "White text on white paper", fontsize=12, color=(1, 1, 1))

    again = doc.new_page(width=420, height=595)
    again.insert_text((40, 80), "Eight: another page with body copy.", fontsize=12)

    doc.save(os.path.join(out, "blanks.pdf"), deflate=True, garbage=3)
    doc.close()


def write_scanned(triage: str, out: str) -> None:
    """planted.pdf rasterised at 200 dpi: an image-only PDF for the OCR tools.

    `ocr-pdf` and `digitize-document` must be shown a page with no text layer, or a
    result that came from the existing layer cannot be told from one the recogniser
    read. This is the same move `ocr-round-trip.mjs` makes through the shipped
    `rasterize-pdf` tool, done at fixture time so every run starts from one file.
    """
    src = pymupdf.open(os.path.join(triage, "planted.pdf"))
    doc = pymupdf.open()
    for page in src:
        pix = page.get_pixmap(dpi=200)
        new = doc.new_page(width=page.rect.width, height=page.rect.height)
        new.insert_image(new.rect, pixmap=pix)
    doc.save(os.path.join(out, "scanned.pdf"), deflate=True)
    doc.close()
    src.close()


def write_cbz(out: str) -> None:
    """photos.cbz — three real photographs in a ZIP, for the comic-book importer.

    The test harness's own CBZ is three copies of a 1×1 pixel, which is fine for
    "did a page appear" and useless for "did the picture survive": every output
    page measures 100 % ink either way.
    """
    with zipfile.ZipFile(os.path.join(out, "photos.cbz"), "w") as archive:
        for index, name in enumerate(["photo.png", "wide.png", "tiny.png"]):
            archive.write(os.path.join(out, name), arcname=f"page{index + 1}.png")


def write_heic(out: str) -> None:
    """A real HEIC still, if this ffmpeg can write one; absent otherwise."""
    path = os.path.join(out, "photo.heic")
    if os.path.exists(path):
        return
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", os.path.join(out, "photo.png"), "-frames:v", "1", "-tag:v", "hvc1", path,
    ]
    done = subprocess.run(cmd, capture_output=True)
    if done.returncode != 0 or not os.path.exists(path):
        # No HEIC encoder here. The JPEG bytes under a `.heic` name let the tool be
        # driven at all; the HEIC *decode* path stays NOT REACHED and says so.
        with open(os.path.join(out, "photo.jpg"), "rb") as src, open(path, "wb") as dst:
            dst.write(src.read())
        print("heic-to-pdf: no HEIC encoder available, wrote JPEG bytes as photo.heic")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=os.path.join(tempfile.gettempdir(), "triage"))
    args = ap.parse_args()
    out = os.path.join(args.dir, "in")
    os.makedirs(out, exist_ok=True)
    write_images(out)
    write_pdfs(args.dir, out)
    write_table(out)
    write_uncompressed(args.dir, out)
    write_bookmarked(args.dir, out)
    write_blanks(args.dir, out)
    write_scanned(args.dir, out)
    write_heic(out)
    write_video(args.dir, out)
    write_cbz(out)
    with open(os.path.join(out, "note.txt"), "wb") as handle:
        handle.write(b"An attachment planted by the triage fixture.\n")
    for name in sorted(os.listdir(out)):
        print(f"{name}\t{os.path.getsize(os.path.join(out, name))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
