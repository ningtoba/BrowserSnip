#!/usr/bin/env python3
"""Fixtures for the `sanitize-pdf` per-switch byte audit.

The question this answers is the campaign's oldest one: **does a switch that is
turned on change the produced bytes, or only the sentence?** Each fixture plants
one distinct marker per scope, so "removed" is a byte search for the thing that
was supposed to go — not a count of keys — and "left alone" is the same search
against the same fixture with the switch off.

    python3 docs/research/sanitize-switch-fixtures.py --dir /tmp/lane-optimize2/fx

Six files, written as raw objects so every object number and every shape is
chosen rather than inherited from a writer:

* `all.pdf` — one file carrying all six scopes at once, in the shapes that have
  burned this tool before: an `/OpenAction` *array* holding one referenced action
  and one inline action, a `/JavaScript` name tree whose leaf action is stored
  **inline** (no object number, invisible to an indirect sweep), a page `/AA`, a
  JS link action, an attachment named twice (`/EmbeddedFiles` **inline filespec**
  plus a catalogue `/AF` object), an XMP stream, an indirect `/Info`, a FreeText
  note with an `/AP` stream, a Widget field value, a URI link (a marker the
  *script* switch must not take), and an optional-content layer switched off in
  the default view.
* `info-inline.pdf` — the trailer names `/Info` as a **direct** dictionary, which
  is what several producers do and what a `trailerInfo.Info instanceof PDFRef`
  test walks past.
* `attach-foreign.pdf` — a `/Kids` attachment tree with a payload behind an
  `/EF` that points straight at the stream, the shape that made the reader throw.
* `annot-inherited.pdf` — `/Annots` on the `/Pages` node, inherited by the sheet.
* `layers-off.pdf` — a two-layer file with one layer off in the default view.
* `plain.pdf` — the negative control: no script, no attachment, no XMP, no
  annotations, no layers. Every switch must say "there was none" and change
  nothing but the file structure.

`manifest.json` next to them records, per fixture, the markers per scope and what
must survive every run; the checker reads that file instead of re-stating it.
"""
from __future__ import annotations

import argparse
import json
import pathlib

FONT = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"


def stream(body: bytes, extra: str = "") -> bytes:
    return f"<< /Length {len(body)}{extra} >>\nstream\n".encode() + body + b"\nendstream"


def build(objects: dict[int, bytes], path: pathlib.Path, trailer_extra: str = "") -> int:
    """Write `objects` (number → body) as an uncompressed classic xref file.

    Object numbers are honoured exactly, gaps included: the shapes under audit are
    addressed by number in the manifest, so a builder that quietly renumbers them
    would move the very references being measured.
    """
    top = max(objects)
    body = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"
    offsets: dict[int, int] = {}
    for number in sorted(objects):
        offsets[number] = len(body)
        body += b"%d 0 obj\n" % number + objects[number] + b"\nendobj\n"
    start = len(body)
    body += b"xref\n0 %d\n0000000000 65535 f \n" % (top + 1)
    for number in range(1, top + 1):
        body += (
            b"%010d 00000 n \n" % offsets[number]
            if number in offsets
            else b"0000000000 65535 f \n"
        )
    body += (
        "trailer\n<< /Size %d /Root 1 0 R%s >>\nstartxref\n%d\n%%%%EOF\n" % (top + 1, trailer_extra, start)
    ).encode()
    path.write_bytes(body)
    return len(body)


# ── all.pdf ──────────────────────────────────────────────────────────────────
ALL_MARKERS = {
    "javascript": [
        "SANJSCRIPTOPEN9",
        "SANJSCRIPTINLINE10",
        "SANJSCRIPTTREE12",
        "SANJSCRIPTAA3",
        "SANJSCRIPTLINK16",
    ],
    "attachments": ["SANJATTACHAPAY7", "SANJATTACHBPAY8"],
    "metadata": ["SANJXMPPACK5"],
    "info": ["SANJINFOTITLE6", "SANJINFOAUTH6"],
    "annotations": ["SANJANNOTNOTE14", "SANJFIELDVAL13", "SANJLINKURI15", "SANJANNOTAP19"],
    "hiddenLayers": ["SANJHIDDENLAYER22"],
}
SURVIVORS = ["SANJPAGEBODY4", "SANJVISIBLELAYER23"]

