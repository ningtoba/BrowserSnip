# The run join (seam 2C, defect 1) — measurement, decision, before/after

**Where:** `src/lib/pdf/core/convert.ts::rowText` and the two cell builders in
`src/lib/pdf/core/tables.ts` (`gridRow`, `gridFromRules`) all answer a run
junction with `joinRuns` — one space when the page left a word-sized gap, silence
when it did not.

**Why it was wrong:** pdf.js `getTextContent()` starts a new run at every font
change, every positioned (kerned) pair and every ligature glyph. The spine joined
those runs with `' '`, so a word the *extractor* split became several words the
*user* saw. Every fixture the family had been verified with was written by MuPDF
or pdf-lib, which hand over a whole line in one run — the defect could not show.

## The numbers behind the threshold

`docs/research/rowjoin-gaps.py` labels each intra-row junction with PyMuPDF's
glyph layout (the two glyphs facing the junction, found by position — independent
of how either side groups lines) and scores the rule. Captured run:
`docs/research/rowjoin-gaps.log`. Dumps come from
`docs/research/rowjoin-spine-probe.mts`, which runs the real spine
(pdf.js → `toExtractedItems` → `clusterRows` → `rowText`) in plain node.

762 labelled junctions in 61 text-bearing PDFs:

| witness class | n | run gap / glyph size |
| --- | --- | --- |
| inside a word | 89 | −0.000 … 0.012 em |
| word boundary, a gap | 670 | 0.214 … 56.2 em |
| word boundary, overlapping runs | 3 | −0.72 em (×2), −24.7 em |

`WORD_GAP_EM = 0.1` scores 760/762 (99.7 %); 0.02, 0.05, 0.15 and 0.20 score
**identically**, 0.30 drops to 93.7 %. The two misses are a `©` glyph whose own
advance box already covers the space after it, so no box-gap rule can see them
(both are the same LaTeX `c\copyright` line, twice in the corpus).

`OBJECT_OVERLAP_EM = 0.5` (a run reaching back more than half an em is *another
object on the line*, not the tail of this word) is what keeps two regressions out
of the join: an optional-content layer drawn over body text
(`layers.pdf`: "…retained Quarterly" + "Text on the hidden layer" at 24.7 em of
overlap) and LaTeX's `c\copyright` line (0.72 em). Without that clause both came
out glued ("QuarterlyText").

`LINE_STEP_EM = 0.4` is the vertical clause: a step past it is another line. No
junction *inside* a visual row in the corpus steps more than 0.02 em (978
junctions measured), so the clause only ever fires for `gridFromRules`, which
hands one cell the runs of several physical rows — a wrapped cell stays
"Line one Line two", never "Line oneLine two".

## Before → after (real spine output, both witnesses agreeing)

| fixture | card reported | source has | after |
| --- | --- | --- | --- |
| `lig.pdf` (Chromium, all-ligature sentence) | 38 words | 16 | 16, verbatim |
| `head.pdf` (Chromium, headings + bullets + table) | 42 words | 37 | 37, `reflow`/`finding` whole |
| `uni-html.pdf` (Chromium, CJK/emoji/bidi) | 160 words | 134 | 134, `世界` and `😀🎉🚀` unsplit |
| `colour.pdf` (pdf-lib, one run per line) — parity control | 262 words | 262 | 262, byte-identical text |
| `cells.pdf` (Chromium table) cell 4 | `Ünïcødé 世 界 naïve` | `Ünïcødé 世界 naïve` | fixed |

Whole corpus: 28 148 → 28 110 words (−38 false spaces), 7 of 49 files changed at
all, 11 lines total, every one of them checked against `get_text` **and**
`pdftotext -raw` (see the log; the two `©` lines keep one lost space each).

## The `<br>` / wrapped-cell clause: measured, then implemented

**Symptom.** `cells.pdf` row 5 is `Line one<br>Line two | newline cell | 4`; the
whitespace grid emitted **three** rows for it —
`["Line one","",""] / ["","newline cell","4"] / ["Line two","",""]` — so a
four-row table printed as seven lines with holes in them.

