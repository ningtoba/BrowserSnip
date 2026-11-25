#!/usr/bin/env python3
"""Judge a `rotate` output against its own source, sheet by sheet.

`rotate` promises "the same PDF with the pages you chose turned by 90°, 180° or
270°. Only the orientation changes — nothing is redrawn." Every part of that is a
number in the file:

  * the *orientation* half — sheet *i* carries `/Rotate (source + delta) % 360`
    when it was picked and its own `/Rotate` when it was not;
  * the *nothing is redrawn* half — the page's content streams are byte-identical
    to the source's, its `/MediaBox` and `/CropBox` are untouched, and the render
    at 100 dpi has the same non-white pixel count (a quarter turn is a frame
    change, so the ink of the turned sheet must equal the ink of the same sheet
    unturned — the tolerance below only covers antialiasing on the turned axis);
  * the *same PDF* half — annotations (type, rect, contents), link dictionaries,
    characters and `/Info` all come back unchanged.

Readings come from the produced bytes with PyMuPDF, and the same source measured
the same way is the expectation — never a guess.

    python3 docs/research/rotate-round-bytes.py --dir /tmp/rb/colour \
        --source /tmp/triage/colour.pdf          # exit 0 = every case as promised
    python3 docs/research/rotate-round-bytes.py --selfcheck

`--selfcheck` is the instrument test: a page of paper (`blank.pdf`) must read 0
ink and no content of its own, and the source must measure the same twice.
`--control` judges one turned case as if the delta were 0 and requires it to FAIL,
so a green row here cannot be a checker that ignores rotation.

The default CASES table below is this round's fixed build (dev server 5292,
`docs/research/rotate-round.sh` writes the downloads under `BYTES`, default
`/tmp/rb`); pass `--dir/--source` to judge one directory of
`<name>.pdf` outputs whose expectations are in EXPECT.
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import os
import sys

import pymupdf

DPI = 100
# Antialiasing on a turned frame moves a few thousand pixels out of ~500 000;
# anything larger is a cut corner or a scaled redraw. 0.3 % is the bar the
# campaign already used on this tool's pane row.
TURNED_TOLERANCE = 0.003

# name -> (source, picked pages (1-based), delta). "all" means every sheet.
EXPECT: dict[str, tuple[str, object, int]] = {
    "r90all": ("colour", "all", 90),
    "r180all": ("colour", "all", 180),
    "r270all": ("colour", "all", 270),
    "r90p4": ("colour", [4], 90),
    "r180p4": ("colour", [4], 180),
    "r270p4": ("colour", [4], 270),
    "r270p7": ("colour", [7], 270),
    "r90p8": ("colour", [8], 90),
    "r90list": ("colour", [1, 3, 6], 90),
    "r180rng": ("colour", [2, 3, 4], 180),
    "r90odd": ("colour", "odd", 90),
    "r270evn": ("colour", "even", 270),
    # `Rotation=4` / `Rotation=360` cannot reach the segmented control: the rail
    # writes the value as a user event, reads `group: 90° →*|180°|270° ←` back
    # unchanged (no chip says 4 or 360) and runs on the default 90. So the bytes
    # are source + 90, and the "must be 90/180/270" note is unreachable from this
    # control — which is what the round records, not what the file does.
    "r4chip": ("colour", "all", 90),
    "r360": ("colour", "all", 90),
    "r360all": ("colour", "all", 90),
    # The pane rig's own downloads (`docs/research/rotate-pane.mjs`, `--dir
    # /tmp/rb/r`): the angles these carry are the ones the strip announced for the
    # same sheets a moment before the click.
    "after270-p4": ("colour", [4], 270),
    "after90-p4": ("colour", [4], 90),
    "after270-typed47": ("colour", [4, 7], 270),
    # The two straighten runs re-driven after the sentence was fixed: the angles the
    # pane announced did not move.
    "r270p7-afterfix": ("colour", [7], 270),
    "r270p47-afterfix": ("colour", [4, 7], 270),
    "a90p1": ("annot", [1], 90),
    "a270p1": ("annot", [1], 270),
    "a90all": ("annot", "all", 90),
    "z90all": ("rot90", "all", 90),
}

SOURCES = {
    "colour": "/tmp/triage/colour.pdf",
    "annot": "/tmp/triage/in/annot.pdf",
    "rot90": "/tmp/triage/rot90.pdf",
}


def ink(page: pymupdf.Page) -> int:
    """Non-white pixels at 100 dpi, off the bitmap."""
    pix = page.get_pixmap(dpi=DPI)
    samples = memoryview(pix.samples)
    return sum(1 for i in range(0, len(samples), pix.n) if samples[i:i + 3] != b"\xff\xff\xff")


def streams(doc: pymupdf.Document, page: pymupdf.Page) -> list[str]:
    """Hashes of the page's own decompressed content streams, in order."""
    out = []
    for xref in page.get_contents():
        raw = doc.xref_stream(xref)
        out.append(hashlib.sha256(raw or b"").hexdigest()[:16] if raw else f"empty:{xref}")
    return out


