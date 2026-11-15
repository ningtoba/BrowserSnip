"""Round 029 `font-to-outline` — build the fixtures and judge a produced file.

    python3 docs/research/font-outline-round.py --build /tmp/triage/in
    python3 docs/research/font-outline-round.py --compare SRC.pdf OUT.pdf [OUT2 …]

Fixtures, because the tool has one claim and several ways to break it:

  doc.pdf   four A4 sheets — p1 text in an **embedded subset** (Vera), p2 text in a
            **non-embedded base-14 reference** (Helvetica), p3 the same reference
            over a drawn box, p4 a picture and a polyline and **no text**. /Info
            carries a title and an author so a rewrite that drops it is visible.
  rich.pdf  three sheets carrying what a rewrite usually throws away — a highlight
            annotation and a link on p1, a `/CropBox [60 60 500 700]` and a URI link
            on p2, `/Rotate 90` on p3 — plus a two-entry outline and an /Info title.

`--compare` is a check, not a printout: it exits 1 on any page whose text did not
leave, whose ink changed by more than 1 % of the source's own pixels, whose box,
rotation, annotation, link or info entry went missing, or — for a `--keep` page —
whose text did leave. It prints `ok`/`FAIL` per row so a log reads as evidence.

    --keep 1,3      pages that must keep their text and art (the unselected ones)
    --partial       a selected-pages run: the outline is expected to be dropped
    --crop "x0,y0,x1,y1"  a region to render from both files for the eye, at 200 dpi
"""
import os
import sys

import pymupdf

FACE = "/usr/share/fonts/TTF/Vera.ttf"
MARK = "OUTLINEPROBE page {page} line {row} — the quick brown fox jumps over 13 lazy dogs."


def text_of(page):
    """`get_text` is typed as text or a list of blocks depending on options."""
    extracted = page.get_text("text")
    return extracted if isinstance(extracted, str) else "".join(extracted)


def pixel_png(path):
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 48, 48))
    for y in range(48):
        for x in range(48):
            pix.set_pixel(x, y, (20 + x * 4, 200 - y * 4, 120) if (x + y) % 3 else (240, 20, 20))
    pix.save(path)


def build(outdir):
    os.makedirs(outdir, exist_ok=True)
    png = os.path.join(outdir, "round-pixel.png")
    pixel_png(png)

    doc = pymupdf.open()
    for index in range(1, 5):
        page = doc.new_page(width=595.28, height=841.89)
        if index == 4:
            page.insert_image(pymupdf.Rect(54, 300, 214, 460), filename=png)
            page.draw_polyline(
                [pymupdf.Point(54, 600), pymupdf.Point(240, 660), pymupdf.Point(430, 560)],
                color=(0, 0, 0.8),
                width=4,
            )
            continue
        if index == 1:
            page.insert_font(fontname="F0", fontfile=FACE)
            fontname, size = "F0", 12
        else:
            fontname, size = "helv", 12
        for row in range(1, 5):
            page.insert_text(
                (54, 110 + (row - 1) * 20),
                MARK.format(page=index, row=row),
                fontname=fontname,
                fontsize=size,
            )
        if index == 3:
            page.draw_rect(pymupdf.Rect(54, 200, 500, 300), color=(0.8, 0.1, 0.1), width=2)
    doc.set_metadata({"title": "OUTLINEPROBE document", "author": "Round 029", "subject": "keep me"})
    doc.save(os.path.join(outdir, "doc.pdf"))
    doc.close()

    doc = pymupdf.open()
    one = doc.new_page(width=595.28, height=841.89)
    one.insert_text((54, 110), "ANNOTPROBE page 1 carries a highlight and a link", fontname="helv", fontsize=13)
    annot = one.add_highlight_annot(pymupdf.Rect(54, 98, 420, 114))
    annot.update()
    two = doc.new_page(width=595.28, height=841.89)
    two.insert_text((54, 110), "ANNOTPROBE page 2 has a crop box and a URI link", fontname="helv", fontsize=13)
    two.set_cropbox(pymupdf.Rect(60, 60, 500, 700))
    three = doc.new_page(width=595.28, height=841.89)
    three.insert_text((54, 110), "ANNOTPROBE page 3 is stored at /Rotate 90", fontname="helv", fontsize=13)
    three.set_rotation(90)
    # Links last: a GOTO link needs the target page's xref to exist.
    # Re-fetched: a page object is stale once more pages were appended.
    doc[0].insert_link({"kind": pymupdf.LINK_GOTO, "from": pymupdf.Rect(54, 130, 300, 150), "page": 1, "to": pymupdf.Point(0, 0)})
    doc[1].insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(54, 130, 300, 150), "uri": "https://example.com/round029"})
    doc.set_toc([[1, "First sheet", 1], [1, "Second sheet", 2]])
    doc.set_metadata({"title": "ANNOTPROBE document", "author": "Round 029"})
    doc.save(os.path.join(outdir, "rich.pdf"))
    doc.close()

    for name in ("doc.pdf", "rich.pdf"):
        path = os.path.join(outdir, name)
        doc = pymupdf.open(path)
        print(
            name,
            "pages", doc.page_count,
            "text chars", [len(text_of(p).strip()) for p in doc],
            "fonts", [sorted({f[3] for f in p.get_fonts(full=True)}) for p in doc],
            "embeds", [[f[3] for f in p.get_fonts(full=True) if f[1] != "n/a"] for p in doc],
            "annots", [len(list(p.annots() or [])) for p in doc],
            "links", [len(p.get_links()) for p in doc],
            "rotations", [p.rotation for p in doc],
            "outline", len(doc.get_toc()),
        )
        doc.close()


