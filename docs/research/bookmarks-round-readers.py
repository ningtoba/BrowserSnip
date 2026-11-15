#!/usr/bin/env python3
"""Outside readers over the files the `bookmarks` tool produced.

Nothing here imports the app. Every verdict comes from pypdf and MuPDF
(PyMuPDF) over the produced bytes and the fixture they came from, so the table
describes the file a user would download rather than the sentence the card
printed.

Each produced file is asked, per entry: what the title reads as under each
reader, how deep the entry sits, and **which page index its destination really
resolves to** — followed through `/Dest`, through an `/A` `/GoTo` `/D` array and
through a named destination in either `/Dests` store, because a bookmark that
names the wrong sheet is the defect that reads perfectly.

Usage: python3 docs/research/bookmarks-round-readers.py <dir-with-cases.json>
"""
import json
import pathlib
import sys

import pymupdf
import pypdf

FAILS = 0
LINES = 0


def say(line=""):
    global LINES
    LINES += 1
    print(line)


def check(ok, text):
    global FAILS
    if not ok:
        FAILS += 1
    say(f"{'PASS' if ok else 'FAIL'} {text}")


def page_of(reader, target):
    """Page index a destination points at, or None.

    Handles all three spellings a destination arrives in: an array whose first
    item is the page, an integer page index, and a dictionary carrying `/D`. The
    page is matched on its reference because pdf-lib hands the page object back
    when resolved, and a resolved `PageObject` never equals an `IndirectObject`.
    """
    if target is None:
        return None
    ref = target if isinstance(target, pypdf.generic.IndirectObject) else None
    if ref is not None:
        target = ref.get_object()
    if isinstance(target, (int, float)) and not isinstance(target, bool):
        return int(target)
    if isinstance(target, pypdf.generic.ArrayObject):
        return page_of(reader, target[0])
    if isinstance(target, pypdf.generic.DictionaryObject):
        inner = target.get("/D")
        if inner is not None:
            return page_of(reader, inner)
    for number, page in enumerate(reader.pages):
        own = page.indirect_reference
        if ref is not None and own is not None and own.idnum == ref.idnum:
            return number
        if ref is None and page.get_object() is target:
            return number
    return None


def named(reader, name):
    """A named destination resolved out of either store the format allows."""
    catalogue = reader.trailer["/Root"]
    catalogue = catalogue.get_object() if hasattr(catalogue, "get_object") else catalogue
    root = catalogue
    for holder in (root.get("/Dests"), (root.get("/Names") or {}).get("/Dests")):
        if holder is None:
            continue
        holder = holder.get_object()
        if isinstance(holder, dict) and name in holder:
            value = holder[name].get_object()
            return value.get("/D") if isinstance(value, dict) else value
        for entry in holder.get("/Names", []) or []:
            entry = entry.get_object() if hasattr(entry, "get_object") else entry
            if isinstance(entry, pypdf.generic.TextStringObject) and str(entry) == name:
                index = list(holder["/Names"]).index(entry)
                value = holder["/Names"][index + 1].get_object()
                return value.get("/D") if isinstance(value, dict) else value
    return None


def flatten(reader):
    """`(depth, title, page index or None)` for every entry, in tree order."""
    rows = []

    def walk(items, depth):
        for item in items if isinstance(items, list) else [items]:
            if isinstance(item, list):
                walk(item, depth + 1)
                continue
            title = item.get("/Title")
            page = None
            if "/Dest" in item:
                page = page_of(reader, item["/Dest"])
            elif "/A" in item:
                action = item["/A"].get_object()
                if isinstance(action, dict) and action.get("/S") == "/GoTo":
                    target = action.get("/D")
                    page = page_of(
                        reader,
                        named(reader, str(target)) if isinstance(target, (str, pypdf.generic.TextStringObject)) else target,
                    )
            rows.append((depth, str(title) if title is not None else "", page))
            walk(item.get("/Kids", []), depth)
            rows.append(("end", "", None))

    walk(reader.outline, 1)
    # `pypdf` appends the nodes after their children; sort back to tree order by
    # reading the `/Next` chain the tree itself carries instead.
    return rows


