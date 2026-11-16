#!/usr/bin/env python3
"""Judge what `extract-attachments` produced, per run, against the fixture's payload.

Round 062 harness. Each argument is a JSON written by
`docs/research/attachments-extract-probe.mjs`: the card's own sentence, the name
the browser would have saved under, and every blob the run created (base64).
Every byte the tool produced is SHA-256'd — for a ZIP, entry by entry — and
compared to the payload the fixture was built to carry (`MANIFEST.json`), never to
a name count. A run whose fixture carries no attachment must produce no blob and
a refusal sentence, so the instrument is proved on the empty case too.

    python3 docs/research/attachments-extract-check.py /tmp/r062/*.json

Exit status: 0 when every run agrees with its fixture, 1 otherwise. A name the
fixture does not carry is reported as `name=…` and fails, because a file that
arrives under a name the PDF does not hold is the same class of defect as a file
that does not arrive.
"""
import base64
import hashlib
import io
import json
import os
import re
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "..", "..", "tests", "fixtures", "attachments", "MANIFEST.json")
NO_FILES = "This PDF contains no embedded files."
FOUND = re.compile(r"Found (\d+) embedded file\(s\): (.*)\.")


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def flatten(name: str) -> str:
    """`sanitiseEntryName` in `core/archive.ts`, so a path name is judged flattened.

    A download attribute cannot carry `/`; the tool flattens the name the same way
    an archive entry is flattened, and this is that rule restated.
    """
    cleaned = re.sub(r"[/\\]+", "-", name)
    cleaned = re.sub(r'[<>:"|?*\x00-\x1f]', "", cleaned).lstrip(".").strip()
    return cleaned[:180] if cleaned else "file"


def load_manifest() -> dict:
    with open(MANIFEST, encoding="utf-8") as fh:
        return json.load(fh)


def source_payloads(fixture: str) -> dict:
    """The payloads the file itself holds, read by a reader that did not write it.

    A fixture outside the bank (`/tmp/triage/in/attach.pdf`) still has a right
    answer: the one MuPDF extracts from the untouched source, measured the same way.
    """
    import pymupdf  # noqa: PLC0415 — only needed for the out-of-bank fixtures

    with pymupdf.open(fixture) as doc:
        return {name: sha(doc.embfile_get(name)) for name in doc.embfile_names()}


def judge(path: str, manifest: dict) -> list[str]:
    """Every way this run disagrees with the fixture, as sentences; [] is a pass."""
    with open(path, encoding="utf-8") as fh:
        run = json.load(fh)
    source = run["pdf"]
    fixture = os.path.basename(source)
    expected = manifest.get(fixture, {}).get("payloads", {}) or source_payloads(source)
    wanted = set(expected.values())
    body = run.get("body", "")
    problems: list[str] = []
    blobs = [base64.b64decode(item["b64"]) for item in run.get("blobs", [])]
    names = [name for name in run.get("downloadNames", []) if name is not None]

    if not expected:
        # Control: nothing embedded. A refusal in words, no file, no download.
        if NO_FILES not in body:
            problems.append("no refusal sentence")
        if blobs:
            problems.append(f"{len(blobs)} blob(s) for a file with no attachment")
        if names:
            problems.append(f"download name(s) {names} for a file with no attachment")
        return problems

    if NO_FILES in body:
        problems.append(f"claimed no embedded files over {len(expected)} payload(s)")
    match = FOUND.search(body)
    counted = int(match.group(1)) if match else 0
    if counted != len(expected):
        problems.append(f"card counted {counted}, fixture carries {len(expected)}")

    # `downloadBlob` makes one blob and the pane one for the preview; identical
    # copies of one payload are one fact, not two files.
    if not blobs:
        problems.append("no file produced")
    produced: list[tuple[str, bytes]] = []
    for blob in blobs:
        if blob[:2] == b"PK":
            try:
                with zipfile.ZipFile(io.BytesIO(blob)) as archive:
                    produced = [(info.filename, archive.read(info)) for info in archive.infolist()]
            except zipfile.BadZipFile:
                problems.append("a blob starts with PK but is not an archive")
            break
    else:
        produced = [(names[0] if names else "", blob) for blob in blobs[:1]]

    if len(expected) == 1:
        out_names = set(names)
        if len(names) != 1:
            problems.append(f"one attachment produced {len(names)} download name(s): {names}")
        if names and names[0] in ("", None):
            problems.append("the download name is empty")
        got = {sha(blob) for blob in blobs}
        if wanted - got:
            problems.append("payload SHA-256 does not match the fixture")
        accepted = set(expected) | {flatten(name) for name in expected}
        if out_names - accepted:
            problems.append(f"name={sorted(out_names)} — the fixture's payloads are {sorted(expected)}")
    else:
        # Several: one entry per attachment, each under its own (unique) name, and
        # every payload present exactly once. `uniqueName` in the archive renames a
        # second copy of a name rather than dropping it.
        got = sorted(sha(data) for _, data in produced)
        if got != sorted(wanted):
            problems.append(f"archive payloads {got} != fixture {sorted(wanted)}")
        entry_names = [name for name, _ in produced]
        if len(entry_names) != len(set(entry_names)):
            problems.append(f"archive entry names are not unique: {entry_names}")
        if len(entry_names) != len(expected):
            problems.append(f"archive holds {len(entry_names)} entr(ies) for {len(expected)} attachment(s)")
        if len(names) != 1 or not names[0].endswith(".zip"):
            problems.append(f"a multi-file run downloaded {names}, not one archive")
    if len(expected) > 1 and len({sha(data) for _, data in produced}) < len(expected):
        problems.append("the same payload was written for two attachments")
    return problems


def main(argv: list[str]) -> int:
    manifest = load_manifest()
    bad = 0
    for path in argv:
        problems = judge(path, manifest)
        label = os.path.basename(path)
        if problems:
            bad += 1
            print(f"FAIL {label}: " + "; ".join(problems))
        else:
            print(f"ok   {label}")
    print(f"\n{len(argv) - bad}/{len(argv)} runs agree with their fixture")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
