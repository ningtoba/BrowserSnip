#!/usr/bin/env python3
"""Build `tests/fixtures/readers/`: one file per shape `readPageLabels` / `readOutline` allow.

The attachments pass (`docs/research/attachments-foreign-repro.md`) established the
method: fixtures written **outside** this repo, an outside-reader census of every
shape, and a per-shape table instead of one reproduced bug. This is the same rig for
the two readers `docs/research/foreign-structure-audit.md` left unfixed:

* `readPageLabels` reads `/Nums` off the root only, so a `/Kids` **number tree** comes
  back `["1","2","3"]` for a file MuPDF labels `i-1, I, c`;
* `readOutline` resolves a named destination only when the array is inline in a flat
  `/Names`, so a value behind a reference, a destination *dictionary*, a `/Kids`
  **name tree** and the PDF 1.4 `/Names → /Dests` location all give `page: null`.

Every file is written by MuPDF 1.28.2 (PyMuPDF), libqpdf 12.3.2 (pikepdf 10.9.1) or
pypdf 6.14.2 — never by pdf-lib — and is censused by MuPDF and pypdf afterwards, which
are the two readers on this box that implement page labels and outlines at all.
**There is no `qpdf` and no `mutool` binary here**, and poppler's `pdfinfo` prints
neither page labels nor bookmarks, so poppler is a parse-witness (it has to open the
file) rather than a third opinion.

    python3 scripts/readers-foreign-fixtures.py [outdir]
    python3 scripts/readers-foreign-fixtures.py --check     # determinism, twice

The per-page label strings and the (title, page) outline pairs recorded in
`census.json` are what `tests/pdf/readers-foreign.test.ts` compares this app against.
"""
import json
import os
import subprocess
import sys
from typing import Any

import pikepdf
import pymupdf
import pypdf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pdf_fixture_determinism import (  # noqa: E402
    check_reproducible,
    freeze_all,
    write_manifest,
)

# The keys each named-destination fixture files its three destinations under.
OUTLINE_KEYS = ("alpha", "beta", "gamma")

TARGET = os.path.abspath(
    sys.argv[1] if len(sys.argv) > 1 else "tests/fixtures/readers"  # noqa: S108
)
os.makedirs(TARGET, exist_ok=True)

PLANTED = "Lighthouse Inventory 1887"
SHEETS = ("ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO", "FOXTROT")


# ---------------------------------------------------------------------------
# The base document every fixture is built on
# ---------------------------------------------------------------------------

def base(pages: int = 4) -> pymupdf.Document:
    doc = pymupdf.open()
    for index in range(pages):
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


def reopen(name: str) -> Any:
    return pikepdf.open(os.path.join(TARGET, name), allow_overwriting_input=True)


def save(pdf: Any, name: str) -> None:
    pdf.save(os.path.join(TARGET, name))
    pdf.close()


# ---------------------------------------------------------------------------
# Page labels
# ---------------------------------------------------------------------------

def label_dict(pdf: Any, style: str | None, start: int | None, prefix: str | None,
               indirect: bool) -> Any:
    """One page-label range dictionary.

    `/S`, `/St` and `/P` are each optional (ISO 32000-1 §12.4.2 Table 160), so a shape
    that omits one is a different shape and is written as one here.
    """
    d = pikepdf.Dictionary()
    if style is not None:
        d["/S"] = pikepdf.Name("/" + style)
    if prefix is not None:
        d["/P"] = pikepdf.String(prefix)
    if start is not None:
        d["/St"] = pikepdf.Integer(start)
    return pdf.make_indirect(d) if indirect else d


def set_labels_flat(pdf: Any, ranges: list[tuple[int, dict]], indirect: bool) -> None:
    """`/PageLabels` as a flat `/Nums` array — the shape pdf-lib and MuPDF write."""
    nums = pikepdf.Array()
    for page, spec in ranges:
        nums.append(pikepdf.Integer(page))
        nums.append(label_dict(pdf, spec.get("style"), spec.get("start"),
                               spec.get("prefix"), indirect))
    pdf.Root["/PageLabels"] = pikepdf.Dictionary(Nums=nums)


