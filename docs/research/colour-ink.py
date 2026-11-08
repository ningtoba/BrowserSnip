#!/usr/bin/env python3
"""Measure what a colour tool actually did to the pixels — per region, per control.

  python3 docs/research/colour-ink.py --src /tmp/colour/colour.pdf --page 1 \
      --out /tmp/colour/invert.pdf --ask invert --polarity

  python3 docs/research/colour-ink.py --src ... --page 2 --out ... \
      --ask brightness=1.6,contrast=1 --not-plain /tmp/colour/plain.pdf

`docs/research/rail-measure.py` answers "is there ink on the page". For
`invert-colors`, `adjust-colors` and `scanner-effect` that is not enough: a blank
page inverts to a blank page, so ink-presence cannot tell a working colour tool from
one that shipped paper. What can is **polarity** (the bar that was black is now
light, the band that was paper is now dark) and **direction** (a brightness of 1.6
lifted the mid greys; a contrast of 2 moved the two greys of the fixture *apart*).

Every assertion is therefore a comparison against a prediction made from the
**source sheet's own measured colour**, pushed through the CSS filter formula the
tool composes (`core/measure.ts` `cssFilterString`, order: grayscale, sepia,
invert, brightness, contrast, saturate, hue-rotate, then the pixel passes) — never
against a number this script invents. Each ask is also scored against an
**identity** prediction (the control did nothing) and an **opposite** prediction
(the control moved the wrong way), and prints `VACUOUS` if no region can tell the
three apart. Exits 1 on any failed ask.
"""
import argparse
import colorsys
import math
import os
import sys

import pymupdf

DPI = 100
STRIDE = 7
TOL = 8.0            # per channel: a 0.9-quality JPEG of the sheet, resampled
MIN_MOVE = 8.0       # a region must be predicted to move at least this to judge an ask
INK_WHITE = 245      # "non-white" exactly as rail-measure.py counts it

# Fractions of the **displayed** sheet from its top-left, matching REGIONS in
# colour-fixture.mjs. PyMuPDF rasterises a page as displayed and pdf.js paints it the same
# way, so this is the one space in which a source sheet and a produced page can be
# compared — and sheet 4 of the fixture exists to prove it: it stores a portrait box with
# `/Rotate 90` and the fixture places that ink *through* the turn, so a mirrored or
# un-inverted mapping reads paper where the bar should be. Keep the two tables in step.
REGIONS = {
    "bar": (0.10, 0.10, 0.90, 0.22),      # solid black
    "copy": (0.08, 0.26, 0.92, 0.82),     # 26 lines of body copy
    "band": (0.10, 0.86, 0.90, 0.97),     # clean paper
    "red": (0.10, 0.10, 0.32, 0.30),
    "green": (0.39, 0.10, 0.61, 0.30),
    "blue": (0.68, 0.10, 0.90, 0.30),
    "grey": (0.10, 0.36, 0.32, 0.50),     # luma ~89, below the contrast pivot
    "wash": (0.39, 0.36, 0.61, 0.50),     # luma ~166, above it
}
# Which regions each sheet of the fixture carries.
PAGE_REGIONS = {
    1: ("bar", "copy", "band"),
    2: ("red", "green", "blue", "grey", "wash", "band"),
    3: ("band",),                                # the empty control
    4: ("bar", "copy", "band"),                  # the same three, on a turned sheet
}


def luma(rgb):
    return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]


def spread(rgb):
    return max(rgb) - min(rgb)


def hue_angle(rgb):
    h = colorsys.rgb_to_hls(*(c / 255 for c in rgb))[0] * 360.0
    return h


def clamp255(v):
    return max(0.0, min(255.0, v))


# ── the filter maths the shipped helper composes, per CSS filter-effects ────────

def m_grayscale(c, t=1.0):
    g = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    return tuple((1 - t) * ch + t * g for ch in c)


def m_invert(c, t=1.0):
    return tuple((1 - t) * ch + t * (1 - ch) for ch in c)


def m_brightness(c, b):
    return tuple(ch * b for ch in c)


def m_contrast(c, k):
    return tuple(k * (ch - 0.5) + 0.5 for ch in c)


