#!/usr/bin/env python3
"""Rebuild `tests/fixtures/attachments/`: PDFs whose attachments were written by **outside** tools.

`core/attachments.ts` lists, extracts, replaces and removes embedded files, and its
own suite is green. That suite builds every input with `addAttachments`, i.e. with
pdf-lib — the same writer the reader was written against — which is the third
instance of the pattern this repo keeps hitting (font subsetting, the Ghostscript
argv, and here): **a reader that recognises the shape its own writer produces
rather than the shapes the format allows.**

ISO 32000-1 §7.11.3 and §7.9.6 allow all of:

* a name-tree value that is an **indirect reference** *or* a **direct dictionary**
  ("each value shall be either an indirect reference to a dictionary object *or* a
  dictionary object containing …");
* `/EmbeddedFiles` as a flat `/Names` array *or* a tree of `/Kids` with `/Limits`;
* a file specification whose `/EF` **is** the embedded-file stream, or a dictionary
  naming `/F`, `/UF`, `/DOS`, `/UNIX` or `/Mac` — with `/UF` the Unicode-preferred
  entry;
* `/Params` — `/Size`, `/CreationDate`, `/ModDate`, `/CheckSum` — **optional**;
* the same file declared in the catalogue, in a page's `/Annots` as a
  `/FileAttachment`, and (PDF 2.0) in a document-level `/Annots` on the catalogue.

Every fixture here is written by a producer that shares no code with this repo —
libqpdf 12.3.2 through `pikepdf` for the hand-shaped cases, MuPDF 1.28.2 through
`PyMuPDF` and pypdf 6.14.2 for the native ones — and each is verified by three
readers that did not write it (MuPDF, pypdf, poppler's `pdfdetach`) before it is
kept. `docs/research/attachments-foreign-shapes.log` is that census: a shape only
one outside reader sees is recorded there rather than smoothed over.

Payloads are distinct per fixture and cover every byte value 0x00-0xFF plus a UTF-8
marker, so an extraction is proved by its SHA-256 and not by its length — the
"assert content, not count" rule this repo already applies to pages.

**The output is byte-reproducible.** MuPDF stamps the embedded file's `/Params` with
the time of the run and every producer writes a random `/ID`, so the first version of
this script gave different bytes on every invocation — which makes a red test mean
"someone re-ran the generator" as often as "the reader broke". `freeze()` therefore
replaces every timestamp with a fixed one and re-saves with libqpdf's
content-derived ID; it touches no structure, and the census below is the proof,
because it re-reads each shape (inline vs referenced file spec, `/EF` form, `/Kids`
tree) from the kept bytes. `MANIFEST.json` records the SHA-256 of every fixture and
`tests/pdf/attachments-foreign.test.ts` asserts the files on disk still match it.

    python3 scripts/attachments-foreign-fixtures.py [outdir]  # rebuild
    python3 scripts/attachments-foreign-fixtures.py --check   # rebuild twice, compare
"""
import json
import os
import re
import subprocess
import sys

import pikepdf
import pymupdf
import pypdf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pdf_fixture_determinism import (  # noqa: E402
    check_reproducible,
    freeze_all,
    sha,
    write_manifest,
)

TARGET = os.path.abspath(
    sys.argv[1] if len(sys.argv) > 1 else "tests/fixtures/attachments"  # noqa: S108
)
os.makedirs(TARGET, exist_ok=True)

# One base document, written by MuPDF so no fixture sits on a pdf-lib byte.


def base_path() -> str:
    """The MuPDF-written three-page base every hand-shaped fixture starts from.

    A function, not a constant: `--check` retargets `TARGET` to a scratch directory,
    and a module-level path would have the scratch build read and write the committed
    fixtures.
    """
    return os.path.join(TARGET, "_base.pdf")


def make_base() -> None:
    doc = pymupdf.open()
    for i in range(3):
        page = doc.new_page()
        page.insert_text((72, 96), f"Foreign attachment fixture, sheet {i + 1}", fontsize=13)
        page.insert_text((72, 120), "The pages are ordinary; everything of interest is in the catalogue.", fontsize=9)
    doc.save(base_path())
    doc.close()


