#!/usr/bin/env python3
"""Rebuild `tests/fixtures/encrypted/`: PDFs locked by **outside** implementations.

The test suite needs encrypted inputs whose cipher is real. pdf-lib — the engine
this app edits with — cannot produce them: `save({ encrypt })` registers an
`/Encrypt` dictionary and a `/ID` and never runs a cipher over the streams (see
`docs/TOOL-CAMPAIGN.md`, the `protect` row), so a file this repo writes and then
locks is evidence of a gate, never of a cipher. Every locked fixture here is
therefore written by one of the two independent encryptors on this box over one
base document:

    qpdf --encrypt <user> <owner> <bits> [options] -- plain.pdf out.pdf   (libqpdf 12.3.2, through pikepdf)
    pymupdf: doc.save(out, encryption=…, owner_pw=…, user_pw=…, permissions=…)          (MuPDF 1.28.2)

The `qpdf` binary itself is not installed, so qpdf's CLI option set runs through
the library `pikepdf` embeds. The two producers also *spell* the lock differently
— MuPDF inlines the encryption dictionary in the trailer, qpdf writes a reference
— and that difference is recorded per file, because the guard's cheap trailer scan
has to read both (`looksEncrypted` in `core/doc.ts`).

Passwords are uniform so a test needs only one secret: the **user** password is
`hunter2` on every `*-user` file (and empty on the `*-owner` file, which is the
point of including it), and the **owner** password is `hunter2` everywhere. The
permissions are qpdf's own spellings and match the `encrypted-inputs` rig: copy
and accessibility allowed, print / modify / annotate / form / assemble refused,
so `/P` is non-trivial and `decodePermissions` has something to decode.

Each file is verified before it is kept — by the encryptor that wrote it, with
the password it was given, and with MuPDF — and the `/Encrypt` dictionary plus a
page count is printed, which is what `tests/fixtures/encrypted/README.md`
records. A fixture that was never valid proves nothing, so a failed check stops
the script rather than writing a doubtful file.

    python3 scripts/encrypted-fixtures.py [outdir]     # default tests/fixtures/encrypted
"""
import os
import sys

import pikepdf
import pymupdf

TARGET = os.path.abspath(
    sys.argv[1] if len(sys.argv) > 1 else "tests/fixtures/encrypted"  # noqa: S108
)
os.makedirs(TARGET, exist_ok=True)

USER = "hunter2"
OWNER = "hunter2"
PLANTED = "Lighthouse Inventory 1887"
PAGES = 3
SHEET_WORDS = ("ALPHA", "BRAVO", "CHARLIE")
BASE = os.path.join(TARGET, "plain.pdf")

# qpdf's option spellings for `/P`, chosen to be the set the `protect` row and
# the `encrypted-inputs` rig both carry.
QPDF_PERMISSIONS = [
    "--print=none", "--modify=none",
    "--annotate=n", "--form=n", "--assemble=n", "--extract=y", "--accessibility=y",
]

# name -> (bits, use-aes, user password). `owner-only` means an empty user
# secret: anyone can open the file, and the streams are still ciphertext. Each
# strength this app reads carries both kinds of secret, because the two behave
# differently to a reader — the AES-256 owner-only file is the one five outside
# readers open with nothing typed and this app reported as locked.
FIXTURES = {
    "rc4-128-user.pdf": (128, False, USER),
    "rc4-128-owner.pdf": (128, False, ""),
    "aes-128-user.pdf": (128, True, USER),
    "aes-256-user.pdf": (256, False, USER),
    "aes-256-owner.pdf": (256, False, ""),
}

# The same locks by the other outside producer on this box. MuPDF also *spells*
# the lock differently: it inlines the encryption dictionary in the trailer
# (`/Encrypt<<…>>`) where qpdf writes a reference (`/Encrypt 12 0 R`), which is
# what the cheap trailer scan has to recognise.
MUPDF_FIXTURES = {
    "mu-rc4-128-user.pdf": ("PDF_ENCRYPT_RC4_128", USER),
    "mu-aes-128-user.pdf": ("PDF_ENCRYPT_AES_128", USER),
    "mu-aes-256-user.pdf": ("PDF_ENCRYPT_AES_256", USER),
    "mu-aes-256-owner.pdf": ("PDF_ENCRYPT_AES_256", ""),
}


