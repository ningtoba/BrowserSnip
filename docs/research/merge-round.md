# `merge` — measured, two defects, fixed and pinned

Probe: `docs/research/merge-round.mjs` (two documents into the rail, tray order read
out of the DOM and shifted with the cards' own `Move … earlier` button, each toggle
written the way a user's event reaches React and read back before the run, the
download taken through the result card's own button, a screenshot of the pane and of
the card). Reader: `docs/research/merge-round-bytes.py` — PyMuPDF, per-sheet box,
`/MediaBox`, `/CropBox`, `/Rotate`, characters, non-white pixels at 50 dpi,
annotations, links, images, plus `/Info`, XMP, the outline, the page-label ranges and
the embedded files. Every case is run against the **sources** as well as the output,
so "the merged pages are the source pages" is a comparison and not a page count.
Chromium headless at 1440×1100, dev server `http://localhost:5271`, one port per case.

## What was already right (measured, kept)

* **Order.** The output is the tray order, page for page: `colour.pdf`'s four sheets
  (ink `33011 / 24021 / 0 / 69335`) then `sheets.pdf`'s five
  (`43824 / 68059 / 21908 / 108649 / 0`), unchanged from the sources at the same dpi.
  Driving `Move sheets.pdf earlier` reverse both the tray (`sheets.pdf`,
  `colour.pdf`) and the bytes (`15900 / 24600 / 10266 …`), the per-file bookmark
  entries (`sheets.pdf → 1`, `colour.pdf → 6`) and the download name
  (`sheets_merged.pdf`). `docs/research/shots/merge-6-tray-swapped.png`.
* **Page boxes and `/Rotate`** survive exactly: `/MediaBox` `420×595`, `/CropBox`
  `[36 36 400 500]` injected into page 2 comes back `[36 36 400 500]`, and the
  quarter-turned sheet is still `595×420 /Rotate 90` with its own `69335` ink.
* **Annotations and links**: page 1 of `annot.pdf` carries 3 annotations and 1 link,
  and page 1 of the download carries 3 and 1 (`merge-round-carry.log`), which is what
  the card's note promises.
* **Embedded files**: `attach.pdf` has one, the download has one, with the same name.
* **Page labels**: `labels-kids-mixed.pdf` numbering `i ii I II c xA` comes out as
  ranges re-based onto the sheets it landed on (start 4, 6, 8, 9 — sheets 1-4 belong
  to the unnumbered first file and correctly stay unnumbered).
* **Refusals are true.** One file: the run button is disabled and the pane prints
  *"Still needed: Add at least two PDF files to merge."* Locked AES-256 file:
  *"`locked.pdf` is password protected."* + the row's own password box; typed in, the
  merge runs and the copy keeps `/V 5 /R 6 AES-256` with its words. Zero-page file:
  *"`zero.pdf` has no pages."* The same file twice: it runs, and the card says the
  pages are used twice. No console error in any case.
* **Dark mode**: tokens only, cards, queue and CTA all legible (`merge-7-dark.png`).

## Defect 1 — the blank spacer was the wrong sheet

`blankBetween` took the size of the file's **first** page, so a file that ends
landscape got a portrait spacer: page 4 (the neighbour, `595×420`, `/Rotate 90`) and
page 5 (the spacer, `420×595`, `/Rotate 0`). The help text said "the page before it",
and the sibling `add-blank-page` already takes the neighbour. Now the spacer is
`595×420`, the neighbour's displayed geometry; a uniform file is unchanged (the
control in `tests/pdf/edge-organize.test.ts`). `merge-round-spacer.log`.

## Defect 2 — the merged file had no document info at all

`pdf-lib` copies pages and nothing else, so with `meta.pdf` first the download lost
its title (`Triage metadata title`), author, subject, keywords, creator **and the
whole XMP packet**, and the card said nothing. A merge is a copy: `rebuildDocument`
already carries these fields for repair and unlock, so the first file's now travel
(title, author, subject, keywords, creator and the packet) while the producer stays
`BrowserSnip`, and the card names whose info was left behind when another file had
its own. Controls: `sheets.pdf` (untitled) first invents nothing and says
*"`sheets.pdf` has no document info … put the file whose info you want first"*; the
note stays quiet when no other file has a title. `merge-round-info.log`,
`merge-5-info-note.png`.

Keywords come back space-separated (`alpha beta gamma` for `alpha, beta, gamma`)
because `setKeywords` takes a list — recorded, not fixed.

## Red without the fix

`npx vitest run tests/pdf/edge-organize.test.ts` with `src/lib/pdf/tools/organize.ts`
checked out at `HEAD`: **3 failed / 97 passed**; with the fix: **100 passed**.
The three: the spacer size (`expected {width: 200, height: 100} to deeply equal
{width: 400, height: 300}`), the info carry (no title, author, subject, keywords, no
`/Metadata`), and the "no info to carry" note.

