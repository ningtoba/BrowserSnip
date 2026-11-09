#!/usr/bin/env python3
"""Independent judgement for the `encrypted-inputs` row: what the bytes *are*.

The app's own claims come out of `encrypted-inputs-rig.test.ts`.  This script asks
the same questions of the same files with readers that share no code with this
app — MuPDF, qpdf (libqpdf), poppler and pypdf, plus Ghostscript as a page count —
and prints, for every fixture and every file the rig dumped into `<dir>/out/`:

  gate      which secret opens it per reader, and what the `/Encrypt` dictionary
            actually claims (`/V`, `/R`, and the crypt filter it names — or the
            absence of one, which from `/V 4` up *is* the `/None` filter);
  content   the object census as MuPDF reads it: pages, annotations and raw
            `/Annots` entries, fields and their values, bookmarks, attachments,
            the planted sentence per page, the sheet words that name each page,
            and non-white ink for sheet 1;
  complaints what each reader printed while it worked, captured off the C-level
            stderr — "a reader said nothing and drew nothing" is a different
            finding from "a reader refused the file";
  deltas    that census against the census of the file the operation started
            from, so a loss is a number rather than a feeling;
  verdict   `unreadable` (a reader will not open it), `silent-loss` (it opens,
            counts the right number of pages, and the words are gone) or
            `preserved`.

"It did not throw" is not success, and neither is "the page count matches": a file
that opens as three pages and rasterises to blank paper is a wrong file that looks
healthy, which is the failure mode this campaign keeps meeting.

    python3 docs/research/encrypted-inputs-fixtures.py /tmp/einp
    ENCRYPTED_INPUTS_DIR=/tmp/einp npx vitest run \\
      --config docs/research/encrypted-inputs.vitest.config.ts
    python3 docs/research/encrypted-inputs-readers.py /tmp/einp
"""
import contextlib
import glob
import json
import os
import re
import subprocess
import sys
import tempfile

import pikepdf
import pymupdf

TARGET = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "/tmp/einp")  # noqa: S108 — the rig's scratch dir

# Filled from the manifest: the sentence planted on every sheet, and a word that
# belongs to one sheet only, so a page count can be right while a page is missing.
with open(os.path.join(TARGET, "manifest.json"), encoding="utf-8") as handle:
    MANIFEST = json.load(handle)
PLANTED = MANIFEST["planted"]["sentence"]
SHEET_WORDS = MANIFEST["planted"]["sheet_words"]
PASSWORDS = MANIFEST["passwords"]
AGAIN_USER = "again-pass"
AGAIN_OWNER = "again-owner"
SECRETS = {"user": PASSWORDS["user"], "owner": PASSWORDS["owner"], "again": AGAIN_USER, "again-owner": AGAIN_OWNER}


@contextlib.contextmanager
def captured_stderr():
    """Collect C-level stderr while the readers work.

    MuPDF reports a broken stream by writing to fd 2 and carrying on, which is the
    difference between a file that is quietly wrong and one a reader argues with —
    so the complaints are collected per file and printed with its verdict.
    """
    holder: dict = {"text": ""}
    with tempfile.TemporaryFile(mode="w+b") as sink:
        saved = os.dup(2)
        sys.stderr.flush()
        os.dup2(sink.fileno(), 2)
        try:
            yield holder
        finally:
            sys.stderr.flush()
            os.dup2(saved, 2)
            os.close(saved)
            sink.seek(0)
            holder["text"] = sink.read().decode("utf-8", "replace").strip()


def notes_of(captured: dict, path: str = "") -> str:
    """The captured complaints, collapsed to `3× kind` so they stay readable.

    MuPDF writes a complaint as several physical lines with the file name on one of
    them, so the text is split at its own `WARNING:` / `ERROR:` markers, the path is
    replaced (it differs per file and says nothing about the failure), and the
    digits are folded — offsets and object numbers repeat the same complaint.
    """
    text = captured.get("text", "")
    if not text:
        return ""
    kinds: dict[str, int] = {}
    for chunk in re.split(r"(?=(?:WARNING|ERROR)\s*:)", text):
        collapsed = " ".join(chunk.split())
        if not collapsed:
            continue
        if path:
            collapsed = collapsed.replace(path, "<file>")
        kind = re.sub(r"\d+", "N", collapsed)[:110]
        kinds[kind] = kinds.get(kind, 0) + 1
    return " · ".join(f"{count}× {kind}" for kind, count in sorted(kinds.items(), key=lambda item: -item[1])[:5])


