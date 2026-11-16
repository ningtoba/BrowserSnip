#!/usr/bin/env python3
"""Judge `remove-annotations` in the bytes: the counts, the content, the form.

Three questions, asked of a source/output pair and judged with readers that did
not write the input:

  1. **the count** — every `/Annots` entry per sheet, what MuPDF lists (marks,
     links, widgets) and each one's subtitle. A pop-up is an entry but not a mark.
  2. **the content underneath** — `/Contents` byte for byte, the boxes and
     `/Rotate`, then a 72 dpi render with annotation appearances off. MuPDF's
     raster shifts a level or two when a sheet stops carrying `/Annots` at all,
     so `--strip-control` runs the same measurement on a strip-only copy and its
     number is the tolerance: past it, content moved.
  3. **the form** — `/AcroForm /Fields` resolved, and a walk of every indirect
     reference in the file (qpdf's `--check` code path, `check_pdf_syntax`, does
     *not* flag a ref whose object is gone; pypdf does, and so does this).

  python3 docs/research/remove-annotations-bytes.py --src IN.pdf --out OUT.pdf \
      [--strip-control STRIPPED.pdf] [--expect-empty]
  python3 docs/research/remove-annotations-bytes.py --src IN --out OUT --quiet

`--expect-empty` requires the sheets to come back with no entries at all; the
exit code is 1 on any failure, so a run is a check.
"""
from __future__ import annotations

import argparse
import hashlib
import sys

import pikepdf
import pymupdf
from pypdf import PdfReader


def census(path: str) -> dict:
    doc = pymupdf.open(path)
    rows = []
    for page in doc:
        kind, value = doc.xref_get_key(page.xref, 'Annots')
        entries = value.count(' 0 R') if kind == 'array' else 0
        rows.append({
            'box': (round(page.rect.width, 1), round(page.rect.height, 1)),
            'rotate': page.rotation,
            'entries': entries,
            'marks': [(str(a.type[0]) + a.type[1], tuple(round(v, 1) for v in a.rect)) for a in (page.annots() or [])],
            'links': len(page.get_links()),
            'widgets': len(list(page.widgets() or [])),
            'chars': len(page.get_text()),
        })
    reader = PdfReader(path)
    meta = reader.metadata or {}
    return {
        'pages': doc.page_count,
        'rows': rows,
        'title': meta.get('/Title'),
        'outline': len(reader.outline) if reader.outline else 0,
    }


def layer(page: pymupdf.Page) -> bytes:
    return page.get_pixmap(dpi=72, alpha=False, annots=False).samples


def content(src: str, out: str, control: str | None) -> int:
    a, b = pymupdf.open(src), pymupdf.open(out)
    c = pymupdf.open(control) if control else None
    bad = 0
    for pa, pb in zip(a, b, strict=True):
        same_streams = [pa.parent.xref_stream(x) for x in pa.get_contents()] == [pb.parent.xref_stream(x) for x in pb.get_contents()]
        ok = same_streams and pa.rect == pb.rect and pa.rotation == pb.rotation
        sa, sb = layer(pa), layer(pb)
        moved = sum(1 for i in range(len(sa)) if sa[i] != sb[i])
        delta = max((abs(sa[i] - sb[i]) for i in range(len(sa)) if sa[i] != sb[i]), default=0)
        bound = None
        if c is not None:
            sc = layer(c[pa.number])
            bound = sum(1 for i in range(len(sa)) if sa[i] != sc[i])
        print(f'  p{pa.number + 1} content-streams-equal={same_streams} moved-channels={moved}'
              f' max-delta={delta} control={bound}')
        if not ok or (bound is not None and moved > bound) or (bound is None and moved):
            bad += 1
    return bad


def references(path: str) -> list[str]:
    out: list[str] = []

    def walk(obj, pdf, seen, where):
        if obj is None:
            out.append(f'{where} -> unresolved')
            return
        gen = getattr(obj, 'objgen', (0, 0))
        if gen != (0, 0):
            if gen in seen:
                return
            seen.add(gen)
            try:
                obj = pdf.get_object(gen)
            except Exception:
                out.append(f'{where} -> {gen}')
                return
        if isinstance(obj, pikepdf.Array):
            for i, value in enumerate(obj):
                walk(value, pdf, seen, f'{where}[{i}]')
        elif isinstance(obj, pikepdf.Dictionary):
            for key, value in obj.items():
                walk(value, pdf, seen, f'{where}/{key}')

    with pikepdf.open(path) as pdf:
        walk(pdf.Root, pdf, set(), 'Root')
    return out


def form(path: str) -> list[str]:
    with pikepdf.open(path) as pdf:
        acro = pdf.Root.get('/AcroForm')
        if acro is None:
            return ['no /AcroForm']
        fields = acro.get('/Fields')
        if fields is None:
            return ['/AcroForm without /Fields']
        rows = []
        for entry in fields:
            if entry is None:
                rows.append('unresolved')
                continue
            rows.append(f'T={entry.get("/T")} kids={len(entry.get("/Kids", []))}')
        return [f'/Fields {len(fields)}: ' + '; '.join(rows)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--strip-control')
    ap.add_argument('--expect-empty', action='store_true')
    args = ap.parse_args()

    before, after = census(args.src), census(args.out)
    for label, data in (('src', before), ('out', after)):
        print(f'{label} pages={data["pages"]} entries={sum(r["entries"] for r in data["rows"])}'
              f' marks={sum(len(r["marks"]) for r in data["rows"])}'
              f' links={sum(r["links"] for r in data["rows"])}'
              f' widgets={sum(r["widgets"] for r in data["rows"])}'
              f' title={data["title"]!r} outline={data["outline"]}')
        for i, row in enumerate(data['rows']):
            print(f'  p{i + 1} {row["box"]} rot={row["rotate"]} entries={row["entries"]} chars={row["chars"]} {row["marks"]}')

    failures = 0
    if args.expect_empty and any(r['entries'] for r in after['rows']):
        print('FAIL: entries survived on a sheet')
        failures += 1
    if after['pages'] != before['pages']:
        print(f'FAIL: page count {before["pages"]} -> {after["pages"]}')
        failures += 1
    if before['title'] and after['title'] != before['title']:
        print(f'FAIL: title {before["title"]!r} -> {after["title"]!r}')
        failures += 1
    if after['outline'] != before['outline']:
        print(f'FAIL: outline {before["outline"]} -> {after["outline"]}')
        failures += 1

    moved = content(args.src, args.out, args.strip_control)
    if moved:
        print(f'FAIL: content moved on {moved} sheet(s)')
        failures += 1

    print('src form:', form(args.src))
    print('out form:', form(args.out))
    dangling = references(args.out)
    print(f'out dangling references: {len(dangling)} {dangling[:6]}')
    if dangling:
        failures += 1

    with open(args.out, "rb") as handle:
        print(f'sha256 out {hashlib.sha256(handle.read()).hexdigest()[:16]}')
    print('VERDICT', 'FAIL' if failures else 'PASS', f'({failures} failure(s))')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
