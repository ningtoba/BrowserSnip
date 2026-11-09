#!/usr/bin/env python3
"""
Read a WYSIWYG run's produced files and say what the bytes actually carry.

  bash docs/research/wysiwyg-measure.sh                       # drives both probes
  python3 docs/research/wysiwyg-bytes.py /tmp/wysiwyg/after --source /tmp/sample.pdf

`wysiwyg-rig.mjs` and `colour-rail.mjs` put a style on the page and take the
screenshot; this answers the other half of the campaign's rule — what is *in the file*:

* **which faces the run added**, by subtracting the source document's own `/BaseFont`
  list from the produced file's. A page that already cites Helvetica proves nothing
  about a watermark asked for in Courier; only the difference is the tool's doing.
* **what each mark drew**, read out of its own appearance stream: the `/Tf` size, the
  `rg` fill, the `Tm` baselines — and the gap between two baselines, which is what a
  "line height" claim has to mean in bytes. PyMuPDF's page text does not include an
  annotation's appearance, so a mark measured from `get_text` is not the mark at all.
* **the ink a mark lays down**, inside its own rectangle, against the same page with
  its annotations deleted. A name in `/BaseFont` that paints nothing is still nothing
  — that is the defect class the font-subset row just closed.
* **the extracted text**, because a Japanese run that comes back as `?????` was folded
  to WinAnsi whatever the face is called.

It exits non-zero when a produced file contradicts the claim its surface makes, so it
is a check and not a printout.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any, cast

import pymupdf

# What the rig claims for each surface, in the same words it sets.
EXPECT: dict[str, dict] = {
    "textbox": {
        "face": "NotoSans-Bold",
        "markFace": "NotoSans-Bold",
        "markSize": 22,
        "markGap": 44,
        "markFill": (0.545, 0.361, 0.965),
        "marks": True,
    },
    "stamp": {"markFace": "Times-Bold", "marks": True},
    # A sticky note is the surface with no style control: the claim is that the mark
    # exists and carries the pen's colour in `/C`. Whether MuPDF paints the 26 pt icon
    # in `get_pixmap` is the renderer's choice, not this feature's, so ink is not
    # claimed here — see the note in `wysiwyg-text-style-findings.md`.
    "note": {"noteColor": (0.02, 0.588, 0.412), "noDa": True},
    "edittext": {"spanFace": "Times-Bold", "extract": "edited", "size": 20},
    "headerfooter": {"spanFace": "Times-Bold", "extract": "Quarterly", "size": 16},
    "pagenumbers": {"spanFace": "Times-Italic", "extract": "Page1of1", "size": 22},
    "watermark": {"spanFace": "Courier-Bold", "extract": "Draft", "size": 48},
    "addstamps": {"markFace": "Times-Italic", "marks": True},
}

BASE_FONT = re.compile(r"/BaseFont\s*/([A-Za-z0-9+,\-.]+)")
FORM = re.compile(r"/Subtype\s*/Form\b")
FONT_REF = re.compile(r"/Font\s+(\d+)\s+0\s+R|/Font\s*<<([^>]*)>>")
INNER_REF = re.compile(r"/(\w+)[\s/]+(\d+)\s+0\s+R")


def all_faces(doc: pymupdf.Document) -> set[str]:
    found: set[str] = set()
    for xref in range(1, doc.xref_length()):
        obj = doc.xref_object(xref, compressed=True) or ""
        for match in BASE_FONT.finditer(obj):
            found.add(match.group(1))
    return found


def font_names(doc: pymupdf.Document, xref: int) -> dict[str, str]:
    """The `/F1 → BaseFont` map a form XObject's own resources declare."""
    out: dict[str, str] = {}
    obj = doc.xref_object(xref, compressed=True) or ""
    for _, inline in FONT_REF.findall(obj):
        for name, target in INNER_REF.findall(inline or ""):
            text = doc.xref_object(int(target), compressed=True) or ""
            base = BASE_FONT.search(text)
            if base:
                out[name] = base.group(1)
    match = FONT_REF.search(obj)
    if match and match.group(1):
        text = doc.xref_object(int(match.group(1)), compressed=True) or ""
        for name, target in INNER_REF.findall(text):
            base = BASE_FONT.search(doc.xref_object(int(target), compressed=True) or "")
            if base:
                out[name] = base.group(1)
    return out


