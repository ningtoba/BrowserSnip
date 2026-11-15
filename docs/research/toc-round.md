# `table-of-contents` — round 039

Two geometry defects, both measured on the produced file in a real Chromium tab
before anything was touched. Everything else in the checklist below held in both
states and is recorded so the next pass need not re-run it.

Driver: `docs/research/colour-rail.mjs` (single-run form) against the dev server
`:5271`, every field written the way a user's event reaches React and read back
out of the DOM before the click. Judge: PyMuPDF on the download — page boxes,
text spans, `/Annots` rects, `get_toc()`, per-page non-white pixels at 60 dpi
against the same source page measured the same way.

Fixtures: `/tmp/triage/in/bookmarked.pdf` (3-entry outline, 4 sheets),
`/tmp/triage/colour.pdf` (the same 4 sheets with no outline — the triage spec's
own pick for this tool), and four built from `colour.pdf`'s dense first sheet:
`spill.pdf` (40 sheets, 60 entries), `one.pdf` (40 sheets, 1 entry), `long.pdf`
(12 over-long titles), `stress.pdf` (5 sheets, `/Info`, a highlight annot and a
URI link on sheet 1, an inset `/CropBox [40 40 380 555]` on sheet 2, three
bookmarks, a `/PageLabels` range).

## Defect 1 — the contents was laid out in the crop frame and drawn on a media-frame sheet

`generateTocPage` took the sheet size from `/MediaBox` and the margins from
`/CropBox`, then drew at absolute crop coordinates on the freshly inserted page,
which carries no `/CropBox` at all.

`stress.pdf`, `insertAt=2`, sheet written:

| | sheet | leftmost text x | number right edge | highest text top |
|---|---|---|---|---|
| before | 420 × 595 | 88.0 pt | 332.0 pt | 86.8 pt |
| after | 340 × 515 | 48.0 pt | 292.0 pt | 46.8 pt |

So every entry sat 40 pt right and 40 pt up inside a sheet 80 pt wider than the
page it was copied from; the visible margin was 88 pt where the body's is 48.
After: the sheet **is** the source's visible box (48 pt margin on all four edges),
which is what its neighbours show.

## Defect 2 — the link covered the title and nothing else

Same run, `/Annots` rect widths per row: **25.2 / 32.4 / 24.2 pt** before,
**244.0 / 244.0 / 244.0 pt** after. The page number sits at the right margin, so
242–279 pt of every row — the leader and the number, the two things a reader aims
at — was dead to the click while the card promised "clickable links to the
outline it reads". The rect now runs from the entry's own x to just past the
number and still one line high (15.9 pt, not the page).

## Held, both states

* Insertion point: `insertAt=3` of 40 puts the contents at sheets 3–5, `insertAt=2`
  of 5 at sheet 2, `insertAt=21` of 40 at sheet 21; `insertAt=99` is clamped to the
  last sheet with a warning.
* Every entry, its dot leader (`[1 2.5] 0 d`, 0.4 pt, grey) and its number are in
  the inserted page's own text layer.
* **Numbering is right after insertion** — the classic off-by-N is not here.
  60/60 entries on `spill.pdf` print the sheet their own link lands on (entry 1 →
  1, entry 3 → 6, entry 60 → 23) and the source outline is renumbered the same
  way (`1, 2, 6, … 23`); 3/3 on `bookmarked.pdf` (`2, 3, 5`); 1/1 on `one.pdf`
  (21 → 22). Links `/GoTo` the same sheets, `/Dest` and `/A` agreeing.
* Spill: 60 entries at 11 pt fill three sheets (23 / 23 / 14), each continuation
  page opening with the heading; the 38 body sheets past the insert point read
  **46995 px each, identical to the source**, so the spill overwrites nothing.
* One entry on 40 sheets: one page, number 22, one link.
* Over-long titles clip with `…` at the margin and never reach the number.
* Refusal on a source with no outline (`colour.pdf`): the tool stops with "This
  PDF has no bookmarks to build a table of contents from. Add them with Edit
  Bookmarks first.", `STOPPED`, no download — the spec's own fixture for this
  tool is refused, and correctly so.
* `/Info` kept (`one.pdf` title), 1 annot + 1 link on the body sheet kept, the
  source outline kept and re-pointed.
* Dark mode on tokens only, the paper left white (`shots/039-toc-pane-dark.png`).
* Result card counts equal the file (4 → 5, 40 → 43, 5 → 6 pages) and name the
  sheet and the listing length.

## Left open, measured

* `/PageLabels` are not consulted: on `stress.pdf` the reader shows `A-3` for the
  sheet the contents calls `4`, and MuPDF/pypdf answer `A-1 … A-6` for the store.
  The note ("numbered against the finished document") is true of the file, and
  the mapping to a label style is a product decision.
* The page label store is also copied unchanged, so the inserted sheets join the
  existing range and are numbered like body pages (`A-2` for the contents sheet).

## Red without the fix

`tests/pdf/edit-bytes.test.ts`, `bookmarks.ts` stashed: **2 failed / 2 passed**
("lays the contents inside the visible box of the sheet it copies" → 420 × 595 vs
340 × 515; "makes the whole row the link …" → 76.1 pt against 546.8). 0 failed
with it; 3255 passed / 1 skipped over the full suite.
