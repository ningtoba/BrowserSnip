#!/usr/bin/env python3
"""Judge what `add-page-labels` wrote, in the file and by two readers that did not write it.

The tool's whole product is a `/PageLabels` number tree, and its own message is produced
by the same module that wrote the tree — so the reader under test cannot judge itself.
Each produced file is asked three questions instead:

  store    the catalogue's `/PageLabels` read off the bytes with libqpdf (pikepdf):
           every `/Nums` pair, its `/Start`, `/S`, `/St`, `/P`
  mupdf    `page.get_label()` for every sheet (MuPDF 1.28.2)
  pypdf    `PdfReader.page_labels` (pypdf 6.14.2)

and, where the tool claims to leave the rest of the document alone, `/Info`, annots,
links and the outline are counted on both sides.

    python3 docs/research/page-labels-round.py --src IN.pdf --out OUT.pdf \\
        --expect 'i,ii,1,2' --furniture
    python3 docs/research/page-labels-round.py --src IN.pdf --out OUT.pdf --stable

`--expect` is the label every sheet must read under **both** readers (comma separated;
`-` is one empty label). `--stable` compares the output's store and labels against the
source's instead — the round-trip case, where the same numbering has to survive being
read back and written again. The exit status is 1 when any row fails.
"""
import argparse
import json
import logging
import sys
from typing import Any

import pikepdf
import pymupdf
import pypdf

LOG = []
for _name in ("pypdf", "pypdf._page_labels"):
    _l = logging.getLogger(_name)
    _h = logging.Handler()
    _h.emit = lambda record: LOG.append(record.getMessage())  # type: ignore[method-assign]
    _l.addHandler(_h)
    _l.setLevel(logging.WARNING)


def store(path: str) -> Any:
    with pikepdf.open(path) as pdf:
        tree = pdf.Root.get("/PageLabels")
        if tree is None:
            return "absent"
        nums = tree.get("/Nums")
        if nums is None:
            return f"kids={len(tree.get('/Kids', []))}"
        flat = list(nums)
        return [
            {
                "start": int(flat[i]),
                "s": str(flat[i + 1].get("/S")) if flat[i + 1].get("/S") is not None else None,
                "st": int(flat[i + 1].get("/St")) if flat[i + 1].get("/St") is not None else None,
                "p": str(flat[i + 1].get("/P")) if flat[i + 1].get("/P") is not None else None,
            }
            for i in range(0, len(flat), 2)
        ]


def mupdf_labels(path: str) -> list[str]:
    """MuPDF's answer per sheet; `<IndexError>` where its binding refuses.

    MuPDF 1.28.2 raises for a sheet that comes *before* the first range, and one such
    sheet makes every sheet after it raise as well — so the refusal is recorded per
    page rather than allowed to abort the whole row.
    """
    out: list[str] = []
    with pymupdf.open(path) as doc:
        for page in doc:
            try:
                out.append(page.get_label())
            except Exception as error:  # noqa: BLE001 - the refusal is the measurement
                out.append(f"<{type(error).__name__}>")
    return out


def pypdf_labels(path: str) -> list[str]:
    try:
        return list(pypdf.PdfReader(path).page_labels)
    except Exception as error:  # noqa: BLE001
        return [f"<{type(error).__name__}>"]


def furniture(path: str) -> dict[str, Any]:
    with pymupdf.open(path) as doc:
        return {
            "info": {k: v for k, v in doc.metadata.items() if v},
            "annots": sum(len(list(page.annots() or [])) for page in doc),
            "links": sum(len(page.get_links() or []) for page in doc),
            "outline": [entry[1] for entry in doc.get_toc()],
        }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--expect", default="")
    ap.add_argument("--stable", action="store_true")
    ap.add_argument("--furniture", action="store_true")
    args = ap.parse_args()

    rows: list[tuple[str, bool, str]] = []
    src_store, out_store = store(args.src), store(args.out)
    src_mu, out_mu = mupdf_labels(args.src), mupdf_labels(args.out)
    src_py, out_py = pypdf_labels(args.src), pypdf_labels(args.out)

    print(f"src store: {json.dumps(src_store)}")
    print(f"out store: {json.dumps(out_store)}")
    print(f"src mupdf: {src_mu}")
    print(f"src pypdf: {src_py}")
    print(f"out mupdf: {out_mu}")
    print(f"out pypdf: {out_py}")

    if args.expect:
        want = ["" if part == "-" else part for part in args.expect.split(",")]
        rows.append(("mupdf matches asked", out_mu == want, f"{out_mu} vs {want}"))
        rows.append(("pypdf matches asked", out_py == want, f"{out_py} vs {want}"))
    if args.stable:
        rows.append(("store survives the round trip", out_store == src_store, f"{out_store} vs {src_store}"))
        rows.append(("mupdf survives the round trip", out_mu == src_mu, f"{out_mu} vs {src_mu}"))
        rows.append(("pypdf survives the round trip", out_py == src_py, f"{out_py} vs {src_py}"))
    if args.furniture:
        before, after = furniture(args.src), furniture(args.out)
        print(f"src furniture: {json.dumps(before)}")
        print(f"out furniture: {json.dumps(after)}")
        rows.append(("info kept", before["info"] == after["info"], f"{after['info']} vs {before['info']}"))
        rows.append(("annots kept", before["annots"] == after["annots"], f"{after['annots']} vs {before['annots']}"))
        rows.append(("links kept", before["links"] == after["links"], f"{after['links']} vs {before['links']}"))
        rows.append(("outline kept", before["outline"] == after["outline"], f"{after['outline']} vs {before['outline']}"))

    for name, ok, detail in rows:
        print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}")
    if LOG:
        print("reader complaints:", sorted(set(LOG)))
    return 0 if all(ok for _, ok, _ in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
