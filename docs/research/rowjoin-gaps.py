#!/usr/bin/env python3
"""
Witness-check the run join (`core/tables.ts::joinRuns`, used by `rowText` and by
both table-cell builders) against extractors that share no code with this app.

pdf.js starts a new text run at every font change, every positioned (kerned) pair
and around every ligature glyph. `rowText` used to answer every one of those
boundaries with a space, which is how "efficient" reached the user as
"e ff icient" and a 16-word page reported 38 words. The fix is a gap rule, and a
gap rule needs a measured threshold, so this rig labels **every** intra-row run
junction in a fixture set with PyMuPDF's glyph-level truth — the two glyphs that
face the junction, found by position, independent of how either extractor groups
lines — and reports:

  1. the distribution of `gap / glyph-size` per class (the tuning table),
  2. the confusion matrix of the rule at `WORD_GAP_EM` / `LINE_STEP_EM` /
     `OBJECT_OVERLAP_EM`,
  3. a sweep of the threshold, so the chosen value can be shown to sit on a
     plateau rather than on one fixture's spike.

Step 1 — dump the spine's own rows and geometry for a set of PDFs (plain node;
the app source is TypeScript, so it is bundled first):

  EB=node_modules/@esbuild/linux-x64/bin/esbuild
  "$EB" docs/research/rowjoin-spine-probe.mts --bundle --platform=node \
    --format=esm --alias:pdfjs-dist=pdfjs-dist/legacy/build/pdf.mjs \
    --banner:js="import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" \
    --outfile=/tmp/rowjoin-probe.mjs
  node /tmp/rowjoin-probe.mjs /tmp/rowjoin/pre.jsonl <pdf...>      # before the fix
  node /tmp/rowjoin-probe.mjs /tmp/rowjoin/post.jsonl <pdf...>     # after it

Step 2 — judge the dumps:

  python3 docs/research/rowjoin-gaps.py /tmp/rowjoin/post.jsonl <dir-with-the-pdfs>
  K=0.02,0.05,0.1,0.2,0.3 python3 docs/research/rowjoin-gaps.py …

Pages at `/Rotate` 90/270 are skipped: MuPDF's char boxes are in unrotated space
and this rig does not re-derive them, so only the app side would be measured.
"""
import json
import os
import sys
from bisect import bisect_left
from collections import defaultdict

import pymupdf

WORD_GAP_EM = float(os.environ.get("WORD_GAP_EM", "0.1"))
LINE_STEP_EM = float(os.environ.get("LINE_STEP_EM", "0.4"))
OBJECT_OVERLAP_EM = float(os.environ.get("OBJECT_OVERLAP_EM", "0.5"))


