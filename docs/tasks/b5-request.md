# B5 requests — convert-to / office pass

From worker B5 (`tools/convert-to.ts`, `tools/office.ts`,
`tests/pdf/edge-convert-to.test.ts`). Nothing here is edited outside my three
files; each item names the owner and the concrete change.

## R1 — `openInputs` refuses every non-PDF tool (owner: A1 / `tools/helpers.ts`)

`openInputs` now routes each input through `core/guard`'s `openPdfInput`, which
raises `NOT_A_PDF` when the bytes have no `%PDF-` header. Correct for PDF tools,
fatal for converters: `word-to-pdf`, `excel-to-pdf`, `powerpoint-to-pdf`,
`epub-to-pdf`, `email-to-pdf`, `cbz-to-pdf` and every tool in `tools/office.ts`
used it as a generic "give me the uploaded bytes" call, so after Phase A landed
a real DOCX was refused with *"is not a PDF: its contents do not start with
%PDF-1.x"*. `tools-e2e` never covered those ids, so nothing caught it.

Worked around locally in `tools/convert-to.ts` with `sniffSource` /
`assertSourceFormat` / `sourceBatches` / `readPrimarySource`, which do the E1/E2
half of the guard (empty file named, wrong container named from magic bytes)
without demanding a PDF.

Requested so B6 (`convert-from.ts`, same trap: `odt-to-pdf`-style readers,
`rtf`/`docx` writers that read an input PDF *and* a sidecar) does not copy the
sniffer:

- Export from `core/guard` a content-kind sniff — `sniffContainerKind(bytes, name)`
  returning `'pdf' | 'zip' | 'ole' | 'palm' | 'image' | 'svg' | 'text' | 'binary'`
  plus a human label — and a `readNonPdfInput(bytes, name, { kinds, label, hint })`
  gate next to `openPdfInput`.
- Keep `openInputs` PDF-only, but make that legible: rename in the JSDoc first
  line to "opens PDF inputs" so a converter author does not reach for it.

I am happy to delete my local sniffer once that lands; my tests pin the
sentences, so the swap is mechanical.

## R2 — paste-only converters cannot run (owner: A1/A2 / `tools/runner.ts`)

`txt-to-pdf`, `markdown-to-pdf`, `html-to-pdf`, `csv-to-pdf`, `json-to-pdf`,
`xml-to-pdf` and `rtf-to-pdf` all declare a `source: file | paste` control, and
`readSources` honours it. But `runPdfTool` calls `fileProblem` first, which
returns `EMPTY_FILE` ("Add a file first.") for `files.length === 0` whatever the
tool declares, and `collect()` then reads `inputs[0].name` — so the paste path
is unreachable from the UI and would crash if reached.

Requested: honour `minFiles: 0` (or a `sourcesFromFields: true` flag) in
`fileProblem`, and name an output from `values`/tool id when there is no input
file. Until then my paste tests call `tool.run(context)` directly.

## R3 — `core/content` cannot decode app-written text (owner: A1/B3 or content owner)

Two things in `src/lib/pdf/core/content.ts` make "assert it extracts" unverifiable:

- Line ~1305: `const STANDARD: Record<string, …> = {}` is empty, so
  `standardMetrics()` always returns `null` and a page that references Helvetica
  without embedding it has no widths and no code→Unicode mapping.
- `textRects()` on a document this app just wrote returns one glyph per
  text-showing operator, e.g. drawing "Plain Helvetica text" yields `["P"]`, and
  `["H","c"]` for a two-block layout page. Reproduce:

  ```ts
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([300, 300]).drawText('Plain Helvetica text', { x: 20, y: 200, size: 18, font });
  const re = await PDFDocument.load(await doc.save());
  textRects(re.getPages()[0]); // → [{ text: 'P' }] , expected the whole run
  ```

This matters beyond my category: the text editor uses `textRects` to find what
to replace (`text-editor/draw.ts:114`), and redaction to decide what to remove.
My tests therefore decode `Tj`/`TJ` operands against the page's own
`/ToUnicode` CMaps locally, which is real but duplicated effort — with R3 fixed
that helper belongs in `core/content` as `extractPageText(page)`.

## R4 — `officeReady()` is hard-coded `false` (owner: 1-engines / `core/office-in.ts`)

