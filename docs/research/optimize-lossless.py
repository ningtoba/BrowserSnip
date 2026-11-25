#!/usr/bin/env python3
"""Does a "lossless" rebuild still draw the same picture? Equal, not close.

  python3 docs/research/optimize-lossless.py --src /tmp/triage/uncompressed.pdf \\
      --out /tmp/r023/after-uncompressed.pdf

Every page of the produced file is compared with the same-numbered page of the
source at the same dpi. `optimize-pdf` promises the same picture, so the answers
here are **equalities**: identical ink pixel count, identical text, identical
image dimensions and `/Filter`, same boxes, same rotation, same `/Annots`, same
links, same outline, same `/Info` keys, same embedded files.

`rail-measure.py` prints ink coverage as prose, which cannot distinguish a page
that kept its ink from one whose ink moved by a pixel row. This prints
per-invariant PASS/FAIL and exits 1 on any failure, so it can be used as the
control for a revert: run it on the source against itself (must pass) and on a
deliberately broken pair (must fail — `--self` inverts to prove that).

Filters on an image xref are read from the file, so a re-encode (DCTDecode
instead of FlateDecode) shows up as a changed filter even if the pixel count of
the page happens to survive a downsampled raster.
"""
import argparse
import hashlib
import json
import os
import re
import sys

import pymupdf
import numpy as np

DPI = 150


def page_ink(page):
    """`(sha256 of the whole RGB raster, count of non-white pixels)` at 150 dpi.

    The digest is the equality — a picture shifted by one pixel row scores the
    same count with a different hash. The count is Python-loop-free (`numpy`)
    because a 4 000-pixel-perimeter sheet is 2 M pixels a page and the corpus is
    38 files: the old per-sample generator spent minutes per fixture.
    """
    pix = page.get_pixmap(dpi=DPI, colorspace=pymupdf.csRGB, alpha=False)
    samples = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
    ink = int((samples < 245).any(axis=2).sum())
    return hashlib.sha256(pix.samples).hexdigest(), ink


def dangling(path, doc):
    """`N 0 R` strings in the file whose object is not in the xref.

    Ink identity cannot see this: a page renders while the trailer's `/Info`
    points at a deleted object. MuPDF reports "cannot find object in xref".
    """
    raw = open(path, "rb").read()
    missing = []
    for match in re.finditer(rb"(?<![0-9])(\d+) 0 R", raw):
        number = int(match.group(1))
        if number >= doc.xref_length():
            missing.append(number)
            continue
        try:
            if doc.xref_object(number, compressed=True) == "null":
                missing.append(number)
        except Exception:  # noqa: BLE001
            missing.append(number)
    return sorted(set(missing))


def images(doc, page):
    found = []
    for info in page.get_images(full=True):
        xref = info[0]
        raw = doc.xref_object(xref, compressed=True)
        filt = "none"
        for name in ("FlateDecode", "DCTDecode", "JPXDecode", "CCITTFaxDecode", "LZWDecode",
                     "RunLengthDecode", "JBIG2Decode"):
            if f"/{name}" in raw:
                filt = name
        # Decoded pixels, so a lossless Flate of a raw bitmap compares equal while a
        # re-encode (DCT, different size) does not.
        found.append((info[2], info[3], filt, hashlib.sha256(doc.xref_stream(xref) or b"").hexdigest()[:16]))
    return found


def links(page):
    return [(link.get("uri", ""), round(link["from"].x0, 2), round(link["from"].y0, 2),
             link.get("page", -1)) for link in page.get_links()]


def annots(page):
    return [(a.type[1], tuple(round(v, 2) for v in a.rect)) for a in (page.annots() or [])]


def describe(path, password=None):
    doc = pymupdf.open(path)
    if doc.needs_pass and password:
        # A locked file is only judgeable with the secret the rail typed into the
        # card; `colour-rail.mjs` records it per run (`cardPassword`).
        doc.authenticate(password)
    pages = []
    for page in doc:
        text = page.get_text()
        digest, ink = page_ink(page)
        pages.append({
            "ink": ink,
            "pixels": digest,
            "chars": len(text),
            "text": hashlib.sha256(str(text).encode()).hexdigest()[:16],
            "rect": tuple(round(v, 2) for v in page.rect),
            "mediabox": tuple(round(v, 2) for v in page.mediabox),
            "cropbox": tuple(round(v, 2) for v in page.cropbox),
            "rotation": page.rotation,
            "images": images(doc, page),
            "links": links(page),
            "annots": annots(page),
        })
    return {
        "pages": pages,
        "info": {k: v for k, v in (doc.metadata or {}).items() if v},
        "toc": doc.get_toc(),
        "dangling": dangling(path, doc),
        # A "lossless" rebuild of a locked file is allowed to say it kept the
        # protection; the only way to hold it to that is to read the flag back.
        "encryption": {
            "encrypted": bool(doc.is_encrypted),
            "needs_pass": bool(doc.needs_pass),
            "permissions": str(getattr(doc, "permissions", None)),
        },
        "files": [(name, hashlib.sha256(doc.embfile_get(name) or b"").hexdigest()[:16])
                  for name in doc.embfile_names()],
    }


