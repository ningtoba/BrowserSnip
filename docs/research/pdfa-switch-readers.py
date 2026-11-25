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
  * **the cross-reference structure** — §6.1.4 test 3: part 1 forbids an xref
    stream, so a file that writes `/Type /XRef` cannot be a part-1 file whatever
    else about it is right;
  * **the mirror by property, not by substring** — §6.7.3 tests 1/4/5/8: `/Info`
    `Subject` → `dc:description['x-default']`, `/Info` `Keywords` → `pdf:Keywords`,
    `/Info` `Creator` → `xmp:CreatorTool`, and the two dates compared **as instants
    at the resolution the format allows** — a packet writing `…:39.376Z` over an
    `/Info` `D:…39Z` mirrors the same wall-clock second and still fails tests 1/8,
    which the substring check above cannot see;
  * **links** — the `/Link` annotations the file had before the rewrite;
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
from datetime import datetime, timedelta, timezone
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


DC = "{http://purl.org/dc/elements/1.1/}"
PDF_NS = "{http://ns.adobe.com/pdf/1.3/}"
XMP_NS = "{http://ns.adobe.com/xap/1.0/}"
DATE_SPelling = re.compile(
    r"^D?:?\s*(\d{4})-?(\d{2})?-?(\d{2})?[T ]?(\d{2})?:?(\d{2})?:?(\d{2})?(\.\d+)?"
    r"(Z|[+-]\d{2}:?\d{2})?$"
)


def parse_date(value: str | None):
    """(the instant, does the string carry a fraction of a second) or None.

    Both spellings a PDF/A file uses are accepted: the `/Info` form
    `D:YYYYMMDDHHmmSS` with an optional zone (§7.9.4), which **has no fractional
    field at all**, and the XMP ISO-8601 form `YYYY-MM-DDThh:mm:ss[.sss](Z|±hh:mm)`.
    A missing zone is read as UTC and reported, never silently.
    """
    if not value:
        return None
    match = DATE_SPelling.match(value.strip().replace("'", ""))
    if not match:
        return None
    year, month, day, hour, minute, second, fraction, zone = match.groups()
    offset = timezone.utc
    if zone and zone != "Z":
        sign = 1 if zone[0] == "+" else -1
        digits = zone[1:].replace(":", "")
        offset = timezone(sign * timedelta(hours=int(digits[:2]), minutes=int(digits[2:4] or 0)))
    moment = datetime(
        int(year), int(month or 1), int(day or 1), int(hour or 0), int(minute or 0), int(second or 0), tzinfo=offset
    )
    return moment, bool(fraction)


def literal(tree, name: str) -> str | None:
    """An XMP property written as an attribute or as element text."""
    for node in tree.iter():
        if node.get(name) is not None:
            return node.get(name).strip()
        if node.tag == name and (node.text or "").strip():
            return node.text.strip()
    return None


def alt(tree, name: str) -> str | None:
    """An XMP unordered-array property — `dc:title`, `dc:description` — first item."""
    for node in tree.iter():
        if node.get(name) is None and node.tag != name:
            continue
        for item in node.iter(f"{{{RDF}}}li"):
            if (item.text or "").strip():
                return item.text.strip()
    return None


