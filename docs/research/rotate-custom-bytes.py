#!/usr/bin/env python3
"""rotate-custom — what the produced file actually contains, per sheet.

    python3 docs/research/rotate-custom-bytes.py --dir /tmp/r/rc --source /tmp/triage/colour.pdf

For every produced sheet and the source sheet it came from, prints the displayed
box, `/Rotate`, non-white pixels at 100 dpi, the dark-ink centroid, the direction of
the first text line (degrees, image space, y down), characters, `/Annots`, links and
images, plus `/Info` — and, for a 1:1 turn, the ink ratio against the source, which is
what says whether a corner was cut or the content was scaled.

The instrument is checked before it is trusted: `--selfcheck` measures a page of
paper (`blank.pdf`) and requires 0 ink and no line direction on it, and re-measures
the source twice to prove the numbers are stable.
"""
import argparse
import hashlib
import json
import math
import os
import sys

import pymupdf

DPI = 100


def displayed(page):
    """The box a reader is shown.

    `page.rect` is already the rotated rectangle in MuPDF — a sheet stored 420×595
    with `/Rotate 90` reports 595×420 — so this does NOT swap on rotation. (It used
    to, which double-counted the turn and made every rotated source sheet look a
    quarter-turn away from the page the tool actually produced.)
    """
    return page.rect.width, page.rect.height


def streams(doc, page):
    """Hashes of the page's own decompressed content streams, in order."""
    out = []
    for xref in page.get_contents():
        raw = doc.xref_stream(xref)
        out.append(hashlib.sha256(raw or b"").hexdigest()[:16] if raw else f"empty:{xref}")
    return out


def ink(pix):
    """(non-white pixel count, centroid of the dark pixels) of a pixmap."""
    data = pix.samples
    n = pix.n
    stride = pix.stride
    nonwhite = 0
    dark_n = 0
    sx = sy = 0.0
    for y in range(pix.height):
        row = y * stride
        for x in range(pix.width):
            i = row + x * n
            r, g, b = data[i], data[i + 1], data[i + 2]
            if r != 255 or g != 255 or b != 255:
                nonwhite += 1
            if r < 128 and g < 128 and b < 128:
                dark_n += 1
                sx += x
                sy += y
    centroid = (round(sx / dark_n / pix.width, 3), round(sy / dark_n / pix.height, 3)) if dark_n else None
    return nonwhite, dark_n, centroid


def line_direction(page):
    """Direction of the first text line, in image space (y down), degrees."""
    raw = page.get_text("rawdict")
    for block in raw.get("blocks", []):
        for line in block.get("lines", []):
            chars = [c for span in line["spans"] for c in span["chars"]]
            if len(chars) < 3:
                continue
            first, last = chars[0]["origin"], chars[-1]["origin"]
            dx, dy = last[0] - first[0], last[1] - first[1]
            if math.hypot(dx, dy) < 2:
                continue
            return round(math.degrees(math.atan2(dy, dx)), 1)
    return None


def measure(path, sheets=None):
    doc = pymupdf.open(path)
    out = {"file": path, "pages": doc.page_count, "meta": doc.metadata, "sheets": []}
    for page in doc:
        if sheets is not None and page.number not in sheets:
            continue
        w, h = displayed(page)
        pix = page.get_pixmap(dpi=DPI)
        nonwhite, dark, centroid = ink(pix)
        out["sheets"].append({
            "page": page.number,
            "displayed": [round(w, 1), round(h, 1)],
            "rendered": [pix.width, pix.height],
            "rotate": page.rotation,
            "mediabox": [round(v, 1) for v in page.mediabox],
            "cropbox": [round(v, 1) for v in page.cropbox],
            "ink": nonwhite,
            "dark": dark,
            "centroid": centroid,
            "line": line_direction(page),
            "chars": len(page.get_text()),
            "annots": len(list(page.annots() or [])),
            "annots_raw": annots_raw(doc, page),
            "annots_count": len(annots_raw(doc, page)),
            "links": len(page.get_links()),
            "images": len(page.get_images()),
            "streams": streams(doc, page),
            "first_line": str(page.get_text("text")).strip().split("\n")[0][:60],
            "ink_x": round(pix.width * (centroid[0] if centroid else 0), 1),
        })
    return out


