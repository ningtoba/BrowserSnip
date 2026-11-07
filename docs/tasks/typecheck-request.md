# Type-check request — raised by the tests typecheck pass

`tsconfig.json` includes only `src` and `vite-env.d.ts`, so no test file in this
repository has ever been type-checked. `tsconfig.tests.json` (kept in place)
extends it with `tests`, and the first run reported 58 errors across 14 files.
All 58 are now gone; `npx tsc -p tsconfig.tests.json --noEmit` and
`npx tsc -p tsconfig.json --noEmit` both report 0, and no test was deleted or
weakened to get there.

**Nothing here is a behavioural bug in `src`, and no test was deleted or weakened
to get there.** §7 records the one test that went red while this pass ran — a
catalogue-shape invariant catching another commit's change of shape — and where
it landed.

## 1. `core/guard.preflightPdf` should name `ToolFile` instead of re-describing it

`src/lib/pdf/core/guard.ts:594` takes

```ts
source: { name: string; size: number; blob: () => Blob }
```

which is a hand-copied subset of `ToolFile` (`src/lib/pdf/tools/types.ts`). Two
consequences worth one line to fix — `Pick<ToolFile, 'name' | 'size' | 'blob'>`:

* The two spellings can drift apart and nothing would notice, because the only
  caller (`tools/runner.ts:343`, through `toToolFile`) satisfies both.
* A DOM `File` does **not** satisfy it: TypeScript's `lib.dom` declares
  `interface File extends Blob` without `blob()`, and neither jsdom's `File` nor
  Node's implements it. So `preflightPdf(someFile)` compiles to a
  `source.blob is not a function` throw the moment the file is non-empty — an
  empty file slips past only because `readEdges` returns before slicing
  (`tests/pdf/guard.test.ts` was relying on exactly that, and is fixed on the
  test side).

## 2. pdf-lib's typed lookups do not accept `PDFRawStream`

`PDFContext.lookup`/`lookupMaybe` (and the same pair on `PDFDict`) overload on
`typeof PDFArray | PDFBool | PDFDict | PDFHexString | PDFName | PDFNull |
PDFNumber | PDFStream | PDFRef | PDFString` — the **base** `PDFStream` only. A
call like `context.lookup(ref, PDFRawStream)` picks the last overload and the
result is typed `PDFString`, so `stream.dict` silently becomes `never` —
`formOps` / `pageContent` / the stamp-image check in
`tests/pdf/annotations.test.ts`, and the content-stream, XMP-metadata and
ICC-profile checks in `tests/pdf/edge-optimize.test.ts`.

Twelve errors, all in tests, all fixed there: pass `PDFStream` and narrow with
`instanceof PDFRawStream`, or read through `core/content.streamBytes`, which
already takes `PDFStream`. Worth knowing in `src` too — a `lookup(..., PDFRawStream)`
there would compile and lie about its return type in exactly the same way.

## 3. The `protect` password rule: the note in `field-required-note.md` is done

Commit `c377720` moved `protect`'s missing-password sentences from a tool-level
`validate()` onto the fields (`required` + `missing`) and left
`docs/tasks/field-required-note.md` asking this pass to move
`tests/pdf/edge-security.test.ts`'s E18 assertion. It now asserts the refusal
through `validateFields`, which is the seam the runner itself calls, and keeps
the genuinely cross-field shared-password rule on `validate()`.

Side effect of finding it: that assertion was already failing **before** this
pass touched it — `edge-security.test.ts` does not pass when run on its own at
`c377720`. It is green again, so the file can be run per-file as the brief
assumes. No action needed, but it explains why the E18 test's body differs from
the version committed alongside `c377720`.

## 4. Convention: an assertion message belongs on `expect()`, not on the matcher

`expect(value).toBe(other, 'message')` is legal JavaScript and vitest **ignores**
the extra argument; the supported spelling is `expect(value, 'message').toBe(other)`
(`@vitest/expect`: `<T>(actual: T, message?: string): Assertion<T>`). 29 of the 58
errors were this — every message in `tests/pdf/ux-organize.test.ts`'s selection,
drag and keyboard blocks was decoration that never reached a failure. They were
moved onto `expect()` rather than deleted, so they now print.

