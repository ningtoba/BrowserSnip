#!/usr/bin/env python3
"""
Judge the files `csv-struct-rig.test.ts` produced, with a reader that shares no
code with this app.

A CSV grid is only correct if each source row becomes one baseline holding one run
per cell, in column order, at the same column x as the rows above and below it, with
the header repeated and bold on every sheet the table spills onto. So for each
`<dir>/<label>.pdf` this prints, per sheet:

  * `rows`   how many baselines hold table text, and the columns per baseline
    (a wrapped cell shows as several baselines, which is why the cells themselves
    are printed for the first rows);
  * `cols`   the distinct column x values, so drift between rows is visible;
  * `bold`   which of those runs were drawn in a bold face — the header;
  * `size`   the type size the grid ended up at, for the "scaled down" promise;
  * `off`    runs whose origin sits outside the page box, and the sentence and
    warnings the run printed, which are the claims being checked.

  npx vitest run --config docs/research/csv-struct.vitest.config.ts
  python3 docs/research/csv-struct-measure.py /tmp/csvstruct before-fix \
    | tee docs/research/csv-struct-before.txt
"""
import glob
import json
import os
import re
import sys

import pymupdf

DIR = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "/tmp/csvstruct")  # noqa: S108 — the rig's scratch dir
TAG = sys.argv[2] if len(sys.argv) > 2 else "run"


def read(path: str) -> str:
    if not os.path.exists(path):
        return ""
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def spans(page):
    out = []
    for block in page.get_text("dict")["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                text = span.get("text", "")
                if text.strip() == "":
                    continue
                out.append({
                    "x": round(span["bbox"][0], 1),
                    "y": round(span["bbox"][3], 1),
                    "x1": round(span["bbox"][2], 1),
                    "size": round(span["size"], 2),
                    "bold": "Bold" in span["font"],
                    "text": text[:28],
                })
    return out


def main() -> int:
    print(f"## {TAG} — {DIR}, judged by MuPDF outside this app")
    for path in sorted(glob.glob(os.path.join(DIR, "*.pdf"))):
        label = os.path.basename(path)[: -len(".pdf")]
        meta = json.loads(read(os.path.join(DIR, f"{label}.json")) or "{}")
        src = read(os.path.join(DIR, f"{label}.src.md"))
        # What the file says the grid should be, counted without this app's parser:
        # rows and the widest row's cell count, quoting honoured.
        cells, row = [], []
        inside, buf = False, ""
        i = 0
        while i < len(src):
            ch = src[i]
            if ch == '"':
                if inside and i + 1 < len(src) and src[i + 1] == '"':
                    buf += '"'
                    i += 2
                    continue
                inside = not inside
            elif ch == "," and not inside:
                row.append(buf.strip())
                buf = ""
            elif ch in "\r\n" and not inside:
                if buf.strip() or row:
                    row.append(buf.strip())
                    cells.append(row)
                    row, buf = [], ""
            else:
                buf += ch
            i += 1
        if buf.strip() or row:
            row.append(buf.strip())
            cells.append(row)
        non_empty = [r for r in cells if any(c for c in r)]
        widest = max((len(r) for r in non_empty), default=0)
        doc = pymupdf.open(path)
        print(f"\n=== {label}  src_rows={len(non_empty)} src_widest={widest}  sheets={meta.get('sheets', '-')} "
              f"runs={meta.get('streamRuns', '-')}/outside={meta.get('runsOutsideBox', '-')}")
        print(f"    message : {meta.get('message', '')}")
        for line in meta.get("warnings", []) or []:
            print(f"    warning : {line}")
        for number, page in enumerate(doc):
            found = spans(page)
            by_row: dict = {}
            for s in found:
                by_row.setdefault(s["y"], []).append(s)
            rows = sorted(by_row.items())
            cols = sorted({s["x"] for s in found})
            sizes = sorted({s["size"] for s in found})
            bold_y = [y for y, items in rows if any(i["bold"] for i in items)]
            print(f"    sheet {number + 1}: baselines={len(rows)} cols={len(cols)} size={sizes} "
                  f"page={round(page.rect.width, 1)}x{round(page.rect.height, 1)} bold_rows={bold_y[:4]}")
            print(f"      col_x={cols[:14]}")
            for y, items in rows[:4]:
                items.sort(key=lambda s: s["x"])
                print(f"      y{y}: " + " | ".join(f"{i['text']!r}{'B' if i['bold'] else ''}@{i['x']}" for i in items[:8]))
            if len(rows) > 4:
                print(f"      … {len(rows) - 4} more baselines; last: " + " | ".join(
                    f"{i['text']!r}@{i['x']}" for i in sorted(rows[-1][1], key=lambda s: s["x"])[:6]))
            hits = 0
            for items in by_row.values():
                items.sort(key=lambda s: s["x"])
                for left, right in zip(items, items[1:]):
                    if left["x1"] > right["x"] + 0.2:
                        hits += 1
            print(f"      overlapping cell text on a shared baseline: {hits}")
            over = [s for s in found if s["x1"] > page.rect.width + 0.5 or s["x"] < -0.5 or s["y"] > page.rect.height + 0.5]
            if over:
                print(f"      off-page runs: {len(over)} e.g. {[(o['text'], o['x'], o['y']) for o in over[:3]]}")
        doc.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