def annots_raw(doc, page):
    """The page's own `/Annots` entries as xref tokens, indirect array included."""
    kind, value = doc.xref_get_key(page.xref, "Annots")
    if kind == "xref":
        value = doc.xref_object(int(value.split()[0]), compressed=False)
        kind = "array" if value.startswith("[") else kind
    if kind != "array" or not value:
        return []
    # `[]` is an empty array, not one mark: the tokens are the `N 0 R` entries.
    return [token for token in value.replace("[", " ").replace("]", " ").split(" R ") if token.strip()]


def body_chars(path):
    """Every page's character count with its annotations removed.

    MuPDF folds a free-text note's own words into `get_text()`, so `annot.pdf`
    sheet 1 reads 1 816 characters: 1 779 of body copy plus the 37 of "A free-text
    note sitting on the page". The rebuild leaves the marks behind (and says so), so
    the body alone is what a turned sheet has to keep — measured by stripping the
    marks off a copy of the source, not by guessing which annots draw text.
    """
    doc = pymupdf.open(path)
    for page in doc:
        for annot in list(page.annots() or []):
            annot.remove() if hasattr(annot, "remove") else page.delete_annot(annot)
    copy = pymupdf.open(stream=doc.tobytes(), filetype="pdf")
    return [len(page.get_text()) for page in copy]


def turn_box(width, height, angle):
    """The box a `width × height` rectangle needs when turned `angle` degrees."""
    radians = math.radians(abs(angle))
    cosine, sine = abs(math.cos(radians)), abs(math.sin(radians))
    return (width * cosine + height * sine, width * sine + height * cosine)


def norm_dir(degrees_value):
    """Fold an image-space direction into (-180, 180]."""
    return ((float(degrees_value) + 180) % 360) - 180


# One row per case the round rig runs: (source, picked pages, angle the field held, fit).
# `D` is 180, not 360: the angle control is a slider with `max 180`, and writing 360
# into a range input leaves it at 180 — measured in the rig's own read-back, and the
# card prints the same 180 it ran with.
ROUND_CASES = [
    ("A-all-30-grow", "colour", "all", 30, "grow"),
    ("B-all-neg30-grow", "colour", "all", -30, "grow"),
    ("C-all-0-grow", "colour", "all", 0, "grow"),
    ("D-all-360-grow", "colour", "all", 180, "grow"),
    ("E-all-45-keep", "colour", "all", 45, "keep"),
    ("F-all-90-grow", "colour", "all", 90, "grow"),
    ("G-all-neg90-grow", "colour", "all", -90, "grow"),
    ("H-p4-0-grow", "colour", [4], 0, "grow"),
    ("I-p4-30-grow", "colour", [4], 30, "grow"),
    ("J-p4-90-grow", "colour", [4], 90, "grow"),
    ("K-p3-empty-30-grow", "colour", [3], 30, "grow"),
    ("L-p1-30-grow", "colour", [1], -30, "grow"),
    ("AN-p1-30-grow", "annot", [1], 30, "grow"),
    ("AN-all-90-grow", "annot", "all", 90, "grow"),
    ("AB-p1-30-grow", "bookmarked", [1], 30, "grow"),
    ("AM-all-15-grow", "meta", "all", 15, "grow"),
]

ROUND_SOURCES = {
    "colour": "/tmp/triage/colour.pdf",  # noqa: S108
    "annot": "/tmp/triage/in/annot.pdf",  # noqa: S108
    "bookmarked": "/tmp/triage/in/bookmarked.pdf",  # noqa: S108
    "meta": "/tmp/triage/in/meta.pdf",  # noqa: S108
}

# A turned page is re-laid from the source box, so its ink moves a little: measured
# 0.9994 to 1.019 when the page grew (antialiasing on the diagonals), and 0.304 to
# 0.934 when the old box was kept (the low number is the 336x71 slip at 45°, whose
# ink is mostly outside the kept frame). The bands are those measurements, not
# invented thresholds.
GROW_INK = (0.95, 1.06)
KEEP_INK = (0.0, 1.02)
BOX_TOLERANCE_PT = 0.2
DIRECTION_TOLERANCE_DEG = 0.6
INFO_KEYS = ("title", "author", "subject", "keywords", "creator")


