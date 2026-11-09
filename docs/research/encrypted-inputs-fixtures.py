#!/usr/bin/env python3
"""The `encrypted-inputs` row's inputs: PDFs locked by **outside** implementations.

Nothing in the set was written by the engine that now has to read it.  `base.pdf`
is built by MuPDF (PyMuPDF) carrying everything a copy is known to lose — three
text pages, two annotations, two form fields with values, two bookmarks, one
enclosure — and each encrypted fixture is that same document locked by one of
two independent encryptors:

    qpdf --encrypt <user> <owner> <bits> [options] -- base.pdf out.pdf
    pymupdf: doc.save(out, encryption=…, user_pw=…, owner_pw=…, permissions=…)

Two kinds of lock are produced, because they are not the same question:

  · `-user`   — the **user password** gates opening; a reader must type it;
  · `-owner`  — the user password is empty and only the owner password is set,
                so anyone may read the file and `/P` merely *asks* a reader to
                behave (restrictions, not a lock).

Every file is then verified with the tool that made it, and with MuPDF: qpdf's
own `--is-encrypted` verdict (`encrypted` / `password_incorrect`), the full
`/Encrypt` dictionary field by field, `pikepdf.open(password=…)`, a wrong
password refused, and MuPDF's `needs_pass` / `authenticate('')` /
`authenticate(user)` plus an object census (pages, annotations and their kinds,
fields and their values, bookmarks, attachments, extracted characters, the
planted sentence).  The census of a locked file is compared with the census of
`base.pdf` in the same line, so any loss the *encryptor* caused is visible here
rather than being blamed on this app later.  All of it lands in `manifest.json`,
which the app-side probe reads: a fixture that was never valid proves nothing.

    python3 docs/research/encrypted-inputs-fixtures.py <outdir>
"""
import json
import os
import subprocess
import sys

import pikepdf
import pymupdf

TARGET = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "/tmp/einp")  # noqa: S108 — the rig's scratch dir
os.makedirs(TARGET, exist_ok=True)

USER = "reader-pass"
OWNER = "owner-pass"
WRONG = "not-the-password"
PLANTED = "Lighthouse Inventory 1887"
PAGES = 3
SHEET_WORDS = ("ALPHA", "BRAVO", "CHARLIE")
BASE = os.path.join(TARGET, "base.pdf")

# qpdf's own option spellings for the `/P` bits, chosen to be the same set the
# `protect` row's reference fixtures carry: copy and accessibility allowed,
# print / modify / annotate / form / assemble refused.
QPDF_PERMISSIONS = [
    "--print=none", "--modify=none",
    "--annotate=n", "--form=n", "--assemble=n", "--extract=y", "--accessibility=y",
]


def constant(name: str) -> int:
    """A PyMuPDF `PDF_*` constant.

    PyMuPDF assembles these names onto the module at import time from its SWIG
    bindings, so a static checker cannot see them even though they are always
    there at runtime — which this function asserts rather than assumes.
    """
    value = getattr(pymupdf, name, None)
    if value is None:
        raise AssertionError(f"pymupdf has no constant {name}")
    return int(value)


RC4 = constant("PDF_ENCRYPT_RC4_128")
AES128 = constant("PDF_ENCRYPT_AES_128")
AES256 = constant("PDF_ENCRYPT_AES_256")

# MuPDF's mask has no separate extract bit; copy is the bit that governs it.
MUPDF_PERMISSIONS = constant("PDF_PERM_ACCESSIBILITY") | constant("PDF_PERM_COPY")


