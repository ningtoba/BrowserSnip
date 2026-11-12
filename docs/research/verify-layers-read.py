#!/usr/bin/env python3
"""Does switching a layer off actually hide its ink, per reader?

  python3 docs/research/verify-layers-read.py <file.pdf> [expected-hidden ...]

Reports `/OCProperties` as the file holds it — the `/OCGs` list, and whether `/D /ON`
and `/D /OFF` name those same objects or copies of them, which is the difference
between a viewer finding the layer and not — then renders the page with MuPDF and with
poppler and counts the pixels of each layer's own colour, so "hidden in the default
view" is answered by the ink rather than by the dictionary.
"""
import subprocess
import sys
from pathlib import Path
from typing import Any

import fitz
import pikepdf

path = Path([a for a in sys.argv[1:] if not a.startswith("--")][0])
expect_hidden = [a for a in sys.argv[1:] if a.startswith("--")]

with pikepdf.open(path) as handled:
    props: Any = handled.Root.get("/OCProperties")
    if props is None:
        print("pikepdf: no /OCProperties")
        raise SystemExit(1)
    ocgs = list(props.get("/OCGs") or [])
    names = {}
    for index, entry in enumerate(ocgs):
        names[str(entry.get("/Type"))] = index
        print(f"  /OCGs[{index}] = {str(entry.get('/Name'))!r} indirect={entry.is_indirect}")
    ocg_refs = {id(ocgs[i]): (i, str(ocgs[i].get('/Name'))) for i in range(len(ocgs))}
    default = props.get("/D")
    def resolve(key):
        array = default.get(key)
        if array is None:
            return []
        out = []
        for member in array:
            hit = ocg_refs.get(id(member))
            text = str(member.get("/Name")) if hasattr(member, "get") else str(member)
            out.append((text, "same object" if hit else "copy, not the /OCGs entry"))
        return out
    for key in ("/ON", "/OFF", "/Order"):
        rows = resolve(key)
        print(f"  /D {key}: {[f'{n} ({how})' for n, how in rows] or '(absent)'}")
    print(f"  /Configs: {len(list(props.get('/Configs') or []))} entry(ies)")

document: Any = fitz.open(path)
print(f"\nMuPDF {fitz.version[0]} get_ocgs: {document.get_ocgs()}")
page = document.load_page(0)
pixmap = page.get_pixmap(dpi=72)
samples = pixmap.samples


def count(needle) -> int:
    total = 0
    for i in range(0, len(samples), pixmap.n):
        if needle(samples[i], samples[i + 1], samples[i + 2]):
            total += 1
    return total


red = count(lambda r, g, b: r > 150 and g < 90 and b < 90)
blue = count(lambda r, g, b: b > 150 and r < 90)
print(f"MuPDF render: {red} red pixels, {blue} blue pixels "
      f"(a painted block is 220x120 = 26400 at 72 dpi)")
text = page.get_text()
print(f"MuPDF text layer: {[line for line in text.splitlines() if 'revision' in line.lower() or line == 'alice1bravo']}")
document.close()

out = subprocess.run(["pdftoppm", "-r", "72", "-png", str(path), str(path.parent / "lay")], capture_output=True)
pngs = sorted(path.parent.glob("lay-*.png"))
print(f"\npoppler render: exit={out.returncode} {pngs}")
for png in pngs:
    doc: Any = fitz.open(png)
    pm = doc.load_page(0).get_pixmap()
    s = pm.samples
    r = sum(1 for i in range(0, len(s), pm.n) if s[i] > 150 and s[i + 1] < 90 and s[i + 2] < 90)
    b = sum(1 for i in range(0, len(s), pm.n) if s[i + 2] > 150 and s[i] < 90)
    print(f"  {png.name}: {r} red pixels, {b} blue pixels")
    doc.close()
    png.unlink()


def compare(first: Path, second: Path) -> None:
    """Render both files with MuPDF and poppler and report where the ink differs."""
    print(f"\n# render comparison {first.name} -> {second.name}")
    for label in ("MuPDF",):
        left = fitz.open(first)
        right = fitz.open(second)
        for number in range(min(left.page_count, right.page_count)):
            a = left.load_page(number).get_pixmap(dpi=72)
            b = right.load_page(number).get_pixmap(dpi=72)
            diff = 0
            box = None
            for y in range(min(a.height, b.height)):
                for x in range(min(a.width, b.width)):
                    ia = (y * a.width + x) * a.n
                    ib = (y * b.width + x) * b.n
                    if a.samples[ia:ia + 3] != b.samples[ia:ib and ia + 3]:
                        diff += 1
                        box = (x, y) if box is None else (min(box[0], x), min(box[1], y), max(box[2] if len(box) > 2 else x, x), max(box[3] if len(box) > 3 else y, y))
            print(f"  {label} page {number + 1}: {diff} pixels changed"
                  + (f", first differing at {box[:2]}" if box else ""))
        left.close()
        right.close()
    for path, tag in ((first, "before"), (second, "after")):
        prefix = path.parent / f"cmp-{tag}"
        out = subprocess.run(["pdftoppm", "-r", "72", "-png", str(path), str(prefix)], capture_output=True)
        pngs = sorted(path.parent.glob(f"cmp-{tag}-*.png"))
        ink = []
        for png in pngs:
            doc = fitz.open(png)
            pm = doc.load_page(0).get_pixmap()
            s = pm.samples
            ink.append(sum(1 for i in range(0, len(s), pm.n) if s[i] < 240 or s[i + 1] < 240 or s[i + 2] < 240))
            doc.close()
            png.unlink()
        print(f"  poppler {tag}: exit={out.returncode} ink per page {ink}")


if "--compare" in sys.argv:
    index = sys.argv.index("--compare")
    compare(Path(sys.argv[index + 1]), Path(sys.argv[index + 2]))
