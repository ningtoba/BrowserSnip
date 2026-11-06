# A2 requests — changes needed outside `src/components/tools/pdf/shared/**`

A2 owns `shared/**`, `hooks/usePdfTool.ts`, `stores/process-store.ts` and
`tests/app/shared-ui.test.tsx`. Everything below is in someone else's file, so
it is requested rather than done. Each item names what A2 does today as a
stand-in, so nothing is blocked.

## 1. `PdfToolDefinition.promise` — to A1 (owns `lib/pdf/tools/types.ts`)

The rail prints a one-line "what you get" statement under the tool name.
`actionLabel` landed, `promise` did not. A2 reads it through
`PanelTool = PdfToolDefinition & { promise?: string }` and falls back to a
per-category sentence (`toolForm.ts` → `promiseFor`).

Please add, next to `actionLabel`:

```ts
  /** One line under the tool name: what the user gets when they press it. */
  promise?: string;
```

Phase-B authors can then write a per-tool sentence; until they do, the category
fallback is what ships.

## 2. Export the file-count rules — to A1 (owns `lib/pdf/tools/runner.ts`)

`fileProblem(tool, files)` is private, but the rail must disable the primary
action *before* the click (E18), which needs the same answers: no file, one
file at a time, `minFiles`/`maxFiles`, and the E16 duplicate-name refusal.
`usePdfTool` currently mirrors those four rules.

Requested: `export function fileProblem(tool, files): ToolInputError | null` (or
a thin `fileBlockers`) so there is one place that decides. If it is not
exported, the mirror in the hook has to be kept in sync by hand.

## 3. A structural home for run warnings — to A1 + Phase B

`ToolResult` has `message` and `sections`, but no warnings, so an honest run
that had to compromise ("OCR skipped on page 4", "Ghostscript unavailable, used
the core path") has nowhere to say it. The store now has `warnings: string[]`
and `ResultCard` renders them, and `usePdfTool` fills them by harvesting log
lines that read as a compromise:

```
/warn|degrad|skipp|fallback|could not|couldn.t|failed to|no text layer|larger than|ignored|became/i
```

That is a bridge, not a design. Preferred shape:

```ts
// types.ts — ToolResult members
warnings?: string[];
// runner.ts — RunOutcome
warnings: string[];   // tool warnings + the `clampFields` change messages
```

Once that exists, delete `WARNING_LINE` in `usePdfTool.ts` and pass
`outcome.warnings` to `setWarnings`.

## 4. One size formatter — to whoever owns `lib/utils/download.ts`

`describeSize` (guard, A1) and `formatFileSize` (download util) both exist and
disagree on rounding (`2.0 KB` vs `2 KB`). A2's components call
`formatFileSize`, because that is what every existing component uses. Pick one
owner and delete the other; A2 will follow whatever is left.

## 5. Dark mode for theme tokens — to A3 / the owner of `tailwind.config.js`

`shared/**` now uses only named tokens (`cream-light`, `cream-soft`,
`cream-border`, `ink-*`, `accent`, `success`, `warn`, `danger`, `doodle-*`,
`shadow-doodle`) — no hexes, except the `#000000` fallback of the colour-picker
input, which is a value rather than a style.

Those theme colours are still literal hexes in `tailwind.config.js`, so
`html.dark` does not reach them; only the `@layer components` classes
(`.doodle-input`, `.shell-*` …) read the CSS variables. Two ways to close it:

- point the theme colours at the variables (`ink: { DEFAULT: 'var(--text-strong)' … }`,
  `cream: { light: 'var(--panel-bg)', soft: 'var(--sunken-bg)', border: 'var(--hairline)' }`,
  `accent: { DEFAULT: 'var(--accent)' … }`) — one edit, and every existing
  component goes dark with no further work; or
- tell shared components to use the `shell-*` class set instead of colour
  utilities, and A2 will port `FileQueue`, `ResultCard`, `PageThumbs` and
  `PreviewPane` to it.

## 6. `usePdfTool` page count (informational, no edit needed)

Validation of `pages` fields needs the document's page count. The hook takes it
as an option (`usePdfTool(toolId, { pageCount })`) and `PdfToolPanel` feeds it
from `useFileStore.metadata` when it still describes the current file. Bespoke
surfaces that already open a `PdfSession` should pass `session.numPages`; guard
reads it from `values.pageTotal`, and A2 sets that when it validates.