def set_labels_kids(pdf: Any, sections: list[Any]) -> None:
    """`/PageLabels` as a `/Kids` + `/Limits` **number tree**.

    Each section is one leaf holding `/Limits [first last]` and its own `/Nums`; a
    section given as a list of two sections becomes a `/Kids` node, which is how a
    producer splits a long label set — and what makes this a tree rather than an array.
    """
    def leaf(entries: list[Any]) -> Any:
        nums = pikepdf.Array()
        for page, spec in entries:
            nums.append(pikepdf.Integer(page))
            nums.append(label_dict(pdf, spec.get("style"), spec.get("start"),
                                   spec.get("prefix"), True))
        return pdf.make_indirect(pikepdf.Dictionary(
            Limits=pikepdf.Array([pikepdf.Integer(entries[0][0]),
                                  pikepdf.Integer(entries[-1][0])]),
            Nums=nums,
        ))

    kids = pikepdf.Array()
    for section in sections:
        if section and isinstance(section[0], list):
            inner = pikepdf.Array()
            for group in section:  # type: ignore[assignment]
                inner.append(leaf(group))  # type: ignore[arg-type]
            first = section[0][0][0]  # type: ignore[index]
            last = section[-1][-1][0]  # type: ignore[index]
            kids.append(pdf.make_indirect(pikepdf.Dictionary(
                Limits=pikepdf.Array([pikepdf.Integer(first), pikepdf.Integer(last)]),
                Kids=inner,
            )))
        else:
            kids.append(leaf(section))  # type: ignore[arg-type]
    pdf.Root["/PageLabels"] = pikepdf.Dictionary(Kids=kids)


MIXED = [
    (0, {"style": "r"}),
    (2, {"style": "D", "start": 1}),
    (4, {"style": "A", "start": 1, "prefix": "Ex "}),
]


def build_labels(name: str, shape: str, producer: str, pages: int, build) -> None:
    write(base(pages), name)
    pdf = reopen(name)
    build(pdf)
    save(pdf, name)
    SHAPES[name] = {"shape": shape, "producer": producer}


# ---------------------------------------------------------------------------
# Outlines
# ---------------------------------------------------------------------------

def outline_dicts(pdf: Any) -> list[Any]:
    """Every outline item dictionary in reading order, flattened."""
    found: list[Any] = []

    def walk(items: list[Any]) -> None:
        for item in items:
            # pikepdf 10.9.1 exposes the item dictionary as `.obj`; `.children` is the
            # parsed subtree, so the walk sees every item in reading order.
            found.append(item.obj)
            walk(item.children)

    with pdf.open_outline() as outline:
        walk(outline.root)
    return found


def install_dests(pdf: Any, where: str, value_form: str) -> None:
    """Write a destination store and return the destinations it holds.

    `where` is the two spellings the format allows for the same lookup:

        catalog-flat  `/Dests << /Names [ … ] >>`               (PDF 1.1)
        catalog-kids  `/Dests << /Kids [ << /Limits /Names >> ] >>`
        names-flat    `/Names << /Dests << /Names [ … ] >> >>`   (PDF 1.4)
        names-kids    `/Names << /Dests << /Kids [ … ] >> >>`
        absent        nothing at all — the negative control

    `value_form` is the second axis: the value of a pair may be the destination
    **array** inline, that array behind a **reference**, or a destination
    **dictionary** behind a reference (the spelling pypdf's `add_named_destination`
    writes, §12.3.2.2 "either a destination array or a destination dictionary").
    """
    names = OUTLINE_KEYS
    destinations = []
    for page_ref in [pdf.Root["/Pages"]["/Kids"][index] for index in range(len(names))]:
        array = pikepdf.Array([page_ref, pikepdf.Name("/Fit")])
        if value_form == "dict-ref":
            # §12.3.2.2: a named destination may be an array **or** a destination
            # dictionary; pypdf's `add_named_destination` writes the dictionary.
            value = pdf.make_indirect(pikepdf.Dictionary(S=pikepdf.Name("/GoTo"), D=array))
        elif value_form == "array-ref":
            value = pdf.make_indirect(array)
        elif value_form == "array-inline":
            value = array
        else:
            raise ValueError(f"unknown destination form {value_form!r}")
        destinations.append(value)

    if where == "absent":
        return
    pairs = pikepdf.Array()
    for key, value in zip(names, destinations, strict=True):
        pairs.append(pikepdf.String(key))
        pairs.append(value)
    flat = pdf.make_indirect(pikepdf.Dictionary(Names=pairs))
    tree = (pikepdf.Dictionary(Kids=pikepdf.Array([flat])) if "kids" in where
            else pikepdf.Dictionary(Names=pairs))
    if where.startswith("names"):
        pdf.Root["/Names"] = pdf.make_indirect(pikepdf.Dictionary(Dests=tree))
    else:
        pdf.Root["/Dests"] = tree


