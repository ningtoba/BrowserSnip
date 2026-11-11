#!/usr/bin/env python3
# The pypdf names this probe reaches for are its own internals (`AlgV5`, `_key`,
# `aes_ecb_decrypt`), typed loosely enough that a strict checker calls every one of
# them an error while it runs fine. This file is a measuring stick, not a library.
# pyright: reportGeneralTypeIssues=false, reportPrivateImportUsage=false, reportArgumentType=false, reportAttributeAccessIssue=false, reportIndexIssue=false, reportOptionalMemberAccess=false
"""Independent verdicts on the AES-256 files THIS APP wrote.

`tests/pdf/crypto-aes256-write.test.ts` proves `core/crypto`'s revision-6 ladder
reproduces a foreign fixture's `/U`, `/UE`, `/O`, `/OE` and `/Perms` byte for byte,
and that pdf.js opens what this app writes. This is the other half of the same
claim, run by parsers that share no code with either:

  recompute  pypdf's own `AlgV5` rebuilds all five dictionary values from the
             file's salts and the file key pypdf derived, and each is compared with
             the bytes the file carries. This is the check the `protect` row was
             closed on for AES-128, at the revision where there are five values
             instead of three and no MD5 to blame when one is wrong.
  MuPDF      needs_pass, which secret authenticates, the cipher it names, /P, the
             planted sentence per sheet, page-1 ink and the outline.
  qpdf       opens with / without the secret, and `check_pdf_syntax` — the
             `qpdf --check` verdict, through the library that embeds it.
  poppler    pdfinfo's `Encrypted:` line and whether pdftotext needs the password.
  Ghostscript how many pages it renders, with the secret and without.

Every file is asked with the empty password first and the planted one second,
because a permissions-only file's user secret IS the empty string and a reader that
refuses it is refusing the gate, not the fixture.

  python3 docs/research/aes256-write-readers.py <dir> [PLANTED] [PASSWORD]

The dir the test fills:

  AES256_PROBE_DIR=/tmp/a256 npx vitest run tests/pdf/crypto-aes256-write.test.ts
  python3 docs/research/aes256-write-readers.py /tmp/a256
"""
import glob
import os
import subprocess
import sys

TARGET = os.path.abspath(sys.argv[1])
PLANTED = sys.argv[2] if len(sys.argv) > 2 else "Lighthouse Inventory 1887"
PASSWORD = sys.argv[3] if len(sys.argv) > 3 else "hunter2"
TRY_PASSWORDS = ("", PASSWORD)


def run(cmd):
    done = subprocess.run(cmd, capture_output=True, text=True, check=False, errors="replace")
    return done.returncode, done.stdout, done.stderr


def clip(text, count=170):
    joined = " / ".join(line for line in (text or "").splitlines() if line.strip())
    return joined[:count]


def raw(value):
    """A dictionary string value as bytes, whichever string class pypdf chose."""
    return getattr(value, "original_bytes", None) or value.encode("latin1")