def m_saturate(c, s):
    g = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    return tuple(g + s * (ch - g) for ch in c)


def m_hue(c, deg):
    a = math.radians(deg)
    cos, sin = math.cos(a), math.sin(a)
    r, g, b = c
    return (
        (0.213 + cos * 0.787 - sin * 0.213) * r
        + (0.715 - cos * 0.715 - sin * 0.715) * g
        + (0.072 - cos * 0.072 + sin * 0.928) * b,
        (0.213 - cos * 0.213 + sin * 0.143) * r
        + (0.715 + cos * 0.285 + sin * 0.140) * g
        + (0.072 - cos * 0.072 - sin * 0.283) * b,
        (0.213 - cos * 0.213 - sin * 0.787) * r
        + (0.715 - cos * 0.715 + sin * 0.715) * g
        + (0.072 + cos * 0.928 + sin * 0.072) * b,
    )


def m_whiten(c, level=0.45):
    gamma = 1 - level * 0.9
    return tuple(255 * ((ch / 255.0) ** gamma) for ch in c)


def apply_ask(src_rgb, ask):
    """The colour the tool *promises* for a source pixel, in cssFilterString order."""
    c = tuple(ch / 255 for ch in src_rgb)
    if ask.get("grayscale"):
        c = m_grayscale(c)
    if ask.get("invert"):
        c = m_invert(c)
    if "brightness" in ask:
        c = m_brightness(c, ask["brightness"])
    if "contrast" in ask:
        c = m_contrast(c, ask["contrast"])
    if "saturation" in ask:
        c = m_saturate(c, ask["saturation"])
    if "hue" in ask:
        c = m_hue(c, ask["hue"])
    out = tuple(clamp255(ch * 255) for ch in c)
    if "whitening" in ask and ask["whitening"]:
        out = m_whiten(out)
    if "threshold" in ask:
        cutoff = ask["threshold"] * 255
        v = 0.0 if luma(out) < cutoff else 255.0
        out = (v, v, v)
    return out


def opposite(ask):
    """The same control moved the other way: a filter wired backwards lands here."""
    opp = {}
    if "brightness" in ask:
        opp["brightness"] = 1 / ask["brightness"] if ask["brightness"] else 1
    if "contrast" in ask:
        opp["contrast"] = 1 / ask["contrast"] if ask["contrast"] else 1
    if "saturation" in ask:
        opp["saturation"] = 1 / ask["saturation"] if ask["saturation"] else 1
    if "hue" in ask:
        opp["hue"] = -ask["hue"]
    if ask.get("invert"):
        return {"identity": True}
    if "threshold" in ask or "grayscale" in ask:
        return {"identity": True}
    return opp or {"identity": True}


# ── measuring a file ───────────────────────────────────────────────────────────

def raster(page, dpi=DPI):
    return page.get_pixmap(dpi=dpi, colorspace=pymupdf.csRGB)


def pixel(pix, x, y):
    buf = pix.samples
    step = pix.n
    at = y * pix.width * step + x * step
    return (buf[at], buf[at + 1], buf[at + 2])


def ink_pct(pix):
    sampled = dark = 0
    buf = pix.samples
    step = pix.n * STRIDE
    for i in range(0, max(len(buf) - (pix.n - 1), 0), step):
        sampled += 1
        if buf[i] < INK_WHITE or buf[i + 1] < INK_WHITE or buf[i + 2] < INK_WHITE:
            dark += 1
    return 100.0 * dark / max(sampled, 1), dark, sampled


def region_box(pix, name):
    x0, y0, x1, y1 = REGIONS[name]
    w, h = pix.width, pix.height
    ax, ay = int(x0 * w), int(y0 * h)
    bx, by = int(x1 * w), int(y1 * h)
    # Inset so a 1-2 px JPEG ring at the block's edge cannot carry the answer.
    pad = max(2, int(0.02 * min(bx - ax, by - ay)))
    return ax + pad, ay + pad, bx - pad, by - pad


_MEMORY: dict = {}


