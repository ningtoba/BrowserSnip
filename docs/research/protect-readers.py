#!/usr/bin/env python3
"""Independent-reader table for the `protect` row.

For every file in <dir>, four readers this app shares no code with — MuPDF
(PyMuPDF), poppler, qpdf (pikepdf) and pypdf — answer the same four questions,
plus Ghostscript as a fifth opinion on parseability:

  opens?   can the reader parse the file at all,
  gate?    does it refuse the file when no password is offered,
  text?    does the planted sentence survive extraction,
  /P?      what does the reader's own decode of the raw /P integer allow.

A file whose user password is empty (a permissions-only run) must answer
"opens with no password" and still refuse the restricted actions, so each
reader is asked with the empty password first and the real one second.

  python3 docs/research/protect-readers.py <dir> [PLANTED] [PASSWORD]
"""
import glob
import os
import subprocess
import sys

TARGET = os.path.abspath(sys.argv[1])
PLANTED = sys.argv[2] if len(sys.argv) > 2 else "Lighthouse"
PASSWORD = sys.argv[3] if len(sys.argv) > 3 else "reader-pass"
# Empty first: an open password of "" is a legal, common file, and a reader that
# refuses it is refusing the gate, not the fixture.
TRY_PASSWORDS = ("", PASSWORD)
PERMISSION_BITS = {
    "print": 4, "highres": 2048, "modify": 8, "copy": 16,
    "annot": 32, "forms": 256, "access": 512, "assemble": 1024,
}


def run(cmd):
    # errors="replace", not the default strict decode: Ghostscript writes C-level
    # diagnostics that are not UTF-8, and a reader's complaint arriving as bytes is
    # how the run used to die halfway through the table with a UnicodeDecodeError.
    done = subprocess.run(cmd, capture_output=True, text=True, check=False, errors="replace")
    return done.returncode, done.stdout, done.stderr


def clip(text, count=200):
    joined = " / ".join(line for line in (text or "").splitlines() if line.strip())
    return joined[:count]


def permissions_of(mask):
    return {name: bool(mask & bit) for name, bit in PERMISSION_BITS.items()}


# ── MuPDF (PyMuPDF) ─────────────────────────────────────────────────────────
def mupdf(path):
    import pymupdf
    try:
        doc = pymupdf.open(path)
    except Exception as err:  # noqa: BLE001
        return f"does not open: {type(err).__name__}: {clip(str(err), 140)}", "", ""
    gate, opened = "asks for no password", True
    if doc.needs_pass:
        gate, opened = "refuses an empty password", False
        for candidate in TRY_PASSWORDS[1:]:
            if doc.authenticate(candidate):
                gate, opened = f"opened with the password {candidate!r}", True
                break
    pages = doc.page_count
    text = "".join(str(doc[index].get_text()) for index in range(pages))
    meta = doc.metadata or {}
    perms = permissions_of(doc.permissions) if opened else {}
    doc.close()
    verdict = f"opens, gate: {gate}, pages={pages}, cipher={meta.get('encryption')!r}"
    if perms:
        verdict += f", /P allows {sorted(k for k, v in perms.items() if v) or 'nothing'}"
    return verdict, text, ""


# ── poppler ─────────────────────────────────────────────────────────────────
def poppler(path):
    code_free, info_free, err_free = run(["pdfinfo", path])
    # Both secrets, empty first, as TRY_PASSWORDS promises: a permissions-only file's
    # user password is "", so handing poppler the owner password as -upw is a wrong
    # password and poppler says so. Asking only the real one reported an honest
    # refusal as "the reader cannot read this file".
    code, out, err = -1, "", ""
    for candidate in TRY_PASSWORDS:
        args = ["-upw", candidate] if candidate else []
        code, out, err = run(["pdftotext", *args, path, "-"])
        if code == 0:
            break
    if code_free != 0 and code != 0:
        return f"does not open: {clip(err or err_free, 160)}", "", ""
    # A file with a real open password makes a bare `pdfinfo` fail, so the lines
    # worth quoting have to be asked for with the secret — otherwise the table
    # prints `pages=?` beside a file poppler reads perfectly well once it is typed.
    if code_free != 0:
        code_pw, info_pw, _ = run(["pdfinfo", "-upw", PASSWORD, path])
        if code_pw == 0:
            info_free = info_pw
    reported = next((row.split(":", 1)[1].strip() for row in info_free.splitlines()
                     if row.startswith("Encrypted")), "?")
    pages = next((row.split(":", 1)[1].strip() for row in info_free.splitlines()
                  if row.startswith("Pages")), "?")
    gate = "opens with no password" if reported == "no" else f"asks for a password ({reported})"
    return f"opens, gate: {gate}, pages={pages}, pdfinfo /P: {reported}", out, err