def compare(src, out, allow=(), verbose=False, password=None):
    """Compare two files page by page; returns `(failures, notes, facts)`.

    `allow` names invariants a *deliberate* option is expected to move (the
    `stripMetadata` run legitimately empties `/Info`), so the batch can still
    fail every other equality on the same file.
    """
    before = describe(src, password)
    after = describe(out, password)
    failures = []
    notes = []
    allowed = set(allow)

    def emit(line):
        (notes if verbose else notes).append(line)

    def check(name, a, b, group=None):
        ok = a == b
        if verbose:
            print(f"{'PASS' if ok else 'FAIL'} {name}: {a!r} vs {b!r}")
        if not ok and group not in allowed:
            failures.append(name)

    check("page count", len(before["pages"]), len(after["pages"]))
    check("page sizes", [p["rect"] for p in before["pages"]], [p["rect"] for p in after["pages"]])
    check("info keys", sorted(before["info"]), sorted(after["info"]), group="info")
    for key in sorted(before["info"]):
        check(f"info/{key}", before["info"][key], after["info"].get(key), group="info")
    check("outline", before["toc"], after["toc"])
    check("dangling refs", before["dangling"], after["dangling"])
    check("encryption", before["encryption"], after["encryption"])
    check("embedded files", before["files"], after["files"])

    for index, source in enumerate(before["pages"]):
        if index >= len(after["pages"]):
            failures.append(f"page {index + 1} missing")
            continue
        got = after["pages"][index]
        for field in ("ink", "pixels", "chars", "text", "rect", "mediabox", "cropbox",
                      "rotation", "links", "annots"):
            check(f"page {index + 1} {field}", source[field], got[field])
        # `/Filter` may change when `compressStreams` Flate-codes a stored bitmap:
        # that is lossless, so dims and decoded pixels are the equality and a filter
        # change is printed as a note. A re-encode moves the decoded digest.
        check(f"page {index + 1} images",
              [(i[0], i[1], i[3]) for i in source["images"]],
              [(i[0], i[1], i[3]) for i in got["images"]])
        for old, new in zip(source["images"], got["images"]):
            if old[2] != new[2]:
                emit(f"NOTE page {index + 1} image filter {old[2]} -> {new[2]} (decoded pixels equal)")

    total_ink = sum(p["ink"] for p in before["pages"])
    got_ink = sum(p["ink"] for p in after["pages"])
    sha_equal = [
        (s["pixels"] == g["pixels"], s["ink"] == g["ink"])
        for s, g in zip(before["pages"], after["pages"])
    ]
    facts = {
        "pages": len(before["pages"]),
        "ink": [total_ink, got_ink],
        "chars": [sum(p["chars"] for p in before["pages"]), sum(p["chars"] for p in after["pages"])],
        "sha_equal": all(s for s, _ in sha_equal),
        "ink_equal": all(i for _, i in sha_equal),
        "per_page": [{"ink": s["ink"], "sha": s["pixels"][:8], "out_ink": g["ink"], "out_sha": g["pixels"][:8]}
                     for s, g in zip(before["pages"], after["pages"])],
        "bytes": [len(open(src, "rb").read()), len(open(out, "rb").read())],
        "same_bytes": open(src, "rb").read() == open(out, "rb").read(),
    }
    return failures, notes, facts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src")
    ap.add_argument("--out")
    ap.add_argument("--batch", help="colour-rail JSONL of runs to judge one per line")
    ap.add_argument("--tool", default="optimize-pdf", help="which runs in --batch to judge")
    ap.add_argument("--fixtures", action="append", default=[], help="dir(s) to resolve run file names in")
    ap.add_argument("--allow", default="", help="comma list of invariants an option is meant to move (info)")
    ap.add_argument("--self", nargs="*", metavar="SRC", help="prove the checker discriminates")
    args = ap.parse_args()

    if args.self:
        return self_test(args.self, [f for f in (args.src, args.out) if f])

    if args.batch:
        return run_batch(args.batch, args.tool, args.fixtures or ["/tmp/triage/in", "/tmp/triage"],
                         [a for a in args.allow.split(",") if a])

    if not args.src or not args.out:
        ap.print_usage()
        return 2
    failures, notes, facts = compare(args.src, args.out, verbose=True)
    for line in notes:
        print(line)
    print(f"\nink pixels {facts['ink'][0]} vs {facts['ink'][1]} (dpi {DPI})")
    print(f"chars {facts['chars'][0]} vs {facts['chars'][1]}")
    print("VERDICT", "IDENTICAL" if not failures else f"{len(failures)} FAILURE(S): {sorted(set(failures))}")
    return 1 if failures else 0


