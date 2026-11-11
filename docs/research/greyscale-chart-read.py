#!/usr/bin/env python3
"""Read the greyscale chart out of a produced file — per swatch, per path.

  python3 docs/research/greyscale-chart-read.py measure \\
      --in /tmp/gs/post-greyscale-recolour.pdf --page 1 --path Recolour

  python3 docs/research/greyscale-chart-read.py compare \\
      --path 'Recolour=a.pdf:1' --path 'Re-render=b.pdf:1' --path 'Scanner=c.pdf:1' \\
      --tolerance 1

This is `colour-ink.py` reused, not re-derived. It imports that file and hands its
region table the fractions from `greyscale-chart.json`, so the rasterisation, the
region inset that keeps a JPEG edge ring out of a mean, the strided sampling and the
luma maths are all the campaign's own. What is added here is only the *judgement* a
greyscale standard needs:

  · **the grey is the standard's** — the measured value must equal Rec.709's, not
    merely be grey;
  · **spread must be 0** — a tinted "grey" means a path that filtered nothing, or
    filtered something else;
  · **distinct colours must not collapse** — two swatches landing on one integer grey
    is the failure a luma choice can create and a luma promise must not hide;
  · **paths must agree with each other** — the whole point of one standard, and the
    only one of the four that needs more than one produced file to state.

`compare` prints the table for every path side by side, then the widest disagreement
per swatch. Exits 1 on any failed rule, so a shell rig can treat it as an assertion.
"""
import argparse
import importlib.util
import json
import os
import sys

import pymupdf  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
TABLE = os.path.join(HERE, "greyscale-chart.json")


def _load_campaign_reader():
    """Import `colour-ink.py` — hyphenated, so by path rather than by name.

    The whole point: the rasterisation, the region inset that keeps a JPEG ring out of a
    mean, the strided sampling and the CSS filter maths are the campaign's, executed by
    the same code that produced every colour row in `docs/TOOL-CAMPAIGN.md`. A second
    copy here would be the greyscale-standard bug wearing a rig costume.
    """
    spec = importlib.util.spec_from_file_location("colour_ink", os.path.join(HERE, "colour-ink.py"))
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load {HERE}/colour-ink.py — the campaign's reader is missing")
    module = importlib.util.module_from_spec(spec)
    sys.modules["colour_ink"] = module
    spec.loader.exec_module(module)
    return module


colour_ink = _load_campaign_reader()


def load_table(path):
    with open(path) as handle:
        return json.load(handle)


def bind_regions(table):
    """Point `colour_ink`'s region lookup at the chart's own fractions.

    `colour_ink.region_box` / `region_pixels` / `region_mean` all read the module-global
    `REGIONS`, so replacing it once reuses their inset-and-sample rule verbatim instead of
    writing a second one here that could disagree about which square is which.
    """
    vars(colour_ink)["REGIONS"] = {
        s["name"]: (s["region"]["x0"], s["region"]["y0"], s["region"]["x1"], s["region"]["y1"])
        for s in table["swatches"]
    }


def measure(path, page_index, table, dpi=colour_ink.DPI):
    """{swatch: (mean_r, mean_g, mean_b)} for one produced page, as displayed."""
    with pymupdf.open(path) as doc:
        if page_index > doc.page_count:
            raise SystemExit(f"{path}: has {doc.page_count} page(s), was asked for {page_index}")
        pix = colour_ink.raster(doc[page_index - 1], dpi)
        return {s["name"]: colour_ink.region_mean(pix, s["name"]) for s in table["swatches"]}, pix


def grey_of(mean):
    """The grey a swatch reads as: the shared luma, plus its channel spread."""
    return colour_ink.m_grayscale(tuple(c / 255 for c in mean))[0] * 255.0


