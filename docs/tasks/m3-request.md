# M3 → other workers

M3 landed the page organizer's UX pass: `src/components/tools/pdf/organize/**`
plus `tests/pdf/ux-organize.test.ts`. Nothing here needs a decision from you
unless you own the file named.

## What changed under M3's ownership

- `organize/plan.ts` **added** — the plan model and the `pageOrder` grammar,
  moved verbatim out of `PageOrganizer.tsx`, plus multi-select variants
  (`rotatePlanItems`, `duplicatePlanItems`, `deletePlanItems`,
  `insertBlanksAfter`, `samePlan`, `describeItem`, `cardLabel`).
  `PageOrganizer` re-exports all of it (`export * from './plan'`), so
  `tests/pdf/page-organizer.test.ts` still imports from the old path — 39 tests,
  unchanged, still green.
- `organize/workspace.ts` **added** — the reducer Stirling's
  `trackWorkspaceReducer.ts` models and EmbedPDF leaves to the app: selection
  (Cmd-click / Shift-range), gap-based drag with a landing position, keyboard
  carry, per-document undo/redo, refusal text, the card projection, the mount
  window, and the keyboard map.
- `organize/preview.ts` **added** — E8/E9 geometry: the rotated thumbnail box,
  and `outputRotation(sourceAngle, planRotation)`.
- `organize/OrganizeMain.tsx` **deleted**. It was unreachable (nothing imports
  it; `registry.ts` lazy-loads `PageOrganizer`), it was the second implementation
  of the same surface, and it wrote the array plan shape. Its removal is the
  brief's "deleting dead components is preferred to refining them".
- `PageOrganizer.tsx` **rewritten against the reducer**: memoized card, mount
  window, toolbar with per-action disabled reasons, in-pane shortcut list, one
  live region, oversized end-of-list drop zone, drop-outside-is-no-op, and an
  export path that refuses a zero-output plan and discards a stale result.

## E9 defect fixed here, worth knowing about

`buildPlan` used to write `page.setRotation(degrees(item.rotate))`, which
**dropped the source page's own `/Rotate`**: a `/Rotate 90` page planned with
`r90` came out at 90° instead of 180°, while the preview showed 180°. It now
writes `sourceAngle + delta`, matching the thumbnail (pdf.js viewports already
honour `/Rotate`). Same rule the registry applies at
`lib/pdf/tools/organize.ts` ("only re-set the rotation when the plan says so").

## M5 — `shared/**`, `hooks/usePdfTool.ts`, `stores/process-store.ts`

1. `params.pageOrder` for the `organize` tool can now be **`[]`** (an empty
   array), not only a string. That is deliberate: the registry reads an empty
   *string* as "no plan was written" and would copy every page, so an emptied
   grid would have pressed Run into "Done" for a document the user deleted page
   by page (E13). `planFromValues`'s array branch already throws `NO_PAGES` with
   the right sentence. Please make sure `PdfToolPanel` renders a non-string field
   value without crashing and shows the field as empty.
2. If you can cheaply surface it: the pane computes the same refusal
   (`planRefusal` in `organize/workspace.ts`) — a one-line reason under **Run**
   would make the two surfaces agree instead of disagreeing about what is
   runnable.

## M6 — `lib/pdf/tools/*.ts` (definitions only)

- The comment at `lib/pdf/tools/organize.ts:2607` still says "the older
  `OrganizeMain` pane writes an array". `OrganizeMain` is gone; the only writer
  of the array shape is now `PageOrganizer`, and only for the explicit empty
  plan described above. Reword when you next touch that file.
- The `organize` tool's `pageOrder` field help could say what the grid guarantees
  instead: "The page grid writes this for you. Type over it only if you want to;
  an empty plan is refused rather than treated as all pages."

## M1 — `editor/**` (no action needed, but a dependency to keep)

`organize/workspace.ts` imports two of your modules instead of re-inventing
them, so please keep these exports stable:

- `editor/history.ts`: `HistoryState`, `createHistory`, `pushHistory`,
  `undoHistory`, `redoHistory`, `canUndo`, `canRedo`.
- `editor/shortcuts.ts`: `Shortcut`, `historyCommandForKey`, `isTypingTarget`.

One note: `isTypingTarget` treats every `<input>` as a typing target, including
checkboxes and radio buttons. Stirling's map deliberately keeps the shortcuts
for those (`NON_TEXT_INPUTS`), so `organize/workspace.ts` applies that exemption
before delegating to you rather than editing your file. If you want the same
behaviour in the annotation editor, the predicate is `takesTyping` there and can
move into `editor/shortcuts.ts` verbatim.

## Verification (mine, run in isolation)

- `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E "pdf/organize"` → empty.
- `npx vitest run tests/pdf/ux-organize.test.ts tests/pdf/edge-organize.test.ts
  tests/pdf/edge-editors.test.ts` → green.
- Also green: `tests/pdf/page-organizer.test.ts`, `tests/pdf/registry.test.ts`.
