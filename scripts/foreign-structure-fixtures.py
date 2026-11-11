#!/usr/bin/env python3
"""Build `tests/fixtures/foreign/`: one file per PDF structure, **no pdf-lib anywhere**.

The attachments pass (`docs/research/attachments-foreign-repro.md`) started from a
sentence the bytes contradicted and ended on a reader that only recognised what its
own writer emits. This directory is the same question asked of the app's **other**
readers, so the audit in `docs/research/foreign-structure-audit.md` is a measurement
rather than a hunch: for each structure, one file in which the structure exists and
is countable, written by a producer that shares no code with this repo, and verified
by that producer plus a second outside reader before it is kept.

    outlines + named destinations  pymupdf `set_toc` (3 entries, one nested)
    page labels                    pikepdf `/PageLabels` as a `/Kids` number tree
    optional content (OCG)         pymupdf `add_ocg`, one on / one off, drawn with
    annotations                    pymupdf note + free-text + highlight + link
    form fields                    pymupdf widgets (text, checkbox, dropdown)
    /Info + XMP                    pymupdf `set_metadata` + `set_xml_metadata`
    embedded file                  pymupdf `embfile_add`

Every file carries the same three text pages naming their own sheet, so a reader can
be asked "did you lose a page" as well as "did you lose a field".

    python3 scripts/foreign-structure-fixtures.py [outdir]
"""
import hashlib
import json
import os
import subprocess
import sys
from typing import Any

import pymupdf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pdf_fixture_determinism import (  # noqa: E402
    check_reproducible,
    freeze_all,
    sha,
    write_manifest,
)

TARGET = os.path.abspath(
    sys.argv[1] if len(sys.argv) > 1 else "tests/fixtures/foreign"  # noqa: S108
)
os.makedirs(TARGET, exist_ok=True)

PLANTED = "Lighthouse Inventory 1887"
# The two widget kinds this fixture writes. Named here because PyMuPDF's stubs omit
# these module constants entirely while the runtime defines them.
TEXT_WIDGET: int = pymupdf.PDF_WIDGET_TYPE_TEXT  # type: ignore[attr-defined]
CHECKBOX_WIDGET: int = pymupdf.PDF_WIDGET_TYPE_CHECKBOX  # type: ignore[attr-defined]
SHEETS = ("ALPHA", "BRAVO", "CHARLIE")
ENCLOSURE = b"a,b\n1,2\n"
XMP = (
    '<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>'
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF '
    'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">'
    '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Foreign structures</rdf:li></rdf:Alt></dc:title>'
    '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
)


def doc_new() -> pymupdf.Document:
    doc = pymupdf.open()
    for index in range(3):
        page = doc.new_page(width=595, height=842)
        page.insert_text((60, 730), f"{PLANTED} page {index + 1}", fontsize=16)
        page.insert_text((60, 700), f"Sheet {SHEETS[index]} body copy", fontsize=11)
        page.draw_rect(pymupdf.Rect(60, 750, 300, 770), color=(0, 0, 0), fill=(0, 0, 0))
    return doc


def write(doc: pymupdf.Document, name: str) -> str:
    path = os.path.join(TARGET, name)
    doc.save(path)
    doc.close()
    return path


def build_outlines() -> dict:
    doc = doc_new()
    # Three entries, one of them a child — the shape a Word or LibreOffice export
    # carries, and the one this app's own outline writer produces.
    doc.set_toc([
        [1, "Chapter One", 1],
        [2, "Section One.A", 2],
        [1, "Chapter Two", 3],
    ])
    info = {"toc": doc.get_toc()}
    write(doc, "outlines.pdf")
    return info


def build_page_labels() -> dict:
    import pikepdf

    doc = doc_new()
    path = write(doc, "page-labels.pdf")
    pdf = pikepdf.open(path, allow_overwriting_input=True)

    def label(style: str, start: int, prefix: str | None = None):
        d = pikepdf.Dictionary(S=pikepdf.Name("/" + style))
        if prefix:
            d["/P"] = pikepdf.String(prefix)
        d["/St"] = pikepdf.Object.parse(str(start).encode())
        return pdf.make_indirect(d)

    # A /Kids tree, not a flat /Nums — the shape `readPageLabels` has never met.
    kid_a = pdf.make_indirect(pikepdf.Dictionary(
        Limits=pikepdf.Array([pikepdf.Object.parse(b"0"), pikepdf.Object.parse(b"1")]),
        Nums=pikepdf.Array([
            pikepdf.Object.parse(b"0"), label("D", 1, "i-"),
            pikepdf.Object.parse(b"1"), label("R", 1),
        ]),
    ))
    kid_b = pdf.make_indirect(pikepdf.Dictionary(
        Limits=pikepdf.Array([pikepdf.Object.parse(b"2"), pikepdf.Object.parse(b"2")]),
        Nums=pikepdf.Array([pikepdf.Object.parse(b"2"), label("a", 3)]),
    ))
    pdf.Root["/PageLabels"] = pikepdf.Dictionary(Kids=pikepdf.Array([kid_a, kid_b]))
    pdf.save(path)
    pdf.close()
    again = pymupdf.open(path)
    labels = again.get_page_labels()
    again.close()
    info = {"labels": labels}
    return info


