#!/usr/bin/env python3
"""Judge a "digitally signed" PDF with readers that share no code with the app.

  python3 docs/research/verify-digital-sign-read.py <signed.pdf> [--tamper]

Asks, in order:
  * is there a signature *field* — `/FT /Sig`, a `/V` with `/ByteRange`, a SubFilter?
  * does the PKCS#7 blob verify over exactly the bytes `/ByteRange` names, as judged
    by `openssl cms -verify` (a `cmsVerifySignedData` equivalent)?
  * is the signer named, and is the digest the one claimed?
  * does flipping one byte inside the signed range get detected?
  * is the visible appearance on the page the tool was told to mark, and does it
    paint something there?
"""
import subprocess
import sys
import tempfile
from pathlib import Path

import fitz
import pikepdf
from pypdf import PdfReader

path = Path([a for a in sys.argv[1:] if not a.startswith("--")][0])
want_tamper = "--tamper" in sys.argv

reader = PdfReader(str(path))
fields = reader.get_fields() or {}
print(f"pypdf over {path.name}: {len(fields)} form field(s)")
for name, field in fields.items():
    print(f"  {name!r}: /FT={field.get('/FT')} /V={'present' if field.get('/V') is not None else 'absent'} "
          f"/M={field.get('/M')}")

raw = path.read_bytes()
byte_range = []
cms = b""
with pikepdf.open(path) as handled:
    form = handled.Root.get("/AcroForm")
    print(f"pikepdf: /AcroForm in Root = {form is not None}"
          f"{'，/NeedAppearances=' + str(form.get('/NeedAppearances')) if form is not None else ''}")
    sig = None
    owner = None
    for ref in ([] if form is None else form.get("/Fields", [])):
        value = ref.get("/V")
        kids = ref.get("/Kids")
        print(f"  field {ref.get('/T')} /FT={ref.get('/FT')} /Subtype={ref.get('/Subtype')} "
              f"/Rect={list(ref.get('/Rect') or [])} /Kids={len(list(kids)) if kids is not None else 0} "
              f"/F={ref.get('/F')} /V={'yes' if value is not None else 'no'}")
        if value is not None and str(ref.get("/FT")) == "/Sig":
            sig, owner = value, ref
    if sig is None:
        print("VERDICT: no /Sig field with a /V — nothing is cryptographically signed")
        raise SystemExit(1)
    span = sig.get("/ByteRange")
    contents = sig.get("/Contents")
    if span is None or contents is None:
        print("  the signature dictionary is missing /ByteRange or /Contents")
        raise SystemExit(1)
    byte_range = [int(x) for x in span]
    print(f"  signature dictionary: /Filter={sig.get('/Filter')} /SubFilter={sig.get('/SubFilter')} "
          f"/ByteRange={byte_range}")
    print(f"  /Name={sig.get('/Name')} /Location={sig.get('/Location')} /Reason={sig.get('/Reason')} "
          f"/M={sig.get('/M')} /Cert={sig.get('/Cert')} /Prop_Build={sig.get('/Prop_Build')}")
    # A hex string arrives from pikepdf already decoded to bytes: those bytes *are*
    # the CMS blob, padded with zeros out to the reserved width.
    blob = bytes(contents)
    trimmed = blob.rstrip(b"\x00")
    cms = trimmed if trimmed[:1] == b"\x30" else blob
    signed_len = sum(byte_range[1::2])
    print(f"  /Contents reserves {len(blob)} bytes; {len(cms)} of them are the CMS blob. "
          f"The signature covers {signed_len} of the file's {len(raw)} bytes "
          f"(the gap is the placeholder itself)")

work = Path(tempfile.mkdtemp(prefix="dsr-"))
(work / "signed.bin").write_bytes(b"".join(
    raw[start:start + length] for start, length in zip(byte_range[0::2], byte_range[1::2], strict=True)))
(work / "sig.p7s").write_bytes(cms)
signed_bytes = (work / "signed.bin").read_bytes()


def run(args, data=None):
    done = subprocess.run(args, input=data, capture_output=True)
    return done.returncode, (done.stdout + done.stderr).decode("utf8", "replace").strip()


code, noise = run(["openssl", "cms", "-verify", "-inform", "DER", "-in", str(work / "sig.p7s"),
                   "-content", str(work / "signed.bin"), "-binary", "-noverify", "-out", "/dev/null"])
