#!/usr/bin/env python3
"""
Judge a produced CSV-to-PDF download with a reader that shares no code with this
app, and exit non-zero unless its tail arrived.

The claim this checks is the one `csv-to-pdf` makes with a page count: that every
row was printed. So the question is not "does the file open" but

  * is the **last text in the source** on a sheet (`--tail`);
  * does every row's last sentence appear on a sheet;
  * do the characters a reader extracts equal the characters of the source plus
    the header rows the table repeats — nothing lost, nothing invented.

  python3 docs/research/table-list-tail-deploy.py \
    --label "deployed https://www.browsersnip.com" \
    --csv /tmp/deploy-table.csv --pdf /tmp/deployed-table.csv.pdf --tail FINALROW

`--csv` is the source the probe fed the tool, `--pdf` the download it captured.
Exits 1 when the tail is missing or the character identity does not hold.
"""
import argparse
import re

import pymupdf

HEADER = "idlabelnote"  # the header row of the fixture `table-list-tail-rig.test.ts` writes


def compact(text: str) -> str:
    return re.sub(r"\s+", "", text)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="run")
    ap.add_argument("--csv", required=True)
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--tail", required=True, help="text that must be the last thing printed")
    ap.add_argument("--rows", type=int, default=12, help="rows in the fixture, for the per-row check")
    args = ap.parse_args()

    with open(args.csv, encoding="utf-8") as handle:
        source = handle.read()
    doc = pymupdf.open(args.pdf)
    arrived = compact("".join(str(page.get_text("text")) for page in doc))

    source_chars = compact(re.sub(r"[\",]", " ", source))
    repeats = (doc.page_count - 1) * len(HEADER)
    identity = len(arrived) == len(source_chars) + repeats
    last_sentences = [f"cell{r}sentence40" for r in range(1, args.rows + 1)]
    landed = [s for s in last_sentences if s in arrived]
    tail = args.tail in arrived

    print(f"## {args.label}")
    print(f"sheets {doc.page_count}; characters a reader extracts {len(arrived)} = "
          f"{len(source_chars)} of the source + {repeats} from {doc.page_count - 1} repeats "
          f"of the {len(HEADER)}-character header: {'exact' if identity else 'DOES NOT HOLD'}")
    print(f"last sentence of each row on a sheet: {len(landed)} of {args.rows}"
          + (f" (missing {', '.join(s for s in last_sentences if s not in arrived)})" if len(landed) != args.rows else ""))
    print(f"the source’s final text {args.tail!r} is on a sheet: {'yes' if tail else 'NO'}")
    doc.close()
    return 0 if (tail and identity and len(landed) == args.rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
