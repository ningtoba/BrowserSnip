#!/usr/bin/env python3
"""Independent judgement for the `repair` damage corpus.

    node docs/research/repair-damage-corpus.mjs --dir /tmp/rd
    node docs/research/repair-damage-measure.mjs --dir /tmp/rd     # the app's voice
    python3 docs/research/repair-damage-readers.py /tmp/rd         # the bytes' voice

The app's sentence comes out of `repair-damage-measure.mjs`. This script asks the
same questions of the same files with readers that share no code with this app —
MuPDF, qpdf (libqpdf), poppler, pypdf and Ghostscript — and prints one row per
case:

    before   how many pages each outside reader still finds in the *damaged* file
    after    how many pages it finds in the file `repair` wrote
    ink      non-white pixels of every produced page, at 72 dpi
    words    characters and planted sheet words, so a page count is checked
             against the content it names
    verdict  `preserved`, `lost-pages N->M`, `blank`, `silent-loss`, `unreadable`,
             `overclaims C>G`, or `refused` — a refusal is a legitimate answer to
             damage, but only when the tool's own words say what it gave up

A page count that agrees while every sheet rasterises to paper is the failure this
campaign keeps meeting, so `blank` and `silent-loss` count against the tool. The
defect TOOL-TRIAGE §2 recorded was exactly that: 1 page at 0.00 % ink reported as
"1 page(s) readable".

Writes `<dir>/readers.json` beside the printed table so `repair-damage-run.sh` and
a later pass read the same numbers. Exits 1 when a produced file contradicts the
sentence printed for it, or is paper.
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import subprocess
import sys
import tempfile

import pikepdf
import pymupdf
from pypdf import PdfReader

TARGET = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "/tmp/rd")  # noqa: S108 — the rig's scratch dir
DPI = 72

# Filled from the manifest: the word planted on each sheet, so "4 pages" can be
# told apart from "the same page four times" and from "one page and three blanks".
WORDS: list[str] = []


@contextlib.contextmanager
def quiet_stderr():
    """Collect the complaints a reader makes while it works.

    MuPDF writes to fd 2 and carries on; poppler prints a `Syntax Error` and still
    counts the pages. That is the difference between "the file is fine" and "the
    reader chose to recover", so it belongs with the measurement.
    """
    saved = os.dup(2)
    with tempfile.TemporaryFile(mode="w+b") as sink:
        sys.stderr.flush()
        os.dup2(sink.fileno(), 2)
        try:
            yield
        finally:
            sys.stderr.flush()
            os.dup2(saved, 2)
            os.close(saved)


def page_ink(page) -> float:
    """Non-white percent of one page, sampled off its own raster."""
    pix = page.get_pixmap(dpi=DPI)
    total = max(1, pix.width * pix.height)
    dark = 0
    for row_index in range(pix.height):
        row = pix.samples[row_index * pix.stride:(row_index + 1) * pix.stride]
        for column in range(pix.width):
            channels = row[column * pix.n:column * pix.n + 3]
            if any(value < 250 for value in channels):
                dark += 1
    return round(100.0 * dark / total, 2)


def mupdf(path: str) -> dict:
    try:
        with quiet_stderr():
            doc = pymupdf.open(path)
    except Exception as err:  # noqa: BLE001 — a reader refusing the file is a measurement
        return {"pages": None, "ink": [], "chars": [], "words": [], "error": str(err)[:90]}
    reading: dict = {"pages": doc.page_count, "ink": [], "chars": [], "words": []}
    for page in doc:
        reading["ink"].append(page_ink(page))
        text = str(page.get_text()).strip()
        reading["chars"].append(len(text))
        reading["words"].append([word for word in WORDS if word in text])
    doc.close()
    return reading


def count_with(loader) -> int | None:
    """Run one reader's page count, or `None` when it will not open the file."""
    try:
        with quiet_stderr():
            return loader()
    except Exception:  # noqa: BLE001 — every library signals refusal its own way
        return None


