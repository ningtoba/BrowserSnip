# A4 requests — changes needed in files this worker does not own

Nothing here blocks A4: each item names the workaround currently in place, so the
reviewer can judge whether to do it properly or leave the workaround.

## 1. `src/components/tools/pdf/edit/CropMain.tsx` — expose what it drew

`CropTool` now measures the open document itself (`openPDF` → MediaBox, `/Rotate`,
page count) because `CropMain` shares only `getCropRect()` (fractions of the
displayed page) and `getPageSizePt()` (the **rotated** viewport size of page 1).

Requested API, so the panel can stop re-opening the file:

- `getCropPage(): { index: number; rotation: 0|90|180|270; boxWidthPt: number; boxHeightPt: number; numPages: number }`
- clamp `_cropRect` fractions inside 0–1 where it is written (the drag handler can
  push a margin past the opposite edge, which today yields a negative CropBox).

Current workaround: `edit/cropModel.ts` does the fraction→point re-aim for all four
rotations and `CropTool` opens the document once per file change (first 60 pages).
Cost: one extra `openPDF` per document switch.

## 2. `src/components/tools/pdf/security/{SignMain,RedactMain}.tsx` — reset on document change

Both keep their marks in module-level state (`_state.items`, `_state.redactions`)
with `_pageW/_pageH` left at whatever the last preview measured, so switching
documents leaves the previous file's marks on screen (E19). The panels now filter
the stale entries (`editor/placement.reportMarks` / `clampPageNumber`) and refuse to
send them, but the honest fix is for the mains to clear their state when
`useFileStore.file` changes identity (name + size + lastModified, as
`editor/workspace.documentKey` computes it).

Also requested: `SignMain` should re-clamp existing items when the measured page
becomes smaller than they are, instead of leaving them off-paper.

## 3. `src/lib/pdf-engine/commands.ts` — `cropPages` writes what it is told

`page.setCropBox(l, b, pw - l - r, ph - b - t)` has no clamp: over-cropping produces
a zero-or-negative-width CropBox, which most viewers render as a blank page while
the tool reports success (E13). Either clamp to a minimum kept area or throw.
`CropTool` currently disables its primary action for those inputs, so no bad number
is sent from that panel — other callers can still send one.

Rotation is the second half of the same problem: `cropPages` measures margins
against the MediaBox, while every on-screen crop is a fraction of the **rotated**
display. `cropModel.marginsInPoints` compensates in the panel; doing it in the
engine (read `/Rotate`, swap axes) would fix it for any future caller.

## 4. `src/lib/pdf/core/guard.ts` (A1) — one page-range parser

`edit/cropModel.resolveTargets()` re-implements a tolerant `1-3,5,all` parser with
per-token refusals because A1's `parsePageRanges` is not landed yet (and cannot be
imported without coupling the panel to a moving API). When it lands, delete the
local parser and keep only the rotation maths.

## 5. `src/lib/pdf/engines/EngineGate.tsx` — a way to open settings from anywhere

`text-editor/pageAdvice` wants to offer "load the optional engine" when a page's
only editable text is an invisible OCR layer (E10/E20). `EngineSettingsDialog` is
rendered per-component with local state, so `TextEditor` mounts its own instance.
A one-line global opener (context action or a `CustomEvent` the shell listens for)
would remove that duplicate.

## 6. `tests/pdf/annotation-editor.test.ts` — owned elsewhere, touched by A4

The empty editor now also renders quick-mode chips and a grouped palette. That file
asserts `screen.getByTitle(meta.hint)` for every tool, which is why palette buttons
keep `title={meta.hint}` verbatim (the key badge is a separate `<kbd>` and
`aria-keyshortcuts`). Please do not add the shortcut to the title text: it breaks
that assertion.

## 7. `src/components/tools/pdf/forms/**` does not exist

A4's ownership list names a `forms/` directory, but the form surfaces live in
`src/components/tools/pdf/edit/{FormFillMain,FormCreatorMain}.tsx` (registry ids
`form-filler`, `form-creator`) plus `tools/edit.ts` field definitions — all owned by
other workers. No form code was changed by A4; if the form panes need the same
treatment (grouped inspector, honest "this PDF has no fields" empty state, E13),
that work should be re-assigned to whoever owns `edit/Form*Main.tsx`.
