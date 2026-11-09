#!/usr/bin/env python3
"""
Judge the font-subset probe PDFs by pixels and by three independent readers.

  python3 docs/research/font-subset-measure.py /tmp/fsb [--json] [--tag TAG] [--dpi 150]

For every probe PDF produced by `font-subset-build.mjs` this reports, per
character (one character per row, so a row is a glyph):

* **MuPDF ink** — non-white pixels inside that character's own box, measured off
  the produced file, next to the **reference ink**: the same character drawn by
  MuPDF itself with the untouched source face, at the same size and place. A
  glyph is *lost* when the reference has ink and the produced file has none,
  which is the user report "the page is blank but the text copies fine".
* **fontTools** — the font program is read back out of the file, the character is
  mapped the way a viewer maps it (`/ToUnicode` → code → `/CIDToGIDMap` → glyph
  id), the **glyph program is decompiled and compared against the same glyph in
  the unsubsetted source face**. For a TrueType subset the `loca` entries are
  audited against the glyph records themselves, so the report names the byte
  range where the file lies about where a glyph begins.
* **pdf.js** — `font-subset-pdfjs.mjs` paints the same files in Chromium and
  writes `pdfjs<TAG>.json` next to the layout; when present its lost-glyph count
  and its warnings join the same row.

`--json` writes the whole detail to `measured<TAG>.json`.
"""
import io
import json
import os
import re
import struct
import sys
import tempfile

import pymupdf
from fontTools.ttLib import TTFont

# TrueType simple-glyph flag bits.
ON_CURVE = 0x01
X_SHORT = 0x02
Y_SHORT = 0x04
REPEAT = 0x08
SAME_X = 0x10
SAME_Y = 0x20
# Composite flag bits.
ARG_WORDS = 0x0001
MORE_COMPONENTS = 0x0020
WE_HAVE_A_SCALE = 0x0008
WE_HAVE_XY_SCALE = 0x0040
WE_HAVE_TWO_BY_TWO = 0x0080

TTF_VERSIONS = (b"\x00\x01\x00\x00", b"true")
# A glyf record is followed by long-word padding; more than this and `loca` and
# the record itself are describing different glyphs.
MAX_PAD = 3


def u8(data, i):
    return data[i]


def s16(data, i):
    return struct.unpack_from(">h", data, i)[0]


def s8(data, i):
    return struct.unpack_from(">b", data, i)[0]


def u16(data, i):
    return struct.unpack_from(">H", data, i)[0]


def u32(data, i):
    return struct.unpack_from(">I", data, i)[0]


