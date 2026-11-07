# Refinement + edge-case pass — master brief

Read this fully before touching anything. It is the contract between parallel
workers; violating file ownership causes lost work.

## What the user rejected

Live tool pages were compared with `ihatepdf.cv` (reference) and the verdict was
**"the tools are not refined"** — and explicitly **"focus on tools functionality,
not only design"**.

Concrete defects found in our own UI (from screenshots of `/tool/merge`,
`/tool/pdf-compress`, `/tool/edit-pdf`):

1. A ~320 px settings rail holding a tiny drop zone, two checkboxes with
   paragraph-length explanations, and a generic **Run** button — next to a
   1 000 px empty void. The workspace dominates visually but contains nothing.
2. **No preview of anything.** No page thumbnails, no before/after, no result
   summary. `pdf-compress` renders an image of the page but never shows it.
3. No real states. Nothing is disabled until valid, there is no per-file
   progress, errors land in a "Log" pane as text, and empty vs loading vs
   ready vs done are not visually distinct.
4. No app shell affordances: no tool search, no recent files, no starred tools,
   no dark mode.
5. Editors open on a wall of tools with no routing: the user must infer that
   "Sign" or "Annotate" live inside `edit-pdf`.
6. Functionally: tools accept inputs they cannot honour and report success
   anyway (see matrix below).

**Layout decision (user chose):** keep the two-column rail + workspace. Do **not**
replace it with a centred drop-first page. Make the rail excellent: grouped,
labelled, validated, honest about state, and give the workspace a real job —
preview and thumbnails.

## Ground rules

- **100 % client-side.** No uploads, ever. Nothing new may require a server.
- MIT core only for bundled code. Optional AGPL engines (PyMuPDF/Ghostscript/
  cpdf) stay lazy-loaded behind `engines/EngineGate` and must degrade with an
  honest message, never a fake success.
- `npx tsc -p tsconfig.json --noEmit` must stay **0 errors**.
- Do not edit files another worker owns. If you need a change there, write it to
  `docs/tasks/<your-number>-request.md` instead.
- Every behaviour you add gets a test in **your own** test file (listed below).
  Never edit another worker's test file.
- Tests run with `npx vitest run <your file>`; do not run the whole suite (slow,
  and other workers are writing).
- **Screenshots are judged on `BASE=http://localhost:5223`** — start it with
  `npx vite --port 5223 --strictPort`. The `5199` in the older passes' notes is
  stale: another worker holds it. Harness:
  `node /tmp/shot2.mjs <toolId> <out.png> <light|dark> [file.pdf]` at 1440×1150,
  light **and** dark, with a real PDF loaded — an empty page proves nothing.
- pdf-lib is the `@maxwbh/pdf-lib` fork. `embedFont`/`save`/`decodePDFRawStream`
  are **async**; `registerFontkit` before custom fonts; no
  `insertOutlineEntry`/`getOutline`/`insertBlankPage` — use
  `addPage([w,h])`/`insertPage(i,[w,h])`. Load with
  `{ updateMetadata: false }` for metadata round-trips.
- Never call `lookupMaybe(dict, XClass)` on a dict entry whose type varies
  (`/Encoding` is a name on simple fonts, a dict on CID fonts) — it throws. Read
  it and narrow manually.
- All drawn text goes through `core/fonts.ts` (`drawTextU` / `linesOf`), never
  `page.drawText` with a WinAnsi font — non-Latin text crashes otherwise.
- jsdom has no canvas; component tests must not require real 2-D rendering.
  `tests/setup.ts` stubs `IntersectionObserver` and `ResizeObserver`.

## Edge-case matrix

Every tool must be checked against the cases that apply to it. "Applicable"
means the tool reads or writes that property.

