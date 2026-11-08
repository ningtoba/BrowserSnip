"""Audit #3 byte check: read each tool's exported PDF and say what is really in it.

    RESULTS=/tmp/sweep-results.json SWEEP_DIR=/tmp/sweep BASE_PDF=/tmp/sample.pdf \
        python3 docs/research/audit3-bytescan.py [tool …]

For every tool that put a mark on the canvas, this prints the annotation the file
carries (`/Subtype`, `/Rect`, and the keys that matter: `/QuadPoints`, `/L`, `/LE`,
`/IC`, `/CA`, `/AP`), then measures ink two ways — pixels that only exist when
annotations are drawn, and pixels the file changes against the untouched original.
The second number is the one that catches a canvas that lied: a redaction's bar is
burned into the page content, so the annotation layer on its own measures almost
nothing while the file plainly differs.
"""
import json
import os
import sys
import tempfile

import pymupdf

# Scratch paths for a harness run, not user data: the sweep writes them, this reads
# them, and every one is overridable.
TMP = tempfile.gettempdir()
BASE_PDF = os.environ.get('BASE_PDF', os.path.join(TMP, 'sample.pdf'))
RESULTS = os.environ.get('RESULTS', os.path.join(TMP, 'sweep-results.json'))
SWEEP_DIR = os.environ.get('SWEEP_DIR', os.path.join(TMP, 'sweep'))
OUT_JSON = os.environ.get('OUT_JSON', os.path.join(TMP, 'sweep-bytes.json'))
ZOOM = 2

KEYS = ('QuadPoints', 'L', 'LE', 'IC', 'OC', 'C', 'BS', 'AP', 'Contents', 'A')
TEXT_PROBES = ('Audit text box', 'Audit note', 'CYBERJAYA', '+6001111070825', 'Malaysia')


def corners(box):
    """PyMuPDF Rect / tuple → four rounded numbers, top-left origin."""
    if isinstance(box, pymupdf.Rect):
        values = (box.x0, box.y0, box.x1, box.y1)
    else:
        values = tuple(box)
    return [round(float(v), 1) for v in values]


def samples(page, clip, annots):
    pix = page.get_pixmap(matrix=pymupdf.Matrix(ZOOM, ZOOM), alpha=False, annots=annots, clip=clip)
    return pix.samples, pix.n


def changed_pt2(a, b, stride):
    """Area that differs, in PDF points², at the render zoom."""
    differ = sum(1 for i in range(0, len(a), stride) if a[i:i + 3] != b[i:i + 3])
    return round(differ / (ZOOM * ZOOM), 1)


def dark_pt2(pix_samples, stride):
    black = sum(1 for i in range(0, len(pix_samples), stride) if max(pix_samples[i:i + 3]) < 60)
    return round(black / (ZOOM * ZOOM), 1)


def describe(doc, annot):
    e = {
        'sub': annot.type[1],
        'rect': corners(annot.rect),
        'opacity': round(annot.opacity, 2),
        'content': ((annot.info or {}).get('content') or '')[:40],
    }
    for key in KEYS:
        kind, value = doc.xref_get_key(annot.xref, key)
        if kind != 'null':
            e['pdf_' + key] = str(value)[:120]
    return e


def main():
    with open(RESULTS, encoding='utf-8') as handle:
        rows = json.load(handle)
    want = set(sys.argv[1:])
    base_page = pymupdf.open(BASE_PDF)[0]
    out = []
    for row in rows:
        tool = row['tool']
        if want and tool not in want:
            continue
        rec = {'tool': tool, 'created': bool(row['fresh']),
               'canvas_area_px': row['fresh'][0]['area'] if row['fresh'] else None}
        path = f'{SWEEP_DIR}/{tool}.pdf'
        if not (row.get('exp') or {}).get('ok') or not os.path.exists(path):
            rec['export'] = 'FAILED: ' + str((row.get('exp') or {}).get('why'))
            out.append(rec)
            continue
        doc = pymupdf.open(path)
        page = doc[0]
        rec['file_bytes'] = row['exp']['bytes']
        rec['annots'] = [describe(doc, a) for a in (page.annots() or [])]
        rec['links'] = [{'kind': link.get('kind'), 'uri': str(link.get('uri'))[:70],
                         'rect': corners(link.get('from') or pymupdf.Rect())}
                        for link in page.get_links()]
        if row['fresh']:
            x, y, w, h = row['fresh'][0]['pdfRect']
            clip = pymupdf.Rect(max(x - 8, 0), max(y - 8, 0),
                                min(x + w + 8, page.rect.x1), min(y + h + 8, page.rect.y1))
            on, stride = samples(page, clip, True)
            off, _ = samples(page, clip, False)
            original, _ = samples(base_page, clip, False)
            rec['ink_from_annotation_layer_pt2'] = changed_pt2(on, off, stride)
            rec['ink_vs_original_pt2'] = changed_pt2(on, original, stride)
            rec['black_paper_in_area_pt2'] = dark_pt2(on, stride)
        text = page.get_text()
        rec['text_in_file'] = {probe: (probe in text) for probe in TEXT_PROBES}
        doc.close()
        out.append(rec)

    with open(OUT_JSON, 'w', encoding='utf-8') as handle:
        json.dump(out, handle, indent=1, default=str)
    for rec in out:
        subs = [a['sub'] for a in rec.get('annots', [])]
        if not subs and rec.get('links'):
            subs = [f"Link@{rec['links'][0]['rect']}"]
        print(f"{rec['tool']:10s} created={str(rec['created']):5s} "
              f"canvasPx={str(rec.get('canvas_area_px')):>7s} file={subs} "
              f"layerInk={rec.get('ink_from_annotation_layer_pt2')} "
              f"vsOriginal={rec.get('ink_vs_original_pt2')} "
              f"black={rec.get('black_paper_in_area_pt2')} "
              f"text={ {k: v for k, v in (rec.get('text_in_file') or {}).items() if v} } "
              f"{rec.get('export') or ''}")


if __name__ == '__main__':
    main()
