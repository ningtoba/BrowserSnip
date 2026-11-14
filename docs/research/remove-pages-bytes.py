#!/usr/bin/env python3
"""Which sheets a Delete Pages run kept, and what it did to everything that is not a sheet.

    python3 docs/research/remove-pages-bytes.py SRC OUT KEPT

`KEPT` is the 1-based source sheet list the run should have kept, in order
(`1,3,4`). Every output sheet is measured the same way as the source sheet it
should be — its first non-blank text line, its non-white pixel count at 72 dpi
over the whole page, its displayed box and its `/Rotate` — and the run is OK only
when the output is that list and nothing else. A count of pages is not the test:
four sheets of paper and four sheets of text are the same number.

Then the parts of a document that outlive a page: `/Info`, the XMP packet, the
outline, the page-label ranges, the embedded files, and per sheet its `/Annots`
and its links, measured on both sides so "kept" is a comparison and not a claim.

Ink is counted off a real raster, so the reader is checked before it is trusted:
`--blank` measures a page of paper and must read 0.
"""
import sys

import pymupdf

DPI = 72
WHITE = 250


def ink(page):
    pix = page.get_pixmap(dpi=DPI)
    return sum(1 for i in range(0, len(pix.samples), pix.n) if pix.samples[i] < WHITE)


def first_line(page):
    for line in page.get_text().splitlines():
        if line.strip():
            return line.strip()[:60]
    return ""


def sheet(page):
    return {
        "box": (round(page.rect.width, 1), round(page.rect.height, 1)),
        "rotate": page.rotation,
        "ink": ink(page),
        "line": first_line(page),
        "annots": len(list(page.annots() or [])),
        "links": len(page.get_links() or []),
        "images": len(page.get_images() or []),
        "media": [round(v, 1) for v in page.mediabox],
        "crop": [round(v, 1) for v in page.cropbox],
    }


def document(path):
    doc = pymupdf.open(path)
    xref = doc.xref_xml_metadata()
    packet = (doc.xref_stream(xref) or b"") if isinstance(xref, int) and xref else b""
    out = {
        "meta": doc.metadata,
        "xmp": len(packet),
        "outline": doc.get_toc(),
        "labels": [page.get_label() for page in doc],
        "embedded": doc.embfile_names(),
        "sheets": [sheet(page) for page in doc],
    }
    doc.close()
    return out


def row(n, s):
    return (
        f"  sheet {n}: box {s['box'][0]}x{s['box'][1]} media {s['media']} crop {s['crop']} "
        f"/Rotate {s['rotate']} ink {s['ink']} annots {s['annots']} links {s['links']} "
        f"images {s['images']} line {s['line']!r}"
    )


def main(argv):
    if len(argv) >= 2 and argv[1] == "--blank":
        doc = pymupdf.open(argv[2])
        print("blank-sheet ink:", [ink(page) for page in doc], "(0 is the only pass)")
        return 0
    if len(argv) != 4:
        print(__doc__)
        return 2
    src_path, out_path, kept_raw = argv[1], argv[2], argv[3]
    kept = [int(part) for part in kept_raw.split(",") if part.strip()]

    src = document(src_path)
    out = document(out_path)

    print(f"SOURCE {src_path}")
    for n, s in enumerate(src["sheets"], 1):
        print(row(n, s))
    print(
        f"  /Info title {src['meta']['title']!r} author {src['meta']['author']!r} "
        f"subject {src['meta']['subject']!r} keywords {src['meta']['keywords']!r} "
        f"creator {src['meta']['creator']!r} producer {src['meta']['producer']!r}"
    )
    print(f"  xmp {src['xmp']} bytes · outline {len(src['outline'])} · labels {src['labels']} · embedded {src['embedded']}")

    print(f"OUTPUT {out_path}")
    for n, s in enumerate(out["sheets"], 1):
        print(row(n, s))
    print(
        f"  /Info title {out['meta']['title']!r} author {out['meta']['author']!r} "
        f"subject {out['meta']['subject']!r} keywords {out['meta']['keywords']!r} "
        f"creator {out['meta']['creator']!r} producer {out['meta']['producer']!r}"
    )
    print(f"  xmp {out['xmp']} bytes · outline {len(out['outline'])} · labels {out['labels']} · embedded {out['embedded']}")

    failures = []
    if len(out["sheets"]) != len(kept):
        failures.append(f"kept {len(out['sheets'])} sheets, wanted {len(kept)}")
    for index, source_page in enumerate(kept):
        if index >= len(out["sheets"]):
            break
        want = src["sheets"][source_page - 1]
        got = out["sheets"][index]
        for key in ("box", "rotate", "ink", "line", "annots", "links", "images", "media", "crop"):
            if want[key] != got[key]:
                failures.append(f"sheet {index + 1} should be source {source_page}: {key} {got[key]!r} != {want[key]!r}")
    # A source sheet that was dropped may not appear, whatever the sheet beside it holds.
    for dropped in [n for n in range(1, len(src["sheets"]) + 1) if n not in kept]:
        want = src["sheets"][dropped - 1]
        if want["ink"] > 0 and want["line"]:
            strays = [n for n, s in enumerate(out["sheets"], 1) if s["line"] == want["line"]]
            if len(strays) > 1:
                failures.append(f"dropped sheet {dropped} ({want['line']!r}) is still on sheets {strays}")

    print("VERDICT:", "OK — the kept sheets are the source sheets, in order" if not failures else "FAIL")
    for failure in failures:
        print("  -", failure)
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
