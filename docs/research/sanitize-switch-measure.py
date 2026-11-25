#!/usr/bin/env python3
"""Judge a `sanitize-pdf` switch audit: does a switch that was turned ON change
the produced bytes, and did the thing it names actually leave the file?

    python3 docs/research/sanitize-switch-measure.py \
        --spec docs/research/sanitize-switch-spec.json \
        --runs /tmp/lane-optimize2/runs.jsonl --outdir /tmp/lane-optimize2/out \
        --log /tmp/lane-optimize2/table.md

Every expectation is *derived from the source fixture*, not written down by hand:

* **the payload of each scope** — the script text in every `/JS`/`/JavaScript`
  string, the bytes of every `/Type /EmbeddedFile` stream, the XMP packet's own
  signature, every `/Info` value, every annotation `/Contents`, `/V` and `/URI`,
  and the text drawn inside each `BDC … EMC` span of a layer the default view
  switches off;
* **the state of each switch** — read back out of the DOM by the probe, recorded
  per run (`--runs` is the driver's own JSONL, so the fields the run really used
  are the fields judged here).

A scope marker must be findable in the OFF run's file and unfindable in the ON
run's file, where "findable" means: in the raw bytes, in any object source MuPDF
can name (including objects inside object streams), or in any decoded stream.
Markers that survive a switch that was ON are then classified by whether an
outside reader can still *reach* them — a leftover no reader resolves is residue
and is reported as such; a leftover a reader still answers with is the campaign's
`the switch existed, the payload stayed` defect.

Controls, every run: the page count and every marker that belongs to no switch
must be unchanged, the visible ink of the sheet must be identical for the four
switches that claim nothing about appearance, and the two runs that differ in one
switch only must differ in the bytes exactly where that switch's payload is.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys

import numpy as np
import pymupdf

DPI = 110
XMP_SIGNATURES = (b"<x:xmpmeta", b"<adobe:ns:meta")
LABELS = {
    "javascript": "Remove JavaScript and automatic actions",
    "attachments": "Remove embedded files",
    "metadata": "Remove XMP metadata",
    "info": "Remove the document info dictionary",
    "annotations": "Remove annotations and form fields",
    "hiddenLayers": "Remove hidden layer content",
}
"""The six scope switches, addressed by the words the rail prints beside them."""
JS_CODE = re.compile(rb"/(?:JS|JavaScript)\s*\(((?:[^()\\]|\\.)*)\)")
HEX_CODE = re.compile(rb"/(?:JS|JavaScript)\s*<([0-9A-Fa-f\s]+)>")
TEXT_SHOW = re.compile(rb"\(((?:[^()\\]|\\.)*)\)\s*Tj", re.S)
STR_VALUE = re.compile(rb"/(Contents|V|URI|Alt|TU)\s*\(((?:[^()\\]|\\.)*)\)")


def unescape(raw: bytes) -> bytes:
    """PDF literal-string bytes → the bytes a viewer runs/sees."""
    out = bytearray()
    index = 0
    while index < len(raw):
        char = raw[index]
        if char == 0x5C and index + 1 < len(raw):
            nxt = raw[index + 1]
            table = {0x6E: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12, 0x28: 40, 0x29: 41, 0x5C: 92}
            if nxt in table:
                out.append(table[nxt])
                index += 2
                continue
            if 0x30 <= nxt <= 0x37:
                digits = bytearray()
                step = index + 1
                while step < len(raw) and len(digits) < 3 and 0x30 <= raw[step] <= 0x37:
                    digits.append(raw[step])
                    step += 1
                out.append(int(digits, 8) & 0xFF)
                index = step
                continue
            out.append(nxt)
            index += 2
            continue
        out.append(char)
        index += 1
    return bytes(out)


def object_text(doc) -> bytes:
    """Every object source MuPDF can name, plus every decoded stream body.

    pdf-lib writes dictionaries into object streams, so the raw file bytes prove
    almost nothing on their own — this is the whole visible content of the file.
    The trailer's own text is included: an info dictionary written **direct into
    the trailer** lives nowhere else.
    """
    parts = [doc.xref_object(-1, compressed=False).encode("latin-1", "replace")]
    for xref in range(1, doc.xref_length()):
        try:
            parts.append(doc.xref_object(xref, compressed=False).encode("latin-1", "replace"))
        except Exception:
            parts.append(b"")
        if doc.xref_is_stream(xref):
            try:
                parts.append(doc.xref_stream(xref) or b"")
            except Exception:
                parts.append(b"")
    return b"\n".join(parts)


def decode_literals(blob: bytes) -> bytes:
    """Every PDF literal string in `blob`, written without its backslash escapes.

    A viewer re-escapes what it re-writes — `(console.clear\\(\\);)` — so a needle
    decoded from one file's spelling cannot be searched for in another's bytes
    unless both sides are put back into the same form.
    """
    out = bytearray(blob)
    for match in reversed(list(re.finditer(rb"\(((?:[^()\\]|\\.)*)\)", blob))):
        decoded = unescape(match.group(1))
        if decoded != match.group(1):
            out[match.start(1):match.end(1)] = decoded
    return bytes(out)


def haystack(path: pathlib.Path, doc) -> bytes:
    """Everything the produced file holds, in both escape spellings."""
    blob = object_text(doc) + bytes(path.read_bytes())
    return blob + decode_literals(blob)


def ink(page, annots: bool = False) -> int:
    pixmap = page.get_pixmap(dpi=DPI, annots=annots)
    sample = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(pixmap.height, pixmap.width, pixmap.n)
    return int((sample[:, :, :3] != 255).any(axis=2).sum())


def ink_image(page, annots: bool = False) -> np.ndarray:
    pixmap = page.get_pixmap(dpi=DPI, annots=annots)
    return np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(pixmap.height, pixmap.width, pixmap.n)[:, :, :3]


def visible_pixels(source_page, output_page, limit: int = 16) -> int:
    """Pixels whose colour moved by more than `limit`/255 between two renders.

    A re-write of the file changes MuPDF's antialiasing on glyph edges by one step
    (measured: 37 598 px at exactly one level on a text-heavy sheet, with identical
    row-by-row ink). Only a move bigger than a step is a repaint.
    """
    a = ink_image(source_page)
    b = ink_image(output_page)
    if a.shape != b.shape:
        return -1
    return int((np.abs(a.astype(int) - b.astype(int)).max(axis=2) > limit).sum())


def strong_ink(page, annots: bool = True, threshold: int = 128) -> int:
    """Dark pixels — the marks a user calls content, not an antialiasing halo."""
    return int((ink_image(page, annots=annots).min(axis=2) < threshold).sum())


def diff_box(a: np.ndarray, b: np.ndarray):
    """Bounding box (PDF points, top-left origin rows) where two renders differ."""
    if a.shape != b.shape:
        return None
    delta = (a != b).any(axis=2)
    if not delta.any():
        return None
    rows = np.flatnonzero(delta.any(axis=1))
    cols = np.flatnonzero(delta.any(axis=0))
    scale = 72.0 / DPI
    return (round(cols[0] * scale), round(rows[0] * scale), round((cols[-1] + 1) * scale), round((rows[-1] + 1) * scale))


def collapse(value: bytes) -> str:
    return re.sub(rb"\s+", b" ", value).decode("latin-1", "replace").strip()


def annotation_xrefs(doc) -> set[int]:
    """Every annotation and form-field object the document names, resolved.

    Read off the page's `/Annots` array and the AcroForm field tree — including
    the widget, the link and the pop-up, which MuPDF's own iterator hides.
    """
    xrefs: set[int] = set()
    stack: list[str] = []
    for page in doc:
        # `/Annots` is a page-tree attribute in PDF 2.0: a sheet with none of its own
        # inherits whatever its `/Parent` nodes name.
        node = page.xref
        for _ in range(24):
            holder, value = doc.xref_get_key(node, "Annots")
            if holder != "null":
                stack += re.findall(r"(\d+)\s+0\s+R", value)
            holder, parent = doc.xref_get_key(node, "Parent")
            if holder != "xref":
                break
            node = int(parent.split()[0])
    holder, value = doc.xref_get_key(doc.pdf_catalog(), "AcroForm")
    if holder == "xref":
        stack.append(value.split()[0])
    seen: set[int] = set()
    while stack:
        number = int(stack.pop())
        if number in seen or not 0 < number < doc.xref_length():
            continue
        seen.add(number)
        try:
            source = doc.xref_object(number, compressed=False)
        except Exception:
            continue
        xrefs.add(number)
        # Fields nest: `/Kids` holds the widget of a split field, `/Parent` points back.
        for key in ("Fields", "Kids"):
            holder, value = doc.xref_get_key(number, key)
            if holder != "null":
                stack += re.findall(r"(\d+)\s+0\s+R", value)
        for match in re.finditer(r"/AP\s*<<(.*?)>>", source, re.S):
            xrefs.update(int(n) for n in re.findall(r"(\d+)\s+0\s+R", match.group(1)))
    return xrefs


def span_needles(doc) -> list[str]:
    """The drawing operators of every layer the default view switches off."""
    off = off_layers(doc)
    out = []
    if not off:
        return out
    for page in doc:
        for name, body in marked_spans(page.read_contents()):
            if name in off:
                probe = collapse(body)
                if len(probe) >= 16:
                    out.append(probe[:120])
                for match in TEXT_SHOW.finditer(body):
                    text = unescape(match.group(1)).decode("latin-1", "replace")
                    if len(text) >= 4:
                        out.append(text)
    return sorted(set(out))


def scope_needles(source: pathlib.Path) -> dict[str, list[str]]:
    """The payload of each scope, read out of the untouched fixture."""
    doc = pymupdf.open(source)
    blob = object_text(doc)
    needles: dict[str, set[str]] = {key: set() for key in (
        "javascript", "attachments", "metadata", "info", "annotations", "hiddenLayers")}

    for match in JS_CODE.finditer(blob):
        code = unescape(match.group(1)).decode("latin-1", "replace").strip()
        if len(code) >= 6:
            needles["javascript"].add(code)
    for match in HEX_CODE.finditer(blob):
        try:
            code = bytes.fromhex(match.group(1).decode()).decode("latin-1", "replace").strip()
        except ValueError:
            continue
        if len(code) >= 6:
            needles["javascript"].add(code)

    for xref in range(1, doc.xref_length()):
        if not doc.xref_is_stream(xref):
            continue
        head = doc.xref_object(xref, compressed=False)
        body = doc.xref_stream(xref) or b""
        if "/Type /EmbeddedFile" in head.replace("\n", " "):
            probe = body[:24] or b""
            if len(probe) >= 8:
                needles["attachments"].add(probe.decode("latin-1", "replace"))
        elif "/Type /Metadata" in head.replace("\n", " "):
            # The XMP packet is the metadata stream the switch names — and only that:
            # an XFA packet holds XML of its own, including a `<x:xmpmeta`, and it is
            # disclosed as unread rather than claimed removed.
            for sign in XMP_SIGNATURES:
                if sign in body:
                    needles["metadata"].add(sign.decode("latin-1", "replace"))
            for title in re.findall(rb'dc:title="([^"]{6,})"', body) + re.findall(rb"<dc:title>([^<]{6,})</dc:title>", body):
                needles["metadata"].add(title.decode("latin-1", "replace"))

    # The document info dictionary, however the trailer names it — an indirect
    # reference (the usual spelling) or a dictionary written straight into the
    # trailer (what a few producers do, and the shape a `trailerInfo.Info
    # instanceof PDFRef` test walks past).
    holder, value = doc.xref_get_key(-1, "Info")
    if holder == "xref":
        value = doc.xref_object(int(value.split()[0]), compressed=False)
    if holder in ("dict", "xref"):
        for match in re.finditer(
            r"/(Title|Author|Subject|Keywords)\s*\(((?:[^()\\]|\\.)*)\)", value, re.S
        ):
            text = unescape(match.group(2).encode("latin-1", "replace")).decode("latin-1", "replace").strip()
            if len(text) >= 4:
                needles["info"].add(text)
        for match in re.finditer(r"/(Title|Author|Subject|Keywords)\s*<([0-9A-Fa-f\s]+)>", value, re.S):
            try:
                text = bytes.fromhex(match.group(2).replace(" ", "")).decode("utf-16-be", "replace").strip("\x00").strip()
            except ValueError:
                continue
            if len(text) >= 4:
                needles["info"].add(text)

    # The annotation scope: every comment, field value, URL and appearance string
    # the document names, taken off the annotation and field objects themselves.
    for xref in sorted(annotation_xrefs(doc)):
        try:
            head = doc.xref_object(xref, compressed=False)
        except Exception:
            continue
        for match in re.finditer(rb"\(((?:[^()\\]|\\.)*)\)", head.encode("latin-1", "replace")):
            text = unescape(match.group(1)).decode("latin-1", "replace").strip()
            # A value, not a dictionary: `(0 0 300 200)` and friends live here too.
            if len(text) >= 6 and not text.startswith("/") and "(" not in text:
                needles["annotations"].add(text)
        if doc.xref_is_stream(xref):
            try:
                body = doc.xref_stream(xref) or b""
            except Exception:
                body = b""
            for match in TEXT_SHOW.finditer(body):
                text = unescape(match.group(1)).decode("latin-1", "replace").strip()
                if len(text) >= 6:
                    needles["annotations"].add(text)

    # Optional content: the operators inside a `BDC … EMC` span whose group the
    # default view switches off — the span, not just the text it draws, because a
    # CAD layer is usually paths and fills with no text at all.
    needles["hiddenLayers"].update(span_needles(doc))

    # A needle is only evidence about the scope that owns it. A comment whose text
    # is also drawn on the sheet, a title that is also in the XMP packet, a script
    # that is also the value of an annotation's action: whichever of those the run
    # leaves behind, the *other* switch cannot be blamed for it. So each needle is
    # assigned to one scope, the narrowest place it lives, and dropped from the rest.
    order = ("javascript", "attachments", "metadata", "info", "hiddenLayers", "annotations")
    taken: set[str] = set()
    exclusive: dict[str, set[str]] = {}
    for scope in order:
        keep = {needle for needle in needles[scope] if needle not in taken}
        taken |= keep
        exclusive[scope] = keep
    # And a payload that the sheet itself draws is not evidence about a structure
    # switch: a comment whose text is also printed on the page stays when the
    # comment goes, because the page is what holds it.
    outside = bytearray()
    for page in doc:
        outside += page.read_contents()
    outside_bytes = bytes(outside)
    for scope in order:
        if scope in ("hiddenLayers", "metadata"):
            continue
        exclusive[scope] = {
            needle for needle in exclusive[scope]
            if needle.encode("latin-1", "replace") not in outside_bytes
        }

    return {key: sorted(value) for key, value in exclusive.items() if value}


def off_layers(doc) -> dict[str, str]:
    """`/Properties` names whose group the default view switches off.

    Read out of `/OCProperties /D /OFF` and the pages' `/Resources /Properties`
    map, which is how a viewer decides what to paint: the group's own dictionary
    says nothing about its state.
    """
    blob = object_text(doc)
    off_match = re.search(rb"/OFF\s*\[([^\]]*)\]", blob)
    refs = set()
    if off_match:
        refs = {number.decode() for number in re.findall(rb"(\d+)\s+0\s+R", off_match.group(1))}
    else:
        # A file can switch a group off by leaving it out of `/D /ON`, which is what
        # pdf.js does and what a reader still honours; and `/D` may sit behind an
        # indirect reference, which a regex over the catalogue's own text cannot see.
        # Fall back to the state a reader reports for each group.
        refs = {str(number) for number, group in doc.get_ocgs().items() if not group.get("on")}
        if not refs:
            return {}
    names: dict[str, str] = {}
    for match in re.finditer(
        rb"/Properties\s*<<((?:[^<>]|<<(?:[^<>]|<<[^<>]*>>)*>>)*)>>", blob
    ):
        for pair in re.finditer(rb"/(\w+)\s+(\d+)\s+0\s+R", match.group(1)):
            if pair.group(2).decode() in refs:
                names[pair.group(2).decode()] = pair.group(1).decode()
    return {name: ref for ref, name in names.items()}


def marked_spans(content: bytes):
    """Yield `(property name, span bytes)` for every `/OC /name BDC … EMC`."""
    pattern = re.compile(rb"/OC\s*/(\w+)\s+BDC(.*?)EMC", re.S)
    for match in pattern.finditer(content):
        yield match.group(1).decode(), match.group(2)


def found(needles: list[str], haystack_bytes: bytes) -> list[str]:
    return [needle for needle in needles if needle.encode("latin-1", "replace") in haystack_bytes]


def card_text(record) -> str:
    screen = record.get("screen") or {}
    return (screen.get("result") or "") + "\n" + (screen.get("alert") or "")


def signature(path: pathlib.Path) -> dict:
    """What an outside reader can answer about a file — the pair diff's second half.

    Byte equality proves a switch moved *something*; these are the answers a reader
    gives a user, so "the bytes changed" cannot hide "and the payload stayed".
    """
    doc = pymupdf.open(path)
    catalog = doc.pdf_catalog()
    heads = {}
    for xref in range(1, doc.xref_length()):
        try:
            heads[xref] = re.sub(r"\s+", " ", doc.xref_object(xref, compressed=False))
        except Exception:
            heads[xref] = ""
    return {
        "pages": doc.page_count,
        "annots": [len(list(page.annots() or [])) for page in doc],
        "links": [len(page.get_links()) for page in doc],
        # MuPDF's own iterator hides widgets, links and pop-ups, so the tool's count
        # and the reader's count are different facts and both are recorded.
        "annot_objects": len(annotation_xrefs(doc)),
        "script_objects": sum(1 for head in heads.values() if "/S /JavaScript" in head or "/JS " in head),
        "embedded_file_objects": sum(1 for head in heads.values() if "/Type /EmbeddedFile" in head),
        "mupdf_attachments": doc.embfile_count(),
        "xmp_ref": doc.xref_get_key(catalog, "Metadata")[0] != "null",
        "info_ref": doc.xref_get_key(-1, "Info")[0] != "null",
        "info_inline": doc.xref_get_key(-1, "Info")[0] == "dict",
        "ocgs": len(doc.get_ocgs()),
        "ink": [ink(page) for page in doc],
        "ink_with_annots": [ink(page, annots=True) for page in doc],
        "title": doc.metadata.get("title") or "",
        "poppler": poppler(pathlib.Path(path)),
    }


ANNOTATION_SHAPE = re.compile(rb"/Type\s*/Annot\b|/Subtype\s*/(Widget|Link|FreeText|Text|FileAttachment|Popup)\b")


def hosted_needles(source: pathlib.Path, needles: dict[str, list[str]]) -> set[str]:
    """Payloads that live **on an annotation**, so removing annotations may legally
    take them with it: a link's JavaScript action and a `/FileAttachment`'s inline
    file specification both live there, and a strip that also dropped them is not a
    strip that wandered outside its switch."""
    blob = object_text(pymupdf.open(source))
    hosted = set()
    for chunk in blob.split(b"endobj"):
        if not ANNOTATION_SHAPE.search(chunk):
            continue
        for values in needles.values():
            for needle in values:
                if needle.encode("latin-1", "replace") in chunk:
                    hosted.add(needle)
    return hosted


ABSENCE_CLAIMS = {
    "javascript": r"no script references were present",
    "attachments": r"no embedded files were present",
    "metadata": r"there was no XMP packet to remove",
    "info": r"there was no info dictionary",
    "annotations": r"no annotations were present",
    "hiddenLayers": r"no layer is switched off in the default view",
}
REMOVAL_CLAIMS = {
    "javascript": r"\d+ script reference\(s\) removed",
    "attachments": r"\d+ embedded file\(s\) removed",
    "metadata": r"XMP metadata removed",
    "info": r"info dictionary was removed",
    "annotations": r"\d+ annotation\(s\)",
    "hiddenLayers": r"hidden layer operator\(s\).*?removed",
}
LEFT_CLAIMS = {
    "javascript": r"script reference\(s\) left in place",
    "attachments": r"embedded file\(s\) left in place",
}


def card_problems(entry: dict) -> list[str]:
    """The card's own sentence, held against the payloads that actually moved."""
    card, state = entry["card"], entry["state"]
    needles = entry.get("needles", {})
    # "Removed" means the payload of that kind left the bytes, not that the card
    # said a number.
    still = entry.get("blamed", entry.get("present", {}))
    problems = []
    for scope in LABELS:
        if scope not in needles:
            continue
        total, left = len(needles[scope]), len(still.get(scope, []))
        lost = total - left
        removal = bool(re.search(REMOVAL_CLAIMS[scope], card))
        absence = bool(re.search(ABSENCE_CLAIMS[scope], card))
        claims_left = bool(re.search(LEFT_CLAIMS.get(scope, r"$^"), card))
        if removal and state.get(scope) == "on" and lost != total:
            problems.append(
                f"{scope}: the card says it was removed and {left}/{total} of its payload is still in the file"
                if lost == 0
                else f"{scope}: the card says it was removed and {left}/{total} of its payload stayed"
            )
        if absence and total:
            problems.append(f"{scope}: the card says there was nothing of this kind and the file carries {total}")
        if claims_left and left == 0:
            problems.append(f"{scope}: the card warns the payload stays and it is gone from the bytes")
        if state.get(scope) == "off" and removal:
            problems.append(f"{scope}: the card claims a removal with the switch off")
        if state.get(scope) == "on" and lost and not removal:
            problems.append(f"{scope}: {lost}/{total} payload(s) left the file and the card never says so")
    return problems


