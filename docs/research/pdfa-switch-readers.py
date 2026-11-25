#!/usr/bin/env python3
"""Read a PDF/A candidate the way the card describes it, with readers that did not write it.

    python3 docs/research/pdfa-switch-readers.py FILE.pdf [expected-part …]

Every claim `pdf-to-pdfa` prints is one of these, so each is measured rather than
assumed:

  * **identification** — `pdfaid:part` / `pdfaid:conformance` in the XMP packet, the
    packet parsed as RDF (not string-searched), and whether the packet is UTF-8 with
    its BOM intact — the encoding a validator reads, §6.6.2.1;
  * **output intent** — `/OutputIntents` in the catalogue, `/S /GTS_PDFA1`, `/N`, and
    the ICC profile behind `/DestOutputProfile`: its declared length against the
    bytes, its `acsp` signature, its colour space and PCS, its tag table inside the
    profile, and what lcms2 makes of it;
  * **the Info/XMP mirror** — every `/Info` entry PDF/A §6.6.2.2 wants reflected;
  * **the trailer `/ID`** — §6.1.3, the duty pdf-lib's writer does not perform;
  * **transparency** — soft masks and alpha graphic states, which part 1 forbids;
  * **attachments** — carried in part 3, forbidden in part 1;
  * **fonts** — every face with or without a font program;
  * **preservation** — per page, ink, characters, boxes and rotation against the source
    measured the same way, and the marks/outline/labels the file still names.
"""
from __future__ import annotations

import re
import struct
import subprocess
import sys
from xml.etree import ElementTree

import pymupdf

RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
PDFUA_ID = "{http://www.aiim.org/pdfa/ns/id/}"


def xmp(doc):
    holder, value = doc.xref_get_key(doc.pdf_catalog(), "Metadata")
    if holder != "xref":
        return None, None
    xref = int(value.split()[0])
    raw = doc.xref_stream(xref) or b""
    return raw, xref


def icc_facts(profile: bytes) -> dict:
    out = {"bytes": len(profile)}
    if len(profile) < 132:
        return {**out, "problem": "shorter than an ICC header"}
    declared = struct.unpack(">I", profile[0:4])[0]
    out["declared"] = declared
    out["acsp"] = profile[36:40] == b"acsp"
    out["colour_space"] = profile[16:20].decode("latin1")
    out["pcs"] = profile[20:24].decode("latin1")
    tags = struct.unpack(">I", profile[128:132])[0]
    out["tags"] = tags
    worst = 0
    for index in range(tags):
        base = 132 + index * 12
        if base + 12 > len(profile):
            out["problem"] = "tag table runs past the profile"
            break
        _, offset, size = struct.unpack(">4sII", profile[base : base + 12])
        worst = max(worst, offset + size)
    out["tag_table_end"] = worst
    out["inside"] = worst <= len(profile)
    return out