def glyph_records(data, offset, count):
    """Decompile `count` TrueType glyph records starting at `offset`.

    Each entry is `{"empty": True}`, a simple outline (`contours`/`flags`/`x`/`y`
    with absolute coordinates) or a composite (`components`). The second return
    value is the offset just past the last record — which is how a `loca` entry
    can be checked against the table it indexes. Raises IndexError/struct.error
    when a record runs past the table, i.e. when the index points into the middle
    of a glyph.
    """
    out = []
    pos = offset
    for _ in range(count):
        contours = s16(data, pos)
        box = (s16(data, pos + 2), s16(data, pos + 4), s16(data, pos + 6), s16(data, pos + 8))
        if contours == 0 and box == (0, 0, 0, 0):
            out.append({"empty": True})
            pos += 10
            continue
        if contours > 0:
            ends = [u16(data, pos + 10 + 2 * i) for i in range(contours)]
            n_points = ends[-1] + 1 if ends else 0
            at = pos + 10 + 2 * contours
            instr_len = u16(data, at)
            at += 2 + instr_len
            flags = []
            while len(flags) < n_points:
                flag = u8(data, at)
                at += 1
                flags.append(flag)
                if flag & REPEAT:
                    # One repeat byte, then that many more entries: the bytes
                    # consumed do not grow with the count.
                    repeat = u8(data, at)
                    at += 1
                    for _ in range(repeat):
                        if len(flags) < n_points:
                            flags.append(flag & ~REPEAT)
            xs, x = [], 0
            for flag in flags:
                if flag & X_SHORT:
                    step = u8(data, at)
                    at += 1
                    x += step if flag & SAME_X else -step
                elif not (flag & SAME_X):
                    x += s16(data, at)
                    at += 2
                xs.append(x)
            ys, y = [], 0
            for flag in flags:
                if flag & Y_SHORT:
                    step = u8(data, at)
                    at += 1
                    y += step if flag & SAME_Y else -step
                elif not (flag & SAME_Y):
                    y += s16(data, at)
                    at += 2
                ys.append(y)
            out.append({
                "simple": True,
                "contours": ends,
                "flags": [f & (ON_CURVE | SAME_X | SAME_Y) for f in flags],
                "x": xs,
                "y": ys,
            })
            pos = at
        else:
            components = []
            at = pos + 10
            while True:
                flag = u16(data, at)
                gid = u16(data, at + 2)
                at += 4
                # ARG_1_AND_2_ARE_WORDS says two 16-bit values; otherwise each
                # argument is a single signed byte.
                if flag & ARG_WORDS:
                    args = (s16(data, at), s16(data, at + 2))
                    at += 4
                else:
                    args = (s8(data, at), s8(data, at + 1))
                    at += 2
                scales = []
                if flag & WE_HAVE_A_SCALE:
                    scales.append(s16(data, at) / 16384)
                    at += 2
                elif flag & WE_HAVE_XY_SCALE:
                    scales.extend([s16(data, k) / 16384 for k in (at, at + 2)])
                    at += 4
                elif flag & WE_HAVE_TWO_BY_TWO:
                    scales.extend([s16(data, k) / 16384 for k in (at, at + 2, at + 4, at + 6)])
                    at += 8
                components.append({"flags": flag, "gid": gid, "args": args, "scales": scales})
                if not (flag & MORE_COMPONENTS):
                    break
            out.append({"composite": components, "bbox": box})
            pos = at
    return out, pos


def sfnt_version(data):
    return bytes(data[:4]) if len(data) >= 4 else b""


def sfnt_tables(data):
    """tag -> (offset, length) for an sfnt."""
    if len(data) < 12:
        return {}
    out = {}
    for i in range(u16(data, 4)):
        r = 12 + i * 16
        out[bytes(data[r:r + 4]).decode("latin1")] = (u32(data, r + 8), u32(data, r + 12))
    return out


def wrap_cff(cff):
    """Put a bare CFF program in a one-table OTTO sfnt so fontTools can read it."""
    header = struct.pack(">IHHHH", 0x4F54544F, 1, 16, 0, 0)
    record = b"CFF " + struct.pack(">III", 0, 28, len(cff))
    return header + record + cff + b"\0" * ((4 - len(cff) % 4) % 4)


def utf16_hex_to_codepoint(value):
    """A CMap destination as a code point.

    A destination is a UTF-16BE string, so a writer that spells an astral code
    point as a surrogate pair gives eight hex digits; anything above the Unicode
    range is decoded that way instead of being read as one number. A conforming
    writer emits one code unit per BMP character, and `surrogate` is what counts
    how many destinations arrived as a pair.
    """
    raw = int(value, 16)
    if raw <= 0x10FFFF and len(value) <= 4:
        return raw, False
    text = bytes.fromhex(value + ("0" * (len(value) % 2))).decode("utf-16-be", "replace")
    return (ord(text[0]) if text else raw), True


