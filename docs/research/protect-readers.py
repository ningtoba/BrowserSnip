#!/usr/bin/env python3
"""Independent-reader table for the `protect` row.

For every file in <dir>, five readers this app shares no code with answer the
same four questions:

  opens?      can the reader parse the file at all,
  gate?       does it refuse the file when no password is offered,
  text?       does the planted sentence survive extraction with the password,
  /P?         what does it report the permissions to be (a reader's own decoding
              of the raw /P integer, never this app's label).

A reference file written by qpdf itself is included so the table has a column
that is valid by construction; anything the app writes is read against it.

  python3 docs/research/protect-readers.py <dir> [PLANTED] [PASSWORD]
"""
import glob
import os
import subprocess
import sys

TARGET = os.path.abspath(sys.argv[1])
PLANTED = sys.argv[2] if len(sys.argv) > 2 else "Lighthouse"
PASSWORD = sys.argv[3] if len(sys.argv) > 3 else "reader-pass"


def run(cmd):
    done = subprocess.run(cmd, capture_output=True, text=True, check=False)
    return done.returncode, done.stdout, done.stderr


def first_lines(text, count=1):
    return " / ".join(line for line in (text or "").splitlines() if line.strip())[:count]


# ── MuPDF (PyMuPDF) ─────────────────────────────────────────────────────────
def mupdf(path, password):
    import pymupdf
    try:
        doc = pymupdf.open(path)
    except Exception as err:  # noqa: BLE001
        return f"does not open: {type(err).__name__}: {first_lines(str(err), 120)}", "", ""
    gate = "asks for no password"
    if doc.needs_pass:
        gate = "refuses an empty password"
        if not doc.authenticate(password):
            doc.close()
            return f"opens, gate: {gate}", "", "password refused"
        gate = "opened with the password"
    pages = doc.page_count
    text = "".join(str(doc[index].get_text()) for index in range(pages))
    meta = doc.metadata or {}
    doc.close()
    return f"opens, gate: {gate}, pages={pages}, cipher={meta.get('encryption')!r}", text, ""


# ── poppler ─────────────────────────────────────────────────────────────────
def poppler(path, password):
    code_free, info_free, err_free = run(["pdfinfo", path])
    code, out, err = run(["pdftotext", "-upw", password, path, "-"])
    enc_free = [row for row in info_free.splitlines() if row.startswith("Encrypted")]
    if code_free != 0 and code != 0:
        return f"does not open: {first_lines(err or err_free, 160)}", "", ""
    gate = "opens with no password" if "no" in "".join(enc_free) else "asks for a password"
    enc = "".join(enc_free).replace("Encrypted:", "").strip()
    code_with, out_with, err_with = run(["pdftotext", "-upw", password, path, "-"])
    return f"opens, {gate}, /P says: {enc}", out_with if code_with == 0 else out, first_lines(err_with or err, 200)


# ── qpdf (through pikepdf, which bundles libqpdf) ───────────────────────────
def qpdf(path, password):
    import pikepdf
    gate = "opens with no password"
    try:
        with pikepdf.open(path) as free:
            if free.is_encrypted:
                gate = "refuses an empty password"
    except pikepdf.PasswordError:
        gate = "refuses an empty password"
    except Exception as err:  # noqa: BLE001
        return f"does not open: {type(err).__name__}: {first_lines(str(err), 160)}", ""
    try:
        with pikepdf.open(path, password=password) as pdf:
            problems = pdf.check_pdf_syntax()
            return (f"opens, gate: {gate}, pages={len(pdf.pages)}, "
                    f"is_encrypted={pdf.is_encrypted}, qpdf syntax check: {problems or 'clean'}"), ""
    except Exception as err:  # noqa: BLE001
        return f"cannot open with the password: {type(err).__name__}: {first_lines(str(err), 160)}", ""


# ── pypdf ───────────────────────────────────────────────────────────────────
def pypdf_reader(path, password):
    from pypdf import PdfReader
    try:
        reader = PdfReader(path)
    except Exception as err:  # noqa: BLE001
        return f"does not open: {type(err).__name__}: {first_lines(str(err), 140)}", "", ""
    try:
        if reader.is_encrypted and reader.decrypt(password) == 0:
            return "encrypted, the planted password is refused", "", ""
    except Exception as err:  # noqa: BLE001
        return f"cannot decrypt: {type(err).__name__}: {first_lines(str(err), 140)}", "", ""
    try:
        text = "".join(page.extract_text() or "" for page in reader.pages)
    except Exception as err:  # noqa: BLE001
        return f"opens, pages={len(reader.pages)}, cannot extract: {type(err).__name__}", "", ""
    return f"opens, is_encrypted={reader.is_encrypted}, pages={len(reader.pages)}", text, ""


READERS = (
    ("mupdf", lambda p: mupdf(p, PASSWORD)),
    ("poppler", lambda p: poppler(p, PASSWORD)),
    ("qpdf", lambda p: qpdf(p, PASSWORD)),
    ("pypdf", lambda p: pypdf_reader(p, PASSWORD)),
)

for pdf_path in sorted(glob.glob(os.path.join(TARGET, "*.pdf"))):
    print(f"=== {os.path.basename(pdf_path)} ({os.path.getsize(pdf_path)} bytes)")
    for label, reader in READERS:
        try:
            result = reader(pdf_path)
            verdict, text, note = result if len(result) == 3 else (result[0], result[1], "")
        except Exception as err:  # noqa: BLE001
            verdict, text, note = f"harness error {type(err).__name__}: {err}", "", ""
        line = f"  {label:8s}: {verdict}"
        if PLANTED:
            line += f"\n           planted text: {PLANTED in (text or '')}"
        if note:
            line += f"\n           note: {note}"
        print(line)