def clip(text: str, count: int = 600) -> str:
    joined = " ".join(line.strip() for line in (text or "").splitlines() if line.strip())
    return joined[:count]


def run(cmd: list[str]) -> tuple[int | None, str, str]:
    """An external CLI, with its output; a missing tool is a stated answer."""
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=180)
        return done.returncode, done.stdout, done.stderr
    except FileNotFoundError:
        return None, "", f"{cmd[0]} not installed"
    except subprocess.TimeoutExpired:
        return None, "", f"{cmd[0]} timed out"


def ink_of(page: pymupdf.Page) -> float:
    """Percentage of the rendered sheet that is not paper, at 100 dpi."""
    pix = page.get_pixmap(dpi=100, colorspace=pymupdf.csGRAY)
    samples = pix.samples
    dark = sum(1 for byte in samples if byte < 250)
    return round(100 * dark / max(1, len(samples)), 2)


def safe(ask, default=None):
    """Take one measurement, and record the reader's own failure if it cannot.

    An exception here is a finding, not a crash: a reader that cannot decode a
    string in a produced file is telling us the file's strings are not text.
    """
    try:
        return ask()
    except Exception as err:  # noqa: BLE001
        return f"<{type(err).__name__}: {str(err)[:80]}>"


def census_of(doc: pymupdf.Document) -> dict:
    """What the bytes hold, counted by MuPDF, and what sheet 1 rasterises to.

    Every quantity is taken on its own, because the failure this row is about is
    exactly the one where a page *exists* and cannot be read: one throwing
    `get_text()` must not erase the page count sitting beside it.
    """
    pages = safe(lambda: doc.page_count)
    if not isinstance(pages, int):
        return {"pages": pages}
    notes = [safe(lambda index=index: str(doc[index].get_text()), "") for index in range(pages)]
    unreadable = [note for note in notes if isinstance(note, str) and note.startswith("<")]
    text = "".join(note for note in notes if isinstance(note, str) and not note.startswith("<"))
    return {
        "pages": pages,
        "annots": safe(lambda: sum(len(list(page.annots())) for page in doc)),
        "fields": safe(lambda: sum(len(list(page.widgets())) for page in doc)),
        "field_values": safe(lambda: sorted({str(getattr(w, "field_value", "")) for page in doc for w in page.widgets()})),
        "bookmarks": safe(lambda: len(doc.get_toc())),
        "attachments": safe(lambda: sorted(doc.embfile_names()), []),
        "text_chars": len(text),
        "text_unreadable": f"{len(unreadable)} of {pages} page(s)" if unreadable else "no",
        "planted_pages": sum(1 for note in notes if isinstance(note, str) and PLANTED in note),
        "sheet_words": [word for word in SHEET_WORDS if word in text],
        "ink_page1_percent": safe(lambda: ink_of(doc[0])) if pages else None,
        "excerpt": " ".join(notes[0].split())[:60] if pages and not notes[0].startswith("<") else "",
    }


