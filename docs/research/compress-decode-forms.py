#!/usr/bin/env python3
"""Build the four decode shapes round 022 measured, and judge them in the bytes.

`pdf-compress` has to turn stored image samples into a picture it can re-encode.
Four shapes reach that decode and each has a different way of failing quietly:

  * `dct`       — `/Filter /DCTDecode`: the browser's own JPEG decoder; the
                  fixture the campaign queue ships (`heavy.pdf`) is all of these,
                  so it is the only path that has ever been driven.
  * `flate`     — `/Filter /FlateDecode`, 8-bit samples, no predictor: the inflate
                  path that feeds `putImageData`.
  * `raw`       — no `/Filter` at all: the stream *is* the samples.
  * `ccitt`     — `/Filter /CCITTFaxDecode`, 1-bit fax rows: an encoding the tool
                  does not decode at all, so the check is that the untouched
                  stream survives the rebuild and still decodes in a reader.

Three more shapes that each broke in their own way are still built:

  * `predicted`— `/FlateDecode` with `/DecodeParms /Predictor 12`: every row is a
                 difference from the row above, so the bytes are not pixels.
  * `indexed`  — `/ColorSpace [/Indexed /DeviceRGB …]`: one byte per pixel is an
                 index into a palette, not a grey level.
  * `alpha-raw`— a picture with an unfiltered `/SMask`: the mask is read through
                 the same decode as the picture, so it fails the same way.

The fixtures are written by hand as PDF 1.5 (`pymupdf` only reads them back), so
the shape is exactly the one named and nothing re-serialises it.

Usage:
    python3 docs/research/compress-decode-forms.py --build /tmp/x
    python3 docs/research/compress-decode-forms.py --judge SRC OUT [SRC OUT …]

`--judge` prints one row per pair: the page box, ink at 72 dpi, the stored
`/Width`/`/Height`/`/Filter` of every image and the two corner samples. A file
that opens, has the right page, but the wrong corners is the shape this round was
about. Per image it also reports **`decodes`** — `doc.extract_image` + PIL, i.e.
the picture taken back out of the bytes the tool wrote — and the non-white pixel
count *inside that image*: a stream that survives as an object but decodes to a
black box, to moiré, or to nothing is a defect even when the page still looks
plausible. The untouched source measured the same way is the control, and a
re-encode has to keep at least 95 % of the image's own ink (the same bound the
page render uses; downsampling hard edges loses a little anti-aliased rim).
"""
import contextlib
import hashlib
import io
import json
import os
import shutil
import sys
import tempfile
import zlib

import numpy as np
import pymupdf
from PIL import Image


def ink_of(pix, threshold=250):
    """Non-white sample count of a MuPDF raster, in C rather than in a Python loop.

    The definition is the one round 022 recorded its numbers under: every byte of
    the RGB buffer below the threshold counts, so a page of colour text scores its
    three channels. `pix.samples` in a per-pixel Python loop costs minutes over a
    1 240 × 1 754 sheet, which is why this reads the buffer as an array.
    """
    arr = np.frombuffer(pix.samples, dtype=np.uint8)
    return int((arr < threshold).sum())


#: The filters `core/compress.ts:recompressImage` is willing to decode and rewrite.
#: Anything else (CCITT, JBIG2, LZW, RunLength, a filter stack) is answered with
#: `skipped` before a canvas is touched, so its stream must come back byte-for-byte.
RE_ENCODED_FILTERS = {"DCTDecode", "JPXDecode", "FlateDecode", "none"}


def raw_pdf(objects):
    """Assemble a minimal PDF from body strings (no compression, fixed xref)."""
    buf = bytearray(b"%PDF-1.5\n")
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(buf))
        buf += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    start = len(buf)
    buf += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        buf += b"%010d 00000 n \n" % offset
    buf += b"trailer\n<< /Size %d /Root 1 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        len(objects),
        start,
    )
    return bytes(buf)


