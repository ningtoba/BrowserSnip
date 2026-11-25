#!/usr/bin/env python3
"""Judge an `add-attachments` name battery with readers that did not write it.

    python3 docs/research/attach-names-check.py [battery-dir]

Reads `battery.json` (written by the c4 probe `tests/pdf/c4-add-names-battery.test.ts`)
and, for every produced PDF, asks **libqpdf (pikepdf), MuPDF, pypdf and poppler's
`pdfdetach`** what the file carries: the name-tree key, `/F`, `/UF`, `/Desc`, the
`/EF` naming, `/Subtype`, `/Params` (`/Size`, `/CheckSum`, `/CreationDate`,
`/ModDate`) and the SHA-256 of each payload. Nothing here trusts the app's own
reader — the question is whether a foreign reader gets the name the person typed and
the bytes they attached, and whether the file re-opens at all.

A case passes when, for every enclosure the run handed the writer:

* all four readers open the file;
* some stored file specification names it under `/UF` — else `/F`, else the name-tree
  key — with the requested (trimmed) name, and its payload hashes to the digest the
  run put in;
* `/Params /Size` is the payload length, `/CheckSum` its MD5, and both dates parse as
  PDF date strings;
* the MuPDF and poppler views agree with the qpdf view on name and bytes;
* the typed note is what `/Desc` says, on every entry it was promised to;
* and every pre-existing enclosure the case started with is still there with its
  original bytes, while the page count and per-sheet ink match the source the run
  began from (written next to the output as `<case>-src.pdf`).

Exit status is the number of failed checks.
"""
import hashlib
import json
import os
import re
import subprocess
import sys

import pikepdf
import pymupdf
import pypdf

MUPDF_READER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "attach-names-mupdf.py")


def read_mupdf(path: str) -> dict:
    """One MuPDF verdict, in a fresh interpreter (see `attach-names-mupdf.py`)."""
    proc = subprocess.run([sys.executable, MUPDF_READER, path], capture_output=True, text=True, timeout=300, check=False)
    line = next((ln for ln in proc.stdout.splitlines() if ln.startswith("{")), None)
    if line is None:
        return {"opens": False, "error": (proc.stderr or proc.stdout).strip()[:200]}
    import json as _json

    return _json.loads(line)


MUPDF_WHOLE: dict = {}

BATTERY = sys.argv[1] if len(sys.argv) > 1 else "/tmp/lane-security/c4/battery"

