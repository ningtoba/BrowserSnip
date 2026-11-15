#!/usr/bin/env python3
"""Judge one round of `edit-round-probe.mjs` output: screen half and file half.

    python3 docs/research/edit-round-check.py /tmp/edit031/before

For every case the probe left behind (`<id>.json`, `<id>-before.png`,
`<id>-after.png`, `<id>.pdf`) the whole page was captured before and after, with
the selection cleared first so Select's handles are not counted as ink.

* **screen** — ink is the pixels that changed between the two captures, counted off
  the bitmap inside the mark's own box (grown by the stroke plus 3 pt for the
  anti-aliased edge). Its colour is the mean of the closest half of those pixels,
  compared with the swatch read back out of the DOM before the gesture — both
  exactly and blended at the mark's opacity, which is what a translucent highlight
  really paints. A clean column of the same page (x 395–418, clear of the text) is
  the instrument's own control and must measure nothing.
* **file** — the page is rendered twice, with and without annotations, and the
  difference inside the annotation's `/Rect` is the annotation's own ink, with its
  `/Subtype`, `/Rect`, `/C` and appearance stream read off the object. The three
  annotations and the link already on the fixture, and its `/Info`, must survive.

Exit 1 if any case fails; the verdict is the printed table.
"""
from __future__ import annotations

import json
import math
import os
import re
import sys

import pymupdf
from PIL import Image

INK_DELTA = 24  # a changed channel byte; below this is anti-aliasing on paper
MIN_INK_PX = 120
COLOUR_TOL = 40
RECT_TOL_PT = 2.5
PAGE_W, PAGE_H = 420.0, 595.0
CONTROL_X = (395, 418)  # the fixture's clean column


def rgb(hex_colour: str) -> tuple[int, int, int]:
    h = hex_colour.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def px(pix, x: int, y: int) -> tuple[int, int, int]:
    v = pix[x, y]
    if isinstance(v, tuple):
        return (int(v[0]), int(v[1]), int(v[2]))
    return (int(v), int(v), int(v))


def blend(colour: tuple[int, int, int], alpha: float) -> tuple[int, int, int]:
    return tuple(round(c * alpha + 255 * (1 - alpha)) for c in colour)  # type: ignore[return-value]


def shape_ok(kind: str, points: list[tuple[int, int]], rect: list, drag: list, path: list | None = None) -> tuple[bool, str]:
    """Is the changed ink the *shape* that was drawn?

    A perimeter tool's pixels must sit on the outline and leave the middle alone; a
    segment's must hug the segment; a band must cover its row. This is the check a
    count cannot make: a filled blob, or ink in the wrong place inside the right
    box, passes area and colour but fails here.
    """
    if not points:
        return False, "no ink"
    x0, y0, x1, y1 = rect
    w, h = max(x1 - x0, 1), max(y1 - y0, 1)
    if kind in ("square", "circle"):
        band = 6.0

        def edge(x: float, y: float) -> float:
            if kind == "square":
                return min(abs(x - x0), abs(x - x1), abs(y - y0), abs(y - y1))
            nx, ny = (x - (x0 + x1) / 2) / (w / 2), (y - (y0 + y1) / 2) / (h / 2)
            return abs(math.hypot(nx, ny) - 1) * min(w, h) / 2

        on_edge = sum(1 for x, y in points if edge(x, y) <= band) / len(points)
        centre = sum(1 for x, y in points if abs(x - (x0 + x1) / 2) < w * 0.2 and abs(y - (y0 + y1) / 2) < h * 0.2)
        return (on_edge > 0.9 and centre < 0.05 * len(points)), f"edge {on_edge:.2f} centre {centre}"
    if kind in ("line", "arrow", "ink"):
        # the drawn path, in screenshot space: one segment, or the freehand's own
        # points in the order the hand moved
        segs = []
        if path and len(path) > 1:
            scr = [(px, PAGE_H - py) for px, py in path]
            segs = list(zip(scr, scr[1:]))
        else:
            segs = [((drag[0], PAGE_H - drag[1]), (drag[2], PAGE_H - drag[3]))]

        def off(x: float, y: float) -> float:
            best = 1e9
            for (sx, sy), (ex, ey) in segs:
                dx, dy = ex - sx, ey - sy
                length = max(math.hypot(dx, dy), 1)
                t = max(0.0, min(1.0, ((x - sx) * dx + (y - sy) * dy) / (length * length)))
                best = min(best, math.hypot(x - (sx + t * dx), y - (sy + t * dy)))
            return best
        corridor = 6 if kind == "ink" else 5
        near = sum(1 for x, y in points if off(x, y) <= corridor) / len(points)
        return near > 0.9, f"near-path {near:.2f}"
    if kind == "highlight":
        cols = {x for x, _ in points}
        return len(cols) > 0.8 * w, f"columns {len(cols)}/{int(w)}"
    return True, ""


