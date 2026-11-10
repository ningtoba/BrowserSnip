#!/usr/bin/env python3
"""Judgement by readers that share no code with this app, for `password-anywhere`.

`tests/pdf/password-anywhere.test.ts` rotates a locked file with the secret typed
where the file is listed — through `rotate`, a tool with no password field of its
own — and dumps what it produced when run as

    PASSWORD_ANYWHERE_ARTIFACTS=/tmp/pw-anywhere \\
      npx vitest run tests/pdf/password-anywhere.test.ts

This script asks the same questions of those bytes with MuPDF (PyMuPDF), libqpdf
(pikepdf) and poppler, and — because the only claim worth making is that the copy is
*the file it was, edited* — it asks them of the **source fixture** too and compares:

  secrets   which of {empty, hunter2, wrong} each reader accepts. MuPDF answers with
            its own authentication mask, so the copy is held to the source's mask for
            the same secret rather than to a reading of that mask invented here;
  pages     the page count each reader reports (3);
  text      the sentence planted on every sheet, and the word belonging to one sheet
            alone, per page — a page count that survives while the words go missing
            is the failure this campaign keeps meeting;
  rotate    each page's rotation, which is the edit the run was asked to make. The
            source must NOT already carry it, or the control proved nothing;
  lock      what `/Encrypt` still says about the copy (`/V`, `/R`, the filter `/StmF`
            selects and its `/CFM`, `/P`), libqpdf's own `check`, and poppler's
            `pdfinfo -enc` line;
  verdict   PASS only when the copy opens to the same secrets as its source, keeps
            three pages and their words, carries the rotation, still declares the
            cipher the source declared, and survives libqpdf's check.

Every probe runs in a fresh interpreter: a rejected password leaves a MuPDF document
unusable, and reopening the same file afterwards in the same process reads its pages
as empty — which would put "the words are gone" in the table for a reason that has
nothing to do with the bytes.

    python3 docs/research/password-anywhere-readers.py /tmp/pw-anywhere

The fixtures come from `tests/fixtures/encrypted/`, written by libqpdf and MuPDF and
never by this app — see that directory's README.
"""
import json
import os
import re
import subprocess
import sys

ARGS = sys.argv[1:]
TARGET = os.path.abspath(ARGS[1] if len(ARGS) > 2 and ARGS[0] == "--probe" else ARGS[0] if ARGS else "/tmp/pw-anywhere")  # noqa: S108 — the test's scratch dir, or the one file a probe child was given
HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.path.join(HERE, "..", "..", "tests", "fixtures", "encrypted")
PASSWORD = os.environ.get("PW_ANYWHERE_SECRET", "hunter2")  # noqa: S105 — the published secret of every fixture here
WRONG = "not-the-password"
SECRETS = ("", PASSWORD, WRONG)
PLANTED = "Lighthouse Inventory 1887"
SHEETS = ["ALPHA", "BRAVO", "CHARLIE"]
PAGES = 3
ROTATION = 90

# One file, one secret, one reader set, in a process that has seen none of them.
PROBE_CHILD = r"""
import json, sys
import pymupdf
path, secret = sys.argv[1], sys.argv[2]
try:
    doc = pymupdf.open(path)
except Exception as error:
    print(json.dumps({"opened": False, "why": "will not open: " + str(error)[:70]})); sys.exit(0)
try:
    level = doc.authenticate(secret) if doc.needs_pass else 2
    if not level:
        print(json.dumps({"opened": False, "level": 0, "needs_pass": True})); sys.exit(0)
    pages = []
    for index in range(doc.page_count):
        page = doc.load_page(index)
        text = page.get_text("text")
        joined = " ".join(text.split()) if isinstance(text, str) else ""
        words = %(planted)r in joined
        sheet = (%(sheets)r[index] in joined) if index < len(%(sheets)r) else False
        pages.append({"words": words, "sheet": sheet, "rotation": page.rotation})
    print(json.dumps({
        "opened": True, "level": level, "needs_pass": bool(doc.needs_pass),
        "pages": doc.page_count, "pages_detail": pages,
        "words": sum(1 for page in pages if page["words"]),
        "sheet_flags": [page["sheet"] for page in pages],
        "rotations": [page["rotation"] for page in pages],
        "permissions": doc.permissions,
    }))
except Exception as error:
    print(json.dumps({"opened": False, "why": str(error)[:70]}))
finally:
    doc.close()
"""


