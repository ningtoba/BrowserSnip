"""Read a `font-to-outline` run's bytes with engines that are not the producer.

    python3 font-outline-readers.py <input.pdf> <produced.pdf> [<produced2.pdf> …]

Five readers, each named with its version in the header it prints: PyMuPDF (the
MuPDF library), pypdf, poppler's `pdftotext`/`pdfinfo`, and Ghostscript itself
opening and rasterising the file. A file that came back *unchanged* fails the
same rows a blank page would, which is the point: "outlined" is measured as text
that can no longer be extracted, glyphs that now arrive as vector paths, page
count and page boxes intact, and ink still on the page.
"""
import subprocess
import sys

import pymupdf
import pypdf

DPI = 72


def ink_pct(page):
    pix = page.get_pixmap(dpi=DPI)
    n = pix.n
    data = pix.samples
    lit = sum(
        1 for i in range(0, len(data), n) if data[i] != 255 or data[i + 1] != 255 or data[i + 2] != 255
    )
    return 100.0 * lit / (pix.width * pix.height)


def describe(path):
    print(f"\n=== {path}")
    doc = pymupdf.open(path)
    print(f"    mupdf      : open ok, pages {doc.page_count}, needs_pass {doc.needs_pass}")
    for index in range(doc.page_count):
        page = doc[index]
        words = "".join(page.get_text(option="text") or [])
        # `get_images` lists the image XObjects a page's own resources hold; after
        # a rewrite the picture can live inside a Form XObject and still paint.
        # Both counts are printed so "the image is gone" is a claim about pixels,
        # not about where the resource dictionary happens to sit.
        painted = page.get_image_info(xrefs=True)
        print(
            f"    p{index + 1}        : size ({page.rect.width:.2f}, {page.rect.height:.2f}) rotate {page.rotation}"
            f" | text chars {len(words.strip())}"
            f" | fonts {sorted({f[3] for f in page.get_fonts(full=True)})}"
            f" | images listed {len(page.get_images(full=True))} / painted {len(painted)}"
            f" | vector paths {len(page.get_drawings())}"
            f" | ink {ink_pct(page):.2f}%"
            f" | annots {len(list(page.annots()))}"
        )
    doc.close()

    reader = pypdf.PdfReader(path)
    sample = (reader.pages[0].extract_text() or "").strip()
    print(
        f"    pypdf      : open ok, pages {len(reader.pages)}"
        f", page 1 mediabox {reader.pages[0].mediabox}, text chars {len(sample)}"
    )
    text = subprocess.run(["pdftotext", path, "-"], capture_output=True, text=True)
    printable = "".join(ch for ch in text.stdout if ch.isprintable())
    print(f"    pdftotext  : exit {text.returncode}, characters {len(printable.strip())}")
    info = subprocess.run(["pdfinfo", path], capture_output=True, text=True)
    sizes = [line.split(" ", 1)[1].strip() for line in info.stdout.splitlines() if line.startswith("Page size")]
    print(f"    pdfinfo    : exit {info.returncode}, page sizes {sizes}")
    gs = subprocess.run(
        ["gs", "-o", "null", "-sDEVICE=nullpage", "-dNOPAUSE", "-dBATCH", path],
        capture_output=True,
        text=True,
    )
    print(f"    ghostscript: exit {gs.returncode}{' — ' + gs.stderr.strip().splitlines()[-1] if gs.returncode else ''}")


print("readers:")
print(" ", (pymupdf.__doc__ or "PyMuPDF").strip())
print("  pypdf", pypdf.__version__)
for tool in ("pdftotext", "pdfinfo"):
    out = subprocess.run([tool, "-v"], capture_output=True, text=True)
    print(" ", tool, (out.stderr or out.stdout).strip().splitlines()[0])
out = subprocess.run(["gs", "--version"], capture_output=True, text=True)
print("  gs", out.stdout.strip())
print(f"  qpdf: {'not installed in this sandbox' if subprocess.run(['bash','-lc','command -v qpdf'],capture_output=True).returncode else 'installed'}")
print(f"  mutool CLI: {'not installed in this sandbox' if subprocess.run(['bash','-lc','command -v mutool'],capture_output=True).returncode else 'installed'} (MuPDF is used through PyMuPDF above)")

for path in sys.argv[1:]:
    describe(path)
