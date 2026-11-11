#!/usr/bin/env python3
"""Judge pdf-to-pdfa's output with readers that did not write it.

  python3 docs/research/pdfa-attribution-readers.py <file.pdf> …

For each file it prints the size, the /Producer an outside reader finds, whether the
XMP carries a PDF/A identification, whether the catalogue holds an /OutputIntents
entry (and what that entry names), the /MarkInfo flag, and whether the fonts on the
page ship with a font program. Every column is a reading of the bytes, never a
sentence from this app: the row this exists for is "who wrote this file, and is it
what the card says".

MuPDF (via PyMuPDF) and pypdf are used because this sandbox has no qpdf and no
mutool; both are independent of the Ghostscript build the tab downloads.
"""
import re
import sys

import pymupdf
import pypdf


def catalogue_intent(doc: pymupdf.Document) -> tuple[str, str]:
    """The /OutputIntents entry as MuPDF reads the catalogue, plus its dictionary."""
    catalog = doc.pdf_catalog()
    kind, value = doc.xref_get_key(catalog, "OutputIntents")
    if kind == "null":
        return "absent", ""
    ref = re.search(r"(\d+) 0 R", value or "")
    if not ref:
        return kind, value or ""
    entry = re.sub(r"\s+", " ", doc.xref_object(int(ref.group(1)), compressed=True))
    profile = re.search(r"/DestOutputProfile (\d+) 0 R", entry)
    if profile:
        stream = doc.xref_stream(int(profile.group(1)))
        entry += (
            f" | DestOutputProfile stream {len(stream)} B"
            if stream is not None
            else " | DestOutputProfile (unread)"
        )
    return kind, entry


def fonts(doc: pymupdf.Document) -> str:
    """Every face on any page, and whether its descriptor carries a font program."""
    seen: dict[str, bool] = {}
    for page_number in range(doc.page_count):
        for xref, _ext, ftype, name, _ref, _enc in doc.get_page_fonts(page_number):
            descriptor = re.sub(r"\s+", " ", doc.xref_object(xref, compressed=True))
            for match in re.finditer(r"/FontDescriptor (\d+) 0 R", descriptor):
                descriptor = re.sub(
                    r"\s+", " ", doc.xref_object(int(match.group(1)), compressed=True)
                )
                break
            seen[f"{name} ({ftype})"] = any(
                key in descriptor for key in ("/FontFile", "/FontFile2", "/FontFile3")
            )
    return "; ".join(
        f"{name} {'embedded' if embedded else 'NOT embedded'}" for name, embedded in sorted(seen.items())
    ) or "no fonts"


def main(paths: list[str]) -> int:
    if not paths:
        print(__doc__)
        return 2
    for path in paths:
        with open(path, "rb") as handle:
            raw = handle.read()
        doc = pymupdf.open(path)
        reader = pypdf.PdfReader(path)
        root = reader.root_object
        xmp = doc.get_xml_metadata() or ""
        part = re.search(r"pdfaid:part[^0-9]{0,4}(\d)", xmp)
        conformance = re.search(r"pdfaid:conformance[^A-Za-z]{0,3}([A-Za-z])", xmp)
        marked = doc.xref_get_key(doc.pdf_catalog(), "MarkInfo")[0] != "null"
        intent_kind, intent_entry = catalogue_intent(doc)
        producer = ""
        try:
            producer = str((reader.metadata or {}).get("/Producer", ""))
        except Exception:  # noqa: BLE001
            producer = "(unreadable /Info)"
        print(path)
        print(f"  bytes {len(raw)}  pages {doc.page_count}")
        print(f"  producer {producer or 'none'}")
        print(f"  xmp_pdfaid {part.group(1) if part else 'no'}"
              f" conformance {conformance.group(1) if conformance else 'no'}")
        print(f"  output_intents {intent_kind}" + (f"  {intent_entry}" if intent_entry else ""))
        print(f"  markinfo {'present' if marked else 'absent'}")
        print(f"  fonts {fonts(doc)}")
        intents = root.get("/OutputIntents")
        print(f"  pypdf_catalog_output_intents {'present' if intents is not None else 'absent'}")
        doc.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
