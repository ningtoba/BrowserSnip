# Parity sweep → shell/shared owner

From worker PARITY. Nothing here is a fix I could make inside my own files
(`src/lib/pdf/tools/*.ts` except `runner.ts`/`types.ts`, `src/components/dashboard/**`,
`src/components/landing/**`); each item needs a file you own. My tests already name
the debt, so each entry can be closed by emptying the list it points at.

1. **The collapsed summary echoes untouched defaults** — `shared/toolForm.ts`
   `describeOptions()`. It prints every visible field, so `change-permissions` ships
   267 characters into a `truncate`d one-line bar and the control that actually
   decides the output is cut off mid-word. Print only what the user changed, cap at
   three entries and say `+N more`.
   Tracked by `LONG_SUMMARIES` in `tests/pdf/parity-definitions.test.ts` (14 ids).

2. **The intake never uses its own footnote** — `shared/ToolSurface.tsx`.
   `FileIntake` already takes `footNote`, and the generated page passes nothing, so a
   tool with no fields shows a title, one line and a button, and a tool that takes a
   non-PDF format never names the accepted extensions before the picker opens.
   `footNote={intakeCopy(...).many + accepted formats}` plus `notes[0]` would fix both.

3. **Two stale routing keys and one collision** — `layout/ToolWorkspace.tsx`.
   `PDF_PANELS.crop` is a PDF panel behind a *video* tool id, so the video Crop page
   mounts both control sets in the same sidebar; `MAIN_VIEWS.annotate` and
   `MAIN_VIEWS['pdf-compare']` point at ids the registry no longer has.
   Tracked by `STRANDED_PANE_KEYS` in `tests/pdf/parity-surface.test.ts` — deleting
   the entries means shrinking that list, not extending it.

4. **One job, two ids** — `redact`/`redact-pdf` and `compare`/`compare-pdfs` are
   separate definitions with the same display name, so the catalogue holds two
   identical cards. The dashboard folds them via `CARD_ALIASES`
   (`src/components/dashboard/toolJobs.ts`) as a stopgap; folding the definitions is
   yours, and will also fix the ⌘K palette, which still lists both.

5. **`scan-to-pdf` is the one bespoke surface that skips the shared intake** — it is
   image-input, so `ToolWorkspace` opens its capture pane directly. That is
   deliberate, and `PANE_WITHOUT_INTAKE` in `tests/pdf/parity-surface.test.ts` records
   it; worth a look only if the camera pane's own drop-first state has drifted from
   the intake's typography.