def glyphs_of_page(page):
    """[(x0, x1, y_mid, char)] for every glyph, in the page's top-left space."""
    out = []
    for block in page.get_text("rawdict")["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                for ch in span["chars"]:
                    x0, y0, x1, y1 = ch["bbox"]
                    out.append((x0, x1, (y0 + y1) / 2, ch["c"]))
    return out


def by_row(band, x_end, x_start, fs):
    """Indices of the two glyphs that face a junction, band sorted by x0."""
    starts = [g[0] for g in band]
    li = bisect_left(starts, x_end - 0.05 * fs) - 1
    ri = bisect_left(starts, x_start - 0.05 * fs)
    return li, ri


def classify(band, li, ri, fs):
    """'space' / 'nospace' / None when the witness has nothing to say."""
    if li is None or ri is None or li < 0 or ri >= len(band):
        return None
    if ri < li:
        # The next run starts left of where this one ends: two objects sharing a
        # line, which every witness keeps on separate lines.
        return "space"
    if ri == li:
        return None  # one glyph is being read as both sides: nothing to say
    between = band[li + 1 : ri]
    if any(g[3].isspace() for g in between):
        return "space"
    if between:
        return None
    hole = band[ri][0] - band[li][1]
    return "space" if hole >= 0.05 * fs else "nospace"


def quantiles(values):
    if not values:
        return "n=0"
    v = sorted(values)
    pick = lambda p: v[min(len(v) - 1, int(p * (len(v) - 1)))]  # noqa: E731
    return (
        f"n={len(v):4d} min={v[0]:8.3f} p05={pick(0.05):7.3f} "
        f"p50={pick(0.5):7.3f} p95={pick(0.95):7.3f} max={v[-1]:8.3f}"
    )


def main():
    dumps = [a for a in sys.argv[1:] if a.endswith(".jsonl")]
    fixdir = next((a for a in sys.argv[1:] if not a.endswith(".jsonl")), ".")
    rows = []
    for d in dumps:
        with open(d) as handle:
            rows += [json.loads(line) for line in handle]
    bypage = defaultdict(list)
    for r in rows:
        if "spine" in r:
            bypage[(r["file"], r["page"])].append(r)

    # (gap_em, step_em, truth, file, page, prev, cur) for every labelled junction.
    junctions = []
    dist = defaultdict(list)
    unlabelled = 0
    docs = {}
    pages = 0
    for (fname, page), rs in sorted(bypage.items()):
        doc = docs.setdefault(fname, pymupdf.open(os.path.join(fixdir, fname)))
        p = doc[page - 1]
        if p.rotation != 0 or any(r.get("rotate", 0) != 0 for r in rs):
            continue
        pages += 1
        band_by_y = defaultdict(list)
        for g in sorted(glyphs_of_page(p)):
            band_by_y[round(g[2])].append(g)
        for r in rs:
            items = r["items"]
            top = min(i["y"] for i in items)
            bottom = max(i["y"] + i["h"] for i in items)
            band = []
            for key in range(int(top) - 1, int(bottom) + 2):
                band += band_by_y.get(key, [])
            band.sort()
            for prev, cur in zip(items, items[1:]):
                if abs(prev["uy"]) < abs(prev["ux"]) or abs(cur["uy"]) < abs(cur["ux"]):
                    continue  # a quarter-turned run: not this page's geometry
                if prev["s"][-1:].isspace() or cur["s"][:1].isspace():
                    continue  # the space is already inside a run
                fs = max(prev["fs"], cur["fs"])
                if not fs:
                    continue
                li, ri = by_row(band, prev["x"] + prev["w"], cur["x"], fs)
                truth = classify(band, li, ri, fs)
                gap_em = (cur["x"] - (prev["x"] + prev["w"])) / fs
                step_em = abs((cur["y"] + cur["h"]) - (prev["y"] + prev["h"])) / fs
                dist[truth or "unlabelled"].append(gap_em)
                if truth is None:
                    unlabelled += 1
                    continue
                junctions.append((gap_em, step_em, truth, fname, page, prev["s"], cur["s"]))

    print(f"pages judged: {pages}   labelled junctions: {len(junctions)}   unlabelled: {unlabelled}")
    print("\n1) junction gap in em of the glyph size, by witness class")
    for cls in ("nospace", "space", "unlabelled"):
        if dist[cls]:
            print(f"   {cls:11} {quantiles(dist[cls])}")

    def score(word_gap_em):
        ok = 0
        wrong = []
        for gap_em, step_em, truth, fname, page, ps, cs in junctions:
            guess = (
                "space"
                if step_em > LINE_STEP_EM
                or gap_em < -OBJECT_OVERLAP_EM
                or gap_em > word_gap_em
                else "nospace"
            )
            if guess == truth:
                ok += 1
            else:
                wrong.append((fname, page, ps[-12:], cs[:12], round(gap_em, 3), round(step_em, 3), truth, guess))
        return ok, wrong

    ok, wrong = score(WORD_GAP_EM)
    print(f"\n2) the shipped rule (WORD_GAP_EM={WORD_GAP_EM} LINE_STEP_EM={LINE_STEP_EM} "
          f"OBJECT_OVERLAP_EM={OBJECT_OVERLAP_EM}): {ok}/{len(junctions)} = "
          f"{100.0 * ok / max(1, len(junctions)):.2f}%")
    for w in wrong[:12]:
        print("   miss:", w)

    sweep = [float(s) for s in os.environ.get("K", "").split(",") if s.strip()]
    if sweep:
        print("\n3) threshold sweep (same labels, only WORD_GAP_EM moves)")
        for k in sweep:
            hit, _ = score(k)
            print(f"   WORD_GAP_EM={k:<5} {hit}/{len(junctions)} = {100.0 * hit / max(1, len(junctions)):.2f}%")


main()