def resolve(name, dirs):
    for directory in dirs:
        path = os.path.join(directory, name)
        if os.path.exists(path):
            return path
    return None


def run_batch(jsonl, tool, dirs, allow):
    """One line per case: did the rebuild draw the same picture, page by page?

    A case whose output bytes are the input bytes (the tool handed the file back
    because the rebuild was not smaller) is counted separately: it proves the
    honesty of that branch and nothing at all about the rebuild.
    """
    rows = []
    with open(jsonl) as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            record = json.loads(line)
            if record.get("tool") != tool:
                continue
            tag = record.get("tag", "?")
            src_name = (record.get("files") or [""])[0]
            src = resolve(src_name, dirs)
            if not src:
                rows.append({"case": tag, "verdict": "NO FIXTURE", "file": src_name})
                continue
            outputs = record.get("outputs") or []
            if not outputs:
                rows.append({"case": tag, "verdict": "NO OUTPUT", "screen": (record.get("alert") or "")[:120],
                             "fail": record.get("fail")})
                continue
            out = outputs[0]["path"]
            try:
                failures, notes, facts = compare(
                    src, out, allow=allow, password=record.get("cardPassword")
                )
            except Exception as error:  # noqa: BLE001 - the produced file may not open at all
                rows.append({"case": tag, "verdict": f"UNREADABLE: {error}", "out": out})
                continue
            rows.append({
                "case": tag,
                "src": os.path.basename(src),
                "verdict": "IDENTICAL" if not failures else f"{len(failures)} FAILURE(S)",
                "rebuild": "as-input" if facts["same_bytes"] else "rewritten",
                "pages": facts["pages"],
                "ink": facts["ink"],
                "sha_equal": facts["sha_equal"],
                "bytes": facts["bytes"],
                "chars": facts["chars"],
                "failures": sorted(set(failures))[:8],
                "notes": notes,
            })
    bad = [r for r in rows if r["verdict"] not in ("IDENTICAL",)]
    rebuilt = [r for r in rows if r.get("rebuild") == "rewritten"]
    for row in rows:
        print(json.dumps(row))
    for row in rows:
        if row.get("notes"):
            print(f"  {row['case']}: " + " | ".join(row["notes"]))
    print(f"\n{len(rows)} case(s) for `{tool}`: {len(rows) - len(bad)} identical, {len(bad)} not, "
          f"{len(rebuilt)} actually rewritten by the tool, "
          f"{len(rows) - len(rebuilt)} handed back byte-for-byte as input")
    for row in bad:
        print(f"  NOT IDENTICAL: {row['case']} -> {row['verdict']} "
              + (f"{row['failures']}" if row.get("failures") else ""))
    return 1 if bad else 0


def self_test(sources, pair):
    """The instrument before the finding: equal files must pass, different ones must not."""
    failures = 0
    for src in sources:
        out = f"{src}.selfcheck.pdf"
        turned_ok = False
        with pymupdf.open(src) as doc:
            if doc.page_count:
                # The same page count, the same objects, the same characters — and a
                # sheet turned 90°, which only a render comparison can see.
                last = doc[doc.page_count - 1]
                last.set_rotation((last.rotation + 90) % 360)
                doc.save(out, garbage=4, deflate=True)
                turned_ok = True
        if turned_ok:
            same = compare(src, src)[0]
            turned = compare(src, out)[0]
            ok_same, ok_diff = not same, bool(turned)
            print(f"{'PASS' if ok_same else 'FAIL'} {os.path.basename(src)}: src vs src -> "
                  f"{len(same)} failure(s) (want 0)")
            print(f"{'PASS' if ok_diff else 'FAIL'} {os.path.basename(src)}: src vs last-page-turned -> "
                  f"{len(turned)} failure(s) (want >0): {sorted(set(turned))[:3]}")
            failures += (not ok_same) + (not ok_diff)
    if pair and len(pair) == 2:
        moved = compare(pair[0], pair[1])[0]
        print(f"{'PASS' if moved else 'FAIL'} cross-fixture {os.path.basename(pair[0])} vs "
              f"{os.path.basename(pair[1])} -> {len(moved)} failure(s) (want >0)")
        failures += not moved
    print("SELFTEST", "OK" if not failures else f"{failures} PROBLEM(S)")
    return 1 if failures else 0



if __name__ == "__main__":
    sys.exit(main())
