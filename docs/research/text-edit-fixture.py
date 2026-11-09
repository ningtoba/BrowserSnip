#!/usr/bin/env python3
"""Build the `edit-pdf-text` fidelity corpus: one PDF per real deletion cause.

  python3 docs/research/text-edit-fixture.py /tmp/tf

Every sheet is a *document*, not a unit fixture: a different producer makes each
one, because the question this row has to answer is what the engine meets in the
wild. What it writes, and why each shape is the real thing:

  sample.pdf      the campaign's CV page (copied in when present) — non-embedded
                  standard-14 faces, one `(text) Tj` per run, RGB ink, vector
                  rules and a logo image.
  distilled.pdf   the same page through `gs -sDEVICE=pdfwrite`: what any printer
                  or Distiller emits — page content wrapped in a Form XObject,
                  fonts subsetted.
  kerned.pdf      sample.pdf's show operators rewritten into kerned `TJ` arrays
                  with per-glyph offsets: the shape Word/LaTeX output takes.
  scan.pdf        a 200 dpi raster of a text page with an **invisible** text
                  layer (render mode 3): searchable, selectable, painted by
                  pixels the engine cannot delete.
  type3.pdf       a hand-built Type3 font whose CharProcs paint rectangles.
  cid.pdf         PyMuPDF with a TrueType face + `subset_fonts()` → Type0 /
                  Identity-H / CIDFontType2 **subsubset** with ToUnicode. This is
                  also the shape of this app's own text output, so a re-edit of a
                  file we wrote meets it.
  paper.pdf       tinted paper with artwork behind the words: the case a white
                  patch gets wrong.

Prints JSON describing the structure it wrote, so the probe's cause table is
checked against the fixture instead of trusted.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

import pikepdf
import pymupdf

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
# The campaign's reference document, where every other row's harness reads it too.
SAMPLE = os.path.join(tempfile.gettempdir(), "sample.pdf")

TEXT_LINES = [
    "Talently Self-Assessment",
    "Muhammad Luqman Hakim Razlan",
    "Submitted May 18, 2026 - 04:12 PM",
    "PERSONAL INFORMATION",
    "luqmanhakim.dev@gmail.com",
    "Built the reporting pipeline for the analytics group and shipped it in six weeks.",
    "Keywords: PDF, text layer, kerning, subsetting, Form XObject, Type3 glyphs.",
]


def save(doc, path):
    """`save` takes different arguments in the two libraries this rig drives."""
    if isinstance(doc, pikepdf.Pdf):
        doc.save(path)
    else:
        doc.save(path, garbage=3, deflate=True)
    return path


def fixture_sample(out):
    dest = os.path.join(out, "sample.pdf")
    if os.path.exists(SAMPLE):
        shutil.copyfile(SAMPLE, dest)
        return dest
    doc: pymupdf.Document = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    for i, line in enumerate(TEXT_LINES):
        page.insert_text((50, 90 + i * 26), line, fontsize=11, fontname="helv")
    return save(doc, dest)


def fixture_distilled(out, src):
    dest = os.path.join(out, "distilled.pdf")
    subprocess.run(
        [
            "gs", "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=pdfwrite",
            "-dPDFSETTINGS=/prepress", "-dEmbedAllFonts=true", "-dSubsetFonts=true",
            f"-sOutputFile={dest}", src,
        ],
        check=True,
    )
    return dest


def fixture_form(out, src):
    """Wrap every page's content in a Form XObject — Word, InDesign, TeX.dvips.

    The form carries the page's own `/Resources` and a `/Matrix` that shifts it,
    which is the part that matters: a walker that reads `/Contents` alone sees the
    `Do` and none of the words, and a walker that does not compose the form's CTM
    puts them in the wrong place. Odd pages get a second, nested level.
    """
    pdf = pikepdf.open(src)
    for index, page in enumerate(pdf.pages):
        contents = page.get("/Contents")
        if contents is None:
            continue
        items = list(contents) if isinstance(contents, pikepdf.Array) else [contents]
        data = b"\n".join(item.read_bytes() for item in items)
        box = page.get("/CropBox")
        if box is None:
            box = pikepdf.Array([0, 0, 595, 842])
        resources = page.get("/Resources")
        if resources is None:
            resources = pikepdf.Dictionary()
        xobjects = pikepdf.Dictionary()

        if index % 2 == 0:
            name = f"/Fx{index}"
            xobjects[name] = make_form(pdf, data, box, resources, 0.0)
            body = f"q 1 0 0 1 0 0 cm {name} Do Q\n".encode()
        else:
            # Nested: the outer form's only content is a `Do` of the inner one,
            # and the inner one is nudged 0.5 pt by its own `/Matrix`.
            inner_name = f"/Fx{index}i"
            outer_name = f"/Fx{index}"
            xobjects[inner_name] = make_form(pdf, data, box, resources, 0.5)
            inner_refs = pikepdf.Dictionary({inner_name: xobjects[inner_name]})
            nested = pikepdf.Stream(
                pdf, f"q {inner_name} Do Q".encode(),
                {
                    "/Type": pikepdf.Name("/XObject"),
                    "/Subtype": pikepdf.Name("/Form"),
                    "/BBox": pikepdf.Array([float(box[0]), float(box[1]), float(box[2]), float(box[3])]),
                    "/Resources": pikepdf.Dictionary({"/XObject": inner_refs}),
                },
            )
            pdf.objects.append(nested)
            xobjects[outer_name] = nested
            body = f"q 1 0 0 1 0 0 cm {outer_name} Do Q\n".encode()

        page.Contents = pikepdf.Stream(pdf, body)
        page.Resources = pikepdf.Dictionary({"/XObject": xobjects})
    dest = os.path.join(out, "forms.pdf")
    pdf.save(dest)
    return dest


def make_form(pdf, body, box, resources, dx):
    """A `/Form` XObject holding `body` at the page's own box, shifted by `dx`."""
    form = pikepdf.Stream(
        pdf, body,
        {
            "/Type": pikepdf.Name("/XObject"),
            "/Subtype": pikepdf.Name("/Form"),
            "/BBox": pikepdf.Array([float(box[0]), float(box[1]), float(box[2]), float(box[3])]),
            "/Matrix": pikepdf.Array([1, 0, 0, 1, dx, 0]),
            "/Resources": resources,
        },
    )
    pdf.objects.append(form)
    return form


