#!/usr/bin/env python3
"""Read an organize export back and ask whether it is the plan the grid showed.

  python3 docs/research/organize-campaign-bytes.py <source.pdf> <export.pdf> "1r90, blank, 2, 3"

Order is compared by each page's first text line — a distinctive string per
sheet in the fixtures — not by page count, because the failure this campaign
exists to find is a reorder that keeps the count and loses the order. Rotation is
compared against what the plan *token* is defined to mean — see
`PageOrganizer`'s serialiser and the tool's own note: a bare `4` keeps the
rotation the source page already carries, and `4r180` is the `/Rotate` the output
must hold, absolute, because that is how the pane publishes a turn made on a page
that arrived turned (`r0` straightens it). Reading `r180` as "turn another 180 on
top of the source" — the model inside the pane, before it is written out — fails
a correct export: it wanted 270 where the card said 180 and the file held 180. A
blank sheet is asserted to carry no text and no ink.

  python3 docs/research/organize-campaign-bytes.py <source.pdf> <export.pdf> "1r90, blank, 2, 3"
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
            out.append(("blank", None, None))
            continue
        m = re.match(r"^(\d+)(?:r(\d+))?$", token)
        if not m:
            raise SystemExit(f"not a plan token: {token}")
        # `None` is a bare token: keep the source page's own /Rotate. A number is
        # the absolute /Rotate the output must carry.
        out.append(("page", int(m.group(1)), None if m.group(2) is None else int(m.group(2))))
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
        if turn is not None and turn % 90:
            bad.append(f"page {i}: r{turn} is not a quarter turn")
        if kind == "blank":
            ink = nonwhite(page)
            if first_line(page) or ink:
                bad.append(f"page {i}: plan says blank, file has text/ink ({ink} px)")
            continue
        want = heads[number - 1]
        got = first_line(page)
        if got != want:
            bad.append(f"page {i}: order — file {got!r}, plan wanted {want!r} (source page {number})")
        want_rot = rots[number - 1] if turn is None else turn % 360
        if page.rotation != want_rot:
            why = f"bare token, the source carries {rots[number - 1]}" if turn is None else f"the token says r{turn}"
            bad.append(f"page {i}: rotation — file {page.rotation}, plan wanted {want_rot} ({why})")
    for line in bad:
        print("FAIL", line)
    print("OK: the exported file is the plan the grid held" if not bad else f"{len(bad)} mismatch(es)")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
