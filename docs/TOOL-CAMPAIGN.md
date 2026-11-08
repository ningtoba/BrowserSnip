# TOOL CAMPAIGN — one tool per agent

The queue for auditing every tool against the live build. One row per tool, one
agent per tool, no agent touches a file it does not own.

**The rule.** A tool is verified only by measuring **what the user sees, and what
the file contains.** Both halves or neither:

- **browser evidence** — a real Chromium tab against a live dev server (started
  *detached*: `(nohup npx vite --port 52xx --strictPort >/tmp/xx.log 2>&1 &)`),
  a screenshot of the tool holding real content, and ink measured **off the
  canvas bitmap** — never inferred from a node count or a reported total.
- **a byte-level check of the exported file** — open the download with PyMuPDF
  and measure what the file itself draws (`get_pixmap` ink vs. the untouched
  source), not merely that an object exists in it.

A green unit run is neither half. Every assertion written around this area so far
has been about **counts and presence** — blocks extracted, marks added, objects
written — and never about output. That is the same shape as the markup bowtie,
the vacuous image compression and the zero-ink link: `edit-pdf` once shipped a
`area=0` mark with 1,400 passing tests. The symptom was real; the tests were
blind.

**Status** — `unexamined` → `defect-found` → `fixed+deployed` → `verified-good`.
A row may only reach `verified-good` with both evidence halves recorded.
`blocker:` in the last column means the true cause sits in a shared module the
tool's owner must not edit without a decision; the fix is sequenced, not
improvised.

Harness beside this file: `research/audit3-cdp.mjs` (CDP driver),
`research/audit3-sweep.mjs` (canvas ink + exported bytes),
`research/audit3-bytescan.py` (file-side measure),
`research/text-campaign-repro.mjs` (edit-pdf-text: load → open block → export →
dump the content stream), `research/text-campaign-dark.mjs` (same, dark mode),
`research/organize-campaign.mjs` (organize: geometry, per-card thumbnail ink, a
real HTML5 drag with the gap indicator read mid-flight, the export captured from
`createObjectURL`), `research/organize-campaign-bytes.py` (compares that file
with the plan the grid held — order by first line per sheet, rotation as
*source /Rotate + the plan's turn*, blanks asserted empty; exits 1 on any
mismatch, so it is a check and not a printout).