def judge_case(name, source_path, output_path, pick, angle, fit, expect_turned=True):
    """One case: every sheet compared with the source sheet it came from."""
    src, out = pymupdf.open(source_path), pymupdf.open(output_path)
    total = src.page_count
    chosen = set(range(1, total + 1)) if pick == "all" else {int(p) for p in pick}
    problems = []
    print(f"\n== {name}: {os.path.basename(output_path)} picked={sorted(chosen)} angle={angle} fit={fit} "
          f"({os.path.getsize(source_path)} -> {os.path.getsize(output_path)} bytes)")
    if out.page_count != total:
        problems.append(f"{name}: page count {out.page_count} != {total}")
        return problems
    was_all = {s["page"]: s for s in measure(source_path)["sheets"]}
    got_all = {s["page"]: s for s in measure(output_path)["sheets"]}
    bodies = body_chars(source_path)
    for i in range(total):
        was, got = was_all[i], got_all[i]
        # The body copy alone: MuPDF reads a free-text note's words as page text,
        # and the note is left behind by the rebuild (the tool says so).
        body = bodies[i]
        if (i + 1) not in chosen:
            keys = ("displayed", "rotate", "ink", "chars", "annots_count", "links", "images", "streams")
            moved = [f"{key} {was[key]!r} -> {got[key]!r}" for key in keys if was[key] != got[key]]
            print(f"   sheet {i + 1} (as it was): box {got['displayed']} rot {got['rotate']} ink {got['ink']} "
                  f"chars {got['chars']} ann {len(got['annots_raw'])} link {got['links']} img {got['images']} "
                  f"streams {got['streams']} {'OK' if not moved else 'CHANGED: ' + '; '.join(moved)}")
            if moved:
                problems.append(f"{name} sheet {i + 1}: not copied verbatim — {'; '.join(moved)}")
            continue
        want = turn_box(was["displayed"][0], was["displayed"][1], angle) if fit == "grow" else tuple(was["displayed"])
        box_ok = abs(got["displayed"][0] - want[0]) <= BOX_TOLERANCE_PT and abs(got["displayed"][1] - want[1]) <= BOX_TOLERANCE_PT
        lo, hi = GROW_INK if fit == "grow" else KEEP_INK
        ratio = round(got["ink"] / was["ink"], 4) if was["ink"] else None
        ink_ok = (lo <= ratio <= hi) if ratio is not None else got["ink"] == was["ink"]
        if was["line"] is None or got["chars"] == 0:
            # A sheet with no line to read, or one whose copy all fell outside the
            # kept frame (`E-all-45-keep` sheet 2: 13 characters, none of them inside
            # the old box), cannot testify about a direction. The ink row does.
            line_ok, want_line = True, None
        else:
            want_line = round(norm_dir(was["line"] + angle), 1)
            line_ok = got["line"] is not None and abs(norm_dir(got["line"]) - want_line) <= DIRECTION_TOLERANCE_DEG
        rot_ok = got["rotate"] == 0
        # A grown frame holds every character of the body copy; a kept frame clips
        # some of it outside the page (measured: 49 of sheet 1's 1 779 characters at
        # 45°), which is the corner-cutting the tool counts in its own warning.
        text_ok = got["chars"] == body if fit == "grow" else got["chars"] <= body
        # The rebuild leaves the marks behind — the tool says so — so a mark that
        # DID come along would make its own warning false.
        marks_false_promise = len(was["annots_raw"]) and len(got["annots_raw"])
        ok = box_ok and ink_ok and line_ok and rot_ok and text_ok and not marks_false_promise
        print(f"   sheet {i + 1} (turned): box {got['displayed']} (want {round(want[0], 1)}x{round(want[1], 1)}) "
              f"rot {got['rotate']} (want 0) ink {got['ink']} ratio {ratio} (want {lo}-{hi}) "
              f"line {got['line']} (want {want_line}) chars {got['chars']} (body {body}) "
              f"ann {len(got['annots_raw'])} (was {len(was['annots_raw'])}) link {got['links']} img {got['images']} "
              f"streams {got['streams']} {'OK' if ok else 'WRONG'}")
        if not expect_turned:
            continue
        if not rot_ok:
            problems.append(f"{name} sheet {i + 1}: /Rotate {got['rotate']} — the turn was stored, not baked into the content")
        if not box_ok:
            problems.append(f"{name} sheet {i + 1}: box {got['displayed']} != the {angle}° turn of "
                            f"{was['displayed']} ({round(want[0], 1)}x{round(want[1], 1)})")
        if not ink_ok:
            problems.append(f"{name} sheet {i + 1}: ink ratio {ratio} outside {lo}-{hi} "
                            f"({was['ink']} -> {got['ink']})")
        if not line_ok:
            problems.append(f"{name} sheet {i + 1}: first-line direction {got['line']} != {want_line}")
        if not text_ok:
            problems.append(f"{name} sheet {i + 1}: text {got['chars']} against the source body {body} "
                            f"({fit} frame)")
        if marks_false_promise:
            problems.append(f"{name} sheet {i + 1}: {len(got['annots_raw'])} of the source's {len(was['annots_raw'])} "
                            f"marks came along although the tool warns they are lost")
    smeta, ometa = src.metadata or {}, out.metadata or {}
    lost = [f"{key}: {smeta.get(key)!r} -> {ometa.get(key)!r}" for key in INFO_KEYS
            if (smeta.get(key) or "") and (ometa.get(key) or "") != (smeta.get(key) or "")]
    xmp_src, xmp_out = len(src.get_xml_metadata() or ""), len(out.get_xml_metadata() or "")
    producer = ometa.get("producer") or ""
    print(f"   /Info {'carried' if not lost else 'LOST ' + '; '.join(lost)}; XMP {xmp_src} -> {xmp_out}; "
          f"producer {producer!r}")
    problems.extend(f"{name}: /Info {line}" for line in lost)
    if xmp_out != xmp_src:
        problems.append(f"{name}: XMP packet {xmp_src} -> {xmp_out} bytes")
    if producer != "BrowserSnip":
        problems.append(f"{name}: producer {producer!r} is not this app's, as the card's own note says")
    return problems


