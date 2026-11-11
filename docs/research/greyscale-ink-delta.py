#!/usr/bin/env python3
"""What moving the ink metric from BT.601 to Rec.709 does to the app's ink numbers.

  python3 docs/research/greyscale-ink-delta.py            # the repo's own corpus
  python3 docs/research/greyscale-ink-delta.py a.pdf b.pdf

`core/measure.ts` used to own its own luminance, BT.601, and `inkRatio` /
`alphaMaskFromPixels` / `thresholdPixels` all counted with it. Those three functions
decide whether a page is blank (`remove-blank-pages`), where a scan's text lines run
(`deskew-pdf`) and which side of a bilevel cutoff a pixel falls on
(`adjust-colors`, `scanner-effect`). Unifying the standard moved the metric with the
output, so this measures the move rather than arguing that it is small.

The structural fact worth stating up front, because it is what the corpus then has to
survive: **0.299+0.587+0.114 and 0.2126+0.7152+0.0722 both sum to 1**, so a pixel with
R=G=B reads the same grey either way. Only a *chromatic* pixel can move. A page of
black text on white paper therefore cannot change its ink percentage by one sample,
and the table below says so page by page instead of by assertion.

Sampled exactly as the app samples: `inkRatio` takes every pixel of a page rendered at
`scale 0.5` (36 dpi) against a cutoff of 220, and multiplies the luma by alpha/255;
`alphaMaskFromPixels` takes every pixel of a page at `scale 1.5` (108 dpi) at cutoff
200; `thresholdPixels` cuts at 128. A page is `blank` at ink <= 0.001, which is
`isBlankPage`'s default.
"""
import os
import sys

import pymupdf

# The two triples, both spelled here because this file's job is the difference between them.
W601 = (0.299, 0.587, 0.114)
W709 = (0.2126, 0.7152, 0.0722)

BLANK_INK_THRESHOLD = 0.001   # isBlankPage's default
INK_CUTOFF = 220              # inkRatio's default
MASK_CUTOFF = 200             # alphaMaskFromPixels' default, the deskew input
BILEVEL_CUTOFF = 128          # thresholdPixels' default
INK_DPI = 36                  # scale 0.5 of 72
MASK_DPI = 108                # scale 1.5 of 72

CORPUS_DIRS = ["tests/fixtures", "docs/research", "tests/pdf"]


def luma(w, r, g, b):
    return w[0] * r + w[1] * g + w[2] * b


def collect(explicit):
    if explicit:
        return explicit
    found = []
    for root in CORPUS_DIRS:
        for dirpath, _, files in os.walk(root):
            for name in sorted(files):
                if name.endswith(".pdf"):
                    found.append(os.path.join(dirpath, name))
    return sorted(found)


def samples(pix):
    """(r, g, b, a) per pixel, as an ImageData buffer would hand them to the app."""
    n = pix.n
    buf = pix.samples
    out = []
    for i in range(0, len(buf) - (n - 1), n):
        a = buf[i + 3] if n >= 4 else 255
        out.append((buf[i], buf[i + 1], buf[i + 2], a))
    return out


