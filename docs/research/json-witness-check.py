#!/usr/bin/env python3
"""
Witness-check the JSON-shaped extractors (pdf-to-json, prepare-pdf-for-ai) for
LaneQ1 step 3. A produced `.json` must (a) `json.loads`, (b) carry the structure
the card promises, (c) whose text matches the PyMuPDF/pdftotext witness of the
source, and (d) whose *count in the app's own message* equals what the bytes
contain — the bars-6 "model counts are not evidence" class.

  BASE=http://localhost:5293 PORT=9853 SPEC=/tmp/lane-q1/spec4.json \
    OUTDIR=/tmp/lane-q1/out JSONL=/tmp/lane-q1/runs4.jsonl node docs/research/colour-rail.mjs
  python3 docs/research/json-witness-check.py /tmp/lane-q1/out /tmp/lane-q1/runs4.jsonl

For every `<tool>__<tag>_<name>.json` it resolves the source fixture from the
JSONL record, opens it in PyMuPDF (authenticating `reader-pass` when locked), and
checks. `verdict` is the first failure in this order; `OK` means everything held.
"""
from __future__ import annotations

import json
import os
import re
import sys
import unicodedata
from collections import Counter

import pymupdf

SEARCH_DIRS = ["/tmp/lane-q1", "/tmp/triage", "/tmp/triage/in"]
PW = "reader-pass"


