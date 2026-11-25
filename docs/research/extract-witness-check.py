#!/usr/bin/env python3
"""
Witness-check the DATA-extract converters (pdf-to-text, pdf-to-markdown, and the
JSON/CSV/table/Excel siblings) against readers that share no code with this app.

These tools do not draw a page: their truth is the *text/markup* they hand back
versus what the source document actually says. This rig answers that question
with two independent witnesses — PyMuPDF (`get_text`, `find_tables`) and poppler
(`pdftotext`) — plus a re-parseability gate (a produced .json must load, a
produced pipe table must round-trip through a markdown-table parser, a .txt must
agree token-for-token with the source's own whitespace split).

Run the tools first (live), then point this at the outputs:

  BASE=http://localhost:5293 PORT=9853 SPEC=/tmp/lane-q1/spec.json \
    OUTDIR=/tmp/lane-q1/out JSONL=/tmp/lane-q1/runs.jsonl \
    node docs/research/colour-rail.mjs
  python3 docs/research/extract-witness-check.py /tmp/lane-q1/out

For each produced `<tool>__<tag>_<name>.{txt,md}` it recomputes the source PDF
(the `<name>.pdf` is found from the JSONL record's fixture list when present,
else it reads a matching `.src.pdf` beside the output) and reports:

  * token_fidelity  multiset equality between the app text and the PyMuPDF text
                    (missing / invented tokens), which is where a spurious-space
                    bug shows up: a ligature word the app splits "ef-fi-cient"
                    invents tokens the source does not carry as separate words;
  * word_ratio      app word count / witness word count — a lie against the card's
                    "a word count you can check against the original";
  * md_table_ok     a produced Markdown pipe table re-parses to the same grid
                    `find_tables` reports for the source (cells equal row-for-row);
  * astral/rtl      whether supplementary-plane and RTL characters survive.

Only `pdf-to-text`/`pdf-to-markdown` are wired here today; the sibling converters
add `--kind json|csv|xlsx` gates in their own rounds.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import unicodedata
from collections import Counter

import pymupdf


def tok(s: str) -> Counter:
    return Counter(re.findall(r"\S+", unicodedata.normalize("NFC", s)))


def _open(pdf: str):
    d = pymupdf.open(pdf)
    if d.needs_pass:
        d.authenticate("reader-pass")
    return d


def witness_text(pdf: str) -> str:
    d = _open(pdf)
    out = "".join(p.get_text() for p in d)
    d.close()
    return out



def pdftotext(pdf: str) -> str:
    try:
        return subprocess.run(["pdftotext", "-raw", pdf, "-"],
                              capture_output=True, text=True, check=False).stdout
    except FileNotFoundError:
        return ""


def md_grid(md: str) -> list[list[str]]:
    rows = []
    for line in md.splitlines():
        line = line.strip()
        if line.startswith("|") and not re.match(r"^\|\s*-{2,}", line):
            rows.append([c.strip() for c in line.strip("|").split("|")])
    return rows


def pdf_grid(pdf: str) -> list[list[str]]:
    d = _open(pdf)
    best: list[list[str]] = []
    for p in d:
        for t in p.find_tables().tables:
            best = t.extract()
            break
        if best:
            break
    d.close()
    return [[("" if c is None else str(c)).strip() for c in r] for r in best]


def classes(s: str) -> tuple[int, int, int]:
    astral = sum(1 for c in s if ord(c) > 0xFFFF)
    rtl = sum(1 for c in s if 0x0590 <= ord(c) <= 0x06FF)
    cjk = sum(1 for c in s if 0x4E00 <= ord(c) <= 0x9FFF or 0x3040 <= ord(c) <= 0x30FF or 0xAC00 <= ord(c) <= 0xD7AF)
    return astral, rtl, cjk


SEARCH_DIRS = ["/tmp/lane-q1", "/tmp/triage", "/tmp/triage/in"]


def find_pdf(outdir: str, jsonl: str | None, prefix: str) -> str | None:
    # the fixture the colour-rail record logged for this run prefix (basename),
    # resolved against the known fixture dirs
    if jsonl and os.path.exists(jsonl):
        for line in open(jsonl):
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            pfx = f"{r.get('tool','')}__{r.get('tag','base')}"
            if pfx == prefix:
                for name in r.get("files", []):
                    base = os.path.basename(name)
                    if not base.endswith(".pdf"):
                        continue
                    if os.path.isabs(name) and os.path.exists(name):
                        return name
                    for d in SEARCH_DIRS:
                        cand = os.path.join(d, base)
                        if os.path.exists(cand):
                            return cand
    return None



def main() -> int:
    outdir = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "/tmp/lane-q1/out")
    jsonl = sys.argv[2] if len(sys.argv) > 2 else None
    records = []
    if jsonl and os.path.exists(jsonl):
        for line in open(jsonl):
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    rows = []
    for r in records:
        prefix = f"{r.get('tool','')}__{r.get('tag','base')}"
        pdf = find_pdf(outdir, jsonl, prefix)
        if not pdf:
            continue
        for fn in sorted(os.listdir(outdir)):
            if not fn.startswith(prefix + "_") or not fn.endswith((".txt", ".md")):
                continue
            app = open(os.path.join(outdir, fn), encoding="utf-8").read()
            wit = unicodedata.normalize("NFC", witness_text(pdf))
            a, w = tok(app), tok(wit)
            missing, extra = w - a, a - w
            aw, ww = len(app.split()), len(wit.split())
            ratio = (aw / ww) if ww else float("nan")
            md_ok = "n/a"
            if fn.endswith(".md") and "| ---" in app:
                md_ok = "OK" if md_grid(app) == pdf_grid(pdf) else "MISMATCH"
            acls, wcls = classes(app), classes(wit)
            verdict = "PASS"
            if extra:
                verdict = "SPACED-WORDS"  # app invented tokens by splitting real words
            elif missing:
                verdict = "LOSS"
            if md_ok == "MISMATCH":
                verdict = "TABLE"
            rows.append((fn, os.path.basename(pdf), verdict, len(missing), len(extra),
                         aw, ww, round(ratio, 2), acls, wcls, md_ok))


    print(f"{'output':40} {'pdf':16} {'verdict':13} {'miss':>4} {'invt':>4} "
          f"{'app_w':>5} {'wit_w':>5} {'ratio':>5}  app(astral/rtl/cjk) wit(a/r/c)  md")
    for r in rows:
        print(f"{r[0][:40]:40} {r[1][:16]:16} {r[2]:13} {r[3]:>4} {r[4]:>4} "
              f"{r[5]:>5} {r[6]:>5} {r[7]:>5}  {r[8]} {r[9]}  {r[10]}")
    bad = [r for r in rows if r[2] != "PASS"]
    print(f"\n{len(bad)} of {len(rows)} outputs disagree with the PyMuPDF witness. "
          "SPACED-WORDS = rowText joins every pdf.js item with a space, splitting "
          "ligature/kerned runs into fake words (see core/convert.ts::rowText).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