def build_base() -> None:
    """The countable document, written by MuPDF and left unlocked.

    Three text pages that each name their own sheet, plus ink on page 1: a page
    count that stays 3 while the words go missing is only catchable in the text,
    and the strip is catchable in the pixels.
    """
    doc = pymupdf.open()
    for index in range(PAGES):
        page = doc.new_page(width=595, height=842)
        page.insert_text((60, 700), f"{PLANTED} page {index + 1}", fontsize=18)
        page.insert_text((60, 660), f"Sheet {SHEET_WORDS[index]} body copy", fontsize=11)
        page.draw_rect(pymupdf.Rect(60, 720, 300, 740), color=(0, 0, 0), fill=(0, 0, 0))
    doc.set_toc([[1, "Chapter One", 1], [2, "Intro", 2]])
    doc.set_metadata({"title": PLANTED, "author": "encrypted fixtures"})
    doc.save(BASE)
    doc.close()


def qpdf_lock(out: str, *, bits: int, aes: bool, user: str) -> str:
    """Run qpdf's CLI option set through the libqpdf `pikepdf` embeds."""
    argv = ["qpdf"]
    if not aes:
        argv.append("--allow-weak-crypto")  # qpdf 12 refuses RC4 without this
    argv += ["--encrypt", user, OWNER, str(bits)]
    if bits == 128:
        argv.append(f"--use-aes={'y' if aes else 'n'}")
    argv += QPDF_PERMISSIONS + ["--", BASE, out]
    job = pikepdf.Job(argv)
    job.run()
    # 0 = clean, 3 = wrote the file with warnings (the RC4 weak-crypto note).
    if job.exit_code not in (0, 3):
        raise RuntimeError(f"qpdf refused to write {out} (exit {job.exit_code})")
    if not os.path.exists(out):
        raise RuntimeError(f"qpdf reported success but wrote no {out}")
    return " ".join(argv)


def dictionary(path: str, password: str) -> dict:
    """The `/Encrypt` dictionary as the file itself writes it."""
    with pikepdf.open(path, password=password) as pdf:
        entry = pdf.trailer.get("/Encrypt")
        if entry is None:
            return {}
        flat: dict = {}
        for key, value in entry.items():
            name = str(key).lstrip("/")
            if isinstance(value, pikepdf.String):
                flat[name] = f"{len(bytes(value))}-byte string"
            elif isinstance(value, pikepdf.Dictionary):
                inner = []
                for inner_key, inner_value in value.items():
                    if isinstance(inner_value, pikepdf.Dictionary):
                        inner.append(
                            f"{inner_key}:CFM={inner_value.get('/CFM')}"
                            f"/Length={inner_value.get('/Length')}"
                        )
                    else:
                        inner.append(f"{inner_key}={inner_value}")
                flat[name] = "dict(" + ", ".join(inner) + ")"
            else:
                flat[name] = str(value)
        return flat


def mupdf_lock(out: str, constant: str, user: str) -> str:
    """Lock the base document with MuPDF, the second independent encryptor."""
    permissions = py_constant("PDF_PERM_ACCESSIBILITY") | py_constant("PDF_PERM_COPY")
    doc = pymupdf.open(BASE)
    doc.save(out, encryption=py_constant(constant), owner_pw=OWNER, user_pw=user, permissions=permissions)
    doc.close()
    if not os.path.exists(out):
        raise RuntimeError(f"MuPDF reported success but wrote no {out}")
    return (
        f"python3 -c \"import pymupdf; d = pymupdf.open('plain.pdf'); d.save('{os.path.basename(out)}', "
        f"encryption=pymupdf.{constant}, owner_pw={OWNER!r}, user_pw={user!r}, "
        "permissions=PDF_PERM_ACCESSIBILITY|PDF_PERM_COPY)\""
    )


