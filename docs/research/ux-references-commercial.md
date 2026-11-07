# Research: commercial PDF tools in the browser — interaction conventions users already know

Intended repo home: `docs/research/ux-references-commercial.md` (wave-1 research file R-series, per `docs/UX-BRIEF.md`).
Read-only research; no source or test files were touched.

## Summary

Across Acrobat, Sejda, iLovePDF, BentoPDF, ihatepdf.cv and the canvas editors (Figma/Canva), the
converged convention is: **Select/Move is the resting state, a placement tool disarms itself after
one use, stickiness is an explicit user-visible choice, marks snap to real text geometry (one
quadrilateral per line inside a single annotation), and every long operation reports per-file stage
progress plus a numeric result.** BrowserSnip's two named bugs are deviations from documented,
widely-praised behaviour, not matters of taste. Two claims could not be fully verified (see
"Unverified"): the exact wording on Adobe's own help page (403 to our fetcher), and live canvas
behaviour of the web editors (JS apps; only their HTML/marketing/UI strings are fetchable).

## Method and evidence quality

Each tool was checked against its own docs/help plus user-community reports. Web PDF editors are
client-side apps, so a headless fetch yields the page's embedded UI strings (real, in-product copy)
but not live pointer behaviour — behaviour claims for those tools are labelled *interpretation*.
Standards (ISO 32000-1, WCAG) and Figma/Canva help text are primary.

---

## 1. Tool stickiness after placement

