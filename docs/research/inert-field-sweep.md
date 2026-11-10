# The inert-field census, over the whole catalogue

`docs/TOOL-TRIAGE.md` found three controls whose value never reached the output, and
`adjust-colors` before that with five at once. The question asked was whether the class
is bigger than those examples. This is the cheap answer: a census, not a fix list.

Reproduce with `npx vitest run tests/pdf/inert-field-sweep.test.ts`. It reads the live
`TOOL_CATALOGUE` for the field lists — a hand-maintained copy would drift from the
registry the same way the two `PAGE_FIELD` copies did — and then asks, per field:

> does this key reach the values bag anywhere inside the tool's own `run`, or inside any
> function that `run` reaches, transitively?

A field counts as read when the key is spelled in that path (`numberValue(values,
'opacity')`), when the path names the constant that declares it
(`numberOf(context.values, BLANK_COUNT, notes)` — the field-descriptor
readers take the `ToolField`, not the key, and an earlier pass of this sweep called
every one of those "inert" because it did not know that), or when the path reads it as a
property (`values.font` in `readTextStyle`).

## Numbers

* **335** value-bearing fields checked across the **84** catalogue tools that declare
  any — of them **199** are choices a user can actually set: `select`, `toggle`,
  `segmented`, `multiselect`.
* **0** keys are read by nothing anywhere in `src/`. The five `adjust-colors` sliders and
  the CBZ/Scan `Page size` pair that this campaign accused are all accounted for: they
  were read in name but not in path, which is the shape the census can still see.
* **1** field on a generated rail is read by nothing on its own tool's output path:
  * `pdf-to-json.tables` — "Detect tables". `buildJson` calls
    `documentToJson(doc, session, indices)`, which detects tables unconditionally
    (`core/convert.ts` splices them into the blocks before the caller sees them), so
    `off` is not "the raw text runs only, which is faster" — it is `on`: `documentToJson`
    takes no such flag and splices detected tables in unconditionally
    (`core/convert.ts:188-198`), so no value the toggle can hold reaches a parameter. The
    toggle is rendered and defaults to on. Not byte-measured here — pdf.js needs a real
    worker URL, which jsdom does not give it — and a fix must carry that measurement.
* **1** field on a pane-owned id is written by neither the rail nor the pane:
  * `redact-pdf.alsoMetadata` — "Also clear matching text from metadata and bookmarks".
    The run does read it (`tools/security.ts:714, 729`), but `redact-pdf` mounts
    `RedactMain` as its surface and the shell renders no generated rail beside a main
    view, while `RedactTool` — the panel for the folded `redact` id — sends only
    `{ regions, fill }`. So on `/tool/redact-pdf` the switch never appears and the value
    is whatever `default: true` says.
* **30** fields are declared across the **7** ids whose surface is hand-written
  (`add-stamps` 12, `pdf-crop` 7, `scan-to-pdf` 4, `compare-pdfs` 3, `redact-pdf` 2,
  `form-filler` 1, `form-creator` 1). None of them is rendered as a rail —
  `ToolWorkspace` sets `isSchemaTool` false whenever a pane exists — so each of those 30
  is a contract between a definition and its pane, not a control. Asking each pane
  whether it names the key finds exactly one that nothing writes — the `alsoMetadata`
  above — which is why that one is stuck at its declared default while the other 29 are
  set by the pane that owns the id.

## What the census cannot see

* A value that reaches the output only to be overwritten downstream. `scan-to-pdf`'s
  `fit` is the standing example: the pane pins `fit: 'contain'` in its own `run({...})`
  overrides, so the definition's three-way `Fit` select cannot be reached from the page
  even though `run` reads it and `scanImagesToPdf` honours it (measured: contain
  `10/215.5/575.3/410.9`, cover `10/10/575.3/821.9`, stretch identical to contain).
* A key read through a value computed at run time — a loop over a `const` list is fine
  (`pdf-crop`'s `CROP_SIDES.map((side) => numberValue(values, side, 0))`), but the sweep
  only resolves it because the list's members are also declared keys.
* The bytes. Nothing here proves a control moves the file; that is what
  `tests/pdf/inert-controls.test.ts` does for the three accused controls, and what a
  scheduled fix must do for each field on this list before it is called fixed.
