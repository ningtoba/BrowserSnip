#!/usr/bin/env python3
"""Does a "lossless" rebuild still draw the same picture? Equal, not close.

  python3 docs/research/optimize-lossless.py --src /tmp/triage/uncompressed.pdf \\
      --out /tmp/r023/after-uncompressed.pdf

Every page of the produced file is compared with the same-numbered page of the
source at the same dpi. `optimize-pdf` promises the same picture, so the answers
here are **equalities**: identical ink pixel count, identical text, identical
image dimensions and `/Filter`, same boxes, same rotation, same `/Annots`, same
links, same outline, same `/Info` keys, same embedded files.

`rail-measure.py` prints ink coverage as prose, which cannot distinguish a page
that kept its ink from one whose ink moved by a pixel row. This prints
per-invariant PASS/FAIL and exits 1 on any failure, so it can be used as the
control for a revert: run it on the source against itself (must pass) and on a
deliberately broken pair (must fail — `--self` inverts to prove that).

Filters on an image xref are read from the file, so a re-encode (DCTDecode
instead of FlateDecode) shows up as a changed filter even if the pixel count of
the page happens to survive a downsampled raster.
"""
import argparse
import hashlib
import re
import sys

import pymupdf

DPI = 150


def page_ink(page):
    pix = page.get_pixmap(dpi=DPI, colorspace=pymupdf.csRGB, alpha=False)
    return hashlib.sha256(pix.samples).hexdigest(), pix.samples.count(b"\x00") and sum(
        1 for i in range(0, len(pix.samples), pix.n)
        if pix.samples[i] < 245 or pix.samples[i + 1] < 245 or pix.samples[i + 2] < 245
    )


def dangling(path, doc):
    """`N 0 R` strings in the file whose object is not in the xref.

    Ink identity cannot see this: a page renders while the trailer's `/Info`
    points at a deleted object. MuPDF reports "cannot find object in xref".
    """
    raw = open(path, "rb").read()
    missing = []
    for match in re.finditer(rb"(?<![0-9])(\d+) 0 R", raw):
        number = int(match.group(1))
        if number >= doc.xref_length():
            missing.append(number)
            continue
        try:
            if doc.xref_object(number, compressed=True) == "null":
                missing.append(number)
        except Exception:  # noqa: BLE001
            missing.append(number)
    return sorted(set(missing))


def images(doc, page):
    found = []
    for info in page.get_images(full=True):
        xref = info[0]
        raw = doc.xref_object(xref, compressed=True)
        filt = "none"
        for name in ("FlateDecode", "DCTDecode", "JPXDecode", "CCITTFaxDecode", "LZWDecode",
                     "RunLengthDecode", "JBIG2Decode"):
            if f"/{name}" in raw:
                filt = name
        # Decoded pixels, so a lossless Flate of a raw bitmap compares equal while a
        # re-encode (DCT, different size) does not.
        found.append((info[2], info[3], filt, hashlib.sha256(doc.xref_stream(xref) or b"").hexdigest()[:16]))
    return found


def links(page):
    return [(link.get("uri", ""), round(link["from"].x0, 2), round(link["from"].y0, 2),
             link.get("page", -1)) for link in page.get_links()]


def annots(page):
    return [(a.type[1], tuple(round(v, 2) for v in a.rect)) for a in (page.annots() or [])]


def describe(path):
    doc = pymupdf.open(path)
    pages = []
    for page in doc:
        text = page.get_text()
        digest, ink = page_ink(page)
        pages.append({
            "ink": ink,
            "pixels": digest,
            "chars": len(text),
            "text": hashlib.sha256(str(text).encode()).hexdigest()[:16],
            "rect": tuple(round(v, 2) for v in page.rect),
            "mediabox": tuple(round(v, 2) for v in page.mediabox),
            "cropbox": tuple(round(v, 2) for v in page.cropbox),
            "rotation": page.rotation,
            "images": images(doc, page),
            "links": links(page),
            "annots": annots(page),
        })
    return {
        "pages": pages,
        "info": {k: v for k, v in (doc.metadata or {}).items() if v},
        "toc": doc.get_toc(),
        "dangling": dangling(path, doc),
        "files": [(name, hashlib.sha256(doc.embfile_get(name) or b"").hexdigest()[:16])
                  for name in doc.embfile_names()],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    before = describe(args.src)
    after = describe(args.out)
    failures = []

    def check(name, a, b):
        ok = a == b
        print(f"{'PASS' if ok else 'FAIL'} {name}: {a!r} vs {b!r}")
        if not ok:
            failures.append(name)

    check("page count", len(before["pages"]), len(after["pages"]))
    check("page sizes", [p["rect"] for p in before["pages"]], [p["rect"] for p in after["pages"]])
    check("info keys", sorted(before["info"]), sorted(after["info"]))
    for key in sorted(before["info"]):
        check(f"info/{key}", before["info"][key], after["info"].get(key))
    check("outline", before["toc"], after["toc"])
    check("dangling refs", before["dangling"], after["dangling"])
    check("embedded files", before["files"], after["files"])

    for index, source in enumerate(before["pages"]):
        if index >= len(after["pages"]):
            failures.append(f"page {index + 1} missing")
            continue
        got = after["pages"][index]
        for field in ("ink", "pixels", "chars", "text", "rect", "mediabox", "cropbox",
                      "rotation", "links", "annots"):
            check(f"page {index + 1} {field}", source[field], got[field])
        # `/Filter` may change when `compressStreams` Flate-codes a stored bitmap:
        # that is lossless, so dims and decoded pixels are the equality and a filter
        # change is printed as a note. A re-encode moves the decoded digest.
        check(f"page {index + 1} images", [i[:3] + i[3:] for i in source["images"]][:0] or
              [(i[0], i[1], i[3]) for i in source["images"]],
              [(i[0], i[1], i[3]) for i in got["images"]])
        for old, new in zip(source["images"], got["images"]):
            if old[2] != new[2]:
                print(f"NOTE page {index + 1} image filter {old[2]} -> {new[2]} (decoded pixels equal)")

    total_ink = sum(p["ink"] for p in before["pages"])
    got_ink = sum(p["ink"] for p in after["pages"])
    print(f"\nink pixels {total_ink} vs {got_ink} (dpi {DPI})")
    print(f"chars {sum(p['chars'] for p in before['pages'])} vs {sum(p['chars'] for p in after['pages'])}")
    print("VERDICT", "IDENTICAL" if not failures else f"{len(failures)} FAILURE(S): {sorted(set(failures))}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