def num(obj):
    """Round every number in a nested point list, whatever shape it came as."""
    if isinstance(obj, (list, tuple)):
        return [num(v) for v in obj]
    if isinstance(obj, float):
        return round(obj, 2)
    if hasattr(obj, "x") and hasattr(obj, "y"):
        return (round(obj.x, 2), round(obj.y, 2))
    if hasattr(obj, "tl"):  # a PyMuPDF Rect
        return [round(v, 2) for v in (obj.x0, obj.y0, obj.x1, obj.y1)]
    return obj


def close(a, b, tol=0.5):
    """Geometry compared with a rounding tolerance; anything else compared equal."""
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return abs(a - b) <= tol
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)) and len(a) == len(b):
        return all(close(x, y, tol) for x, y in zip(a, b))
    return a == b


def turn(rect, delta, width, height):
    """The same mark after the *page* is turned `delta`° clockwise.

    MuPDF hands back annotation and link rectangles in the rotated frame the
    reader sees, so a stored `/Rotate 90` moves them — that is the correct answer,
    and the source rect turned about the displayed page is the only fair thing to
    compare it with. `(x, y) -> (H - y, x)` for a quarter turn clockwise.
    """
    x0, y0, x1, y1 = rect
    pts = [(x0, y0), (x1, y0), (x0, y1), (x1, y1)]
    d = ((delta % 360) + 360) % 360
    if d == 90:
        moved = [(height - y, x) for x, y in pts]
    elif d == 180:
        moved = [(width - x, height - y) for x, y in pts]
    elif d == 270:
        moved = [(y, width - x) for x, y in pts]
    else:
        moved = pts
    xs, ys = [p[0] for p in moved], [p[1] for p in moved]
    return (round(min(xs), 1), round(min(ys), 1), round(max(xs), 1), round(max(ys), 1))


def annots(doc: pymupdf.Document, page: pymupdf.Page) -> dict:
    """The marks as the file stores them, and as the reader is shown them.

    `raw` is the annotation dictionary read out of the xref — `/Subtype`, `/Rect`,
    `/QuadPoints`, `/Contents`. A stored `/Rotate` is a frame change, so nothing in
    it may move: that is the identity the round demands.
    `shown` is what PyMuPDF hands a reader. MuPDF reports ordinary annotation
    rectangles in the page's *unrotated* space, so these do not swing with the
    turn (only the `/Rotate`-aware link map does, see `links`) — it is recorded so
    the row can be read, not asserted against a hand-rolled rotation.
    """
    raw, shown = [], []
    for a in (page.annots() or []):
        raw.append((a.type[1], doc.xref_get_key(a.xref, "Rect"), doc.xref_get_key(a.xref, "QuadPoints"),
                    (a.info or {}).get("content") or ""))
        shown.append((a.type[1], num(a.rect), num(a.vertices) if a.vertices else None,
                      (a.info or {}).get("content") or ""))
    return {"raw": raw, "shown": shown}


def links(doc: pymupdf.Document, page: pymupdf.Page) -> dict:
    """`/Link` annotations: the dictionaries (must not move) and the reader's map.

    `page.get_links()` answers in the *rotated* frame the reader sees, so turning
    the sheet must swing a link's rectangle by exactly the same quarter — `turn()`
    in `judge` is the expectation, and it is what makes "the links still work after
    the turn" a measurement rather than a count.
    """
    raw = [
        ("Link", doc.xref_get_key(a.xref, "Rect"),
         (a.info or {}).get("content") or "", (a.info or {}).get("uri") or "")
        for a in (page.annots() or []) if a.type[1] == "Link"
    ]
    shown = [
        (l.get("kind"), l.get("page"), l.get("uri") or "", num(l.get("from", pymupdf.Rect())))
        for l in page.get_links()
    ]
    return {"raw": raw, "shown": shown}


def sheet(doc: pymupdf.Document, page: pymupdf.Page) -> dict:
    pix = page.get_pixmap(dpi=DPI)
    return {
        "rot": page.rotation,
        "raw": doc.xref_get_key(page.xref, "Rotate"),
        "box": (round(page.rect.width, 1), round(page.rect.height, 1)),
        "render": (pix.width, pix.height),
        "media": tuple(round(v, 1) for v in page.mediabox),
        "crop": tuple(round(v, 1) for v in page.cropbox),
        "ink": ink(page),
        "streams": streams(doc, page),
        "chars": len(page.get_text()),
        "text": (page.get_text().splitlines() or [""])[0][:40],
        "words": sorted(page.get_text().split()),
        "annots": annots(doc, page),
        "links": links(doc, page),
        "images": len(page.get_images()),
    }


