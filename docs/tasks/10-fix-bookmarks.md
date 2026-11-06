Fix the 4 failing tests in `tests/pdf/bookmarks.test.ts` (cwd = repo root). Run `npx vitest run tests/pdf/bookmarks.test.ts` first and read every failure.

STRICT FILE OWNERSHIP — edit ONLY: `src/lib/pdf/core/bookmarks.ts`, `tests/pdf/bookmarks.test.ts`.
Other agents are editing `src/components/tools/pdf/**`, `src/lib/pdf/core/annotations.ts` and `redact.ts` concurrently — do not touch those. No npm install, no git.

Failing areas: `generateTocPage` (both cases — real inserted pages with dot leaders, right-aligned numbers and working links; and `startPage` / custom heading / `leader: 'none'` / `pagesBefore` numbering offset) and `addBatesNumbers` (both cases — `{org} {page} {total} {date} {time}` + prefix/suffix, and page selection + `unitOffset` + `crossDocument`).

Reminder of the agreed semantics: `startPage` is the 0-based insertion index for the generated TOC pages; `pagesBefore` is added to each entry's DISPLAYED page number so a cover page does not mislabel every entry. `addBatesNumbers` returns `Promise<{ stamped, unknownTokens }>`, resolves `{org}` from /Author then /Creator then /Title, and leaves an unrecognised `{token}` literal in the output while reporting it.

Rule: fix the implementation, not the test, unless the test asserts something PDF-incorrect — then justify it.

Finish with `npx vitest run tests/pdf/bookmarks.test.ts` green and `npx tsc -p tsconfig.json --noEmit` clean for your files. Report root causes.
