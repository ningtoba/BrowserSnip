#!/usr/bin/env python3
"""Measure the c2 BMP/TIFF battery: rendered page pixels vs the source decoded.

One page render at 1:1 (72 dpi -> one pixel per point, the tool's own hug
convention) compared channel-wise against the untouched fixture decoded by the
same reference decoder (Pillow) — plus page boxes and, for 32-bit BMP, the
/SMask split. A run that failed prints its refusal sentence verbatim.
"""
import json
import sys
import pymupdf
from PIL import Image

FX = "/tmp/lane-convert/fx"
EXPECTED = {
    # the fixture whose truth cannot be a Pillow decode (RLE4): the palette the
    # file itself embeds, applied to the known index pattern, built by the fixture script
    "c2-rle4": f"{FX}/rle4-expected.png",
    "c2-rle4sdk": f"{FX}/rle4-expected.png",
}

def src_rgb(path):
    im = Image.open(path)
    if im.mode in ("RGBA", "LA") or "transparency" in im.info:
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        bg.alpha_composite(im)
        return bg.convert("RGB")
    if im.mode == "I;16":
        return im  # caller decides the mapping
    return im.convert("RGB")

def render_pages(pdf):
    doc = pymupdf.open(pdf)
    out = []
    for page in doc:
        pix = page.get_pixmap(matrix=pymupdf.Matrix(1, 1), alpha=False)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        out.append((page.rect, img))
    # smask presence on page 0
    xrefs = [x[0] for x in doc[0].get_images(full=True)]
    smasks = []
    for x in xrefs:
        d = doc.extract_image(x)
        smasks.append(bool(d.get("smask")))
    return doc.name, out, smasks, doc.page_count

def diff(a, b):
    if a.size != b.size:
        return f"SIZE a={a.size} b={b.size}", None, None
    pa, pb = a.load(), b.load()
    worst = 0
    bad = 0
    for y in range(a.size[1]):
        for x in range(a.size[0]):
            ca, cb = pa[x, y], pb[x, y]
            d = max(abs(u - v) for u, v in zip(ca, cb))
            worst = max(worst, d)
            bad += d > 0
    return f"maxdiff={worst} differing={bad}/{a.size[0]*a.size[1]}", worst, bad

for line in open(sys.argv[1]):
    r = json.loads(line)
    if r.get("tool") not in ("bmp-to-pdf", "tiff-to-pdf"):
        continue
    tag = r.get("tag")
    files = r.get("files", [])
    def fxpath(f):
        import os
        if os.path.isabs(f) and os.path.exists(f):
            return f
        for base in (FX, "/tmp/triage/in"):
            if os.path.exists(f"{base}/{f.split('/')[-1]}"):
                return f"{base}/{f.split('/')[-1]}"
        raise FileNotFoundError(f)
    files = [fxpath(f) for f in files]
    if not r.get("ok"):
        print(f"{tag}: REFUSED -> {str(r.get('alert'))[:400]}")
        continue
    outs = r.get("outputs") or []
    if not outs:
        print(f"{tag}: ok but NO OUTPUT")
        continue
    path = outs[0]["path"]
    _, pages, smasks, n = render_pages(path)
    src = EXPECTED.get(tag, files[0])
    sim = Image.open(src)
    frames = getattr(sim, "n_frames", 1)
    notes = []
    if frames > 1 and sim.format == "TIFF":
        srcs = []
        for f in range(frames):
            sim.seek(f)
            srcs.append(sim.convert("RGB"))
    else:
        s = src_rgb(src)
        if s.mode == "I;16":
            raw = s.tobytes()
            hi = Image.frombytes("L", s.size, raw[1::2]).convert("RGB")
            lo = Image.frombytes("L", s.size, raw[0::2]).convert("RGB")
            # match which byte the page took
            dh = diff(pages[0][1], hi)[1]
            dl = diff(pages[0][1], lo)[1]
            pick = "hi8" if (dh is not None and (dl is None or dh <= dl)) else "lo8"
            srcs = [hi if pick == "hi8" else lo]
            notes.append(f"16-bit compared against {pick}")
        else:
            srcs = [s]
    verdicts = []
    for i, (rect, img) in enumerate(pages):
        s = srcs[i] if i < len(srcs) else srcs[-1]
        txt, worst, bad = diff(img, s)
        box = f"box={rect.width:.2f}x{rect.height:.2f}pt srcpx={s.size}"
        verdicts.append(f"p{i+1} {box} {txt}")
    print(f"{tag}: {outs[0]['name']} {outs[0]['bytes']}B pages={n} smask={smasks} " + " | ".join(verdicts) + (" [" + "; ".join(notes) + "]" if notes else ""))