def build_outlines_dests(mode: str) -> dict:
    """Outline items naming a destination in `/Dests`, in three spellings.

    `resolveNamedDestination` reads a flat `/Names` array off `/Dests` and wants the
    value to be an array it can see directly. The format allows more than that, and the
    three variants tell the shapes apart instead of blaming whichever one fails:

        flat-direct  `/Names` at the root, destination arrays written inline — control
        flat-ref     `/Names` at the root, each destination behind a reference
        tree-ref     a `/Kids` + `/Limits` subtree, destinations behind references

    MuPDF is the outside check, and it reports page 0 for an entry whose destination it
    cannot resolve, so each row states what a reader that did not write the file makes
    of the same spelling.
    """
    import pikepdf

    doc = doc_new()
    doc.set_toc([[1, "Chapter One", 1], [1, "Chapter Two", 2]])
    name = f"outlines-dests-{mode}.pdf"
    path = write(doc, name)
    pdf = pikepdf.open(path, allow_overwriting_input=True)

    names = ["alpha", "beta"]
    destinations = []
    for index in range(len(names)):
        page_ref = pdf.Root["/Pages"]["/Kids"][index]
        target = pikepdf.Array([page_ref, pikepdf.Name("/Fit")])
        destinations.append(target if mode == "flat-direct" else pdf.make_indirect(target))
    pairs = pikepdf.Array()
    for key, target in zip(names, destinations, strict=True):
        pairs.append(pikepdf.String(key))
        pairs.append(target)
    if mode != "tree-ref":
        pdf.Root["/Dests"] = pikepdf.Dictionary(Names=pairs)
    else:
        leaf = pdf.make_indirect(pikepdf.Dictionary(
            Limits=pikepdf.Array([pikepdf.String("alpha"), pikepdf.String("beta")]),
            Names=pairs,
        ))
        pdf.Root["/Dests"] = pikepdf.Dictionary(Kids=pikepdf.Array([leaf]))

    items = []
    # pikepdf's stubs type `/First` as an Array and `/Next` as an Object; the outline
    # chain is a dictionary walk either way, so the handle is left unrefined.
    node = pdf.Root["/Outlines"]["/First"]  # type: ignore[assignment]
    while node is not None:
        items.append(node)
        node = node.get("/Next")  # type: ignore[assignment]
    for item, key in zip(items, names, strict=False):
        target = item
        if not target.is_indirect:
            continue
        if "/A" in target:
            del target["/A"]
        target["/Dest"] = pikepdf.String(key)
    pdf.save(path)
    pdf.close()

    again = pymupdf.open(path)
    # MuPDF's Python bindings expose no per-item resolver in 1.28.2, so `get_toc()` is
    # the probe: an entry it cannot resolve comes back with page 0.
    info = {"mupdf_pages": [entry[2] for entry in again.get_toc()]}
    again.close()
    return info


def build_page_labels_flat() -> dict:
    """The control: the same three ranges, written as a flat `/Nums` array.

    Without it the `/Kids` row below only says "labels are wrong", which is not what
    is measured: the reader handles the flat shape pdf-lib writes, and loses the tree.
    """
    import pikepdf

    doc = doc_new()
    path = write(doc, "page-labels-flat.pdf")
    pdf = pikepdf.open(path, allow_overwriting_input=True)

    def label(style: str, start: int, prefix: str | None = None):
        d = pikepdf.Dictionary(S=pikepdf.Name("/" + style))
        if prefix:
            d["/P"] = pikepdf.String(prefix)
        d["/St"] = pikepdf.Integer(start)
        return pdf.make_indirect(d)

    pdf.Root["/PageLabels"] = pikepdf.Dictionary(
        Nums=pikepdf.Array([
            pikepdf.Integer(0), label("D", 1, "i-"),
            pikepdf.Integer(1), label("R", 1),
            pikepdf.Integer(2), label("a", 3),
        ]),
    )
    pdf.save(path)
    pdf.close()
    again = pymupdf.open(path)
    info = {"labels": again.get_page_labels()}
    again.close()
    return info


