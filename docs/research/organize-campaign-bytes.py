#!/usr/bin/env python3
"""Read an organize export back and ask whether it is the plan the grid showed.

  python3 docs/research/organize-campaign-bytes.py <source.pdf> <export.pdf> "1r90, blank, 2, 3"

Order is compared by each page's first text line — a distinctive string per
sheet in the fixtures — not by page count, because the failure this campaign
exists to find is a reorder that keeps the count and loses the order. Rotation
is compared against *source /Rotate + the plan's turn*, which is what the
card's preview paints; a blank sheet is asserted to carry no text and no ink.
"""
import re
import sys

import pymupdf


def plan_tokens(spec: str):
    out = []
    for token in re.split(r"[,\s]+", spec.strip()):
        if not token:
            continue
        if token.lower() == "blank":
            out.append(("blank", None, 0))
            continue
        m = re.match(r"^(\d+)(?:r(\d+))?$", token)
        if not m:
            raise SystemExit(f"not a plan token: {token}")
        out.append(("page", int(m.group(1)), int(m.group(2) or 0)))
    return out


def first_line(page: pymupdf.Page) -> str:
    lines = str(page.get_text()).strip().splitlines()
    return lines[0] if lines else ""


def nonwhite(page: pymupdf.Page) -> int:
    pix = page.get_pixmap(dpi=72)
    s = pix.samples
    return sum(1 for i in range(0, len(s), 3) if s[i] < 250 or s[i + 1] < 250 or s[i + 2] < 250)


def main() -> int:
    source_path, export_path, spec = sys.argv[1], sys.argv[2], sys.argv[3]
    plan = plan_tokens(spec)
    src = pymupdf.open(source_path)
    exported = pymupdf.open(export_path)
    heads = [first_line(src[n]) for n in range(src.page_count)]
    rots = [src[n].rotation for n in range(src.page_count)]
    pages = [exported[n] for n in range(exported.page_count)]

    print(f"plan {len(plan)} items, file {exported.page_count} pages")
    bad = []
    if len(pages) != len(plan):
        bad.append(f"count: expected {len(plan)}, got {len(pages)}")
    for i, (page, item) in enumerate(zip(pages, plan, strict=False), start=1):
        kind, number, turn = item
        if kind == "blank":
            ink = nonwhite(page)
            if first_line(page) or ink:
                bad.append(f"page {i}: plan says blank, file has text/ink ({ink} px)")
            continue
        want = heads[number - 1]
        got = first_line(page)
        if got != want:
            bad.append(f"page {i}: order — file {got!r}, plan wanted {want!r} (source page {number})")
        want_rot = (rots[number - 1] + turn) % 360
        if page.rotation != want_rot:
            bad.append(f"page {i}: rotation — file {page.rotation}, source {rots[number - 1]} + plan {turn} = {want_rot}")
    for line in bad:
        print("FAIL", line)
    print("OK: the exported file is the plan the grid held" if not bad else f"{len(bad)} mismatch(es)")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