def page_objects(width, height, image_body, title):
    content = b"q %d 0 0 %d 0 0 cm /Im0 Do Q" % (width, height)
    return [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>"
        % (width, height),
        b"<< /Length %d >>stream\n" % len(content) + content + b"\nendstream",
        image_body,
        b"<< /Title (%s) >>" % title.encode(),
    ]


def up_filtered(samples, row):
    """PNG `Up` differencing: what `/Predictor 12` means on disk."""
    out = bytearray()
    previous = bytes(row)
    for start in range(0, len(samples), row):
        line = samples[start : start + row]
        out.append(2)
        out.extend((line[i] - previous[i]) & 0xFF for i in range(row))
        previous = line
    return bytes(out)


def write(path, data):
    with open(path, "wb") as handle:
        handle.write(data)


def jpeg_bytes(rgb, width, height, quality=92):
    """A real JPEG file for the same samples, so `/DCTDecode` is the path taken."""
    buf = io.BytesIO()
    Image.frombytes("RGB", (width, height), rgb).save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def ccitt_payload(image, photometric=0):
    """Group 4 fax payload for a PIL `1` image, written by libtiff and stripped.

    Returns `(bytes, black_is_1)`. libtiff keeps the whole image in one strip, so
    the strip is the exact `/CCITTFaxDecode` stream PDF wants. The polarity is
    *measured*, not derived from the spec table: the fixture is rendered back
    with PyMuPDF and the flag that puts the ink on the right side of the page
    wins (MuPDF reads a min-is-white G4 stream as `BlackIs1 true`, and the build
    step below checks that the rendered black fraction matches the bitmap).
    """
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "fax.tif")
        image.save(path, compression="group4", photometric=photometric)
        with Image.open(path) as tiff:
            offset = tiff.tag_v2[273]
            offset = offset[0] if isinstance(offset, (tuple, list)) else offset
            count = tiff.tag_v2[279]
            count = count[0] if isinstance(count, (tuple, list)) else count
            written = tiff.tag_v2[262]
        with open(path, "rb") as handle:
            data = handle.read()[offset : offset + count]
    return data, written == 0