def poppler(path: pathlib.Path) -> dict:
    """What poppler — a reader that did not write this file — answers about it."""
    def run(cmd):
        try:
            return subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        except Exception as error:  # a missing binary is recorded, not fatal
            return subprocess.CompletedProcess(cmd, 127, "", str(error))

    info = run(["pdfinfo", str(path)]).stdout
    detach = run(["pdfdetach", "-list", str(path)]).stdout
    first = detach.splitlines()[0] if detach.splitlines() else ""
    match = re.search(r"(\d+) embedded file", first)
    return {
        "javascript": (re.search(r"JavaScript:\s*(\w+)", info) or [None, "?"])[1],
        "attached": int(match.group(1)) if match else 0,
        "title": (re.search(r"Title:\s*(.+)", info) or [None, ""])[1].strip(),
        "errors": re.findall(r"Syntax (?:Error|Warning): (.+)", info)[:3],
    }


def reach(scope: str, signature: dict) -> str:
    """Can an outside reader still get at what the switch was told to take out?"""
    if scope == "metadata":
        return "yes" if signature.get("xmp_ref") else "no — the packet is unreferenced residue"
    if scope == "info":
        return "yes" if (signature.get("info_ref") or signature.get("info_inline") or signature.get("title")) \
            else "no — the dictionary is unreferenced residue"
    if scope == "attachments":
        attached = (signature.get("poppler") or {}).get("attached", 0)
        return "yes" if attached or signature.get("mupdf_attachments") else "no — no reader lists it"
    if scope == "annotations":
        return "yes" if sum(signature.get("annots", [])) or sum(signature.get("links", [])) \
            else "no — the dictionaries are unreferenced residue"
    if scope == "hiddenLayers":
        return "yes" if signature.get("ocgs") else "no — no layer definition is left"
    if scope == "javascript":
        return "yes" if (signature.get("poppler") or {}).get("javascript") == "yes" else "unknown"
    return "unknown"


