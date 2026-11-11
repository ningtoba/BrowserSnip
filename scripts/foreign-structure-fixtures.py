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
    fonts + images                 pymupdf faces (base-14, TrueType subset, CFF/OTF)
                                   and two rasters, in four resource layouts: page,
                                   inherited from `/Pages`, inside a Form XObject,
                                   and one dictionary shared by three pages
    script actions                 pikepdf `/OpenAction` inline / referenced / an
                                   array, `/JS` with no `/S`, `/AA` on a page, an
                                   annotation and a field, `/Names » /JavaScript`
                                   flat and as a `/Kids` tree, and an XFA packet
    signatures                     pikepdf `/Sig` + `/ByteRange` + a PKCS#7 this repo
                                   assembled (`scripts/pdf_fixture_pkcs7.py`) from an
                                   OpenSSL key pair, checked by `openssl cms -verify`

The last three families are the rows `docs/research/reader-sweep-reconciliation.md`
found with no measurement at all: `listFonts`/`listImages`, `inspectScript`/
`stripScript` and `readSignatures`.

Every file carries the same three text pages naming their own sheet, so a reader can
be asked "did you lose a page" as well as "did you lose a field".

    python3 scripts/foreign-structure-fixtures.py [outdir]
    python3 scripts/foreign-structure-fixtures.py --check   # byte-reproducible, twice
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from typing import Any

import pymupdf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pdf_fixture_determinism import (  # noqa: E402
    check_reproducible,
    file_bytes,
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


# ---------------------------------------------------------------------------
# The three rows `docs/research/reader-sweep-reconciliation.md` found unmeasured:
# the font/image inventories, the script walk, and signature verification.
# ---------------------------------------------------------------------------

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NOTO_TTF = os.path.join(REPO, "public", "fonts", "NotoSans-Regular.ttf")
CFF_OTF = os.path.join(REPO, "tests", "fixtures", "cff-face.otf")
#: The key pair OpenSSL generated once and that the repository carries: reading it from
#: a fixed path (not `TARGET`) is what lets `--check` rebuild into a scratch directory.
SIGNER_DIR = os.path.join(REPO, "tests", "fixtures", "foreign")
SIGNER_KEY = os.path.join(SIGNER_DIR, "signer-key.pem")
SIGNER_CERT = os.path.join(SIGNER_DIR, "signer-cert.pem")
#: Width of the `/Contents` placeholder, in hex characters. A real signer reserves
#: space it then fills; the reservation is what makes a length-preserving patch and
#: therefore a reproducible `/ByteRange` possible.
CONTENT_PAD = 4096
#: The `/ByteRange` numbers are written zero-padded to this width for the same reason
#: (§7.3.3: an integer is one or more digits, so `0000001234` is `1234`).
RANGE_PAD = 10


def doc_with_resources() -> pymupdf.Document:
    """The base document plus every resource shape `listFonts` / `listImages` reads.

    Page 1 carries three faces — the base-14 Helvetica MuPDF references without
    embedding, an embedded TrueType subset (`/Type0` → `/CIDFontType2` → `/FontFile2`)
    and an OpenType/CFF face (`/FontFile3` with `/Subtype /CIDFontType0C`, which
    pdf-lib never writes) — and two images: one stored with **no `/Filter`** behind an
    `[/ICCBased …]` colour space, one `/DCTDecode`d JPEG.
    """
    doc = doc_new()
    page = doc[0]
    page.insert_text((60, 680), "embedded TrueType subset", fontname="noto",
                     fontfile=NOTO_TTF, fontsize=12)
    page.insert_text((60, 650), "embedded CFF face", fontname="cff",
                     fontfile=CFF_OTF, fontsize=12)
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 40, 24))
    # `Pixmap(colorspace, rect)` leaves the sample buffer uninitialised in MuPDF, so
    # painting only part of it makes the saved file depend on whatever the allocator
    # handed back. Fill it first, then draw the pattern: the same 40x24 pixels, and
    # the same bytes, every run.
    pix.set_rect(pymupdf.IRect(0, 0, 40, 24), (255, 255, 255))
    pix.set_rect(pymupdf.IRect(0, 0, 20, 24), (255, 0, 0))
    page.insert_image(pymupdf.Rect(60, 560, 140, 584), pixmap=pix)
    page.insert_image(pymupdf.Rect(60, 500, 140, 524), stream=pix.tobytes("jpeg"))
    return doc


