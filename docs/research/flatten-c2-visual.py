#!/usr/bin/env python3
"""Three-way visual judge for a flatten run: source vs our download vs the bar.

    python3 docs/research/flatten-c2-visual.py SRC.pdf OUT.pdf [dpi] [first-page] [last-page]

MuPDF's own `Document.bake()` is the standalone-utility bar for this tool (qpdf's CLI
is not on this box; libqpdf is only reachable through pikepdf, which writes no
appearances), so a bake that disagrees with `bake()` about where a pixel goes is
wrong, not the other way round. Poppler renders the source too, so a disagreement
about clipping cannot be blamed on one library.

Per page it prints differing-pixel counts and the boxes they fall in for
src↔ours, src↔MuPDF-bake and src↔poppler, the ink totals, and it writes
`visual-{src,out,diff}-pN.png` next to the run for the eye.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

import fitz
import numpy as np
from PIL import Image
from scipy import ndimage

LOOK = os.environ.get("LOOK", "/tmp")


def render_fitz(path: str, page: int, dpi: int) -> np.ndarray:
    d = fitz.open(path)
    p = d[page]
    pix = p.get_pixmap(dpi=dpi, annots=True, clip=p.rect)
    arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
    out = arr[:, :, :3].copy()
    d.close()
    return out


def render_poppler(path: str, out_dir: str, dpi: int) -> list[np.ndarray]:
    subprocess.run(["pdftoppm", "-r", str(dpi), "-png", path, f"{out_dir}/pop"],
                   check=True, capture_output=True)
    files = sorted(f for f in os.listdir(out_dir) if f.startswith("pop") and f.endswith(".png"))
    return [np.asarray(Image.open(os.path.join(out_dir, f)).convert("RGB")) for f in files]


def clusters(mask: np.ndarray, min_px: int = 25) -> list[list[int]]:
    lab, n = ndimage.label(mask)
    found: list[tuple[int, int, int, int, int]] = []
    for i in range(1, int(n) + 1):
        ys, xs = np.nonzero(lab == i)
        if xs.size < min_px:
            continue
        found.append((int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()), int(xs.size)))
    top = sorted(found, key=lambda t: -t[4])[:10]
    return [list(t) for t in top]


def compare(a: np.ndarray, b: np.ndarray) -> dict:
    if a.shape != b.shape:
        return {"diff_px": -1, "note": f"shape {a.shape} vs {b.shape}", "clusters": []}
    m = np.abs(a.astype(int) - b.astype(int)).max(axis=2) > 24
    return {"diff_px": int(m.sum()), "clusters": clusters(m)}


def main() -> None:
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit(2)
    src, out = sys.argv[1], sys.argv[2]
    dpi = int(sys.argv[3]) if len(sys.argv) > 3 else 150
    first = int(sys.argv[4]) if len(sys.argv) > 4 else 0
    last = int(sys.argv[5]) if len(sys.argv) > 5 else fitz.open(src).page_count - 1
    os.makedirs(LOOK, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        bar = os.path.join(tmp, "bar.pdf")
        d = fitz.open(src)
        d.bake()
        d.save(bar, deflate=True)
        d.close()
        pop_dir = os.path.join(tmp, "pop")
        os.makedirs(pop_dir, exist_ok=True)
        pop = render_poppler(src, pop_dir, dpi)

        report = {"source": src, "produced": out, "dpi": dpi, "pages": []}
        for i in range(first, last + 1):
            a = render_fitz(src, i, dpi)
            b = render_fitz(out, i, dpi)
            c = render_fitz(bar, i, dpi)
            entry: dict = {
                "page": i + 1,
                "shape": list(a.shape),
                "ours": compare(a, b),
                "mupdf_bake": compare(a, c),
                "ink": {
                    "src": int((a.min(axis=2) < 250).sum()),
                    "out": int((b.min(axis=2) < 250).sum()),
                    "bar": int((c.min(axis=2) < 250).sum()),
                },
            }
            if i < len(pop):
                entry["poppler_vs_mupdf_on_source"] = compare(a, pop[i])
            report["pages"].append(entry)
            Image.fromarray(a).save(f"{LOOK}/visual-src-p{i+1}.png")
            Image.fromarray(b).save(f"{LOOK}/visual-out-p{i+1}.png")
            m = np.abs(a.astype(int) - b.astype(int)).max(axis=2)
            Image.fromarray(((m > 24).astype(np.uint8)) * 255).save(f"{LOOK}/visual-diff-p{i+1}.png")
        print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
