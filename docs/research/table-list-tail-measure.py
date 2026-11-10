#!/usr/bin/env python3
"""
Judge the files `table-list-tail-rig.test.ts` produced, with a reader that shares
no code with this app.

`text-tail-measure.py` asks one question of the paragraph branch. This asks the
same of the table, list and heading branches: which of the five markers can a
reader actually pull off the sheets, and how much of the content stream hangs
outside a page box.

  * `mupdf_chars`   characters a reader finds on the sheets;
  * `marks`         how many of MKSTART/MK25/MK50/MK75/MKEND land on a sheet —
                    the survival count the ledger quotes, e.g. `1/5`;
  * `runs_stream` / `runs_in_box`, counted by the app's own decoder in the rig: a
    block running past the bottom edge shows up as stream runs with no box to hold
    them (`510 / 4` was the pre-fix table);
  * `first_missing` the first marker absent from the sheets, and the byte in the
    whitespace-compacted source where it sits: how far the file got;
  * `message` the sentence the tool printed, which is the claim being checked.

  npx vitest run --config docs/research/table-list-tail.vitest.config.ts
  python3 docs/research/table-list-tail-measure.py /tmp/tablelist after-fix \
    | tee docs/research/table-list-tail-after.txt
"""
import glob
import os
import re
import sys

import pymupdf

DIR = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "/tmp/tablelist")  # noqa: S108 — the rig's scratch dir
TAG = sys.argv[2] if len(sys.argv) > 2 else "run"
MARKS = ["MKSTART", "MK25", "MK50", "MK75", "MKEND"]


def read(path: str) -> str:
    if not os.path.exists(path):
        return ""
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def sheet_text(path: str) -> str:
    """Every character a reader can pull off the sheets, in MuPDF's own order."""
    doc = pymupdf.open(path)
    parts = [str(page.get_text("text")) for page in doc]
    doc.close()
    return "".join(parts)


def main() -> int:
    rows = []
    # A fixture whose run threw produced no PDF at all, which is the loudest
    # answer of the three, so the loop is driven by the sources, not the files.
    for path in sorted(glob.glob(os.path.join(DIR, "*.src.txt"))):
        label = os.path.basename(path)[: -len(".src.txt")]
        pdf = os.path.join(DIR, f"{label}.pdf")
        source = read(path)
        if not source:
            continue
        compact_source = re.sub(r"\s+", "", source)
        arrived = sheet_text(pdf) if os.path.exists(pdf) else ""
        compact_arrived = re.sub(r"\s+", "", arrived)
        doc = pymupdf.open(pdf) if os.path.exists(pdf) else None
        sheets = doc.page_count if doc else 0
        if doc is not None:
            doc.close()
        stream = read(os.path.join(DIR, f"{label}.stream.txt")).split("\t")
        drawn, boxed = (int(stream[0]), int(stream[1])) if len(stream) >= 2 and stream[0].isdigit() else (0, 0)
        missing = [mark for mark in MARKS if mark not in compact_arrived]
        first = missing[0] if missing else "-"
        where = compact_source.find(first) if first != "-" else -1
        message = read(os.path.join(DIR, f"{label}.msg.txt")).strip()
        if not message and not os.path.exists(os.path.join(DIR, f"{label}.msg.txt")):
            message = "(no message)"
        rows.append((label, len(source.encode()), len(compact_arrived), sheets, drawn, boxed,
                     f"{len(MARKS) - len(missing)}/{len(MARKS)}", first, where, len(compact_source), message))

    print(f"## {TAG} — {DIR}, judged by MuPDF outside this app")
    print(f"{'fixture':14} {'src_bytes':>9} {'mupdf_chars':>11} {'sheets':>6} {'runs_stream':>11} "
          f"{'runs_in_box':>11}  {'marks':>6}  {'first_missing':13} {'byte_in_src':>13}  message")
    for row in rows:
        print(f"{row[0]:14} {row[1]:9} {row[2]:11} {row[3]:6} {row[4]:11} {row[5]:11}  {row[6]:>6}  {row[7]:13} "
              f"{row[8]:>5}/{row[9]:<7} {row[10]}")
    whole = [row for row in rows if row[7] == "-" and row[3] > 0]
    boxed_only = [row for row in rows if row[4] == row[5] and row[3] > 0]
    nofile = [row for row in rows if row[3] == 0]
    print(f"every marker on a sheet: {len(whole)} of {len(rows)} fixtures; "
          f"nothing hanging outside a page box: {len(boxed_only)} of {len(rows)}; "
          f"produced no file at all: {len(nofile)} ({', '.join(row[0] for row in nofile) or 'none'})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
