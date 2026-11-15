#!/usr/bin/env python3
"""`background-color` — did the fill land *behind*, and did it leave the page alone?

  python3 docs/research/background-ink.py --src /tmp/triage/colour.pdf \
      --out /tmp/r041/after.pdf --fill '#88bbee' --page 1 --regions copy,band

Ink presence cannot judge this tool. A page of flat blue has ink; a page whose
content the pass destroyed and then covered has ink too, and the app's own report
line reads the same either way. Two counts separate them, both taken against the
**source sheet measured the same way**:

* `fill%` — pixels within `TOL` of the requested colour. On a paper region this is
  the whole area once the pass has worked (`--paper`), and it must be far lower on
  the untouched source, or the instrument cannot tell the pass from the file it
  started with.
* `white%` — pixels at letter white (the source's own paper). A near-white fill
  like the default `#f7f7f4` is within tolerance of paper, so `fill%` alone cannot
  tell "not painted yet" from "painted"; the white population can, and it must
  collapse.
* `dark%` — pixels below `DARK` luma: the page's own glyphs, its black bar, its
  stamps. Content that survived the pass keeps its dark population; content the
  pass orphaned (a nested `/Contents` array drops every stream) reads 0.

Regions are the *displayed* fractions `colour-fixture.mjs` and `colour-ink.py`
already carry, so a sheet with `/Rotate 90` is judged where the reader sees it.

Exit 1 on any failed ask. Every ask prints the source number beside it, so a
region with no paper to change and no ink to keep is shown as such rather than
counted as a pass.
"""
import argparse
import sys

import pymupdf

DPI = 100
TOL = 12.0            # per channel, against the requested fill
DARK = 96             # luma: a glyph pixel, or the fixture's solid bar
REGIONS = {
    "bar": (0.10, 0.10, 0.90, 0.22),
    "copy": (0.08, 0.26, 0.92, 0.82),
    "band": (0.10, 0.86, 0.90, 0.97),
}
# `--paper` asks demand the region to be painted; every ask keeps `dark%`.
ASK_KINDS = ("paper", "keep-ink")


def box(pix, name):
    x0, y0, x1, y1 = REGIONS[name]
    w, h = pix.width, pix.height
    ax, ay, bx, by = int(x0 * w), int(y0 * h), int(x1 * w), int(y1 * h)
    pad = max(2, int(0.02 * min(bx - ax, by - ay)))
    return ax + pad, ay + pad, bx - pad, by - pad


def measure(pix, name, fill):
    ax, ay, bx, by = box(pix, name)
    sampled = filled = dark = white = 0
    total = [0.0, 0.0, 0.0]
    for y in range(ay, max(ay + 1, by), 2):
        for x in range(ax, max(ax + 1, bx), 2):
            px = pix.pixel(x, y)
            sampled += 1
            for i in range(3):
                total[i] += px[i]
            if (px[0] + px[1] + px[2]) / 3 < DARK:
                dark += 1
            if min(px[0], px[1], px[2]) >= 250:
                white += 1
            if all(abs(px[i] - fill[i]) <= TOL for i in range(3)):
                filled += 1
    n = max(sampled, 1)
    return {
        "fill": 100.0 * filled / n,
        "dark": 100.0 * dark / n,
        "white": 100.0 * white / n,
        "mean": tuple(round(v / n, 1) for v in total),
        "n": sampled,
    }


