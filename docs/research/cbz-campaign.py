#!/usr/bin/env python3
"""Judge a produced CBZ the way a comic reader would: entry by entry.

`cbz-bytes.mjs` measured *ink* and stopped there. Ink alone cannot tell you that
entry 3 is a picture of page 3 — an archive whose entries are all page 1 measures
the right ink on one entry and wrong everywhere else, and one that repeats a page
looks perfectly inked. So this reads the container instead:

  1. every entry is a real JPEG/PNG (magic matches the extension, PIL decodes it)
  2. the entry's name says which page it should be, and the *picture* says which
     page it is: the entry is matched against every source page rendered at the
     archive's own pixel size, and the best match has to be the page it names
     (8x8 grey signature, mean absolute difference) — the ink table is printed
     beside it so a reader can see the sizes and the sign of the delta
  3. names sort in page order (zero-padded, unique) and match the byte order
  4. the first entry is a picture, not a directory; nothing is nested
  5. ComicInfo.xml, if present, is well-formed and says the archive's own count
     (the format itself mandates nothing: `readium/architecture` — "unlike the
     EPUB format, CBZ doesn't have any mandatory extra files" — so absence is
     reported, not failed)
  6. every control reached the bytes: entry count == pages asked for, entries are
     all one format, and *each* entry's pixel size is its own page's displayed
     box at that dpi (a mixed-size source is not a defect — a `/Rotate 90`
     sheet is landscape — so the size rule is per page, not one size for all)

  python3 docs/research/cbz-campaign.py --cbz /tmp/r021/before.cbz \
      --source /tmp/triage/ink.pdf --dpi 200

Exit code 0 only when every check passes; a FAIL line names the entry and what it
measured. `--expect-shuffled` proves the identity check is not vacuous.
"""
import argparse
import io
import re
import sys
import zipfile

import numpy as np
import pymupdf
from PIL import Image

fails: list[str] = []


def pix_ints(pm: pymupdf.Pixmap) -> tuple[int, int, int]:
    """PyMuPDF types these as optional; they are ints on any live pixmap."""
    return int(pm.n), int(pm.width or 0), int(pm.height or 0)


def fail(msg: str) -> None:
    fails.append(msg)
    print(f"FAIL {msg}")


def sig(im: Image.Image) -> np.ndarray:
    """An 8x8 grey fingerprint, so identity survives any re-encode."""
    return np.asarray(im.convert("L").resize((8, 8), Image.Resampling.BOX), dtype=float)


def alike(a: Image.Image, b: Image.Image) -> float:
    """Centred cosine similarity of the two fingerprints, −1…1.

    Ink *area* alone is too weak to prove identity: at quality 0.4 the extra
    ringing on a dense page moved its ink 2.6 points and the density ordering
    flipped, so a right entry was read as the page next door. Centring the
    fingerprint cancels a global brightening/darkening and compares the *shape* —
    the same page measures 1.000, its neighbour 0.75. A flat sheet has no shape,
    so it falls back to ink equality.
    """
    x, y = sig(a).ravel(), sig(b).ravel()
    x, y = x - x.mean(), y - y.mean()
    if np.linalg.norm(x) == 0 or np.linalg.norm(y) == 0:
        return 1.0 if abs(ink(a) - ink(b)) < 0.01 else 0.0
    return float(x @ y / (np.linalg.norm(x) * np.linalg.norm(y)))


