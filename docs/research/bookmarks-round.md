# Round 038 — `bookmarks`, measured

Tool: `bookmarks` (`src/lib/pdf/tools/edit.ts:1212`), surface `none`, action
`Save bookmarks`, one textarea and one toggle. Fixtures `/tmp/triage/in/bookmarked.pdf`
(4 sheets: copy, colour squares, **an empty sheet**, a `595×420 /Rotate 90` sheet;
`/Info` title, and an outline of three entries written by pdf-lib as `/A /GoTo`
actions — *Chapter One* → 1, *Section One.A* → 2 as its child, *Chapter Two* → 4,
the first with `/Count -1`) and `/tmp/triage/in/colour.pdf` (the same 4 sheets with
no outline, the control). A dev build on `:5271`.

**Judged by readers that did not write the file**: pypdf 6.14.2 and MuPDF 1.28.2
(PyMuPDF). Every produced entry is followed to the page it *really* resolves to —
through `/Dest`, through an `/A` `/GoTo` `/D` array and through a named destination
in either `/Dests` store — because a bookmark on the wrong sheet reads perfectly.

Harness (committed, all of it):

* `bookmarks-round-rig.test.ts` + `bookmarks-round.vitest.config.ts` — eight cases
  through the shipped `runPdfTool` (the rail's own path: guard, clamps, warnings),
  every produced file dumped beside a JSON of the exact text typed and the exact
  words the card printed. `BOOKMARKS_DIR=… npx vitest run --config
  docs/research/bookmarks-round.vitest.config.ts`
* `bookmarks-round-readers.py` — the verdict. Per entry: title, depth, resolved
  destination page, compared to what the typist meant; then MuPDF's tree against
  pypdf's (`get_toc` with `simple=False`), the page count, `/Info`, annotation and
  link counts and per-sheet ink at 36 dpi against the untouched source. Its own
  control is at the foot: a blank PDF must read as an empty outline.
* `bookmarks-round.mjs` — the screen half in real Chromium: one tab per case,
  every field written as a user event and **read back out of the DOM before the
  click**, the produced file taken through `downloadBlob`'s own object URL, and two
  screenshots per case.

## What was already right, with numbers

* **The typed grammar lands as typed.** Two spaces, one tab and four spaces each
  mean one level deeper: `nesting` comes back `[(1,'Chapter One'),(2,'Section
  One.A'),(1,'Chapter Two'),(2,'Tab Child'),(3,'Four-Space Grandchild'→page 3)]`
  under both readers, 5 of 5 entries, no depth flattened.
* **Non-ASCII and PDF-special titles survive verbatim** — `Report (final)`,
  `Back\slash`, `Café ☕`, `Русский` read back byte-identical under pypdf *and*
  MuPDF. MuPDF's `get_toc` decodes a `<FEFF…>` title (the `/P` trap the labels row
  hit does not reach `/Title`), so the writer's UTF-16BE string is not a defect.
* **Replace vs append is obeyed and counted.** Replace (the default) rewrites the
  tree and says *"replacing the 3 bookmarks already in the document"*; append keeps
  all three source entries **with their titles, depths and targets** (1, 2, 4) and
  their `/A /GoTo` actions are normalised to `/Dest` that both readers still
  resolve.
* **`/Info`, annotations, links, page count and per-sheet ink are untouched** in
  all eight cases (`[19048, 12737, 0, 36082]` on all four sheets, before and after;
  title and creator identical).
* **The edges are answered honestly.** Page 9 on a four-page file → a targetless
  entry plus *"1 entry named a page outside this 4-page document, so it opens
  nothing when clicked"*; an empty title → skipped and counted; 40 entries → 40
  entries at the depth typed; an empty box → the current outline as a report, no
  file, which is the card's promise.
* **A destination is written for every entry that has one and omitted otherwise**
  (`/Dest` arrays with `/Fit`), which is what both readers follow.

## What was wrong — 3 FAIL / 298 assertions in the bytes

