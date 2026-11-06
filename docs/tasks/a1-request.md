# A1 requests — input guard layer

The guard layer is in: `src/lib/pdf/core/guard.ts`, re-exported from
`src/lib/pdf/tools/helpers.ts`, wired into `openInputs` and `runPdfTool`.
Tests: `tests/pdf/guard.test.ts` (E1-E6, E15, E16).

Nothing below is a change I made to your files — it is what your files can drop
now that the shared layer exists.

## For A2 (`shared/toolForm.ts`, `shared/PdfToolPanel.tsx`, `hooks/usePdfTool.ts`)

1. **`ToolField` has the optional capabilities natively.** `types.ts` now
   declares `min`, `max`, `step`, `integer`, `pattern`, `optional`, `group`
   (all optional, so every existing definition still typechecks), and
   `PdfToolDefinition` has `actionLabel`. The `PanelField` / `PanelTool`
   intersections in `toolForm.ts` are no longer needed — delete them and import
   `ToolField` / `PdfToolDefinition` directly. (`promise` is yours to keep, or
   ask and I will add it to `types.ts`.)
2. **Use one definition of "valid" so the rail and the runner agree.** The rail
   currently re-derives the numeric rules; `core/guard` exports the ones the
   runner already applies before `tool.run`:
   - `validateFields(fields, values): FieldIssue[]` — `REQUIRED`,
     `NOT_A_NUMBER`, `OUT_OF_RANGE` (with `suggestion`), `NOT_INTEGER`,
     `BAD_PATTERN`, `BAD_PAGE_RANGE`. Hidden fields (`when` false) are skipped.
   - `clampFields(fields, values): { values, changes: FieldClamp[] }` —
     `changes[].message` is already a sentence
     (`"Resolution must be between 96 and 400 dpi: 0 became 96."`), which is the
     E15 notice the rail should show.
   - `fieldBounds(field)`, `clampNumber(value, min, max, { integer })`,
     `pageRangeProblem(value, pageCount): string | null` (E6: `null` for page 1
     of a 1-page file, a sentence for page 2), `describeSize(bytes)`.
   Import them from `@/lib/pdf/tools/helpers` (façade) or
   `@/lib/pdf/core/guard` (definition) — both are stable.
3. **Stop pattern-matching the password message.** `usePdfTool.ts` does
   `if (/password/i.test(message)) setLocked(true)`. Use
   `isPasswordRequired(error)` instead: it understands `ToolInputError`
   (`code: 'PASSWORD_REQUIRED' | 'BAD_PASSWORD'`, `passwordRequired: true`),
   `PasswordRequiredError` from `core/doc`, and the older prose. For the error
   pane, `describeToolError(error)` returns
   `{ code, message, fileName, hint, passwordRequired }` — `fileName` is what a
   `FileQueue` row highlights, and `hint` is the second line `ErrorPanel` wants.
4. **`FileQueue` does not need its own probe.** `runPdfTool`'s pre-flight is
   already shared: `inspectFiles(files, password?)` from
   `@/lib/pdf/tools/runner` returns one `PdfInspection` per file —
   `{ name, size, isPdf, pages, declaredPages, encrypted, algorithm,
   needsPassword, passwordAccepted, permissions, version, truncated, recovered,
   error, message, hint, detail }`. `error` is `null` or a code, so a row can
   render ready / locked / damaged / not-a-PDF without reading bytes itself.
   `inspectPdf(bytes, name, { cheap: true })` is the no-parse variant (header +
   trailer only) if you want per-keystroke checks on a 500-page file (E7).
5. **E16 is already decided, per tool arity**: a byte-identical repeat is
   opened once and logged by `openInputs` (multi-document tools), and a single-
   document tool rejects the list before the run with
   `"x.pdf" appears twice in the selection.` Please do not re-warn in the panel —
   read the run log instead. Likewise a recoverable file logs
   `Recovered "x.pdf": read 3 of 4 pages.` (E3).

## For B workers (per-tool definitions)

1. Call `openInputs(context)` / `openPrimary(context)` and trust it: an empty
   file, a renamed JPEG, a locked document and a pageless PDF are refused with
   `ToolInputError` naming the file before your `run` body executes. Do not
   hand-roll `bytes.length === 0` or `%PDF` checks.
2. Declare `min` / `max` / `integer` on every numeric field. `runPdfTool` clamps
   out-of-range values into them and logs the reason, so `dpi: 0` cannot reach
   your code (E15). Declare `pattern` for formatted text and `required` for
   fields the tool cannot default.
3. Group rail fields with `group`, and give the tool `actionLabel` (the panel
   then says "Merge", not "Run").
4. If a tool needs the password before `openInputs`, pass
   `openInputs(context, { password })`. If it needs the document's encryption
   facts, they are on `OpenedInput.inspection` (algorithm, permissions, pages).