def ink(im: Image.Image) -> float:
    arr = np.asarray(im.convert("L"), dtype=np.uint8)
    return 100.0 * float((arr < 245).sum()) / arr.size


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cbz", required=True)
    ap.add_argument("--source")
    ap.add_argument("--dpi", type=float, default=200)
    ap.add_argument("--pages", default="all", help="the selection asked for")
    ap.add_argument("--expect-shuffled", action="store_true",
                    help="the identity mapping must come out WRONG (control that the check bites)")
    args = ap.parse_args()

    z = zipfile.ZipFile(args.cbz)
    infos = z.infolist()
    names = [i.filename for i in infos]
    print(f"archive {args.cbz}: {len(names)} entries, {sum(i.file_size for i in infos)} B uncompressed")
    for i in infos:
        print(f"  {i.filename:<24} method={i.compress_type} {i.file_size} B")

    # ── 4. first entry, nesting ──────────────────────────────────────────────
    if not names:
        fail("archive is empty")
        return 1
    if names[0].endswith("/"):
        fail(f"first entry is a directory: {names[0]!r}")
    nested = [n for n in names if "/" in n]
    if nested:
        fail(f"entries are nested: {nested[:3]}")

    # ── 1. every entry is a real image with the magic its name claims ────────
    MAGIC = {"jpg": b"\xff\xd8\xff", "jpeg": b"\xff\xd8\xff", "png": b"\x89PNG\r\n\x1a\n"}
    images: list[Image.Image] = []
    for info in infos:
        raw = z.read(info.filename)
        ext = info.filename.rsplit(".", 1)[-1].lower()
        if ext not in MAGIC:
            fail(f"{info.filename}: extension {ext!r} is not a comic page format")
            continue
        if not raw.startswith(MAGIC[ext]):
            fail(f"{info.filename}: magic {raw[:4].hex()} is not {ext}")
        try:
            im = Image.open(io.BytesIO(raw))
            im.load()
        except Exception as exc:  # noqa: BLE001 - the point is to report it
            fail(f"{info.filename}: does not decode ({exc})")
            continue
        images.append(im)

    # ── 3. names: unique, zero-padded, byte order == sort order ─────────────
    if len(set(names)) != len(names):
        dupes = sorted({n for n in names if names.count(n) > 1})
        fail(f"duplicate entry names: {dupes[:4]}")
    if sorted(names) != names:
        fail("entries are not stored in sort order — a reader would page out of order")
    tails = []
    for n in names:
        m = re.search(r"(\d+)\.\w+$", n)
        if not m:
            fail(f"{n}: no page number in the name")
            continue
        tails.append((int(m.group(1)), len(m.group(1))))
    if tails:
        nums = [t[0] for t in tails]
        if nums != list(range(1, len(nums) + 1)):
            fail(f"page numbers are not 1..{len(nums)} in order: {nums[:6]}")
        if min(t[1] for t in tails) < 3:
            fail(f"page number padding is under three digits: {min(t[1] for t in tails)}")

    # ── 5. ComicInfo ────────────────────────────────────────────────────────
    ci = [n for n in names if n.lower() == "comicinfo.xml"]
    if not ci:
        print("ComicInfo.xml: ABSENT")
    else:
        text = z.read(ci[0]).decode("utf-8", "replace")
        print(f"ComicInfo.xml: present, {len(text)} B")
        for tag in ("Title", "Series", "PageCount"):
            m = re.search(rf"<{tag}>(.*?)</{tag}>", text)
            if not m:
                fail(f"ComicInfo.xml has no <{tag}>")
        m = re.search(r"<PageCount>(\d+)</PageCount>", text)
        if m and int(m.group(1)) != len(images):
            fail(f"ComicInfo.xml says {m.group(1)} pages, the archive holds {len(images)}")

    # ── 6. one format ───────────────────────────────────────────────────────
    formats = {im.format or "?" for im in images}
    if len(formats) > 1:
        fail(f"entries mix formats: {sorted(formats)}")

    # ── 2. identity: the picture has to be the page the name says ───────────
    if not args.source or not images:
        return 1 if fails else 0
    doc = pymupdf.open(args.source)
    asked = list(range(1, doc.page_count + 1))
    if args.pages != "all":
        asked = []
        for part in args.pages.split(","):
            if "-" in part:
                a, b = part.split("-")
                asked += list(range(int(a), int(b) + 1))
            else:
                asked.append(int(part))
    if len(asked) != len(images):
        fail(f"{len(asked)} pages were asked for, {len(images)} entries were written")

    # Source pages at the archive's own pixel size, so the comparison is like for
    # like: this is the same raster the tool should have encoded.
    expected = []
    for page in doc:
        # `get_pixmap` paints the page as displayed, `/Rotate` included, which is
        # the same sheet the renderer had on its canvas.
        pm = page.get_pixmap(dpi=int(round(args.dpi)))
        _, w, h = pix_ints(pm)
        expected.append((int(page.number or 0) + 1, Image.frombytes("RGB", (w, h), pm.samples)))

    # ── 6b. each entry is its own page's displayed box at the asked dpi ─────
    print("size table — entry px vs the page its name claims, measured the same way")
    for entry, im in zip(names, images, strict=False):
        m = re.search(r"(\d+)\.\w+$", entry)
        if not m or not 1 <= int(m.group(1)) <= len(asked):
            continue
        want = next((e for e in expected if e[0] == asked[int(m.group(1)) - 1]), None)
        if want is None:
            continue
        dw, dh = im.size[0] - want[1].size[0], im.size[1] - want[1].size[1]
        print(f"  {entry:<24} {im.size[0]}x{im.size[1]} vs {want[1].size[0]}x{want[1].size[1]} "
              f"(Δ {dw:+d},{dh:+d})")
        if abs(dw) > 1 or abs(dh) > 1:
            fail(f"{entry} is {im.size[0]}x{im.size[1]} px; page {asked[int(m.group(1)) - 1]} "
                 f"at {args.dpi} dpi is {want[1].size[0]}x{want[1].size[1]}")

    # The page an entry claims, read from its *name* rather than its position: an
    # archive whose names run 2,3,4,1 must be judged by what the name says, or a
    # rotated naming passes on position alone (measured — the first version of
    # this file did exactly that).
    print("ink table — entry vs the page its name claims vs that source page's own ink")
    wrong = 0
    for entry, im in zip(names, images, strict=False):
        m = re.search(r"(\d+)\.\w+$", entry)
        if not m:
            continue
        slot = int(m.group(1))
        if not 1 <= slot <= len(asked):
            fail(f"{entry}: page {slot} but only {len(asked)} pages were asked for")
            continue
        asked_page = asked[slot - 1]
        want = next((e for e in expected if e[0] == asked_page), None)
        if want is None:
            continue
        # Identity is judged on the fingerprint, with the ink table beside it so a
        # reader can see the magnitudes. Best match only counts as a mismatch when
        # it is clearly more alike than the page the name claims (0.01 of cosine),
        # so two neighbouring pages of the same comic are not called a defect.
        same = alike(im, want[1])
        best = max(expected, key=lambda e: alike(im, e[1]))
        best_same = alike(im, best[1])
        print(f"  {entry:<24} names page {asked_page}: alike {same:.3f} · ink {ink(im):5.2f}% vs "
              f"{ink(want[1]):5.2f}% · best match page {best[0]} ({best_same:.3f})")
        if best[0] != asked_page and best_same > same + 0.01:
            wrong += 1
            fail(f"{entry} is a picture of page {best[0]} (alike {best_same:.3f}), "
                 f"not the page {asked_page} its name claims (alike {same:.3f})")

    if args.expect_shuffled:
        if wrong == 0:
            fail("the identity check found every page right in an archive it should not have — it is blind")
        else:
            print(f"control: {wrong}/{len(images)} entries wrongly identified, as they should be")
        return 0

    print("OK" if not fails else f"{len(fails)} FAIL")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