def xfa_bytes(path: pathlib.Path) -> int:
    """How much XFA packet the file carries (0 when it has none)."""
    doc = pymupdf.open(path)
    total = 0
    holder, value = doc.xref_get_key(doc.pdf_catalog(), "AcroForm")
    for xref in range(1, doc.xref_length()):
        try:
            head = doc.xref_object(xref, compressed=False).replace("\n", " ")
        except Exception:
            # A hole the last save left in the xref table: no packet lives there.
            continue
        if "/XFA" not in head and not (holder == "xref" and int(value.split()[0]) == xref):
            continue
        for match in re.finditer(r"/XFA\s*(\[[^\]]*\]|<<[^>>]*>>)", head):
            for number in re.findall(r"(\d+)\s+0\s+R", match.group(1)):
                try:
                    total += len(doc.xref_stream(int(number)) or b"")
                except Exception:
                    pass
    return total


def referrers(doc) -> dict[int, list[int]]:
    """Which objects name each object, so a stream can be traced to its owner."""
    out: dict[int, list[int]] = {}
    for xref in range(1, doc.xref_length()):
        try:
            text = doc.xref_object(xref, compressed=False)
        except Exception:
            continue
        for number in set(re.findall(r"(\d+)\s+0\s+R", text)):
            out.setdefault(int(number), []).append(xref)
    return out


