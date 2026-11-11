"""Fixtures for the `font-to-outline` proof — see `font-outline-proof.log`.

    python3 font-outline-fixtures.py <outdir>

Three sheets, because the tool has two ways to lie and one way to be silent:

  type.pdf      two pages (A4, then US Letter) of drawn text and nothing else —
                the shape the triage ran, and the case that must lose its text;
  type-art.pdf  the same text plus a picture and vector art — outlining must
                remove the first and keep the other two;
  art-only.pdf  a picture and two vector drawings with **no text at all** — the
                inverse case: there is nothing to outline, so nothing may be lost.

The text is drawn with MuPDF's built-in Helvetica, i.e. a standard-14 reference
with no font program in the file, which is what a plain text page looks like and
what Ghostscript has to substitute a face for before it can outline it.
"""
import os
import sys

import pymupdf

MARK = "OUTLINEPROBE page {page} line {row}"


def pixel_png(path):
    png = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 32, 32))
    for y in range(32):
        for x in range(32):
            png.set_pixel(x, y, (20 + x * 7, 200 - y * 5, 120) if (x + y) % 3 else (240, 20, 20))
    png.save(path)


def page_text(page) -> str:
    """`get_text` is typed as text or a dict/list of blocks, depending on options."""
    extracted = page.get_text("text")
    return extracted if isinstance(extracted, str) else "".join(extracted)


def main(outdir):
    os.makedirs(outdir, exist_ok=True)
    png = os.path.join(outdir, "pixel.png")
    pixel_png(png)

    for name, art in (("type", False), ("type-art", True)):
        doc = pymupdf.open()
        for index, size in enumerate([(595.28, 841.89), (612.0, 792.0)], start=1):
            page = doc.new_page(width=size[0], height=size[1])
            for row in range(1, 5):
                page.insert_text(
                    (54, 110 + (row - 1) * 22),
                    MARK.format(page=index, row=row),
                    fontname="helv",
                    fontsize=14,
                )
            if art:
                page.insert_image(pymupdf.Rect(54, 300, 214, 460), filename=png)
                page.draw_rect(
                    pymupdf.Rect(260, 300, 500, 460),
                    color=(0.8, 0.1, 0.1),
                    fill=(0.2, 0.6, 0.2),
                    width=3,
                )
                page.draw_line(pymupdf.Point(54, 600), pymupdf.Point(520, 700), color=(0, 0, 0.9), width=4)
        doc.save(os.path.join(outdir, f"{name}.pdf"))
        doc.close()

    doc = pymupdf.open()
    page = doc.new_page(width=595.28, height=841.89)
    page.insert_image(pymupdf.Rect(54, 500, 214, 660), filename=png)
    page.draw_rect(pymupdf.Rect(260, 500, 500, 660), color=(0.8, 0.1, 0.1), fill=(0.2, 0.6, 0.2), width=3)
    page.draw_polyline(
        [pymupdf.Point(54, 300), pymupdf.Point(240, 240), pymupdf.Point(430, 320)],
        color=(0, 0, 0.9),
        width=4,
    )
    doc.save(os.path.join(outdir, "art-only.pdf"))
    doc.close()

    for name in ("type", "type-art", "art-only"):
        doc = pymupdf.open(os.path.join(outdir, f"{name}.pdf"))
        print(
            name,
            "pages", doc.page_count,
            "text chars", [len(page_text(doc[i]).strip()) for i in range(doc.page_count)],
            "images painted", [len(doc[i].get_image_info(xrefs=True)) for i in range(doc.page_count)],
            "vector paths", [len(doc[i].get_drawings()) for i in range(doc.page_count)],
        )
        doc.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("usage: font-outline-fixtures.py <outdir>")
    main(sys.argv[1])