def child(code, *args):
    """Run a snippet in a fresh interpreter and read its JSON answer."""
    done = subprocess.run(
        [sys.executable, "-c", code, *args],
        capture_output=True, text=True, check=False, timeout=180, errors="replace",
    )
    try:
        return json.loads(done.stdout.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        return {"opened": False, "why": ("no answer: " + (done.stderr or done.stdout)[-90:])}


def mupdf_probe(path):
    """What MuPDF makes of one file, per secret, each in its own process."""
    code = PROBE_CHILD % {"planted": PLANTED, "sheets": SHEETS}
    return {secret: child(code, path, secret) for secret in SECRETS}


def qpdf_probe(path, secret):
    """libqpdf, through pikepdf: does it open, and what does its dictionary say."""
    code = r"""
import json, sys
import pikepdf
path, secret = sys.argv[1], sys.argv[2]
try:
    with pikepdf.open(path, password=secret) as pdf:
        out = {"opened": True, "pages": len(pdf.pages), "is_encrypted": bool(pdf.is_encrypted),
               "problems": [str(p) for p in pdf.check_pdf_syntax()]}
        entry = pdf.trailer.get("/Encrypt")
        if entry is not None:
            v = int(entry["/V"]) if "/V" in entry else 0
            r = int(entry["/R"]) if "/R" in entry else 0
            cfm = None
            if "/StmF" in entry and "/CF" in entry:
                name = str(entry["/StmF"])
                f = entry["/CF"].get(name if name.startswith("/") else "/" + name)
                if f is not None and "/CFM" in f:
                    cfm = str(f["/CFM"])
            out.update({"v": v, "r": r, "cfm": cfm,
                        "p": int(entry["/P"]) if "/P" in entry else None,
                        "census": "/V %d /R %d" % (v, r) + (" /CFM %s" % cfm if cfm else " (no crypt filter selected)")})
    print(json.dumps(out))
except Exception as error:
    print(json.dumps({"opened": False, "why": type(error).__name__ + ": " + str(error)[:80]}))
"""
    return child(code, path, secret)


def cli(cmd):
    """An external CLI; a missing tool is a stated answer, not a crash."""
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=180, errors="replace")
        return done.returncode, done.stdout, done.stderr
    except FileNotFoundError:
        return None, "", f"{cmd[0]} not installed"
    except subprocess.TimeoutExpired:
        return None, "", f"{cmd[0]} timed out"


def poppler_probe(path, secret):
    """poppler's third opinion: what it says the file is, and what it reads."""
    rc, enc, _ = cli(["pdfinfo", path])
    listed = " ".join(line.strip() for line in (enc or "").splitlines() if line.lower().startswith("encrypted"))
    rc, body, err = cli(["pdftotext", "-upw", secret, path, "-"])
    text = " ".join((body or "").split())
    return {
        "opens": rc == 0,
        "enc": listed,
        "words": PLANTED in text,
        "sheets": [word in text for word in SHEETS],
        "why": (err or "").strip()[:90],
    }


def probe(path):
    """Every reader's answer about one file, and the secret that opens it."""
    mu = mupdf_probe(path)
    secret = next((s for s in SECRETS if mu[s].get("opened")), PASSWORD)
    qpdf = qpdf_probe(path, secret)
    return {
        "mupdf": mu,
        "secret": secret,
        "qpdf": qpdf,
        "check": f"problems={len(qpdf.get('problems', []))} " + " | ".join(qpdf.get("problems", []))[:160]
        if qpdf.get("opened") else f"refused: {qpdf.get('why', '')}",
        "poppler": poppler_probe(path, secret),
    }


def describe(tag, view):
    lines = [f"  {tag}"]
    for secret in SECRETS:
        entry = view["mupdf"][secret]
        label = "(empty)" if secret == "" else secret
        lines.append(
            f"      {label:<18} opened={str(entry.get('opened')):<5} level={entry.get('level')} "
            f"pages={entry.get('pages')} words={entry.get('words')} sheets={entry.get('sheet_flags')} "
            f"rot={entry.get('rotations')} {entry.get('why', '')}"
        )
    q = view["qpdf"]
    lines.append(f"      libqpdf            opened={q.get('opened')} pages={q.get('pages')} "
                 f"encrypted={q.get('is_encrypted')} {q.get('census', 'no /Encrypt')} /P {q.get('p')} "
                 f"{q.get('why', '')}")
    p = view["poppler"]
    lines.append(f"      poppler            opens={p.get('opens')} words={p.get('words')} "
                 f"sheets={p.get('sheets')} {p.get('enc')} {p.get('why', '')}")
    lines.append(f"      libqpdf check      {view['check']}")
    return "\n".join(lines)