**Measurement** (`docs/research/rowjoin-table-probe.mts` dumps the physical rows
behind every detected table; `rowjoin-br-check.py` scores the candidate clause;
`rowjoin-br.log` holds the run). Of **217** consecutive row pairs inside the 55
tables found across the bar fixtures and the 49-PDF corpus:

| relation between the next row's top and this row's bottom | pairs | what it is |
| --- | --- | --- |
| overlap (`gap < 0`) | **2** | both in `cells.pdf`: the lines of the `<br>` cell (141.00–150.75, 147.00–156.75, 152.25–162.00) |
| tight but separated (`0 ≤ gap < 0.5 × height`) | 94 | spreadsheet exports (6.88 pt lines 1.93 pt apart) — every one a real row |
| normal spacing | 121 | real rows |

So overlap is the discriminator: it fires on exactly the two pairs that are one
logical row and on none of the 194 that are not. `logicalRows()` (exported from
`core/tables.ts`, used by `gridRows`) folds it; `joinRuns`' `LINE_STEP_EM` clause
then writes a space where the cell had its line break. Ruled mode already folded
the same way — it buckets rows by their band — so the two modes now agree.

**Result, against the witness.** PyMuPDF `find_tables` reads that table as 5 rows
whose last cell is `Line one\nLine two`; the app now produces the same 5 rows and
`Line one Line two` in that cell (a space, not a newline, because the cell goes
into CSV, where a raw newline would have to be quoted). Row count, grid shape and
every other table in the corpus: 1 change in 55.

