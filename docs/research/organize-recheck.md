# `organize` — re-audited on this build (sweep/organize, `:5292`, 2026-11-25)

Four probes, all against a live Chromium tab on this worktree's dev server:
`organize-campaign.mjs` (geometry + per-card ink + a real HTML5 drag + `r`/`b`
keys + export), `organize-gestures.mjs` (drag, keyboard carry, shift-range
multi-select rotate, duplicate group, insert blank, delete via a card's own
button, undo, undo, redo, export), `organize-open-items.mjs` (a pre-rotated sheet
turned once and straightened, the outline/annotation carries, the second-file
behaviour), and the new `organize-plan-export.mjs` (type a `pageOrder` into the
field, Apply, read the grid back, Save, take the bytes).
Judged by `organize-campaign-bytes.py` (order by each sheet's first text line, the
`/Rotate` the plan token names, blanks asserted to carry no text and no ink) and
PyMuPDF.

## Defect 1 — the plan field refused the grammar its own help advertises (fixed)

The field's help says *"a range like 2-5"* and the registry's `parsePlan` accepts
ranges, spaced ranges (`2 - 5`), `2--5`, `2..5`, `2–5` and `;` separators. The
pane's own reader (`plan.ts::parsePageOrder`) knew only single page tokens, so
typing `4-6, 1, blank, 2r90` — the example this round typed into the live field —
came back

> "4-6" is not a page token. Use 3, 3r90 or blank — f2:3 pulls page 3 of the second file.

…while the footer line directly above the field promised *"This is the pageOrder
value the tool registry parses, so the sidebar field and this grid always agree."*
It did not: the registry would have run that plan; the pane refused it and left the
grid painting the untouched default order, and `Save reordered PDF` could not be
pressed at all (`save ready? false`, no bytes). A `2 - 5`, `2..5`, `2–5` or `1;3`
plan failed the same way, and a range that ran off the end or backwards answered
the generic "not a page token" instead of naming the page or the way round.

Fixed in `plan.ts`: the same fold the registry applies (`-{1,2}`, `–`, `..`,
spaces → `-`), `;` as a separator, a range expanding over each page it names with
the turn computed **per page** from that page's own `/Rotate`, both ends bounds-checked,
and a backwards range refused with `Write 2-4r90 to go forwards`.

Measured after the fix, live: type `4-6, 1, blank, 2r90` → the grid repaints
`pg4 pg5 pg6 pg1 blank pg2`, the status announces *"Loaded the plan from the page
order field. Plan is 6 output pages."*, the field re-publishes itself as
`4, 5, 6, 1, blank, 2r90` (the same plan, expanded), Save writes 3030 bytes, and
the reader agrees: `FILE: FOUR@90, FIVE, SIX, ONE, blank, TWO@90` —
*OK: the exported file is the plan the grid held*. Re-run at a 1 s and a 20 s settle
with the same bytes; `f2:3` with one document open still refuses truthfully
(*asks for file 2, but 1 PDF is open*).
Red without the fix: `tests/pdf/page-organizer.test.ts` → **3 failed** (`"2-4" is
not a page token`, `"2–4" is not a page token`, `"1-3r0" is not a page token`);
with it, 321 passing across the four organize/pane files.

## Defect 2 — the campaign's reader judged rotation the wrong way round (fixed)

`organize-campaign-bytes.py` compared `source /Rotate + the token's number`. The
grammar is absolute — `planToPageOrder` writes `r<n>` as the `/Rotate` the output
must carry, and the tool's own note says `r0` straightens a page — so the reader
failed two *correct* exports: a `595×420 /Rotate 90` sheet turned once in the grid
(card: *"turned to 180 degrees"*, token `4r180`, file `/Rotate 180`) was reported
as `file 180, source 90 + plan 180 = 270`, and the straightened one (`4r0` → file
0) likewise. Instrument-first check: after the fix the reader still fails when it
must — a plan claiming `4r270` over that file reports
`FAIL page 4: rotation — file 180, plan wanted 270 (the token says r270)`, and
swapping two tokens in the org6 plan reports both order mismatches.

## Verified on this build (measured, unchanged)

* **Geometry** (the last round's defect): at a 1280 px viewport the grid is
  672 px, the `role=listbox` 638 px, each card 168 px across 3 columns, no card
  overflowing its grid, the plan field not clipped (547 of 549 px used).
* **Per-card ink off the bitmap**: 18.3 / 18.3 / **0** / 18.8 / 18.2 / 18.0 %
  non-white — the third card is the blank sheet and paints nothing, the fourth is
  the quarter-turned sheet and paints landscape (`box [132,93]`).
* **Gestures**: drag (with the `→ 4` gap badge and *"Moved org6.pdf page 6 to
  position 4. Plan is 6 output pages."*), keyboard carry, shift-range multi-select
  rotate (*"Rotated 90° clockwise 3 pages."*), duplicate, blank insert, delete via
  a card's own `✕` button, undo, undo, redo — and the exported 10-sheet file is
  that plan, sheet for sheet, with the inserted blank carrying no text and no ink
  and sized like the page beside it (`595×420` after a turned sheet), and a bare
  `4` keeping the source page's own `/Rotate 90`.
* **The carries**: `bookmarked.pdf` → all 3 outline entries re-pointed;
  `annot.pdf` → 3 annotations + 1 link on the sheet they live on; ink of an
  untouched sheet identical to the source at 72/110/150/300 dpi (`49571 / 114792 /
  212099 / 845370`).
* **Second file**: `input.multiple true`, the drop becomes a source (`sources 2`,
  a second tab, `Use as base`), the published plan qualifies as
  `f2:1, f2:2, …`, and the pane says out loud that only its own Save can build
  that plan because the sidebar Run reads the first file alone.
* No console error in any run.

## Defect 3 — measured, left open: the theme button throws the plan away

With a typed plan on screen (`pg4 pg5 pg6 pg1 blank pg2`, 6 cards, 5 of them
painted), pressing the header's own ☀/☾ button reverts the grid to the document's
default order — `pg1 pg2 pg3 pg4 pg5 pg6`, typed plan gone, no announcement, and
in the run that started in dark the grid came back empty (`save ready? false`, no
bytes). Nothing in the pane promises a theme switch keeps an unfinished plan, so
this is recorded rather than papered over: the cause is the pane re-seeding on the
re-render (the `sync`/`seededFor` pair in `PageOrganizer.tsx` ~359-380) and a fix
belongs with whoever owns the plan-restore decision, not to this round's scope.

Network half: no organize run uploaded a byte (the export path is
`URL.createObjectURL` in the tab; `net-check.mjs` measured the same surface's
siblings at `biggestForeignUpload: 0`).
