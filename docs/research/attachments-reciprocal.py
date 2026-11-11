#!/usr/bin/env python3
"""Judge the bytes **this** app writes with readers that did not write them.

The mirror image of `scripts/attachments-foreign-fixtures.py`. A reader that only
accepts foreign files and a writer whose output only its own reader can read are
the same blindness in opposite directions, and `docs/TOOL-CAMPAIGN.md` has one of
each on the books (`protect`'s dictionary MuPDF refuses to open, `repair`'s single
blank sheet). So the two artifacts this pass produces are handed to MuPDF, pypdf
and poppler and the answer is compared with what the app claimed:

* `own-writer.pdf` — what `add-attachments` stores: two enclosures, one with an
  ASCII name and one whose name needs characters outside PDFDocEncoding, each
  carrying every byte value 0x00-0xFF.
* `own-removal.pdf` — what `edit-attachments` leaves after removing the enclosure
  in `tests/fixtures/attachments/mupdf-native.pdf`, a file MuPDF wrote. Removing a
  name so quietly that only this app's reader notices would be the same defect
  wearing the other hat.

Names are **reported, not compared**, beyond the one pypdf decodes per spec: a
reader may show `/UF` or `/F`, and MuPDF's Python binding hands back UTF-16BE text
misdecoded. What has to agree, and is asserted, is the number of enclosures and the
SHA-256 of every payload. It is a check, not a printout: any disagreement exits 1.

    python3 docs/research/attachments-reciprocal.py        # writes the log, or fails
    BROWSERSNIP_ATTACH_DUMP=docs/research/attachments-foreign \
        npx vitest run tests/pdf/attachments-foreign.test.ts   # regenerate the PDFs
"""
import hashlib
import os
import re
import subprocess
import sys
import tempfile

import pikepdf
import pymupdf
import pypdf

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DIR = os.path.join(REPO, "docs", "research", "attachments-foreign")
LOG = os.path.join(REPO, "docs", "research", "attachments-reciprocal.log")

PAYLOAD = bytes(range(256))
OTHER_PAYLOAD = bytes(255 - i for i in range(256))
ASCII_NAME = "own-writer.bin"
UNICODE_NAME = "über-𓂀.bin"
BASE = os.path.join(REPO, "tests", "fixtures", "attachments", "mupdf-native.pdf")

lines: list[str] = []
failures: list[str] = []


def note(text: str = "") -> None:
    lines.append(text)
    print(text)


def check(ok: bool, claim: str) -> None:
    note(f"    {'ok  ' if ok else 'FAIL'}  {claim}")
    if not ok:
        failures.append(claim)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def run(args: list[str]) -> str:
    """poppler prints the file's own bytes for a name, which is not always valid UTF-8."""
    out = subprocess.run(args, capture_output=True, check=False, timeout=120)
    return out.stdout.decode("utf-8", errors="replace") + out.stderr.decode("utf-8", errors="replace")


def poppler(path: str) -> list[tuple[str, str]]:
    """(name as poppler prints it, payload sha256) for every enclosure poppler saves out."""
    listing = run(["pdfdetach", "-list", path])
    tmp = tempfile.mkdtemp()
    found: list[tuple[str, str]] = []
    for line in listing.splitlines():
        if not re.match(r"^\s*\d+:", line):
            continue
        number, name = line.split(":", 1)
        target = os.path.join(tmp, f"{number.strip()}.bin")
        run(["pdfdetach", "-save", number.strip(), "-o", target, path])
        body = b""
        if os.path.exists(target):
            with open(target, "rb") as saved:
                body = saved.read()
        found.append((name.strip(), sha(body)))
    return found


def readers(path: str) -> dict[str, list[tuple[str, str]]]:
    """(name, payload sha256) per reader that shares no code with this repo."""
    out: dict[str, list[tuple[str, str]]] = {}

    doc = pymupdf.open(path)
    out["MuPDF 1.28.2"] = [(n, sha(doc.embfile_get(n))) for n in doc.embfile_names()]
    doc.close()

    try:
        got = pypdf.PdfReader(path).attachments
        out["pypdf 6.14.2"] = [
            (k.strip("/"), sha(v[0] if isinstance(v, list) else v)) for k, v in got.items()
        ]
    except Exception as exc:  # noqa: BLE001
        out["pypdf 6.14.2"] = [("error", f"{type(exc).__name__}: {exc}")]

    out["poppler 26.10.0"] = poppler(path)
    return out


