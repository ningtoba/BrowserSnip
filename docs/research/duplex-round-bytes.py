#!/usr/bin/env python3
"""Judge a duplex-collate output against its source, sheet by sheet.

The collation is a permutation: for a scan of `N` pages the front block is the
first `ceil(N/2)` pages, the back block is what follows the offset, and a
reversed back block is read last-page-first. The output must be the inverse of
that scan — sheet 1's front, sheet 1's back, sheet 2's front, … — so printing
the output double-sided lands the pages in reading order.

This is a check, not a printout: it exits 1 if any sheet differs from the source
page the promise says belongs there, or if a piece of page furniture does.

  python3 docs/research/duplex-round-bytes.py --source S --out O [--reverse]
                                               [--offset N]

Measured per sheet: /MediaBox and /CropBox, /Rotate, the first non-empty text
line, non-white pixels at 40 dpi, annotation count, link URIs. Measured once:
/Info (title, author, subject, keywords, creator), XMP presence, the outline
mapped per destination, and each page's reader label.

`--reverse` models the default (the back block came out last-page-first); drop
it for the "scanned in order" control. Ink is compared exactly: a page copy
reproduces the same paint, so a tolerance would only hide a substituted sheet.
"""
import argparse
import sys

import pymupdf


def first_line(page):
    for line in page.get_text().splitlines():
        if line.strip():
            return line.strip()[:60]
    return ""


def ink(page, dpi=40):
    pix = page.get_pixmap(dpi=dpi)
    return sum(1 for byte in pix.samples if byte < 250)


def measure(path):
    doc = pymupdf.open(path)
    pages = [
        {
            "box": tuple(round(v, 2) for v in page.mediabox),
            "crop": tuple(round(v, 2) for v in page.cropbox),
            "rotate": page.rotation,
            "text": first_line(page),
            "ink": ink(page),
            "annots": len(list(page.annots() or [])),
            "links": sorted(link.get("uri", "") for link in page.get_links() if link.get("uri")),
        }
        for page in doc
    ]
    info = doc.metadata or {}
    xmp = bool(doc.get_xml_metadata())
    outline = doc.get_toc()
    labels = [page.get_label() for page in doc]
    return {"path": path, "pages": pages, "info": info, "xmp": xmp, "outline": outline, "labels": labels}


def expected_order(total, offset, reverse):
    half = (total + 1) // 2
    front = list(range(half))
    back = list(range(min(total, half + offset), total))
    if reverse:
        back.reverse()
    order = []
    for i in range(max(len(front), len(back))):
        if i < len(front):
            order.append(front[i])
        if i < len(back):
            order.append(back[i])
    return order


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--reverse", action="store_true")
    parser.add_argument("--offset", type=int, default=0)
    args = parser.parse_args()

    src = measure(args.source)
    out = measure(args.out)
    order = expected_order(len(src["pages"]), args.offset, args.reverse)
    failures = []

    def check(ok, message):
        print(("PASS " if ok else "FAIL ") + message)
        if not ok:
            failures.append(message)

    check(len(out["pages"]) == len(order), f"page count {len(out['pages'])} == {len(order)} expected")
    for dest, source_index in enumerate(order):
        if dest >= len(out["pages"]) or source_index >= len(src["pages"]):
            continue
        want, got = src["pages"][source_index], out["pages"][dest]
        check(got["text"] == want["text"], f"sheet {dest + 1} is source {source_index + 1} by first line {want['text']!r} (got {got['text']!r})")
        check(got["box"] == want["box"], f"sheet {dest + 1} /MediaBox {want['box']} (got {got['box']})")
        check(got["crop"] == want["crop"], f"sheet {dest + 1} /CropBox {want['crop']} (got {got['crop']})")
        check(got["rotate"] == want["rotate"], f"sheet {dest + 1} /Rotate {want['rotate']} (got {got['rotate']})")
        check(got["ink"] == want["ink"], f"sheet {dest + 1} ink {want['ink']} px (got {got['ink']})")
        check(got["annots"] == want["annots"], f"sheet {dest + 1} annotations {want['annots']} (got {got['annots']})")
        check(got["links"] == want["links"], f"sheet {dest + 1} link URIs {want['links']} (got {got['links']})")

    # A reorder cannot change the identity of the file: the /Info fields and the
    # packet stay, the producer becomes this app's, and nothing is invented.
    # Only fields the source actually carries are compared: `openPDF` stamps a
    # creator on a file that had none before the tool ever sees it, which is a
    # shared seam rather than this tool's claim. Keywords compare as tokens —
    # the PDF `/Keywords` string is comma-separated by convention, and the carry
    # re-joins the same words with spaces.
    for key in ("title", "author", "subject", "creator"):
        if not src["info"].get(key):
            continue
        check((out["info"].get(key) or "") == src["info"].get(key),
              f"/Info {key} {src['info'].get(key)!r} (got {out['info'].get(key)!r})")
    if src["info"].get("keywords"):
        want = sorted(w for w in src["info"]["keywords"].replace(",", " ").split() if w)
        got = sorted(w for w in (out["info"].get("keywords") or "").replace(",", " ").split() if w)
        check(got == want, f"/Info keywords {want} (got {got})")
    check(out["xmp"] == src["xmp"], f"XMP packet {src['xmp']} (got {out['xmp']})")
    check(out["info"].get("producer") == "BrowserSnip", f"producer BrowserSnip (got {out['info'].get('producer')!r})")

    # An outline entry follows its page, so its destination is the output sheet
    # the source page landed on (first copy, as the app's remap defines it).
    landed = {}
    for dest, source_index in enumerate(order):
        landed.setdefault(source_index, dest)
    want_outline = [(level, title, landed.get(page - 1)) for level, title, page in src["outline"]]
    got_outline = [(level, title, page - 1) for level, title, page in out["outline"]]
    check(got_outline == want_outline, f"outline mapped {want_outline} (got {got_outline})")

    # The label shown on an output sheet is the one its source page carried.
    want_labels = [src["labels"][source_index] for source_index in order if source_index < len(src["labels"])]
    check(out["labels"] == want_labels, f"per-sheet labels {want_labels} (got {out['labels']})")

    print(f"\n{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