def chain(reader):
    """The outline followed by `/First` `/Next` `/First`… — real tree order."""
    catalogue = reader.trailer["/Root"]
    catalogue = catalogue.get_object() if hasattr(catalogue, "get_object") else catalogue
    root = catalogue.get("/Outlines")
    root = root.get_object() if root is not None else None
    rows = []

    def walk(node, depth):
        while node is not None:
            node = node.get_object()
            title = str(node.get("/Title")) if node.get("/Title") is not None else ""
            page = None
            if "/Dest" in node:
                page = page_of(reader, node["/Dest"])
            elif "/A" in node:
                action = node["/A"].get_object()
                if isinstance(action, dict) and action.get("/S") == "/GoTo":
                    target = action.get("/D")
                    if isinstance(target, (str, pypdf.generic.TextStringObject)):
                        page = page_of(reader, named(reader, str(target)))
                    else:
                        page = page_of(reader, target)
                else:
                    page = -1
            rows.append((depth, title, page))
            first = node.get("/First")
            if first is not None:
                walk(first, depth + 1)
            node = node.get("/Next")

    walk(root.get("/First") if root else None, 1)
    return rows


def surface(path):
    """Counts the tool must not disturb, plus the sheet ink."""
    doc = pymupdf.open(path)
    reader = pypdf.PdfReader(path)
    info = reader.trailer["/Info"].get_object() if "/Info" in reader.trailer else {}
    return {
        "pages": doc.page_count,
        "info": {k: str(info.get(k)) for k in ("/Title", "/Author", "/Subject", "/Creator") if k in info},
        "annots": sum(len(list(page.annots() or [])) for page in doc),
        "links": sum(len(page.get_links()) for page in doc),
        "ink": [sum(1 for b in page.get_pixmap(dpi=36, colorspace=pymupdf.csGRAY).samples if b < 250) for page in doc],
        "xrefs": doc.xref_length(),
    }


def main():
    directory = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    cases = json.loads((directory / "cases.json").read_text())
    say(f"readers: pypdf {pypdf.__version__}, MuPDF {pymupdf.__doc__.split()[1] if pymupdf.__doc__ else '?'}")
    say()

    for case in cases:
        say(f"=== {case['case']}  ({case.get('note', '')})")
        say(f"typed: {case['typed']!r}")
        say(f"card : {case.get('message') or case.get('error')}")
        for warning in case.get("warnings") or []:
            say(f"warn : {warning}")
        say()
        if not case.get("ok"):
            # A case the tool refused is a failure, not a skip: the run produced no
            # file, so every question below would otherwise go unasked and silent.
            check(False, f"the tool refused the case: {case.get('error')}")
            say()
            continue
        for name in case.get("files") or []:
            produced = directory / "out" / name
            source = case["fixture"]

            doc = pymupdf.open(produced)
            toc = doc.get_toc(simple=False)
            mupdf_rows = [(item[0], item[1], item[2]) for item in toc]
            say(f"MuPDF get_toc: {[(d, t, p) for d, t, p in mupdf_rows]}")

            reader = pypdf.PdfReader(produced)
            rows = chain(reader)
            say(f"pypdf chain  : {rows}")

            expected = case.get("expect") or []
            check(len(rows) == len(expected), f"entry count {len(rows)} == typed {len(expected)}")
            for got, want in zip(rows, expected, strict=False):
                depth, title, page = got
                wanted_page = None if want["page"] is None else want["page"] - 1
                check(title == want["title"], f"title reads back {title!r} == {want['title']!r}")
                check(depth == want["depth"], f"depth {depth} == {want['depth']} for {title!r}")
                check(page == wanted_page, f"destination resolves to {page} == {wanted_page} for {title!r}")

            # MuPDF must agree on the tree, depth and page numbers.
            # MuPDF answers a heading with no destination as page -1; pypdf as
            # None, and MuPDF counts pages from 1. Normalise both to 0-based or None.
            check(
                [(d, t, p - 1 if p > 0 else None) for d, t, p in mupdf_rows]
                == [(d, t, pg) for d, t, pg in rows],
                "MuPDF's tree == pypdf's tree (depth, title, page)",
            )

            before, after = surface(source), surface(produced)
            check(after["pages"] == before["pages"], f"page count {after['pages']} == source {before['pages']}")
            check(after["info"] == before["info"], f"/Info kept {after['info']}")
            check(after["annots"] == before["annots"], f"annotations {after['annots']} == source {before['annots']}")
            check(after["links"] == before["links"], f"link annots {after['links']} == source {before['links']}")
            check(after["ink"] == before["ink"], f"sheet ink unchanged {after['ink']}")
            say()
        say()

    # The instrument's own control: a blank sheet must not read as a tree.
    blank = pymupdf.open()
    blank.new_page()
    blank.save(directory / "control-blank.pdf")
    control = pypdf.PdfReader(directory / "control-blank.pdf")
    check(chain(control) == [], "control: a blank PDF has no outline")
    say()
    say(f"TOTAL {FAILS} FAIL / {LINES} lines")


if __name__ == "__main__":
    main()
