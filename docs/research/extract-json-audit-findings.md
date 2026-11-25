# pdf-to-json + prepare-pdf-for-ai — Step-3 witness audit (sweep/convert2, master e29fcf4)

Live: colour-rail.mjs SPEC over 18+3 runs (:5293/9853). Judge: docs/research/json-witness-check.py
(json.loads + structure + PyMuPDF witness + counts==bytes). Network: 0 off-origin on every run.

## pdf-to-json — owned surface VERIFIED-GOOD; inherits the shared rowText spine (blocker 2C)
- json.loads valid on all 10 fixtures (incl. encrypted locked128 -> 8 pages).
- Structure: page numbers ascending within source; every block has a numeric rect; the table
  block carries a real rows grid. table.pdf grid = 4 cols [Item,Qty,Price,Total]+4 rows, which
  MATCHES the source and BEATS PyMuPDF find_tables (truncated to 3 cols) — the app is more correct.
- Counts==bytes (bars 6): message page/block counts equal the arrays exactly:
  j1 8 pages/2 blocks, j2 1/1 (+1 table), j7 scanned 3 pages/0 blocks (each images=1, text='').
- Honest edges: page selection reaches the JSON (j9 Pages=2 -> 1 page); scanned keeps its file + no-text
  warning; blank refuses with no empty-file download (j8: 'The 1 selected page(s) are blank').
- Fidelity vs witness: colour/encrypted/rot/page2/scanned PASS (no invented tokens). uni-html/head/lig
  show SPACED-WORDS (35/9/34 invented) — the SAME core/convert.ts::rowText spine as the text tools
  (block.text and page.text carry 'e ff icient'). Report-only for this lane; re-anchor when 2C lands.

## prepare-pdf-for-ai — FIXED one owned defect + inherits the spine
- ref_doc_info shape, num_pages honest to the SELECTION (p8 Pages=2 -> num_pages 1, text 'colour sheet'),
  Document id re-keys the ref (p2 -> 'my-doc-id'), flat extra merged (p3 source/year), page separator ('\f')
  between content pages, invalid-JSON refusal present. counts==bytes: 'Produced 1 reference document(s)'
  == the single ref_doc_info key.
- DEFECT (convert-from.ts, my file): the 'Extra metadata' field promises 'Anything nested is rejected
  before the run' and 'One flat object of strings and numbers', but the run only JSON.parsed it, so
  '{"a":{"b":1}}' and '{"tags":[1,2]}' and a top-level list were ACCEPTED and spread a nested object/
  array straight into the index metadata. Pre-fix p4/p5 produced a download (nested rode along).
- FIX: flatMetadata() rejects a non-object root and any object/array value, naming the offending key:
  'The extra metadata must stay flat: "a" holds a nested object, which an index cannot store.' + repair.
- RED without fix: tests/pdf/edge-convert-from.test.ts 'rejects nested extra metadata' fails 1 test
  ('prepare-pdf-for-ai succeeded where it was expected to refuse'). GREEN with fix: 7/7 (3 json + 4 ai).
- Re-measured live after fix: nested & array now refuse (screen shows file+cause+Retry); flat still runs.
- Still inherits the spine: a ligature PDF's chunk text carries 'e ff icient' (report-only, 2C).

## Left open
- RowText join semantics (seam 2C) — see /tmp/lane-q1/rowtext-seam-spec.md; failing fixtures lig.pdf/head.pdf here.
- pdf-to-json promise says blocks carry 'fonts' but the seam records only fontHeight (size), no font
  family — a description nuance rooted in core/convert.ts (blocker-only), not fixed here.
