#!/usr/bin/env python3
"""`text-color` — which SHOW OPERATORS got a colour in front of them, and what painted.

  python3 docs/research/text-shapes-check.py --src /tmp/text/text.pdf --out /tmp/text/tc.pdf
  python3 docs/research/text-shapes-check.py --pdf /tmp/text/text.pdf --pages 1,5,6

A colour claim about text needs three different instruments, because the three can
disagree and every interesting defect in this campaign has been one of them lying:

* the **operator in force** at each show, read from the content-stream bytes by a
  tokeniser that respects `(...)` strings and `[...]` arrays — a regex counts the
  `TJ` *inside* the fixture's own string `( TJ)`, and the count the card prints is
  a count of these operators, so this is the number the report line must match;
* the **resolved run** from MuPDF's own text trace (`get_texttrace`): the colour the
  viewer paints, and the render mode as two items (fill `type 0`, stroke `type 1`)
  for a `Tr 2` faux-bold, or `type 3` for the invisible OCR shape;
* the **ink** in the rasterised page: the dominant non-white colour at 150 dpi, which
  is the only one of the three that a Type3 glyph painted inside its own CharProc, or
  a run painted through a Pattern, cannot talk its way out of.

`CHANGED` is printed per operator (colour in force before vs after, matched by
position), and a page whose shows did not move is a page the card must not count.
Exits 1 when `--expect changed=N[,M]` disagrees with what was measured.
"""
import argparse
import re
import sys
from collections import Counter

import pymupdf

SHOWS = {"Tj", "TJ", "'", '"'}
COLOUR_FILL = {"rg", "g", "k", "sc", "scn", "CS", "cs"}
OPERANDS = re.compile(
    r"""\((?:\\.|[^\\()])*\)      # literal string
      | \[|\]                    # array brackets
      | /?[^\s\[\]()]+           # name, number, keyword
    """,
    re.X,
)


def tokens(data):
    """Content-stream tokens, with literal strings and array brackets kept whole."""
    return [m.group(0) for m in OPERANDS.finditer(data)]


def runs_in(content):
    """Every show operator with the colour and render state in force at that point."""
    stack, pending, out = [], [], []
    fill, stroke, mode, fspace, sspace = "0 0 0", "0 0 0", "0", "-", "-"
    for tok in tokens(content):
        if tok == "[":
            pending.append(tok)
            continue
        if tok not in OPERANDS_SET:
            # An operand: it belongs to the operator that follows, so it accumulates.
            # (It used to be dropped, which made every colour column read `rg:` with
            # no triple and hid which run had actually been repainted.)
            pending.append(tok)
            continue
        if tok in ("Tj", "TJ", "'", '"'):
            shown = " ".join(t for t in pending if t.startswith("(") or re.match(r"^<[0-9A-Fa-f]*>$", t))
            out.append({"op": tok, "fill": fill, "stroke": stroke, "Tr": mode,
                        "cs": fspace, "CS": sspace,
                        "label": re.sub(r"^[({\[]|[])}>]$", "", shown)[:34]})
            continue
        if tok == "q":
            stack.append((fill, stroke, mode, fspace, sspace))
            continue
        if tok == "Q" and stack:
            fill, stroke, mode, fspace, sspace = stack.pop()
            continue
        if tok == "cs":
            fspace = operands_of(pending)
        elif tok == "CS":
            sspace = operands_of(pending)
        elif tok in ("rg", "g", "k", "sc", "scn"):
            fill = f"{tok}:{operands_of(pending)}"
        elif tok in ("RG", "G", "K", "SC", "SCN"):
            stroke = f"{tok}:{operands_of(pending)}"
        elif tok == "Tr":
            mode = operands_of(pending)
        pending = []
    return out


def operands_of(buf):
    return " ".join(t for t in buf if t not in ("[", "]"))


# Every operator that ends an operand list: an unlisted operator (a `Td` before a show)
# would otherwise leave its own numbers glued to the next colour's triple.
OPERANDS_SET = SHOWS | {"q", "Q", "cs", "CS", "rg", "g", "k", "sc", "scn",
                        "RG", "G", "K", "SC", "SCN", "Tr", "Tf", "BT", "ET",
                        "Td", "TD", "Tm", "TL", "TP", "Tc", "Tw", "Tz", "Ts",
                        "w", "M", "d", "ri", "i", "gs", "cm", "re", "m", "l",
                        "c", "v", "y", "h", "f", "f*", "F", "B", "B*", "S", "n",
                        "Do", "sh", "BI", "ID", "EI", "mp", "DP", "BMC", "BDC", "EMC"}