def build_base() -> None:
    """The countable document: every object this app is known to drop, planted."""
    doc = pymupdf.open()
    for index in range(PAGES):
        page = doc.new_page(width=595, height=842)
        page.insert_text((60, 700), f"{PLANTED} page {index + 1}", fontsize=18)
        # A word unique to each sheet: a page count that stays 3 while a page
        # goes missing is only visible in the text, so the text names its sheet.
        page.insert_text((60, 660), f"Sheet {SHEET_WORDS[index]} body copy", fontsize=11)
    first, second, third = doc[0], doc[1], doc[2]

    note = first.add_text_annot((120, 400), "Alice needs a note")
    note.set_info(title="Audit", content="Alice needs a note", subject="review")
    note.update()
    mark = second.add_highlight_annot(pymupdf.Rect(58, 686, 300, 706))
    mark.set_info(title="Audit", content="marked")
    mark.update()

    widget(third, rect=pymupdf.Rect(60, 300, 260, 320), field_name="applicant.name",
            field_label="Name", field_value="Ada Lovelace",
            field_type=constant("PDF_WIDGET_TYPE_TEXT"))
    widget(third, rect=pymupdf.Rect(60, 250, 80, 270), field_name="agree",
           field_label="Agree", field_value=True,
           field_type=constant("PDF_WIDGET_TYPE_CHECKBOX"))

    # A link annotation as well: the campaign's `zero-ink link` failure mode is
    # only countable if a link is in the document to begin with.
    third.insert_link({
        "kind": constant("LINK_URI"),
        "from": pymupdf.Rect(60, 620, 220, 636),
        "uri": "https://example.com",
    })

    doc.set_toc([[1, "Chapter Bravo", 1], [2, "Intro", 2]])
    doc.embfile_add("source.csv", b"a,b\n1,2\n", filename="source.csv", ufilename="source.csv", desc="csv")
    doc.set_metadata({"title": PLANTED, "author": "encrypted-inputs rig"})
    doc.save(BASE)
    doc.close()


def widget(page: pymupdf.Page, **properties) -> None:
    """Add a form field, setting MuPDF's `Widget` attributes by name.

    The attributes exist at runtime but the class hands them to a type checker as
    `None`, so they are applied through `setattr`.  Same field names, same order
    a browser sends them.
    """
    field = pymupdf.Widget()
    for name, value in properties.items():
        setattr(field, name, value)
    page.add_widget(field)


def qpdf_lock(out: str, *, user: str, bits: int, aes: bool) -> str:
    """Run qpdf's CLI option set through the libqpdf that `pikepdf` embeds."""
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


def mupdf_lock(out: str, *, user: str, algorithm: int) -> str:
    doc = pymupdf.open(BASE)
    doc.save(out, encryption=algorithm, owner_pw=OWNER, user_pw=user, permissions=MUPDF_PERMISSIONS)
    doc.close()
    if not os.path.exists(out):
        raise RuntimeError(f"MuPDF reported success but wrote no {out}")
    names = {RC4: "PDF_ENCRYPT_RC4_128", AES128: "PDF_ENCRYPT_AES_128", AES256: "PDF_ENCRYPT_AES_256"}
    return (
        f"python3 -c \"import pymupdf; d = pymupdf.open('{os.path.relpath(BASE, TARGET)}'); "
        f"d.save('{os.path.basename(out)}', encryption=pymupdf.{names[algorithm]}, "
        f"owner_pw={OWNER!r}, user_pw={user!r}, "
        "permissions=PDF_PERM_ACCESSIBILITY|PDF_PERM_COPY)\""
    )


def qpdf_verdict(path: str) -> dict:
    """qpdf's own answer to "is this locked, and does it need the user password"."""
    job = pikepdf.Job(["qpdf", "--is-encrypted", path])
    job.run()
    return {"exit": job.exit_code, **(job.encryption_status or {})}


def dictionary(path: str, password: str) -> dict:
    """The `/Encrypt` dictionary as the file writes it, one line per key."""
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
                        inner.append(f"{inner_key}:CFM={inner_value.get('/CFM')}/Length={inner_value.get('/Length')}")
                    else:
                        inner.append(f"{inner_key}={inner_value}")
                flat[name] = "dict(" + ", ".join(inner) + ")"
            else:
                flat[name] = str(value)
        return flat