def fax_image(width, height):
    """A fax-shaped sheet: three text bands, a header rule, a dark block."""
    image = Image.new("1", (width, height), 1)
    at = image.load()
    for y in range(height):
        for x in range(width):
            black = (
                (20 <= y < 26 and 30 <= x < width - 30)
                or (60 <= y < 90 and 40 <= x < width - 40 and (x // 7) % 2 == 0)
                or (150 <= y < 230 and 40 <= x < 260)
                or (300 <= y < 330 and 60 <= x < width - 60 and (x // 11) % 3)
                or (380 <= y < 400 and 30 <= x < width - 30 and (x // 5) % 2 == 0)
            )
            at[x, y] = 0 if black else 1
    return image


def build(out_dir):
    width, height = 1600, 1100
    # A photo-like page: coloured bars either side, dark rules across, and a
    # scan line every 7 px so the pixels are worth measuring.
    # A ±60 dither keeps the middle from flattening: a flat vector page deflates
    # to almost nothing and then no JPEG can beat it, which would hide the decode
    # under test behind "the re-encode was larger".
    rows = []
    for y in range(height):
        line = bytearray()
        for x in range(width):
            if x < 300:
                line += bytes((190, 30, 30))
            elif x >= 1300:
                line += bytes((30, 40, 190))
            elif 120 <= y % 140 <= 160 and 400 <= x < 1200:
                line += bytes((15, 15, 15))
            else:
                mixed = ((x * 374761393 + y * 668265263) ^ 0x5BF03635) & 0xFFFFFFFF
                mixed = ((mixed ^ (mixed >> 13)) * 1274126177) & 0xFFFFFFFF
                jitter = ((mixed >> 16) % 121) - 60
                ramp = (128, 128, 160)
                line += bytes(max(0, min(255, c + jitter)) for c in ramp)
        rows.append(bytes(line))
    photo = b"".join(rows)
    flat = up_filtered(photo, width * 3)

    def picture(filters, extra=b""):
        head = (
            b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /BitsPerComponent 8"
            b" /ColorSpace /DeviceRGB" % (width, height)
        )
        return head + extra + filters + b" /Length %d >>stream\n" % len(base) + base + b"\nendstream"

    # 1. raw: `/Length` only.
    base = photo
    raw = picture(b"")
    # 2. predicted: Flate + `/DecodeParms /Predictor 12`.
    base = zlib.compress(flat, 9)
    predicted = picture(
        b" /Filter /FlateDecode",
        b" /DecodeParms << /Predictor 12 /Colors 3 /Columns %d /BitsPerComponent 8 >>" % width,
    )
    write(f"{out_dir}/compress-raw.pdf", raw_pdf(page_objects(width // 2, height // 2, raw, "raw samples")))
    write(f"{out_dir}/compress-predicted.pdf", raw_pdf(page_objects(width // 2, height // 2, predicted, "png predictor")))

    # 3. indexed: 3 px bands, 8-entry palette, plus a per-column index dither so
    #    the stream is not flat and a JPEG re-encode can honestly be smaller.
    palette = b""
    for step in range(8):
        palette += bytes((step * 30, 200 - step * 20, 20 + step * 25))
        palette += bytes((220 - step * 25, step * 25, 240 - step * 20))
        palette += bytes((20 + step * 25, 220 - step * 25, step * 20))
    # The bands either side are fixed entries so the corner samples mean
    # something; the middle walks the whole palette so the index stream is noisy.
    def index_at(x, y):
        if x < 300:
            return 0
        if x >= 1300:
            return 2
        mixed = ((x * 374761393 + y * 668265263) ^ 0x5BF03635) & 0xFFFFFFFF
        mixed = ((mixed ^ (mixed >> 13)) * 1274126177) & 0xFFFFFFFF
        return 3 + ((mixed >> 16) % 21)

    indices = bytes(index_at(x, y) for y in range(height) for x in range(width))
    base = zlib.compress(indices, 9)
    head = (
        b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /BitsPerComponent 8"
        b" /ColorSpace [/Indexed /DeviceRGB 23 <%s>] /Filter /FlateDecode" % (width, height, palette.hex().encode())
    )
    indexed = head + b" /Length %d >>stream\n" % len(base) + base + b"\nendstream"
    write(f"{out_dir}/compress-indexed.pdf", raw_pdf(page_objects(width // 2, height // 2, indexed, "indexed palette")))

    # 4. alpha-raw: an unfiltered DeviceGray `/SMask` that hides the right half.
    mask = bytes(255 if x < width // 2 else 0 for y in range(height) for x in range(width))
    base = mask
    mask_body = (
        b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /BitsPerComponent 8"
        b" /ColorSpace /DeviceGray /Length %d >>stream\n" % (width, height, len(base))
        + base
        + b"\nendstream"
    )
    base = photo
    head = (
        b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /BitsPerComponent 8"
        b" /ColorSpace /DeviceRGB /SMask 7 0 R" % (width, height)
    )
    pictured = head + b" /Length %d >>stream\n" % len(base) + base + b"\nendstream"
    objects = page_objects(800, 550, pictured, "raw soft mask")
    objects.append(mask_body)
    write(f"{out_dir}/compress-alpha-raw.pdf", raw_pdf(objects))

    # 5. dct: `/Filter /DCTDecode` — a real JPEG (quality 92) of the same photo,
    #    so the browser decoder is what answers, and the page is laid out at
    #    144 dpi effective: under the `balanced` cap, so the re-encode is a pure
    #    quality pass and nothing hides behind a downsample.
    base = jpeg_bytes(photo, width, height, 92)
    dct = (
        b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /BitsPerComponent 8"
        b" /ColorSpace /DeviceRGB /Filter /DCTDecode /Length %d >>stream\n"
        % (width, height, len(base))
    ) + base + b"\nendstream"
    write(f"{out_dir}/compress-dct.pdf", raw_pdf(page_objects(width // 2, height // 2, dct, "jpeg samples")))

    # 6. flate: `/FlateDecode` with plain 8-bit samples and no predictor — the
    #    inflate → `putImageData` path on its own, without the two wrinkles above.
    base = zlib.compress(photo, 9)
    flate = (
        b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /BitsPerComponent 8"
        b" /ColorSpace /DeviceRGB /Filter /FlateDecode /Length %d >>stream\n"
        % (width, height, len(base))
    ) + base + b"\nendstream"
    write(f"{out_dir}/compress-flate.pdf", raw_pdf(page_objects(width // 2, height // 2, flate, "flate samples")))

    # 7. ccitt: 1-bit Group 4 fax rows. `compress.ts` never decodes this (it is
    #    not a canvas format), so the whole claim is that the stored stream
    #    survives the rebuild byte-for-byte and still draws.
    fax_width, fax_height = 640, 440
    fax = fax_image(fax_width, fax_height)
    payload, _ = ccitt_payload(fax)
    bitmap = fax.convert("L").tobytes()
    want = sum(1 for v in bitmap if v < 128) / (fax_width * fax_height)

    def fax_pdf(flag):
        head = (
            b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /BitsPerComponent 1"
            b" /ColorSpace /DeviceGray /Filter /CCITTFaxDecode"
            b" /DecodeParms << /K -1 /Columns %d /Rows 0 /BlackIs1 %s /EndOfBlock true /EncodedByteWidth 0 >>"
            b" /Length %d >>stream\n"
            % (fax_width, fax_height, fax_width, b"true" if flag else b"false", len(payload))
        )
        return raw_pdf(page_objects(fax_width // 2, fax_height // 2, head + payload + b"\nendstream", "ccitt g4 fax"))

    path = f"{out_dir}/compress-ccitt.pdf"
    rendered = {}
    for flag in (True, False):
        write(path, fax_pdf(flag))
        with pymupdf.open(path) as check:
            pix = check[0].get_pixmap(dpi=72)
        rendered[flag] = sum(1 for i in range(0, len(pix.samples), pix.n) if pix.samples[i] < 128) / (
            pix.width * pix.height
        )
    # The render is downsampled 2:1, so the dark fraction is not the bitmap's to
    # the digit; the discriminating fact is that one flag matches the picture and
    # the other is its negative.
    chosen = min(rendered, key=lambda flag: abs(rendered[flag] - want))
    other = rendered[not chosen]
    if abs(rendered[chosen] - want) > 0.25 * want + 0.01 or abs(other - want) < 2 * abs(
        rendered[chosen] - want
    ):
        raise SystemExit(
            f"ccitt fixture cannot tell its polarity: bitmap {want:.3f}, "
            f"BlackIs1 true {rendered[True]:.3f}, false {rendered[False]:.3f}"
        )
    write(path, fax_pdf(chosen))
    print(
        f"ccitt fixture: /BlackIs1 {str(chosen).lower()} renders {rendered[chosen]:.3f} dark "
        f"(bitmap {want:.3f}, the other flag {other:.3f})"
    )


def size_of(path):
    with open(path, "rb") as handle:
        return len(handle.read())


def corner(samples, width, x, y):
    at = (y * width + x) * 3
    return tuple(samples[at : at + 3])


def sample_points(pix):
    """Two probe points that exist on a business card and on a tabloid alike.

    Fixed pixel coordinates (round 022's `(10, 300)`) fell off the end of the
    320 × 220 fax page and the corner read came back an empty tuple — an
    instrument that crashes on a small fixture hides whatever it was built to
    see, so the points are fractions of the render now.
    """
    x_left = min(10, max(1, pix.width // 20))
    x_right = min(pix.width - 10, max(x_left + 1, int(pix.width * 0.97)))
    y = max(1, pix.height // 2)
    return (x_left, y), (x_right, y)


def image_facts(doc, page):
    """Per stored image: the dictionary, the decoded picture, and their digests.

    `pymupdf.Pixmap(doc, xref)` is the reader's decode — it runs MuPDF's own
    CCITT/JPEG/flate/raw paths, so an image the tool wrote but nobody can read
    raises here rather than scoring. `raw` is the stored stream, so a skip that
    claims "byte-for-byte the original" can be checked against that claim.

    The picture's own ink is scored as a **density** over the area its soft mask
    leaves visible: a dpi cap halves `/Width` and the count with it, and a
    re-encoded soft-masked picture is composited onto paper where the mask hid
    it, so its hidden half turns white in the samples and says nothing about the
    page the reader sees.
    """
    found = []
    for info in page.get_images(full=True):
        xref, smask = info[0], info[1]
        row = {
            "w": info[2],
            "h": info[3],
            "bpc": info[4],
            "filter": info[8] or "none",
            "smask": bool(smask),
            "decodes": True,
            "dw": 0,
            "dh": 0,
            "ink": 0,
            "density": 0.0,
            "raw": "",
            "pix": "",
            "error": "",
        }
        try:
            raw = doc.xref_stream_raw(xref) or b""
            row["raw"] = hashlib.sha256(raw).hexdigest()[:16]
        except Exception as error:  # noqa: BLE001
            row["error"] = f"stream: {error}"
        try:
            pix = pymupdf.Pixmap(doc, xref)
            if pix.n - pix.alpha > 3:
                pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
            samples = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
            dark = (samples[..., :3] < 250).any(axis=2)
            visible = np.ones_like(dark, dtype=bool)
            if smask:
                mask = pymupdf.Pixmap(doc, smask)
                if (mask.width, mask.height) == (pix.width, pix.height):
                    visible = np.frombuffer(mask.samples, dtype=np.uint8).reshape(
                        mask.height, mask.width
                    ) >= 128
            row.update(
                dw=pix.width,
                dh=pix.height,
                ink=int(dark.sum()),
                density=float(dark[visible].mean()) if visible.any() else 0.0,
                pix=hashlib.sha256(pix.samples).hexdigest()[:16],
            )
        except Exception as error:  # noqa: BLE001
            row["decodes"] = False
            row["error"] = f"decode: {error}"
        found.append(row)
    return found


def judge(source, produced):
    def census(path):
        doc = pymupdf.open(path)
        page = doc[0]
        pix = page.get_pixmap(dpi=72, colorspace=pymupdf.csRGB, alpha=False)
        (lx, ly), (rx, ry) = sample_points(pix)
        return {
            "box": (round(page.rect.width, 1), round(page.rect.height, 1)),
            "ink": ink_of(pix),
            "images": [(i[2], i[3], i[8], "smask" if i[1] else "-") for i in page.get_images(full=True)],
            "facts": image_facts(doc, page),
            "left": corner(pix.samples, pix.width, lx, ly),
            "right": corner(pix.samples, pix.width, rx, ry),
            "pix": pix,
            "chars": len(page.get_text()),
        }

    a = census(source)
    b = census(produced)
    a["pix"].save(produced.replace(".pdf", "-src.png"))
    b["pix"].save(produced.replace(".pdf", "-out.png"))
    row = {
        "source": source.rsplit("/", 1)[-1],
        "produced": produced.rsplit("/", 1)[-1],
        "bytes": [size_of(source), size_of(produced)],
        "box_in": a["box"],
        "box_out": b["box"],
        "ink_in": a["ink"],
        "ink_out": b["ink"],
        "images_in": a["images"],
        "images_out": b["images"],
        "img_in": a["facts"],
        "img_out": b["facts"],
        "left_in": a["left"],
        "left_out": b["left"],
        "right_in": a["right"],
        "right_out": b["right"],
    }
    fails = []
    if a["box"] != b["box"]:
        fails.append("box")
    # Downsampling hard-edged bars loses a little anti-aliased edge to the white
    # threshold, so 5 % is the bound; the corners below are the exact check.
    if not b["ink"] >= a["ink"] * 0.95:
        fails.append(f"page-ink {a['ink']}->{b['ink']}")
    for side, points in (("left", (a["left"], b["left"])), ("right", (a["right"], b["right"]))):
        before, after = points
        if max(abs(before[i] - after[i]) for i in range(3)) >= 40:
            fails.append(f"{side} corner {before}->{after}")
    if len(a["facts"]) != len(b["facts"]):
        fails.append(f"image-count {len(a['facts'])}->{len(b['facts'])}")
    for index, (before, after) in enumerate(zip(a["facts"], b["facts"])):
        tag = f"image {index + 1}"
        # The picture has to still be there, and still be a picture.
        if not after["decodes"]:
            fails.append(f"{tag} undecodable ({after['error']})")
            continue
        if after["density"] <= 0 < before["density"]:
            fails.append(f"{tag} decoded to paper ({before['density']:.3f}->{after['density']:.3f})")
        elif before["decodes"] and after["density"] < before["density"] * 0.95:
            fails.append(f"{tag} ink density {before['density']:.4f}->{after['density']:.4f}")
        # A format the tool never decodes (`recompressImage` returns `skipped`
        # for anything but DCT/JPX/Flate/raw samples) must come back with the
        # bytes it went in with, or "left untouched" is a lie.
        if (
            before["filter"] == after["filter"]
            and before["filter"] not in RE_ENCODED_FILTERS
            and before["raw"] != after["raw"]
        ):
            fails.append(f"{tag} {after['filter']} stream changed while left alone")
    row["fails"] = fails
    row["verdict"] = "ok" if not fails else f"WRONG: {fails}"
    print(json.dumps(row))


def self_test(directory):
    """The judge against a page of paper and a page of ink (`round-brief` §Failing well).

    Every fixture is judged against itself (must be `ok`) and against a copy whose
    content stream was blanked by MuPDF (must be `WRONG`): a check that passes on
    both is measuring the file's existence, not its picture.
    """
    bad = 0
    for name in sorted(os.listdir(directory)):
        if not name.endswith(".pdf"):
            continue
        src = os.path.join(directory, name)
        scratch = os.path.join(directory, ".selfcheck")
        os.makedirs(scratch, exist_ok=True)
        same = os.path.join(scratch, f"{name}.same.pdf")
        blank = os.path.join(scratch, f"{name}.blank.pdf")
        shutil.copyfile(src, same)
        with pymupdf.open(src) as doc:
            page = doc[0]
            pictures = page.get_images(full=True)
            if pictures:
                # The picture is gone but the page box, the object count and the
                # file size hardly move: only an ink measure can see it.
                for info in pictures:
                    page.delete_image(info[0])
            else:
                page.set_rotation((page.rotation + 90) % 360)
            doc.save(blank, garbage=0)
        for other, want_ok in ((same, True), (blank, False)):
            import contextlib

            with contextlib.redirect_stdout(io.StringIO()) as captured:
                judge(src, other)
            row = json.loads(captured.getvalue().strip().splitlines()[-1])
            ok = (row["verdict"] == "ok") == want_ok
            if not ok:
                bad += 1
            print(f"{'PASS' if ok else 'FAIL'} {name} vs {name}{'.blank' if not want_ok else '.copy'}: "
                  f"{row['verdict']} (want {'ok' if want_ok else 'WRONG'})")
    print("SELFTEST", "OK" if not bad else f"{bad} PROBLEM(S)")
    return 1 if bad else 0


def main(argv):
    if argv[1:2] == ["--build"]:
        build(argv[2])
        return 0
    if argv[1:2] == ["--self"]:
        return self_test(argv[2])
    if argv[1:2] == ["--judge"]:
        pairs = argv[2:]
        for index in range(0, len(pairs), 2):
            judge(pairs[index], pairs[index + 1])
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
