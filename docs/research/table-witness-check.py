#!/usr/bin/env python3
"""
Witness-check the table trio (pdf-to-csv, extract-tables, pdf-to-excel) against
PyMuPDF `find_tables`, with an RFC-4180 CSV round-trip and an openpyxl read-back.

For each produced artifact it compares the app's grid to the source's grid and
separates two very different kinds of disagreement:

  * DETECT  — the app found a different NUMBER of tables than the witness. The
    trio runs whitespace/column detection only (the ruled-lines path in
    core/tables.ts is never fed vector lines — `detectTables` is always called
    with `lines: []`), so a table that sits in the same block as a prose or
    heading line, or whose cells span columns, is missed or mis-cut. That is the
    shared-seam blocker; the bare-table fixtures the old tests used never showed it.
  * QUOTE/CELL — for tables BOTH readers find, do the cells match, and does the
    CSV survive an RFC-4180 round-trip with delimiter/quote/newline escaping and a
    UTF-8 BOM? This is the part the tools own through `tablesToCsv`/`typedRows`.

  BASE=http://localhost:5293 PORT=9853 SPEC=/tmp/lane-q1/specN.json \
    OUTDIR=/tmp/lane-q1/out JSONL=/tmp/lane-q1/runsN.jsonl node docs/research/colour-rail.mjs
  python3 docs/research/table-witness-check.py /tmp/lane-q1/out /tmp/lane-q1/runsN.jsonl
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
import sys
import unicodedata
from collections import Counter

import pymupdf

try:
    import openpyxl
except ImportError:
    openpyxl = None  # xlsx rows then just report as SKIP

SEARCH_DIRS = ["/tmp/lane-q1", "/tmp/triage", "/tmp/triage/in"]
PW = "reader-pass"


def norm(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def wit_grids(pdf: str) -> list[list[list[str]]]:
    d = pymupdf.open(pdf)
    if d.needs_pass:
        d.authenticate(PW)
    grids: list[list[list[str]]] = []
    for p in d:
        for t in p.find_tables().tables:
            grids.append([[("" if c is None else str(c)).strip() for c in r] for r in t.extract()])
    d.close()
    return grids


def csv_grids(raw: str) -> list[list[list[str]]]:
    raw = raw.lstrip("\ufeff")
    # tables are separated by a blank line
    chunks = re.split(r"\r?\n\r?\n", raw.strip())
    out = []
    for ch in chunks:
        if not ch.strip():
            continue
        out.append([r for r in csv.reader(io.StringIO(ch))])
    return out


def md_grids(raw: str) -> list[list[list[str]]]:
    tables, cur = [], []
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("|") and not re.match(r"^\|\s*-{2,}", line):
            cur.append([c.strip() for c in line.strip("|").split("|")])
        elif not line.startswith("|") and cur:
            tables.append(cur); cur = []
    if cur:
        tables.append(cur)
    return tables


def resolve(jsonl: str | None, prefix: str) -> str | None:
    if not jsonl:
        return None
    for line in open(jsonl):
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if f"{r.get('tool','')}__{r.get('tag','base')}" == prefix:
            for name in r.get("files", []):
                base = os.path.basename(name)
                if os.path.isabs(name) and os.path.exists(name):
                    return name
                for d in SEARCH_DIRS:
                    if os.path.exists(os.path.join(d, base)):
                        return os.path.join(d, base)
    return None


def msg_for(jsonl: str | None, prefix: str) -> str:
    if not jsonl:
        return ""
    for line in open(jsonl):
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if f"{r.get('tool','')}__{r.get('tag','base')}" == prefix:
            return ((r.get("screen") or {}).get("result") or "").replace("\n", " ")
    return ""


def count_ok(msg: str, n_tables: int, n_rows: int, n_sheets: int | None) -> str:
    checks = []
    m = re.search(r"(\d+) table\(s\)", msg)
    if m:
        checks.append(int(m.group(1)) == n_tables)
    else:
        checks.append(n_tables == 0)
    m = re.search(r"totalling (\d+) rows", msg)
    if m:
        checks.append(int(m.group(1)) == n_rows)
    m = re.search(r"across (\d+) worksheet", msg)
    if m and n_sheets is not None:
        checks.append(int(m.group(1)) == n_sheets)
    return "OK" if all(checks) else "COUNT-LIE"


def main() -> int:
    outdir = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "/tmp/lane-q1/out")
    jsonl = sys.argv[2] if len(sys.argv) > 2 else None
    seen = set()
    for fn in sorted(os.listdir(outdir)):
        ext = fn.rsplit(".", 1)[-1] if "." in fn else ""
        if ext not in ("csv", "md", "json", "xlsx"):
            continue
        prefix = fn.rsplit("_", 1)[0]
        key = prefix + "." + ext
        if key in seen:
            continue
        # only artifacts whose tool is in the trio
        if not any(t in prefix for t in ("pdf-to-csv", "extract-tables", "pdf-to-excel")):
            continue
        src = resolve(jsonl, prefix)
        if not src:
            continue
        seen.add(key)
        path = os.path.join(outdir, fn)
        grids: list[list[list[str]]] = []
        if ext == "csv":
            grids = csv_grids(open(path, encoding="utf-8-sig", newline="").read())
        elif ext == "md":
            grids = [g for g in md_grids(open(path, encoding="utf-8").read()) if any("Month" in c or "Dept" in c or "Item" in c or "Description" in c for c in (x for r in g for x in r))]
        elif ext == "json" and prefix.startswith("extract-tables"):
            try:
                grids = [t["rows"] for t in json.loads(open(path, encoding="utf-8").read())["tables"]]
            except (json.JSONDecodeError, KeyError):
                print(f"{fn:52} JSON INVALID"); continue
        elif ext == "xlsx":
            if openpyxl is None:
                print(f"{fn:52} SKIP (no openpyxl)"); continue
            wb = openpyxl.load_workbook(path)
            grids = [[[(str(c) if c is not None else "") for c in r] for r in ws.iter_rows(values_only=True)] for ws in (wb[n] for n in wb.sheetnames)]
        else:
            continue

        wit = wit_grids(src)
        n_rows = sum(len(g) for g in grids)
        n_sheets = len(grids) if ext == "xlsx" else None
        cnt = count_ok(msg_for(jsonl, prefix), len(grids), n_rows, n_sheets) if "extract-tables" not in prefix or ext != "md" else "?"
        # per-table cell equality: match each app grid to the best witness grid
        cells = []
        for g in grids:
            best = None
            for w in wit:
                if len(w) == len(g):
                    same = sum(1 for i in range(len(g)) if [norm(x) for x in g[i]] == [norm(x) for x in w[i]])
                    score = same / max(1, len(g))
                    if best is None or score > best:
                        best = score
            cells.append("exact" if best == 1.0 else (f"{best:.2f}" if best is not None else "no-wit-match"))
        verdict = []
        if cnt == "COUNT-LIE":
            verdict.append("COUNT")
        if len(grids) < len(wit):
            verdict.append(f"DETECT app{len(grids)}<wit{len(wit)}")
        if any(c not in ("exact", "no-wit-match") for c in cells):
            verdict.append("CELLDIFF " + ",".join(cells))
        if ext == "csv":
            raw = open(path, encoding="utf-8-sig", newline="").read()
            b = open(path, "rb").read()
            if not b.startswith(b"\xef\xbb\xbf"):
                verdict.append("NO-BOM")
            if "\r\n" not in raw:
                verdict.append("NO-CRLF")
        print(f"{fn[:52]:52} {cnt:9} app={len(grids)}t/wit={len(wit)}t cells={cells} {' | '.join(verdict) or 'OK'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