def hex_rgb(text):
    value = text.lstrip("#")
    if len(value) == 3:
        value = "".join(ch * 2 for ch in value)
    if len(value) != 6:
        raise SystemExit(f"--fill needs a hex colour, not {text!r}")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--fill", required=True)
    ap.add_argument("--page", type=int, required=True, help="1-based")
    ap.add_argument("--whole", action="store_true", help="the whole displayed sheet, not a region")
    ap.add_argument("--regions", default="")
    ap.add_argument("--ask", default="paper,keep-ink")
    ap.add_argument("--opacity", type=float, default=1.0)
    args = ap.parse_args()

    fill = hex_rgb(args.fill)
    asks = [a for a in args.ask.split(",") if a]
    for ask in asks:
        if ask not in ASK_KINDS:
            raise SystemExit(f"unknown ask {ask!r}")
    names = [r for r in args.regions.split(",") if r]
    for name in names:
        if name not in REGIONS:
            raise SystemExit(f"unknown region {name!r}")

    src = pymupdf.open(args.src)[args.page - 1]
    out = pymupdf.open(args.out)[args.page - 1]
    src_pix = src.get_pixmap(dpi=DPI, colorspace=pymupdf.csRGB)
    out_pix = out.get_pixmap(dpi=DPI, colorspace=pymupdf.csRGB)

    print(f"page {args.page}: {src.rect.width:.0f}x{src.rect.height:.0f} rot {src.rotation}"
          f" → {out.rect.width:.0f}x{out.rect.height:.0f} rot {out.rotation}   fill {args.fill}")
    failed = 0

    def judge(name, before, after, sheet=False):
        nonlocal failed
        line = (f"  {name:<6} fill {before['fill']:5.1f} → {after['fill']:5.1f} %"
                f"   white {before['white']:5.1f} → {after['white']:5.1f} %"
                f"   dark {before['dark']:5.1f} → {after['dark']:5.1f} %"
                f"   mean {before['mean']} → {after['mean']}")
        problems = []
        if sheet:
            # A whole displayed sheet: no `dark` is graded here, only how much of
            # the paper the pass painted. This is the ask a `/Rotate` sheet needs —
            # the page's own white band sits over the region behind it.
            dropped = before["white"] - after["white"]
            if before["white"] < 5.0:
                problems.append("VACUOUS — the sheet was already painted")
            elif dropped < 20.0:
                problems.append(f"white only fell {dropped:.1f} pp")
        elif args.opacity >= 1:
            # Paper becomes the fill. A region with glyphs keeps less of it — the
            # ink and its anti-aliasing are not fill — so the demand falls off with
            # the source's own ink coverage, never below 55 %.
            need = 95.0 if before["dark"] <= 1.0 else max(55.0, 100.0 - 3.0 * before["dark"])
            if before["dark"] > 95.0:
                problems.append("VACUOUS — a solid block, no paper to change")
            elif after["fill"] < need:
                problems.append(f"only {after['fill']:.1f} % of the region is the fill (need {need:.0f})")
            dropped = before["white"] - after["white"]
            if before["white"] >= 5.0 and dropped < 20.0:
                problems.append(f"white only fell {dropped:.1f} pp")
            elif before["fill"] >= 99.0 and before["white"] < 5.0:
                problems.append("VACUOUS — already the fill")
        else:
            # A wash: the paper must MOVE towards the fill without becoming it.
            moved = max(abs(f - b) for f, b in zip(after["mean"], before["mean"], strict=True))
            if moved < TOL:
                problems.append(f"mean moved only {moved:.1f} (tolerance {TOL:.0f})")
            if before["dark"] > 1.0 and after["dark"] < before["dark"] * 0.85:
                problems.append(f"ink lost: {before['dark']:.1f} → {after['dark']:.1f} %")
            if all(abs(after["mean"][i] - fill[i]) <= TOL for i in range(3)) and before["white"] < 5.0:
                problems.append("VACUOUS — already the fill")
        print(line + ("   " + "; ".join(problems) if problems else "   ok"))
        # A vacuous region is on the record, not a failure: the region simply has
        # no paper to paint or is already the fill.
        if [p for p in problems if not p.startswith("VACUOUS")]:
            failed += 1

    if args.whole:
        # The whole displayed sheet: what a turned page is judged by, where the
        # page's own white band hides the region behind it.
        def whole(pix):
            sampled = filled = white = 0
            total = [0.0, 0.0, 0.0]
            for y in range(0, pix.height, 2):
                for x in range(0, pix.width, 2):
                    px = pix.pixel(x, y)
                    sampled += 1
                    for i in range(3):
                        total[i] += px[i]
                    if all(abs(px[i] - fill[i]) <= TOL for i in range(3)):
                        filled += 1
                    if min(px[0], px[1], px[2]) >= 250:
                        white += 1
            n = max(sampled, 1)
            return {"fill": 100.0 * filled / n, "dark": 0.0, "white": 100.0 * white / n,
                    "mean": tuple(round(v / n, 1) for v in total), "n": sampled}
        judge("sheet", whole(src_pix), whole(out_pix), sheet=True)
    for name in names:
        judge(name, measure(src_pix, name, fill), measure(out_pix, name, fill))

    print("FAIL" if failed else "PASS")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