def page_rows(doc, path, index):
    page = doc[index]
    rows = []
    for label, dpi, cutoff in (
        (f"inkRatio @{INK_DPI}dpi cut {INK_CUTOFF}", INK_DPI, INK_CUTOFF),
        (f"alphaMask @{MASK_DPI}dpi cut {MASK_CUTOFF}", MASK_DPI, MASK_CUTOFF),
    ):
        pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csRGB, alpha=True)
        px = samples(pix)
        chroma = sum(1 for r, g, b, _ in px if max(r, g, b) != min(r, g, b))
        ink601 = ink709 = 0
        for r, g, b, a in px:
            scale = a / 255
            if a and luma(W601, r, g, b) * scale < cutoff:
                ink601 += 1
            if a and luma(W709, r, g, b) * scale < cutoff:
                ink709 += 1
        total = len(px) or 1
        rows.append(
            {
                "where": f"{path} [{index + 1}]",
                "what": label,
                "chroma_pct": 100.0 * chroma / total,
                "p601": 100.0 * ink601 / total,
                "p709": 100.0 * ink709 / total,
                "moved": ink709 - ink601,
                "blank601": ink601 / total <= BLANK_INK_THRESHOLD * 100,
                "blank709": ink709 / total <= BLANK_INK_THRESHOLD * 100,
            }
        )
    # The bilevel cut, on the page's own pixels: how many samples change tone.
    pix = page.get_pixmap(dpi=INK_DPI, colorspace=pymupdf.csRGB, alpha=True)
    flips = 0
    for r, g, b, a in samples(pix):
        if not a:
            continue
        if (luma(W601, r, g, b) < BILEVEL_CUTOFF) != (luma(W709, r, g, b) < BILEVEL_CUTOFF):
            flips += 1
    rows[-1]["bilevel_flips"] = flips
    return rows


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    os.chdir(os.path.dirname(os.path.dirname(here)))  # docs/research → repo root
    files = collect(sys.argv[1:])
    rows, unreadable = [], []
    for path in files:
        try:
            with pymupdf.open(path) as doc:
                if doc.needs_pass:
                    unreadable.append((path, "encrypted"))
                    continue
                for index in range(min(doc.page_count, 3)):
                    rows.extend(page_rows(doc, path, index))
        except Exception as exc:  # noqa: BLE001  a rig reports, it does not crash
            unreadable.append((path, type(exc).__name__))

    print("file [page] | metric | chroma% | ink601% | ink709% | Δpp | bilevel flips | blank601 | blank709")
    flipped = []
    worst = (0.0, "")
    for row in rows:
        tag = ""
        if row["blank601"] != row["blank709"]:
            tag = "  ← FLIPS"
            flipped.append(row)
        delta = abs(row["p709"] - row["p601"])
        if delta > worst[0]:
            worst = (delta, row["where"] + " " + row["what"])
        print(
            f"{row['where']} | {row['what']} | {row['chroma_pct']:.3f}"
            f" | {row['p601']:.4f} | {row['p709']:.4f} | {row['p709'] - row['p601']:+.4f}"
            f" | {row.get('bilevel_flips', 0)} | {row['blank601']} | {row['blank709']}{tag}"
        )
    pages = {r["where"] for r in rows}
    chroma_pages = {r["where"] for r in rows if r["chroma_pct"] > 0}
    print(
        f"\n{len(rows)} page-metric rows over {len(pages)} pages in {len(files)} files"
        f" ({len(unreadable)} unreadable: {', '.join(p for p, _ in unreadable[:6])}"
        f"{' …' if len(unreadable) > 6 else ''})."
    )
    print(f"pages carrying no chromatic pixel at all: {len(pages) - len(chroma_pages)} — their ink % is bit-identical.")
    print(f"pages carrying any chromatic pixel: {len(chroma_pages)}.")
    print(f"largest ink-% move on any row: {worst[0]:.4f} pp, on {worst[1] or '—'}.")
    print(f"blank/non-blank decisions that changed: {len(flipped)}"
          + ("  ← " + "; ".join(f"{r['where']} {r['p601']:.3f}→{r['p709']:.3f}" for r in flipped) if flipped else ""))
    deskew_changed = [r for r in rows if "alphaMask" in r["what"] and r["moved"] != 0]
    print(
        f"deskew mask (cutoff {MASK_CUTOFF}) rows whose ink population moved: {len(deskew_changed)}"
        + ("  ← " + "; ".join(f"{r['where']} {r['moved']:+d}px" for r in deskew_changed[:8]) if deskew_changed else "")
    )
    ink_moved = [r for r in rows if "inkRatio" in r["what"] and r["moved"] != 0]
    print(
        f"inkRatio (cutoff {INK_CUTOFF}) rows whose ink % moved at all: {len(ink_moved)}"
        + ("  ← " + "; ".join(f"{r['where']} {r['p601']:.4f}→{r['p709']:.4f} %" for r in ink_moved) if ink_moved else "")
    )
    bilevel = [r for r in rows if r.get("bilevel_flips")]
    print(
        f"rows with any pixel changing side of the bilevel cutoff {BILEVEL_CUTOFF}: {len(bilevel)}"
        f" totalling {sum(r['bilevel_flips'] for r in bilevel)} pixels"
        + ("  ← " + "; ".join(f"{r['where']} {r['bilevel_flips']}px" for r in bilevel) if bilevel else "")
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
