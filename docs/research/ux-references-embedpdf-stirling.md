# Research: EmbedPDF and Stirling-PDF as UX references for BrowserSnip

Read-only research wave (R-task). Intended repo location: `docs/research/ux-references-embedpdf-stirling.md`.
No source or test files modified.

**Version note, important for every claim below.** EmbedPDF has two live API shapes and they differ
on the exact question BrowserSnip cares about. BrowserSnip's admired engine, and the version
Stirling-PDF actually ships, is **@embedpdf v2.15.1**. The behaviour that reads like a designed
one-shot/sticky system is **v3 (`main`, `3.0.0-next.*`)**. Both are reported separately, labelled.

## Summary

EmbedPDF already has the two things BrowserSnip's Bug 1 and Bug 2 are missing, as first-class named
concepts: an `afterCreate` policy (`select` / `tool: 'stay' | 'default'` / `editText`, per-tool
overridable) and a text-selection-driven markup path (`onCommitted` → `createFromSelection` →
`quadPoints`, one quad per line). Stirling-PDF is not really an independent reference: its current
`frontend/` viewer **is** EmbedPDF v2.15.1, so its genuinely transferable material is the layer
EmbedPDF leaves to you — a reducer-based page organizer with a clean keyboard map, and a toast
system with error coalescing and in-toast progress. The one place the project's brief is *ahead of
nothing* is Bug 2's "one mark per line": EmbedPDF's own docs state the opposite, explicitly, and
the PDF convention supports them.

## Findings

### 1. EmbedPDF's tool activation is a single "active tool id" on per-document state

