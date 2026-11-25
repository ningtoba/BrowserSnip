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
| 8 | `src/components/tools/pdf/editor/geometry.ts:121-165` `viewportToPdfPoint`/`pdfToViewportPoint` (+ `pageSize` swap, `screenToPdfRect`/`pdfToScreenRect` corner re-bounds, `markScreenRotation`; zoom folded in) — the annotation editor's entire placement surface | both (point/rect) | **private** quarter-turn tables, now origin-aware: `PageGeom` carries the pdf.js `view` box origin (`x0/y0`), the forward map adds it, the inverse subtracts it, `clampRectToPage` clamps against the crop | YES — **wave 2E**. Was: rows equal T by closed form EXCEPT they never added the origin, drifting marks by exactly the offset on CropBox-offset sheets (measured 45 pt on a (30,45) crop, pre-fix). Producers (`AnnotationEditor.tsx` geom memo + burn path) read `pageProxy.view[0]/[1]` — the same value pdf.js paints with. Pin `tests/pdf/annotation-geometry-origin.test.ts` (node env, **real pdf.js** as oracle): matches `convertToViewportRectangle`/`convertToPdfPoint` on a cropped+turned sheet for all four rotations, at zoom 0.75/1.5/2, round-trips, equals T, and reads the census fixture `/tmp/triage/in/annot.pdf` p8. 11/12 RED without the terms; the uncropped control stays byte-identical. Consumers (`specs.ts`, `AnnotationOverlay.tsx`) needed no change — one change at the table retired all three, as predicted |
| 9 | `src/lib/pdf/core/annotations.ts:2171-2178` `stampBox` (display size of an annot rect), `:2188-2200` `uprightMatrix` (appearance-stream turn compensation), `:2395-2415` burn-page raster turned back (`rotationMatrixForImage`) | size + orientation (within /Rect / appearance frame) | **private** quarter-turn matrices; `uprightMatrix` is the appearance-stream sibling of #4's rotate compensation | NOT substitutable — no viewer rect crosses these; they live inside the annotation appearance box. Family recorded |
| 10 | `src/lib/pdf/core/bookmarks.ts:1434-1451` `stampOrigin` (+ caller :1551 with `displayedSize`) — page-numbering stamps anchored on the **visible** sheet | display(**y-from-bottom**)→user point | **private**; rot90 `(W−dy_b, dx)` is T's map composed with the one y-convention flip its caller makes — equal by closed form | NOT converged — bottom-origin point API T doesn't expose; no measured defect |
| 11 | `src/components/tools/pdf/edit/cropModel.ts:71-92` `marginsInPoints` (+ `DISPLAYED_TO_STORED` :94, `targetPage` :346-360 size swap; consumers `CropTool.tsx`, `CropMain.tsx`) | display→stored, per-EDGE | **private** corner table of edges | NOT representable as one rect map (four edges, not a box; the honesty sentence names each displayed→stored edge). Same family, different arity — keep |
| 12 | `src/lib/pdf/tools/edit.ts:87-98` `frameOf`, `:101-106` `toUserSpace`, `:110-121` `toUserRect`; consumers :213,:525,:877,:1027 (`placeRun`) | display(**y-from-bottom**)→user point/rect | **private**; equivalent to T under that convention by closed form (rot90 `(W−dy_b,dx)` ✓) | NOT this wave — dispatcher ruled #4 routes through T, not edit.ts's pair; fold when its owner takes it |
| 13 | `src/components/tools/pdf/text-editor/model.ts:96-127` `viewerToUserMatrix`/`viewerBoxToUserSpace` (+ `objectMatrix` :147, `textMatrixForRun` :177, `imageMatrix` :196, `rotateBoxAboutCenter` :214); consumers `draw.ts:138,683,797`, `TextEditor.tsx` | display→user (matrix/rect) | **M** — matrix form, documented inverse of T's table (cross-checked in `tests/pdf/text-editor.test.ts`); needed for `Tm`/`cm` composition (reflection folded so glyphs stay det +1) | PARTLY — forward is converged-by-equivalence. `model.quarterTurn` :87 is a pure-rename dupe of `tables.quarterTurn` and `viewerBoxToUserSpace` re-implements T's re-bound; fold both when the text-editor is next open |
| 14 | ~~**DEFECT (latent)**~~ `src/components/tools/pdf/text-editor/draw.ts:798-809` `userRectToBox` (used :708 → patch boxes re-mapped by #13's `viewerBoxToUserSpace` at :731) | user→display | **M** inverted: `invertMatrix(viewerToUserMatrix(frame))` — the one call `model.ts:135` always exposed but nothing used | YES — **wave 2E**. Was: forward map applied as its own inverse; equal to the true inverse only at `x0=y0=0` and rot ∈ {0,90,180}; wrong for /Rotate 270 and at every rotation when the box origin ≠ 0. Measured pre-fix (re-derived, not copied): round-trip drift 200 pt on rot270 origin(0,0), 60–215 pt on rot ∈ {0,90,270} with origin (30,45). Pin `tests/pdf/text-editor-patch-mapping.test.ts`: rotation battery on the exported mapping + `applyEdits` over a word the engine cannot delete (text in a **direct** form XObject — `commitFormStreams` refuses to rewrite it, so the real `covered` patch path fires) with the painted rectangle read off the produced bytes; 9/14 RED without the fix, rot90/180-at-origin-0 self-inverse cases and the /Rotate 0 control byte-stable. MuPDF judgment: pre-fix patch at user x=−155 (off the sheet, word exposed), post-fix x=60,y=295 dead on the word (eye-checked renders) |
| 15 | ~~**DEFECT (latent)**~~ `src/lib/pdf/tools/organize.ts:394-409` `displayRegion` (n-up / split-page tiles, :2666,:2757) | display→user rect | **private**; all four rows now equal T's map by closed form (rot 180 y-term fixed `y0+H−ty−th` → `y0+ty`; exported as `displayRegion` for the pin) | YES — **wave 2E**. The rot-180 y-term disagreed with the table: the inverse of the /Rotate 180 display map keeps `py = uy` (a half-turned sheet flips left↔right, a band low on paper still shows low), so the tile's y is `y0 + ty`. Ground truth re-derived this pass, matching the census probe: MuPDF rendered ink stored at user y 520-560 on a /Rotate 180 sheet at display rows 39-79 from the top (rot 0/90/270 sweeps agree with T too). Pin `tests/pdf/organize-rot180-divide.test.ts` drives the real `divide-pages` through `runPdfTool` and **MuPDF-renders each produced piece counting dark device pixels**: `[24000, 0]` (band in the displayed-top piece) with the fix, `[0, 24000]` (mirrored) without — 3/4 RED. Table-equality asserted for all four turns + a crop-offset sheet; the square-sheet case records why it hid (the mirror still handed each tile half the page). Effect was: the 180° split cut the band mirrored about the horizontal centre on non-square sheets |
| 16 | `src/lib/pdf/core/pages.ts:199-211` `displayedSize` (consumers `measure.ts:387`, `bookmarks.ts:1541`) | size-only | **private** size swap + crop∩media intersection | NOT converged — T's `viewerSizeOf` swaps but does not intersect CropBox∩MediaBox (the §14.11.2 rule pdf.js uses), which `displayedSize` must keep; fold only if T grows that semantics |
| 17 | `src/lib/pdf/core/signature.ts:1032-1130` `installSignatureField` widget `/Rect` + `/AP` | display→user (rect) + orientation (appearance) | **T** (`viewerRectToUserSpace`/`viewerSizeOf`, row-4 pattern) + the row-9 `uprightMatrix` recipe baked into the appearance stream | YES — **wave 2E** (intent was the open ask; dispatcher ruled: the block must appear where placed, **upright as displayed** — wave 2D's standard). Was: anchored 36 pt inside the **stored** top-left via rotation-blind `getWidth()/getHeight()` with an unturned appearance, so on /Rotate 90/180/270 sheets the block showed in a different displayed corner and read turned (pre-fix MuPDF render: block displayed top-**right**, "Digitally signed by" running down the edge). Now the block is sized/aimed in the displayed sheet and mapped to user space; the stream carries the inverse `cm` with `/BBox` at the stored rect's size. Live-verified: signed files measured through pdf.js `getAnnotations` render the block at displayed x[36,256] y[36,126] on /Rotate 0/90/270 alike, text horizontal (eye-checked pixmap). Pin `tests/pdf/signature-widget-anchor.test.ts` (real crypto, node env): 4/6 RED without the fix; `/Rotate 0` is byte-plain/identity — the existing `digital-sign-bytes` BBox==Rect-size pins stay green |
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
- Private-but-equivalent tables (#10, #11, #12, #15 rows 0/90/270, M) verified
  equal to T by closed form this pass — none is a duplicate *defect*; each kept for a
  stated reason (bottom-origin y convention, edge arity, zoom folding, matrix
  composability). (#8's rows were listed here too, but they were equal **minus the
  box origin** — that turned out to be a latent defect, now fixed with origin terms
  by wave 2E; the tables remain private because they fold zoom and screen px.)
- **The three open members this census handed to the roster are closed — wave 2E
  (branch `fix/seam-wave2e`, one commit per defect, each with a RED-without-fix pin):**
  (a) `draw.ts userRectToBox` wrong-inverse → `invertMatrix(viewerToUserMatrix(frame))`
  (#14, `516056c`); (b) `organize.ts displayRegion` rot-180 y-term → `y0 + ty`
  (#15, `4c43fb1`, MuPDF-judged `divide-pages` pin); (c) `geometry.ts` box origins →
  `PageGeom.x0/y0` from pdf.js `view`, threaded at both producers (#8, `730b041`,
  pdf.js-as-oracle pin on the census fixture), and the `signature.ts` widget anchored
  in the displayed frame + `uprightMatrix`-turned appearance (#17, `473bdef`, live
  eyes-on: block at displayed (36,36)-(256,126) with upright text on /Rotate 0/90/270
  alike; the ruled intent — "where placed, upright as displayed" — resolved the
  original ask). All controls byte-stable: /Rotate 0 and zero-origin sheets unchanged
  everywhere; full suite 3911 pass / 13 skip / 0 fail, `vite build` green.
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

## Wave 2E close-out (2026-11-26)

All four open members are converged and pinned. Evidence bar per defect, as ever,
is *reproduced on the pre-fix build first* (closed-form round-trips re-derived by
hand, MuPDF pixel counts, pdf.js viewport math) and only then cured:

| Row | Defect | Cure | RED pin (fails without fix) | Control |
|-----|--------|------|------------------------------|---------|
| #14 | forward M applied as its own inverse | `invertMatrix(viewerToUserMatrix(frame))` | `tests/pdf/text-editor-patch-mapping.test.ts` 9/14 | rot 0/90/180 @ origin(0,0) round-trip (self-inverse), rot-0 export byte-stable |
| #15 | rot-180 y-term `H−ty−th` | `y0 + ty` (the table's row) | `tests/pdf/organize-rot180-divide.test.ts` 3/4, MuPDF piece ink `[0,24000]→[24000,0]` | rot 0/90/270 rows agree with T pre and post |
| #8 | origin never added to the private tables | `PageGeom.x0/y0` from pdf.js `view`, both directions + clamp | `tests/pdf/annotation-geometry-origin.test.ts` 11/12 vs real pdf.js | uncropped pages match old tables byte-for-byte |
| #17 | widget at stored corner, appearance unturned | display-frame placement via T + `uprightMatrix` in the AP stream | `tests/pdf/signature-widget-anchor.test.ts` 4/6 | /Rotate 0 identity: same rect, plain stream, existing pins green |

Live half (the display↔user rows are engine-side; the pane side is pdf.js): the
signature fix was additionally judged on rendered pixels — pdf.js `getAnnotations`
maps every quarter-turned file's widget rect to displayed (36,36)-(256,126) and the
MuPDF pixmap shows the block top-left with horizontal text (eye-checked; pre-fix it
sat top-right reading down the edge). No tool sends file bytes anywhere new: every
pin above is pure-local (pdf-lib / pdf.js / MuPDF on the produced bytes).

Gates: `npx vitest run` 154 files, **3911 passed / 13 skipped / 0 failed**; `npx tsc -b`
clean; `npm run typecheck:tests` clean; `npx vite build` green. Test-rewritten
`docs/research/crop-units-*.pdf` fixtures restored before commit.
