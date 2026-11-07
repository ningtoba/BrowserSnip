# ready → owners: what the ready-state pass needed outside its own files

Context: this pass took the five items on the ready state — the collapsed summary
that echoed untouched defaults, the intake that never named its formats, the dead
band between the file cards and the pinned bar, one-line file names, and the
edge-to-edge intake button. Files owned: `src/components/tools/pdf/shared/**`,
`tests/pdf/ux-task-shell.test.tsx`, `tests/pdf/parity-definitions.test.ts`,
`tests/pdf/ux-rail.test.ts`, `tests/app/shared-ui.test.tsx`.

Two things would have needed edits in someone else's column, so they are asked
for here instead of taken.

## 1. `layout/ToolWorkspace.tsx` — the bespoke intake still has no footnote

`shared/FileIntake.tsx` now renders `footNote` (the generated page passes one from
`ToolSurface`). The bespoke surfaces render the same component and pass nothing,
so an empty `edit-pdf` or `annotate-pdf` page still says title + promise + button
and never names what belongs there:

```tsx
// src/components/layout/ToolWorkspace.tsx, in the `showIntake` branch
import { FileIntake, PDF_ACCEPT, intakeCopy, intakeFootNote, useIntake } from '@/components/tools/pdf/shared/FileIntake';
...
        <FileIntake
          title={title}
          promise={definition ? promiseFor(definition) : tool.description ?? ''}
          copy={intakeCopy(definition?.accept, isMultiFile)}
          controls={intake}
+         footNote={intakeFootNote(definition?.accept, isMultiFile, definition?.notes ?? [])}
        />
```

`intakeFootNote(accept, multiple, notes)` is exported and pure: it returns one
line — `Accepts .docx, .doc, .odt, .rtf · one file at a time · <first note>` — and
`''` when there is nothing to say.

## 2. `lib/pdf/tools/convert-to.ts` — a note names an internal module

The intake now prints each definition's first note, which is good copy hygiene
except where the note is written for a reader of the source. `convert-to.ts:112`:

> `'Text is drawn as real, selectable PDF text through core/fonts, so it stays
> searchable and copyable.'`

`core/fonts` is a module path, and the UX brief's copy rule is "no internal class
names". Suggest "…through real embedded fonts, so it stays searchable and
copyable." It is the only note in the catalogue that quotes a source path (grepped
across `src/lib/pdf/tools/*.ts`).

## Not a request, but the numbers behind the bar's new position

Measured at 1440×1000 on `BASE=http://localhost:5223` with a real PDF, before and
after moving `RunBar` inside the scroll region (`sticky bottom-0`):

| page | before | after |
|---|---|---|
| `pdf-compress`, 1 file | cards end y=422, bar starts y=823 → **401 px** of bare background | bar starts y=450 → **28 px** |
| `merge`, 3 files | re-add strip ends y=546, bar starts y=860 → **314 px** | bar starts y=565 → **20 px** |

Neither page scrolls at that size (content 720/756 px in a 720/756 px region), so
pinning the bar bought reachability for a scroll that does not exist.
