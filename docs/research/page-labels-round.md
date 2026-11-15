# `add-page-labels` — the store, per sheet, judged by readers that did not write it

One run per case through `docs/research/colour-rail.mjs` (batch form: the textarea is
written as a user's event and read back out of the DOM before the click) on the dev
build `:5271`, every produced file asked the same three questions by
`docs/research/page-labels-round.py`:

* **store** — the catalogue's `/PageLabels` read off the bytes with libqpdf (pikepdf
  10.9.1): every `/Nums` pair's `/Start`, `/S`, `/St`, `/P`
* **mupdf** — `page.get_label()` per sheet (MuPDF 1.28.2)
* **pypdf** — `PdfReader.page_labels` per sheet (pypdf 6.14.2)

The tool's own sentence is written by the same module that wrote the tree, so it is the
column under test, not an answer. Fixtures are `colour.pdf` (4 sheets) and two copies
built from it with PyMuPDF: a 30-sheet file (`thirty.pdf`) and a furnished one
(`/Info`, one annotation, one link, a two-entry outline).

Never drawn: the ink of every produced sheet is counted at 50 dpi and equals the
source's sheet for sheet (`33011, 24021, 0, 69335`), so the tool's promise that
"nothing is drawn on the page" holds — the blank sheet 3 stays at 0.

## Before → after, per case

| case | asked | store written | MuPDF | pypdf |
| --- | --- | --- | --- | --- |
| a range from sheet 2 | `2-3 roman 1` | ~~`/Start 1 /r`~~ → `/Start 0 /D` + `/Start 1 /r` | ~~`<IndexError>, i, ii, iii`~~ → `1, i, ii, iii` | ~~`'', i, ii, iii`~~ → `1, i, ii, iii` |
| a zero start | `1-2 decimal 0` + `3-4 decimal 1` | ~~`/St 1`~~ → `/St 0` | ~~`1, 2, 1, 2`~~ → `0, 1, 1, 2` | ~~`1, 2, 1, 2`~~ → `0, 1, 1, 2` |
| a zero start, roman | `1-2 roman 0` + `3-4 decimal 1` | `/St 0` (was `/St 1`) | `'', i, 1, 2` | `'', i, 1, 2` |
| a 4-digit start | `1-2 decimal 1000` + `3-4 decimal 1` | `/St 1000` | `1000, 1001, 1, 2` | same |
| 30 sheets, letters | `1-30 alpha 1` | one `/a`, no `/St` | `a … z, aa, ab, ac, ad` — no wrap | same |
| a prefix on one range | `2-3 roman 1 x` + `4-4 decimal 1` | `/P (x)` on that range only | `1, xi, xii, 1` | same |
| `/Info`, annot, link, outline | `1-4 roman 1` | — | `i, ii, iii, iv` | same — and all four kept (title/author/subject identical, 1 annot, 1 link, `First`/`Second`) |
| over a pre-labelled file | `1-2 decimal 1` | `Cover i`+`Cover ii`+`1`,`2` → one `/D` range | `1, 2, 3, 4` | same |
| round trip of the first row's output | `1-1 decimal 1` + `2-4 roman 1` | identical store | identical | identical |

## The two defects, and what the card said

1. **A sheet above the lowest range was in no range at all.** `addPageLabels` wrote the
   range at its own `/Start` and left sheet 1 unaddressed, so both outside readers
   answered *nothing* for it — pypdf an empty label, MuPDF an `IndexError` (its binding
   cannot answer a sheet before the first range) — while the card said
   *"The first 4 pages now read: 1, i, ii, iii"* and the file said
   *"1, i, ii, iii"* only to this app. `§12.4.2` leaves such a sheet to be numbered by
   position, which is exactly `1`; the tool now writes that position as a decimal range
   at `/Start 0` and notes it. The claim is not invented: it is the numbering the
   format already defaults to, spoken in the file.
2. **A zero start was clamped to 1.** `labelDict` wrote `Math.max(1, …)` and skipped `/St`
   when the value was 1, so `1-2 decimal 0` came back `1, 2` under both readers and
   `readPageLabels` previewed the same clamped number. `/St` may be 0 (§12.4.2 only
   defaults it to 1 when absent) and both readers honour it once it is in the file.
   Roman and letter ranges have no zero — both readers show an empty label for a zero
   roman range, and a zero lettered range reads empty under pypdf and `z` under MuPDF —
   so the card says which styles that affects and previews the stored 0.

Also fixed on the copy: the replacement of an existing numbering is now counted on the
card (*"Replaced the 2 label ranges it already had."*) and standing-noted, since
`addPageLabels` deletes the store rather than merging.

## Controls

* sheet 1 above the range is **not** roman (`1`, not `i`), and a run starting at sheet 1
  writes no lead range at all
* the second range's `/St 1` stays unwritten (the format's default) while the asked-for
  `0` is written
* the prefix stays on the range that named it — the neighbours read `1`, `1`
* the ink of all four sheets is unchanged, and the blank sheet reads 0
* the round trip re-reads and re-writes the same store, sheet for sheet
* running over an unlabelled file writes no lead range it did not need

## Left open, measured

* no browser viewer shows page labels in headless Chromium — the PDF plugin does not
  mount and `--screenshot` on a `file://…pdf` times out — so the reader side is MuPDF's
  `get_label` and pypdf's `page_labels` only, not a toolbar. The app's own preview is
  position-based (`Page 1 of 4`, thumbnails `1`–`4`), which is what the card's "nothing
  is drawn on the page" note says.
* `/St` negative (the parser takes `\d+` only) is untested here; the readers interpret a
  negative `/St` as floor-by-position (`-2` → `cmxcviii, cmxcix, '', i`), not as `-2`.
* a range with `none` and a start number writes an `/St` no reader uses; harmless, left.
