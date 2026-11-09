#!/usr/bin/env python3
"""The `encrypted-inputs` ledger table, rendered from the two logs.

Reads `<dir>/app-claims.json` (what this app said, written by
`encrypted-inputs-rig.test.ts`) and `<dir>/readers.json` (what the bytes are,
written by `encrypted-inputs-readers.py`) and prints the two markdown tables the
row in `docs/TOOL-CAMPAIGN.md` carries — the belief table per fixture, and the
operation table per produced file.

Rendered rather than typed: a number copied out of a log is a number that can
disagree with its own log.

    python3 docs/research/encrypted-inputs-table.py /tmp/einp
"""
import json
import os
import re
import sys

TARGET = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "/tmp/einp")  # noqa: S108 — the rig's scratch dir

with open(os.path.join(TARGET, "manifest.json"), encoding="utf-8") as handle:
    MANIFEST = json.load(handle)
with open(os.path.join(TARGET, "app-claims.json"), encoding="utf-8") as handle:
    CLAIMS = json.load(handle)
with open(os.path.join(TARGET, "readers.json"), encoding="utf-8") as handle:
    READERS = json.load(handle)

PASSWORDS = MANIFEST["passwords"]
rows_by_fixture = {row["fixture"].split()[0]: row for row in CLAIMS}
by_file = {item["file"].split("/")[-1]: item for item in READERS}

FIELD = re.compile(r"^(\w[\w ]*?): (.*)$")


def field(row: dict, key: str, pattern: str, default: str = "—") -> str:
    """One value out of one probe line, by pattern — the transcript is the source."""
    text = row.get(key, "")
    match = re.search(pattern, text)
    return match.group(1) if match else default


def gate_column(row: dict, key: str) -> str:
    """`accepted/error` plus the sentence's shape, compressed to what it decided."""
    if not row.get(key):
        return "not measured"
    if row[key].startswith("throws"):
        return f"throws: {field(row, key, r'throws ([^·]+)')}"
    accepted = field(row, key, r"accepted=(\w+)")
    error = field(row, key, r"error=([^ ]+)")
    return f"accepted={accepted} error={error}"


print("## Table 1 — what this app believes about each locked file\n")
print("| file (maker · kind · cipher) | asks without a password (and the `/P` it decoded) | right password | owner password | wrong password |"
      " pages app/MuPDF | preview draws | thumbnail draws | engine's census vs MuPDF's |")
print("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
for fixture in MANIFEST["fixtures"] + [
    {"file": "base.pdf", "made_by": "MuPDF", "kind": "no-password (control)", "mupdf_cipher": "(none)",
     "census": MANIFEST["base"]["census"]},
    {"file": "own-protected.pdf", "made_by": "this app", "kind": "user-password",
     "mupdf_cipher": "None (the gate this app writes)", "census": MANIFEST["base"]["census"]}]:
    name = fixture["file"]
    row = rows_by_fixture.get(name)
    if not row:
        continue
    blind = row.get("gate: no password", "")
    perms = re.search(r"/P=(-?\d+)", blind)
    asks = ("yes — " + field(row, "gate: no password", r"error=(\w+)") + (f", /P={perms.group(1)}" if perms else "")) \
        if "needsPassword=true" in blind \
        else (f"no (opens); restricted, not locked; /P={perms.group(1)}" if "opensEmpty=true" in blind and perms
              else "no (opens)")
    preview_ops = field(row, "preview (pdf.js)", r"ops=(\d+)")
    preview_text = "text ok" if PASSWORDS and MANIFEST["planted"]["sentence"] in row.get("preview (pdf.js)", "") else "no text"
    draws = re.search(r"fill (\d+)", row.get("preview (pdf.js)", ""))
    thumb = re.search(r"draws: (.*)", row.get("thumbnail (core/render)", ""))
    engine = field(row, "census (engine)", r"fields=(\d+)")
    engine_bk = field(row, "census (engine)", r"bookmarks=(\d+)")
    engine_att = row.get("census (engine)", "")
    att = re.search(r"attachments=\[([^\]]*)\]", engine_att)
    truth = fixture.get("census") or {}
    cipher = fixture.get("mupdf_cipher") or field(row, "fixture", r"· ([^\]]+)\]")
    print(f"| `{name}` · {fixture['made_by']} · {fixture['kind']} · {cipher} | {asks} "
          f"| {gate_column(row, 'gate: user password')} | {gate_column(row, 'gate: owner password')} "
          f"| {gate_column(row, 'gate: wrong password')} "
          f"| {field(row, 'page count', r'app=(\S+)')} / {field(row, 'page count', r'MuPDF=(\S+)')} "
          f"| ops {preview_ops}, {preview_text}, fills {draws.group(1) if draws else '—'} "
          f"| {'yes' if thumb and 'fill' in thumb.group(1) else thumb.group(1) if thumb else '—'} "
          f"| fields {engine} / {truth.get('fields')}, bookmarks {engine_bk} / {truth.get('bookmarks')}, "
          f"attachments [{att.group(1) if att else ''}] / {truth.get('attachments')} |")

print("\n## Table 2 — the three routine operations, judged by readers that did not write the file\n")
print("| file | operation | the app says | MuPDF opens with | cipher the file claims | pages |"
      " planted pages | sheet 1 ink % | fields | bookmarks | attachments | verdict |")
print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
OPS = {"rotate": "rotate", "remove-pages": "delete page 2", "protect": "protect again"}
for row in CLAIMS:
    name = row["fixture"].split()[0]
    source = name.replace(".pdf", "")
    for op, label in OPS.items():
        produced = f"{source}--{op}.pdf"
        item = by_file.get(produced)
        probe = row.get(f"after {label}", "")
        if not item and not probe:
            continue
        if not item:
            print(f"| `{name}` | {label} | — | — | — | — | — | — | — | — | — | "
                  f"**no output: {field({'x': probe}, 'x', r'throws (.*)', probe)[:120]}** |")
            continue
        claims = field({"c": probe}, "c", r"claims ([^·]+)") or "(no claim recorded)"
        cipher = item["gate"]["dictionary"]
        cipher = cipher.get("CFM") if isinstance(cipher, dict) else cipher
        census = item["census"] or {}
        print(f"| `{name}` | {label} | {claims.strip()[:88]} | {','.join(item['mupdf']['opens_with'])} "
              f"| {json.dumps(cipher, ensure_ascii=False)} | {census.get('pages')} | {census.get('planted_pages')} "
              f"| {census.get('ink_page1_percent')} | {json.dumps(census.get('fields'), ensure_ascii=False)} "
              f"| {census.get('bookmarks')} | {len(census.get('attachments') or [])} "
              f"| {item['verdict'].split(';')[0]} |")

print("\n## Table 3 — what the outside readers say about the inputs themselves\n")
print("| file | qpdf | MuPDF needs pass | MuPDF opens with | poppler without a password | pypdf | Ghostscript |")
print("| --- | --- | --- | --- | --- | --- | --- |")
for fixture in MANIFEST["fixtures"]:
    item = by_file.get(fixture["file"])
    if not item:
        continue
    poppler = item["poppler"]["no password"]
    print(f"| `{fixture['file']}` | {json.dumps(item['gate']['is_encrypted'], sort_keys=True)} "
          f"| {item['mupdf']['needs_pass']} | {','.join(item['mupdf']['opens_with'])} "
          f"| pages={poppler['pages']} planted={poppler['planted']} err={poppler['err'][:60] or '(none)'} "
          f"| {json.dumps(item['pypdf'], sort_keys=True)[:110]} | {item['ghostscript'][:80]} |")
