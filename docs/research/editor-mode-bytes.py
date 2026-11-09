#!/usr/bin/env python3
"""Read a merged-editor export back and say what the FILE holds.

  python3 docs/research/editor-mode-bytes.py /tmp/merged-doc.pdf
  python3 docs/research/editor-mode-bytes.py /tmp/merged-doc.pdf.text.pdf --text

The surface's layer list is not the evidence: a mark can be on screen and missing
from the bytes (the zero-ink bowtie this campaign keeps re-measuring), and a
rewrite can be reported by the pane and never written. So this script opens the
produced file with PyMuPDF and counts what is really there.

  annots   every annotation object on every page, with subtype and rect
  ink      non-white coverage of the page the mark landed on, at 110 dpi
  words    for --text: is the replacement string in the file, and is the
           sentence it replaced still there underneath (a covered-up edit)

`--want-annot N` and `--want-word W` turn the printout into a check that exits 1.
"""
import argparse
import sys

import pymupdf


def annots(doc):
    rows = []
    for pno, page in enumerate(doc):
        for a in page.annots() or []:
            rows.append({"page": pno + 1, "type": a.type[1], "rect": tuple(round(v, 1) for v in a.rect)})
    return rows


def ink(page, zoom=110 / 72):
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), colorspace=pymupdf.csGRAY)
    data = pix.samples
    dark = sum(1 for b in data if b < 200)
    return {"w": pix.width, "h": pix.height, "dark": dark, "pct": round(100 * dark / len(data), 2)}


def words_of(page) -> str:
    """The page's own text layer, as one string (`get_text("text")` is the str form)."""
    return str(page.get_text("text"))


def all_words(doc) -> str:
    return "\n".join(words_of(page) for page in doc)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("--text", action="store_true", help="judge a text-mode export")
    ap.add_argument("--want-annot", type=int, default=None)
    ap.add_argument("--want-word", default=None)
    ap.add_argument("--gone-word", default=None)
    args = ap.parse_args()

    doc = pymupdf.open(args.pdf)
    rows = annots(doc)
    print(f"{args.pdf}: {len(doc)} page(s), {len(rows)} annotation(s)")
    for r in rows:
        print(f"  p{r['page']} {r['type']} rect={r['rect']}")
    words = words_of(doc[0])
    line = words.split("\n")[0][:60] if words else ""
    print(f"  page 1 first line: {line!r}")
    print(f"  page 1 ink: {ink(doc[0])}")

    failed = []
    if args.want_annot is not None and len(rows) != args.want_annot:
        failed.append(f"annotation count is {len(rows)}, asked for {args.want_annot}")
    if args.want_word:
        where = all_words(doc)
        if args.want_word not in where:
            failed.append(f"{args.want_word!r} is not in the file's words")
        if args.gone_word and args.gone_word in where:
            failed.append(f"{args.gone_word!r} is still in the file — the old glyphs were covered, not deleted")
    if args.text and not args.want_word:
        failed.append("--text should name the word to look for (--want-word)")

    if failed:
        for f in failed:
            print(f"FAIL {f}")
        sys.exit(1)
    print("OK the file says what the surface claimed")


if __name__ == "__main__":
    main()