def census(doc: pymupdf.Document, path: str | None = None, password: str = "") -> dict:
    """What the bytes actually hold, counted by MuPDF — not by this app.

    `annots` counts what MuPDF hands out through `page.annots()`, which omits
    `/Link` and widget annotations; `annots_entries` counts the raw `/Annots`
    array entries with qpdf, which is the number this app's own helper reports.
    Both are recorded so a disagreement is a measurement rather than a definition.
    """
    text = "".join(str(page.get_text()) for page in doc)
    entries = 0
    if path:
        with pikepdf.open(path, password=password) as pdf:
            for page in pdf.pages:
                value = page.get("/Annots")
                if value is not None:
                    entries += len(value)
    return {
        "pages": doc.page_count,
        "annots": sum(len(list(page.annots())) for page in doc),
        "annots_entries": entries,
        "annot_kinds": sorted({a.type[1] for page in doc for a in page.annots()}),
        "links": sum(len(page.get_links()) for page in doc),
        "fields": sum(len(list(page.widgets())) for page in doc),
        "field_values": sorted({str(getattr(w, "field_value", "")) for page in doc for w in page.widgets()}),
        "bookmarks": len(doc.get_toc()),
        "attachments": sorted(doc.embfile_names()),
        "text_chars": len(text),
        "planted_pages": sum(1 for i in range(doc.page_count) if PLANTED in doc[i].get_text()),
        "sheet_words": [word for word in SHEET_WORDS if word in text],
        "title": (doc.metadata or {}).get("title"),
        # Non-white coverage of sheet 1 at 100 dpi: what the page *draws*, not
        # what a parser says it contains. A page of ciphertext rasterises blank.
        "ink_page1_percent": ink_of(doc[0]) if doc.page_count else None,
        "page1_excerpt": " ".join(str(doc[0].get_text()).split())[:70] if doc.page_count else "",
    }


def ink_of(page: pymupdf.Page) -> float:
    """Percentage of the rendered sheet that is not paper."""
    pix = page.get_pixmap(dpi=100, colorspace=pymupdf.csGRAY)
    samples = pix.samples
    dark = sum(1 for byte in samples if byte < 250)
    return round(100 * dark / max(1, len(samples)), 2)


def poppler(path: str, password: str) -> dict:
    """poppler's opinion — a reader with its own idea of what a gate means."""
    def call(tool, args):
        try:
            argv = [tool] + [a for a in args if a != "-"] + [path]
            if args and args[-1] == "-":
                argv.append("-")
            done = subprocess.run(argv, capture_output=True, text=True, check=False, timeout=120)
            return done.returncode, done.stdout, done.stderr
        except FileNotFoundError:
            return None, "", f"{tool} not installed"
        except subprocess.TimeoutExpired:
            return None, "", f"{tool} timed out"

    pw = ["-upw", password] if password else []
    info_code, info_text, info_err = call("pdfinfo", pw)
    fields = {}
    for line in info_text.splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            fields.setdefault(key.strip().lower(), value.strip())
    # "-" as the output name is what makes pdftotext write to the pipe at all.
    text_code, text, text_err = call("pdftotext", ["-layout"] + pw + ["-"])
    return {
        "pages": fields.get("pages"),
        "encrypted": fields.get("encrypted", "(absent)"),
        "pdfinfo_rc": info_code,
        "pdfinfo_err": " / ".join(s for s in info_err.splitlines() if s.strip())[:200],
        "text_rc": text_code,
        "text_planted": PLANTED in text,
        "text_chars": len(text),
        "text_err": " / ".join(s for s in text_err.splitlines() if s.strip())[:200],
    }


def pypdf(path: str, password: str) -> dict:
    try:
        from pypdf import PdfReader
    except Exception as err:  # noqa: BLE001
        return {"error": f"pypdf unavailable: {err}"}
    try:
        reader = PdfReader(path)
        locked = bool(reader.is_encrypted)
        decrypt = None
        try:
            decrypt = reader.decrypt(password or "")
        except Exception as err:  # noqa: BLE001
            decrypt = f"raised {type(err).__name__}"
        try:
            pages = len(reader.pages)
            text = "".join(page.extract_text() or "" for page in reader.pages)
        except Exception as err:  # noqa: BLE001
            return {"encrypted": locked, "decrypt": decrypt, "error": f"{type(err).__name__}: {str(err)[:120]}"}
        return {"encrypted": locked, "decrypt": str(decrypt), "pages": pages, "planted": PLANTED in text, "text_chars": len(text)}
    except Exception as err:  # noqa: BLE001
        return {"error": f"{type(err).__name__}: {str(err)[:140]}"}


