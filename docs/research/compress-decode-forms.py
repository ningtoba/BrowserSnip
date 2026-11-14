#!/usr/bin/env python3
"""Build the four decode shapes round 022 measured, and judge them in the bytes.

`pdf-compress` has to turn stored image samples into a picture it can re-encode.
Four shapes reach that decode and each has a different way of failing quietly:

  * `raw`      — no `/Filter` at all: the stream *is* the samples.
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
that opens, has the right page and the same ink but the wrong corners is the
shape this round was about.
"""
import json
import sys
import zlib

import pymupdf


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


def size_of(path):
    with open(path, "rb") as handle:
        return len(handle.read())


def corner(samples, width, x, y):
    at = (y * width + x) * 3
    return tuple(samples[at : at + 3])


def judge(source, produced):
    def census(path):
        doc = pymupdf.open(path)
        page = doc[0]
        pix = page.get_pixmap(dpi=72)
        return {
            "box": (round(page.rect.width, 1), round(page.rect.height, 1)),
            "ink": sum(1 for b in pix.samples if b < 250),
            "images": [(i[2], i[3], i[8], "smask" if i[1] else "-") for i in page.get_images(full=True)],
            "left": corner(pix.samples, pix.width, 10, 300),
            "right": corner(pix.samples, pix.width, min(pix.width - 10, 780), 300),
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
        "left_in": a["left"],
        "left_out": b["left"],
        "right_in": a["right"],
        "right_out": b["right"],
    }
    same_box = a["box"] == b["box"]
    # Downsampling hard-edged bars loses a little anti-aliased edge to the white
    # threshold, so 5 % is the bound; the corners below are the exact check.
    ink_kept = b["ink"] >= a["ink"] * 0.95
    same_corners = (
        max(abs(a["left"][i] - b["left"][i]) for i in range(3)) < 40
        and max(abs(a["right"][i] - b["right"][i]) for i in range(3)) < 40
    )
    row["verdict"] = "ok" if (same_box and ink_kept and same_corners) else "WRONG"
    print(json.dumps(row))


def main(argv):
    if argv[1:2] == ["--build"]:
        build(argv[2])
        return 0
    if argv[1:2] == ["--judge"]:
        pairs = argv[2:]
        for index in range(0, len(pairs), 2):
            judge(pairs[index], pairs[index + 1])
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
