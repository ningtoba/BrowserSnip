#!/usr/bin/env python3
"""Judge the page-copy numbering table with the readers that did not write the fixture.

`tests/pdf/page-labels-copy.test.ts` runs the shipped copying tools over the foreign
files in `tests/fixtures/readers/` and writes what came back, plus the row it asserted,
into a directory named by `BROWSERSNIP_LABEL_DUMP`:

    BROWSERSNIP_LABEL_DUMP=/tmp/labels \\
      npx vitest run tests/pdf/page-labels-copy.test.ts
    python3 docs/research/page-labels-copy-round-trip.py /tmp/labels \\
      > docs/research/page-labels-copy-table.md

The dump is not trusted to read itself. Every file — the fixture that went in and the
file that came out — is asked the same question by **MuPDF 1.28.2** and **pypdf 6.14.2**:
what does the page numbering say on each sheet (`page.get_label()`,
`PdfReader.page_labels`), and what does the catalogue hold (`/PageLabels`, its `/Nums`
and `/Kids`, read off the bytes with **libqpdf 12.3.2** through pikepdf 10.9.1). Our own
reader is the thing under test, so asking it twice could only ever say "nothing
changed": a numbering the copy dropped and the reader then expanded to `1, 2, 3` reads
as a page number either way. Same reason `readers-round-trip.py` exists — and the two
rows there, `copy-labels` and `merge-labels`, are this table's rows 1 and 9.

Where the two outside readers disagree with each other the row says so instead of this
app picking a winner; the disagreements are listed under the table, and each is a
reader's own limit on a shape the format allows, not a fact about the copy.
"""
import json
import logging
import os
import sys
import tempfile
from typing import Any, TypedDict

import pikepdf
import pymupdf
import pypdf

FIXTURES = "tests/fixtures/readers"


class Collect(logging.Handler):
    """What the outside readers complained about while answering.

    pypdf logs a warning rather than raising for a page label it cannot work out, and
    those lines are evidence: `Could not reliably determine page label for 3` is pypdf
    admitting it does not carry a `/Kids` range past its first page, which is a fact
    about the reader that the table has to show rather than hide in a terminal.
    """

    def __init__(self) -> None:
        super().__init__()
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(record.getMessage())


READER_LOGS = Collect()
for _name in ("pypdf", "pypdf._page_labels", "mupdf", "pymupdf"):
    _logger = logging.getLogger(_name)
    _logger.addHandler(READER_LOGS)
    _logger.setLevel(logging.WARNING)


class Row(TypedDict):
    id: str
    tool: str
    values: dict[str, object]
    inputs: list[str]
    before: list[str]
    after: list[str]
    why: str


def store_shape(path: str) -> str:
    """What the file's own catalogue says about its numbering — not a reader's view."""
    with pikepdf.open(path) as pdf:
        tree: Any = pdf.Root.get("/PageLabels")
        if tree is None:
            return "absent"
        # A dictionary pikepdf read straight off the catalogue is already the
        # object; a reference has to be followed to get there.
        obj = tree if isinstance(tree, pikepdf.Dictionary) else tree.get_object()
        parts = []
        if "/Nums" in obj:
            parts.append(f"/Nums x{len(obj['/Nums']) // 2}")
        if "/Kids" in obj:
            parts.append(f"/Kids x{len(obj['/Kids'])}")
        return "; ".join(parts) if parts else "present, neither /Nums nor /Kids"


def per_page(path: str) -> tuple[list[str], list[str]]:
    """The numbering of every sheet, as each of the two outside readers reports it.

    MuPDF's Python binding raises `IndexError` for a sheet that precedes the first
    range — it indexes the range list without checking. No row here produces that
    shape (a copy does not create a leading gap), but it is reported rather than
    hidden, because the alternative is a table that cannot tell a blank from a crash.
    """
    with pymupdf.open(path) as doc:
        try:
            mupdf = [page.get_label() for page in doc]
        except IndexError:
            mupdf = ["ERR IndexError"] * doc.page_count
    try:
        labels = pypdf.PdfReader(path).page_labels
        strings = [str(label) for label in labels]
    except Exception as error:  # noqa: BLE001
        strings = [f"ERR {type(error).__name__}"]
    return mupdf, strings


def read_case(dump: str, name: str) -> Row:
    with open(os.path.join(dump, f"{name}.json"), encoding="utf-8") as handle:
        return json.load(handle)  # type: ignore[no-any-return]


def input_path(dump: str, name: str) -> str:
    """A fixture on disk, or the file an earlier row of this table produced."""
    return os.path.join(FIXTURES, name) if name.endswith(".pdf") else os.path.join(dump, f"{name}.pdf")


def verdict(got: list[str], wanted: list[str]) -> str:
    """Where this reader's per-sheet answer differs from the row that was asserted."""
    if got == wanted:
        return "yes"
    if len(got) != len(wanted):
        return f"different sheet count: {len(got)} not {len(wanted)}"
    diff = [
        f"sheet {index + 1}: {value!r} not {wanted[index]!r}"
        for index, value in enumerate(got)
        if value != wanted[index]
    ]
    return "; ".join(diff)


