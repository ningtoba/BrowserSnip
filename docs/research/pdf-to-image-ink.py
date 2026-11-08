#!/usr/bin/env python3
"""Measure what `pdf-to-image` produced — and fail if it is paper, or one page N times.

  python3 docs/research/pdf-to-image-ink.py --source /tmp/p2i/sheets.pdf --dpi 200 FILE...

Accepts a ZIP of images, a single image, or a multi-page TIFF. Per produced image
it prints the byte length, the pixel size and the non-white coverage, then with
`--source` it is a check rather than a printout and exits 1 unless:

* **each file carries ink where the source page has ink**, within
  `max(2.0 pp, 25 %)` of the source's own coverage measured by PyMuPDF at the same
  dpi — the band `rasterize-ink.py` settled on, so the threshold is a comparison
  with the source and not a number this file invents;
* **the produced pixel size is the page's box at the dpi asked for** (±1 px), which
  is the `dpi` field measured rather than trusted;
* **the images are pairwise distinct by SHA-256** when the selection holds more than
  one page — the half an ink test cannot catch: a loop stuck on one page yields N
  inked, plausible files. When the source pages differ in size, their outputs must
  differ in size the same way;
* and the source's own empty control page comes back **empty** (0 non-white px), so
  the figures above are measurements and not a floor the instrument always reports.

`--pages 2` / `--pages 1-3` names the selection the run was given, so an entry can
be matched to the page it claims to be and the count is checked.
"""
import argparse
import hashlib
import io
import re
import sys
import zipfile

import pymupdf
from PIL import Image

BAND_PP = 2.0     # percentage points of coverage
BAND_REL = 0.25   # or this fraction of it, whichever is wider — as rasterize-ink.py


