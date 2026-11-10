#!/usr/bin/env python3
"""
Judge the files `text-tail-rig.test.ts` produced, with a reader that shares no
code with this app.

For each `<dir>/<label>.pdf` it reports what MuPDF can actually extract — the half
the user sees, not the half the content stream holds — against the marker source
the rig wrote beside it:

  * `mupdf_chars`   characters a reader finds on the sheets;
  * `runs_stream` / `runs_in_box`, counted by the app's own decoder in the rig — a
    block that runs past the bottom edge shows up here as stream runs with no box
    to hold them (`482 / 51` was the pre-fix text file);
  * `first_missing` the first marker absent from the sheets, and the byte in the
    whitespace-compacted source where it sits: how far the file got;
  * `message` the sentence the tool printed, which is the claim being checked.

  npx vitest run --config docs/research/text-tail.vitest.config.ts
  python3 docs/research/text-tail-measure.py /tmp/txttail after-fix \
    | tee docs/research/text-tail-after.txt
"""
import glob
import os
import re
import sys

import pymupdf

DIR = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "/tmp/txttail")  # noqa: S108 — the rig's scratch dir
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
    for path in sorted(glob.glob(os.path.join(DIR, "*.pdf"))):
        label = os.path.basename(path)[: -len(".pdf")]
        source = read(os.path.join(DIR, f"{label}.src.txt"))
        if not source:
            continue
        compact_source = re.sub(r"\s+", "", source)
        arrived = sheet_text(path)
        compact_arrived = re.sub(r"\s+", "", arrived)
        doc = pymupdf.open(path)
        sheets = doc.page_count
        doc.close()
        stream = read(os.path.join(DIR, f"{label}.stream.txt")).split("\t")
        drawn, boxed = (int(stream[0]), int(stream[1])) if len(stream) >= 2 and stream[0].isdigit() else (0, 0)
        missing = [mark for mark in MARKS if mark not in compact_arrived]
        first = missing[0] if missing else "-"
        where = compact_source.find(first) if first != "-" else -1
        message = read(os.path.join(DIR, f"{label}.msg.txt")).strip()
        rows.append((label, len(source.encode()), len(compact_arrived), sheets, drawn, boxed,
                     first, where, len(compact_source), message))

    print(f"## {TAG} — {DIR}, judged by MuPDF outside this app")
    print(f"{'fixture':13} {'src_bytes':>9} {'mupdf_chars':>11} {'sheets':>6} {'runs_stream':>11} "
          f"{'runs_in_box':>11}  {'first_missing':13} {'byte_in_src':>13}  message")
    for row in rows:
        print(f"{row[0]:13} {row[1]:9} {row[2]:11} {row[3]:6} {row[4]:11} {row[5]:11}  {row[6]:13} "
              f"{row[7]:>5}/{row[8]:<7} {row[9]}")
    clean = [row for row in rows if row[6] == "-"]
    boxed_only = [row for row in rows if row[4] == row[5]]
    print(f"every marker on a sheet: {len(clean)} of {len(rows)} fixtures; "
          f"nothing hanging outside a page box: {len(boxed_only)} of {len(rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