def build_resources(mode: str) -> dict:
    """Where a page's resources live, in four spellings the format allows.

        plain      each page names its own `/Resources` — what pdf-lib writes
        inherited  `/Resources` sits on the `/Pages` node (§7.7.3.3 inherited attrs)
        xobject    the page draws one Form XObject that carries the resources itself
        shared     every page names the *same* resource dictionary object
        subset     the two embedded faces carry a `BCDFEE+` subsetting tag, as
                   LibreOffice and Acrobat write them
    """
    import pikepdf

    name = f"resources-{mode}.pdf"
    path = write(doc_with_resources(), name)
    if mode == "plain":
        return {"mode": mode}

    pdf = pikepdf.open(path, allow_overwriting_input=True)
    pages = pdf.Root["/Pages"]
    kids = list(pages["/Kids"])
    first = kids[0]
    resources = first["/Resources"]

    if mode == "inherited":
        pages["/Resources"] = resources
        for page in kids:
            if "/Resources" in page:
                del page["/Resources"]
    elif mode == "shared":
        for page in kids[1:]:
            page["/Resources"] = resources
    elif mode == "subset":
        # The tag a subsetting producer puts in front of the face name. MuPDF embeds
        # these two faces whole, so the prefix is added by hand over the libqpdf model
        # — which is exactly the spelling (`BCDFEE+Faker`, `ABCDEA+FontName`) that
        # LibreOffice and Acrobat write and that `listFonts` splits into `name` and
        # `subset`.
        prefixes = {"/noto": "BCDFEE+", "/cff": "ABCDEA+"}
        for key, font in first["/Resources"]["/Font"].items():
            prefix = prefixes.get(str(key))
            if prefix is None:
                continue
            for node in [font, *(font.get("/DescendantFonts") or [])]:
                if "/BaseFont" in node:
                    node["/BaseFont"] = pikepdf.Name(
                        f"/{prefix}{str(node['/BaseFont']).lstrip('/')}")
            descriptor = (font.get("/DescendantFonts") or [font])[0].get("/FontDescriptor")
            if descriptor is not None and "/FontName" in descriptor:
                descriptor["/FontName"] = pikepdf.Name(
                    f"/{prefix}{str(descriptor['/FontName']).lstrip('/')}")
    elif mode == "xobject":
        contents = first["/Contents"]
        entries = contents if isinstance(contents, pikepdf.Array) else [contents]
        data = b"".join(entry.read_bytes() for entry in entries)
        form = pdf.make_indirect(pikepdf.Stream(pdf, data))
        form["/Type"] = pikepdf.Name("/XObject")
        form["/Subtype"] = pikepdf.Name("/Form")
        form["/BBox"] = first["/MediaBox"]
        form["/Resources"] = resources
        holder = pikepdf.Dictionary()
        holder["/Fm0"] = form
        first["/Resources"] = pikepdf.Dictionary(XObject=holder)
        first["/Contents"] = pdf.make_indirect(
            pikepdf.Stream(pdf, b"q 1 0 0 1 0 0 cm /Fm0 Do Q\n"))
    pdf.save(path)
    pdf.close()
    return {"mode": mode}


def resource_inventory(path: str) -> dict:
    """An outside inventory of what each page places, written for this census.

    It walks the **object model** through libqpdf (pikepdf), resolving inherited
    `/Resources` up the page tree (§7.7.3.3) and stepping into Form XObjects, and it
    records for every entry whether the pointer was stored inline or behind a
    reference — the distinction that has now bitten this repo three times. Nothing in
    here is this app's code: the point is to be able to say what the bytes hold.
    """
    import pikepdf

    pdf = pikepdf.open(path)

    def stored(value) -> bool:
        return bool(getattr(value, "is_indirect", False))

    def name_of(value) -> str | None:
        return None if value is None else str(value)

    def inherited(page, key: str):
        node = page
        while node is not None:
            if key in node:
                return node[key]
            node = node.get("/Parent")
        return None

    fonts: list[dict] = []
    images: list[dict] = []
    seen_forms: set[int] = set()

    def look(resources, page_number: int, via: str) -> None:
        if resources is None:
            return
        font_dict = resources.get("/Font")
        if font_dict is not None:
            for key, value in font_dict.items():
                entry: dict[str, Any] = {
                    "page": page_number, "key": name_of(key), "via": via,
                    "referenced": stored(value),
                    "subtype": name_of(value.get("/Subtype")),
                    "baseFont": name_of(value.get("/BaseFont")),
                    "encoding": name_of(value.get("/Encoding")),
                }
                descendants = value.get("/DescendantFonts")
                descendant = descendants[0] if descendants else None
                if descendant is not None:
                    entry["descendantSubtype"] = name_of(descendant.get("/Subtype"))
                    entry["descendantBaseFont"] = name_of(descendant.get("/BaseFont"))
                    info = descendant.get("/CIDSystemInfo") or {}
                    entry["registry"] = str(info.get("/Registry") or "")
                    entry["ordering"] = str(info.get("/Ordering") or "")
                descriptor = (descendant or value).get("/FontDescriptor")
                entry["fontFile"] = next(
                    (file for file in ("/FontFile", "/FontFile2", "/FontFile3")
                     if descriptor is not None and file in descriptor), None)
                fonts.append(entry)
        xobjects = resources.get("/XObject")
        if xobjects is None:
            return
        for key, value in xobjects.items():
            subtype = name_of(value.get("/Subtype"))
            if subtype == "/Form":
                if id(value) in seen_forms:
                    continue
                seen_forms.add(id(value))
                look(value.get("/Resources"), page_number, f"form-xobject:{name_of(key)}")
                continue
            if subtype != "/Image":
                continue
            color_space = value.get("/ColorSpace")
            filter_name = value.get("/Filter")
            images.append({
                "page": page_number, "key": name_of(key), "via": via,
                "referenced": stored(value),
                "width": int(value.get("/Width", 0)),
                "height": int(value.get("/Height", 0)),
                "bitsPerComponent": int(value.get("/BitsPerComponent", 0)),
                "filter": name_of(filter_name if not isinstance(filter_name, pikepdf.Array)
                                  else filter_name[0]),
                "colorSpace": name_of(color_space if not isinstance(color_space, pikepdf.Array)
                                      else color_space[0]),
                "smask": "/SMask" in value,
                "imageMask": bool(value.get("/ImageMask", False)),
                "xref": None if not value.is_indirect else value.objgen[0],
                "bytes": len(value.read_raw_bytes()),
            })

    for index, kid in enumerate(pdf.Root["/Pages"]["/Kids"]):
        look(inherited(kid, "/Resources"), index + 1, "page")
    pdf.close()
    return {"fonts": fonts, "images": images}