def screen_half(before_path: str, after_path: str, scale: float, rect: list, stroke: float, opacity: float, colour_hex: str):
    """`rect` is the annotation's own `/Rect` in MuPDF coordinates, which on a page
    with no rotation is the captured screenshot's own space (y down from the top)."""
    before = Image.open(before_path).convert("RGB")
    after = Image.open(after_path).convert("RGB")
    if before.size != after.size:
        return {"err": f"size {before.size} != {after.size}"}
    w, h = before.size
    bp, ap = before.load(), after.load()
    assert bp is not None and ap is not None
    pad = stroke + 3
    box = (
        max(int((rect[0] - pad) * scale), 0),
        max(int((rect[1] - pad) * scale), 0),
        min(int((rect[2] + pad) * scale), w),
        min(int((rect[3] + pad) * scale), h),
    )
    ctrl = (int(CONTROL_X[0] * scale), int(120 * scale), int(CONTROL_X[1] * scale), int(500 * scale))
    want = rgb(colour_hex)
    wanted: list[tuple[int, int, int]] = [want, blend(want, opacity), blend(want, min(opacity, 0.4))]
    ink = outside = control = 0
    changed: list[tuple[float, tuple[int, int, int]]] = []
    far: list[tuple[float, tuple[int, int, int]]] = []
    points: list[tuple[int, int]] = []
    for y in range(h):
        for x in range(w):
            a, b = px(bp, x, y), px(ap, x, y)
            if max(abs(a[i] - b[i]) for i in range(3)) <= INK_DELTA:
                continue
            if ctrl[0] <= x < ctrl[2] and ctrl[1] <= y < ctrl[3]:
                control += 1
                continue
            ink += 1
            if not (box[0] <= x <= box[2] and box[1] <= y <= box[3]):
                outside += 1
                continue
            points.append((x, y))
            changed.append((min(math.dist(b, c) for c in wanted), b))
            if math.dist(b, (255, 255, 255)) > 60:
                far.append((min(math.dist(b, c) for c in wanted), b))
    if ink == 0:
        return {"ink": 0, "outside": 0, "control": control, "core": None, "colourDelta": None}
    pool = far if len(far) > 40 else changed
    pool.sort()
    core = pool[: max(len(pool) // 10, min(len(pool), 60))]
    mean = tuple(round(sum(c[i] for _, c in core) / len(core)) for i in range(3))
    return {
        "ink": ink,
        "outside": outside,
        "control": control,
        "points": points,
        "core": mean,
        "colourDelta": round(min(math.dist(mean, c) for c in wanted), 1),
        "box": box,
    }


def match_new(annots, src_annots):
    """Export annotations that are not one of the source's, matched by type+rect."""
    taken = set()
    new = []
    for a in annots:
        hit = None
        for i, s in enumerate(src_annots):
            if i in taken or s.type[1] != a.type[1]:
                continue
            if abs(s.rect.x0 - a.rect.x0) < 1 and abs(s.rect.y0 - a.rect.y0) < 1:
                hit = i
                break
        if hit is None:
            new.append(a)
        else:
            taken.add(hit)
    return new, len(taken)


def file_half(pdf_path: str, source_path: str, drag: dict, colour_hex: str, body: str | None):
    doc = pymupdf.open(pdf_path)
    src = pymupdf.open(source_path)
    page, src_page = doc[0], src[0]
    annots = list(page.annots() or [])
    src_annots = list(src_page.annots() or [])
    new, kept = match_new(annots, src_annots)
    out: dict = {
        "annotCount": len(annots),
        "newCount": len(new),
        "keptSourceAnnots": kept,
        "sourceAnnots": len(src_annots),
        "links": len(page.get_links()),
        "sourceLinks": len(src_page.get_links()),
        "infoSame": (doc.metadata or {}).get("title") == (src.metadata or {}).get("title")
        and (doc.metadata or {}).get("producer") == (src.metadata or {}).get("producer"),
        "pageCount": doc.page_count,
        "sourcePageCount": src.page_count,
    }
    if not new:
        return out
    found = new[0]
    out["subtype"] = found.type[1]
    out["rect"] = [round(v, 2) for v in found.rect]
    drag_rect = pymupdf.Rect(drag["x1"], PAGE_H - drag["y2"], drag["x2"], PAGE_H - drag["y1"])
    out["dragRect"] = [round(v, 2) for v in drag_rect]
    out["placementDelta"] = [round(found.rect[i] - drag_rect[i], 2) for i in range(4)]
    out["C"] = [round(c, 3) for c in found.colors.get("stroke", [])] + [round(c, 3) for c in found.colors.get("fill", [])]
    obj = doc.xref_object(found.xref)
    ref = re.search(r"/AP\s*<<\s*/N\s+(\d+)\s+\d+\s+R", obj)
    data = (doc.xref_stream(int(ref.group(1))) if ref else b"") or b""
    out["apBytes"] = len(data)
    out["apHead"] = data[:90].decode("latin1", "replace").replace("\n", " ")
    if body:
        # A line break is a layout fact, not a missing word: compare with the
        # whitespace folded, and only the words that fit the box at all.
        flat = lambda value: " ".join(value.split())
        head = " ".join(body.split()[:2])
        out["textPresent"] = head in flat(page.get_textbox(found.rect + (-4, -4, 4, 4)))
        out["textInRect"] = flat(page.get_textbox(found.rect))[:80]
        out["textHead"] = head
        da = re.search(r"/DA\s*\((.*?)\)\s*/", obj)
        out["da"] = da.group(1)[:120] if da else ""
        out["annotFonts"] = [f[3] for f in page.get_fonts() if f[3] not in {g[3] for g in src_page.get_fonts()}]
    with_annots = page.get_pixmap(dpi=96, annots=True)
    without = page.get_pixmap(dpi=96, annots=False)
    pw, ph = with_annots.width, with_annots.height
    sx, sy = pw / page.rect.width, ph / page.rect.height
    box = (int(found.rect.x0 * sx) - 1, int(found.rect.y0 * sy) - 1, int(found.rect.x1 * sx) + 1, int(found.rect.y1 * sy) + 1)
    a_px, b_px = with_annots.samples, without.samples
    changed: list[tuple[float, tuple[int, int, int]]] = []
    far: list[tuple[float, tuple[int, int, int]]] = []
    want = rgb(colour_hex)
    wanted: list[tuple[int, int, int]] = [want, blend(want, 0.4)]
    for y in range(max(box[1], 0), min(box[3], ph)):
        for x in range(max(box[0], 0), min(box[2], pw)):
            o = (y * pw + x) * with_annots.n
            p, q = tuple(a_px[o:o + 3]), tuple(b_px[o:o + 3])
            if max(abs(p[i] - q[i]) for i in range(3)) <= INK_DELTA:
                continue
            changed.append((min(math.dist(p, c) for c in wanted), p))
            if math.dist(p, (255, 255, 255)) > 60:
                far.append((min(math.dist(p, c) for c in wanted), p))
    out["inkPx"] = len(changed)
    out["fileInkPct"] = round(100 * len(changed) / max((box[2] - box[0]) * (box[3] - box[1]), 1), 2)
    if changed:
        pool = far if len(far) > 40 else changed
        pool.sort()
        core = pool[: max(len(pool) // 10, min(len(pool), 60))]
        out["fileCore"] = tuple(round(sum(c[i] for _, c in core) / len(core)) for i in range(3))
        out["fileColourDelta"] = round(min(math.dist(out["fileCore"], c) for c in wanted), 1)
    return out


# How far from the rectangle the hand drew a mark's own `/Rect` may legitimately
# sit: a stroke is centred on its path, a click gets a default box centred on the
# pointer, and a highlight is snapped to the glyph box it crossed.
PLACEMENT_TOL = {
    "square": RECT_TOL_PT, "circle": RECT_TOL_PT, "stamp": RECT_TOL_PT, "image": RECT_TOL_PT,
    "ink": 6.0, "line": 7.0, "arrow": 12.0,
    # a highlight is snapped to the glyph box it crossed, a click gets a default
    # box centred on the pointer: both move the rect, deliberately.
    "highlight": 72.0, "note": 16.0, "freetext": 122.0,
}


def placed_where_drawn(rec: dict, fh: dict) -> bool:
    tool = rec.get("tool") or rec.get("id", "").split("-")[0]
    stroke = float((rec.get("markBox") or {}).get("stroke") or 1)
    tol = PLACEMENT_TOL.get(tool, stroke / 2 + 3)
    return all(abs(d) <= tol for d in fh.get("placementDelta", [99]))


def main() -> int:
    root = sys.argv[1]
    source = os.environ.get("PDF", "/tmp/triage/in/annot.pdf")
    failures = 0
    cases = sorted(f[:-5] for f in os.listdir(root) if f.endswith(".json") and not f.startswith("epilogue"))
    for case in cases:
        rec = json.load(open(os.path.join(root, f"{case}.json")))
        drag = rec.get("drawn")
        mark = rec.get("markBox")
        colours = rec.get("colourSet") or {}
        before = os.path.join(root, f"{case}-before.png")
        after = os.path.join(root, f"{case}-after.png")
        pdf_path = os.path.join(root, f"{case}.pdf")
        ok_caps = os.path.exists(before) and os.path.exists(after)
        body = (rec.get("typed") or {}).get("body") or (rec.get("typed") and "Measured text box")
        fh = file_half(pdf_path, source, drag, colours.get("wanted", "#000000"), body) if os.path.exists(pdf_path) and drag else {"err": "no file"}
        stroke = float((mark or {}).get("stroke") or 1)
        screen = (
            screen_half(before, after, rec.get("scale", 1), fh["rect"], stroke, 1.0, colours.get("wanted", "#000000"))
            if ok_caps and fh.get("rect") else {"err": "no capture or no annotation rect"}
        )
        problems: list[str] = []
        shape, shapeNote = shape_ok(
            rec.get("tool") or "", screen.get("points") or [], fh.get("rect") or [0, 0, 1, 1],
            [drag["x1"], drag["y1"], drag["x2"], drag["y2"]] if drag else [0, 0, 1, 1],
            rec.get("path"),
        )
        if screen.get("ink", 0) >= MIN_INK_PX and not shape:
            problems.append(f"shape: {shapeNote}")
        if screen.get("ink", 0) < MIN_INK_PX:
            problems.append(f"screen ink {screen.get('ink')}")
        white_word = colours.get("wanted") and math.dist(rgb(colours["wanted"]), (255, 255, 255)) < 40
        if white_word and screen.get("core"):
            # white words on the box's own white fill: the ink is anti-aliased grey,
            # so "is it the colour asked for" is "is it light", not a distance.
            if math.dist(screen["core"], (255, 255, 255)) >= 110:
                problems.append(f"screen colour {screen['core']} not white")
        elif rec.get("tool") != "image" and (screen.get("colourDelta") is None or screen["colourDelta"] > COLOUR_TOL):
            problems.append(f"screen colour {screen.get('core')} vs {colours.get('wanted')}")
        if screen.get("outside", 0) > 0.05 * max(screen.get("ink", 1), 1):
            problems.append(f"{screen['outside']} px outside the mark box")
        if screen.get("control", 0) > 0 and rec.get("tool") != "image":
            problems.append(f"control column dirty ({screen['control']} px)")
        if fh.get("newCount", 0) != 1:
            problems.append(f"file new annots {fh.get('newCount')}")
        elif not placed_where_drawn(rec, fh):
            problems.append(f"mark placed off the drag by {fh.get('placementDelta')}")
        if fh.get("inkPx", 0) < MIN_INK_PX:
            problems.append(f"file ink {fh.get('inkPx')}")
        if white_word and fh.get("fileCore") and not math.dist(fh["fileCore"], (255, 255, 255)) < 110:
            problems.append(f"file colour {fh.get('fileCore')} not white")
        elif not white_word and rec.get("tool") != "image" and fh.get("fileColourDelta") is not None and fh["fileColourDelta"] > COLOUR_TOL:
            problems.append(f"file colour {fh.get('fileCore')}")
        if body and not fh.get("textPresent"):
            problems.append("typed text missing from the file")
        if fh.get("keptSourceAnnots") != fh.get("sourceAnnots"):
            problems.append(f"source annots {fh.get('keptSourceAnnots')}/{fh.get('sourceAnnots')}")
        if fh.get("links") != fh.get("sourceLinks"):
            problems.append(f"links {fh.get('links')}/{fh.get('sourceLinks')}")
        if not fh.get("infoSame", False):
            problems.append("/Info changed")
        if fh.get("pageCount") != fh.get("sourcePageCount"):
            problems.append("page count changed")
        if problems:
            failures += 1
        print(json.dumps({
            "case": case, "verdict": "FAIL" if problems else "ok", "problems": problems,
            "colour": colours.get("wanted"),
            "screen": {k: screen.get(k) for k in ("ink", "outside", "control", "core", "colourDelta")} | {"shape": shapeNote},
            "file": {k: fh.get(k) for k in ("subtype", "rect", "placementDelta", "C", "apBytes", "inkPx", "fileCore", "fileColourDelta", "textPresent", "apHead", "da", "annotFonts")},
        }))
    print(f"# {len(cases) - failures}/{len(cases)} ok")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
