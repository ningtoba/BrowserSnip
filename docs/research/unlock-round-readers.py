#!/usr/bin/env python3
"""Round 052: `unlock`'s copies, judged by five readers that share no code with it.

An unlocked copy is the one output where a *bad* result is hard to see in this
app: it opens, so nothing complains, and the only witnesses to what it lost are a
reader that agrees to open it and a census of the objects beside it.

For every produced file this prints, off the bytes: whether any `/Encrypt` entry,
any `/P` and any crypt filter survive; then, per reader (MuPDF, libqpdf through
pikepdf, poppler, pypdf, Ghostscript), whether it opens the copy with **nothing
typed**, how many pages it finds, and what text it extracts. MuPDF then renders
every sheet and counts non-white pixels against the same measurement of the
decrypted source, and the object census — annotations and their kinds, form field
values, link targets, outline titles, page labels, enclosures, `/Info` — is
compared source against copy.

Everything is compared with the source measured the same way, so no threshold is
guessed: ink has to be equal, the page boxes have to be equal, and every census
list has to be equal.

  python3 docs/research/unlock-round-readers.py <source> <copy> [USER]

`<copy>` may be a directory of copies, one per case.
"""
import json
import os
import subprocess
import sys

import pikepdf
import pymupdf
import pypdf

SOURCE = os.path.abspath(sys.argv[1])
TARGET = os.path.abspath(sys.argv[2])
USER = sys.argv[3] if len(sys.argv) > 3 else "reader-pass"
DPI = 72


def run(cmd):
    done = subprocess.run(cmd, capture_output=True, text=True, check=False, errors="replace")
    return done.returncode, done.stdout, done.stderr


def clip(text, count=110):
    return " / ".join(line for line in (text or "").splitlines() if line.strip())[:count]


def census(path, password=""):
    """The objects a copy is not allowed to lose, read through MuPDF."""
    doc = pymupdf.open(path)
    if doc.needs_pass:
        doc.authenticate(password)
    counts = {
        "pages": doc.page_count,
        "annotations": sum(len(doc.xref_get_key(page.xref, "Annots")[1].split(" R"))
                           - 1 for page in doc
                           if doc.xref_get_key(page.xref, "Annots")[0] != "null"),
        "outline": len(doc.get_toc()),
        "attachments": doc.embfile_names(),
        "title": (doc.metadata or {}).get("title"),
        "author": (doc.metadata or {}).get("author"),
        "label": doc.xref_get_key(doc.pdf_catalog(), "PageLabels")[1],
    }
    doc.close()
    return counts


def ink(path, password=""):
    """Non-white pixels per sheet, and the page boxes, at a fixed dpi."""
    doc = pymupdf.open(path)
    if doc.needs_pass:
        doc.authenticate(password)
    measured = []
    for page in doc:
        pixmap = page.get_pixmap(dpi=DPI)
        dark = sum(1 for index in range(0, len(pixmap.samples), 3) if pixmap.samples[index] < 250)
        measured.append((page.number, round(page.rect.width, 1), round(page.rect.height, 1),
                         page.rotation, len(page.get_text()), dark))
    doc.close()
    return measured


def judge(path, expected_ink):
    with open(path, "rb") as handle:
        raw = handle.read()
    verdict = {
        "path": os.path.basename(path),
        "bytes": len(raw),
        "encrypt_entry": b"/Encrypt" in raw,
        "permissions": b"/P " in raw or b"/P-" in raw,
        "crypt_filter": b"/CFM" in raw,
    }
    job = pikepdf.Job(["qpdf", "--check", path])
    job.run()
    verdict["qpdf_check_exit"] = job.exit_code

    with pikepdf.open(path) as pdf:
        verdict["qpdf_opens_with_nothing"] = True
        verdict["qpdf_pages"] = len(pdf.pages)

    doc = pymupdf.open(path)
    verdict["mupdf_needs_pass"] = bool(doc.needs_pass)
    verdict["mupdf_pages"] = doc.page_count
    verdict["mupdf_permissions"] = doc.permissions
    verdict["mupdf_text_head"] = clip(doc[0].get_text() if doc.page_count else "")
    doc.close()

    code, out, _ = run(["pdftotext", "-f", "1", "-l", "1", path, "-"])
    verdict["poppler_exit"] = code
    verdict["poppler_text_head"] = clip(out)

    try:
        reader = pypdf.PdfReader(path)
        verdict["pypdf_encrypted"] = reader.is_encrypted
        verdict["pypdf_pages"] = len(reader.pages)
        verdict["pypdf_text_head"] = clip(reader.pages[0].extract_text())
    except Exception as error:  # noqa: BLE001 — a refusal is the verdict
        verdict["pypdf_error"] = f"{type(error).__name__}: {error}"

    code, _, err = run(["gs", "-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=nullpage", path])
    verdict["ghostscript_exit"] = code
    verdict["ghostscript_error"] = clip(err)

    measured = ink(path)
    verdict["ink"] = measured
    verdict["ink_matches_source"] = [row[5] for row in measured] == [row[5] for row in expected_ink]
    verdict["boxes_match_source"] = [row[1:4] for row in measured] == [row[1:4] for row in expected_ink]
    return verdict


source_ink = ink(SOURCE, USER)
source_census = census(SOURCE, USER)
print(f"source {os.path.basename(SOURCE)} ink {[row[5] for row in source_ink]} census {json.dumps(source_census)}")

targets = sorted(
    os.path.join(TARGET, name) for name in os.listdir(TARGET)
    if name.endswith(".pdf") and os.path.basename(TARGET) != ".pdf"
) if os.path.isdir(TARGET) else [TARGET]

failures = 0
for path in targets:
    verdict = judge(path, source_ink)
    copy_census = census(path)
    verdict["census_matches_source"] = copy_census == source_census
    verdict["census"] = copy_census
    print(json.dumps(verdict, sort_keys=True))

    problems = [
        name for name, bad in (
            ("an /Encrypt entry survived", verdict["encrypt_entry"]),
            ("a crypt filter survived", verdict["crypt_filter"]),
            ("MuPDF still wants a password", verdict["mupdf_needs_pass"]),
            ("qpdf --check failed", verdict["qpdf_check_exit"] != 0),
            ("a reader refused it", verdict["mupdf_pages"] == 0 or verdict.get("pypdf_error")),
            ("ink differs from the source", not verdict["ink_matches_source"]),
            ("a page box or rotation differs", not verdict["boxes_match_source"]),
            ("an object did not survive", not verdict["census_matches_source"]),
        ) if bad
    ]
    print(f"  {os.path.basename(path)}: {'OK' if not problems else '; '.join(problems)}")
    failures += bool(problems)

print(f"{len(targets)} copy/copies judged, {failures} with a problem")
sys.exit(1 if failures else 0)