def mupdf_resources(path: str) -> dict:
    """What MuPDF, a second implementation, says each page places."""
    doc = pymupdf.open(path)
    seen = {
        "fonts": [page.get_fonts(full=True) for page in doc],
        "images": [page.get_images(full=True) for page in doc],
        "xobjects": [page.get_xobjects() for page in doc],
    }
    doc.close()
    return seen


# --- the script walk --------------------------------------------------------

JS_CODES = {
    "open": "app.alert('opened');",
    "page": "this.syncDDE = false;",
    "annot": "event.target.fillColor = color.red;",
    "field": "event.value = this.getField('sub').value * 1.2;",
    "named": "console.clear();",
}


def build_scripts(mode: str) -> dict:
    """One file per place a PDF can be told to run JavaScript.

        openaction-inline   catalogue `/OpenAction` with the action dict inline
        openaction-ref      the same entry with the action behind a reference
        openaction-array    `/OpenAction` naming **two** actions in one entry
        js-key-only         an action with `/JS` and no `/S` at all
        names-flat          `/Names » /JavaScript` as a flat `/Names` array, one
                            value inline and one behind a reference
        names-kids          the same pairs inside a `/Kids` + `/Limits` subtree
        hosts-aa            page `/AA /O`, annotation `/AA /E`, field `/AA /K`
                            and a field `/A`, plus a field with no action at all
        xfa                 an `/AcroForm /XFA` packet whose script lives in its
                            own XML, which nothing here parses

    The action dictionaries themselves are written by libqpdf through pikepdf into a
    document MuPDF wrote; poppler, which walks these trees with its own code, is the
    outside witness in `verify()` below.
    """
    import pikepdf

    doc = doc_new()
    annot_page = None
    if mode == "hosts-aa":
        annot_page = doc[0].add_text_annot((300, 600), "carries an /AA /E action")
        annot_page.update()
    name = f"script-{mode}.pdf"
    path = write(doc, name)

    pdf = pikepdf.open(path, allow_overwriting_input=True)

    def action(code: str, *, inline: bool = False, with_subtype: bool = True):
        made = pikepdf.Dictionary()
        if with_subtype:
            made["/S"] = pikepdf.Name("/JavaScript")
        made["/JS"] = pikepdf.String(code)
        return made if inline else pdf.make_indirect(made)

    if mode == "openaction-inline":
        pdf.Root["/OpenAction"] = action(JS_CODES["open"], inline=True)
    elif mode == "openaction-ref":
        pdf.Root["/OpenAction"] = action(JS_CODES["open"])
    elif mode == "openaction-array":
        pdf.Root["/OpenAction"] = pikepdf.Array(
            [action(JS_CODES["open"], inline=True), action(JS_CODES["named"])])
    elif mode == "js-key-only":
        pdf.Root["/OpenAction"] = action(JS_CODES["open"], inline=True, with_subtype=False)
    elif mode in ("names-flat", "names-kids"):
        pairs = pikepdf.Array()
        pairs.append(pikepdf.String("Startup"))
        pairs.append(action(JS_CODES["named"], inline=True))
        pairs.append(pikepdf.String("Fold"))
        pairs.append(action(JS_CODES["field"]))
        if mode == "names-flat":
            tree = pikepdf.Dictionary(Names=pairs)
        else:
            leaf = pdf.make_indirect(pikepdf.Dictionary(
                Limits=pikepdf.Array([pikepdf.String("Fold"), pikepdf.String("Startup")]),
                Names=pairs))
            tree = pikepdf.Dictionary(Kids=pikepdf.Array([leaf]))
        pdf.Root["/Names"] = pikepdf.Dictionary(JavaScript=tree)
    elif mode == "hosts-aa":
        page = pdf.Root["/Pages"]["/Kids"][0]
        page["/AA"] = pikepdf.Dictionary(O=action(JS_CODES["page"]))
        annot = pdf.Root["/Pages"]["/Kids"][0]["/Annots"][0]
        annot["/AA"] = pikepdf.Dictionary(E=action(JS_CODES["annot"], inline=True))
        totals = pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name("/Annot"), Subtype=pikepdf.Name("/Widget"),
            FT=pikepdf.Name("/Tx"), T=pikepdf.String("totals"),
            AA=pikepdf.Dictionary(K=action(JS_CODES["field"]))))
        heading = pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name("/Annot"), Subtype=pikepdf.Name("/Widget"),
            FT=pikepdf.Name("/Tx"), T=pikepdf.String("heading"),
            A=action(JS_CODES["open"], inline=True)))
        blank = pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name("/Annot"), Subtype=pikepdf.Name("/Widget"),
            FT=pikepdf.Name("/Tx"), T=pikepdf.String("blank")))
        pdf.Root["/AcroForm"] = pikepdf.Dictionary(
            Fields=pikepdf.Array([totals, heading, blank]), NeedAppearances=True)
    elif mode == "xfa":
        xml = ("<xdp:xdp xmlns:xdp='http://ns.adobe.com/xdp/'"
               " xmlns:xfa='http://www.xfa.org/schema/xfa-template/3.0/'>"
               "<template><x:script>xfa.host.messageBox('in the packet');"
               "</x:script></template></xdp:xdp>")
        stream = pdf.make_indirect(pikepdf.Stream(pdf, xml.encode()))
        field = pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name("/Annot"), Subtype=pikepdf.Name("/Widget"),
            FT=pikepdf.Name("/Tx"), T=pikepdf.String("xfaprop")))
        pdf.Root["/AcroForm"] = pikepdf.Dictionary(
            Fields=pikepdf.Array([field]), XFA=pikepdf.Array([pikepdf.String("xdp"), stream]))
    pdf.save(path)
    pdf.close()
    return {"mode": mode, "annot": bool(annot_page)}


