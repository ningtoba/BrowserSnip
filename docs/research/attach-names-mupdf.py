#!/usr/bin/env python3
"""One MuPDF verdict, in a process of its own.

    python3 docs/research/attach-names-mupdf.py <file.pdf> [<file.pdf> …]

PyMuPDF keeps a broken structure in the process-level error state: open a file whose
object stream is corrupt and the *next* `pymupdf.open()` in the same process can raise
`ValueError: bad xref` over a file that is fine — measured here, where
`into-dos-unix.pdf` opens with both enclosures alone and reports `bad xref` after a
corrupt case has been read. So each file is judged in a fresh interpreter, and the
result is one JSON object per line: page count, ink per sheet, and every attachment
as `{filename, ufilename, description, size, creationDate, modDate, sha256}` with
MuPDF's UTF-8-in-Latin-1 name decoding undone (the same mojibake
`docs/research/attachments-foreign-shapes.log` records for a file libqpdf wrote).
"""
import json
import subprocess
import sys

READER = """
import hashlib, json, sys, pymupdf
path = sys.argv[1]
out = {"file": path}
try:
    doc = pymupdf.open(path)
    out["opens"] = True
    out["pages"] = doc.page_count
    out["ink"] = [sum(1 for b in page.get_pixmap(dpi=72).samples if b < 250) for page in doc]
    out["text"] = [len(page.get_text()) for page in doc]
    files = []
    for i in range(doc.embfile_count()):
        info = doc.embfile_info(i)
        files.append({
            "index": i,
            "name": deutf(info.get("name")),
            "filename": deutf(info.get("filename")),
            "ufilename": deutf(info.get("ufilename")),
            "description": deutf(info.get("description")),
            "size": info.get("size"),
            "creationDate": info.get("creationDate"),
            "modDate": info.get("modDate"),
            "sha256": hashlib.sha256(doc.embfile_get(i)).hexdigest(),
        })
    out["files"] = files
    doc.close()
except Exception as exc:
    out["opens"] = False
    out["error"] = f"{type(exc).__name__}: {exc}"
print(json.dumps(out, ensure_ascii=False))
"""

PRELUDE = """
import hashlib, json, sys
def deutf(value):
    if value is None:
        return None
    text = str(value)
    try:
        return text.encode('latin-1').decode('utf-8')
    except (UnicodeEncodeError, UnicodeDecodeError):
        return text
"""


def read(path: str) -> dict:
    proc = subprocess.run(
        [sys.executable, "-c", PRELUDE + READER, path],
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    line = next((ln for ln in proc.stdout.splitlines() if ln.startswith("{")), None)
    if line is None:
        return {"file": path, "opens": False, "error": (proc.stderr or proc.stdout).strip()[:200]}
    return json.loads(line)


if __name__ == "__main__":
    for argument in sys.argv[1:]:
        print(json.dumps(read(argument), ensure_ascii=False))