# ── pypdf: the key schedule, recomputed by somebody else ────────────────────
def recompute(path):
    # The private names are the point: `AlgV5.calculate_hash` is pypdf's own
    # implementation of the revision-6 ladder, and `aes_cbc_encrypt` / `aes_ecb_decrypt`
    # are its own AES. Nothing here borrows a byte from this app.
    from pypdf import PdfReader  # type: ignore[import-untyped]
    from pypdf._encryption import AlgV5, aes_cbc_encrypt, aes_ecb_decrypt

    reader = PdfReader(path)
    opened = None
    for candidate in TRY_PASSWORDS:
        try:
            level = reader.decrypt(candidate)
        except Exception as err:  # noqa: BLE001
            return f"pypdf cannot decrypt ({candidate or 'empty'}): {type(err).__name__}: {clip(str(err))}"
        if level:
            opened = (candidate, level)
            break
    if opened is None:
        return "pypdf accepts neither the empty nor the planted password"
    candidate, level = opened
    enc = reader._encryption
    key = enc._key
    entry = reader.trailer["/Encrypt"]
    u_value, o_value = raw(entry["/U"]), raw(entry["/O"])
    ue_value, oe_value = raw(entry["/UE"]), raw(entry["/OE"])
    perms = raw(entry["/Perms"])
    dictionary = {str(name): entry[name] for name in entry}
    filters = entry["/CF"]["/StdCF"] if "/CF" in dictionary else {}
    # pypdf's own decode of the dictionary's claim. `BooleanObject` is an int
    # subclass whose `bool()` is True even when it spells `false`, so reading the
    # flag off the dictionary by hand is how this line first printed `True` for a
    # file that says `/EncryptMetadata false`. The byte the check value records is
    # printed beside it, which is the pair worth comparing.
    metadata_encrypted = bool(enc.EncryptMetadata)
    # The five values, rebuilt from the file's own randomness: the salts are the
    # tails of /U and /O, the wrapped key is what /UE unwraps to, and the four
    # ignored bytes are read back out of /Perms itself.
    perms_plain = aes_ecb_decrypt(key, perms)
    seal_key = {
        "fileKey": key,
        "userValidationSalt": u_value[32:40],
        "userKeySalt": u_value[40:48],
        "ownerValidationSalt": o_value[32:40],
        "ownerKeySalt": o_value[40:48],
        "permsRandom": perms_plain[12:16],
    }
    user_secret = PASSWORD.encode() if candidate == PASSWORD else b""
    # Whichever secret opened it, both were tried; report the file's own user secret
    # as the empty string only when the empty password is what opened it.
    computed_u = AlgV5.calculate_hash(6, user_secret, seal_key["userValidationSalt"], b"")
    computed_ue = aes_cbc_encrypt(
        AlgV5.calculate_hash(6, user_secret, seal_key["userKeySalt"], b""), bytes(16), key
    )
    owner_secret = PASSWORD.encode()
    computed_o = AlgV5.calculate_hash(6, owner_secret, seal_key["ownerValidationSalt"], u_value)
    computed_oe = aes_cbc_encrypt(
        AlgV5.calculate_hash(6, owner_secret, seal_key["ownerKeySalt"], u_value), bytes(16), key
    )
    computed_perms = aes_cbc_encrypt(
        key,
        bytes(16),
        enc.P.to_bytes(4, "little") + b"\xff\xff\xff\xff"
        + (b"T" if metadata_encrypted else b"F") + b"adb" + seal_key["permsRandom"],
    )
    def same(computed, carried):
        return "matches" if computed == carried else "DIFFERS"
    text = "".join(page.extract_text() or "" for page in reader.pages)
    return (
        f"pypdf: decrypt({candidate!r})={level} "
        f"(1=user 2=owner), keylen={len(key)}, "
        f"dict=/V {dictionary.get('/V')} /R {dictionary.get('/R')} /Length {dictionary.get('/Length')} "
        f"CFM={filters.get('/CFM')} CF/Length={filters.get('/Length')} /P {dictionary.get('/P')} "
        f"EncryptMetadata={metadata_encrypted}, "
        f"|O|={len(o_value)} |U|={len(u_value)} |OE|={len(oe_value)} |UE|={len(ue_value)} |Perms|={len(perms)}, "
        f"recomputed /U {same(computed_u, u_value[:32])}, /UE {same(computed_ue, ue_value)}, "
        f"/O {same(computed_o, o_value[:32])}, /OE {same(computed_oe, oe_value)}, "
        f"/Perms {same(computed_perms, perms)}, "
        f"perms-plain {perms_plain[:12].hex()} (byte 8 {perms_plain[8:9]!r}, 9-11 {perms_plain[9:12]!r}), "
        f"pages={len(reader.pages)}, planted {PLANTED in text}, text chars {len(text)}"
    )


# ── MuPDF ───────────────────────────────────────────────────────────────────
def mupdf(path):
    import pymupdf

    try:
        doc = pymupdf.open(path)
    except Exception as err:  # noqa: BLE001
        return f"does not open: {type(err).__name__}: {clip(str(err))}"
    gate = "opens with no password"
    if doc.needs_pass:
        auth = doc.authenticate(PASSWORD)
        if not auth:
            doc.close()
            return "refuses the empty password and the planted one"
        gate = f"refuses an empty password, opened with {PASSWORD!r}"
    auth = doc.authenticate(PASSWORD)
    pages, planted, ink = doc.page_count, 0, "?"
    for index in range(pages):
        if PLANTED in str(doc[index].get_text()):
            planted += 1
    try:
        pix = doc[0].get_pixmap(dpi=72)
        samples = pix.samples
        ink = f"{100 * sum(1 for i in range(0, len(samples), pix.n) if samples[i] < 255) / (pix.width * pix.height):.2f}"
    except Exception:  # noqa: BLE001, S110
        pass  # a page this build cannot raster simply reports ink "?"
    meta = doc.metadata or {}
    line = (f"MuPDF: needs_pass={doc.needs_pass}, {gate}, auth={auth}, pages={pages}, "
            f"cipher={meta.get('encryption')!r}, /P={doc.permissions}, "
            f"planted_pages {planted}/{pages}, ink_page1_percent={ink}, toc_entries={len(doc.get_toc())}, "
            f"title={meta.get('title')!r}")
    doc.close()
    return line


