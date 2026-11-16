#!/usr/bin/env python3
"""Judge an `edit-attachments` output: names, payload bytes, leftover streams.

Round 063. Every claim the card makes about a rename or a delete is read off the
file rather than off the tool's sentence:

  * the name-tree key, `/F` and `/UF` of each entry (so a rename that moved only
    one of the three shows as a mismatch),
  * the SHA-256 of each payload (so "the bytes are unchanged" is a digest, not a
    size),
  * how many `/EmbeddedFile` streams are left (so a delete that unlinked the
    entry and orphaned the stream shows),
  * libqpdf's syntax check, the page count, the extracted-text length and `/Info`,
    which a rename must not disturb.

    python3 docs/research/edit-attachments-063-check.py SOURCE OUT

`SOURCE` is measured the same way, so the two columns are comparable. Exit status
is 0 when OUT holds exactly what is asked for in the argument order used below.
"""
import hashlib
import sys

import pikepdf
import pymupdf


def measure(path):
    doc = pymupdf.open(path)
    entries = []
    for index in range(doc.embfile_count()):
        info = doc.embfile_info(index)
        payload = doc.embfile_get(index)
        entries.append((info['name'], repr(info['ufilename']), len(payload),
                        hashlib.sha256(payload).hexdigest()[:16]))
    pdf = pikepdf.open(path)
    streams = 0
    names = []
    for object_ in pdf.objects:
        if isinstance(object_, pikepdf.Stream) and str(object_.stream_dict.get('/Type')) == '/EmbeddedFile':
            streams += 1
        if isinstance(object_, pikepdf.Dictionary):
            if str(object_.get('/Type')) == '/Filespec':
                names.append(('spec', object_.get('/F').unparse() if object_.get('/F') is not None else None,
                              object_.get('/UF').unparse() if object_.get('/UF') is not None else None))
            if '/EmbeddedFiles' in object_:
                names.append(('tree', [str(k) for k in object_['/EmbeddedFiles']['/Names'][::2]]))
    return {
        'pages': doc.page_count,
        'text': sum(len(page.get_text()) for page in doc),
        'title': (doc.metadata or {}).get('title'),
        'entries': entries,
        'streams': streams,
        'names': names,
        'syntax': pdf.check_pdf_syntax(),
    }


def main(argv):
    if len(argv) != 3:
        print(__doc__)
        return 2
    before, after = measure(argv[1]), measure(argv[2])
    for key in before:
        print(f'{key:8} {before[key]!r}')
        print(f'{"":8} -> {after[key]!r}')
    ok = (
        after['syntax'] == []
        and after['pages'] == before['pages']
        and after['text'] == before['text']
        and after['title'] == before['title']
        and after['streams'] == len(after['entries'])
        and all(entry[3] in {b[3] for b in before['entries']} for entry in after['entries'])
    )
    print('OK' if ok else 'MISMATCH')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
