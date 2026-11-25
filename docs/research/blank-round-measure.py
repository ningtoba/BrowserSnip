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


def sheets(path: Path, dpi: int) -> list[dict]:
    """One dict per page: the readings the judge compares."""
    doc = pymupdf.open(path)
    out = []
    for page in doc:
        out.append(
            {
                "disp": (round(page.rect.width, 1), round(page.rect.height, 1)),
                "rot": page.rotation,
                "mb": tuple(round(v, 1) for v in page.mediabox),
                "cb": tuple(round(v, 1) for v in page.cropbox),
                "ink": ink_of(page, dpi),
                "annots": len(list(page.annots() or [])),
                "links": len(page.get_links()),
                "text": first_line(page),
            }
        )
    doc.close()
    return out


def furniture(path: Path) -> dict:
    doc = pymupdf.open(path)
    meta = doc.metadata or {}
    out = {
        "info": {key: meta.get(key) or "" for key in ("title", "author", "subject", "keywords", "creator")},
        "producer": meta.get("producer") or "",
        "xmp": len(doc.get_xml_metadata() or ""),
        "outline": doc.get_toc(),
        "emb": doc.embfile_count(),
        "widgets": sum(len(list(page.widgets() or [])) for page in doc),
    }
    doc.close()
    return out


PAGE_SIZES_PT = {"a4": (595.3, 841.9), "letter": (612.0, 792.0), "a3": (841.9, 1190.6)}


def judge_case(entry: dict, produced: Path, dpi: int) -> list[str]:
    """Judge one spec run: position, size, zero ink, originals, identity, sentence."""
    source = Path(entry["files"][0])
    src, got = sheets(source, dpi), sheets(produced, dpi)
    fs, fg = furniture(source), furniture(produced)
    total = len(src)
    fields = entry.get("fields") or {}
    position = {"Before the first page": "start", "After the last page": "end",
                "After a specific page": "after", "Before a specific page": "before"}.get(
        fields.get("Position", ""), "end")
    asked_count = int(fields.get("Blank pages to add", 1))
    count = min(max(asked_count, 1), 200)  # the field's own min/max
    asked_anchor = int(fields.get("Page number", total if position == "end" else 1))
    anchor = min(max(asked_anchor, 1), total)
    insert_at = {"start": 0, "end": total, "after": min(total, anchor), "before": max(0, anchor - 1)}[position]
    size_label = fields.get("Blank sheet size", "")
    problems: list[str] = []
    print(f"\n== {entry['tag']}: {source.name} position={position} count={count} (asked {asked_count}) "
          f"anchor={anchor} (asked {fields.get('Page number', '-')}) size={size_label or 'same as neighbour'}")
    if len(got) != total + count:
        problems.append(f"{entry['tag']}: page count {len(got)} != {total}+{count}")
        return problems
    # The neighbour the code picks, and the box it shows: a `/Rotate 90` sheet is
    # matched by its displayed box, not the one it is stored in (E8).
    neighbour = max(0, min(total - 1, (anchor - 2) if position == "before" else (anchor - 1)))
    want_blank = src[neighbour]["disp"]
    if size_label:
        for name, box in PAGE_SIZES_PT.items():
            if name.upper() in size_label.upper():
                want_blank = box
    blanks = list(range(insert_at, insert_at + count))
    sampled = blanks if len(blanks) <= 12 else sorted({blanks[0], blanks[len(blanks) // 2], blanks[-1]})
    for pos in range(len(got)):
        if pos in blanks:
            if pos not in sampled:
                if got[pos]["disp"] != want_blank:
                    problems.append(f"{entry['tag']}: blank {pos + 1} box {got[pos]['disp']} != {want_blank}")
                continue
            page = got[pos]
            clean = page["ink"] == 0 and page["text"] == "" and page["annots"] == 0 and page["links"] == 0
            sized = page["disp"] == want_blank
            print(f"   blank {pos + 1}: disp={page['disp']} (want {want_blank}) ink={page['ink']} "
                  f"text={page['text']!r} annots={page['annots']} links={page['links']} "
                  f"mb={page['mb']} {'OK' if clean and sized else 'WRONG'}")
            if not clean:
                problems.append(f"{entry['tag']}: page {pos + 1} is not blank (ink {page['ink']}, {page['text']!r})")
            if not sized:
                problems.append(f"{entry['tag']}: blank {pos + 1} box {page['disp']} != {want_blank}")
            continue
        origin = pos if pos < insert_at else pos - count
        was, now = src[origin], got[pos]
        same = all(was[key] == now[key] for key in ("disp", "rot", "mb", "cb", "ink", "annots", "links", "text"))
        if origin in (0, 3, 6, total - 1) or not same:
            print(f"   page {pos + 1} = source {origin + 1}: disp={now['disp']} rot={now['rot']} ink={now['ink']} "
                  f"annots={now['annots']} links={now['links']} text={now['text']!r} {'OK' if same else 'CHANGED'}")
        if not same:
            problems.append(f"{entry['tag']}: page {pos + 1} differs from source {origin + 1}: "
                            + "; ".join(f"{key} {was[key]!r} -> {now[key]!r}"
                                        for key in ("disp", "rot", "mb", "cb", "ink", "annots", "links", "text")
                                        if was[key] != now[key]))
    lost = [f"{key} {fg['info'][key]!r} != {value!r}" for key, value in fs["info"].items() if value and fg["info"][key] != value]
    if fg["producer"] != "BrowserSnip":
        lost.append(f"producer {fg['producer']!r} is not this app's")
    if fg["xmp"] != fs["xmp"]:
        lost.append(f"XMP {fs['xmp']} -> {fg['xmp']}")
    if sum(page["annots"] for page in got) != sum(page["annots"] for page in src):
        lost.append(f"annotations {sum(page['annots'] for page in src)} -> {sum(page['annots'] for page in got)}")
    if fg["emb"] != fs["emb"]:
        lost.append(f"embedded files {fs['emb']} -> {fg['emb']}")
    # Bookmarks follow their pages: an entry aimed at page p moves when the blanks
    # land before it, and stays when they do not.
    want_outline = [
        [level, title, (page + count if page > insert_at else page)]
        for level, title, page in fs["outline"]
    ]
    if fg["outline"] != want_outline:
        lost.append(f"outline {fs['outline']} -> {fg['outline']} (want {want_outline})")
    print(f"   identity: {'carried' if not lost else 'PROBLEM ' + '; '.join(lost)}; "
          f"outline {len(fs['outline'])} entries, {fg['emb']} embedded, xmp {fg['xmp']}")
    problems.extend(f"{entry['tag']}: {line}" for line in lost)
    return problems


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

    if args and args[0] == "--judge":
        import json

        spec = json.loads(Path(args[1]).read_text())
        root = Path(args[2])
        problems: list[str] = []
        for entry in spec:
            matches = sorted(root.glob(f"{entry['tool']}__{entry['tag']}_*.pdf"))
            if not matches:
                problems.append(f"{entry['tag']}: no download in {root}")
                print(f"\n== {entry['tag']}: MISSING ({root}/{entry['tool']}__{entry['tag']}_*.pdf)")
                continue
            problems += judge_case(entry, matches[0], dpi)
        print("\n" + ("AS PROMISED — 0 problem lines" if not problems else f"{len(problems)} PROBLEM LINES"))
        for problem in problems:
            print("  !", problem)
        return 0 if not problems else 1

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