def cmap_to_unicode(stream):
    """code point -> character code, plus how many destinations were surrogate pairs."""
    text = stream.decode("latin1", "replace")
    pairs = {}
    surrogates = 0
    for block in re.findall(r"beginbfchar(.*?)endbfchar", text, re.S):
        for src, dst in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", block):
            code_point, paired = utf16_hex_to_codepoint(dst)
            surrogates += 1 if paired else 0
            pairs[code_point] = int(src, 16)
    for block in re.findall(r"beginbfrange(.*?)endbfrange", text, re.S):
        # A destination that is an array (`<lo> <hi> [<a> <b>]`) is not this shape;
        # no writer in this app emits one, and the count below says if we met one.
        for lo, hi, dst in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>(?!\s*\])", block):
            base, paired = utf16_hex_to_codepoint(dst)
            surrogates += 1 if paired else 0
            for i in range(int(hi, 16) - int(lo, 16) + 1):
                pairs[base + i] = int(lo, 16) + i
    return pairs, surrogates


def cid_to_gid(doc, ref):
    """The `/CIDToGIDMap` stream of a descendant CIDFont, or None for Identity."""
    kind, value = doc.xref_get_key(ref, "CIDToGIDMap")
    if kind != "xref":
        return None
    data = doc.xref_stream(int(value.split()[0]))
    if not data:
        return None
    return [struct.unpack_from(">H", data, i * 2)[0] for i in range(len(data) // 2)]


def embedded_fonts(doc, page_number=0):
    """Every Type0 font of a page, with the program and the maps a viewer uses."""
    out = {}
    for xref, *_rest in doc.get_page_fonts(page_number, full=True):
        if doc.xref_get_key(xref, "Subtype")[1] != "/Type0":
            continue
        base = doc.xref_get_key(xref, "BaseFont")[1]
        kind, desc = doc.xref_get_key(xref, "DescendantFonts")
        # `[10 0 R]` and `10 0 R` are both shapes PyMuPDF answers with here.
        head = re.search(r"\d+", desc or "")
        ref = int(head.group(0)) if kind in ("array", "xref", "dict") and head else None
        if ref is None:
            continue
        info = {
            "base": base,
            "subtype": doc.xref_get_key(ref, "Subtype")[1],
            "program": None,
            "programKey": None,
            "toUnicode": {},
            "toUnicodeSurrogates": 0,
            "gidOfCode": None,
            "w": doc.xref_get_key(ref, "W")[1],
        }
        k, tu = doc.xref_get_key(xref, "ToUnicode")
        if k == "xref":
            stream = doc.xref_stream(int(tu.split()[0]))
            if stream:
                info["toUnicode"], info["toUnicodeSurrogates"] = cmap_to_unicode(stream)
        info["gidOfCode"] = cid_to_gid(doc, ref)
        _k, fd = doc.xref_get_key(ref, "FontDescriptor")
        if fd:
            fd_ref = int(fd.split()[0])
            for key in ("FontFile2", "FontFile3", "FontFile"):
                kk, vv = doc.xref_get_key(fd_ref, key)
                if kk == "xref":
                    info["program"] = doc.xref_stream(int(vv.split()[0]))
                    info["programKey"] = key
                    break
        out[base] = info
    return out


def parse_program(info):
    """A fontTools view of the program, plus what kind of program it is."""
    program = bytes(info["program"] or b"")
    version = sfnt_version(program)
    kind = "CFF" if version == b"OTTO" else "TTF" if version in TTF_VERSIONS else None
    font = None
    error = None
    try:
        if kind is None and version[:1] == b"\x01":
            # A bare CFF program (the payload of FontFile3 /CIDFontType0C), which
            # fontTools only reads inside an sfnt wrapper.
            kind = "CFF"
            font = TTFont(io.BytesIO(wrap_cff(program)))
        else:
            font = TTFont(io.BytesIO(program))
    except Exception as exc:  # the reader that matters failed; say which and how
        error = f"{type(exc).__name__}: {exc}"[:160]
    return kind, font, error, len(program)


def audit_cff_header(program):
    """Whether a CFF header points at the Name INDEX that is actually there.

    A CFF header is `major, minor, hdrSize, firstOffset`, and `firstOffset` is the
    absolute offset of the Name INDEX. FreeType honours it and rejects the whole
    font when it is wrong; fontTools walks the indexes sequentially and never
    notices — which is why one reader can call the same program clean.
    """
    if len(program) < 6 or program[0] != 1:
        return None
    hdr_size, first_offset = program[2], program[3]
    looks_like_index = (
        hdr_size + 3 <= len(program)
        and program[hdr_size:hdr_size + 2] != b"\x00\x00"  # count >= 1
        and 1 <= program[hdr_size + 2] <= 4                # offset size
    )
    if first_offset == hdr_size or not looks_like_index:
        return None
    return {
        "firstOffset": first_offset,
        "nameIndexAt": hdr_size,
        "bytes": (
            f"the CFF header says the Name INDEX begins at byte {first_offset}, but it begins at "
            f"byte {hdr_size} (hdrSize); FreeType/MuPDF read the header and reject the font"
        ),
    }


_SOURCE_CACHE = {}


def source_glyph_map(path):
    if path in _SOURCE_CACHE:
        return _SOURCE_CACHE[path]
    font = TTFont(path, lazy=True)
    cmap = font.getBestCmap() or {}
    names = {name: i for i, name in enumerate(font.getGlyphOrder())}
    pair = (font, {cp: names[name] for cp, name in cmap.items() if name in names})
    _SOURCE_CACHE[path] = pair
    return pair


def truetype_outline(font, gid):
    """The glyph record a viewer would paint for `gid`, decompiled."""
    if font is None or "glyf" not in font:
        return None
    order = font.getGlyphOrder()
    if gid >= len(order):
        return {"error": f"glyph {gid} is past the end of the subset ({len(order)} glyphs)"}
    data = bytes(font.reader["glyf"])
    loca = list(font["loca"].locations)
    start = loca[gid]
    end = loca[gid + 1] if gid + 1 < len(loca) else len(data)
    if end <= start:
        return {"empty": True}
    try:
        one, _ = glyph_records(data, start, 1)
    except (IndexError, struct.error) as exc:
        return {"error": f"{type(exc).__name__} reading the record at byte {start}"}
    return one[0] if one else {"error": "no record"}


def cff_outline(font, gid):
    """The charstring a viewer would paint for `gid`, as drawn path commands.

    The charstring is drawn directly rather than through `font.getGlyphSet()`,
    which needs an `hmtx` table that a bare CFF program (the payload of
    FontFile3) does not carry.
    """
    if font is None or "CFF " not in font:
        return None
    try:
        from fontTools.pens.recordingPen import RecordingPen

        order = font.getGlyphOrder()
        if gid >= len(order):
            return {"error": f"glyph {gid} is past the end of the subset ({len(order)} glyphs)"}
        top = font["CFF "].cff.topDictIndex[0]
        pen = RecordingPen()
        top.CharStrings[order[gid]].draw(pen)
        commands = [c[0] for c in pen.value]
        empty = not any(c == "moveTo" for c in commands)
        return {"empty": True} if empty else {"commands": commands}
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"[:120]}


def same_outline(a, b):
    """True when two glyph programs draw the same outline."""
    if a is None or b is None:
        return None
    if "error" in a or "error" in b:
        return False
    if bool(a.get("empty")) != bool(b.get("empty")):
        return False
    if a.get("empty"):
        return True
    if "commands" in a or "commands" in b:
        return a.get("commands") == b.get("commands")
    if "composite" in a or "composite" in b:
        if "composite" not in a or "composite" not in b or len(a["composite"]) != len(b["composite"]):
            return False
        # A subset renumbers the glyphs it keeps, so the component ids legitimately
        # change; what must not change is how many there are and where they land.
        return all(
            x["flags"] == y["flags"] and x["args"] == y["args"] and x["scales"] == y["scales"]
            for x, y in zip(a["composite"], b["composite"], strict=False)
        )
    return (
        a.get("contours") == b.get("contours")
        and a.get("flags") == b.get("flags")
        and a.get("x") == b.get("x")
        and a.get("y") == b.get("y")
    )


def audit_loca(font):
    """`loca` entries that disagree with the glyph records the table holds.

    Every TrueType glyph states its own length, so the table is its own witness.
    Two separate disagreements are counted, because they mean different things:

    * `misaligned` — a glyph record that does not begin on a 4-byte boundary. A
      source face may legally say so (its `loca` is 32-bit); a *subset* whose
      index is the 16-bit half-offset form cannot, because half of an odd offset
      is rounded down and every later glyph then starts inside the wrong record.
    * `wrongSpan` — the bytes `loca` gives a glyph are not the bytes the record
      occupies, beyond the long-word padding a record is allowed to end with.
    """
    data = bytes(font.reader["glyf"])
    loca = list(font["loca"].locations)
    count = font["maxp"].numGlyphs
    misaligned = []
    wrong_span = []
    for i in range(count):
        start = loca[i] if i < len(loca) else len(data)
        end = loca[i + 1] if i + 1 < len(loca) else len(data)
        if end == start:
            continue  # an empty glyph carries no record to disagree with
        if start % 4:
            misaligned.append({"glyph": i, "offset": start, "locaSays": end - start})
        stated = None
        try:
            one, after = glyph_records(data, start, 1)
            if one and "error" not in one[0]:
                stated = after - start
        except (IndexError, struct.error):
            stated = None
        if stated is None or not 0 <= (end - start) - stated <= MAX_PAD:
            wrong_span.append({"glyph": i, "offset": start, "locaSays": end - start, "recordSays": stated})
    if not misaligned and not wrong_span:
        return None
    parts = []
    if misaligned:
        first = misaligned[0]
        parts.append(
            f"{len(misaligned)} of {count} glyph records do not start on a 4-byte boundary "
            f"(glyph {first['glyph']} at byte {first['offset']})"
        )
    if wrong_span:
        first, last = wrong_span[0], wrong_span[-1]
        parts.append(
            f"{len(wrong_span)} of {count} entries give a glyph a different number of bytes than "
            f"its record occupies (glyph {first['glyph']} at byte {first['offset']}: loca says "
            f"{first['locaSays']}, the record is {first['recordSays']}"
            + ("" if last == first else f", and the same disagreement runs to glyph {last['glyph']} at byte {last['offset']}")
            + ")"
        )
    return {
        "misaligned": len(misaligned),
        "wrongSpan": len(wrong_span),
        "of": count,
        "firstSpan": wrong_span[0] if wrong_span else None,
        "bytes": "; ".join(parts),
    }


def char_boxes(doc):
    """Every single character MuPDF reads in the document, with its box."""
    boxes = {}
    for page in doc:
        raw = page.get_text(
            "rawdict", flags=pymupdf.TEXT_PRESERVE_LIGATURES | pymupdf.TEXT_PRESERVE_WHITESPACE
        )
        for block in raw.get("blocks", []):
            for line in block.get("lines", []):
                for span in line.get("spans", []):
                    for ch in span.get("chars", []):
                        text = ch.get("c", "")
                        if len(text) != 1 or text.strip() == "":
                            continue
                        boxes.setdefault(text, (pymupdf.Rect(ch["bbox"]), page.number))
    return boxes


def ink_of(page, rect, dpi, default=None):
    if default is not None:
        return default
    clip = (rect + (-1, -1, 1, 1)) & page.rect
    if clip.is_empty:
        return 0
    pix = page.get_pixmap(dpi=dpi, clip=clip, colorspace=pymupdf.csRGB)
    data, n = pix.samples, pix.n
    return sum(
        1
        for i in range(pix.width * pix.height)
        if data[i * n] < 245 or data[i * n + 1] < 245 or data[i * n + 2] < 245
    )


def ink_per_box(doc, boxes, dpi):
    bitmaps = {}
    for _rect, page_number in boxes.values():
        if page_number not in bitmaps:
            bitmaps[page_number] = doc[page_number].get_pixmap(dpi=dpi)
    out = {}
    zoom = dpi / 72.0
    for ch, (rect, page_number) in boxes.items():
        pix = bitmaps[page_number]
        x0, y0 = max(0, int((rect.x0 - 1) * zoom)), max(0, int((rect.y0 - 1) * zoom))
        x1, y1 = min(pix.width, int((rect.x1 + 1) * zoom)), min(pix.height, int((rect.y1 + 1) * zoom))
        data, n, stride = pix.samples, pix.n, pix.stride
        dark = 0
        for y in range(y0, max(y0, y1)):
            row = y * stride
            for x in range(x0, max(x0, x1)):
                off = row + x * n
                if data[off] < 245 or data[off + 1] < 245 or data[off + 2] < 245:
                    dark += 1
        out[ch] = dark
    return out


def reference_ink(source_path, chars, geometry, dpi):
    """What the untouched face paints for the same characters, measured the same way.

    MuPDF writes this reference itself, with its own subsetter, so it is a second
    producer rather than the code under test: a glyph that has ink here and none in
    the probe file was lost by this app's writer, not by the face. The rows land at
    the same x, step and size as the probe, and the ink is read out of the same
    per-character boxes, so the two numbers are comparable glyph for glyph.
    """
    with open(source_path, "rb") as fh:
        buffer = fh.read()
    step = geometry["baselineStep"]
    margin = geometry["margin"]
    size = geometry["fontSize"]
    height = 297 * 2  # two pages' worth of points: tall enough for any probe range
    per_page = max(1, int((height - 2 * margin) // step))
    doc = pymupdf.open()
    page = doc.new_page(width=min(geometry["pageWidth"], 595), height=height)
    page.insert_font(fontname="F0", fontbuffer=buffer)
    for index, ch in enumerate(chars):
        if index and index % per_page == 0:
            page = doc.new_page(width=min(geometry["pageWidth"], 595), height=height)
            # Registered per page: `insert_text` names a font, and the bytes only
            # reach MuPDF through `insert_font`.
            page.insert_font(fontname="F0", fontbuffer=buffer)
        row = index % per_page
        page.insert_text((margin, height - margin - (row + 1) * step + 6), ch, fontname="F0", fontsize=size)
    handle, path = tempfile.mkstemp(suffix=".pdf")
    os.close(handle)
    try:
        doc.save(path)
    finally:
        doc.close()
    try:
        ref = pymupdf.open(path)
        ink = ink_per_box(ref, char_boxes(ref), dpi)
        ref.close()
    finally:
        os.unlink(path)
    return ink


def measure_face(face, out_dir, dpi):
    pdf_path = os.path.join(out_dir, face["pdf"])
    pymupdf.TOOLS.reset_mupdf_warnings()
    doc = pymupdf.open(pdf_path)
    boxes = char_boxes(doc)
    produced = ink_per_box(doc, boxes, dpi)
    doc.close()
    # Only what MuPDF said while reading *this* file. The reference pass below
    # drives MuPDF over the untouched face, and its complaints are not this row.
    mupdf_warnings = (pymupdf.TOOLS.mupdf_warnings() or "").strip()[:400]
    fonts = embedded_fonts(pymupdf.open(pdf_path))

    source_path = face.get("sourceFace")
    if source_path and not os.path.isabs(source_path):
        source_path = os.path.join(out_dir, source_path)
    source_font = source_map = None
    reference = {}
    if source_path and os.path.exists(source_path):
        source_font, source_map = source_glyph_map(source_path)
        geometry = {
            "baselineStep": face["baselineStep"],
            "margin": face["margin"],
            "fontSize": face["fontSize"],
            "pageWidth": face["pageWidth"],
        }
        reference = reference_ink(source_path, face["chars"], geometry, dpi)

    rows = []
    programs = []
    loca_report = None
    cff_report = None
    for info in fonts.values():
        kind, font, error, size = parse_program(info)
        if not info["program"]:
            programs.append(f"{info['base']}: no font program — a standard 14 reference, painted from the viewer's own face")
        else:
            slot = ""
            if kind == "CFF" and info["programKey"] != "FontFile3":
                slot = f" — a CFF program in the TrueType slot ({info['programKey']}) of a {info['subtype']} font"
            elif kind == "TTF" and info["programKey"] != "FontFile2":
                slot = f" — a TrueType program in {info['programKey']} of a {info['subtype']} font"
            programs.append(
                f"{info['base']}: {info['programKey']} holding a {kind or 'unreadable'} program of {size} B "
                f"from a {face.get('sourceFaceBytes')} B face, descendant {info['subtype']}, "
                f"/ToUnicode covers {len(info['toUnicode'])} code points"
                + (f" of them written as {info['toUnicodeSurrogates']} surrogate pairs" if info["toUnicodeSurrogates"] else "")
                + f", fontTools {'parses' if font else 'FAILS: ' + str(error)}{slot}"
            )
            if kind == "CFF":
                cff_report = audit_cff_header(bytes(info["program"])) or cff_report
        if font is not None and "glyf" in font:
            loca_report = audit_loca(font)
        for code_point, code in sorted(info["toUnicode"].items(), key=lambda kv: kv[1]):
            ch = chr(code_point)
            if ch not in boxes:
                continue
            gid = info["gidOfCode"][code] if info["gidOfCode"] and code < len(info["gidOfCode"]) else code
            if font is not None and "CFF " in font:
                subset_glyph = cff_outline(font, gid)
                source_glyph = cff_outline(source_font, source_map[ord(ch)]) if source_map and ord(ch) in source_map else None
            else:
                subset_glyph = truetype_outline(font, gid)
                source_glyph = truetype_outline(source_font, source_map[ord(ch)]) if source_map and ord(ch) in source_map else None
            same = same_outline(subset_glyph, source_glyph)
            empty_source = bool(source_glyph and source_glyph.get("empty"))
            rows.append({
                "char": ch,
                "code": code,
                "gid": gid,
                "ink": produced.get(ch, 0),
                "reference": reference.get(ch),
                "outline": "ok" if same else ("different" if same is False else "not comparable"),
                "emptyInSource": empty_source,
                "error": (subset_glyph or {}).get("error") if isinstance(subset_glyph, dict) else None,
            })
    if not rows and boxes:
        # A simple (non-Type0) font, e.g. a standard 14 reference: the viewer
        # paints it from its own face, so there is no program to compare and the
        # only question is whether the page has ink.
        for ch, (_rect, _page) in sorted(boxes.items()):
            rows.append({
                "char": ch,
                "code": None,
                "gid": None,
                "ink": produced.get(ch, 0),
                "reference": reference.get(ch),
                "outline": "not comparable",
                "emptyInSource": False,
                "error": None,
            })
    return {
        "id": face["id"],
        "label": face["label"],
        "via": face["via"],
        "flavour": face["flavour"],
        "appSeesCff": face.get("appSeesCff"),
        "faceName": face["faceName"],
        "pdf": face["pdf"],
        "pdfBytes": os.path.getsize(pdf_path),
        "sourceFaceBytes": face.get("sourceFaceBytes"),
        "programs": programs,
        "mupdfWarnings": mupdf_warnings,
        "loca": loca_report,
        "cff": cff_report,
        "rows": rows,
        "drawn": len(face.get("chars", [])),
        "refused": face.get("refused", []),
    }


def classify(result):
    """The counts a row of the table is made of.

    A glyph is *lost* when the source face has an outline for it and the produced
    file paints nothing. The MuPDF-drawn reference is reported beside it as a
    second witness — it is not the gate, because MuPDF's own subsetting of a
    CFF face is lossy and would hide real losses.
    """
    drawable = [r for r in result["rows"] if not r["emptyInSource"]]
    lost = [r for r in drawable if r["ink"] == 0]
    unverified = [r for r in lost if not r["reference"]]
    mismatched = [r for r in drawable if r["outline"] == "different"]
    return drawable, lost, unverified, mismatched


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "fsb")
    tag = ""
    dpi = 150
    for i, arg in enumerate(sys.argv):
        if arg == "--tag":
            tag = "-" + sys.argv[i + 1]
        if arg == "--dpi":
            dpi = int(sys.argv[i + 1])
    with open(os.path.join(out_dir, f"layout{tag}.json"), encoding="utf-8") as fh:
        layout = json.load(fh)
    pdfjs_path = os.path.join(out_dir, f"pdfjs{tag}.json")
    pdfjs = {}
    if os.path.exists(pdfjs_path):
        with open(pdfjs_path, encoding="utf-8") as fh:
            pdfjs = {row["id"]: row for row in json.load(fh)["faces"]}

    results = [measure_face(face, out_dir, dpi) for face in layout["faces"]]

    print(f"per-glyph ink, MuPDF at {dpi} dpi, reference = the same face drawn by MuPDF itself\n")
    print(f"{'face':20} {'flavour':7} {'cff guard':9} {'glyphs':6} {'lost':5} {'program':7} {'mupdf':6} {'pdf.js':6} {'first lost':10} {'KB':>7}")
    for result in results:
        drawable, lost, _unverified, mismatched = classify(result)
        order = {r["char"]: i for i, r in enumerate(result["rows"])}
        first = min((order[r["char"]] for r in lost), default=None)
        pj = pdfjs.get(result["id"])
        warn = "clean"
        if result["mupdfWarnings"]:
            warn = result["mupdfWarnings"].splitlines()[0][:22]
        print(
            f"{result['id']:20} {result['flavour']:7} "
            f"{('fires' if result['appSeesCff'] else 'dead'):9} "
            f"{len(drawable):6} {len(lost):5} {len(mismatched):7} {warn:>6} "
            f"{(str(pj['lost']) if pj else '-'):>6} "
            f"{('row ' + str(first)) if first is not None else '-':>10} "
            f"{result['pdfBytes'] / 1024:7.1f}"
        )
    print()
    for result in results:
        drawable, lost, unverified, mismatched = classify(result)
        if not lost and not mismatched and not result["loca"] and not result["cff"] and not result["mupdfWarnings"]:
            continue
        print(f"## {result['id']} — {result['label']} ({result['flavour']} face, via {result['via']})")
        for line in result["programs"]:
            print("   " + line)
        if result["mupdfWarnings"]:
            print(f"   MuPDF: {result['mupdfWarnings'].splitlines()[0]}")
        if result["loca"]:
            print(f"   loca: {result['loca']['bytes']}")
        if result["cff"]:
            print(f"   CFF header: {result['cff']['bytes']}")
        if lost:
            print(f"   lost ink ({len(lost)} of {len(drawable)}): {''.join(sorted(r['char'] for r in lost))[:140]}")
            shown = ", ".join(f"{r['char']} {r['ink']}/{r['reference']}" for r in lost[:6])
            print(f"   ink produced/reference: {shown}")
        if unverified:
            print(f"   lost ink with no MuPDF reference either ({len(unverified)} of {len(lost)} lost)"
                  f": {''.join(sorted(r['char'] for r in unverified))[:80]}")
        if mismatched:
            print(f"   glyph program differs from the source face ({len(mismatched)}): "
                  f"{''.join(sorted(r['char'] for r in mismatched))[:140]}")
            for r in [m for m in mismatched if m.get("error")][:2]:
                print(f"   {r['char']}: {r['error']}")
        print()
    if "--json" in sys.argv:
        target = os.path.join(out_dir, f"measured{tag}.json")
        with open(target, "w", encoding="utf-8") as fh:
            json.dump(results, fh, indent=1, default=str)
        print(f"wrote {target}")


if __name__ == "__main__":
    main()
