#!/usr/bin/env python3
"""Round 051: what the /Encrypt dictionary says, and what five outside readers
answer to it — with a deliberately wrong password, the user secret and the owner
secret asked separately.

`docs/research/protect-readers.py` (the row's older rig) tries the empty password
and then the right one and reports whether the plant survives; it never offers a
*wrong* secret, so "a wrong password is refused" was one of the row's unmeasured
claims, and it never reads `/V`, `/R` or `/CF` out of the bytes, so the cipher the
card prints was checked by eye against a log rather than parsed.

For each file this prints, from the bytes:

  /V /R /CFM /Length /StmF /StrF /P   the dictionary as written,
  bits                               the /P mask decoded bit by bit,

and then, per reader (MuPDF, poppler, qpdf, pypdf, Ghostscript), four verdicts:
no password, a wrong one, the user password, the owner password — plus, where the
reader's CLI allows it, whether it honours a disabled copy or print flag.

  python3 docs/research/protect-round-readers.py <dir> [PLANTED] [USER] [OWNER]
"""
import glob
import os
import re
import subprocess
import sys

TARGET = os.path.abspath(sys.argv[1])
PLANTED = sys.argv[2] if len(sys.argv) > 2 else "Lighthouse"
USER = sys.argv[3] if len(sys.argv) > 3 else "reader-pass"
OWNER = sys.argv[4] if len(sys.argv) > 4 else "owner-pass"
WRONG = "not-the-password"
BITS = {"print": 4, "highres": 2048, "modify": 8, "copy": 16, "annot": 32,
        "forms": 256, "access": 512, "assemble": 1024}


def run(cmd):
    done = subprocess.run(cmd, capture_output=True, text=True, check=False, errors="replace")
    return done.returncode, done.stdout, done.stderr


def clip(text, count=150):
    return " / ".join(line for line in (text or "").splitlines() if line.strip())[:count]


def dictionary(path):
    """The /Encrypt dictionary as the bytes spell it — the file's own claim."""
    with open(path, "rb") as handle:
        raw = handle.read()
    bits = {}
    for key in (rb"/V", rb"/R", rb"/CFM", rb"/Length", rb"/StmF", rb"/StrF", rb"/Filter"):
        found = re.findall(re.escape(key) + rb"\s*(/[A-Za-z0-9]+|-?\d+)", raw)
        bits[key.decode()] = [value.decode() for value in found][:4]
    mask = re.findall(rb"/P\s*(-?\d+)", raw)
    value = int(mask[-1]) & 0xFFFFFFFF if mask else None
    allows = sorted(name for name, bit in BITS.items() if value is not None and value & bit)
    return bits, mask[-1].decode() if mask else "?", allows


# Each reader answers one of: opens-with | refuses | error, per candidate secret.
def mupdf(path, candidate):
    import pymupdf
    try:
        doc = pymupdf.open(path)
        if not doc.needs_pass:
            return "opens with no password", ""
        if candidate is None:
            return "refuses (asks)", ""
        ok = doc.authenticate(candidate)
        return ("opened" if ok else "refused"), ""
    except Exception as err:  # noqa: BLE001
        return f"error {type(err).__name__}", str(err)


def poppler(path, candidate, flag="-upw"):
    args = [flag, candidate] if candidate else []
    code, out, err = run(["pdftotext", *args, path, "-"])
    if code == 0:
        return ("opened with the empty secret" if not candidate else "opened"), out
    if "password" in (err or "").lower():
        return "refused", ""
    return f"rc={code}", clip(err)


def qpdf(path, candidate):
    import pikepdf
    try:
        with pikepdf.open(path, password=candidate or "") as pdf:
            check = pdf.check_pdf_syntax() or "clean"
            allow = sorted(name for name in (
                "print_lowres", "print_highres", "modify_annotation", "modify_assembly",
                "modify_form", "modify_other", "extract", "accessibility",
            ) if getattr(pdf.allow, name, False))
            return f"opened, syntax {check}, allows {allow or 'nothing'}", ""
    except pikepdf.PasswordError:
        return "refused", ""
    except Exception as err:  # noqa: BLE001
        return f"error {type(err).__name__}", str(err)


def pypdf_reader(path, candidate):
    from pypdf import PdfReader
    try:
        reader = PdfReader(path)
        if not reader.is_encrypted:
            return "opens with no password", ""
        level = reader.decrypt(candidate or "")
        if level == 0:
            return "refused", ""
        text = "".join(page.extract_text() or "" for page in reader.pages)
        return f"opened (level {level})", text
    except Exception as err:  # noqa: BLE001
        return f"error {type(err).__name__}", str(err)


def ghostscript(path, candidate):
    out = f"/tmp/protect-round-gs-{os.getpid()}.pdf"
    code, _, err = run(["gs", "-o", out, "-sDEVICE=pdfwrite", "-dBATCH", "-dNOPAUSE",
                        f"-dPDFPassword=({candidate or ''})", path])
    pages, text = "?", ""
    if os.path.exists(out):
        _, info, _ = run(["pdfinfo", out])
        pages = next((row.split(":", 1)[1].strip() for row in info.splitlines()
                      if row.startswith("Pages")), "?")
        _, text, _ = run(["pdftotext", out, "-"])
        os.remove(out)
    if "password" in (err or "").lower():
        return "refused", ""
    if code == 0 and pages not in ("0", "?"):
        return f"wrote {pages} page(s)", text
    return f"rc={code} pages={pages}", clip(err)


READERS = {"mupdf": mupdf, "poppler": poppler, "qpdf": qpdf, "pypdf": pypdf_reader, "gs": ghostscript}

for path in sorted(glob.glob(os.path.join(TARGET, "*.pdf"))):
    print(f"=== {os.path.basename(path)} ({os.path.getsize(path)} bytes)")
    bits, mask, allows = dictionary(path)
    print(f"  dictionary: {bits}")
    print(f"  /P {mask} -> allows {allows or 'nothing'}")
    for label, reader in READERS.items():
        cells = []
        for name, candidate in (("no-password", None), ("wrong", WRONG),
                                ("user", USER), ("owner", OWNER)):
            try:
                flag = "-opw" if (name == "owner" and label == "poppler") else "-upw"
                verdict, text = (reader(path, candidate, flag) if label == "poppler"
                                 else reader(path, candidate))
            except Exception as err:  # noqa: BLE001
                verdict, text = f"harness error {type(err).__name__}", ""
            cell = f"{name}: {verdict}"
            if name in ("user", "owner") and text:
                cell += f" [plant {PLANTED in text}]"
            cells.append(cell)
        print(f"  {label:8s}: " + "; ".join(cells))
    # Does a reader honour the flags where its CLI lets it? Only meaningful on
    # files the flags restrict; every reader is asked with the owner secret so the
    # answer is about enforcement, not about the gate.
    code_text, text_out, text_err = run(["pdftotext", "-opw", OWNER, path, "-"])
    print(f"  copy (pdftotext, owner secret): rc={code_text} chars={len(text_out)} "
          f"plant={PLANTED in text_out} allows-copy={'copy' in allows}")
    code_ps, _, ps_err = run(["pdftops", "-opw", OWNER, path, "/tmp/protect-round.ps"])
    print(f"  print (pdftops, owner secret): rc={code_ps} {clip(ps_err, 110)} "
          f"allows-print={'print' in allows}")