| # | Case | Expected behaviour |
|---|------|--------------------|
| E1 | 0-byte file | Clear rejection naming the file, before any parse |
| E2 | Not a PDF (renamed .jpg/.txt/.docx) | Rejection mentioning the format, not "failed" |
| E3 | Corrupt/truncated PDF | Recover or report which page broke; never silent success |
| E4 | AES/RC4 encrypted, no password | Ask for password; do not hang |
| E5 | Encrypted + correct password | Succeeds; output is **not** still encrypted |
| E6 | Single page | Every "range/page" control accepts page 1 and rejects 2 |
| E7 | 500+ pages | No O(n²) freeze; progress reported; memory bounded |
| E8 | Mixed page sizes | No crash; per-page geometry respected |
| E9 | Rotated pages (/Rotate 90/180/270) | Preview and output orientation match |
| E10 | No text layer (scanned) | Say so and offer OCR, don't report "0 characters, done" |
| E11 | CJK / RTL / accents / emoji | Renders via embedded Unicode font, no crash |
| E12 | Huge embedded image | Progress, and no unbounded base64 string |
| E13 | Zero results (no forms, no tables, no images) | Honest empty state, not an empty download |
| E14 | Output larger than input (compress) | Report the delta; offer to keep the original |
| E15 | Value out of range (dpi 0, quality 200, negative margin) | Clamped or rejected with a reason |
| E16 | Duplicate input files | Handled, not merged twice by accident |
| E17 | Filename with spaces/unicode | Download name is sane |
| E18 | Tool run with nothing selected | Primary action disabled before the click |
| E19 | Cancel / new file mid-run | No stale output, no double-download |
| E20 | Feature needing an absent engine | Explicit "install engine / degraded" message |

## Phase A — shared foundation (4 parallel workers, disjoint files)

### A1 — Input guard layer  ·  `docs/tasks/a1-guard.md`
Owns: `src/lib/pdf/core/guard.ts` (new), `src/lib/pdf/tools/helpers.ts`,
`src/lib/pdf/tools/types.ts`, `tests/pdf/guard.test.ts`
Add a single validation gate every tool passes through, so E1–E5, E15, E18 stop
being per-tool afterthoughts:
- `class ToolInputError extends Error { code, fileName, hint }` with codes for
  `EMPTY_FILE`, `NOT_A_PDF`, `CORRUPT`, `PASSWORD_REQUIRED`,
  `BAD_PASSWORD`, `UNSUPPORTED`, `NEEDS_ENGINE`, `OUT_OF_RANGE`, `NO_PAGES`.
- `inspectPdf(bytes, name)` → `{ pages, size, encrypted, needsPassword,
  permissions, isPdf }` using a cheap header/trailer check before any parse, and
  never throwing on garbage input.
- `openInputs` in `helpers.ts` must call it: reject E1/E2 with the file name,
  detect E4/E5 and surface `passwordRequired` to the UI instead of a stack trace.
- Extend `ToolField` with `min/max/step/integer/pattern/optional/group` so
  `PdfToolPanel` can validate numerically (E15) — keep the union backwards
  compatible; every existing tool must still typecheck unchanged.
- Export `clampNumber`, `parsePageRanges` (1-based, tolerant of `1-3,5,7-`,
  rejects inverted ranges and 0), `describeSize`.
Tests: E1–E6, E15, E16 over synthetic bytes (truncated, garbage, encrypted via
`core/signature`+`security` helpers or a fixture you build in-test).

### A2 — Rail, states, previews  ·  `docs/tasks/a2-shared.md`
Owns: `src/components/tools/pdf/shared/**` (including `PdfToolPanel.tsx`),
`src/hooks/usePdfTool.ts`, `src/stores/process-store.ts`,
`src/components/tools/pdf/shared/OutputActions.tsx` if present,
`tests/app/shared-ui.test.tsx`
Build the pieces every bespoke tool surface will reuse:
- `FileQueue` — per-file rows: name, size, page count, thumbnail strip, remove,
  reorder handles, per-file progress bar, and a named error state (E1/E2/E4).
- `PageThumbs` — renders N page thumbnails from a `PdfSession` via
  `core/render.ts`, virtualised enough for E7 (render visible window only),
  click-to-select, selection range shift-click, `Rotate`/`Delete` affordance
  hooks.
- `PreviewPane` — the void's job: page preview with zoom/fit, page stepper,
  rotate, and a **before/after** split for transform tools.
- `ResultCard` — output name, size before → after with %, page count, engine
  used or "degraded", warnings from the run report, Download + Download all +
  Zip.
- `EmptyState`, `ErrorPanel` (recoverable, names the file, offers Retry),
  `ProgressBar`.
- `PdfToolPanel`: group fields (`group`), label + unit + clamp inline validation
  (E15/E18), disable primary action until inputs are valid, replace "Run" with
  the tool's own verb (`tool.actionLabel ?? verbFor(tool)`), show a
  "what you get" one-liner under the title, and render `notes` as a collapsible
  honesty panel rather than loose text.
- Store: add `phase: 'idle'|'inspecting'|'ready'|'running'|'done'|'error'`,
  per-file progress map, `warnings`, `sizeBefore/After`. Keep existing API
  working — 400+ tests depend on it.