`officeReady()` returns `false` unconditionally and `convertOffice()` always
throws, so every legacy-container route (`word-to-pdf` on `.doc`,
`powerpoint-to-pdf` on `.ppt`) is a permanent refusal. That is honest and my
tools now say it in `NEEDS_ENGINE` form with a re-save alternative, but it also
means the ~15 lines of "loading the office converter" progress code are dead.
Please confirm either (a) it stays unbundled — then I can drop the progress call
and shorten the sentence — or (b) a loader is coming, in which case the tools in
`tools/office.ts` `LEGACY_ONLY` list should gain a `run` and the registry's
`unavailable` guard with it.

## R5 — small vocabulary ask (owner: A1 / `core/guard.ts`)

`blocksResult` uses code `NEEDS_ENGINE` when a *CDN-hosted Unicode font face*
cannot be fetched (offline CJK), because `OUT_OF_RANGE`/`UNSUPPORTED` are both
wrong and `NEEDS_ENGINE` reads oddly next to PyMuPDF. A
`RESOURCE_UNAVAILABLE` code with a "re-run while online" default hint would let
the rail show a retry affordance instead of a generic failure.

## R6 — two `core/office-in.ts` readers miss the elements real files use

Found while building fixtures from genuine producer output. Both currently make
a converter look like it worked while the PDF it produced is empty of the text
that was in the file. `tools/office.ts` and `tools/convert-to.ts` now refuse
those inputs out loud ("no text frames this reader can see, so every slide would
come out blank") instead of shipping blank pages, but the refusal is a
workaround: the decks are readable, we just do not read them.

1. `odpToBlocks` collects `byLocalName(page, 'shape')`. LibreOffice/Impress write
   slide text as `<draw:frame><draw:text-box><text:p>…` — `draw:shape` is for
   graphical objects. Result: a real `.odp` yields only `pagebreak` blocks.
   Match `frame` as well as `shape` (or walk `draw:text-box` directly).
2. `xpsToBlocks` compares `localName(glyph) !== 'glyphs'`. XPS writes
   `<t:Glyphs UnicodeString="…"/>`, so the local name is `Glyphs`, and the
   comparison is case-sensitive: every text run on every fixed page is skipped.
   Compare case-insensitively (as `localName()` already normalises prefixes).

Repro for both, runnable today (each prints `[]`-equivalent output):

```ts
const { odpToBlocks, xpsToBlocks } = await import('@/lib/pdf/core/office-in');
// zip with content.xml containing:
//   <draw:page><draw:frame><draw:text-box><text:p>Open slide</text:p></draw:text-box></draw:frame></draw:page>
await odpToBlocks(odp);   // → [{ kind: 'pagebreak' }] — the title is gone
// zip with FixedDoc01/Pages/Page1.fpage containing:
//   <FixedPage …><t:Glyphs UnicodeString="XPS page one text" …/></FixedPage>
await xpsToBlocks(xps);   // → [{ kind: 'pagebreak' }] — the run is gone
```

My tests therefore build the containers in the shapes the current readers
understand (`draw:shape`, lowercase `glyphs`) and pin the refusal for the real
shapes; when this lands, both fixtures can switch to producer output and the
refusal tests can become conversion tests.

## R7 — operators pushed onto a page after `save()` are silently dropped (owner: core/doc)

`@maxwbh/pdf-lib` keeps a page pointing at the content stream it already
serialised, so `page.pushOperators(...)` on a document that has been saved once
does not reach the next save. Repro (ran in this repo, jsdom, same code path as
`digitize-document`):

```ts
const doc = await imageOnlyPdfWithOnePage();      // page has an image XObject
await doc.save({ useObjectStreams: true });       // any save
await addSearchableTextLayer(doc, results, { invisible: true }); // reports words: 3
const out = await doc.save({ useObjectStreams: true });
pageContentStreams(reload(out).getPages()[0]);     // → the BT…Tj block is missing
```

Saving the layer onto `PDFDocument.load(bytes)` of the intermediate result works
(`hasBT=true`), so the rule is: *after an intermediate save, re-open before you
mutate.* `digitize-document` was hit by exactly this — it reported "digitised
with N recognised words" while the download contained only the picture, which is
the E10 complaint in its purest form. Fixed in `tools/convert-to.ts` by layering
onto `openPDF(bytes)`.

Asked of the engine owner, not as a code request: should `core/doc` grow a
`reopen(doc)` helper (save + load, metadata preserved) so no tool has to know
this quirk? `tools/edit.ts` (`ocr-pdf`) currently pushes onto a freshly loaded
document and is safe today, but it becomes unsafe the moment that tool saves
mid-run.