def rewrite_items(pdf: Any, form: str, names: tuple[str, ...] = OUTLINE_KEYS) -> None:
    """Point every outline item at its destination in `form` — one spelling per file.

    The base outline is always built the same way, so the only thing that varies
    between two `outlines-*.pdf` files is how the item names where it goes.
    """
    if form == "keep":
        return
    items = outline_dicts(pdf)
    for index, item in enumerate(items):
        key = names[index % len(names)]
        for drop in ("/Dest", "/A", "/Destination"):
            if drop in item:
                del item[drop]
        if form == "dest-inline-array":
            item["/Dest"] = pikepdf.Array([pdf.Root["/Pages"]["/Kids"][index],
                                           pikepdf.Name("/Fit")])
        elif form == "dest-string":
            item["/Dest"] = pikepdf.String(key)
        elif form == "dest-name":
            item["/Dest"] = pikepdf.Name("/" + key)
        elif form == "action-name":
            item["/A"] = pikepdf.Dictionary(S=pikepdf.Name("/GoTo"),
                                            D=pikepdf.Name("/" + key))
        elif form == "action-string":
            item["/A"] = pikepdf.Dictionary(S=pikepdf.Name("/GoTo"),
                                            D=pikepdf.String(key))
        elif form == "action-array":
            item["/A"] = pikepdf.Dictionary(S=pikepdf.Name("/GoTo"),
                                            D=pikepdf.Array([pdf.Root["/Pages"]["/Kids"][index],
                                                             pikepdf.Name("/Fit")]))
        elif form == "action-uri":
            item["/A"] = pikepdf.Dictionary(S=pikepdf.Name("/URI"),
                                            URI=pikepdf.String("https://example.invalid"))
        elif form == "se-only":
            item["/SE"] = pdf.make_indirect(pikepdf.Dictionary(Pg=pdf.Root["/Pages"]["/Kids"][0]))
        elif form == "dest-and-action":
            item["/Dest"] = pikepdf.Array([pdf.Root["/Pages"]["/Kids"][0],
                                           pikepdf.Name("/Fit")])
            item["/A"] = pikepdf.Dictionary(S=pikepdf.Name("/GoTo"),
                                            D=pikepdf.String(key))
        else:
            raise ValueError(f"unknown item form {form!r}")


def base_outline(name: str, nested: bool = True,
                 titles: tuple[str, ...] = ("Chapter One", "Section One.A", "Chapter Two"),
                 info: bool = False) -> str:
    """A MuPDF-written two-level outline, so the wiring is a producer's, not ours.

    `info` decides whether the file carries a `/Info` dictionary. MuPDF writes none
    unless metadata is set, which is the shape most of these fixtures keep — and the
    shape `core/metadata.ts:infoDict` throws on.
    """
    doc = base(4)
    if info:
        doc.set_metadata({
            "title": "Reader fixtures",
            "author": "PyMuPDF 1.28.2",
            "producer": "scripts/readers-foreign-fixtures.py",
        })
    toc = [[index + 1 if nested and index == 1 else 1, title, page]
           for index, (title, page) in enumerate(zip(titles, (1, 2, 3), strict=True))]
    doc.set_toc(toc if nested else [[1, title, index + 1]
                                    for index, title in enumerate(titles[:2])])
    return write(doc, name)


def build_outline(name: str, shape: str, producer: str, where: str, value_form: str,
                  item_form: str, nested: bool = True,
                  titles: tuple[str, ...] = ("Chapter One", "Section One.A", "Chapter Two"),
                  info: bool = False) -> None:
    base_outline(name, nested, titles, info)
    pdf = reopen(name)
    install_dests(pdf, where, value_form)
    rewrite_items(pdf, item_form)
    save(pdf, name)
    SHAPES[name] = {"shape": shape, "producer": producer}


