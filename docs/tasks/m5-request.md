# M5 → other surfaces

M5 owns `src/components/tools/pdf/shared/**`, `hooks/usePdfTool.ts`,
`stores/process-store.ts` and `tests/pdf/ux-rail.test.ts`. These four things sit
just outside that boundary and undo what the rail now does. Nothing here is
blocked on me; the rail works without them, it just says it twice.

## 1. `layout/ToolWorkspace.tsx` draws a second, contradicting progress bar

While `isProcessing`, the main pane renders `components/ui/ProgressBar.tsx`
(ToolWorkspace.tsx:258-262). That bar is media-pipeline shaped:

- it always prints `progress.toFixed(0)%` and a determinate width, so a PDF tool
  that has not reported a denominator shows **"Processing… 0%"** directly under a
  rail that honestly says *"Reading the file — no time estimate yet"*;
- it repeats the same run the rail is already reporting, so one job has two bars
  with two different stories.

Ask: for PDF tools (`definition` present) drop that bar and let the rail's
`ProgressBar` + `RunStatus` carry it, or gate it on `currentProgress` (the
ffmpeg fields) which is the only thing it can truthfully render.

## 2. The same file shows the error twice, once raw

ToolWorkspace.tsx:264-283 paints a "Could not finish" toast with the bare
`{error}` string while the rail paints an `ErrorPanel` for the same value — with
the file name, the guard layer's hint and a Retry. The toast is the one place a
`TypeError: …` can still reach the user, because
`shared/ErrorPanel.tsx#readableMessage` is only applied inside the panel.

Ask: either remove the toast for PDF tools, or render it through
`readableMessage(error)` and keep the rail's panel as the actionable copy.
Cancelled runs no longer set `error` at all (they set `notice`), so this toast
cannot fire for a cancel any more.

## 3. The header's "Process" button is a second primary action with no reason

ToolWorkspace.tsx:304-317 renders `Process` in the page header, and
`triggerProcess` (ToolWorkspace.tsx:162-164) fires the rail's button by id:
`document.getElementById('tool-process-btn')?.click()`. While the rail's action
is disabled — no file that fits, a required field still empty, a page range past
the end — clicking `Process` clicks a disabled button and **nothing happens**:
no reason, no focus move, no message. It also never carries the tool's verb, so
the same job is called "Compress" in the rail and "Process" above it, which is
the exact pattern the brief lists as E18. Two cheap fixes: render it only when
the rail would enable its own action (and label it with `verbFor(tool)`), or drop
it now that the sidebar is gone and the rail is the whole chrome.

## 4. Bespoke surfaces should take the shared queue and card

`organize/**` (M3) and `security/{Sign,Redact,Compare}Tool.tsx`,
`edit/CropTool.tsx`, `scan/**` (M4) still hand-roll their file rows, their
bars and their result lines. `shared/FileQueue.tsx` now carries per-file page
counts, stage names, an indeterminate bar when nothing was measured, a named
failure with Retry, ≥28 px position controls and a `progressNote` for estimated
multi-file progress; `shared/ResultCard.tsx` carries pages in → out, the size
delta, the growth notice (E14) and the counted warning list. Reaching for them is
cheaper than re-deriving the same five states per surface.

## 5. `lib/pdf/tools/*.ts` (M6): summary lines that promise a shape

Several tools return a fixed `message` describing what they *meant* to do
("Smaller now.", "Compressed to …"). `usePdfTool` now puts `result.message` in
the card instead of the last progress stage, and `ResultCard#honestSummary`
refuses a shrink claim when the bytes grew — but the cleanest fix is upstream: a
tool that cannot know its own delta should return no message and let the numbers
speak, and a tool that returns `files` should say how many pages it touched.