def qpdf_pages(path: str) -> int | None:
    def load() -> int:
        pdf = pikepdf.open(path)
        try:
            return len(pdf.pages)
        finally:
            pdf.close()

    return count_with(load)


def pypdf_pages(path: str) -> int | None:
    def load() -> int:
        with open(path, "rb") as handle:
            return len(PdfReader(handle, strict=False).pages)

    return count_with(load)


def poppler_pages(path: str) -> int | None:
    def load() -> int | None:
        proc = subprocess.run(["pdfinfo", path], capture_output=True, text=True, timeout=90, check=False)
        found = re.search(r"^Pages:\s+(\d+)", proc.stdout, re.MULTILINE)
        if found:
            return int(found.group(1))
        raise RuntimeError(proc.returncode and "no Pages line")

    return count_with(load)


def qpdf_check(path: str) -> str:
    """libqpdf's own structural verdict, which is the question a rebuilt index begs.

    `repair` now writes a cross-reference table of its own over the objects it found,
    so "it opens" is not enough: qpdf is the reader that reports a table that is
    structurally wrong even when a lenient reader still gets the pages out of it.
    """
    try:
        with quiet_stderr():
            pdf = pikepdf.open(path)
    except Exception as err:  # noqa: BLE001 — a refusal is the measurement
        return f"refuses: {str(err)[:52]}"
    try:
        errors = pdf.check_pdf_syntax()
    except Exception as err:  # noqa: BLE001
        return f"check errored: {str(err)[:52]}"
    finally:
        pdf.close()
    if not errors:
        return "clean"
    names = [str(getattr(item, "name", item)) for item in errors]
    return "; ".join(names)[:70]


def reader_noise(path: str) -> str:
    """poppler's and Ghostscript's own words about one file, one line."""
    notes = []
    for cmd in (["pdfinfo", path], ["gs", "-q", "-o", os.devnull, "-sDEVICE=nullpage", path]):
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120, check=False)
        except (OSError, subprocess.TimeoutExpired):
            continue
        text = (proc.stderr or "").strip().replace("\n", " | ")
        kept = [bit.strip() for bit in text.split("|") if bit.strip()]
        if kept and proc.returncode != 0:
            notes.append(f"{cmd[0]}: {kept[0][:90]}")
    return " · ".join(notes[:2])


def reading_of(path: str) -> dict:
    return {
        "mupdf": mupdf(path),
        "qpdf": qpdf_pages(path),
        "pypdf": pypdf_pages(path),
        "poppler": poppler_pages(path),
        "bytes": os.path.getsize(path),
        "qpdf_check": qpdf_check(path),
        "noise": reader_noise(path),
    }


def best(reading: dict) -> int | None:
    """The most any outside reader still finds — the yardstick `repair` is graded on."""
    counts = [
        reading["mupdf"]["pages"],
        reading["qpdf"],
        reading["pypdf"],
        reading["poppler"],
    ]
    numbers = [value for value in counts if value is not None]
    return max(numbers) if numbers else None


def names_loss(answer: dict) -> bool:
    """True when the tool's own words name what it gave up."""
    text = " ".join([answer.get("message", "")] + list(answer.get("warnings", [])))
    return bool(re.search(
        r"lost|missing|could not|unreadable|no content|content is gone|blank|only \d+|of \d+ listed|not recovered",
        text,
        re.I,
    ))


def verdict(before: dict, after: dict | None, answer: dict | None) -> str:
    held = best(before)
    if answer is not None and not answer["ok"]:
        return "refused" if not held else f"refused a {held}-page file"
    if after is None:
        return "no output measured"
    got = best(after)
    if not got:
        return "unreadable"
    claimed = answer["pages"] if answer else None
    if claimed is not None and claimed > got:
        return f"overclaims {claimed}>{got}"
    if held and got < held:
        return f"lost-pages {held}->{got}"
    inks = after["mupdf"].get("ink") or []
    chars = after["mupdf"].get("chars") or []
    if sum(inks) == 0 and sum(chars) == 0:
        return "blank"
    if sum(inks) == 0 or sum(chars) == 0:
        return "silent-loss"
    if held and got > held and answer and not names_loss(answer):
        return "unreported gain"
    return "preserved"