def fmt_ink(r):
    return "paper" if not r[2] else " ".join(f"{c}×{n}" for c, n in r[2][:3])


def ink(page, dpi=150):
    """The dominant non-white colour of the page's pixels, and how many."""
    pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csRGB)
    step = max(1, pix.width // 400)
    seen = Counter()
    for y in range(0, pix.height, step):
        for x in range(0, pix.width, step):
            px = pix.pixel(x, y)
            if min(px[:3]) < 245:
                seen[px[:3]] += 1
    if not seen:
        return "paper", 0, []
    top = [(f"#{c[0]:02x}{c[1]:02x}{c[2]:02x}", n) for c, n in seen.most_common(3)]
    return top[0][0], top[0][1], top


def trace(page):
    """MuPDF's own resolved runs: colour, render mode, line width, text."""
    out = []
    for it in page.get_texttrace():
        out.append({
            "type": it.get("type"), "color": it.get("color"), "lw": it.get("linewidth"),
            "font": it.get("font"), "text": "".join(chr(c[0]) for c in it.get("chars", [])),
        })
    return out


def content(doc, page):
    return "\n".join(
        (doc.xref_stream(x) or b"").decode("latin-1", "replace") for x in page.get_contents()
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src")
    ap.add_argument("--out")
    ap.add_argument("--pdf")
    ap.add_argument("--pages", default="")
    ap.add_argument("--expect", default="", help="changed=N[,N] shows per page")
    args = ap.parse_args()

    src = pymupdf.open(args.src or args.pdf)
    out = pymupdf.open(args.out) if args.out else None
    pages = ([int(p) for p in args.pages.split(",") if p]
             or list(range(1, min(src.page_count, (out.page_count if out else src.page_count)) + 1)))

    changed_per_page = {}
    for pno in pages:
        sp, op = src[pno - 1], (out[pno - 1] if out else src[pno - 1])
        src_runs = runs_in(content(src, sp))
        out_runs = runs_in(content(out, op)) if out else src_runs
        moved = sum(1 for a, b in zip(src_runs, out_runs) if a["fill"] != b["fill"] or a["stroke"] != b["stroke"])
        changed_per_page[pno] = (len(out_runs), moved)
        print(f"── page {pno}: {len(src_runs)} shows → {len(out_runs)} shows, {moved} with a different colour in force")
        print(f"        ink was {fmt_ink(ink(sp))} | now {fmt_ink(ink(op))}")
        for i, (a, b) in enumerate(zip(src_runs, out_runs)):
            flag = ""
            if a["fill"] != b["fill"] or a["stroke"] != b["stroke"]:
                flag = "  CHANGED"
            print(f"   {i + 1:>2} {a['op']:<3} fill {a['fill']:<26} → {b['fill']:<26}"
                  f" stroke {a['stroke']:<22} Tr {a['Tr']}→{b['Tr']} {a['cs']}→{b['cs']}{flag}  {a['label']!r}")
        if out is not None:
            for label, doc, pg in (("src ", src, sp), ("out ", out, op)):
                for it in trace(pg):
                    col = it["color"]
                    cs = (f"({col[0] * 255:.0f},{col[1] * 255:.0f},{col[2] * 255:.0f})"
                          if isinstance(col, (list, tuple)) and len(col) == 3 else f"space{col}")
                    print(f"   {label}trace type {it['type']} {cs} lw {it['lw']} {it['font'][:16]:<16} {it['text'][:34]!r}")

    if args.out:
        total = sum(m for _, m in changed_per_page.values())
        print(f"TOTAL recoloured shows measured in the bytes: {total}")

    if args.expect:
        want = [int(x) for x in args.expect.split(",") if x]
        got = [changed_per_page[p][1] for p in pages]
        if got != want:
            print(f"FAIL expected changed={want}, measured {got}")
            return 1
        print(f"OK changed per page {got}")
    return 0


sys.exit(main())
