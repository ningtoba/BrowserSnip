#!/usr/bin/env python3
"""Render `docs/research/readers-foreign-repro.md`'s tables from the recorded runs.

The two app columns come from the shipped `runPdfTool`/`readPageLabels`/`readOutline`
driven by `tests/pdf/readers-foreign.test.ts`:

    BROWSERSNIP_READERS_TABLE=/tmp/after.json npx vitest run tests/pdf/readers-foreign.test.ts

with `/tmp/before.json` taken from the same run at the commit *before* the fix, and
`tests/fixtures/readers/census.json` supplying the outside columns — which are the
readers' own answers over the frozen bytes, not this script's opinion. Nothing here
recomputes a label: if the numbers in the table and the numbers in `census.json` ever
disagree, the fixture changed and the generator has to be re-run.
"""
import json
import sys

FIX = "tests/fixtures/readers/census.json"


def cells(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def fmt_list(values: list) -> str:
    return "`[" + ", ".join(f"`{v}`" if isinstance(v, str) else f"{v}" for v in values) + "]`"


def fmt_outline(nodes: list) -> str:
    parts = []
    for node in nodes:
        page = "no page" if node["page"] is None else node["page"]
        level = f" (level {node['depth'] + 1})" if node["depth"] else ""
        parts.append(f"{node['title']}→{page}{level}")
    return "`[" + ", ".join(parts) + "]`"


def load(path: str) -> dict:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def main(before_path: str, after_path: str, out_path: str) -> None:
    census = load(FIX)
    before = load(before_path)
    after = load(after_path)
    lines: list[str] = []

    for side, key in (("labels", "labels"), ("outlines", "outlines")):
        rows_b = {r["file"]: r for r in before[key]}
        rows_a = {r["file"]: r for r in after[key]}
        lines += [
            f"### {side}: every shape, both readers, this app before and after\n",
            "| fixture | shape the format allows | the readers that did not write it | this app before the fix | this app now |",
            "| --- | --- | --- | --- | --- |",
        ]
        for name in sorted(rows_b):
            frozen = census[name]["outside_after_freeze"]
            if side == "labels":
                outside = (f"MuPDF `{frozen['mupdf_page_labels']}`; "
                           f"pypdf `{frozen['pypdf_labels']}`")
                b = fmt_list(rows_b[name]["ours"])
                a = fmt_list(rows_a[name]["ours"])
            else:
                outside = (f"pypdf `{[[e['title'], e['page']] for e in frozen['pypdf_outline']]}`; "
                           f"MuPDF `{[[t[1], t[2]] for t in frozen['toc']]}`")
                b = fmt_outline(rows_b[name]["ours"])
                a = fmt_outline(rows_a[name]["ours"])
            verdict = "same" if b == a else "**moved**"
            lines.append(f"| `{name}` | {cells(rows_b[name]['shape'])} | {cells(outside)} "
                         f"| {cells(b)} | {cells(a)} — {verdict} |")
        lines.append("")

    with open(out_path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
    moved = sum(1 for side in ("labels", "outlines")
                for r, s in zip(before[side], after[side], strict=True)
                if r["ours"] != s["ours"])
    print(f"{out_path}: {len(before['labels'])} label rows, "
          f"{len(before['outlines'])} outline rows, {moved} of them moved")


if __name__ == "__main__":
    main(*sys.argv[1:4])