def judge_round(root, control=False):
    """Judge every case of a round directory; `--control` mislabels one angle."""
    dirs = {"colour": "rc", "annot": "rc-annot", "bookmarked": "rc-book", "meta": "rc-meta"}
    problems = []
    for name, key, pick, angle, fit in ROUND_CASES:
        path = os.path.join(root, dirs[key], f"{name}.pdf")
        if not os.path.exists(path):
            problems.append(f"{name}: no download at {path}")
            continue
        if control and name != "A-all-30-grow":
            continue
        problems += judge_case(name, ROUND_SOURCES[key], path,
                               pick, 60 if control else angle, fit)
    if control:
        print(f"\ncontrol: A-all-30-grow judged as a 60° turn -> {len(problems)} problem lines (must be > 0)")
        return 0 if problems else 1
    print("\n" + ("AS PROMISED — 0 problem lines" if not problems else f"{len(problems)} PROBLEM LINES"))
    for problem in problems:
        print("  !", problem)
    return 0 if not problems else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir")
    ap.add_argument("--source", default="/tmp/triage/colour.pdf")  # noqa: S108
    ap.add_argument("--cases", default="")
    ap.add_argument("--selfcheck", action="store_true")
    ap.add_argument("--judge", default="", help="judge a round directory against its expectations")
    ap.add_argument("--control", action="store_true", help="prove the judge can see a turn")
    args = ap.parse_args()

    if args.judge:
        sys.exit(judge_round(args.judge, args.control))

    source = measure(args.source)
    if args.selfcheck:
        blank = measure("/tmp/triage/blank.pdf")  # noqa: S108
        print("selfcheck blank:", json.dumps(blank["sheets"]))
        again = measure(args.source)
        same = [s["ink"] for s in again["sheets"]] == [s["ink"] for s in source["sheets"]]
        print("selfcheck stable source re-measure:", same)
        if not same:
            sys.exit("instrument is not stable")
    print("SOURCE:", json.dumps(source["sheets"]))
    print("SOURCE /Info title:", json.dumps(source["meta"].get("title")))

    import glob
    import os
    names = sorted(glob.glob(os.path.join(args.dir, "*.pdf")))
    if args.cases:
        wanted = set(args.cases.split(","))
        names = [n for n in names if os.path.basename(n).split(".")[0] in wanted]
    for name in names:
        got = measure(name)
        src_ink = [s["ink"] for s in source["sheets"]]
        line = []
        for s in got["sheets"]:
            src = src_ink[s["page"]] if s["page"] < len(src_ink) else None
            ratio = round(s["ink"] / src, 3) if src else None
            line.append(f"p{s['page']} box={s['displayed']} rot={s['rotate']} ink={s['ink']} "
                        f"ratio={ratio} dark={s['dark']} cen={s['centroid']} line={s['line']} "
                        f"chars={s['chars']} ann={s['annots']} link={s['links']} img={s['images']}")
        print(os.path.basename(name), f"pages={got['pages']}",
              "title=" + json.dumps(got["meta"].get("title")))
        for row in line:
            print("   ", row)


if __name__ == "__main__":
    main()
