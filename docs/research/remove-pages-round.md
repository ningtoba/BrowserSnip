# remove-pages (Delete Pages), round 004

Dev build `:5271`, Chromium over CDP, PyMuPDF reading the downloads. The file half
was right before anything was touched; two surface defects and one silent byte
loss were not, and the two surface ones are visible in the before screenshots.

## Measured before (`remove-pages-round-before.log`, shots 1-4)

* **The sheet work was already correct and stayed correct.** Dropping sheet 2, 4,
  the empty sheet 3, the reversed pair `4,2` and the duplicate `2,2` all produced
  exactly the surviving source sheets, in order: `remove-pages-bytes.py` compares
  each output sheet's first text line, ink at 72 dpi, box and `/Rotate` against
  the source sheet it should be, and answers OK for every case. The instrument is
  checked both ways — colour.pdf's empty sheet reads ink 0, and a deliberately
  wrong kept list fails on line, box, rotate and ink.
* **Everything a keeper carries came through**: 3 annots and 1 link on the kept
  sheet of `annot.pdf` (3 and 1 in the source), the embedded `note.txt`, page
  labels `ii, 1, 2` with their sheets, the outline re-pointed to the sheets that
  stayed with the dropped entry counted on the card.
* Refusals are true and said: `all` disables the run ("Choose the pages to delete
  — deleting every page would leave an empty PDF."), `1-4` typed is refused by
  the run with the same sentence and a hint, one page of one page is refused, `9`
  of 4 names the count.
* **The card counts match the file both directions** — 4 → 3 with "Removed 1
  page, kept 3 pages." over a 3-sheet file; 4 → 1 with "Removed 3 pages, kept 1
  page." over a 1-sheet file.
* **Defect 1, the identity.** `pdf-lib` copies pages and nothing else, so the
  output came back with no `/Info` at all: title, author, subject, keywords,
  creator and the whole 381-byte XMP packet dropped, producer replaced by
  pdf-lib's, and the card said nothing on a tool whose promise is "every other
  page untouched".
* **Defect 2, the picker.** The page strip never rendered: the collapsed options
  row passes `compact` to its lead control, `compact` drops the strip, and this
  tool declares one field — so there is no disclosure to unfold and the picker
  was a text box and two chips on a tool that is only a page picker
  (`thumbs 0 / strip false`, shots 1, 3, 4).
* **Defect 3, the duplicated sentence.** An out-of-range range was printed twice
  in red — once by the guard as the field's issue, once by the picker — plus a
  third time in "Still needed:" (shot 3).

## After (`remove-pages-round-after.log`, shots 5-10)

* The strip is drawn for a `pages` lead field (not `compact`), 4 tiles on
  `colour.pdf`, and a tile is the control: clicking page 3 writes `1-2,4` and the
  run keeps source sheet 3 alone (checker OK). The strip footer owns the count,
  so the picker's second counting line is gone.
* The info travels (`carryDocInfo`, the same helper `merge` uses) and the
  producer is the app's own; an untitled file invents nothing. Keywords come back
  space-joined, as the merge round already records.
* The range sentence is printed once.
* Every sheet case above re-measured OK; annots/links/attachments/outline/labels
  unchanged; refusals unchanged.

## Left open, measured

* **The strip starts with every page selected** on this tool (the field defaults
  to `all`), so one tile click reads as "delete only this one". Defensible for a
  delete tool and pinned in the new surface test, but it is a product call.
* `extract-pages`, `rotate` and every other copy tool still drop the `/Info`;
  only this tool carries it (`PAGE_COPY_NOTE` is shared and would overclaim).
* The strip's footer says "pick pages below" while the tiles are above it.
* A 0-page PDF is legal; the tool refuses to make one. That is what it says, and
  the hint points at Extract Pages.
