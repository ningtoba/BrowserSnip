# Ticket — `pdf-layers` cannot toggle a layer, because its lists are never filled

**Found by:** the eight-tool measurement (`docs/research/layers-deployed.log`, from
`node docs/research/verify-layers-run.mjs` against `https://www.browsersnip.com`).

## What the deployed pane does

Open `/#/tool/pdf-layers`, drop a PDF that has two optional-content groups
(`tests/fixtures/foreign/layers.pdf` — `DrawnLayer` on, `HiddenLayer` off, written by
MuPDF), open the options disclosure, and the rail reads:

```json
{"groups":[
  {"label":"Hide these layers","options":[],"boxes":[]},
  {"label":"Show these layers","options":[],"boxes":[]}]}
```

No rows. The only reachable actions are *Add a layer named* and *Delete layers named*,
which take text. So the card's first two verbs after "List" — "toggle" — cannot be
performed by a person at all, while the tool's own help text describes a control that
isn't there:

> Hide these layers — *Switched off in the default view. The content stays in the file
> and any reader can turn it back on.*

## Why

`src/lib/pdf/tools/edit.ts:1849-1850` declares both fields with a literal
`options: []`, and `ToolField.options` (`src/lib/pdf/tools/types.ts:53`) is a static
array: nothing in the rail asks the opened document what its layers are. `pdf-layers`
is the only tool in the app with a `multiselect` field, so no other path exercises this.

The *engine* half is fine and measured: with the values the rail would have sent, the
tool writes `/OCProperties /D /ON` and `/OFF` as references to the groups in `/OCGs`,
and rendering the file before and after shows the layer's ink actually disappears —
MuPDF changes 708 pixels on page 1, and poppler's page-1 ink count falls 7454 → 6866
while the other two pages are untouched (`docs/research/layers-readers.log`). The pane
sentence names the layers the file ends up holding.

## What is wanted

A document-driven options path: the rail should ask the tool (or the runner) for the
choices once a document is open, and re-ask when the document changes. That touches
`src/components/tools/pdf/shared/FieldControls.tsx`, the field-description type in
`src/lib/pdf/tools/types.ts`, and `src/hooks/usePdfTool.ts` — none of which belong to
the `pdf-layers` seam — so it was written up instead of done here.

Smallest acceptable alternative, entirely inside `pdf-layers`' own files: list the
group names in the pane's read-only output (the tool already knows them —
`listLayers`) next to the two free-text fields, and say in the help text that a layer
is hidden by naming it, one per line. That is honest, but it is a product decision
about how the tool reads, so it is not made unilaterally either.

## Reproduce

```sh
BASE=https://www.browsersnip.com PDF=tests/fixtures/foreign/layers.pdf \
  HIDE=DrawnLayer SHOW=HiddenLayer ADD='Revision C' \
  OUT=/tmp/eight/layers.pdf node docs/research/verify-layers-run.mjs
```

The `rail:` line prints the two empty groups; `hide:`/`show:` answer
`no option DrawnLayer among ` with an empty list.
