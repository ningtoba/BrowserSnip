#!/usr/bin/env python3
"""What a browser would have to download before page 1 can paint.

    python3 docs/research/linearize-prefix.py FILE.pdf [FILE2.pdf …]

A `/Linearized` dictionary is a *claim*; ISO 32000-1 Annex F is the obligation that
goes with it — page 1's objects and the hint tables written in front of everything
else, and an xref for them first. This measures the obligation instead of reading
the claim:

  * the transitive closure of page 1 is walked out of the file's own references
    (the page dictionary, its content streams, every resource, font program,
    property dictionary and inherited node it reaches);
  * each object's position is the byte offset it must arrive at — its own
    `n 0 obj` header, or, for an object packed into an object stream, that
    stream's header, because that is the unit a reader has to fetch;
  * the furthest of those offsets over the file length is the fraction of the file
    that has to land before the first sheet can be drawn;
  * plus the two facts a checker keys on: the parameter dictionary inside the
    first 1024 bytes with an `/L` equal to the file length, and how many
    cross-reference sections the file carries (Annex F requires two).

The number that makes a linearized file different is not the dictionary, it is this
prefix. A rebuild that only re-orders objects still answers "most of the file"; a
conforming linearization answers "a few percent".
"""
from __future__ import annotations

import re
import sys

import pymupdf

REFERENCE = re.compile(r"\b(\d+)\s+0\s+R")


def header_offsets(data: bytes) -> dict[int, int]:
    """Offset of every `n 0 obj` header written loose in the file."""
    return {int(m.group(1)): m.start() for m in re.finditer(rb"(?:^|[\s>])(\d+) 0 obj", data)}


def stream_members(doc) -> dict[int, int]:
    """`object → offset of the object stream that carries it`, for packed objects."""
    inside: dict[int, int] = {}
    data = None
    for xref in range(1, doc.xref_length()):
        try:
            head = re.sub(r"\s+", " ", doc.xref_object(xref, compressed=False))
        except Exception:
            continue
        if "/Type /ObjStm" not in head:
            continue
        count = re.search(r"/N (\d+)", head)
        if not count or not doc.xref_is_stream(xref):
            continue
        body = doc.xref_stream(xref) or b""
        pairs = body.split(maxsplit=2 * int(count.group(1)))
        numbers = [int(token) for token in pairs[0 : 2 * int(count.group(1))] if token.isdigit()]
        for member in numbers[0::2]:
            inside.setdefault(member, xref)
    return inside


def page_one_closure(doc) -> set[int]:
    """Every object number sheet 1 reaches, by reference, transitively.

    `/Parent` is followed for the attributes a sheet inherits (`/Resources`,
    `/MediaBox`, `/Rotate`) and *not* for the node's own references: a `/Pages` node
    names every kid in the document, and walking that edge would make page 1's
    closure the whole file — which is exactly the question being asked.
    """
    page = doc[0]
    seen: set[int] = set()
    todo = [page.xref]
    inheritable: list[int] = []
    node = doc.xref_get_key(page.xref, "Parent")
    while node[0] == "xref":
        parent = int(node[1].split()[0])
        inheritable.append(parent)
        node = doc.xref_get_key(parent, "Parent")
    while todo:
        xref = todo.pop()
        if xref in seen or not 0 < xref < doc.xref_length():
            continue
        seen.add(xref)
        try:
            head = doc.xref_object(xref, compressed=False)
        except Exception:
            continue
        for key, value in re.findall(r"/(Parent)\s+(\d+)\s+0\s+R", head):
            seen.add(int(value))  # the ancestor is reached, its other edges are not
        for number in REFERENCE.findall(re.sub(r"/Parent\s+\d+\s+0\s+R", " ", head)):
            todo.append(int(number))
    for parent in inheritable:
        seen.add(parent)
        try:
            head = doc.xref_object(parent, compressed=False)
        except Exception:
            continue
        for edge in ("Resources", "MediaBox", "CropBox", "Rotate", "Properties", "ExtGState"):
            found = re.search(rf"/{edge}\s*(<<.*?>>|\d+ 0 R)", head, re.S)
            if not found:
                continue
            for number in REFERENCE.findall(found.group(1)):
                if int(number) not in seen:
                    todo.append(int(number))
    return seen, set(inheritable)


def report(path: str) -> None:
    data = open(path, "rb").read()
    doc = pymupdf.open(path)
    loose = header_offsets(data)
    packed = stream_members(doc)
    head = data[:1024]
    linear = b"/Linearized" in head
    param = {}
    for key in ("L", "N", "O", "E", "T"):
        found = re.search(rf"/{key}\s+(\d+)".encode(), head)
        if found:
            param[key] = int(found.group(1))
    hint = re.search(rb"/H\s*\[\s*(\d+)\s+(\d+)\s*\]", head)
    sections = len(re.findall(rb"(?:^|[\s>])xref[\s\n]+\d+", data)) + len(re.findall(rb"/Type\s*/XRef", data))
    closure, ancestors = page_one_closure(doc)
    positions = []
    for number in sorted(closure):
        if number in loose:
            positions.append((number, loose[number]))
        elif number in packed and packed[number] in loose:
            positions.append((number, loose[packed[number]]))
    last = max((off for _, off in positions), default=0)
    tree = max(
        (loose[number] for number in ancestors if number in loose),
        default=None,
    )
    # A reader that honours Annex F does not walk `/Root » /Pages » /Kids` to find
    # sheet 1 — that is the whole point of the hint table, and the page-tree node is
    # allowed to sit at the end of the file. So the file is measured against its own
    # promise: `/E` says where the first-page section stops, and every object sheet 1
    # needs, plus the hint stream named by `/H`, has to be inside it.
    promised = param.get("E")
    cover = promised if linear and promised else last
    inside = [number for number, off in positions if promised is not None and off >= promised]
    hint_inside = bool(hint) and int(hint.group(1)) + int(hint.group(2)) <= (promised or 0)
    print(
        f"{path}\n"
        f"  {len(data)} bytes | /Linearized in first 1024: {linear}"
        f" | params {param or '—'} | /H {[int(g) for g in hint.groups()] if hint else '—'}"
        f" | xref sections {sections}\n"
        f"  sheet-1 closure {len(closure)} object(s); last of them at byte {last}"
        f" → {last / max(len(data), 1) * 100:.1f} % of the file by walking the page tree"
        + (f"; the /Pages node itself sits at byte {tree} ({tree / len(data) * 100:.1f} %)" if tree else "")
        + "\n"
        + (
            f"  first-page section promised by /E: byte {promised}"
            f" → a range reader paints sheet 1 after {promised / len(data) * 100:.1f} % of the file;"
            f" objects at or past that byte: {inside or 'none'}; hint stream inside it: {hint_inside}"
            if linear and promised
            else f"  no /E to honour (not linearized): the reader pays the full {last / max(len(data), 1) * 100:.1f} % walk"
        )
    )


def main() -> int:
    for path in sys.argv[1:]:
        try:
            report(path)
        except Exception as error:
            print(f"{path}\n  unreadable: {error}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