def script_sites(path: str) -> dict:
    """Every place this file *runs* script from, walked over the libqpdf model.

    Independent of `core/sanitize.ts`: entries are collected by hand from the
    catalogue, every page, every annotation and every field (recursively through
    `/Kids`), the catalogue's own `/JavaScript`, and the `/Names » /JavaScript` tree
    walked **through `/Kids` as well as flat**, which is the difference this census
    exists to be able to see.
    """
    import pikepdf

    pdf = pikepdf.open(path)

    def is_js(value) -> bool:
        """Does this entry point at a JavaScript action (inline, referenced or an array)?"""
        if isinstance(value, pikepdf.Array):
            return any(is_js(item) for item in value)
        if not isinstance(value, pikepdf.Dictionary):
            return False
        subtype = value.get("/S")
        if subtype is not None:
            return str(subtype) == "/JavaScript"
        return "/JS" in value or "/JavaScript" in value

    entries: list[str] = []

    def scan_host(node, label: str) -> None:
        for key in ("/OpenAction", "/A"):
            if key in node and is_js(node[key]):
                entries.append(f"{label} {key}")
        auto = node.get("/AA")
        if auto is not None:
            for trigger in sorted(str(key) for key in auto):
                value = auto[pikepdf.Name(trigger)]
                if is_js(value):
                    entries.append(f"{label} /AA {trigger}")

    scan_host(pdf.Root, "catalogue")
    for index, kid in enumerate(pdf.Root["/Pages"]["/Kids"]):
        label = f"page {index + 1}"
        scan_host(kid, label)
        for annot in kid.get("/Annots") or []:
            scan_host(annot, f"{label} annot")

    form = pdf.Root.get("/AcroForm")
    if form is not None:

        def walk_field(node, depth: int) -> None:
            scan_host(node, f"field {node.get('/T')!s}")
            for child in node.get("/Kids") or []:
                if depth < 4:
                    walk_field(child, depth + 1)

        for field in form.get("/Fields") or []:
            walk_field(field, 0)

    javascript_tree = (pdf.Root.get("/Names") or {}).get("/JavaScript")
    names: list = []

    def collect(node) -> None:
        if node is None:
            return
        names.extend(node.get("/Names") or [])
        for child in node.get("/Kids") or []:
            collect(child)

    collect(javascript_tree)
    for at in range(1, len(names), 2):
        if is_js(names[at]):
            entries.append(f"javascript name tree entry {names[at - 1]!s}")
    pdf.close()
    return {"entries": sorted(entries), "count": len(entries),
            "xfa": "/XFA" in (pdf.Root.get("/AcroForm") or pikepdf.Dictionary())}


def poppler_javascript(path: str) -> str | None:
    """poppler's own answer to "does this document run script", from `pdfinfo`."""
    info = subprocess.run(["pdfinfo", path], capture_output=True, check=False)
    for line in info.stdout.decode("utf-8", "replace").splitlines():
        if line.lower().startswith("javascript"):
            return line.split(":", 1)[1].strip()
    return None


# --- signatures -------------------------------------------------------------

SIGNATURES: dict[str, dict[str, Any]] = {}


