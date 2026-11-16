#!/usr/bin/env python3
"""Round 048 measure: the produced file, judged by readers that share no code.

  python3 docs/research/form-creator-placement.py <produced.pdf> [<source.pdf>]

Recurses the whole /AcroForm tree. Then a fill round trip: every widget written
through MuPDF's own widget API, saved, reopened by MuPDF, pypdf and poppler's text
layer. Page text length, /Info, ink and /Annots are compared to the source.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

import fitz
import pikepdf
from pypdf import PdfReader

args = [a for a in sys.argv[1:] if not a.startswith("--")]
produced = Path(args[0])
source = Path(args[1]) if len(args) > 1 else None


def page_stats(path):
    d = fitz.open(path)
    out = [(n + 1, round(p.rect.width), round(p.rect.height), p.rotation,
            sum(1 for pix in [p.get_pixmap(dpi=72)] for x in range(0, pix.width, 3)
                for y in range(0, pix.height, 3) if pix.pixel(x, y)[:3] != (255, 255, 255)),
            len(p.get_text()), len(list(p.widgets() or [])))
           for n, p in enumerate(d)]
    info = {k: v for k, v in (d.metadata or {}).items() if k in ("title", "author", "creator")}
    d.close()
    return out, info


print(f"== {produced.name}")
if source:
    print("source  :", page_stats(source))
print("produced:", page_stats(produced))

d = fitz.open(produced)
print(f"\nis_form_pdf={d.is_form_pdf} pages={d.page_count}")
rows = []
for n, p in enumerate(d):
    for w in p.widgets() or []:
        rows.append({'page': n + 1, 'name': w.field_name, 'type': w.field_type_string,
                     'rect': (round(w.rect.x0, 1), round(w.rect.y0, 1), round(w.rect.x1, 1), round(w.rect.y1, 1)),
                     'size': (round(w.rect.width, 1), round(w.rect.height, 1)),
                     'maxlen': getattr(w, 'text_maxlen', None), 'flags': w.field_flags,
                     'ap': '/AP' in dict(w.obj) if getattr(w, 'obj', None) is not None else '?'})
for r in rows:
    print("  widget", r)


def walk(entry, parent, depth):
    own = str(entry.get("/T", "")) if entry.get("/T") is not None else ""
    name = f"{parent}.{own}" if parent and own else (own or parent)
    rect = entry.get("/Rect")
    print(f"  node {'  ' * depth}{name or '(anon)'}: /FT={entry.get('/FT')} /Ff={entry.get('/Ff')}"
          f" /MaxLen={entry.get('/MaxLen')} /V={entry.get('/V')} /TU={entry.get('/TU')}"
          f" /Rect={[round(float(v), 1) for v in rect] if rect is not None else None}"
          f" /P={'yes' if entry.get('/P') is not None else 'NO'}"
          f" /AP={'yes' if entry.get('/AP') is not None else 'NO'}")
    for kid in entry.get("/Kids", []):
        walk(kid, name, depth + 1)


with pikepdf.open(produced) as pdf:
    form = pdf.Root.get("/AcroForm")
    print("\n/AcroForm present:", form is not None, "| /NeedAppearances:",
          None if form is None else form.get("/NeedAppearances"))
    print("/Info:", dict(pdf.docinfo) if pdf.docinfo is not None else None)
    if form is not None:
        for entry in form.get("/Fields", []):
            walk(entry, "", 0)

reader = PdfReader(str(produced))
print(f"\npypdf top-level /T: {sorted((reader.get_fields() or {}).keys())}")

# ── fill round trip, MuPDF as the fill writer ────────────────────────────────
work = Path(tempfile.mkdtemp(prefix="r048-"))
filled = work / "filled.pdf"
doc = fitz.open(produced)
used = []
for n, page in enumerate(doc):
    for w in page.widgets() or []:
        kind = w.field_type_string
        val = {"Text": "Ada Lovelace", "ComboBox": "Finland", "ListBox": "red",
               "CheckBox": True, "RadioButton": "S"}.get(kind)
        if val is None or w.field_name in [u[0] for u in used]:
            continue
        try:
            w.field_value = val
            w.update()
            used.append((w.field_name, kind, val, n + 1))
        except Exception as error:                                    # noqa: BLE001
            print(f"FILL {w.field_name} on page {n + 1} failed: {type(error).__name__}: {error}")
doc.save(filled)
doc.close()
print(f"\nMuPDF filled {len(used)}: {[(n, k, v, f'p{p}') for n, k, v, p in used]}")
again = fitz.open(filled)
print("MuPDF read back:", [(w.field_name, w.field_value) for p in again for w in (p.widgets() or [])])
again.close()
print("pypdf read back:", {n: str(f.get("/V")) for n, f in (PdfReader(str(filled)).get_fields() or {}).items()})
text = subprocess.run(["pdftotext", "-layout", str(filled), "-"], capture_output=True, text=True).stdout
print("poppler text shows:", [v for _, _, v, _ in used if str(v) in text] or "NONE")
