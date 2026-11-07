# convert-from2 requests — finishing the interrupted PDF→images/text/tables/Word/SVG pass

From the follow-up worker on `src/lib/pdf/tools/convert-from.ts`,
`src/lib/pdf/core/{images-out,raster,measure,ocr,docx-out}.ts` and
`tests/pdf/edge-convert-from.test.ts`, continuing from checkpoint `2b7a774`
(10 failing tests in `tests/pdf/edge-convert-from.test.ts`). All ten are green;
none was deleted or softened. Each item below that touches a file outside that
set is a **request**, in the `b6c-request.md` format — one is applied, and it is
small and easy to revert.

## Impossible as written — the TIFF density pair, and where the oracle had to move

`raster resolution metadata › writes the requested dpi into the TIFF` asserts

```ts
expect(tags.x).toEqual([300, 1]);   // XResolution: numerator 300, denominator 1
```

while reading `tags` from `UTIF.decode()`. That combination cannot pass, whatever
the file contains: UTIF **divides** a RATIONAL while decoding it
(`node_modules/utif/UTIF.js`, `_readIFD`, `type == 5` →
`arr.push(readUint(voff) / readUint(voff + 4))`), so `t282` is `[300]` — one
number. `[300, 1]` was therefore not testing the export at all; the best it
could ever say is "some ratio equalled 300", which `600/2` also satisfies.

The assertion is kept at full strength and the **reader** moved, in
`tests/pdf/edge-convert-from.test.ts` → `tiffPages()`: the IFD chain is now
walked out of the file's own bytes, and the two 32-bit words of tags 282/283 are
read where the entry says they live. That is both what the sentence means and a
stricter check, because `concatTiffs` rebases every IFD — a density that survived
only in page 1's tail used to be invisible to the UTIF view of the merged file.
No production behaviour was changed to satisfy it, and the pixel round trips
through UTIF (`expectPageSignature`, still 4 pages of exact colours) prove the
merged structure is intact around the same change.

## R1 — `core/convert.ts` dropped every raster from PDF to SVG (APPLIED)

`pdf-to-svg`'s `Embed raster images as data URIs` toggle had nothing to switch:
with it on, an image page produced an empty `<g>` and `1 operator(s) skipped`.
`imageDataUrl()` accepted pixels only through
`raw instanceof Uint8ClampedArray || raw instanceof Uint8Array`, and the payload
pdf.js transfers does not pass that test here — it is a typed array built in the
worker's realm, so `instanceof` is false in the page's realm even though
`ArrayBuffer.isView` is true and the bytes are ordinary RGB. The old failure mode
was silent by design: `paintImage(undefined)` counts a skipped operator, which is
the honest thing to do with **no** pixels and the wrong thing to do with pixels
that merely looked foreign.

Applied (2 hunks, no signature change): `asLocalBytes(value)` returns a
same-buffer view belonging to this realm, and `imageDataUrl` uses it in place of
the two `instanceof` tests. It also fixes the more likely browser-side variant,
since `new ImageData(bytes, …)` is entitled to refuse a foreign array.
`instanceof Blob` (the JPEG/PNG pass-through) and the canvas/ImageBitmap branches
are untouched, and `embedImages: false` still skips the image before any of this.

Pinned by `pdf-to-svg › leaves the raster out when the toggle says so, and puts it
in when it says yes` (`<image` plus a `data:image/` href on, neither off).

Owner: `core/convert.ts` is in no ownership row of this pass; revert this file's
diff if its owner wants the check somewhere else. `convert-from.ts` cannot do it
instead — the interpreter decides what "no pixels" means.

## Two notes on the ownership list, so nobody hunts for a missing file

- `src/lib/pdf/core/csv.ts` **does not exist**. The CSV writer is `tablesToCsv()`
  in `src/lib/pdf/core/tables.ts`, and the quoting, delimiter and BOM behaviour
  the failing tests wanted is already correct there — no change was needed, and
  `tables.ts` was left alone.
- `core/measure.ts` and `core/ocr.ts` are in the owned list but needed nothing
  for these ten tests: the page-dimension report, the greyscale raster path and
  the "run OCR first" sentences were already honest. Both were read, not edited.

## Deliberately not expanded (each one is reported, never dropped — E13)

`extract-images` now unpacks DeviceGray/RGB/CMYK, `/Indexed` over any base,
`/ICCBased` counted by `/N`, `CalGray`/`CalRGB`, and 1, 2, 4, 8 and 16-bit
samples, with `/Decode` and 1-bit-legal `/SMask`s. Left refused, with a sentence
naming the cause in the result report:

- `/Separation` and `/DeviceN` — the tint transform is a PostScript program; an
  interpreter for it does not belong in an image exporter.
- `/Lab` — needs the page's white point to be placed on screen.
- `/Pattern` — the colour comes from a tiling pattern, not a sample grid.
- Any other `/BitsPerComponent` (e.g. 12-bit DNG-ish samples).
- CCITT and JBIG2 streams, as before.

`pdf-to-excel` types a cell as a number only for a sign, digit groups, a decimal
point and a currency mark it recognises (`$ ¢-¥ € £` plus a fixed ISO list). `12%`
is left as text on purpose: the value a spreadsheet holds is `0.12` with a percent
*format*, and inventing a format the PDF never declared is a decision the cell
should not make alone.

## One output change worth a second look, inside an owned file

`pdf-to-excel` now writes with `bookSST: true`, so repeated text lands in
`xl/sharedStrings.xml` and cells point at it — the layout Excel itself produces,
and the reason the test "text cells belong in the shared string table" could not
pass before. Cell values, sheet names and column widths are unchanged.

## Still red outside this pass's files (reported, not fixed)

Pre-existing at `2b7a774`, all three about field labels in
`src/lib/pdf/tools/organize.ts` (verified against `git show HEAD:…`):

- `tests/pdf/ux-definitions.test.ts › names each shared concept the same way
  everywhere` — `add-blank-page.position` is labelled
  "Where the blank sheets go" where the vocabulary says "Position".
- `tests/pdf/ux-definitions.test.ts › explains a consequence in help, or says
  nothing` — `alternate-merge.pattern`'s help is a paragraph.
- `tests/pdf/guard.test.ts › clamps an absurd number instead of producing a
  broken file` — expects the "How many" label in the clamp message, and
  `add-blank-page` calls that field "Blank pages to add".

`npx tsc -b` (the app project) is 0 errors; `npx tsc -p tsconfig.tests.json`
still reports 25 errors in other agents' test files
(`edit-bytes.test.ts`, `edge-convert-to.test.ts`, `_scratch*-probe.test.ts`,
`zz-scratch2/3.test.ts`) — none in `src/lib/**` or in this suite's file.