def qpdf_gate(path: str) -> dict:
    """qpdf's own read of the dictionary, the secret it accepts, and its syntax verdict."""
    job = pikepdf.Job(["qpdf", "--is-encrypted", path])
    job.run()
    gate: dict = {"is_encrypted": {"exit": job.exit_code, **(job.encryption_status or {})}}

    accepted, key = "(nothing)", ""
    for label, candidate in [("empty", ""), *SECRETS.items()]:
        try:
            with pikepdf.open(path, password=candidate):
                accepted, key = label, candidate
                break
        except pikepdf.PasswordError:
            continue  # try the next one; "(nothing)" below means none of them opened it
    gate["opens_with"] = accepted

    check = pikepdf.Job(["qpdf", f"--password={key}", "--check", path])
    try:
        check.run()
        gate["check_exit"] = check.exit_code
        gate["check_warnings"] = bool(check.has_warnings)
    except RuntimeError as err:
        # pikepdf raises once qpdf's exit code means "errors detected": the refusal
        # *is* the measurement.
        gate["check_exit"] = check.exit_code
        gate["check_error"] = str(err)[:120]

    try:
        with pikepdf.open(path, password=key) as pdf:
            entry = pdf.trailer.get("/Encrypt")
            if entry is None:
                gate["dictionary"] = "no /Encrypt"
            else:
                version = int(entry.get("/V", 0))
                named = {str(k): str(v.get("/CFM")) for k, v in (entry.get("/CF") or {}).items()}
                gate["dictionary"] = {
                    "V": version,
                    "R": str(entry.get("/R")),
                    "Length": str(entry.get("/Length")),
                    "P": str(entry.get("/P")),
                    # `/V 1`–`/V 3` predate crypt filters, so an absent `/CF` there
                    # means the predefined RC4 algorithm. Only from `/V 4` up does a
                    # dictionary that names no filter mean `/None`: not encrypted.
                    "CFM": named or ("/None (no filter named)" if version >= 4 else "pre-filter RC4"),
                    "StmF": str(entry.get("/StmF")),
                    "StrF": str(entry.get("/StrF")),
                }
    except Exception as err:  # noqa: BLE001
        gate["dictionary"] = f"unreadable: {type(err).__name__}: {str(err)[:110]}"
    return gate


def mupdf_read(path: str) -> dict:
    """MuPDF's gate answer and its census; complaints are collected by the caller."""
    report: dict = {}
    opened_with = []
    for label, secret in [("empty", ""), *SECRETS.items()]:
        probe = pymupdf.open(path)
        if probe.authenticate(secret) != 0:
            opened_with.append(label)
        probe.close()
    report["opens_with"] = opened_with or ["(nothing)"]

    doc = pymupdf.open(path)
    report["needs_pass"] = bool(doc.needs_pass)
    key = ""
    for _label, secret in [("empty", ""), *SECRETS.items()]:
        if doc.authenticate(secret):
            key = secret
            break
    # The cipher name is only readable once a secret has been offered.
    report["cipher"] = (doc.metadata or {}).get("encryption")
    report["permissions"] = doc.permissions
    report["census"] = census_of(doc) if doc.is_pdf else None
    doc.close()

    # Raw `/Annots` entries — the count this app's own helper reports — taken with
    # qpdf, which reads the array rather than the annotation objects, so a
    # ciphertext `/V` string cannot hide an entry the page still carries.
    try:
        with pikepdf.open(path, password=key) as pdf:
            entries = sum(len(page["/Annots"]) for page in pdf.pages if page.get("/Annots") is not None)
    except Exception as err:  # noqa: BLE001
        entries = f"<qpdf could not read them: {type(err).__name__}>"
    if report["census"] is not None:
        report["census"]["annots_entries"] = entries
    return report


def poppler_read(path: str) -> dict:
    """poppler: does it ask, and can it print the words once it is allowed in."""
    report = {}
    for label, secret in [("no password", ""), *SECRETS.items()]:
        args = ["-upw", secret] if secret else []
        code, info, err = run(["pdfinfo", *args, path])
        fields = {}
        for line in info.splitlines():
            if ":" in line:
                key, value = line.split(":", 1)
                fields.setdefault(key.strip().lower(), value.strip())
        text_code, text, text_err = run(["pdftotext", "-layout", *args, path, "-"])
        report[label] = {
            "rc": code,
            "pages": fields.get("pages"),
            "cipher": fields.get("encrypted"),
            "err": clip(err or text_err, 120),
            "chars": len(text),
            "planted": PLANTED in text,
            "sheets": [word for word in SHEET_WORDS if word in text],
        }
    return report


def pypdf_read(path: str) -> dict:
    """pypdf: a fourth implementation's answer about the gate and the text."""
    try:
        from pypdf import PdfReader
    except Exception as err:  # noqa: BLE001
        return {"error": f"pypdf unavailable: {err}"}
    try:
        reader = PdfReader(path)
        verdict: dict = {"encrypted": bool(reader.is_encrypted)}
        for label, secret in [("empty", ""), *SECRETS.items()]:
            try:
                verdict[label] = str(reader.decrypt(secret))
            except Exception as err:  # noqa: BLE001
                verdict[label] = f"raised {type(err).__name__}"
        try:
            text = "".join(page.extract_text() or "" for page in reader.pages)
            verdict["pages"] = len(reader.pages)
            verdict["planted"] = PLANTED in text
        except Exception as err:  # noqa: BLE001
            verdict["read"] = f"{type(err).__name__}: {str(err)[:110]}"
        return verdict
    except Exception as err:  # noqa: BLE001
        return {"error": f"{type(err).__name__}: {str(err)[:120]}"}


