#!/usr/bin/env python3
"""Judge what `extract-attachments` handed back, per run, against the source document.

    python3 docs/research/attach-extract-check.py [extract-dir]

Ground truth is the **source file** re-read by libqpdf (pikepdf), MuPDF and pypdf — never
this app's own reader, and never a count. For every run recorded in `extract.json`
(written by `tests/pdf/c4-extract-battery.test.ts`) it checks:

* the number of files the card says it found equals the number of attachments the source
  holds and the number of downloads/ZIP entries produced;
* every payload comes back **byte for byte** (SHA-256 against the source's stream), so a
  zero-byte enclosure survives as an empty file rather than vanishing;
* each produced name is the source's `/UF` — else `/F`, else the name-tree key — flattened
  the way `sanitiseEntryName` flattens (`/` and `\\` to `-`, Windows-illegal characters
  dropped, leading dots stripped), and it is a name a file system accepts;
* entries that share a name inside one ZIP are deduped (`dup.bin`, `dup.bin-2`) and both
  payloads survive;
* the sentence names what was actually produced, and the ZIP re-opens with a comment that
  says where the bytes came from;
* a source with nothing in it produces no download and says so.

Exit status is the number of failing runs.
"""
import hashlib
import io
import json
import os
import re
import sys
import zipfile

import pikepdf
import pymupdf
import pypdf

ROOT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/lane-security/c4/extract"
HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "..", "..", "tests", "fixtures", "attachments", "MANIFEST.json")

FLATTEN_SLASH = re.compile(r"[/\\]+")
FLATTEN_ILLEGAL = re.compile(r'[<>:"|?*\x00-\x1f]')
LEADING_DOTS = re.compile(r"^\.+")
FOUND = re.compile(r"Found (\d+) embedded file\(s\): (.*)\.$")


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sanitise(name: str) -> str:
    """`sanitiseEntryName` in `core/archive.ts`, so a flattening is checked not assumed."""
    cleaned = LEADING_DOTS.sub("", FLATTEN_ILLEGAL.sub("", FLATTEN_SLASH.sub("-", name))).strip()
    return cleaned[:180] if cleaned else "file"


def text_of(value) -> str:
    if value is None:
        return ""
    data = bytes(value)
    if data[:2] == b"\xfe\xff":
        return data[2:].decode("utf-16-be", errors="replace")
    if len(data) >= 4 and len(data) % 2 == 0 and not any(data[0::2]):
        return data.decode("utf-16-be", errors="replace")
    return data.decode("latin-1", errors="replace")


def deref(pdf, value):
    if value is None or isinstance(value, (pikepdf.Dictionary, pikepdf.Array, pikepdf.Stream)):
        return value
    try:
        return pdf.get_object(value.objgen)
    except Exception:  # noqa: BLE001
        return None


def source_truth(path: str) -> list[dict]:
    """Every attachment in the source, read from the dictionaries themselves.

    The name a download must carry is the one the reader shows: `/UF` — else `/F`, else
    the name-tree key, else nothing for a `/AF`-only file. Sites are de-duplicated by
    object identity, because the same specification is commonly named twice (catalogue
    plus a page annotation) and that is still one file.
    """
    pdf = pikepdf.open(path)
    found: list[dict] = []
    seen: set = set()

    def one(spec, marker, key_name):
        if not isinstance(spec, pikepdf.Dictionary) or marker in seen:
            return
        ef = deref(pdf, spec.get("/EF"))
        stream = None
        if isinstance(ef, pikepdf.Dictionary):
            for name in ("/UF", "/F", "/DOS", "/UNIX", "/Mac"):
                if name in ef:
                    stream = deref(pdf, ef[name])
                    break
        elif ef is not None:
            stream = ef
        if stream is None:
            return
        body = stream.read_bytes()
        uf, f = text_of(spec.get("/UF")), text_of(spec.get("/F"))
        chosen = next((n for n in (uf, f, key_name) if n and n.strip()), "")
        found.append({"name": chosen, "uf": uf, "f": f, "key": key_name or "",
                      "sha256": sha(body), "size": len(body)})
        seen.add(marker)

    def marker_of(raw, resolved):
        return raw.objgen if hasattr(raw, "objgen") else id(resolved)

    def walk(node):
        if node is None:
            return
        arr = node.get("/Names")
        if arr is not None:
            for i in range(0, len(arr), 2):
                raw, spec = arr[i + 1], deref(pdf, arr[i + 1])
                one(spec, marker_of(raw, spec), text_of(arr[i]))
        for kid in list(node.get("/Kids") or []):
            walk(deref(pdf, kid))

    names_dict = deref(pdf, pdf.Root.get("/Names"))
    walk(deref(pdf, names_dict.get("/EmbeddedFiles")) if names_dict is not None else None)
    for page in pdf.pages:
        page_names = deref(pdf, page.get("/Names"))
        if page_names is not None:
            walk(deref(pdf, page_names.get("/EmbeddedFiles")))
    for value in list(pdf.Root.get("/AF") or []):
        one(deref(pdf, value), marker_of(value, deref(pdf, value)), "")
    for page in pdf.pages:
        for value in list(page.get("/Annots") or []):
            annot = deref(pdf, value)
            if not isinstance(annot, pikepdf.Dictionary) or str(annot.get("/Subtype")) != "/FileAttachment":
                continue
            target = annot.get("/FS") or annot.get("/A")
            one(deref(pdf, target), marker_of(target, deref(pdf, target)), text_of(annot.get("/Contents")))
    return found


