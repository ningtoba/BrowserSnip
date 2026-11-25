#!/usr/bin/env python3
"""Rebuild the `validate-signature-pdf` state set the audit judged, from one signed file.

  python3 docs/research/validate-signature-craft.py <signed.pdf> <out-dir>

`validate-signature-pdf` is judged by whether six states stay six different answers,
and only two of them come out of the app's own tools (a good signature, a re-signed
file). The rest are byte surgery on a produced file, each edit keeping the file
length identical so the *only* thing that moves is the claim under test — a pikepdf
re-save would move every offset and confound the digest with the re-serialisation.

Every case is cross-checked against readers that share no code with the app
(`openssl cms -verify`, `pdfsig`), because a state the app invents is worth nothing:

  tampered     one byte inside a stream in the first signed range
               → openssl exit 4, pdfsig "Digest Mismatch", file still parses
  forged       one hex digit of the DER itself; the covered bytes do not move, so
               the message digest still matches — only the RSA check can catch it
               → openssl exit 4 (invalid padding), pdfsig "Signature is Invalid"
  empty        /V deleted from the field: prepared and never signed
  subfilter    /SubFilter renamed in place: not a type the reader has a rule for
  outside      the last /ByteRange length widened 1730 → 9999: the declared ranges
               reach past the end of the file, which is a claim about another file
  appended     bytes glued on after signing: the signature is intact over its own
               ranges and silent about the rest
  sha1         the /Contents placeholder refilled with a SHA-1 CMS over the very
               same covered bytes → digest intact, value intact, weak algorithm

`unsigned` needs no fixture: any unsigned source PDF (the corpus fixture) is it.
"""
import subprocess
import sys
from pathlib import Path

import pikepdf

signed_path = Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/r/dig-a.pdf')
out = Path(sys.argv[2] if len(sys.argv) > 2 else '/tmp/lane-security/c5')
out.mkdir(parents=True, exist_ok=True)
raw = signed_path.read_bytes()
text = raw.decode('latin1')

# /ByteRange is read off the file rather than assumed, so the script follows a
# re-run of the signing tool instead of freezing one revision's offsets.
br = [int(x) for x in __import__('re').search(
    r'/ByteRange \[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]', text).groups()]
print(f'{signed_path.name}: /ByteRange {br}, file {len(raw)} B')


def patched(offset: int, value: bytes) -> bytes:
    bumped = bytearray(raw)
    bumped[offset:offset + len(value)] = value
    return bytes(bumped)


def report(label: str, data: bytes) -> None:
    path = out / f'{label}.pdf'
    path.write_bytes(data)
    sig = subprocess.run(['pdfsig', str(path)], capture_output=True)
    verdict = [line.strip().lstrip('- ').strip() for line in sig.stdout.decode().splitlines()
               if 'Signature Validation' in line or 'Signing Hash' in line]
    print(f'  {label:22s} {path.stat().st_size:6d} B  pdfsig exit={sig.returncode}  {verdict}')


report('state-tampered', patched(text.index('stream', 200) + 60, bytes([raw[text.index('stream', 200) + 60] ^ 1])))

name_at = text.index('/SubFilter /adbe.pkcs7.detached') + len('/SubFilter /')
report('state-subfilter', patched(name_at, b'adbe.pkcs7.unknwnXx'))
# /ByteRange padded to 10 digits by the signing pass: swap the last field's digits
# for an equally wide, impossible length.
last = br[3]
br_at = text.index(f'{last:010d}', text.index('/ByteRange'))
report('state-outside', patched(br_at, b'0000009999'))
report('state-appended', raw + b'\n% revision two appended after signing\n%%EOF\n')

with pikepdf.open(signed_path) as pdf:
    del pdf.Root.AcroForm.Fields[0].V
    pdf.save(out / 'state-empty.pdf')
print(f"  {'state-empty':22s} {(out / 'state-empty.pdf').stat().st_size:6d} B  (pikepdf re-saves, so this one moves offsets too)")

# A forged *value*: one hex digit of the DER flipped. The covered bytes do not move,
# so the message digest inside the blob still matches the file — only the RSA check
# over the signed attributes can notice, which is the state a digest-only reader
# calls "valid".
placeholder = raw[br[1]:br[2]]
der_end = len(placeholder.rstrip(b'0')) // 2 * 2 - 6
forged = bytearray(raw)
digit = forged[br[1] + der_end]
forged[br[1] + der_end] = ord('e') if digit != ord('e') else ord('f')
report('state-forged', bytes(forged))

# A SHA-1 CMS over the same covered bytes, patched into the same placeholder.
work = out / '.craft'
work.mkdir(exist_ok=True)
covered = b''.join(raw[s:s + l] for s, l in zip(br[0::2], br[1::2], strict=True))
(work / 'cov.bin').write_bytes(covered)
cert = Path('/tmp/triage/in/signer-cert.pem')
key = Path('/tmp/triage/in/signer-key.pem')
sign = subprocess.run(['openssl', 'cms', '-sign', '-binary', '-md', 'sha1', '-in', str(work / 'cov.bin'),
                       '-signer', str(cert), '-inkey', str(key), '-outform', 'DER', '-out', str(work / 'sha1.p7s')],
                      capture_output=True)
if sign.returncode != 0:
    sys.exit(f'openssl cms -sign failed: {sign.stderr.decode()[:200]}')
der = (work / 'sha1.p7s').read_bytes()
width = br[2] - br[1]
report('state-sha1', patched(br[1], der.hex().encode().ljust(width, b'0')))