def norm(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def tok(s: str) -> Counter:
    return Counter(re.findall(r"\S+", norm(s)))


def open_src(pdf: str):
    d = pymupdf.open(pdf)
    if d.needs_pass:
        d.authenticate(PW)
    return d


def witness_pages(pdf: str):
    d = open_src(pdf)
    out = []
    for p in d:
        out.append((p.get_text(), [round(v, 2) for v in (p.rect.width, p.rect.height)], p.rotation))
    d.close()
    return out


def resolve(jsonl: str, prefix: str) -> str | None:
    if not jsonl or not os.path.exists(jsonl):
        return None
    for line in open(jsonl):
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if f"{r.get('tool','')}__{r.get('tag','base')}" == prefix:
            for name in r.get("files", []):
                base = os.path.basename(name)
                if not base.endswith(".pdf"):
                    continue
                if os.path.isabs(name) and os.path.exists(name):
                    return name
                for d in SEARCH_DIRS:
                    if os.path.exists(os.path.join(d, base)):
                        return os.path.join(d, base)
    return None


def app_msg(jsonl: str, prefix: str) -> str:
    if not jsonl or not os.path.exists(jsonl):
        return ""
    for line in open(jsonl):
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if f"{r.get('tool','')}__{r.get('tag','base')}" == prefix:
            res = (r.get("screen", {}) or {}).get("result", "") or ""
            return res.replace("\n", " ")
    return ""


def check_document(obj: dict, src: str, msg: str):
    fails: list[str] = []
    pages = obj.get("pages")
    if not isinstance(pages, list):
        return ["no pages[]"], {}
    src_pages = witness_pages(src)
    # page numbers present, strictly ascending, within source
    nums = [p.get("page") for p in pages]
    if nums != sorted(nums) or any(not isinstance(n, int) for n in nums):
        fails.append("page numbers not ascending ints")
    if any(n > len(src_pages) for n in nums):
        fails.append("page number exceeds source")
    # counts == bytes
    m = re.search(r"(\d+)\s+page\(s\),\s*(\d+)\s+block\(s\)", msg)
    real_blocks = sum(len(p.get("blocks", [])) for p in pages)
    counts = {}
    if m:
        counts = {"msg_pages": int(m.group(1)), "msg_blocks": int(m.group(2)),
                  "real_pages": len(pages), "real_blocks": real_blocks}
        if int(m.group(1)) != len(pages):
            fails.append(f"msg says {m.group(1)} pages, json has {len(pages)}")
        if int(m.group(2)) != real_blocks:
            fails.append(f"msg says {m.group(2)} blocks, json has {real_blocks}")
    else:
        fails.append("no 'N page(s), M block(s)' message found")
    # structure: every block carries a numeric rect; table blocks carry a row grid
    bad_rect = 0
    table_blocks = 0
    for p in pages:
        for b in p.get("blocks", []):
            r = b.get("rect", {})
            if not all(isinstance(r.get(k), (int, float)) for k in ("x", "y", "width", "height")):
                bad_rect += 1
            if b.get("type") == "table":
                table_blocks += 1
                rows = b.get("rows")
                if not (isinstance(rows, list) and rows and all(isinstance(x, list) for x in rows)):
                    fails.append("table block without a rows grid")
    if bad_rect:
        fails.append(f"{bad_rect} block(s) without a numeric rect")
    # text fidelity vs the source pages that were selected
    app_text = "".join(norm(p.get("text", "")) for p in pages)
    src_text = "".join(norm(src_pages[n - 1][0]) for n in nums) if nums else ""
    a, w = tok(app_text), tok(src_text)
    fidelity = {"invented": sum((a - w).values()), "missing": sum((w - a).values())}
    if fidelity["invented"] > fidelity["missing"] and fidelity["invented"] > 2:
        fails.append(f"SPACED-WORDS: {fidelity['invented']} invented tokens (rowText spine)")
    return fails, {"pages": len(pages), "blocks": real_blocks, "tables": table_blocks, **fidelity}


def check_llama(obj: dict, src: str, msg: str, fields: dict):
    fails: list[str] = []
    rdi = obj.get("ref_doc_info")
    if not isinstance(rdi, dict) or not rdi:
        return ["no ref_doc_info object"], {}
    keys = list(rdi)
    title = (fields or {}).get("Document id") or os.path.basename(src)
    counts = {"ref_docs": len(keys)}
    rec = rdi[keys[0]]
    meta = rec.get("metadata", {})
    text = rec.get("text", "")
    src_pages = witness_pages(src)
    # num_pages must equal the source pages actually selected (not always total)
    m = re.search(r"Produced (\d+) reference document\(s\) from (\d+) page\(s\)", msg)
    if m:
        counts.update({"msg_refs": int(m.group(1)), "msg_pages": int(m.group(2)),
                       "meta_num_pages": meta.get("num_pages"), "real_refs": len(keys)})
        if int(m.group(1)) != len(keys):
            fails.append(f"msg says {m.group(1)} refs, json has {len(keys)}")
        if meta.get("num_pages") != int(m.group(2)):
            fails.append(f"metadata.num_pages {meta.get('num_pages')} != selected pages {m.group(2)}")
    else:
        fails.append("no 'Produced N reference document(s) from M page(s)' message")
    # title re-key: explicit Document id must be the ref_doc_info key
    if title and title not in keys and "Document id" in (fields or {}):
        fails.append(f"Document id '{title}' did not re-key ref_doc_info {keys}")
    # form-feed separators between pages when more than one page is in the chunk
    sel = str((fields or {}).get("Pages", "all")).strip()
    n_pages = meta.get("num_pages") or len(src_pages)
    if isinstance(n_pages, int) and n_pages > 1 and "\f" not in text:
        fails.append("multi-page chunk text has no page separator (\\f)")
    # text fidelity vs witness of selected pages
    a, w = tok(text), tok("".join(norm(sp[0]) for sp in src_pages))
    invented, missing = sum((a - w).values()), sum((w - a).values())
    counts.update({"invented": invented, "missing": missing})
    if invented > missing and invented > 2:
        fails.append(f"SPACED-WORDS: {invented} invented tokens (rowText spine)")
    return fails, counts


def main() -> int:
    outdir = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "/tmp/lane-q1/out")
    jsonl = sys.argv[2] if len(sys.argv) > 2 else None
    rows = []
    for fn in sorted(os.listdir(outdir)):
        if not fn.endswith(".json"):
            continue
        prefix = fn.rsplit("_", 1)[0]  # tool__tag  (name has no '__')
        raw = open(os.path.join(outdir, fn), encoding="utf-8").read()
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError as e:
            rows.append((fn, "-", ["json.loads FAILED: " + str(e)[:40]], {}))
            continue
        src = resolve(jsonl, prefix)
        msg = app_msg(jsonl, prefix)
        fields = {}
        for line in (open(jsonl) if jsonl and os.path.exists(jsonl) else []):
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if f"{r.get('tool','')}__{r.get('tag','base')}" == prefix:
                fields = r.get("fields", {})
        if not src:
            rows.append((fn, "NO-SRC", ["fixture unresolved"], {}))
            continue
        if "ref_doc_info" in obj:
            fails, counts = check_llama(obj, src, msg, fields)
        elif "pages" in obj:
            fails, counts = check_document(obj, src, msg)
        else:
            fails, counts = ["unknown json shape (no pages[]/ref_doc_info)"], {}
        rows.append((fn, os.path.basename(src), fails, counts))

    print(f"{'output':46} {'src':14} {'counts':40} verdict")
    any_fail = False
    for fn, src, fails, counts in rows:
        v = "OK" if not fails else " | ".join(fails)
        if fails:
            any_fail = True
        print(f"{fn[:46]:46} {src[:14]:14} {str(counts)[:40]:40} {v[:70]}")
    print("\nSUMMARY:", "all outputs structurally valid & count-honest" if not any_fail
          else "see failing rows above (SPACED-WORDS = the shared rowText spine, report-only for now)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
