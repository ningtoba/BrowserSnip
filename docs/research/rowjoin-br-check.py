#!/usr/bin/env python3
"""
Score the `<br>` / wrapped-cell clause that `core/tables.ts::logicalRows` now implements.

Old purpose: decide whether folding is safe. It is (see the header of
`logicalRows` for the counts); this script is the instrument that produced them and
re-checks the grid the fold yields against the app's own dump.

Score the candidate `<br>` clause: group physical table rows whose boxes
overlap into one logical row.

Reports, over the whole table probe dump, every consecutive row pair inside a
detected table by vertical relationship (overlap / tight / normal) and prints
what the grid would look like if overlapping rows were merged, so the clause can
be accepted or rejected on counts rather than on one fixture.

usage: rowjoin-br.py run/tables-q1.jsonl run/tables-corpus.jsonl
"""
import json
import sys
from collections import defaultdict

buckets = defaultdict(int)
per_file = defaultdict(lambda: defaultdict(int))
merge_preview = []
ambiguous = []

for path in sys.argv[1:]:
    for line in open(path):
        r = json.loads(line)
        shapes = r["shapes"]
        cols = r["columns"]
        groups = [[shapes[0]]] if shapes else []
        for prev, cur in zip(shapes, shapes[1:]):
            gap = cur["top"] - prev["bottom"]
            height = max(prev["height"], cur["height"]) or 1
            ratio = gap / height
            if gap < 0:
                kind = "overlap"
            elif ratio < 0.5:
                kind = "tight"
            else:
                kind = "normal"
            buckets[kind] += 1
            per_file[r["file"]][kind] += 1
            if kind == "overlap":
                groups[-1].append(cur)
            else:
                groups.append([cur])
        if not any(buckets[k] for k in ("overlap",)):
            continue
        merged = []
        for g in groups:
            cells = [[] for _ in range(cols)]
            for row in g:
                for i, cell in enumerate(row["cells"]):
                    if cell:
                        cells[i].append(cell)
            merged.append([" ".join(c) for c in cells])
        if len(merged) != r["gridRows"]:
            merge_preview.append((r["file"], r["page"], r["gridRows"], len(merged), merged))
        for g in groups:
            fills = [set(i for i, c in enumerate(row["cells"]) if c) for row in g]
            if len(g) > 1:
                for a, b in zip(fills, fills[1:]):
                    if a & b:
                        ambiguous.append((r["file"], r["page"], sorted(a), sorted(b)))

print("row-pair classes inside detected tables:", dict(buckets))
print("\nfiles with overlapping row pairs:")
for f, kinds in sorted(per_file.items()):
    if kinds.get("overlap"):
        print(f"  {f:34} {dict(kinds)}")
print("\ngrid under the merge clause (only tables whose row count changes):")
for f, p, before, after, merged in merge_preview:
    print(f"  {f} p{p}: grid rows {before} -> {after}")
    for m in merged[-3:]:
        print("     ", json.dumps(m, ensure_ascii=False))
print(f"\nmerges that stack two rows claiming the SAME column (wrapped-cell cases): {len(ambiguous)}")
for a in ambiguous[:8]:
    print("   ", a)
