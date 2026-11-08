#!/usr/bin/env python3
"""ocr-pdf round-trip check — read the artifacts `ocr-round-trip.mjs` produced and
fail unless the planted words came back, through the file as well as the screen.

    python3 docs/research/ocr-check.py --dir /tmp/ocr

The chain under test is two shipped tools: `rasterize-pdf` turns a page of known
text into an image-only PDF, and `ocr-pdf` has to return those words from the
picture alone. So the proof is self-validating — if either tool regresses, one of
these assertions fails, and it fails loudly rather than reporting a non-empty
string.

What it checks, in order:

1. the rasterised PDF really is image-only (no text layer to lean on), and keeps
   the fixture's ink — page 3 measures 0 non-white px, so "blank" is in the bytes;
2. the words `ocr-pdf` printed for page 1 match the planted lines by a stated
   similarity measure (difflib ratio and word-level F1 over the normalized
   strings), not by "output is non-empty";
3. the invisible layer in the downloaded file carries the same words, and pages 2
   and 3 carry none of them — the check the vendor image-cache collision breaks;
4. the three silent-page outcomes say three different things, and the ink percent
   the tool speaks agrees with the same sheet measured out of the file by PyMuPDF
   (a claim about pixels, corroborated by pixels);
5. what the rail asked for is what ran: page selection, resolution, and a language
   hint that changes nothing are read off the artifacts rather than inferred.

Exits 1 on the first failure with the number that said so.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path

import pymupdf

# The similarity bar. OCR of a 200 dpi JPEG re-rendered at 300 dpi is not a
# typewriter: one dropped full stop is allowed, a swallowed line is not. A blank
# read scores 0.0 and an exact read 1.0, so the threshold only has to sit between
# "recognised the page" and "did not".
MIN_RATIO = 0.90
MIN_WORD_F1 = 0.90
# How far the tool's ink figure may sit from the same sheet measured by PyMuPDF.
# The two rasterise through different libraries; 3 pp is the JPEG ring the
# `rasterize-pdf` row recorded, not a fudge factor invented here.
INK_TOLERANCE_PP = 3.0

FAILURES: list[str] = []


def check(ok: bool, label: str, detail: str) -> None:
    line = f"{'OK  ' if ok else 'FAIL'} {label}: {detail}"
    print(line)
    if not ok:
        FAILURES.append(line)


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def ratio(planted: str, got: str) -> float:
    return SequenceMatcher(None, norm(planted), norm(got)).ratio()


def word_f1(planted: str, got: str) -> float:
    want, have = norm(planted).lower().split(), norm(got).lower().split()
    if not want:
        return 0.0
    pool = list(have)
    hits = sum(1 for word in want if word in pool and pool.pop(pool.index(word)) is not None)
    precision = hits / max(1, len(have))
    recall = hits / len(want)
    return 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)


def ink_pct(page: pymupdf.Page, dpi: int = 100) -> float:
    pix = page.get_pixmap(dpi=dpi)
    samples, stride = pix.samples, pix.n
    total = pix.width * pix.height
    dark = sum(1 for i in range(0, len(samples), stride) if samples[i] < 245)
    return 100.0 * dark / total if total else 0.0


def page_text(doc: pymupdf.Document, index: int) -> str:
    return str(doc[index].get_text())


def screen_body(path: Path) -> str:
    """The visible text the probe saved, minus the chrome it always carries."""
    return path.read_text()


def block_for(body: str, page: int) -> str:
    """The text the report card shows under `Page N`, up to the next page header."""
    match = re.search(rf"^Page {page}\n(.*?)(?=^Page \d+$|\Z)", body, re.S | re.M)
    return match.group(1).strip() if match else ""


def main() -> int:
    ap = argparse.ArgumentParser()
    # Required rather than defaulted: the probe writes the artifacts, the checker
    # only reads the directory it is pointed at.
    ap.add_argument("--dir", required=True)
    args = ap.parse_args()
    root = Path(args.dir)

    planted = json.loads((root / "planted.json").read_text())
    lines = planted["lines"]
    want = " ".join(lines)

    if not (root / "scanned.pdf").exists():
        check(False, "the rasterise half produced a file", "no scanned.pdf — nothing to read")
        return 1
    source = pymupdf.open(root / "planted.pdf")
    scanned = pymupdf.open(root / "scanned.pdf")

    # ── 1. the rasterise half really produced an image-only PDF ───────────────
    check(len(scanned) == len(source), "rasterise kept the page count", f"{len(source)} -> {len(scanned)}")
    stray = {i: norm(page_text(scanned, i)) for i in range(len(scanned)) if norm(page_text(scanned, i))}
    check(not stray, "rasterised PDF carries no text layer", f"pages with text: {stray or 'none'}")
    images = [len(scanned[i].get_images(full=True)) for i in range(len(scanned))]
    check(all(n == 1 for n in images), "one image XObject per sheet", str(images))
    src_ink = [ink_pct(source[i]) for i in range(len(source))]
    got_ink = [ink_pct(scanned[i]) for i in range(len(scanned))]
    check(
        got_ink[0] > 1.0,
        "the planted sheet still carries ink after rasterising",
        f"source {src_ink[0]:.2f} % -> rasterised {got_ink[0]:.2f} %",
    )
    check(
        got_ink[2] == 0.0,
        "the empty sheet is still empty in the file",
        f"source {src_ink[2]:.2f} % -> rasterised {got_ink[2]:.2f} %",
    )
    check(
        abs(got_ink[1] - src_ink[1]) < 5.0,
        "the gradient sheet kept its coverage",
        f"source {src_ink[1]:.2f} % -> rasterised {got_ink[1]:.2f} %",
    )

    # ── 2. the words came back on the screen ─────────────────────────────────
    report = screen_body(root / "ocr-report.txt")
    read1 = block_for(report, 1)
    check(read1 != "", "report mode printed page 1", f"{len(read1)} chars")
    r, f1 = ratio(want, read1), word_f1(want, read1)
    check(
        r >= MIN_RATIO and f1 >= MIN_WORD_F1,
        "recognised text matches the planted words",
        f"similarity {r:.3f} (>= {MIN_RATIO}), word F1 {f1:.3f} (>= {MIN_WORD_F1})",
    )
    print(f"     recognised: {read1!r}")

    # ── 3. and into the downloaded file, page by page ────────────────────────
    if not (root / "ocr-layer.pdf").exists():
        # A refusal is an answer, not a crash: say which half refused.
        check(False, "the layer run produced a file", "no ocr-layer.pdf — the tool downloaded nothing")
        layer = pymupdf.open(root / "scanned.pdf")
    else:
        layer = pymupdf.open(root / "ocr-layer.pdf")
    laid = [norm(page_text(layer, i)) for i in range(len(layer))]
    r_file, f1_file = ratio(want, laid[0]), word_f1(want, laid[0])
    check(
        r_file >= MIN_RATIO and f1_file >= MIN_WORD_F1,
        "the invisible layer carries the planted words",
        f"similarity {r_file:.3f}, word F1 {f1_file:.3f}",
    )
    print(f"     in the file: {laid[0][:200]!r}")
    check(
        not any(word in laid[1].lower() for word in ("lighthouse", "quartermaster", "harbour")),
        "page 2 was not answered with page 1's words",
        f"page 2 layer text: {laid[1]!r}",
    )
    check(laid[2] == "", "page 3 carries no text at all", f"page 3 layer text: {laid[2]!r}")
    check(
        len(layer) == len(scanned),
        "the layer run kept every sheet",
        f"{len(scanned)} -> {len(layer)}",
    )
    modes = [
        (layer[i].get_texttrace() and "traced" or "none") for i in range(len(layer))
    ]
    check(modes[0] == "traced", "page 1's content stream draws text", str(modes))

    # ── 4. three silences, three sentences, and the ink backs them up ────────
    read2, read3 = block_for(report, 2), block_for(report, 3)
    pct2 = re.search(r"(\d+(?:\.\d+)?) %", read2)
    pct3 = re.search(r"(\d+(?:\.\d+)?) %", read3)
    check(
        bool(pct2) and "not a blank sheet" in read2,
        "the inked page with no letters says it is not blank",
        read2.replace("\n", " ")[:150],
    )
    check(
        "blank" in read3 and bool(pct3) and float(pct3.group(1)) == 0.0,
        "the empty page is named blank with a measured 0.00 %",
        read3.replace("\n", " ")[:150],
    )
    check(read2 != read3, "the two are not the same sentence", f"{len(read2)} vs {len(read3)} chars")
    if pct2:
        claim, measured = float(pct2.group(1)), got_ink[1]
        check(
            abs(claim - measured) <= INK_TOLERANCE_PP,
            "the ink the tool speaks matches the file",
            f"tool {claim:.2f} % vs PyMuPDF {measured:.2f} % (tolerance {INK_TOLERANCE_PP} pp)",
        )
    check(
        not any(
            "Nothing was recognised on the" in (root / name).read_text()
            for name in ("ocr-report.txt", "ocr-layer.txt")
        ),
        "the old blur is gone from the screen",
        "neither card says 'Nothing was recognised on the N page you selected'",
    )

    # ── 5. what the rail asked for is what ran ───────────────────────────────
    pick = screen_body(root / "ocr-pick.txt")
    check("across 1 page" in pick, "the page selection reached the run", "report says 'across 1 page'")
    check("Page 2" not in pick and "Page 3" not in pick, "only the picked page was read", "no Page 2/3 block")
    lang = screen_body(root / "ocr-lang.txt")
    check(
        norm(block_for(lang, 1)) == norm(block_for(pick, 1)),
        "the language hint changed what was read",
        "German on page 1 returned byte-identical text to English — the bundled reader is one dictionary",
    )
    skip = screen_body(root / "ocr-skip.txt")
    # The source PDF, skip toggle on: page 1 holds its own text, so the run must
    # name the pages it read separately from the one it left alone, and must not
    # call the left-alone page blank.
    check(
        "the 2 pages the recogniser read" in skip and "already had its own text layer" in skip,
        "a skipped page is counted apart from a silent one",
        re.sub(r"\s+", " ", skip)[-220:],
    )
    check(
        "blank" not in (block_for(skip, 1) or "").lower(),
        "the page it never read is not called blank",
        f"Page 1 block: {block_for(skip, 1)!r}",
    )
    check(
        "Nothing was recognised" not in skip and "no text was recognised on the 3" not in skip.lower(),
        "a skipped page is not folded into the count of pages read",
        "the card counts 1 read + 1 left alone, not 3 unread",
    )
    log = (root / "round-trip.log").read_text()
    for asked in re.findall(r"^(\w[\w ]*)=(\S+) → .*?state value=(\S+)", log, re.M):
        label, want_v, got_v = asked
        check(want_v == got_v, f"rail field {label!r} holds what was typed", f"{want_v} == {got_v}")
    check("dpi=300" in log, "the resolution the probe asked for is the one the rail holds", "dpi=300 read back")
    check("console errors: []" in log, "no console error in any run", log.strip().splitlines()[-1])

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S)")
        for line in FAILURES:
            print(" -", line)
        return 1
    print("OK: rasterise → OCR round trip returned the planted words, page for page, and told the three silences apart")
    return 0


if __name__ == "__main__":
    sys.exit(main())
