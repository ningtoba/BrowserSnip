# Research: how pdf.js's built-in annotation editor behaves (R1 reference brief)

Intended repo location: `docs/research/ux-references-pdfjs-viewer.md` (written to the run's
authorised artifact path; this worker had one output file only).
Reads `docs/UX-BRIEF.md` Bug 1 (tool does not step aside), Bug 2 (highlight must be text, not a
rectangle) and the "every surface" checklist.

**What I actually read (primary).** Source at two pinned tags of `mozilla/pdf.js`:

- `v5.4.54` (current-ish 5.x line): `src/display/editor/{tools.js, editor.js, annotation_editor_layer.js, freetext.js, highlight.js, ink.js, stamp.js, draw.js, toolbar.js, drawers/highlight.js}`, `web/{app.js, toolbar.js, ui_utils.js, annotation_editor_layer_builder.css}`, `web/locale` → `l10n/en-US/viewer.ftl`, `web/viewer.html`.
- `v4.0.379` (the exact version `BrowserSnip/package.json` declares: `"pdfjs-dist": "^4.0.379"`): `src/display/editor/{tools.js, annotation_editor_layer.js, freetext.js, highlight.js}`.
- Behavioural corroboration from pdf.js's own integration tests in commit
  [`6d2c6cf`](https://github.com/mozilla/pdf.js/commit/6d2c6cfc9f0c34ddee7fb96ae7ce7c3800f2c416), and from
  commits [`95f9bed`](https://github.com/mozilla/pdf.js/commit/95f9bedc7c96ef515d84ed28a884a0b6a3decc75),
  [`4e7c30d`](https://github.com/mozilla/pdf.js/commit/4e7c30da9a09ad3b46eaf1a6c4e93934a741db89),
  [`e1f6f51`](https://github.com/mozilla/pdf.js/commit/e1f6f5179f1920ad7496e6f4e69220a09cf17146),
  [#17291](https://github.com/mozilla/pdf.js/pull/17291), plus open issue
  [#20199](https://github.com/mozilla/pdf.js/issues/20199).

There is **no prose design doc** from Mozilla describing these rules; the normative statement of
intent is the code and its comments plus the integration tests. Everything below is labelled
*direct evidence* (read in source/tests) or *inference* (my reading).

---

## Summary

pdf.js never reverts to a "select" tool after you place anything — tool mode is a document-level
state that only the tool button can turn off, and since 2025 selecting an object *switches the
toolbar to that object's tool* rather than back to a cursor. Highlights are built from the real DOM
text selection: one annotation per drag, one quad per line rect, fill drawn as the sweep-line union
of those rects, and a drag that produced no rects creates nothing. Its selection model is unusually
complete for the keyboard (arrows 1/10 page units, coalesced into one undo step, resizers promoted
to `role="spinbutton"` for keyboard resize), and its undo stack is document-wide, 128 entries,
surfaced almost entirely through Ctrl+Z plus a post-delete snackbar.

**The headline for BrowserSnip: the user's expectation in Bug 1 ("tool must step aside") is *not*
what pdf.js does — pdf.js gets the same outcome by a different route (the new object always takes
selection + focus, and clicking an existing object selects it instead of creating a new one).**

---

## Findings

### Q1. After placing a text box, does the tool stay armed? What happens to focus?

**1.1 The active tool stays armed. Nothing in the editor code path returns the mode to
`AnnotationEditorType.NONE`.**
`AnnotationEditorLayer.pointerup()` → `createAndAddNewEditor()` → `add()` → `onceAdded()`; none of
these touch `#mode`. `updateMode()` only leaves the tool when something dispatches
`switchannotationeditormode` with `NONE`. `freetext.js` contains **zero** occurrences of
`AnnotationEditorType.NONE` in either v4.0.379 or v5.4.54; the only writes of `NONE` are the
initial value of `#mode` and the tool-button toggle.
**Sources:** [`src/display/editor/annotation_editor_layer.js` v5.4.54](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/src/display/editor/annotation_editor_layer.js), [`src/display/editor/tools.js`](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/src/display/editor/tools.js), [`src/display/editor/freetext.js`](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/src/display/editor/freetext.js). **Confidence: high. Support: direct evidence (source reading; a negative claim, see "Missing evidence").**

**1.2 The only way out of a tool is the tool button again.** Each editor button dispatches
`switchannotationeditormode` with `mode = classList.contains("toggled") ? NONE : <TOOL>` — i.e. the
button is a toggle between its tool and "no tool".
**Source:** [`web/toolbar.js` v5.4.54](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/web/toolbar.js). **Confidence: high. Support: direct evidence.**
pdf.js's own test turns the Text tool off with `switchToFreeText(page, /* disable */ true)` — a
second click on the button — never with Escape
([`6d2c6cf`](https://github.com/mozilla/pdf.js/commit/6d2c6cfc9f0c34ddee7fb96ae7ce7c3800f2c416)).

**1.3 Escape does *not* clear the tool — it unselects.** The UI-manager keyboard table binds
`Escape`/`mac+Escape` → `unselectAll()`. "Esc deselects the annotation **tool**" is still an open
feature request as of the last check ([#20199](https://github.com/mozilla/pdf.js/issues/20199),
labels `feature`, `editor`, open).
**Confidence: high. Support: direct evidence (code) + corroboration (open issue).**

**1.4 Focus goes *into* the new box immediately, and comes back to the box's own div on commit.**
`FreeTextEditor.onceAdded()` → `enableEditMode(); editorDiv.focus()`. `disableEditMode()` then
carries the caret from the `contenteditable` back to the wrapper div:

> `// On Chrome, the focus is given to <body> when contentEditable is set to false, hence we focus the div.`
> `this.div.focus({ preventScroll: true /* See issue #15744 */ });`

…plus `this._isDraggable = true` and `this.isEditing = false`. So after you stop typing you are
standing *on the object*, not in a layer owned by another tool: drag, arrows, Delete all work
without a further click. That is the part of Bug 1's expectation that pdf.js does satisfy, and it
satisfies it with focus, not with a tool switch.
**Sources:** [`freetext.js` v5.4.54](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/src/display/editor/freetext.js), [`freetext.js` v4.0.379](https://raw.githubusercontent.com/mozilla/pdf.js/v4.0.379/src/display/editor/freetext.js). **Confidence: high. Support: direct evidence.**

**1.5 Drawn annotations are selected (and focused) at the end of the gesture.**
`DrawingEditor.onceAdded(focus)`: `this._isDraggable = true; if (this.#mustBeCommitted) { this.commit(); this.parent.setSelected(this); if (focus && this.isOnScreen) this.div.focus(); }` —
note the `isOnScreen` guard, which was an explicit fix
(["Don't focus a newly added drawing if it isn't visible on screen", PR #19144](https://github.com/mozilla/pdf.js/releases/tag/v4.9.155)).
`AnnotationEditorLayer.add()` passes `/* focus = */ !this.#isEnabling`, i.e. it does **not** steal
focus while a layer is being (re)enabled.
**Confidence: high. Support: direct evidence.**

**1.6 Selecting an object switches the toolbar to that object's tool (2025 behaviour).**
`AnnotationEditorUIManager.setSelected()` starts with
`this.updateToolbar({ mode: editor.mode, editId: editor.id })`, and `AnnotationEditor.get mode()`
returns the editor type. Bug 1975538 / commit
[`6d2c6cf`](https://github.com/mozilla/pdf.js/commit/6d2c6cfc9f0c34ddee7fb96ae7ce7c3800f2c416) added a
regression test named *"must check that we switch to FreeText in clicking on a FreeText annotation"*,
whose final assertion is `page.waitForSelector(".annotationEditorLayer.freetextEditing")` after
clicking the text box.
**Interpretation:** pdf.js has no neutral "Select" resting state; the toolbar is a mirror of the
selection, not an independent mode. **Confidence: high.**

**1.7 Stamp / Image / Signature are not click-to-place at all.**
In `pointerup()`, before creating anything:
```js
if (currentMode === AnnotationEditorType.STAMP || currentMode === AnnotationEditorType.SIGNATURE) {
  this.#uiManager.unselectAll();
  return;
}
```
Images arrive via file picker or `StampEditor.paste()` → `parent.pasteEditor({mode: STAMP}, …)`
(which *does* set the mode and centres the new editor in the viewport). So the "one-shot placement"
tools in BrowserSnip's list have no pdf.js analogue for the click-to-place half of Bug 1; the
closest analogue is paste, which calls `updateToolbar(mode)` and leaves the mode set.
**Confidence: high. Support: direct evidence. (v4.0.379 has the same guard minus SIGNATURE.)**

---

### Q2. Which tools are sticky vs one-shot?

It is **inferable from the code, not documented in prose**. Two static flags decide it:
`static get isDrawer()` and `static get supportMultipleDrawings()`, consumed by
`AnnotationEditorLayer.pointerup()`:

```js
if (this.#currentEditorType?.isDrawer && this.#currentEditorType.supportMultipleDrawings) return; // gesture already handled it
```

| Tool | `isDrawer` | `supportMultipleDrawings` | Observable stickiness |
|---|---|---|---|
| Pen / Ink | true | **true** (`InkEditor`) | Stays in the *same* drawing session; each stroke is a separate undo step (`AnnotationEditorParamsType.DRAW_STEP`) until the session ends (`cleanUndoStack(DRAW_STEP)` in `endDrawing`). Sticky by design. |
| Highlight | false (v4) / drawer-like free mode (v5) | — | Armed until toggled off; every completed text selection creates another highlight, so it is de-facto sticky. `canCreateNewEmptyEditor()` is `false`, so Enter/Space creates nothing. |
| Free text | false | false | Stays armed, **but** the next click is usually swallowed: `pointerdown` sets `#allowClick = !editor || editor.isEmpty()` for the still-focused box, so click #1 commits and only click #2 places a second box. |
| Stamp / Image / Signature | false | false | Never created by a page click (see 1.7); created from a dialog/paste. |
| Shapes / Arrow | — | — | **Not in pdf.js at all.** v4/v5 editors are exactly: FreeText, Highlight, Ink, Stamp(image), Signature. Any BrowserSnip shape tool has no pdf.js precedent. |

**Sources:** [`src/display/editor/draw.js`](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/src/display/editor/draw.js) (`DrawingEditor.isDrawer = true`, `supportMultipleDrawings = false` base), [`ink.js`](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/src/display/editor/ink.js) (`supportMultipleDrawings → true`), [`highlight.js`](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/src/display/editor/highlight.js), [`stamp.js`](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/src/display/editor/stamp.js), [`annotation_editor_layer.js`](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/src/display/editor/annotation_editor_layer.js).
**Confidence: high for the mechanism; medium for the "Free text absorbs one click" sequencing (derived from event ordering pointerdown→blur; I did not run it in a browser).** *Researcher inference is flagged in the table's FreeText row.*

---

### Q3. How a highlight is built from a drag

**3.1 The drag is a native DOM text selection, not a marquee.** With the Highlight tool armed,
`updateMode(HIGHLIGHT)` calls `enableTextSelection()`, which sets `div.tabIndex = -1`, adds a
`selectstart` listener on `document`, adds class `highlighting` to the text layer, and — crucially —
`togglePointerEvents(false)` (editor layer gets `pointer-events: none`) and `disableClick()`. The
annotation layer is disabled too, per
[`95f9bed` "Disable annotation layer when highlighting (bug 1868759)"](https://github.com/mozilla/pdf.js/commit/95f9bedc7c96ef515d84ed28a884a0b6a3decc75):
*"When highlighting, the annotation editor layer is disabled to get pointer events from the text
layer, but the annotation layer must be then disabled either in order to avoid bad interactions."*
**Confidence: high. Support: direct evidence.**

**3.2 Rects come from the text layer, one per line fragment.**
v4.0.379 `AnnotationEditorLayer.pointerUpAfterSelection()` and v5.4.54 `AnnotationEditorUIManager.getSelectionBoxes()`
both do: `range.getClientRects()` → drop `width === 0 || height === 0` → normalise to page-relative
fractions through a rotation switch (90/180/270 each have their own rotator) → `boxes[]`. v5
iterates **all** `selection.rangeCount` ranges (so multi-range/RTL-ish selections work) and
returns `null` if any range is outside that page's text layer.
**Confidence: high. Support: direct evidence.**

**3.3 One annotation per drag, with one quad per rect.**
`HighlightEditor` stores `#boxes` and serialises:
`quadPoints = new Array(boxes.length * 8)` — 8 numbers per box — with the comment:
*"The specifications say that the rectangle should start from the bottom left corner and go
counter-clockwise. But when opening the file in Adobe Acrobat it appears that this isn't correct
hence the 4th and 6th numbers are just swapped."* The annotation's `rect` is the whole bounding box.
**So the brief's phrase "one mark per line" is wrong for pdf.js: it is one mark, many quads.**
**Sources:** [`highlight.js` v4.0.379](https://raw.githubusercontent.com/mozilla/pdf.js/v4.0.379/src/display/editor/highlight.js), [`highlight.js` v5.4.54](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/src/display/editor/highlight.js). **Confidence: high.**

**3.4 The painted shape is the union outline, not the bounding box.**
`HighlightEditor.#createOutlines()` runs `new HighlightOutliner(boxes, borderWidth = 0.001)` and
`getOutlines()` — a **sweep-line** union of the input rectangles (`drawers/highlight.js`: "We begin
to sort lexicographically the vertical edges … we're now using a sweep line algorithm to find the
outlines"), PR
[#17291 "Add a way to extract the outlines of a union of rectangles"](https://github.com/mozilla/pdf.js/pull/17291):
*"The goal is to be able to get these outlines to fill the shape corresponding to a text selection."*
A second pass (`borderWidth 0.0025, innerMargin 0.001`) produces the *selection/hover outline*, and
`lastPoint` is stored so the outline's end can be re-anchored. Drawing is via the page `DrawLayer`
(SVG paths, `fill: color`, `clipPath`), not canvas and not a CSS box.
**Consequence for "covers the leading":** pdf.js inherits the geometry of the text-layer spans; it
tightens the shape by unioning the *word* rects rather than by measuring baselines. Whether a given
line's leading is covered is therefore a property of pdf.js's own text layer, not of the highlight
algorithm. **Confidence: high for the algorithm; medium for the leading claim (researcher
inference from how the inputs are produced — I did not measure rendering).**

**3.5 A drag that hits no text creates nothing — and it is a two-tier rule.**
- Collapsed/empty selection: `if (selection.rangeCount === 0) return;` / `if (!boxes || boxes.length === 0) return;` (v4 literally: `if (boxes.length !== 0) { createAndAddNewEditor(...) }` then `selection.empty()`).
- Pointer down on a place with **no text at all** (the `textLayer` div itself, a `role="img"`
  marked-content span, or `.endOfContent`): v5 falls back to a *free highlight* —
  `HighlightEditor.startHighlighting(...)`, a `FreeHighlightOutliner` stroke of configurable
  thickness; `#endHighlight` then does
  `if (!this._freeHighlight.isEmpty()) { createAndAddNewEditor(…) } else { parent.drawLayer.remove(this._freeHighlightId) }`.
  **Free highlights do not exist in v4.0.379** (`startHighlighting`/`FreeHighlight` are absent from that tag's `highlight.js`).
**Confidence: high. Support: direct evidence.**

**3.6 While a highlight drag is in progress, existing highlights are made non-interactive**, because
*"When the mouse was hovering an existing highlight, all the text in the page was selected"*
([`4e7c30d` "Disable existing highlights when drawing a new one (bug 1879035)"](https://github.com/mozilla/pdf.js/commit/4e7c30da9a09ad3b46eaf1a6c4e93934a741db89)).
Mechanism visible in source: `HighlightEditor.disableEditing()/enableEditing()` toggle a
`disabled` class, and the CSS has `.highlightEditor.disabled .internal { pointer-events: none }`
while `.annotationEditorLayer.disabled.highlightEditing :is(.freeTextEditor, .inkEditor, .stampEditor, .signatureEditor) { pointer-events: auto }`
deliberately omits `.highlightEditor`.
**Confidence: high for the rule; medium for which call site toggles it in every path (I did not
trace every `disableEditing()` caller).**

**3.7 A highlight is not movable and has no resize handles.** Constructor: `this._isDraggable = false;`
and `HighlightEditor` never overrides `isResizable` (base returns `false`); the resize-handle CSS is
scoped to `.freeTextEditor, .inkEditor, .stampEditor, .signatureEditor` — `.highlightEditor` is not
in that list. Highlights get a floating edit toolbar with a **colour picker** (`toolbarButtons`
getter) and Remove, hover/selected outline states, and `rotate()` support for rotated pages.
**Confidence: high.**

**3.8 Selection can also originate outside the tool.** Context menu / floating toolbar path:
`highlightSelection(methodOfCreation)` → if `#mode === NONE` it calls
`switchToMode(HIGHLIGHT, callback)` first (`showannotationeditorui` → in `web/toolbar.js`
`editorHighlightButton.click()`), creates the editor, and if it had to enter the mode it also calls
`showAllEditors("highlight", true, true)`. Holding **Shift** during the selection defers creation to
`keyup` (`#highlightWhenShiftUp` → `#onSelectEnd("main_toolbar")`).
Origin: [`e1f6f51` "create an highlight from the context menu when some text is selected (bug 1867739)"](https://github.com/mozilla/pdf.js/commit/e1f6f5179f1920ad7496e6f4e69220a09cf17146).
**Confidence: high.**

---

### Q4. Selection model and keyboard

**4.1 Click / multi-select / drag.**
`AnnotationEditor.pointerdown`: right-click (and mac ctrl-click) → `preventDefault()` + return.
`#isDraggable` → `#setUpDragSession()`, which only starts dragging **if the editor is already
selected** (`if (isSelected) { … }`), and on `cancelDrag` falls back to `#selectOnPointerEvent(e)`.
Otherwise `#selectOnPointerEvent`: `ctrlKey` (non-mac) / `shiftKey` / `metaKey` (mac) →
`parent.toggleSelected(this)` (add/remove from multi-selection), else `parent.setSelected(this)`.
`commitOrRemove()` on the manager is the universal "finish what you're doing" call — it is invoked
before mode changes, before viewport updates, before delete, and before undo-affected operations.
**Confidence: high.**

**4.2 Visual feedback (CSS is part of the contract).**
`:is(.freeTextEditor,.inkEditor,.stampEditor,.signatureEditor)` → `border: solid 2px transparent`
when unselected, `--hover-outline` (grey `#8f8f9d`) on `:hover:not(.selectedEditor)`, and
`--focus-outline` (`#0060df`, 2px) + a 1px white "around" via `::before` when `.selectedEditor`;
`.selectedEditor { z-index: 100000 }`; and `&.draggable.selectedEditor { cursor: move }` — i.e.
the move cursor only appears once the object is selected *and* is actually draggable. Rotation-aware:
`[data-main-rotation]`/`[data-editor-rotation]` select which handle gets `nwse-`/`nesw-`/`ns-`/`ew-resize`,
`.editToolbar { rotate: 270deg }` on rotated pages, forced-colours overrides for HCM.
Source: [`web/annotation_editor_layer_builder.css` v5.4.54](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/web/annotation_editor_layer_builder.css). **Confidence: high.**

**4.3 Resize handles.** `#createResizers()` builds 8 divs (`topLeft, topMiddle, topRight, middleRight, bottomRight, bottomMiddle, bottomLeft, middleLeft`) or 4 when `_willKeepAspectRatio`, all `tabIndex = -1` until keyboard-resize is enabled; `--resizer-size: 6px` + 1px border, offset outward by `--resizer-shift` (so the visual dot is ~8px including border; there is no extra hit-slop in CSS). DOM order is explicitly commented:
*"When the resizers are used with the keyboard, they're focusable, hence we want to have them in this order (top left, top middle, top right, …) in the DOM to have the focus order correct"* — and on page rotation the DOM nodes are physically reordered so the first is again the visual top-left. Resize is committed as a single undo step (`#addResizeToUndoStack()`), min size `AnnotationEditor.MIN_SIZE = 16`.
**Confidence: high.**

**4.4 Keyboard map (from the two `KeyboardManager` tables in `tools.js`).**

| Keys | Action | Guard |
|---|---|---|
| `Ctrl/Cmd+A` | `selectAll()` (commits first) | `textInputChecker` |
| `Ctrl/Cmd+Z` / `Ctrl+Y` / `Ctrl+Shift+Z` (both cases; mac comment) | `undo()` / `redo()` | `textInputChecker` |
| `Backspace`, `alt/ctrl/shift+Backspace`, mac variants, `Delete`, `ctrl+Delete`, `shift+Delete`, `mac+Delete` | `delete()` — **Delete and Backspace are the same binding** | `textInputChecker` |
| `Enter`, `Space` | `addNewEditorFromKeyboard()` (only if `currentLayer.canCreateNewEmptyEditor()`) | focus must be inside the viewer container and `target` not a `<button>`; plus `!self.isEnterHandled` (Enter v5) so an editor that handles Enter keeps it |
| `Escape` | `unselectAll()` — which first commits an in-progress editor, and returns early if a drawing session got committed | none |
| `Arrow×4` | `translateSelectedEditors(±1)` | `arrowChecker`: container contains `document.activeElement`, active element is not a `BUTTON`, and `hasSomethingToControl()` |
| `Ctrl+Arrow` / `Shift+Arrow` (mac: `shift+Arrow`) | `translateSelectedEditors(±10)` | same |

Units are **page units, not CSS pixels**: `TRANSLATE_SMALL = 1; TRANSLATE_BIG = 10; // page units`.
`translateSelectedEditors` coalesces a burst into one undo entry: `const TIME_TO_WAIT = 1000;`
*"We don't want to have an undo/redo for each translation so we wait a bit before adding the command
to the command manager."*
In v5 the whole table is gated by `if (this.#mode !== AnnotationEditorType.NONE && !this.isEditorHandlingKeyboard)`;
in v4.0.379 it is only `if (!this.isEditorHandlingKeyboard)`. That difference matters (see Contradictions).
**Confidence: high.**

**4.5 Nudge while typing is per-editor, and only when the box is empty.**
`FreeTextEditor._keyboardManager`: `ctrl+s/mac+meta/s/ctrl+p/mac+meta+p` → `commitOrRemove`
(`{ bubbles: true }`, *"Commit the text in case the user use ctrl+s to save the document"*),
`ctrl+Enter / mac+meta+Enter / Escape / mac+Escape` → `commitOrRemove`, arrows → `_translateEmpty`
with `arrowChecker = self => self.isEmpty()`. `shouldGetKeyboardEvents() { return this.isInEditMode(); }`
is what makes `isEditorHandlingKeyboard` true so the global table steps aside.
**Confidence: high.**

**4.6 Suppressing shortcuts while typing — three independent layers.**
1. Editor level: `isEditorHandlingKeyboard` (`getActive()?.shouldGetKeyboardEvents() || (selectedEditors.size === 1 && firstSelectedEditor.shouldGetKeyboardEvents())`) and, in v5, `mode !== NONE`.
2. Field level: `textInputChecker = (_self, { target: el }) => el instanceof HTMLInputElement ? (type !== "text" && type !== "number") : true` — i.e. an open colour input or a text/number field owns its keys, and it is attached to undo/redo/delete/selectAll.
3. Viewer level, `web/app.js onKeyDown`: if the focused element is `INPUT|TEXTAREA|SELECT`, a `BUTTON` + Space, or `isContentEditable`, **every** viewer shortcut returns — *except* Escape 27, which is still allowed so menus can be dismissed.
4. Also `resizer`-mode: `shouldGetKeyboardEvents()` returns `#isResizerEnabledForKeyboard`, and `#resizerBlur` ends resize when focus leaves the resizer group (`event.relatedTarget?.parentNode !== this.#resizersDiv`).
**Confidence: high.**

**4.7 Tab order / focus plumbing.** Every editor div is `tabIndex = 0`, `role="application"`,
`data-editor-rotation`, `id`; `enable()/disable()` flip `tabIndex` 0/−1, and `#disableAll()` (mode →
NONE) removes all editors from the tab order. Focus in → `focusin` → `parent.setSelected(this)`
unless the editor was clicked (`#hasBeenClicked`). Unselecting a focused editor moves focus to the
layer: `this._uiManager.currentLayer.div.focus({ preventScroll: true })` (comment: *"Don't use
this.div.blur() because we don't know where the focus will go"*). Buttons in the floating edit
toolbar set `editor._focusEventsAllowed = false` on `focusin` (capture) so clicking Remove/Alt-text
does not re-trigger editor focus logic. Moving an editor between page layers preserves focus through
a `setTimeout(…, 0)` dance that disables focus callbacks until the editor is re-focused.
Keyboard-only path to *start* editing: `Enter`/`Space` with the container focused creates an editor
centred in the viewport (`addNewEditor` → `#getCenterPoint()`, rotation-aware, clamped to the
viewport), and `Enter` on a selected resizable editor enters resize mode.
**Confidence: high for the code; medium for "Tab cannot reach annotations when no tool is armed"
(which follows from `#disableAll` + `tabIndex = -1` but is a behavioural claim I did not run).**

**4.8 Not in pdf.js:** `Cmd/Ctrl+D` duplicate (copy/paste via `Ctrl+C/X/V` with a
`application/pdfjs` clipboard payload instead), no marquee rubber-band selection of several editors,
no `role="toolbar"` on the main tool row (the *per-object* floating toolbar has it).
**Confidence: high for the absence of Cmd+D in the two tables; medium for marquee (absence of code).**

---

### Q5. Undo / redo: scope and surfacing

- **Scope: whole document, one stack.** `CommandManager` lives on the `AnnotationEditorUIManager`
  (one per document, owning all per-page layers), so undo crosses pages. `constructor(maxSize = 128)`;
  the buffer is trimmed at the far end (`#commands.splice(0, 1)`) so history is capped, not unbounded.
- **Coalescing primitives:** `addCommands({cmd, undo, post?, mustExec, type, overwriteIfSameType, keepUndo})`
  — *"For example when we change a color we don't want to be able to undo all the steps, hence we only
  want to keep the last undoable action in this sequence of actions"*; `cleanType(type)` drops the
  steps of one session (`cleanUndoStack(AnnotationEditorParamsType.DRAW_STEP)` when an ink drawing ends).
- **Grouping by time** for nudges (`TIME_TO_WAIT = 1000`) and by type for parameters.
- **Add/remove are both commands:** `addUndoableEditor(editor)` (`undo: () => editor.remove()`),
  `delete()` builds `cmd`/`undo` and, inside `cmd`, shows the snackbar before removing.
- **Surfacing:** `undo()`/`redo()` dispatch `annotationeditorstateschanged` with
  `hasSomethingToUndo`/`hasSomethingToRedo`/`isEditing`/`isEmpty`/`hasSelectedEditor`(/`hasSelectedText` in v5).
  In Firefox builds that event goes to `externalServices.updateEditorStates(evt)` (`MOZCENTRAL` only)
  which drives native chrome buttons. **In the generic viewer there is no Undo/Redo toolbar button at
  all** — `web/viewer.html` v5.4.54 has no `editorUndoButton`/`editorRedoButton`; the only visible
  affordance is `EditorUndoBar` after a delete.
- **`EditorUndoBar`** (`web/editor_undo_bar.js`): `role="status"`, `aria-labelledby="editorUndoBarMessage"`,
  `tabindex="-1"`, message from `pdfjs-editor-undo-bar-message-{highlight,freetext,ink,stamp,signature}`
  ("Highlight removed"…) or `…-message-multiple` = *"{count} annotations removed"*, plus Undo and Close
  buttons; it focuses itself after 100 ms — *"Without the setTimeout, VoiceOver will read out the
  document title instead of the popup label"*; it hides on `beforeprint`, `download`, on any keypress
  except Tab/Shift (`app.js onKeyDown`, with a guard for Space/Enter on its own undo button), and
  whenever the mode returns to NONE.
- **Context menu** exposes `undo`, `redo`, `delete`, `selectAll` via `onEditingAction({name})`.
**Confidence: high. Support: direct evidence (all quoted from source at v5.4.54).**

---

### Q6. Explicit accessibility affordances in the annotation editor

1. **Live announcements per created object.** `a11yAlert(messageId, args)` sets `data-l10n-id` on
   `#viewer-alert` (`<span id="viewer-alert" class="visuallyHidden" role="alert">` in `web/viewer.html`).
   Strings exist for all five types: *"Highlight added", "Text added", "Drawing added", "Image added", "Signature added"*.
   Called from the constructor, guarded by `if (!this.annotationElementId)` so re-hydrating an existing
   annotation doesn't announce.
2. **Object roles + names.** Editor wrapper: `role="application"` + `data-l10n-id`
   (`pdfjs-editor-highlight-editor` → `.aria-label = Highlight editor`; `…-ink-editor` → "Drawing editor";
   `…-stamp-editor` → "Image editor"; signature uses `.aria-description = Signature editor: {description}`).
   Highlight: `div.setAttribute("aria-label", this.#text); div.setAttribute("role", "mark")` — the
   highlighted text *is* the accessible name — and the painted `div.internal` is `aria-hidden="true"`.
   Free text inner editable: `role="textbox"` + `aria-multiline=true` while editing, downgraded to
   `role="comment"` (and `aria-multiline` removed) when editing is disabled;
   `aria-activedescendant="<id>-editor"` on the wrapper when not in edit mode; placeholder via
   `pdfjs-free-text2.default-content = "Start typing…"`.
3. **Resize handles are announced.** `role="spinbutton"` on each resizer, `data-l10n-id` →
   `pdfjs-editor-resizer-*` = *"Top left corner — resize"*, *"Middle right — resize"*, …; DOM order =
   visual order and re-sorted on rotation; `Enter` to enter, blur/`Escape`-ish to leave.
4. **Per-object toolbar is a real `role="toolbar"`** with `tabIndex=0` buttons named "Remove text" /
   "Remove highlight" / "Remove drawing" / "Remove image" / "Remove signature"; `:focus-visible` gets a
   2px solid `#0060df` (light) / `#0df` (dark) outline; `contextmenu` suppressed on the toolbar and on
   the undo bar; the floating Highlight button has both `.title` and `.aria-label` plus a
   `.visuallyHidden` label span.
5. **Tool row semantics: `role="radiogroup"` + `role="radio"`.** `#editorModeButtons` is a radiogroup;
   each tool button carries `role="radio"`, `aria-haspopup="true"`, `aria-expanded`, `aria-controls`.
   `toggleExpandedBtn()` (`web/ui_utils.js`) writes `aria-expanded`, **not** `aria-checked`; the sibling
   helper `toggleCheckedBtn()` writes `aria-checked` and is used for other tool groups.
   **Researcher judgement: this is a pdf.js weak spot, and BrowserSnip's `aria-pressed` requirement is
   better — do not copy this detail.**
6. **Reading order + structure.** Editors are re-parented through `TextAccessibilityManager.moveElementInDOM(...)`
   and carry `structTreeParentId` into the serialised annotation; `pause(on)`/`#focusedElement` preserve
   focus across page-virtualisation.
7. **Forced-colours mode is treated as a first-class state** throughout the editor CSS
   (`@media screen and (forced-colors: active)` → `CanvasText`/`ButtonFace`/`Highlight` variants,
   `forced-color-adjust: none` on colour swatches), plus inverted-contrast hover rules from later releases.
**Confidence: high. Support: direct evidence.**

---

## Contradictions

1. **Bug 1's expectation vs pdf.js reality.** The brief asserts the correct behaviour is "the active
   tool returns to Select". pdf.js does the opposite (Findings 1.1–1.3) and still satisfies the user's
   *complaint*, because (a) the new object receives selection + focus (1.4, 1.5), and (b) a click on an
   existing object selects it rather than creating a new one (`event.target !== this.div` early-return
   in the layer's `pointerdown`, and `AnnotationEditor.pointerdown` handling the click first). A third
   behaviour, added in 2025, is that the toolbar mirrors the selection (1.6). **Recommendation does not
   change (BrowserSnip has no "select" tool concept to mirror), but the brief's claim that pdf.js "does
   the obvious thing here" is not accurate.**
2. **"One mark per line" vs one annotation with N quads.** The brief's Bug 2 wording implies multiple
   annotations; pdf.js emits one annotation whose `quadPoints` has 8 numbers per line rect (3.3). This
   matters for BrowserSnip: matching *the file format* means one `/Annot` subtype `/Highlight` per drag
   with a `QuadPoints` array, not one per line.
3. **"Clicking an existing highlight selects that mark" vs "highlights are inert while the highlight
   tool is armed."** pdf.js resolves the conflict by disabling existing highlights during the drag (3.6)
   — the opposite of what the brief asks for. Both are defensible; the brief must choose deliberately
   and document it. (In the *unarmed* state pdf.js does let you click a highlight to select it.)
4. **Shift means different things.** pdf.js uses Shift for (a) add/remove from selection
   (`#selectOnPointerEvent`) and (b) "hold Shift to keep selecting / defer highlight creation"
   (`#highlightWhenShiftUp`). The brief proposes Shift-click = "keep this sticky tool armed". Reusing
   Shift for stickiness collides with the established modifier. *Researcher judgement: prefer Ctrl/Cmd
   or Alt for stickiness, or the button-toggle model.*
5. **Keyboard table gating differs between the two versions BrowserSnip straddles.** v4.0.379 runs the
   global editor shortcuts whenever `!isEditorHandlingKeyboard`; v5.4.54 additionally requires
   `mode !== NONE`. In v5, arrows/Delete work in a "no tool" state only *because* selecting an editor
   flips the mode to that editor's tool. If BrowserSnip keeps a real "Select" tool, it must run its
   shortcut table in the Select state too (the v4 shape), or arrows will silently die.
6. **`pdfjs-dist@^4.0.379` is a caret range.** Behaviour differs across that range: free (drawn)
   highlights and `role="mark"`/`a11yAlert` additions are absent from 4.0.379 and present by 4.10.x.
   Resolve the lockfile before citing "pdf.js does X" to a user of this repo.

---

## What BrowserSnip should copy, and why

1. **Build highlights from the text layer's own geometry, and store per-line quads.** Take rects from
   the text layer (pdf.js: `range.getClientRects()` over every non-collapsed range, dropping zero-size
   rects), keep them in page-relative fractions so zoom/rotate are free, emit one annotation with one
   quad per rect, and paint the union outline — not the bounding box — so the gap between lines stays
   unpainted. `BrowserSnip` already computes quads, so the missing half is (a) source = DOM selection
   rects rather than a drag rectangle, (b) union-outline painting, (c) per-quad rather than
   per-bbox serialisation. This is the whole of Bug 2.
2. **"No rects → no annotation", plus a fallback for no-text regions.** Copy the three guards
   (`rangeCount === 0`, `range.collapsed`, `boxes.length === 0`) and, separately, the v5 rule that
   dragging on a *non-text* region falls back to a free-form highlight of configurable thickness
   instead of producing a garbage text highlight — which is exactly the "scanned pages with no text
   layer" row of the brief's edge-case matrix.
3. **Commit-on-blur returns focus to the object, not to a tool.** `disableEditMode()` →
   `this.div.focus({ preventScroll: true })` + `_isDraggable = true` + `aria-activedescendant`
   restored. That is what makes "arrow, drag, Delete all work on it immediately" true without needing
   a Select tool, and it fixes the caret-in-the-wrong-layer half of Bug 1 directly.
4. **The click-vs-create rule.** "Pointer down on an existing object selects it; a click on empty
   page area with a tool armed creates." pdf.js implements it with one early-return
   (`if (event.target !== this.div) return;`) plus `#allowClick = !editor || editor.isEmpty()` so a
   commit click is never mis-read as a create click. Whatever tool state machine BrowserSnip picks,
   steal the `commitOrRemove()` discipline: call it before mode change, before delete, before
   viewport/scale/rotation changes, and before undo.
5. **Nudge units + time-coalesced undo.** 1 page unit / 10 page units with a 1000 ms burst window so
   ten taps of ArrowRight is one undo step, and the same for colour/size parameter changes
   (`overwriteIfSameType` + `keepUndo`). A per-keypress undo step makes arrow-nudging feel broken even
   when it works.
6. **Escape semantics, layered.** Inside a text editor: Escape = `commitOrRemove`. Outside: Escape =
   unselect. Add one more level (clear the armed tool) that pdf.js still doesn't have — that is the
   brief's `Esc unwinds one level` line, and pdf.js's open #20199 is evidence users ask for it.
7. **Keyboard resize via handles-as-spinbuttons.** `Enter` on a selected resizable editor focuses the
   (visually-first) handle, arrows resize 1/10, blur ends and pushes one undo step, handles kept in
   visual DOM order across page rotation. This is the cheapest known way to make handles
   keyboard-reachable, and it directly answers the checklist's "keyboard reachability for every
   pointer-only action".
8. **Accessibility scaffolding worth lifting verbatim:** a visually-hidden `role="alert"` region
   fed per-type strings ("Text added"/"Highlight added"); `role="mark"` + the highlighted text as
   `aria-label` on highlight editors with the painted layer `aria-hidden`; `role="textbox"` +
   `aria-multiline` ↔ `role="comment"` switching on the text editor; `role="toolbar"` + verb-named
   per-object Remove buttons ("Remove text", not "Delete"); `role="status"` + `aria-labelledby` +
   programmatic focus (with the VoiceOver 100 ms note) on the post-delete undo snackbar; forced-colours
   variant for every state.
9. **Undo surface honesty.** pdf.js keeps the model (`hasSomethingToUndo/Redo` in one state event) but
   only exposes a snackbar. BrowserSnip should keep visible Undo/Redo buttons driven by exactly that
   state shape and announce them to AT — the brief's "undo/redo reported to assistive tech" line has no
   pdf.js precedent to copy, only the event payload to imitate.

## Where BrowserSnip's stated intent differs (deliberate, and worth documenting in the repo)

| Brief says | pdf.js does | Verdict |
|---|---|---|
| After placing a text box, active tool returns to **Select** | Tool stays armed; only the tool button (or switching to `NONE`) clears it | **Diverge, on purpose.** pdf.js has no Select tool to return to; its buttons are toggles. Document "one-shot unless the tool declares sticky" as the property, since nothing in pdf.js states it. |
| Sticky-vs-one-shot is a documented per-tool property | Two static flags (`isDrawer`, `supportMultipleDrawings`) plus a dialog-flow special case; never described in prose | **Copy the outcome, write the missing doc.** pdf.js proves the concept is expressible as one boolean per tool. |
| Pen and Highlight sticky | Pen sticky (accumulates strokes into one annotation); highlight stays armed | Agree. |
| Stamp/Image/Signature/Shape/Arrow one-shot | Those tools either don't exist (Shape/Arrow) or aren't click-placed (Stamp/Image/Signature) | **No precedent.** Treat as free design; keep the "place once, hand control back" rule. |
| One mark **per line** | One mark with one quad per line | **Fix the brief's wording.** Per-line annotations would break `/QuadPoints` semantics and Acrobat round-tripping. |
| Clicking an existing highlight selects it (even with the tool armed) | Existing highlights are deliberately made inert while highlighting (bug 1879035) | **Conflict to resolve.** Suggested reconciliation: hit-test existing marks first when the drag does not select any text; make marks selectable only after the current drag commits. Whatever is chosen, cite both behaviours so a later worker doesn't "fix" it back. |
| Shift-click holds a sticky tool armed | Shift = add-to-selection; Shift-hold = defer highlight creation | **Collision.** Pick another modifier. |
| Arrow nudge 1px, Shift 10px | 1 / 10 **page units**, Ctrl-or-Shift for the big step, 1000 ms coalescing | Keep the brief's px model but copy the coalescing. |
| `Cmd/Ctrl-D` duplicates | No duplicate binding; `Ctrl+C/V` with an `application/pdfjs` payload | **pdf.js is weaker here; BrowserSnip's intent stands.** |
| `aria-pressed` on tool toggles | `role="radio"` + `aria-expanded` (and `aria-checked` only on non-editor groups) | **pdf.js is wrong-ish; keep `aria-pressed` (or full radiogroup semantics with `aria-checked`), don't copy.** |
| Esc clears the tool | Escape never clears the tool (open #20199) | BrowserSnip's checklist wins. |

---

## Missing evidence / could not confirm

- **No Mozilla prose spec.** Nothing in the pdf.js docs/wiki states the stickiness or selection rules;
  every claim here is code + tests + commit messages. A reader who disputes a behaviour should be
  pointed at the file names above, not at a documentation URL.
- **Proving "the tool never reverts" is a negative claim.** I searched the two most relevant files at
  two tags for every write of `AnnotationEditorType.NONE`; I did not run the viewer in a browser, and
  I did not read the Firefox *chrome* (non-generic) annotation toolbar, which wraps the same engine and
  could add a revert in its own UI.
- **Free-text click sequencing** (commit-click absorbed, second click creates) is inferred from
  `pointerdown`/`pointerup` + `#allowClick` and pointer/blur ordering — not executed.
- **Whether text-layer spans cover leading** (i.e. how tight a pdf.js highlight actually looks)
  is a rendering property I did not measure; the algorithm claims are solid, the visual claim is
  interpretation.
- `source_check` for the stickiness claim returned **no confirming passages** (status
  `missing-evidence`); the claim therefore rests on the direct source reading above, which is the
  stronger evidence class anyway. Disclosed rather than worked around.
- Not examined: `web/comment_manager.js`, `web/alt_text_manager.js`/`new_alt_text_manager.js`,
  `signature_manager.js`, `web/annotation_editor_params.js`, and v6.x changes (e.g. v5.4.54/v6.3.289
  release notes mention further "[Editor]" focus/comment-sidebar work) — relevant only if M1 wants the
  comment/popup or alt-text flows.
- `docs/UX-BRIEF.md` references "the module already computes quads"; I did not read
  `src/components/tools/pdf/editor/**`, so the mapping from these findings to specific BrowserSnip
  files is left to M1.

---

## Sources

**Kept**
- [`src/display/editor/tools.js` v5.4.54](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/src/display/editor/tools.js) — UI manager: mode state machine, keyboard table, `CommandManager` (maxSize 128), `translateSelectedEditors` coalescing, `delete()`/undo bar, `getSelectionBoxes`, `a11yAlert`, `highlightSelection`, `setSelected`→`updateToolbar`.
- [`src/display/editor/annotation_editor_layer.js` v5.4.54](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/src/display/editor/annotation_editor_layer.js) / [v4.0.379](https://raw.githubusercontent.com/mozilla/pdf.js/v4.0.379/src/display/editor/annotation_editor_layer.js) — per-tool layer state, `pointerdown`/`pointerup`, `#allowClick`, STAMP/SIGNATURE guard, v4 `pointerUpAfterSelection` (the highlight-from-selection algorithm).
- [`src/display/editor/editor.js` v5.4.54](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/src/display/editor/editor.js) — resizers, keyboard resize, drag session, `role="application"`, `select()`/`unselect()` focus moves, `MIN_SIZE`.
- [`src/display/editor/freetext.js` v5.4.54](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/src/display/editor/freetext.js) / [v4.0.379](https://raw.githubusercontent.com/mozilla/pdf.js/v4.0.379/src/display/editor/freetext.js) — edit-mode/focus/`aria-activedescendant`, per-editor keyboard table, `role="textbox"`↔`"comment"`, `a11yAlert`.
- [`src/display/editor/highlight.js` v5.4.54](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/src/display/editor/highlight.js) / [v4.0.379](https://raw.githubusercontent.com/mozilla/pdf.js/v4.0.379/src/display/editor/highlight.js) — `quadPoints` per box, outline pass, free-highlight lifecycle, `role="mark"`, `_isDraggable = false`.
- [`src/display/editor/drawers/highlight.js` v5.4.54](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/src/display/editor/drawers/highlight.js) — sweep-line union `HighlightOutliner`.
- [`src/display/editor/draw.js` v5.4.54](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/src/display/editor/draw.js) + [`ink.js`](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/src/display/editor/ink.js) — `isDrawer`, `supportMultipleDrawings`, `DRAW_STEP`, `onceAdded` select+focus.
- [`src/display/editor/toolbar.js` v5.4.54](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/src/display/editor/toolbar.js) — `role="toolbar"`, per-type Remove labels, floating highlight button, focus guards.
- [`web/toolbar.js`](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/web/toolbar.js), [`web/ui_utils.js`](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/web/ui_utils.js), [`web/viewer.html`](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/web/viewer.html) — tool buttons as toggles emitting `NONE`; `aria-expanded` vs `aria-checked`; `role="radiogroup"`, `#viewer-alert role="alert"`, `#editorUndoBar role="status"`.
- [`web/annotation_editor_layer_builder.css` v5.4.54](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/web/annotation_editor_layer_builder.css) — hover/selected/hover-only outlines, `cursor: move` gating, 6px+1px resizers with rotation-correct cursors, per-tool cursors, forced-colours states, which editors get handles/pointer-events.
- [`web/editor_undo_bar.js`](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/web/editor_undo_bar.js), [`web/app.js`](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/web/app.js) — snackbar messages/behaviour; typing guard + undo-bar hide rules in `onKeyDown`.
- [`l10n/en-US/viewer.ftl` v5.4.54](https://raw.githubusercontent.com/mozilla/pdf.js/v5.4.54/l10n/en-US/viewer.ftl) — exact user-facing strings ("Start typing…", "Top left corner — resize", "Highlight added", "… annotations removed").
- Commits/PRs: [`6d2c6cf`](https://github.com/mozilla/pdf.js/commit/6d2c6cfc9f0c34ddee7fb96ae7ce7c3800f2c416) (mode follows selection, with test), [`95f9bed`](https://github.com/mozilla/pdf.js/commit/95f9bedc7c96ef515d84ed28a884a0b6a3decc75), [`4e7c30d`](https://github.com/mozilla/pdf.js/commit/4e7c30da9a09ad3b46eaf1a6c4e93934a741db89), [`e1f6f51`](https://github.com/mozilla/pdf.js/commit/e1f6f5179f1920ad7496e6f4e69220a09cf17146), [#17291](https://github.com/mozilla/pdf.js/pull/17291), [#16659](https://github.com/mozilla/pdf.js/pull/16659) (double-click to edit existing FreeText), [#20307](https://github.com/mozilla/pdf.js/pull/20307) (focus after mode switch), [#20199](https://github.com/mozilla/pdf.js/issues/20199) (Escape ≠ tool off, still open).

**Rejected / deprioritised**
- [Nutrient blog: "How to use the PDF.js AnnotationEditorLayer"](https://www.nutrient.io/blog/pdfjs-annotation-editor-layer/) — accurate on the `switchannotationeditorparams` API but vendor paraphrase; superseded by the files above.
- [Bugzilla 1789998](https://bugzilla.mozilla.org/show_bug.cgi?id=1789998) — 2022-era feature-survey copy, describes a much earlier editor ("Text annotation: add, move, delete, adjust size") and predates highlight/undo-bar work.
- PDF.js Express / Apryse / pdfjs.community threads — different product's tool model; useful only as "someone else had this problem".
- [LibHunt mirror of release notes](https://js.libhunt.com/pdf-js-changelog/5.4.394) — duplicate of the GitHub releases page.

---

## Next steps

1. `grep -n '"pdfjs-dist"' BrowserSnip/package-lock.json` to pin which behaviour set the app actually
   runs (free-highlight fallback and `role="mark"` exist only in later 4.x).
2. M1: read `src/components/tools/pdf/editor/**` and write the tool descriptor table
   `{ id, sticky: boolean, commitOnClick: boolean, handles: n|0, dragWhenSelected: boolean }` — that
   single object is what the brief means by "a deliberate, documented property".
3. M1: verify how BrowserSnip's highlight model serialises today (`QuadPoints` per line vs one rect)
   against Finding 3.3 — if it writes one annotation per line, saved PDFs will diverge from Acrobat
   and Stirling round-trips; that needs its own check before the interaction work lands.
4. Optional follow-up research: Stirling-PDF / EmbedPDF for the *Shape/Arrow* tools, which pdf.js has
   no equivalent of, plus Firefox's native (chrome) annotation toolbar for the undo/redo buttons the
   generic viewer lacks.