# ── qpdf (through pikepdf, which bundles libqpdf) ───────────────────────────
def qpdf(path):
    import pikepdf
    # Opening with no password is the gate test. A restricted-but-openable file
    # reports is_encrypted while still letting anyone in, which is a different
    # answer from a refusal and has to be printed as one.
    try:
        with pikepdf.open(path) as free:
            gate = ("opens with no password, restricted only" if free.is_encrypted
                    else "asks for no password")
    except pikepdf.PasswordError:
        gate = "refuses an empty password"
    except Exception as err:  # noqa: BLE001
        return f"does not open: {type(err).__name__}: {clip(str(err), 160)}", ""
    for candidate in (*TRY_PASSWORDS, None):
        try:
            with pikepdf.open(path, password=candidate or "") as pdf:
                allow = pdf.allow
                granted = sorted(name for name in (
                    "print_lowres", "print_highres", "modify_annotation", "modify_assembly",
                    "modify_form", "modify_other", "extract", "accessibility",
                ) if getattr(allow, name, False))
                return (f"opens, gate: {gate}, pages={len(pdf.pages)}, is_encrypted={pdf.is_encrypted}, "
                        f"qpdf syntax check: {pdf.check_pdf_syntax() or 'clean'}, "
                        f"/P allows {granted or 'nothing'}"), ""
        except pikepdf.PasswordError:
            continue
        except Exception as err:  # noqa: BLE001
            return (f"opens, gate: {gate}, but qpdf rejects it: "
                    f"{type(err).__name__}: {clip(str(err), 160)}"), ""
    return f"opens, gate: {gate}, and no password we tried is accepted", ""


# ── pypdf ───────────────────────────────────────────────────────────────────
def pypdf_reader(path):
    from pypdf import PdfReader
    try:
        reader = PdfReader(path)
    except Exception as err:  # noqa: BLE001
        return f"does not open: {type(err).__name__}: {clip(str(err), 140)}", "", ""
    accepted = None
    try:
        if not reader.is_encrypted:
            accepted = "no password asked"
        else:
            for candidate in TRY_PASSWORDS:
                if reader.decrypt(candidate) != 0:
                    accepted = repr(candidate) if candidate else "opened on the empty password"
                    break
    except Exception as err:  # noqa: BLE001
        return f"cannot decrypt: {type(err).__name__}: {clip(str(err), 140)}", "", ""
    if accepted is None:
        return "encrypted, and neither the empty nor the planted password is accepted", "", ""
    try:
        text = "".join(page.extract_text() or "" for page in reader.pages)
    except Exception as err:  # noqa: BLE001
        return f"opens ({accepted}), pages={len(reader.pages)}, cannot extract: {type(err).__name__}", "", ""
    return f"opens, is_encrypted={reader.is_encrypted}, gate: {accepted}, pages={len(reader.pages)}", text, ""


def ghostscript(path):
    """Ghostscript's own opinion, measured rather than trusted.

    `rc=0` is not an answer: on a file whose dictionary declares more than the
    bytes hold, gs exits 0 and writes a single blank page. So the render is
    converted and read back, and the page count and the planted words are what
    this reports.
    """
    out = f"/tmp/protect-gs-{os.getpid()}.pdf"
    for candidate in TRY_PASSWORDS:
        code, _, err = run(["gs", "-o", out, "-sDEVICE=pdfwrite", "-dBATCH", "-dNOPAUSE",
                            f"-dPDFPassword=({candidate})", path])
        pages, text = "?", ""
        if os.path.exists(out):
            _, info, _ = run(["pdfinfo", out])
            pages = next((row.split(":", 1)[1].strip() for row in info.splitlines()
                          if row.startswith("Pages")), "?")
            _, text, _ = run(["pdftotext", out, "-"])
            os.remove(out)
        # `rc=0` and a page in the output is not yet a render: on a file it will not
        # open, Ghostscript exits 0 having written a one-page stub and complained
        # about the password on stderr. Taking that as success reported a refused
        # file as "renders with no password", which is the opposite of the fact.
        refused = "password" in (err or "").lower()
        if code == 0 and pages not in ("0", "?") and not refused:
            return (f"renders{'' if candidate else ' with no password'} → wrote {pages} page(s), "
                    f"planted text through gs: {PLANTED in text}")
        if refused:
            continue
        if code != 0:
            return f"FAIL rc={code}: pages={pages} {clip(err, 120)}"
    return "refuses both passwords"


READERS = (
    ("mupdf", lambda p: mupdf(p)),
    ("poppler", lambda p: poppler(p)),
    ("qpdf", lambda p: qpdf(p)),
    ("pypdf", lambda p: pypdf_reader(p)),
)

for pdf_path in sorted(glob.glob(os.path.join(TARGET, "*.pdf"))):
    print(f"=== {os.path.basename(pdf_path)} ({os.path.getsize(pdf_path)} bytes)")
    for label, reader in READERS:
        try:
            result = reader(pdf_path)
            verdict, text, note = result if len(result) == 3 else (result[0], "", result[1])
        except Exception as err:  # noqa: BLE001
            verdict, text, note = f"harness error {type(err).__name__}: {err}", "", ""
        line = f"  {label:8s}: {verdict}"
        if text or label != "qpdf":
            line += f"\n           planted text extracted: {PLANTED in (text or '')}"
        if note:
            line += f"\n           reader's own complaint: {clip(note, 200)}"
        print(line)
    print(f"  gs      : {ghostscript(pdf_path)}")