def cmd_measure(args):
    table = load_table(args.table)
    bind_regions(table)
    means, _ = measure(args.inp, args.page, table)
    by_name = {s["name"]: s for s in table["swatches"]}
    print(f"{'swatch':<15}{'source rgb':>14}{'measured rgb':>18}{'spread':>7}{'grey':>7}{'709':>6}{'601':>6}{'Δ709':>7}")
    bad = 0
    for s in table["swatches"]:
        mean = means[s["name"]]
        spread = colour_ink.spread(mean)
        grey = grey_of(mean)
        delta = grey - s["grey709"]
        ok = spread <= args.spread_tol and abs(delta) <= args.grey_tol
        bad += 0 if ok else 1
        print(
            f"{s['name']:<15}{str(tuple(by_name[s['name']]['rgb'])):>14}"
            f"{str(tuple(round(c, 1) for c in mean)):>18}{spread:7.1f}{grey:7.1f}"
            f"{s['grey709']:6.0f}{s['grey601']:6.0f}{delta:+7.1f} {'' if ok else '  ← FAIL'}"
        )
    print(f"\n{args.path}: {len(table['swatches']) - bad}/{len(table['swatches'])} swatches"
          f" within spread≤{args.spread_tol} and |grey−Rec.709|≤{args.grey_tol}")
    return 1 if bad else 0


def parse_spec(spec):
    """`Name=file.pdf[:page]` → (name, path, page)."""
    name, _, rest = spec.partition("=")
    path, sep, page = rest.rpartition(":")
    if not sep or not path.lower().endswith(".pdf"):
        path, page = rest, "1"
    return name, path, int(page)


def cmd_compare(args):
    table = load_table(args.table)
    bind_regions(table)
    specs = [parse_spec(s) for s in args.path]
    results = {}
    for name, path, page in specs:
        means, _ = measure(path, page, table)
        results[name] = {k: grey_of(v) for k, v in means.items()}
    names = [n for n, _, _ in specs]
    print(f"{'swatch':<15}{'709':>6}{'601':>6}" + "".join(f"{n[:13]:>15}" for n in names)
          + f"{'spread':>9}{'worst Δ':>9}")
    collapsed = []
    widest = []
    for s in table["swatches"]:
        vals = [results[n][s["name"]] for n in names]
        lo, hi = min(vals), max(vals)
        widest.append((hi - lo, s["name"]))
        line = f"{s['name']:<15}{s['grey709']:6.0f}{s['grey601']:6.0f}"
        line += "".join(f"{v:15.1f}" for v in vals)
        line += f"{hi - lo:9.1f}{max(abs(v - s['grey709']) for v in vals):9.1f}"
        print(line)
    # Collapse is judged on the *rounded* grey, because that is the only alphabet an
    # 8-bit page can carry: two swatches that both land on 116 are one swatch.
    by_rounded = {}
    for s in table["swatches"]:
        for n in names:
            by_rounded.setdefault((n, round(results[n][s["name"]])), []).append((n, s["name"]))
    print("\n── distinct colours that collapse to one grey, per path")
    collapsed = []
    for entries in by_rounded.values():
        if len(entries) > 1:
            collapsed.append(entries)
            print("   COLLAPSE " + ", ".join(f"{n}/{sw}" for n, sw in entries))
    if not collapsed:
        print("   none")
    print("\n── the pairs that come closest, per path (rounded units apart)")
    for n in names:
        ranked = sorted(
            (
                abs(round(results[n][a["name"]]) - round(results[n][b["name"]])),
                a["name"],
                b["name"],
            )
            for i, a in enumerate(table["swatches"])
            for b in table["swatches"][i + 1 :]
        )[:4]
        print(f"   {n:<14}" + "  ".join(f"{x}/{y}:{d}" for d, x, y in ranked))
    over = [w for w in widest if w[0] > args.tolerance]
    print(
        f"\ncompare: widest cross-path disagreement {max(w for w, _ in widest):.1f}"
        f" on {max(widest, key=lambda w: w[0])[1]}; tolerance {args.tolerance}."
    )
    if over:
        print("   " + "; ".join(f"{n} off by {d:.1f}" for d, n in sorted(over, reverse=True)))
    return 1 if (over or collapsed) else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["measure", "compare"])
    ap.add_argument("--table", default=TABLE)
    ap.add_argument("--in", dest="inp", help="a produced file to read (measure)")
    ap.add_argument("--page", type=int, default=1, help="1-based sheet of the produced file")
    ap.add_argument("--path", action="append", default=[], help="Name=file.pdf[:page] (compare)")
    ap.add_argument("--tolerance", type=float, default=1.0, help="max cross-path disagreement")
    ap.add_argument("--grey-tol", type=float, default=1.0, help="max |measured − Rec.709|")
    ap.add_argument("--spread-tol", type=float, default=1.0, help="max channel spread")
    args = ap.parse_args()
    sys.exit(cmd_measure(args) if args.command == "measure" else cmd_compare(args))


if __name__ == "__main__":
    main()
