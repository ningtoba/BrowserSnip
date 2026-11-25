#!/usr/bin/env python3
"""round 073 fixtures — TIFFs built to answer one question each, for tiff-to-pdf.

    python3 docs/research/tiff-to-pdf-fixtures.py /tmp/r73

Pillow writes every one of them, so the same bytes can be handed to Pillow again
as the oracle for what the page must draw. `bigendian.tif` is written by hand
(Pillow only writes little-endian TIFFs) and is checked with Pillow on the way.
"""
import struct
import sys

import PIL.Image as I

DIR = sys.argv[1] if len(sys.argv) > 1 else '/tmp/r73'  # noqa: S108 — a scratch dir, by argument


def set_extra_samples(path: str, value: int) -> None:
    """Rewrite tag 338 in every IFD of a little-endian TIFF (Pillow always writes 2)."""
    with open(path, 'rb') as handle:
        raw = bytearray(handle.read())
    assert raw[:2] == b'II', 'this patcher only reads little-endian TIFFs'
    offset = struct.unpack_from('<I', raw, 4)[0]
    for _ in range(16):
        if not offset or offset + 2 > len(raw):
            break
        count = struct.unpack_from('<H', raw, offset)[0]
        for index in range(count):
            entry = offset + 2 + index * 12
            if struct.unpack_from('<H', raw, entry)[0] == 338:
                struct.pack_into('<H', raw, entry + 8, value)
        follower = offset + 2 + count * 12
        offset = struct.unpack_from('<I', raw, follower)[0] if follower + 4 <= len(raw) else 0
    with open(path, 'wb') as handle:
        handle.write(raw)