XMP = (
    b'<?xpacket begin="\xef\xbb\xbf" id="W5M0MpCehiHzreSzNTczkc9d"?>'
    b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    b'<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:title="SANJXMPPACK5"/>'
    b"</rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>"
)

CONTENT = (
    b"q BT /F1 12 Tf 20 180 Td (SANJPAGEBODY4) Tj ET Q\n"
    b"/GS0 gs\n"
    b"/OC /MC1 BDC\n"
    b"q BT /F1 12 Tf 20 150 Td (SANJHIDDENLAYER22) Tj ET Q\n"
    b"EMC\n"
    b"/OC /MC2 BDC\n"
    b"q BT /F1 12 Tf 20 120 Td (SANJVISIBLELAYER23) Tj ET Q\n"
    b"EMC\n"
)


def all_pdf(path: pathlib.Path) -> dict:
    catalog = (
        b"<< /Type /Catalog /Pages 2 0 R"
        b" /OpenAction [ 9 0 R << /S /JavaScript /JS (SANJSCRIPTINLINE10) >> ]"
        b" /Names << /JavaScript 12 0 R"
        b" /EmbeddedFiles << /Names [ (note.txt)"
        b" << /Type /Filespec /F (note.txt) /UF (note.txt) /EF << /F 7 0 R >> >> ] >> >>"
        b" /AF [ 11 0 R ] /Metadata 5 0 R /AcroForm 17 0 R /OCProperties 21 0 R /Lang (en) >>"
    )
    objects = {
        1: catalog,
        2: b"<< /Type /Pages /Kids [ 3 0 R ] /Count 1 >>",
        3: (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 300 200 ]"
            b" /Resources << /Font << /F1 20 0 R >> /ProcSet [ /PDF /Text ] /ExtGState << /GS0 24 0 R >>"
            b" /Properties << /MC1 22 0 R /MC2 23 0 R >> >>"
            b" /Contents 4 0 R /Annots [ 13 0 R 14 0 R 15 0 R 16 0 R ]"
            b" /AA << /O << /S /JavaScript /JS (SANJSCRIPTAA3) >> >> >>"
        ),
        4: stream(CONTENT),
        5: stream(XMP, " /Type /Metadata /Subtype /XML"),
        6: b"<< /Title (SANJINFOTITLE6) /Author (SANJINFOAUTH6) /Producer (sanitize-switch-fixtures) >>",
        7: stream(b"SANJATTACHAPAY7 / attachment A payload bytes\n", " /Type /EmbeddedFile"),
        8: stream(b"SANJATTACHBPAY8 / attachment B payload bytes\n", " /Type /EmbeddedFile"),
        9: b"<< /S /JavaScript /JS (SANJSCRIPTOPEN9) >>",
        # A `/Kids` name tree, so the walk has to descend, with the action stored
        # inline on the leaf — the spelling nothing reachable through the
        # indirect sweep ever touches.
        12: b"<< /Kids [ << /Names [ (Fold) << /S /JavaScript /JS (SANJSCRIPTTREE12) >> ] >> ] >>",
        11: b"<< /Type /Filespec /F (invoice.xml) /UF (invoice.xml) /EF << /F 8 0 R >> >>",
        13: (
            b"<< /Type /Annot /Subtype /Widget /FT /Tx /T (amount) /V (SANJFIELDVAL13)"
            b" /Rect [ 10 20 120 36 ] /F 4 >>"
        ),
        14: (
            b"<< /Type /Annot /Subtype /FreeText /Rect [ 10 40 220 70 ]"
            b" /Contents (SANJANNOTNOTE14) /F 4 /AP << /N 19 0 R >> >>"
        ),
        15: (
            b"<< /Type /Annot /Subtype /Link /Rect [ 10 150 120 168 ]"
            b" /A << /S /URI /URI (https://example.org/SANJLINKURI15) >> /F 4 >>"
        ),
        16: (
            b"<< /Type /Annot /Subtype /Link /Rect [ 10 90 120 108 ]"
            b" /A << /S /JavaScript /JS (SANJSCRIPTLINK16) >> /F 4 >>"
        ),
        17: b"<< /Fields [ 13 0 R ] /DR << /Font << /F1 20 0 R >> >> >>",
        19: stream(
            b"q BT /F1 10 Tf 12 18 Td (SANJANNOTAP19) Tj ET Q\n",
            " /Type /XObject /Subtype /Form /BBox [ 0 0 210 30 ] /Resources << /Font << /F1 20 0 R >> >>",
        ),
        20: FONT,
        21: b"<< /OCGs [ 22 0 R 23 0 R ] /D << /ON [ 23 0 R ] /OFF [ 22 0 R ] /Order [ 22 0 R 23 0 R ] /RBGroups [ ] >> >>",
        22: b"<< /Type /OCG /Name (RevisionB) /Intent /View >>",
        23: b"<< /Type /OCG /Name (RevisionA) /Intent /View >>",
        24: b"<< /Type /ExtGState >>",
    }
    build(objects, path, trailer_extra=" /Info 6 0 R")
    return {
        "scopes": ALL_MARKERS,
        "survivors": SURVIVORS,
        "counts": {"attachments": 2, "annotations": 4, "javascript": 5},
        "source": {"pages": 1},
    }


