# pdf-to-text / pdf-to-markdown — Step-2 witness audit (re-settle on today's master)

Branch sweep/convert2 @ e29fcf4, dev :5293, CDP 9853.
Drivers: docs/research/colour-rail.mjs (live Chromium, FIELDS+downloads+network) + docs/research/extract-witness-check.py (PyMuPDF + pdftotext witnesses).

## Ligature / multi-item spacing — the one real defect (isolated on /tmp/lane-q1/lig.pdf)
Source (both witnesses agree):

    The efficient officer finally affirmed a sufficient profile offline.
    Influence flowed through the official office configuration.

App output (identical for pdf-to-text .txt and pdf-to-markdown .md):

    The e ff icient o ff icer fi nally a ff irmed a su ff icient pro fi le o ffl ine.
    In fl uence fl owed through the official office configuration.

Word count: app 'Extracted 38 words' vs truth 16 (ratio 2.38). Root cause:
core/convert.ts::rowText -> row.items.map(i=>i.str).join(" ") — pdf.js returns each
ligature/kerned run as a separate text item; the unconditional space between items
splits one word into several. MuPDF-generated fixtures (one item per line) never
exercise this, which is why the prior tail-rig re-settle reported verified-good.

## Fidelity matrix (extract-witness-check.py)
pdf-to-text__t1-colour-default_colour.tx colour.pdf       PASS             0    0   262   262   1.0  (0, 0, 0) (0, 0, 0)  n/a
pdf-to-text__t2-colour-reflow_colour.txt colour.pdf       PASS             0    0   262   262   1.0  (0, 0, 0) (0, 0, 0)  n/a
pdf-to-text__t3-colour-markers_colour.tx colour.pdf       SPACED-WORDS     0   10   294   262  1.12  (0, 0, 0) (0, 0, 0)  n/a
pdf-to-text__t4-colour-page2_colour.txt  colour.pdf       LOSS            37    0     2   262  0.01  (0, 0, 0) (0, 0, 0)  n/a
pdf-to-text__t5-uni_uni-html.txt         uni-html.pdf     SPACED-WORDS     9   23   158   134  1.18  (3, 21, 2) (4, 44, 2)  n/a
pdf-to-text__t8-enc_locked128.txt        locked128.pdf    PASS             0    0   269   269   1.0  (0, 0, 0) (0, 0, 0)  n/a
pdf-to-markdown__m1-uni_uni-html.md      uni-html.pdf     SPACED-WORDS     8   24   160   134  1.19  (3, 21, 2) (4, 44, 2)  n/a
pdf-to-markdown__m2-table-on_table.md    table.pdf        TABLE            0    2    54    20   2.7  (0, 0, 0) (0, 0, 0)  MISMATCH
pdf-to-markdown__m3-table-off_table.md   table.pdf        PASS             0    0    20    20   1.0  (0, 0, 0) (0, 0, 0)  n/a
pdf-to-markdown__m4-headings-off_uni-htm uni-html.pdf     SPACED-WORDS     8   24   160   134  1.19  (3, 21, 2) (4, 44, 2)  n/a
pdf-to-markdown__m5-pagerule_colour.md   colour.pdf       SPACED-WORDS     0    1   269   262  1.03  (0, 0, 0) (0, 0, 0)  n/a
pdf-to-text__h1-text-layout_head.txt     head.pdf         SPACED-WORDS     2    5    42    37  1.14  (0, 0, 0) (0, 0, 0)  n/a
pdf-to-text__h2-text-reflow_head.txt     head.pdf         SPACED-WORDS     2    5    42    37  1.14  (0, 0, 0) (0, 0, 0)  n/a
pdf-to-markdown__h3-md-head-on_head.md   head.pdf         SPACED-WORDS     2    7    44    37  1.19  (0, 0, 0) (0, 0, 0)  n/a
pdf-to-markdown__h4-md-head-off_head.md  head.pdf         SPACED-WORDS     2    5    42    37  1.14  (0, 0, 0) (0, 0, 0)  n/a
pdf-to-markdown__h5-md-table-off_head.md head.pdf         SPACED-WORDS     2    7    44    37  1.19  (0, 0, 0) (0, 0, 0)  n/a
pdf-to-text__lig-text_lig.txt            lig.pdf          SPACED-WORDS    12   22    38    16  2.38  (0, 0, 0) (0, 0, 0)  n/a
pdf-to-markdown__lig-md_lig.md           lig.pdf          SPACED-WORDS    12   22    38    16  2.38  (0, 0, 0) (0, 0, 0)  n/a

14 of 18 outputs disagree with the PyMuPDF witness. SPACED-WORDS = rowText joins every pdf.js item with a space, splitting ligature/kerned runs into fake words (see core/convert.ts::rowText).

PASS rows prove the rig is precise (262/262 on colour.pdf, exact on encrypted open
path t8 269/269, table-off m3). SPACED-WORDS = the rowText defect (head/lig) plus the
uni.pdf RTL-presentation-form and CJK-glyph-split behaviours inherent to the shared
extractor. m2 'MISMATCH' is the rig, not the app: pdf-to-markdown rebuilt the full
4-column grid (Item/Qty/Price/Total) that PyMuPDF find_tables truncated to 3 — the app
is more correct there and the pipe table re-parses cell-for-cell.

## Controls that reach the bytes
- layout on/off: t1 keeps 26 physical lines; t2 reflow joins to one paragraph (262=262).
- pageMarkers: t3 emits '--- page N ---' before each page.
- page selection: t4 (Pages=2) -> only 'colour sheet' reaches the file (2 tokens).
- encrypted open: t8 locked128 + password 'reader-pass' -> byte-parity with unencrypted.
- tables on/off (markdown): m2 pipe grid vs m3 tab-separated plain lines.
- headings on/off: h3 '# '/'## ' vs h4 none.
- page rule (markdown): m5 inserts 7 '---' between the 8 pages.
- refusals honest + OCR advice: scanned.pdf and blank.pdf produce a report, 0 downloads.

## Screen half (read by eye)
t1 content card, t6/m6 scanned refusals, lig dark — see /tmp/lane-q1/out/*.png.

## Verdict
Both tools: DEFECT-FOUND, root cause in shared seam core/convert.ts::rowText
(blocker-only for this lane; blast radius = every text-shaped tool that reads
rowText: pdf-to-text, pdf-to-markdown, pdf-to-json, prepare-pdf-for-ai, and the
edit/word/svg exporters). No convert-from.ts change is correct in isolation.
Existing pins re-settle green on today's master (pdf-to-text 14/14, pdf-to-markdown 4/4).