def build_layers() -> dict:
    doc = doc_new()
    page = doc[0]
    on = doc.add_ocg("DrawnLayer", on=True)  # noqa: F841
    doc.add_ocg("HiddenLayer", on=False)
    page.insert_text((60, 640), "Painted through DrawnLayer", fontsize=11, oc=on)
    info = {"ocgs": sorted(doc.get_ocgs())}
    write(doc, "layers.pdf")
    return info


def build_annotations() -> dict:
    doc = doc_new()
    page = doc[0]
    note = page.add_text_annot((300, 600), "A note from an outside writer")
    note.set_info(title="foreign", content="A note from an outside writer")
    note.update()
    free = page.add_freetext_annot(pymupdf.Rect(60, 500, 320, 530), "Free text, drawn inline", fontsize=10)
    free.update()
    page.add_highlight_annot(pymupdf.Rect(60, 722, 320, 740))
    page.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(60, 400, 260, 420), "uri": "https://example.com"})
    info = {"annots": [[a.type[1] for a in (doc.load_page(i).annots() or [])] for i in range(doc.page_count)]}
    write(doc, "annotations.pdf")
    return info


def widget(kind: int, rect, name: str, value: str, label: str) -> Any:
    """One form widget.

    PyMuPDF's type stubs annotate every `Widget` attribute as `None`-typed, so the
    handle is held as `Any` and the attributes are assigned exactly the way the runtime
    documents them. A probe of this call wrote both widgets and the census read them
    back by name, which is the evidence that the stubs, not this code, are wrong.
    """
    made: Any = pymupdf.Widget()
    made.field_type = kind
    made.rect = pymupdf.Rect(*rect)
    made.field_name = name
    made.field_label = label
    if kind == TEXT_WIDGET:
        made.text = value
    else:
        made.field_value = value
    return made


def widget_names(doc: pymupdf.Document) -> list[str]:
    """Every field name the file's widgets carry."""
    names: set[str] = set()
    for index in range(doc.page_count):
        for annot in (doc.load_page(index).widgets() or []):
            field: Any = annot
            if field.field_name:
                names.add(str(field.field_name))
    return sorted(names)


def build_form() -> dict:
    doc = doc_new()
    page = doc[0]
    page.add_widget(widget(TEXT_WIDGET, (60, 300, 260, 320), "answer", "Ada Lovelace", "The answer"))
    page.add_widget(widget(CHECKBOX_WIDGET, (60, 260, 84, 284), "tick", "Yes", "Tick"))
    info = {"widgets": widget_names(doc)}
    write(doc, "form.pdf")
    return info


def build_metadata() -> dict:
    doc = doc_new()
    doc.set_metadata({
        "title": "Foreign structures",
        "author": "PyMuPDF 1.28.2",
        "subject": "One file per structure",
        "keywords": "info, xmp",
        "creator": "scripts/foreign-structure-fixtures.py",
    })
    doc.set_xml_metadata(XMP)
    info = {"title": (doc.metadata or {}).get("title"), "xmp_bytes": len(XMP.encode())}
    write(doc, "metadata.pdf")
    return info


def build_attachment() -> dict:
    doc = doc_new()
    doc.embfile_add("enclosure.txt", ENCLOSURE, filename="enclosure.txt",
                    ufilename="enclosure.txt", desc="written by MuPDF")
    info = {"names": sorted(doc.embfile_names()), "sha256": hashlib.sha256(ENCLOSURE).hexdigest()}
    write(doc, "attachment.pdf")
    return info


def verify(name: str) -> dict:
    """Two outside readers over the kept file; a shape nobody can see proves nothing."""
    path = os.path.join(TARGET, name)
    doc = pymupdf.open(path)
    seen = {
        "pages": doc.page_count,
        "toc": len(doc.get_toc()),
        "labels": doc.get_page_labels(),
        "ocgs": sorted(doc.get_ocgs()),
        "annots": sorted({a.type[1] for i in range(doc.page_count)
                          for a in (doc.load_page(i).annots() or [])}),
        "widgets": widget_names(doc),
        "title": (doc.metadata or {}).get("title"),
        "xmp": len((doc.get_xml_metadata() or "").encode()),
        "embfiles": sorted(doc.embfile_names()),
    }
    doc.close()
    detach = subprocess.run(["pdfdetach", "-list", path], capture_output=True, check=False)
    listing = detach.stdout.decode("utf-8", "replace").strip().splitlines()
    seen["poppler_attachments"] = listing[:1]
    return seen


