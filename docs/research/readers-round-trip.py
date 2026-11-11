#!/usr/bin/env python3
"""Judge the reader round trips with the readers that did not write the fixture.

`tests/pdf/readers-foreign.test.ts` runs the shipped tools over files in
`tests/fixtures/readers/` and writes what came back into a directory named by
`BROWSERSNIP_READERS_DUMP`:

    BROWSERSNIP_READERS_DUMP=/tmp/rt npx vitest run tests/pdf/readers-foreign.test.ts
    python3 docs/research/readers-round-trip.py /tmp/rt

The dump is not trusted to read itself. Every file — the fixture that went in and the
file that came out — is asked the same two questions by **MuPDF 1.28.2** and **pypdf
6.14.2**: what does the page numbering say on each sheet (`get_page_labels`,
`page.get_label()`, `PdfReader.page_labels`), and where does each bookmark land
(`get_toc()`, `get_destination_page_number`). Our own reader is the thing under test, so
a round trip judged by asking it again can only ever say "nothing changed": a bookmark
the reader lost and the writer rewrote as a heading reads back as no page either way.

Printed as markdown rows for `docs/research/readers-foreign-repro.md`.
"""
import os
import sys
from typing import Any

import pikepdf
import pymupdf
import pypdf


def label_view(path: str) -> str:
    doc = pymupdf.open(path)
    per_page = [page.get_label() for page in doc]
    ranges = doc.get_page_labels()
    doc.close()
    pyp = pypdf.PdfReader(path)
    try:
        strings = list(pyp.page_labels)
    except Exception as error:  # noqa: BLE001
        strings = [f"ERR {type(error).__name__}"]
    store = "absent"
    with pikepdf.open(path) as pdf:
        tree = pdf.Root.get("/PageLabels")
        if tree is not None:
            if "/Nums" in tree:
                store = f"/Nums x{len(tree['/Nums']) // 2}"
            elif "/Kids" in tree:
                store = f"/Kids x{len(tree['/Kids'])}"
            else:
                store = "present, neither /Nums nor /Kids"
    return (f"MuPDF per page {per_page}; MuPDF ranges {len(ranges)}; "
            f"pypdf {strings}; the file's own store: {store}")


def outline_view(path: str) -> str:
    doc = pymupdf.open(path)
    toc = doc.get_toc()
    doc.close()
    reader = pypdf.PdfReader(path)
    resolved: list[tuple[str | None, object]] = []

    def walk(items) -> list[tuple[str | None, object]]:
        found: list[tuple[str | None, object]] = []
        for item in items:
            if isinstance(item, list):
                found.extend(walk(item))
                continue
            try:
                page: object = reader.get_destination_page_number(item)
            except Exception:  # noqa: BLE001
                page = None
            found.append((getattr(item, "title", None), page))
        return found

    try:
        resolved = walk(reader.outline)
    except Exception as error:  # noqa: BLE001
        resolved = [(f"ERR {type(error).__name__}", None)]
    named = 0
    with pikepdf.open(path) as pdf:
        root = pdf.Root.get("/Outlines")
        if root is not None and "/First" in root:
            stack: list[Any] = [root["/First"]]
            while stack:
                node: Any = stack.pop()
                item: Any = node.get_object() if hasattr(node, "get_object") else node
                if "/Dest" in item or "/Destination" in item or "/A" in item:
                    named += 1
                for key in ("/First", "/Next"):
                    child = item.get(key)
                    if child is not None:
                        stack.append(child)
    return (f"pypdf resolves {sum(1 for _, p in resolved if p is not None)} of "
            f"{len(resolved)}: {resolved}; MuPDF {toc}; items naming a target in the "
            f"bytes: {named}")


def main() -> None:
    import tempfile

    dump = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "rt")
    fixtures = "tests/fixtures/readers"
    for name in sorted(os.listdir(dump)):
        if not name.endswith(".pdf"):
            continue
        produced = os.path.join(dump, name)
        source = os.path.join(fixtures, name.split("__", 1)[1])
        kind = "labels" if os.path.basename(source).startswith("labels") else "outlines"
        view = label_view if kind == "labels" else outline_view
        print(f"### {name}\n")
        print(f"- in  — {os.path.basename(source)}: {view(source)}")
        print(f"- out — {name}: {view(produced)}\n")


if __name__ == "__main__":
    main()
