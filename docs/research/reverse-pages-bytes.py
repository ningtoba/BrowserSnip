#!/usr/bin/env python3
"""Judge a reverse-pages output against its own source, sheet by sheet.

`reverse-pages` promises "the same pages in the opposite order". That is a
testable shape: output sheet *i* must be source sheet *n-1-i* — the same ink, the
same box, the same stored `/Rotate`, the same first text line, its annotations and
its links — while `/Info` and the XMP packet stay the document's own (they live
above the page tree, so `copyPages` leaves them behind unless the run carries
them).

Every reading is taken from the file with PyMuPDF: ink at 100 dpi off
`get_pixmap()`, counts of `/Annots` and link dicts, the `/Info` keys and the
length of the packet. Run it with no argument and it judges the fixed build; pass
`--before` for the run recorded before the fix.

    python3 docs/research/reverse-pages-bytes.py            # exit 0 = as promised
    python3 docs/research/reverse-pages-bytes.py --before   # exit 1 on the info loss

Controls, so a green is not a page of paper:
  * `same` — the source against itself must FAIL the order comparison;
  * sheet 3 of `colour.pdf` is blank (ink 0), so the ink check alone cannot carry
    the sheet identity — the box/rotation/first-line readings have to.
"""
import sys

import pymupdf

BEFORE = "--before" in sys.argv
CASES = [
    # (label, source, output before the fix, output after it)
    ("colour", "/tmp/triage/colour.pdf", "/tmp/r/reverse-base.pdf", "/tmp/r/after-base.pdf"),
    ("annot", "/tmp/triage/in/annot.pdf", "/tmp/r/reverse-annot.pdf", "/tmp/r/after-annot.pdf"),
    ("bookmarked", "/tmp/triage/in/bookmarked.pdf", "/tmp/r/reverse-bookmarked.pdf", "/tmp/r/after-bookmarked.pdf"),
    ("meta", "/tmp/triage/in/meta.pdf", "/tmp/r/reverse-meta.pdf", "/tmp/r/after-meta.pdf"),
    ("attach", "/tmp/triage/in/attach.pdf", "/tmp/r/reverse-attach.pdf", "/tmp/r/after-attach.pdf"),
    ("labels", "/tmp/r/in-labels.pdf", "/tmp/r/reverse-labels.pdf", "/tmp/r/after-labels.pdf"),
    ("link", "/tmp/r/in-link.pdf", "/tmp/r/reverse-link.pdf", "/tmp/r/after-link.pdf"),
    ("one-page", "/tmp/triage/in/table.pdf", "/tmp/r/reverse-one.pdf", "/tmp/r/after-one.pdf"),
    ("two-page", "/tmp/r/in-2page.pdf", "/tmp/r/reverse-two.pdf", "/tmp/r/after-two.pdf"),
    ("round-trip", "/tmp/triage/colour.pdf", "/tmp/r/reverse-roundtrip.pdf", "/tmp/r/after-roundtrip.pdf"),
]


def ink(page):
    """Non-white pixels at 100 dpi.

    `pix.samples` hands back a fresh copy of the whole buffer on every access, so
    it is pinned in a memoryview first: read per pixel it took 10 s a sheet, which
    is a hang next to a ten-case table.
    """
    pix = page.get_pixmap(dpi=100)
    samples = memoryview(pix.samples)
    return sum(
        1 for i in range(0, len(samples), pix.n) if samples[i:i + 3] != b"\xff\xff\xff"
    )


def sheets(doc):
    out = []
    for page in doc:
        first = [line for line in page.get_text().splitlines() if line.strip()][:1]
        out.append({
            "w": round(page.rect.width, 1),
            "h": round(page.rect.height, 1),
            "rot": page.rotation,
            "ink": ink(page),
            "text": first[0] if first else "",
            "annots": len(list(page.annots() or [])),
            "links": [(link["kind"], link.get("page")) for link in page.get_links()],
            "label": page.get_label(),
        })
    return out


