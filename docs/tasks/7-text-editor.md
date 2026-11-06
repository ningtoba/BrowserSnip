Build BrowserSnip's **in-place PDF text editor** at
`src/components/tools/pdf/text-editor/TextEditor.tsx` (cwd = repo root). This is BentoPDF's `/edit-pdf-text`:
"Click any paragraph and edit it in place with live reflow, fonts, and styling." This is the single most
requested PDF feature and BrowserSnip has nothing like it.

STRICT FILE OWNERSHIP — create/edit ONLY files under `src/components/tools/pdf/text-editor/` plus
`tests/pdf/text-editor.test.ts`. Do NOT touch registry.ts, constants.ts, types/index.ts, ToolWorkspace.tsx,
src/lib/pdf/** (other agents own those files), or other component dirs. No npm install. No git.

READ FIRST: docs/PDF-ENGINE-CONTRACT.md; src/lib/pdf/core/{content,redact,render,fonts,doc,pages,images}.ts;
src/components/tools/pdf/shared/PdfToolPanel.tsx; src/lib/pdf/tools/types.ts.

COMPONENT CONTRACT (registry.ts already lazy-imports this path):
  export default function TextEditor(): JSX.Element   // also `export { TextEditor }`
  No props. Reads `useFileStore`, writes `useProcessStore`.

HONEST ENGINE MODEL — do not fake it:
Real in-place content surgery (rewriting existing glyph runs) needs PDFium/PyMuPDF. The client-side-only
model that is genuinely correct and is what non-PDFium editors do:
  - click a paragraph → identify its block from `session.textItems(page)` (cluster by baseline + gap,
    reuse `joinReadingOrder`/`clusterRows` ideas from core/render + core/tables)
  - show an editable rich-text representation of that block in a positioned overlay with live rewrap
  - on commit: **delete the original runs** with `removeTextInRects` from core/content (real deletion, so
    the old text is not left selectable underneath), then draw the edited block back with
    `drawTextU`/`wrapText` from core/fonts at the same origin, using the extracted font size and colour as
    the initial style so the result looks like the original
  - if `removeTextInRects` reports `needsRasterFallback`, tell the user that block needs the optional
    PyMuPDF engine instead of silently producing doubled text.
Document this model in a comment at the top of the file.

REQUIRED UI (scope: build all of it, even where a control is simple):
- Toolbar: Back to upload / Open another PDF / Export (Ctrl+S) / Undo (Ctrl+Z) / Redo (Ctrl+Shift+Z).
- Tool modes: Edit (with an Edit Scope select: Text / Images / Shapes / All), Add text box, Add image.
- Format inspector panel: font family (bundled Noto + lazy script fonts + system fonts via the
  Local Font Access API where available, feature-detect `queryLocalFonts`), size 1–400, colour with
  swatches + custom picker, alignment left/centre/right/justify, style toggles bold/italic/underline/
  strikethrough/superscript/subscript, bullet + numbered lists with marker style and indent, text outline
  colour + width, line spacing, paragraph spacing, character spacing, word spacing, horizontal scale,
  first-line and hanging indent, and text direction Auto/LTR/RTL.
- Object manipulation on selection: rotate ±90, flip H/V, replace image keeping placement, duplicate,
  delete, bring to front / send to back, alt text.
- Multi-select align (left/centre/right/top/middle/bottom) and distribute horizontally/vertically.
- Zoom presets + fit page, page prev/next + jump-to-page, rulers toggle, hide/show bars.
- Find & Replace across EVERY page (not just the visible one): match case, whole word, ignore accents,
  next/prev match, Replace, Replace All, with a status line.
- "Copy this page's text in reading order".
- Toast notifications, and an OCR-layer notice when a page's text is an invisible layer (detect with
  `isInvisible` on extracted items) because those blocks are selectable but not editable.
- Warn before editing a signed document and export as an appended revision using `snapshot()` +
  `saveIncremental()` from core/doc so the original signature stays verifiable; warn that PDF/A
  conformance may break.

CONSTRAINTS: 100% client-side; no new dependencies; must not require any optional engine for the core
editing loop (engine only unlocks the fallback path).

VERIFY: `npx tsc --noEmit -p tsconfig.json` clean for your files. `tests/pdf/text-editor.test.ts` must cover
the PURE logic only (paragraph clustering from synthetic ExtractedTextItem[], find/replace matching with
case/whole-word/accent options, the style-model reducer, undo/redo, reflow line breaking) — no canvas.
Run `npx vitest run tests/pdf/text-editor.test.ts`.
Report: files, what the editor can really do vs. what is gated on the optional engine, and what needs a
human to click through in a browser.
