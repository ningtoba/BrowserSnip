#!/usr/bin/env python3
"""Measure the c2 PSD/SVG battery: boxes, geometry, pixels, refusal sentences."""
import json
import sys
import pymupdf
from PIL import Image

FX = "/tmp/lane-convert/fx"

def page_img(pdf, p=0):
    d = pymupdf.open(pdf)
    pg = d[p]
    pix = pg.get_pixmap(matrix=pymupdf.Matrix(1, 1), alpha=False)
    return pg.rect, Image.frombytes("RGB", (pix.width, pix.height), pix.samples)

def ink_box(img, want):
    """Smallest rect covering pixels matching want(px)."""
    w, h = img.size
    px = img.load()
    xs = []
    ys = []
    for y in range(h):
        for x in range(w):
            if want(px[x, y]):
                xs.append(x); ys.append(y)
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)

def red(px):
    return px[0] > 150 and px[1] < 100 and px[2] < 100

def blue(px):
    return px[2] > 150 and px[0] < 100

def green(px):
    return px[1] > 150 and px[0] < 120

GEOM = {
    # tag: (page w,h expected pt, ink fn, expected ink box x0 y0 x1 y1 or None)
    "c2-plain": (200, 100, red, (10, 10, 109, 59)),
    "c2-viewbox": (200, 100, blue, (0, 0, 99, 49)),       # 200x100 in a 400x200 viewBox -> half
    "c2-square": (200, 200, blue, (50, 75, 149, 124)),    # 100x50 centred on a 200 square
    "c2-vbonly": (300, 150, green, (150, 0, 224, 149)),   # 120-unit square meet-fitted: scale 1.25, right half
    "c2-rotate": (200, 100, red, (90, 20, 109, 79)),      # 60x20 rotated 90 about the centre
    "c2-extimg": (100, 50, None, None),
    "c2-dataimg": (100, 50, None, None),
    "c2-huge": (4096, 41, red, (0, 0, 40, 40)),           # 6000x60 capped at 4096: 60*4096/6000=40.96
    "c2-a4margin": (595.28, 841.89, None, None),
    "c2-filter": (60, 60, None, None),
}

for line in open(sys.argv[1]):
    r = json.loads(line)
    tool = r.get("tool")
    tag = r.get("tag")
    if tool not in ("psd-to-pdf", "svg-to-pdf"):
        continue
    if not r.get("ok"):
        print(f"{tool} {tag}: REFUSED -> {str(r.get('alert'))[:330]}".replace("\n", " | "))
        continue
    out = (r.get("outputs") or [{}])[0]
    path = out.get("path")
    if not path:
        print(f"{tool} {tag}: ok but no file")
        continue
    d = pymupdf.open(path)
    rect0, img = page_img(path)
    line1 = f"{tool} {tag}: pages={d.page_count} box={rect0.width:.2f}x{rect0.height:.2f}pt bytes={out.get('bytes')}"
    if tool == "svg-to-pdf" and tag in GEOM:
        want_w, want_h, want_fn, want_box = GEOM[tag]
        geom = ""
        if want_fn is not None:
            got = ink_box(img, want_fn)
            geom = f" inkbox={got} want={want_box}" + (" MATCH" if got == want_box else " DIFF")
        line1 += f" boxwant=({want_w},{want_h})" + geom
    if tool == "svg-to-pdf" and tag == "c2-extimg":
        left = img.crop((0, 0, 50, 50)).getcolors(2500) or []
        nonwhite = sum(c for c, col in left if col != (255, 255, 255))
        line1 += f" left-half non-white px={nonwhite}"
    if tool == "svg-to-pdf" and tag == "c2-dataimg":
        right = img.crop((50, 0, 100, 50))
        nonwhite = sum(1 for col in right.getdata() if col != (255, 255, 255))
        line1 += f" right-half non-white px={nonwhite}"
    if tool == "svg-to-pdf" and tag == "c2-filter":
        # blurred 40x40 black square: edge pixels between 0 and 255 prove the filter RAN
        edge = img.getpixel((9, 30))
        core = img.getpixel((30, 30))
        line1 += f" edge={edge} core={core} softened={'yes' if 8 < edge[0] < 247 else 'no'}"
    if tool == "psd-to-pdf":
        # compare against the composite the fixture embedded
        src = {"c2-jpeg0": "psd-jpeg0.psd", "c2-batch": "psd-jpeg0.psd", "c2-16jpeg": "psd-16jpeg.psd",
               "c2-cmykjpeg": "psd-cmykjpeg.psd", "c2-png": "psd-png.psd"}.get(tag)
        if src:
            raw = open(f"{FX}/{src}", "rb").read()
            import io
            j = raw.find(b"\xff\xd8\xff")
            p = raw.find(b"\x89PNG")
            if tag == "c2-png" and p >= 0:
                s = Image.open(io.BytesIO(raw[p:raw.find(b"IEND", p) + 8])).convert("RGB")
            elif 0 <= j:
                s = Image.open(io.BytesIO(raw[j:raw.rfind(b"\xff\xd9") + 2])).convert("RGB")
            elif 0 <= p:
                s = Image.open(io.BytesIO(raw[p:raw.find(b"IEND", p) + 8])).convert("RGB")
            else:
                s = None
            if s is not None:
                worst = 0; bad = 0
                for y in range(min(s.size[1], img.size[1])):
                    for x in range(min(s.size[0], img.size[0])):
                        dd = max(abs(u - v) for u, v in zip(img.getpixel((x, y)), s.getpixel((x, y))))
                        worst = max(worst, dd); bad += dd > 0
                line1 += f" vs-embedded-jpeg maxdiff={worst} differing={bad}/{s.size[0]*s.size[1]}"
    print(line1)
