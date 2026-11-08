#!/usr/bin/env python3
"""Measure what a produced file actually contains, page by page or pixel by pixel.

  python3 docs/research/rail-measure.py /tmp/probe/out/merge-00-x.pdf [more.pdf …]

Prints, per file: page count, each page's identifying first line (so order is
read, not counted), text length, image count, link count, form fields, and the
non-white pixel coverage of the page rasterised at 100 dpi — ink off the pixels,
never inferred from an object count. Pass --brief for one line per page field
set without the raster, or --no-ink to skip the pixels.

The triage mode answers the same questions for *every* output kind the catalogue
produces, and writes JSON instead of prose:

  python3 docs/research/rail-measure.py --triage /tmp/triage/runs.jsonl \\
      --fixtures /tmp/triage --write /tmp/triage/measured.jsonl

Each input file named by a run is measured the same way as its output, so a claim
is always a comparison — pages in against pages out, the source's ink against the
output's ink — and a control flip is judged by whether the produced file's
*content* digest moved. That digest ignores pdf-lib's timestamp and the xref ID,
so two runs that differ only in when they ran compare equal, and two runs that
should differ and do not are caught.
"""
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import zipfile

import pymupdf
from PIL import Image

DPI = 100
STRIDE = 7
TEXTY = (".txt", ".md", ".csv", ".json", ".html", ".xml", ".htm", ".eml", ".rtf",
         ".fb2", ".svg", ".xhtml", ".tsv")
RASTER = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif", ".avif")
VIDEO = (".mp4", ".webm", ".mov", ".m4v", ".mkv", ".avi", ".mp3", ".wav", ".aac")


def ink(page):
    """Non-white coverage, sampled off the rasterised bitmap."""
    pix = page.get_pixmap(dpi=DPI, colorspace=pymupdf.csRGB)
    buf = pix.samples
    step = pix.n * STRIDE
    sampled = 0
    dark = 0
    for i in range(0, max(len(buf) - (pix.n - 1), 0), step):
        sampled += 1
        if buf[i] < 245 or buf[i + 1] < 245 or buf[i + 2] < 245:
            dark += 1
    return 100.0 * dark / max(sampled, 1)


def describe(path, show_ink=True, full=True):
    if not os.path.exists(path):
        print(f"{path}: MISSING")
        return
    with open(path, "rb") as handle:
        raw = handle.read()
    try:
        doc = pymupdf.open(path)
    except Exception as exc:  # noqa: BLE001
        print(f"{path}: UNOPENABLE {type(exc).__name__}: {exc}")
        return
    meta = doc.metadata or {}
    print(f"== {path}: pages={doc.page_count} bytes={len(raw)} "
          f"encrypted={meta.get('encryption')} needs_pass={doc.needs_pass} toc={len(doc.get_toc())}")
    for index in range(doc.page_count):
        page = doc[index]
        text = str(page.get_text())
        words = [ln for ln in text.strip().splitlines() if ln.strip()]
        first = words[0][:52] if words else "(no text)"
        links = len(page.get_links())
        annots = len(list(page.annots() or []))
        widgets = len(list(page.widgets() or []))
        imgs = len(page.get_images(full=True))
        draws = len(page.get_drawings())
        paint = f"ink={ink(page):5.2f}%" if show_ink else "ink=  skip"
        print(f"  p{index + 1:<3} {paint} chars={len(text):5} "
              f"imgs={imgs:<3} links={links:<2} annots={annots:<2} widgets={widgets:<2} "
              f"draw={draws:<4} | {first}")
        if not full:
            break
    doc.close()