def ghostscript_pages(path: str, secret: str) -> str:
    """How many pages the interpreter can actually reach."""
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "pages.pdf")
        # `-o` alone leaves this Ghostscript without a device; naming pdfwrite is
        # what makes it write a countable file rather than nothing at all.
        args = ["gs", "-q", "-dBATCH", "-dNOPAUSE", "-sDEVICE=pdfwrite", "-o", out]
        if secret:
            args.append(f"-sFilePassword={secret}")
        args.append(path)
        code, _stdout, err = run(args)
        if code is None:
            return "gs not usable"
        written = 0
        if os.path.exists(out):
            doc = pymupdf.open(out)
            written = doc.page_count
            doc.close()
        return f"{written} page(s) written" + (f"; stderr: {clip(err, 160)}" if err.strip() else "")


def number(value) -> float | None:
    """A measured quantity, or `None` when the reader could not measure it."""
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def verdict_of(gate: dict, read: dict, complaints: str) -> str:
    """Judge the outcome. `opens` is not the same question as `is right`.

    The test is self-referential on purpose: every sheet a file still carries is
    supposed to carry the planted sentence and some ink, whatever operation made
    the file. A deleted page is gone; a kept page that reads as nothing is the bug.
    """
    census = read["census"] or {}
    pages = number(census.get("pages"))
    refused = gate.get("opens_with") == "(nothing)" or int(gate.get("check_exit") or 0) >= 4
    if refused or pages in (0, None):
        return (f"unreadable: qpdf opens with {gate.get('opens_with')}, --check exit "
                f"{gate.get('check_exit')} {gate.get('check_error', '')}; MuPDF pages={census.get('pages')}")
    blank = number(census.get("ink_page1_percent")) in (0, 0.0)
    lost_words = number(census.get("planted_pages")) != pages
    unreadable = census.get("text_unreadable") not in (None, "no")
    if blank or lost_words or unreadable:
        reasons = []
        if lost_words:
            reasons.append(f"the planted sentence survives on {census.get('planted_pages')} of {pages} page(s)")
        if blank:
            reasons.append("sheet 1 rasterises blank")
        if unreadable:
            reasons.append(f"MuPDF cannot read the text on {census.get('text_unreadable')}")
        return (f"silent-loss: opens with {','.join(read.get('opens_with') or [])}, "
                + "; ".join(reasons)
                + (f"; readers complained: {clip(complaints, 160)}" if complaints else "; no reader complained"))
    return "reads: every page it carries has its words and its ink"


def line(label: str, value) -> None:
    if isinstance(value, (dict, list)):
        value = json.dumps(value, sort_keys=True, ensure_ascii=False)
    print(f"    {label}: {clip(str(value))}")


def reference_for(name: str) -> dict | None:
    """The document a produced file came from, as the same instrument measured it.

    `own-protected.pdf` is this app's own gate over `base.pdf` — the control that
    tells a defect in the read path apart from the ruling built on top of it — so
    its reference is the unencrypted base, whose census MuPDF took in the same run.
    """
    for fixture in MANIFEST["fixtures"]:
        if name.startswith(fixture["file"].replace(".pdf", "")):
            return {"file": fixture["file"], "census": fixture["census"]}
    if name.startswith("own-protected"):
        return {"file": "base.pdf (unencrypted control)", "census": MANIFEST["base"]["census"]}
    if name.startswith("base--") or name == "base.pdf":
        # The unencrypted control's own operations: their reference is the base.
        return {"file": "base.pdf (unencrypted control)", "census": MANIFEST["base"]["census"]}
    return None


print(f"# independent readers over {TARGET}")
print(f"# planted {PLANTED!r}, sheet words {SHEET_WORDS}, secrets {sorted(set(PASSWORDS.values()) | {AGAIN_USER, AGAIN_OWNER})}")
print("# qpdf dictionary claims, per fixture:")
for fixture in MANIFEST["fixtures"]:
    print(f"#   {fixture['file']}: {json.dumps(fixture['dictionary'], sort_keys=True)}")

