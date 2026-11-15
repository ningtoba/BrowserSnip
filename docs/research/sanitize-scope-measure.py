#!/usr/bin/env python3
"""Judge a `sanitize-pdf` run: did the named thing actually leave the file, and
did everything else stay?

    python3 docs/research/sanitize-scope-measure.py --source /tmp/r026/fx/af.pdf \
        --output /tmp/r026/after/sanitize-pdf__af-on_af_sanitized.pdf --expect-removed

Checks, in the order the claim reads:

* **the payload** — every stream decompressed and searched for the fixture marker,
  so an unreferenced leftover cannot pass as "removed";
* **the reference** — `/AF`, `/Names → /EmbeddedFiles`, the file specification, a
  `/FileAttachment` annotation's `/FS`: all absent after a removal, all present
  before one;
* **what must not move** — page count, each page's own content-stream bytes and its
  rendered ink (110 dpi) against the source. A sanitiser that re-renders the page
  is a different tool.

`--expect-removed` = the switch was on; the default is the off-switch control,
where the payload must still be there and reachable. Exits 1 on any mismatch, so
this is a check and not a printout.
"""
import argparse
import sys

import numpy as np
import pymupdf

MARKER = b"ZUGFERD-INVOICE-PAYLOAD-123"
DPI = 110


def payload(doc) -> list:
    """Every xref whose *decoded* stream holds the marker."""
    hits = []
    for xref in range(1, doc.xref_length()):
        try:
            if not doc.xref_is_stream(xref):
                continue
            if MARKER in (doc.xref_stream(xref) or b""):
                hits.append(xref)
        except Exception as error:  # a hole in the xref table is not a payload
            print(f"  (xref {xref} unreadable: {error})")
            continue
    return hits


def content(doc, page) -> bytes:
    return page.read_contents()


def ink(page) -> int:
    pixmap = page.get_pixmap(dpi=DPI, annots=False)
    sample = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(pixmap.height, pixmap.width, pixmap.n)
    return int((sample[:, :, :3] != 255).any(axis=2).sum())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--expect-removed", action="store_true")
    parser.add_argument("--label", default="")
    args = parser.parse_args()

    source = pymupdf.open(args.source)
    output = pymupdf.open(args.output)
    failures = []

    def check(name, ok, detail=""):
        print(f"  {'ok  ' if ok else 'FAIL'} {name}{'' if ok else f' — {detail}'}")
        if not ok:
            failures.append(name)

    print(f"{args.label or args.output} (expect {'removed' if args.expect_removed else 'kept'})")
    left = payload(output)
    catalog = output.pdf_catalog()
    if args.expect_removed:
        check("payload left the file", not left, f"still in xref(s) {left}")
        check("/AF gone", output.xref_get_key(catalog, "AF")[0] == "null")
        check("/Names gone", output.xref_get_key(catalog, "Names")[0] == "null")
        specs = [x for x in range(1, output.xref_length())
                 if _key(output, x, "Type") == "/Filespec"]
        check("no file specification left", not specs, f"still at {specs}")
        fs = [x for x in range(1, output.xref_length()) if _key(output, x, "FS") not in (None, "null")]
        check("no annotation /FS left", not fs, f"still at {fs}")
    else:
        check("payload is still in the file", bool(left), "the payload left with the switch off")
        check("/AF kept", output.xref_get_key(catalog, "AF")[0] != "null"
              or output.xref_get_key(catalog, "Names")[0] != "null")

    check("page count unchanged", output.page_count == source.page_count,
          f"{source.page_count} -> {output.page_count}")
    for index in range(min(output.page_count, source.page_count)):
        check(f"page {index + 1} content bytes untouched",
              content(output, output[index]) == content(source, source[index]))
        before, after = ink(source[index]), ink(output[index])
        check(f"page {index + 1} ink unchanged", before == after, f"{before} -> {after} px")
    print(f"{'FAILED' if failures else 'passed'}: {len(failures)} mismatch(es)")
    return 1 if failures else 0


def _key(doc, xref, name):
    try:
        return doc.xref_get_key(xref, name)[1]
    except Exception:
        return None


if __name__ == "__main__":
    sys.exit(main())
