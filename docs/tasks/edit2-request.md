# edit-bytes.test.ts — what the harness got wrong, and why it was changed

The 29 failures at checkpoint `2b7a774` were all real: every one of them described
behaviour the tools did not have. Nine of them, though, also needed a fix in
`tests/pdf/edit-bytes.test.ts` itself, because the assertion was written against a
helper that cannot report what the test claims to read. Those are listed here,
with the byte-level reason. No assertion was loosened, no test was skipped, and
nothing was deleted: `69 passed` are the same 69 tests that file always declared.

## 1. `dictOf()` returned nothing for a stream object

```ts
const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
return resolved instanceof PDFDict ? resolved : undefined;   // a stream is not a PDFDict
```

In pdf-lib `PDFStream extends PDFObject` and *holds* its dictionary as
`stream.dict`; it does not extend `PDFDict`. So every `/XObject` image, every
annotation appearance and every `/ToUnicode` CMap resolved to `undefined`, and
five tests that count images or read an appearance's resources were asking
`dictOf` for something it can never return — an `/Image` entry is *always* a
stream. The helper now unwraps `PDFStream` to its `dict`. The same file already
knew this: `asStr… am).dict.get('Resources')` in the custom-stamp test.

Affected: image watermark, the three raster colour tools, custom stamp image.

## 2. `/PageLabels/Nums` was read as a dictionary

`labelRanges()` looked up `/Nums` with `dictOf`. `/Nums` is a number tree — an
**array** of `index dictionary` pairs (ISO 32000-1 §14.4.2) — so `root` was
undefined and both label tests read `[]` no matter what was written. The tool's
bytes were correct all along: `/PageLabels << /Nums [ 0 << /S /R >> … ] >>`.
Changed to `arrayOf`, which the same file already defines and uses for `/Annots`.

## 3. `runFonts()` reported names with their slash

The helper strips a subset prefix (`ABCDEF+Helvetica`) but not the leading `/`
that `PDFName.asString()` returns, so it produced `/Times-Roman` while the
assertion asked for `Times-Roman`. Slash stripped; the face is now reported the
way a reader shows it.

## 4. `listAnnotations` reports `kind`, not `type`

The stamp test read `mark.type`. The record this app's own annotation reader
returns is `{ kind, page, rect, … }` — `kind` is the spelling used by every other
test in the repo (`annotations.test.ts`, `annotation-editor.test.ts`) and by
`AnnotationSpec`. Reading `.kind` keeps one spelling for one concept; the
assertion (`/stamp/i`) is unchanged, and it is now checked against the
`/Subtype` the file actually carries.

## 5. The fixture could not draw a page of CJK

`pdfFixture` wrote every fixture page with `StandardFonts.Helvetica`, so the
"never promises text a WinAnsi-only face could not draw" test threw
`WinAnsi cannot encode "内"` *inside the fixture*, before the tool under test ran.
A page whose own body text is CJK is exactly what that test needs. The fixture now
draws its text through `core/fonts.drawTextU` — the same route the app uses — which
keeps Helvetica for Latin (so the byte patterns the other tests match are
unchanged) and embeds a Unicode face when the string does not fit WinAnsi.

## 6. Each page's own fixture word had to be removed per page

`expect(texts.map((t) => t.replace('a', '').trim())).toEqual(['I', 'II', 'III'])`
stripped page 1's fixture word (`a`) but pages 2 and 3 carry `b` and `c`, and
`pageText` joins the runs it finds. The folio assertion itself is intact: the
word is now dropped from the page that holds it.

## 7. A partial recolour needs a page that does not match

The "names the pages where nothing matched when some did" test painted *both*
fixture pages with `rgb(0, 0, 0)`, so `from: '#000000'` matched everything and
there was no partial case to report. The second page is now painted `#1a1a1a`,
which is the case the field's own help documents: "a near-black from a scanner
will not count as black".

## 8. A multiline flag has to be asked for

The "keeps the field values, options and flags" test asserted `/Ff & 4096` on a
field whose spec never said `multiline`. The bit is written when a spec asks for
it (the sibling test in this same file does), so this spec asks for it too.

## 9. `afterEach` now clears the fetched-face cache

`core/fonts` caches downloaded face bytes for the life of the tab, which is the
point — a CJK face is several megabytes. But that made "a NotoSans URL was asked
for" unobservable in any test after the first CJK run, because the fetch never
happened again. `clearFontCache()` is called with the other per-test resets, so
each test sees the URLs *its own* conversion fetched.

## Outside the harness, one expectation in another file moved

`tests/pdf/edge-forms-core.test.ts` documented `WIDGET_RECT` as
`{ x: 39.75, y: 699.75, width: 120.5, height: 20.5 }` — the widget rectangle
after pdf-lib folds the 0.5 pt border *outside* the box. `edit-bytes.test.ts`
requires the widget to sit on the rectangle the designer dropped it at
(`toBeCloseTo(700, 3)`), and the same border change makes this file's
`listFormFields` geometry match what was asked for. The constant now reads
`{ x: 40, y: 700, width: 120, height: 20 }`, with the comment explaining where the
border goes (inside, as `core/forms.appearanceOptions` says).

## Not a harness problem: what had to be built

* `core/fonts.ts` — a face embedded with **its own** character codes, widths,
  `/CIDToGIDMap` and `/ToUnicode`. pdf-lib's embedder hands fontkit the string and
  uses the glyph numbers back, so a character the fetched face lacks lands on
  `.notdef` (code 0) with no CMap entry at all: a blank on the page *and* a blank
  on copy. Three different characters missing from one face cannot even be told
  apart afterwards.
* `core/content.ts` — runs are merged along the pen position in text space, not
  the drawn rectangles, so a watermark at 45° is one run rather than twelve;
  `/Contents` streams can be joined and folded (`paintBehind`); a form XObject can
  be copied into a page (`inlineFormXObject`).
* `tools/edit.ts` — `drawBehind` puts the mark in front of the page's own streams
  and keeps pdf-lib's `q`/`Q` pair around the mark rather than stranded after it;
  the header/footer rule is drawn as a stroked path; an empty `/CropBox` is
  detected on the page node, where `cropBox()`'s MediaBox fallback hides it.
* `core/forms.ts` — a flattened field is *copied into the page content* instead of
  being referenced as a form XObject, and the missing `/BBox`→`/Rect` scale is
  fixed, so the baked answer is both visible at its real size and searchable.
* `core/office-in.ts` — XML that uses a prefix it never declared no longer reads
  as "not readable XML"; the missing prefixes are bound to a placeholder so the
  qualified names survive to be compared honestly (`<t:Glyphs>` is still not
  `<glyphs>`, and the XPS tool says it found no text runs it can recover).
* `core/bookmarks.ts` — a contents-page link now carries a `/GoTo` action beside
  its `/Dest`.
* `tools/legacy.ts`, `tools/edit.ts` — `compare` and `redact` were renamed in the
  catalogue; two rows called "Compare PDFs" (and two called "Redact PDF") are a
  choice nobody can read off the dashboard.
