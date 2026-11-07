# Catalogue + routing integrity — closed, with two asks

Worker CATALOGUE, against `docs/tasks/parity-request.md` items 3 and 4. Everything I
could fix inside my own files is fixed; the two asks below need a file I do not own.

## Closed here

**Item 3 — stale routing keys.** `PDF_PANELS.crop` is deleted, and the workspace now
consults the panel map only for non-video pages, so a PDF panel cannot mount in a video
sidebar again whatever key is added later. `MAIN_VIEWS.annotate` and
`MAIN_VIEWS['pdf-compare']` are deleted. `STRANDED_PANE_KEYS` in
`tests/pdf/parity-surface.test.ts` is now empty and stays the ratchet: a pane key that
answers no registered tool fails the suite.

**Item 4 — one job, two ids.** The fold moved into `src/lib/pdf/tools/registry.ts`:
`TOOL_ALIASES` (`redact` → `redact-pdf`, `compare` → `compare-pdfs`), with
`canonicalToolId()`, `isToolAlias()` and `TOOL_CATALOGUE` derived from it. No definition
was deleted, so every bookmark and shared link still resolves. `#/tool/redact` now
redirects to `#/tool/redact-pdf`, which also puts the star, the per-tool session and the
recents entry on one id instead of two. `CARD_ALIASES` and `cardIdFor` are deleted from
`toolJobs.ts` — the dashboard, the ⌘K palette and every count read the catalogue, so
there is no second list to keep in step. Aliases and their shelf entries are gone from
`TOOL_JOBS` too.

**Counts.** `PDF_TOOL_COUNT` (`src/lib/constants.ts`) is `TOOL_CATALOGUE.length` and
`TOOL_COUNT` is `VIDEO_TOOL_COUNT + PDF_TOOL_COUNT`; `Landing.tsx` and `PdfDashboard.tsx`
print those instead of `PDF_TOOLS.length`. The number the product advertises is therefore
**122 PDF tools, 130 with the 8 video tools** (the registry still answers 124 ids).
README corrected to match. `tests/pdf/parity-surface.test.ts` fails if the dashboard
headline and the catalogue ever disagree.

**Item 5 (`scan-to-pdf`)** is untouched: the camera pane is still the deliberate
no-intake exception, and it reads well next to the shared intake.

## Ask 1 — definitions owner: the folded definitions are now unreachable, not unused

`redact` (`src/lib/pdf/tools/edit.ts`) and `compare` (`src/lib/pdf/tools/legacy.ts`) are
still registered, still carry their own `run`, `fields`, `promise` and `notes`, and are
still driven directly by `tests/pdf/edge-edit.test.ts`, `tests/pdf/edge-optimize.test.ts`
and `tests/pdf/ux-surfaces.test.ts` — but nothing in the product can reach them now: the
route folds to the canonical tool and the catalogue does not list them. Two sets of copy
for one job is how the drift started.

Please either fold any sentence the canonical definition is missing into
`redact-pdf` / `compare-pdfs` and leave the alias definitions as runner-only shims, or
delete the alias definitions outright. **If you delete either one, say so here first:**
`registry.ts` warns when an alias target is missing, and
`tests/pdf/parity-surface.test.ts` asserts both spellings resolve (`getPdfTool(alias)`
and `canonicalToolId(alias)`), so the deletion and the `TOOL_ALIASES` entry have to land
together or the fold itself becomes the dead code.

## Ask 2 — definitions owner: two comments still advertise the id count

- `src/lib/pdf/tools/helpers.ts:356` — "identical in all ~124 tools". The public count is
  122; 124 is the number of ids the registry answers.
- `tests/pdf/parity-definitions.test.ts:10` and `tests/pdf/ux-definitions.test.ts:2` say
  "124" / "~124". Those sweeps are correctly over registry ids, so the number is right
  there — worth one clause saying so, so the next reader does not "fix" it to 122 and
  lose a tool from the sweep.