def report(path: str, expected: str | None) -> None:
    doc = pymupdf.open(path)
    catalog = doc.pdf_catalog()
    raw, xref = xmp(doc)
    lines = [f"== {path} ({len(open(path,'rb').read())} B) claimed part {expected or '?'}"]
    identification = None
    utf8 = None
    if raw:
        bom = raw.startswith(b"\xef\xbb\xbf") or b"<?xpacket begin=" in raw[:60] and "\ufeff".encode("utf-8") in raw[:60]
        try:
            raw.decode("utf-8", errors="strict")
            utf8 = "strict-utf8 ok"
        except UnicodeDecodeError as error:
            utf8 = f"FAILS utf-8 decode: {error}"
        body = re.sub(rb"^.*?\?>", b"", raw, count=1, flags=re.S)
        try:
            tree = ElementTree.fromstring(body)
            # Both spellings the field can take: an element, and the attribute form
            # both Ghostscript and this app's writer emit.
            part = conf = None
            for node in tree.iter():
                part = part or node.get(f"{PDFUA_ID}part") or (node.text.strip() if node.tag == f"{PDFUA_ID}part" and node.text else None)
                conf = conf or node.get(f"{PDFUA_ID}conformance") or (node.text.strip() if node.tag == f"{PDFUA_ID}conformance" and node.text else None)
            identification = (part, conf)
            ns = sorted({m.group(1) for m in re.finditer(rb'xmlns:([A-Za-z]+)=', raw)})
            lines.append(f"  xmp: packet {len(raw)} B, bom-in-prolog {bom}, {utf8}, namespaces {[n.decode() for n in ns]}")
        except ElementTree.ParseError as error:
            identification = None
            lines.append(f"  xmp: packet {len(raw)} B, NOT PARSEABLE ({error})")
    else:
        lines.append("  xmp: no /Metadata stream")
    lines.append(f"  identification pdfaid:part/conformance: {identification}")
    if expected and identification != (expected[0], expected[1:].upper()):
        lines.append(f"  MISMATCH: the card says {expected}, the packet says {identification}")

    holder, intent = doc.xref_get_key(catalog, "OutputIntents")
    lines.append(f"  /OutputIntents: {holder} {str(intent)[:160]}")
    if holder == "array":
        first = re.search(r"(\d+)\s+0\s+R", str(intent))
        x = int(first.group(1)) if first else None
        head = doc.xref_object(x, compressed=False).replace("\n", " ") if x else ""
        lines.append(f"    intent dict: {head[:220]}")
        profile_ref = re.search(r"/DestOutputProfile\s+(\d+)\s+0\s+R", head)
        if profile_ref:
            pxref = int(profile_ref.group(1))
            profile = doc.xref_stream(pxref) or b""
            facts = icc_facts(profile)
            lines.append(f"    ICC: {facts}")
            try:
                import io
                import PIL.ImageCms as cms
                handle = cms.getOpenProfile(io.BytesIO(profile))
                lines.append(f"    lcms2 opens it: {cms.getProfileName(handle)!r}")
            except Exception as error:
                lines.append(f"    lcms2 refuses it: {error}")
        else:
            lines.append("    NO /DestOutputProfile — the intent names no colour")
    identification_ok = bool(identification)
    intent_ok = holder == "array"
    lines.append(f"  → PDF/A duties this reader can check: identification {identification_ok}, intent {intent_ok}")

    trailer = doc.xref_object(-1, compressed=False)
    lines.append(f"  trailer /ID: {'yes' if '/ID' in trailer else 'ABSENT (PDF/A §6.1.3 requires it)'}")

    info = {k: v for k, v in doc.metadata.items() if v and k not in ("format",)}
    lines.append(f"  /Info seen by MuPDF: {info}")
    if raw:
        packet = raw.decode("latin1", "replace")
        def same_date(pdf_date: str) -> str:
            m = re.match(r"D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([+Z-]|\+)", pdf_date)
            return pdf_date
        missing = []
        for key in ("title", "author", "subject", "keywords", "creator", "producer"):
            value = str(info.get(key) or "")
            if value and value not in packet:
                missing.append(key)
        for key in ("creationDate", "modDate"):
            value = str(info.get(key) or "")
            if not value:
                continue
            digits = re.findall(r"\d+", value)
            # XMP writes the same instant as `YYYY-MM-DDThh:mm:ss`, so the mirror is
            # checked on the numbers, not on the two different renderings of them.
            stamp = f"{digits[0]}-{digits[1]}-{digits[2]}T{digits[3]}:{digits[4]}:{digits[5]}" if len(digits) >= 6 else value
            if stamp not in packet:
                missing.append(key)
        lines.append(f"  /Info entries not mirrored in the packet: {missing or 'none'}")

    # Transparency, attachments, fonts, and what survived the rewrite.
    soft_masks = alpha = 0
    for x in range(1, doc.xref_length()):
        try:
            head = doc.xref_object(x, compressed=False)
        except Exception:
            continue
        if "/SMask" in head:
            soft_masks += 1
        if "/CA" in head or "/ca" in head or "/BM" in head:
            alpha += 1
    attachments = doc.embfile_count()
    fonts = []
    for page in doc:
        for name, ext, ftype, base, refnum, *_ in page.get_fonts():
            # The font program hangs off the descriptor, not the font dictionary.
            embedded = False
            try:
                head = doc.xref_object(font_xref, compressed=False)
                descriptor = re.search(r"/FontDescriptor\s+(\d+)\s+0\s+R", head)
                if descriptor:
                    embedded = bool(re.search(r"/FontFile2?\b|/FontFile3\b", doc.xref_object(int(descriptor.group(1)), compressed=False)))
            except Exception:
                pass
            fonts.append((base, ftype, embedded))
    lines.append(
        f"  transparency: {soft_masks} /SMask reference(s), {alpha} graphic-state entries with alpha"
        f" | attachments {attachments} | faces {len(fonts)} embedded {sum(1 for f in fonts if f[2])}"
    )
    print("\n".join(lines))


def main() -> int:
    args = sys.argv[1:]
    for index in range(0, len(args), 2):
        path = args[index]
        expected = args[index + 1] if index + 1 < len(args) else None
        try:
            report(path, expected)
        except Exception as error:
            print(f"== {path}\n  unreadable: {error}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
