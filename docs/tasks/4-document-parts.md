Implement §4 (bookmarks, metadata, attachments, forms) of `docs/PDF-ENGINE-CONTRACT.md`. Cwd = repo root.

STRICT FILE OWNERSHIP — create/edit ONLY:
  src/lib/pdf/core/bookmarks.ts, metadata.ts, attachments.ts, forms.ts
  tests/pdf/bookmarks.test.ts, tests/pdf/metadata.test.ts, tests/pdf/attachments.test.ts
Do NOT touch package.json, vite.config.ts, constants.ts, types/index.ts, src/components/**, src/lib/pdf/engines/**, src/lib/pdf/tools/**, or core files owned by other agents (annotations/content/layout/tables/measure/ocr/convert). No npm install. No git.

Read first: docs/PDF-ENGINE-CONTRACT.md and the frozen src/lib/pdf/core/{doc,pages,fonts}.ts.
VERIFY THESE FACTS YOURSELF by reading the .d.ts files, do not trust this summary:
- pdf-lib has real outline support: PDFDocument.getOutline(), getOutlineCount(), removeOutline(), insertOutlineEntry(text, target, {parent,next,top,color,bold,italic}). See node_modules/@maxwbh/pdf-lib/cjs/api/PDFDocument.d.ts and cjs/api/outlines/*.
- The fork has doc.attach(bytes, name, options) (cjs/core/embedders/FileEmbedder.d.ts exports AFRelationship) but NO list/remove: read /Names → /EmbeddedFiles → /Dicts where each value is an /FS file spec whose /EF points at an /EmbeddedFile stream with /Params /CheckSum /Size /CreationDate; removal splices the name tree.
- AcroForm: doc.getForm(), getFields/getField, PDFTextField.setText, PDFCheckBox.check, PDFOptionList, PDFDropdown, PDFRadioButton, enableAppearances, save({updateFieldAppearances:true}). Confirm names under cjs/api/form/.

DELIVERABLES: the four modules with exactly the §4 signatures; correct PDF date handling (D:YYYYMMDDHHmmSS±HH'mm') both directions; generateTocPage inserting real pages with dot leaders and right-aligned page numbers (real /Link destinations are a bonus; if you need link annotations write them inline rather than importing ./annotations, which another agent owns); addBatesNumbers supporting {n},{org},{page},{total},{date},{time} tokens and stamping via core/fonts.ts drawTextU so unicode always works.

VERIFY: `npx tsc --noEmit -p tsconfig.json` and your tests green under `npx vitest run tests/pdf/`. Tests must do REAL round-trips: write outline → save → load → read; attach → save → load → list + extract bytes + checksum; writeInfo → save → load → readInfo; fillForm on a doc built with createFormField. Report API, deviations, caveats.