SHOW_RE = re.compile(rb"\(((?:\\.|[^\\()])*)\)\s*Tj")


def kern_array(match):
    """`(text) Tj` → `[(t) -7 (e) -14 …] TJ`, one element per glyph."""
    parts = []
    for index, byte in enumerate(match.group(1)):
        if parts:
            parts.append(str(-((index * 7) % 23)).encode())
        parts.append(b"(" + bytes([byte]) + b")")
    return b"[" + b" ".join(parts) + b"] TJ"


def fixture_kerned(out, src):
    pdf = pikepdf.open(src)
    streams = 0
    for page in pdf.pages:
        contents = page.get("/Contents")
        if contents is None:
            continue
        items = list(contents) if isinstance(contents, pikepdf.Array) else [contents]
        for item in items:
            stream = pikepdf.Object.parse(item, pdf=pdf) if False else item
            data = stream.read_bytes()
            new = SHOW_RE.sub(kern_array, data)
            if new != data:
                stream.write(new)
                streams += 1
    dest = os.path.join(out, "kerned.pdf")
    pdf.save(dest)
    return dest, streams


def fixture_scan(out):
    """A raster page with an invisible (mode 3) text layer on top."""
    text: pymupdf.Document = pymupdf.open()
    sheet = text.new_page(width=595, height=842)
    for i, line in enumerate(TEXT_LINES):
        sheet.insert_text((50, 90 + i * 26), line, fontsize=12, fontname="helv")
    png_path = os.path.join(out, "_scan.png")
    sheet.get_pixmap(dpi=200).save(png_path)

    doc: pymupdf.Document = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_image(page.rect, filename=png_path)
    for i, line in enumerate(TEXT_LINES):
        page.insert_text((50, 90 + i * 26), line, fontsize=12, fontname="helv", render_mode=3)
    os.remove(png_path)
    return save(doc, os.path.join(out, "scan.pdf"))