print(f"openssl cms -verify over the byte range as written: exit={code} · {noise.replace(chr(10), ' / ')[:220]}")
code, noise = run(["openssl", "cms", "-verify", "-inform", "DER", "-in", str(work / "sig.p7s"),
                   "-content", str(work / "signed.bin"), "-binary", "-noverify", "-out", str(work / "out.bin")])
print(f"openssl names the certificate inside the blob: {noise[:120]}")
code, noise = run(["openssl", "pkcs7", "-inform", "DER", "-in", str(work / "sig.p7s"), "-print_certs", "-text", "-noout"])
print(f"certificate the blob carries: exit={code} · {noise.replace(chr(10), ' | ')[:260]}")
code, noise = run(["openssl", "pkcs7", "-inform", "DER", "-in", str(work / "sig.p7s"), "-print_certs", "-noout"])
code2, noise2 = run(["openssl", "asn1parse", "-inform", "DER", "-in", str(work / "sig.p7s")])
algorithms = sorted({line.strip() for line in noise2.splitlines()
                     if "digest" in line.lower() or "sha" in line.lower() or "rsa" in line.lower()})
print(f"digest/signature algorithms inside the CMS blob: exit={code}/{code2} · {algorithms[:6]}")
print(f"certificate the blob carries: {noise.replace(chr(10), ' | ')[:220]}")

if want_tamper and byte_range:
    for label, spot in (("middle of the first span", byte_range[0] + 40),
                        ("last signed byte of the first span", byte_range[0] + byte_range[1] - 1),
                        ("inside the second span", byte_range[2] + 10),
                        ("in the signature placeholder itself", byte_range[1] + 4)):
        if not 0 <= spot < len(raw):
            print(f"tamper {label}: offset {spot} is outside the file")
            continue
        tampered = bytearray(raw)
        tampered[spot] ^= 0x01
        covered = work / "covered.bin"
        covered.write_bytes(b"".join(bytes(tampered)[start:start + length]
                                    for start, length in zip(byte_range[0::2], byte_range[1::2], strict=True)))
        code, noise = run(["openssl", "cms", "-verify", "-inform", "DER", "-in", str(work / "sig.p7s"),
                           "-content", str(covered), "-binary", "-noverify", "-out", "/dev/null"])
        opens = ""
        if label == "middle of the first span":
            tpath = work / "tampered.pdf"
            tpath.write_bytes(bytes(tampered))
            doc = fitz.open(tpath)
            opens = f" · MuPDF still opens it ({doc.page_count} pages)"
            doc.close()
        print(f"tamper {label} (offset {spot}): exit={code} · {noise.replace(chr(10), ' / ')[:120]}{opens}")

mupdf = fitz.open(path)
print(f"\nMuPDF {fitz.version[0]}: {mupdf.page_count} pages, needs_pass={mupdf.needs_pass}, form={mupdf.is_form_pdf}")


def widget_rows(page):
    found_widgets = page.widgets()
    return [(getattr(w, "field_name", None), getattr(w, "field_type_string", None),
             tuple(round(v, 1) for v in w.rect)) for w in (found_widgets or [])]


for number in range(1, mupdf.page_count + 1):
    page = mupdf.load_page(number - 1)
    annots = [(a.type, getattr(a, "field_name", None), tuple(round(v, 1) for v in a.rect)) for a in page.annots()]
    painted = page.get_pixmap(dpi=72)
    dark = sum(1 for i in range(0, len(painted.samples), 4) if painted.samples[i] < 200)
    print(f"  page {number} ({page.rect.width:.0f}x{page.rect.height:.0f}): annots={annots} "
          f"widgets={widget_rows(page)} · render {painted.width}x{painted.height} px, {dark} dark pixels")

code, noise = run(["pdfinfo", str(path)])
keep = [line for line in noise.splitlines() if "Pages" in line or "Page size" in line or "Encrypted" in line]
print(f"\npdfinfo: exit={code} {keep}")
code, noise = run(["pdftotext", str(path), "-"])
print(f"poppler text: planted sentences = "
      f"{[noise.count(f'alice{n}bravo') for n in (1, 2, 3)]} (exit {code})")
mupdf.close()