def info(doc):
    """The identity a reader knows the document by, as a comparable list.

    `keywords` comes back from `carryDocInfo` space-separated where the source
    stored commas, so the *list* is what is compared, not the string. A key the
    source does not have is not compared at all: `pdf-lib` writes its own
    `Creator` on every document it creates, which is pre-existing behaviour of the
    shared writer rather than something this tool adds.
    """
    meta = doc.metadata or {}
    return {key: meta.get(key) or "" for key in ("title", "author", "subject", "keywords", "creator")}


def missing_info(source, out):
    source_info, out_info = info(source), info(out)
    want = {key: value for key, value in source_info.items() if value}
    problems = []
    for key, value in want.items():
        if key == "keywords":
            if sorted(value.replace(",", " ").split()) != sorted(out_info[key].split()):
                problems.append(f"keywords {out_info[key]!r} != {value!r}")
        elif out_info[key] != value:
            problems.append(f"/Info {key} {out_info[key]!r} != {value!r}")
    return problems


def judge(label, source_path, output_path, reversed_expected):
    source = pymupdf.open(source_path)
    out = pymupdf.open(output_path)
    print(f"\n== {label}: {source.page_count} -> {out.page_count} pages, "
          f"info {info(source)} / {info(out)}, producer {out.metadata.get('producer')!r}")
    problems = []
    if out.page_count != source.page_count:
        problems.append(f"page count {out.page_count} != {source.page_count}")
    src = sheets(source)
    got = sheets(out)
    for i, sheet in enumerate(got):
        want = src[source.page_count - 1 - i] if reversed_expected else src[i]
        print(f"   sheet {i + 1}: box {sheet['w']}x{sheet['h']} rot {sheet['rot']} ink {sheet['ink']} "
              f"annots {sheet['annots']} links {sheet['links']} label {sheet['label']!r} "
              f"text {sheet['text'][:24]!r} | want box {want['w']}x{want['h']} rot {want['rot']} "
              f"ink {want['ink']} annots {want['annots']} links {want['links']} label {want['label']!r} "
              f"text {want['text'][:24]!r}")
        # A link names a page *index*: reversing moves it, so the expectation is
        # translated through the same map before the comparison.
        moved = [
            (kind, None if page is None else source.page_count - 1 - page)
            for kind, page in want["links"]
        ]
        if sheet["links"] != moved:
            problems.append(f"sheet {i + 1} links: {sheet['links']!r} != {moved!r} (source {want['links']!r})")
        for key in ("w", "h", "rot", "ink", "text", "annots", "label"):
            if sheet[key] != want[key]:
                problems.append(f"sheet {i + 1} {key}: {sheet[key]!r} != {want[key]!r}")
    # The document's identity is not a page: it has to survive whatever the order.
    problems.extend(missing_info(source, out))
    if out.metadata.get("producer") != "BrowserSnip":
        problems.append(f"producer {out.metadata.get('producer')!r} is not this app's")
    if len(out.get_xml_metadata() or "") != len(source.get_xml_metadata() or ""):
        problems.append("XMP packet length changed")
    print("   verdict:", "as promised" if not problems else "MISMATCH")
    for problem in problems:
        print("     -", problem)
    return not problems


ok = True
for label, source, before, after in CASES:
    planned = "round-trip" in label  # reversed twice is the source order again
    chosen = before if BEFORE else after
    try:
        ok &= judge(label, source, chosen, reversed_expected=not planned)
    except FileNotFoundError:
        print(f"\n== {label}: {chosen} missing")
        ok = False

# Control: the same file against itself must fail the order comparison.
print("\n== control: colour.pdf against itself (must MISMATCH)")
same_ok = judge("control", "/tmp/triage/colour.pdf", "/tmp/r/after-base.pdf", reversed_expected=False)
if same_ok:
    print("   !! the order comparison passed on an unreversed file — the probe is broken")
ok &= not same_ok

print("\nRESULT:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