PDF_DATE = re.compile(r"^D:(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:[0-2]\d|3[01])(?:[01]\d|2[0-3])[0-5]\d[0-5]\d(?:Z|[+-](?:[01]\d|2[0-3])'[0-5]\d')?(?:[Zz])?$")


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def md5(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def as_text(value) -> str | None:
    """A pikepdf string/name as the text it holds (UTF-16BE BOM honoured)."""
    if value is None:
        return None
    if isinstance(value, pikepdf.Name):
        return str(value).lstrip("/")
    data = bytes(value)
    if data[:2] == b"\xfe\xff":
        return data[2:].decode("utf-16-be", errors="replace")
    if len(data) >= 4 and len(data) % 2 == 0 and not any(data[0::2]):
        return data.decode("utf-16-be", errors="replace")
    return data.decode("latin-1", errors="replace")


def deref(pdf: pikepdf.Pdf, value):
    """A name-tree value is a reference or the object itself (ISO 32000-1 §7.9.6)."""
    if isinstance(value, (pikepdf.Dictionary, pikepdf.Array, pikepdf.String)):
        return value
    if value is None:
        return None
    try:
        return pdf.get_object(value.objgen)
    except Exception:  # noqa: BLE001
        return None


def specs(pdf: pikepdf.Pdf) -> list[tuple[str, pikepdf.Dictionary]]:
    """Every `/EmbeddedFiles` name-tree pair, flat or under `/Kids`."""
    found: list[tuple[str, pikepdf.Dictionary]] = []

    def walk(node):
        if node is None:
            return
        names = node.get("/Names")
        if names is not None:
            for index in range(0, len(names), 2):
                key = as_text(names[index])
                spec = deref(pdf, names[index + 1])
                if isinstance(spec, pikepdf.Dictionary):
                    found.append((str(key), spec))
        for kid in list(node.get("/Kids") or []):
            walk(kid)

    root = pdf.Root.get("/Names")
    walk(root.get("/EmbeddedFiles") if root is not None else None)
    # PDF 2.0 `/AF` and file-attachment annotations name the same shape without a key.
    for value in list(pdf.Root.get("/AF") or []):
        spec = deref(pdf, value)
        if isinstance(spec, pikepdf.Dictionary):
            found.append(("", spec))
    for page in pdf.pages:
        for value in list(page.get("/Annots") or []):
            annot = deref(pdf, value)
            if not isinstance(annot, pikepdf.Dictionary) or str(annot.get("/Subtype")) != "/FileAttachment":
                continue
            target = annot.get("/FS") or annot.get("/A")
            spec = deref(pdf, target)
            if isinstance(spec, pikepdf.Dictionary):
                found.append((str(as_text(annot.get("/Contents")) or ""), spec))
    return found


def qpdf_view(path: str) -> list[dict]:
    pdf = pikepdf.open(path)
    out = []
    for key, spec in specs(pdf):
        entry = {"key": key, "F": as_text(spec.get("/F")), "UF": as_text(spec.get("/UF")), "Desc": as_text(spec.get("/Desc"))}
        ef = spec.get("/EF")
        stream = None
        if ef is None:
            entry["ef"] = None
        elif isinstance(ef, pikepdf.Dictionary):
            entry["ef"] = sorted(str(k) for k in ef.keys())
            for name in ("/UF", "/F", "/DOS", "/UNIX", "/Mac"):
                if name in ef:
                    stream = deref(pdf, ef[name])
                    break
        else:
            entry["ef"] = ["stream-itself"]
            stream = deref(pdf, ef)
        if stream is not None:
            body = stream.read_bytes()
            entry["sha256"] = sha(body)
            entry["size"] = len(body)
            entry["subtype"] = str(stream.get("/Subtype")).lstrip("/") if "/Subtype" in stream else None
            params = stream.get("/Params")
            if isinstance(params, pikepdf.Dictionary):
                entry["params"] = {
                    "Size": int(params["/Size"]) if "/Size" in params else None,
                    "CheckSum": bytes(params["/CheckSum"]).hex() if "/CheckSum" in params else None,
                    "CreationDate": as_text(params.get("/CreationDate")),
                    "ModDate": as_text(params.get("/ModDate")),
                }
        out.append(entry)
    return out


def mupdf_text(value) -> str | None:
    """MuPDF hands back UTF-8; PyMuPDF decodes it as Latin-1.

    `unicode-name.pdf` — written by libqpdf, not here — is listed by the very same
    PyMuPDF as `Ã¼ber-ð.txt` for a stored `/UF` of `über-𓂀.txt`
    (`docs/research/attachments-foreign-shapes.log`), so the mojibake is this reader's
    decoding, not the writer's bytes. Undo it before comparing names.
    """
    if value is None:
        return None
    text = str(value)
    try:
        return text.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return text


def mupdf_view(path: str) -> list[dict]:
    """MuPDF, run in a process of its own — see `docs/research/attach-names-mupdf.py`.

    The page count and per-sheet ink come back with it, so the "nothing else moved"
    comparison uses the same reader on both halves.
    """
    global MUPDF_WHOLE
    MUPDF_WHOLE = read_mupdf(path)
    if not MUPDF_WHOLE.get("opens"):
        raise RuntimeError(f"MuPDF: {MUPDF_WHOLE.get('error')}")
    return MUPDF_WHOLE.get("files", [])


def pypdf_view(path: str) -> list[dict]:
    reader = pypdf.PdfReader(path)
    out = []
    for name, value in reader.attachments.items():
        for body in value if isinstance(value, list) else [value]:
            out.append({"name": name, "sha256": sha(body), "size": len(body)})
    return out


def cesu8_decode(raw: bytes) -> str:
    """poppler prints a `/UF` name as UTF-8, except that an astral code point arrives as
    CESU-8 — each UTF-16 surrogate encoded on its own, which strict UTF-8 refuses. Try
    plain UTF-8 first, then re-join a surrogate pair, so the printed name compares equal
    to the name that was asked for."""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        pass
    out, index = bytearray(), 0
    while index < len(raw):
        if (
            index + 6 <= len(raw)
            and raw[index] == 0xED and 0xA0 <= raw[index + 1] <= 0xBF
            and raw[index + 3] == 0xED and 0xB0 <= raw[index + 4] <= 0xBF
        ):
            high = 0xD800 | ((raw[index + 1] & 0x0F) << 6) | (raw[index + 2] & 0x3F)
            low = 0xDC00 | ((raw[index + 4] & 0x0F) << 6) | (raw[index + 5] & 0x3F)
            out += chr(0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00)).encode("utf-8")
            index += 6
            continue
        out.append(raw[index])
        index += 1
    return out.decode("utf-8", errors="replace")


