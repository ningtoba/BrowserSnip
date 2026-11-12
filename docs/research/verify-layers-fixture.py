#!/usr/bin/env python3
"""A two-layer PDF shaped like a CAD export, for the layer tools.

  python3 docs/research/verify-layers-fixture.py /tmp/eight/two-layers.pdf

Two optional-content groups, "Red revision" and "Blue revision", each painting a
solid block at a different height inside a `/OC BDC … EMC` wrapper, both ON in the
default view, plus a plain sentence so a lost page is visible. `/OCProperties`
carries `/OCGs`, `/D /ON`, `/D /Order` and one `/Configs` entry — the shape real
exports use, and the one a reader has to agree with to answer "is this layer on?".
"""
import sys
from pathlib import Path

import pikepdf

out = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/eight/two-layers.pdf")
pdf = pikepdf.Pdf.new()
pdf.add_blank_page(page_size=(595, 842))
page = pdf.pages[0]

font = pdf.make_indirect(pikepdf.Dictionary(
    Type="/Font", Subtype="/Type1", BaseFont="/Helvetica", Encoding="/WinAnsiEncoding"))
fonts = pdf.make_indirect(pikepdf.Dictionary(F1=font))


def stream(body: str) -> pikepdf.Stream:
    # Resources live on the page, as they do in a CAD export: a viewer that keeps
    # /Properties at page level must still resolve `/OC0 BDC`.
    return pdf.make_indirect(pikepdf.Stream(pdf, body.encode()))


labels = stream("BT /F1 16 Tf 60 780 Td (TWO LAYER FIXTURE) Tj ET\n"
                "BT /F1 12 Tf 60 200 Td (alice1bravo) Tj ET\n")

layers = []
for name, colour, y in (("Red revision", "1 0 0 rg", 560), ("Blue revision", "0 0 1 rg", 340)):
    oc = pdf.make_indirect(pikepdf.Dictionary(
        Type="/OC", Name=name, ON=True,
        Intent=pikepdf.Array([pikepdf.Name("/View"), pikepdf.Name("/Design")]),
        Usage=pdf.make_indirect(pikepdf.Dictionary(
            View=pdf.make_indirect(pikepdf.Dictionary(Language="EN-US")),
            Print=pdf.make_indirect(pikepdf.Dictionary(DefaultState="/ON", Intent="/Design")),
        )),
    ))
    body = (f"q {colour} 60 {y} 220 120 re f Q\n"
            f"BT /F1 13 Tf 70 {y + 135} Td ({name} label) Tj ET\n")
    item = stream(f"/OC0 BDC\n{body}EMC\n")
    item["/Properties"] = pdf.make_indirect(pikepdf.Dictionary(OC0=oc))
    item["/Resources"] = pdf.make_indirect(pikepdf.Dictionary(Font=fonts))
    layers.append((name, oc, item))

page["/Resources"] = pdf.make_indirect(pikepdf.Dictionary(
    Font=fonts,
    Properties=pdf.make_indirect(pikepdf.Dictionary(OC0=layers[0][1])),
    ProcSet=pikepdf.Array([pikepdf.Name("/PDF"), pikepdf.Name("/Text"), pikepdf.Name("/ImageC")]),
))
page["/Contents"] = pikepdf.Array([labels, *[item for _, _, item in layers]])
ocgs = [oc for _, oc, _ in layers]
pdf.Root["/OCProperties"] = pdf.make_indirect(pikepdf.Dictionary(
    OCGs=pikepdf.Array(ocgs),
    D=pdf.make_indirect(pikepdf.Dictionary(
        BaseState="/ON",
        ON=pikepdf.Array(ocgs), Order=pikepdf.Array(ocgs), RBMode="/NotNested")),
    Configs=pikepdf.Array([pdf.make_indirect(pikepdf.Dictionary(
        Name="(View A)", ON=pikepdf.Array([ocgs[0]])))
    ]),
))
pdf.save(out)
print(f"wrote {out}: OCGs {[str(o['/Name']) for o in ocgs]}, both /ON, one /Configs entry")