Tests: state transitions, disabled-until-valid, clamp messages, FileQueue error
naming, ResultCard delta text. No canvas dependency.

### A3 — App shell  ·  `docs/tasks/a3-shell.md`
Owns: `src/components/layout/AppLayout.tsx`, `src/components/layout/CommandPalette.tsx` (new),
`src/lib/recents.ts` (new), `src/index.css`, `src/hooks/useTheme.ts` (new),
`src/hooks/useIsCompact.ts`, `tests/app/shell.test.tsx`
- ⌘K/Ctrl-K command palette over the registry: fuzzy name + keyword + category,
  arrow keys, Enter navigates, Esc closes, empty-state "no tools match".
- Category nav rail with counts, collapsible, current-tool highlight.
- **Recent files** (name, size, tool, timestamp) and **starred tools**, persisted
  in `localStorage` under namespaced keys, capped (e.g. 12 recents), with a
  "Clear" action. Note: recent = metadata only; never store file contents.
- **Dark mode** toggle, class-based (`html.dark`) wired through the existing
  doodle tokens in `index.css` — light stays default; every token used by the
  shell must have a dark value, and no component may hard-code a hex.
- Tool page header: breadcrumb + one-line promise + engine badge when the tool
  uses one.
Tests: palette filters correctly, keyboard nav, recents cap and persistence,
star toggle, theme class toggles and persists.

### A4 — Editors  ·  `docs/tasks/a4-editors.md`
Owns: `src/components/tools/pdf/editor/**`, `src/components/tools/pdf/text-editor/**`,
`src/components/tools/pdf/organize/**`, `src/components/tools/pdf/forms/**`,
`src/components/tools/pdf/security/{SignTool,RedactTool,CompareTool}.tsx`,
`src/components/tools/pdf/edit/CropTool.tsx`,
`src/components/tools/pdf/scan/**`, `tests/pdf/edge-editors.test.ts`
- **Quick-mode chips** on the empty editor state — `Sign`, `Edit text`,
  `Annotate` — routing into the right tool with the right panel preselected.
- Reassurance microcopy in the drop card ("It never leaves this device").
- Rail-style inspector for tool options; keyboard shortcuts (V/H/T/P/Esc/Delete/
  Ctrl-Z/Ctrl-Y) with a visible shortcut list.
- Edge cases specific to editors: E6 (1-page doc), E8 (mixed sizes), E9
  (rotated pages must not misplace marks), E10 (text editor on a scanned page →
  must say "no text layer here — run OCR" instead of silently offering nothing),
  E11 (CJK blocks), E13 (redaction selecting nothing), E19 (switch documents
  mid-edit), E20 (blocks that need PyMuPDF).
- Crop/organize: reject empty selection, clamp ranges to page count, keep
  rotation state, warn when the plan has 0 output pages.
Tests: model/geometry/history invariants (no canvas), quick-mode routing,
scanned-page messaging, clamping.

## Phase B — per-tool bespoke pass (after A lands, 6 parallel workers)

Each worker owns exactly one tool-definition file plus one test file, and must
give every tool in its category: an honest capability statement, a real preview
or result presentation, validation, and tests for its applicable matrix rows.
Categories and counts: organize 23, optimize 9, edit 21, security 19,
convert-to 35, convert-from 17 (+4 legacy, 8 office).

| Worker | Owns |
|---|---|
| B1 | `tools/organize.ts`, `tests/pdf/edge-organize.test.ts` |
| B2 | `tools/optimize.ts`, `tools/legacy.ts`, `tests/pdf/edge-optimize.test.ts` |
| B3 | `tools/edit.ts`, `tests/pdf/edge-edit.test.ts` |
| B4 | `tools/security.ts`, `tests/pdf/edge-security.test.ts` |
| B5 | `tools/convert-to.ts`, `tools/office.ts`, `tests/pdf/edge-convert-to.test.ts` |
| B6 | `tools/convert-from.ts`, `tests/pdf/edge-convert-from.test.ts` |

Rules for B: do **not** edit `types.ts`, `helpers.ts`, `registry.ts`,
`PdfToolPanel.tsx`, or shared components — request changes in
`docs/tasks/bN-request.md`. `registry.test.ts` guards invariants; keep ids and
`outputSuffix` unique, keep descriptions ≥ 4 words, and give every tool a `run`
or `unavailable` reason.
