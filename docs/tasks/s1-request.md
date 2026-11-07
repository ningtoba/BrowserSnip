# S1 → other workers (sidebar removal, wave 1)

Owned and finished in `AppLayout.tsx`, `CommandPalette.tsx`, `hooks/useIsCompact.ts`,
`lib/recents.ts`, `tests/app/shell.test.tsx`. Everything below is a file I do
**not** own, so it is a request, not a change I made.

## 1. Engine UI: zero importers left in `src/` (for S2)

Per the brief's "Engines: silent, not deleted" ruling (confirmed by the
orchestrator as my file to clean), the shell no longer renders any engine
affordance. Deleted from `AppLayout.tsx`: the `EngineSettingsDialog` import and
mount, `useEngineStatus`, the top-bar **Engines n/3** chip, the mobile ⚙ button
and the local `EngineRequirementBadge` + its per-tool render in `ToolPageHeader`.

Tree-wide grep for `EngineGate|useEngineStatus|EngineSettingsDialog|EngineBadge|EngineRequirementBadge`
now matches **only** comments and the ratchet lists in
`tests/pdf/engines-provider.test.ts:403` and `tests/pdf/engine-auto.test.ts:58-62`.
`src/components/tools/pdf/text-editor/TextEditor.tsx` also stopped importing it.
Nothing in `src/` needs a follow-up from me.

One consequence to confirm you intended: with the dialog gone, nothing writes
`ENGINE_STORAGE_KEY` (`browsersnip:wasm-engines`) any more — `provider.ts:183` is
the only `setItem`. A mirror URL saved by an older build is still honoured, with
no UI left to change or clear it.

## 2. Degradation must be said in the run surface (for S2 / M5)

Removing the badge must not remove the honesty. The contract I assumed, and the
one my shell test pins: a run that skipped optional-engine work reports it in
`result.warnings`, which reaches the store (`runner.ts:297`) and renders in
`shared/ResultCard.tsx:157`. `tests/app/shell.test.tsx` → *"degraded runs still
speak"* renders a `ResultCard` with `degraded` + a warning naming the unreachable
engine, so the surface demonstrably carries the sentence. If S2's auto-provision
path can end a run with work skipped and **no** warning string, that is a finding
against `engine-auto.test.ts`, not against the shell.

## 3. Dead CSS now that the rail is gone (owner of `src/index.css`)

These selectors have zero remaining uses in `src/` and `tests/` (verified with a
word-boundary grep over both trees). Deleting them is what stops a later reader
from assuming the rail still exists:

- `.shell-rail`, `.shell-nest`, `.shell-row`, `.shell-row-active` — the rail, its
  category nesting and its rows (my deletion).
- `.shell-badge`, `.shell-badge-ok`, `.shell-badge-warn` — engine badges (the
  `EngineGate` UI is deleted).
- `.shell-dot-ok`, `.shell-dot-idle` — the "Engines n/3" status dot.

Still used, do **not** delete: `.shell-app`, `.shell-header`, `.shell-rule`,
`.shell-hairline-t`, `.shell-title`, `.shell-soft`, `.shell-muted`, `.shell-accent`,
`.shell-link`, `.shell-meta`, `.shell-btn`, `.shell-btn-active`, `.shell-icon-btn`,
`.shell-kbd`, `.shell-scrim`, and every `.palette-*` rule.
Note `tests/app/shell.test.tsx` asserts `.shell-rail` is absent from the rendered
shell, so it keeps passing either way.

## 4. Two word-level leftovers in files I do not own

- `src/stores/ui-store.ts` — `sidebarOpen: true` and `toggleSidebar()` have no
  readers anywhere (`ToolWorkspace` only touches `showLogMonitor`/`toggleLogMonitor`).
  The state setter outlived the sidebar; delete both. (`activeTool` +
  `setActiveTool` in the same store are also unread — `file-store`/`process-store`
  own the real session — but that may predate this pass.)
- `src/components/layout/ToolWorkspace.tsx:295-297` — the comment says
  `AppLayout`'s `ToolPageHeader` "carries the breadcrumb, the promise, the engine
  badge and the star". There is no engine badge any more; drop those three words.

## 5. What the palette now owns (no action needed, FYI for wave 2)

`⌘K` / `Ctrl-K` **or** the header Search button opens it. On an empty query the
bands are Starred → Recent → All tools, keyboard-walkable, each row showing the
tool's category and one-line promise (recent rows show the file name, its size,
age and the tool it came from). `Clear recent files` moved into the Recent band
heading. Stars are set from `ToolPageHeader` only — the palette marks a starred
row with ★ but does not toggle it, so a wave-2 polish could add a star action to
the palette without a second source of truth appearing.
