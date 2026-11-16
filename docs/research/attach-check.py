#!/usr/bin/env python3
"""Measure an `add-attachments` download against the document it came from.

    python3 docs/research/attach-check.py SRC.pdf OUT.pdf NAME=SHA [NAME=SHA ...]

For every enclosure it prints the name-tree key, `/F`, `/UF`, the `/EF` keys,
`/Subtype`, `/Params` (`/Size`, `/ModDate`, `/CheckSum`) and the SHA-256 of the
payload a reader actually gets back; the expected SHA for each name is passed on the
command line and compared. Page count, per-sheet ink and text, `/Info` and any
pre-existing enclosure are compared with the source measured the same way, so
"nothing else moved" is a number rather than a sentence. Read by PyMuPDF 1.28.2,
pypdf 6.14.2 and libqpdf 12.3.2 (pikepdf 10.9.1) — never by this app's own reader.
"""
import hashlib
import sys

import pikepdf
import pymupdf
import pypdf

src, out = sys.argv[1], sys.argv[2]
expected = dict(pair.split('=', 1) for pair in sys.argv[3:])


def census(path):
    doc = pymupdf.open(path)
    return {
        'pages': doc.page_count,
        'ink': [sum(1 for b in page.get_pixmap(dpi=72).samples if b < 250) for page in doc],
        'text': [len(page.get_text()) for page in doc],
        'info': {k: v for k, v in doc.metadata.items() if k not in ('format', 'encryption')},
        'emb': [hashlib.sha256(doc.embfile_get(i)).hexdigest() for i in range(doc.embfile_count())],
    }


a, b = census(src), census(out)
print('pages', a['pages'], '->', b['pages'], 'same' if a['pages'] == b['pages'] else 'CHANGED')
print('ink', a['ink'], '->', b['ink'], 'same' if a['ink'] == b['ink'] else 'CHANGED')
print('text', a['text'], '->', b['text'], 'same' if a['text'] == b['text'] else 'CHANGED')
print('/Info same' if a['info'] == b['info'] else f'/Info CHANGED {a["info"]} -> {b["info"]}')
print('pre-existing payloads same', a['emb'] == b['emb'][:len(a['emb'])])

pdf = pikepdf.open(out)
names = pdf.Root.Names.EmbeddedFiles.Names if '/Names' in pdf.Root else None
seen = {}
if names is not None:
    for i in range(0, len(names), 2):
        key, spec = names[i], names[i + 1]
        stream = spec.EF.F
        body = stream.read_bytes()
        digest = hashlib.sha256(body).hexdigest()
        seen[str(key)] = digest
        params = {str(k): str(v) for k, v in dict(stream.Params).items()}
        print('ENTRY name-tree-key', key.unparse(),
              '| /F', spec.get('/F').unparse(),
              '| /UF', spec.get('/UF').unparse(),
              '| /EF', list(spec.EF.keys()),
              '| /Subtype', str(stream.get('/Subtype')),
              '| /Size', params.get('/Size'),
              '| /ModDate', params.get('/ModDate'),
              '| /CheckSum', 'yes' if '/CheckSum' in params else 'no',
              '| sha256', digest, 'len', len(body))
print('pypdf names', [entry.name for entry in pypdf.PdfReader(out).attachment_list])
print('AF members', len(pdf.Root.AF) if '/AF' in pdf.Root else 0, '| /PageMode', str(pdf.Root.get('/PageMode')))

bad = []
for name, want in expected.items():
    got = seen.get(name)
    print(('OK  ' if got == want else 'BAD '), name, 'want', want, 'got', got)
    if got != want:
        bad.append(name)
print('VERDICT', 'PASS' if not bad and b['ink'] == a['ink'] and b['text'] == a['text'] and b['pages'] == a['pages'] else 'FAIL')
sys.exit(0 if not bad else 1)
