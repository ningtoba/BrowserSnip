#!/usr/bin/env python3
"""The known-good side of the `protect` row.

Writes one fixture and encrypts it four ways with **qpdf** (through pikepdf),
then prints each file's /Encrypt dictionary field by field.  This is what a
claim about "what R6 requires" should be measured against: an independent
implementation's own output, not this app's reading of the spec.  Each file is
read back by qpdf and by MuPDF, so "valid" is a measurement.

  python3 docs/research/protect-reference.py <outdir>
"""
import os
import sys

import pikepdf
import pymupdf

TARGET = os.path.abspath(sys.argv[1])
os.makedirs(TARGET, exist_ok=True)

USER = "reader-pass"
OWNER = "owner-pass"
PLANTED = "Lighthouse Inventory 1887"
BASE = os.path.join(TARGET, "base.pdf")

PERMISSIONS = pikepdf.Permissions(
    print_lowres=False, print_highres=False,
    modify_annotation=False, modify_assembly=False,
    modify_form=False, modify_other=False,
    extract=True, accessibility=True,
)


def fixture():
    doc = pymupdf.open()
    for index in range(3):
        page = doc.new_page(width=595, height=842)
        page.insert_text((60, 700), f"{PLANTED} page {index + 1}", fontsize=18)
    doc.set_metadata({"title": PLANTED})
    doc.save(BASE)
    doc.close()


def encryption(revision: int, use_aes: bool):
    shared = {"owner": OWNER, "user": USER, "allow": PERMISSIONS, "metadata": True, "aes": use_aes}
    if revision == 6:
        return pikepdf.Encryption(R=6, **shared)
    if revision == 5:
        return pikepdf.Encryption(R=5, **shared)
    if revision == 4:
        return pikepdf.Encryption(R=4, **shared)
    return pikepdf.Encryption(R=3, **shared)


def describe(value):
    if isinstance(value, pikepdf.String):
        return f"string, {len(bytes(value))} bytes"
    if isinstance(value, pikepdf.Dictionary):
        inner = ", ".join(f"{key} {describe(item)}" for key, item in value.items())
        return f"dict({inner})"
    if isinstance(value, pikepdf.Name):
        return f"name {value}"
    return str(value)


def report(path):
    print(f"--- {os.path.basename(path)} ({os.path.getsize(path)} bytes)")
    with pikepdf.open(path, password=USER) as pdf:
        encrypt = pdf.trailer.get("/Encrypt")
        if encrypt is None:
            print("    no /Encrypt")
        else:
            for key, value in encrypt.items():
                print(f"    {key}: {describe(value)}")
        print(f"    qpdf opened it with the user password: {len(pdf.pages)} page(s)")
    doc = pymupdf.open(path)
    accepted = bool(doc.authenticate(USER))
    pages = doc.page_count
    text = "".join(str(doc[index].get_text()) for index in range(pages))
    meta = doc.metadata or {}
    doc.close()
    print(f"    MuPDF: authenticates={accepted} pages={pages} cipher={meta.get('encryption')!r} "
          f"planted text extracted={PLANTED in text}")


if not os.path.exists(BASE):
    fixture()

for case_name, revision, use_aes in (
    ("ref-r6-aes256.pdf", 6, True),
    ("ref-r5-aes256.pdf", 5, True),
    ("ref-r4-aes128.pdf", 4, True),
    ("ref-r3-rc4.pdf", 3, False),
):
    out = os.path.join(TARGET, case_name)
    try:
        with pikepdf.open(BASE) as pdf:
            pdf.save(out, encryption=encryption(revision, use_aes))
    except Exception as err:  # noqa: BLE001
        print(f"--- {case_name}: qpdf refused this combination: {type(err).__name__}: {err}")
        continue
    report(out)
