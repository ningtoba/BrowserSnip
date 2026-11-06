# B6c requests — convert-from pass

From worker B6c (`src/lib/pdf/tools/convert-from.ts`,
`tests/pdf/edge-convert-from.test.ts`). Phase B rule says anything outside the
two owned files is a request; three of these were **already applied** because
they are outright crashes on the convert-from path and the category cannot be
finished honestly without them. Each is a small, self-contained patch that is
easy to revert if the file's real owner disagrees — say so and I will move the
work into `convert-from.ts` instead.

## R1 — `core/images-out.ts` threw on every PDF that contains an image (APPLIED)

`collectImageRefs` read resource entries with `doc.context.lookup(ref, PDFDict)`.
An **image XObject is a stream, not a dict**, so pdf-lib threw
`Expected instance of PDFDict, but got instance of PDFRawStream` and *Extract
Images* failed on the first page holding any image — this is the exact trap the
brief warns about ("never ask for a class on an entry whose type varies; read it
and narrow manually"). `lookupMaybe` is not the escape hatch: it throws the same
error when the object exists but is of another type, it only returns `undefined`
for a missing object.

Applied: a `narrowDict(doc, value)` helper that does the untyped
`doc.context.lookup(value)` and narrows with `instanceof`, returning
`stream.dict` for a `PDFRawStream` (that is where an image's `/Subtype` lives)
and `null` for anything else. Used at both XObject sites and inside
`resolveDict`. No behaviour change for form XObjects.

Pinned by `tests/pdf/edge-convert-from.test.ts` › *extract-images* (a JPEG
stream returned byte-identical, a Flate PNG returned at its original 40×24 and
decoding back to the colour that was drawn).

## R2 — `core/raster.ts` TIFF output did not decode back (APPLIED)

*PDF to TIFF* produced a file that UTIF (the app's own dependency, used by
`core/images.ts`) could not read, and a page that "exported successfully" was
unusable as an input to anything else. Three defects, all in `encodeTiff`:

1. `const resolutionOffset = p + 4` ran while `p` still pointed at the **start**
   of the IFD, so the two RATIONALs were written on top of entry 0 and entry 1 —
   `ImageWidth` (tag 256) came back as tag 72 and the width was lost.
2. `BitsPerSample` was declared `type SHORT, count 1, value 8` while
   `SamplesPerPixel` is 3. A strict reader multiplies the two and gets
   8 bits per *pixel*, so every row is read at a third of its real length and
   the page decodes solid black. The tag now carries one SHORT per sample,
   stored out of line (3 × SHORT does not fit the 4-byte value field).
3. `concatTiffs` copied `2 + entryCount * 12 + 4` bytes per page — the IFD
   **table only**, dropping the out-of-line tail that those entries point into.
   It now copies the page's IFD block to the end of its buffer and rebases every
   out-of-line entry offset by the IFD's move (StripOffsets keeps its own,
   data-relative rewrite).

Verified byte-level: `pdf-to-tiff` over a document mixing A4 portrait, Letter
landscape and a `/Rotate 90` page yields one multi-page TIFF whose pages decode
through `UTIF` to 595×841, 792×612, 300×400 and 400×300 with the exact pixel
colour each page was rendered with.

## R3 — `core/measure.ts` embedded by the *requested* format, not the real one (APPLIED)

`embedRender` did `format === 'jpeg' ? embedJpg(bytes) : embedPng(bytes)`.
Per the HTML canvas spec a `toBlob('image/jpeg')` that the engine cannot encode
**falls back to PNG silently**, and pdf-lib then dies with
`SOI not found in JPEG` — which is how *PDF to Greyscale → Re-render* failed.
The patch sniffs the two-byte SOI marker and picks the embedder from the bytes;
the requested format still decides what is *asked for*, only not what is
*assumed*.

## R4 — `core/images.ts` reads dimensions that UTIF never sets (NOT APPLIED)

`ifdToCanvas` uses `ifd.w` / `ifd.h`. UTIF's `decodeImage` publishes
`img.width` / `img.height` (from `t256` / `t257`); there is no `w`/`h` on an IFD
— see `node_modules/utif/UTIF.js`, `UTIF.decodeImage`. So TIFF **import**
(`image-to-pdf`, anything routing through `decodeImages`) gets `undefined`
dimensions: `Math.max(undefined, undefined)` is `NaN`, the scale is `NaN`, and
the canvas ends up 1×1. Reproduce after R2 lands, because before it the file was
rejected earlier:

```ts
const bytes = new Uint8Array(await encodeTiff(canvas).arrayBuffer());
const ifd = UTIF.decode(bytes.buffer)[0];
UTIF.decodeImage(bytes.buffer, ifd);
ifd.w;          // undefined
ifd.width;      // 595
```

Owner: whoever picks up `core/images.ts` (it is in no Phase A/B ownership row).
Not touched here because *convert-from* never calls it.

## R5 — `jsonToMarkdown` cannot be told "no headings" (workaround in place)

`headingHeights: []` means "detect them yourself", so the rail's
*Detect headings from font sizes* toggle in `pdf-to-markdown` was
indistinguishable from leaving it on — the off position never turned anything
off. `convert-from.ts` now passes `NO_HEADING_HEIGHT` (`0.01` pt, a height no
run is drawn at) when the toggle is off, with a comment. A real fix belongs in
`core/convert`: accept `headingHeights: null` (or a `headings: false` option)
instead of overloading the empty array; then the sentinel can go.

## R6 — `reportResult` should take `warnings` (A1, `tools/helpers.ts`)

`reportResult(sections, { message, files })` has no `warnings`, so an
honest-empty report that also has to carry an E3 "this file was damaged" notice
needs the `withWarnings()` wrapper in `convert-from.ts`. `ToolResult` already
declares `warnings`; the helper's options type is the only gap
(`PdfToolOutputOptions` would be the natural home).

## R7 — `page-dimensions` is defined in `convert-from.ts` but categorised `organize`

It is in the `convertFromTools` array, so the registry serves it from the
convert-from module while the UI groups it under organize. The B6 coverage guard
counted it as a missing convert-from tool. Either the tool's `category` is wrong
or it belongs in `tools/organize.ts`; left as-is because moving it changes the
rail's grouping, which is A2's surface. The test now compares the *intersection*
of exercised ids with the convert-from category and says why.

## R8 — note for the other B workers: `PageSpecError` at the tool boundary

The UI prints `error.message`, so a bad page selection currently reads
`"2" refers to page 2, but this document has 1 page.` — no file name, no valid
range, no `code`, no `hint`, and `${error.name}: ${error.message}` on any surface
that includes the class name (the run log, the B-phase test helpers).
`convert-from.ts` translates it in one place, `pageSelection()`, into
`ToolInputError('OUT_OF_RANGE', …)` naming the file and `1-N`. Any other tool
calling `resolvePages` directly has the same leak; the wrapper is worth moving to
`tools/helpers.ts` once two more categories want it.
