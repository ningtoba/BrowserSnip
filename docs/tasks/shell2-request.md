# shell-2 → owners: changes the drop-first page shape needs in files I do not own

Context: the tool page shape was rebuilt to iLovePDF's order — centred title +
promise + one oversized drop button while empty, then horizontal file cards with
the options in a bottom bar and one big verb at its right edge, then a dedicated
result screen. The rail is gone for schema-driven tools (`ToolWorkspace` now hands
those pages to `PdfToolPanel` → `ToolSurface`). Bespoke surfaces (`edit-pdf`,
`edit-pdf-text`, `organize`, `sign`, `crop`, `scan`, `redact`, `compare`, the form
editors) keep their editors but open on the same intake and finish on the same
result screen.

Copy and components that still describe the old layout:

1. **`src/lib/pdf/tools/runner.ts:114`** — the `minFiles` blocker's hint is
   `'Add the missing document in the panel on the left.'`. There is no panel on
   the left on a generated page; the files live in the card row under "Your
   files", and the add-more card / page-wide drop are how a file gets there.
   Suggested: `'Add the missing document — the add-more card sits beside the files.'`
   `paneClause()` (the "or from its own editor pane" suffix) is still true for the
   bespoke surfaces, so it only needs the location phrase revisited.

2. **`src/components/tools/pdf/editor/AnnotationEditor.tsx:2338`** —
   `Or drop one in the panel on the left.` inside its own empty state. The editor
   no longer mounts until a file exists, so that branch is now only reachable
   after a document is already open (or from a compact layout). Either delete the
   line or point it at the page: the whole tab is the drop target.

3. **`src/components/layout/AppLayout.tsx` — `ToolPageHeader`** prints the tool
   name in the breadcrumb and `definition.description` as a subline directly
   above a page that now prints its own `<h1>` title and one-line promise. The
   page reads as two stacked headers saying nearly the same thing. Suggested:
   keep the breadcrumb and the star, drop the description subline (the promise is
   on the page), and leave the tool name only in the breadcrumb so the page owns
   the single `<h1>`.

4. **`src/components/ui/FileDropZone.tsx`** — still hard-codes `border-[#B9B9AF]`
   (a hex literal, and invisible against `html.dark`'s panel colour) and re-lists
   the chosen files with plain "Remove" rows. Bespoke panels and the video tools
   still use it, so it cannot simply be deleted. Suggested: take
   `src/components/tools/pdf/shared/FileIntake.tsx` (`useIntake`) and
   `shared/FileCards.tsx` as the replacement once someone owns the editors, and
   until then swap the two `#B9B9AF` utilities for `border-cream-border`.

5. **Nobody owns `src/components/viewer/ThumbnailStrip.tsx` / `PDFViewer.tsx` in
   this pass** — they are no longer mounted for schema-driven tools (the cards
   carry the first-page preview and the page picker carries the rest). They are
   still mounted for bespoke panels and for any PDF tool that keeps a rail, so
   nothing was deleted. If a later pass confirms no surface mounts them, they and
   `usePDFRenderer` can go.

Nothing here blocks the current build: all five are copy/dead-chrome cleanups, and
the tests in `tests/pdf/ux-task-shell.test.tsx` assert the new shape only.

Note for whoever takes the bespoke panels next: `shared/FileQueue.tsx` (the stacked
row list) is no longer mounted by any surface — the generated pages use
`shared/FileCards.tsx` and the bespoke panels still list their documents
themselves. It stays exported and covered by tests, so it can be deleted in the
same change that moves `CompressTool`/`SignTool`/`RedactTool`/`CompareTool`/
`CropTool`/`ScanTool` onto `FileCards`.
