#!/usr/bin/env python3
"""Fixtures for the `sanitize-pdf` under-removal probe.

Three one-page files, one per way a PDF can carry an embedded file (ISO 32000-1
§7.9.6 name tree, §7.11.3 `/FileAttachment` annotation, PDF 2.0 / PDF-A-3 catalogue
`/AF`). Every one carries the marker `ZUGFERD-INVOICE-PAYLOAD-123`, so "did the
payload leave the output" is a decompressed byte search, not a count of keys.

    python3 docs/research/sanitize-scope-fixtures.py --dir /tmp/r026/fx

`actions.pdf` is the other direction — the actions a `/JavaScript` switch must NOT
take: a `/OpenAction` that only names a view, a `/AA` map with a non-script
trigger, a link annotation with a `/URI` action.
"""
import argparse
import pathlib

PAYLOAD = b"ZUGFERD-INVOICE-PAYLOAD-123"
CONTENT = b"q BT /F1 12 Tf 20 100 Td (page body) Tj ET Q"


def build(objects, path: pathlib.Path) -> None:
    body = b"%PDF-1.7\n"
    offsets = []
    for index, source in enumerate(objects):
        offsets.append(len(body))
        body += b"%d 0 obj\n" % (index + 1) + source + b"\nendobj\n"
    start = len(body)
    body += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        body += b"%010d 00000 n \n" % offset
    body += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, start)
    path.write_bytes(body)


def attachment(stores: str) -> list:
    """`stores` is any of `af`, `tree`, `annot`: where the same file is named."""
    annots = b" /Annots [7 0 R]" if "annot" in stores else b""
    page = b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R" + annots + b">>"
    catalog = b"<< /Type /Catalog /Pages 2 0 R"
    if "af" in stores:
        catalog += b" /AF [5 0 R]"
    if "tree" in stores:
        catalog += b" /Names << /EmbeddedFiles << /Names [(note.txt) 5 0 R] >> >>"
    catalog += b" >>"
    spec = b"<< /Type /Filespec /F (note.txt) /UF (note.txt) /EF << /F 8 0 R >> >>"
    annot = (
        b"<< /Type /Annot /Subtype /FileAttachment /Rect [40 30 60 50] /FS 5 0 R /F 4 /Contents (note.txt) >>"
        if "annot" in stores
        else b"<< >>"
    )
    return [
        catalog,
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        page,
        b"<< /Length %d >>\nstream\n" % len(CONTENT) + CONTENT + b"\nendstream",
        spec,
        b"<< /Type /EmbeddedFile /Length 8 >>\nstream\nplaceholder\nendstream",
        annot,
        b"<< /Type /EmbeddedFile /Length %d >>\nstream\n" % len(PAYLOAD) + PAYLOAD + b"\nendstream",
    ]


def actions() -> list:
    page = (
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Annots [5 0 R 6 0 R] "
        b"/AA << /WC << /S /JavaScript /JS (calc()) >> /WS << /S /GoTo /D [3 0 R /Fit] >> >> >>"
    )
    return [
        b"<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /GoTo /D [3 0 R /Fit] >> >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        page,
        b"<< /Length %d >>\nstream\n" % len(CONTENT) + CONTENT + b"\nendstream",
        b"<< /Type /Annot /Subtype /Link /Rect [10 150 90 170] /A << /S /URI /URI (https://example.org/) >> >>",
        b"<< /Type /Annot /Subtype /Link /Rect [10 100 90 120] /A << /S /JavaScript /JS (clicked()) >> >>",
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True)
    args = parser.parse_args()
    out = pathlib.Path(args.dir)
    out.mkdir(parents=True, exist_ok=True)
    build(attachment("af"), out / "af.pdf")
    build(attachment("af tree"), out / "af-and-names.pdf")
    build(attachment("tree"), out / "tree.pdf")
    build(attachment("annot"), out / "annot-fs.pdf")
    build(actions(), out / "actions.pdf")
    for path in sorted(out.glob("*.pdf")):
        print(path, path.stat().st_size)


if __name__ == "__main__":
    main()
