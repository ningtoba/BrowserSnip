Build BrowserSnip's flagship **annotation editor** at `src/components/tools/pdf/editor/AnnotationEditor.tsx`
(cwd = repo root). This is the `/edit-pdf` equivalent of BentoPDF: "Annotate, highlight, redact, comment,
add shapes/images, search, and view PDFs" — work that sits *on top of* the page.

STRICT FILE OWNERSHIP — create/edit ONLY files under `src/components/tools/pdf/editor/` plus
`tests/pdf/annotation-editor.test.ts`. Do NOT touch registry.ts, constants.ts, types/index.ts,
ToolWorkspace.tsx, anything in src/lib/pdf/**, or other component dirs (concurrent agents own them).
No npm install. No git.

READ FIRST: docs/PDF-ENGINE-CONTRACT.md; src/lib/pdf/core/{annotations,redact,render,doc,pages,fonts,images,pack}.ts;
src/lib/pdf/tools/types.ts; src/hooks/usePdfTool.ts; src/components/tools/pdf/shared/PdfToolPanel.tsx (reuse its
`PdfToolPanel`/`ReportView` styling vocabulary); src/components/viewer/PDFViewer.tsx and
src/components/tools/pdf/security/RedactMain.tsx (the existing markup + interaction patterns to imitate);
src/index.css + tailwind.config.js for the class names (doodle-btn, doodle-input, doodle-chip,
rounded-doodle-md, bg-cream, text-ink, text-ink-muted, border-cream-border, shadow-doodle-card, accent/success/warn/danger).

COMPONENT CONTRACT (registry.ts already lazy-imports this path):
  export default function AnnotationEditor(): JSX.Element   // also `export { AnnotationEditor }`
  Takes NO props. Reads the loaded file from `useFileStore`, writes results through `useProcessStore`.

REQUIRED BEHAVIOUR:
1. Renders the PDF with a `PdfSession` from `openRender` (one session, destroyed on unmount AND on file
   change — the old code leaked these and destroyed a shared singleton). Page-at-a-time with prev/next,
   a page-number input, zoom (fit-width / 50–400%), and keyboard arrows.
2. Tool palette, each producing a real `AnnotationSpec` via `addAnnotations` from core/annotations:
   Highlight, Underline, StrikeOut, Note (sticky Text), FreeText (text box), Ink (freehand pen),
   Square, Circle, Line, Arrow, Polygon/PolyLine (shape), Stamp (built-in names + custom image),
   Image (place a PNG/JPEG), Signature (draw on a small canvas → Stamp), Link (to page or URI),
   Redact. Colour picker, stroke width, and opacity per tool. Selecting highlight/underline/strike must
   snap to the text line under the cursor using `session.textItems(page)` quads — do not require the user
   to trace a rectangle by hand, and refuse politely with a hint when the page has no extractable text
   (a scanned page), because BentoPDF's own FAQ calls this out.
3. Overlay model: draw the in-progress annotations as absolutely-positioned SVG/DOM over the canvas using
   the inverse of the render scale (PDF user space bottom-left ↔ screen top-left). Click an existing
   annotation to select it; drag to move; Delete/Backspace removes it; undo/redo stack (Ctrl+Z / Ctrl+Shift+Z)
   over the whole annotation list, including per-keystroke text edits.
4. Export: build a copy of the document (`clonePDF`), apply `addAnnotations`, apply `applyRedactions` for
   redaction rects, then save via `savePDF` and push to the process store with `setOutput`. Redaction must
   report honestly when a region fell inside an image (applyRedactions returns `rasterised`).
5. Multi-document tabs up to 10 (`documentManager:{maxDocuments:10}` equivalent): a tab strip over
   `useFileStore.files` with per-tab annotation state kept in a `Map` keyed by file name so switching tabs
   does not lose work.
6. No autosave: state is in memory; say so in a footer line, and warn on unmount/close with unsaved changes.
7. Empty/loading/error states are real UI, never a blank pane (this was a standing defect). Surface a
   password prompt when the file is encrypted (catch `PasswordRequiredError`).

CONSTRAINTS: 100% client-side. No new npm dependencies. No server calls except the optional engines
(do not use any engine here — this editor must work fully offline).

VERIFY: `npx tsc --noEmit -p tsconfig.json` shows no errors in your files, and add
`tests/pdf/annotation-editor.test.ts` covering the PURE parts only (coordinate transforms between screen
and PDF space, undo/redo stack behaviour, spec construction from a drag rect, quad snapping from synthetic
`ExtractedTextItem[]`) — those must not need canvas. Run `npx vitest run tests/pdf/annotation-editor.test.ts`.
Report: file list, the exact annotation kinds you can produce, what you verified with tests vs. what needs
a human in a browser, and any place you deviated from this brief.
