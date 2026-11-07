# UX pass — brief

Read this fully. It is the contract between parallel workers; file ownership is
not negotiable because concurrent writers overwrite each other.

## What the user asked for, in their words

> "ok please remove the sidebar, the engines (I dont care if you want to use cdn
> engine just apply it). what I meant by enhance is like for example the text box
> need to be refine, when click to put text box the selection auto goes to the
> cursor (select) again, highlight need to be done properly. Enhancing in this
> context is enhance all the small things and the user experience. You can
> literally spawn 1 subagents for each module and spawn a subagent for each
> submodule ... Look at different example of implementation. Please go through
> all the pdf tools"

Three separate things:

1. **Remove the sidebar and the engines UI.** Engines stay useful, silently.
2. **Fix the annotation editor's interaction model** — the two named bugs below
   are examples of the class, not the whole of it.
3. **"Enhance all the small things"** across every tool: focus, hover, drag
   feedback, empty states, error copy, keyboard, defaults, affordances.

## The two named bugs (fix these exactly, then the class)

**Bug 1 — the tool does not step aside after it is used.**
Pick the text-box tool, click on the page to place a box: the *tool* stays on
"Text box". So the next click on the page makes a second box instead of moving
or editing the one just placed, and the caret you are typing into is inside a
layer the Select tool owns. Expected: after the box is placed, the active tool
returns to **Select** and the new box is the selection — cursor, drag handles,
arrow-key nudge and Delete all work on it immediately. Same rule for **Stamp**,
**Image**, **Signature**, **Shape**, **Arrow** and any other one-shot placement
tool: place once, hand control back.
**Ruled by the user, so this is settled — implement it exactly:**

- One-shot by default: Text box, Stamp, Image, Signature, Link. Place → Select.
- Sticky by default, no pin needed: Pen, Highlight, Underline, Strike-out,
  Rectangle, Ellipse, Line, Arrow, Freeform.
- **A visible pin/lock on every placement tool** overrides the default. Pinned
  Text box keeps placing on each click until unpinned or `Esc`. This is the
  answer to "pdf.js never reverts" versus "Acrobat always reverts": the resting
  state is a cursor, and stickiness is the user's explicit choice, not a side
  effect of the implementation order.
- Pin state must be visible on the tool button (`aria-pressed`, a lock glyph or
  filled state) and must survive selecting another object; `Esc` unwinds one
  level at a time — dismiss the in-progress edit, then clear the selection, then
  unpin, then disarm the tool.
- Sticky-vs-one-shot is a declared property of each tool (`afterCreate` in the
  tool spec, following EmbedPDF's vocabulary), never an accident of which handler
  returns first.

**Bug 2 — highlight is not done properly.**
Dragging a highlight must select the *text*, not a rectangle. Concretely: snap
the drag to real line boxes from the text layer (the module already computes
quads), so a highlight covers the words and not the leading above them; a drag
that crosses a line produces **one highlight annotation carrying one quad per
line** — the way the PDF spec, pdf.js and EmbedPDF all do it — so it moves,
resizes and deletes as a single object while still hugging each line. NOT one
box spanning two lines and covering the gap between them, and NOT one separate
annotation per line; (an earlier draft of this brief said "one mark per line",
which the research wave correctlyoverturned: it splits the user's single intent into
several objects they then have to select repeatedly). releasing the drag with no words underneath must create
nothing rather than an empty mark; and clicking an existing highlight selects
*that* mark instead of starting a new one. Underline and strike-through are the
same code path and must inherit all of it.

## Ground rules

- **100 % client-side. Nothing uploads.** No new network dependency except the
  existing jsDelivr engine fetch.
- Keep the existing doodle/light design language and its tokens. No new hex
  literals in components — use `--panel-bg`, `--text-muted`, `shell-*` classes,
  or the Tailwind palette. Dark mode has tokens; do not regress it.
- `npx tsc -p tsconfig.json --noEmit` must stay **0 errors**.
- Never run the full test suite (other workers are writing). Run only your own
  test files plus the ones named in your task.
- Filter typecheck noise to your paths; errors from files you do not own belong
  to someone else mid-edit.
- Every behaviour you add gets a test. jsdom has **no canvas**: assert on model,
  geometry, state-machine and DOM invariants, never on pixels.
- An interaction change that breaks an existing test means one of two things: you
  regressed it, or the test encoded the old wrong behaviour. Say which, in your
  report. Do not quietly delete assertions.
- Accessibility is part of "the small things": visible focus ring, `aria-pressed`
  on tool toggles, `role="toolbar"`, keyboard reachability for every pointer-only
  action, `aria-live` for status, and undo/redo reported to assistive tech.
- Fork traps that have already bitten this repo: `dict.lookup`/`lookupMaybe`
  **throws** on a type mismatch — read the object and narrow it yourself when a
  key's type varies (`/Encoding`, `/OCGs`, `/Annots`); `embedFont`/`save`/
  `decodePDFRawStream().decode()` are async; never `page.drawText` with a WinAnsi
  font — go through `core/fonts.ts` (`drawTextU`).

## Architecture decisions (already made — do not relitigate)

### Sidebar goes away

`AppLayout`'s left `<aside>` (categories with counts, starred list, recent files,
~124 tool rows) is removed. It duplicated the dashboard and stole ~16rem of
workspace width from tools that need it.

