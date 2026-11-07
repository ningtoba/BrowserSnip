# M2 requests / notes for other owners

M2 owns `src/components/tools/pdf/text-editor/**` and `tests/pdf/ux-text.test.ts`.
Nothing here blocks M2: the text editor's own E10 route works. Two things sit just
outside the boundary and say less than they could.

## 1. A jump to a registry tool silently drops the open document

`useFileStore` keeps one file slot per tool and `layout/ToolWorkspace.tsx` calls
`setActiveTool(toolId)` on mount, so routing from tool A to tool B lands B with
whatever B had before — usually nothing. Only the three editor surfaces consume a
pending `EditorIntent` (`editor/quickModes.ts#takeEditorIntent`), so a registry tool
never picks the hand-off up.

The text editor hit this on its E10 advice row ("Page 3 has no text layer — run
OCR"), where the old toast claimed the document was coming along while the OCR page
opened empty. M2 fixed it inside its own files: `text-editor/handoff.ts#seedToolFile`
writes the target's slot before the route changes, and the copy now names what
actually happens (`planHandoff`).

Ask, if the shell owns it:

- `edit/FormFillMain.tsx:686` routes to `form-creator` with "Add fields" while a PDF
  is open. That button lands on an empty drop zone and needs the same carry (or
  copy that says the file must be picked again). Owner looks like M4 (`forms/**`).
- Hoisting `seedToolFile(toolId, file)` into `stores/file-store.ts` (or making
  `ToolWorkspace` adopt a pending intent for any tool id) would let every surface
  carry the document with one line instead of each module re-deriving the rule.

## 2. `shared/focusRing.ts` is now used by the text editor too

M5's `FOCUS_RING` is the one focus-ring spelling, and the text editor's paragraph
targets, resize handles and Edits rows use it (they draw their own `box-shadow`, so
`outline-*` is the correct choice there). No action needed — recorded so the ring is
not re-invented per component.

## Contract notes from M2 that other surfaces may want

- `keys.ts#MODE_AFTER_CREATE` / `stepsAside(mode, pinned)` is the declared
  one-shot-vs-sticky property for this editor's three modes, per the brief's pin
  ruling ("never an accident of which handler returns first"). M1's
  `effectiveAfterCreate` is the same idea for the annotation palette; the two tables
  should stay in step if a third editor appears.
- `tests/pdf/edge-editors.test.ts` had one assertion on the old
  `pageAdvice({ engineAvailable })` flag, which M1 flagged in `m1-request.md`. It is
  updated here (three engine states now: loaded / fetchable with a quoted size /
  unreachable), so that note can be closed.
