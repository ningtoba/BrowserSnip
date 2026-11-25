# Seam wave 2D — display↔user mapping-site census

Date 2026-11-26. Scope: every site in `src/**` that converts coordinates between
**DISPLAYED space** (the rotated sheet a viewer shows / a pane paints — top-left
origin unless noted) and **stored user space** (MediaBox/CropBox, bottom-left), or
performs rotation-sensitive size/orientation math in the same family.
Grep seeds: `viewerRectToUserSpace|userSpaceToSvgMatrix|viewerSizeOf|pageFrameOfView|reduceRotation|getViewport|getRotation|pageRotation|quarterTurn`, hand-rolled quarter-turn arithmetic (`% 180 === 90`, `case 90`, `swap`, rotation matrices), `convertToPdfPoint/convertToViewportPoint`, plus an independent scout census cross-checked line-by-line against this one.

Mapper families:
- **T** = `core/tables.ts` shared family (`viewerRectToUserSpace` :599, `userSpaceToSvgMatrix` :662, `viewerSizeOf` :575, `pageFrameOfView` :684, `quarterTurn` :569)
- **M** = `text-editor/model.ts` matrix form (`viewerToUserMatrix` :96 — documented as the matrix form of T's table; forward map verified equal to T by closed form this pass)
- **pdf.js** = `PageViewport.convertToViewportPoint/convertToPdfPoint` or full-viewport raster (pdf.js owns the math)
- **private** = hand-rolled quarter-turn math local to the file
- **n/a** = rotation-sensitive but not a display↔user mapping (size swap, raster, content transform, read-only)

## The table

| # | Site | Direction | Mapper | Converged? / why not |
|---|------|-----------|--------|----------------------|
| 1 | `src/lib/pdf/core/tables.ts:575,599,662,684` (`viewerSizeOf`, `viewerRectToUserSpace`, `userSpaceToSvgMatrix`, `pageFrameOfView`, `quarterTurn`) | both (rect/size/SVG) | **T** — canonical family | — (this IS the mapper; proven 0.8 pt exact by wave 2B) |
| 2 | `src/lib/pdf/core/ocr.ts:256,329,334,533` — OCR line/word boxes onto the sheet | display→user + size | **T** | YES (wave 2B). Result consumers (`tools/convert-to.ts`, `tools/edit.ts`) stay in user space — no screen re-map exists |
| 3 | `src/lib/pdf/tools/security.ts:874` (redact-pdf run) — marks → deletable rects | display→user rect | **T** + local `frameOf` :2135 (PageFrame *builder*, not a competing mapper) | YES |
| 4 | `src/lib/pdf-engine/commands.ts:~810-895` `drawSignatureMarks` — sign-pane mark fractions/sizes → painted content | display→user rect + upright turn | **T** + 4-corner anchor table for pdf-lib's rotated-draw anchor + displayed-up-axis baseline lift | YES — **this wave (2D)**. RED pin `tests/pdf/sign-placement.test.ts`; live rig `legacy-pane-cards.mjs sign-turned` lands at drag point, upright; rotate-0 byte-identical |
| 5 | `src/lib/pdf/core/convert.ts:230,1547,1562,1576` (JSON display size; page→SVG frame + `<g>` matrix) | size + user→SVG/display | **T** (`viewerSizeOf`, `pageFrameOfView`, `userSpaceToSvgMatrix`) | YES. `core/convert.ts` is wave-2C's file — recorded, untouched here |
| 6 | `src/components/tools/pdf/edit/FormFillMain.tsx:480-486` — widget `/Rect` → HTML overlay | user→display | **pdf.js** `convertToViewportPoint` | n/a — pdf.js is the mapper; no private math to retire |
| 7 | `src/components/tools/pdf/edit/FormCreatorMain.tsx:415-422` — field drafts ↔ overlay | both | **pdf.js** `convertToPdfPoint`/`convertToViewportPoint` | n/a — same |
| 8 | `src/components/tools/pdf/editor/geometry.ts:121-165` `viewportToPdfPoint`/`pdfToViewportPoint` (+ `pageSize` swap, `screenToPdfRect`/`pdfToScreenRect` corner re-bounds, `markScreenRotation`; zoom folded in) — the annotation editor's entire placement surface | both (point/rect) | **private** quarter-turn tables; rows equal T's map by closed form EXCEPT they never add the box origin `x0/y0` (`PageGeom` :42-50 carries no origin field) | NOT converged — correct on zero-origin sheets, **misregisters pages whose CropBox/MediaBox origin ≠ 0** (latent, second defect member). Consumer fix would flow to `specs.ts:1113-1129`, `AnnotationEditor.tsx`, `AnnotationOverlay.tsx:199,229` — one change at the table retires all three |
| 9 | `src/lib/pdf/core/annotations.ts:2171-2178` `stampBox` (display size of an annot rect), `:2188-2200` `uprightMatrix` (appearance-stream turn compensation), `:2395-2415` burn-page raster turned back (`rotationMatrixForImage`) | size + orientation (within /Rect / appearance frame) | **private** quarter-turn matrices; `uprightMatrix` is the appearance-stream sibling of #4's rotate compensation | NOT substitutable — no viewer rect crosses these; they live inside the annotation appearance box. Family recorded |
| 10 | `src/lib/pdf/core/bookmarks.ts:1434-1451` `stampOrigin` (+ caller :1551 with `displayedSize`) — page-numbering stamps anchored on the **visible** sheet | display(**y-from-bottom**)→user point | **private**; rot90 `(W−dy_b, dx)` is T's map composed with the one y-convention flip its caller makes — equal by closed form | NOT converged — bottom-origin point API T doesn't expose; no measured defect |
| 11 | `src/components/tools/pdf/edit/cropModel.ts:71-92` `marginsInPoints` (+ `DISPLAYED_TO_STORED` :94, `targetPage` :346-360 size swap; consumers `CropTool.tsx`, `CropMain.tsx`) | display→stored, per-EDGE | **private** corner table of edges | NOT representable as one rect map (four edges, not a box; the honesty sentence names each displayed→stored edge). Same family, different arity — keep |
| 12 | `src/lib/pdf/tools/edit.ts:87-98` `frameOf`, `:101-106` `toUserSpace`, `:110-121` `toUserRect`; consumers :213,:525,:877,:1027 (`placeRun`) | display(**y-from-bottom**)→user point/rect | **private**; equivalent to T under that convention by closed form (rot90 `(W−dy_b,dx)` ✓) | NOT this wave — dispatcher ruled #4 routes through T, not edit.ts's pair; fold when its owner takes it |
| 13 | `src/components/tools/pdf/text-editor/model.ts:96-127` `viewerToUserMatrix`/`viewerBoxToUserSpace` (+ `objectMatrix` :147, `textMatrixForRun` :177, `imageMatrix` :196, `rotateBoxAboutCenter` :214); consumers `draw.ts:138,683,797`, `TextEditor.tsx` | display→user (matrix/rect) | **M** — matrix form, documented inverse of T's table (cross-checked in `tests/pdf/text-editor.test.ts`); needed for `Tm`/`cm` composition (reflection folded so glyphs stay det +1) | PARTLY — forward is converged-by-equivalence. `model.quarterTurn` :87 is a pure-rename dupe of `tables.quarterTurn` and `viewerBoxToUserSpace` re-implements T's re-bound; fold both when the text-editor is next open |
| 14 | **DEFECT (latent)**: `src/components/tools/pdf/text-editor/draw.ts:798-809` `userRectToBox` (used :708 → patch boxes re-mapped by #13's `viewerBoxToUserSpace` at :731) | user→display claimed, actually user→**something else** | applies **M forward as if it were its own inverse**; verified by closed form: equals the true inverse only at `x0=y0=0` and rot ∈ {0, 90, 180}; **wrong for /Rotate 270** (uses W/H where H/W belongs) and **wrong at every rotation when the box origin ≠ 0** | NOT converged (not 2D's file). Consequence: the paper patch over an undeletable leftover word lands off the word it hides on those sheets. `invertMatrix` already sits unused in `model.ts:135` — the fix is one call. Flagged to text-editor owner via this census |
| 15 | **DEFECT (latent)**: `src/lib/pdf/tools/organize.ts:394-409` `displayRegion` (n-up / split-page tiles, :2666,:2757) | display→user rect | **private**; rot 0/90/270 rows equal T's map by closed form; **rot 180 y-term disagrees**: it returns `y0 + H − ty − th` where the correct term (pdf.js spec derivation, MuPDF-render-confirmed this pass: ink stored at user 700-800-from-bottom on a /Rotate 180 sheet paints at display rows 700-800-from-top, i.e. `py = uy`) is `y0 + ty` | NOT converged (organize is not 2D's file). Effect: the 180° split cuts the band mirrored about the horizontal centre on non-square sheets. Flagged to organize owner |
| 16 | `src/lib/pdf/core/pages.ts:199-211` `displayedSize` (consumers `measure.ts:387`, `bookmarks.ts:1541`) | size-only | **private** size swap + crop∩media intersection | NOT converged — T's `viewerSizeOf` swaps but does not intersect CropBox∩MediaBox (the §14.11.2 rule pdf.js uses), which `displayedSize` must keep; fold only if T grows that semantics |
| 17 | `src/lib/pdf/core/signature.ts:995-1012` `installSignatureField` widget `/Rect` | (mapping owed, absent) | none — anchors the visible widget 36 pt inside the **stored** top-left via `page.getWidth()/getHeight()` (rotation-blind, verified in `node_modules/@maxwbh/pdf-lib` PDFPage.js) | DEFECT-CANDIDATE (ask, not assume): on /Rotate 90/180/270 sheets the field shows in a different corner than "top-left" and its appearance reads turned. Intent (stored corner vs displayed corner) should go to the digital-sign owner — per project memory, expected behavior is asked, not invented |
| 18 | `src/lib/pdf/core/content.ts:3843-3848` `rotateInPlaceMatrix` (+ `appearanceTurn` :3873) | user→user content transform | n/a — no displayed frame crossed | not in class (recorded to close) |
| 19 | `src/lib/pdf/core/pack.ts:116` `const swap` | — | n/a — declared then `void swap;` (deliberate) | not in class; the void mark says the author knew. Ambiguous intent for `placeImage(rotate)` — ask the pack owner rather than delete |
| 20 | `src/lib/pdf/core/render.ts:340-345,640-700` (renderPage `rotation:` , thumbnails `turned`/`turnedBox`/`turnCanvas`) + `src/lib/renderer/core.ts:47-107` + `src/lib/pdf/core/blank.ts:153` | raster/display space | **pdf.js** viewport + raster-space geometry | n/a — every rect stays inside one raster frame; no user-space crossing |
| 21 | `src/lib/pdf-engine/commands.ts` `comparePDFs`/`diffCanvas`/areas (:990-1040) | device-px raster → display points | raster (÷scale); `/Rotate` carried inside pdf.js rasters of both files equally | n/a — correctly frame-pure (both inputs are displayed sheets; user space never entered) |
| 22 | Pane measurement sources + in-frame flips: `SignMain.tsx:145-155,266-270,370-398`, `RedactMain.tsx:245-263`, `RedactTool.tsx:45-49` (display y-flip `pageHeightPt − (y+h)` — display↔display, not user), `CropMain.tsx:79-81`, `CompareMain.tsx:442-449`, `PreviewPane.tsx:116,352-361,480`, `PageThumbs.tsx:132,335`, `TextEditor.tsx:431,2080,2378`, `organize/preview.ts:33-36` `swapsAxes` | measure **displayed** sheet only | **pdf.js** viewport or plain size swap | YES-by-design — these define the display-space contract; the class rule is that the ENGINE side maps (rows 2-5), which is what wave 2D restored for sign |
| 23 | Read-only rotation uses (no mapping): `metadata.ts:1362`, `optimize.ts:2579`, `organize.ts:257,1483,1507`, `workspace.ts:617-621`, `measure.ts:391`, `cropModel.ts:61` `normaliseRotation` | — | — | not in class |

## Class verdict

- Sites that turn a **pane-drawn box into painted/changed content**: #2 OCR, #3 redact,
  #4 sign, #5 SVG/JSON, #6/#7 forms (pdf.js), #13 text-editor (matrix form M ≡ T).
  After this wave all of them map through a shared, spec-derived table — the sign
  break was the last live member of the "pane measures displayed, engine converts
  against stored" defect and it is closed RED→GREEN with a byte pin plus the live
  turned-page rig.
- Private-but-equivalent tables (#8 rows, #10, #11, #12, #15 rows 0/90/270, M) verified
  equal to T by closed form this pass — none is a duplicate *defect*; each kept for a
  stated reason (bottom-origin y convention, edge arity, zoom folding, matrix
  composability).
- **Three open members, none inside wave-2D ownership** — handed to the roster by
  this census: (a) `draw.ts userRectToBox` wrong-inverse (#14, fix = existing
  `invertMatrix`), (b) `organize.ts displayRegion` rot-180 y-term (#15, MuPDF-proved
  against the pdf.js-derived table), (c) `geometry.ts` tables missing the box origin
  (#8) and `signature.ts` stored-corner widget anchor (#17, intent ask).
- Fold list for a future tidy: `model.quarterTurn` → `tables.quarterTurn`;
  `model.viewerBoxToUserSpace` → `tables.viewerRectToUserSpace`; give T a point form +
  a bottom-origin variant to retire #10/#12/#8 tables; T's `viewerSizeOf` could grow
  the crop∩media rule to retire #16.
- Cross-check reconciliation: an independent scout census contributed #14, #15, #17,
  the `RedactTool` flip and `frameOfPage`/`frameOf` builder classifications, and the
  pdf-lib rotation-blindness of #17's `getWidth()`; two of its equalities were
  refined by closed-form + MuPDF re-derivation (its "displayRegion cross-checked
  equal" holds only for rot 0/90/270; the 180 y-term disagrees).

# Wave 2D — item 5 side-record (SignTool image/png)

Charter premise checked against this revision (master `be2e383` + wave 2D commits):
the sign pane's draw pad (`SignTool.tsx`) has **no quality slider** — its controls
are text/font/colour/width, upload file + w/h, draw + w/h. So the PNG hardcode
(`toBlob(..., 'image/png')` at :174/:236, `toDataURL('image/png')` :239,
`mime: 'image/png'` :304) moots nothing. Consequences as they stand: an uploaded
JPEG signature is decoded and re-encoded **lossless PNG** (bigger bytes, zero
quality loss — matching Q3's deployed-site note "container drop, no promise
attached"); the engine's `embedImageBytes(..., format: 'png')` agrees with what
the pane sends. The separate annotation-editor pad
(`editor/SignaturePad.tsx:95-98`) exports JPEG at a hardcoded 0.92 — also no
slider. **No fix attempted**: switching SignTool to JPEG-with-quality would
LOWER fidelity for no requested gain and change shipped byte shapes; adding a
slider is new scope. Nothing the sign tool promises (`promise`/`notes` in
`tools/legacy.ts` `sign`) mentions quality or file format. Verdict:
side-record only — the premise did not survive measurement.

# Gate record (step 6)

- `npx vitest run` — full repo: **150 files, 3863 passed, 13 skipped, 0 failed** (32.2 s).
- `npx tsc -p tsconfig.tests.json --noEmit` — clean (last src change preceded it; only docs commits followed).
- eslint: inert repo-wide (no flat config committed on master).
- Live: `legacy-pane-cards.mjs SCENARIO=sign-turned` lands at drag point, upright, post-fix; other pages' content streams byte-identical pre/post; rotate-0 live control unchanged; `compare-pdfs`/`sign`/`pdf-crop` routes load in Chromium with zero page errors (the lib→component import bundles fine).
