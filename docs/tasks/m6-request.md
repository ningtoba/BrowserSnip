# M6 — requests out of `src/lib/pdf/tools/**`

Found while auditing the ~124 tool definitions as a set. Everything here is in
another worker's file, so it is listed rather than changed.

## 1. `redact-pdf` needs pane state it has no field for (was mine, deferred)

`security.ts` → `redact-pdf` reads `values.regions` as structured state and
refuses with "Draw at least one redaction rectangle on the page first" when it
is empty, but it declares no `regions` field — so the rail shows nothing for the
one value the run depends on. The sibling `redact` definition (`edit.ts`) does
expose a `Regions` field with the `page:x,y,w,h` grammar.

A field was not added here because the pane writes an **array of objects** to
that key while the shared `text` field writes a string; whichever way it is
resolved, `RedactMain` (M4) and the definition have to agree on the shape.

## 2. `page-dimensions` is categorised `organize` but defined in `convert-from.ts`

`convert-from.ts:1157`. Harmless — the registry groups by `category`, and
`tests/pdf/registry.test.ts` passes — but the size report is not discoverable
from the module its own dashboard group points a reader to.

## 3. Copy that was stale in the panes while this pass ran (already moving)

The definitions now say `Colour`, `Resolution` (dpi), `File format` and
`Image quality` in one spelling each, asserted by
`tests/pdf/ux-definitions.test.ts`. Earlier in the session `WatermarkTool.tsx`
and `RedactMain.tsx` labelled the same control `Mark colour`, `Stamp colour` and
— on a redaction fill — `Watermark colour`. Those strings are gone from
`src/components/tools/pdf/**` as of this writing; if they come back with the
panes' own save controls, they should reuse the field labels from the definition
rather than invent a fourth name.