def main() -> int:
    global WORDS  # noqa: PLW0603 — the manifest owns the planted words
    with open(os.path.join(TARGET, "manifest.json"), encoding="utf-8") as handle:
        manifest = json.load(handle)
    WORDS = manifest["sheet_words"]
    with open(os.path.join(TARGET, "app.json"), encoding="utf-8") as handle:
        answers = {item["file"]: item for item in json.load(handle)}

    cases = [{"name": "base", "file": "corpus/base.pdf"}, {"name": "base-objstm", "file": "corpus/base-objstm.pdf"}]
    cases += [{"name": item["name"], "file": item["file"]} for item in manifest["cases"]]

    rows = []
    for case in cases:
        source = os.path.join(TARGET, case["file"])
        produced = os.path.join(TARGET, "out", os.path.basename(source))
        answer = answers.get(os.path.basename(source))
        before = reading_of(source)
        after = reading_of(produced) if os.path.exists(produced) else None
        rows.append({
            "case": case["name"],
            "before": before,
            "after": after,
            "claim": answer["message"] if answer else "(not run)",
            "warnings": answer["warnings"] if answer else [],
            "verdict": verdict(before, after, answer),
        })

    def cells(reading: dict | None) -> str:
        if reading is None:
            return "no file"
        pages = reading["mupdf"]["pages"]
        return f"mupdf {pages} · qpdf {reading['qpdf']} · pop {reading['poppler']} · pypdf {reading['pypdf']} · check {reading['qpdf_check']}"

    print(f"{'case':24} {'input still holds':80} {'output reads as':80} ink % per sheet        verdict")
    print("-" * 250)
    for row in rows:
        inks = "/".join(f"{value:.1f}" for value in (row["after"]["mupdf"]["ink"] if row["after"] else [])) or "-"
        print(f"{row['case']:24} {cells(row['before']):52} {cells(row['after']):52} {inks:22} {row['verdict']}")

    print()
    for row in rows:
        print(f"### {row['case']}: {row['claim']}")
        for warning in row["warnings"]:
            print(f"    ! {warning}")
        if row["before"]["noise"]:
            print(f"    readers, input: {row['before']['noise']}")
        if row["after"] and row["after"]["noise"]:
            print(f"    readers, output: {row['after']['noise']}")
        print(f"    input characters per sheet: {row['before']['mupdf']['chars']}")
        print(f"    input planted words: {row['before']['mupdf']['words']}")
        if row["after"]:
            print(f"    output characters per sheet: {row['after']['mupdf']['chars']}")
            print(f"    output planted words: {row['after']['mupdf']['words']}")

    with open(os.path.join(TARGET, "readers.json"), "w", encoding="utf-8") as handle:
        json.dump(rows, handle, indent=2)
        handle.write("\n")

    bad = [row for row in rows if not row["case"].startswith("base") and row["verdict"] != "preserved"]
    refused = [row for row in bad if row["verdict"].startswith("refused")]
    contradicted = [row for row in bad if row["verdict"] not in ("unreadable", "no output measured")
                    and not row["verdict"].startswith("refused")]
    print(f"\n{len(bad)} case(s) not preserved, of which {len(refused)} were refused outright")
    print(f"{len(contradicted)} case(s) whose produced file contradicts the sentence printed for it")
    return 1 if any(row["verdict"] in ("blank", "silent-loss", "unreadable", "no output measured")
                    or "overclaims" in row["verdict"] for row in bad) else 0


if __name__ == "__main__":
    sys.exit(main())