def info(doc: pymupdf.Document) -> dict:
    meta = doc.metadata or {}
    return {k: meta.get(k) or "" for k in
            ("title", "author", "subject", "keywords", "creator", "producer", "creationDate", "modDate")}


def picked(pick: object, total: int) -> set[int]:
    if pick == "all":
        return set(range(1, total + 1))
    if pick == "odd":
        return {i for i in range(1, total + 1) if i % 2 == 1}
    if pick == "even":
        return {i for i in range(1, total + 1) if i % 2 == 0}
    return set(pick or [])


def judge(label: str, source_path: str, output_path: str, pick: object, delta: int) -> list[str]:
    src = pymupdf.open(source_path)
    out = pymupdf.open(output_path)
    want_pages = picked(pick, src.page_count)
    problems: list[str] = []
    print(f"\n== {label}: {os.path.basename(output_path)}  source={source_path} "
          f"picked={sorted(want_pages)} delta={delta} ({os.path.getsize(source_path)} -> {os.path.getsize(output_path)} bytes)")
    if out.page_count != src.page_count:
        problems.append(f"page count {out.page_count} != {src.page_count}")
        return problems
    for page in out:
        i = page.number
        got = sheet(out, page)
        was = sheet(src, src[i])
        want_rot = (was["rot"] + delta) % 360 if (i + 1) in want_pages else was["rot"]
        turned = got["rot"] != was["rot"] or want_rot != was["rot"]
        ok_rot = got["rot"] == want_rot
        # A quarter turn swaps the box a reader sees; the stored `/MediaBox` and
        # `/CropBox` do not move. The displayed rect is therefore compared against
        # the source's own rect turned by the same quarter, never against itself.
        quarter = (want_rot - was["rot"]) % 180 == 90
        want_box = (was["box"][1], was["box"][0]) if quarter else was["box"]
        ok_box = (round(got["box"][0], 1), round(got["box"][1], 1)) == (round(want_box[0], 1), round(want_box[1], 1))
        # The marks: their dictionaries must not move at all (a stored `/Rotate` is
        # a frame change), while the rectangles a reader is shown must be the source
        # rectangles turned by exactly the same quarter about the same page.
        applied = (want_rot - was["rot"]) % 360
        W, H = was["box"]
        ok_ann_raw = got["annots"]["raw"] == was["annots"]["raw"]
        ok_link_raw = got["links"]["raw"] == was["links"]["raw"]
        ok_ann_shown = len(got["annots"]["shown"]) == len(was["annots"]["shown"]) and all(
            k == wk and vt == wvt and c == wc
            for (k, _rn, vt, c), (wk, _r, wvt, wc) in zip(got["annots"]["shown"], was["annots"]["shown"]))
        ok_link_shown = len(got["links"]["shown"]) == len(was["links"]["shown"]) and all(
            k_ == wk and pn == wpn and uu == wu and close(fr, turn(f, applied, W, H) if f else f)
            for (k_, pn, uu, fr), (wk, wpn, wu, f) in zip(got["links"]["shown"], was["links"]["shown"]))
        if turned:
            lo, hi = was["ink"] * (1 - TURNED_TOLERANCE), was["ink"] * (1 + TURNED_TOLERANCE)
            ok_ink = (lo <= got["ink"] <= hi) if was["ink"] else got["ink"] == 0
        else:
            ok_ink = got["ink"] == was["ink"]
        ok_rest = (
            got["media"] == was["media"] and got["crop"] == was["crop"]
            and got["streams"] == was["streams"] and got["chars"] == was["chars"]
            and got["words"] == was["words"] and ok_box
            and ok_ann_raw and ok_link_raw and ok_ann_shown and ok_link_shown
            and got["images"] == was["images"]
        )
        ratio = round(got["ink"] / was["ink"], 4) if was["ink"] else None
        marks = ""
        if was["annots"]["shown"] or was["links"]["shown"]:
            marks = (" marks src " + str([m[1] for m in was["annots"]["shown"]] + [m[3] for m in was["links"]["shown"]])
                     + " -> out " + str([m[1] for m in got["annots"]["shown"]] + [m[3] for m in got["links"]["shown"]]))
        print(f"   sheet {i + 1}: rot {got['rot']} (want {want_rot}, /Rotate {got['raw']}) "
              f"box {got['box']} (want {want_box}) render {got['render']} ink {got['ink']} (src {was['ink']} ratio {ratio}) "
              f"chars {got['chars']} ann {len(got['annots']['shown'])} (raw {'=' if ok_ann_raw else 'MOVED'}) "
              f"link {len(got['links']['shown'])} (raw {'=' if ok_link_raw else 'MOVED'}) "
              f"streams {got['streams']}{marks} {'OK' if ok_rot and ok_ink and ok_rest else ''}")
        if not ok_rot:
            problems.append(f"{label} sheet {i + 1}: /Rotate {got['rot']} != {want_rot}")
        if not ok_ink:
            problems.append(f"{label} sheet {i + 1}: ink {got['ink']} vs source {was['ink']} (ratio {ratio})")
        if got["media"] != was["media"] or got["crop"] != was["crop"]:
            problems.append(f"{label} sheet {i + 1}: box moved {was['media']}/{was['crop']} -> {got['media']}/{got['crop']}")
        if not ok_box:
            problems.append(f"{label} sheet {i + 1}: displayed box {got['box']} != {want_box}")
        if got["streams"] != was["streams"]:
            problems.append(f"{label} sheet {i + 1}: content streams rewritten (redrawn)")
        if got["chars"] != was["chars"] or got["text"] != was["text"] or got["words"] != was["words"]:
            problems.append(f"{label} sheet {i + 1}: text {got['chars']}/{got['text']!r} != {was['chars']}/{was['text']!r}")
        if not ok_ann_raw:
            problems.append(f"{label} sheet {i + 1}: annotation dictionaries moved {was['annots']['raw']} -> {got['annots']['raw']}")
        if not ok_ann_shown:
            problems.append(f"{label} sheet {i + 1}: annotations not where the turn puts them "
                            f"{was['annots']['shown']} -> {got['annots']['shown']}")
        if not ok_link_raw:
            problems.append(f"{label} sheet {i + 1}: link dictionaries moved {was['links']['raw']} -> {got['links']['raw']}")
        if not ok_link_shown:
            problems.append(f"{label} sheet {i + 1}: links not where the turn puts them "
                            f"{was['links']['shown']} -> {got['links']['shown']}")
        if got["images"] != was["images"]:
            problems.append(f"{label} sheet {i + 1}: images {was['images']} -> {got['images']}")
    si, oi = info(src), info(out)
    lost = [f"{k}: {si[k]!r} -> {oi[k]!r}" for k in si if si[k] and oi[k] != si[k]]
    print(f"   /Info {'unchanged' if not lost else 'MOVED ' + '; '.join(lost)}")
    if lost:
        problems.append(f"{label}: /Info {lost}")
    return problems


