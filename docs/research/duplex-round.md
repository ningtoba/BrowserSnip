# duplex-collate round — brief 011

Tool: `duplex-collate` (`src/lib/pdf/tools/organize.ts:1850`). Fixture from
`/tmp/triage/spec.json`: `/tmp/triage/colour.pdf`, label `Collate`, dev build `:5271`.

## What the card claims

Promise: "A re-ordered PDF where each front page is followed by its own back page."
Toggle, default **on**: "Second half was scanned in reverse" — help: "Most
single-pass duplex scanners output the back side upside-down and last-page-first."
Offset help: pages between the two blocks are left out and the run names them.

The permutation the card claims is the inverse of a last-page-first back block:
fronts `1..ceil(n/2)`, back block `ceil(n/2)..n` reversed, interleaved. For four
sheets the output is `1,4,2,3` — sheet 1 front, sheet 1 back, sheet 2 front,
sheet 2 back — which is what a duplex printer reads back into pages 1–4.

## Before (measured, not assumed)

Every run below is a real Chromium tab, upload, field written the way React
receives it and read back, a click on `Collate`, and the download captured
through `downloadBlob`. Judged by `duplex-round-bytes.py` (40 dpi): per sheet
first non-empty line, `/MediaBox`, `/CropBox`, `/Rotate`, non-white pixels,
annotations, link URIs; then `/Info`, XMP, outline destinations and per-sheet
labels against the same measurement of the untouched source.

* Order, boxes, `/Rotate`, ink, annots, links, outline and labels were already
  **exact on every case**: `duplex-round-before.log` has 0 failures on those
  columns across colour.pdf, `annot.pdf` (3 annots + a URI link on sheet 1),
  `bookmarked.pdf` (outline re-pointed 1→1, 2→3, 4→2), a labelled fixture
  (per-sheet `1, App-2, 2, App-1`) and the 5-page odd fixture. Landscape sheet 4
  kept `595x420 /Rotate 90` in output position 2, 133 403 px in and out.
* The toggle and the offset reach the bytes: `backReversed=false` gave
  `1,3,2,4`; `offset=1` gave `1,4,2` and the card named the dropped page 3.
* The preview strip shows the collated order and the rotated sheet, not the
  source order (`shots/duplex-preview-order.png`).
* Odd 5 pages: output `1,5,2,4,3`, no blank inserted; the card says "An odd 5
  pages scan splits 3 + 2, so the last sheet has no back page." Printing the
  output duplex leaves the last back physically blank, so no spacer is needed.
* 1 page: `1 → 1` copy with the "cannot be collated" and odd-sheet notes.
* 0 pages: the rail refuses before the run — "zero.pdf has no pages. Nothing to
  convert, and a repair will not add pages." (`shots/duplex-0p.png`).
* Card counts match the file: 4 → 4, 5 → 5, 1 → 1.

**The defect:** `/Info` and XMP sat above the page tree, so the copy left them
with the source. Title `colour-tool fixture: bar + copy + band, colour squares,
empty` → `""`; on the labelled fixture title/author/subject/keywords/creator all
went; the creator fell back to pdf-lib's and the producer stayed pdf-lib's, under
a card that said only "Collated 4 pages from a 2 + 2 scan." 14 FAIL lines in
`duplex-round-before.log`, all of them identity fields.

The pane also printed the offset readout as `0pages` (`shots/duplex-unit-before.png`).

## After

* Same runs, same judge: `duplex-round-after.log`, **0 failures** across
  colour.pdf, the labelled fixture, the upside-down fixture, the 1-page refusal
  and both controls. Title/author/subject/keywords/creator and XMP are the
  source's, the producer is `BrowserSnip`, and the card now carries the standing
  info note (`shots/duplex-pane.png`, `HONEST NOTES (2)`).
* Instrument controls in that log: the rev-off output judged with the wrong flag
  fails **8** lines (order, rotation, ink), and the untouched source judged as an
  output fails **8**. A checker that passed either would be blind.
* Readout now `0 pages`; symbol units stay tight (`45°`).
* Red without the fix: **1 failed / 125 skipped** for the `/Info` carry
  (`git stash` of `organize.ts`), **1 failed / 1 passed** for the unit spacing
  (`git stash` of `FieldControls.tsx`).

## Left open, measured

The help says the back sides arrive "upside-down and last-page-first", but the
tool restores the **order only**. On a six-sheet fixture whose back pages are
upside-down (the shape the help names), the output reads P1…P6 in order with
`/Rotate 180` still on every back (`shots/duplex-backs-upside-down.png`), so the
user must still turn the even sheets. The comparable BentoPDF tool behaves the
same (order only); turning backs 180 by default is a product decision, since a
scan whose backs came out upright would then be turned wrongly. The help sentence
describes the scanner, not a claim that the tool fixes the orientation, so it was
left as written and recorded here.

`colour.pdf`'s back pages are upright (no `/Rotate`), which is why the fixture is
a good order test and a poor orientation one.