# ── the rest ─────────────────────────────────────────────────────────────────
def info_inline(path: pathlib.Path) -> dict:
    objects = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [ 3 0 R ] /Count 1 >>",
        3: (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 300 200 ]"
            b" /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"
        ),
        4: stream(b"q BT /F1 12 Tf 20 100 Td (info-inline body) Tj ET Q\n"),
        5: FONT,
    }
    build(
        objects,
        path,
        trailer_extra=" /Info << /Title (SANJINFOTITLEINLINE5) /Author (SANJINFOAUTHINLINE5) >>",
    )
    return {
        "scopes": {"info": ["SANJINFOTITLEINLINE5", "SANJINFOAUTHINLINE5"]},
        "survivors": [],
        "counts": {},
        "source": {"pages": 1},
    }


def attach_foreign(path: pathlib.Path) -> dict:
    """A `/Kids` attachment tree whose leaf file specification points `/EF`
    straight at the stream object, and a second file reached only through a
    document-level `/FileAttachment` annotation."""
    objects = {
        1: b"<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles 6 0 R >> >>",
        2: b"<< /Type /Pages /Kids [ 3 0 R ] /Count 1 >>",
        3: (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 300 200 ]"
            b" /Resources << /Font << /F1 8 0 R >> >> /Contents 4 0 R /Annots [ 7 0 R ] >>"
        ),
        4: stream(b"q BT /F1 12 Tf 20 100 Td (attach-foreign body) Tj ET Q\n"),
        6: b"<< /Kids [ << /Names [ (tree.bin) << /Type /Filespec /F (tree.bin) /EF << /F 5 0 R >> >> ] >> ] >>",
        5: stream(b"SANJFOREIGNPAY5 / kids-tree payload\n", " /Type /EmbeddedFile"),
        7: (
            b"<< /Type /Annot /Subtype /FileAttachment /Rect [ 30 30 50 50 ] /F 4"
            b" /Contents (SANJFOREIGNANN9) /FS << /Type /Filespec /F (ann.bin) /EF << /F 9 0 R >> >> >>"
        ),
        9: stream(b"SANJFOREIGNPAY9 / annotation payload\n", " /Type /EmbeddedFile"),
        8: FONT,
    }
    build(objects, path)
    return {
        "scopes": {"attachments": ["SANJFOREIGNPAY5", "SANJFOREIGNPAY9", "SANJFOREIGNANN9"]},
        "survivors": [],
        "counts": {"attachments": 2},
        "source": {"pages": 1},
    }


