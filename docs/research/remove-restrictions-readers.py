#!/usr/bin/env python3
"""Outside readers over the files `remove-restrictions`, `unlock` and
`change-permissions` produced.

Nothing here imports this app. Every verdict comes from pypdf, MuPDF (PyMuPDF),
libqpdf (through pikepdf) or poppler, run over a directory of produced PDFs plus
the fixtures they came from, so the table describes the bytes a user would
download rather than the sentence the result card printed.

A produced file is opened with **no secret at all** — "the password was removed"
is only evidence when nothing is typed. The fixtures are opened with their own
secret (`hunter2`, or empty for the owner-only pair) so the before-picture is
measured on the same terms.

Usage: python3 docs/research/remove-restrictions-readers.py <produced-dir> <fixture-dir>
"""
import json
import os
import subprocess
import sys

import pikepdf
import pymupdf
import pypdf

PLANTED = "Lighthouse Inventory 1887"
SHEET_WORDS = ("ALPHA", "BRAVO", "CHARLIE")


def ink_percent(page, dpi=72):
    """Fraction of non-white pixels on one sheet."""
    pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY)
    data = pix.samples
    if not data:
        return 0.0
    dark = sum(1 for byte in data if byte < 250)
    return round(100.0 * dark / len(data), 2)


def census(texts):
    joined = "\n".join(texts)
    return {
        "planted": sum(1 for text in texts if PLANTED in text),
        "sheets": sum(1 for word in SHEET_WORDS if word in joined),
        "chars": sum(len(text) for text in texts),
    }


def pypdf_view(path, secret):
    """pypdf: opens with `secret`, what level that secret is, what is readable."""
    try:
        reader = pypdf.PdfReader(path)
        encrypted = reader.is_encrypted
        level = reader.decrypt(secret) if encrypted else 1
        texts = [page.extract_text() or "" for page in reader.pages] if level else []
        return {
            "encrypted": encrypted,
            "opens": bool(level),
            # pypdf: 1 = user password, 2 = owner password, 0 = refused.
            "level": int(level),
            "pages": len(reader.pages) if level else 0,
            **census(texts),
        }
    except Exception as error:
        return {"error": f"{type(error).__name__}: {error}"}


def mupdf_view(path, secret):
    """MuPDF: does it ask, does the secret open it, what do the sheets hold."""
    try:
        doc = pymupdf.open(path)
        needs = bool(doc.needs_pass)
        auth = doc.authenticate(secret)
        if needs and not auth:
            return {"needs_pass": needs, "opens": False}
        pages = doc.page_count
        texts = [page.get_text() for page in doc]
        return {
            "needs_pass": needs,
            "opens": bool(auth or not needs),
            "auth_bits": auth,
            "encrypted": bool(doc.is_encrypted),
            "permissions": doc.permissions,
            "pages": pages,
            "ink_page1": ink_percent(doc[0]) if pages else 0.0,
            **census(texts),
        }
    except Exception as error:
        return {"error": f"{type(error).__name__}: {error}"}


def qpdf_view(path, secret):
    """libqpdf: opens with `secret`, the dictionary it read, and its syntax check."""
    try:
        pdf = pikepdf.Pdf.open(path, password=secret)
        crypto = pdf.encryption if pdf.is_encrypted else None
        view = {
            "opens": True,
            "encrypted": bool(pdf.is_encrypted),
            "pages": len(pdf.pages),
            "syntax": pdf.check_pdf_syntax() or "clean",
        }
        if crypto is not None:
            view.update({
                "V": crypto.V,
                "R": crypto.R,
                "P": crypto.P,
                "stream_method": str(crypto.stream_method).split(".")[-1],
                "string_method": str(crypto.string_method).split(".")[-1],
                "user_password": crypto.user_password.decode("latin1"),
            })
        pdf.close()
        return view
    except Exception as error:
        return {"error": f"{type(error).__name__}: {error}"}


def poppler_view(path):
    """poppler runs as a subprocess and is given no password prompt to answer."""
    info = subprocess.run(["pdfinfo", path], capture_output=True, text=True, timeout=120)
    body = subprocess.run(
        ["pdftotext", path, "-"], capture_output=True, text=True, timeout=120
    )
    fields = {}
    for line in (info.stdout or "").splitlines():
        key, _, value = line.partition(":")
        fields[key.strip()] = value.strip()
    text = body.stdout or ""
    return {
        "rc": info.returncode,
        "pages": fields.get("Pages"),
        "encryption": fields.get("Encryption"),
        "page1": fields.get("Page size"),
        "chars": len(text),
        "planted": PLANTED in text,
        "stderr": [line for line in (info.stderr or "").splitlines() if line][:2],
    }


def main():
    produced_dir, fixture_dir = sys.argv[1], sys.argv[2]
    print("# produced by the app, opened with no secret typed")
    for name in sorted(n for n in os.listdir(produced_dir) if n.endswith(".pdf")):
        path = os.path.join(produced_dir, name)
        with open(path, "rb") as handle:
            raw = handle.read()
        print(f"\n## {name}")
        print("   pypdf  ", json.dumps(pypdf_view(path, "")))
        print("   mupdf  ", json.dumps(mupdf_view(path, "")))
        print("   qpdf   ", json.dumps(qpdf_view(path, "")))
        print("   poppler", json.dumps(poppler_view(path)))
        print("   bytes  ", json.dumps({
            "size": len(raw),
            "hasEncryptKey": b"/Encrypt" in raw,
            "typedSecretInBytes": b"hunter2" in raw,
        }))

    print("\n\n# the fixtures themselves, opened with their own secret")
    for name in sorted(n for n in os.listdir(fixture_dir) if n.endswith(".pdf")):
        path = os.path.join(fixture_dir, name)
        secret = "" if name.endswith("-owner.pdf") or name == "plain.pdf" else "hunter2"
        print(f"\n## {name} (secret {secret!r})")
        print("   pypdf  ", json.dumps(pypdf_view(path, secret)))
        print("   mupdf  ", json.dumps(mupdf_view(path, secret)))
        print("   qpdf   ", json.dumps(qpdf_view(path, secret)))


if __name__ == "__main__":
    main()