def main() -> None:
    dump = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "labels")
    if not os.path.isdir(dump):
        raise SystemExit(f"no dump in {dump} — run the test with BROWSERSNIP_LABEL_DUMP set")
    names = sorted(entry[: -len(".json")] for entry in os.listdir(dump) if entry.endswith(".json"))
    if not names:
        raise SystemExit(f"no rows in {dump}")
    cases = {name: read_case(dump, name) for name in names}

    print("# Page numbering across the page copy, judged by readers that did not write it\n")
    print("Inputs are in `tests/fixtures/readers/`, written by MuPDF 1.28.2 / libqpdf")
    print("12.3.2 / pypdf 6.14.2 by `scripts/readers-foreign-fixtures.py`; outputs are the")
    print("shipped `runPdfTool` over those bytes. `this app asserted` is the column")
    print("`tests/pdf/page-labels-copy.test.ts` fails on, so the two outside columns are")
    print("an independent answer to the same question, sheet by sheet.\n")
    print("| row | the copy | this app asserted | MuPDF 1.28.2 | pypdf 6.14.2 | the file's own store |")
    print("| --- | --- | --- | --- | --- | --- |")
    for name in names:
        case = cases[name]
        before_mupdf: list[str] = []
        before_pypdf: list[str] = []
        shapes = []
        for item in case["inputs"]:
            path = input_path(dump, item)
            mupdf_here, pypdf_here = per_page(path)
            before_mupdf += mupdf_here
            before_pypdf += pypdf_here
            shapes.append(store_shape(path))
        produced = os.path.join(dump, f"{name}.pdf")
        after_mupdf, after_pypdf = per_page(produced)
        copy = f"`{case['tool']}` " + " ".join(
            f"{key}={json.dumps(value)}" for key, value in case["values"].items()
        )
        print(
            f"| `{name}` | {copy} on {' + '.join('`' + i + '`' for i in case['inputs'])} "
            f"| {case['after']} "
            f"| in {before_mupdf} → out {after_mupdf}; **{verdict(after_mupdf, case['after'])}** "
            f"| in {before_pypdf} → out {after_pypdf}; **{verdict(after_pypdf, case['after'])}** "
            f"| `{' + '.join(shapes)}` → `{store_shape(produced)}` |"
        )

    print("\n## What the readers complained about, verbatim\n")
    print("pypdf logs these instead of raising, so they belong with the table.\n")
    print("```")
    for line, count in sorted(
        {text: READER_LOGS.lines.count(text) for text in set(READER_LOGS.lines)}.items()
    ):
        print(f"{count:>3} × {line}")
    print("```\n")

    print("\n## Every row, and what it is the evidence for\n")
    for name in names:
        print(f"- **`{name}`** — {cases[name]['why']}")

    print("\n## The disagreements, named instead of adjudicated\n")
    print(
        "- **MuPDF escapes a non-ASCII `/P` prefix instead of printing it.** "
        "`copy-subset-prefix`'s sheet 1 is `§II` here and under pypdf, and `<A7>II` under "
        "MuPDF — and the *input* reads `<A7>I`, `§I` under pypdf. Same escaping on both "
        "sides of the copy, so nothing moved: what the verdict column flags is MuPDF's "
        "rendering of byte `A7`, not a different label. This is why the prefix is written "
        "single-byte where PDFDocEncoding can spell it (see `prefixString` in "
        "`core/bookmarks.ts`): MuPDF's page-label reader copies the string's bytes into the "
        "label without looking for the UTF-16BE BOM, so the BOM spelling comes back as "
        "`<FEFF00A7>`."
    )
    print(
        "- **A range with `/P` and no `/S` carries no number.** §12.4.2 Table 160 makes "
        "/S optional, and `copy-prefix-only` measures it: both readers say `Cover ` on "
        "both sides, which is the shape `add-page-labels` itself writes for its `none` "
        "style. A copy that appended a number to those sheets would be adding content the "
        "file does not hold."
    )
    print(
        "- **A style the format does not define.** `labels-nums-unknown-style.pdf` names "
        "`/S /G` with `/St 2`. MuPDF shows no label at all, pypdf counts from 1 and ignores "
        "`/St`, this app counts from `/St` in decimal — three answers, each the same before "
        "and after the copy. The copy writes the `/G` back verbatim, because a copy that "
        "rewrote it would be settling that argument."
    )
    print(
        "- **`absent` and `''` are the same fact seen from two sides.** For "
        "`labels-absent.pdf` MuPDF answers `''` for every sheet, which is its way of "
        "saying \"this sheet has no label\"; pypdf and this app print the position, "
        "`1, 2, 3, 4`. Both columns are unchanged by the copy, and the store column says "
        "`absent → absent`: no dictionary was written for a file that had none."
    )
    print(
        "- **A `/Kids` range past its own first page.** pypdf stops each range at its "
        "`/Start`, which is why the `before` column of the two `/Kids` fixtures reads "
        "`i, ii, I, 4, c, xA` there and `i, ii, I, II, c, xA` under MuPDF. Every *output* "
        "of this table is a flat `/Nums` tree, where all three agree — so the disagreement "
        "is confined to the before columns, and the after columns are the ones that say "
        "what the copy did."
    )
    print(
        "- **MuPDF's binding cannot number a sheet before the first range** (it raises "
        "`IndexError`), and pypdf invents one: measured on a scratch file whose only range "
        "starts at page 3, MuPDF raised and pypdf answered `['cmxcix', '', 'i', '21']`. That "
        "is why no fixture here has that shape — an outside reader cannot adjudicate it, so "
        "it could not carry a row of this table."
    )


if __name__ == "__main__":
    main()