def build_signature(name: str, *, mode: str, fields: int = 1, algorithm: str = "sha256",
                    perms: bool = False) -> dict:
    """A document carrying an unsigned-but-fully-shaped `/Sig` field, by libqpdf.

    The `/ByteRange` is written as four zeros and the `/Contents` as `CONTENT_PAD`
    hex zeros; `sign_fixture()` fills both **after** the determinism freeze, because
    the offsets they name are properties of the bytes that survive that rewrite.
    Padding the numbers to a fixed width is what lets that patch preserve the file
    length — see the module comment on `scripts/pdf_fixture_pkcs7.py`.
    """
    import pikepdf

    doc = doc_new()
    page = write(doc, name)
    pdf = pikepdf.open(page, allow_overwriting_input=True)
    field_refs = []
    for number in range(fields):
        value = pdf.make_indirect(pikepdf.Object.parse(
            f"<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached"
            f" /Name (Foreign Signer {number + 1}) /Location (Census box)"
            f" /M (D:20240101120000Z) /ByteRange [0 0 0 0]"
            f" /Contents <{'0' * CONTENT_PAD}> >>".encode()))
        field = pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name("/Annot"), Subtype=pikepdf.Name("/Widget"),
            FT=pikepdf.Name("/Sig"), T=pikepdf.String(f"Signature{number + 1}"),
            Rect=pikepdf.Array([pikepdf.Integer(60), pikepdf.Integer(400 + 90 * number),
                                pikepdf.Integer(240), pikepdf.Integer(460 + 90 * number)]),
            P=pdf.Root["/Pages"]["/Kids"][0]))
        field["/V"] = value
        field_refs.append(field)
    form = pdf.make_indirect(pikepdf.Dictionary(
        Fields=pikepdf.Array(field_refs), NeedAppearances=True))
    pdf.Root["/AcroForm"] = form
    if perms:
        pdf.Root["/Perms"] = pikepdf.Dictionary(
            DocMDP=pdf.make_indirect(pikepdf.Dictionary(
                Type=pikepdf.Name("/Sig"), Reference=pikepdf.Array([field_refs[0]]),
                TransformParams=pikepdf.Dictionary(
                    DocMDPParams=pikepdf.Dictionary(P=pikepdf.Integer(1))))))
    pdf.save(page)
    pdf.close()
    SIGNATURES[name] = {"mode": mode, "algorithm": algorithm, "perms": perms}
    if mode == "tampered":
        SIGNATURES[name]["tamper"] = True
    return {"fields": fields, "mode": mode}


def need(match, describe: str):
    """A regex hit the caller cannot do without, narrowed for the type checker."""
    if match is None:
        raise SystemExit(describe)
    return match


def sign_fixture(name: str) -> dict:
    """Patch every `/Sig` placeholder in the file into a real signature.

    Runs **after** the determinism freeze, because `/ByteRange` names offsets in the
    bytes that survive that rewrite. The two length-changing normalisations happen
    first (the `/Contents` layout, then the padded `/ByteRange` fields); from then on
    every write lands in a field of the same width, which is what keeps a digest
    computed over the two spans describing the finished file.

    With two fields the earlier one is signed over its own prefix only — the bytes up
    to its own `/Contents` gap, which nothing later touches — and the later one over
    the whole file. That is what an incremental second signature looks like from the
    outside: the first signer's ranges were frozen when it signed, the second covers
    the first.
    """
    from cryptography.hazmat.primitives.serialization import load_pem_private_key
    from cryptography.x509 import load_pem_x509_certificate
    from pdf_fixture_pkcs7 import signed_data

    settings = SIGNATURES[name]
    path = os.path.join(TARGET, name)
    with open(path, "rb") as handle:
        raw = bytearray(handle.read())

    def gaps(source: bytes):
        return list(re.finditer(rb"/Contents\s*<([0-9A-Fa-f\s]+)>", source))

    def spans(source: bytes):
        return list(re.finditer(rb"/ByteRange\s*\[([^\]]*)\]", source))

    def padded(values: list[int]) -> bytes:
        return b" ".join(f"{value:0{RANGE_PAD}d}".encode() for value in values)

    wrapped = settings["mode"] == "contents-wrapped"

    # 1. `/Contents` layout: one line, or wrapped at 96 characters the way Acrobat and
    #    MuPDF write a long hex string. Both spellings are legal PDF, and which one a
    #    producer chose is exactly what `readHexString` has to survive.
    for found in reversed(gaps(bytes(raw))):
        digits = re.sub(rb"\s", b"", found.group(1)).decode()
        layout = ("\n".join(digits[index:index + 96]
                            for index in range(0, len(digits), 96)) if wrapped else digits)
        raw = bytearray(raw[:found.start(1)] + layout.encode() + raw[found.end(1):])

    # 2. widen each `/ByteRange` number to a fixed field so step 3 cannot move bytes.
    for span in reversed(spans(bytes(raw))):
        values = [int(text) for text in span.group(1).split()]
        if len(values) != 4:
            raise SystemExit(f"/ByteRange in {name} does not hold four numbers")
        raw = bytearray(raw[:span.start(1)] + padded(values) + raw[span.end(1):])

    capacity = [len(re.sub(rb"\s", b"", found.group(1))) for found in gaps(bytes(raw))]
    with open(SIGNER_CERT, "rb") as handle:
        certificate = load_pem_x509_certificate(handle.read())
    with open(SIGNER_KEY, "rb") as handle:
        private_key = load_pem_private_key(handle.read(), password=None)

    recorded: list[dict[str, Any]] = []
    for position in range(len(capacity)):
        # 3. the gap's offsets in the finished layout, then the numbers, then the bytes.
        gap = gaps(bytes(raw))[position]
        gap_start, gap_end = gap.start(1), gap.end(1)
        final = position == len(capacity) - 1
        values = [0, gap_start, gap_end, len(raw) - gap_end if final else 0]
        span = spans(bytes(raw))[position]
        raw = bytearray(raw[:span.start(1)] + padded(values) + raw[span.end(1):])
        again = gaps(bytes(raw))[position]
        if (again.start(1), again.end(1)) != (gap_start, gap_end):
            raise SystemExit(f"writing /ByteRange moved the /Contents gap in {name}")

        covered = bytes(raw[:gap_start]) + bytes(raw[gap_end:gap_end + values[3]])
        der = signed_data(covered, certificate, private_key, algorithm=settings["algorithm"])
        body = der.hex().upper().ljust(capacity[position], "0")
        if len(body) != capacity[position]:
            raise SystemExit(
                f"the signature does not fit its {capacity[position]}-character placeholder in {name}")
        # Lay the signature into the placeholder without moving a byte of it: the
        # producer's whitespace stays, each digit slot takes one hex character, and the
        # spare room is zero padding — which is what a real signer leaves behind too.
        region = bytes(raw[gap_start:gap_end])
        cursor = 0
        filled: list[int] = []
        for character in region:
            if chr(character).isspace():
                filled.append(character)
                continue
            filled.append(ord(body[cursor]))
            cursor += 1
        if len(filled) != len(region):
            raise SystemExit(f"filling /Contents changed its width in {name}")
        raw = bytearray(raw[:gap_start] + bytes(filled) + raw[gap_end:])
        recorded.append({"byteRange": values, "derBytes": len(der),
                         "contentsHexChars": capacity[position],
                         "coversWholeFile": final})

    if settings.get("tamper"):
        # One character of the field name, one byte, changed after the fact: the file
        # still parses and the digest must not match. This is the control that says
        # `digestMatches` is a computation and not a constant.
        at = raw.find(b"(Signature1)")
        if at < 0:
            raise SystemExit(f"no field name to tamper with in {name}")
        raw[at + len(b"(Signature")] = ord("7")
    with open(path, "wb") as handle:
        handle.write(bytes(raw))
    return {"signatures": recorded}