def object_roles(doc) -> dict[int, str]:
    """What kind of object each xref is, from its own shape and from what points at it.

    Shape rather than the page's `/Annots` array: after a strip the array is empty,
    and the dictionary it used to name is exactly the object this report has to
    place. Whether anything still points at it is answered separately.
    """
    holder, value = doc.xref_get_key(-1, "Info")
    info_xref = int(value.split()[0]) if holder == "xref" else -1
    heads: dict[int, str] = {}
    for xref in range(1, doc.xref_length()):
        try:
            heads[xref] = re.sub(r"\s+", " ", doc.xref_object(xref, compressed=False))
        except Exception:
            continue
    named = referrers(doc)
    annot_like = re.compile(
        r"/Type /Annot\b|/Subtype /(Widget|Link|FreeText|Text|FileAttachment|Popup|Highlight"
        r"|Strikeout|Underline|Square|Circle|Ink|Stamp|Redact|Caret|Polygon|PolyLine|Squiggly)\b"
    )
    annot_xrefs = {x for x, head in heads.items() if annot_like.search(head)}
    page_xrefs = {
        x for x, head in heads.items()
        if re.search(r"/Type /Page\b(?!s)", head) and "/Kids" not in head
    }
    roles: dict[int, str] = {}
    for xref, head in heads.items():
        owners = {o for o in named.get(xref, [])}
        is_stream = doc.xref_is_stream(xref)
        if xref == info_xref:
            roles[xref] = "the info dictionary"
        elif xref in annot_xrefs:
            roles[xref] = "an annotation or field dictionary"
        elif "/Type /EmbeddedFile" in head:
            roles[xref] = "an attachment payload"
        elif "/Type /Metadata" in head:
            roles[xref] = "the XMP packet"
        elif "/Type /OCG" in head:
            roles[xref] = "a layer definition"
        elif "/Type /ObjStm" in head:
            roles[xref] = "an object stream"
        # Before the "owned by a page" test: a page's automatic action is a script
        # action that merely hangs on the page, not the page's drawing.
        elif re.search(r"/S /JavaScript\b", head) or re.search(r"/JS\b", head):
            roles[xref] = "a script action"
        elif xref in page_xrefs:
            roles[xref] = "a page"
        elif "/Subtype /Form" in head and owners and owners <= annot_xrefs:
            roles[xref] = "an annotation appearance stream"
        elif is_stream and any(x in page_xrefs for x in owners):
            roles[xref] = "a page's content"
        else:
            roles[xref] = "another object"
    return roles