# ── qpdf (through pikepdf, which bundles libqpdf) ───────────────────────────
def qpdf(path):
    import pikepdf

    try:
        with pikepdf.open(path) as free:
            gate = "opens with no password, restricted only" if free.is_encrypted else "asks for no password"
    except pikepdf.PasswordError:
        gate = "refuses an empty password"
    except Exception as err:  # noqa: BLE001
        return f"does not open: {type(err).__name__}: {clip(str(err))}"
    for candidate in TRY_PASSWORDS:
        try:
            with pikepdf.open(path, password=candidate) as pdf:
                return (f"qpdf: {gate}, opened with {candidate or 'empty'}, pages={len(pdf.pages)}, "
                        f"is_encrypted={pdf.is_encrypted}, "
                        f"qpdf syntax check: {pdf.check_pdf_syntax() or 'clean'}")
        except pikepdf.PasswordError:
            continue
        except Exception as err:  # noqa: BLE001
            return f"qpdf: {gate}, but qpdf rejects it: {type(err).__name__}: {clip(str(err))}"
    return f"qpdf: {gate}, and no password we tried is accepted"


# ── poppler ─────────────────────────────────────────────────────────────────
def poppler(path):
    code, out, err = -1, "", ""
    for candidate in TRY_PASSWORDS:
        args = ["-upw", candidate] if candidate else []
        code, out, err = run(["pdftotext", *args, path, "-"])
        if code == 0:
            break
    # `pdfinfo -upw hunter2` fails on a permissions-only file, whose user secret is
    # the empty string: poppler calls a wrong user password an incorrect file. Both
    # spellings are asked, and the one that answered is the one quoted.
    info_code, info, _ = run(["pdfinfo", path])
    if info_code != 0:
        info_code, info_retry, _ = run(["pdfinfo", "-upw", PASSWORD, path])
        if info_code == 0:
            info = info_retry
    if code != 0 and info_code != 0:
        return f"does not open: {clip(err, 160)}"
    reported = next((row.split(":", 1)[1].strip() for row in info.splitlines()
                     if row.startswith("Encrypted")), "?")
    pages = next((row.split(":", 1)[1].strip() for row in info.splitlines()
                  if row.startswith("Pages")), "?")
    return (f"poppler: pdfinfo says Encrypted: {reported}, pages={pages}, "
            f"text extracted {'with' if code == 0 else 'without'} a password, "
            f"planted text: {PLANTED in out}")


# ── Ghostscript ─────────────────────────────────────────────────────────────
def ghostscript(path):
    out = f"/tmp/aes256-gs-{os.getpid()}.pdf"
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
        refused = "password" in (err or "").lower()
        if code == 0 and pages not in ("0", "?") and not refused:
            return (f"Ghostscript: renders{'' if candidate else ' with no password'} → wrote {pages} page(s), "
                    f"planted text through gs: {PLANTED in text}")
        if refused:
            continue
        if code != 0:
            return f"Ghostscript: FAIL rc={code}, pages={pages} {clip(err, 120)}"
    return "Ghostscript: refuses both passwords"


for target in sorted(glob.glob(os.path.join(TARGET, "*.pdf"))):
    name = os.path.basename(target)
    print(f"--- {name}  ({os.path.getsize(target)} bytes)")
    for probe in (recompute, mupdf, qpdf, poppler, ghostscript):
        try:
            print(f"    {probe(target)}")
        except Exception as err:  # noqa: BLE001
            print(f"    {probe.__name__}: crashed {type(err).__name__}: {clip(str(err))}")
print(f"--- planted sentence asked for: {PLANTED!r}, password: {PASSWORD!r}")
