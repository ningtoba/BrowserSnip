Build three PDF tool panes in BrowserSnip (cwd = repo root). These are the remaining `surface: custom`
main views that registry.ts already lazy-imports.

STRICT FILE OWNERSHIP — create/edit ONLY:
  src/components/tools/pdf/organize/PageOrganizer.tsx
  src/components/tools/pdf/edit/FormFillMain.tsx
  src/components/tools/pdf/edit/FormCreatorMain.tsx
  tests/pdf/page-organizer.test.ts
Do NOT touch registry.ts, constants.ts, types/index.ts, ToolWorkspace.tsx, src/lib/pdf/**, or other
component directories (concurrent agents own them). No npm install. No git.

READ FIRST: docs/PDF-ENGINE-CONTRACT.md; src/lib/pdf/core/{doc,pages,render,images,annotations,forms}.ts;
src/lib/pdf/tools/{types,helpers}.ts; src/hooks/usePdfTool.ts;
src/components/tools/pdf/shared/PdfToolPanel.tsx; and the existing
src/components/tools/pdf/organize/OrganizeMain.tsx (the current reorder-only grid — improve on it).

Each component: `export default function X()` plus a named export, NO props, reads `useFileStore`,
writes `useProcessStore`.

1. PageOrganizer — replaces the reorder-only organiser. Real drag-and-drop with keyboard alternatives
   (it must be usable without a mouse), plus per-thumbnail actions: rotate 90, duplicate, delete, insert a
   blank page after, and insert pages *from a second PDF*. Multi-source: show a file tab strip over
   `useFileStore.files` so pages can be pulled from several documents into one order. Emit the plan as the
   `pageOrder` value string the registry already parses ("3, 1r90, blank, 2") and also drive the export
   directly so the button works. Show live page counts. Reuses thumbnails from core/render with progress,
   and must destroy its PdfSession on unmount and on file change.

2. FormFillMain — `/form-filler`. List AcroForm fields via `listFormFields` from core/forms, render an
   input per field type (text, multiline, checkbox, radio group, dropdown, listbox) positioned over the
   rendered page, plus a flat field list panel as an accessible alternative. Fill with `fillForm`, keeping
   unicode working (route any drawn appearance text through core/fonts). Detect XFA-only documents with
   `hasXfa` and say plainly what will and will not work. Support "Fill and flatten" as an option.

3. FormCreatorMain — `/form-creator`. Drag field rectangles onto a rendered page; per-field name, tooltip,
   required/read-only flags, font size, multiline, max length, and choice options for list/dropdown/radio.
   Create with `createFormField` from core/forms, then save. Support selecting, moving, resizing, deleting,
   and tab order. Show a warning if the document already has an AcroForm and offer to keep or replace it.

CONSTRAINTS: 100% client-side, no new dependencies, no optional engine required.

VERIFY: `npx tsc --noEmit -p tsconfig.json` clean for your files; `tests/pdf/page-organizer.test.ts` covers
the pure plan model (reorder/duplicate/delete/insert-blank reducers and the plan↔`pageOrder` string
round-trip). Run `npx vitest run tests/pdf/page-organizer.test.ts`.
Report files, what you verified, and anything that needs a human in a browser.
