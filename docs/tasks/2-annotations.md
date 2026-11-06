Implement §2 (PDF annotations) of `docs/PDF-ENGINE-CONTRACT.md`. Cwd = repo root.

STRICT FILE OWNERSHIP — create/edit ONLY:
  src/lib/pdf/core/annotations.ts, src/lib/pdf/core/redact.ts, tests/pdf/annotations.test.ts
Do NOT touch package.json, vite.config.ts, constants.ts, types/index.ts, src/components/**, src/lib/pdf/engines/**, src/lib/pdf/tools/**, or other src/lib/pdf/core/* files (concurrent agents). No npm install. No git.

Read first: docs/PDF-ENGINE-CONTRACT.md, src/lib/pdf/core/{doc,pages,fonts}.ts (frozen), and the legacy `redactPDF` in src/lib/pdf-engine/commands.ts for context (do NOT modify that file).
Use `@maxwbh/pdf-lib` (pdf-lib fork). It has NO high-level Highlight/Ink/FreeText API — write dictionaries via doc.context.

REQUIREMENTS:
1. addAnnotation/addAnnotations producing correct annotation dicts for EVERY AnnotationKind in the contract: /Subtype, /Rect (normalised; document our top-left QuadRect → PDF bottom-left conversion in a comment), /P, /C, /CA, /BM /Normal, /NM, /T, /M (PDF date), /F, /Contents, /QuadPoints for text markup, /DA for FreeText, /BS /W, /IC for ink, /LE for line arrows, /AP /N appearance stream.
2. Appearance streams must be self-contained Form XObjects (/Type /XObject /Subtype /XObject /BBox /Resources with /Font or /XObject declared only when referenced), registered via doc.context.register. Verify by round-trip: build → annotate → save → reload → assert /Annots entries, rects, and that the appearance bytes decompress to the expected operators.
3. listAnnotations / removeAnnotations / annotationCount must work on foreign documents: parse page /Annots including inherited entries and indirect references.
4. redact.ts applyRedactions PERMANENTLY removes content: rewrite the page content stream to drop text-showing operators whose glyphs fall inside each rect (track BT/ET, Tm/Td/TD/T*, Tf, Tz, TL and TJ/Tj — a real text-state machine), then paint the fill rect. If the rect intersects an image XObject (Do operator with a resolvable bbox), set rasterised:true so the caller can fall back to raster redaction. Returning "covered but still selectable" via this API must be impossible.
5. Pure pdf-lib, no canvas, no DOM.

VERIFY: `npx tsc --noEmit -p tsconfig.json` (only errors in your files) and `npx vitest run tests/pdf/annotations.test.ts` green. Report the API, the exact keys written per kind, what round-trips you verified, and PDF-correctness caveats a reviewer should check in a real viewer.