def signature_facts(path: str) -> dict:
    """Read the `/Sig` dictionaries back and let **OpenSSL** judge the blob.

    The embedded `/Contents` string is decoded by libqpdf, the two spans are cut out of
    the file with the `/ByteRange` numbers as libqpdf parses them, and `openssl cms
    -verify` then checks the certificate's signature over those bytes and the message
    digest the CMS carries inside. That is an outside implementation confirming each
    fixture before this repo's reader is asked about it; where OpenSSL says the digest
    does not match — as it must for `sig-tampered.pdf` — the census records that too,
    rather than calling a broken file clean.
    """
    import pikepdf

    pdf = pikepdf.open(path)
    form = pdf.Root.get("/AcroForm")
    out: dict[str, Any] = {"fields": [], "perms": "/Perms" in pdf.Root,
                           "certificate": openssl_certificate()}
    if form is None:
        pdf.close()
        return out
    with open(path, "rb") as handle:
        raw = handle.read()
    # The `/Contents` hex as it sits in the file, in object order: the layout (one line
    # or wrapped) is as much a fact about the fixture as the bytes are.
    on_disk = list(re.finditer(rb"/Contents\s*<([0-9A-Fa-f\s]+)>", raw))
    byte_ranges = list(re.finditer(rb"/ByteRange\s*\[([^\]]*)\]", raw))
    for number, field in enumerate(form.get("/Fields") or []):
        value = field.get("/V")
        if value is None or "/ByteRange" not in value:
            continue
        ranges = [int(item) for item in value["/ByteRange"]]
        covered = raw[ranges[0]:ranges[0] + ranges[1]] + raw[ranges[2]:ranges[2] + ranges[3]]
        der = bytes(value["/Contents"]).rstrip(b"\x00")
        with tempfile.TemporaryDirectory() as work:
            blob = os.path.join(work, "sig.der")
            content = os.path.join(work, "covered.bin")
            with open(blob, "wb") as handle:
                handle.write(der)
            with open(content, "wb") as handle:
                handle.write(covered)
            checked = subprocess.run(
                ["openssl", "cms", "-verify", "-binary", "-inform", "DER", "-in", blob,
                 "-content", content, "-CAfile", SIGNER_CERT, "-no_check_time",
                 "-out", os.devnull],
                capture_output=True, check=False)
            printed = subprocess.run(["openssl", "asn1parse", "-inform", "DER", "-in", blob],
                                     capture_output=True, check=False)
        digest_label = next((line.split()[-1] for line in
                             printed.stdout.decode("utf-8", "replace").splitlines()
                             if "RSAEncryption" in line),
                            None)
        span = on_disk[number].group(1) if number < len(on_disk) else b""
        out["fields"].append({
            "name": str(field.get("/T")),
            "subFilter": str(value.get("/SubFilter")),
            "byteRange": ranges,
            "byteRangeSpelled": byte_ranges[number].group(1).decode().split()
            if number < len(byte_ranges) else [],
            "fileLength": len(raw),
            "spansAddUp": ranges[0] == 0 and ranges[0] + ranges[1] <= ranges[2]
            and ranges[2] + ranges[3] <= len(raw),
            "opensslVerifies": checked.returncode == 0,
            "opensslError": checked.stderr.decode("utf-8", "replace").strip()[:200] or None,
            "opensslSignatureAlgorithm": digest_label,
            "derBytes": len(der),
            "contentsHexChars": len(re.sub(rb"\s", b"", span)),
            "contentsWrapped": b"\n" in span,
            "valueIsIndirect": bool(value.is_indirect),
        })
    pdf.close()
    return out