**1.1 Acrobat ships an explicit, named "keep tool armed" affordance.** An Adobe community answer
(accepted as the correct answer) tells users: *"In the Comment tools, select the tool you want to use
(but don't use it yet). De-Select the 'Use the same tool until it's unselected' icon"*, citing Adobe's
help page *Use annotation and drawing markup tools to add comments in PDFs*. A separate Acrobat
thread describes right-clicking the tool icon and choosing *"Keep tool selected"*, and Acrobat
classic's Prepare Form had a pushpin control by that name.
**Sources:** [Adobe Community — Can not close text call out](https://community.adobe.com/questions-9/can-not-close-text-call-out-or-other-edit-functions-1286133),
[acrobatusers — text box (Edit PDF)](https://answers.acrobatusers.com/text-box-q193297.aspx),
[Adobe Community — "Keep tool selected" when inserting form fields](https://community.adobe.com/questions-9/keep-tool-selected-when-inserting-form-fields-can-you-disable-it-in-new-experience-1293880).
**Support:** direct quotation. **Confidence: high** for existence of the affordance; **medium** for its
exact help-page wording (helpx returned HTTP 403 to our fetcher).

**1.2 Reverting to Select after placement is the muscle memory.** A 2025 Acrobat thread is titled
"Anyone else annoyed in Acrobat Pro that the comment tool doesn't go back to 'Select' after 'Draw'"
and says: *"it seems to me that the tool used to revert back to the Select tool so I could move or
manipulate the rectangle or text box. My muscle memory seems to think so… Now it stays on whatever
shape I drew, so I just keep drawing boxes on top of boxes while I'm clicking around trying to move
the shape I just drew."* A third-party troubleshooting write-up describes the same failure as:
*"After creating a text callout, the tool stays selected, causing every subsequent mouse click to
unintentionally create another text callout box."*
**Sources:** [Adobe Community](https://community.adobe.com/questions-27/anyone-else-annoyed-in-acrobat-pro-that-the-comment-tool-doesn-t-go-back-to-select-after-draw-623088),
[WPS office-quick-solution](https://www.wps.com/office-quick-solution/pdf-troubleshooting/how-to-stop-the-text-callout-tool-from-remaining-selected-in-acrobat/).
**Confidence: high** (this is exactly BrowserSnip's Bug 1, reported against the market leader).

**1.3 Escape is expected to disarm the tool in one press.** *"If I try to click outside the text call out
box then it will simply create a new one even after I push the esc key"* (Acrobat); *"after creating a
text box with a mouse click, each subsequent click anywhere on the page will create a new text box.
I can end this cycle only by pressing Esc twice"* (Acrobat 2024, Prepare Form — answered by Adobe
staff as *intended* behaviour for field creation, i.e. sticky-by-design there).
**Sources:** [Adobe Community 2023](https://community.adobe.com/questions-9/can-not-close-text-call-out-or-other-edit-functions-1286133),
[Adobe Community 2026](https://community.adobe.com/questions-9/acrobat-pro-2024-claasic-text-boxes-under-prepare-form-keep-actively-creating-1625530).
**Confidence: high** for the expectation; the two-press Esc is reported as a defect/irritation.

**1.4 Where a tool *is* sticky, the vendor documents it as a mode, and it is only the creation mode.**
Sejda's own instructions are written around an armed tool: *"Make sure the 'Text' tool is selected.
Click anywhere on the PDF page to add text"* and *"Select the 'Text' tool in the top toolbar. Click any
existing text to start editing"*; highlighting is *"Click on 'Annotate', then choose the style and select
text on page to apply"* — i.e. markup tools are momentary selections of text, not rectangles.
**Source:** [Sejda PDF editor](https://www.sejda.com/pdf-editor). **Confidence: medium** — this is
documented wording; **inference (researcher):** the Text tool therefore stays armed between clicks.
iLovePDF separates view manipulation from editing entirely: *"To move in and around individual pages,
select the hand icon. Use the magnifying glasses to zoom in and out"*.
**Source:** [iLovePDF help](https://www.ilovepdf.com/help/documentation). **Confidence: medium.**

**1.5 Canvas editors make Move the default and give a keyboard door back to it.** Figma: *"When you
open a design file, the Move tool is enabled by default"*, *"To clear your selection entirely: Click
anywhere on the canvas / Use the keyboard shortcut: Esc"*, and third-party/bootcamp sources plus the
Figma forum state that **Esc or V returns you to the Move tool** from any drawing tool. Figma also
shows *"The crosshair cursor indicates where the new object will be placed"* while a creation tool is
armed, and text placement is: *"Click once in the canvas to add a text layer that grows horizontally;
Click and drag to create a text layer with a fixed size."*
**Sources:** [Figma — Select layers and objects](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects),
[Figma — Access design tools from the toolbar](https://help.figma.com/hc/en-us/articles/360041064174-Access-design-tools-from-the-toolbar),
[Figma — Use Figma products with a keyboard](https://help.figma.com/hc/en-us/articles/360040328653-Use-Figma-products-with-a-keyboard),
[Figma forum](https://forum.figma.com/ask-the-community-7/why-doesn-t-the-mouse-switch-to-selection-after-using-shortcut-r-to-create-a-graphic-i-have-to-press-v-or-esc-to-switch-it-to-selection-mode-14475).
**Confidence: high** for the docs; Esc/V↔Move is corroborated by two secondary sources, not the
toolbar help page itself.

**1.6 Pan is a modifier, not a mode.** Figma: *"You can press and hold the space bar to temporarily
activate the Hand tool."* Canva Whiteboards: *"To move around, press the spacebar and drag the canvas
in any direction."*
**Sources:** [Figma toolbar](https://help.figma.com/hc/en-us/articles/360041064174), [Canva help](https://www.canva.com/en_gb/help/expand-to-whiteboard/). **Confidence: high** (Canva text taken from a search extract of the Canva Help Center; the Canva pages blocked a full fetch).

## 2. Highlight behaviour

**2.1 The format itself forbids rectangles.** ISO 32000-1 §12.5.6.10 / Table 182: `QuadPoints` is
**required** for Highlight/Underline/Squiggly/StrikeOut — *"An array of 8×n numbers specifying the
coordinates of n quadrilaterals… Each quadrilateral shall encom[pass] a word or a group of
contiguous words in the text under the annotation"*; the annotation's `Rect` only bounds them.
**Sources:** [ISO 32000-2 Table 182 mirror](https://github.com/pdf-raku/PDF-ISO_32000_2-raku/blob/main/lib/ISO_32000_2/Table_182-Additional_entries_specific_to_text_markup_annotations.rakumod),
[LosLab PDFium QuadPoints](https://blog.loslab.com/en-us/pdfium-component/creating-text-markup-annotations-with-quad-points-pdfium-delphi.html). **Confidence: high.**

**2.2 Multi-line = one annotation carrying one quad per line.** LosLab, verbatim: *"A selection that
wraps across three lines needs three quads, one per line, because a single quadrilateral spanning all
three would also paint the right end of line one and the left end of line three"*; and *"You could
instead create one annotation per line. It renders the same, but a reviewer then sees three comments,
three popups and three items to delete for what was one highlight. Put the lines in one annotation."*
**Confidence: high** (directly fetched). ⚠️ **This contradicts the literal reading of UX-BRIEF Bug 2**
("one mark **per line**, each with its own quad"). Per-line *annotations* diverge from every real
reader's comment list; per-line *quads inside one mark* matches it. Flagged, not resolved here.

**2.3 Corner order is Z, not the spec's counterclockwise.** *"Acrobat, and the long line of tools built
to read what Acrobat writes, use a Z pattern instead: point 1 top-left, point 2 top-right, point 3
bottom-left, point 4 bottom-right… Write the Z order."* Corroborated by a Stack Overflow thread where
an iOS author reports the same against-the-spec behaviour.
**Sources:** [LosLab](https://blog.loslab.com/en-us/pdfium-component/creating-text-markup-annotations-with-quad-points-pdfium-delphi.html),
[SO — PDF Spec vs Acrobat creation (QuadPoints)](https://stackoverflow.com/questions/9855814/pdf-spec-vs-acrobat-creation-quadpoints). **Confidence: high.**

**2.4 In a browser, line snapping is a property of the text layer, and empty selections create nothing.**
The pdf.js recipe is: track `pointerup` → read `window.getSelection()` → walk `range.startContainer`/
`endContainer` to find pages → `range.getClientRects()` (one rect per line) →
`pageView.viewport.convertToPdfPoint(x, y)`. The reference implementation `react-pdf-highlighter`
guards the empty case in code: `if (!range || isCollapsed) return;` … `const rects =
getClientRects(range, pages); if (rects.length === 0) return;` — i.e. **a drag with no words
underneath creates no annotation**, exactly as UX-BRIEF demands.
**Sources:** [Nutrient — How to build text highlight annotations with PDF.js](https://www.nutrient.io/blog/pdfjs-text-highlight-annotations/),
[react-pdf-highlighter PdfHighlighter.tsx](https://github.com/agentcooper/react-pdf-highlighter/blob/main/src/components/PdfHighlighter.tsx),
[mozilla/pdf.js #15138 (zero-size rects from the enhanced text layer)](https://github.com/mozilla/pdf.js/issues/15138). **Confidence: high** for the pattern; **medium** on exact code (search extract of the file).
Known trap: per-line rects that spill outside the page box get filtered, producing **missing middle
lines** in 3+ line highlights ([react-pdf-highlighter #180](https://github.com/agentcooper/react-pdf-highlighter/issues/180)).

**2.5 Users judge a highlighter by contiguity, not by per-word fidelity.** Acrobat: *"the highlight tool
only works on each individual word, so when I try to highlight an entire sentence or paragraph, each
individual word is highlighted with blank spaces in between"*; an Acrobat DC idea thread asks
*"Please make the highlights contiguous"*, and Adobe's admin reply confirms the feature does **not**
exist. Separately, mark height following the *line box* rather than the glyph box is a long-standing
grievance (*"The highlighting height is about 2 lines of text high… It's like highlighting with a very
wide, dull highlighter"*).
**Sources:** [Adobe Community 2018](https://community.adobe.com/questions-9/how-to-continuously-highlight-or-underline-text-in-a-pdf-on-adobe-acrobat-1227532),
[Acrobat DC Uservoice](https://acrobat.uservoice.com/forums/911254-acrobat-web/suggestions/46805395-highlights-layout),
[Adobe Community — How to change height of highlight](https://community.adobe.com/questions-9/how-to-change-height-of-highlight-1240241). **Confidence: high.**
**Inference (researcher):** merging adjacent word rects on the same baseline into one quad per line is
the behaviour users ask for; Acrobat's per-word quad emission is a *text-extraction quality* artefact,
not a goal.

## 3. The small-things inventory a canvas editor is expected to have

| Convention | Authoritative statement | Checkable acceptance for BrowserSnip |
|---|---|---|
| Resting tool = select | Figma: Move *"enabled by default"*; Esc clears selection | After placing, `activeTool === 'select'` |
| Crosshair while armed | Figma: *"The crosshair cursor indicates where the new object will be placed"* | Canvas `cursor` differs per armed tool |
| Hover tells you it's interactive + hover highlights the target | Figma Layers hover → *"a blue box will highlight that layer's location on the canvas"* (user-toggled "Highlight on hover") | Hovering an annotation renders a ring/handles |
| Direction-correct resize cursors by hovering the edge | Figma: *"hover over the layer's left or right bounds until the [cursor] appears. Click and drag to resize"*; corners resize both | `ew/nw/se/ns…-resize` per handle; handles ≥8 px + hit slop |
| Live size readout while drawing/resizing | Figma: *"You'll see the rectangle's dimensions underneath the bottom edge"*; W/H shown *"in blue underneath the layer"* | px label follows the box during drag |
| Alignment / smart guides with a visible guide | Figma: Snap to objects/geometry/pixel grid — *"A red guide appears on the canvas as a visual indicator"*; *"hold Control to temporarily disable"*; Canva: *"Alignment guides may appear as you move it"* | Guides render on snap; modifier suppresses |
| Constrained transforms | Figma: Shift = square/15° rotation snap; Alt/Option = resize from centre; lock-aspect temporarily with Shift (and release breaks it) | Shift constrains resize+rotate |
| Marquee selection | Figma: *"Click and hold on an empty part of the canvas. Drag… A blue box will appear around each object"*; Shift+click removes from selection | Drag on empty canvas lasso-selects |
| Double-click = go one level deeper | Figma: *"Double-click on the object — or press the enter key — to select one level of nesting down"*; Enter/Shift+Enter step in/out; Tab next sibling | dbl-click a text box enters edit mode |
| Esc unwinds one level at a time | Figma: Esc = clear selection; Figma forum/baseline: Esc/V = back to Move | Esc: close editor → deselect → disarm → close panel |
| Arrow nudge 1 px, Shift 10 px | Figma: *"small nudge is set to 1 and big nudge set to 10… hold down Shift to use the big nudge"* | Matches UX-BRIEF exactly |
| Cmd/Ctrl-D duplicate; Alt+drag duplicates | Figma shortcut sheets (secondary) | Copy lands selected, offset |
| Zoom to fit / selection / actual size; scroll+modifier zoom | Figma: Shift `+`, Shift `-`, Shift 1 fit, Shift 2 selection; default view *"Zoom to fit"*; Cmd/Ctrl + wheel. Canva: `Ctrl + +`, `Ctrl + -`, `Ctrl 0` actual, `Alt+Ctrl 0` fit, `Shift+Ctrl 0` fill | Named zoom commands, not only a slider |
| Space = temporary pan | Figma + Canva (see 1.6) | Hold space → hand cursor, drag pans |
| Shortcuts suppressed while typing | Researcher synthesis of the brief's rule + Figma's text-edit mode | Guard on `input/textarea/contenteditable` |
| Target size | WCAG 2.5.8: *"at least 24 by 24 CSS pixels"*, else the 24 px spacing exception; 2.5.5 enhanced = 44 px | 28 px floor passes AA; document handle exceptions |
| Focus visible & not obscured | WCAG 2.4.7 *"each item receiving focus has a visible indicator"*; 2.4.11 focused item not entirely hidden | Focus ring on every toolbar/button; ring not under a sticky bar |
| Dragging has a non-drag alternative | WCAG 2.2 added **2.5.7 Dragging Movements (AA)** (list evidence) | Reorder/delete/resize also reachable by keys+buttons |
| Tooltips on hover **and** keyboard focus; one line; never load-bearing | NN/g tooltip guidelines; SAP: *"Appears on hover, focus, or touch (long press)… Does not require user interaction inside it"*; *"Don't use them for critical information"* | `title`/`aria-describedby`, focusable triggers |
| Hidden content not triggered too eagerly | NN/g timing guidelines: revealing on mouseover *"too quickly… results in accidental activations"* | ~300–500 ms tooltip delay |
| Disabled controls explain themselves | NN/g: *"clearly explain why the button is disabled"*; Nielsen (UX Tigers): *"display disabled features in muted colors, accompanied by explanations"*; WCAG 3 draft: *"When a submit button is disabled until all required fields are filled in, explain that this is the case."* | One line next to the primary action |
| Progress thresholds | NN/g: *"Use a progress indicator for any action that takes longer than about 1.0 second"*; indeterminate loop for 2–10 s; *"percent-done progress indicators should be used for operations taking more than about 10 seconds"*; *"Clearly indicate progress completed and time or steps remaining"* | No fake determinate bar; stage names instead |
| Undo/redo is universal and unlabelled-by-default | Figma: ⌘/Ctrl+Z for every change, incl. layer order | Undo/redo must announce state to AT (brief rule) |

## 4. File-queue and progress conventions (in-product strings)

**iLovePDF** (extracted from the live tool HTML, so these are real UI strings): drop zone
*"Select PDF files / or drop PDFs here"*; queue/progress *"Uploading file 0 of 0"*, *"Time left -
seconds - Upload speed - MB/S"*, *"Uploaded"*; stage names *"Compressing PDF…"*, *"Merging PDFs…"*;
network failure *"Woops! Something is wrong with your Internet connection…"*; merge page hint
*"To change the order of your PDFs, drag and drop the files as you want."*; and an
insufficient-input state that names the next action: *"Please, select more PDF files by clicking again
on 'Select PDF files'. Select multiple files by mantaining pressed 'Ctrl'"* [sic]. Compress is
positioned as *"Shrink PDF file size, with before and after sizes"*, and third-party tests of the
mobile flow report it *"display[ing] the file size before and after compression"*.
**Sources:** [ilovepdf.com/compress_pdf](https://www.ilovepdf.com/compress_pdf), [ilovepdf.com/merge_pdf](https://www.ilovepdf.com/merge_pdf), [swifdoo report](https://www.swifdoo.com/blog/compress-pdf-to-300kb-ilovepdf).

**Sejda** states its limits *before* the click, in the drop-zone subtitle: *"Files stay private.
Automatically deleted after 2 hours. Free service for documents up to 200 pages or 50 MB and 3 tasks
per hour."* Its named failures: *"Sorry, your file is too large."*, *"Too many attempts. Please try
again later."*, *"You reached your free limit of 3 tasks per hour. Please upgrade to continue
processing this task or break for 00:59:00."* — each names the cause and the remedy, one with a
countdown.
**Sources:** [sejda.com/pdf-editor](https://www.sejda.com/pdf-editor), [sejda.com/sign-pdf](https://www.sejda.com/sign-pdf).

**Smallpdf** keeps a numbered verb-first flow and gates honestly in the step text: *"Drag & drop your
file into Smallpdf's free PDF compressor."*, *"Choose Basic, Moderate (Pro), or Strong (Pro)
compression, then click 'Compress'."*, *"Download or share your compressed PDF when you're done."*
**Source:** [smallpdf.com/compress-pdf](https://www.smallpdf.com/compress-pdf).

**ihatepdf.cv** (owner's reference): the tool page is front-loaded with outcome promises rather than
chrome — breadcrumb `Home › PDF Tools › Free PDF Editor`, an "At a glance" list, a 4-step How-to, and
trust bullets (`✓ 100% Free ✓ No Watermark ✓ No Sign-Up ✓ No Upload — Files Stay on Your Device ✓
Works Offline`). Two behaviours matter for BrowserSnip: text editing is **modeless** (*"Click any line
of text to edit it in-place. The original font, size, and colour are detected and reused, so the
layout does not shift"*), and the no-text-layer case **degrades with a confirmation step** (*"When
ihatepdf opens a page and finds no text, it automatically runs OCR… Words the OCR engine was unsure
about are highlighted so you can verify them before downloading"*) — E10 handled as an honest,
checkable state rather than "0 characters, done".
**Source:** [ihatepdf.cv/edit-pdf-text](https://ihatepdf.cv/edit-pdf-text). **Caveat:** fetched copy only; the canvas app itself was not driven.

**bentopdf.com** is the same genre and reinforces the convention: *"Click any paragraph and edit it in
place with live reflow, fonts, and styling"*, *"Add image stamps to your PDF using the annotation
toolbar"*, *"Strip comments, highlights, and links"*, plus a multi-step **PDF Workflow Builder**
("visual node editor") and zero-upload claims (*"All processing happens directly in your web browser
(client-side)"*). No queue/progress/error copy surfaced (search for "progress", "queue", "batch" in
the fetched page: no matches), so its file-queue conventions are **unverified**.
**Source:** [bentopdf.com](https://bentopdf.com).

## 5. Error and empty-state copy that reads human

Distilled from NN/g's error-message guidelines, with the pattern each yields:

- **Plainspoken, no codes** — *"Avoid technical jargon… Hide or minimize the use of obscure error
  codes or abbreviations."* → `qa-invoice.pdf is password-protected. Enter its password to open.` not
  `NEEDS_ENGINE` / `ToolInputError`.
- **Say what specifically went wrong** — *"Generic messages such as An error occurred lack context."*
  → name the file, the field, the offending value.
- **Always pair with a remedy** — *"Merely stating the problem is also not enough; offer some
  potential remedies."* → the message contains the button ("Retry", "Choose another file", "Try
  Light compression").
- **Never blame, minimise humour** — *"Don't use phrasing that blames users… such as invalid, illegal,
  or incorrect. Avoid humor since it can become stale if users encounter the error frequently."*
  → drop "Invalid page range"; use "Page range goes past the end of this 8-page file".
- **Don't fire early** — *"Presenting errors too early is a hostile pattern. It's like grading a test
  before the student has had a chance to answer."* → validate on blur/submit, not on first keystroke.
- **Keep it next to the thing** — *"Display the error message close to the error's source."* → inline
  under the rail field, not in a global Log pane.
- **Preserve input & shrink repair effort** — *"display the original text entered… even if it does not
  match the requirements"*; *"instead of just saying City and ZIP code don't match, let users click on
  a button for the city that matches."* → clamp-and-tell (E15), and offer the valid range as chips.
- **Severity matches the container** — banners/toasts for "good to know", modals for blockers.
- **Empty state = status + how to fill + pathway** — NN/g: empty states *"communicate system status,
  increase learnability… and deliver direct pathways for key tasks."* → e.g. "No text layer on these
  3 scanned pages — Run OCR" (E10), "No forms found in this file — Add your own text fields" (E13).
- **Total failure may earn novelty, once.** NN/g permits a lighter tone only when the system can
  offer no recourse — iLovePDF's *"Woops! Something is wrong with your Internet connection…"* sits
  exactly there (and BrowserSnip, being offline-capable, rarely qualifies).

## What BrowserSnip should copy, and why

1. **Select is the resting state; placement tools one-shot into it** (Acrobat muscle memory, Figma
   default). Test: place a text box → `activeTool === 'select'`, `selection === [newId]`, and the next
   canvas click does **not** create a second box. Same assertion for Stamp/Image/Signature/Shape/Arrow.
2. **Make sticky-vs-one-shot a declared column with a visible affordance** — Acrobat's named
   "use the same tool until it's unselected" toggle is the precedent; ship either a lock control on the
   tool button (`aria-pressed`) or Shift-click-to-hold. Test: a `TOOL_STICKINESS` map is asserted;
   Pen/Highlight stay armed, everything else disarms.
3. **One Esc = one level up, and the tool is a level** (Acrobat users count two presses as a bug).
   Chain: exit text edit → deselect → disarm tool → close panel; never "close the app".
4. **Highlight is text geometry, not a rectangle, and the mark is one annotation with one quad per
   line** (ISO Table 182; LosLab). Merge adjacent word rects sharing a baseline; write Z-order quads;
   clip each rect to the page box; union into `Rect`. Test: 2-line drag → 1 mark, `quads.length === 2`,
   no quad covers the leading gap. **Escalate the brief's "one mark per line" wording** — if per-line
   annotations are kept, justify it as an internal model that collapses to one `/Highlight` on export.
5. **Empty drag creates nothing; clicking a mark selects it, never starts a new one** — precedent in
   `react-pdf-highlighter`'s `isCollapsed` / `rects.length === 0` guards. Underline/strike inherit the
   same path (ISO treats the four subtypes identically; only the paint differs).
6. **Space = temporary pan; separate zoom commands** (Figma, Canva, iLovePDF's hand/magnifiers). Add
   zoom-to-fit / zoom-to-selection / actual-size, and don't let the annotation tool steal a pan drag.
7. **While moving or resizing an annotation: live W×H label, snap guides rendered on engagement, Shift
   to constrain, modifier to suppress snapping, direction-correct cursors, ≥8 px handles with slop**
   (Figma). This is the single biggest "it feels refined" delta on a canvas.
8. **Marquee on empty canvas, Shift+click to subtract, double-click/Enter to step into a mark**
   (Figma), plus the keyboard parity table the brief already lists (1 px / Shift 10 px nudge,
   ⌘/Ctrl-D, Del, ⌘/Ctrl-Z) — the numbers match Figma's documented defaults, so users arriving from
   any editor get them for free.
9. **Queue rows named like iLovePDF's**: file name, size, page count, thumbnail, per-file
   `Uploading 2 of 5` + `Time left` + speed *only when measurable*, stage name while working
   ("Compressing…"), named failure with Retry, and remove/reorder that also works without dragging
   (WCAG 2.5.7). Drop the Log-pane-as-error-sink.
10. **State the limits before the click, in the drop-zone subtitle, Sejda-style** — e.g. "Free for
    files up to N pages. Nothing is uploaded; processing happens in this tab." Honest limits beat an
    error after effort.
11. **Results in checkable numbers with the ugly cases pre-handled**: pages in/out, size before →
    after and the delta, what was skipped — and never "Done" for nothing (E13) nor "compressed" when
    it grew (E14): say *"This file came out 12% larger — Keep original?"*.
12. **Copy rules** (NN/g): name the file/value/fix; no class names, no stack traces, no `undefined`;
    no blame words; errors inline beside the control; disabled controls carry a one-line reason;
    tooltips ≤1 line and revealed on focus as well as hover; empty states always contain the verb
    that fills them.

## Contradictions

- **Per-line marks vs per-line quads.** UX-BRIEF Bug 2 says "one mark per line, each with its own
  quad"; the PDF format and every reader keep multi-line markup as **one annotation with N quads**,
  and per-line annotations are explicitly criticised for producing *"three comments, three popups and
  three items to delete for what was one highlight"* (LosLab). Unresolved in the brief; recommend one
  mark + N quads and escalate to M1.
- **Acrobat's own default moved away from revert-to-Select** (shape/callout tools now stay armed),
  and the community treats that as a regression — while Adobe staff confirm sticky-by-default is
  *intended* for Prepare Form field creation. So "sticky" is legitimate only where the user is
  deliberately creating many objects in a row.
- **Acrobat's per-word vs contiguous highlighting**: Acrobat ships per-word quads (users complain
  about the gaps); Adobe confirmed contiguity is not implemented. BrowserSnip can beat the reference
  here rather than match it.
- **`ihatepdf.cv`'s own claim vs Acrobat/Smallpdf**: ihatepdf and BentoPDF lead with modeless
  in-place text editing; Sejda/Acrobat require an armed Text tool. The modern (and better) convention
  is modeless editing + armed creation.

## Missing evidence / unverified

- Adobe's help page *Use annotation and drawing markup tools* (helpx) returned **HTTP 403** to our
  fetcher; the toggle's exact label is attested only through Adobe community answers quoting it.
- **Live canvas behaviour** of Acrobat web, iLovePDF, Smallpdf and Sejda editors could not be
  observed headlessly (all are JS apps behind a session/upload). Stickiness claims for those four rest
  on their own instructional wording → *interpretation*, medium confidence.
- **ihatepdf.cv's actual annotation canvas** (tool revert, highlight snapping) — only its marketing/FAQ
  copy is fetchable; no interactive observation was possible.
- **bentopdf.com** queue/progress/error conventions: no strings found in the fetched page; the
  app's in-editor behaviour is unverified (its sub-app path was not confirmed either).
- Canva's Help Center blocked full fetches (unsupported-browser wall); Canva facts come from
  Help-Center text returned in search extracts.
- No authoritative source found for "drag ghost" as a *named* convention; the browser's default drag
  image and Figma's crosshair/selection previews are the nearest documented behaviour. Treat the
  drag-ghost item in the brief as sound but researcher-inferred.
- Whether Acrobat web (not desktop) exposes the sticky-tool toggle at all: **unverified**.

## Sources

Kept:
- Adobe Community — comment tool doesn't return to Select after Draw; text-callout threads; keep-tool-selected form-field thread — user expectation evidence for Bug 1.
- acrobatusers forum — "Keep tool selected" right-click on Edit-PDF text box.
- WPS office-quick-solution — restates the sticky-callout failure in product terms.
- helpx *Use annotation and drawing markup tools* (title cited; page 403) — https://helpx.adobe.com/acrobat/using/commenting-pdfs.html
- ISO 32000 Table 182 mirror + LosLab PDFium QuadPoints — quads per line, Z-order, one-annotation rule.
- Nutrient blog + react-pdf-highlighter source + pdf.js issues #15138 / #10516 — pdf.js text-layer highlight pipeline and its empty/edge cases.
- Acrobat Community + Uservoice — contiguity and mark-height complaints.
- Figma Help Center (toolbar, shape tools, select layers, alignment/position, zoom & view, keyboard) — the small-things inventory.
- Canva Help Center (whiteboard pan/zoom, page view settings, keyboard shortcuts) — pan/zoom/selection parity.
- Sejda PDF editor + sign pages; iLovePDF compress/merge pages + help; Smallpdf compress page — file-queue, progress and error strings, in-product.
- ihatepdf.cv home + /edit-pdf-text; bentopdf.com — owner's reference sites: modeless text edit, auto-OCR with confidence flagging, honest limit promises.
- NN/g: error-message guidelines, empty-state design, progress indicators, response-time limits, tooltip guidelines, hidden-content timing, disabled buttons; UX Tigers (Nielsen) inactive controls; W3C WCAG 2.4.7 / 2.4.11 / 2.5.8 / 2.2 changes; WCAG 3 draft "disabled controls explained".

Rejected / deprioritised:
- App-store reviews, SEO listicles and tool-comparison blogs (softwareadvice, trupeer, tutorialtactic,
  digitalmasta, apelr) — redundant or unverifiable second-hand UI claims.
- ScreensDesign "UI breakdown" of the iLovePDF **mobile** app — different platform from a browser canvas.
- PCWorld Sejda review — describes task-first landing flow, not canvas interaction.

## Next steps

1. **Hands-on capture (30 min, needs a browser):** drive the annotation editors of Acrobat web,
   Smallpdf (`/edit-pdf`), Sejda and ihatepdf.cv; record per-tool: does the tool disarm, is there a
   keep-armed control, what does Esc do, does highlight merge word rects, does an empty drag create
   anything. This is the only way to convert §1.4 and §4 from interpretation to evidence, and it also
   settles the per-line-quad contradiction with screenshots.
2. **Ask M1 for a decision on the highlight model** (one annotation + N quads vs N marks), since it
   changes both the annotation store and the export path.
3. **Wave-2 owners:** turn §3's table rows into the jsdom-assertable invariants for M1/M3/M5
   (cursor tokens, handle sizes, nudge deltas, `aria-pressed` stickiness, `aria-live` stage strings)
   and §4/§5 into a copy pattern sheet for M6 (`ux-definitions.test.ts`).

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "Brief covers all five asked-for areas (tool stickiness, highlight behaviour, canvas small-things inventory, file-queue/progress conventions, error+empty copy) with 20+ cited sources, direct quotes vs interpretation labelled, confidence per finding, a 12-point 'what to copy' list phrased as checkable tests, an explicit Contradictions and Missing-evidence section, and a <=150-word handoff."
    }
  ],
  "changedFiles": [
    "/home/nekophobia/.pi/agent/sessions/--home-nekophobia-Projects-BrowserSnipRepo--/subagent-artifacts/outputs/5e2c4085-d3c1-43d9-8976-84e1020195ba/task-6.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "web_search (multi-angle, workflow=none) + fetch_content on Adobe community/helpx, Sejda, iLovePDF, Smallpdf, Figma Help Center, Canva help, ihatepdf.cv, bentopdf.com, NN/g, W3C, ISO Table 182 mirror",
      "result": "passed",
      "summary": "Primary + community evidence gathered for all five areas; Adobe helpx and Canva help blocked full fetch (noted)"
    },
    {
      "command": "source_check on ISO/QuadPoints multi-line claim",
      "result": "failed",
      "summary": "Provider rate limit (Exa 429) left it 'missing-evidence'; verified instead by directly fetching the LosLab page and the ISO Table 182 mirror"
    }
  ],
  "validationOutput": [
    "Figma Help Center: 'small nudge is set to 1 and big nudge set to 10 ... hold down Shift to use the big nudge settings instead'; 'Move tool is enabled by default'; 'press and hold the space bar to temporarily activate the Hand tool'",
    "Adobe Community (accepted answer): 'De-Select the \"Use the same tool until it's unselected\" icon'",
    "LosLab/ISO: 'A selection that wraps across three lines needs three quads, one per line'; 'create one annotation per line ... a reviewer then sees three comments, three popups and three items to delete'",
    "iLovePDF in-product strings: 'Uploading file 0 of 0' / 'Time left - seconds - Upload speed - MB/S' / 'Compressing PDF...' / 'Woops! Something is wrong with your Internet connection...'",
    "Sejda: 'Files stay private. Automatically deleted after 2 hours. Free service for documents up to 200 pages or 50 MB and 3 tasks per hour.'; 'Sorry, your file is too large.'",
    "WCAG 2.5.8: targets 'at least 24 by 24 CSS pixels' (44 px for 2.5.5 enhanced); WCAG 2.4.7 focus visible; NN/g: progress indicator for anything >1s, percent-done >10s"
  ],
  "residualRisks": [
    "Behaviour claims for Acrobat web / iLovePDF / Smallpdf / Sejda editors are inferred from each vendor's own instructional text and in-product strings, not from live observation (JS apps are unfetchable headlessly) - medium confidence",
    "Adobe's helpx page returned HTTP 403, so the exact wording of the 'use the same tool until it's unselected' control rests on Adobe community answers quoting it",
    "ihatepdf.cv and bentopdf.com were verified only as published copy; their actual canvas interaction and queue/error states remain unverified",
    "UX-BRIEF's 'one mark per line' conflicts with the PDF/reader convention of one annotation carrying one quad per line; unresolved and escalated to M1 rather than decided here",
    "No authoritative source found for 'drag ghost' as a named convention; that checklist item is researcher-inferred",
    "source_check could not complete (Exa 429); decision-critical claims were verified by direct source inspection instead"
  ],
  "noStagedFiles": true,
  "diffSummary": "One research artifact written (docs/research/ux-references-commercial.md content, delivered at the authoritative output path task-6.md); no source or test files modified",
  "reviewFindings": [
    "no blockers",
    "advisory: docs/UX-BRIEF.md Bug 2 wording ('one mark per line') conflicts with ISO 32000-1 QuadPoints convention (one annotation, one quad per line) - needs an explicit owner decision before M1 implements",
    "advisory: brief's ~28px target floor exceeds WCAG 2.5.8's 24px AA minimum, but WCAG 2.5.7 (dragging needs a non-drag alternative) is not mentioned in the checklist and should be added"
  ],
  "manualNotes": "Deliverable text is the markdown written to the authoritative path. Content is intended for docs/research/ux-references-commercial.md per the task, but the run-level output path overrode that filename, so nothing was written inside the repo. Wave-1 siblings R1-R3 own the other ux-references-* files; no overlap."
}
```
