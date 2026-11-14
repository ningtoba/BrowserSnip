#!/usr/bin/env python3
"""Measure what `add-blank-page` produced, page by page, in pixels and boxes.

  python3 docs/research/blank-round-measure.py /tmp/triage/colour.pdf out/*.pdf
  python3 docs/research/blank-round-measure.py --diff /tmp/r/before /tmp/r/after

Per file: page count, then one line per page — the box a viewer shows (PyMuPDF's
`page.rect`, which applies `/Rotate`), `/Rotate`, `/MediaBox`, `/CropBox`, the
first line of text, the non-white pixel count of the raster at `--dpi`, annots and
links. Then the document's furniture: `/Info`, XMP length, outline, embedded
files, widget count. The source is measured by the same code, so every claim is a
comparison rather than an absolute.

`--diff` prints only the page and furniture lines that differ between two output
directories, which is how the after half proves it moved only what it claims
(the title and the producer, and nothing else).
"""
import io
import sys
from pathlib import Path

import pymupdf
from PIL import Image

DPI = 50


def ink_of(page: pymupdf.Page, dpi: int) -> int:
    """Non-white pixels in the rendered page — ink off the pixels, never a count."""
    pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csRGB)
    grey = Image.open(io.BytesIO(pix.tobytes("png"))).convert("L")
    histogram = list(grey.histogram())
    # Bins 0..249 are everything darker than "nearly white".
    return sum(histogram[:250])


def first_line(page: pymupdf.Page) -> str:
    text = page.get_text()
    lines: list[str] = str(text or "").strip().split("\n")
    return (lines[0] if lines else "")[:44]


def describe(path: Path, dpi: int) -> list[str]:
    doc = pymupdf.open(path)
    meta = doc.metadata or {}
    out = [f"== {path} pages={doc.page_count}"]
    for page in doc:
        rect = page.rect
        out.append(
            f"  p{(page.number or 0) + 1} disp={round(rect.width, 1)}x{round(rect.height, 1)}"
            f" rot={page.rotation}"
            f" mb={[round(v, 1) for v in page.mediabox]} cb={[round(v, 1) for v in page.cropbox]}"
            f" ink={ink_of(page, dpi)}"
            f" annots={len(list(page.annots() or []))} links={len(page.get_links())}"
            f" text={first_line(page)!r}"
        )
    out.append(
        f"  INFO title={meta.get('title')!r} author={meta.get('author')!r}"
        f" subject={meta.get('subject')!r} keywords={meta.get('keywords')!r}"
        f" creator={meta.get('creator')!r} producer={meta.get('producer')!r}"
    )
    out.append(
        f"  DOC xmp={len(doc.get_xml_metadata() or '')} outline={doc.get_toc()}"
        f" emb={doc.embfile_count()} widgets={sum(len(list(p.widgets() or [])) for p in doc)}"
    )
    doc.close()
    return out


def main(argv: list[str]) -> int:
    dpi = DPI
    args: list[str] = []
    index = 0
    while index < len(argv):
        if argv[index] == "--dpi":
            dpi = int(argv[index + 1])
            index += 2
            continue
        args.append(argv[index])
        index += 1

    if args and args[0] == "--diff":
        left, right = Path(args[1]), Path(args[2])
        for produced in sorted(right.glob("*.pdf")):
            other = left / produced.name
            if not other.exists():
                print(f"only after: {produced.name}")
                continue
            a, b = describe(other, dpi), describe(produced, dpi)
            # The path differs by directory only, so drop it from the comparison.
            a[0], b[0] = "", ""
            changed = [
                f"- {x}\n+ {y}" for x, y in zip(a, b, strict=False) if x != y
            ]
            extra = b[len(a):] + a[len(b):]
            print(f"== {produced.name} {'CHANGED' if changed or extra else 'identical'}")
            for line in changed:
                print(line)
            for line in extra:
                print(f"± {line}")
        return 0

    for name in args:
        for line in describe(Path(name), dpi):
            print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