def openssl_certificate() -> dict:
    """What OpenSSL says the committed signing certificate holds.

    `readSignatures` answers a signer name, an issuer, a validity window and a digest
    algorithm out of the PKCS#7; those are the columns the census can be compared with.
    """
    shown = subprocess.run(["openssl", "x509", "-in", SIGNER_CERT, "-noout",
                            "-subject", "-issuer", "-serial", "-startdate", "-enddate"],
                           capture_output=True, check=False)
    lines = shown.stdout.decode("utf-8", "replace").splitlines()

    def field(prefix: str) -> str | None:
        for line in lines:
            if line.startswith(prefix):
                return line.split("=", 1)[1].strip()
        return None

    return {"subject": field("subject"), "issuer": field("issuer"), "serial": field("serial"),
            "notBefore": field("notBefore"), "notAfter": field("notAfter")}


def poppler_info(path: str) -> dict:
    """poppler's own `pdfinfo` answer: does it open the file, and does it see script.

    `JavaScript: yes` is poppler's conclusion after walking `/OpenAction`, `/AA`,
    the catalogue's `/JavaScript` and the `/Names » /JavaScript` tree **with its own
    code**, so it is the outside witness for the script row: a file it calls scripted
    runs something, whatever this app's inventory says about it.
    """
    info = subprocess.run(["pdfinfo", path], capture_output=True, check=False)
    text = info.stdout.decode("utf-8", "replace")
    javascript = next((line.split(":", 1)[1].strip()
                       for line in text.splitlines()
                       if line.lower().startswith("javascript")), None)
    return {"opens": info.returncode == 0, "javascript": javascript}


