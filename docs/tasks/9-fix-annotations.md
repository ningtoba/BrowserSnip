Fix the 6 failing tests in `tests/pdf/annotations.test.ts` (cwd = repo root). Run `npx vitest run tests/pdf/annotations.test.ts` first and read every failure.

STRICT FILE OWNERSHIP — edit ONLY: `src/lib/pdf/core/annotations.ts`, `src/lib/pdf/core/redact.ts`, `src/lib/pdf/core/content.ts`, `tests/pdf/annotations.test.ts`.
Other agents are editing `src/components/tools/pdf/**` and `src/lib/pdf/core/bookmarks.ts` concurrently — do not touch those. No npm install, no git.

Failing areas: `appearance streams > substitutes characters Helvetica cannot encode instead of throwing`, and all five `applyRedactions > …` cases (glyph deletion inside a rect, whole-run deletion, Td/TD/Tz and q/Q/cm text-state tracking, `rasterised` reporting for image XObjects and inline images, and redaction of text nested in a Form XObject including the shared-form copy case).

Rule: **fix the implementation, not the test**, unless the test itself asserts something PDF-incorrect — in which case say so explicitly and justify it from the PDF specification. `applyRedactions` must genuinely remove the text (a redaction that only paints a box is the defect this whole feature exists to fix), and must return `rasterised: true` when content it cannot cut is present.

Note: `src/lib/pdf/core/content.ts` now exists with a full content-stream tokenizer and a `removeTextInRects` text-state machine. If `redact.ts` re-implements that logic badly, prefer delegating to `content.ts` rather than duplicating a weaker parser.

Finish with `npx vitest run tests/pdf/annotations.test.ts` green and `npx tsc -p tsconfig.json --noEmit` clean for your files. Also clean the dead code the previous author left in `content.ts` (reported unused: `PDFHexString`, `decodeTextOperand`, `ColorState`, `STANDARD_FONT_METRICS`, and the unused `scale`/`y0` locals) — delete them rather than leaving `void` markers, unless a deletion reveals they were actually needed, in which case wire them up correctly.

Finish with `npx vitest run tests/pdf/annotations.test.ts` green and `npx tsc -p tsconfig.json --noEmit` clean for your files. Report root causes, not just "tests pass", and list anything a reviewer should check in a real PDF viewer.