What replaces it, with no chrome cost:
- ⌘K / Ctrl-K palette becomes the only way to jump tools, and gains **Starred**
  and **Recent** sections at the top of an empty query. Recents/starred keep their
  existing `lib/recents.ts` storage; the *list UI* goes, the capability does not.
- The tool page keeps its breadcrumb header (that is not the sidebar) and the
  dashboard link.
- The compact/mobile drawer behaviour must stay coherent: with no rail, the menu
  button and `useHasRail()` consumers must not strand a control that opens
  nothing.

### Engines: silent, not deleted

Today `runPdfTool` **throws** `NEEDS_ENGINE` when `engines.isConfigured(id)` is
false, and only three tools declare engines (all in `optimize.ts`). Removing the
check without provisioning would turn a clear error into a crash. So:

- Delete the UI: `EngineSettingsDialog`, the top-bar "Engines 3/3" chip,
  `EngineBadge`, `EngineRequirementBadge`, and the per-tool engine note in
  `ToolPageHeader`.
- Resolve the engine automatically from the existing default CDN source when a
  tool needs it. The user must never be asked to "enable" something.
- If the fetch fails (offline, blocked CDN), **degrade with an honest sentence**
  naming what was skipped and what still happened, via `result.warnings`, or a
  clear error if there is no fallback. Never a blank pane, never a silent lie.
- 15–56 MB WASM downloads must not start on page load; fetch only when a tool
  that needs one actually runs.

## The structural finding this pass must fix

There are **two implementations** of the PDF operations in this repo:

1. `lib/pdf/tools/**` + `tools/runner.ts` — the registry path. Has the guard
   layer (`core/guard`), field clamping with a stated reason (E15), password
   pre-flight (E4/E5), duplicate handling (E16), structural `warnings`, per-file
   progress and the single-owner pdf.js sessions.
2. `hooks/usePDFEngine.ts` → its own `executeToolCommand` switch →
   `lib/pdf-engine/commands`. This path has **none** of the above.

Six live surfaces still run on the legacy path — `CompressTool`, `SignTool`,
`RedactTool`, `CompareTool`, `CropTool`, `ScanTool` — so the editors and tools a
person actually clicks behave differently from the 100+ registry tools: different
error copy, no validation, no warnings, no progress. Seventeen further
components import the legacy hook but are referenced by nobody
(`MergeTool`, `SplitTool`, `RotateTool`, `OrganizeTool`, `RemovePagesTool`,
`ExtractPagesTool`, `RepairTool`, `ProtectTool`, `UnlockTool`, `PageNumbersTool`,
`WatermarkTool`, `ImageToPDFTool`, `HTMLToPDFTool`, `DigitizeDocumentTool`,
`PDFToWordTool`, `PDFToExcelTool`, `PDFToPdfATool`) — the registry replaced them
and they were never deleted.

Consequence for this pass: **nobody polishes a surface until it is on the one
path.** Deleting dead components is preferred to refining them; a UX pass over 17
files nobody can reach is cost with no user. Verify reachability yourself before
deleting (`grep -rl "<ComponentName>" src/ | grep -v <file>`), and check
`ToolWorkspace.tsx`'s lazy `mainViewFor` map, which references by string path.

## Waves

**Wave 1 — structure and research:** S1 (sidebar), S2 (silent engines),
S3 (one dispatch path), R1–R3 (reference research, read-only).
**Wave 2 — module UX, after wave 1 lands:** M1–M6.

## Module ownership

