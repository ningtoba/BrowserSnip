# M1 requests / notes for other owners

## Blocking another worker's file (not mine)

`tests/pdf/edge-editors.test.ts` has one red assertion that lives in M2's file:

- `page advice > is honest about an invisible OCR layer, with and without the engine`
  expects `offline.actions` to contain `open-engine`
  (`tests/pdf/edge-editors.test.ts:631`), but `pageAdvice.ts` (M2) now branches on
  `engineLoaded` / `engineFetchable` / `engineSize` while the test's `base` fixture
  still only sets `engineAvailable: false` (`tests/pdf/edge-editors.test.ts:611`).
  With `engineFetchable` undefined the OCR case returns `['run-ocr', 'add-text']`.
  Owner: whoever lands `text-editor/pageAdvice.ts` — either the fixture gains
  `engineFetchable: true, engineSize: '…'`, or the row is retired with the old
  flag. Not an M1 assertion and not changed by me.

Everything else in my definition of done is green:
`ux-annotation.test.ts` (35), `annotation-editor.test.ts`, `annotations.test.ts` —
166 passed / 1 failed, the failure above.

## Requests I did need from others

None. Everything M1 had to change was inside `src/components/tools/pdf/editor/**`.

## Contract change other surfaces should know about

`ToolMeta` (editor/types.ts) gained a required `afterCreate: 'stay' | 'default'`.
Nothing outside `editor/**` constructs a `ToolMeta`, and
`npx tsc -p tsconfig.json --noEmit` reports no error outside the files other
workers are editing, so no action is needed — recorded here so the field is not
"helpfully" made optional later. `effectiveAfterCreate(tool, pinned)` in
`editor/tools.ts` is the only reader of it.
