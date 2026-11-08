#!/usr/bin/env python3
"""Measure what `rasterize-pdf` produced, page by page — and fail if it is paper.

  python3 docs/research/rasterize-ink.py [--compare SRC.pdf] [--dpi 100] FILE...

Per page this prints the non-white coverage of the page **as it displays**
(PyMuPDF applies `/Rotate`, so it is what a viewer shows), the embedded image
XObject's pixel size, the displayed box and `/Rotate`, and how dark each of the
four edge strips is — the orientation probe the `/Rotate 90` fixture needs, since
"rasterised as displayed" has to be read off the ink and not assumed.

With `--compare SRC.pdf` it is a check rather than a printout, and exits 1 unless
for every page:

* a sheet the source draws ink on is **not blank** in the output — the defect this
  row was opened for, 0.00 % non-white under "Rasterised 1 page(s) to JPEG";
* the coverage agrees within `max(2.0 pp, 25 %)`: a sideways or clipped raster
  loses part of the picture, and JPEG error cannot account for that;
* the same edges carry a band, so a rotated sheet comes back turned the way it is
  displayed rather than the way it is stored;
* the displayed box is unchanged, which is the aspect half of the same risk.
"""
import argparse
import sys

import pymupdf

STRIP = 0.055      # edge strip: this fraction of the short side
BAND_DENSITY = 0.6 # a strip at least this dark is "a band on that edge"
STRIDE = 3


def dark(x, y, pix):
    at = (y * pix.width + x) * pix.n
    s = pix.samples
    return s[at] < 245 or s[at + 1] < 245 or s[at + 2] < 245


def ink_of(pix):
    """(dark pixels, sampled pixels) — the count, so a hairline is not rounded away."""
    n = pix.n
    sampled = dark_count = 0
    for i in range(0, max(len(pix.samples) - (n - 1), 0), n * 7):
        sampled += 1
        if pix.samples[i] < 245 or pix.samples[i + 1] < 245 or pix.samples[i + 2] < 245:
            dark_count += 1
    return dark_count, sampled


def centroid(pix):
    """Mean position of the dark pixels, as a fraction of the page.

    Bands on two edges pin the orientation to within a transpose; the centre of
    mass of the ink pins that too, because the fixture's copy sits off-centre. A
    sideways, flipped or cropped raster moves it, so this is the number that makes
    "rasterised as displayed" a measurement rather than an impression.
    """
    n, w, h = pix.n, pix.width, pix.height
    sx = sy = count = 0
    for y in range(0, h, STRIDE):
        base = y * w * n
        for x in range(0, w, STRIDE):
            at = base + x * n
            s = pix.samples
            if s[at] < 245 or s[at + 1] < 245 or s[at + 2] < 245:
                sx += x
                sy += y
                count += 1
    if not count:
        return None
    return (round(sx / count / w, 3), round(sy / count / h, 3))


def edge_densities(pix):
    """Fraction of dark pixels in a strip along each displayed edge."""
    w, h = pix.width, pix.height
    band = max(2, round(STRIP * min(w, h)))
    counts = {"top": 0, "bottom": 0, "left": 0, "right": 0}
    totals = dict(counts)
    for y in range(h):
        for x in range(0, w, STRIDE):
            on = dark(x, y, pix)
            if y < band:
                totals["top"] += 1
                counts["top"] += 1 if on else 0
            if y >= h - band:
                totals["bottom"] += 1
                counts["bottom"] += 1 if on else 0
            if x < band:
                totals["left"] += 1
                counts["left"] += 1 if on else 0
            if x >= w - band:
                totals["right"] += 1
                counts["right"] += 1 if on else 0
    return {k: (counts[k] / max(totals[k], 1)) for k in counts}, band