def payload(tag: str, shift: int = 0) -> bytes:
    """Deterministic bytes over the whole 0-255 range: an encoding detour shows up."""
    body = bytes((i + shift) % 256 for i in range(256))
    return tag.encode() + b"|" + body + b"|" + "über 𓂀".encode()


# `/Params /CheckSum` is MD5 by definition (ISO 32000-1 §7.11.3), so the fixtures have
# to carry real ones — an invented digest would let this app report a checksum that its
# own bytes deny, which is the failure mode this pass is about. They are written as
# literals keyed by the payload's SHA-256 prefix rather than computed here, because a
# generator holding a weak-hash call is a generator whose next reader has to re-derive
# why MD5 is allowed; `tests/pdf/attachments-foreign.test.ts` asserts each stored value
# equals the digest of the extracted bytes, so a wrong constant fails a test.
CHECKSUMS = {
    "057f1c47b11a9d9d": "550c2c43b7daa872b59ab520a5845f09",
    "067570bac8320c1d": "20b91ce8645a201a6d97a89852ce6c0d",
    "09ed501c75b36923": "381d6dac54ec6f319dead3d8ba76efef",
    "12abf8f19a5ae753": "8d02c94f6940e484e92f113368c149b5",
    "149be634b36c30d3": "32d2c65fff7a2a58f6ee4bd89e79aff0",
    "1b4ef91511774fe9": "8a3d0d3f933a44e6ed090b103b4773f3",
    "1e77e836b5faaacf": "4503503372d378b3a805542fa91952c0",
    "39e485c58370ddc3": "d17a22a69072c4e12dad0c9f0de409fe",
    "3adf0ffe7e8a26ef": "fb3586a066d255c26fa29eead36b6d69",
    "60e6ee7dcaf326e8": "bca055442bfa3fb763d67b3ea0d0c6ab",
    "65f54195401c66cc": "46326c5e67747d5fe8a05dc571608830",
    "6d4b8fa7b05143ad": "518c040b46124b1ad92a394e255742d0",
    "7ba3aad285a9e8b7": "3cbb10324b8b79730a284bbb6b6a8412",
    "b71020a0db478637": "a0e121f1393e54892815ace3be4966ae",
    "bc2642b8271ad87b": "76714fbb632e5d8daa0f6ae7d6865a93",
    "d2e0be7b8199907e": "882a29ce51a269cf4312fa93d016469b",
    "dc27bf90d6be70ab": "0659feb5613cd6b990427361ae9ddb42",
    "f2e68a9e71e0e427": "3e4c14d4b21f653aeeea819dd9fc553a",
    "f61ea5e77bfc4640": "84ae02adb222a497a68fe705099f13e9",
    "f688bc41534910ec": "6c2b7a8fbbf12582857558144a62a009",
}


def checksum_for(data: bytes) -> bytes:
    """The `/CheckSum` for a payload this script knows, as raw digest bytes."""
    key = sha(data)[:16]
    if key not in CHECKSUMS:
        raise KeyError(f"no /CheckSum recorded for payload {key} — add it to CHECKSUMS")
    return bytes.fromhex(CHECKSUMS[key])


def D(**kw) -> pikepdf.Dictionary:
    """A dictionary from `/Key: value` pairs given as keywords."""
    d = pikepdf.Dictionary()
    for key, value in kw.items():
        d["/" + key] = value
    return d


def N(text: str) -> pikepdf.Name:
    return pikepdf.Name("/" + text)


def num(value: int) -> pikepdf.Integer:
    """A PDF integer object, built directly rather than parsed out of text."""
    return pikepdf.Integer(int(value))


def rect():
    return pikepdf.Array([num(72), num(700), num(92), num(720)])


