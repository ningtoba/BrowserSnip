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
* **1** field on a generated rail is read by nothing on its own tool's output path —
  **closed**, by deletion:
  * `pdf-to-json.tables` — "Detect tables". `buildJson` calls
    `documentToJson(doc, session, indices)`, which detects tables unconditionally
    (`core/convert.ts` splices them into the blocks before the caller sees them), so
    `off` is not "the raw text runs only, which is faster" — it is `on`: `documentToJson`
    takes no such flag and splices detected tables in unconditionally
    (`core/convert.ts:188-198`), so no value the toggle can hold reaches a parameter.
    The toggle is rendered and defaults to on. Not byte-measured here — pdf.js needs a real
    worker URL, which jsdom does not give it — and a fix must carry that measurement.
    *Measured and deleted* (`tests/pdf/field-reach.test.ts`): the
    rail does render the checkbox, so this was never a field-definition/rail mismatch;
    `tables: true` and `tables: false` both wrote 2531 B at sha `0168e4abd08a1863`, one
    table block in each. A control whose two values cannot be told apart in the file is a
    lie with a click target. Making the option real is a `core/convert.ts` feature — a flag
    on `documentToJson`, plus an answer for the help text's "faster" claim — not a typo.
* **1** field on a pane-owned id is written by neither the rail nor the pane —
  **closed**, by wiring:
  * `redact-pdf.alsoMetadata` — "Also clear matching text from metadata and bookmarks".
    The run does read it (`tools/security.ts:714, 729`), but `redact-pdf` mounts
    `RedactMain` as its surface and the shell renders no generated rail beside a main
    view, while `RedactTool` — the panel the route resolves for the redaction job —
    sent only `{ regions, fill }`. So on `/tool/redact-pdf` the switch never appears and
    the value is whatever `default: true` says.
    *Measured and wired*: the run honours it (the two outputs differ, and `pypdf` reads
    `/Title` `'Zephyr Bravo Content'` with the switch off against `None` with it on, the
    bookmark title intact against `[redacted]`), and the panel now renders the definition's
    own field and writes it into the runner's bag. Chasing that last sentence is what found
    the bug behind it — see *What the census cannot see*, first bullet.
* **30** fields are declared across the **7** ids whose surface is hand-written
  (`add-stamps` 12, `pdf-crop` 7, `scan-to-pdf` 4, `compare-pdfs` 3, `redact-pdf` 2,
  `form-filler` 1, `form-creator` 1). None of them is rendered as a rail —
  `ToolWorkspace` sets `isSchemaTool` false whenever a pane exists — so each of those 30
  is a contract between a definition and its pane, not a control. Asking each pane
  whether it names the key finds exactly one that nothing writes — the `alsoMetadata`
  above — which is why that one is stuck at its declared default while the other 29 are
  set by the pane that owns the id.
  *Two of those 29 were then checked by hand, on bytes, because "the pane names the key"
  is not the same question as "the user can set it":*
  * `add-stamps.opacity` — a measurement gap only. `run` honours it (measured: `/CA` 1
    against `0.2` read back with `pypdf`, 1507 B against 1511 B), and `/tool/add-stamps`
    mounts `AnnotationEditor`, whose own Opacity slider reaches the same `/CA` through
    `editor/specs.ts`. Nothing is dead; the 12 declared fields are a second vocabulary for
    behaviour the editor already ships, which is why they can drift without a test noticing.
  * `pdf-crop.unit` — **closed**, by giving the control a surface. `run` honoured the
    unit all along (measured again here, on bytes: one region declared as
    21.6/28.8/43.2/57.6 pt, 7.62/10.16/15.24/20.32 mm, 0.762/1.016/1.524/2.032 cm and
    0.3/0.4/0.6/0.8 in wrote the *same* `/MediaBox` and the same `/CropBox` on all four
    sheets of a document built to catch the usual lies — an offset origin, a non-square
    page, A4 beside US Letter, and a 400×700 sheet carrying `/Rotate 90`, with four
    pairwise-distinct margins so an edge swap cannot cancel out; `tests/pdf/crop-units.test.ts`,
    read back out of the same files by `docs/research/crop-units-read.py` through
    `pypdf`). What was missing was a place to choose it: `CropTool` sent `unit: 'pt'` in
    its own override and showed the four margins as read-only numbers, so the select and
    the margin boxes described a rail that never mounts while the card said "Drag a crop
    rectangle **or type exact margins in points, mm or inches**". The panel now renders
    the definition's own `unit` field, takes typed margins in whatever unit it holds, and
    forwards both — the tool converts, so 15 typed into the bottom box with `mm` selected
    takes 42.5 pt off the bottom, and 42.5 is what the panel printed as the points the
    file would hold. Both halves of that are pinned: typing a margin means what it says in
    the chosen unit, and switching unit re-states the same rectangle without moving it (a
    crop dragged to 20 / 10 / 30 / 40 pt still writes 20 / 10 / 30 / 40 pt with
    `Millimetres` showing 7.0556 / 3.5278 / 10.5833 / 14.1111 in its boxes).
    *On the deployed site too* (`docs/research/crop-units-run.mjs`, one run per unit, the
    downloads read by the same `pypdf` checker into
    `docs/research/crop-units-deployed.log`): the four files of one pass are byte-identical
    to each other (sha256 `6abdf5b4…`; a second pass differs in bytes only because
    pdf-lib stamps each file, so the cross-unit claim is *identical within a run*, as
    elsewhere in this campaign) and each holds `[75.6, 67.2, 489.2, 972.4]`,
    `[57.6, 43.2, 566.48, 820.29]`, `[57.6, 43.2, 583.2, 770.4]`,
    `[57.6, 43.2, 371.2, 678.4]` — zero corner drift, `/CropBox` equal to `/MediaBox`,
    no console error — with the panel printing
    `writes 21.6/28.8/43.2/57.6 pt` for every one of them.
    Same shape as `scan-to-pdf.fit` — a pinned value outranks a declared field — and
    fixed the way `redact-pdf.alsoMetadata` was, by wiring the pane to the field.