targets = [(f["file"], os.path.join(TARGET, f["file"]), None) for f in MANIFEST["fixtures"]]
targets += [
    (os.path.join("out", os.path.basename(p)), p, reference_for(os.path.basename(p)))
    for p in sorted(glob.glob(os.path.join(TARGET, "out", "*.pdf")))
]

results = []
for name, path, reference in targets:
    # One capture window per file, around every in-process reader: MuPDF's errors
    # surface when a document is closed, which is after the call that caused them.
    with captured_stderr() as holder:
        gate = qpdf_gate(path)
        read = mupdf_read(path)
        pypdf = pypdf_read(path)
    complaints = notes_of(holder, path)
    poppler = poppler_read(path)
    # Ghostscript is asked for the file's own secret, the one the readers accepted,
    # so a zero page count means it could not reach the pages, not that it was shut out.
    secret = next((value for label, value in [("empty", ""), *SECRETS.items()] if label in (read.get("opens_with") or [])), "")
    gs = ghostscript_pages(path, secret)
    judgment = verdict_of(gate, read, complaints)

    summary = {
        "file": name,
        "made_from": reference["file"] if reference else "(fixture, the reference)",
        "gate": gate,
        "mupdf": {key: value for key, value in read.items() if key != "census"},
        "census": read["census"],
        "poppler": poppler,
        "pypdf": pypdf,
        "ghostscript": gs,
        "reader_complaints": clip(complaints, 400),
        "verdict": judgment,
    }
    if reference:
        before, after = reference["census"], read["census"] or {}
        summary["deltas"] = {
            key: f"{before.get(key)}→{after.get(key)}"
            for key in ("pages", "annots", "annots_entries", "fields", "field_values", "bookmarks", "attachments",
                        "planted_pages", "sheet_words", "text_chars", "ink_page1_percent")
            if before.get(key) != after.get(key)
        } or "none"
        # Objects a reader cannot see any more are a loss whether or not the pages
        # that remain still read, so they belong in the verdict too.
        if judgment.startswith("reads:") and summary["deltas"] != "none":
            lost = {key: value for key, value in summary["deltas"].items()
                    if key in ("annots", "annots_entries", "fields", "field_values", "bookmarks", "attachments")}
            if lost:
                judgment = f"partial-loss: every remaining page reads, but {json.dumps(lost, sort_keys=True, ensure_ascii=False)}"
        summary["verdict"] = judgment
    results.append(summary)

    print(f"\n--- {name}" + (f"   [made from {reference['file']}]" if reference else "   [fixture]"))
    line("qpdf gate", {k: v for k, v in gate.items() if k != "check_exit"})
    line("qpdf --check", f"exit {gate.get('check_exit')} {gate.get('check_error', '')}".strip())
    line("MuPDF", {**{k: v for k, v in read.items() if k != "census"},
                   "annots_entries": (read["census"] or {}).get("annots_entries")})
    line("census", read["census"])
    if reference:
        line("deltas", summary["deltas"])
    line("poppler", poppler)
    line("pypdf", pypdf)
    line("ghostscript", gs)
    line("complaints", complaints or "(none)")
    line("VERDICT", judgment)

with open(os.path.join(TARGET, "readers.json"), "w", encoding="utf-8") as handle:
    json.dump(results, handle, indent=1, sort_keys=True)

print(f"\n# readers.json written to {os.path.join(TARGET, 'readers.json')}")
print("\n# produced files, judged by readers that did not write them")
print("file | opens with | cipher the file claims | pages | planted | ink % | fields | bookmarks | attachments | verdict")
for item in results:
    if item["made_from"] == "(fixture, the reference)":
        continue
    census = item["census"] or {}
    cipher = item["gate"]["dictionary"].get("CFM") if isinstance(item["gate"]["dictionary"], dict) else item["gate"]["dictionary"]
    print(f"{item['file']} | {','.join(item['mupdf']['opens_with'])} | {json.dumps(cipher)} | "
          f"{census.get('pages')} | {census.get('planted_pages')} | {census.get('ink_page1_percent')} | "
          f"{census.get('fields')} | {census.get('bookmarks')} | {len(census.get('attachments') or [])} | "
          f"{clip(item['verdict'], 120)}")