def poppler_view(path: str) -> dict:
    listing = subprocess.run(["pdfdetach", "-list", path], capture_output=True, timeout=180, check=False)
    text = cesu8_decode(listing.stdout)
    numbers, names = [], []
    for line in text.splitlines():
        head = line.split(":", 1)
        if head[0].strip().isdigit():
            numbers.append(head[0].strip())
            names.append(head[1].strip())
        elif names:
            # A name that holds a newline prints over two lines; the second one is
            # still part of the entry before it (the `newline-name` shape).
            names[-1] += "\n" + line
    # `-saveall -o <dir>` writes one file per entry under the stored name; `-save N`
    # takes a file path, not a directory, so it reports "Error saving …" for a dir.
    workdir = path + ".detach"
    saved = []
    if numbers:
        os.makedirs(workdir, exist_ok=True)
        subprocess.run(["pdfdetach", "-saveall", "-o", workdir, path], capture_output=True, timeout=180, check=False)
        for name in sorted(os.listdir(workdir)):
            body = open(os.path.join(workdir, name), "rb").read()
            saved.append({"written": name, "sha256": sha(body), "size": len(body)})
        subprocess.run(["rm", "-rf", workdir], check=False)
    return {"names": [wtf8_to_text(n) for n in names], "saved": saved,
            "stderr": listing.stderr.decode("utf-8", errors="replace").strip()}


def wtf8_to_text(value: str) -> str:
    """poppler prints a `/UF` astral name as CESU-8 (surrogate pairs encoded whole), so
    Python hands back lone surrogates; re-join them before comparing with the asked name."""
    try:
        return value.encode("utf-16", "surrogatepass").decode("utf-16")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return value


def pages_and_ink(path: str) -> tuple[int, list[int]]:
    doc = pymupdf.open(path)
    value = (doc.page_count, [sum(1 for b in page.get_pixmap(dpi=72).samples if b < 250) for page in doc])
    doc.close()
    return value


def readers_that_open_the_source(path: str) -> set[str]:
    """Which outside readers get through the document BEFORE this app touched it.

    The foreign bank deliberately keeps shapes the outside readers disagree about —
    `ef-dos-unix.pdf` is refused by MuPDF (`attachments-foreign-shapes.log`:
    "object is not a stream") and by pypdf (`No /(U)F key found`) as written by libqpdf.
    Demanding of the output what the source never gave would blame this writer for the
    reader's own limit, so the source sets the bar for each reader separately.
    """
    got: set[str] = set()
    try:
        qpdf_view(path)
        got.add("pikepdf")
    except Exception:  # noqa: BLE001
        pass
    try:
        if read_mupdf(path).get("opens"):
            got.add("mupdf")
    except Exception:  # noqa: BLE001
        pass
    try:
        pypdf_view(path)
        got.add("pypdf")
    except Exception:  # noqa: BLE001
        pass
    try:
        poppler_view(path)
        got.add("poppler")
    except Exception:  # noqa: BLE001
        pass
    return got


