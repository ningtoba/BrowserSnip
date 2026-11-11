#!/usr/bin/env python3
"""Do the attached files survive the trip, byte for byte?

  python3 docs/research/verify-attachments-read.py <attached.pdf> <hashes.txt>

Three readers that share no code with the writer each list the enclosures; every
result is hashed and compared with the `sha256` of the bytes that went in. Also
reported are the `/EmbeddedFile` dictionary's own claims — `/Params /CheckSum` (an
MD5 over the stored bytes, per the spec), `/Size`, `/Subtype`, `/UF` — plus `/AF`, and
what poppler's attachment list says.
"""
import hashlib
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

import fitz
import pikepdf
from pypdf import PdfReader

pdf_path = Path(sys.argv[1])
wanted: dict[str, tuple[str, int]] = {}
for line in Path(sys.argv[2]).read_text(encoding="utf8").splitlines():
    match = re.match(r"^([0-9a-f]{64})\s+(\d+)\s+(.*)$", line)
    if match:
        wanted[match.group(3)] = (match.group(1), int(match.group(2)))

print("targets:")
for name, (digest, size) in wanted.items():
    print(f"  {digest[:16]}… {size:>5}B  {name}")

found: dict[str, bytes] = {}
reader: Any = PdfReader(str(pdf_path))
try:
    for name, blobs in reader.attachments.items():
        for blob in blobs:
            found[name] = blob
    print(f"\npypdf lists {len(found)}: {list(found) or '(none)'}")
except Exception as error:  # noqa: BLE001 - an outsider's failure is the finding
    print(f"\npypdf raised {type(error).__name__}: {error}")

mupdf_names: dict[str, bytes] = {}
document: Any = fitz.open(pdf_path)
count = int(document.embfile_count())
print(f"MuPDF {fitz.version[0]}: embfile_count={count}")
for index, name in enumerate([str(n) for n in document.embfile_names()]):
    info = document.embfile_info(index)
    data = bytes(document.embfile_get(index))
    mupdf_names[name] = data
    print(f"  {name!r}: desc={info.get('descr')!r} declared size={info.get('size')} length={len(data)} "
          f"sha256={hashlib.sha256(data).hexdigest()[:16]}… mime={info.get('mime_type')!r}")
document.close()

entries: dict[str, bytes] = {}
with pikepdf.open(pdf_path) as handled:
    root: Any = handled.Root
    names = root.get("/Names")
    embedded = names.get("/EmbeddedFiles") if names is not None else None
    if embedded is not None:
        pairs = list(embedded.get("/Names") or [])
        for key, value in zip(pairs[0::2], pairs[1::2], strict=True):
            stream: Any = value
            # A names array may hold the stream itself or a file specification with
            # /EF; both are legal, and which one this is belongs in the report.
            wrapper = stream.get("/EF")
            kind = "raw stream"
            if wrapper is not None:
                inner = wrapper.get("/F") if hasattr(wrapper, "get") else None
                stream = inner if inner is not None else wrapper
                kind = "/EF file specification"
            body = bytes(stream.read_bytes())
            entries[str(key)] = body
            params = stream.get("/Params")
            print(f"  pikepdf {str(key)!r}: {len(body)}B via {kind} /Desc={stream.get('/Desc')!r} /Subtype={stream.get('/Subtype')} "
                  f"/UF={stream.get('/UF')} /Params /Size={params.get('/Size') if params is not None else None} "
                  f"/CheckSum={'yes' if params is not None and params.get('/CheckSum') is not None else 'no'} "
                  f"/CreationDate={params.get('/CreationDate') if params is not None else None}")
    listing = root.get("/AF")
    specs = list(embedded.get("/Names") or []) if embedded is not None else []
    for key, value in zip(specs[0::2], specs[1::2], strict=True):
        spec: Any = value
        print(f"  filespec {str(key)!r}: /UF={spec.get('/UF')!r} /F={spec.get('/F')!r} /AFRelationship={spec.get('/AFRelationship')!r} /Desc={spec.get('/Desc')!r}")
    print(f"  /AF: {[str(x) for x in listing] if listing is not None else 'none'}; "
          f"/Names keys: {[str(k) for k in (names.keys() if names is not None else [])]}")

print("\nper file, across the three readers:")
for name in sorted(set(found) | set(mupdf_names) | set(entries)):
    digests = {
        "pypdf": hashlib.sha256(found[name]).hexdigest() if name in found else None,
        "MuPDF": hashlib.sha256(mupdf_names[name]).hexdigest() if name in mupdf_names else None,
        "pikepdf": hashlib.sha256(entries[name]).hexdigest() if name in entries else None,
    }
    want = wanted.get(name, (None, None))[0]
    agree = len({value for value in digests.values() if value}) == 1
    verdict = "matches the input bytes" if want in digests.values() else "NO READER RETURNS THE INPUT BYTES"
    shown = {key: (value[:12] + "…" if value else "MISSING") for key, value in digests.items()}
    print(f"  {name}: {shown} · {'readers agree' if agree else 'READERS DISAGREE'} · {verdict}")
for name, (digest, size) in wanted.items():
    if name not in found and name not in mupdf_names and name not in entries:
        print(f"  {name}: MISSING FROM EVERY READER (was {size}B, sha256 {digest[:12]}…)")

poppler = subprocess.run(["pdfinfo", "-listattachments", str(pdf_path)], capture_output=True, text=True)
print(f"\npoppler `pdfinfo -listattachments`: exit={poppler.returncode}")
print("  " + "\n  ".join(line for line in poppler.stdout.splitlines() if line.strip())[:800])
if poppler.returncode != 0:
    print("  " + poppler.stderr.strip()[:200])