def mark_drawings(doc: pymupdf.Document) -> list[dict[str, Any]]:
    """
    Every annotation appearance, as the file draws it.

    Size, fill and the baselines the stream positions, read from the operators — the
    same strings the appearance writer emitted, and the only place a FreeText's own
    line breaks exist once the file is saved.
    """
    out: list[dict[str, Any]] = []
    for xref in range(1, doc.xref_length()):
        obj = doc.xref_object(xref, compressed=True) or ""
        if not FORM.search(obj) or "/BBox" not in obj:
            continue
        raw = doc.xref_stream(xref)
        if not raw:
            continue
        ops = bytes(raw).decode("latin-1", "replace")
        if "Tj" not in ops and "TJ" not in ops:
            continue
        names = font_names(doc, xref)
        sizes = [float(m.group(2)) for m in re.finditer(r"/([\w.-]+)\s+([\d.]+)\s+Tf", ops)]
        faces = [names.get(m.group(1), m.group(1)) for m in re.finditer(r"/([\w.-]+)\s+[\d.]+\s+Tf", ops)]
        fills = [
            tuple(round(float(v), 3) for v in m.group(1).split())
            for m in re.finditer(r"((?:\d*\.?\d+ ){2}\d*\.?\d+) rg", ops)
        ]
        baselines = sorted({float(m.group(2)) for m in re.finditer(r"1 0 0 1 ([-\d.]+) ([-\d.]+) Tm", ops)}, reverse=True)
        gaps = [round(a - b, 1) for a, b in zip(baselines, baselines[1:], strict=False)]
        out.append(
            {
                "xref": xref,
                "faces": sorted(set(faces)),
                "sizes": sorted(set(sizes)),
                "fills": sorted(set(fills)),
                "baselines": baselines,
                "gaps": gaps,
                "ops": ops[:200],
            }
        )
    return out


def spans(page: pymupdf.Page) -> list[dict[str, Any]]:
    """Text drawn into the page's own content stream, with face, size and colour."""
    found = []
    dictionary = cast(dict[str, Any], page.get_text("dict"))
    for block in dictionary.get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                found.append(
                    {
                        "text": span["text"],
                        "font": span["font"],
                        "size": round(span["size"], 2),
                        "color": f"#{span['color']:06x}",
                        "baseline": round(span["origin"][1], 1),
                    }
                )
    return found


def count_ink(pixmap: pymupdf.Pixmap) -> int:
    samples = pixmap.samples
    step = pixmap.n
    dark = 0
    for i in range(0, len(samples) - step + 1, step):
        if 0.2126 * samples[i] + 0.7152 * samples[i + 1] + 0.0722 * samples[i + 2] < 140:
            dark += 1
    return dark


def mark_ink(doc: pymupdf.Document) -> list[dict[str, Any]]:
    """
    Ink each annotation lays down, inside its own rectangle.

    Measured twice — as saved, and with every annotation deleted from a copy of the
    same bytes — so the number is the mark's own ink rather than the words already on
    the page underneath it.
    """
    page = doc[0]
    rects = []
    annot = page.first_annot
    while annot is not None:
        rect = annot.rect
        if rect and not rect.is_empty:
            rects.append(rect)
        annot = annot.next
    if not rects:
        return []
    bare = pymupdf.open()
    bare.insert_pdf(doc)
    clean = bare[0]
    while clean.first_annot:
        clean.delete_annot(clean.first_annot)
    out = []
    for index, rect in enumerate(rects):
        clip = pymupdf.IRect(max(int(rect.x0) - 2, 0), max(int(rect.y0) - 2, 0), int(rect.x1) + 2, int(rect.y1) + 2)
        out.append(
            {
                "mark": index + 1,
                "rect": [round(v, 1) for v in rect],
                "ink_px": count_ink(page.get_pixmap(clip=clip, dpi=150)) - count_ink(clean.get_pixmap(clip=clip, dpi=150)),
            }
        )
    return out


