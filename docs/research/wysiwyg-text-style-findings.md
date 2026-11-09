# WYSIWYG text styling — what shipped, what was refused, what the bytes say

The request was *"literally any pdf editor or add a text box feature I want something
like wysiwyg where I can pick fonts and change the text bold or anything please do it
properly."* This file records what "properly" turned out to mean, per surface, measured
off the produced file.

## The model

`src/lib/pdf/core/text-style.ts` is the single definition of the seven properties a user
can set — `fontFamily`, `size`, `color`, `bold`, `italic`, `align`, `lineSpacing` — plus:

* **the family registry**, each entry stating how its face reaches the file
  (`named` / `embedded` / `fetched` / `device`) and which postures it holds as **real
  faces**;
* `carriesPosture(family, posture, text)`, which answers for the face that will
  *actually* write the run, not the one the picker named;
* `faceSurfaceSupport(surface)`, what each surface's **writer** can draw;
* per-surface defaults and `localStorage` persistence under
  `browsersnip:text-style:v1`;
* `familyIdFrom`, which maps the rail's old `helvetica`/`auto` spellings onto the one
  id space the editors already used.

`text-editor/model.ts`'s `InlineStyle`/`EditorStyle` are built on it, so the block editor
and the annotation inspector cannot hold different numbers for the same word.

## Controls refused, and why

| control | where | why it is not there |
| --- | --- | --- |
| Italic (and bold) | `noto`, every `script:*` face | No italic file is bundled and each fetched script face ships one weight. A slant the tab cannot put in the bytes is a preview that lies about the export, so the button renders disabled **with the reason in its title**. |
| Italic past WinAnsi | `std:helvetica`/`std:times`/`std:courier` | Those three hold a real oblique/italic face — until the run needs characters they cannot encode, at which point the bundled face answers and the slant goes. `carriesPosture` re-reads the button against the selection's own text, so it disappears exactly then. |
| Family / weight / slant / size / alignment / line height | the annotation editor's **Note** | A sticky note's body reaches the file as a plain `/Contents` string and every reader paints the popup in its own UI font. The `Text size` slider that was there reached no mark, no spec and no byte, and is deleted. Colour and opacity stay: `/C` and `/CA` carry them. The inspector says this where the slider used to be. |
| Alignment | `header-footer`, `page-numbers`, `watermark` | The anchor *is* the alignment (a folio corner, a header slot, a watermark position and angle). A second control writing the same byte is two answers. |
| Line height | the four rail tools, `add-stamps`, the annotation `stamp` | Line height is the distance between lines and each of those marks draws one run. `faceSurfaceSupport` reports `lineSpacing: false`, and the control is not rendered. |
| Justify | every surface but the block editor | Justifying needs a measure to stretch a line across. Only `layoutBlock` has one. |

## One layout, used twice

`prepareTextObject` → `layoutBlock` lays a block out with the faces the file will carry.
`editor/textLayout.ts` is the only caller that computes lines: the overlay paints the
returned lines as SVG `<text>` on the returned baselines, and `core/annotations.ts`
writes the same numbers into the appearance stream. There is no CSS wrap in the path.
A test in `tests/pdf/text-style-bytes.test.ts` lays the same block out against two
different documents — the scratch one the preview measures with, the copy being exported
— and requires the same breaks and the same coordinates.

## Measured, before and after

`bash docs/research/wysiwyg-measure.sh` drives every surface against a build and
`wysiwyg-bytes.py` reads the answer out of the produced file. On
`localhost:5281` (this build) versus `localhost:5282` (the build at `81385c1`, i.e. what
is deployed):