def main() -> None:
    # 1. three frames, distinct sizes and distinct colours: "one page per frame,
    #    in frame order" and "not frame 0 repeated" are both measurable.
    frames = [I.new('RGB', (200, 120), (220, 30, 40)),
              I.new('RGB', (160, 90), (30, 160, 60)),
              I.new('RGB', (120, 160), (30, 60, 200))]
    frames[0].save(f'{DIR}/frames.tif', save_all=True, append_images=frames[1:], compression='raw')

    # 2. a single frame, the control every colour question is asked against.
    I.new('RGB', (200, 120), (220, 30, 40)).save(f'{DIR}/single.tif', compression='raw')

    # 3. CMYK quadrants: pure cyan, magenta, yellow, black. Read as RGB, cyan
    #    comes out red.
    cmyk = I.new('CMYK', (200, 120), (0, 0, 0, 0))
    for x in range(100):
        for y in range(60):
            cmyk.putpixel((x, y), (255, 0, 0, 0))
            cmyk.putpixel((x + 100, y), (0, 255, 0, 0))
            cmyk.putpixel((x, y + 60), (0, 0, 255, 0))
            cmyk.putpixel((x + 100, y + 60), (0, 0, 0, 255))
    cmyk.save(f'{DIR}/cmyk.tif', compression='raw')

    # 4. a 1-bit Group 4 fax: a black block on white paper.
    fax = I.new('1', (300, 200), 1)
    for x in range(60, 180):
        for y in range(40, 120):
            fax.putpixel((x, y), 0)
    fax.save(f'{DIR}/fax4.tif', compression='group4')

    # 5. big-endian (`MM`) uncompressed RGB — the byte order is in the header.
    width, height = 160, 100
    pixels = bytearray()
    for _y in range(height):
        for x in range(width):
            pixels += bytes((220, 30, 40) if x < width // 2 else (30, 160, 60))
    pixel_offset = 8
    bits_at = pixel_offset + len(pixels)
    ifd_at = bits_at + 6
    tags = [(256, 4, 1, width), (257, 4, 1, height), (258, 3, 3, bits_at), (259, 3, 1, 1),
            (262, 3, 1, 2), (273, 4, 1, pixel_offset), (277, 3, 1, 3), (278, 4, 1, height),
            (279, 4, 1, len(pixels)), (282, 5, 1, 0), (283, 5, 1, 0), (284, 3, 1, 1)]
    rationals = ifd_at + 2 + len(tags) * 12 + 4
    tags[9] = (282, 5, 1, rationals)
    tags[10] = (283, 5, 1, rationals + 8)
    out = bytearray(b'MM' + struct.pack('>HI', 42, ifd_at))
    out += bytes(pixels) + struct.pack('>HHH', 8, 8, 8) + struct.pack('>H', len(tags))
    for tag, kind, count, value in tags:
        out += struct.pack('>HHI', tag, kind, count)
        out += struct.pack('>HH', value, 0) if (kind == 3 and count == 1) else struct.pack('>I', value)
    out += struct.pack('>I', 0) + struct.pack('>II', 72, 1) + struct.pack('>II', 72, 1)
    with open(f'{DIR}/bigendian.tif', 'wb') as handle:
        handle.write(bytes(out))

    # 6. a complete 400 x 240 picture and the same file cut at 40 % of its bytes.
    gradient = I.new('RGB', (400, 240))
    for y in range(240):
        for x in range(400):
            gradient.putpixel((x, y), (x % 256, (y * 2) % 256, 200))
    gradient.save(f'{DIR}/full.tif', compression='raw')
    with open(f'{DIR}/full.tif', 'rb') as handle:
        complete = handle.read()
    with open(f'{DIR}/cut.tif', 'wb') as handle:
        handle.write(complete[:int(len(complete) * 0.4)])

    # 7. another container under a .tif name.
    I.new('RGB', (120, 80), (220, 30, 40)).save(f'{DIR}/png-in.tif', format='PNG')
    I.new('RGB', (120, 80), (220, 30, 40)).save(f'{DIR}/jpg-in.tif', format='JPEG')

    # 8. one alpha declaration each way. `ExtraSamples` (tag 338) says whether the
    #    colour samples have already been multiplied by the alpha: 1 = associated,
    #    2 = unassociated (TIFF 6.0 §22). Both files here are the same picture — a
    #    78 % red band beside 78 % white — so the page they convert to must be the
    #    same page. Pillow always writes 2, so the associated pair is stored
    #    premultiplied by hand and the tag is patched afterwards.
    alpha = I.new('RGBA', (120, 90), (0, 0, 0, 0))
    for x in range(120):
        colour = (220, 30, 40) if x < 60 else (255, 255, 255)
        for y in range(90):
            alpha.putpixel((x, y), (*colour, 200))
    alpha.save(f'{DIR}/alpha-plain.tif', compression='raw')
    assoc = I.new('RGBA', (120, 90), (0, 0, 0, 0))
    for x in range(120):
        colour = (220, 30, 40) if x < 60 else (255, 255, 255)
        for y in range(90):
            assoc.putpixel((x, y), (*[round(c * 200 / 255) for c in colour], 200))
    assoc.save(f'{DIR}/alpha-assoc.tif', compression='raw')
    set_extra_samples(f'{DIR}/alpha-assoc.tif', 1)

    # Pillow is the oracle for what the two files mean, and it says the same picture:
    # un-associating 173/24/31 at alpha 200 returns 220/30/40 (±1 of rounding), and
    # the white band is white at 200 in both.
    for name in ('alpha-plain.tif', 'alpha-assoc.tif'):
        with I.open(f'{DIR}/{name}') as handle:
            red = handle.convert('RGBA').getpixel((10, 10))
            white = handle.convert('RGBA').getpixel((110, 10))
        assert max(abs(a - b) for a, b in zip(red, (220, 30, 40, 200))) <= 2, (name, red)
        assert white == (255, 255, 255, 200), (name, white)

    # the hand-built one must read back the way it was drawn.
    be = I.open(f'{DIR}/bigendian.tif').convert('RGB')
    assert be.getpixel((10, 10)) == (220, 30, 40) and be.getpixel((150, 50)) == (30, 160, 60)


if __name__ == '__main__':
    main()