def main() -> int:
    note("ATTACHMENTS — the reciprocal check: this app's own output, read by tools that")
    note("did not write it. Verifiers: libqpdf 12.3.2 (pikepdf 10.9.1), MuPDF 1.28.2 (PyMuPDF),")
    note("pypdf 6.14.2, poppler 26.10.0 `pdfdetach`. No `qpdf` or `mutool` binary on this box,")
    note("so this is four readers, not five.")
    note()

    writer = os.path.join(DIR, "own-writer.pdf")
    removal = os.path.join(DIR, "own-removal.pdf")
    for path in (writer, removal):
        if not os.path.exists(path):
            note(f"missing {path} — regenerate with:")
            note("  BROWSERSNIP_ATTACH_DUMP=docs/research/attachments-foreign \\")
            note("      npx vitest run tests/pdf/attachments-foreign.test.ts")
            return 2

    want = sha(PAYLOAD)
    note("== own-writer.pdf — the bytes `add-attachments` wrote")
    note(f"   payloads: {ASCII_NAME} sha256 {want}, {UNICODE_NAME} sha256 {sha(OTHER_PAYLOAD)}")
    note("   (every byte value 0x00-0xFF, and the same set reversed — a reader that handed")
    note("    one stream back for both names would pass a single-payload check)")
    for reader, found in readers(writer).items():
        note(f"   {reader}: {[(n, h[:12]) for n, h in found]}")
        check(len(found) == 2, f"{reader} lists both enclosures")
        check(sorted(h for _, h in found) == sorted([want, sha(OTHER_PAYLOAD)]),
              f"{reader} extracts both payloads byte for byte, and does not duplicate one")
        for name, h in found:
            if name == ASCII_NAME:
                check(h == want, f"{reader} returns the ASCII-named enclosure's own bytes")
    pypdf_names = [n for n, _ in readers(writer)["pypdf 6.14.2"]]
    check(sorted(pypdf_names) == sorted([ASCII_NAME, UNICODE_NAME]),
          f"pypdf reads the names as written, Unicode included: {pypdf_names}")

    # The fields this app claims to store, read back by libqpdf rather than by us.
    pdf = pikepdf.open(writer)
    specs = list(pdf.Root["/Names"]["/EmbeddedFiles"]["/Names"])[1::2]
    streams = [spec["/EF"]["/F"] for spec in specs]
    check(len(streams) == 2, f"libqpdf walks the tree to 2 embedded-file streams (found {len(streams)})")
    for index, stream in enumerate(streams):
        body = stream.read_bytes()
        want_body = want if index == 0 else sha(OTHER_PAYLOAD)
        check(sha(body) == want_body, f"libqpdf reads stream {index + 1} as the payload it stores")
        params = stream["/Params"]
        # /CheckSum is MD5 by definition (ISO 32000-1 §7.11.3), not a security choice.
        check(bytes(params["/CheckSum"]) == hashlib.md5(body, usedforsecurity=False).digest(),
              "/Params /CheckSum is the MD5 of the payload libqpdf read")
        check(int(params["/Size"]) == len(body) == 256, "/Params /Size matches those bytes")
    legacy = bytes(specs[1]["/F"])
    note(f"   what the legacy `/F` of the Unicode name holds: {legacy!r}. 𓂀 has no")
    note("   PDFDocEncoding byte, so pdf-lib writes `\\x0c\\x80` there and the UTF-16BE `/UF`")
    note("   beside it carries the real name — which is what pypdf lists above, while poppler")
    note("   prints `/F` and shows the substitution. Record, not fixed here: the bytes a user")
    note("   downloads come from `/UF`, and every reader above extracted them intact.")

    note("")
    note("== own-removal.pdf — the same enclosure removed by `edit-attachments`")
    for reader, found in readers(removal).items():
        note(f"   {reader}: {found}")
        check(found == [], f"{reader} agrees the file is gone")
    info = run(["pdfinfo", removal])
    pages = re.search(r"^Pages:\s+(\d+)", info, re.M)
    check(pages is not None and pages.group(1) == "3", f"poppler parses the re-saved file: {pages and pages.group(0)}")
    moved = pymupdf.open(removal)
    base = pymupdf.open(BASE)
    check(base.page_count == moved.page_count == 3, "removal cost no page")
    check(moved.embfile_names() == [], "MuPDF opens the copy and lists no attachment")

    note("")
    note(f"{len(failures)} disagreement(s) with the readers that did not write these bytes.")
    with open(LOG, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