def screen_claim(name: str, directory: Path) -> dict[str, Any] | None:
    """What the rig saw on screen, for the surfaces that lay out in the DOM."""
    side = directory / f"{name}.json"
    if not side.exists():
        return None
    data = json.loads(side.read_text())
    zoom = data.get("zoom") or 1
    layouts = (data.get("screen") or {}).get("layout") or []
    if not layouts:
        return {"zoom": zoom, "lines": None}
    lines = layouts[0]["lines"]
    return {
        "zoom": zoom,
        "lines": len(lines),
        "sizePt": [round(line["size"] / zoom, 1) for line in lines],
        "gapPt": round((lines[-1]["y"] - lines[0]["y"]) / zoom, 1) if len(lines) > 1 else None,
        "fill": lines[0].get("fill"),
        "weight": lines[0].get("weight"),
        "family": layouts[0].get("family"),
    }


def close(a: Any, b: Any, tolerance: float = 0.02) -> bool:
    """One number, or the three of an `rg` operand."""
    try:
        if isinstance(a, tuple) or isinstance(b, tuple):
            left = a if isinstance(a, tuple) else (float(a),) * 3
            right = b if isinstance(b, tuple) else (float(b),) * 3
            return len(left) == len(right) and all(abs(float(x) - float(y)) <= tolerance for x, y in zip(left, right, strict=True))
        return abs(float(a) - float(b)) <= tolerance
    except (TypeError, ValueError):
        return False


def check(
    name: str,
    added: set[str],
    found: list[dict[str, Any]],
    text: str,
    drawings: list[dict[str, Any]],
    ink: list[dict[str, Any]],
) -> list[str]:
    spec = EXPECT.get(name) or {}
    bad: list[str] = []
    joined = " ".join(sorted(added)).replace("-", "").lower()
    # A standard-14 face is *named*, not embedded, and the fixture already names all
    # fourteen — so an added-face diff proves nothing for those. `spanFace` is the
    # claim that survives: the font the drawn run itself reports.
    if "face" in spec and spec["face"].replace("-", "").lower() not in joined:
        bad.append(f"expected the run to add a face matching {spec['face']!r}; it added {sorted(added) or 'nothing'}")
    if "spanFace" in spec:
        drawn = sorted({str(s["font"]).replace("-", "").lower() for s in found if close(s["size"], spec.get("size", s["size"]), 1.5)})
        if not any(spec["spanFace"].replace("-", "").lower() in font for font in drawn):
            bad.append(f"expected the run to be drawn in {spec['spanFace']!r}; it drew {drawn or 'nothing at that size'}")
    if "extract" in spec and spec["extract"] not in text:
        bad.append(f"expected {spec['extract']!r} to extract from the file; got {text.strip()[:110]!r}")
    if "size" in spec and not any(close(s["size"], spec["size"], 1.5) for s in found):
        bad.append(f"expected a page run at {spec['size']} pt; the file draws {sorted({s['size'] for s in found})}")
    if "markFace" in spec and not any(
        spec["markFace"].replace("-", "").lower() in " ".join(d["faces"]).replace("-", "").lower() for d in drawings
    ):
        bad.append(f"expected a mark drawn in {spec['markFace']!r}; the appearances name {[d['faces'] for d in drawings]}")
    if "markSize" in spec and not any(any(close(s, spec["markSize"], 1.5) for s in d["sizes"]) for d in drawings):
        bad.append(f"expected a mark at {spec['markSize']} pt; the appearances draw {[d['sizes'] for d in drawings]}")
    if "markGap" in spec and not any(any(close(g, spec["markGap"], 2.5) for g in d["gaps"]) for d in drawings):
        bad.append(f"expected a mark whose lines sit {spec['markGap']} pt apart; the gaps are {[d['gaps'] for d in drawings]}")
    if "markFill" in spec and not any(
        any(close(f, spec["markFill"], 0.02) for f in d["fills"]) for d in drawings
    ):
        bad.append(f"expected the mark filled with {spec['markFill']}; the streams fill {[d['fills'] for d in drawings]}")
    if spec.get("noDa"):
        # PDF holds a note's body as a plain `/Contents` string; there is no font for
        # it to name. Asserting the absence is the proof that the deleted control was
        # deleting a promise, not a feature.
        da = [d for d in defaults(doc) if d.startswith("Text:") and "(no /DA)" not in d]
        if da:
            bad.append(f"a note should declare no text appearance; it declares {da}")
    if "noteColor" in spec:
        got = note_colours(pymupdf.open(path_of(name)))
        if not any(close(g, spec["noteColor"], 0.03) for g in got):
            bad.append(f"expected the note to carry the pen colour {spec['noteColor']}; `/C` holds {got}")
    if spec.get("marks"):
        if not ink:
            bad.append("expected a mark that lays down ink; the page carries none")
        elif all(row["ink_px"] <= 0 for row in ink):
            bad.append(f"every mark measured 0 ink: {ink}")
    return bad