def raster_ink(data: bytes) -> dict:
    """Non-white coverage of an image, off its own decoded pixels."""
    try:
        img = Image.open(io.BytesIO(data))
    except Exception as exc:  # noqa: BLE001
        return {"kind": "image", "error": f"{type(exc).__name__}: {exc}"[:160]}
    frames = getattr(img, "n_frames", 1)
    rgb = img.convert("RGB")
    wide, high = rgb.size
    buf = rgb.tobytes()
    step = 3 * 7
    sampled = dark = 0
    for i in range(0, max(len(buf) - 2, 0), step):
        sampled += 1
        if buf[i] < 245 or buf[i + 1] < 245 or buf[i + 2] < 245:
            dark += 1
    out = {
        "kind": "image",
        "format": (img.format or "").lower(),
        "width": wide,
        "height": high,
        "frames": frames,
        "ink": round(100.0 * dark / max(sampled, 1), 2),
        "samples": sampled,
        "digest": hashlib.sha256(buf).hexdigest()[:16],
    }
    return out


def probe_video(path: str) -> dict:
    """Duration, size and streams, out of the container itself."""
    cmd = [
        "ffprobe", "-v", "error", "-show_entries",
        "format=duration,size,bit_rate:stream=codec_type,codec_name,width,height,r_frame_rate",
        "-of", "json", path,
    ]
    done = subprocess.run(cmd, capture_output=True, text=True)
    try:
        info = json.loads(done.stdout or "{}")
    except json.JSONDecodeError:
        return {"kind": "video", "error": (done.stderr or "ffprobe failed")[:200]}
    streams = info.get("streams", [])
    return {
        "kind": "video",
        "duration": float(info.get("format", {}).get("duration", 0) or 0),
        "bit_rate": int(float(info.get("format", {}).get("bit_rate", 0) or 0)),
        "size": int(float(info.get("format", {}).get("size", 0) or 0)),
        "video": [s for s in streams if s.get("codec_type") == "video"],
        "audio": [s for s in streams if s.get("codec_type") == "audio"],
    }