**Claim:** One tool is active per document; `null` means selection/pointer. State lives per document.
**Sources:** [@embedpdf/plugin-annotation v2.15.1 types](https://cdn.jsdelivr.net/npm/@embedpdf/plugin-annotation@2.15.1/dist/lib/types.d.ts) ·
[v3 selecting docs](https://www.embedpdf.com/docs/headless/react/annotations/selecting)
**Support:** direct evidence. v2 `AnnotationDocumentState` carries `activeToolId: string | null`,
`activeToolContext?: Record<string, unknown>`, `selectedUids: string[]`, `hasPendingChanges`,
`locked`. The scope exposes `getActiveTool()`,
`setActiveTool(toolId | null, context?)`, `onActiveToolChange`. `AnnotationState` is
`{ documents: Record<string, AnnotationDocumentState>, activeDocumentId, tools, colorPresets }`. In v3
activation moved to a shared interaction plugin: `interaction.activateTool(id)` and an
`activateDefaultTool()`.
**Confidence:** high

Note the `activeToolContext` bag: it is how a tool carries transient per-activation state (v3 does the
same job with `stamps.arm(stamp)` / `stamps.isArmed()` / `stamps.disarm()` — "arms a stamp's bytes so
the next click places them"). That is the pattern for "Stamp/Image/Signature need an asset before the
next click means anything".

### 2. One-shot vs sticky is an explicit, documented policy object in v3 — and a blunt global flag in v2

**Claim:** v3 has exactly the concept the brief asks for: `afterCreate = { select, tool, editText }`,
configurable globally and per tool, changeable at runtime. v2 has the same three knobs but as
plugin-wide booleans defaulting to *sticky-without-select*.
**Sources:** [v3 Tools & defaults](https://www.embedpdf.com/docs/headless/react/annotations/tools) ·
[`write/after-create.ts`](https://github.com/embedpdf/embed-pdf-viewer/blob/main/packages/plugin/annotation/src/write/after-create.ts) ·
[v2.15.1 types](https://cdn.jsdelivr.net/npm/@embedpdf/plugin-annotation@2.15.1/dist/lib/types.d.ts)
**Support:** direct evidence. v3 docs table: `select` (default `true`), `tool` — `'stay'` keeps the
tool active, `'default'` goes back to the default tool, usually `pointer` (default `'stay'`),
`editText` — "For text boxes: start typing in the new box right away" (default `true`); "**A tool's
own `afterCreate` wins over the one for every tool**"; "The setting can change while the app runs. A
'keep tool' button in your toolbar is one call."

The implementation is small and worth reading whole:

```ts
const policyOf = (toolId: string | undefined): AfterCreateSettings => ({
  ...settings.get().afterCreate,
  ...(toolId ? tools.get(toolId)?.afterCreate : undefined),
});
const done = (toolId, result) => {
  if (!result.effects.some((e) => e.type === 'create')) return;
  if (policyOf(toolId).tool !== 'default') return;
  ctx.tryGet(InteractionToken)?.activateDefaultTool();
};
```

Two details in it matter more than the shape. `done()` returns early unless the result actually
*created* something — the tool step-aside is keyed to a real create, not to the pointer-up handler
that happened to fire first (which is precisely Bug 1's failure mode). And `shape()` refuses to leave
a fresh text box unselected *if* it is being typed into: `if (!policy.select && !typing) session =
{...session, selected: []}` — the box you are typing in is always the selection.

Also from the same file's header comment: "**Code that creates never selects unless it asks**
(`create(…, { select: true })`), so this applies only to what a tool makes." User gesture and program
mutate get different default selection policy. v2's flags: `deactivateToolAfterCreate?: boolean`
("default false"), `selectAfterCreate?: boolean` ("default false"), `editAfterCreate?: boolean`
("default false") — no per-tool granularity.
**Confidence:** high (v3 wording is verbatim from docs; v2 verbatim from `.d.ts` JSDoc)

The brief's "Pen and Highlight stay armed; Shift-click may hold a sticky tool armed" maps onto v3 as
`tool: 'stay'` on those two tools and `tool: 'default'` on the rest, with the Shift variant as a
runtime `updateSettings({ afterCreate: … })`. It is not a handler-ordering accident in EmbedPDF, which
is what the brief wants to kill here.

### 3. Highlight is driven by the *text selection*, not by the drag rectangle — and there is a threshold

**Claim:** Markup tools never convert a rectangle to text. The selection plugin owns geometry; the
annotation plugin consumes it at drag-commit.
**Sources:** [v3 Selecting & copying](https://www.embedpdf.com/docs/headless/react/text/selection) ·
[`write/markup.ts`](https://github.com/embedpdf/embed-pdf-viewer/blob/main/packages/plugin/annotation/src/write/markup.ts) ·
[v3 With-code](https://www.embedpdf.com/docs/headless/react/annotations/with-code)
**Support:** direct evidence. Selection state exposes `isSelecting` ("`true` until you let go") and
events `onChanged` (fires "while dragging too") vs `onCommitted` ("A drag or a tap finished
selecting"), and the docs tell you which to use for what: "Use the change event for things that
follow the selection as it grows, and the **commit** event for things that should happen once, **such
as creating a highlight**." Geometry comes from `selection.listSegments(page)` ("each selected line
as four corners, **turned with the text**") and `selection.listRects(page)` ("a plain box per line").

`applyToolToSelection(toolId)` in `markup.ts` is the whole "release and make a mark" path, and it
bails on every empty case before creating anything:

```ts
const tool = tools.get(toolId);
const markup = tool && selectionMarkupOf(tool);
if (!tool || !markup || !authority.canCreate()) return false;
const selection = ctx.tryGet(SelectionPublicToken);
if (!selection || !selection.hasSelection()) return false;
```

Plus `const last = entry.segments[entry.segments.length - 1]; if (!last) continue;` — a page with no
selected segments produces nothing. That is the brief's "releasing the drag with no words underneath
must create nothing rather than an empty mark", as a two-line guard.

Anti-click-vs-drag is a documented setting on the selection plugin: `dragThresholdPx` — "How far, in
pixels, the pointer moves before a drag selects", **default `4`**. Separately,
`selectWordAt(page, point)` / `selectLineAt(page, point)` "return `false` when there's no text there"
(the double-click / triple-click equivalents) — so "click, no text" is distinguishable from "drag,
text" without geometry guesswork.
**Confidence:** high

### 4. Multi-line: **one annotation per page, many quads** — which contradicts the brief's wording

**Claim:** A highlight spanning three lines is one annotation carrying three quads. A selection
spanning pages makes one annotation *per page*, not per line.
**Sources:** [Highlights & text markup (engine docs)](https://www.cloudpdf.com/docs/engine/annotations/text-markup) ·
[`write/markup.ts`](https://github.com/embedpdf/embed-pdf-viewer/blob/main/packages/plugin/annotation/src/write/markup.ts)
**Support:** direct evidence, verbatim: "**A highlight over three lines is one annotation with three
quads, not three annotations. PDF apps select, move and delete it as one.**" And "A markup sits on one
page. When a selection runs over two pages, create one markup on each page, each from that page's
range." Field table: `quadPoints` — "Where the text is: **one quad per line piece**. Required, at
least one." `markup.ts` matches: `const quads = entry.segments.map((segment) => segment.quad)` inside
a `for (const entry of snapshot.pages)` loop, with the function documented as "one annotation per
page, over the page's selected text".

Quad naming is worth copying exactly, because it is the part that survives rotated and RTL text: "A
quad is four corners, `{ upperLeft, upperRight, lowerLeft, lowerRight }`, **named as the text itself
stands**: `upper` is the top of the letters… On text turned upside down, `upperLeft` is at the bottom
right of the page. Right-to-left text uses the same names." And: "Other PDF apps store a markup's
corners in different orders. The engine sorts them out when it reads the file."
**Confidence:** high

**→ This is a direct conflict with `docs/UX-BRIEF.md` Bug 2**, which asks for "a drag that crosses a
line produces one mark **per line**, each with its own quad, the way a real PDF reader does it". Real
readers do the opposite. See *Contradictions*.

Two adjacent facts from the same page, both cheap to adopt:
- "You **don't pass a `rect`**: the engine works it out from the quads, as the box around all of
  them." (Rect is derived, so a stale rect cannot disagree with the quads.)
- "A markup **stores where the text is, not which characters it covers**. If you need the text later,
  for a list of highlights or an export, read it when you create the mark and keep it in `contents`."
- Default `blendMode` for a highlight is `'multiply'`: "a real marker: the text under it stays dark
  and readable, whatever the color."

### 5. Hitting an existing annotation, and editing it

**Claim:** Hit-testing is geometry in the model, not DOM; and an existing annotation is edited by
finding *which tool owns it* and applying that tool's property set.
**Sources:** [v3 Selecting](https://www.embedpdf.com/docs/headless/react/annotations/selecting) ·
[v3 With-code](https://www.embedpdf.com/docs/headless/react/annotations/with-code) ·
[v2.15.1 types](https://cdn.jsdelivr.net/npm/@embedpdf/plugin-annotation@2.15.1/dist/lib/types.d.ts)
**Support:** direct evidence. v3 `annotation.getAt(page, point)` → "The topmost annotation at a point
on a page, or `null`. **A selected annotation's handles count as the annotation**" (i.e. the chrome is
part of the hit target, so grabbing a handle does not fall through to the page or to a second
annotation). Selection APIs: `select`, `add`, `selectAll(page?)`,
`selectInRect(page, rect)` (marquee), `clear`.

Marquee semantics are stated precisely and are better than most implementations: "everything it
touches is selected. **It has to touch what an annotation paints**: its lines, or the inside of a
filled shape. **A box drawn inside an empty rectangle doesn't select the rectangle.**"

Editing: v2 exposes `findToolForAnnotation(annotation)` — the round-trip from a PDF record back to the
tool that made it, which is what makes "select that mark instead of starting a new one" and its style
panel fall out of one lookup. v3 formalises it as `selection.getProperties()` returning
`{ properties, values, mixed }` where `mixed` "lists the properties where the selected annotations
differ. Show those as 'mixed'", and "When different kinds are selected, you get only the properties
they all have." Mark-type conversion is an explicit first-class move: highlight ↔ underline ↔ squiggly
↔ strikeout via a `subtype` choice property, and "**it stays the same annotation**, with its replies
and its place in the drawing order."
**Confidence:** high

### 6. Interaction affordances worth copying: chrome, snapping, rotation, z-order

**Claim:** All four exist and are configurable as *data*, with sizes in screen pixels.
**Sources:** [v3 Selecting & editing](https://www.embedpdf.com/docs/headless/react/annotations/selecting) ·
[v3 Tools](https://www.embedpdf.com/docs/headless/react/annotations/tools) ·
[v2.15.1 types](https://cdn.jsdelivr.net/npm/@embedpdf/plugin-annotation@2.15.1/dist/lib/types.d.ts)
**Support:** direct evidence, condensed:
- **Chrome is a settings object** (`chrome`): `outline` (style/width/color), `handles`
  (`shape: 'square'|'circle'`, `size`, **`hitSize`**), `rotationHandle` (`enabled`, `size`, `hitSize`,
  `offset`, `stalk`), `guides`, `marquee`, `textOutline`, `readout` (the angle shown while rotating).
  "Every size is in **screen pixels**, so handles stay the same size at every zoom. `hitSize` is the
  area you can grab; **keep it at 24 or more for touch**." Handles can be replaced by your own
  components — and the split is deliberate: "**You only draw: the viewer still decides where a handle
  can be grabbed**, so what you draw can't break dragging."
- **Snapping:** "While moving, the selection snaps to the edges and centers of other annotations and
  of the page, and a turn snaps to 0°, 90°, 180° and 270°. **Hold Shift to move or turn freely.**"
  "The threshold is in screen pixels, so snapping feels the same at every zoom." v2 models it in the
  transform payload: `TransformOptions.metadata.isSnapped` / `snappedAngle` / `rotationCenter`.
- **Rotation** is a field, not a gesture-only feature: `update(ref, { rotation: 90 })`; plus
  `selection.rotateBy(degrees)` (quarter turns) and `selection.resetRotation()`.
- **Z-order:** "Annotations on a page are drawn in order, and the last one is on top." `reorder(refs,
  position)` moves them "next to another annotation of the page or to the back or the front", with one
  stated exception: "Form fields are drawn above every annotation and keep their own order, so
  `reorder()` never places an annotation above a field."
- **Ghost preview:** a see-through copy of what a *click* would place, hidden over an annotation and
  over text for text tools, "on by default for tools you use by clicking… off for tools you mostly
  drag". "The cursor says *which* tool is active; the preview says *where* the annotation will land."
- **Click-to-place has defaults and an anchor.** `square`/`circle` 80×60pt centered, `line` 80pt,
  `free-text` 180×40 top-left, `note` 20×20, `stamp` 150pt wide; `anchor` picks which part lands on
  the click; "**What a click places always stays on the page: near an edge, it's moved inside.**"
- **Groups:** `selection.group()` / `ungroup()`, "saved in the PDF the way Acrobat saves it".
- **Locking is layered, not binary:** `locked` (no move/resize/delete), `lockedContents` (no text
  edit), `hidden` (not selectable at all), and `editable` which "does what `locked` does without
  writing the flag into the PDF". v2 spells out the three separate questions
  (`isAnnotationInteractive` / `isAnnotationStructurallyLocked` / `isAnnotationContentLocked`) and the
  reason: "Locked annotations let clicks **pass through to layers below** (e.g. form-filling)."
- **Touch:** handle grab area is doubled; "One finger on the selected annotation moves it; anywhere
  else, it scrolls the page"; drawing tools take one finger, two fingers scroll/zoom.
- **Rotated pages:** per-tool `upright` flag decides whether a placed stamp/text box is turned to read
  upright on a rotated page.

On the brief's "snapping to text lines": I found **no such feature**. EmbedPDF does not snap marks to
text lines — it takes the line geometry from the text layout and builds quads from it (finding 4).
Interpretation: the affordance the brief is reaching for is *derivation from layout*, not snapping.
**Confidence:** high for each quoted item; the "no text-line snapping" point is absence-of-evidence
within the pages and files I read.

### 7. Undo/redo is its own plugin, on a Command pair, with per-document history and purging

**Claim:** Annotation edits are undoable because every mutation is a `Command` with `execute()`/
`undo()`, in a separate `plugin-history` package; the annotation plugin tags history entries with
metadata so permanent operations can purge them.
**Sources:** [@embedpdf/plugin-history@2.15.0 types](https://cdn.jsdelivr.net/npm/@embedpdf/plugin-history@2.15.0/dist/lib/types.d.ts) ·
[plugin-history CHANGELOG](https://github.com/embedpdf/embed-pdf-viewer/blob/main/packages/plugin-history/CHANGELOG.md) ·
[v2.15.1 annotation types](https://cdn.jsdelivr.net/npm/@embedpdf/plugin-annotation@2.15.1/dist/lib/types.d.ts)
**Support:** direct evidence. `Command { execute(): void; undo(): void; metadata? }`. Changelog:
"Added `purgeByMetadata()` method to remove history entries matching a predicate on command metadata…
**Enables permanent operations (like redaction commits) to clean up related undo/redo history**"; and
"## Multi-Document Support — The history plugin now supports per-document history state." The
annotation plugin's side: `interface AnnotationCommandMetadata { annotationIds: string[] }` —
"Metadata attached to annotation history commands for filtering/purging. Used by the history plugin's
`purgeByMetadata`".

Undo/redo *reporting* is a separate concern from the history stack. v3 emits
`origin` on every change — [`services/announce.ts`](https://github.com/embedpdf/embed-pdf-viewer/blob/main/packages/plugin/annotation/src/services/announce.ts):
"Announces confirmed record changes: the engine's record, **whoever caused the change (an API verb, a
gesture, a remote session)**". That origin tag is what lets a UI say "you undid X" for gestures and
stay quiet for program changes.
**Confidence:** high

**Gap worth naming:** Stirling wraps undo availability as
`useHistoryAvailability(historyApiRef)` → `canUndo`/`canRedo` feeding toolbar buttons (finding 12). I
did not find an *annotation-undo* API in the annotation plugin itself; undo lives only in the history
plugin, so an app that does not register it has no undo at all.

### 8. Why the plugins are split, in their own words

**Claim:** The split is about bundle weight, framework independence, and testability — not tidiness.
**Sources:** [Understanding plugins](https://www.embedpdf.com/docs/react/headless/understanding-plugins) ·
[Headless overview](https://www.embedpdf.com/docs/headless/react) ·
[docs/conventions/plugins.md](https://github.com/embedpdf/embed-pdf-viewer/blob/main/docs/conventions/plugins.md)
**Support:** direct evidence. "This à la carte approach ensures your application remains lean, loading
only the functionality you actually need." Structural rules that are the actual point:
- "**Plugins hold state and logic, never HTML.** The framework packages draw. That's why every plugin
  works the same in React, Vue, Svelte and Angular, and **why you can use a plugin's API in a test
  without a browser.**"
- Coupling is by capability token, not by import: "The capability system enables loose coupling
  between plugins by allowing them to declare what they provide and what they require, without direct
  references to specific plugin implementations." Dependency is stated to the user: the Selection
  plugin "depends on the Interaction Manager plugin. You must install both packages."
- Uniform surface per plugin — four hooks, one job each: `useX()` (API, never re-renders, "its object
  never changes, so it's safe in effects and callbacks"), `useXState(selector)` (re-renders, "to
  re-render only when one value changes, pass a function that picks it"), `useXEvent()`,
  `useXSettings()`. Plus a fixed file anatomy (`contract.ts` = public lens, `model.ts` = "state,
  transitions, projections, folds", `controller.ts`, `host-contract.ts`).
- State is per document by default: "Most plugins keep their state per document: each open document
  has its own search, its own selection, its own zoom. A few belong to the whole viewer, such as
  translations, commands and stamp libraries."
- **The guard rule, verbatim:** "Anything the user may not be allowed to do has a check with the same
  name… **Use them to hide or disable buttons. The engine checks every call again, so they keep your
  UI honest; they're not the guard.**"
- Coordinate rule: "Every position is in points from the top-left corner of the page, with y going
  down. Layers and overlays convert to pixels for you." And the layer contract: "Later layers sit on
  top… while an annotation layer or a form layer is on the page, **the render layer leaves what it
  draws out of the page picture, so nothing is drawn twice**."
**Confidence:** high

### 9. Stirling-PDF is not an independent second opinion — it runs on EmbedPDF v2.15.1

**Claim:** Stirling-PDF's current React frontend depends on 20+ `@embedpdf` packages.
**Source:** [`frontend/package.json`](https://github.com/Stirling-Tools/Stirling-PDF/blob/main/frontend/package.json)
**Support:** direct evidence. Pinned `"@embedpdf/engines": "2.15.1"` and `^2.15.1` on
`core`, `models`, `plugin-annotation`, `plugin-attachment`, `plugin-bookmark`,
`plugin-document-manager`, `plugin-export`, `plugin-history`, `plugin-interaction-manager`,
`plugin-pan`, `plugin-print`, `plugin-redaction`, `plugin-render`, `plugin-rotate`, `plugin-scroll`,
`plugin-search`, `plugin-selection` (^2.14.4), `plugin-spread`, `plugin-thumbnail`, `plugin-tiling`,
`plugin-viewport`, `plugin-zoom`. The viewer component is
`frontend/src/editor/core/components/viewer/EmbedPdfViewer.tsx`.

Also in that manifest, relevant to BrowserSnip's own stack: **`@cantoo/pdf-lib` ^2.8.2** (a maintained
`pdf-lib` fork — the family of things BrowserSnip's "fork traps" are about: async `save`, font
embedding, `dict.lookup` throws), `@atlaskit/pragmatic-drag-and-drop` **and** `@dnd-kit/core` (both
present), `@tanstack/react-virtual`, Mantine 8 + `@storybook/addon-a11y`, `fake-indexeddb`,
Playwright + Vitest browser mode.
**Confidence:** high

Practical consequence: treat EmbedPDF as the *interaction model* reference and Stirling-PDF as the
*app layer that wraps a bare engine* reference — which is the layer EmbedPDF explicitly does not ship.

### 10. Stirling's organize/drag: a reducer per workspace, with undo/redo inside it

**Claim:** The multi-tool was replaced by a "Page Editor" built on per-file page tracks driven by one
reducer, lazily rendered, with undo/redo as reducer actions.
**Sources:** [PR #7618 "Replace multi-tool with redesigned Page Editor"](https://github.com/Stirling-Tools/Stirling-PDF/pull/7618) ·
[`frontend/src/editor/core/components/pageTracks/`](https://github.com/Stirling-Tools/Stirling-PDF/tree/main/frontend/src/editor/core/components/pageTracks)
**Support:** direct evidence. Merged 2026-10-06, +7574/−9033 across 90 files. New
`trackWorkspaceReducer.ts` (773 lines) **with a 642-line `trackWorkspaceReducer.test.ts`**, plus
`PageTracks.tsx` (1119), `TrackRow.tsx` (707), `TrackPageTile.tsx` (292), `SelectByNumberPopover.tsx`,
`BlankPagePreview.tsx`, `DisabledFileTrack.tsx`, and hooks `useTrackWorkspace`, `useTrackSelection`,
`useTrackThumbnails`, `useTrackSave`, `usePageTracksShortcuts`. CodeRabbit's walkthrough: "Adds track
and page contracts, source synchronization, editing operations, **undo and redo**, and save
reconciliation."

Commit messages in that PR are a usable checklist of the small things: "Switch to lazy loaded tracks
to support large PDFs", "Make tracks collapsable and allow zooming", "Automatically set wrap state
based on how many PDFs are open", "Evenly space pages horizontally in wrapped mode", "Scale hover
controls and page numbers with pages", "Truncate filenames", "Only enable track buttons if pages are
selected", "Disable download/close when there's unsaved changes", "Click off to deselect",
"Fix page reordering insertion point", "Fix drag and drop indicator on tracks",
"Make page selection consistent", "Fix WebKit bug".

The predecessor's drag bugs are documented in [PR #2466](https://github.com/Stirling-Tools/Stirling-PDF/pull/2466)
and read as a list of things to get right the first time: "Fix bug causing pages to be **removed**…
when **dropped outside** of scope", "increased size of **end page drop zone** to make dropping at the
end easier", "**Highlight pages that have just been moved**", "Fixed bug causing **flickering** when
hovering over end of row with dragged page", "so **whole row doesn't shuffle** around when dragging
pages, just the currently hovered element", "**Fade out** dragged page instead of removing it from
order".
**Confidence:** high

### 11. Stirling's per-tool options and page-range UI

**Claim:** Tool options are a shared shell plus small controls; page ranges are a real component with
operators and a syntax hint.
**Sources:** [`annotation/shared/`](https://github.com/Stirling-Tools/Stirling-PDF/tree/main/frontend/src/editor/core/components/annotation/shared) ·
[`shared/pageSelection/`](https://github.com/Stirling-Tools/Stirling-PDF/tree/main/frontend/src/editor/core/components/shared/pageSelection) ·
[`tools/shared/ToolStep.tsx`](https://github.com/Stirling-Tools/Stirling-PDF/blob/main/frontend/src/editor/core/components/tools/shared/ToolStep.tsx)
**Support:** direct evidence (file inventory + two files read in full). Annotation tool shell parts:
`BaseAnnotationTool.tsx`, `DrawingControls.tsx` (undo/redo/place), `ColorControl`, `ColorPicker`,
`WidthControl`, `OpacityControl`, `PropertiesPopover`, `TextInputWithFont`, `DrawingCanvas`,
`ImageUploader`, `MultiClickShapeHint` — each with a co-located `.stories.tsx`. Page-range parts:
`SelectPages.tsx`, `PageSelectionInput.tsx`, `AdvancedSelectionPanel.tsx`, `OperatorsSection.tsx`,
`BulkSelectionPanel.tsx`, `SelectedPagesDisplay.tsx`, `PageSelectionSyntaxHint.tsx`. Tool flow shell:
`ToolStep.tsx`, `ToolWorkflowTitle.tsx`, `createToolFlow.module.css`. File queue:
`fileEditor/AddFileCard.tsx` (+ test), `shared/FileSidebar.tsx`, `FileEditorThumbnail.tsx`.
Progress: `tools/autoFormDetection/DetectionProgressPanel.tsx`, `DetectionSummaryPanel.tsx`.
**Confidence:** high for existence; medium for what each does (only two read in full).

### 12. What is genuinely good in Stirling's app layer

**Claim:** Five things are better than EmbedPDF offers out of the box, because EmbedPDF leaves them to
you. **Support** for all: direct evidence from the files/PRs cited.
**Confidence:** high unless noted.

1. **Keyboard map, small and correct.**
   [`usePageTracksShortcuts.ts`](https://github.com/Stirling-Tools/Stirling-PDF/blob/main/frontend/src/editor/core/components/pageTracks/hooks/usePageTracksShortcuts.ts),
   ~60 lines, with a co-located test. Quoted rationale: "Inputs that take no typing, such as a page
   tile's checkbox, **keep the shortcuts**" (`NON_TEXT_INPUTS = checkbox|radio|button|submit`);
   "Typing in a field, **or acting inside a dialog or menu over the editor**, must not edit pages
   behind it" — the guard is `target.isContentEditable || target.closest('[role="dialog"],
   [role="menu"]')`. `if (event.defaultPrevented || isOutsideEditor(event.target)) return;` — a child
   that already handled the key wins. Binds `Ctrl/Cmd+Z`, `Ctrl+Shift+Z`, `Ctrl+Y`, `Ctrl+D`,
   `Delete`/`Backspace`. Listener installed once and reads latest props through a ref, so it is not
   re-bound on every selection change.
2. **Toast system.**
   [`Toast.README.md`](https://github.com/Stirling-Tools/Stirling-PDF/blob/main/frontend/src/editor/core/components/toast/Toast.README.md)
   — imperative `alert()` from anywhere; four types; **duplicate error coalescing with count badges
   ("Server error 4")**; progress *inside* a toast via `alert({ progressBarPercentage: 0 })` then
   `updateToast(id, { progressBarPercentage: 50 })` and a final `updateToast(id, { alertType:
   'success', …, progressBarPercentage: 100 })`; `isPersistentPopup` for errors needing an action
   (6s auto-dismiss otherwise); `role="status"`, `aria-label`s, Escape to dismiss; expandable body so
   a long reason does not eat the screen. Error copy rules: "**Friendly Fallbacks**: Shows 'There was
   an error processing your request' for unhelpful backend responses. **Smart Titles**: 'Server error'
   for 5xx, 'Request error' for 4xx, 'Network error' for others."
3. **Selection-gated actions and unsaved-state honesty.** "Only enable track buttons if pages are
   selected"; "Disable download/close when there's unsaved changes"; `CloseFilesConfirmModal.tsx`;
   `useNavigationGuard()` with `registerUnsavedChangesChecker` and
   `registerNavigationWarningHandlers` ("prompts for save failures and unsaved changes when navigating
   away"); a distinct "Save" icon state when dirty; `DisabledFileTrack.tsx` for a file that cannot be
   edited at all.
4. **Per-file tracks beat one merged grid.** Each open PDF keeps its own row and identity (colour-
   keyed via `fileColors.ts`), so reordering within a document cannot silently interleave documents —
   the classic merge/multi-tool mistake. Plus `SelectByNumberPopover.tsx` (pick pages by number
   instead of hunting thumbnails) and `TrackPageViewModal.tsx` (zoom one page without leaving the
   organizer).
5. **A real keyboard map *on top of the engine*.** [PR #5748](https://github.com/Stirling-Tools/Stirling-PDF/pull/5748)
   added Ctrl+P / Ctrl+S / Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y / Ctrl+0 / Ctrl+R / Ctrl+Shift+R / Home /
   End / PageUp / PageDown / Escape over the EmbedPDF viewer.

### 13. What is weak in Stirling's app layer

**Claim:** Reliability of the save/export path, silent failure, and browser-shortcut fragility. All
direct evidence from the review threads and PR comments on the sources cited.
**Confidence:** high.

1. **Silent save failure**, at three sites in PR #7618's own diff. `useTrackSave.ts:233` — "For any
   error except `PolicyBlockedError`, the hook only calls `console.error`. **From the user's view, the
   'Saving...' overlay disappears and the edits stay pending. Nothing explains what happened.**"
   `useTrackSave.ts:126` — `buildTrackFile` returns `null`, "The save loop then calls `continue` and
   skips that track **without any message**. `save` still returns the `versioned` map… The track stays
   'edited', so each new save attempt fails the same silent way", and `onApplyAndContinue` "treats any
   non-null result as success. Navigation then continues, and the editor **unmounts with the unsaved
   track still in memory**". `WorkbenchBar.tsx:263` — an un-`try`'d `await` where "The rejection
   escapes `handleExportAll`, no file downloads, and the user gets no message." These are exactly the
   brief's E13/E19 failure modes, in a merged PR.
2. **Browser-shortcut collision is unsolved, not hard-solved.** In #5748: reviewer "If I have clicked
   not the pdf before running print I get this [browser print]"; author "it uses the same shortcuts as
   the browser, so **if the site isn't in focus, we can't override the browser shortcut**"; later
   "It **still seems to be happening on roughly 1 in 2 times**"; "I can only reproduce on **Chromium**
   based browsers. In Firefox it does work"; merged anyway as "a *good* first step… **Sub-optimal**".
   A follow-up commit exists specifically to *remove* `Ctrl+Shift+S`.
3. **Missing drag-time position feedback.** [Issue #6170](https://github.com/Stirling-Tools/Stirling-PDF/issues/6170)
   (open, enhancement) asks for "a small dynamic badge… showing the target position" when dragging a
   page — still unimplemented after the full Page Editor rewrite.
4. **No way to move between open documents by keyboard.** [Issue #6252](https://github.com/Stirling-Tools/Stirling-PDF/issues/6252)
   (open): "users must click to change the active document."
5. **The annotation tool shell leaks one tool's copy into every tool.** In
   [`BaseAnnotationTool.tsx`](https://github.com/Stirling-Tools/Stirling-PDF/blob/main/frontend/src/editor/core/components/annotation/shared/BaseAnnotationTool.tsx)
   the instruction block is unconditional and signature-worded regardless of the tool:
   `t("sign.instructions.title", "How to add signature")` /
   `"Click anywhere on the PDF to place your annotation."`, with a hardcoded `color="blue"`. The
   shared shell also holds `const [selectedColor, setSelectedColor] = useState("#000000")` — a literal
   hex in a component, and per-mount state, so the chosen colour does not survive switching tools
   (contrast EmbedPDF: tool `defaults` + `useAnnotationDefaults(id)` + `updateDefaults`, "kept in this
   viewer", persisted by you on `onDefaultsChanged`).
6. **Props injected by `React.cloneElement`** typed as `React.ReactElement<Partial<InjectedAnnotationToolProps>>`
   — the child's contract is unchecked and the optionality hides mistakes.
7. **Two drag libraries** (`@atlaskit/pragmatic-drag-and-drop` and `@dnd-kit/core`) in one manifest —
   interpret as an unresolved migration, i.e. cost, not a pattern to copy.

### 14. EmbedPDF's keyboard/a11y position for canvas-like surfaces

**Claim:** The engine deliberately binds **no** keys; the commands plugin owns keys, shortcuts,
enabled-state and a11y semantics as one registry.
**Sources:** [v3 Selecting](https://www.embedpdf.com/docs/headless/react/annotations/selecting) ·
[Commands & shortcuts](https://www.embedpdf.com/docs/react/headless/plugins/plugin-commands)
**Support:** direct evidence.
- Headless annotation plugin: "**The headless plugin doesn't take over any keys, since your app may
  already use them.** Delete and Escape are a few lines" — and it supplies the escape hatch to do it:
  `selection.delete()`, `cancel()` ("Stops a drag, or a polygon in progress"), `draft.finish()`,
  `draft.cancel()`, `text.begin/end()`. `<AnnotationDraftMenu>` exists because "on touch screens" a
  multi-click shape needs visible Done/Cancel.
- Command registry: "Toolbars, menus, a **command palette** and the keyboard all run the same command,
  **so they always agree**." Fields: `id` (`area:action`), `label`/`labelKey`, `icon`, `shortcut`
  (string or array), `shortcutInTextFields`, `enabled`, `active`, `visible`, `run`, `requires`,
  `locked`, `categories`, `panel|menu|modal`. `enabled`/`active`/`visible` "are asked again whenever
  either changes, and after the command runs, **so a button is always right without events or effects
  of your own**"; a predicate that throws "counts as `false`".
- Keyboard scoping: `useCommandShortcuts()` "**ignores keys typed into text fields**, except a command
  whose `shortcutInTextFields` is `true` (a Find that should work from the search box too), runs
  commands for the active document, and **leaves a key alone when its command can't run right
  now**… With more than one viewer on a page, pass `target`… its keys then work only while focus is
  inside it." `Mod` = Cmd on Mac, Ctrl elsewhere; `shortcut` "is formatted for the user's platform:
  `⌘K` on a Mac, `Ctrl+K` elsewhere". `listShortcuts()` → `{ commandId, shortcut }` "**for a keyboard
  help sheet**".
- A11y precision worth copying verbatim: "`pressable` says whether the command is a toggle. **Give a
  toggle's button `aria-pressed`, true or false, and leave it off the others, so a screen reader
  announces only toggles as toggles. A command that opens a menu is `active` while its menu is open,
  and its button says `aria-expanded` instead.**"
- Disabled-with-a-reason: `getRefusal(id)` → `{ reason, message }` (`'turned-off' | 'not-allowed' |
  'locked'`) "**with a sentence for the user**"; `notAllowed: 'disable'` shows the command greyed with
  `disabledReason` for its tooltip. Unknown id → resolves labelled with its id, invisible/disabled,
  and in development "**it warns once, with the closest id there is**", so a button never crashes on a
  missing command.
- Standard key map, for the convention argument: `tool:pointer` `V`, `tool:pan` `H`, `tool:zoom` `Z`,
  `annotation:delete` `Delete`, `snapshot:clear` `Escape`, `selection:copy` `Mod+C`,
  `document:download` `Mod+S`, `document:print` `Mod+P`, page nav `→` `←` `Home` `End`,
  zoom `Mod+=` `Mod+-`. Every one "is enabled only when it can run".
- Changelog evidence they got this from being bitten:
  [plugin-commands CHANGELOG](https://github.com/embedpdf/embed-pdf-viewer/blob/main/packages/plugin-commands/CHANGELOG.md) —
  "Allow `Tab` and `Shift+Tab` keyboard handling **to continue working inside form inputs so field
  navigation is not blocked**."
- Anchored UI: overlays "hide while the user drags", "never cover the rotation handle", and "stay
  attached while the user scrolls and zooms".
**Confidence:** high

## What BrowserSnip should copy, and why

Ordered by (user-visible payoff) ÷ (cost), assuming the registry path (`lib/pdf/tools/**`) wins as S3
plans.

1. **A per-tool `afterCreate` policy: `{ select, tool: 'stay' | 'default', editText }`.** This *is*
   Bug 1, already named, with per-tool override and runtime changeability. Copy the three fields and
   the two guards from `after-create.ts`: step aside only when a `create` effect actually happened,
   and never deselect a box you are currently typing in. Cost: a small pure function plus a `TOOLS`
   table field — one day, and it is testable in jsdom as a state machine with no canvas. Then the
   brief's "deliberate, documented property of each tool" is literally a table column.
2. **`onChanged` vs `onCommitted` for markup, and `dragThresholdPx` (4px).** Highlight/underline/
   strikeout should create on *commit*, and a pointer move under the threshold is a click, not a
   drag. That pair gives "release with no words underneath creates nothing" for free. Cost: an hour,
   if the drag already produces a candidate range; add the `if (!segments.length) return` bail.
3. **One annotation per page with `quadPoints` = one quad per line — instead of the brief's "one mark
   per line".** Copy the model, not the wording: derived bounding rect ("you don't pass a `rect`"),
   quads named as the text stands so rotated/CJK/RTL text survives, and `blendMode: multiply` so
   highlighted text stays readable. Cost: **this is the expensive one** — every existing code path
   that assumes a highlight has one rect must handle N, and pdf-lib has no `quadPoints` helper, so
   write it once in `lib/pdf/` and test it as pure geometry. Pay it: it is the difference between
   BrowserSnip's output opening correctly in Acrobat/Preview and not.
4. **A single command registry (id, label, icon, shortcut, enabled/active/visible, run) feeding
   toolbar + ⌘K palette + keyboard.** BrowserSnip is already making ⌘K the primary navigation (S1);
   without one registry the palette, the toolbar and the shortcut list will disagree — that is the
   same class of bug as the two dispatch paths the brief calls "the structural finding". Steal the
   three details that prevent future bugs: `aria-pressed` only on `pressable` commands (and
   `aria-expanded` for menu openers), `Mod` formatting for display, and `listShortcuts()` as the
   source of the in-app help sheet (the brief requires "the shortcut list is reachable from inside the
   surface"). Cost: ~1–2 days, mostly porting existing handlers into `run`.
5. **Stirling's keyboard guard, verbatim.** `event.defaultPrevented` first; text-field check that
   *exempts* `checkbox|radio|button|submit`; and `closest('[role="dialog"], [role="menu"]')` so keys
   do not edit the document behind an open popover. Plus the ref trick to bind the listener once.
   ~60 lines with a test; the brief's keyboard section is otherwise going to be written piecemeal per
   module. This also fixes Esc/arrow-nudge/Delete consistency across M1–M4.
6. **`update(ref, { subtype })` as a *kind change on the same object*.** "A highlight can become an
   underline… It stays the same annotation, with its replies and its place in the drawing order."
   BrowserSnip's highlight/underline/strikeout are described as "the same code path" — so make them
   literally the same record with a different render + `/Subtype`, instead of delete-and-recreate
   (which loses selection and undo continuity). Cost: low, once item 3 lands.
7. **Chrome as data, with `hitSize` in screen pixels and a separate draw/hit split.** Sizes that scale
   with zoom are a real annoyance; EmbedPDF's rule is `hitSize ≥ 24` for touch and "you only draw, the
   viewer decides where a handle can be grabbed". Pair it with Stirling's doubled touch grab area and
   the brief's "≥8 px with a hit slop" and you have one defensible number set for M1. Cost: low
   (constant table + pass-through).
8. **Snapping: edges/centres of other annotations and of the page; rotation snap 0/90/180/270;
   Shift = free; threshold in screen px.** Cheap to express as pure geometry against the model, so it
   is exactly the kind of thing the brief's "assert on model, geometry, state-machine, never pixels"
   rule can lock down. Rotation snap especially: ~20 lines and it makes a rotated stamp or text box
   look intentional.
9. **Z-order as an operation, not an array edit.** `reorder(refs, position)` with "next to / to front /
   to back" plus the stated exception that form fields always sit above. BrowserSnip's shapes-vs-text
   layering has no user-facing fix today. Cost: medium (needs a stable ordering concept in the model).
10. **Stirling's toast shape for M5/S2/S3: `alert({ alertType, title, body, progressBarPercentage,
    isPersistentPopup, buttonText, buttonCallback })` + `updateToast(id, …)`.** Specifically steal
    **duplicate-error coalescing with a count badge** (a 500-page job that fails per page produces one
    toast, not fifty), **progress inside the toast** (matches the brief's per-file/per-stage
    requirement without inventing a second progress surface), and **"friendly fallback + smart title"
    error-copy rules** (matches "Errors name the file, the value, and the fix. No internal class
    names, no stack traces"). Cost: low if `process-store` already keys notifications by id.
11. **`hasPendingChanges` / `CommitState` / `CommitBatch` as the save model.** v2 tracks each record as
    `'new' | 'dirty' | 'moved' | 'deleted' | 'synced' | 'ignored'` and batches creations/updates/
    deletions, with `updates[].moved` meaning "only positional data changed — **skip appearance
    regeneration**". That single flag is a real perf win for a drag, and the state machine makes the
    brief's "nothing says Done when it did nothing" checkable rather than a vibe. Cost: medium, but it
    is also what makes item 12's honesty automatic.
12. **Stirling's unsaved/dirty discipline**: gate Download/Close on dirty state, confirm before
    unmount, and warn on navigation away — but implement the failure path they skipped: every silent
    `continue`/`console.error` in `useTrackSave` becomes a warning in `result.warnings` or an error
    toast (finding 13.1). Cost: low; it is the brief's own rule, applied.
13. **Stirling's Page Editor shape for M3, and its page-range component for M6.** Per-file tracks (not
    one merged grid), lazy rendering for large documents, collapse + zoom + wrap, hover controls that
    scale with the tile, `SelectByNumberPopover` ("never ask the user to… count pages"), and
    `SelectPages` + `PageSelectionSyntaxHint` + `OperatorsSection` as the shared range input every
    registry tool should use instead of a bare text field. Copy `trackWorkspaceReducer.ts` as the
    pattern: **a pure reducer + a 642-line test file** is precisely how you satisfy "jsdom has no
    canvas" while still covering drag/reorder/split/undo.
14. **`MultiClickShapeHint.tsx` as the template for in-progress affordances on a canvas-like surface**
    (4 KB, read it whole). Anchor by fraction of the page layer "so it stays on the point across zoom";
    `pointer-events: none` plus fading itself to `opacity 0.15` when the cursor is over it, so it can
    never swallow a click; `data-no-interaction` so the input manager does not treat the overlay as
    page geometry; capture-phase read of the click; self-dismiss on the `create` event; colours from
    CSS variables; translated with an inline fallback. And its copy — "**Double-click or press Enter to
    finish**" — is the whole "every pointer action has a key equivalent" requirement in six words.
15. **`editable` / locked layering, without writing flags into the PDF.** "The `editable` setting does
    what `locked` does **without writing the flag into the PDF**", and locked annotations "let clicks
    pass through to layers below". For BrowserSnip that is the correct answer to "scanned page with no
    text layer", "encrypted input", and read-only annotation types in the brief's edge-case matrix.
    Cost: a predicate.

## What not to copy

1. **EmbedPDF's plugin/capability architecture itself.** Token registries, `contract.ts` /
   `host-contract.ts` lenses, per-plugin four-hook sets, per-document state maps and a
   framework-split build exist to serve a multi-framework distributable with 25+ packages and
   collaborative documents. BrowserSnip is one app with one framework. Cost of imitating it: every
   M-task acquires a token, a scope, a `getX()` and three hooks before it can move a rectangle —
   realistically a week of indirection and a permanent "where is this state?" tax, for zero user
   benefit. Copy the *rules* that are cheap and universal (logic out of components so it is testable
   without a browser; UI checks are advisory, the model re-checks; page-point coordinates in the
   model, pixels only at draw time). Do not copy the *mechanism*.
2. **Stirling's `BaseAnnotationTool` pattern.** Its shared shell owns `selectedColor` in local
   component state with a hardcoded `#000000` (a hex literal in a component — the brief bans exactly
   this), renders an unconditional Alert whose copy is signature-specific for every tool, hardcodes
   `color="blue"`, and injects props by `cloneElement` with `Partial<>` types so nothing checks the
   contract. Cost of copying: another place where tool state resets on unmount and another hex that
   dark mode will not fix. Put defaults on the tool definition (EmbedPDF's `defaults` +
   `updateDefaults` + `onDefaultsChanged`) and pass props explicitly.
3. **`deactivateToolAfterCreate` as a global boolean** (v2's shape). One flag for every tool gives you
   Bug 1 back the instant someone sets it to `true` for the text box and loses Pen. Adopt the v3
   per-tool policy object instead; v2's flag is what the brief is already stuck on.
4. **Browser-level `Ctrl+P` / `Ctrl+R` / `Ctrl+S` overrides.** Stirling's own thread: "if the site
   isn't in focus, we can't override the browser shortcut", "roughly 1 in 2 times", "only reproduce on
   Chromium", merged as "sub-optimal". For a 100 %-client-side tool, `Ctrl+S` interception is a
   promise you cannot keep. Cost: partial fixes that read as flakiness and cost more trust than the
   shortcut earns. Keep document-scoped keys (`target` + focus, as EmbedPDF's `useCommandShortcuts`
   supports), prefer non-conflicting chords, and never let a *feature* depend on one. Note the
   opposite lesson from finding 14: EmbedPDF still *swallows* the key of a disabled command so the
   browser cannot steal it — that part is worth having, and needs a visible reason.
5. **Stirling's silent best-effort save/export loop.** Three separate merged review comments describe
   failures that logged to the console and left the user with "no message" or a navigation that
   unmounted unsaved edits. Cost: the trust the whole brief is trying to buy, spent on a `continue`.
6. **EmbedPDF's own default of staying sticky (`tool: 'stay'`).** Their docs defend it ("so people can
   draw another"), but the brief has user evidence that for a *text box* it is wrong. Make it
   per-tool, ship the values the brief names, and keep their "keep the tool" toggle as an opt-in —
   do not inherit the default silently.
7. **Two drag libraries.** Pragmatic-drag-and-drop and dnd-kit are both in one manifest, and Stirling
   shipped a `DragDropGrid` (1037 lines) then deleted it in the same rewrite. Pick one in M3 and move
   on; carrying both is only affordable with a team the size of Stirling's.
8. **`@embedpdf/plugin-history` as a dependency.** Undo/redo being a separate plugin means an app can
   have no undo at all if it forgets to register it. BrowserSnip should own a small, tested undo stack
   in the model — it already has to be pure to be jsdom-testable, and annotation history is the thing
   the brief wants announced to assistive tech, which you cannot delegate.

## Contradictions

- **One mark per line vs one mark with N quads.** `docs/UX-BRIEF.md` Bug 2: "a drag that crosses a line
  produces one mark **per line**, each with its own quad, **the way a real PDF reader does it**".
  EmbedPDF's engine docs, same subject: "A highlight over three lines is **one annotation with three
  quads, not three annotations**. PDF apps select, move and delete it as one", corroborated in
  `write/markup.ts` (`quads = entry.segments.map(s => s.quad)`, one `createMarkup` commit per page).
  The reference implementation and the brief's stated rationale therefore disagree; the brief's "one
  mark per line" is the only part I would not follow. Not resolved here — M1 owns the call.
- **Sticky-by-default vs step-aside.** v2's `deactivateToolAfterCreate` defaults `false`; v3 documents
  `tool: 'stay'` as the default; the brief's user wants `'default'` for text box / stamp / image /
  signature / shape / arrow. Not a factual conflict — a product choice — but note the admired
  reference disagrees with the requested behaviour for most tools.
- **Does a disabled command swallow its key?** EmbedPDF: yes — "A command that's turned off or not
  allowed **still takes its key**, so the browser doesn't do something else with it". Stirling's
  `usePageTracksShortcuts`: no — "Without a selection there is nothing to duplicate, so **the browser
  keeps its own Ctrl+D**", with the same reasoning applied to Delete. Both defensible; EmbedPDF's is
  better for `Mod+P`/`Mod+S`, Stirling's is better for `Delete`/`Ctrl+D`. Flagged, not resolved.
- **Which is the "real" EmbedPDF?** Stirling ships v2.15.1 while `main` and the docs site describe v3
  with a different activation API (`setActiveTool` → `interaction.activateTool`) and a different
  sticky model (booleans → `afterCreate`). Everything above is labelled by version.
- **`source_check` returned `missing-evidence`** (confidence 0.20) for the quad-model claim despite
  surfacing the correct authoritative page. I resolved it by fetching
  `cloudpdf.com/docs/engine/annotations/text-markup` directly and quoting it. Disclosed as a
  validation-tool limitation, not a weak claim.

## Missing evidence

- **BentoPDF's actual EmbedPDF version** was not verified; the task asserted the dependency. I
  confirmed the dependency exists for **Stirling-PDF**, not for BentoPDF.
- **Stirling's legacy server-rendered pipeline UI** (`src/main/resources/static/js/…`, the Thymeleaf
  multi-tool / drag-and-drop file list) was **not** audited. Findings 10–13 are the newer React
  `frontend/src/editor`. If "the UI users actually see today" means the legacy one, findings 12–13
  describe where it is going, not what is deployed.
- **v3 keyboard/a11y surface**: I found "the headless plugin doesn't take over any keys",
  `useCommandShortcuts()` and `listShortcuts()`, but did **not** find a roving-tabindex / focus-order
  contract for annotations, nor an accessible name for an annotation on the page. Whether EmbedPDF
  exposes annotations to assistive tech at all is unresolved. The brief's "undo/redo reported to
  assistive tech" therefore has no reference implementation I can point to.
- **Docs code blocks were stripped** by the readable extractor, so EmbedPDF docs gave me prose only;
  every API signature above came from a raw `.ts` / `.d.ts`, not from a docs example. I did not run
  either project, so all "good/weak" judgements come from source, tests and review threads rather than
  hands-on use.
- **EmbedPDF undo/redo scope surface** (`canUndo`, `canRedo`, `undo()`, label/announcement payloads) is
  inferred from the changelog, `plugin-history`'s `Command` type and Stirling's
  `useHistoryAvailability`; I did not read the plugin's scope file.
- Whether **pdf.js's own text layer** can supply per-line quads as cleanly as EmbedPDF's layout does is
  a question for M1/M2, outside this task — but it gates item 3 of "should copy".
- `frontend/portal/UI_CONVENTIONS.md` ("Simple, presentational, brand-defining UI → our SUI design
  system; Complex, stateful, or accessibility-hard widgets → Mantine") appeared only in a search
  summary and was **not** opened; treat as medium confidence.
- I did not read `tools/definitions.ts` (30 KB) or `tools/handlers.ts` (22 KB) in full — cited as the
  next place M1 should look for per-tool defaults and handler ordering.

## Sources

**Kept — EmbedPDF primary**
- [`packages/plugin/annotation/src/write/after-create.ts`](https://github.com/embedpdf/embed-pdf-viewer/blob/main/packages/plugin/annotation/src/write/after-create.ts)
  — the one-shot/sticky policy in code; the single most transferable file here.
- [`packages/plugin/annotation/src/write/markup.ts`](https://github.com/embedpdf/embed-pdf-viewer/blob/main/packages/plugin/annotation/src/write/markup.ts)
  — selection→quads conversion, one commit per page, empty-selection bails, `applyToolToSelection`.
- [`packages/plugin/annotation/src/tools/behaviors.ts`](https://github.com/embedpdf/embed-pdf-viewer/blob/main/packages/plugin/annotation/src/tools/behaviors.ts)
  — why engaged form widgets are hit-test/marquee/selection-inert.
- [`packages/plugin/annotation/src/services/announce.ts`](https://github.com/embedpdf/embed-pdf-viewer/blob/main/packages/plugin/annotation/src/services/announce.ts)
  — change `origin`: API verb / gesture / remote session.
- [`@embedpdf/plugin-annotation@2.15.1` `types.d.ts`](https://cdn.jsdelivr.net/npm/@embedpdf/plugin-annotation@2.15.1/dist/lib/types.d.ts)
  — the v2 truth: state shape, `setActiveTool`, `afterCreate` booleans, `TransformOptions` snap
  metadata, unified drag/resize constraints, lock predicates, `CommitBatch`/`CommitState`.
- [v3 Tools & defaults](https://www.embedpdf.com/docs/headless/react/annotations/tools) ·
  [Selecting & editing](https://www.embedpdf.com/docs/headless/react/annotations/selecting) ·
  [With-code](https://www.embedpdf.com/docs/headless/react/annotations/with-code) ·
  [Selecting & copying](https://www.embedpdf.com/docs/headless/react/text/selection) ·
  [Annotations overview](https://www.embedpdf.com/docs/headless/react/annotations) — official docs for
  the v3 model.
- [Highlights & text markup (engine docs)](https://www.cloudpdf.com/docs/engine/annotations/text-markup)
  — "one annotation with three quads"; quad naming; derived rect; `multiply` blend; caret/`/IRT`.
- [Commands & shortcuts](https://www.embedpdf.com/docs/react/headless/plugins/plugin-commands)
  — command registry, shortcut scoping, `aria-pressed` vs `aria-expanded`, refusal sentences.
- [Understanding plugins](https://www.embedpdf.com/docs/react/headless/understanding-plugins) ·
  [Headless overview](https://www.embedpdf.com/docs/headless/react) — why the split; "logic never
  HTML"; "checks are not the guard".
- [docs/conventions/plugins.md](https://github.com/embedpdf/embed-pdf-viewer/blob/main/docs/conventions/plugins.md)
  — fixed plugin anatomy (`model.ts` = state/transitions/projections/folds).
- [plugin-history CHANGELOG](https://github.com/embedpdf/embed-pdf-viewer/blob/main/packages/plugin-history/CHANGELOG.md)
  + [`@2.15.0` `types.d.ts`](https://cdn.jsdelivr.net/npm/@embedpdf/plugin-history@2.15.0/dist/lib/types.d.ts)
  — `Command{execute,undo,metadata}`, `purgeByMetadata`, per-document history.
- [plugin-commands CHANGELOG](https://github.com/embedpdf/embed-pdf-viewer/blob/main/packages/plugin-commands/CHANGELOG.md)
  — Tab/Shift+Tab must keep working inside form inputs.
- [Create Page Annotation](https://www.embedpdf.com/docs/engines/annotations/create-page-annotation) —
  confirms a highlight object "needs `segmentRects` and a `color`" (naming differs from the v3 docs'
  `quadPoints`; both are multi-quad).

**Kept — Stirling-PDF primary**
- [`frontend/package.json`](https://github.com/Stirling-Tools/Stirling-PDF/blob/main/frontend/package.json)
  — proof it runs on EmbedPDF 2.15.1; also `@cantoo/pdf-lib`, two DnD libs, a11y/test tooling.
- [PR #7618 Page Editor](https://github.com/Stirling-Tools/Stirling-PDF/pull/7618) — track reducer,
  lazy tracks, wrap/zoom/collapse, unsaved guards, and three silent-failure review threads.
- [`usePageTracksShortcuts.ts`](https://github.com/Stirling-Tools/Stirling-PDF/blob/main/frontend/src/editor/core/components/pageTracks/hooks/usePageTracksShortcuts.ts)
  (+ [its test](https://github.com/Stirling-Tools/Stirling-PDF/blob/main/frontend/src/editor/core/components/pageTracks/hooks/usePageTracksShortcuts.test.ts))
  — the keyboard guard to copy.
- [`Toast.README.md`](https://github.com/Stirling-Tools/Stirling-PDF/blob/main/frontend/src/editor/core/components/toast/Toast.README.md)
  — coalescing, in-toast progress, error-copy rules, `role="status"`.
- [`BaseAnnotationTool.tsx`](https://github.com/Stirling-Tools/Stirling-PDF/blob/main/frontend/src/editor/core/components/annotation/shared/BaseAnnotationTool.tsx)
  — the per-tool options shell, and its leaks.
- [`MultiClickShapeHint.tsx`](https://github.com/Stirling-Tools/Stirling-PDF/blob/main/frontend/src/editor/core/components/annotation/shared/MultiClickShapeHint.tsx)
  — the in-progress canvas overlay pattern, complete, in 4 KB.
- [PR #2466 drag-and-drop fixes](https://github.com/Stirling-Tools/Stirling-PDF/pull/2466) ·
  [PR #5748 viewer shortcuts](https://github.com/Stirling-Tools/Stirling-PDF/pull/5748) ·
  [issue #6170 drag position badge](https://github.com/Stirling-Tools/Stirling-PDF/issues/6170) ·
  [issue #6252 switch documents by keyboard](https://github.com/Stirling-Tools/Stirling-PDF/issues/6252)
  — the honest weak list.
- [`pageTracks/`](https://github.com/Stirling-Tools/Stirling-PDF/tree/main/frontend/src/editor/core/components/pageTracks)
  · [`annotation/shared/`](https://github.com/Stirling-Tools/Stirling-PDF/tree/main/frontend/src/editor/core/components/annotation/shared)
  · [`shared/pageSelection/`](https://github.com/Stirling-Tools/Stirling-PDF/tree/main/frontend/src/editor/core/components/shared/pageSelection)
  · [`ThumbnailSidebar.tsx`](https://github.com/Stirling-Tools/Stirling-PDF/blob/6c85200e/frontend/editor/src/core/components/viewer/ThumbnailSidebar.tsx)
  (blob-URL revocation on file switch).

**Rejected / deprioritized**
- DeepWiki (`2.1-plugin-system`, `4.6-annotation-plugin`, `4-plugin-ecosystem`) — auto-generated from
  source, second-hand where the official docs and the shipped `.d.ts` are primary; used only as a lead.
- `@embedpdf/plugin-annotation@2.12.1` types — superseded by 2.15.1, the version actually pinned.
- Adobe/Medium/iText/PyMuPDF hits from `source_check` — off-topic for an EmbedPDF-behaviour question.
- Stirling `frontend/src/processor/**` and `cloud/**` (SaaS billing, onboarding, wallets) — no bearing
  on tool UX.
- pdf.js's own viewer — belongs to the sibling R-task.

## Next steps

1. **M1/M2 own the Bug-2 model decision** (finding 4): one record with `quadPoints[]` vs N records.
   Write it as a ~30-line geometry spike before touching the editor — the cost lives in every
   downstream single-rect assumption, not in the writer.
2. **Enumerate BrowserSnip's tools into the `afterCreate` table** (finding 2) and get it signed off in
   one commit: every tool × `select`/`tool`/`editText`, plus the Shift-hold override. That turns the
   brief's "deliberate, documented property" into a reviewable artifact.
3. **Open `packages/plugin/annotation/src/tools/definitions.ts` (30 KB) and `tools/handlers.ts`
   (22 KB)** on `main` for per-tool defaults, `clickCreate` sizes and pointer/marquee/hit-test
   ordering — I read the policy and markup layers but not the handler layer, and M1 will want `getAt`
   and `selectInRect` semantics exactly.
4. **Audit Stirling's legacy `static/js` multi-tool** if the brief means "what users see today" —
   explicitly out of scope here (see *Missing evidence*).
5. **Check pdf.js `TextLayer` for per-line quad availability** before promising line-accurate
   highlights; if it yields line boxes but not quads, decide whether to synthesise or switch engines.
6. **Settle the key-swallowing policy** (Contradictions, bullet 3) once, in the command-registry spec,
   with the exception list written down.

---

### Acceptance report

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Concise result: 14 numbered sourced findings covering all 5 asked questions, a ranked 'copy' list and a costed 'do not copy' list. Residual risks section present (residualRisks below + 'Missing evidence' and 'Contradictions' in-document). Written to the authoritative output path; repo source/tests untouched."
    }
  ],
  "changedFiles": [
    "/home/nekophobia/.pi/agent/sessions/--home-nekophobia-Projects-BrowserSnipRepo--/subagent-artifacts/outputs/5e2c4085-d3c1-43d9-8976-84e1020195ba/task-5.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "read docs/UX-BRIEF.md",
      "result": "passed",
      "summary": "Brief read fully before researching; its Bug 1/Bug 2 wording used as the comparison target."
    },
    {
      "command": "web_search (multi-query: EmbedPDF annotation tool state model; highlight/selection quads; capabilities plugin split; Stirling-PDF organize UI; keyboard/accessibility)",
      "result": "passed",
      "summary": "Exa rate-limited on one batch (429); recovered with narrower follow-up queries."
    },
    {
      "command": "fetch_content on embedpdf.com v3 docs (annotations/tools, selecting, with-code, text/selection, overview), cloudpdf engine text-markup, commands, understanding-plugins",
      "result": "passed",
      "summary": "Primary official docs captured. Caveat: readable extraction drops code blocks, so prose only."
    },
    {
      "command": "fetch_content raw on GitHub api trees + source: annotation write/after-create.ts, write/markup.ts, tools/behaviors.ts, services/announce.ts, plugin-annotation@2.15.1 types.d.ts, plugin-history@2.15.0 types.d.ts",
      "result": "passed",
      "summary": "Verified the one-shot/sticky policy, selection->quads path, empty-selection bails, and v2-vs-v3 API differences in actual source."
    },
    {
      "command": "fetch_content on Stirling-PDF frontend/package.json, PR #7618, PR #5748, PR #2466, issues #6170/#6252, usePageTracksShortcuts.ts, Toast.README.md, BaseAnnotationTool.tsx, MultiClickShapeHint.tsx, pageTracks/annotation/pageSelection/toast trees",
      "result": "passed",
      "summary": "Confirmed Stirling ships on @embedpdf 2.15.1; captured organize/drag, per-tool options, progress and error-copy specifics plus three silent-failure review threads."
    },
    {
      "command": "source_check on the one-annotation-N-quads claim",
      "result": "failed",
      "summary": "Returned missing-evidence (confidence 0.20); resolved by fetching cloudpdf.com/docs/engine/annotations/text-markup directly and quoting it."
    }
  ],
  "validationOutput": [
    "verbatim, cloudpdf.com/docs/engine/annotations/text-markup: \"A highlight over three lines is one annotation with three quads, not three annotations. PDF apps select, move and delete it as one.\"",
    "verbatim, after-create.ts: `policyOf = { ...settings.get().afterCreate, ...(toolId ? tools.get(toolId)?.afterCreate : undefined) }`; `if (policyOf(toolId).tool !== 'default') return; ctx.tryGet(InteractionToken)?.activateDefaultTool();`",
    "verbatim, markup.ts: `if (!selection || !selection.hasSelection()) return false;` and `const quads = entry.segments.map((segment) => segment.quad);`",
    "verbatim, v3 docs: \"A tool's own `afterCreate` wins over the one for every tool\"; \"`tool` ... `'stay'` keeps the tool active. `'default'` goes back to the default tool, usually `pointer`.\"",
    "verbatim, v2.15.1 types: `deactivateToolAfterCreate?: boolean` - \"When true (default false), deactivate the active tool after creating an annotation.\"",
    "verbatim, Stirling frontend/package.json: 23 @embedpdf deps pinned at 2.15.1 incl. plugin-annotation, plugin-history, plugin-selection, plugin-interaction-manager",
    "verbatim, BaseAnnotationTool.tsx: `const [selectedColor, setSelectedColor] = useState(\"#000000\");`",
    "paths confirmed on default branch main (default_branch verified via api.github.com): embedpdf embed-pdf-viewer packages/plugin/annotation/src/**; Stirling frontend/src/editor/core/components/{pageTracks,annotation/shared,shared/pageSelection,toast}/**"
  ],
  "residualRisks": [
    "Version split: the one-shot/sticky design BrowserSnip wants exists cleanly only in v3 (main/next, unreleased); v2.15.1 - what Stirling ships - has global booleans. Any 'copy afterCreate' work is copying an unreleased API shape.",
    "The brief's Bug 2 wording (one mark per line) conflicts with the documented PDF/EmbedPDF model (one mark, N quads). If M1 implements the brief literally, output may diverge from Acrobat/Preview semantics.",
    "Stirling's legacy Thymeleaf/static-js multi-tool was NOT audited. If 'the UI users actually see today' means the legacy surface, findings 10-13 describe the successor, not production.",
    "No hands-on use of either product; good/weak judgements rest on source, tests, PR review threads and open issues, not on interaction testing.",
    "No accessible-name/focus-order contract for annotations was found in EmbedPDF, so the brief's 'undo/redo reported to assistive tech' still has no reference implementation.",
    "EmbedPDF docs pages yielded prose only (code blocks stripped by extraction); all API signatures came from raw .ts/.d.ts instead.",
    "source_check returned missing-evidence on a claim that primary sources support; treat its low-confidence verdicts in this run as a provider limitation, not dissent.",
    "BentoPDF's EmbedPDF version is unverified - the task asserted it and I confirmed the equivalent dependency only for Stirling-PDF."
  ],
  "noStagedFiles": true,
  "diffSummary": "One new research artifact written to the assigned outputs path (task-5.md). No repo files created, edited or deleted; docs/research/ left untouched.",
  "reviewFindings": [
    "blocker-adjacent: docs/UX-BRIEF.md Bug 2 'one mark per line' contradicts EmbedPDF's documented quadPoints model (one annotation, one quad per line). Needs an explicit M1 decision, not silent resolution.",
    "cost note: adopting one-record-with-N-quads requires a pdf-lib quadPoints writer plus rework of every single-rect assumption in the editor; it is the largest item on the 'should copy' list.",
    "copy hazard: do not inherit EmbedPDF's sticky default ('tool: stay') verbatim - it disagrees with the user-reported Bug 1 for text box/stamp/image/signature/shape/arrow.",
    "reliability lesson from Stirling PR #7618 review threads: silent console.error on save failure, un-caught getExportFiles rejection, and skipping an unbuildable track while still reporting success.",
    "cheap a11y win available now: aria-pressed only on real toggles, aria-expanded for menu openers (EmbedPDF commands docs).",
    "no blockers in BrowserSnip source - none was modified by this task."
  ],
  "manualNotes": "The task named two output destinations: 'docs/research/ux-references-embedpdf-stirling.md' (ONE file only) and the authoritative session outputs path. Per the Output instruction that the configured path wins and other output destinations should be ignored, I wrote exactly one file - task-5.md - and did not touch the repo. If the docs/research/ location is still wanted, the parent can move the artifact in one step; it is written to be valid at either path (references to docs/UX-BRIEF.md are explicit). Biggest cross-cutting discovery: Stirling-PDF's V2 frontend is itself built on @embedpdf 2.15.1, so these are not two independent references - EmbedPDF is the interaction model, Stirling is a worked example of the app layer EmbedPDF deliberately leaves to you (keyboard map, toasts, page tracks, unsaved guards)."
}
```