## Left open, measured

1. **A zero-page file refuses the whole job.** The sentence is true, but a merge
   could use the files that do have pages — and the tool's own `NO_PAGES` branch
   (*"None of the files you added has a page."*) is unreachable because the runner's
   pre-flight throws on the first bad input. The fix is in `tools/runner.ts`'s
   pre-flight loop, shared with every other tool, so it is not this row's.
2. **Two files with the same name key the queue by name**, so React logs
   `Encountered two children with the same key` on a file added twice. The output is
   correct; the fix is `FileCards`' `keyFor`, shared with every multi-file tool.
3. **`/CreationDate` is the merge's**, not the first file's — `rebuildDocument`
   behaves the same way and the card does not claim otherwise.
4. **The guard's zero-page hint says "Nothing to convert"** on a tool that copies
   rather than converts; the guard is shared.

## Re-audit (sweep/organize, dev build `:5292`, 2026-11-25)

Re-driven live against this build with `docs/research/merge-round.mjs` and
`docs/research/net-check.mjs` (the network half: CDP `Network`, every request the
tab made, with its upload size). Fixtures are the re-generated corpus:
`colour.pdf` is 8 sheets and `sheets.pdf` 5, so every number below is this
round's own measurement, read by `docs/research/merge-round-bytes.py`.

* **Order, geometry, ink — exact.** The 13-sheet output measures
  `33011 / 24021 / 0 / 69335 / 120888 / 0 / 11700 / 11700` then
  `43824 / 68059 / 21908 / 108649 / 0` non-white pixels at 50 dpi — sheet for
  sheet the source measurement at the same dpi, including the quarter-turned
  `595×420 /Rotate 90` sheet (69335) and the `336×71.4` slip with its
  `/CropBox [42 59.5 378 130.9]` intact. `Move sheets.pdf earlier` reverses the
  bytes and the per-file bookmarks (`sheets.pdf → 1`, `colour.pdf → 6`) and the
  download name with them.
* **Bookmarks** — on: `[colour.pdf → 1, sheets.pdf → 9]`. Off: `bookmarked.pdf`
  first carries its own tree re-pointed (`Chapter One → 1`, `Section One.A → 2`,
  `Chapter Two → 4`) and no per-file entries are invented.
* **Spacer** — with `blank page between files` on, the sheet inserted after
  `colour.pdf` is `336×71 /Rotate 0`, the neighbour's displayed geometry, and it
  holds 0 characters and 0 ink.
* **Everything that is not a page** — 3 annotations + 1 link from `annot.pdf`
  arrive on the sheet they were on, `attach.pdf`'s `note.txt` arrives with its
  bytes, `labels-kids-mixed.pdf`'s numbering re-bases by the leading blank file
  (`r` at 0 → at 1, `R` at 2 → 3, `a` at 4 → 5, `xA` at 5 → 6), and with
  `meta.pdf` first the title, author, subject, keywords, creator and the XMP
  packet all travel while the producer stays `BrowserSnip`.
* **Refusals** — one file: the button is disabled and the pane prints *"Still
  needed: Add at least two PDF files to merge."*

**Fixed: the carried keyword string lost its separators.** `meta.pdf`'s
`/Keywords (alpha, beta, gamma)` reached the merged file as
`alpha beta gamma`: `carryDocInfo` split the string on commas and handed pdf-lib
a list, which joins its elements with a single space — so the promise that the
first file's "keywords travel as the merged file's own" was true for the words
and false for the value. `/Keywords` is one string (ISO 32000-1 §14.3.3) and the
separators belong to it, so the value now travels whole
(`setKeywords([keywords])`). Before → after, live browser run on `meta.pdf` +
`sheets.pdf`: `keywords 'alpha beta gamma'` → `'alpha, beta, gamma'`.
Pinned by `tests/pdf/edge-organize.test.ts` → *"carries a source's keyword
separators with the words (E7)"*: **1 failed without the fix** (`expected
'alpha beta gamma' to be 'alpha, beta, gamma'`), green with it; the two controls
in the same test (a `; ` list, and a separator-free value) pass either way.
`carryDocInfo` is shared by every tool defined in `organize.ts`, so the same
rewrite is gone from those too.
* **Dark mode** — `shots` kept at `/tmp/lane-organize/r/merge-dark-pane.png`:
  cards, thumbnails, checkboxes, honest-notes strip and CTA all legible.
* **Network** — no request carried a byte out of the tab
  (`biggestForeignUpload: 0`, 158 same-origin requests). The only foreign
  requests are the app shell's own `fonts.googleapis.com/css2` stylesheet and
  two `fonts.gstatic.com` woff2 fonts (71 KB in), plus `data:` URIs for the
  result card's thumbnails. No file bytes left the tab.