def zip_report(data: bytes) -> dict:
    """A container is measured by what is inside it, not by its byte count."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except Exception as exc:  # noqa: BLE001
        return {"kind": "zip", "error": f"{type(exc).__name__}: {exc}"[:160]}
    members = []
    digests = []
    for info in sorted(archive.infolist(), key=lambda i: i.filename):
        raw = archive.read(info)
        members.append({"name": info.filename, "bytes": info.file_size, "crc": format(info.CRC, "08x")})
        digests.append(f"{info.filename}:{info.CRC:08x}")
        if info.filename.lower().endswith(RASTER):
            members[-1].update(raster_ink(raw))
    return {
        "kind": "zip",
        "members": len(members),
        "names": [m["name"] for m in members][:24],
        "detail": members[:24],
        "digest": hashlib.sha256("|".join(digests).encode()).hexdigest()[:16],
    }


def pdf_digest(doc) -> tuple[str, list]:
    """A hash of what the document *says*, so a timestamp cannot make two runs differ.

    Content streams, page boxes, rotation, extracted text, and the bytes of every
    embedded image are folded in. The trailer ID, /CreationDate and /ModDate are
    not, because pdf-lib writes a fresh one to every file it saves.
    """
    parts = []
    pages = []
    volatile = re.compile(rb"/(CreationDate|ModDate)\s*\([^)]*\)")
    for index in range(doc.page_count):
        page = doc[index]
        try:
            content = b"".join(doc.xref_stream(x) or b"" for x in page.get_contents())
        except Exception:  # noqa: BLE001
            content = b""
        content = volatile.sub(b"", content)
        text = str(page.get_text())
        images = []
        for item in page.get_images(full=True):
            xref = item[0]
            try:
                images.append(doc.extract_image(xref)["image"])
            except Exception:  # noqa: BLE001
                images.append(b"?")
        annots = len(list(page.annots() or []))
        widgets = len(list(page.widgets() or []))
        box = tuple(round(v, 2) for v in page.rect)
        rot = page.rotation
        words = [ln for ln in text.strip().splitlines() if ln.strip()]
        pages.append({
            "page": index + 1,
            "ink": round(ink(page), 2),
            "chars": len(text),
            "words": len(words),
            "first": (words[0][:52] if words else "(no text)"),
            "imgs": len(images),
            "links": len(page.get_links()),
            "annots": annots,
            "widgets": widgets,
            "draw": len(page.get_drawings()),
            "box": list(box),
            "rotate": rot,
        })
        parts.append(repr([index, sorted(box), rot, len(text), text[:4000], annots, widgets,
                           len(page.get_links()),
                           [hashlib.sha256(im).hexdigest()[:12] for im in images],
                           hashlib.sha256(content).hexdigest()[:16]]))
    meta = doc.metadata or {}
    stable_meta = {k: meta.get(k) for k in ("title", "author", "subject", "keywords", "creator", "producer")}
    # Document-level furniture a control can legitimately change has to be inside the
    # digest, or "the output is identical" is a false accusation: `pdf-to-pdfa`'s
    # PDF/A version field only moves `pdfaid:part` in the XMP packet, and the page
    # content streams are byte-for-byte the same in both runs.
    catalog = doc.pdf_catalog()
    doc_level = {
        "xmp": (doc.get_xml_metadata() or "")[:4000],
        "openAction": doc.xref_get_key(catalog, "OpenAction"),
        "names": doc.xref_get_key(catalog, "Names"),
        "lang": doc.xref_get_key(catalog, "Lang"),
        "markInfo": doc.xref_get_key(catalog, "MarkInfo"),
        "viewerPrefs": doc.xref_get_key(catalog, "ViewerPreferences"),
        "outputIntents": doc.xref_get_key(catalog, "OutputIntents"),
    }
    parts.append(repr(["meta", stable_meta, doc.get_toc(),
                       len(doc.embfile_names()) if hasattr(doc, "embfile_names") else 0,
                       doc_level if not doc.is_encrypted else ["encrypted", doc.needs_pass]]))
    return hashlib.sha256("\n".join(parts).encode("utf-8", "replace")).hexdigest()[:16], pages


def structural_digest(raw: bytes) -> str:
    """A digest for a PDF no reader will open, so a control flip is still comparable.

    Every file pdf-lib writes carries a fresh `/CreationDate`, `/ModDate` and trailer
    `/ID`; stripping those leaves the bytes a no-op run cannot change and an
    `/Encrypt` change — a permission toggle's whole job — always does.
    """
    stripped = re.sub(rb"/(CreationDate|ModDate)\s*\([^)]*\)", b"", raw)
    stripped = re.sub(rb"/ID\s*\[[^\]]*\]", b"", stripped)
    return hashlib.sha256(stripped).hexdigest()[:16]


def measure_any(path: str) -> dict:
    """One record per file, whatever kind of file it is."""
    if not os.path.exists(path):
        return {"path": path, "kind": "missing"}
    with open(path, "rb") as handle:
        raw = handle.read()
    ext = os.path.splitext(path)[1].lower()
    out = {
        "path": os.path.basename(path),
        "bytes": len(raw),
        "sha": hashlib.sha256(raw).hexdigest()[:16],
        "magic": raw[:8].hex(),
    }
    if raw[:5] == b"%PDF-" or ext == ".pdf":
        try:
            doc = pymupdf.open(path)
        except Exception as exc:  # noqa: BLE001
            out.update({"kind": "pdf", "error": f"{type(exc).__name__}: {exc}"[:180],
                        "digest": structural_digest(raw)})
            return out
        if doc.needs_pass or doc.is_encrypted:
            # Unopened and unreadable is not the same as blank: say which it is.
            authenticated = (doc.authenticate("") or doc.authenticate("reader-pass")
                             or doc.authenticate("owner-pass"))
            if not authenticated:
                out.update({"kind": "pdf", "encrypted": True, "needsPass": bool(doc.needs_pass),
                            "digest": structural_digest(raw),
                            "error": "encrypted: no reader without the password was asked"})
                doc.close()
                return out
        try:
            digest, pages = pdf_digest(doc)
        except Exception as exc:  # noqa: BLE001
            out.update({"kind": "pdf", "encrypted": bool(doc.is_encrypted),
                        "error": f"opened but unreadable: {type(exc).__name__}: {exc}"[:180]})
            doc.close()
            return out
        meta = doc.metadata or {}
        out.update({
            "kind": "pdf",
            "pages": doc.page_count,
            "pageDetail": pages,
            "digest": digest,
            "encrypted": bool(doc.is_encrypted),
            "needsPass": bool(doc.needs_pass),
            "toc": len(doc.get_toc()),
            "title": meta.get("title"),
            "author": meta.get("author"),
            "producer": meta.get("producer"),
            "xmpBytes": len(doc.get_xml_metadata() or ""),
            "totalInk": round(sum(p["ink"] for p in pages) / max(len(pages), 1), 2),
            "maxInk": round(max([p["ink"] for p in pages], default=0.0), 2),
            "minInk": round(min([p["ink"] for p in pages], default=0.0), 2),
            "chars": sum(p["chars"] for p in pages),
            "imgs": sum(p["imgs"] for p in pages),
            "annots": sum(p["annots"] for p in pages),
            "widgets": sum(p["widgets"] for p in pages),
            "links": sum(p["links"] for p in pages),
            "draw": sum(p["draw"] for p in pages),
        })
        doc.close()
        return out
    if ext in VIDEO:
        out.update(probe_video(path))
        return out
    if raw[:2] == b"PK" or ext in (".zip", ".cbz", ".docx", ".xlsx", ".pptx", ".epub",
                                   ".odt", ".ods", ".odp", ".xps", ".pages"):
        out.update(zip_report(raw))
        return out
    if ext in RASTER:
        out.update(raster_ink(raw))
        return out
    if ext in TEXTY or raw[:32].lstrip().startswith(b"<") or _looks_text(raw):
        text = raw.decode("utf-8", "replace")
        out.update({
            "kind": "text",
            "chars": len(text),
            "lines": len(text.splitlines()),
            "digest": hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:16],
            "head": text.strip().splitlines()[0][:80] if text.strip() else "",
        })
        return out
    out.update({"kind": "binary", "digest": hashlib.sha256(raw).hexdigest()[:16]})
    return out


def _looks_text(raw: bytes) -> bool:
    head = raw[:512]
    if not head:
        return False
    return sum(1 for b in head if b < 9 or (13 < b < 32) or b > 126) < len(head) * 0.02


def resolve(fixtures: str, name: str) -> str:
    """A run names its input by basename; the fixtures live in two directories."""
    for candidate in (os.path.join(fixtures, name), os.path.join(fixtures, "in", name)):
        if os.path.exists(candidate):
            return candidate
    return ""


def triage(runs_path: str, fixtures: str, write: str) -> int:
    """Measure every run's inputs and outputs, and judge the campaign's questions."""
    with open(runs_path) as handle:
        records = [json.loads(line) for line in handle if line.strip()]
    source_cache: dict[str, dict] = {}
    base_digest: dict[str, str] = {}
    out_lines = []
    for record in records:
        tool = record.get("tool")
        tag = record.get("tag", "base")
        sources = []
        for name in record.get("files", []):
            if name not in source_cache:
                path = resolve(fixtures, name)
                source_cache[name] = measure_any(path) if path else {"kind": "missing", "path": name}
            sources.append(source_cache[name])
        outputs = [measure_any(o["path"]) for o in record.get("outputs", []) if o.get("path")]
        verdict = judge(record, sources, outputs)
        key = f"{tool}|{'|'.join(record.get('files', []))}"
        if tag == "base" and outputs:
            base_digest[key] = "/".join(o.get("digest", o.get("sha", "")) for o in outputs)
        if tag != "base":
            here = "/".join(o.get("digest", o.get("sha", "")) for o in outputs)
            verdict["sameAsBase"] = bool(here) and here == base_digest.get(key)
        merged = {
            "tool": tool,
            "tag": tag,
            "ok": record.get("ok"),
            "fail": record.get("fail"),
            "clicked": record.get("clicked"),
            "fields": record.get("fields"),
            "readback": [r.get("after") for r in record.get("readback", []) if isinstance(r, dict)],
            "report": (record.get("screen") or {}).get("result"),
            "alert": (record.get("screen") or {}).get("alert"),
            "status": (record.get("screen") or {}).get("status"),
            "surfaceText": (record.get("screen") or {}).get("surfaceText"),
            "errors": record.get("errors"),
            "sources": sources,
            "outputs": outputs,
            **verdict,
        }
        out_lines.append(json.dumps(merged))
    with open(write, "w") as handle:
        handle.write("\n".join(out_lines) + "\n")
    print(f"measured {len(out_lines)} run(s) → {write}")
    return 0


def judge(record: dict, sources: list, outputs: list) -> dict:
    """The campaign's questions, answered with numbers rather than booleans."""
    pages_in = sum(s.get("pages", 0) for s in sources)
    # "Ink of the source" means the same measurement however the source is stored:
    # a page of a PDF, the pixels of an image, or an image inside a ZIP (CBZ).
    ink_in = [s.get("maxInk", 0.0) for s in sources if s.get("kind") == "pdf"]
    ink_in += [s.get("ink", 0.0) for s in sources if s.get("kind") == "image"]
    for s in sources:
        if s.get("kind") == "zip":
            ink_in += [m.get("ink", 0.0) for m in s.get("detail", []) if m.get("ink") is not None]
    measured_ink = [o["maxInk"] for o in outputs
                    if o.get("kind") == "pdf" and o.get("maxInk") is not None]
    text_out = sum(o.get("chars", 0) for o in outputs)
    out_bytes = sum(o.get("bytes", 0) for o in outputs)
    claim = record.get("screen") or {}
    report = claim.get("result") or ""
    pages_claim = re.search(r"(\d+)\s*\u2192\s*(\d+)", report)
    # Only a PDF that a reader could open counts as measured: an encrypted output is
    # unmeasured, and calling it "blank" would invent a defect.
    measured = [o for o in outputs if o.get("kind") == "pdf" and o.get("pages") is not None]
    # A tool that paints nothing onto a page that had ink is the defect this
    # campaign keeps finding; a page that was empty in the source stays empty.
    blank = (
        bool(measured)
        and any(v > 1.0 for v in ink_in)
        and all(o.get("maxInk", 0.0) < 0.5 for o in measured)
    )
    return {
        "pagesIn": pages_in,
        "pagesOut": sum(o.get("pages", 0) for o in measured),
        "inkInMax": round(max(ink_in, default=0.0), 2),
        "inkOutMax": round(max(measured_ink), 2) if measured_ink else None,
        "unmeasured": [o.get("error", o.get("kind", "?"))[:90] for o in outputs if o.get("error")],
        "outBytes": out_bytes,
        "outTextChars": text_out,
        "blankWhereSourceHadInk": blank,
        "reportPagesClaim": pages_claim.groups() if pages_claim else None,
    }


if __name__ == "__main__":
    if "--triage" in sys.argv:
        runs = sys.argv[sys.argv.index("--triage") + 1]
        fixtures = sys.argv[sys.argv.index("--fixtures") + 1] if "--fixtures" in sys.argv else os.path.join(tempfile.gettempdir(), "triage")
        write = sys.argv[sys.argv.index("--write") + 1] if "--write" in sys.argv else os.path.join(tempfile.gettempdir(), "triage", "measured.jsonl")
        sys.exit(triage(runs, fixtures, write))
    paths = [a for a in sys.argv[1:] if not a.startswith("--")]
    for one in paths:
        describe(one, show_ink="--no-ink" not in sys.argv, full="--brief" not in sys.argv)