def ink_of(image):
    """Non-white pixels of a PIL image, composited over paper like a viewer shows it."""
    rgb = image.convert("RGBA")
    px = rgb.load()
    dark = 0
    step = max(1, (rgb.width * rgb.height) // 400_000)  # keep a 300 dpi sheet cheap
    for y in range(0, rgb.height, step):
        for x in range(0, rgb.width, step):
            r, g, b, a = px[x, y]
            if a == 0:
                continue  # paper
            blend = (255 * (255 - a)) // 255
            if min(r + blend, g + blend, b + blend) < 245:
                dark += 1
    return dark, (rgb.width // step or 1) * (rgb.height // step or 1)


def tiff_pages(blob):
    # `utif`-style minimal split is not worth it here; PyMuPDF opens TIFF too.
    doc = pymupdf.open(stream=blob, filetype="tiff")
    return [Image.open(io.BytesIO(pix.tobytes("png"))) for pix in
            (page.get_pixmap(dpi=72) for page in doc)]


def produced(path):
    """[(name, PIL image, container bytes)] from a zip, a lone image, or a TIFF."""
    with open(path, "rb") as handle:
        blob = handle.read()
    if blob[:2] == b"PK" or path.endswith(".zip"):
        out = []
        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            for entry in sorted(archive.namelist()):
                if entry.endswith("/"):
                    continue
                out.append((entry, Image.open(io.BytesIO(archive.read(entry))), len(blob)))
        return out
    if path.endswith((".tif", ".tiff")):
        return [(f"page-{i + 1}", image, len(blob)) for i, image in enumerate(tiff_pages(blob))]
    return [(path.rsplit("/", 1)[-1], Image.open(io.BytesIO(blob)), len(blob))]


def parse_pages(spec):
    if not spec or spec == "all":
        return None
    pages = []
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            lo, hi = part.split("-")
            pages.extend(range(int(lo), int(hi) + 1))
        elif part:
            pages.append(int(part))
    return pages


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--source")
    ap.add_argument("--dpi", type=float, default=200)
    ap.add_argument("--pages", default="all")
    args = ap.parse_args()

    source = pymupdf.open(args.source) if args.source else None
    wanted = parse_pages(args.pages)
    failures = []

    for path in args.files:
        images = produced(path)
        print(f"\n{path}  ({len(images)} image(s))")
        rows = []
        for name, image, container_bytes in images:
            dark, sampled = ink_of(image)
            coverage = 100 * dark / sampled if sampled else 0.0
            digest = hashlib.sha256(image.tobytes()).hexdigest()[:16]
            size_note = f"{container_bytes} B container" if len(images) == 1 else "in zip"
            print(f"  {name:28s} {image.width}x{image.height:<6} {coverage:6.2f}% ink  sha {digest}  ({size_note})")
            m = re.search(r"-page-(\d+)", name)
            page = int(m.group(1)) if m else (wanted[len(rows)] if wanted and len(rows) < len(wanted) else len(rows) + 1)
            rows.append((name, image, coverage, sampled, digest, page))

            if source is not None:
                sheet = source[page - 1]
                box = sheet.rect
                expect = (round(box.width * args.dpi / 72), round(box.height * args.dpi / 72))
                if abs(image.width - expect[0]) > 1 or abs(image.height - expect[1]) > 1:
                    failures.append(
                        f"{name}: {image.width}x{image.height} px, but {page}-of-{source.page_count} "
                        f"at {args.dpi:g} dpi is {expect[0]}x{expect[1]}"
                    )
                pix = sheet.get_pixmap(dpi=int(round(args.dpi)))
                s_dark, s_total = 0, 0
                step = max(1, (pix.width * pix.height) // 400_000)
                stride = pix.n
                for y in range(0, pix.height, step):
                    base = y * pix.width * stride
                    for x in range(0, pix.width, step):
                        at = base + x * stride
                        s_total += 1
                        if pix.samples[at] < 245 or pix.samples[at + 1] < 245 or pix.samples[at + 2] < 245:
                            s_dark += 1
                s_cov = 100 * s_dark / s_total if s_total else 0.0
                band = max(BAND_PP, BAND_REL * s_cov)
                kind = "empty control" if s_dark == 0 else "inked"
                print(f"      source page {page}: {pix.width}x{pix.height} at {args.dpi:g} dpi, "
                      f"{s_cov:6.2f}% ink ({kind})")
                if s_dark == 0 and dark != 0:
                    failures.append(f"{name}: the empty source page came back with {dark} non-white px")
                if s_dark > 0 and dark == 0:
                    failures.append(
                        f"{name}: 0 non-white px against a source page at {s_cov:.2f}% — "
                        "the canvas was encoded before pdf.js painted it"
                    )
                if s_dark > 0 and abs(coverage - s_cov) > band:
                    failures.append(
                        f"{name}: {coverage:.2f}% ink against the source's {s_cov:.2f}% "
                        f"(band ±{band:.2f} pp)"
                    )

        if wanted is not None and len(rows) != len(wanted):
            failures.append(f"{path}: the selection asked for {wanted}, {len(rows)} images came back")
        elif wanted is not None and [r[5] for r in rows] != wanted:
            failures.append(f"{path}: pages came back {[r[5] for r in rows]}, not {wanted}")

        if len(rows) > 1:
            digests = [r[4] for r in rows]
            repeats = sorted({d for d in digests if digests.count(d) > 1})
            if repeats:
                failures.append(
                    f"{path}: {len(rows)} images, only {len(set(digests))} distinct — "
                    f"one page exported N times (sha {' '.join(repeats)})"
                )
            sizes = [(r[1].width, r[1].height) for r in rows]
            boxes = {(round(s.rect.width), round(s.rect.height)) for s in source} if source else set()
            if source is not None and len(boxes) == source.page_count and len(set(sizes)) != len(sizes):
                failures.append(f"{path}: sizes repeat {sizes} although every source page has its own box")
            inks = [round(r[2], 2) for r in rows]
            print(f"  pairwise ink: {inks}")

    print()
    if failures:
        print("FAIL")
        for line in failures:
            print(" -", line)
        sys.exit(1)
    print("OK: every produced image is the page it names, inked, at the dpi asked for")


if __name__ == "__main__":
    main()