SHAPES: dict[str, dict[str, str]] = {}


def main() -> None:  # noqa: C901, PLR0915
    # ---- page labels -------------------------------------------------------
    build_labels(
        "labels-absent.pdf", "no /PageLabels at all — the negative control",
        "MuPDF 1.28.2 (PyMuPDF)", 4, lambda pdf: None)
    build_labels(
        "labels-nums-d.pdf", "flat /Nums, /S /D with /St 1 — a genuinely arabic file",
        "libqpdf 12.3.2 (pikepdf)", 4,
        lambda pdf: set_labels_flat(pdf, [(0, {"style": "D", "start": 1})], True))
    build_labels(
        "labels-nums-r.pdf", "flat /Nums, /S /r (lowercase roman)",
        "libqpdf 12.3.2 (pikepdf)", 4,
        lambda pdf: set_labels_flat(pdf, [(0, {"style": "r"})], True))
    build_labels(
        "labels-nums-R-st4.pdf", "flat /Nums, /S /R with /St 4 (uppercase roman, offset start)",
        "libqpdf 12.3.2 (pikepdf)", 4,
        lambda pdf: set_labels_flat(pdf, [(0, {"style": "R", "start": 4})], True))
    build_labels(
        "labels-nums-a.pdf", "flat /Nums, /S /a (lowercase alphabetic)",
        "libqpdf 12.3.2 (pikepdf)", 4,
        lambda pdf: set_labels_flat(pdf, [(0, {"style": "a"})], True))
    build_labels(
        "labels-nums-A-st2.pdf", "flat /Nums, /S /A with /St 2 (uppercase alphabetic, offset start)",
        "libqpdf 12.3.2 (pikepdf)", 4,
        lambda pdf: set_labels_flat(pdf, [(0, {"style": "A", "start": 2})], True))
    build_labels(
        "labels-nums-prefix.pdf", "flat /Nums with /P prefixes on a decimal and a roman range",
        "libqpdf 12.3.2 (pikepdf)", 4,
        lambda pdf: set_labels_flat(pdf, [(0, {"style": "D", "start": 1, "prefix": "i-"}),
                                          (2, {"style": "r", "prefix": "§"})], True))
    build_labels(
        "labels-nums-mixed.pdf", "flat /Nums, a mixed sequence across three sections (/r, /D, /A + /P)",
        "libqpdf 12.3.2 (pikepdf)", 6,
        lambda pdf: set_labels_flat(pdf, MIXED, True))
    build_labels(
        "labels-nums-inline-dicts.pdf", "flat /Nums whose range dictionaries are inline, not referenced",
        "libqpdf 12.3.2 (pikepdf)", 6,
        lambda pdf: set_labels_flat(pdf, MIXED, False))
    doc = base(4)
    write(doc, "labels-nums-empty-dict.pdf")
    pdf = reopen("labels-nums-empty-dict.pdf")
    pdf.Root["/PageLabels"] = pikepdf.Dictionary(
        Nums=pikepdf.Array([pikepdf.Integer(0), pdf.make_indirect(pikepdf.Dictionary())]))
    save(pdf, "labels-nums-empty-dict.pdf")
    SHAPES["labels-nums-empty-dict.pdf"] = {
        "shape": "a flat /Nums whose range dictionary is empty — no /S, no /P, no /St",
        "producer": "libqpdf 12.3.2 (pikepdf)",
    }
    build_labels(
        "labels-nums-prefix-only.pdf", "a range with /P and no /S — a prefix-only label",
        "libqpdf 12.3.2 (pikepdf)", 4,
        lambda pdf: set_labels_flat(pdf, [(0, {"prefix": "Cover "}),
                                          (2, {"style": "r", "prefix": "of "})], True))
    build_labels(
        "labels-nums-unknown-style.pdf", "a range whose /S is a style this format does not define (/G)",
        "libqpdf 12.3.2 (pikepdf)", 4,
        lambda pdf: set_labels_flat(pdf, [(0, {"style": "G", "start": 2})], True))
    build_labels(
        "labels-kids-mixed.pdf", "/Kids + /Limits number tree, one style per section",
        "libqpdf 12.3.2 (pikepdf)", 6,
        lambda pdf: set_labels_kids(pdf, [[(0, {"style": "r"}), (2, {"style": "R", "start": 1})],
                                          [(4, {"style": "a", "start": 3}),
                                           (5, {"style": "A", "start": 1, "prefix": "x"})]]))
    build_labels(
        "labels-kids-deep.pdf", "a /Kids tree whose leaves sit under a second /Kids level",
        "libqpdf 12.3.2 (pikepdf)", 6,
        lambda pdf: set_labels_kids(pdf, [[[MIXED[0], MIXED[1]], [MIXED[2]]]]))
    build_labels(
        "labels-kids-prefix.pdf", "a /Kids tree carrying /P prefixes and /St offsets",
        "libqpdf 12.3.2 (pikepdf)", 4,
        lambda pdf: set_labels_kids(pdf, [[(0, {"style": "R", "start": 1, "prefix": "§"})],
                                          [(2, {"style": "D", "start": 21, "prefix": "A-"})]]))
    write(base(4), "labels-native-mupdf.pdf")
    path = os.path.join(TARGET, "labels-native-mupdf.pdf")
    doc = pymupdf.open(path)
    doc.set_page_labels([{"startpage": 0, "prefix": "", "style": "r", "firstpagenum": 1},
                         {"startpage": 2, "prefix": "x-", "style": "D", "firstpagenum": 7}])
    # MuPDF refuses to overwrite its own input non-incrementally, so the label pass
    # goes to a side file which then takes the fixture's place.
    staging = path + ".staging"
    doc.save(staging)
    doc.close()
    os.replace(staging, path)
    SHAPES["labels-native-mupdf.pdf"] = {
        "shape": "the label ranges MuPDF's own set_page_labels writes (flat /Nums, inline dicts) — control",
        "producer": "MuPDF 1.28.2 (PyMuPDF set_page_labels)",
    }

    # ---- outlines ----------------------------------------------------------
    build_outline(
        "outlines-native-mupdf.pdf",
        "MuPDF's own /Outlines: /A /GoTo with the /D array inline, two levels, /XYZ destinations",
        "MuPDF 1.28.2 (PyMuPDF set_toc)", "absent", "array-inline", "keep")
    SHAPES["outlines-native-mupdf.pdf"] = {
        "shape": "MuPDF's own /Outlines: /A /GoTo with the /D array inline, two levels, /XYZ destinations",
        "producer": "MuPDF 1.28.2 (PyMuPDF set_toc)",
    }

    doc = base(4)
    write(doc, "outlines-native-pypdf.pdf")
    reader = pypdf.PdfReader(os.path.join(TARGET, "outlines-native-pypdf.pdf"))
    out = pypdf.PdfWriter()
    out.append(reader)
    parent = out.add_outline_item("Chapter One", 0)
    out.add_outline_item("Section One.A", 1, parent=parent)
    out.add_outline_item("Chapter Two", 2)
    with open(os.path.join(TARGET, "outlines-native-pypdf.pdf"), "wb") as handle:
        out.write(handle)
    SHAPES["outlines-native-pypdf.pdf"] = {
        "shape": "pypdf's own outline: /A /GoTo with an inline /D array, nested through /First",
        "producer": "pypdf 6.14.2 (PdfWriter.add_outline_item)",
    }

    doc = base(4)
    write(doc, "outlines-native-pikepdf.pdf")
    pdf = reopen("outlines-native-pikepdf.pdf")
    with pdf.open_outline() as outline:
        first = pikepdf.OutlineItem("Chapter One", 0)
        first.children.append(pikepdf.OutlineItem("Section One.A", 1))
        outline.root.append(first)
        outline.root.append(pikepdf.OutlineItem("Chapter Two", 2))
    save(pdf, "outlines-native-pikepdf.pdf")
    SHAPES["outlines-native-pikepdf.pdf"] = {
        "shape": "libqpdf's own outline: /Dest as an inline array, nesting through /First and /Parent",
        "producer": "libqpdf 12.3.2 (pikepdf open_outline)",
    }

    build_outline(
        "outlines-flat-chain.pdf",
        "a flat /First → /Next chain of two items with inline /Dest arrays — the control",
        "MuPDF 1.28.2 (set_toc) + libqpdf 12.3.2", "absent", "array-inline",
        "dest-inline-array", nested=False,
        titles=("Chapter One", "Chapter Two", "Chapter Three"))
    build_outline(
        "outlines-dests-inline.pdf",
        "/Dests flat /Names with the destination array inline, item /Dest a string",
        "MuPDF 1.28.2 (set_toc) + libqpdf 12.3.2 (/Dests)", "catalog-flat",
        "array-inline", "dest-string")
    build_outline(
        "outlines-dests-ref.pdf",
        "/Dests flat /Names with each destination behind a reference — the reported failure",
        "MuPDF 1.28.2 (set_toc) + libqpdf 12.3.2 (/Dests)", "catalog-flat",
        "array-ref", "dest-string")
    build_outline(
        "outlines-dests-kids-ref.pdf",
        "/Dests as a /Kids + /Limits tree with referenced destinations",
        "MuPDF 1.28.2 (set_toc) + libqpdf 12.3.2 (/Dests tree)", "catalog-kids",
        "array-ref", "dest-string")
    build_outline(
        "outlines-names-dests-kids-ref.pdf",
        "the PDF 1.4 location: /Names → /Dests as a /Kids tree with referenced destinations",
        "MuPDF 1.28.2 (set_toc) + libqpdf 12.3.2 (/Names)", "names-kids",
        "array-ref", "dest-string")
    build_outline(
        "outlines-names-dests-dict.pdf",
        "/Names → /Dests whose value is a destination DICTIONARY behind a reference (what pypdf's add_named_destination writes)",
        "MuPDF 1.28.2 (set_toc) + libqpdf 12.3.2 (/Names)", "names-flat",
        "dict-ref", "dest-string")
    build_outline(
        "outlines-dest-name.pdf",
        "item /Dest written as a NAME object naming /Dests, values behind references",
        "MuPDF 1.28.2 (set_toc) + libqpdf 12.3.2 (/Dests)", "catalog-flat",
        "array-ref", "dest-name")
    build_outline(
        "outlines-action-name.pdf",
        "item /A /GoTo whose /D is a NAME into a referenced /Dests value",
        "MuPDF 1.28.2 (set_toc) + libqpdf 12.3.2 (/Dests)", "catalog-flat",
        "array-ref", "action-name")
    build_outline(
        "outlines-action-string.pdf",
        "item /A /GoTo whose /D is a STRING into the /Names → /Dests tree",
        "MuPDF 1.28.2 (set_toc) + libqpdf 12.3.2 (/Names)", "names-kids",
        "array-ref", "action-string")
    build_outline(
        "outlines-action-array.pdf",
        "item /A /GoTo with the /D destination array inline (no name tree involved)",
        "MuPDF 1.28.2 (set_toc) + libqpdf 12.3.2", "absent", "array-inline",
        "action-array")
    build_outline(
        "outlines-targetless.pdf",
        "items with no destination at all: a heading, a /URI action, and an /SE-only item",
        "MuPDF 1.28.2 (set_toc) + libqpdf 12.3.2", "absent", "array-inline",
        "action-uri")
    # The heading and the /SE-only entry, spelled per item rather than per file.
    pdf = reopen("outlines-targetless.pdf")
    items = outline_dicts(pdf)
    if len(items) > 1:
        del items[1]["/A"]
        items[1]["/SE"] = pdf.make_indirect(
            pikepdf.Dictionary(Pg=pdf.Root["/Pages"]["/Kids"][0]))
    if len(items) > 2:
        del items[2]["/A"]
    save(pdf, "outlines-targetless.pdf")
    build_outline(
        "outlines-empty.pdf",
        "/Outlines present with /Count 0 and no /First — empty, not null-everywhere",
        "MuPDF 1.28.2 (set_toc) + libqpdf 12.3.2", "absent", "array-inline", "keep")
    pdf = reopen("outlines-empty.pdf")
    root = pdf.Root["/Outlines"]
    for key in ("/First", "/Last", "/Title"):
        if key in root:
            del root[key]
    root["/Count"] = pikepdf.Integer(0)
    save(pdf, "outlines-empty.pdf")
    write(base(4), "outlines-absent.pdf")
    pdf = reopen("outlines-absent.pdf")
    if "/Outlines" in pdf.Root:
        del pdf.Root["/Outlines"]
    save(pdf, "outlines-absent.pdf")
    SHAPES["outlines-absent.pdf"] = {
        "shape": "no /Outlines at all — empty, not null-everywhere",
        "producer": "MuPDF 1.28.2 (PyMuPDF)",
    }
    build_outline(
        "outlines-dest-and-action.pdf",
        "an item carrying /Dest **and** /A on the same entry (which one a reader honours)",
        "MuPDF 1.28.2 (set_toc) + libqpdf 12.3.2 (/Dests)", "catalog-flat",
        "array-ref", "dest-and-action")
    # Titles made of the words planted on the page, so `redact-pdf`'s bookmark scrub
    # has something to rewrite and the round trip can be measured.
    build_outline(
        "outlines-redactable.pdf",
        "the referenced-/Dests failure, titles matching the page's own words, with a /Info dictionary",
        "MuPDF 1.28.2 (set_toc, set_metadata) + libqpdf 12.3.2 (/Dests)", "catalog-flat",
        "array-ref", "dest-string",
        titles=("Lighthouse One", "Inventory Two", "Sheet Three"), info=True)