ROLE_OWNERS = {
    "the info dictionary": {"info"},
    "the info dictionary written direct into the trailer": {"info"},
    # A field, a widget or a link is the annotation itself, and the script it runs
    # and the file it carries are written inside it — so its dictionary answers to
    # three switches and to none of them alone.
    "an annotation or field dictionary": {"annotations", "javascript", "attachments"},
    "an annotation appearance stream": {"annotations"},
    "an attachment payload": {"attachments"},
    "the XMP packet": {"metadata"},
    "a layer definition": {"hiddenLayers"},
    "a page's content": {"hiddenLayers"},
    "a page": {"annotations", "javascript", "hiddenLayers"},
    "a script action": {"javascript"},
    # A name-tree node or a catalogue entry: where a named script or a file
    # specification is written inline, which is the shape that hid code before.
    "another object": {"javascript", "attachments", "metadata", "info"},
    "an object stream": set(),
}


def needle_homes(doc, needle: str) -> list[tuple[str, bool]]:
    """`[(role, something points at it)]` for every object still holding the needle."""
    encoded = needle.encode("latin-1", "replace")
    roles = object_roles(doc)
    sources: dict[int, str] = {}
    trailer = doc.xref_object(-1, compressed=False)
    if encoded in trailer.encode("latin-1", "replace"):
        # A file can name its info dictionary direct in the trailer instead of by
        # reference; the trailer itself is then the object holding the value.
        sources[-1] = "the info dictionary written direct into the trailer"
    for xref in range(1, doc.xref_length()):
        try:
            text = doc.xref_object(xref, compressed=False)
        except Exception:
            continue
        bodies = [text.encode("latin-1", "replace")]
        if doc.xref_is_stream(xref):
            try:
                bodies.append(doc.xref_stream(xref) or b"")
            except Exception:
                pass
        # The needle was decoded off the source; a viewer re-escapes what it
        # re-writes, so both spellings are the same payload.
        if any(
            encoded in body or encoded in decode_literals(body)
            for body in bodies
        ):
            sources[xref] = roles.get(xref, "another object")
    out = []
    for xref, role in sorted(sources.items()):
        referenced = any(
            other != xref and re.search(rf"\b{xref} 0 R", safe_object(other, doc) or "")
            for other in range(1, doc.xref_length())
        )
        out.append((role, referenced))
    return out


def safe_object(xref: int, doc) -> str:
    try:
        return doc.xref_object(xref, compressed=False)
    except Exception:
        return ""


def blame(scope: str, homes: list[tuple[str, bool]]) -> bool:
    """Is a leftover this switch's payload, or the same text living elsewhere?

    `/Info` and an XMP packet routinely carry the same title, and a comment's text
    can be printed on the sheet as well as stored on the annotation. Only a copy
    that sits in an object of this scope's own kind counts against the switch.
    """
    return any(scope in ROLE_OWNERS.get(role, set()) for role, _ in homes)


def source_visible(scope: str, signature: dict) -> bool:
    """Would a reader have shown this payload to the user before the run?

    A file can hold an object no reader resolves — `/Annots` on a page-tree node, a
    layer definition with no marked content naming it. Leaving one behind is a
    recording, not a defect; the campaign's bar is what the user's file says.
    """
    poppler_answers = signature.get("poppler") or {}
    if scope == "javascript":
        return poppler_answers.get("javascript") == "yes" or bool(signature.get("script_objects"))
    if scope == "attachments":
        return bool(poppler_answers.get("attached")) or bool(signature.get("mupdf_attachments")) \
            or bool(signature.get("embedded_file_objects"))
    if scope == "metadata":
        return bool(signature.get("xmp_ref"))
    if scope == "info":
        return bool(signature.get("info_ref") or signature.get("info_inline") or signature.get("title"))
    if scope == "annotations":
        return bool(sum(signature.get("annots", [])) or sum(signature.get("links", []))
                    or signature.get("annot_objects"))
    if scope == "hiddenLayers":
        return bool(signature.get("ocgs"))
    return True


def report(entry: dict, scope: str, message: str) -> None:
    """A finding against a payload no reader could see in the first place is recorded."""
    if not source_visible(scope, entry["source_signature"]):
        entry.setdefault("notes", []).append(f"recorded, not a defect (no reader reaches it in the source): {message}")
    else:
        entry["problems"].append(message)