def judge(name):
    """One produced file against the outside-locked fixture it was made from."""
    source = re.sub(r"\.pdf\.rotated\.pdf$", "", name).replace("surface-route-", "")
    produced_path = os.path.join(TARGET, name)
    source_path = os.path.join(FIXTURES, f"{source}.pdf")
    if not os.path.exists(source_path):
        return False, [f"no fixture named {source}.pdf to compare against"], None, None
    produced, was = probe(produced_path), probe(source_path)

    reasons = []
    detail = produced["mupdf"][produced["secret"]]
    base = was["mupdf"][was["secret"]]
    if not detail.get("opened"):
        reasons.append("MuPDF opens the copy with none of the three secrets")
    if detail.get("pages") != PAGES:
        reasons.append(f"MuPDF counts {detail.get('pages')} pages, not {PAGES}")
    if detail.get("words") != PAGES:
        reasons.append(f"the planted sentence is on {detail.get('words')} of {PAGES} pages")
    if not all(detail.get("sheet_flags") or []):
        reasons.append(f"a sheet word is missing: {detail.get('sheet_flags')}")
    if detail.get("rotations") != [ROTATION] * PAGES:
        reasons.append(f"the copy's rotations are {detail.get('rotations')}, not {ROTATION} on every page")
    if base.get("rotations") == [ROTATION] * PAGES:
        reasons.append("the source already carried that rotation, so the control proved nothing")
    # The secrets have to be the same ones, or the copy is a different file's lock.
    if produced["secret"] != was["secret"]:
        reasons.append(f"the copy opens on {produced['secret']!r}, the source on {was['secret']!r}")
    for secret in SECRETS:
        mine, theirs = produced["mupdf"][secret], was["mupdf"][secret]
        if bool(mine.get("opened")) != bool(theirs.get("opened")):
            reasons.append(f"MuPDF {'accepts' if mine.get('opened') else 'refuses'} {secret!r} on the copy, "
                           f"{'accepts' if theirs.get('opened') else 'refuses'} it on the source")
        if mine.get("level") != theirs.get("level"):
            reasons.append(f"MuPDF's authentication mask for {secret!r} changed: "
                           f"{theirs.get('level')} on the source, {mine.get('level')} on the copy")
    if detail.get("permissions") != base.get("permissions"):
        reasons.append("/P means something different on the copy than it did on the source")
    if not produced["qpdf"].get("opened"):
        reasons.append(f"libqpdf will not open the copy with the source's secret: {produced['qpdf'].get('why', '')}")
    for field in ("v", "r", "cfm", "p"):
        if produced["qpdf"].get(field) != was["qpdf"].get(field):
            reasons.append(f"/Encrypt /{field.upper()} is {produced['qpdf'].get(field)}, "
                           f"the source said {was['qpdf'].get(field)}")
    if not produced["poppler"].get("opens") or not produced["poppler"].get("words"):
        reasons.append("poppler could not read the planted sentence out of the copy")
    if not produced["check"].startswith("problems=0"):
        reasons.append(f"libqpdf's own check: {produced['check'][:140]}")
    return not reasons, reasons, produced, was


def main():
    if len(ARGS) > 2 and ARGS[0] == "--probe":
        print(json.dumps(probe(os.path.abspath(ARGS[1])), indent=1))
        return 0
    files = sorted(f for f in os.listdir(TARGET) if f.endswith(".rotated.pdf"))
    if not files:
        print(f"no produced files in {TARGET}")
        return 1
    print("password-anywhere: files this app produced by rotating a locked PDF with the")
    print("secret typed where the file is listed — a tool (`rotate`) that has no password")
    print("field of its own — judged by MuPDF, libqpdf and poppler against the fixture.\n")
    print(f"secrets tried: (empty), {PASSWORD!r}, {WRONG!r}; planted {PLANTED!r}; sheet words {SHEETS}")
    print(f"expected: {PAGES} pages, each carrying its sentence and its sheet word, rotated {ROTATION}.\n")
    failures = 0
    for name in files:
        ok, reasons, produced, was = judge(name)
        print(f"{name:<60}  {'PASS' if ok else 'FAIL'}")
        if produced and was:
            print(describe("the copy:", produced))
            print(describe("the source fixture:", was))
        failures += 0 if ok else 1
        if not ok:
            print("    why: " + "; ".join(reasons))
        print()
    print(f"{len(files) - failures}/{len(files)} produced files are the file they came from, rotated")
    return 1 if failures else 0


if __name__ == "__main__":
    if len(ARGS) == 3 and ARGS[0] == "--mupdf":
        print(json.dumps(mupdf_probe(os.path.abspath(ARGS[1]))))
        sys.exit(0)
    sys.exit(main())