SHAPES: dict[str, dict[str, str]] = {}
EXPECTED: dict[str, dict[str, bytes]] = {}


def note_shape(name: str, shape: str, producer: str, payloads: dict[str, bytes] | None = None) -> None:
    SHAPES[name] = {"shape": shape, "producer": producer}
    if payloads:
        EXPECTED[name] = payloads


def main() -> None:
    builders = {
        "outlines.pdf": build_outlines,
        "outlines-dests-flat-direct.pdf": lambda: build_outlines_dests("flat-direct"),
        "outlines-dests-flat-ref.pdf": lambda: build_outlines_dests("flat-ref"),
        "outlines-dests-tree-ref.pdf": lambda: build_outlines_dests("tree-ref"),
        "page-labels.pdf": build_page_labels,
        "page-labels-flat.pdf": build_page_labels_flat,
        "layers.pdf": build_layers,
        "annotations.pdf": build_annotations,
        "form.pdf": build_form,
        "metadata.pdf": build_metadata,
        "attachment.pdf": build_attachment,
    }
    shapes = {
        "outlines.pdf": ("a /Outlines tree of three entries, one of them a child", "MuPDF 1.28.2 (PyMuPDF set_toc)"),
        "outlines-dests-flat-direct.pdf": ("/Dests /Names with the destination arrays inline — the control",
                                           "MuPDF 1.28.2 (set_toc) + libqpdf 12.3.2 (/Dests)"),
        "outlines-dests-flat-ref.pdf": ("/Dests /Names with each destination behind a reference",
                                        "MuPDF 1.28.2 (set_toc) + libqpdf 12.3.2 (/Dests)"),
        "outlines-dests-tree-ref.pdf": ("a /Kids + /Limits /Dests tree, destinations behind references",
                                        "MuPDF 1.28.2 (set_toc) + libqpdf 12.3.2 (/Dests tree)"),
        "page-labels.pdf": ("/PageLabels as a /Kids number tree, not a flat /Nums", "libqpdf 12.3.2 (pikepdf)"),
        "page-labels-flat.pdf": ("/PageLabels as a flat /Nums array — the control", "libqpdf 12.3.2 (pikepdf)"),
        "layers.pdf": ("two /OCGs, one on and one off, referenced from page content", "MuPDF 1.28.2 (PyMuPDF add_ocg)"),
        "annotations.pdf": ("note + free-text + highlight + link on one page", "MuPDF 1.28.2 (PyMuPDF)"),
        "form.pdf": ("an AcroForm with a text field and a checkbox widget", "MuPDF 1.28.2 (PyMuPDF add_widget)"),
        "metadata.pdf": ("/Info written by one tool, an XMP packet by another", "MuPDF 1.28.2 (PyMuPDF)"),
        "attachment.pdf": ("an enclosure MuPDF writes into the name tree", "MuPDF 1.28.2 (PyMuPDF embfile_add)"),
    }
    for name, (shape, producer) in shapes.items():
        note_shape(name, shape, producer,
                   {"enclosure.txt": ENCLOSURE} if name == "attachment.pdf" else None)

    report = {}
    for name, build in builders.items():
        intended = build()
        report[name] = {"intended": intended, "outside": verify(name)}

    # Same determinism step the attachment fixtures use: timestamps and both halves of
    # the trailer /ID pinned, so a red test means the reader changed, not the clock.
    write_manifest(TARGET, freeze_all(TARGET, SHAPES, {n: {k: sha(v) for k, v in p.items()}
                                                       for n, p in EXPECTED.items()},
                                      "the three-page base, written by MuPDF",
                                      "MuPDF 1.28.2 (PyMuPDF)"))
    # Re-verify after the freeze: the census must describe the bytes that are kept.
    for name in report:
        report[name]["outside_after_freeze"] = verify(name)
    print(json.dumps(report, indent=1, ensure_ascii=False))
    with open(os.path.join(TARGET, "census.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=1, ensure_ascii=False)


if __name__ == "__main__":
    if "--check" in sys.argv:
        sys.exit(check_reproducible([sys.executable, os.path.abspath(__file__)], "foreign"))
    main()
