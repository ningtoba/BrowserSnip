#!/usr/bin/env python3
"""
Judge the files `txt-enc-rig.test.ts` produced, with a reader that shares no code
with this app.

For each `<dir>/<label>.pdf` it reports, from MuPDF's own view of the sheets:

  * `chars`   characters a reader extracts, and how many of them are U+FFFD — the
              silent-mojibake signature of a legacy single-byte file decoded as
              UTF-8 (`caf\ufffd` is a box on the page, not an accent);
  * `expect`  whether the string the source carried arrives whole (whitespace
              compacted), so an encoding that garbles it fails here;
  * `lines`   the number of distinct baselines, plus the first words of each line
              up to six — this is what shows a lone `\r` joining two rows, or a
              tab landing a column at a different x on each row;
  * `col2_x`  the x-coordinate of every word of the table's second column, so a
              monospace alignment claim is measured, not admired;
  * `edge`    how far right / below the sheet any glyph sits, which is the
              "single word longer than the column" promise being checked;
  * `net`     the remote hosts the run asked for, read from the rig's JSON.

  npx vitest run --config docs/research/txt-enc.vitest.config.ts
  python3 docs/research/txt-enc-measure.py /tmp/txtenc before-fix \
    | tee docs/research/txt-enc-before.txt
"""
import glob
import json
import os
import re
import sys

import pymupdf

DIR = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "/tmp/txtenc")  # noqa: S108 — the rig's scratch dir
TAG = sys.argv[2] if len(sys.argv) > 2 else "run"
# Words that must share one x in the tab/spaces tables.
COLUMN2 = {"NAME", "apple", "banana", "cherry"}


def compact(text: str) -> str:
    return re.sub(r"\s+", "", text)


def read(path: str) -> str:
    if not os.path.exists(path):
        return ""
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def sheet_lines(doc) -> list:
    """(page, baseline y, words) for every text line a reader can group."""
    lines = []
    for page_index, page in enumerate(doc):
        by_line: dict = {}
        for word in page.get_text("words"):
            x0, y0, x1, y1, text = word[0], word[1], word[2], word[3], word[4]
            by_line.setdefault((page_index, round(y1, 1)), []).append((x0, x1, text))
        for (page_no, baseline), words in sorted(by_line.items()):
            words.sort()
            lines.append((page_no, baseline, words))
    return lines


def main() -> int:
    print(f"## {TAG} — {DIR}, judged by MuPDF outside this app")
    for path in sorted(glob.glob(os.path.join(DIR, "*.pdf"))):
        label = os.path.basename(path)[: -len(".pdf")]
        expect = read(os.path.join(DIR, f"{label}.expect.txt"))
        meta = json.loads(read(os.path.join(DIR, f"{label}.json")) or "{}")
        doc = pymupdf.open(path)
        text = "".join(str(page.get_text("text")) for page in doc)
        lines = sheet_lines(doc)
        widths = [page.rect.width for page in doc]
        heights = [page.rect.height for page in doc]
        col2 = sorted({round(x0, 1) for _, _, words in lines for x0, _, text_word in words if text_word in COLUMN2})
        rightmost = max((x1 for _, _, words in lines for _, x1, _ in words), default=0.0)
        below = max((y for _, y, _ in lines), default=0.0)
        doc.close()
        arrived = compact(expect) in compact(text) if expect else "-"
        fffd = text.count("\ufffd")
        head = " | ".join(
            f"p{page_no}:{round(y, 1)}:" + " ".join(w for _, _, w in words)[:40] for page_no, y, words in lines[:6]
        )
        print(f"\n{label}  src={meta.get('srcBytes')}  sheets={meta.get('sheets', '-')}  "
              f"runs_stream={meta.get('streamRuns', '-')}/outside_box={meta.get('runsOutsideBox', '-')}")
        print(f"  message   : {meta.get('message', '')}")
        for line in meta.get('warnings', []) or []:
            print(f"  warning   : {line}")
        print(f"  net       : remote={meta.get('remoteHosts')}  urls={len(meta.get('fetchUrls', []))}  "
              f"announced={meta.get('announced')}")
        print(f"  chars     : {len(text)} extracted, {fffd} of them U+FFFD")
        print(f"  expect    : {arrived}  ({expect[:48]!r})" if expect else "  expect    : -")
        print(f"  baselines : {len(lines)} distinct lines on {len(widths)} sheets "
              f"(max x1={round(rightmost, 1)} vs sheet width {round(max(widths), 1) if widths else '-'}, "
              f"max y={round(below, 1)} vs height {round(max(heights), 1) if heights else '-'})")
        if col2:
            print(f"  col2_x    : {col2}  spread={round(max(col2) - min(col2), 1)}")
        print(f"  head      : {head[:400]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