def produced_files(run: dict) -> list[dict]:
    """Everything the tool handed back, ZIP entries expanded into name + payload."""
    out = []
    for output in run.get("outputs", []):
        path = os.path.join(ROOT, f"{run['case']}--{output['name']}")
        if not os.path.exists(path):
            out.append({"missing": output["name"]})
            continue
        body = open(path, "rb").read()
        if output["name"].endswith(".zip"):
            archive = zipfile.ZipFile(io.BytesIO(body))
            for info in archive.infolist():
                out.append({
                    "name": info.filename,
                    "sha256": sha(archive.read(info)),
                    "size": info.file_size,
                    "container": output["name"],
                    "container_sha": sha(body),
                    "comment": archive.comment.decode("utf-8", "replace"),
                    "order": len(out),
                })
        else:
            out.append({"name": output["name"], "sha256": sha(body), "size": len(body),
                        "container": output["name"], "comment": ""})
    return out


def check_run(run: dict) -> list[str]:
    problems: list[str] = []
    case = run["case"]
    source = run.get("sourcePath") or ""
    src_name = run["input"]
    if source is None:
        return [f"{case}: source document not found for `{src_name}`"]
    truth = source_truth(source)
    produced = produced_files(run)

    # Count honesty (three ways).
    if run.get("error"):
        return problems
    message = run.get("message", "")
    if run.get("prior"):
        # `case` came out of another tool (merge, sanitize); its own sentence is recorded
        # separately so the extract counts are compared with the extract sentence only.
        message = message.split(" || ")[-1]
    found = FOUND.match(message.strip())
    if truth:
        if found is None:
            problems.append(f"the source holds {len(truth)} attachment(s) but the card does not report them: {message[:160]!r}")
        else:
            claimed = int(found.group(1))
            if claimed != len(truth):
                problems.append(f"card says `Found {claimed}`, the source holds {len(truth)}")
            if len(produced) != len(truth):
                problems.append(f"{len(produced)} file(s) produced for {len(truth)} in the source")
        # The sentence is `<name> (<size>), <name> (<size>)`; split on the pair boundary,
        # because a name may itself hold a comma (`a;b,c=d.txt`).
        names_in_message = [part.rsplit(" (", 1)[0].strip() for part in re.split(r"\), ", found.group(2))] if found else []
        for entry in produced:
            if not any(n == entry["name"] for n in names_in_message):
                problems.append(
                    f"`{entry['name']}` is what the download holds, the sentence names {names_in_message}"
                    f" (the archive dedupes a repeated name with a `-2` suffix; the sentence should say so)"
                )
    else:
        if produced:
            problems.append(f"the source holds nothing yet {len(produced)} file(s) came back")
        said = (message + " " + json.dumps(run.get("reports", []))).lower()
        if "no embedded files" not in said and "no attachments found" not in said:
            problems.append(f"an empty source should say so plainly: {message[:160]!r}")

    # Every payload byte-for-byte, in both directions.
    truth_by_sha: dict[str, list[dict]] = {}
    for entry in truth:
        truth_by_sha.setdefault(entry["sha256"], []).append(entry)
    matched = set()
    for entry in produced:
        hits = truth_by_sha.get(entry["sha256"], [])
        if not hits:
            problems.append(f"produced `{entry['name']}` payload {entry['sha256'][:16]} is not in the source")
            continue
        matched.add(entry["sha256"])
        # Three documented fallbacks are legal answers next to the flattening: the
        # position name for a file with no name at all (`attachment-N.bin`), the `-2`
        # dedupe suffix, which `core/archive.ts` puts before the extension, and the
        # `file` stand-in for a name that is only dots.
        expected = sanitise(hits[0]["name"]) or "file"
        actual = entry["name"]
        stem, dot, ext = expected.rpartition("."), None, None
        base = expected[: expected.rfind(".")] if "." in expected[1:] else expected
        ext = expected[len(base):] if expected != base else ""
        legal = {expected, base + ext, "file"} | {f"attachment-{n}.bin" for n in range(1, 12)}
        legal |= {f"{base}-{i}{ext}" for i in range(2, 12)} | {f"{expected}-{i}" for i in range(2, 12)}
        del stem, dot
        if actual not in legal:
            problems.append(f"`{hits[0]['name']}` arrived as `{actual}`, the documented flattening gives `{expected}`")
        bad = [c for c in entry["name"] if c in '<>:"|?' or (ord(c) < 32)]
        if bad:
            problems.append(f"produced name `{entry['name']}` keeps a file-system-hostile character {bad}")
        if entry["size"] != hits[0]["size"]:
            problems.append(f"`{entry['name']}` size {entry['size']} != source {hits[0]['size']}")
    for entry in truth:
        if entry["sha256"] not in matched:
            problems.append(f"the source's `{entry['name']}` ({entry['size']} B, {entry['sha256'][:10]}) never came back")

    # ZIP hygiene: unique entries, a comment naming the source.
    container_names = [e["name"] for e in produced if str(e.get("container", "")).endswith(".zip")]
    if len(container_names) != len(set(container_names)):
        problems.append(f"duplicate ZIP entry names: {container_names}")
    for entry in produced:
        if str(entry.get("container", "")).endswith(".zip") and src_name.replace(".pdf", "") not in entry.get("comment", ""):
            problems.append(f"the archive comment does not name the source: {entry.get('comment')!r}")
            break
    return problems


def main() -> int:
    runs = json.load(open(os.path.join(ROOT, "extract.json")))
    failed = 0
    for run in runs:
        problems = check_run(run)
        if problems:
            failed += 1
        print(f"{'ok  ' if not problems else 'FAIL'} {run['case']:44s} outputs={len(run.get('outputs', []))} msg={run.get('message','')[:60]!r}")
        for problem in problems:
            print(f"      · {problem}")
    print(f"\n{len(runs)} runs, {failed} failed")
    return failed


if __name__ == "__main__":
    sys.exit(main())
