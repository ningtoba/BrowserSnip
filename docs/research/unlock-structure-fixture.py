#!/usr/bin/env python3
"""The `unlock` round's structure fixture: a locked file carrying everything a
rewrite is known to drop, so "it survives" is a count and not a hope.

The triage fixture the round was handed (`/tmp/triage/in/locked.pdf`) is a
colour-tool page set: four sheets of ink, and **no** annotations, no form, no
outline, no `/PageLabels`, no enclosure.  `unlock`'s card claims all of those
"stay where they were", so the tool has to be shown one file that has them.

Built with MuPDF (an outside implementation), locked with libqpdf through
`pikepdf` at AES-256 — the strength the round brief calls R6 — with user and owner
password `hunter2`.  `structure-plain.pdf`
is the same document unlocked, so every count has a source to be equal to.

    python3 docs/research/unlock-structure-fixture.py tests/fixtures/encrypted

Writes `structure-plain.pdf`, `structure-aes-256-user.pdf` and
`structure-census.json` — the roster keeps all three in `tests/fixtures/encrypted/`  and prints the census of
both, so a fixture that never carried a thing cannot be credited with keeping it.
"""
import os
import sys

import json
import re

import pikepdf
import pymupdf

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "/tmp/r52")  # noqa: S108 — the round's scratch dir
os.makedirs(OUT, exist_ok=True)
PLAIN = os.path.join(OUT, "structure-plain.pdf")
LOCKED = os.path.join(OUT, "structure-aes-256-user.pdf")
# The corpus' own secret (`tests/fixtures/encrypted/README.md`): one value for
# every user-password fixture, so a test needs one constant.
USER = "hunter2"
OWNER = "hunter2"


def constant(name: str) -> int:
    value = getattr(pymupdf, name, None)
    if value is None:
        raise AssertionError(f"pymupdf has no constant {name}")
    return int(value)


doc = pymupdf.open()
for index in range(2):
    page = doc.new_page(width=595, height=842)
    page.insert_text((60, 760), f"Structure sheet {index + 1}", fontsize=18)
    page.insert_text((60, 730), "Lighthouse Inventory 1887 body copy", fontsize=11)

first, second = doc[0], doc[1]
note = first.add_text_annot((120, 500), "Alice needs a note")
note.set_info(title="Audit", content="Alice needs a note", subject="review")
note.update()
mark = first.add_highlight_annot(pymupdf.Rect(58, 722, 320, 742))
mark.set_info(title="Audit", content="marked")
mark.update()
first.insert_link({
    "kind": constant("LINK_URI"),
    "from": pymupdf.Rect(60, 690, 220, 706),
    "uri": "https://example.com",
})

field = pymupdf.Widget()
field.field_name = "applicant.name"
field.field_label = "Name"
field.field_value = "Ada Lovelace"
field.field_type = constant("PDF_WIDGET_TYPE_TEXT")
field.rect = pymupdf.Rect(60, 400, 260, 420)
second.add_widget(field)
agree = pymupdf.Widget()
agree.field_name = "agree"
agree.field_label = "Agree"
agree.field_value = True
agree.field_type = constant("PDF_WIDGET_TYPE_CHECKBOX")
agree.rect = pymupdf.Rect(60, 350, 80, 370)
second.add_widget(agree)

doc.set_toc([[1, "Chapter Bravo", 1], [2, "Intro", 2]])
doc.set_page_labels([{"startpage": 0, "prefix": "A-", "style": "D", "firstpagenum": 1}])
doc.embfile_add("source.csv", b"a,b\n1,2\n", filename="source.csv", ufilename="source.csv", desc="csv")
doc.set_metadata({"title": "Lighthouse Inventory 1887", "author": "unlock structure rig"})
doc.save(PLAIN)
doc.close()

job = pikepdf.Job([
    "qpdf", "--encrypt", USER, OWNER, "256",
    "--print=none", "--modify=none", "--annotate=n", "--form=n", "--assemble=n",
    "--extract=y", "--accessibility=y", "--", PLAIN, LOCKED,
])
job.run()
if job.exit_code not in (0, 3):
    raise RuntimeError(f"qpdf refused to write {LOCKED} (exit {job.exit_code})")


def xref_array(doc: "pymupdf.Document", xref: int, key: str) -> int:
    """How many entries an array key on this object holds (0 when absent)."""
    kind, value = doc.xref_get_key(xref, key)
    if kind == "null":
        return 0
    return len([entry for entry in value.strip("[]").split(" R") if entry.strip()])


