#!/usr/bin/env python3
"""Does a pdf-layers export move exactly the ink it says, and nothing else?

  python3 docs/research/layers-measure.py <source.pdf> <produced.pdf> \
      [--hidden NAME] [--shown NAME] [--removed NAME]

Both files are rendered with MuPDF (and, when `pdftoppm` is present, with poppler)
at one dpi and compared page by page, so "the layer's ink went and the rest of the
page did not change" is a pixel count and not a dictionary guess. The
`/OCProperties` bookkeeping is printed with every `ON` / `OFF` entry resolved
against the `/OCGs` entries by object number — a copy is not a reference and a
viewer that cannot match it shows everything. `/Info`, annotations, links and the
text of every page are printed so "untouched" is measured too.

A `--hidden` name must lose ink and leave the other pages byte-identical in the
render; `--shown` must gain ink. Exit 1 when a claim does not hold, so a broken
instrument cannot pass silently.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

import re

import pymupdf

DPI = 150


def props(path: Path) -> None:
    doc = pymupdf.open(path)
    catalog = doc.pdf_catalog()
    kind, value = doc.xref_get_key(catalog, "OCProperties")
    print(f"  /OCProperties: {kind} {value}")
    if kind != "xref":
        return
    props_xref = int(value.split()[0])
    ocgs_kind, ocgs_value = doc.xref_get_key(props_xref, "OCGs")
    names: dict[int, str] = {}
    raw = doc.xref_get_key(props_xref, "OCGs")
    print(f"  /OCGs: {raw}")
    if raw[0] == "array":
        for item in raw[1].strip("[]").split():
            if item.endswith("R"):
                xref = int(item.split()[0])
                name = doc.xref_get_key(xref, "Name")
                names[xref] = name[1]
    _, default = doc.xref_get_key(props_xref, "D")
    print(f"  /D: {default}")
    if default.startswith("xref"):
        d_xref = int(default.split()[0])
        for key in ("ON", "OFF", "Order"):
            got = doc.xref_get_key(d_xref, key)
            print(f"  /D {key}: {got[0]} {resolve(got, names)}")
    else:
        for key in ("ON", "OFF", "Order"):
            hit = re.search(rf"/{key}\[([^\]]*)\]", default)
            if hit is None:
                print(f"  /D {key}: absent")
                continue
            got = ("array", hit.group(0).split("[", 1)[1].rstrip("]"))
            print(f"  /D {key}: {resolve(got, names)}")
    doc.close()


def resolve(got: tuple[str, str], names: dict[int, str]) -> list[str]:
    """An `ON` / `OFF` entry list, each reference named from its `/OCGs` entry.

    A copy of a group dictionary dereferences to the same object number, so the
    question "is this the group a viewer will match" is the object number, and an
    entry that is not in `/OCGs` is reported as such rather than silently named.
    """
    out = []
    for item in got[1].split():
        if item.endswith("R"):
            xref = int(item.split()[0])
            out.append(f"{names.get(xref, 'NOT AN /OCGs ENTRY')}@{xref}")
        else:
            out.append(item)
    return out


def page_facts(path: Path) -> list[tuple]:
    doc = pymupdf.open(path)
    out = []
    for page in doc:
        out.append(
            (
                page.number,
                round(page.rect.width, 1),
                round(page.rect.height, 1),
                page.rotation,
                len(page.get_text()),
                page.get_text().replace("\n", " / ")[:120],
                len(list(page.get_links())),
                len(list(page.annots() or [])),
                sum(1 for _ in page.get_images()),
            )
        )
    print(f"  /Info: {doc.metadata}")
    print("  /Shapes page boxes:")
    for (number, width, height, rotation, chars, _text, links, annots, images) in out:
        print(
            f"    p{number + 1}: {width}x{height} rot={rotation} chars={chars} "
            f"links={links} annots={annots} images={images}"
        )
    return out


def render(path: Path, into: Path) -> list[Path]:
    doc = pymupdf.open(path)
    made = []
    for page in doc:
        pixmap = page.get_pixmap(dpi=DPI)
        target = into / f"{path.stem}-{page.number}.png"
        pixmap.save(target)
        made.append(target)
    doc.close()
    return made


def pixels(path: Path) -> list[tuple[int, int, int]]:
    pixmap = pymupdf.Pixmap(path)
    if pixmap.alpha:
        pixmap = pymupdf.Pixmap(pixmap, 0)
    data = pixmap.samples
    return [
        (data[i], data[i + 1], data[i + 2])
        for i in range(0, len(data), pixmap.n)
    ]


def compare(source: list[Path], produced: list[Path], width: int) -> list[tuple]:
    """Per page: changed pixels, their bounding box, and ink before / after.

    The box is what makes the claim about *one* layer: a hide that also repainted
    the page would move ink outside a text row, and the same total would still
    read as a change.
    """
    rows = []
    for before_png, after_png in zip(source, produced, strict=True):
        before = pixels(before_png)
        after = pixels(after_png)
        changed = 0
        box = [width, 0, 10**6, 0]
        for index, (a, b) in enumerate(zip(before, after, strict=True)):
            if a == b:
                continue
            changed += 1
            x, y = index % width, index // width
            box[0] = min(box[0], x)
            box[1] = max(box[1], y)
            box[2] = min(box[2], y)
            box[3] = max(box[3], x)
        rows.append(
            (
                changed,
                (box[0], box[2], box[3], box[1]) if changed else None,
                sum(1 for pixel in before if pixel != (255, 255, 255)),
                sum(1 for pixel in after if pixel != (255, 255, 255)),
            )
        )
    return rows


def ink_inside(png: Path, box: tuple[int, int, int, int], width: int) -> int:
    data = pixels(png)
    x0, y0, x1, y1 = box
    total = 0
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            if data[y * width + x] != (255, 255, 255):
                total += 1
    return total


def poppler(path: Path, into: Path) -> list[int] | None:
    if subprocess.run(["which", "pdftoppm"], capture_output=True).returncode != 0:
        return None
    stem = into / f"{path.stem}-pop"
    done = subprocess.run(
        ["pdftoppm", "-r", str(DPI), "-png", str(path), str(stem)],
        capture_output=True,
    )
    if done.returncode != 0:
        return None
    ink = []
    for png in sorted(into.glob(f"{stem.name}-*.png")):
        pixmap = pymupdf.Pixmap(png)
        if pixmap.alpha:
            pixmap = pymupdf.Pixmap(pixmap, 0)
        data = pixmap.samples
        ink.append(
            sum(1 for i in range(0, len(data), pixmap.n) if data[i : i + 3] != b"\xff\xff\xff")
        )
    return ink


def main() -> int:
    args = sys.argv[1:]
    want = {}
    files = []
    rest = list(args)
    while rest:
        item = rest.pop(0)
        if item.startswith("--"):
            want[item] = rest.pop(0)
        else:
            files.append(Path(item))
    source, produced = files

    print(f"source {source}")
    props(source)
    source_facts = page_facts(source)
    print(f"produced {produced}")
    props(produced)
    produced_facts = page_facts(produced)

    problems = []
    with tempfile.TemporaryDirectory() as scratch:
        scratch_path = Path(scratch)
        source_pngs = render(source, scratch_path)
        produced_pngs = render(produced, scratch_path)
        width = pymupdf.Pixmap(source_pngs[0]).width
        rows = compare(source_pngs, produced_pngs, width)
        print("\nMuPDF page-by-page (changed px, changed box x0,y0,x1,y1, ink before -> after):")
        for number, row in enumerate(rows):
            print(f"  p{number + 1}: {row[0]} changed, box {row[1]}, ink {row[2]} -> {row[3]}")
        if rows[0][1]:
            # One layer's drawing is one text row: a repaint of the sheet would
            # reach the whole page, so the box is the read that says "this ink".
            box = rows[0][1]
            inside_before = ink_inside(source_pngs[0], box, width)
            inside_after = ink_inside(produced_pngs[0], box, width)
            print(f"  inside the box: ink {inside_before} -> {inside_after}")

        for flag, name in want.items():
            if flag == "--removed":
                continue
            if flag == "--hidden":
                if inside_after >= inside_before:
                    problems.append(f'hiding "{name}" did not reduce the ink it draws')
                moved = [row[0] for row in rows[1:]]
                if any(moved):
                    problems.append(f'hiding "{name}" changed pages 2+: {moved}')
            elif inside_after <= inside_before:
                problems.append(f'showing "{name}" did not add the ink it draws')

        before_pop = poppler(source, scratch_path)
        after_pop = poppler(produced, scratch_path)
        if before_pop is not None and after_pop is not None:
            print(f"\npoppler ink per page: before {before_pop} after {after_pop}")
        else:
            print("\npoppler: unavailable or refused")

    # Non-layer content, /Info, annotations and links.
    if len(source_facts) != len(produced_facts):
        problems.append(f"page count moved {len(source_facts)} -> {len(produced_facts)}")
    for before, after in zip(source_facts, produced_facts, strict=True):
        if before[:4] != after[:4]:
            problems.append(f"page {before[0] + 1} box/rotation moved {before[:4]} -> {after[:4]}")
        if before[6:] != after[6:]:
            problems.append(f"page {before[0] + 1} links/annots/images moved {before[6:]} -> {after[6:]}")
    source_text = [row[5] for row in source_facts]
    produced_text = [row[5] for row in produced_facts]
    for number, (before, after) in enumerate(zip(source_text, produced_text, strict=True)):
        if before != after:
            print(f"  p{number + 1} text changed: {after!r}")

    print()
    if problems:
        for problem in problems:
            print(f"FAIL {problem}")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
