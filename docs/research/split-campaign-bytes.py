#!/usr/bin/env python3
"""What `split` cut, judged in the bytes of every file it handed back.

    python3 docs/research/split-campaign-bytes.py --records /tmp/split/records.json

The probe (`split-campaign.mjs`) saves each produced file as
`<case>__<n>__<download name>.pdf` and, where the case asked for it, the archive
as `…__<n>__<stem>_split.zip`. This reader works out what each name *promises* —
the page range, or the odd/even side — and then demands that the file's sheets
are exactly those source sheets: same displayed box, same `/MediaBox`, same
`/Rotate`, same characters and the same first text line, same non-white pixel
count at the same dpi. Nothing is taken on trust from the card's sentence.

It also checks the two things a folder shows you and the preview does not: that
the names sort in the order the document reads (zero-padded to the document's own
width), and that every entry of the archive is one of those files, byte for byte.
Controls built into the run: a source sheet that is paper measures 0 ink (so a
blank output sheet is a real result, not a broken instrument), and the same
source measured twice gives the same numbers.
"""
from __future__ import annotations

import argparse
import io
import json
import re
import zipfile

import numpy as np
import pymupdf

DPI = 110


def sheets(path_or_doc) -> list[tuple]:
    doc = path_or_doc if hasattr(path_or_doc, "page_count") else pymupdf.open(path_or_doc)
    out = []
    for page in doc:
        pix = page.get_pixmap(dpi=DPI)
        a = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)[:, :, :3]
        text = page.get_text().strip()
        out.append(
            (
                round(pix.width), round(pix.height), int(page.rotation),
                tuple(round(v) for v in page.mediabox),
                len(text), text.split("\n")[0][:60] if text else "(blank)",
                int((a != 255).any(axis=2).sum()),
            )
        )
    return out


def odd_even(total: int, side: str) -> list[int]:
    step, start = (2, 1) if side == "odd" else (2, 2)
    return list(range(start, total + 1, step))


def expected_from_name(name: str, total: int) -> list[int] | None:
    """The page numbers a produced file's own name promises it holds."""
    stem = re.sub(r"\.pdf$", "", name)
    # A repeated sheet gets the writer's own clash suffix (`… (2)`); the number
    # inside it is not part of the page the name points at.
    stem = re.sub(r"\s*\(\d+\)$", "", stem)
    m = re.search(r"_(?:page|pages)-(\d+)-(\d+)$", stem)
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        return list(range(a, b + 1))
    m = re.search(r"_(?:page|pages)-(\d+)$", stem)
    if m:
        return [int(m.group(1))]
    m = re.search(r"_(\d+)-(\d+)$", stem)
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        return list(range(a, b + 1))
    m = re.search(r"_(\d+)$", stem)
    if m:
        return [int(m.group(1))]
    if stem.endswith("odd-pages"):
        return odd_even(total, "odd")
    if stem.endswith("even-pages"):
        return odd_even(total, "even")
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--records", required=True)
    ap.add_argument("--cases", required=True, help="the cases file, for each case's source document")
    args = ap.parse_args()
    records = json.load(open(args.records))
    case_of = {c["id"]: c for c in json.load(open(args.cases))}
    source_of = {cid: c.get("pdf") for cid, c in case_of.items()}
    # A case may spell out the sheets each produced file must hold (`expect`:
    # one list of 1-based page numbers per output PDF, in the order they were
    # taken). `extract-pages` names its files after single pages, so its order
    # promise lives in the typed selection, not in the name.
    expect_of = {cid: c.get("expect") for cid, c in case_of.items()}
    source_cache: dict[str, list[tuple]] = {}
    failures: list[str] = []
    checks = 0

    for rec in records:
        cid = rec["id"]
        pdf = source_of.get(cid)
        outs = rec.get("outputs") or []
        if not outs:
            print(f"-- {cid}: no files ({rec.get('fail') or 'refusal'})")
            continue
        # One source measurement per document, reused for every case that used it.
        def source(path: str) -> list[tuple]:
            if path not in source_cache:
                source_cache[path] = sheets(path)
                again = sheets(path)
                if again != source_cache[path]:  # instrument control
                    failures.append(f"{cid}: the instrument disagrees with itself on {path}")
            return source_cache[path]

        produced = 0
        for out in outs:
            if not out["name"].lower().endswith(".pdf"):
                continue
            src = source(pdf)
            total = len(src)
            want = (
                expect_of.get(cid)[produced]
                if expect_of.get(cid) and produced < len(expect_of[cid])
                else expected_from_name(out["name"], total)
            )
            produced += 1
            got = sheets(out["path"])
            if want is None:
                failures.append(f"{cid}: cannot read a page promise out of the name {out['name']}")
                continue
            if len(got) != len(want):
                failures.append(f"{cid}: {out['name']} promises {want} and holds {len(got)} sheet(s)")
                continue
            for i, (page, number) in enumerate(zip(got, want)):
                checks += 1
                if page != src[number - 1]:
                    failures.append(
                        f"{cid}: {out['name']} sheet {i + 1} is not source page {number}\n"
                        f"      file {page}\n      src  {src[number - 1]}"
                    )
            print(f"   {cid}: {out['name']} = pages {want} ✓ "
                  f"ink {[s[-1] for s in got]}")
        # The archive, when the case took it: every PDF name on the card must be
        # an entry, and the entry's bytes must be the file the card offered.
        zips = [o for o in outs if o["name"].lower().endswith(".zip")]
        if zips:
            z = zips[0]
            with zipfile.ZipFile(z["path"]) as arc:
                names = sorted(arc.namelist())
                singles = sorted(o["name"] for o in outs if o["name"].lower().endswith(".pdf"))
                checks += 1
                if names != singles:
                    failures.append(f"{cid}: the archive holds {names}, the card offered {singles}")
                for entry in names:
                    raw = arc.read(entry)
                    match = next((o for o in outs if o["name"] == entry), None)
                    if match and raw != open(match["path"], "rb").read():
                        failures.append(f"{cid}: archive entry {entry} is not the bytes the card offered")
                    checks += 1
            print(f"   {cid}: zip {len(names)} entries, bytes match the individual files ✓")

    paper = pymupdf.open()
    paper.new_page(width=420, height=595)
    paper_path = "/tmp/lane-organize/r/paper-control.pdf"
    paper.save(paper_path)
    paper.close()
    blank_ink = sheets(paper_path)[0][-1]
    checks += 1
    if blank_ink != 0:
        failures.append(f"instrument: a page of paper measured {blank_ink} ink, not 0")
    print(f"control: a fresh sheet of paper measures {blank_ink} ink at {DPI} dpi")
    print(f"\n{checks} checks, {len(failures)} failure(s)")
    for f in failures:
        print("FAIL", f)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
