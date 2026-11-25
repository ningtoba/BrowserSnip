# `split` — re-audited against this build (sweep/organize, dev server `:5292`, 2026-11-25)

Probe: `docs/research/split-campaign.mjs` — one Chromium tab, every case
re-navigated with a unique query (so a hidden field cannot read back from the
previous case's mode), the mode chip pressed first, each field written the way a
user's event reaches React and **read out of the DOM before the click**, every
card row's own download pressed, and the archive taken through *Download as zip*.
Reader: `docs/research/split-campaign-bytes.py` — for each produced file it works
the page promise out of the file's **own name** (`…_pages-01-04.pdf` → sheets
1-4, `…_page-05.pdf` → sheet 5, `…_odd-pages.pdf` → the odd side) and then
demands that every sheet in the file measures exactly like the source sheet it
names: displayed box, `/MediaBox`, `/CropBox`, `/Rotate`, characters, first text
line and non-white pixels at 110 dpi; plus the archive's entry list and each
entry's bytes against the file the card offered. Control built into the reader: a
fresh page of paper must measure 0 ink, and measuring a source twice must give
the same numbers.

Corpus: 26 cases over `colour.pdf` (8 sheets: `129225 / 114812 / 0 / 333027 /
583578 / 0 / 56540 / 56540` ink at 110 dpi, sheet 4 a `595×420 /Rotate 90`, sheet
8 a `336×71` slip with its own `/CropBox`), `sheets.pdf` (5 sizes),
`blank.pdf` (1), a 10-page document (for name width), and the carry fixtures
`annot.pdf`, `attach.pdf`, `form.pdf`, `meta.pdf`, `bookmarked.pdf`,
`labels-kids-mixed.pdf`.

## Verdict: one defect, in a refusal's sentence; everything else verified-good.
141 + 46 byte checks, 0 failures; the sheets, names, archives and carries all held.

Every mode cut the sheets its label names, and the bytes say so:

| case | what the card offered | what the files hold (measured) |
| --- | --- | --- |
| `1-3` | 1 file, `PAGES 8 → 3` | sheets 1,2,3 — ink `129225 / 114812 / 0` |
| `1-3, 5` | 2 files, `8 → 4` | `…_pages-1-3` = 1,2,3; `…_page-5` = 5 (`583578`) |
| Every page | 8 files | 1…8, each its own sheet, blanks still blank (`0`) |
| Odd / even (both) | 2 files | `odd-pages` = 1,3,5,7 (`129225 / 0 / 583578 / 56540`), `even-pages` = 2,4,6,8 |
| Odd only | 1 file | odd side only |
| Odd / even on a 1-page file, both | 1 file | note: *"This document has no even pages, so no even-pages file was made."* — and no empty file |
| 31-even-only-onepager | refusal | *"This split would produce no files at all. / Pick a range inside 1-1, or switch to 'Every page'."* — true, but it threw away the reason the code had already written, and sent the user to a range box the mode they chose does not show. **Fixed this round:** the alert now reads *"This document has no even pages, so this split would produce no files. / Its only sheet is odd. Ask for "Odd pages only", or switch to "Every page"."* |
| Chunks of 3 | 3 files | 1-3, 4-6, 7-8 (short final file, as the help says) |
| Chunks of 8 (= length) | 1 file | note names the collapse: *"The chunk size (8) is at least the document's length…"* |
| `Pages per file = 0` | 8 files | clamped to 1 with the correction on the card |
| `5-2` | refusal | *"runs backwards — page 5 comes after page 2. Write 2-5."* |
| `9-12` | refusal | *"refers to page 9, but this document has 8 pages."* |
| `abc` | refusal | *"is not a page number or a range like 3-5."* |
| empty ranges | button disabled | the validate sentence, no click possible |
| `1-3, 2-4` (overlap) | 2 files | overlap kept as two ranges; the coverage note counts the union (4 of 8) |
| 10 pages, every page | 10 files | `…_page-01 … _page-10` — a folder sorts them in reading order |
| 10 pages, chunks of 4 | 3 files | `…_pages-01-04`, `-05-08`, `-09-10` |

**Everything that is not a sheet still travels, as `PAGE_COPY_NOTE` promises**
(`split` notes are exactly that sentence, so each clause is the tool's claim):
`annot.pdf` sheet 1 → 3 annotations + 1 link in the part; `attach.pdf`'s
`note.txt` → `/EmbeddedFiles` still 1; `labels-kids-mixed.pdf` `4-6` → the
output's own numbering reads **II, c, xA** (ranges re-pointed, the one range that
numbered only dropped sheets left, and the card says so);
`bookmarked.pdf` `1-3` → 2 of its 3 bookmarks came along and the card names the
one that pointed outside the part; `form.pdf` → 3 widget boxes on the page and no
`/AcroForm`, with the card saying the fields stopped being editable.
`split` carries no `/Info` and does not claim to (its notes list is only
`PAGE_COPY_NOTE`; `title ''` measured).

**The refusal that was wrong (fixed this round).** `Split by = Odd / even`,
`Which side of the sheet = Even pages only`, a 1-page document: the alert read
*"This split would produce no files at all. — Pick a range inside 1-1, or switch
to 'Every page'."* True, but it discarded the sentence the same `run` had just
written into `notes` (*"This document has no even pages…"*) and pointed the user
at a range box the mode on screen does not show. The alert now names the side and
the alternative that exists: *"This document has no even pages, so this split
would produce no files. — Its only sheet is odd. Ask for \"Odd pages only\", or
switch to \"Every page\"."* (`/tmp/lane-organize/split/35-even-only-onepager-after.png`).
Pinned by `tests/pdf/edge-organize.test.ts` → *"names the side a one-page document
has no pages on…"*: **1 failed without the fix** (`expected 'This split would
produce no files at …' to match /no even pages/i`), 321 passed with it.

**Screen half** (`/tmp/lane-organize/split/*.png`, read by eye): the 8-file
result card lists every name with its own size and download arrow plus *Download
all* / *Download as zip* / *Keep original*, the preview paints sheet 1 with real
ink (black bar, body copy), the honesty line about the file growing is amber and
legible, the refusal pane shows `STOPPED` on the file card with *"Pick pages
between 1 and 8"* and a Retry, and the dark run keeps every one of those rows
readable with tokens (no hex literal needed a change).

**Network half** (`docs/research/net-check.mjs`, CDP `Network` on the live run):
`biggestForeignUpload: 0` — nothing left the tab. 155-158 same-origin requests
(dev-server modules, the pdf.js worker); the only foreign traffic is the app
shell's `fonts.googleapis.com/css2` stylesheet and two `fonts.gstatic.com` woff2
files, plus `data:` URIs for its own thumbnails. The app's own sentence on the
card — *"Split PDF finished in this tab — nothing was uploaded"* — agrees.

## Left open, measured

1. The `…_page-3-2.pdf` style clash suffix (a sheet named twice, one file per
   page) is readable but not the ` (2)` shape the archive writer uses elsewhere;
   both sort after their base name, so a folder still reads in order. Recorded,
   not changed.
2. Split's archive entry list is a shared-seam behaviour
   (`components/tools/pdf/shared/ResultCard.tsx`); it is verified here in the
   live run (entries equal the card's names, byte for byte) and pinned there by
   `tests/app/shared-ui.test.tsx`, not by this lane.
