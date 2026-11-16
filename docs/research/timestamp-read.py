#!/usr/bin/env python3
"""Judge a timestamped PDF from the file itself.

    python3 docs/research/timestamp-read.py /tmp/r66/signed.pdf /tmp/r66/after-ts.pdf

The card promises a third-party stamp proving the signature existed at a stated
moment. So the file has to answer, outside this app: does `/ByteRange` still cover
every byte it did before, does the signature still verify over the covered bytes,
is there a token at all, does it parse, does it imprint the *signature value*
(ETSI EN 319 142-1 §6.3) and does the token itself verify against the authority's
own chain? Also, for the screen half's sake, does the document still draw.
"""
import hashlib
import json
import os
import re
import subprocess
import sys

WORK = os.environ.get('WORK', '/tmp/r66')

TS_OID = bytes.fromhex('2a864886f70d010910020e')  # 1.2.840.113549.1.9.16.2.14


def read(path, binary=True):
    with open(path, 'rb') as handle:
        return handle.read()


def write(path, blob):
    with open(path, 'wb') as handle:
        handle.write(blob)


def run(argv, **kw):
    return subprocess.run(argv, capture_output=True, **kw)


def tlvs(blob, start=0, end=None):
    """Yield (tag, header_start, content_start, content_end) for one level."""
    end = len(blob) if end is None else end
    at = start
    while at < end:
        tag = blob[at]
        length = blob[at + 1]
        header = 2
        if length & 0x80:
            count = length & 0x7F
            length = int.from_bytes(blob[at + 2:at + 2 + count], 'big')
            header = 2 + count
        yield tag, at, at + header, at + header + length
        at += header + length


def tree(blob, start, end):
    """Nested [tag, content, children] nodes for one TLV sequence."""
    nodes = []
    for tag, _h, cstart, cend in tlvs(blob, start, end):
        nodes.append([tag, blob[cstart:cend], tree(blob, cstart, cend) if tag & 0x20 else []])
    return nodes


def find(nodes, tag, depth=0):
    for node in nodes:
        if node[0] == tag:
            yield node
        yield from find(node[2], tag, depth + 1)


def tlv(tag, content):
    length = len(content)
    if length > 0xFF:
        return bytes([tag, 0x82, length >> 8, length & 0xFF]) + content
    if length > 0x7F:
        return bytes([tag, 0x81, length]) + content
    return bytes([tag, length]) + content


def trimmed(der):
    for _tag, _h, _cs, cend in tlvs(der, 0, len(der)):
        return der[:cend]
    return der