def selfcheck() -> None:
    blank = pymupdf.open("/tmp/triage/blank.pdf")
    print("selfcheck blank.pdf:", [ink(p) for p in blank], "streams",
          [streams(blank, p) for p in blank])
    if any(ink(p) for p in blank):
        sys.exit("instrument reads ink on a page of paper")
    src = pymupdf.open(SOURCES["colour"])
    a = [ink(p) for p in src]
    b = [ink(p) for p in pymupdf.open(SOURCES["colour"])]
    print("selfcheck colour.pdf ink:", a, "stable:", a == b)
    if a != b:
        sys.exit("instrument is not stable")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="")
    ap.add_argument("--source", default="")
    ap.add_argument("--selfcheck", action="store_true")
    ap.add_argument("--control", action="store_true")
    args = ap.parse_args()
    if args.selfcheck:
        selfcheck()
    problems: list[str] = []
    if args.control:
        # The turned sheet judged as if nothing had moved must FAIL, or this file
        # is a checker that cannot see a rotation.
        problems = judge("CONTROL r270all-as-identity", SOURCES["colour"],
                         os.path.join(os.environ.get("BYTES", "/tmp/rb"), "colour", "r270all.pdf"), "all", 0)
        print(f"\ncontrol: {len(problems)} problem lines (must be > 0)")
        return 0 if problems else 1
    if args.dir:
        cases = {}
        for path in sorted(glob.glob(os.path.join(args.dir, "*.pdf"))):
            name = os.path.basename(path)[:-4]
            cases[name] = EXPECT.get(name)
        for name, spec in cases.items():
            if spec is None:
                print(f"\n== {name}: no expectation recorded — skipped")
                continue
            source = args.source or SOURCES[spec[0]]
            problems += judge(name, source, os.path.join(args.dir, name + ".pdf"), spec[1], spec[2])
    else:
        root = os.environ.get("BYTES", "/tmp/rb")
        for directory in ("colour", "annot", "rot90"):
            for path in sorted(glob.glob(os.path.join(root, directory, "*.pdf"))):
                name = os.path.basename(path)[:-4]
                if name not in EXPECT:
                    continue
                spec = EXPECT[name]
                problems += judge(name, SOURCES[spec[0]], path, spec[1], spec[2])
    print("\n" + ("AS PROMISED — 0 problem lines" if not problems else f"{len(problems)} PROBLEM LINES"))
    for p in problems:
        print("  !", p)
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
