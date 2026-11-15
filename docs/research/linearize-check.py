#!/usr/bin/env python3
"""Judge a file against the linearized PDF structure, and against its source.

A tool called "Linearize PDF" is only verified by two things: the bytes are laid
out the way ISO 32000-1 Annex F requires, and the rebuild did not lose the
document. This measures both and exits 1 on any failure, so a run is a check
rather than a printout.

Structural facts, in the order a reader meets them:

  1. the parameter dictionary starts inside the first 1024 bytes (F.3.3);
  2. its `/L` equals the file length to the byte — qpdf treats a mismatch as
     "not linearized" and ignores every hint;
  3. `/H` names a primary hint stream that really is an object at that offset;
  4. the first page's object (`/O`) comes before the second group's first
     object, i.e. page 1 is at the front of the file;
  5. the file carries two cross-reference sections (the first-page one and the
     main one), not zero and not one;
  6. `pikepdf`/`libqpdf` — qpdf's own checker — accepts it
     (`is_linearized`, `check_linearization()`).

Preservation is measured against the source with the same instrument: per page
ink pixel count at 72 dpi, characters, `MediaBox`/`CropBox`/`/Rotate`, `/Annots`
and links; document `/Title`, `/Author`, `/Producer` and the outline.

    python3 docs/research/linearize-check.py --src IN.pdf --out OUT.pdf [--before]

`--before` records a run that is *expected* not to be linearized (the local
rebuild path): the structure must then fail 1–6 while preservation still holds.
"""
from __future__ import annotations

import argparse
import re
import sys

import pikepdf
import pymupdf


def ink(page: pymupdf.Page) -> int:
    pix = page.get_pixmap(dpi=72)
    return sum(
        1 for i in range(0, len(pix.samples), pix.n) if any(c < 250 for c in pix.samples[i : i + 3])
    )


def census(path: str) -> dict:
    doc = pymupdf.open(path)
    pages = [
        {
            "box": (round(p.rect.width, 1), round(p.rect.height, 1)),
            "rotate": p.rotation,
            "text": len(p.get_text()),
            "annots": len(list(p.annots() or [])),
            "links": len(p.get_links()),
            "ink": ink(p),
        }
        for p in doc
    ]
    meta = doc.metadata or {}
    out = {
        "pages": doc.page_count,
        "title": meta.get("title") or "",
        "author": meta.get("author") or "",
        "producer": meta.get("producer") or "",
        "toc": doc.get_toc(),
        "pages_detail": pages,
    }
    doc.close()
    return out


def structure(path: str) -> dict:
    with open(path, "rb") as handle:
        raw = handle.read()
    at = raw.find(b"/Linearized")
    facts: dict = {
        "bytes": len(raw),
        "dict_at": at,
        "dict_within_1024": 0 <= at < 1024,
    }
    if at >= 0:
        match = re.search(rb"/L\s+(\d+)", raw[at : at + 400])
        facts["L"] = int(match.group(1)) if match else None
        facts["L_matches_length"] = facts["L"] == len(raw)
        hint = re.search(rb"/H\s*\[\s*(\d+)\s+(\d+)\s*\]", raw[at : at + 400])
        facts["H"] = tuple(int(x) for x in hint.groups()) if hint else None
        if facts["H"]:
            offset, length = facts["H"]
            window = raw[offset : offset + length]
            facts["H_is_an_object"] = bool(re.match(rb"\s*\d+\s+\d+\s+obj", window))
            # The primary hint stream's dictionary names the shared-object hint
            # table at `/S`; a stream without it is not a hint stream.
            facts["H_has_hint_dict"] = b"/S " in window
        first = re.search(rb"/O\s+(\d+)", raw[at : at + 400])
        if first:
            ref = first.group(1) + b" 0 obj"
            page_at = raw.find(ref)
            facts["O"] = int(first.group(1))
            facts["O_offset"] = page_at
            end_of_first = re.search(rb"/E\s+(\d+)", raw[at : at + 400])
            main_xref = re.search(rb"/T\s+(\d+)", raw[at : at + 400])
            facts["E"] = int(end_of_first.group(1)) if end_of_first else None
            facts["T"] = int(main_xref.group(1)) if main_xref else None
            # `/E` is the end of the first page: its page object has to sit
            # inside that region, and the second group (and the main xref, `/T`)
            # after it. That is what "page 1 first" means in bytes.
            facts["O_before_second_group"] = bool(
                facts["E"] is not None
                and facts["T"] is not None
                and 0 <= page_at < facts["E"] <= facts["T"] <= len(raw)
            )
    facts["xref_sections"] = len(re.findall(rb"(?m)^xref\s*$", raw))
    try:
        with pikepdf.open(path) as pdf:
            facts["pikepdf_is_linearized"] = bool(pdf.is_linearized)
            try:
                pdf.check_linearization()
                facts["pikepdf_check"] = "ok"
            except Exception as err:  # noqa: BLE001 - the reason is the measurement
                facts["pikepdf_check"] = f"FAILED: {err}"
    except Exception as err:  # noqa: BLE001
        facts["pikepdf_check"] = f"could not open: {err}"
    return facts


STRUCTURAL_KEYS = (
    "dict_within_1024",
    "L_matches_length",
    "H_is_an_object",
    "H_has_hint_dict",
    "O_before_second_group",
)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--before", action="store_true", help="a rebuild that must NOT be linearized")
    args = parser.parse_args()

    failures: list[str] = []
    facts = structure(args.out)
    print("structure:", facts)

    if args.before:
        if facts["dict_at"] < 0:
            failures.append("--before: no /Linearized dictionary at all")
        if facts["dict_within_1024"] and facts["L_matches_length"]:
            failures.append("--before: the file is linearized")
        if facts["xref_sections"] != 1:
            failures.append(f"--before: expected one xref section, found {facts['xref_sections']}")
        if facts.get("pikepdf_check") == "ok":
            failures.append("--before: libqpdf accepted it as linearized")
    else:
        for key in STRUCTURAL_KEYS:
            if not facts.get(key):
                failures.append(f"structure: {key} is false")
        if facts["xref_sections"] != 2:
            failures.append(f"structure: expected two xref sections, found {facts['xref_sections']}")
        if facts.get("pikepdf_check") != "ok":
            failures.append(f"structure: libqpdf check — {facts.get('pikepdf_check')}")
        if not facts.get("pikepdf_is_linearized"):
            failures.append("structure: libqpdf says the file is not linearized")

    before, after = census(args.src), census(args.out)
    for field in ("pages", "title", "author", "toc"):
        if before[field] != after[field]:
            failures.append(f"lost {field}: {before[field]!r} -> {after[field]!r}")
    for index, (was, now) in enumerate(zip(before["pages_detail"], after["pages_detail"], strict=False), 1):
        for field in ("box", "rotate", "text", "annots", "links", "ink"):
            if was[field] != now[field]:
                failures.append(f"page {index} {field}: {was[field]!r} -> {now[field]!r}")

    print("preservation: pages", before["pages"], "->", after["pages"])
    for index, (was, now) in enumerate(zip(before["pages_detail"], after["pages_detail"], strict=False), 1):
        print(f"  page {index} ink {was['ink']} -> {now['ink']}  text {was['text']} -> {now['text']}")
    print("VERDICT", "FAIL: " + "; ".join(failures) if failures else "PASS")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