`tsconfig.tests.json` catches the arity-1 matchers, and
`.github/workflows/deploy.yml` now runs `npm run typecheck:tests` in the build
job, so a new dropped message fails CI. What it cannot catch is a message added
to a matcher that legitimately takes two arguments
(`expect(x).toHaveProperty('a', 'b', 'msg')`); the rule is worth remembering when
writing tests.

## 5. `src/types/utif.d.ts` is right; a test had drifted from it

The ambient type deliberately omits the dimensions UTIF derives (`width`,
`height`) so that `ifd.w` cannot compile into a `0 × 0` canvas again.
`tests/pdf/edge-convert-from.test.ts` read `ifd.width` / `ifd.height` — real at
runtime, undeclared by design. The test now reads the raw `t256` / `t257` tags,
which keeps it an independent oracle for the conversion instead of routing the
check through `tiffPageDimensions`. No change requested; the stale sentence in
`tests/pdf/edge-forms-core.test.ts` that claimed the type "claims `w` / `h`" has
been corrected to match the declaration.

## 6. `noUnusedLocals` stays off, for one reason

`tsconfig.json` sets `noUnusedLocals: false` and `tsconfig.tests.json` inherits
it. Switching it on reports 13 findings in `src` — dead imports and unread locals
in `core/content.ts`, `ui/OutputActions.tsx`, `ui/FileDropZone.tsx` and others —
that this pass may not edit, so the flag would make the new CI step red for
reasons outside it. Checked separately with the same config: two findings live in
tests. `ux-definitions.test.ts` imported a `ToolField` type it no longer uses,
removed here; `field-required.test.ts:19` binds
`const open = protect.fields!.find((f) => f.key === 'userPassword')!` and never
reads it — left for its author, whose commit landed twenty minutes before this
pass finished. Clearing the `src` list is the task that unlocks the flag.

## 7. The one test that was red, and where it landed

Mid-pass, commit `c377720` gave `protect`'s password fields their own
`required` declaration, and the catalogue-shape rule in
`tests/pdf/parity-definitions.test.ts` caught it — the invariant working, not a
test going stale. Verbatim, with the field list it printed:

```
 FAIL  tests/pdf/parity-definitions.test.ts > the collapsing options bar > does not bury a gate: required fields come first and stay visible
AssertionError: expected [ …(3) ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "protect: \"userPassword\" is required but declared after optional fields",
+   "protect: \"userPassword\" is required but can be hidden by when()",
+   "protect: \"ownerPassword\" is required but declared after optional fields",
+ ]

 ❯ tests/pdf/parity-definitions.test.ts:230:22
```

Two clauses fired and they needed different answers:

* **Ordering** — the rule counted any field without `required` as optional, so
  `mode` (a segmented picker with `default: 'both'`, which can never be
  submitted empty) made both password fields look buried. A defaulted control
  cannot hold a run up, so it is no longer treated as one; a select *without* a
  default still is.
* **Visibility** — the source half went to `c377720`'s author:
  `protect.userPassword` now declares
  `required: (v) => v.mode !== 'owner'`, restating its own `when`, so the state
  the rule fears is unreachable (`1f95f53`). The test half is the split: a
  statically required field that a `when` can hide still fails, while a predicate
  that disappears in the same breath as the control passes.

The rule is now `buries no gate: a required control is not hidden while it
blocks, and not behind an open question`, and it probes the panel states instead
of pattern-matching the declaration — so a predicate that disagrees with its own
`when` (required in exactly the state that hides it) is caught too. Its twin
assertion, `the buried-gate rule is armed…`, feeds the rule the three shapes by
hand: a rule that has stopped matching anything otherwise looks exactly like a
clean catalogue.

State at the end of this pass: `npx vitest run` **1448 tests, all green**
(`Test Files 39 passed`), `tsc -p tsconfig.json` 0, `tsc -p tsconfig.tests.json` 0.
