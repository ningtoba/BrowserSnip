#!/usr/bin/env python3
"""
Judge the files `md-struct-rig.test.ts` produced, with a reader that shares no code
with this app.

For each `<dir>/<label>.pdf` it prints what MuPDF sees on the sheets — run position,
baseline, size and font, the `/Annots`, the placed images, the drawn rules and the
ink — plus the sentence and warnings the run printed from the rig's JSON, and a few
derived structural numbers the markdown claims turn on:

  * `distinct_size_font`: how many (size, font) pairs the page holds — a document
    whose heading, body, bold and code runs all collapse to one pair has lost its
    structure even though every word is present;
  * `marker_xs` / `marker_ys`: where list markers and their text sit, so nesting and
    the task-list checkbox can be judged, not admired;
  * `link_annots` + `urls_in_text`: where the URLs went;
  * `code_ink_px`: dark pixels inside a code block's own band — the code branch paints
    its background after its text, which shows up here as a box with nothing in it;
  * `fffd` and `boxes`: characters the embedded face could not draw.

  npx vitest run --config docs/research/md-struct.vitest.config.ts
  python3 docs/research/md-struct-measure.py /tmp/mdstruct before-fix \
    | tee docs/research/md-struct-before.txt
"""
import glob
import io
import json
import os
import re
import sys

import pymupdf
from PIL import Image

DIR = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "/tmp/mdstruct")  # noqa: S108 — the rig's scratch dir
TAG = sys.argv[2] if len(sys.argv) > 2 else "run"
MARKS = ["MKSTART", "MKEND", "MKH", "MKF"]
DPI = 150


def compact(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def read(path: str) -> str:
    if not os.path.exists(path):
        return ""
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def words(page):
    return [(round(w[0], 1), round(w[1], 1), round(w[3], 1), w[4]) for w in page.get_text("words")]


def ink_in(page, rect):
    pix = page.get_pixmap(dpi=DPI, clip=rect)
    img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("L")
    return sum(1 for p in img.getdata() if p < 128)


def main() -> int:
    print(f"## {TAG} — {DIR}, judged by MuPDF outside this app")
    for path in sorted(glob.glob(os.path.join(DIR, "*.pdf"))):
        label = os.path.basename(path)[: -len(".pdf")]
        meta = json.loads(read(os.path.join(DIR, f"{label}.json")) or "{}")
        source = read(os.path.join(DIR, f"{label}.src.md"))
        doc = pymupdf.open(path)
        first = doc[0]
        all_text = compact("".join(str(p.get_text("text")) for p in doc))
        spans = [(round(s["size"], 2), s["font"]) for p in doc for b in p.get_text("dict")["blocks"] if b.get("type") == 0
                 for l in b["lines"] for s in l["spans"]]
        pairs = sorted({(size, font.split("+")[-1]) for size, font in spans})
        ws = words(first)
        markers = [(x0, y1, t) for x0, _, y1, t in ws if t in ("•", "-", "◦", "*", "[ ]", "[x]", "[X]", "☐", "☑", "1.", "2.", "3.")]
        annots = [a for p in doc for a in (p.annots() or [])]
        link_annots = [a for a in annots if a.type[0] == "Link"]
        uris = []
        for a in link_annots:
            try:
                uris.append(a.info.get("uri") or (a.get_text() if hasattr(a, "get_text") else ""))
            except Exception:  # noqa: BLE001 — a malformed annot is itself the finding
                uris.append("<unreadable>")
        images = sum(len(p.get_images()) for p in doc)
        image_boxes = [tuple(round(v, 1) for v in r) for p in doc for r in [i for i in [im["bbox"] for im in p.get_image_info()]]]
        drawings = sum(len(p.get_drawings()) for p in doc)
        remote = sorted({u for u in meta.get("fetched", []) if re.match(r"^https?://(?!localhost|127\.)", u)})
        missing = [m for m in MARKS if m not in all_text.replace(" ", "")]
        print(f"\n=== {label}  sheets={meta.get('sheets', '-')}  runs={meta.get('streamRuns', '-')}/outside={meta.get('runsOutsideBox', '-')}  "
              f"images={images}  annots={len(annots)}/{len(link_annots)} links  drawings={drawings}")
        print(f"    message : {meta.get('message', '')}")
        for line in meta.get("warnings", []) or []:
            print(f"    warning : {line}")
        print(f"    net     : {len(meta.get('fetched', []))} fetched, remote={remote}")
        print(f"    faces   : {len(pairs)} distinct (size, family): {pairs[:8]}")
        print(f"    markers : {markers[:10]}")
        print(f"    imgs    : {image_boxes[:4]}")
        print(f"    links   : uris={uris[:4]} | spec in text={'example.com' in all_text} | autolink={'autolink.example' in all_text}")
        print(f"    missing : {missing}  |  FFFD={all_text.count(chr(0xfffd))}  chars={len(all_text)}")
        if (label in {"code-blocks", "fence-script", "mermaid"}):
            code_words = [w for w in ws if re.match(r"(const|function|return|indented|script|div|graph)", w[3])]
            if code_words:
                top = min(w[1] for w in code_words) - 8
                bottom = max(w[2] for w in code_words) + 8
                print(f"    code_ink: {ink_in(first, pymupdf.Rect(50, top, 545, bottom))} dark px in the code band y{round(top)}-{round(bottom)} (0 = painted over)")
        print(f"    x-edges : min={min([w[0] for w in ws], default=0)} max={max([w[2] for w in ws], default=0)} (page {round(first.rect.width, 1)})")
        for x0, y0, y1, text in ws[:10]:
            print(f"      p0 x{x0:6} y{y1:6} {text[:60]!r}")
        doc.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