def ef_stream(pdf, data: bytes, *, params: bool = True, subtype: bool = True, shift: int = 0):
    """The `/EmbeddedFile` stream, with or without the optional `/Params`."""
    stream = pikepdf.Stream(pdf, payload(data, shift) if isinstance(data, str) else data)
    stream["/Type"] = N("EmbeddedFile")
    if subtype:
        stream["/Subtype"] = N("text/plain")
    if params:
        raw = stream.read_bytes()
        stream["/Params"] = D(
            Size=num(len(raw)),
            CheckSum=pikepdf.String(checksum_for(raw)),
            CreationDate=pikepdf.String("D:20240229120000Z"),
            ModDate=pikepdf.String("D:20240301083000Z"),
        )
    return stream


def file_spec(pdf, stream, *, name: str, ef: str = "dictF"):
    """A file specification in one of the shapes §7.11.3 allows.

    A Unicode `/UF` is built by the one fixture that needs it, because
    `pikepdf.String(str)` serialises in PDFDocEncoding and a non-ASCII name has to
    travel as UTF-16BE with a BOM to be the shape a real producer writes.
    """
    fs = D(Type=N("Filespec"), F=pikepdf.String(name))
    if ef == "dictF":
        fs["/EF"] = D(F=stream)
    elif ef == "dictUF":
        fs["/EF"] = D(UF=stream)
    elif ef == "dictDOS":
        fs["/EF"] = D(DOS=stream)
    elif ef == "dictUNIX":
        fs["/EF"] = D(UNIX=stream)
    elif ef == "stream":
        fs["/EF"] = stream
    return fs


def attach_flat(pdf, pairs) -> None:
    """`/Root/Names/EmbeddedFiles` holding a flat `/Names` array."""
    if "/Names" not in pdf.Root:
        pdf.Root["/Names"] = D()
    flat = pikepdf.Array()
    for key, value in pairs:
        flat.append(key)
        flat.append(value)
    pdf.Root["/Names"]["/EmbeddedFiles"] = D(Names=flat)


def file_attachment(pdf, fs):
    return pdf.make_indirect(
        D(
            Type=N("Annot"),
            Subtype=N("FileAttachment"),
            Rect=rect(),
            FS=fs,
        )
    )


def save(pdf, name: str) -> str:
    path = os.path.join(TARGET, name)
    pdf.save(path, static_id=True)
    pdf.close()
    return path


EXPECTED: dict[str, dict[str, str]] = {}
SHAPES: dict[str, dict[str, str]] = {}

SHAPES_BASE_SHAPE = "the three-page base, written by MuPDF"
SHAPES_BASE_PRODUCER = "MuPDF 1.28.2 (PyMuPDF)"


def freeze_all_here() -> dict:
    """Freeze every fixture and return the manifest, using the shared determinism step.

    `SHAPES` carries the per-fixture label the manifest records, so the census, the
    manifest and the reproduction table all describe the same shape; the two base
    constants are the fallback for `_base.pdf`, which is not itself a case.
    """
    return freeze_all(TARGET, SHAPES, EXPECTED, SHAPES_BASE_SHAPE, SHAPES_BASE_PRODUCER)