def region_pixels(pix, name):
    """A strided sample of the region's pixels.

    Cached per bitmap because the asks re-read the same regions, and strided
    because a 200 dpi copy region is half a million pixels and Python walks it
    slowly. Sampling every third pixel leaves 99.9 % of a glyph's anti-aliasing
    population and a mean that agrees with the full walk to well under a unit.
    """
    key = (id(pix), name)
    cached = _MEMORY.get(key)
    if cached is not None:
        return cached
    ax, ay, bx, by = region_box(pix, name)
    out = []
    for y in range(ay, max(ay + 1, by), 3):
        for x in range(ax, max(ax + 1, bx), 3):
            out.append(pixel(pix, x, y))
    _MEMORY[key] = out
    return out


def region_mean(pix, name):
    px = region_pixels(pix, name)
    if not px:
        return (0.0, 0.0, 0.0)
    return tuple(sum(v[i] for v in px) / len(px) for i in range(3))


def predict_region_mean(pix, name, ask):
    """What the ask leaves behind in this region, filtered **per pixel**.

    Not the filtered region mean. A text region is bimodal — paper at 255 and ink
    at 0 — and both ends are fixed points of `contrast` and of `whitening`, so the
    mean of the filtered pixels barely moves while the filtered mean of the region
    soars. Predicting from the mean said "the scanner effect lifted the copy region
    to 253.8" where the page, correctly, said 223.7.
    """
    px = region_pixels(pix, name)
    if not px:
        return (0.0, 0.0, 0.0)
    total = [0.0, 0.0, 0.0]
    for rgbv in px:
        pushed = apply_ask(rgbv, ask)
        for i in range(3):
            total[i] += pushed[i]
    return tuple(ch / len(px) for ch in total)


def edge_transition(pix, name):
    """How many rows a region's top edge takes to cross, in pixels.

    Measured as the width of the transition, not the height of the step: whitening
    and contrast change the two plateau levels, so only the *width* says whether the
    edge was crisped. A sharpened stroke crosses in fewer rows than a soft one.
    """
    x0, y0, x1, y1 = REGIONS[name]
    w, h = pix.width, pix.height
    x = int((x0 + x1) / 2 * w)
    top = int(y0 * h)
    if top + 8 >= int(y1 * h):
        return None
    outside = luma(pixel(pix, x, max(top - 8, 0)))
    inside = luma(pixel(pix, x, top + 8))
    if abs(inside - outside) < 12:
        return None
    lo, hi = min(inside, outside), max(inside, outside)
    band = (hi - lo) * 0.15
    return sum(1 for y in range(max(top - 8, 0), top + 8) if lo + band < luma(pixel(pix, x, y)) < hi - band)


def midtones(pix):
    """Sampled pixels sitting between the two tones a bilevel cutoff leaves."""
    buf = pix.samples
    step = pix.n * STRIDE
    mid = 0
    for i in range(0, max(len(buf) - (pix.n - 1), 0), step):
        lv = luma((buf[i], buf[i + 1], buf[i + 2]))
        if 64 <= lv <= 191:
            mid += 1
    return mid


def check_page(path, page_index, dpi=DPI):
    doc = pymupdf.open(path)
    page = doc[page_index]
    return doc, page, raster(page, dpi)


def native_raster(doc, page):
    """The page's own embedded image, decoded at the pixel size the tool wrote.

    Reading a 200 dpi JPEG through a 100 dpi re-render mixes two pixels for every
    one the tool produced, so every glyph edge becomes a mid tone — which is what
    made the bilevel and edge measurements say "not applied" about a page that was.
    """
    images = page.get_images(full=True)
    if len(images) != 1:
        return None
    info = doc.extract_image(images[0][0])
    if not info:
        return None
    pix = pymupdf.Pixmap(info["image"])
    if pix.n >= 4:
        pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
    return pix


# ── the asks ───────────────────────────────────────────────────────────────────