def ink(page, dpi=72):
    pix = page.get_pixmap(dpi=dpi)
    n, data = pix.n, pix.samples
    lit = [i // n for i in range(0, len(data), n) if data[i] != 255 or data[i + 1] != 255 or data[i + 2] != 255]
    return len(lit), pix


def box_ink(page, rect, dpi=72):
    """Non-white pixels inside `rect` — the ink a region carries, for a control."""
    pix = page.get_pixmap(dpi=dpi, clip=rect)
    n, data = pix.n, pix.samples
    return sum(1 for i in range(0, len(data), n) if data[i] != 255 or data[i + 1] != 255 or data[i + 2] != 255)


def page_rows(doc):
    rows = []
    for page in doc:
        count, _ = ink(page)
        rows.append(
            {
                "text": len(text_of(page).strip()),
                "fonts": sorted({f[3] for f in page.get_fonts(full=True)}),
                # `get_fonts` marks 'n/a' where the file carries no program, which
                # is exactly the base-14 reference this round is about.
                "embedded": [f[3] for f in page.get_fonts(full=True) if f[1] != "n/a"],
                "ink": count,
                "paths": len(page.get_drawings()),
                "annots": [(a.type[1], tuple(round(v, 1) for v in a.rect)) for a in (page.annots() or [])],
                "links": [(link.get("kind"), tuple(round(v, 1) for v in link["from"])) for link in page.get_links()],
                "rotate": page.rotation,
                "box": (round(page.rect.width, 2), round(page.rect.height, 2)),
                "media": tuple(round(v, 2) for v in page.mediabox),
                "crop": tuple(round(v, 2) for v in page.cropbox),
            }
        )
    return rows


def compare(source, produced, keep, crop, partial=False):
    fails = 0

    def row(name, ok, detail=""):
        nonlocal fails
        fails += 0 if ok else 1
        print(f"    {'ok  ' if ok else 'FAIL'} {name}{' — ' + detail if detail else ''}")

    src = pymupdf.open(source)
    out = pymupdf.open(produced)
    print(f"\n=== {source} -> {produced}")
    row("page count", out.page_count == src.page_count, f"{src.page_count} -> {out.page_count}")
    if out.page_count != src.page_count:
        return fails
    before, after = page_rows(src), page_rows(out)
    for index, (b, a) in enumerate(zip(before, after, strict=True), start=1):
        print(f"  page {index}: text {b['text']} -> {a['text']} | ink {b['ink']} -> {a['ink']}"
              f" | paths {b['paths']} -> {a['paths']} | fonts {b['fonts']} -> {a['fonts']}"
              f" | embed tags {b['embedded']} -> {a['embedded']} | rotate {b['rotate']} -> {a['rotate']}")
        if index in keep:
            # A kept page keeps its text (and a kept page that never had any, none).
            row(f"p{index} text kept", a["text"] == b["text"], f"{b['text']} -> {a['text']} chars")
        else:
            row(f"p{index} text is gone", a["text"] == 0, f"{a['text']} chars left")
        # Ink is compared with the same page's own count: 1 % of the source.
        tolerance = max(2, int(b["ink"] * 0.01))
        row(f"p{index} ink kept", abs(a["ink"] - b["ink"]) <= tolerance, f"{b['ink']} -> {a['ink']} (tol {tolerance})")
        if b["text"] != 0 and index not in keep:
            row(f"p{index} glyphs are now paths", a["paths"] > b["paths"], f"{b['paths']} -> {a['paths']}")
        if index in keep:
            row(f"p{index} art untouched", a["paths"] >= b["paths"], f"{b['paths']} -> {a['paths']}")
        row(f"p{index} box", a["box"] == b["box"], f"{b['box']} -> {a['box']}")
        row(f"p{index} media box", a["media"] == b["media"], f"{b['media']} -> {a['media']}")
        row(f"p{index} crop box", a["crop"] == b["crop"], f"{b['crop']} -> {a['crop']}")
        row(f"p{index} rotation", a["rotate"] == b["rotate"], f"{b['rotate']} -> {a['rotate']}")
        if b["annots"]:
            row(f"p{index} annotations", a["annots"] == b["annots"], f"{b['annots']} -> {a['annots']}")
        if b["links"]:
            row(f"p{index} links", a["links"] == b["links"], f"{b['links']} -> {a['links']}")
    if partial:
        # A partial run rebuilds the page tree and warns for what it drops; the
        # bookmarks are the one structure that does not come back.
        row("outline named, not kept", True, f"{src.get_toc()} -> {out.get_toc()} (the card counts it)")
    else:
        row("outline", out.get_toc() == src.get_toc(), f"{src.get_toc()} -> {out.get_toc()}")
    before_info, after_info = src.metadata or {}, out.metadata or {}
    for key in ("title", "author", "subject"):
        row(f"info {key}", after_info.get(key) == before_info.get(key),
            f"{before_info.get(key)!r} -> {after_info.get(key)!r}")
    if crop:
        x0, y0, x1, y1 = (float(v) for v in crop.split(","))
        rect = pymupdf.Rect(x0, y0, x1, y1)
        for name, doc in (("source", src), ("produced", out)):
            stem = produced.rsplit(".", 1)[0]
            doc[0].get_pixmap(dpi=200, clip=rect).save(f"{stem}-crop-{name}.png")
        # The crop is judged by eye and by difference: 4 % of the crop's own lit px.
        hit = box_ink(out[0], rect)
        want = box_ink(src[0], rect)
        row("crop still paints the same words", abs(hit - want) <= max(4, int(want * 0.04)), f"{want} -> {hit} lit px")
        print(f"    crops: {produced.rsplit('.', 1)[0]}-crop-source.png / -produced.png")
    src.close()
    out.close()
    return fails


def main(argv):
    if "--build" in argv:
        build(argv[argv.index("--build") + 1])
        return 0
    if "--compare" not in argv:
        print(__doc__)
        return 2
    # Options may sit after the paths, so only `.pdf` arguments are files.
    paths = [a for a in argv[argv.index("--compare") + 1:] if a.endswith(".pdf")]
    src, outs = paths[0], paths[1:]
    keep = {int(v) for v in (argv[argv.index("--keep") + 1].split(",") if "--keep" in argv else [])}
    crop = argv[argv.index("--crop") + 1] if "--crop" in argv else ""
    fails = 0
    for out in outs:
        fails += compare(src, out, keep, crop, "--partial" in argv)
    print(f"\n{fails} FAIL line(s)")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