## What the census cannot see

* **A pane that never mounts.** `8bb1c49` folded `redact` and `compare` into
  `redact-pdf` / `compare-pdfs` as aliases, and `ToolWorkspace` resolves the route id
  through `canonicalToolId` *before* it looks a pane up — so `PDF_PANELS['redact']`
  answered nothing and `/tool/redact-pdf` showed the redaction canvas with **no apply
  button at all**. Every census question about that tool's two fields was therefore
  asked of a surface the catalogue could not reach: `RedactTool` "names the key" is a
  meaningless answer when the component is never rendered. Fixed in `cafea60` (both pane
  lookups fold first, `PDF_PANELS` is keyed canonically) and pinned by
  `tests/pdf/field-reach.test.ts`, which mounts each panelled route and asks for the
  control. `compare-pdfs` was measured, not assumed: its panel was already keyed
  canonically and mounts once the two documents it asks for are loaded — judging a
  two-file tool with one file invents a defect.
* **A definition left standing after its fold** — the half of that story `cafea60`
  could not fix, and a routing pass found rather than the census: folding `redact` into
  `redact-pdf` kept `redact`'s own entry in `tools/edit.ts`, so the registry still
  answered `getPdfTool('redact')` with a registered tool ("Redact Regions", `run`, fields
  and all) that no route could reach — `TOOL_CATALOGUE` already left it out, and the
  surface behind `/tool/redact` was `redact-pdf`'s, because the route folds before it
  picks a pane. Its only exercisers were tests calling the definition directly, which is
  precisely the state a fold leaves behind and precisely what no count notices.
  **Retired**, and `redact-pdf` kept as the one tool for the job: the entry and its
  `ANNOTATION_SURFACE_FIELDS` list are gone, `MAIN_VIEWS` no longer carries a `redact`
  key, and the byte tests that used to drive the dead definition now drive `redact-pdf`
  on the same documents (`tests/pdf/edge-edit.test.ts`, `tests/pdf/edit-bytes.test.ts`).
  What the retired id still has to do is keep working for a visitor who already used
  it, and that is pinned twice over: `canonicalToolId('redact')` still folds and
  `/tool/redact` still lands on the redaction panel with its apply control
  (`tests/pdf/field-reach.test.ts`), the palette and the job-word table still answer the
  word with `redact-pdf` (`tests/app/shell.test.tsx`,
  `tests/pdf/parity-definitions.test.ts`), and the pane maps hold no orphan key
  (`tests/pdf/parity-surface.test.ts`). The id itself stays in
  `TOOL_ALIASES`, in `ToolId` and in the download-suffix switch beside `compare`,
  because those three spell out *ids a bookmark or a stored session can carry*, not
  tools the app offers. Asked of the deployed build (`docs/research/folded-id-check.mjs`,
  output in `folded-id-check-deployed.log`): `#/tool/redact` folds to
  `#/tool/redact-pdf` and mounts the panel whose apply button reads `Apply 0
  Redactions` beside the permanent-redaction warning and the metadata switch, the words
  "Redact Regions" appear nowhere on the page, and the copy and the catalogue agree —
  the dashboard prints 121, renders 121 cards, and its six shelves count
  20 + 36 + 18 + 20 + 11 + 16 = 121, while the landing says "121 PDF tools" and
  "121 tools · 6 categories" (8 video tools, 129 site-wide).
  *What it cost: nothing a user could reach.* The retired entry's own note offered
  "type page:x,y,w,h entries", but its `regions` field belonged to a rail that never
  mounted beside the pane — `redact-pdf` takes its regions from the marks on the canvas,
  and `add-stamps` still parses the same `page:x,y,w,h` grammar for its placements
  field. The catalogue count is unchanged at **121** tools (`PDF_TOOL_COUNT` reads
  `TOOL_CATALOGUE.length`; the retired id was already folded out of it), and
  `PDF_TOOLS` — every id the registry answers — went from 124 to 123.
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
