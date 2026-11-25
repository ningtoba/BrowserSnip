# pdf-to-csv + extract-tables + pdf-to-excel — Step-4 witness audit (sweep/convert2)

Live: colour-rail SPEC over ~35 runs (:5293/9853). Judge: docs/research/table-witness-check.py
(PyMuPDF find_tables grid + RFC-4180 csv.reader round-trip + openpyxl read-back).
Corpus: real chromium-rendered tables (simple-b/n, cells w/ comma/quote/semicolon/unicode/<br>,
twotables, spans) + triage table.pdf/colour.pdf/scanned. Network: 0 off-origin on every run.

## What holds (owned surface verified-good)
- RFC-4180 quoting (core/tables.ts): csv.reader round-trips produced CSV exactly —
  'Gizmo, large' quoted on comma, 'He said "hi"' doubled to ""He said ""hi""""" , 'semi;colon' quoted
  only under semicolon delimiter, UTF-8 BOM present (EF BB BF), CRLF line endings.
- Delimiter switch (comma/semicolon/tab) honoured. Number typing (pdf-to-excel typedRows):
  Val 1..4 and Rev/Cost became ints in the xlsx; 'Gizmo, large'/'semi;colon' stayed text.
- Multi-table counting honest + reaches bytes: twotables -> 'Extracted 2 table(s) totalling 8
  rows'; per-sheet xlsx '2 table(s) across 2 worksheet(s)' (Table 1/Table 2); oneSheet
  '2 table(s) across 1 worksheet(s)' with a blank separator row. extract-tables json/csv/md all
  agree on the grid; md/csv grids match find_tables cell-for-cell where both detect.
- Where the app finds MORE than PyMuPDF: table.pdf app grid = 4 cols [Item,Qty,Price,Total]
  (matches source); find_tables truncates to 3. App is the more correct witness here.
- Honest edges: colour prose -> 'No grid of aligned columns was found on 8 page(s)' + lower
  minRows / PDF-to-Text advice (bar 2/6); scanned -> scan wording + OCR; blank selection -> report.

## FIXED (owned, convert-from.ts) — extract-tables
- DEFECT: toMarkdownTable printed the header row TWICE whenever the detected table carried a
  headerRow — which looksLikeHeader sets for the common shape of a text label row over numeric
  data (invoices/reports). Live before-fix twotables.md showed '| Month | Rev |' then a separator
  then '| Month | Rev |' again as data. The ternary 'headerRow ? table.rows : table.rows.slice(1)'
  re-included row[0] exactly in the header-present branch.
- FIX: body is now always table.rows.slice(1). RED without fix: extract-tables 'prints the
  Markdown header row once' fails 1 test ("expected ['| Month | Revenue |', …(1)] to have a
  length of 1 but got 2"). GREEN: pdf-to-csv 5 + extract-tables 4 + pdf-to-excel 4 = 13 pass.
- Re-measured live post-fix: twotables.md now header-once, grid matches find_tables exactly (exact).
- COPY: the note claimed 'Tables are found from ruled lines and aligned columns'. Ruled lines are
  never read — detectTables is always called with lines:[] (convert-from.ts collectTables and
  core/convert.ts both), and nothing in the pipeline produces VectorLine[] from the page. So
  detection is aligned-columns ONLY. Note rewritten to say so and to name the real miss cases.

## BLOCKER (shared core/tables.ts — report-only; seam follow-up) — the trio misses real tables
whitespace/column detection only, and it is fragile off a bare grid:
- prose or heading sharing the block with a table: prose.pdf (one sentence above a bordered
  3-col table) -> 'No tables found' (witness: 1 table); hdr.pdf -> heading swept in as a junk
  row 'Invoice,,'; multi.pdf (2 pages, 3 bordered tables + prose/headings) -> 0 tables, all 3 missed.
  Cause: splitBlocks (tables.ts) only cuts a block at vertical gap > height*2.6, so a nearby line
  stays in the table's block and columnsFromRows/confidence rejects it.
- spans: spans.pdf (colspan/rowspan) -> 'No tables found' (witness find_tables reads the grid).
  A ruled grid would carry it, but the ruled path is dead (see copy fix). This is why the note
  mattering: the promise of ruled-line detection is what a user relies on for exactly these tables.
- in-cell line break (<br>): cells.pdf 'Line one\nLine two' fractured into 3 physical rows
  (clusterRows splits by baseline) instead of one multi-line cell; find_tables keeps it as one cell.
- CJK / ligature in a cell split by the parts.join(' ') at tables.ts:286/424 — '世界' came out
  '世 界'. Same spine class as core/convert.ts::rowText; seam 2C should fix both joins.
Only the app's own bare-grid fixtures (tablePdf: rows drawn with 140pt gaps, no surrounding text)
exercise the one layout whitespace detection handles — which is why the prior verified-good passed.

## Left open (2C / tables.ts)
- Wire the ruled-lines path (a vector-lines source feeding detectTables) so bordered tables and
  prose/spans adjacency detect; and harden splitBlocks so a heading/prose line does not poison a
  table block. Owned surface of all three tools is otherwise correct.
- extract-tables JSON promise says 'cell coordinates' but rows are plain string arrays with only a
  table-level rect; minor overclaim, rooted in collectTables shape (note-level, not fixed).