CASES = [
    # (file name, producer, qpdf bits / mupdf algorithm, aes, user password)
    ("einp-q-r3-rc4-128-user.pdf",   "qpdf",  128, RC4,    False, USER),
    ("einp-q-r4-aes-128-user.pdf",   "qpdf",  128, AES128, True,  USER),
    ("einp-q-r6-aes-256-user.pdf",   "qpdf",  256, AES256, True,  USER),
    ("einp-q-r3-rc4-128-owner.pdf",  "qpdf",  128, RC4,    False, ""),
    ("einp-q-r4-aes-128-owner.pdf",  "qpdf",  128, AES128, True,  ""),
    ("einp-q-r6-aes-256-owner.pdf",  "qpdf",  256, AES256, True,  ""),
    ("einp-mu-r3-rc4-128-user.pdf",  "mupdf", 128, RC4,    False, USER),
    ("einp-mu-r4-aes-128-user.pdf",  "mupdf", 128, AES128, True,  USER),
    ("einp-mu-r6-aes-256-user.pdf",  "mupdf", 256, AES256, True,  USER),
    ("einp-mu-r6-aes-256-owner.pdf", "mupdf", 256, AES256, True,  ""),
]


def verify(path: str, *, user: str, made_by: str, command: str, kind: str, reference: dict) -> dict:
    """Every claim about a fixture is made by a reader that did not write it."""
    report = {
        "file": os.path.basename(path),
        "kind": kind,
        "made_by": made_by,
        "command": command,
        "bytes": os.path.getsize(path),
        "qpdf": qpdf_verdict(path),
        "dictionary": dictionary(path, user or ""),
        "passwords": {"user": user, "owner": OWNER, "wrong": WRONG},
    }

    # The producing tool must open it with its own password — this is the check
    # that makes the fixture valid rather than merely present.
    try:
        with pikepdf.open(path, password=user or "") as pdf:
            report["qpdf_opens"] = f"yes, {len(pdf.pages)} page(s)"
    except Exception as err:  # noqa: BLE001
        report["qpdf_opens"] = f"no: {type(err).__name__}: {str(err)[:120]}"
    if user:
        try:
            with pikepdf.open(path, password=WRONG):
                report["qpdf_rejects_the_wrong_one"] = "NO — it accepted the wrong one"
        except pikepdf.PasswordError:
            report["qpdf_rejects_the_wrong_one"] = "yes"
        except Exception as err:  # noqa: BLE001
            report["qpdf_rejects_the_wrong_one"] = f"raised {type(err).__name__}: {str(err)[:80]}"
    else:
        report["qpdf_rejects_the_wrong_one"] = "n/a (no user secret set)"

    doc = pymupdf.open(path)
    report["mupdf_needs_pass"] = bool(doc.needs_pass)
    report["mupdf_empty_password_opens"] = doc.authenticate("") != 0
    doc.close()
    doc = pymupdf.open(path)
    report["mupdf_user_password_opens"] = doc.authenticate(user or "") != 0
    report["mupdf_cipher"] = (doc.metadata or {}).get("encryption")
    report["mupdf_permissions"] = doc.permissions
    report["census"] = census(doc, path, user) if report["mupdf_user_password_opens"] or not user else None
    doc.close()
    if user:
        doc = pymupdf.open(path)
        accepted = doc.authenticate(WRONG)
        if accepted:
            report["mupdf_accepts_the_wrong_one"] = accepted
            report["mupdf_wrong_one_pages_readable"] = doc.page_count
        else:
            # MuPDF leaves the document closed: it will not hand out pages at all.
            report["mupdf_accepts_the_wrong_one"] = False
            report["mupdf_wrong_one_pages_readable"] = "not readable"
        doc.close()

    report["poppler_no_password"] = poppler(path, "")
    report["poppler_with_password"] = poppler(path, user) if user else None
    report["pypdf"] = pypdf(path, user or "")
    report["encryptor_changed_nothing"] = report["census"] == reference if report.get("census") else None
    return report