def fixture_type3(out):
    """One-page PDF whose only font is a hand-built Type3."""
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(595, 842))
    page = pdf.pages[0]
    char_procs = {}
    for letter in b"AB":
        char_procs["/" + chr(letter)] = pikepdf.Stream(pdf, b"q 0 0 1 rg 1 1 40 60 re f Q\n")
    font = pikepdf.Dictionary({
        "/Type": pikepdf.Name("/Font"),
        "/Subtype": pikepdf.Name("/Type3"),
        "/BaseFont": pikepdf.Name("/TypeThreeFixture"),
        "/FontMatrix": pikepdf.Array([0.001, 0, 0, 0.001, 0, 0]),
        "/FontBBox": pikepdf.Array([0, 0, 40, 60]),
        "/FirstChar": 65,
        "/LastChar": 66,
        "/Widths": pikepdf.Array([50, 50]),
        "/CharProcs": pikepdf.Dictionary(char_procs),
        "/Encoding": pikepdf.Dictionary({
            "/Type": pikepdf.Name("/Encoding"),
            "/Differences": pikepdf.Array([65, pikepdf.Name("/A"), pikepdf.Name("/B")]),
        }),
    })
    page.Resources = pikepdf.Dictionary({"/Font": pikepdf.Dictionary({"/T3": font})})
    page.Contents = pikepdf.Stream(pdf, b"BT /T3 40 Tf 60 700 Td (AABB) Tj ET\n")
    return save(pdf, os.path.join(out, "type3.pdf"))


def fixture_cid(out):
    """Type0 / Identity-H subsubset + ToUnicode — this app's own output shape."""
    face = os.path.join(REPO, "public", "fonts", "NotoSans-Regular.ttf")
    doc: pymupdf.Document = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.insert_font(fontname="noto", fontfile=face)
    for i, line in enumerate(TEXT_LINES):
        page.insert_text((50, 90 + i * 26), line, fontsize=12, fontname="noto")
    doc.subset_fonts()
    return save(doc, os.path.join(out, "cid.pdf"))


def fixture_paper(out):
    """Tinted paper with artwork behind the words."""
    doc: pymupdf.Document = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    page.draw_rect(pymupdf.Rect(30, 60, 560, 260), color=None, fill=(0.86, 0.90, 0.95))
    page.draw_line(pymupdf.Point(40, 120), pymupdf.Point(540, 180),
                   color=(0.7, 0.2, 0.2), width=6)
    for i, line in enumerate(TEXT_LINES[:4]):
        page.insert_text((50, 100 + i * 26), line, fontsize=13, fontname="helv",
                         color=(0.1, 0.1, 0.35))
    return save(doc, os.path.join(out, "paper.pdf"))


def structure(path):
    doc = pymupdf.open(path)
    forms = count_forms(path)
    fonts = {}
    stats = {"file": os.path.basename(path), "pages": doc.page_count, "forms": forms,
             "images": 0, "tj": 0, "TJ": 0, "invisible": 0}
    for page in doc:
        for f in page.get_fonts(full=True):
            fonts[f[3] + f[2]] = {"base": f[3], "subtype": f[2], "ext": f[4]}
        raw = b"".join(doc.xref_stream(x) or b"" for x in (page.get_contents() or []))
        stats["tj"] += len(re.findall(rb"\bTj\b", raw))
        stats["TJ"] += len(re.findall(rb"\bTJ\b", raw))
        stats["invisible"] += len(re.findall(rb"\b3 Tr\b", raw))
        stats["images"] += len(page.get_images(full=True))
    stats["fonts"] = list(fonts.values())
    doc.close()
    return stats


def count_forms(path):
    """`/Form` XObjects in the file — every indirect object, nested included."""
    pdf = pikepdf.open(path)
    total = 0
    for entry in pdf.objects:
        if is_form(entry):
            total += 1
    return total


def is_form(entry):
    return (
        entry is not None
        and hasattr(entry, "keys")
        and str(entry.get("/Subtype", "")) == "/Form"
    )


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "tf")
    os.makedirs(out, exist_ok=True)
    sample = fixture_sample(out)
    made = [sample, fixture_distilled(out, sample), fixture_form(out, sample)]
    kerned, streams = fixture_kerned(out, sample)
    made.append(kerned)
    made += [fixture_scan(out), fixture_type3(out), fixture_cid(out), fixture_paper(out)]
    print(json.dumps({"kernedStreams": streams,
                      "fixtures": [structure(p) for p in made]}, indent=2))


if __name__ == "__main__":
    main()
