#!/usr/bin/env python3
"""Where did the stamps actually land?

  python3 docs/research/verify-stamps-read.py --make /tmp/eight/stamps-source.pdf
  python3 docs/research/verify-stamps-read.py /tmp/eight/stamped.pdf --anchor top-right

The fixture is four pages that differ in size *and* rotation, each ruled and labelled,
so a stamp painted against the wrong box is visible in the numbers. The judge renders
every page at 72 dpi (one pixel = one point) and reports the bounding box of the
stamp's own colour in displayed space, beside the annotation rectangle and beside the
corner the tool was told to use. `pdftoppm` gets the same pages, because a mark only
MuPDF can see is a mark most people will not.
"""
import subprocess
import sys
from pathlib import Path

import fitz
import pikepdf

RED = (0.862, 0.149, 0.149)  # #dc2626, the stamp label colour the rail defaults to
SIZES = [(595, 842, 0), (595, 842, 90), (400, 300, 0), (500, 700, 180), (450, 600, 270)]

args = list(sys.argv[1:])
if args and args[0] == "--make":
    out = Path(args[1])
    doc = fitz.open()
    for index, (width, height, rotation) in enumerate(SIZES):
        page = doc.new_page(width=width, height=height)
        # Draw in unrotated space, then rotate: the displayed size swaps for 90/270.
        page.draw_rect(fitz.Rect(20, 20, width - 20, height - 20), color=(0.6, 0.6, 0.6), width=1)
        page.insert_text((30, 45), f"PAGE {index + 1} {width}x{height} rot {rotation}", fontsize=13)
        page.insert_text((30, height / 2), f"alice{index + 1}bravo", fontsize=12)
        page.set_rotation(rotation)
    doc.save(out)
    doc.close()
    print(f"wrote {out}")
    raise SystemExit(0)

path = Path([a for a in args if not a.startswith("--")][0])
anchor = "top-right"
for argument in args:
    if argument.startswith("--anchor"):
        anchor = argument.split("=", 1)[1] if "=" in argument else "top-right"

corners = {
    "top-right": lambda w, h, sw, sh: (w - 30 - sw, 30),
    "top-left": lambda w, h, sw, sh: (30, 30),
    "bottom-right": lambda w, h, sw, sh: (w - 30 - sw, h - 30 - sh),
    "bottom-left": lambda w, h, sw, sh: (30, h - 30 - sh),
    "center": lambda w, h, sw, sh: ((w - sw) / 2, (h - sh) / 2),
}

document = fitz.open(path)
print(f"MuPDF {fitz.version[0]} on {path.name}: {document.page_count} pages, "
      f"expected anchor {anchor!r}")
for index in range(document.page_count):
    page = document.load_page(index)
    box = page.rect  # displayed space, rotation already applied
    marks = []
    for annot in page.annots() or []:
        marks.append(annot)
    print(f"\n-- page {index + 1}: displayed {box.width:.0f}x{box.height:.0f}, rotation {page.rotation}, "
          f"mediabox {tuple(round(v) for v in page.mediabox)}")
    if not marks:
        print("   annotations: (none) — NOTHING LANDED ON THIS PAGE")
    for annot in marks:
        sub = annot.type[1] if isinstance(annot.type, tuple) else str(annot.type)
        rect = annot.rect
        # MuPDF hands back `/Rect` in the page's own unrotated space, so this row is
        # not a statement about where the mark is seen — the rendered ink below is.
        print(f"   {sub}: rect=({rect.x0:.1f},{rect.y0:.1f},{rect.x1:.1f},{rect.y1:.1f}) in unrotated space, "
              f"{rect.width:.1f}x{rect.height:.1f} pt; "
              f"hidden={getattr(annot, 'is_hidden', '?')} content={annot.info.get('content')!r} "
              f"field={getattr(annot, 'field_name', None)!r}")
        try:
            pix = annot.get_pixmap()
            print(f"      appearance stream: {pix.width}x{pix.height} px")
        except Exception as error:  # noqa: BLE001
            print(f"      appearance stream: none ({error})")
    # Where the ink actually is, by its own colour, in displayed space.
    pixmap = page.get_pixmap(dpi=72)
    samples = pixmap.samples
    found = None
    for y in range(pixmap.height):
        for x in range(pixmap.width):
            offset = (y * pixmap.width + x) * pixmap.n
            red, green, blue = samples[offset], samples[offset + 1], samples[offset + 2]
            if red > 140 and green < 110 and blue < 110 and red - green > 60:
                if found is None:
                    found = [x, y, x, y]
                else:
                    found[0] = min(found[0], x)
                    found[1] = min(found[1], y)
                    found[2] = max(found[2], x)
                    found[3] = max(found[3], y)
    if found:
        x0, y0, x1, y1 = found
        seen = "VISIBLE ON THE SHEET" if (x0 >= 0 and y0 >= 0 and x1 < pixmap.width and y1 < pixmap.height) else "PAINTED OFF THE SHEET"
        print(f"   stamp-coloured ink as rendered: ({x0},{y0})-({x1},{y1}) = {x1 - x0 + 1}x{y1 - y0 + 1} pt, "
              f"{pixmap.width - 1 - x1} pt from the right edge, {y0} pt from the top — {seen}")
    else:
        print("   stamp-coloured ink as rendered: NONE — the page shows no stamp")
document.close()

with pikepdf.open(path) as handled:
    for index, page in enumerate(handled.pages):
        annots = page.get("/Annots")
        if annots is None:
            print(f"\npikepdf page {index + 1}: no /Annots")
            continue
        for ref in annots:
            annot = ref
            print(f"pikepdf page {index + 1}: /Subtype={annot.get('/Subtype')} /Rect={list(annot.get('/Rect') or [])} "
                  f"/Rotate={annot.get('/Rotate')} /CA={annot.get('/CA')} /AP={'yes' if annot.get('/AP') is not None else 'no'} "
                  f"/Name={annot.get('/Name')} /FS={annot.get('/FS')}")

poppler = subprocess.run(["pdftoppm", "-r", "72", "-png", str(path), str(path.parent / "pop")],
                         capture_output=True, text=True)
print(f"\npdftoppm render: exit={poppler.returncode} files={sorted(p.name for p in path.parent.glob('pop-*.png'))}")
for png in sorted(path.parent.glob("pop-*.png")):
    image = fitz.open(png)
    page = image.load_page(0)
    pixmap = page.get_pixmap()
    samples = pixmap.samples
    red = sum(1 for i in range(0, len(samples), pixmap.n)
              if samples[i] > 140 and samples[i + 1] < 110 and samples[i + 2] < 110)
    print(f"  {png.name}: {pixmap.width}x{pixmap.height} px, {red} stamp-coloured pixels (poppler sees the mark)"
          if red else f"  {png.name}: {pixmap.width}x{pixmap.height} px, 0 stamp-coloured pixels (poppler does NOT)")
    image.close()
    png.unlink()