def py_constant(name: str) -> int:
    """A PyMuPDF `PDF_*` constant.

    PyMuPDF assembles these onto the module at import time from its SWIG bindings,
    so a static checker cannot see them even though they are always there — which
    this asserts rather than assumes, same as the audit rig does.
    """
    value = getattr(pymupdf, name, None)
    if value is None:
        raise RuntimeError(f"pymupdf has no constant {name}")
    return int(value)


def trailer_spelling(path: str) -> str:
    """How the file's trailer names its encryption dictionary, if it has one."""
    with open(path, "rb") as handle:
        handle.seek(max(0, os.path.getsize(path) - 4096))
        tail = handle.read()
    if b"/Encrypt<" in tail:
        return "inlined (/Encrypt<<…)"
    if b"/Encrypt " in tail:
        return "a reference (/Encrypt N 0 R)"
    return "no /Encrypt entry"


def verify(name: str, path: str, password: str) -> str:
    """Open it with the tool that wrote it, and with MuPDF, or stop."""
    with pikepdf.open(path, password=password) as pdf:
        qpdf_pages = len(pdf.pages)
    doc = pymupdf.open(path)
    secret = password or OWNER
    if doc.needs_pass and not doc.authenticate(secret):
        raise RuntimeError(f"MuPDF refused {secret!r} for {name}")
    words = sum(1 for page in doc if PLANTED in page.get_text())
    sheets = [word for word in SHEET_WORDS if any(word in page.get_text() for page in doc)]
    doc.close()
    if words != PAGES:
        raise RuntimeError(f"{name}: MuPDF found the planted sentence on {words} of {PAGES} pages")
    if len(sheets) != PAGES:
        raise RuntimeError(f"{name}: MuPDF found only {sheets}")
    if qpdf_pages != PAGES:
        raise RuntimeError(f"{name}: qpdf counted {qpdf_pages} pages")
    reader = "no password" if not doc_needs_pass(path) else repr(secret)
    return (
        f"qpdf opens it ({qpdf_pages} pages), MuPDF opens it with {reader} "
        f"({words}/{PAGES} planted pages, sheets {', '.join(sheets)})"
    )


def doc_needs_pass(path: str) -> bool:
    """Does a reader have to type something to open this file?"""
    doc = pymupdf.open(path)
    try:
        return bool(doc.needs_pass)
    finally:
        doc.close()


def main() -> None:
    build_base()
    print(f"base   plain.pdf  (MuPDF, unlocked, {trailer_spelling(BASE)})\n       {verify('plain.pdf', BASE, '')}")
    for name, (bits, aes, user) in FIXTURES.items():
        path = os.path.join(TARGET, name)
        command = qpdf_lock(path, bits=bits, aes=aes, user=user)
        report(name, path, user, "libqpdf", command)
    for name, (constant, user) in MUPDF_FIXTURES.items():
        path = os.path.join(TARGET, name)
        command = mupdf_lock(path, constant, user)
        report(name, path, user, "MuPDF", command)
    total = len(FIXTURES) + len(MUPDF_FIXTURES) + 1
    print(f"\nwrote {total} files to {TARGET}")


def report(name: str, path: str, user: str, made_by: str, command: str) -> None:
    """One block per fixture: the command, the dictionary, the trailer, the checks."""
    fields = dictionary(path, user)
    print(f"\nlock   {name}  ({made_by})")
    print(f"       {command}")
    print(f"       /V {fields.get('V')} /R {fields.get('R')} /Length {fields.get('Length')} "
          f"/CF {fields.get('CF')} /StmF {fields.get('StmF')} /StrF {fields.get('StrF')} "
          f"/P {fields.get('P')}")
    print(f"       trailer carries {trailer_spelling(path)}")
    print(f"       {verify(name, path, user)}")


if __name__ == "__main__":
    main()