def annot_inherited(path: pathlib.Path) -> dict:
    """/Annots on the `/Pages` node: the sheet inherits it, so a strip that reads
    only each page's own dictionary counts nothing and removes nothing."""
    objects = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [ 3 0 R ] /Count 1 /Annots [ 5 0 R ] >>",
        3: (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 300 200 ]"
            b" /Resources << /Font << /F1 6 0 R >> >> /Contents 4 0 R >>"
        ),
        4: stream(b"q BT /F1 12 Tf 20 100 Td (annot-inherited body) Tj ET Q\n"),
        5: (
            b"<< /Type /Annot /Subtype /Text /Rect [ 40 40 60 60 ] /F 4"
            b" /Contents (SANJINHERITEDNOTE5) >>"
        ),
        6: FONT,
    }
    build(objects, path)
    return {
        "scopes": {"annotations": ["SANJINHERITEDNOTE5"]},
        "survivors": [],
        "counts": {"annotations": 1},
        "source": {"pages": 1},
    }


def layers_off(path: pathlib.Path) -> dict:
    """Two layers, one off in the default view, each drawn inside its own `/OC`
    marked content section, so "removed" is measured as bytes *and* as ink."""
    content = (
        b"q BT /F1 12 Tf 20 180 Td (layer sheet body) Tj ET Q\n"
        b"/GS0 gs\n"
        b"/OC /MC1 BDC\n"
        b"q BT /F1 12 Tf 20 150 Td (SANJLAYEROFF22) Tj ET Q\n"
        b"EMC\n"
        b"/OC /MC2 BDC\n"
        b"q BT /F1 12 Tf 20 120 Td (SANJLAYERON23) Tj ET Q\n"
        b"EMC\n"
    )
    objects = {
        1: b"<< /Type /Catalog /Pages 2 0 R /OCProperties 21 0 R >>",
        2: b"<< /Type /Pages /Kids [ 3 0 R ] /Count 1 >>",
        3: (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 300 200 ]"
            b" /Resources << /Font << /F1 20 0 R >> /ExtGState << /GS0 24 0 R >>"
            b" /Properties << /MC1 22 0 R /MC2 23 0 R >> >> /Contents 4 0 R >>"
        ),
        4: stream(content),
        20: FONT,
        21: b"<< /OCGs [ 22 0 R 23 0 R ] /D << /ON [ 23 0 R ] /OFF [ 22 0 R ] /Order [ 22 0 R 23 0 R ] /RBGroups [ ] >> >>",
        22: b"<< /Type /OCG /Name (RevisionB) /Intent /View >>",
        23: b"<< /Type /OCG /Name (RevisionA) /Intent /View >>",
        24: b"<< /Type /ExtGState >>",
    }
    # Gaps are fine now: the file is written with the numbers the manifest names.
    build(objects, path)
    return {
        "scopes": {"hiddenLayers": ["SANJLAYEROFF22"]},
        "survivors": ["SANJLAYERON23"],
        "counts": {},
        "source": {"pages": 1},
    }


def plain(path: pathlib.Path) -> dict:
    objects = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [ 3 0 R ] /Count 1 >>",
        3: (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 300 200 ]"
            b" /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"
        ),
        4: stream(b"q BT /F1 12 Tf 20 100 Td (SANJPLAINBODY4 nothing to remove) Tj ET Q\n"),
        5: FONT,
    }
    build(objects, path)
    return {
        "scopes": {},
        "survivors": ["SANJPLAINBODY4"],
        "counts": {},
        "source": {"pages": 1},
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True)
    args = parser.parse_args()
    out = pathlib.Path(args.dir)
    out.mkdir(parents=True, exist_ok=True)
    manifest = {
        "all.pdf": all_pdf(out / "all.pdf"),
        "info-inline.pdf": info_inline(out / "info-inline.pdf"),
        "attach-foreign.pdf": attach_foreign(out / "attach-foreign.pdf"),
        "annot-inherited.pdf": annot_inherited(out / "annot-inherited.pdf"),
        "layers-off.pdf": layers_off(out / "layers-off.pdf"),
        "plain.pdf": plain(out / "plain.pdf"),
    }
    for name in sorted(manifest):
        path = out / name
        print(f"{path} {path.stat().st_size} bytes")
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"{out / 'manifest.json'}")


if __name__ == "__main__":
    main()
