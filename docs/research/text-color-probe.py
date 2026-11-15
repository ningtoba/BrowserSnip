#!/usr/bin/env python3
"""Build an uncompressed probe sheet for the text-colour round (round 042).

  python3 docs/research/text-color-probe.py /tmp/r/text-color-probe.pdf

Each row is one answer the card makes a claim about, so `colour-rail.mjs` on this
sheet followed by a PyMuPDF read of the produced stream says which rows the tool
reached and which it did not. Needs PIL only for the sRGB profile it embeds.

One page, eight things on it, each a row, so the file itself says which rows a
recolour did and did not reach:

  A  black run with its own `0 0 0 rg`
  B  a run already painted the target colour (`1 0 0 rg`)
  C  a vector rule painted black, then a run that inherits it (no colour op)
  D  a run painted through a `/Pattern` colour space (`/P1 scn`)
  E  a run painted through an `/ICCBased` colour space (`/CS1 cs 0 0 0 scn`)
  F  a run inside a Form XObject
  G  an image XObject

The image is a 4x4 red PNG; the ICC stream is a real sRGB profile.
"""
import struct
import sys
import zlib

W, H = 420, 595
def srgb_profile():
    """A real sRGB ICC profile — an `/ICCBased` stream needs the bytes."""
    from PIL import ImageCms
    return ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()


ICC = srgb_profile()


def png4():
    """A 4x4 solid red PNG, built by hand so no library is needed."""
    def chunk(kind, data):
        body = kind + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xffffffff)
    raw = b''.join(b'\x00' + b'\xff\x00\x00' * 4 for _ in range(4))
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', 4, 4, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw))
            + chunk(b'IEND', b''))


def text(x, y, s):
    return (f'BT /F1 12 Tf 1 0 0 1 {x} {y} Tm ({s}) Tj ET\n').encode('latin-1')


content = b''.join([
    b'q\n',
    # A — its own black fill.
    b'0 0 0 rg\n', text(40, 520, 'RUN A black'),
    # B — already the target colour.
    b'1 0 0 rg\n', text(40, 495, 'RUN B already red'),
    # C — a rule painted black, then a run that inherits that fill and sets none.
    b'0 0 0 rg\n40 470 300 3 re f\n', text(40, 450, 'RUN C after rule'),
    # D — a tiling pattern.
    b'/Pattern cs /P1 scn\n', text(40, 420, 'RUN D pattern'),
    # E — an ICCBased space.
    b'/CS1 cs 0 0 0 scn\n', text(40, 390, 'RUN E icc'),
    # F — text inside a Form XObject.
    b'q 1 0 0 1 0 370 cm /Fx1 Do Q\n',
    # G — an image.
    b'q 40 0 0 40 40 280 cm /Im1 Do Q\n',
    b'Q\n',
])

form = (b'BT /F1 12 Tf 1 0 0 1 40 10 Tm (RUN F in form) Tj ET\n')
pattern = b'0 0 300 20 re f\n'

objects = [
    b'<< /Type /Catalog /Pages 2 0 R >>',
    b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    (f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {W} {H}] '
     f'/Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R /Fx1 7 0 R >> '
     f'/Pattern << /P1 8 0 R >> /ColorSpace << /CS1 [/ICCBased 9 0 R] >> >> '
     f'/Contents 4 0 R >>').encode(),
    b'<< /Length %d >>\nstream\n' % len(content) + content + b'endstream',
    b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    (b'<< /Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB '
     b'/BitsPerComponent 8 /Length %d >>\nstream\n' % len(png4())) + png4() + b'\nendstream',
    (b'<< /Type /XObject /Subtype /Form /BBox [0 0 400 20] '
     b'/Resources << /Font << /F1 5 0 R >> >> /Length %d >>\nstream\n' % len(form)) + form + b'endstream',
    (b'<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 '
     b'/BBox [0 0 300 20] /XStep 300 /YStep 20 /Resources << >> /Length %d >>\nstream\n' % len(pattern))
    + pattern + b'endstream',
    b'<< /N 3 /Alternate /DeviceRGB /Length %d >>\nstream\n' % len(ICC) + ICC + b'\nendstream',
]

out = bytearray(b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n')
offsets = []
for i, body in enumerate(objects, start=1):
    offsets.append(len(out))
    out += b'%d 0 obj\n' % i + body + b'\nendobj\n'
xref = len(out)
out += b'xref\n0 %d\n' % (len(objects) + 1)
out += b'0000000000 65535 f \n'
for off in offsets:
    out += b'%010d 00000 n \n' % off
out += b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objects) + 1, xref)
target = sys.argv[1] if len(sys.argv) > 1 else '/tmp/r/text-color-probe.pdf'
open(target, 'wb').write(bytes(out))
print('wrote', target, len(out))
