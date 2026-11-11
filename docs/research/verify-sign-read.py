#!/usr/bin/env python3
"""Judge the bytes `sign` produced, with readers that share no code with it.

  python3 docs/research/verify-sign-read.py <file.pdf> --expect=1,0.08,0.12,120,40

Questions asked of the file, per page:
  * is the mark an annotation (and if so what subtype), a form /Sig field, or
    pixels painted into the page content?
  * where did it actually land, in PDF points, and what size?
  * does the planted sentence survive on every page (nothing was eaten)?
The panel reports its placement as fractions of the page plus a size in points, so
--expect restates that claim and the measured box is printed beside it.
"""
import sys

import fitz  # PyMuPDF
import pikepdf
from pypdf import PdfReader

flags = [a for a in sys.argv[1:] if a.startswith("--expect=")]
paths = [a for a in sys.argv[1:] if not a.startswith("--")]
path = paths[0]

doc = fitz.open(path)
print(f"PyMuPDF {fitz.version[0]} on {path}: {doc.page_count} pages, "
      f"needs_pass={doc.needs_pass}, is_form={doc.is_form_pdf}")

reader = PdfReader(path)
fields = reader.get_fields() or {}
sig_fields = {name: field.get("/FT") for name, field in fields.items()
              if str(field.get("/FT")) == "/Sig" or str(field.get("/V")) != "None"}
with pikepdf.open(path) as handled:
    root = handled.Root
    print(f"pypdf {reader.pdf_header} · /AcroForm in Root: {'/AcroForm' in root} · "
          f"Root keys: {list(root.keys())}")
    print(f"pypdf fields: {sig_fields or '(none)'}")

def widget_rows(page):
    """Field name, type and box for every widget, however this PyMuPDF spells them."""
    found = page.widgets()
    return [(getattr(w, "field_name", None), getattr(w, "field_type_string", None),
             tuple(round(v, 1) for v in w.rect)) for w in (found or [])]


for index in range(doc.page_count):
    page = doc.load_page(index)
    box = page.rect
    imgs = page.get_image_info(xrefs=True)
    drawn = page.get_drawings()
    print(f"\n-- page {index + 1}: box {box.width:.1f} x {box.height:.1f}")
    print(f"   annotations: {[(a.type[1], tuple(round(v, 1) for v in a.rect), a.info.get('title')) for a in page.annots()] or '(none)'}")
    print(f"   widgets:     {widget_rows(page) or '(none)'}")
    for im in imgs:
        b = fitz.Rect(im["bbox"])
        print(f"   image xref={im.get('xref')} cs={im.get('cs-name')} "
              f"placed {b.width:.1f} x {b.height:.1f} pt at left={b.x0:.1f} bottom={box.height - b.y1:.1f} "
              f"(x frac {b.x0 / box.width:.4f}, y-from-bottom frac {(box.height - b.y1) / box.height:.4f})")
    if not imgs and drawn:
        cover = [d for d in drawn if d["rect"].width > 20 and d["rect"].height > 20]
        print(f"   vector drawings: {len(drawn)} paths, {len(cover)} larger than 20x20 pt; "
              f"first bboxes {[str(d['rect']) for d in cover[:3]] or '(none)'}")
    words = [w[4] for w in page.get_text("words")]
    print(f"   planted sentence: {[w for w in words if 'alice' in w] or 'MISSING'}")
    print(f"   other words on the page: {[w for w in words if 'alice' not in w][:14]}")

if flags:
    print("\n-- panel claim vs bytes")
    for entry in flags[0].split("=", 1)[1].split(";"):
        pg, xf, yf, wpt, hpt = entry.split(",")
        page = doc.load_page(int(pg) - 1)
        pw, ph = page.rect.width, page.rect.height
        want = (float(xf) * pw, float(yf) * ph, float(wpt), float(hpt))
        print(f"   page {pg}: panel wants left={want[0]:.1f} bottom={want[1]:.1f} w={want[2]:.1f} h={want[3]:.1f}")
        for im in page.get_image_info(xrefs=True):
            b = fitz.Rect(im["bbox"])
            print(f"     image is  left={b.x0:.1f} bottom={ph - b.y1:.1f} w={b.width:.1f} h={b.height:.1f}"
                  f"  dx={b.x0 - want[0]:+.1f} dy={(ph - b.y1) - want[1]:+.1f} "
                  f"dw={b.width - want[2]:+.1f} dh={b.height - want[3]:+.1f}")
        for w in page.get_text("words"):
            if "alice" in w[4] or w[4].istitle():
                print(f"     text {w[4]!r} at left={w[0]:.1f} bottom={ph - w[3]:.1f}")
doc.close()