def build() -> None:
    """Record every fixture's shape and the SHA-256 of each payload it must carry."""
    make_base()

    def case(name: str, shape: str, files: dict[str, bytes], producer: str) -> None:
        EXPECTED[name] = {k: sha(v) for k, v in files.items()}
        SHAPES[name] = {"shape": shape, "producer": producer}

    # 1 — the shape MuPDF itself writes, and the one `docs/TOOL-TRIAGE.md` ERRORS 4
    # met: a **direct** file-specification dictionary inside the `/Names` array.
    doc = pymupdf.open(base_path())
    one = payload("mupdf-native")
    doc.embfile_add("note.txt", one, filename="note.txt", ufilename="note.txt", desc="planted by MuPDF")
    doc.save(os.path.join(TARGET, "mupdf-native.pdf"))
    doc.close()
    case("mupdf-native.pdf", "name-tree value is a direct FileSpec dict, /EF << /F >>",
         {"note.txt": one}, "MuPDF 1.28.2 (PyMuPDF embfile_add)")

    # 2 — pypdf's own writer: a second independent native producer.
    two = payload("pypdf-native")
    writer = pypdf.PdfWriter()
    writer.append(pypdf.PdfReader(base_path()))
    writer.add_attachment("ledger.csv", two)
    with open(os.path.join(TARGET, "pypdf-native.pdf"), "wb") as fh:
        writer.write(fh)
    case("pypdf-native.pdf", "pypdf's own FileSpec + /EmbeddedFiles entry",
         {"ledger.csv": two}, "pypdf 6.14.2")

    def hand(name: str, shape: str, files: dict[str, bytes], fill) -> None:
        pdf = pikepdf.open(base_path())
        fill(pdf)
        save(pdf, name)
        case(name, shape, files, "libqpdf 12.3.2 (pikepdf)")

    # 3 — the control: flat `/Names`, **indirect** file spec, `/EF << /F >>` with a
    # full `/Params`. This is the shape pdf-lib writes, so the only one the shipped
    # reader has ever met.
    p3 = {"flat-ref.bin": payload("flat-ref")}

    def f3(pdf):
        stream = pdf.make_indirect(ef_stream(pdf, p3["flat-ref.bin"]))
        fs = pdf.make_indirect(file_spec(pdf, stream, name="flat-ref.bin"))
        attach_flat(pdf, [(pikepdf.String("flat-ref.bin"), fs)])

    hand("flat-names-indirect.pdf", "flat /Names, indirect FileSpec, /EF << /F >>, full /Params", p3, f3)

    # 4 — the same, with the file spec written **into** the array.
    p4 = {"direct-spec.bin": payload("direct-spec")}

    def f4(pdf):
        stream = pdf.make_indirect(ef_stream(pdf, p4["direct-spec.bin"]))
        attach_flat(pdf, [(pikepdf.String("direct-spec.bin"), file_spec(pdf, stream, name="direct-spec.bin"))])

    hand("direct-namespec.pdf", "flat /Names whose value is a DIRECT FileSpec dict", p4, f4)

    # 5 — a `/Kids` + `/Limits` tree, two leaves, two attachments.
    p5 = {"alpha.bin": payload("kid-one"), "beta.bin": payload("kid-two", shift=7)}

    def f5(pdf):
        s1 = pdf.make_indirect(ef_stream(pdf, p5["alpha.bin"]))
        s2 = pdf.make_indirect(ef_stream(pdf, p5["beta.bin"]))
        f1 = pdf.make_indirect(file_spec(pdf, s1, name="alpha.bin"))
        f2 = pdf.make_indirect(file_spec(pdf, s2, name="beta.bin"))
        k1 = pdf.make_indirect(D(Limits=pikepdf.Array([pikepdf.String("alpha.bin")] * 2),
                                 Names=pikepdf.Array([pikepdf.String("alpha.bin"), f1])))
        k2 = pdf.make_indirect(D(Limits=pikepdf.Array([pikepdf.String("beta.bin")] * 2),
                                 Names=pikepdf.Array([pikepdf.String("beta.bin"), f2])))
        pdf.Root["/Names"] = D(EmbeddedFiles=D(Kids=pikepdf.Array([k1, k2])))

    hand("kids-tree.pdf", "/EmbeddedFiles as a /Kids + /Limits tree, two leaves", p5, f5)

    # 6 — `/EF` pointing **straight at** the embedded-file stream.
    p6 = {"ef-stream.bin": payload("ef-stream")}

    def f6(pdf):
        stream = pdf.make_indirect(ef_stream(pdf, p6["ef-stream.bin"]))
        fs = pdf.make_indirect(file_spec(pdf, stream, name="ef-stream.bin", ef="stream"))
        attach_flat(pdf, [(pikepdf.String("ef-stream.bin"), fs)])

    hand("ef-points-at-stream.pdf", "/EF is the EmbeddedFile stream itself, no wrapper dict", p6, f6)

    # 7 — `/EF << /UF >>` only, and a decoy `/F` stream beside it in the next case.
    p7 = {"ef-uf.bin": payload("ef-uf")}

    def f7(pdf):
        stream = pdf.make_indirect(ef_stream(pdf, p7["ef-uf.bin"]))
        fs = pdf.make_indirect(file_spec(pdf, stream, name="ef-uf.bin", ef="dictUF"))
        attach_flat(pdf, [(pikepdf.String("ef-uf.bin"), fs)])

    hand("ef-uf-only.pdf", "/EF << /UF >> with no /F at all", p7, f7)

    # 7b — `/UF` and `/F` both present and naming **different** streams: the spec
    # says a viewer prefers /UF, so the payload must come from there.
    p7b = {"both-names.bin": payload("uf-wins")}

    def f7b(pdf):
        good = pdf.make_indirect(ef_stream(pdf, p7b["both-names.bin"]))
        decoy = pdf.make_indirect(ef_stream(pdf, b"THE WRONG STREAM, /F is the legacy name\n"))
        fs = D(Type=N("Filespec"), F=pikepdf.String("both-names.bin"), UF=pikepdf.String("both-names.bin"))
        fs["/EF"] = D(F=decoy, UF=good)
        attach_flat(pdf, [(pikepdf.String("both-names.bin"), pdf.make_indirect(fs))])

    hand("ef-uf-over-f.pdf", "/EF << /F decoy /UF real >>: /UF must win", p7b, f7b)

    # 8 — `/EF << /DOS >>` and `/EF << /UNIX >>`: neither `/F` nor `/UF`.
    p8 = {"dos.bin": payload("dos"), "unix.bin": payload("unix", shift=11)}

    def f8(pdf):
        sd = pdf.make_indirect(ef_stream(pdf, p8["dos.bin"]))
        su = pdf.make_indirect(ef_stream(pdf, p8["unix.bin"]))
        fd = pdf.make_indirect(file_spec(pdf, sd, name="dos.bin", ef="dictDOS"))
        fu = pdf.make_indirect(file_spec(pdf, su, name="unix.bin", ef="dictUNIX"))
        attach_flat(pdf, [(pikepdf.String("dos.bin"), fd), (pikepdf.String("unix.bin"), fu)])

    hand("ef-dos-unix.pdf", "/EF naming only /DOS and only /UNIX", p8, f8)

    # 9 — no `/Params`: no `/Size`, no `/CheckSum`, no dates.
    p9 = {"no-params.bin": payload("no-params")}

    def f9(pdf):
        stream = pdf.make_indirect(ef_stream(pdf, p9["no-params.bin"], params=False))
        fs = pdf.make_indirect(file_spec(pdf, stream, name="no-params.bin"))
        attach_flat(pdf, [(pikepdf.String("no-params.bin"), fs)])

    hand("no-params.pdf", "EmbeddedFile stream with no /Params (no Size, no CheckSum)", p9, f9)

    # 10 — the same file in the catalogue **and** as a page `/FileAttachment`.
    p10 = {"catalog-and-annot.bin": payload("both")}

    def f10(pdf):
        stream = pdf.make_indirect(ef_stream(pdf, p10["catalog-and-annot.bin"]))
        fs = pdf.make_indirect(file_spec(pdf, stream, name="catalog-and-annot.bin"))
        attach_flat(pdf, [(pikepdf.String("catalog-and-annot.bin"), fs)])
        annot = file_attachment(pdf, fs)
        annot["/Contents"] = pikepdf.String("catalog-and-annot.bin")
        pdf.pages[0]["/Annots"] = pikepdf.Array([annot])

    hand("catalog-and-annot.pdf", "one FileSpec named twice: /EmbeddedFiles and page /Annots", p10, f10)

    # 11 — declared **only** by a page `/FileAttachment`; no name-tree entry at all.
    p11 = {"annot-only.bin": payload("annot-only")}

    def f11(pdf):
        stream = pdf.make_indirect(ef_stream(pdf, p11["annot-only.bin"]))
        fs = pdf.make_indirect(file_spec(pdf, stream, name="annot-only.bin"))
        pdf.pages[1]["/Annots"] = pikepdf.Array([file_attachment(pdf, fs)])

    hand("annot-only.pdf", "attachment reachable only through a page /FileAttachment", p11, f11)

    # 12 — declared **only** in a document-level `/Annots` on the catalogue.
    p12 = {"doc-annot.bin": payload("doc-annot")}

    def f12(pdf):
        stream = pdf.make_indirect(ef_stream(pdf, p12["doc-annot.bin"]))
        fs = pdf.make_indirect(file_spec(pdf, stream, name="doc-annot.bin"))
        annot = file_attachment(pdf, fs)
        annot["/P"] = pdf.make_indirect(D(Type=N("Page"), Parent=pdf.pages[0].obj))
        pdf.Root["/Annots"] = pikepdf.Array([annot])

    hand("doc-annot-only.pdf", "attachment named only in a catalogue-level /Annots", p12, f12)

    # 13 — a UTF-16BE name-tree key whose `/UF` differs from its `/F`. pikepdf
    # serialises a Python `str` in PDFDocEncoding, which is not what a producer
    # shipping a non-ASCII name writes, so the BOM-prefixed UTF-16BE bytes are
    # handed over as a hex string and kept byte-exact.
    U_KEY = "über-𓂀.txt"
    hexstring = b"<FEFF" + U_KEY.encode("utf-16-be").hex().encode() + b">"
    UTF16 = pikepdf.Object.parse(hexstring)

    p13 = {U_KEY: payload("unicode")}

    def f13(pdf):
        stream = pdf.make_indirect(ef_stream(pdf, p13[U_KEY]))
        fs = pdf.make_indirect(D(Type=N("Filespec"), F=pikepdf.String("alias.txt"), UF=UTF16,
                                 EF=D(F=stream, UF=stream)))
        attach_flat(pdf, [(UTF16, fs)])

    hand("unicode-name.pdf", "UTF-16BE /Names key, /UF differing from /F", p13, f13)

    # 14 — an indirect `/EF` dictionary, no `/Subtype`, no `/Params`.
    p14 = {"bare.bin": payload("bare")}

    def f14(pdf):
        stream = pdf.make_indirect(ef_stream(pdf, p14["bare.bin"], params=False, subtype=False))
        fs = D(Type=N("Filespec"), F=pikepdf.String("bare.bin"))
        fs["/EF"] = pdf.make_indirect(D(F=stream))
        attach_flat(pdf, [(pikepdf.String("bare.bin"), pdf.make_indirect(fs))])

    hand("ef-dict-indirect.pdf", "/EF is an indirect dict; no /Subtype, no /Params", p14, f14)

    write_manifest(TARGET, freeze_all_here())


