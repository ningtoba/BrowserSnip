#!/usr/bin/env python3
"""Judge the `edit-pdf-text` exports off their own pixels, words and faces.

  python3 docs/research/text-edit-measure.py /tmp/tf/out

For every block the probe edited, the same questions are asked of the file
*before* the edit and the file *after* it, with PyMuPDF reading the produced
bytes (never the engine's own report):

  words     is the block's original text still in the file, and is the
            replacement text there instead?
  face      which font object actually paints the replacement — the document's
            own, or a substitution?
  geometry  where and how big the replacement lands, in displayed points
  ink       non-white coverage of the region at 150 dpi, before and after
  patch     a filled rectangle the size of the region that the source file did
            not contain: the failure report drawn as a box

A block is `clean` when the old words are gone, the new words are present, the
ink moved to the glyphs rather than to a solid band, and no patch rectangle was
added. `--json` writes the same rows as JSON next to the table.
"""
import json
import os
import sys
import tempfile

import pymupdf

DPI = 150
# A filled quad this big, in share of the block, is a patch and not a glyph.
PATCH_FILL_SHARE = 0.55


def rect_of(box):
    return pymupdf.Rect(box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"])


def union(boxes):
    rect = pymupdf.Rect()
    for box in boxes:
        rect |= rect_of(box)
    return rect


def words_in(page, rect):
    try:
        return " ".join(w[4] for w in page.get_text("words", clip=rect))
    except Exception:
        return ""


def spans_in(page, rect):
    out = []
    data = page.get_text("dict", clip=rect, flags=pymupdf.TEXT_PRESERVE_LIGATURES | pymupdf.TEXT_PRESERVE_WHITESPACE)
    for block in data.get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                if span.get("text", "").strip():
                    out.append(span)
    return out


def ink_ratio(page, rect):
    """Non-white share of the region, sampled off the rasterised bitmap."""
    if rect.is_empty or rect.width <= 0 or rect.height <= 0:
        return 0.0
    pix = page.get_pixmap(dpi=DPI, clip=rect, colorspace=pymupdf.csRGB)
    data = pix.samples
    stride = pix.width * pix.height
    if stride == 0:
        return 0.0
    dark = 0
    for i in range(stride):
        r, g, b = data[i * pix.n], data[i * pix.n + 1], data[i * pix.n + 2]
        if r < 245 or g < 245 or b < 245:
            dark += 1
    return dark / stride


def filled_quads(page):
    """Solid rectangles the page paints, with their colour — patches live here."""
    quads = []
    for shape in page.get_drawings():
        if shape.get("type") not in ("f", "fs"):
            continue
        fill = shape.get("fill")
        for item in shape["items"]:
            if item[0] == "re":
                rect = item[1]
                quads.append({"rect": pymupdf.Rect(rect), "fill": fill})
    return quads


def normalise(colour):
    if colour is None:
        return None
    return tuple(round(float(c), 3) for c in colour)


def patches_added(before, after, rect):
    """Quads the edit added that cover a meaningful share of the block."""
    known = {}
    for quad in before:
        key = (round(quad["rect"].x0, 1), round(quad["rect"].y0, 1),
               round(quad["rect"].x1, 1), round(quad["rect"].y1, 1), normalise(quad["fill"]))
        known[key] = known.get(key, 0) + 1
    added = []
    area = max(1.0, rect.get_area())
    for quad in after:
        hit = quad["rect"] & rect
        if hit.is_empty or hit.get_area() / area < PATCH_FILL_SHARE:
            continue
        key = (round(quad["rect"].x0, 1), round(quad["rect"].y0, 1),
               round(quad["rect"].x1, 1), round(quad["rect"].y1, 1), normalise(quad["fill"]))
        if known.get(key, 0) > 0:
            known[key] -= 1
            continue
        added.append({"rect": quad["rect"], "fill": normalise(quad["fill"]),
                      "share": round(hit.get_area() / area, 3)})
    return added


def share_of(text, needles):
    """How much of `text` is accounted for by the words in `needles`."""
    words = [w for w in text.split() if w]
    if not words:
        return 0.0, ""
    pool = " ".join(needles)
    left = [w for w in words if w not in pool]
    return len(left) / len(words), " ".join(left[:6])


def measure(outdir):
    rows = []
    for name in sorted(os.listdir(outdir)):
        if not name.endswith(".json"):
            continue
        stem = name[:-5]
        before_path = os.path.join(outdir, f"{stem}-before.pdf")
        after_path = os.path.join(outdir, f"{stem}-after.pdf")
        if not (os.path.exists(before_path) and os.path.exists(after_path)):
            continue
        with open(os.path.join(outdir, name), encoding="utf-8") as fh:
            plan = json.load(fh)
        before = pymupdf.open(before_path)
        after = pymupdf.open(after_path)
        source_fonts = {f[3] for p in before for f in p.get_fonts(full=True)}
        for entry in plan.get("perBlock", []):
            page_no = entry["page"]
            if page_no > before.page_count or page_no > after.page_count:
                continue
            bpage, apage = before[page_no - 1], after[page_no - 1]
            rect = union(entry["deletion"])
            old_words = words_in(bpage, rect)
            new_words = words_in(apage, rect)
            spans = spans_in(apage, rect)
            replacements = [entry.get("replacement", "")]
            residual_share, residual_text = share_of(new_words, replacements + [entry.get("text", "")])
            own_font = any(span["font"] in source_fonts or "+" in span["font"] for span in spans)
            rows.append({
                "file": stem,
                "page": page_no,
                "engine": {
                    "removed": entry["removed"],
                    "leftover": entry["leftover"],
                    "nothingRemoved": entry["nothingRemoved"],
                    "needsRaster": entry["needsRaster"],
                    "lostOutside": entry.get("lostOutside", 0),
                },
                "old": old_words[:48],
                "new": new_words[:48],
                "wanted": (replacements[0] or "")[:48],
                "oldSurvives": old_words.strip() != "" and entry.get("text", "")[:12] in old_words,
                "newPresent": bool(replacements[0]) and norm(replacements[0]) in norm(new_words),
                "residualShare": round(residual_share, 3),
                "residualText": residual_text,
                "faces": sorted({s["font"] for s in spans}),
                "facesFromSource": bool(spans) and all(
                    s["font"] in source_fonts or s["font"].split("+")[0] in
                    {f.split("+")[-1] for f in source_fonts} for s in spans),
                "sizes": sorted({round(s["size"], 2) for s in spans}),
                "fontSize": entry.get("fontSize"),
                "inkBefore": round(ink_ratio(bpage, rect), 4),
                "inkAfter": round(ink_ratio(apage, rect), 4),
                "patches": [
                    {"rect": [round(p["rect"].x0, 1), round(p["rect"].y0, 1),
                              round(p["rect"].x1, 1), round(p["rect"].y1, 1)],
                     "fill": p["fill"], "share": p["share"]}
                    for p in patches_added(filled_quads(bpage), filled_quads(apage), rect)
                ],
                "ownFont": own_font,
            })
        before.close()
        after.close()
    return rows


def norm(text):
    return " ".join(str(text).split()).strip()


def verdict(row):
    if row["engine"]["nothingRemoved"]:
        return "not-removed"
    if row["patches"]:
        return "patched"
    if not row["newPresent"]:
        return "text-missing"
    if row["residualShare"] > 0.05:
        return "residual-text"
    if not row["ownFont"]:
        return "substituted"
    return "clean"


def report(rows):
    by_file = {}
    for row in rows:
        by_file.setdefault(row["file"], []).append(row)
    print(f"{'file':16} {'blocks':>6} {'clean':>6} {'patched':>8} {'not-rem':>8} "
          f"{'resid':>6} {'missing':>8} {'subst':>6} {'collat>0':>9}")
    for stem, entries in by_file.items():
        counts = dict.fromkeys(("clean", "patched", "not-removed", "residual-text",
                                "text-missing", "substituted"), 0)
        for row in entries:
            counts[verdict(row)] += 1
        collateral = sum(1 for r in entries if r["engine"]["lostOutside"] > 0)
        print(f"{stem:16} {len(entries):6} {counts['clean']:6} {counts['patched']:8} "
              f"{counts['not-removed']:8} {counts['residual-text']:6} "
              f"{counts['text-missing']:8} {counts['substituted']:6} {collateral:9}")
    return by_file


def main():
    outdir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "tf", "out")
    rows = measure(outdir)
    by_file = report(rows)
    if "--json" in sys.argv:
        with open(os.path.join(outdir, "measured.json"), "w") as fh:
            json.dump(rows, fh, indent=2, default=str)
    if "--examples" in sys.argv:
        for stem, entries in by_file.items():
            for row in entries[:3]:
                print(json.dumps({"file": stem, "verdict": verdict(row), **{
                    k: row[k] for k in ("old", "new", "wanted", "faces", "sizes",
                                        "inkBefore", "inkAfter", "patches", "engine",
                                        "residualText")}}, indent=2, default=str))
    print(f"\n{len(rows)} blocks measured across {len(by_file)} files")


if __name__ == "__main__":
    main()
