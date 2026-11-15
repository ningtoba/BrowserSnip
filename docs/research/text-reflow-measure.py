#!/usr/bin/env python3
"""Judge a `edit-pdf-text` re-flow off the produced file.

  python3 docs/research/text-reflow-measure.py --source /tmp/rf/reflow.pdf \
      --output /tmp/rf/out-long.pdf [--page 1] [--json]

The question is a collision, so the check is one: the rewritten block's lines are
compared with the **neighbouring paragraph that was not touched** — the source's
own lines under the block — and every line whose box lands on one is counted.
`--fit` inverts the verdict for the fixed build (a block may now be set smaller,
so the *type size* is compared with the source's, not the line count alone).

The instrument's own controls, run before either verdict is trusted:

  --source X --output X        the untouched file against itself → 0 collisions,
                               the block's own 2 lines, the block not rewritten.
  --source control.pdf ...     a block with 200 pt of clear paper → 0 collisions
                               in both states, so a collision means a collision.

Exit 1 when any line lands on the neighbour (or, with `--fit`, when the block
still grows past the lines it came from), 0 when it does not.
"""
import argparse
import json
import sys

import pymupdf

TARGET = ("TARGET ALPHA", "hotel india juliet")   # the block under test
NEIGHBOUR = ("FOLLOWING HOTEL", "xray yankee zulu and more")  # never edited
SLACK = 0.5


def spans(page):
    out = []
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                if span["text"].strip():
                    out.append(span)
    return out


def by_prefix(listing, prefixes):
    return [s for s in listing if s["text"].startswith(prefixes)]


def overlap(a, b, slack=SLACK):
    """True when two boxes share more than `slack` points in both directions."""
    dx = min(a[2], b[2]) - max(a[0], b[0])
    dy = min(a[3], b[3]) - max(a[1], b[1])
    return dx > slack and dy > slack


def measure(source, output, page1, fit):
    src = pymupdf.open(source)
    out = pymupdf.open(output)
    index = page1 - 1
    result = {
        "source": source,
        "output": output,
        "page": page1,
        "pages": [src.page_count, out.page_count],
        "rotations": [[p.rotation for p in src], [p.rotation for p in out]],
        "info": [{"title": src.metadata.get("title"), "author": src.metadata.get("author")},
                 {"title": out.metadata.get("title"), "author": out.metadata.get("author")}],
        "cars": {
            "annots": [len(list(src[0].annots() or [])), len(list(out[0].annots() or []))],
            "links": [len(src[0].get_links()), len(out[0].get_links())],
        },
    }
    src_lines = spans(src[index])
    out_lines = spans(out[index])
    target = by_prefix(src_lines, TARGET)
    neighbour = by_prefix(src_lines, NEIGHBOUR)
    target_box = [0.0, 0.0, 0.0, 0.0]
    if target:
        target_box = [min(s["bbox"][0] for s in target), min(s["bbox"][1] for s in target),
                      max(s["bbox"][2] for s in target), max(s["bbox"][3] for s in target)]
    result["target_source_lines"] = [s["text"] for s in target]
    result["neighbour_lines"] = [s["text"] for s in neighbour]

    if not target or not neighbour:
        result["error"] = "target or neighbour not found in the source"
        return result, 2

    # The rewritten block: the output's lines in the target's column, below the
    # heading, minus the neighbour's own (still literally there) lines.
    kept = {s["text"] for s in neighbour}
    rewritten = [
        s for s in out_lines
        if s["text"] not in kept and s["bbox"][0] <= target_box[0] + 6
        and s["bbox"][1] > target_box[1] - 40 and s["bbox"][0] >= target_box[0] - 12
    ]
    # Stop at the neighbour: nothing of the block can be below the FAR line.
    rewritten = [s for s in rewritten if s["text"].startswith(TARGET) or s["bbox"][1] < max(n["bbox"][3] for n in neighbour) + 80]
    result["rewritten_lines"] = [s["text"][:40] for s in rewritten]
    result["line_counts"] = {"source": len(target), "output": len(rewritten)}
    result["sizes"] = {"source": round(target[0]["size"], 2), "output": round(rewritten[0]["size"], 2) if rewritten else None}

    collisions = []
    for line in rewritten:
        for other in neighbour:
            if overlap(line["bbox"], other["bbox"]):
                collisions.append({
                    "line": line["text"][:40],
                    "bbox": [round(v, 1) for v in line["bbox"]],
                    "on": other["text"][:40],
                })
                break
    result["collisions"] = collisions
    result["collision_lines"] = len(collisions)
    top = min(n["bbox"][1] for n in neighbour)
    result["neighbour_top"] = round(top, 1)
    result["last_baseline"] = round(max((s["origin"][1] for s in rewritten), default=top), 1)
    result["past_neighbour_pt"] = round(result["last_baseline"] - top, 1)
    result["page_bottom"] = round(out[index].rect.height, 1)
    result["past_page_pt"] = round(result["last_baseline"] - out[index].rect.height, 1)
    result["verdict"] = (
        "no collision" if result["collision_lines"] == 0
        else f"{result['collision_lines']} rewritten line(s) print over the neighbour"
    )
    present = {s["text"] for s in out_lines}
    result["neighbour_kept"] = sum(1 for n in neighbour if n["text"] in present)
    if fit:
        result["fit_ok"] = (
            result["collision_lines"] == 0
            and result["past_neighbour_pt"] <= 0
            and result["neighbour_kept"] == len(neighbour)
        )
    return result, 0


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--page", type=int, default=1)
    parser.add_argument("--fit", action="store_true", help="the fixed build: the block must hold its own line count")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    result, code = measure(args.source, args.output, args.page, args.fit)
    print(json.dumps(result, indent=2) if args.json else "\n".join(f"{k}: {v}" for k, v in result.items()))
    if code:
        return code
    if args.fit:
        return 0 if result.get("fit_ok") else 1
    return 0 if result["collision_lines"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