| surface | before (`81385c1`) | after (this build) |
| --- | --- | --- |
| text box | — | mark's appearance: `NotoSans-Bold-9742` at 22 pt, fill `(0.545 0.361 0.965)`, two baselines **44.0 pt** apart; screen claim from the same run: 2 lines, 22 pt, gap 44.0 pt, weight 700. 4 600 ink px inside the mark. |
| stamp | — | appearance: `Times-Bold` at 30 pt, fill `(0.863 0.149 0.149)`; screen: 30 pt, `#dc2626`, weight 700. 7 496 ink px. |
| note | — | one mark, `/C (0.02 0.588 0.412)`, **no `/DA`, no `/DR`** — the deleted control was deleting a promise. |
| header / footer | header drawn in **`helvetica`** (there was no typeface control to move it) | `Times-Bold` at 16 pt `#0000ff`, and the file adds `NotoSans-Bold` for the slots the standard face cannot spell |
| page numbers | rail probe could not drive it before (no `Italic` field existed) | folio drawn in **`Times-Italic`** at 22 pt `#ff0000` — a real slant in the file |
| watermark | drawn in **`helveticabold`** (no typeface control) | `Courier-Bold` at 48 pt `#008000`, adds `NotoSans-Bold-5563` |
| add-stamps | rail probe: its *surface* is the page editor, so the rail's action button is absent | byte-proved in `style-controls-invariant.test.ts` instead: `.font`, `.italic`, `.fontSize` and `.color` each change the produced file |
| in-place edit text | — | exported block drawn in the family the panel chose, at the size and colour it chose |

Two honest gaps in that table:

* The **before** column for the four editor surfaces is empty: the rig drives the new
  control set by its accessible names, none of which existed at `81385c1`. Getting those
  four numbers needs a before-shaped probe, not a re-run of this one.
* `add-stamps` and the before `page-numbers` exit 1 in the rail probe for the same class
  of reason — the button and the field the probe addresses belong to whichever build is
  under it.

## Dead-control census, from the invariant test

`tests/pdf/style-controls-invariant.test.ts` asserts the property instead of the
instance: a declared field must be named by code that reads it; each style field of each
text-drawing tool must change the produced bytes; and the control set must render only
what its surface's writer honours (it is mounted in jsdom and its buttons are counted).

* **0** registry fields are declared and named nowhere in the tool layer.
* **33 of 511** are not named inside the module that declares them — 26 of those are
  generated aliases (`jpg-to-pdf`, `pdf-to-png`, …) whose declaring text is built from a
  template, and the rest are read by a helper that lives in another module. Ratcheted by
  the test so a rise is a review, not a shrug.
* The exemption list the rule leans on (`readTextStyle`, `resolvePages`, the runner's
  unlock round) is itself asserted, key by key.
* One test that could not fail (`expect(Array.isArray(...))`) was deleted on the way: a
  test that asserts nothing is the same defect as a control that changes nothing.

## Proposal for its own row, not a TODO

**Give the sticky note a styled appearance of its own.** Decision B in this pass deleted
the note's dead `Text size` slider, because the format holds a note's body as plain text
and readers paint the popup themselves. Writing `/DA` instead was rejected: a control
needing a footnote about whether readers will honour it is a better-dressed dead
control. The option that *would* make note type real is drawing the body into the
annotation's appearance stream — which changes what a note is on the page for every
existing document, from icon-plus-popup to a visible styled box. That deserves its own
row with its own before/after, not a smuggled change here.

Also open, measured here and not fixed:

1. **`panels.tsx` is 1 000+ lines and hostile to edits.** Three of its `InspectorSection`
   /`FormatPanel` regions had to be re-read mid-edit and one panel change cost more turns
   than the whole rail-tools surface change. Splitting it into one module per panel
   (`ModePanel`, `FormatPanel`, `ObjectPanel`, `FindReplacePanel`, `ObjectList`,
   `WarningList`, `ToastStack`, `Ruler`) is a schedule item, not a preference.
2. **The stamp's fitted size is reported but not remembered**: the export adds the
   sentence "drawn at N pt to fit the box", and the inspector's size field keeps showing
   the number that was asked for.
3. **A rail `FIELDS` value cannot contain a space**, so the proof rig's text values are
   written space-free (`prefix=Page suffix=of1`). Harness limitation, not app.

## Re-running

```sh
(nohup npx vite --port 5281 --strictPort >/tmp/5281.log 2>&1 &)
git worktree add /tmp/bs-before 81385c1 && ln -s "$PWD/node_modules" /tmp/bs-before/node_modules
(cd /tmp/bs-before && nohup npx vite --port 5282 --strictPort >/tmp/5282.log 2>&1 &)
BASE=http://localhost:5281 OUTDIR=/tmp/wysiwyg/after  bash docs/research/wysiwyg-measure.sh
BASE=http://localhost:5282 OUTDIR=/tmp/wysiwyg/before bash docs/research/wysiwyg-measure.sh
npx vitest run tests/pdf/text-style.test.ts tests/pdf/text-style-bytes.test.ts \
  tests/pdf/style-controls-invariant.test.ts
```
