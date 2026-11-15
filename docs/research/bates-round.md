# Round 036 — `bates-numbering`, measured

Dev build `:5271`, one Chromium tab per case through the existing probe
`docs/research/colour-rail.mjs` (batch form: every field written the way a user's
event reaches React and read back out of the DOM before the click, every produced
file captured through `downloadBlob`'s own object URL), judged outside the app by
PyMuPDF. Fixtures `/tmp/triage/colour.pdf` (4 sheets: copy, colour squares, **an
empty sheet**, a `595×420 /Rotate 90` sheet) and `/tmp/triage/sheets.pdf` (5 sheets
of five different sizes), plus `annots.pdf` (annot + link + 2-entry outline +
`/Info`) and a crop-box twin for the box question.

Ink was counted off the rendered bitmap as the pixels a run *adds* to the source at
144 dpi (`mean(|out - source|) > 25`), so a page of paper measures zero and every
figure below is ink that was not there before. The instrument was run against the
untouched sources first: 0 px on all nine sheets.

## Already right, before the fix (both halves)

- **One sequence, no repeat, no skip.** `Bates-001 … Bates-004` on the first file,
  `Bates-005 … Bates-009` on the second: 9 numbers for 9 pages, in upload order.
  The empty sheet is stamped (`003`, 532 px) and so is the turned sheet (`004`,
  530 px) — nothing is skipped for having nothing on it.
- **Inside the box, in the displayed frame.** Right 18.0–19.5 pt and bottom 19.5 pt
  on all nine sheets; on the `/Rotate 90` sheet the stamp lands in the *displayed*
  bottom-right of a 1190×840 render and reads upright (`bates-round-rot90-stamp.png`).
  The source's own `/Rotate` is not normalised.
- **Clamping/edge.** 9 digits at 30 pt with margin 0: ink R1.0 B5.5, inside. A
  7-digit number at 5 pt with margin 0: R0.0 B0.5, flush but inside.
- **`start: 0`** writes `B-0 … B-4`, no blank and no negative.
- **Nothing else lost.** `/Info` identical on both fixtures, the annotation and the
  link kept on `annots.pdf`, both outline entries kept, each file keeps its own page
  count (4 / 5).
- **Crop box.** On a page whose visible box is inset to (60,80,360,515) the stamp
  sits 18/19.5 pt from the *crop* edges, not the media edges.
- **Cyrillic prefix** (`Дело`) renders through an embedded Noto subset, nothing missing.
- **No drift.** The same job twice gives the same nine strings, file for file; a
  continuation job with `start: 10` writes `Bates-010 … Bates-014`.
- **Card, sentence half.** `Applied 9 Bates numbers across 2 files
  (colour_bates.pdf 4 pages, sheets_bates.pdf 5 pages).` — 9, 2 and both page counts
  equal the files produced. The earlier FALSE CLAIM row is settled for this sentence.

## Defects found and fixed

1. **`{total}` did not follow the sequence.** `{n}/{total}` over 4 + 5 pages wrote
   `004/4`, then `005/5 … 009/5` — nine numbers measured against a total of five —
   while `{page}` beside it was the file's own position. Now both page tokens answer
   to `{n}`'s scope: `004/9`, `005/9 … 009/9`; the restart control keeps the file as
   its scope (`001/4`, `005/5`).
2. **An unknown token printed in silence.** `{n} {foo} {page}` shipped `{foo}` on
   all five stamps with the card's warnings holding only the last-number line. Now
   `“{foo}” is not a token, so it is printed as it stands on every stamp.`
3. **Copy, after measuring the behaviour.** The note said a second run "writes a
   second number"; at 300 dpi the second number lands in the same ±0 box and
   overprints the first — `Bates-005` over `Bates-001`, only the differing digit
   legible (`bates-round-overprint.png`), both strings still extractable. The note
   now says so.

## Left open, measured

- `PAGES 9 → 4` on a two-file job: the right-hand number is the *primary* output's
  count while `pagesIn` is the batch sum, so the row mixes scopes. Shared seam:
  `RunOutput` carries no per-output page count, so dropping `result.pages` would
  hide the row instead of correcting it (`pages-out.test.ts` pins `pagesOut` for
  this very tool).
- `digits` shorter than the reach widens the stamp with no note (the field help
  says it will).
- A restamp overprints rather than avoiding the number already there (admitted by
  the note now, not detected).
- `start` above 1 000 000 is clamped by the rail; a 7-digit production is reached
  through padding, not through the start value.
- The rail has no `{org}`, though `core/bookmarks.addBatesNumbers` supports it.