def report(source_path, produced_path):
    source = read(source_path)
    produced = read(produced_path)
    text = produced.decode('latin1')
    out = {'source_bytes': len(source), 'produced_bytes': len(produced)}

    span = re.search(r'/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]', text)
    before = re.search(r'/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]', source.decode('latin1'))
    out['byte_range_unchanged'] = span and before and span.groups() == before.groups()
    if not span:
        return out
    a, length_a, b, length_b = map(int, span.groups())
    out['byte_range'] = [a, length_a, b, length_b]
    out['covers_to_eof'] = b + length_b == len(produced)
    out['bytes_outside_ranges'] = a + (len(produced) - (b + length_b))
    out['gap_is_the_contents_placeholder'] = b - (a + length_a)

    covered = produced[:a + length_a] + produced[b:b + length_b]
    write(f'{WORK}/covered.bin', covered)

    contents = re.search(r'/Contents\s*<([0-9A-Fa-f\s]+)>', text)
    if not contents:
        out['contents'] = 'none'
        return out
    der = trimmed(bytes.fromhex(re.sub(r'\s+', '', contents.group(1))))
    out['der_bytes'] = len(der)
    write(f'{WORK}/contents.der', der)

    # SignerInfo is the single SEQUENCE inside the signerInfos SET; its direct
    # children are version, sid, digestAlgorithm, [0] signedAttrs,
    # signatureAlgorithm, the signature value, [1] unsignedAttrs.
    nodes = tree(der, 0, len(der))
    signer_info = None
    for set_node in find(nodes, 0x31):
        # `find` is a generator, so it is always truthy — ask it for a node.
        if set_node[2] and set_node[2][0][0] == 0x30 and any(find(set_node[2], 0xA0)):
            signer_info = set_node[2][0]
            break
    signature_value = None
    token = None
    if signer_info is not None:
        signature_value = next((child[1] for child in signer_info[2] if child[0] == 0x04), None)
        for attribute in find([c for c in signer_info[2] if c[0] == 0xA1], 0x30):
            if any(oid[1] == TS_OID for oid in find([attribute], 0x06)):
                inner = find([attribute], 0x04)
                token = next((node[1] for node in inner), None)
    if token:
        # A bare token is not a `TimeStampResp`; wrap it in one (`PKIStatusInfo
        # { status 0 }`, then the token as it arrived) so `openssl ts` will read
        # it, exactly as a responder would have sent it.
        write(f'{WORK}/token.tst', token)
        inner = tlv(0x30, bytes.fromhex('020100')) + token
        write(f'{WORK}/token-resp.tst', tlv(0x30, inner))
    out['token_bytes'] = len(token or b'')
    out['signature_value_bytes'] = len(signature_value or b'')

    # The signature still verifies over the bytes it covers.
    verify = run(['openssl', 'cms', '-verify', '-binary', '-inform', 'DER', '-in', f'{WORK}/contents.der',
                  '-content', f'{WORK}/covered.bin', '-noverify', '-out', f'{WORK}/content.bin'])
    out['cms_verify_rc'] = verify.returncode
    out['cms_verify'] = (verify.stdout + verify.stderr).decode()[-200:].strip()

    # pdfsig, a second reader
    pdfsig = run(['pdfsig', produced_path])
    out['pdfsig_rc'] = pdfsig.returncode
    out['pdfsig_lines'] = (pdfsig.stdout + pdfsig.stderr).decode().strip().splitlines()
    out['pdfsig'] = [line for line in out['pdfsig_lines']
                     if re.search(r'Valid|Invalid|Mismatch|total document|Timestamp', line)]

    if token and signature_value:
        write(f'{WORK}/sigvalue.bin', signature_value)
        # Does the token imprint the signature value, or something else?
        request = run(['openssl', 'ts', '-reply', '-in', f'{WORK}/token-resp.tst', '-text'])
        body = (request.stdout + request.stderr).decode()
        out['token_parses'] = request.returncode == 0
        block = body.split('Message data:')[1].split('\n\n')[0] if 'Message data:' in body else ''
        joined = ''.join(re.findall(r'\b[0-9a-f]{2}\b', block.split('Serial number')[0]))[:64]
        out['imprint'] = joined
        out['imprint_is_sha256_of_signature_value'] = joined == hashlib.sha256(signature_value).hexdigest()
        out['imprint_is_sha256_of_the_document_digest'] = False
        out['gen_time'] = (re.search(r'Time stamp: (.*)', body) or [None, None])[1]
        out['policy'] = (re.search(r'Policy OID: (.*)', body) or [None, None])[1]

        certs = run(['openssl', 'pkcs7', '-inform', 'DER', '-in', f'{WORK}/token.tst', '-print_certs'],
                    cwd=WORK)
        raw = certs.stdout.decode()
        blocks = re.findall(r'-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----', raw, re.S)
        # The token carries the responder and its two issuers, but not the root
        # that anchors them (`DigiCert Assured ID Root CA`), so that one is fetched
        # — otherwise every chain error reads as a defect in the token.
        anchor = f'{WORK}/anchor.pem'
        if not os.path.exists(anchor):
            run(['curl', '-sS', '-o', f'{WORK}/anchor.crt',
                 'https://cacerts.digicert.com/DigiCertAssuredIDRootCA.crt'])
            run(['openssl', 'x509', '-inform', 'DER', '-in', f'{WORK}/anchor.crt', '-out', anchor])
        anchor_pem = read(anchor).decode() if os.path.exists(anchor) else ''
        ca = '\n'.join(blocks[1:]) + '\n' + anchor_pem
        write(f'{WORK}/chain.pem', ca.encode())
        write(f'{WORK}/root.pem', ca.encode())
        signer = re.search(r'subject=.*?CN=([^,\n]+)', raw)
        out['tsa_certs'] = [signer.group(1)] if signer else []
        verified = run(['openssl', 'ts', '-verify', '-token_in', '-in', f'{WORK}/token.tst',
                        '-data', f'{WORK}/sigvalue.bin', '-CAfile', f'{WORK}/root.pem',
                        '-untrusted', f'{WORK}/chain.pem'])
        out['ts_verify_over_signature_value_rc'] = verified.returncode
        out['ts_verify_over_signature_value'] = (verified.stdout + verified.stderr).decode()[-160:].strip()
        other = run(['openssl', 'ts', '-verify', '-token_in', '-in', f'{WORK}/token.tst',
                     '-data', f'{WORK}/covered.bin', '-CAfile', f'{WORK}/root.pem',
                     '-untrusted', f'{WORK}/chain.pem'])
        out['ts_verify_over_covered_bytes_rc'] = other.returncode

    # The document still draws, compared with its source.
    try:
        import pymupdf
        for path, key in ((source_path, 'source'), (produced_path, 'produced')):
            doc = pymupdf.open(path)
            inks = []
            for page in doc:
                pix = page.get_pixmap(dpi=72)
                inks.append(sum(1 for i in range(0, len(pix.samples), 3) if pix.samples[i] < 250))
            out[f'{key}_pages'] = doc.page_count
            out[f'{key}_text_chars'] = sum(len(p.get_text()) for p in doc)
            out[f'{key}_ink'] = inks
    except Exception as error:  # noqa: BLE001 - a probe
        out['pymupdf'] = str(error)
    return out


if __name__ == '__main__':
    print(json.dumps(report(sys.argv[1], sys.argv[2]), indent=1))