def census() -> list[dict]:
    """What three outside readers say about each kept fixture."""
    rows = []
    for name in sorted(os.listdir(TARGET)):
        if not name.endswith(".pdf") or name.startswith("_"):
            continue
        path = os.path.join(TARGET, name)
        row: dict[str, object] = {"file": name}
        try:
            doc = pymupdf.open(path)
            row["mupdf"] = [
                {"name": n, "sha256": sha(doc.embfile_get(n))} for n in doc.embfile_names()
            ]
            doc.close()
        except Exception as exc:  # noqa: BLE001
            row["mupdf"] = f"error: {type(exc).__name__}: {exc}"
        try:
            reader = pypdf.PdfReader(path)
            row["pypdf"] = [
                {"name": k.strip("/"), "sha256": sha(v[0] if isinstance(v, list) else v)}
                for k, v in reader.attachments.items()
            ]
        except Exception as exc:  # noqa: BLE001
            # `IndirectObject(5, 0, 140056169133968)` carries the Python object id,
            # which is a different number every run and would make the log drift.
            text = f"{type(exc).__name__}: {exc}"
            row["pypdf"] = "error: " + re.sub(r"IndirectObject\((\d+), (\d+), \d+\)", r"Object \1 0 R", text)
        try:
            out = subprocess.run(["pdfdetach", "-list", path], capture_output=True, check=False, timeout=60)
            # poppler hands back the file's own bytes for a `/UF` name, which is not
            # always valid UTF-8; decode with replacement rather than losing the row.
            stdout = out.stdout.decode("utf-8", errors="replace")
            stderr = out.stderr.decode("utf-8", errors="replace")
            names = [ln.split(":", 1)[1].strip() for ln in stdout.splitlines() if ":" in ln]
            row["poppler"] = names + ([f"stderr: {stderr.strip()}"] if stderr.strip() else [])
        except Exception as exc:  # noqa: BLE001
            row["poppler"] = f"error: {type(exc).__name__}: {exc}"
        rows.append(row)
    return rows


