#!/usr/bin/env python3
"""Are the fields the designer made actually fillable by somebody else?

  python3 docs/research/verify-form-creator-read.py <form.pdf> [--fill name=value ...]

MuPDF is asked what the document is (form? needs a password?), then every widget:
field name, type, rect, and whether it has an appearance stream. The fill round trip
is the part a screenshot cannot show: write a value through MuPDF's own widget API,
save, reopen, and read it back — then ask pypdf the same question, so the answer is
not this app agreeing with itself.
"""
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import fitz
import pikepdf
from pypdf import PdfReader

args = list(sys.argv[1:])
path = Path([a for a in args if not a.startswith("--")][0])
fills = [a for a in args if a.startswith("--fill")]
pairs: list[tuple[str, str]] = []
for entry in fills:
    for item in entry.split("=", 1)[1].split(",") if "=" in entry else []:
        name, _, value = item.partition(":")
        pairs.append((name, value))

document: Any = fitz.open(path)
print(f"MuPDF {fitz.version[0]} on {path.name}: {document.page_count} pages, "
      f"is_form_pdf={document.is_form_pdf}, needs_pass={document.needs_pass}, pdf_version={document.metadata.get('format')}")

widgets = []
for number in range(1, document.page_count + 1):
    page = document.load_page(number - 1)
    found = list(page.widgets() or [])
    print(f"\npage {number} ({page.rect.width:.0f}x{page.rect.height:.0f}): {len(found)} widget(s)")
    for widget in found:
        print(f"  name={widget.field_name!r} type={widget.field_type_string} "
              f"rect=({widget.rect.x0:.1f},{widget.rect.y0:.1f},{widget.rect.x1:.1f},{widget.rect.y1:.1f}) "
              f"{widget.rect.width:.1f}x{widget.rect.height:.1f} pt "
              f"value={widget.field_value!r} options={getattr(widget, 'field_options', None)!r} "
              f"maxlen={getattr(widget, 'text_maxlen', None)} flags={widget.field_flags} "
              f"appearance={'/AP' in dict(widget.obj) if hasattr(widget, 'obj') else '?'}")
        widgets.append((number, widget))

reader: Any = PdfReader(str(path))
fields = reader.get_fields() or {}
print(f"\npypdf fields ({len(fields)}):")
for name, field in fields.items():
    print(f"  {name!r}: /FT={field.get('/FT')} /V={field.get('/V')!r} /Ff={field.get('/Ff')} "
          f"/Opt={[str(o) for o in (field.get('/Opt') or [])]} /DA={str(field.get('/DA'))[:48]!r}")

with pikepdf.open(path) as handled:
    form = handled.Root.get("/AcroForm")
    if form is None:
        print("\npikepdf: no /AcroForm")
    else:
        print(f"\npikepdf: /AcroForm=yes /NeedAppearances={form.get('/NeedAppearances')} "
              f"/DA={str(form.get('/DA'))[:70]!r}")
    if form is not None:
        print(f"pikepdf /DR fonts: {[str(k) for k in list((form.get('/DR') or {}).get('/Font') or {})]}")

if pairs:
    work = Path(tempfile.mkdtemp(prefix="fcr-"))
    filled = work / "filled.pdf"
    used = set()
    for number, widget in widgets:
        match = [(name, value) for name, value in pairs if name == widget.field_name]
        if not match or widget.field_name in used:
            continue
        name, value = match[0]
        used.add(name)
        want: Any = True if value.lower() in ("true", "on", "yes") else value
        try:
            widget.field_value = want
            widget.update()
            print(f"filled {name} = {want!r} on page {number}")
        except Exception as error:  # noqa: BLE001 - the answer is the point
            print(f"FILL {name}={value!r} on page {number} failed: {type(error).__name__}: {error}")
    missing = [name for name, _ in pairs if name not in used]
    if missing:
        print(f"no widget offered for: {missing}")
    document.save(filled)
    print(f"\nMuPDF filled {len(pairs)} field(s) and saved {filled.name}")
    again: Any = fitz.open(filled)
    for number in range(1, again.page_count + 1):
        for widget in again.load_page(number - 1).widgets() or []:
            print(f"  after reload page {number}: {widget.field_name!r} = {widget.field_value!r}")
    reread: Any = PdfReader(str(filled))
    print("pypdf sees:", {name: str(field.get('/V')) for name, field in (reread.get_fields() or {}).items()})
    text = subprocess.run(["pdftotext", "-layout", str(filled), "-"], capture_output=True, text=True)
    hits = [value for _, value in pairs if value in text.stdout]
    print(f"poppler text contains the filled values: {hits or 'NONE'}")
    again.close()
document.close()