# ---------------------------------------------------------------------------
# The outside census
# ---------------------------------------------------------------------------

def pypdf_outline(path: str) -> list[Any]:
    reader = pypdf.PdfReader(path)

    def walk(items: list[Any]) -> list[Any]:
        found: list[Any] = []
        for item in items:
            if isinstance(item, list):
                found.extend(walk(item))
                continue
            try:
                page: Any = reader.get_destination_page_number(item)
            except Exception as error:  # noqa: BLE001
                page = f"ERR {type(error).__name__}"
            found.append({"title": getattr(item, "title", None), "page": page})
        return found

    try:
        return walk(reader.outline)
    except Exception as error:  # noqa: BLE001
        return [{"error": f"{type(error).__name__}: {error}"}]


def verify(name: str) -> dict:
    """MuPDF and pypdf over the kept file; poppler only has to open it."""
    path = os.path.join(TARGET, name)
    doc = pymupdf.open(path)
    seen: dict[str, Any] = {
        "pages": doc.page_count,
        "labels": doc.get_page_labels(),
        "toc": doc.get_toc(),
        # The per-page expansion, which is what `readPageLabels` returns: MuPDF
        # answers "" where it has no label for the page.
        "mupdf_page_labels": [page.get_label() for page in doc],
    }
    doc.close()
    reader = pypdf.PdfReader(path)
    seen["pypdf_labels"] = list(reader.page_labels)
    seen["pypdf_outline"] = pypdf_outline(path)
    seen["pypdf_named_dests"] = sorted(reader.named_destinations)
    info = subprocess.run(["pdfinfo", "-enc", "UTF-8", path], capture_output=True, check=False)
    seen["poppler_opens"] = info.returncode == 0
    seen["poppler_pages"] = next((line.split(":", 1)[1].strip()
                                  for line in info.stdout.decode("utf-8", "replace").splitlines()
                                  if line.startswith("Pages:")), None)
    return seen


def main_run() -> None:
    main()
    names = sorted(SHAPES)
    report = {name: {"shape": SHAPES[name]["shape"],
                     "producer": SHAPES[name]["producer"],
                     "outside": verify(name)} for name in names}
    write_manifest(TARGET, freeze_all(TARGET, SHAPES, {},
                                      "a four-page document naming its own sheet",
                                      "MuPDF 1.28.2 (PyMuPDF)"))
    for name in names:
        report[name]["outside_after_freeze"] = verify(name)
    print(json.dumps(report, indent=1, ensure_ascii=False))
    with open(os.path.join(TARGET, "census.json"), "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=1, ensure_ascii=False)
        handle.write("\n")


if __name__ == "__main__":
    if "--check" in sys.argv:
        sys.exit(check_reproducible([sys.executable, os.path.abspath(__file__)], "readers"))
    main_run()