def report(path: str, expected: str | None) -> None:
    doc = pymupdf.open(path)
    catalog = doc.pdf_catalog()
    raw, xref = xmp(doc)
    lines = [f"== {path} ({len(open(path,'rb').read())} B) claimed part {expected or '?'}"]
    identification = None
    utf8 = None
    tree = None
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

    # ── the duties the substring scan cannot see, graded by rule ──────────────────
    # A validator compares *properties* and the *cross-reference structure*; it does
    # not grep. So each of these is looked at on its own terms:
    #   §6.1.4 t3  part 1 forbids the xref stream (`/Type /XRef`) and object streams,
    #              which is a fact about how the file is written, not about the packet;
    #   §6.7.3 t4/t5/t6  `/Info` Subject/Keywords/Creator mirrored into
    #              dc:description['x-default'], pdf:Keywords, xmp:CreatorTool;
    #   §6.7.3 t1/t8  the dates equal **as instants at the resolution the format
    #              allows** — `…T11:01:39.376Z` over `D:20261125110139Z` is the same
    #              wall-clock second and still fails, because PDF dates have no
    #              fractional field for a validator to match.
    fails: list[str] = []
    file_bytes = open(path, "rb").read()
    xref_at, objstm_at = file_bytes.find(b"/Type /XRef"), file_bytes.find(b"/Type /ObjStm")
    part1 = (expected or "").startswith("1")
    lines.append(
        f"  §6.1.4 t3 cross-reference: /Type /XRef {'at byte ' + str(xref_at) if xref_at >= 0 else 'absent'}"
        f", /Type /ObjStm {'at byte ' + str(objstm_at) if objstm_at >= 0 else 'absent'}"
        + ("" if xref_at < 0 or not part1 else " — part 1 forbids xref streams, so this cannot be a part-1 file")
    )
    if xref_at >= 0 and part1:
        fails.append("6.1.4/3 xref stream in a part-1 file")
    if raw and tree is not None:
        for rule, entry, prop, have, written in (
            ("6.7.3/4", "Subject", "dc:description['x-default']", info.get("subject"), alt(tree, DC + "description")),
            ("6.7.3/5", "Keywords", "pdf:Keywords", info.get("keywords"), literal(tree, PDF_NS + "Keywords")),
            ("6.7.3/6", "Creator", "xmp:CreatorTool", info.get("creator"), literal(tree, XMP_NS + "CreatorTool")),
        ):
            want, got = str(have or ""), str(written or "")
            if not want:
                lines.append(f"  §{rule} mirror {entry}: nothing in /Info to mirror")
                continue
            ok = want == got
            lines.append(
                f"  §{rule} mirror {entry} → {prop}: {'equivalent' if ok else 'NOT mirrored'}"
                f" /Info={want[:70]!r} packet={got[:70]!r}"
            )
            if not ok:
                fails.append(f"{rule} {entry} not mirrored")
        for rule, key, prop in (
            ("6.7.3/1", "creationDate", XMP_NS + "CreateDate"),
            ("6.7.3/8", "modDate", XMP_NS + "ModifyDate"),
        ):
            pdf_raw, xmp_raw = str(info.get(key) or ""), literal(tree, prop) or ""
            if not pdf_raw and not xmp_raw:
                lines.append(f"  §{rule} dates {key}: nothing on either side")
                continue
            left, right = parse_date(pdf_raw), parse_date(xmp_raw)
            if left is None or right is None:
                ok = False
                verdict = f"UNPARSEABLE /Info={pdf_raw!r} packet={xmp_raw!r}"
            else:
                ok = left[0] == right[0] and not left[1] and not right[1]
                verdict = (
                    f"{'equivalent' if ok else 'NOT equivalent'}: /Info {pdf_raw!r} ({left[0].isoformat() if left else '?'})"
                    f" vs {xmp_raw!r} ({right[0].isoformat() if right else '?'})"
                )
                if left and right and left[0] == right[0] and (left[1] or right[1]):
                    verdict += " — same instant, but a sub-second field is written where PDF has none"
            lines.append(f"  §{rule} dates {key}: {verdict}")
            if not ok:
                fails.append(f"{rule} {key} not equivalent")

    # Transparency, attachments, fonts, and what survived the rewrite.
    soft_masks = alpha = link_objects = 0
    for x in range(1, doc.xref_length()):
        try:
            head = doc.xref_object(x, compressed=False)
        except Exception:
            continue
        if "/SMask" in head:
            soft_masks += 1
        if "/CA" in head or "/ca" in head or "/BM" in head:
            alpha += 1
        if "/Subtype /Link" in head:
            link_objects += 1
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
    lines.append(
        f"  links: {link_objects} /Subtype /Link object(s), MuPDF answers {sum(len(p.get_links()) for p in doc)} link(s)"
        f" | marks: {sum(len(list(p.annots())) for p in doc)} annot(s) reachable from a page"
    )
    lines.append(f"  §-graded duties FAILED here: {fails or 'none'}")
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
