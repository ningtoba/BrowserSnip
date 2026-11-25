#!/usr/bin/env python3
"""Judge a flatten-pdf download against the untouched source, same measurement.

    python3 docs/research/flatten-c2-measure.py SRC.pdf OUT.pdf [dpi]

Prints, per page: the interactive objects the bytes still carry (/Annots key
present or absent, kinds, popups, links, widgets), the AcroForm field list, the
ink the page paints (non-white pixels at `dpi`), the bounding box of each probe
colour baked into the fixture, the text the page still answers to, and a pixel
diff of source-with-annotations against the produced page. The produced file must
be re-openable by two readers (pikepdf + MuPDF) or the run fails regardless of
what the card said.
"""

from __future__ import annotations

import json
import sys

import fitz
import pikepdf
from PIL import Image, ImageChops
import numpy as np

PROBES = {
    # name: exact-ish RGB the fixture paints, and it must not occur in the paper
    "red": (255, 0, 0),
    "blue": (0, 0, 255),
    "dgreen": (0, 115, 0),
    "pink": (255, 230, 230),
    "magenta": (255, 0, 255),
    "cyanblock": (51, 153, 230),
    "yellow": (255, 255, 0),
}
TOL = 40


def render(path: str, dpi: int) -> list[Image.Image]:
    doc = fitz.open(path)
    out = []
    for page in doc:
        pix = page.get_pixmap(dpi=dpi, annots=True, clip=page.rect)
        mode = "RGB" if pix.n >= 3 else "L"
        img = Image.frombytes(mode, (pix.width, pix.height), pix.samples)
        out.append(img.convert("RGB"))
    doc.close()
    return out


def nonwhite(img: Image.Image) -> int:
    a = np.asarray(img)
    return int(np.count_nonzero(a.min(axis=2) < 250))


def color_bbox(img: Image.Image, target: tuple[int, int, int]) -> tuple[int, int, int, int] | None:
    a = np.asarray(img).astype(int)
    near = np.all(np.abs(a - np.array(target, dtype=int)) <= TOL, axis=2)
    ys, xs = np.nonzero(near)
    if xs.size == 0:
        return None
    return (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))


def color_count(img: Image.Image, target: tuple[int, int, int]) -> int:
    a = np.asarray(img).astype(int)
    near = np.all(np.abs(a - np.array(target, dtype=int)) <= TOL, axis=2)
    return int(near.sum())


def diff_pixels(a: Image.Image, b: Image.Image) -> int:
    if a.size != b.size:
        return -1
    d = ImageChops.difference(a, b)
    arr = np.asarray(d).max(axis=2)
    return int(np.count_nonzero(arr > 24))


def structure(path: str) -> list[dict]:
    out = []
    with pikepdf.open(path) as doc:
        acro = doc.Root.get("/AcroForm")
        fields = 0
        need_appearances = None
        if acro is not None:
            arr = acro.get("/Fields")
            fields = len(arr) if arr is not None else 0
            na = acro.get("/NeedAppearances")
            need_appearances = bool(na) if na is not None else None
        for page in doc.pages:
            raw = page.get("/Annots")
            kinds: dict[str, int] = {}
            popups = 0
            if raw is not None:
                for entry in raw:
                    obj = entry
                    if isinstance(obj, pikepdf.Dictionary):
                        k = str(obj.get("/Subtype", "?"))
                    else:
                        k = "?"
                    kinds[k] = kinds.get(k, 0) + 1
                    if k == "/Popup":
                        popups += 1
            out.append({
                "annots_key_present": raw is not None,
                "annots": len(raw) if raw is not None else 0,
                "kinds": kinds,
                "popups_listed": popups,
                "rotate": int(page.get("/Rotate", 0)),
                "mediabox": [round(float(x), 1) for x in page.mediabox],
            })
        for i, page in enumerate(out):
            page["fields_in_acroform"] = fields if i == 0 else None
            page["need_appearances"] = need_appearances if i == 0 else None
    return out


def text_of(path: str) -> list[str]:
    doc = fitz.open(path)
    out = [p.get_text() for p in doc]
    doc.close()
    return out


def main() -> None:
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit(2)
    src, produced = sys.argv[1], sys.argv[2]
    dpi = int(sys.argv[3]) if len(sys.argv) > 3 else 150

    with pikepdf.open(produced) as probe:  # re-parse gate
        _ = len(probe.pages)
    sdoc = fitz.open(produced)
    reparse_ok = not sdoc.is_encrypted and sdoc.page_count > 0
    sdoc.close()

    a_struct, b_struct = structure(src), structure(produced)
    a_imgs, b_imgs = render(src, dpi), render(produced, dpi)
    a_text, b_text = text_of(src), text_of(produced)

    report = {"source": src, "produced": produced, "dpi": dpi,
              "produced_reopens": reparse_ok, "pages": []}
    for i in range(max(len(a_struct), len(b_struct))):
        a = a_imgs[i] if i < len(a_imgs) else None
        b = b_imgs[i] if i < len(b_imgs) else None
        colors = {}
        for name, target in PROBES.items():
            ca = color_bbox(a, target) if a else None
            cb = color_bbox(b, target) if b else None
            na = color_count(a, target) if a else 0
            nb = color_count(b, target) if b else 0
            if ca is None and cb is None:
                continue
            colors[name] = {
                "src_bbox": ca, "out_bbox": cb, "src_px": na, "out_px": nb,
                "bbox_delta": None if not (ca and cb) else [cb[j] - ca[j] for j in range(4)],
                "px_delta": nb - na,
            }
        report["pages"].append({
            "page": i + 1,
            "source": a_struct[i],
            "produced": b_struct[i],
            "ink_src": nonwhite(a) if a else 0,
            "ink_out": nonwhite(b) if b else 0,
            "ink_delta": (nonwhite(b) if b else 0) - (nonwhite(a) if a else 0),
            "size_src": a.size if a else None,
            "size_out": b.size if b else None,
            "changed_pixels": diff_pixels(a, b) if (a and b) else -1,
            "chars_src": len(a_text[i]) if i < len(a_text) else 0,
            "chars_out": len(b_text[i]) if i < len(b_text) else 0,
            "colors": colors,
        })
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
