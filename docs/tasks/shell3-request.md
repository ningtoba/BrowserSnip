# shell-3 → owners: what the iLovePDF-parity pass needed outside its own files

Context: the task shape landed (intake → ready → running → result). This pass took
the four polish items on it: the duplicated one-line promise, the dead band above
the intake button, the options bar that ate ~40% of the viewport once a file was
loaded, and the result screen's `20 in · out not counted` lie.

Files this pass owns: `src/components/tools/pdf/shared/**`,
`layout/ToolWorkspace.tsx`, `layout/AppLayout.tsx` (`ToolPageHeader` only),
`hooks/usePdfTool.ts`, `stores/process-store.ts`, `lib/pdf/tools/runner.ts`,
`tests/pdf/ux-task-shell.test.tsx` — plus, by request, the `pages` field on
`ToolResult` (`lib/pdf/tools/types.ts`) and its one fill site in
`lib/pdf/tools/helpers.ts`.

## 1. The page header stopped printing the promise (done here)

`ToolPageHeader` said `definition.description` while the page below it said
`promiseFor(tool)` — the same sentence twice in two wordings, e.g. Merge PDF:
"Combine multiple PDFs into one file, with bookmarks for each source" over "One
PDF with every file's pages in your order, plus a bookmark to each source". The
header now keeps the breadcrumb, the tool name and the Star, and the sentence
lives once with the action it describes: in `FileIntake` while empty and in the
loaded page's heading. `docs/tasks/shell2-request.md` item 3 asked for exactly
this; it is done, so that item can be struck.

Because the header was the only place some **bespoke** panes said anything, the
promise moved rather than disappeared: `ToolWorkspace` now renders it in the pane
column (`[data-tool-promise]`) for every surface that is not the generated page,
including the video tools. `tests/pdf/ux-task-shell.test.tsx` ("the promise")
pins one sentence on an empty page, one after a file loads, and one on a bespoke
editor before and after the drop.

## 2. `inspectPdf(..., { cheap: true })` cannot give a page count — do not re-derive one

The brief for the produced-page-count said "count from the produced bytes via
`inspectPdf(..., { cheap: true })`". Two facts in the code make that impossible,
and the second is the interesting one:

- `guard.ts:439` — the cheap branch returns before any parse, with the `base`
  object's `pages: 0` and `declaredPages: null`. Only the full-parse branch
  (guard.ts:461) ever fills a page count in.
- `core/doc.ts:161` — `savePDF` defaults to `useObjectStreams: true`, so this
  app's own PDFs carry the page tree **inside a compressed object stream**. A
  saved 8-page merge contains no plaintext `/Type /Pages` and no `/Count` at all
  (checked by dumping the bytes): a header/trailer string scan can only answer
  "not found".

The count is therefore taken from the document the producer is already holding
(`ToolResult.pages`, filled by `helpers.pdfResult`), which is exact and free, and
the runner carries it to the store and the result card.

**Ask:** the cheap branch's docstring ("Skip the parse and report header/trailer
facts only") reads as if a page fact were among them. Please make it say plainly
that a cheap inspection reports **no** page count — `pages: 0` means "not read",
not "empty document" — so the next person does not try to build a counter on it.

**Still open, deliberately:** a run whose bytes were never a document we held —
the cpdf and Ghostscript paths, and the ~37 `{ kind: 'pdf', bytes: … }` literals
in `security.ts` (14), `optimize.ts` (12), `edit.ts`, `convert-to.ts`,
`convert-from.ts` and `legacy.ts` — reports no count and prints "N in · out not
counted". Two ways to close it, in order of cost: set `pages: doc.getPageCount()`
at each literal (one line per site, and most of those files already hold the
document), or implement the fallback that reads `/Count` out of the inflated
`/Type /ObjStm` in the trailer region. The second is real work against our own
container format, which is why it was not taken while the first was available.

## 3. The options bar is one row, and it can block from inside the fold

`OptionsPanel` used to unfold every field at once. Measured at 1440×1150 with
`pdf-compress` (twelve fields): the bottom bar was **457 px — 40% of the
viewport — and is now 177 px** with one field and a `9 more options` disclosure.
On Merge it was 265 px and is 140 px. The row shows `leadField`
(the field the run is waiting on, then the required-and-empty one, then the one
the user changed, then the first) plus a `N more options` disclosure. Validation
is not hidden by the fold: an invalid field behind it puts `· N needs attention`
on the disclosure (`data-options-attention`) and keeps the CTA off with its
reason line; expanding is a native button and collapsing returns focus to it.

`FileCards` also stopped printing `WAITING` on a loaded, readable file — the card
is not in a job, and the word claimed one. It says `Reading` until the pre-flight
lands and `Ready` after. `FileQueue`'s `rowStage` keeps `Waiting` for a file
queued behind one that is running, which is what `tests/pdf/ux-rail.test.ts`
asserts.

## 4. Tests outside this pass's ownership that had to move

Each encoded the old shape rather than a rule; none was deleted.

- `tests/pdf/ux-rail.test.ts` — "says which preset is chosen": clicks the
  disclosure before touching the preset, because the bar now shows one field.
- `tests/app/shared-ui.test.tsx` — "promises the outcome first and groups the
  fields once a file exists" and "keeps what the user typed and shows the clamp
  reason beside it (E15)": same, one expand click each. The group headings and the
  second field still have to be reached through the fold.
- `tests/app/shell.test.tsx` — "shows the breadcrumb and the tool name, and stops
  there": it asserted the header prints `tool.description`, which is the
  duplicate this pass removed. It now asserts the description is *not* in the
  header and that the star and the name still are.

## 5. What the screenshots still show wrong

Judged on `BASE=http://localhost:5199` at 1440×1150 with a real PDF:

- **The ready page has a dead band in the middle.** The cards sit high (right),
  the bar is pinned at the bottom, so with one or two files ~35% of the page is
  empty background. iLovePDF fills that by putting the CTA directly under the
  list; our verb is pinned by design. Either the ready pane needs something in
  that band (per-file page previews, the sibling-tool row) or the bar stops being
  pinned for short queues.
- **The intake's oversized button is a solid accent block** with 88 px of fill and
  white text. It reads heavier than iLovePDF's, which is a dashed outline with a
  coloured icon. That is `doodle-btn` — a design-language question, not this
  pass's, but it is the first thing on the page.
- **A long file name has no middle ground.** `truncate` gives
  "quarterly-report-2024-…nding.pdf" and the card is 212 px wide, so the name and
  the numbers beside it are the least legible part of the loaded page.
- The expanded panel is 265 px tall on Merge because the page picker paints a
  thumbnail strip. That is opt-in, so it was left alone, but a tool whose lead
  field is a `pages` picker still grows when opened.