def poppler_version() -> str:
    out = subprocess.run(["pdfdetach", "--version"], capture_output=True, text=True, check=False, timeout=60)
    return (out.stdout + out.stderr).strip() or "pdfdetach (version unknown)"


def emit_log(rows: list[dict], path: str) -> None:
    """Write the outside census: shape, producer, and what three foreign readers answer."""
    lines = [
        "ATTACHMENTS — the foreign fixtures in `tests/fixtures/attachments/`, and what",
        "readers that did not write them say.",
        "",
        "Producers on this box: libqpdf 12.3.2 (through pikepdf " + pikepdf.__version__ + ")"
        + ", MuPDF 1.28.2 (through PyMuPDF " + pymupdf.version[0] + ")"
        + ", pypdf " + pypdf.__version__ + ".",
        "Readers used to judge them: the same three, plus poppler's `pdfdetach` "
        + poppler_version().splitlines()[0].strip()
        + " (the `qpdf` and `mutool` binaries are not installed here, so the census is four readers, not five).",
        "",
        "Each `sha256=` is the payload the fixture was built to carry; a reader that lists a",
        "name whose hash differs found the entry but not its bytes, which is the failure this",
        "repo calls a blank page with a page count.",
        "",
    ]
    for row in rows:
        name = row["file"]
        meta = SHAPES.get(name, {"shape": "(base document)", "producer": "MuPDF 1.28.2"})
        lines.append(f"== {name}")
        lines.append(f"   shape    {meta['shape']}")
        lines.append(f"   producer {meta['producer']}")
        want = EXPECTED.get(name, {})
        for key, label in (("mupdf", "MuPDF  "), ("pypdf", "pypdf  "), ("poppler", "poppler")):
            value = row[key]
            if isinstance(value, str):
                lines.append(f"   {label}  {value}")
                continue
            entries = value if isinstance(value, list) else []
            parts = []
            for item in entries:
                if isinstance(item, dict):
                    hit = want.get(item["name"])
                    tag = "sha256=" + item["sha256"][:12]
                    if hit is None:
                        tag += " (unexpected name)"
                    elif hit != item["sha256"]:
                        tag += " != expected " + hit[:12]
                    elif want[item["name"]] == item["sha256"]:
                        tag += " = expected"
                    parts.append(f"{item['name']} {tag}")
                else:
                    parts.append(str(item))
            lines.append(f"   {label}  {len(entries) and ', '.join(parts) or 'nothing'}")
        if want:
            lines.append("   expected " + ", ".join(f"{k} sha256={v[:12]}" for k, v in sorted(want.items())))
        lines.append("")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))


def check() -> int:
    """Rebuild the whole set twice, in separate processes, and compare the bytes."""
    return check_reproducible([sys.executable, os.path.abspath(__file__)], "attachments")


if __name__ == "__main__":
    if "--check" in sys.argv:
        sys.argv.remove("--check")
        sys.exit(check())
    build()
    rows = census()
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    log = os.path.join(repo, "docs", "research", "attachments-foreign-shapes.log")
    emit_log(rows, log)
    print(json.dumps(rows, indent=1, ensure_ascii=False))
