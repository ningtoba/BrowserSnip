#!/usr/bin/env python3
"""Judge a `form-filler` output against the file it was made from.

    python3 docs/research/form-filler-round.py /tmp/triage/in/form.pdf /tmp/f047/before/0-base-off-out.pdf

Per file: page count, `/Info` title, `/AcroForm`, each page's `/Annots`, page
text and ink (100 dpi, non-white samples), and per widget `/V`, `/AS`, `/Ff` and
the text its `/AP /N` stream actually draws. `/V` is read off the field dict —
the `/Parent` when there is one, because that is where pdf-lib writes it — so a
witness that only looked at the widget would report "no value" for every field
on a form built with a field tree, which is what the first pass of this round
did.

Two readers are used on purpose: `pypdf` for the dictionary (`/V`, `/AS`,
`/AcroForm`, `/Annots`, `/Info`) and PyMuPDF for what the page draws.
"""
import re
import sys

import pymupdf
import pypdf

VALUE = re.compile(rb"/V\s*(\([^)]*\)|<[0-9A-Fa-f]+>|\[[^\]]*\]|/[^\s/]+)")
AS = re.compile(rb"/AS\s*(/[^\s/]+)")
FF = re.compile(rb"/Ff\s*(\d+)")


def field_value(doc, xref: int) -> str:
    """`/V` from the dict that carries it: the parent chain first, then the widget."""
    seen = 0
    while xref and seen < 5:
        raw = doc.xref_object(xref).encode("latin-1")
        found = VALUE.search(raw)
        if found:
            return found.group(1).decode("latin-1")
        parent = re.search(r"/Parent (\d+) 0 R", raw.decode("latin-1"))
        xref = int(parent.group(1)) if parent else 0
        seen += 1
    return "-"


def appearance_text(doc, widget) -> str:
    """What the widget's normal appearance draws, as text operands."""
    raw = doc.xref_object(widget.xref).encode("latin-1")
    normal = re.search(rb"/N (\d+) 0 R", raw)
    if not normal:
        return "-"
    stream = doc.xref_stream(int(normal.group(1)))
    out = []
    for token in re.findall(rb"\(([^)]*)\)|<([0-9A-Fa-f]{2,})>", stream):
        literal, hexed = token
        if literal:
            out.append(literal.decode("latin-1"))
        else:
            data = bytes.fromhex(hexed.decode("ascii"))
            out.append(data.decode("utf-16-be" if len(data) % 2 == 0 and data[0::2] == b"\0" * (len(data) // 2) else "latin-1"))
    return " ".join(out) or "-"


def measure(path: str) -> None:
    doc = pymupdf.open(path)
    reader = pypdf.PdfReader(path)
    root = reader.trailer["/Root"]
    print(f"\n=== {path}")
    print(f"  pages {doc.page_count}  title {doc.metadata.get('title')!r}")
    print(f"  /AcroForm {root.get('/AcroForm') if hasattr(root.get('/AcroForm'), '__str__') else None}")
    for page in reader.pages:
        annots = page.get("/Annots")
        print(f"  /Annots {None if annots is None else len(annots)}")
    for page in doc:
        ink = sum(1 for b in page.get_pixmap(dpi=100).samples[::3] if b < 250)
        print(f"  page {page.number}: text {len(page.get_text())} chars, ink {ink} px")
    for page in doc:
        for widget in page.widgets() or []:
            raw = doc.xref_object(widget.xref)
            flags = FF.search(raw.encode("latin-1"))
            print(
                f"  widget {widget.field_name} [{widget.field_type_string}] "
                f"/V {field_value(doc, widget.xref)} /AS "
                f"{(AS.search(raw.encode('latin-1')) or [b'-', '-'])[1].decode('latin-1') if AS.search(raw.encode('latin-1')) else '-'} "
                f"/Ff {int(flags.group(1)) if flags else 0} draws {appearance_text(doc, widget)!r}"
            )


if __name__ == "__main__":
    for path in sys.argv[1:]:
        measure(path)
