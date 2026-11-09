#!/usr/bin/env python3
"""
Measure a file a real tool produced: ink per character, and what readers say.

  python3 docs/research/font-subset-tool-measure.py /tmp/toolfix/hf-deployed.pdf [--expect "ABC#—Z漢"]

The probe in `font-subset-tool.mjs` types text into a tool's own rail (page
numbers, header and footer, a stamp) and keeps the download. This answers the
only two questions that matter about it:

* **does each character paint?** MuPDF reads the page, reports a box per
  character, and the non-white pixels inside that box are counted at `--dpi`
  (150 by default, the same instrument as `font-subset-measure.py`). A character
  with ink 0 and text that extracts is the report this whole exercise exists to
  kill: "the page is blank but copying works".
* **do the readers accept the embedded program?** the `/Type0` fonts are pulled
  out and read the way a viewer reads them — `/ToUnicode` for the codes,
  `/CIDToGIDMap` for the glyphs, the `/FontFile*` program audited against its own
  glyph records (TrueType) or its own header (CFF) — and MuPDF's warnings while
  the page was drawn are printed verbatim.
"""
import argparse
import importlib.util
import json
import os
import sys

import pymupdf

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("font_subset_measure", os.path.join(HERE, "font-subset-measure.py"))
assert _spec is not None and _spec.loader is not None, f"{HERE}/font-subset-measure.py is not importable"
measure = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(measure)


def report(path, expect, dpi):
    doc = pymupdf.open(path)
    pymupdf.TOOLS.reset_mupdf_warnings()
    boxes = measure.char_boxes(doc)
    ink = measure.ink_per_box(doc, boxes, dpi)
    warnings = (pymupdf.TOOLS.mupdf_warnings() or "").strip()
    fonts = {}
    for page in range(doc.page_count):
        for base, info in measure.embedded_fonts(doc, page).items():
            fonts.setdefault(base, info)
    text = " ".join(str(doc[i].get_text()) for i in range(doc.page_count))
    doc.close()

    programs = []
    loca_problems = []
    cff_problems = []
    for info in fonts.values():
        kind, font, error, size = measure.parse_program(info)
        programs.append(
            f"{info['base']}: {info['programKey']} holding a {kind or 'unreadable'} program of {size} B, "
            f"descendant {info['subtype']}, fontTools {'parses' if font else 'FAILS: ' + str(error)}"
        )
        if font is not None and "glyf" in font:
            audit = measure.audit_loca(font)
            if audit:
                loca_problems.append(f"{info['base']}: {audit['bytes']}")
        if kind == "CFF":
            audit = measure.audit_cff_header(bytes(info["program"]))
            if audit:
                cff_problems.append(f"{info['base']}: {audit['bytes']}")

    wanted = list(expect) if expect else sorted(ink)
    rows = [(ch, ink.get(ch, None), ch in text.replace(" ", "")) for ch in wanted if ch.strip()]
    print(f"{path}\n  {len(boxes)} characters carry ink measurements, {len(fonts)} embedded face(s)\n")
    for ch, px, extracted in rows:
        verdict = "paints" if px else ("no outline in the face" if px == 0 and not extracted else "BLANK")
        print(f"  {ch!r:6} ink {str(px):>7}  extracts {str(extracted):5}  {verdict if px != 0 else 'BLANK'}")
    missing = [ch for ch, px, _ in rows if px is None]
    blank = [ch for ch, px, _ in rows if px == 0]
    print(f"\n  characters asked about: {len(rows)}  blank: {len(blank)} {''.join(blank) if blank else ''}")
    if missing:
        print(f"  not found in the file at all: {''.join(missing)}")
    for line in programs:
        print(f"  {line}")
    for line in loca_problems:
        print(f"  loca disagrees: {line}")
    for line in cff_problems:
        print(f"  CFF header disagrees: {line}")
    if warnings:
        print(f"  MuPDF: {warnings.splitlines()[0]}")
    else:
        print("  MuPDF: no warnings")
    return {"file": os.path.basename(path), "blank": blank, "missing": missing,
            "rows": [{"char": ch, "ink": px} for ch, px, _ in rows],
            "programs": programs, "loca": loca_problems, "cff": cff_problems,
            "mupdfWarnings": warnings}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("pdfs", nargs="+")
    parser.add_argument("--expect", default="", help="characters the file must paint")
    parser.add_argument("--dpi", type=int, default=150)
    parser.add_argument("--json", default="", help="write the same rows as JSON here")
    args = parser.parse_args()
    out = [report(path, args.expect, args.dpi) for path in args.pdfs]
    if args.json:
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump(out, fh, indent=1)
    failed = any(entry["blank"] or entry["missing"] or entry["loca"] or entry["cff"] or entry["mupdfWarnings"] for entry in out)
    print("\n" + ("FAIL: a character painted nothing, or a reader disagreed" if failed else "OK: every character painted and every reader agreed"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
