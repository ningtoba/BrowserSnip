#!/usr/bin/env python3
"""Measure a flatten pair with outside readers and print the before/after table.

Usage: flatten-readers.py BEFORE.pdf AFTER.pdf

Nothing here imports the app: every number is read out of the file by MuPDF or
pypdf, because the claim under test is "what the bytes say", not "what the tool
said".
"""
import json
import re
import sys

import pymupdf
from pypdf import PdfReader
from pypdf.generic import ArrayObject, DictionaryObject

BOX_RE = re.compile(r"/Rect\s*\[([^\]]*)\]")


def annotate_shape(pdf, pno, xref):
    """The annotation dictionary as text, for the widget/field columns."""
    return str(pdf.xref_object(int(xref))).replace("\n", " ")


def ink_in(pdf, page_index, rect, dpi=150, annots=True):
    """Fraction of one rectangle that is not paper, measured off the render.

    `annots=False` asks the reader to paint the **page content only**, which is the
    half that tells a bake from a live mark: a flattened file measures the same
    with and without annotations, a file that merely still has them measures ink
    with them and paper without.

    `rect` arrives in PDF user space (origin bottom-left, as `/Rect` is written);
    MuPDF's `clip` is in displayed page space (origin top-left, after `/Rotate`),
    so the box is carried across by the page's own matrices. Feeding `/Rect`
    straight to `clip` measures a band of blank paper and reports 0 % for a mark
    that is plainly on the page.
    """
    page = pdf[page_index]
    box = pymupdf.Rect(*rect) * page.transformation_matrix * page.rotation_matrix
    box = box & page.rect
    if box.is_empty or box.width < 1 or box.height < 1:
        return None
    pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY, clip=box, annots=annots)
    samples = pix.samples
    if not samples:
        return None
    dark = sum(1 for byte in samples if byte < 250)
    return round(100.0 * dark / len(samples), 2)


def mark_boxes(pdf):
    """Every annotation's own box, with its kind: the regions to compare across."""
    boxes = []
    for pno in range(pdf.page_count):
        for entry in pdf.page_annot_xrefs(pno) or []:
            text = annotate_shape(pdf, pno, int(entry[0]))
            kind = "?"
            for name in ("Widget", "Link", "Popup", "Highlight", "Underline", "StrikeOut", "Ink",
                         "Square", "Circle", "Line", "Text", "FreeText", "Stamp", "Caret", "Polygon"):
                if "/Subtype /" + name in text or "/Subtype/" + name in text:
                    kind = name
                    break
            match = BOX_RE.search(text)
            if not match:
                continue
            numbers = [float(value) for value in match.group(1).split()]
            if len(numbers) != 4:
                continue
            boxes.append({"page": pno, "kind": kind, "rect": numbers})
    return boxes


def dump(path, boxes=None):
    out = {"path": path}
    pdf = pymupdf.open(path)
    out["pages"] = pdf.page_count
    marks = []
    links = 0
    widgets = []
    per_page_xobjects = []
    ink = []
    ink_content_only = []
    for pno in range(pdf.page_count):
        page = pdf[pno]
        for annot in page.annots():
            marks.append({"page": pno + 1, "kind": annot.type[1], "rect": [round(v, 1) for v in annot.rect]})
        links += len(page.get_links() or [])
        for entry in pdf.page_annot_xrefs(pno) or []:
            text = annotate_shape(pdf, pno, int(entry[0]))
            if "/Widget" in text:
                widgets.append({"page": pno + 1, "obj": text[:240]})
        per_page_xobjects.append(sorted(name for _r, name, _g, _t in pdf.get_page_xobjects(pno)))
        pix = page.get_pixmap(dpi=72, colorspace=pymupdf.csGRAY)
        samples = pix.samples
        dark = sum(1 for byte in samples if byte < 250)
        ink.append(round(100.0 * dark / len(samples), 2))
        no_annot = page.get_pixmap(dpi=72, colorspace=pymupdf.csGRAY, annots=False)
        bare = no_annot.samples
        ink_content_only.append(round(100.0 * sum(1 for byte in bare if byte < 250) / len(bare), 2))
    out["annots"] = marks
    out["annot_count"] = len(marks)
    out["links"] = links
    out["widgets"] = widgets
    # Each mark's own box, measured the same way in both files: the ink has to be
    # where the annotation was, whether it arrived as a mark or as page content.
    # `boxes` comes from the input file, because the flattened output has no
    # annotations left to read the boxes out of.
    mark_boxes_list = mark_boxes(pdf) if boxes is None else boxes
    out["mark_boxes"] = mark_boxes_list
    out["ink_at_marks"] = [
        {
            "kind": box["kind"],
            "page": box["page"],
            "displayed": ink_in(pdf, box["page"], box["rect"]),
            "content_only": ink_in(pdf, box["page"], box["rect"], annots=False),
        }
        for box in mark_boxes_list
    ]
    out["xobjects"] = per_page_xobjects
    out["ink_pct"] = ink
    out["ink_pct_content_only"] = ink_content_only

    acroform = pdf.xref_get_key(pdf.pdf_catalog(), "AcroForm")
    out["has_acroform"] = acroform[0] != "null"
    if acroform[0] == "xref":
        acro_xref = int(acroform[1].split()[0])
        out["acroform_obj"] = str(pdf.xref_object(acro_xref, 1)).replace("\n", " ")
        out["need_appearances"] = pdf.xref_get_key(acro_xref, "NeedAppearances")[1]
    else:
        out["acroform_obj"] = acroform[1].replace("\n", " ")
    out["text"] = [str(pdf[p].get_text()).strip().replace("\n", " ")[:300] for p in range(pdf.page_count)]
    pdf.close()

    reader = PdfReader(path)
    root = reader.trailer["/Root"]
    out["pypdf_fields"] = sorted((reader.get_fields() or {}).keys())
    fields = []
    acro = root.get("/AcroForm") if isinstance(root, DictionaryObject) else None
    if acro is not None:
        acro = acro.get_object()
        listed = acro.get("/Fields") or ArrayObject()
        for item in listed:
            obj = item.get_object()
            fields.append({
                "name": str(obj.get("/T")),
                "FT": str(obj.get("/FT")),
                "Ff": str(obj.get("/Ff")),
                "kids": len(obj.get("/Kids") or []),
                "value": str(obj.get("/V")),
            })
    out["pypdf_acroform_fields"] = fields
    return out


def main():
    before = dump(sys.argv[1])
    after = dump(sys.argv[2], before["mark_boxes"])
    print(json.dumps({"before": before, "after": after}, indent=2))


if __name__ == "__main__":
    main()