def describe(path, dpi):
    doc = pymupdf.open(path)
    pages = []
    for index in range(doc.page_count):
        page = doc[index]
        pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csRGB)
        densities, band = edge_densities(pix)
        dark_count, sampled = ink_of(pix)
        images = []
        for xref, *_rest in page.get_images(full=True):
            info = doc.extract_image(xref)
            images.append((info["width"], info["height"], info["ext"]))
        rect = page.rect
        entry = {
            "path": path,
            "page": index + 1,
            "ink": 100.0 * dark_count / max(sampled, 1),
            "dark": dark_count,
            "sampled": sampled,
            "box": (round(rect.width, 1), round(rect.height, 1)),
            "rotate": page.rotation,
            "images": images,
            "densities": densities,
            "centroid": centroid(pix),
            "bands": sorted(k for k, v in densities.items() if v >= BAND_DENSITY),
        }
        pages.append(entry)
        print(f"{path} p{index + 1} ink={entry['ink']:6.2f}% dark={entry['dark']}/{entry['sampled']} "
              f"box={entry['box'][0]}x{entry['box'][1]} rot={entry['rotate']:<3} "
              f"imgs={len(images)} imgpx="
              f"{','.join(f'{w}x{h}({e})' for w, h, e in images) or '-'} "
              f"bands={','.join(entry['bands']) or 'none'} centroid={entry['centroid']} "
              f"edge={[f'{k}:{v:.2f}' for k, v in densities.items()]} (strip {band}px)")
    doc.close()
    return pages


def compare(source, output):
    ok = True
    label = output[0]["path"] if output else "?"
    if len(source) != len(output):
        print(f"FAIL {label}: {len(source)} source page(s) against {len(output)} output page(s)")
        return False
    for src, out in zip(source, output, strict=True):
        at = f"{label} p{src['page']}"
        if src["bands"] != out["bands"]:
            print(f"FAIL {at}: banded edges {src['bands'] or 'none'} -> {out['bands'] or 'none'} "
                  "(the raster is not the page as displayed)")
            ok = False
        if src["box"] != out["box"]:
            print(f"FAIL {at}: displayed box {src['box']} -> {out['box']}")
            ok = False
        if src["centroid"] and out["centroid"] and any(
            abs(a - b) > 0.05 for a, b in zip(src["centroid"], out["centroid"], strict=True)
        ):
            print(f"FAIL {at}: ink centroid {src['centroid']} -> {out['centroid']} "
                  "(the picture is turned, flipped or cropped)")
            ok = False
        # Ink is compared as a count, not a rounded percentage: the hairline sheet
        # carries 0.10 %, which rounds to "blank" at two decimals and is exactly
        # the page a guessed threshold would let through.
        if src["dark"] == 0:
            if out["dark"] > 0:
                print(f"FAIL {at}: the source sheet is empty and the output drew "
                      f"{out['dark']} px — ink invented by the rasteriser")
                ok = False
            else:
                print(f"note {at}: blank in both (the control)")
            continue
        if out["dark"] == 0:
            print(f"FAIL {at}: 0 non-white px in the file against {src['dark']} "
                  f"({src['ink']:.2f} %) in the source — a picture of nothing")
            ok = False
            continue
        slack = max(2.0, 0.25 * src["ink"])
        if abs(out["ink"] - src["ink"]) > slack:
            print(f"FAIL {at}: ink {src['ink']:.2f}% -> {out['ink']:.2f}%, outside +/-{slack:.2f} pp "
                  "(cropped, rescaled, or invented)")
            ok = False
    return ok


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dpi", type=int, default=100)
    parser.add_argument("--compare", metavar="SRC.pdf", help="source file to measure the output against")
    parser.add_argument("files", nargs="+")
    args = parser.parse_args()

    source = describe(args.compare, args.dpi) if args.compare else None
    if source:
        print("-- source above; outputs below --")
    passed = True
    for path in args.files:
        pages = describe(path, args.dpi)
        if source is not None:
            ok = compare(source, pages)
            print(f"{'OK' if ok else 'FAIL'}: {path} against {args.compare}")
            passed = passed and ok
    sys.exit(0 if passed else 1)