**1. A title containing the page separator was truncated at the first `::`.**
`textToOutline` did `line.split('::')` and took `[title, page]`. So the line
`A :: B :: 3` was written as the entry **`A`, page lost**, the rest of the title
gone, and the only trace was a warning blaming `B`: *"`B` is not a page number, so
`A` was written without a link."* Measured in the engine rig and again in the real
tab (`docs/research/bookmarks-round-before-browser.log`, card sentence above).
Nothing in the card says a title may not contain `::`.

**2. A fractional page threw the whole run.** `Half :: 2.5` failed with
`Bookmark "Half" points at page 2.5, but this document has 4 pages.` — a sentence
that names the page count as though *it* were the problem — and saved nothing — one of the three FAILs is the refusal itself, counted as a
failure so a case that never reaches the bytes cannot pass silently.

**Copy that disagreed with the count beside it** (both visible in the browser, same
rounds): append said *"Added 1 bookmark after the 3 existings outline."*, and over
a file with no outline *"after the 0 existings outline."*; the skip note said
*"2 lines had no title and was skipped."*

**The pane clipped its own content**: the only field is a textarea opened four rows
high, so a 40-entry outline was cut through the middle of the fifth line's glyphs
(`docs/research/shots/bookmarks-round-before-typed.png`) with the rest behind a
scrollbar.

## The fix

* `splitPageSuffix` (edit.ts) — the separator is the **last** `::`, and only when
  what follows it is a page number or nothing. A line whose tail is not a number is
  a title; when the tail looks like an attempted number (`pp4`) the card says so
  and keeps the title whole. A trailing `::` is a suffix, not part of the title.
* A fractional page is rounded **before** the write, and the card names both
  numbers: *"`2.5` is not a whole page number, so page 3 was used."*
* The append sentence says what it appended after — *"after the 3 bookmarks
  already in the document"* / *"after an empty outline"* — and the skip note agrees
  with itself: *"1 line … was skipped"* / *"2 lines … were skipped"*.
* The help now names the tab as an indent and says the last `::` is the page.
* A **standing note** says what an append does to collapsed state, because the
  outline model has none: measured on the fixture, `Chapter One` arrives `/Count
  -1` (closed) and leaves `/Count 1` (open).
* `ToolField.rows` (shared field contract, three lines) and `rows: 12` on this one
  field: a textarea sized for what it holds, four rows still the default
  (`tests/pdf/bookmarks-field-rows.test.ts`, control included).

## After

* Engine rig: **0 FAIL / 320 assertions** (`bookmarks-round-after.log`), the same
  eight cases that gave the 3 FAIL above;
  `A :: B :: 3` → title `A :: B`, page 3, no warning.
* Real tab: the same file from a real click
  (`docs/research/bookmarks-round-after-browser.log`), 61 assertions, **0 FAIL**;
  append reads *"Added 1 bookmark after the 3 bookmarks already in the document."*
  with the three source entries intact at 1, 2 and 4.
* The pane now opens twelve rows and shows the tenth entry
  (`docs/research/shots/bookmarks-round-after-typed.png`, dark tokens only, paper
  preview white).
* Red without the fix: **5 failed / 74 passed** (`tests/pdf/edge-edit.test.ts`) —
  the `::` title, the non-numeric tail, the fractional page, the append sentence
  and the skip agreement; plus **1 failed / 1 passed** for the rows pin. 0 failed
  with it. Full suite 3253 passed / 1 skipped, `tsc -b` 0, `typecheck:tests` 0,
  `npx vite build` 0.

## Left open, measured

* **Collapsed state is not carried** on an append (see above); it is now a note,
  not a fix. Doing it properly means an `open` flag on `OutlineNode`, in the reader
  and in `buildLevel` — the row records it rather than smuggling it in.
* **A targetless title that contains `::` and a digit in its tail** (`Notes :: 4
  revised`) is read as a title with a warning; the whole line is still kept, so
  nothing is lost, but the warning is noise.
* **A title cannot contain a newline** — a line is an entry. Both readers show a
  tab in a title, which the writer preserves.
* An outline entry whose destination is a named destination is rewritten as a
  direct `/Dest` array, which is what MuPDF and pypdf both prefer; the named
  destination object itself is not dropped from `/Dests`.
* The card's `description` still says "import and export" where the import is a
  paste and the export is a report.