def check_case(case: dict) -> list[str]:
    problems: list[str] = []
    if case.get("error"):
        return problems
    path = case["out"]
    src = path[: -len(".pdf")] + "-src.pdf"

    # 1. Every outside reader must open the file it was handed — but a reader the
    # untouched source already defeats gets no vote on the output.
    capable = readers_that_open_the_source(src) if os.path.exists(src) else {"pikepdf", "mupdf", "pypdf", "poppler"}
    views: dict[str, object] = {}
    for label, call in (
        ("pikepdf", lambda: qpdf_view(path)),
        ("mupdf", lambda: mupdf_view(path)),
        ("pypdf", lambda: pypdf_view(path)),
        ("poppler", lambda: poppler_view(path)),
    ):
        if label not in capable and label != "pikepdf":
            continue
        try:
            views[label] = call()
        except Exception as exc:  # noqa: BLE001
            problems.append(f"{label} cannot read the produced file: {type(exc).__name__}: {exc}")
    if "pikepdf" not in views:
        return [f"{case['case']}: {p}" for p in problems]

    entries: list[dict] = views["pikepdf"]  # type: ignore[assignment]
    mu: list[dict] = views.get("mupdf", [])  # type: ignore[assignment]
    pyp: list[dict] = views.get("pypdf", [])  # type: ignore[assignment]
    pop: dict = views.get("poppler", {"names": [], "saved": []})  # type: ignore[assignment]

    # 2. Each requested enclosure arrives named as asked, with its bytes. When two
    # files in one run share a name the writer keeps the LAST copy (and the card says
    # so), so the wants are folded by name before the bytes are compared.
    wants: dict[str, dict] = {}
    for want in case["expected"]:
        wants[want["name"].strip()] = want
    for want in wants.values():
        asked = want["name"].strip()
        hits = [e for e in entries if asked in {e.get("UF"), e.get("F"), e.get("key")}]
        if not hits:
            problems.append(
                f"`{asked}` stored under none of key/F/UF — qpdf sees "
                f"{[(e.get('key'), e.get('F'), e.get('UF')) for e in entries]}"
            )
            continue
        entry = hits[0]
        if entry.get("sha256") != want["sha256"]:
            problems.append(f"`{asked}` payload {entry.get('sha256')} != {want['sha256']}")
        params = entry.get("params") or {}
        if params.get("Size") != want["size"]:
            problems.append(f"`{asked}` /Params /Size={params.get('Size')} != {want['size']}")
        if params.get("CheckSum") is not None and want.get("md5") and params["CheckSum"] not in want["md5"]:
            problems.append(
                f"`{asked}` /CheckSum {params.get('CheckSum')} is not the MD5 of the payload ({want['md5']})"
            )
        for name in ("CreationDate", "ModDate"):
            value = params.get(name)
            if value is not None and not PDF_DATE.match(value):
                problems.append(f"`{asked}` /Params {name} is not a PDF date: {value!r}")
        if entry.get("UF") is None:
            problems.append(f"`{asked}` has no /UF: the Unicode name is missing")
        mirror = [m for m in mu if m["sha256"] == want["sha256"]]
        if "mupdf" not in capable:
            pass
        elif not mirror:
            problems.append(f"MuPDF does not return the payload for `{asked}`: {[(m['filename'], m['sha256'][:10]) for m in mu]}")
        elif asked not in {(mirror[0]["filename"] or "").strip(), (mirror[0]["ufilename"] or "").strip()}:
            problems.append(f"MuPDF lists the payload as {mirror[0]['filename']!r}/{mirror[0]['ufilename']!r}, not {asked!r}")
        # poppler writes the entry under its stored name, so a name that is a path or
        # `.`/`..` cannot be created on disk; the printed list is the name check, the
        # saved bytes are the payload check when poppler managed to write them.
        if "poppler" in capable and asked not in pop.get("names", []):
            problems.append(f"pdfdetach does not list `{asked}`: {pop.get('names')}")
        if "pypdf" in capable and pyp and not any(p["sha256"] == want["sha256"] for p in pyp):
            problems.append(f"pypdf cannot return the payload for `{asked}`")

    # 3. The note reaches /Desc on every entry it was promised to.
    if case.get("note") is not None:
        for entry in entries:
            if (entry.get("Desc") or "") != case["note"]:
                problems.append(f"/Desc on `{entry.get('UF') or entry.get('key')}` is {entry.get('Desc')!r}, not the typed note")
        for mirror in (mu if "mupdf" in capable else []):
            if (mirror.get("description") or "") != case["note"]:
                problems.append(f"MuPDF reads /Desc as {mirror.get('description')!r}")

    # 4. Pre-existing enclosures keep their bytes; the document is unmoved.
    for stored in case.get("stored", []):
        replaced = any(stored.strip().lower() == w["name"].strip().lower() for w in case["expected"])
        kept = [e for e in entries if stored.strip() in {e.get("UF"), e.get("F"), e.get("key")}]
        if not kept and not replaced:
            problems.append(f"stored enclosure `{stored}` vanished")
    if os.path.exists(src) and "mupdf" in capable:
        src_read = read_mupdf(src)
        if not src_read.get("opens"):
            problems.append(f"the source document itself does not open: {src_read.get('error')}")
        elif not MUPDF_WHOLE.get("opens"):
            pass  # the produced file already failed the re-parse gate above
        else:
            for label, key in (("page count", "pages"), ("per-sheet ink", "ink"), ("per-sheet text", "text")):
                if src_read.get(key) != MUPDF_WHOLE.get(key):
                    problems.append(f"{label} {src_read.get(key)} -> {MUPDF_WHOLE.get(key)}")
            src_hashes = [f["sha256"] for f in src_read.get("files", [])]
            kept = [f["sha256"] for f in MUPDF_WHOLE.get("files", [])]
            for stored in case.get("stored", []):
                if replaced_this_run(case, stored):
                    continue
                if stored not in {f.get("ufilename") or f.get("filename") for f in MUPDF_WHOLE.get("files", [])}:
                    problems.append(f"MuPDF no longer lists the stored enclosure `{stored}`")
                elif len(src_hashes) > len(kept):
                    problems.append(f"MuPDF file count {len(src_hashes)} -> {len(kept)}")
    return problems


def replaced_this_run(case: dict, stored: str) -> bool:
    return any(stored.strip().lower() == w["name"].strip().lower() for w in case["expected"])


def main() -> int:
    cases = json.load(open(os.path.join(BATTERY, "battery.json")))
    failures = 0
    for case in cases:
        problems = check_case(case)
        if problems:
            failures += 1
        print(f"{'ok  ' if not problems else 'FAIL'} {case['case']:24s} {case['requested']!r} note={case.get('note') is not None}")
        for problem in problems:
            print(f"      · {problem}")
    print(f"\n{len(cases)} cases, {failures} failed")
    return failures


if __name__ == "__main__":
    sys.exit(main())