if not os.path.exists(BASE):
    build_base()

base_doc = pymupdf.open(BASE)
base_census = census(base_doc, BASE)
base_doc.close()

manifest = {
    "produced_by": {
        "libqpdf": pikepdf.__libqpdf_version__,
        "pymupdf": pymupdf.VersionBind,
        "pypdf": __import__("pypdf").__version__,
    },
    "passwords": {"user": USER, "owner": OWNER, "wrong": WRONG},
    "planted": {"sentence": PLANTED, "pages": PAGES, "sheet_words": list(SHEET_WORDS)},
    "base": {
        "file": "base.pdf",
        "command": "python3 docs/research/encrypted-inputs-fixtures.py <outdir>  (build_base, by MuPDF)",
        "census": base_census,
        "qpdf": qpdf_verdict(BASE),
        "poppler": poppler(BASE, ""),
    },
    "fixtures": [],
}

print(f"# fixtures in {TARGET} — libqpdf {manifest['produced_by']['libqpdf']}, MuPDF {manifest['produced_by']['pymupdf']}")
print("--- base.pdf (unencrypted control)")
print(f"    census: {json.dumps(base_census, sort_keys=True)}")

for name, producer, bits, algorithm, aes, user in CASES:
    out = os.path.join(TARGET, name)
    if os.path.exists(out):
        os.remove(out)
    command = (
        qpdf_lock(out, user=user, bits=bits, aes=aes)
        if producer == "qpdf"
        else mupdf_lock(out, user=user, algorithm=algorithm)
    )
    kind = "user-password" if user else "owner-password-only"
    report = verify(out, user=user, made_by=producer, command=command, kind=kind, reference=base_census)
    manifest["fixtures"].append(report)

    print(f"--- {name}  [{producer} · {kind}]")
    print(f"    command: {command}")
    print(f"    dictionary: {json.dumps(report['dictionary'], sort_keys=True)}")
    print(f"    qpdf --is-encrypted: {json.dumps(report['qpdf'], sort_keys=True)}   opens: {report['qpdf_opens']}   "
          f"wrong password refused: {report['qpdf_rejects_the_wrong_one']}")
    print(f"    MuPDF: needs_pass={report['mupdf_needs_pass']} empty-opens={report['mupdf_empty_password_opens']} "
          f"user-opens={report['mupdf_user_password_opens']} cipher={report['mupdf_cipher']!r} /P={report['mupdf_permissions']}")
    print(f"    census: {json.dumps(report['census'], sort_keys=True)}")
    print(f"    encryptor changed nothing: {report['encryptor_changed_nothing']}")
    print(f"    poppler (no pw): {json.dumps(report['poppler_no_password'], sort_keys=True)}")
    if report["poppler_with_password"]:
        print(f"    poppler (user pw): {json.dumps(report['poppler_with_password'], sort_keys=True)}")
    print(f"    pypdf: {json.dumps(report['pypdf'], sort_keys=True)}")

with open(os.path.join(TARGET, "manifest.json"), "w") as handle:
    json.dump(manifest, handle, indent=1, sort_keys=True)
print(f"--- manifest: {os.path.join(TARGET, 'manifest.json')}")

# Any fixture whose census drifted from the base is a problem with the fixture,
# not with this app: fail loudly so nobody measures a broken instrument.
drift = [f["file"] for f in manifest["fixtures"] if f.get("encryptor_changed_nothing") is False]
if drift:
    print(f"!! the encryptor itself changed the object census in: {', '.join(drift)}")
    print("   losses for those files are measured against their OWN census, printed above.")