| Worker | Wave | Owns |
|---|---|---|
| S1 | 1 | `src/components/layout/AppLayout.tsx`, `CommandPalette.tsx`, `hooks/useIsCompact.ts`, `lib/recents.ts`, `tests/app/shell.test.tsx` |
| S2 | 1 | `src/lib/pdf/engines/**`, `core/engine-ops.ts`, `tools/runner.ts`, `tools/optimize.ts`, `tests/pdf/engines-*.test.ts`, new `tests/pdf/engine-auto.test.ts` |
| S3 | 1 | `src/hooks/usePDFEngine.ts`, `src/lib/pdf-engine/**`, `optimize/CompressTool.tsx`, `security/{SignTool,RedactTool,CompareTool}.tsx`, `edit/CropTool.tsx`, `scan/ScanTool.tsx`, the 17 unreferenced `*Tool.tsx` files it deletes, new `tests/pdf/one-path.test.ts` |
| R1–R3 | 1 | `docs/research/ux-references-*.md` only (read-only elsewhere) |
| M1 | 2 | `src/components/tools/pdf/editor/**`, new `tests/pdf/ux-annotation.test.ts` |
| M2 | 2 | `src/components/tools/pdf/text-editor/**`, new `tests/pdf/ux-text.test.ts` |
| M3 | 2 | `src/components/tools/pdf/organize/**`, new `tests/pdf/ux-organize.test.ts` |
| M4 | 2 | `security/{SignTool,RedactTool,CompareTool}.tsx`, `forms/**`, `edit/{CropTool,PageNumbersTool,WatermarkTool}.tsx`, `scan/**`, new `tests/pdf/ux-surfaces.test.ts` |
| M5 | 2 | `shared/**`, `hooks/usePdfTool.ts`, `stores/process-store.ts`, new `tests/pdf/ux-rail.test.ts` |
| M6 | 2 | `src/lib/pdf/tools/*.ts` (definitions only: labels, help, defaults, groups, promises), new `tests/pdf/ux-definitions.test.ts` |

Workers on the same wave must not touch another's files. Requests go to
`docs/tasks/<yourid>-request.md`.

## The checklist every surface must pass

Not a style wishlist — each item is a behaviour a user hits in seconds.

**Pointer**
- Hover tells you a thing is interactive (cursor, ring, or affordance). Nothing
  clickable looks inert.
- Active/dragging state is visible while it lasts (grabbed element lifts, a
  marquee draws, a drop indicator shows the landing gap).
- No click target under ~28 px; adjacent targets are separated.
- Drag has an honest drop target and a visible insertion indicator; dropping
  outside is a no-op, not a corruption.
- Resize handles exist, are ≥8 px with a hit slop, and have direction-correct
  cursors (`nwse-resize` etc.).
- Double-click does the obvious thing (edit text, open a page).

**Keyboard**
- Every pointer action has a key equivalent; `Tab` order follows the visual
  order; focus is visible, never `outline: none` without a replacement.
- `Esc` unwinds one level: close editor → deselect → clear tool. Not "close the
  app".
- `Delete`/`Backspace` removes the selection; arrow keys nudge it (1 px, Shift
  10 px); `Cmd/Ctrl-D` duplicates; `Cmd/Ctrl-Z` / `Shift-Z` undo/redo.
- Shortcuts are suppressed while typing in an input, textarea, `contenteditable`,
  or a select with an open list.
- The shortcut list is reachable from inside the surface, not only in docs.

**State and feedback**
- Empty, loading, ready, running, done and error are visually distinct and each
  names the next action.
- Disabled controls say *why*, in one line, near the control.
- Progress is per-file and per-stage for anything over ~1 s; no fake determinate
  bar when the work is unknown.
- Cancel is available during long work and actually stops it; a late result after
  cancel is discarded (E19).
- Results report what happened in numbers the user can check: pages in/out, size
  before/after, what was skipped.
- Nothing says "Done" when it did nothing (E13), and nothing says "compressed"
  when the file grew (E14).

**Text and copy**
- Sentence case, no period on buttons, verb on the primary action.
- Errors name the file, the value, and the fix. No internal class names, no
  stack traces, no `undefined`.
- Tooltips are one line; anything longer is a disclosure.
- Never ask the user to do something the app can do (count pages, guess a range,
  re-type a filename).

**Edge cases (the matrix in REFINEMENT-BRIEF.md still applies)**
- 1-page documents, 500-page documents, mixed page sizes, rotated pages,
  encrypted input, scanned pages with no text layer, CJK/RTL text, zero results,
  window resize mid-interaction, and switching documents mid-edit.

## Reference implementations to copy behaviour from

`docs/research/ux-references-*.md` (written by the research wave) records what
pdf.js's own viewer, EmbedPDF, Stirling-PDF, and the browser PDF tools do for
text boxes, highlight line-snapping, sticky vs one-shot tools, selection handles
and keyboard maps. Prefer matching a convention the user already knows over
inventing one.