def poppler_render(path: pathlib.Path, limit: int = 2) -> list[np.ndarray]:
    """Page bitmaps from a renderer that did not write the file.

    MuPDF's own `annots=False` pass shifts glyph antialiasing by one 1/255 step when a
    page stops naming annotations (measured: 37 598 px moved on a text sheet whose
    row-by-row ink was identical, and whose dark-pixel count did not move at all), so
    it is the wrong instrument for "did the drawing move". poppler renders the source
    and the switch-off output of the same tool bit for bit the same.
    """
    import tempfile

    with tempfile.TemporaryDirectory() as work:
        stem = pathlib.Path(work) / "p"
        subprocess.run(
            ["pdftoppm", "-r", str(DPI), "-png", "-f", "1", "-l", str(limit), str(path), str(stem)],
            capture_output=True, timeout=180, check=False,
        )
        from PIL import Image

        pages = sorted(stem.parent.glob("p*.png"))
        return [np.asarray(Image.open(page).convert("RGB")) for page in pages]


def mark_rects(doc) -> list[list[tuple[float, float, float, float]]]:
    """Where each page's marks sit, in the bitmap's top-left y-down space.

    Read off the raw `/Rect` of every object the pages and the AcroForm name, not off
    MuPDF's annotation iterator: that one hides widgets, pop-ups and links, and a
    widget's border painted 559 px that an iterator-built control could not see.
    """
    per_page: list[list[tuple[float, float, float, float]]] = []
    for page in doc:
        height = page.rect.height
        found: list[tuple[float, float, float, float]] = []
        for xref in sorted(annotation_xrefs(doc)):
            try:
                head = doc.xref_object(xref, compressed=False)
            except Exception:
                continue
            match = re.search(r"/Rect\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)", head)
            if not match:
                continue
            box = tuple(float(number) for number in match.groups())
            # A `/Rect` whose sheet this is stays; the others simply miss their page.
            owner = re.search(r"/P\s+(\d+)\s+0\s+R", head)
            if owner and int(owner.group(1)) != page.xref:
                continue
            x0, y0, x1, y1 = box
            found.append((x0, height - y1, x1, height - y0))
        per_page.append(found)
    return per_page


RENDERS: dict[str, list[np.ndarray]] = {}


def cached_render(path: pathlib.Path) -> list[np.ndarray]:
    key = str(path)
    if key not in RENDERS:
        RENDERS[key] = poppler_render(path)
    return RENDERS[key]


def drawing_delta(source: pathlib.Path, produced: pathlib.Path) -> tuple[int, int]:
    """`(pixels moved outside any mark, pixels moved inside one)` between two renders."""
    before = cached_render(source)
    after = cached_render(produced)
    rects = mark_rects(pymupdf.open(source))
    scale = DPI / 72.0
    outside = inside = 0
    for index, (a, b) in enumerate(zip(before, after)):
        if a.shape != b.shape:
            return -1, -1
        delta = np.abs(a.astype(int) - b.astype(int)).max(axis=2) > 16
        covered = np.zeros(delta.shape, dtype=bool)
        # MuPDF reports annotation rectangles in the same top-left, y-down space the
        # bitmap rows use — a page-height flip here double-counts the inversion and
        # attributes the mark's own ink to "outside".
        for x0, y0, x1, y1 in rects[index] if index < len(rects) else []:
            covered[
                max(int(y0 * scale) - 3, 0):min(int(y1 * scale) + 3, delta.shape[0]),
                max(int(x0 * scale) - 3, 0):min(int(x1 * scale) + 3, delta.shape[1]),
            ] = True
        inside += int((delta & covered).sum())
        outside += int((delta & ~covered).sum())
    return outside, inside


