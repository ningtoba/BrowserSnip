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

## Recorded, not fixed (this seam is the join)

- **In-cell `<br>` fractures a table row.** `cells.pdf` row 5 is
  `Line one<br>Line two | newline cell | 4`; the app emits **three** grid rows —
  `["Line one","",""]`, `["","newline cell","4"]`, `["Line two","",""]`. The
  decision is made by which physical rows share a table row band
  (`clusterRows` / `gridRows`), not by the junction between two runs, so it is
  out of the join's reach. With `LINE_STEP_EM` the *cell* now at least reads
  correctly whenever a caller hands it several rows, which is what a ruled
  `gridFromRules` cell does; the whitespace-grid path still groups per visual line.
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
