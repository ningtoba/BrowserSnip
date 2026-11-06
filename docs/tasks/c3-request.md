# C3 requests — changes needed in files this worker does not own

C3 owns `src/lib/pdf/core/doc.ts`, `src/lib/pdf/core/compress.ts` and
`tests/pdf/edge-geometry-core.test.ts` (23 tests, green; `tools-e2e`,
`edge-organize`, `edge-edit`, `annotations`, `signature`, `edge-convert-to` and
`edge-security` also pass, and `tsc --noEmit` is clean). Nothing below blocks C3:
each item names the seam that is now available and who has to move.

## 1. `docs/PDF-ENGINE-CONTRACT.md` — the frozen `core/doc.ts` row is stale

The row lists `drawPageInto(target, page, source, box, {scale, rotate, opacity})`
and `pdfVersion(doc)` and nothing else from this change. Please add (C3 did not
edit the contract because the brief makes it a shared file):

* `pageRotation(page) → number` — the page's own `/Rotate`, normalised to a
  clockwise 0–359.
* `setPdfVersion(doc, PdfVersion) → string` — raises the version the document
  declares, never lowers it, returns what it now declares.
* `applyPdfVersion(bytes, PdfVersion) → Bytes` — raises the `%PDF-M.m` line of
  **saved** bytes in place (same width, so no xref offset moves).
* `type PdfVersion = '1.4' | '1.5' | '1.6' | '1.7' | '2.0'`.
* On `drawPageInto`, one sentence: the source is measured per page from its own
  visible box, its `/Rotate` is composed with the requested **clockwise** extra
  turn, and the turn goes around the box's own centre (E8, E9).

## 2. `src/lib/pdf/tools/optimize.ts` (B2) — the two B2 requests have landed

* **B2 item 1.** `versionWarning()` can become the fix. Two facts the caller has
  to respect, both pinned by `edge-geometry-core.test.ts`:
  * a **full** `save()` always writes `%PDF-1.7` — the fork's `PDFWriter` and
    `PDFStreamWriter` call `PDFHeader.forVersion(1, 7)` and ignore
    `context.header`. So the sentence "this file declares PDF 1.4 but object
    streams need 1.5" is describing the *input* header (`pdfVersion(doc)` reads
    the parsed one), not the file being downloaded; as written it promises a
    mismatch that a full rebuild cannot have.
  * an **append-only** revision (`saveIncremental`, used by the signature path)
    copies the original bytes verbatim, so there the 1.4 header really does ship.
    That is the case `setPdfVersion` + `applyPdfVersion` exist for:
    `applyPdfVersion(bytes, '1.5')` after the save, or `setPdfVersion` before it
    to keep `pdfVersion(doc)` honest.
  Related, and worth a decision above B2's grade: `saveIncremental` in this fork
  appends the revision but its xref section carries only the free entry and
  `/Size` bump — objects created after `takeSnapshot()` are **not** written, so
  `openPDF(saveIncremental(doc))` reports the pre-edit page count (verified with
  PyMuPDF on a two-revision file). C3 left the behaviour alone; the append path
  belongs to `core/signature.ts`.
* **B2 item 2.** `CompressReport.rebuildBytes` is the size the rebuild produced
  even when `bytes` is the untouched input, so the E14 headline can say "the
  rebuild would have been X from Y" instead of "the original came back".
  `report.notes[0]` already carries both numbers when the original wins; the
  tool's own sentence should use the field rather than the note.

## 3. `src/lib/pdf/tools/organize.ts` (B1) — `stamp()` can shrink

`drawPageInto` now does the two things B1's request asked to be promoted:
it clips to the source page's **own visible box in its own coordinates** (so an
offset `/MediaBox` is shifted, not cropped) and it composes
`pageRotation(source) + requested clockwise angle` around that box's centre,
negated for pdf-lib's counter-clockwise content matrix. What `stamp()` still
keeps, and what C3 deliberately did **not** add because no core caller needs it:
`region` (arbitrary sub-crop), `fit: 'contain' | 'exact' | 'stretch'`, and the
`boolean` "this page had no content stream" answer — `drawPageInto` throws
`MissingPageContentsEmbeddingError` instead of returning `false`. If B1 wants
those three in the primitive, say so and C3's owner can add them; otherwise the
rotation/origin half of `stamp()`'s body is now redundant and its docstring
("comes out sideways … unless the stamp undoes both") no longer describes
`drawPageInto`.

Note the sign convention: `drawPageInto`'s `rotate` option is now an **extra
clockwise** turn (it used to be passed straight to pdf-lib, which turns
counter-clockwise). B1's `stamp()` already takes clockwise `angle`, so `r90` /
`r0` tokens keep working either way.

## 4. `src/lib/pdf/core/layers.ts` + `src/lib/pdf/core/pages.ts` — one spelling of `/Rotate`

`page.getRotation().angle` is re-normalised in at least eight places
(`core/pages.ts:178`, `core/measure.ts:361`, `core/metadata.ts:679`,
`core/bookmarks.ts:1067`, `core/flatten.ts:170`, `core/convert.ts:229`,
`tools/organize.ts:230`, `tools/edit.ts:72`) and `core/layers.ts` never reads
`/Rotate` at all, which is why a watermark on a turned page still needs its own
math. `pageRotation(page)` is the shared spelling.

One constraint for whoever moves it: `core/doc.ts` now imports `cropBox` from
`core/pages.ts`, so **`pages.ts` must not import `doc.ts`**. If `pageRotation`
belongs in `pages.ts` (it fits the module better), it has to be defined there and
re-exported from `doc.ts`, not the other way round.

## 5. Not a request — what E8/E9 coverage now exists

`tests/pdf/edge-geometry-core.test.ts` measures the composed
`/Matrix ∘ CTM` out of the saved file, and cross-checks two of the cases against
an independent renderer (PyMuPDF) while writing them: a 200 × 100 `/Rotate 90`
sheet with a 30 pt strip on its own left edge must land as a 100 × 30 band on the
**top** of the cell (it did, and the pre-fix primitive put it as a sideways
100 × 50 band in the middle), and a `[36 36 236 136]` scan must keep its far
corner, which the old `[0 0 200 100]` clip threw away.