def verify(name: str) -> dict:
    """Two outside readers over the kept file; a shape nobody can see proves nothing."""
    path = os.path.join(TARGET, name)
    doc = pymupdf.open(path)
    seen = {
        "pages": doc.page_count,
        "toc": len(doc.get_toc()),
        "labels": doc.get_page_labels(),
        "ocgs": sorted(doc.get_ocgs()),
        # `get_ocgs()` is keyed by xref, so the names come from its values: this is the
        # column `listLayers` is compared against, and an xref list proves nothing about
        # the words a user reads.
        "ocg_names": sorted(
            str((details or {}).get("name", "")) for details in doc.get_ocgs().values()),
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
    info = poppler_info(path)
    seen["poppler_opens"] = info["opens"]
    seen["poppler_javascript"] = info["javascript"]
    if name.startswith("resources-"):
        seen["qpdf_inventory"] = resource_inventory(path)
        seen["mupdf_resources"] = mupdf_resources(path)
    if name.startswith("script-"):
        seen["qpdf_script_sites"] = script_sites(path)
    if name in SIGNATURES or name.startswith("sig-"):
        seen["signatures"] = signature_facts(path)
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
        "resources-plain.pdf": lambda: build_resources("plain"),
        "resources-inherited.pdf": lambda: build_resources("inherited"),
        "resources-xobject.pdf": lambda: build_resources("xobject"),
        "resources-shared.pdf": lambda: build_resources("shared"),
        "resources-subset.pdf": lambda: build_resources("subset"),
        "script-openaction-inline.pdf": lambda: build_scripts("openaction-inline"),
        "script-openaction-ref.pdf": lambda: build_scripts("openaction-ref"),
        "script-openaction-array.pdf": lambda: build_scripts("openaction-array"),
        "script-js-key-only.pdf": lambda: build_scripts("js-key-only"),
        "script-names-flat.pdf": lambda: build_scripts("names-flat"),
        "script-names-kids.pdf": lambda: build_scripts("names-kids"),
        "script-hosts-aa.pdf": lambda: build_scripts("hosts-aa"),
        "script-xfa.pdf": lambda: build_scripts("xfa"),
        "sig-detached.pdf": lambda: build_signature("sig-detached.pdf", mode="plain"),
        "sig-contents-wrapped.pdf": lambda: build_signature("sig-contents-wrapped.pdf",
                                                            mode="contents-wrapped"),
        "sig-two-fields.pdf": lambda: build_signature("sig-two-fields.pdf", mode="plain",
                                                     fields=2),
        "sig-perms.pdf": lambda: build_signature("sig-perms.pdf", mode="plain", perms=True),
        "sig-tampered.pdf": lambda: build_signature("sig-tampered.pdf", mode="tampered"),
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
        "resources-plain.pdf": ("fonts and images named from each page's own /Resources — the control",
                                "MuPDF 1.28.2 (PyMuPDF: helv + embedded TrueType subset + CFF/OTF + raw and DCT images)"),
        "resources-inherited.pdf": ("/Resources on the /Pages node, none on the page (§7.7.3.3 inherited attributes)",
                                    "MuPDF 1.28.2 (pages) + libqpdf 12.3.2 (resource move)"),
        "resources-xobject.pdf": ("the page draws one Form XObject that carries every font and image itself",
                                  "MuPDF 1.28.2 (pages) + libqpdf 12.3.2 (Form XObject wrap)"),
        "resources-shared.pdf": ("three pages naming the *same* /Resources object — the deduplication case",
                                 "MuPDF 1.28.2 (pages) + libqpdf 12.3.2 (shared resource dict)"),
        "resources-subset.pdf": ("the two embedded faces renamed with a BCDFEE+/ABCDEA+ subsetting tag",
                                 "MuPDF 1.28.2 (pages, embedded faces) + libqpdf 12.3.2 (subset tags)"),
        "script-openaction-inline.pdf": ("catalogue /OpenAction with the JavaScript action inline",
                                         "MuPDF 1.28.2 (pages) + libqpdf 12.3.2 (/OpenAction)"),
        "script-openaction-ref.pdf": ("catalogue /OpenAction naming one action behind a reference",
                                      "MuPDF 1.28.2 (pages) + libqpdf 12.3.2 (/OpenAction)"),
        "script-openaction-array.pdf": ("/OpenAction naming two actions in one array entry",
                                        "MuPDF 1.28.2 (pages) + libqpdf 12.3.2 (/OpenAction array)"),
        "script-js-key-only.pdf": ("an action with /JS and no /S at all",
                                   "MuPDF 1.28.2 (pages) + libqpdf 12.3.2 (/OpenAction)"),
        "script-names-flat.pdf": ("/Names » /JavaScript as a flat /Names array, one value inline and one referenced",
                                  "MuPDF 1.28.2 (pages) + libqpdf 12.3.2 (name tree)"),
        "script-names-kids.pdf": ("the same named scripts inside a /Kids + /Limits subtree",
                                  "MuPDF 1.28.2 (pages) + libqpdf 12.3.2 (/Kids name tree)"),
        "script-hosts-aa.pdf": ("page /AA /O, annotation /AA /E, field /AA /K, field /A, and a field with neither",
                                "MuPDF 1.28.2 (pages, annot) + libqpdf 12.3.2 (/AA, /AcroForm)"),
        "script-xfa.pdf": ("an /AcroForm /XFA packet whose JavaScript lives in its own XML",
                           "MuPDF 1.28.2 (pages) + libqpdf 12.3.2 (/XFA packet)"),
        "sig-detached.pdf": ("a /Sig field whose /V carries adbe.pkcs7.detached over the two /ByteRange spans",
                             "MuPDF 1.28.2 (pages) + libqpdf 12.3.2 (/Sig) + OpenSSL 3.6.5 (key, certificate) "
                             "+ scripts/pdf_fixture_pkcs7.py (PKCS#7), verified by openssl cms"),
        "sig-contents-wrapped.pdf": ("the same /Contents hex string wrapped across lines, as Acrobat writes it",
                                     "MuPDF 1.28.2 (pages) + libqpdf 12.3.2 (/Sig) + OpenSSL 3.6.5 (key, certificate) "
                                     "+ scripts/pdf_fixture_pkcs7.py (PKCS#7)"),
        "sig-two-fields.pdf": ("two /Sig fields, the second naming a /ByteRange over the whole file",
                               "MuPDF 1.28.2 (pages) + libqpdf 12.3.2 (/Sig x2) + OpenSSL 3.6.5 (key, certificate) "
                               "+ scripts/pdf_fixture_pkcs7.py (PKCS#7)"),
        "sig-perms.pdf": ("a signed document that also declares /Perms /DocMDP",
                          "MuPDF 1.28.2 (pages) + libqpdf 12.3.2 (/Sig, /Perms) + OpenSSL 3.6.5 (key, certificate) "
                          "+ scripts/pdf_fixture_pkcs7.py (PKCS#7)"),
        "sig-tampered.pdf": ("the control file with one byte of the field name changed after signing",
                             "MuPDF 1.28.2 (pages) + libqpdf 12.3.2 (/Sig) + OpenSSL 3.6.5 (key, certificate) "
                             "+ scripts/pdf_fixture_pkcs7.py (PKCS#7), one byte patched afterwards)"),
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
    manifest = freeze_all(TARGET, SHAPES, {n: {k: sha(v) for k, v in p.items()}
                                           for n, p in EXPECTED.items()},
                          "the three-page base, written by MuPDF",
                          "MuPDF 1.28.2 (PyMuPDF)")
    # The signature fixtures are the one family whose final bytes are written *after*
    # the freeze: `/ByteRange` names offsets in the frozen file, and the patch that
    # fills it preserves the length. Re-hash those entries so `MANIFEST.json` records
    # what is actually kept.
    for name in sorted(SIGNATURES):
        report[name]["signed"] = sign_fixture(name)
        manifest[name]["sha256"] = sha(file_bytes(os.path.join(TARGET, name)))
    write_manifest(TARGET, manifest)
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
