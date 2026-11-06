# B1 requests — changes needed in files this worker does not own

B1 owns `src/lib/pdf/tools/organize.ts` and `tests/pdf/edge-organize.test.ts`
(47 tests, all passing; `registry.test.ts` and `tools-e2e.test.ts` also pass;
`tsc --noEmit` is clean). Nothing below blocks B1: each item names the
workaround currently in place inside `organize.ts`.

## 1. `src/lib/pdf/core/doc.ts` — `drawPageInto` flattens page geometry (E8, E9)

`drawPageInto` embeds the source page and scales it by `getWidth()/getHeight()`,
which are **pre-rotation MediaBox** dimensions. It never reads `/Rotate` and
never looks at `/CropBox`, so every caller draws a `/Rotate 90` scan sideways
into a box computed for the sheet as displayed, and a page with a non-zero
MediaBox origin is clipped by the wrong rectangle. That is the "tools accept
inputs they cannot honour" complaint, in the primitive itself.

`organize.ts` now uses a local `stamp()` that does three things `drawPageInto`
does not:

* clips with `embedPage(source, {left,bottom,right,top})` against the page's
  **crop box in its own coordinates** (so an offset MediaBox is not shifted);
* composes the turn — `rotate: -(pageRotation + requestedClockwiseAngle)` —
  because `/Rotate` is clockwise and pdf-lib's content matrix is counter-clockwise;
* offers `fit: 'contain' | 'exact' | 'stretch'` (custom-angle rotation needs
  1:1-with-crop, `fix-page-size` needs non-uniform stretch).

**Request:** promote that helper (or an equivalent) into `core/doc.ts` /
`core/pages.ts` and re-express `drawPageInto` on top of it, so `edit`,
`security` and `convert-*` stop inheriting the geometry bug. Until then B3/B4/B5
should be told not to trust `drawPageInto` for rotated sources.

## 2. `src/lib/pdf/tools/helpers.ts` — results cannot carry warnings

`pdfResult(doc, options)` and `filesResult(files, message)` build a
`ToolResult` with no `warnings` slot, so every B worker re-spreads the object
(`{ ...result, warnings: notes.warnings }`) to satisfy the brief's
"report the compromise through `result.warnings`".

**Request:** add `warnings?: string[]` to `PdfToolOutputOptions` and a third
parameter to `filesResult`, so the honesty path is one call, not a spread.

## 3. `src/lib/pdf/tools/runner.ts` — page-count-aware validation never runs

`validateFields` only checks a `pages` field when `values.pageTotal` is present
(`core/guard.ts` line ~864). The rail supplies it
(`shared/toolForm.ts` `checkFields`), `runPdfTool` does **not** — it already
inspects every file in `preflightPdf`, so the page count is known before the
run. Today a value like page 9 of a 3-page file reaches the tool and is caught
there (B1 re-checks with `pageRangeProblem` inside `selection()`).

**Request:** put `pageTotal` (or a per-file array) into the bag the runner
validates, so E6 is blocked before the click on every path, not just the panel
path.

## 4. `src/components/tools/pdf/shared/toolForm.ts` — verb/promise tables

All 21 organize tools now name their own `actionLabel` and `promise`, so
`VERB_BY_ID` and `PROMISE_BY_CATEGORY` are pure fallbacks for this category.

**Request:** keep them as fallbacks and do not add per-tool entries for
categories that have declared their own; `edge-organize.test.ts` asserts the
organize set never resolves to `"Run"` or to a category blurb.

## 5. `src/components/tools/pdf/organize/*` — two writers, one field (A4)

`PageOrganizer.tsx` publishes `params.pageOrder` as the string grammar
(`3, 1r90, blank`, plus `f2:3` for multi-file plans) while
`OrganizeMain.tsx` / `OrganizeTool.tsx` publish a **0-based `number[]`**, which
the registry parser used to ignore silently — a reorder from that pane produced
an unchanged document.

`organize`'s `run` now accepts both shapes, expands `2-5` ranges, honours `r0`
(straighten), keeps a page's own `/Rotate` when no `rNN` is given, and refuses
`f2:3` tokens with an explicit `UNSUPPORTED` message ("organizing works on one
document at a time").

**Request:** pick one value shape; if multi-document plans are wanted, give
`organize` `multiFile: true` and a source-aware plan, otherwise drop the `f…`
prefix from the pane's serialiser.

## 6. Test environment — pdf.js cannot start a worker here

`openRender` fails under vitest/jsdom (`Setting up fake worker failed: …
Received protocol 'http:'`, even with `GlobalWorkerOptions.workerSrc` pointed at
a `file://` URL), so `remove-blank-pages` and `pdf-to-cbz` have no byte-level
test in B1's file — they are covered by the rail-contract block only.

**Request:** a shared helper (legacy `pdfjs-dist` build, or a `file://` worker
configured in `tests/setup.ts`) so render-dependent tools in every category can
be tested for real.
