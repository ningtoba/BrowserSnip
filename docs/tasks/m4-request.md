# M4 requests (surfaces I own are done; these cross a boundary)

Nothing here blocks M4. Each item is a defect or a tidy-up inside another worker's
file, found while fixing the scan-to-pdf hang.

1. **`lib/pdf/tools/legacy.ts` (M6) — the scan tool's own refusal is dead code.**
   `run` starts with `if (context.inputs.length === 0) throw paneOnlyError('Scan to
   PDF', 'a captured page')`, but the runner guarantees at least one file, so that
   branch can never fire. The refusal now happens in `runner.ts` before any work
   (`inputKindProblem`), which is where it belongs. Please either delete the dead
   branch or make it the single place the pane is named — two owners for one
   sentence is how they drift apart.

2. **`lib/pdf/tools/edit.ts` (M6) — `redact` refuses with a bare `Error`.**
   `throw new Error('Draw at least one redaction box on the page, or enter
   page:x,y,w,h regions.')` is the one refusal on this path that is not a
   `ToolInputError`, so the rail cannot show it inline with a code and a hint.
   The redact pane now snaps drags to text lines, so the message should also say
   what an empty drag means ("a box over paper with no words marks nothing —
   hold Shift to mark an area").

3. **`lib/pdf/core/pack.ts` — `embedImageBytes` has no way to carry a file name.**
   `core/images` now accepts `DecodeOptions.name` and names the file in every
   refusal, but `embedImageBytes(doc, bytes, { mime })` drops it, so scan/image
   callers can only attach the name after the fact (they do). A `name` pass-through
   would make the sentence come from one place.

4. **`components/tools/pdf/editor/quads.ts` (M1) — shared dependency.**
   `RedactMain` now imports `snapTextLines` (and `lib/pdf/core/render`'s
   `toExtractedItems`) so a redaction drag snaps to real text lines instead of
   painting a rectangle over the leading. If the snap signature changes, the redact
   pane breaks loudly in `tests/pdf/ux-surfaces.test.ts`.

5. **Observed while working (no action asked).** Two other stalls of the same class
   remain outside my paths: `SignMain`/`CropMain`/`CompareMain`/`RedactMain` each
   open their own pdf.js document per render rather than through
   `core/render`'s single-owner sessions, and `CompareMain` used to leak both
   proxies on every page turn (fixed for the page-change path in this pass). The
   per-pane pdf.js duplication is a wave-3 sized change, not a polish item.