| tool | status | cause / evidence | owner seam |
| --- | --- | --- | --- |
| `edit-pdf-text` | fixed+deployed | **Blank page whose words were still selectable.** Canvas measured `opaque 0 / ink 0` of 500 395 px while the pane reported `20 text block(s)`; `edit-pdf` measured `100 % / 1.08 %` on the same build (`docs/research/shots/campaign-text-before-1-loaded.png` vs `campaign-text-1-loaded.png`, `…-before-2-block-open.png` shows the overlay's `#000000` fallback colour painting over a page with nothing under it). Cause: `core/render.ts` `renderToCanvas` copied pdf.js's intermediate canvas **before the render task had painted** and then cancelled that task — one `await` short. After the fix the same measurement is `opaque 500 395 / ink 5 407`, dark mode included, and the `RenderingCancelledException` is gone. **The exported file was never blank** — on-screen only. Its content stream carries `… 0 Tr … <glyphs> Tj` with an opaque fill, and PyMuPDF rasterises "Talently Self-Assessment" at `[48, 75.6, 279.6, 102.9]`, 20 900 dark px in that strip. The fill was the `#000000` fallback, because `readPalette` was sampling a transparent canvas; with the page painted the same block exports in the document's own `#18181b`. Fix `694e007`, ledger `d6439a9`, CI green on `42458236025`, and the **deployed** site re-measured after the push: `https://www.browsersnip.com/#/tool/edit-pdf-text` → `opaque 100 % / ink 1.08 %` with no console error — the same probe that read `0 / 0` is what the report was about. | `text-editor/**` + `core/render.ts` (shared — editing it approved by the parent, 2025-11-08) |
| `organize` | fixed+deployed | **Two layout defects, both live on the deployed site; the plan itself was byte-exact.** (a) The action toolbar and the honesty lines were *siblings of the grid* inside one `lg:flex-row`, and the toolbar is `shrink-0`, so it kept its content width. The deployed page at a 1280 px viewport measured **grid 24 px, `<ul role="listbox">` 0 px, cards 152 px** — one clipped column beside 717 px of empty toolbar strip (`docs/research/shots/campaign-organize-1-deployed-24px-grid.png`); 1920 px gave 561 px / 3 columns, and only below `lg`, where the container stacks, did the plan get width (578 px / 3). Fixed in `90ba2ab`: the wide strips moved above a row that holds only `[grid, tray]`, and the grid took `min-w-0` — a flex item's default `min-width: auto` is what let one 152 px card hold the column open. Re-measured **672 / 868 / 1288 px in 3 / 5 / 7 columns** at 1280 / 1500 / 1920, cards inside their container. The `clientWidth` that sizes the grid is the same number `renderWindow` derives `columns` from, so a long plan was also mounting one column's worth of cards. (b) `.doodle-btn` and `.doodle-input` are both `w-full` (`index.css`), so in a flex row the button's 100 % base *is* the row and a `flex-1` field only grows into free space that never exists: **the plan-order field measured 26 px holding 130 px of plan string** (24 px of client width — one character of `1, 2, 3, 4, 5, 6`) and the tray's page-range field 26 px holding `1,3,5-7`, while their own Apply/Insert buttons measured 578 px and 188 px. Fixed in `b1ff891` (`w-auto shrink-0 px-3` on the buttons, `min-w-0` on the fields) → 549 px and 106 px, nothing clipped. Both are pinned structurally, because jsdom has no layout to measure: the row may hold nothing but the grid and the tray, and no `w-full` button may share a row with a field. **The whole gesture list, re-run on the deployed site** (`docs/research/organize-gestures.mjs`, `BASE=https://www.browsersnip.com`): drag `→ 8` landed at 8, keyboard carry `Space · → · → · Space` moved page 1 to 3, a Shift-range rotated 3 pages at once, `D` duplicated the group in order, `B` inserted a blank, the card's own ✕ removed one page, `Ctrl+Z` twice and `Ctrl+Shift+Z` once walked the plan back and forward, and the download read back as `OK: the exported file is the plan the grid held` against `2, 3r90, 1r90, 4r90, 3r90, 1r90, 4r90, blank, 5, 6, 7, 10, 8, 9` — 14 items, order compared by each sheet's own first line, rotation as source + turn, the blank checked empty of text *and* of ink — with no console error. **Re-measured on the deployed site after the push** (`https://www.browsersnip.com/#/tool/organize`, 1280 px, `docs/research/organize-campaign.mjs`): `gridPx 672, listPx 638, 3 columns, cardOverflowsGrid false, planFieldPx 549 (clipped false), trayFieldPx 106 (clipped false)`, thumbnails painted 14.9–21.6 % non-white, a real drag whose badge read `→ 4` landing at position 4, and `organize-campaign-bytes.py` answering **OK** for the plan `1r90, blank, 2, 3, 6, 4, 5` — CI green on `42460263860`. Measured and sound, so the next pass need not redo it: **the paint class does not reach this surface** — its only previews come from `thumbnails()`, which awaits `page.render().promise` itself, and per-card non-white coverage on a loaded document is 6.2–31.6 % of the thumbnail bitmap against pdf.js's own render at the same 0.157 scale (5.29 %, 17.06 %, 19.24 %), and the same probe run against `https://www.browsersnip.com` returned the same figures card for card (15, 17, 17, 15, 22, 16 % on the 6-page fixture); **the exported file is the plan the grid held** — a 6-page fixture carrying `/Rotate` 0/90/180/270, a landscape sheet and a link annotation, driven by real drags and keystrokes to `1r90, 6r90, 2r90, 1r90, 2r90, blank, 3, 4, 5`, exported 9 pages with every sheet in its planned slot, **rotation written as source + turn (90 + 90 → 180; 270 + 90 → 0)**, the blank at position 6 empty (0 non-white px) and sized like the neighbour it follows, mixed media boxes kept, `/Annots` copied; a 60-page plan exported 61 pages, order checked token by token. The gap indicator tells the truth — badge `→ 26`, line "position 26 of 60", landed at 26 — and keyboard carry, Shift-range, `Ctrl+Z`/`Ctrl+Shift+Z`, the per-card buttons and the tray's "Used here: n of N" all reported the state they painted. Dark mode renders the same grid in tokens (`cardBg rgb(27, 27, 24)`; no hex literal survives in `src/components/tools/pdf/organize/`). Left open, measured, and belonging to a decision rather than to this row: (1) the pane writes a **turn** into `params.pageOrder` and `organize`'s `parsePlan` reads an **absolute `/Rotate`** — for a page whose own `/Rotate` is 90 the grid previews 180, `Save` writes 180 and the tool writes 90 (`1r90` measured → `[90, 0, 0, 0]`), and the serialiser also drops a zero turn, so a "straighten" cannot reach the tool at all; unreachable in the app today because a bespoke surface mounts no rail form (the organize page's only buttons are the pane's own — `docs/tasks/b1-request.md` §5 already asks which side moves); (2) `Save` rebuilds into a new document, so a 2-entry outline comes back empty and a `/D [page /Fit]` goto resolves to the first sheet instead of the one it named — silently, while the rail's `organize` warns about both in `noteRebuildLoss`; (3) the tool declares no `multiFile`, so `input[type=file].multiple === false` on the route (measured deployed) and a second PDF is dropped without a word, which makes the source tabs, "Use as base" and the `f2:3` grammar unreachable while the pane's own empty state promises "every other file becomes a source you can pull pages from". | `organize/**` |
| `pdf-to-cbz` | fixed+deployed | **A CBZ of six identical blank sheets, reported as a success.** The organize pass measured the archive's own bytes (`docs/research/cbz-bytes.mjs` → unzip → PIL): a 6-page fixture with a noisy embedded photo on the odd pages, 40 lines of text and a coloured band painted last on every page, produced `6 pages rendered at 200 dpi into 3.4 KB` and six JPEGs of **23 690 bytes each, 0.00 % non-white pixels** — identical because identical: nothing was painted into any of them. Reproduced on the deployed site and on the dev server, no console error. Cause: `rasterizePages` (`core/render.ts:519-540`) encodes `render.canvas` straight after `renderPage()` settles, and `renderPage` settles when the task is *scheduled* — the pixels arrive on `render.finished`, which this helper never awaits, then `render.cancel()` runs. It is sequenced item 1 below, arriving by bytes rather than by screen. Adding the one missing `await render.finished` in the same environment turned the same archive into 293 KB / 818 KB per page and 6.97 % / 23.45 % ink, alternating exactly with the fixture's photo pages — the cause, not a plausible theory. **Fixed at the cause in `6b9b479`**: one `await render.finished` in `rasterizePages`, granted narrowly by the parent (`pdf-to-cbz` is its only caller). The test double was why no test saw it — its `renderPage` returned no `finished` at all, so nothing could encode too early; it now models the ordering (the canvas is unpainted until `finished` resolves, and the encoder hands out an inked or a blank PNG), and `pdf-to-cbz`'s test compares the archived bytes against the inked sheet instead of counting entries. Red without the await, green with it. | `organize/**` + `core/render.ts` (one line, approved by the parent this run) |
| `deskew-pdf` | defect-found | **Two stacked defects, found because the CBZ one showed what an unawaited canvas costs.** The measurement is `detectSkew` (`core/measure.ts:434-448`), which reads `render.ctx.getImageData` straight after `renderPage()` settles — the same missing `await render.finished`. Deployed site, a one-page fixture whose 40 lines are tilted a uniform 3° (`docs/research/rail-tool-bytes.mjs`): the run reported *“Nothing to do: no page was tilted past 10° at a confidence of 0.35”*, and the file agreed with itself — every text line still at `-3.0`, and a projection profile over the rasterised pixels still peaks at `-3.0°`. Adding the one missing `await` locally made the measurement real (`Straightened 1 page(s): 1 (-2.95°)`) — and the page came back at **-5.95°**: turned the wrong way, doubling the tilt. So the await alone trades a silent no-op for a visible regression; the angle reaches `applySkew` (`tools/optimize.ts:355`) with the wrong sign, and that is the defect the paper actually shows. Neither file belongs to this pass, so the row is opened rather than fixed. | `blocker:` `core/measure.ts` (await the paint) **and** `tools/optimize.ts` (turn the other way) — and the row's test must measure the angle in the file, not the angle in the report line |
| `edit-pdf` | verified-good | Audit #3 (`research/edit-pdf-audit.md`): 17 tools' canvas ink and exported bytes measured; the three defects found are fixed in `0ea6eac`, `9d6ef0b`. | `editor/**` |

## Two standing rules, both discovered by this campaign rather than assumed

1. **A test double that omits a contract cannot catch a bug in it.** The
   `renderPage` double in `edge-organize.test.ts` returned no `finished` property
   at all, so a helper that never awaited the paint looked fine and 1,875 tests
   stayed green over a CBZ of blank pages. A double has to model the *ordering* —
   nothing inked until `finished` resolves, inked after — not just the shape, and
   `finished: Promise.resolve()` is the same blind spot with better manners.
   Where it still stands: `convert-to-bytes.test.ts:99`, `edge-convert-to.test.ts:81`,
   `edge-edit.test.ts:104`, `edit-bytes.test.ts:117` and `ux-text.test.ts:97`
   return no `finished`; `edge-optimize.test.ts:128` and `pages-out.test.ts:77`
   return one already resolved. Each belongs to its own tool's row, where the
   bytes can say whether it matters.
2. **Blank output is silent.** No console error, no exception, a plausible file
   size, and a report line true about everything except the pixels — six
   identical 23 690-byte JPEGs passed an “is this a PNG” check. So an ink
   assertion belongs in every rasterising tool's test: compare the archived
   bytes (`organize-campaign-bytes.py`, `cbz-bytes.mjs` measure non-white
   coverage out of the real download), never the byte count.
3. **A helper is a defect only where a tool reaches it.** `rasterizePages` had
   one caller and it was a shipped tool, which is what made this user-facing.
   `core/measure.ts` keeps four more unawaited canvas reads: `isBlankPage`,
   `rasterizeWithOptions` and `scannerEffect` have **no caller anywhere in
   `src/`** — dead with a known flaw, left alone — while `detectSkew` has a live
   tool behind it (`deskew-pdf`, its own row above) and `applyColorFilter` is
   reached only by `pdf-to-greyscale`'s raster fallback, which the operator path
   answered before reaching on the fixture tested here.
   A broken helper nobody reaches is a maintenance note, not a defect.

## Sequenced from the `edit-pdf-text` row — not fixed there

1. **13 call sites read a `renderPage` canvas without awaiting `finished`**
   (`grep -rn "await [^)]*renderPage(" src/ | grep -v core/render.ts | wc -l`):
   `core/measure.ts` (`isBlankPage`, `detectSkew`, the rasterise pair),
   `core/ocr.ts`, `tools/{convert-from,edit,optimize,security}.ts`,
   `edit/{FormCreatorMain,FormFillMain}.tsx`,
   `editor/AnnotationEditor.tsx:2766`. They race the same paint the text editor
   lost; several look healthy only because image encoding yields to the event loop
   long enough for pdf.js to catch up. None is measured here — each belongs to its
   own tool's row, where the bytes can be checked. (`thumbnails()` renders through
   `page.render` itself and is not affected.)
2. **`shared/PreviewPane.tsx` is imported by nothing in `src/`**
   (`grep -rln PreviewPane src/` → only itself; its only consumers are
   `tests/pdf/ux-rail.test.ts` and `tests/app/shared-ui.test.tsx`). Dead code with
   a live-looking name: agents keep reasoning about the UI as though it were
   mounted. Cleanup candidate for a layout pass — **do not delete it here**, since
   whether something is still expected to mount it is a layout question.
3. **A rewritten block lands ~6 pt above the run it replaced** — original span
   bbox top `81.6`, the file's rewritten top `75.6` at the same 20 pt size. Screen
   and file agree (both come from `model.layoutBlock`), so it is placement
   accuracy, not invisibility. P2, text-editor's own seam.