**Red without the fold:** 2 tests (`tables.test.ts` "builds the row the author
wrote, not three" and the `pdf-to-csv` pin in `edge-convert-from.test.ts`).

## Recorded, not fixed (this seam is the join)

- **The fold is scoped to the grid, not to prose.** `logicalRows` runs inside
  `gridRows` only; `clusterRows` — which paragraph blocking, column detection and
  the whole `rowText` path share — still returns every visual line. A two-column
  page (`uni-html.pdf`: `LEFT col A1 … RIGHT col B1 …`) keeps its two boxes on one
  line instead of collapsing them into one row.
- **Bidi order and presentation forms** (`uni-html.pdf`): the Arabic line comes
  back as `رﺎﺒﺘﺧا اﺬﻫ ﻢﻟﺎﻌﻟﺎﺑ ﺎﺒﺣﺮﻣ` — joined into words now
  instead of `ر ﺎ ﺒ ﺘ ﺧ ا …`, but still visual order with presentation
  forms, while MuPDF gives `اختبار هذا بالعالم مرحبا`. Separate seam.
- Two more `.str` joins exist outside the seam and are harmless as written:
  `tools/convert-from.ts:1344` (a readable-character *count*) and
  `tools/security.ts:1075,1112,2431` (page-vs-page *equality*).

## Pins

- `tests/pdf/convert.test.ts` — the junction table (ligature, kern 0.01–0.4 em,
  dropped space-run, sub-threshold gap, object overlap, raised span, unmeasurable
  run).
- `tests/pdf/tables.test.ts` — the same rule inside `gridRow`/`gridFromRules`
  cells, including the wrapped-cell break clause.
- `tests/pdf/edge-convert-from.test.ts` + `tests/fixtures/rowjoin/` — the four bar
  PDFs and `cells.pdf` through the real tool runner: word count in the card
  message, verbatim sentence, `世界` in the JSON, the cell in the CSV, and the
  262-word parity control that must not move.

Red without the fix: **11 tests** across those three files (175 still green).

## Family goldens re-anchored (step 5) — one before/after table

**Did any existing golden move?** No, and that is measured rather than assumed. Two
independent instruments say so:

1. **Sensitivity inventory** (`docs/research/rowjoin-goldens.log`): every fixture the
   convert-from / office families build in-suite or vendor on disk (41 files + 3 rebuilt
   suite shapes) was run through the real spine and counted for the junctions the gap rule
   can act on. The pre-existing fixtures present **14 junctions in total** — `tablePdf(5)` 10,
   the header-once `rev.pdf` 4 — and all 14 are inter-*column* boundaries drawn 160 pt apart,
   i.e. ~12 em against a 0.1 em threshold, where the new rule emits a space exactly where the
   old unconditional space already sat. `foldableRowPairs` is 0 everywhere except the vendored
   browser table (2, the `<br>` row).
2. **Old-spine full-suite run**: with `be2e383`'s `core/convert.ts` + `core/tables.ts` checked
   out and the new pins in the tree, `npx vitest run` fails **20 tests and passes 3866** — every
   failure is one of the new pins, none is a pre-existing golden.

So the re-anchor is *additive*: the family's assertions were written against MuPDF- and
pdf-lib-written pages, which hand over one run per line, and this is the first time any of
them has been pinned against a browser-written page. The table below is what each tool's
golden says on the old vs the new spine.

| tool (suite: `tests/pdf/edge-convert-from.test.ts`) | fixture | golden before the spine change | golden after | status |
| --- | --- | --- | --- | --- |
| pdf-to-text | `lig.pdf` | *none existed* — card counted **38 words** on a 16-word page | `Extracted 16 words from 1 page(s).`, sentence verbatim | **new pin** |
| pdf-to-text (layout off) | `head.pdf` | *none* — paragraph flow carried `re fl ow` too | `…to test reflow`, `First finding item` | **new pin** |
| pdf-to-markdown | `head.pdf` | *none* | `reflow` / `finding` whole, `Widget 3 29.97` table row | **new pin** |
| pdf-to-json | `uni-html.pdf` | *none* — `page.text`/`block.text` printed `世 界`, `😀 🎉 🚀` | `世界`, `😀🎉🚀` unsplit, 134-word count | **new pin** |
| prepare-pdf-for-ai | `lig.pdf` | *none* over the chunk text; Q1's pin covered only the metadata gate | LlamaIndex `ref_doc_info[*].text` holds the whole sentence **and** flat `extra` still merges (Q1's gate re-verified in the same assertion) | **new pin + Q1 re-verify** |
| pdf-to-csv | `cells.pdf` | *none* | `Ünïcødé 世界 naïve`; grid is **5 lines**, last row `Line one Line two,newline cell,4` | **new pin** (moved once by the fold: 7 → 5 rows) |
| pdf-to-excel | `cells.pdf` | *none* | workbook cells `B4=Ünïcødé 世界 naïve`, `A5/B5/C5` = the `<br>` row, **no 6th row** | **new pin** |
| extract-tables | `cells.pdf` | *none* | header printed **once**, body **4 rows**, no `\| Line one \|  \|  \|` fragments | **new pin** (moved once by the fold: body 6 → 4) |
| pdf-to-word | `head.pdf` | 3 pins on pdf-lib/MuPDF fixtures only | `word/document.xml` carries `test reflow`, `First finding item` | **new pin** |
| pdf-to-svg `embedImages` | vendored raster fixtures | one pure-builder pin with an injected `image:` callback (blind to the transport) | browser-shaped payload pins + the rail/live proof | **moved with defect 2** |
| colour 262-word parity | `colour.pdf` | *none* | `Extracted 262 words from 8 page(s).` — the control that must not move | **new pin** |
| Q1: prepare-pdf-for-ai flatMetadata | `textPdfCached()` (0 junctions) | passes | passes unchanged (insensitive fixture) | **re-verified** |
| Q1: extract-tables header-once | `rev.pdf` (4 inter-column junctions, `foldableRowPairs=0`) | passes | passes unchanged; grid still 4 rows, header still once | **re-verified** |

Red for the nine new family pins against the pre-fix spine: **9 of 9** (measured by checking
out `be2e383`'s two seam files and running the suite: `9 failed | 91 passed` in
`edge-convert-from.test.ts`).
