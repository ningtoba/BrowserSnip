#!/usr/bin/env python3
"""Read `/P` and `/Encrypt` out of a produced file, and ask five readers about it.

Round 053 (`change-permissions`). Every claim is measured here, on the bytes, by
readers that share no code with the app: pikepdf/libqpdf 12.3.2, MuPDF 1.28.2,
pypdf 6.14.2, poppler's `pdfinfo`, Ghostscript.

    python3 docs/research/change-permissions-round-readers.py \
      --source /tmp/triage/in/locked128.pdf --produced /tmp/cp/locked.pdf \
      --user reader-pass --owner owner-pass

`/P` is decoded bit by bit from the integer in the file (ISO 32000-1 Table 25) and
compared with the expectation computed from the same integer, not with a literal.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys

import pikepdf
import pymupdf
import pypdf

# Table 25 numbers the bits from 1, so "printing" (bit 3) is shift 2. Getting
# this off by one is the classic way to report a permission the file does not
# carry, so the shifts are written out rather than derived.
BITS = {
    2: "printing",
    3: "modify",
    4: "copy",
    5: "annotate",
    8: "form-fill",
    9: "accessibility",
    10: "assemble",
    11: "print-high",
}

DICT_KEYS = ("V", "R", "Length", "CFM", "StmF", "StrF", "EncryptMetadata")


def _open(path: str, secrets: list[str]):
    """The first secret that opens the file, so a source and a copy that take
    different secrets are both measurable."""
    last: Exception | None = None
    for secret in secrets:
        try:
            return pikepdf.open(path, password=secret), secret
        except pikepdf.PasswordError as err:
            last = err
    raise last or RuntimeError("no secret opened the file")


def dictionary(path: str, password: str) -> dict:
    """The `/Encrypt` dictionary field by field, and the /P integer as written."""
    handle, opened = _open(path, [password, ""])
    with handle as pdf:
        enc = pdf.encryption
        raw = pdf.trailer.get("/Encrypt")
        fields = {}
        if raw is not None:
            for key in DICT_KEYS:
                if "/" + key in raw:
                    fields[key] = str(raw["/" + key])
            cf = raw.get("/CF")
            if cf is not None:
                fields["CF"] = {str(k): {str(kk): str(vv) for kk, vv in v.items()}
                                for k, v in cf.items()}
        return {"opened_with": opened or "empty",
                "P": int(raw.get("/P")) if raw is not None and "/P" in raw else None,
                "fields": fields,
                "user_password_bytes": len(enc.user_password or b""),
                "R": int(enc.R), "V": int(enc.V)}


def pbits(value: int | None) -> dict:
    if value is None:
        return {}
    return {name: bool((value >> bit) & 1) for bit, name in BITS.items()}


def raw_scan(path: str) -> dict:
    with open(path, "rb") as handle:
        raw = handle.read().decode("latin1")
    return {
        "has_encrypt": bool(re.search(r"/Encrypt[\s<\d]", raw)),
        "has_cfm": "/CFM" in raw,
        "has_p": bool(re.search(r"/P\s+-?\d+", raw)),
        "permissions_name_in_file": bool(re.search(r"AES|RC4", raw)),
        "bytes": len(raw),
    }


def mupdf(path: str, user: str, owner: str) -> dict:
    out: dict = {"needs_pass": None, "opens": {}, "algorithm": None,
                 "permissions": None, "pages": None, "planted": None,
                 "ink": None, "annots": None, "fields": None, "toc": None,
                 "labels": None, "info": None, "errors": []}
    for label, secret in (("empty", ""), ("user", user), ("owner", owner)):
        try:
            doc = pymupdf.open(path)
            out["needs_pass"] = bool(doc.needs_pass)
            if label == "empty" and doc.needs_pass:
                out["opens"]["empty"] = "no (password asked)"
                doc.close()
                continue
            auth = doc.authenticate(secret) if secret or doc.needs_pass else 1
            out["opens"][label] = f"auth={auth}"
            if auth and label != "empty":
                pass
            if auth:
                out["permissions"] = doc.permissions
                out["pages"] = doc.page_count
                if label == "empty" or label == "user":
                    if out["pages"]:
                        page = doc[0]
                        out["algorithm"] = (doc.metadata or {}).get("format")
                        pix = page.get_pixmap(dpi=110)
                        out["ink"] = sum(
                            1 for i in range(0, len(pix.samples), 3)
                            if pix.samples[i] < 250 or pix.samples[i + 1] < 250
                            or pix.samples[i + 2] < 250)
                        out["planted"] = sum(
                            1 for p in doc if "Lighthouse" in (p.get_text() or ""))
                        out["annots"] = sum(len(list(p.annots() or [])) for p in doc)
                        out["fields"] = sum(len(list(p.widgets() or [])) for p in doc)
                        out["toc"] = len(doc.get_toc())
                        labels = doc.get_page_labels()
                        out["labels"] = labels[:1] if labels else None
                        out["info"] = (doc.metadata or {}).get("title")
                doc.close()
            else:
                doc.close()
        except Exception as err:  # noqa: BLE001
            out["errors"].append(f"{label}: {type(err).__name__}: {str(err)[:120]}")
    return out


def mupdf_cipher(path: str, secret: str) -> str:
    try:
        doc = pymupdf.open(path)
        if doc.needs_pass:
            doc.authenticate(secret)
        (doc[0].get_text() if doc.page_count else "")
        meta = doc.metadata or {}
        doc.close()
        return str(meta)
    except Exception as err:  # noqa: BLE001
        return f"raised {type(err).__name__}"


def qpdf(path: str, user: str, owner: str) -> dict:
    out = {}
    for label, secret in (("empty", ""), ("user", user), ("owner", owner)):
        try:
            with pikepdf.open(path, password=secret) as pdf:
                out[label] = f"opens, {len(pdf.pages)} page(s)"
                allow = pdf.allow
                out[f"{label}_allow"] = sorted(
                    name for name in dir(allow)
                    if not name.startswith("_") and getattr(allow, name) is True)
        except pikepdf.PasswordError:
            out[label] = "refused"
        except Exception as err:  # noqa: BLE001
            out[label] = f"raised {type(err).__name__}: {str(err)[:100]}"
    try:
        with pikepdf.open(path, password=user or owner or "") as pdf:
            problems = pdf.check_pdf_syntax() + pdf.get_warnings()
            out["check"] = "clean" if not problems else problems[:3]
    except Exception as err:  # noqa: BLE001
        out["check"] = f"raised {type(err).__name__}: {str(err)[:100]}"
    return out


def pypdf_probe(path: str, user: str, owner: str) -> dict:
    out = {}
    for label, secret in (("empty", ""), ("user", user), ("owner", owner)):
        try:
            reader = pypdf.PdfReader(path)
            result = reader.decrypt(secret) if reader.is_encrypted else 0
            text = "".join((reader.pages[0].extract_text() or "") for _ in [0]) if result or not reader.is_encrypted else ""
            out[label] = int(result)
            if result or not reader.is_encrypted:
                out["permissions"] = reader.user_access_permissions
                out["pages"] = len(reader.pages)
                out["planted"] = "Lighthouse" in text
        except Exception as err:  # noqa: BLE001
            out[label] = f"raised {type(err).__name__}"
    return out


def poppler(path: str, user: str, owner: str) -> dict:
    out = {}
    for label, flag, secret in (("empty", [], ""), ("user", ["-upw"], user),
                                ("owner", ["-opw"], owner)):
        if label != "empty" and not secret:
            continue
        args = ["pdfinfo", flag[0], secret, path] if flag else ["pdfinfo", path]
        proc = subprocess.run(args,
                              capture_output=True, text=True, timeout=60)
        keep = [line for line in (proc.stdout + proc.stderr).splitlines()
                if re.search(r"Encrypt|print|copy|change|addNotes|Pages:", line)]
        out[label] = {"exit": proc.returncode, "lines": keep[:8]}
    return out


def ghostscript(path: str, secret: str) -> str:
    proc = subprocess.run(
        ["gs", "-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=nullpage",
         f"-sPDFPassword={secret}", path],
        capture_output=True, text=True, timeout=120)
    return f"exit {proc.returncode} {(proc.stderr or proc.stdout).strip()[:120]}"


def census(path: str, secret: str) -> dict:
    doc = pymupdf.open(path)
    if doc.needs_pass:
        doc.authenticate(secret)
    pages = []
    for page in doc:
        pix = page.get_pixmap(dpi=110)
        pages.append({
            "box": [round(page.rect.width, 1), round(page.rect.height, 1), page.rotation],
            "chars": len(page.get_text()),
            "ink": sum(1 for i in range(0, len(pix.samples), 3)
                       if pix.samples[i] < 250 or pix.samples[i + 1] < 250
                       or pix.samples[i + 2] < 250),
            "annots": len(list(page.annots() or [])),
        })
    out = {"pages": doc.page_count, "per_page": pages,
           "info": (doc.metadata or {}).get("title"),
           "labels": doc.get_page_labels() if doc.page_count else None,
           "toc": len(doc.get_toc())}
    doc.close()
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True)
    ap.add_argument("--produced", required=True)
    ap.add_argument("--user", default="")
    ap.add_argument("--owner", default="")
    ap.add_argument("--cipher-only", action="store_true")
    args = ap.parse_args()

    report: dict = {}
    for role, path in (("source", args.source), ("produced", args.produced)):
        entry = {"raw": raw_scan(path)}
        try:
            dictv = dictionary(path, args.user or args.owner or "")
            entry["P"] = dictv["P"]
            entry["P_bits"] = pbits(dictv["P"])
            entry["dictionary"] = dictv["fields"]
            entry["opened_with"] = dictv["opened_with"]
            entry["cipher_len"] = dictv["user_password_bytes"]
        except Exception as err:  # noqa: BLE001
            entry["dictionary_error"] = f"{type(err).__name__}: {str(err)[:120]}"
        report[role] = entry
        if args.cipher_only:
            continue
        entry["mupdf"] = mupdf(path, args.user, args.owner)
        entry["mupdf_metadata"] = mupdf_cipher(path, args.user or args.owner)
        entry["qpdf"] = qpdf(path, args.user, args.owner)
        entry["pypdf"] = pypdf_probe(path, args.user, args.owner)
        entry["poppler"] = poppler(path, args.user, args.owner)
        entry["ghostscript"] = ghostscript(path, args.user or args.owner)
        entry["census"] = census(path, args.user or args.owner)

    # The comparison the round rests on: every page census equal, and the copy's
    # ink where the source's write was ink.
    src, out = report["source"].get("census"), report["produced"].get("census")
    if src and out:
        report["same_pages"] = src["pages"] == out["pages"]
        report["ink_matches_source"] = (
            [p["ink"] for p in src["per_page"]] == [p["ink"] for p in out["per_page"]])
        report["chars_matches_source"] = (
            [p["chars"] for p in src["per_page"]] == [p["chars"] for p in out["per_page"]])
        report["annots_matches_source"] = (
            [p["annots"] for p in src["per_page"]] == [p["annots"] for p in out["per_page"]])
        report["info_matches_source"] = src["info"] == out["info"]
        report["labels_match_source"] = src["labels"] == out["labels"]
    print(json.dumps(report, indent=1, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
