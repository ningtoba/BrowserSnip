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
    """Judge each edited block from the two files, not from the engine's report."""
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
        for entry in plan.get("perBlock", []):
            page_no = entry["page"]
            if page_no > before.page_count or page_no > after.page_count:
                continue
            bpage, apage = before[page_no - 1], after[page_no - 1]
            # Judged on the block's own box: the deletion rects are padded per
            # line and their union spans the gutter between two columns, which
            # counts a neighbour's words as this block's ink.
            region = rect_of(entry["box"]) + (-1, -1, 1, 1)
            box = rect_of(entry["box"])
            old_words = words_in(bpage, region)
            # What the source set this block in, read off the source file.
            source_spans = spans_in(bpage, region)
            source_faces = sorted({s["font"] for s in source_spans})
            replacement = entry.get("replacement", "")
            after_spans = spans_in(apage, box)
            claimed = [e for e in plan.get("expected", []) if e.get("id") == entry.get("id")]
            on_pieces, off_pieces = pieces_placed(
                apage, [e for e in plan.get("expected", []) if e.get("id") == entry.get("id")]
            )
            after_faces = sorted({x["font"] for x in after_spans})
            # Did the block's own words stop existing? Read the whole page back
            # and look for each source word of length >= 4: a fragment of the new
            # text is a tokeniser artefact, an old word found again is a failure.
            replacements = " ".join(
                other.get("replacement", "") for other in plan.get("perBlock", []) if other["page"] == page_no
            )
            residual, residual_text = old_words_surviving(
                entry.get("text", ""), page_text(apage), replacements
            )
            placed = first_line_placement(apage, replacement, box, entry.get("fontSize", 0))
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
                "old": old_words[:44],
                "wanted": replacement[:44],
                "residualShare": round(residual, 3),
                "residualText": residual_text,
                "sourceFaces": source_faces,
                "afterFaces": after_faces,
                "afterPieceFaces": sorted({(p["found"] or {}).get("face", "") for p in on_pieces} - {""}),
                "writerClaimsSource": bool(claimed) and all(e.get("fromSource") for e in claimed),
                "facesUsed": sorted({e.get("face", "") for e in claimed} - {""}),
                "faceKept": bool(on_pieces) and bool(source_faces) and all(
                    (p["found"] or {})["face"] in source_faces
                    for p in on_pieces
                ),
                "fontSize": round(entry.get("fontSize", 0), 2),
                "pieces": len(on_pieces),
                "piecesTotal": len(on_pieces) + len(off_pieces),
                "piecesOff": off_pieces[:3],
                "pieceFaces": sorted({(p["found"] or {}).get("face", "") for p in on_pieces} - {""}),
                "placed": placed,
                "inkBefore": round(ink_ratio(bpage, region), 4),
                "inkAfter": round(ink_ratio(apage, region), 4),
                "patches": [
                    {"rect": [round(p["rect"].x0, 1), round(p["rect"].y0, 1),
                              round(p["rect"].x1, 1), round(p["rect"].y1, 1)],
                     "fill": p["fill"], "share": p["share"]}
                    for p in patches_added(filled_quads(bpage), filled_quads(apage), region)
                ],
            })
        before.close()
        after.close()
    return rows


def page_text(page):
    return norm(page.get_text("text", flags=pymupdf.TEXT_PRESERVE_LIGATURES | pymupdf.TEXT_PRESERVE_WHITESPACE))


def old_words_surviving(old_text, after_text, replacements):
    """
    Share of the block's source words that can still be found in the edited page.

    Word-level, and only words of four letters or more, because the difference
    between "removed" and "covered" is exactly what Ctrl-F answers. A word the
    rewrite *kept* (the editor's own text may repeat the producer's) is not a
    survivor, and neither is a word another block on the page now paints: a line
    box spans the gutter between two columns.
    """
    words = [w for w in norm(old_text).split(" ") if len(w) >= 4 and w not in replacements]
    if not words:
        return 0.0, ""
    left = [w for w in words if w in after_text]
    return len(left) / len(words), " ".join(left[:6])


