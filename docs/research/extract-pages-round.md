# `extract-pages` — re-audited against this build (sweep/organize, dev server `:5292`, 2026-11-25)

Probe: `docs/research/extract-pages-round.mjs` (19 cases, one Chromium tab per
case, `Pages` and `Combine into a single PDF` written as user events and read back
out of the DOM before the click, every produced file taken through the card's own
download buttons, the archive through *Download as zip*, pane-plus-card
screenshots). Reader: `docs/research/split-campaign-bytes.py --cases …`, extended
this round to take an explicit page list per case — an extract file's name
(`colour_extracted.pdf`, `colour_page-3.pdf`) does not carry the typed order, so
the expectation is the selection the case typed, and each produced sheet is then
demanded to measure like that source sheet (displayed box, `/MediaBox`,
`/CropBox`, `/Rotate`, characters, first text line, non-white pixels at 110 dpi).
**63 checks, 0 failures.**

Right, and still right:
* `3,1` → sheet 3 (blank, 0 ink) then sheet 1 (`129225`), in the typed order;
  `4,7` → the two quarter-turned sheets keep `595×420 / 90` and `595×420 / 90`
  with their ink (`333027`, `56540`); `8` → the `336×71` slip keeps its
  `/CropBox [42 59.5 378 130.9]`.
* One file per page: `all` + combine off → 8 files, each its own sheet, ink equal
  to the source; the archive's entries are those 8 names, byte for byte.
* A page named twice is copied twice: `2,2,1` → one file of 3 sheets with the
  note *"Page 2 appears more than once…"*; `3,3` with combine off → two files,
  both sheet 3 (`colour_page-3.pdf`, `colour_page-3-2.pdf`), each measuring the
  source sheet.
* 10 pages or more pad: `10,1` → `ten_page-10.pdf` then `ten_page-01.pdf`, in the
  typed order, and the zip holds those two names.
* `all` says so instead of pretending something was taken out: *"You selected
  every page, so the new file holds 8 pages in the original order."*
* Refusals block before the click: `9` → *"Still needed: "9" refers to page 9, but
  this document has 8 pages."* with the Extract button disabled (`shots/09-oob.png`
  read by eye: red line under the picker, dimmed CTA, nothing clipped); empty →
  *"Choose which pages to extract."*
* The carries the note promises: `annot.pdf` sheet 1 → 3 annotations + 1 link in
  the output; `attach.pdf` → `/EmbeddedFiles` still holds `note.txt`;
  `bookmarked.pdf` `1-3` → 2 of 3 bookmarks, the card naming the dropped one;
  `labels-kids-mixed.pdf` `4-6` → the output numbers itself **II, c, xA** and the
  card says the range that numbered only left-behind sheets went with them;
  `form.pdf` → 3 widget boxes on the sheet, no `/AcroForm`, and the card says the
  fields stopped being editable.

Screen half: the `3,1` card previews blank-then-text (`xp/01-keep-3-1.png`), i.e.
what the file holds; the dark run (`xp/11-dark.png`) keeps the preview, the
`8 → 3` line, the amber honesty strip and the CTA legible on tokens.
Network half: `net-check.mjs` on a live extract run → `biggestForeignUpload: 0`,
160 same-origin requests; only the shell's Google Fonts CSS/woff2 are foreign. The
card itself prints *"Extract Pages finished in this tab — nothing was uploaded."*

Verdict: **verified-good**; behaviour unchanged, no new pin needed (naming,
padding, duplicates, order, carries and refusals are pinned in
`tests/pdf/edge-organize.test.ts`, `page-labels-copy.test.ts`,
`page-copy-fidelity.test.ts`, which pass on this build).
