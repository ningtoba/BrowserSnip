# B3 requests — things the edit tools need from files they do not own

Found while hardening `src/lib/pdf/tools/edit.ts` (tests:
`tests/pdf/edge-edit.test.ts`). Each item names the file, the symptom and the
smallest change that fixes it. Nothing below blocks B3: the tools work today,
with the workaround noted.

## 1. `core/forms.ts` — `listFormFields` throws on a field with no `/TU`

```ts
function alternateName(field: PDFField): string | undefined {
  const value = field.acroField.dict.lookup(PDFName.of('TU'), PDFString);   // throws
  return value?.decodeText();
}
```

`PDFDict.lookup(key, class)` **throws** when the key is absent ("Expected
instance of PDFString or PDFHexString, but got instance of undefined"), and
`createFormField` only writes `/TU` when the spec carries a `label`. So every
form built by *our own* Create PDF Form pane crashes `form-filler` on the
`listFormFields(input.doc)` call until the user happens to name every field.

**Ask:** `lookupMaybe(PDFName.of('TU'), PDFString) ?? lookupMaybe(PDFName.of('T'), PDFString)`
— and a test where a widget has neither.

**Workaround in B3:** the test passes a `label` on every spec it creates.

## 2. `core/layers.ts` — layer names come back escaped

`addLayer(doc, 'Revision B')` stores the name as a PDF *name*, and `listLayers`
returns it verbatim: `Revision#20B`. The `pdf-layers` rail therefore shows a
different name from the one the user typed, and a second instruction naming
"Revision B" no longer matches it (`setLayerVisibility` compares on the stored
name).

**Ask:** decode `#xx` in `listLayers` (and in the `hide`/`show`/`remove` name
matching), or keep `/Name` as a text string.

**Workaround in B3:** none needed for correctness of the file — the test decodes
`#20` before comparing, and the tool reports the name the user asked for.

## 3. `core/fonts.ts` — the `fontFamily` / `exact` style fields are accepted and ignored

`getFont` only asks "is `fontFamily` truthy?" and then loads Noto Sans; the
requested family and `exact` never reach a decision. So a tool cannot honour
"Times, Latin only" without going around the module.

`tools/edit.ts` currently carries a local standard-face path (guarded by
`isWinAnsiSafe`, falling back to the Unicode face with a stated warning) to make
the Page Numbers **Typeface** picker real.

**Ask:** `getFont(doc, { family: 'times' | 'helvetica' | 'courier' | 'noto' | 'auto', … })`
that returns the standard face when the text fits it and reports otherwise, so
the local copy in `tools/edit.ts` can be deleted and every category gets the
same behaviour.

## 4. `components/tools/pdf/edit/{PageNumbersTool,WatermarkTool}.tsx` — parameter names do not match the tool fields

The legacy panes post `font: 'Helvetica'`, `imageScale`, `tileSpacing`; the tool
reads `font: 'helvetica'` (matched case-insensitively now), `scale`, `tileGap`.
Three controls are therefore silently ignored — exactly the defect class the
refinement brief calls out — and `WatermarkTool` still has no file input at all,
while `watermark` gained an `image` field.

**Ask:** rename the params to the field keys (or delete the two panes if
`PdfToolPanel` now covers them).

## 5. `src/lib/utils/download.ts` — a second copy of the output suffix table

`suffixForTool()` duplicates `_numbered.pdf`, `_watermarked.pdf`, `_redacted.pdf`
… which `registry.suffixFor()` already derives from the tool definitions, and it
has no entry for the other edit tools, so they fall through to `_processed.pdf`.

**Ask:** delegate to `getPdfTool(id)?.outputSuffix ?? '_processed.pdf'` and drop
the switch, so a tool cannot be renamed in two places.