def page_words(page):
    """
    Every word the page paints, with the size and face of the span that draws it.

    A span's own box is the glyph ink and a word box is the extent of the word, so
    neither contains the other; the two are joined by the span's baseline origin,
    which always sits at or left of the word it starts.
    """
    spans = [
        (pymupdf.Rect(span["bbox"]), span)
        for block in page.get_text("dict", flags=pymupdf.TEXT_PRESERVE_LIGATURES).get("blocks", [])
        for line in block.get("lines", [])
        for span in line.get("spans", [])
    ]
    out = []
    for word in page.get_text("words"):
        box = pymupdf.Rect(word[:4])
        best = None
        for rect, span in spans:
            if norm(word[4]) not in norm(span["text"]):
                continue
            origin = pymupdf.Point(*span["origin"])
            if origin.y < box.y0 - 1 or origin.y > box.y1 + 1:
                continue
            if origin.x > box.x1:
                continue
            distance = box.x0 - origin.x
            if best is None or distance < best[0]:
                best = (distance, span)
        out.append({"box": box, "text": word[4], "span": best[1] if best else None})
    return out


def pieces_placed(page, expected):
    """
    Match each piece the writer laid out against a word the produced file really
    paints, at the place and size the writer asked for.

    A piece is placed when a word with its text starts within 2 pt of the expected
    x, the baseline falls inside the word's box, and the face painting it is
    within 5 % of the expected size. Position and size are what the user judges —
    my text, there, that size — so they are measured off the file, not assumed
    from an operator count.
    """
    words = page_words(page)
    on = []
    off = []
    for piece in expected:
        head = (norm(piece["text"]).split(" ") or [""])[0]
        hit = None
        for word in words:
            if not word["text"].startswith(head):
                continue
            if abs(word["box"].x0 - piece["x"]) > 2:
                continue
            if not (word["box"].y0 - 1 <= piece["baseline"] <= word["box"].y1 + 1):
                continue
            span = word["span"]
            if span is None or abs(span["size"] - piece["size"]) > max(0.4, piece["size"] * 0.05):
                continue
            hit = {
                "x": round(word["box"].x0, 2),
                "y": round(word["box"].y1, 2),
                "face": span["font"],
                "size": round(span["size"], 2),
            }
            break
        (on if hit else off).append(dict(piece, found=hit))
    return on, off


def first_line_placement(page, replacement, box, size):
    """
    Where the replacement really landed: the first word's span, its offset from
    the block's own top-left, and its size against the block's source size.

    Judged on the first word rather than the whole string because a rewrite
    re-wraps: the text below the block's first line is expected to sit lower than
    the box the old words occupied, and that is a reflow to report, not a miss.
    """
    head = (replacement.split() or [""])[0]
    if not head:
        return None
    for block in page.get_text("dict", flags=pymupdf.TEXT_PRESERVE_LIGATURES).get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                text = span.get("text", "")
                if head not in text:
                    continue
                rect = pymupdf.Rect(span["bbox"])
                return {
                    "dx": round(rect.x0 - box.x0, 2),
                    "dy": round(rect.y0 - box.y0, 2),
                    "size": round(span["size"], 2),
                    "face": span["font"],
                    "text": text[:32],
                }
    return None


def norm(text):
    return " ".join(str(text).split()).strip()


def verdict(row):
    """One word for what the produced file says about one edited block."""
    if row["engine"]["nothingRemoved"] or row["residualShare"] > 0.05:
        return "residual" if not row["engine"]["nothingRemoved"] else "not-removed"
    if row["piecesTotal"] == 0:
        return "missing"
    if row["pieces"] < row["piecesTotal"]:
        return "misplaced"
    if row["patches"]:
        return "patched"
    if not row["faceKept"]:
        return "substituted"
    if not row["writerClaimsSource"]:
        return "claim-mismatch"
    return "clean"


VERDICTS = ("clean", "substituted", "residual", "not-removed", "missing", "misplaced",
            "wrong-size", "patched", "claim-mismatch")


def report(rows):
    by_file = {}
    for row in rows:
        by_file.setdefault(row["file"], []).append(row)
    head = f"{'file':14} {'blocks':>6} " + " ".join(f"{v[:9]:>9}" for v in VERDICTS) + f" {'collat':>7} {'face-kept':>10}"
    print(head)
    for stem, entries in by_file.items():
        counts = dict.fromkeys(VERDICTS, 0)
        for row in entries:
            counts[verdict(row)] += 1
        collateral = sum(1 for r in entries if r["engine"]["lostOutside"] > 0)
        kept = sum(1 for r in entries if r["faceKept"] and r["writerClaimsSource"])
        print(f"{stem:14} {len(entries):6} " + " ".join(f"{counts[v]:9}" for v in VERDICTS)
              + f" {collateral:7} {kept:10}")
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
                    k: row[k] for k in ("old", "wanted", "sourceFaces", "afterFaces",
                                        "placed", "inkBefore", "inkAfter", "patches",
                                        "engine", "residualText")}}, indent=2, default=str))
    print(f"\n{len(rows)} blocks measured across {len(by_file)} files")


if __name__ == "__main__":
    main()