def parse_ask(text):
    ask = {}
    for pair in [p for p in text.split(",") if p.strip()]:
        if "=" in pair:
            key, raw = pair.split("=", 1)
            ask[key.strip()] = float(raw)
        else:
            ask[pair.strip()] = True
    return ask


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--page", type=int, default=1, help="1-based sheet of the fixture")
    ap.add_argument("--out-page", type=int, help="sheet of the produced file to read (default: the same number, which is only right when the run kept every page)")
    ap.add_argument("--base-page", type=int, help="sheet of the --same-as / --not-plain file to read (default: the output's own index; a tool with no page picker produced every sheet, so the index is its own question)")
    ap.add_argument("--ask", action="append", default=[], help="what the rail was set to, e.g. brightness=1.6,contrast=1")
    ap.add_argument("--polarity", action="store_true", help="assert the ink/paper swap (invert)")
    ap.add_argument("--bilevel", action="store_true", help="assert only two tones survive (threshold)")
    ap.add_argument("--achromatic", action="store_true", help="assert colour was removed")
    ap.add_argument("--not-plain", metavar="PDF", help="the output must differ from this plain rasterisation")
    ap.add_argument("--same-as", metavar="PDF", help="the output must match this file region for region (the identity case)")
    ap.add_argument("--blank", action="store_true", help="assert the page stayed empty of ink")
    ap.add_argument("--inked", action="store_true", help="assert the page carries the source sheet's ink rather than paper")
    ap.add_argument("--label", default="")
    args = ap.parse_args()

    for path in (args.src, args.out):
        if not os.path.exists(path):
            print(f"MISSING {path}")
            return 2

    if args.page not in PAGE_REGIONS:
        # Guessing sheet 1 would measure the bar against whatever really sits at those
        # fractions on an unknown sheet — the mistake this table exists to prevent.
        print(f"--page {args.page}: this checker knows the fixture's sheets "
              f"{sorted(PAGE_REGIONS)}; add that sheet's regions to PAGE_REGIONS first")
        return 2

    out_index = (args.out_page or args.page) - 1
    out_doc, out_page, out_pix = check_page(args.out, out_index)
    out_native = native_raster(out_doc, out_page)
    if out_native is not None:
        out_pix = out_native
        sampled = f"embedded raster {out_native.width}×{out_native.height}"
    else:
        sampled = f"the page at {DPI} dpi"
    # The source sheet is sampled at the *same pixel density* as whatever the output
    # is read at: a mid-tone population counted off a 200 dpi bitmap and compared
    # with one counted off a 100 dpi render measures the resampler, not the page.
    with pymupdf.open(args.src) as probe:
        src_box = probe[args.page - 1].rect
    src_dpi = DPI
    if out_native is not None and src_box.width > 0:
        src_dpi = max(24, min(600, round(72 * out_native.width / src_box.width)))
    src_doc, src_page, src_pix = check_page(args.src, args.page - 1, dpi=src_dpi)
    names = PAGE_REGIONS[args.page]
    asks = [parse_ask(a) for a in args.ask]

    src_imgs = len(src_page.get_images(full=True))
    out_imgs = len(out_page.get_images(full=True))
    sb, ob = src_page.rect, out_page.rect
    src_ink, _, _ = ink_pct(src_pix)
    out_ink, out_dark, out_sampled = ink_pct(out_pix)

    print(f"== {args.label or os.path.basename(args.out)}: src p{args.page} → out p{out_index + 1}")
    print(f"   src  box={sb.width:.1f}x{sb.height:.1f} images={src_imgs} ink={src_ink:5.2f}% (at {src_dpi} dpi)")
    print(f"   out  box={ob.width:.1f}x{ob.height:.1f} images={out_imgs} ink={out_ink:5.2f}% "
          f"({out_dark} of {out_sampled} sampled px, read from the {sampled})")
    print("   regions (rgb / luma / spread / hue°):")
    for name in names:
        s, o = region_mean(src_pix, name), region_mean(out_pix, name)
        flag = ""
        if abs(luma(o) - luma(s)) >= MIN_MOVE:
            flag = f"  Δluma {luma(o) - luma(s):+7.1f}"
        print(f"     {name:<6} src ({s[0]:5.1f},{s[1]:5.1f},{s[2]:5.1f}) l={luma(s):5.1f} "
              f"c={spread(s):5.1f} h={hue_angle(s):5.1f}  →  out ({o[0]:5.1f},{o[1]:5.1f},{o[2]:5.1f}) "
              f"l={luma(o):5.1f} c={spread(o):5.1f} h={hue_angle(o):5.1f}{flag}")

    failures = []
    if os.path.abspath(args.out) != os.path.abspath(args.src) and out_imgs != 1 and not args.blank:
        failures.append(f"the produced page holds {out_imgs} image XObjects, not the one a rasterised page draws")
    if abs(sb.width - ob.width) > 1.5 or abs(sb.height - ob.height) > 1.5:
        failures.append(f"the produced page is {ob.width:.1f}x{ob.height:.1f}, the source is {sb.width:.1f}x{sb.height:.1f}")

    if args.polarity:
        bar, band = region_mean(out_pix, "bar"), region_mean(out_pix, "band")
        s_bar, s_band = region_mean(src_pix, "bar"), region_mean(src_pix, "band")
        # The bar is ink and the band is paper in the source; inverted, the bar must
        # read lighter than the band. Ink *count* cannot show this: a page of paper
        # inverted is a page of ink, and a page of ink inverted is a page of paper.
        if luma(s_bar) > luma(s_band):
            failures.append(f"fixture: the bar region is not darker than the band ({luma(s_bar):.1f} vs {luma(s_band):.1f})")
        if not luma(bar) > luma(band) + MIN_MOVE:
            failures.append(f"polarity: inverted bar reads luma {luma(bar):.1f} against band {luma(band):.1f} "
                            f"— the sheet is not the negative of itself")
        else:
            print(f"   POLARITY ok: bar {luma(s_bar):.1f}→{luma(bar):.1f} (ink became light), "
                  f"band {luma(s_band):.1f}→{luma(band):.1f} (paper became dark)")

    if args.bilevel:
        # A 0.9-quality JPEG of a binarised page still rings at every glyph edge, so
        # "exactly two tones" is not measurable off the file. What is: the population
        # of in-between tones, counted at the output's own pixel density and compared
        # with the same sheet read the same way. A cutoff collapses it.
        out_mid = midtones(out_pix)
        src_mid = midtones(src_pix)
        print(f"   BILEVEL: {out_mid} px between 64 and 191 in the output against {src_mid} in "
              f"the source sheet at the same density")
        if src_mid and out_mid > src_mid * 0.12:
            failures.append(f"bilevel: {out_mid} mid tones survive against {src_mid} in the source — "
                            "the page was not binarised")

    if args.achromatic:
        worst = max((spread(region_mean(out_pix, n)) for n in names if n in ("red", "green", "blue")), default=None)
        if worst is None:
            failures.append("achromatic: this sheet has no colour region to judge")
        elif worst > TOL * 2:
            failures.append(f"achromatic: the most colourful region still carries a channel spread of {worst:.1f}")
        else:
            print(f"   ACHROMATIC ok: worst channel spread {worst:.1f}")

    if args.inked and out_ink < src_ink * 0.5:
        failures.append(
            f"the sheet carries {src_ink:.2f} % non-white px and the output {out_ink:.2f} % — "
            "this is paper under a plausible file name, not the page")

    if args.blank and out_dark:
        failures.append(f"the empty control page carries {out_dark} non-white px")

    for ask in asks:
        judged = 0
        for name in names:
            s = region_mean(src_pix, name)
            o = region_mean(out_pix, name)
            pred = predict_region_mean(src_pix, name, ask)
            ident = s
            opp = s if opposite(ask).get("identity") else predict_region_mean(src_pix, name, opposite(ask))
            d_pred = max(abs(o[i] - pred[i]) for i in range(3))
            d_ident = max(abs(o[i] - ident[i]) for i in range(3))
            d_opp = max(abs(o[i] - opp[i]) for i in range(3))
            # A region only judges an ask when the ask predicts something different
            # from doing nothing there: `band` under `brightness=1.6` is white × 1.6,
            # which clips back to white, so it can never separate the two.
            if max(abs(pred[i] - ident[i]) for i in range(3)) < MIN_MOVE:
                continue
            judged += 1
            # And the wrong direction only counts when it is a different direction:
            # `hue-rotate(180)` and `hue-rotate(-180)` are the same turn.
            distinct_opposite = max(abs(opp[i] - pred[i]) for i in range(3)) >= MIN_MOVE
            beats_opposite = (not distinct_opposite) or d_pred < d_opp
            verdict = "ok" if d_pred <= TOL and d_pred < d_ident and beats_opposite else "FAIL"
            note = "" if distinct_opposite else " (the opposite ask is the same turn here)"
            print(f"   {' '.join(f'{k}={v}' for k, v in sorted(ask.items()))} on {name}: "
                  f"predicted ({pred[0]:5.1f},{pred[1]:5.1f},{pred[2]:5.1f}) measured ({o[0]:5.1f},{o[1]:5.1f},{o[2]:5.1f}) "
                  f"Δpred {d_pred:5.1f} Δidentity {d_ident:5.1f} Δopposite {d_opp:5.1f} → {verdict}{note}")
            if verdict == "FAIL":
                failures.append(f"{name}: asked {' '.join(f'{k}={v}' for k, v in sorted(ask.items()))}, "
                                f"measured Δ{d_pred:.1f} from the prediction, Δ{d_ident:.1f} from doing nothing")
        if asks and judged == 0:
            print("   VACUOUS: no region on this sheet can tell the ask from doing nothing")

    base_index = (args.base_page or args.out_page or args.page) - 1
    base_doc = None
    if args.same_as:
        # The identity case: a control set to its default value must leave the sheet
        # exactly as a plain rasterisation of it, or "filters are applied twice" is
        # already true and every direction measured above is off by a composition.
        same_doc, same_page, same_pix = check_page(args.same_as, base_index)
        same_native = native_raster(same_doc, same_page)
        if same_native is not None:
            same_pix = same_native
        drift = []
        for name in names:
            b, o = region_mean(same_pix, name), region_mean(out_pix, name)
            drift.append((name, max(abs(b[i] - o[i]) for i in range(3))))
        worst = max(d for _, d in drift)
        print("   same as " + os.path.basename(args.same_as) + ": "
              + ", ".join(f"{n} Δ{d:.1f}" for n, d in drift))
        if worst > TOL:
            failures.append(f"the identity case is not the identity: {worst:.1f} of drift from "
                            f"{os.path.basename(args.same_as)} — a filter applied twice lands here")
        same_doc.close()
    if args.not_plain:
        base_doc, base_page, base_pix = check_page(args.not_plain, base_index)
        base_native = native_raster(base_doc, base_page)
        if base_native is not None:
            base_pix = base_native
        deltas = []
        for name in names:
            b, o = region_mean(base_pix, name), region_mean(out_pix, name)
            deltas.append((name, max(abs(b[i] - o[i]) for i in range(3))))
        sharps = []
        for name in names:
            if name in ("bar", "red", "grey"):
                a, b = edge_transition(base_pix, name), edge_transition(out_pix, name)
                sharps.append((name, a, b))
        out_mid, base_mid = midtones(out_pix), midtones(base_pix)
        worst = max(d for _, d in deltas)
        print("   vs plain rasterisation: " + ", ".join(f"{n} Δ{d:.1f}" for n, d in deltas)
              + f" | mid tones {base_mid}→{out_mid}"
              + " | edge transition width (px) "
              + ", ".join(f"{n} {a}→{b}" for n, a, b in sharps if a is not None and b is not None))
        # A sheet of greyscale text is nearly a fixed point of the scanner pipeline:
        # whitening and contrast hold paper at 255 and ink at 0, and greyscale has no
        # colour to drop. What none of them can leave alone is the anti-aliasing
        # between those two tones, so on such a page the effect is read off the
        # distribution and the edge — either moving is the effect being applied.
        crisper = out_mid <= base_mid * 0.6 or any(
            a is not None and b is not None and b < a for _, a, b in sharps)
        if worst <= TOL * 2 and not crisper:
            failures.append(
                f"the effect is not applied: every region is within {worst:.1f} of a plain "
                f"rasterisation of the same page, the mid tones did not collapse "
                f"({base_mid}→{out_mid}) and no edge narrowed")

    src_doc.close()
    out_doc.close()
    if base_doc is not None:
        base_doc.close()

    if failures:
        print("FAIL")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