def orphans(path: pathlib.Path) -> tuple[int, int]:
    """Objects the file still ships that nothing points at, and their byte size.

    The residue a switch leaves when it takes the pointer and not the payload: a
    reader answers "no metadata", and the bytes are still in the download.
    """
    doc = pymupdf.open(path)
    named: set[int] = set()
    for xref in range(1, doc.xref_length()):
        try:
            text = doc.xref_object(xref, compressed=False)
        except Exception:
            continue
        named.update(int(number) for number in re.findall(r"(\d+)\s+0\s+R", text))
    try:
        named.update(int(number) for number in re.findall(
            r"(\d+)\s+0\s+R", doc.xref_object(-1, compressed=False)))
    except Exception:
        pass
    containers = set()
    for xref in range(1, doc.xref_length()):
        head = re.sub(r"\s+", " ", safe_object(xref, doc))
        if "/Type /ObjStm" not in head:
            continue
        containers.add(xref)
        # An object packed into an object stream is named by the stream's own pair
        # list, not by an `N 0 R` anywhere in the file.
        try:
            pairs = (doc.xref_stream(xref) or b"").split(b"~", 1)[0].split()
            count_pairs = int(re.search(r"/N (\d+)", head).group(1))
            first = int(re.search(r"/First (\d+)", head).group(1))
            numbers = [int(token) for token in pairs[: 2 * count_pairs] if token.isdigit()]
            named.update(numbers[0::2])
        except Exception:
            pass
    count = size = 0
    for xref in range(1, doc.xref_length()):
        if xref in named or xref in containers or xref == doc.pdf_catalog():
            continue
        text = safe_object(xref, doc)
        if not text or "unreadable" in text:
            continue
        count += 1
        size += len(text)
        if doc.xref_is_stream(xref):
            try:
                size += len(doc.xref_stream_raw(xref) or b"")
            except Exception:
                pass
    return count, size


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", required=True)
    parser.add_argument("--runs", required=True)
    parser.add_argument("--outdir", required=True)
    parser.add_argument("--log", default="")
    parser.add_argument("--only", default="")
    args = parser.parse_args()

    spec = {run["tag"]: run for run in json.loads(pathlib.Path(args.spec).read_text())}
    records = [json.loads(line) for line in pathlib.Path(args.runs).read_text().splitlines() if line.strip()]
    if args.only:
        keep = set(args.only.split(","))
        records = [record for record in records if record["tag"] in keep]

    judged: dict[str, dict] = {}
    order: list[str] = []
    failures = 0

    for record in records:
        tag = record["tag"]
        source = pathlib.Path(spec[tag]["files"][0])
        fields = spec[tag]["fields"]
        state = {scope: ("on" if fields.get(label) == "1" else "off") for scope, label in LABELS.items() if label in fields}
        produced = [pathlib.Path(item["path"]) for item in record.get("outputs", []) if str(item["path"]).endswith(".pdf")]
        entry = {
            "tag": tag,
            "source": source,
            "state": state,
            "card": card_text(record),
            "problems": [],
            "produced": produced[0] if produced else None,
        }
        # The probe read every control back out of the DOM; a run whose read-back
        # disagrees with the spec is not evidence about the tool.
        for item in record.get("readback", []):
            if not isinstance(item, dict) or item.get("label") not in LABELS.values():
                continue
            want = "true" if item.get("want") == "1" else "false"
            if want not in str(item.get("after", "")):
                entry["problems"].append(f"control {item['label']!r} asked {item.get('want')} read back {item.get('after')}")
        for item in record.get("errors", []):
            entry["problems"].append(f"console error: {item}")
        if not produced:
            entry["problems"].append(f"no output: {record.get('fail')}")
            judged[tag] = entry
            order.append(tag)
            failures += 1
            continue

        out_bytes = haystack(entry["produced"], pymupdf.open(entry["produced"]))
        needles = scope_needles(source)
        entry["needles"] = needles
        entry["hosted"] = hosted_needles(source, needles)
        entry["present"] = {scope: found(list, out_bytes) for scope, list in needles.items()}
        entry["sha"] = hashlib.sha256(entry["produced"].read_bytes()).hexdigest()[:16]
        entry["size"] = entry["produced"].stat().st_size
        entry["signature"] = signature(entry["produced"])
        entry["source_signature"] = signature(source)

        out_doc = pymupdf.open(entry["produced"])
        entry["blamed"] = {}
        for scope, present in entry["present"].items():
            blamed = [
                needle for needle in present
                if blame(scope, needle_homes(out_doc, needle))
            ]
            entry["blamed"][scope] = blamed
        for scope, present in entry["present"].items():
            total = len(needles[scope])
            blamed = entry["blamed"][scope]
            if state.get(scope) == "on" and blamed:
                role, referenced = (needle_homes(out_doc, blamed[0]) or [("(shape)", False)])[0]
                report(
                    entry, scope,
                    f"{scope}: ON and {len(blamed)}/{total} payload(s) still in the bytes "
                    f"({reach(scope, entry['signature'])}) — {blamed[0][:40]!r} in {role}"
                    f"{'' if referenced else ', referenced by nothing'}",
                )
            if state.get(scope) == "on" and present and not blamed:
                entry.setdefault("notes", []).append(
                    f"{scope}: every payload of this kind left; {len(present)} string(s) survive only inside "
                    f"another kind of object ({sorted({r for n in present for r, _ in needle_homes(out_doc, n)})})"
                )
            if state.get(scope) == "off" and len(entry["blamed"][scope]) != total:
                gone = sorted(set(needles[scope]) - set(entry["blamed"][scope]))
                # A payload written into an annotation leaves with the annotation when
                # that switch is on; one that lived nowhere near one has no business going.
                if state.get("annotations") == "on" and all(needle in entry["hosted"] for needle in gone):
                    entry.setdefault("notes", []).append(
                        f"{scope}: {len(gone)}/{total} payload(s) left with their host annotation: {gone[:2]}"
                    )
                else:
                    entry["problems"].append(
                        f"{scope}: OFF and {len(gone)}/{total} payload(s) left anyway — missing {gone[:3]}"
                    )
        # What cannot be reached has to be named: the card says an XFA packet stays.
        entry["xfa_source"] = xfa_bytes(source)
        entry["xfa_output"] = xfa_bytes(entry["produced"])
        if entry["xfa_source"] and state.get("javascript") == "on" and state.get("annotations") == "off":
            if not re.search(r"XFA", entry["card"]):
                entry["problems"].append(
                    f"a {entry['xfa_source']} B XFA packet runs script and the card never says the tool does not read it"
                )
            if entry["xfa_output"] == 0:
                entry["problems"].append(
                    f"the {entry['xfa_source']} B XFA packet left the file, which the card says stays where it is"
                )
        # What the switch did NOT ask about must stay: the sheet's own drawing, judged
        # by a renderer that did not write either file, and only outside the rectangles
        # where a mark was painted (removing marks is what the switch is for).
        src_doc = pymupdf.open(source)
        out_doc = pymupdf.open(entry["produced"])
        if src_doc.page_count != out_doc.page_count:
            entry["problems"].append(f"page count {src_doc.page_count} -> {out_doc.page_count}")
        outside, inside = drawing_delta(source, entry["produced"])
        entry["controls"] = [f"poppler render: {outside} px moved outside any mark, {inside} px inside one"]
        if outside:
            report(
                entry, "annotations",
                f"{outside} px of the sheet's own drawing moved — a structure tool does not repaint",
            )
        if state.get("hiddenLayers") == "on" and state.get("annotations") == "off" and inside:
            report(
                entry, "hiddenLayers",
                f"the hidden layer's removal moved {inside} painted px — the content it deleted was on screen",
            )
        if state.get("annotations") == "off" and state.get("hiddenLayers") == "off" and inside:
            report(
                entry, "attachments",
                f"{inside} px stopped being drawn with the annotation switch off — the mark the attachment "
                "was hung on lost its file and poppler refuses it (“Bad Annot File Attachment”)",
            )
        for index in range(min(src_doc.page_count, out_doc.page_count)):
            if src_doc[index].read_contents() != out_doc[index].read_contents():
                if state.get("hiddenLayers") == "off":
                    report(
                        entry, "annotations",
                        f"page {index + 1} content bytes rewritten with no content switch on",
                    )
        entry["orphans"] = orphans(entry["produced"])
        entry["source_orphans"] = orphans(source)
        entry["problems"] += card_problems(entry)
        judged[tag] = entry
        order.append(tag)
        if entry["problems"]:
            failures += 1

    lines = [f"# sanitize-pdf switch audit — {len(judged)} run(s)\n"]
    for tag in order:
        entry = judged[tag]
        state = " ".join(f"{scope}={value}" for scope, value in sorted(entry["state"].items()))
        lines.append(
            f"\n## {tag} — {entry['source'].name} → {entry['size']} B ({entry['sha']})\n   {state}"
        )
        for scope, present in sorted(entry.get("present", {}).items()):
            total = len(entry["needles"][scope])
            verdict = "removed" if not present else f"{len(present)}/{total} still in the file"
            lines.append(f"   {scope:13} {entry['state'].get(scope, 'n/a'):3}  {total:2} payload(s)  {verdict}")
        lines.append(f"   reader: {json.dumps(entry.get('signature', {}), sort_keys=True)[:300]}")
        lines.append(f"   card: {' | '.join(entry['card'].splitlines())[:420]}")
        lines.append(
            f"   unreferenced objects shipped: {entry['orphans'][0]} ({entry['orphans'][1]} B), "
            f"source had {entry['source_orphans'][0]} ({entry['source_orphans'][1]} B)"
        )
        if entry.get("controls"):
            lines.append(f"   controls: {'; '.join(entry['controls'][:4])}"
                         + (f" (+{len(entry['controls']) - 4} more pages)" if len(entry["controls"]) > 4 else ""))
        for note in entry.get("notes", []):
            lines.append(f"   note: {note}")
        for problem in entry["problems"]:
            lines.append(f"   MISMATCH {problem}")

    # ── the one-switch pairs: identical fixture, one control moved ────────────
    # This is the audit's actual question. The per-run rows above say what each
    # output holds; a pair says what the *switch* did — and a switch whose two
    # outputs differ only in structure, or not at all, does not reach the payload.
    lines.append("\n## one-switch pairs — do the produced bytes move?\n")
    by_source: dict[str, list[str]] = {}
    for tag in order:
        by_source.setdefault(judged[tag]["source"].name, []).append(tag)
    pair_failures = 0
    moved_bytes: dict[str, int] = {}
    for name, tags in sorted(by_source.items()):
        for first in tags:
            for second in tags:
                if first >= second:
                    continue
                one, two = judged[first], judged[second]
                if not one["produced"] or not two["produced"]:
                    continue
                moved = [scope for scope in LABELS if one["state"].get(scope) != two["state"].get(scope)]
                if len(moved) != 1:
                    continue
                scope = moved[0]
                on, off = (first, second) if one["state"][scope] == "on" else (second, first)
                loser, keeper = judged[on], judged[off]
                # Accounted by *ownership*: a copy of the same text that lives inside
                # the XMP packet, or inside an annotation the switch is entitled to
                # rewrite, says nothing about whether this switch reached its object.
                lost = sorted(set(keeper["blamed"].get(scope, [])) - set(loser["blamed"].get(scope, [])))
                gained = sorted(set(loser["blamed"].get(scope, [])) - set(keeper["blamed"].get(scope, [])))
                stayed = sorted(loser["blamed"].get(scope, []))
                total = len(keeper["blamed"].get(scope, []))
                # Collateral the switch is allowed to cause: a payload that lives on an
                # annotation goes with the annotation, and a script or attachment
                # written into one is rewritten by its own switch as well.
                collateral = []
                for key in sorted(keeper["present"]):
                    if key == scope:
                        continue
                    diff = sorted(set(keeper["present"][key]) - set(loser["present"].get(key, [])))
                    if not diff:
                        continue
                    if key in ("javascript", "attachments", "annotations") and all(
                        needle in keeper["hosted"] for needle in diff
                    ):
                        continue
                    collateral.append(f"{key}:{len(diff)}")
                same = loser["sha"] == keeper["sha"]
                reader_delta = [
                    key for key in loser["signature"]
                    if loser["signature"][key] != keeper["signature"][key]
                ]
                problems = []
                if same:
                    problems.append("the two outputs are the SAME BYTES — the switch changed nothing")
                if stayed:
                    problems.append(
                        f"payload stayed: {len(stayed)}/{total} object(s) of this scope's own kind still hold it — "
                        f"{stayed[0][:40]!r} ({reach(scope, loser['signature'])})"
                    )
                elif total and not lost:
                    problems.append(f"the bytes moved and none of the scope's {total} payload(s) did")
                elif total and lost and len(lost) < total:
                    problems.append(f"partial: {len(lost)}/{total} payload(s) left, {stayed[:2]} stayed")
                if gained:
                    problems.append(f"switching it on ADDED payload back: {gained[:2]}")
                if collateral:
                    problems.append(f"unrelated payloads moved: {collateral}")
                verdict = "PROBLEM — " + "; ".join(problems) if problems else "MOVES BYTES"
                if problems and not source_visible(scope, keeper["source_signature"]):
                    verdict = ("MOVES BYTES (recorded: the payload no reader reaches in this shape) "
                               if not same else "UNCHANGED (recorded: the payload no reader reaches in this shape)")
                elif problems:
                    pair_failures += 1
                else:
                    moved_bytes[scope] = moved_bytes.get(scope, 0) + 1
                lines.append(
                    f"   {name:22} {scope:13} {on} vs {off}: {keeper['size']} B → {loser['size']} B,"
                    f" {len(lost)} payload(s) removed, reader answers that changed: {reader_delta or 'none'}"
                    f" — {verdict}"
                )
    lines.append("\n## pairs that move bytes, per switch\n")
    for scope in LABELS:
        lines.append(f"   {scope:13} {moved_bytes.get(scope, 0)}")

    # One row per switch: every fixture it was driven on, and what the bytes said.
    lines.append("\n## per-switch summary\n")
    for scope in LABELS:
        on_runs = [tag for tag in order if judged[tag]["state"].get(scope) == "on"]
        off_runs = [tag for tag in order if judged[tag]["state"].get(scope) == "off"]
        stayed = sorted({
            judged[tag]["source"].name
            for tag in on_runs
            if judged[tag]["blamed"].get(scope)
        })
        inert = sorted({
            judged[tag]["source"].name
            for tag in off_runs
            if judged[tag]["blamed"].get(scope)
            and any(
                judged[other]["sha"] == judged[tag]["sha"]
                for other in on_runs
                if judged[other]["source"] == judged[tag]["source"]
            )
        })
        removed = sorted({
            judged[tag]["source"].name
            for tag in on_runs
            if not judged[tag]["blamed"].get(scope) and judged[tag]["present"].get(scope) == []
        })
        lines.append(
            f"   {scope:13} driven on {len(on_runs)} run(s) over {len({judged[t]['source'].name for t in on_runs})} file(s);"
            f" payload gone on {len(removed)} file(s){'; payload LEFT on ' + ', '.join(stayed) if stayed else ''}"
            f"{'; the ON and OFF outputs are identical on ' + ', '.join(inert) if inert else ''}"
        )
    failures += pair_failures

    lines.append(f"\n## verdict\n\n{len(judged)} run(s), {failures} with a mismatch (runs + pairs)\n")
    text = "\n".join(lines)
    print(text)
    if args.log:
        pathlib.Path(args.log).write_text(text + "\n")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
