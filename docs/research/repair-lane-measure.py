"""What the `repair` downloads actually hold, page by page.

For each run in a colour-rail JSONL with tool == `repair`: the produced file's
page count, the planted word each sheet carries (`Alpha/Beta/Gamma/Delta`), the
body line, non-white pixels at 100 dpi, `/Annots`, image count, and dangling
`N 0 R` references (the thing `repair` promises to remove). The healthy base is
measured the same way and printed first as the control.
"""
import json
import re
import sys

import numpy as np
import pymupdf

WORDS = ["Alpha", "Beta", "Gamma", "Delta"]
SENTENCE = "Forty-one crates were checked against the ledger by hand."


def facts(path):
    doc = pymupdf.open(path)
    rows = []
    raw = open(path, "rb").read()
    dangling = []
    for match in re.finditer(rb"(?<![0-9])(\d+) 0 R", raw):
        number = int(match.group(1))
        try:
            if number >= doc.xref_length() or doc.xref_object(number, compressed=True) == "null":
                dangling.append(number)
        except Exception:
            dangling.append(number)
    for page in doc:
        pix = page.get_pixmap(dpi=100, colorspace=pymupdf.csRGB, alpha=False)
        arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)
        text = page.get_text()
        rows.append({
            "box": (round(page.rect.width), round(page.rect.height)),
            "rot": page.rotation,
            "ink": int((arr < 245).any(axis=2).sum()),
            "words": [w for w in WORDS if w in text],
            "sentence": SENTENCE.split()[4] in text,
            "annots": len(list(page.annots() or [])),
            "images": len(page.get_images()),
            "chars": len(text),
        })
    return {
        "pages": doc.page_count,
        "bytes": len(raw),
        "dangling": sorted(set(dangling)),
        "rows": rows,
    }


def main(jsonl):
    for line in open(jsonl):
        record = json.loads(line)
        if record.get("tool") != "repair":
            continue
        out = (record.get("outputs") or [{}])[0].get("path")
        if not out:
            print(f"{record['tag']:38} NO OUTPUT  fail={record.get('fail')}")
            continue
        got = facts(out)
        marks = "".join(
            ("A" if "Alpha" in r["words"] else "-")
            + ("B" if "Beta" in r["words"] else "-")
            + ("G" if "Gamma" in r["words"] else "-")
            + ("D" if "Delta" in r["words"] else "-")
            for r in got["rows"]
        )
        print(
            f"{record['tag']:38} pages={got['pages']} bytes={got['bytes']:>6} "
            f"ink={[r['ink'] for r in got['rows']]} words={marks or '(none)'} "
            f"sentence={[int(r['sentence']) for r in got['rows']]} "
            f"annots={[r['annots'] for r in got['rows']]} images={[r['images'] for r in got['rows']]} "
            f"dangling={got['dangling'][:4]}"
        )
        result = ((record.get("screen") or {}).get("result") or "").replace("\n", " | ")
        said = [p for p in result.split(" | ") if "Repair" in p or "page" in p or "blank" in p]
        print(f"    screen: {' ;; '.join(said[:2])[:250]}")


if __name__ == "__main__":
    main(sys.argv[1])