def note_colours(doc: pymupdf.Document) -> list[tuple[float, float, float]]:
    """The `/C` of every annotation — the only colour a sticky note can keep."""
    out = []
    for xref in range(1, doc.xref_length()):
        obj = doc.xref_object(xref, compressed=True) or ""
        match = re.search(r"/Subtype\s*/Text\b.*?/C\s*\[([^\]]+)\]", obj, re.S)
        if match:
            out.append(tuple(round(float(v), 3) for v in match.group(1).split()))  # type: ignore[arg-type]
    return out


def path_of(name: str) -> Path:
    return LAST[name]


LAST: dict[str, Path] = {}


def report(path: Path, source_faces: set[str], directory: Path) -> list[str]:
    doc = pymupdf.open(path)
    page = doc[0]
    added = all_faces(doc) - source_faces
    found = spans(page)
    drawings = mark_drawings(doc)
    ink = mark_ink(doc)
    text = str(page.get_text("text"))
    print(f"\n=== {path.name} ===")
    print(f"  faces it added : {sorted(added) or '(none)'}")
    print(f"  page runs      : sizes {sorted({s['size'] for s in found})}, colours {sorted({s['color'] for s in found})}")
    for drawing in drawings:
        print(
            f"  mark           : faces={drawing['faces']} sizes={drawing['sizes']} fills={drawing['fills']} "
            f"baselines={drawing['baselines'][:4]} gaps={drawing['gaps'][:4]}"
        )
    print(f"  mark ink       : {ink or '(no annotations)'}")
    print(f"  screen claim   : {json.dumps(screen_claim(path.stem, directory))}")
    print(f"  extracted      : {text.strip()[:120]!r}")
    print(f"  all spans      : {[(s['text'][:24], s['font'], s['size'], s['color']) for s in found][:8]}")
    return check(path.stem, added, found, text, drawings, ink)


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    target = Path(sys.argv[1])
    source = Path("/tmp/sample.pdf")
    if "--source" in sys.argv:
        source = Path(sys.argv[sys.argv.index("--source") + 1])
    source_faces = all_faces(pymupdf.open(source)) if source.exists() else set()
    directory = target if target.is_dir() else target.parent
    files = [directory / f"{name}.pdf" for name in EXPECT] if target.is_dir() else [target]
    LAST.clear()
    LAST.update({f.stem: f for f in files})
    failed: list[str] = []
    for file in files:
        if not file.exists():
            print(f"\n=== {file.stem} ===\n  (not produced)")
            continue
        bad = report(file, source_faces, directory)
        for line in bad:
            print(f"  FAIL {file.stem}: {line}")
        if bad:
            failed.append(file.stem)
    print()
    if failed:
        print(f"{len(failed)} file(s) contradicted the claim their surface makes: {', '.join(failed)}")
        return 1
    print("every produced file says what its surface claimed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