def safe(call, fallback=-1):
    """A MuPDF count, or `-1` where the reader itself trips over the cipher.

    `page.get_links()`, `page.widgets()` and `get_toc()` all raise on the
    *locked* copy (raw annotation and raw outline reads) — a limitation of the
    reader in front of the cipher, not a missing object — so the `-1` says that
    instead of printing a loss that is not there.
    """
    try:
        return call()
    except Exception:  # noqa: BLE001 — the caller decides what a failure means
        return fallback


def annot_subtypes(doc: "pymupdf.Document", page_xref: int) -> list:
    """The `/Subtype` of every `/Annots` entry on a page, as bare names."""
    kind, value = doc.xref_get_key(page_xref, "Annots")
    if kind == "null":
        return []
    found = []
    for xref in [int(entry.split()[0]) for entry in value.strip("[]").split(" R") if entry.strip()]:
        _, subtype = doc.xref_get_key(xref, "Subtype")
        found.append(subtype.lstrip("/"))
    return found


def census(path: str) -> dict:
    doc = pymupdf.open(path)
    if doc.needs_pass:
        assert doc.authenticate(USER), f"{path} does not open with the user password"
    # Read before the `xref_get_key` calls below: a raw key read on an
    # authenticated document leaves the page resources unloaded.
    text_strings = [page.get_text().strip() for page in doc]
    text = [len(value) for value in text_strings]
    labels = doc.xref_get_key(doc.pdf_catalog(), "PageLabels")
    counts = {
        "needs_pass": doc.needs_pass,
        "pages": doc.page_count,
        # Counted off the page dictionary, not `page.annots()`: MuPDF's annot
        # loader raises `UnicodeDecodeError` on the locked copy.
        "annotations": sum(xref_array(doc, page.xref, "Annots") for page in doc),
        "links": safe(lambda: sum(1 for page in doc for _ in (page.get_links() or []))),
        "fields": safe(lambda: sum(1 for page in doc for _ in (page.widgets() or []))),
        "outline": safe(lambda: len(doc.get_toc())),
        "attachments": doc.embfile_names(),
        "page_labels": labels[1] if labels[0] != "null" else "null",
        "title": (doc.metadata or {}).get("title"),
        "author": (doc.metadata or {}).get("author"),
        # The strings, read through the reader rather than off the bytes: a
        # `/V`, a `/URI`, an outline `/Title`, the label prefix, the `/UF` name and
        # the `/Info` values are all *strings*, and on the locked file they are
        # inside the cipher. This is what the test compares the copy against.
        "field_values": safe(lambda: [field.field_value for page in doc for field in (page.widgets() or [])]),
        "uris": safe(lambda: [link.get("uri") for page in doc for link in (page.get_links() or []) if link.get("uri")]),
        "outline_titles": safe(lambda: [title for _, title, _ in (doc.get_toc() or [])]),
        "label_prefix": (re.search(r"/P\s*\(([^)]*)\)", labels[1]) or [None, None])[1]
        if labels[0] != "null" else None,
        "attachment_names": doc.embfile_names(),
        # `/Subtype` off each annotation object: `page.annots()` gives up part
        # way through on the locked copy (a raw read trips over the cipher).
        "subtypes": sorted(subtype for page in doc
                           for subtype in annot_subtypes(doc, page.xref)),
        "text": text,
        "text_strings": text_strings,
    }
    doc.close()
    return counts


plain = census(PLAIN)
locked = census(LOCKED)
for path, counts in ((PLAIN, plain), (LOCKED, locked)):
    print(os.path.basename(path), counts)

# The locked census and the plain one are the same document: a difference here is
# the encryptor's, and it would be blamed on this app later.
for key in ("pages", "annotations", "links", "fields", "outline", "attachments",
            "page_labels", "title", "author", "field_values", "uris",
            "outline_titles", "attachment_names", "subtypes", "text"):
    assert plain[key] == locked[key], f"the lock changed {key}: {plain[key]} vs {locked[key]}"

# Recorded beside the fixture for the test that judges an *unlocked copy* against
# what the source held — the copy's strings are plaintext, so the test can read
# them off the bytes, and only the source needs a reader that undoes the cipher.
locked.pop("needs_pass")
with open(os.path.join(OUT, "structure-census.json"), "w") as handle:
    json.dump(locked, handle, indent=1)
print("wrote structure-census.json")
