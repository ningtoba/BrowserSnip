# Edit PDF (`#/tool/edit-pdf`) — audit #2, verified by audit #3

Run: fresh audit after two prior agents died mid-run (one timed out after 55 screenshots with no
written findings; one blocked on a foreground vite). This file is appended to incrementally, one
finding per observation, so a partial report always exists.

Harness: CDP + headless Chromium against dev server `http://localhost:5311` (5222 was dead at
start of this run), `/tmp/sample.pdf` (10-page CV), 1500x1000 @ deviceScaleFactor 2.
Screenshots: `docs/research/shots/audit2-*.png`.
Source files touched: none.

> **Read this first.** Audit #2 stopped mid-sweep. Everything below it is kept as
> written, and every finding now carries a `**[audit #3]**` line under its heading
> saying *verified / fixed / not reproducible / inherited*. The re-measurement of
> the whole palette — canvas ink and exported bytes for all 17 tools, the three
> defects found and fixed, and the list of claims in this file that turned out to
> be false — is `# Audit #3 — the verification pass` at the end of the file.

## Findings

Appended in order of discovery. Severity: **P0** data loss / wrong exported file, **P1** tool
broken or visibly wrong on canvas, **P2** chrome/state inconsistency, **P3** cosmetic.

- Verified hooks used throughout: `[data-armed-tool]`, `[data-tool="<id>"]`, `[data-mark]`,
  `[data-resize-handle]`, `[data-marquee]`, `[data-zoom]`, `[data-page-extent]`,
  `[data-export-summary]`, `[data-empty-marks]`, `[data-selection-panel]`.
- Cold load of `#/tool/edit-pdf` arms **highlight**, not Select (`quickModes.ts:79` maps the tool to
  `armTool: 'highlight'`); the palette itself is absent until a file is loaded. Page 1 of
  `/tmp/sample.pdf` is 595x842 pt and renders at 100 % fit-width, 144 px of page height sit below
  the 1000 px viewport fold.
- Export button reads `Export annotated PDF (n)` and is disabled at n=0; `[data-export-summary]`
  says "Nothing on the page yet."
- tools present: ["select","highlight","underline","strike","note","freetext","ink","line","arrow","polygon","polyline","square","circle","stamp","image","signature","link","redact"]
- export enabled before any mark: {"label":"Export annotated PDF (0)","disabled":true}

## 1. Palette sweep — does a normal gesture put a visible mark on the page?

Baseline: a cold load of `#/tool/edit-pdf` arms **highlight** (quick-mode default, `quickModes.ts:79`), not Select. Page 1 is 595x842 pt shown at 100 % fit-width; all drags below are anchored on real text lines read out of the PDF with PyMuPDF, not guessed fractions.


### 1. [OK] `highlight` works

> **[audit #3] verified.** Re-measured at `3736594`: 0→1 mark, 1 567 px² on canvas, exported `/Highlight` paints 1 570 pt² in the file.

highlight: marks 0->1 | added=1 | area=990px | armedAfter=select | sel="amw7awqes7" | summary="1 mark on 1 page(s). — first added: {"id":"amw7awqes7","x":801,"y":382,"w":110,"h":9,"stroke":"none","fill":"rgb(255, 235, 59)","op":"1","sw":"1px"}

### 2. [P1] `underline` produces no visible mark

> **[audit #3] not reproducible as stated — the evidence was wrong, not the mark.** `area=0px` came from measuring a `<line>`'s box, which is zero tall however thick the stroke; the rule painted all along. Re-measured: 134 px² on canvas, and the exported `/AP` strokes `0 1 m 134.07 1 l S` = 134.5 pt². The renderer was still improved by `6176b27`/`875c931`, and the overlay and the file now share `markupRule` under test.

underline: marks 1->2 | added=1 | area=0px | armedAfter=select | sel="amw7awr8uc" | summary="2 marks on 1 page(s).

### 3. [P1] `strike` produces no visible mark

> **[audit #3] not reproducible as stated** — same measurement artifact as §2. Re-measured: 78 px² on canvas, 78.5 pt² in the file (`0 5 m 78.12 5 l S`).

strike: marks 2->3 | added=1 | area=0px | armedAfter=select | sel="amw7aws2kh" | summary="3 marks on 1 page(s).

### 4. [OK] `note` works

> **[audit #3] verified.** 0→1, 745 px², `/Text` in the file with `/Contents (Audit note)`. The note's comment now has to be typed for the mark to be worth writing; the editor says so (`data-empty-marks`).

note: marks 3->4 | added=1 | area=676px | armedAfter=select | sel="amw7awsvbk" | summary="4 marks on 1 page(s). — first added: {"id":"amw7awsvbk","x":1258,"y":316,"w":26,"h":26,"stroke":"rgb(27, 27, 24)","fill":"rgb(255, 243, 163)","op":"1","sw":"0.8px"}

### 5. [OK] `freetext` works

> **[audit #3] verified.** 0→1, 13 204 px², `/FreeText` box + border + text in the file (1 752 pt² changed against the original, and `Audit text box` extracts from the page text). Note: setting `input.value` in a probe does not reach React — type with `Input.insertText` or the box exports empty and `data-empty-marks` warns, which is the app being right and the harness wrong.

freetext: marks 4->5 | added=1 | area=7761px | armedAfter=select | sel="amw7awu8p11" | summary="5 marks on 1 page(s). — first added: {"id":"amw7awu8p11","x":1111,"y":509,"w":199,"h":39,"stroke":"rgb(27, 27, 24)","fill":"rgb(255, 255, 255)","op":"1","sw":"0.8px"}

### 6. [OK] `ink` works

> **[audit #3] verified.** 0→1, 7 176 px² of stroke path on canvas, `/Ink` with a 396-byte `m`/`l` stream, 693.5 pt² in the file.

ink: marks 5->6 | added=1 | area=6755px | armedAfter=select | sel="amw7awvok1i" | summary="6 marks on 1 page(s). — first added: {"id":"amw7awvok1i","x":831,"y":769,"w":193,"h":35,"stroke":null,"fill":null,"op":null,"sw":null}

### 7. [P1] `line` produces no visible mark from a normal gesture

> **[audit #3] fixed, then fixed again.** The cause named in §18 was real and was repaired by `b1f4a6e`, before this pass started: one drag now creates 0→1 with 7 200 px² painted and `/L [59.64 81.39 299.64 51.39]` in the file. A second, different swallow was still live — §3.1, a resize grip of the previous mark eating the press — fixed in `1851dfc`. Proof: `docs/research/shots/audit3-line-and-arrow.png`.

line: marks 6->6 | added=0 | area=0px | armedAfter=line | sel="amw7awvok1i" | summary="6 marks on 1 page(s).

### 8. [P1] `arrow` produces no visible mark from a normal gesture

> **[audit #3] fixed, same two causes as §7.** Re-measured: 0→1, 7 751 px² (shaft + head polygon), `/LE [/None /ClosedArrow]` with the head on the release end of `/L`.

arrow: marks 6->6 | added=0 | area=0px | armedAfter=arrow | sel="amw7awvok1i" | summary="6 marks on 1 page(s).

### 9. [OK] `square` works

> **[audit #3] verified.** 0→1, 18 000 px², `/Square` stream `1 1 178 98 re S` = 1 201.5 pt².

square: marks 6->7 | added=1 | area=8400px | armedAfter=select | sel="amw7awyds2x" | summary="7 marks on 1 page(s). — first added: {"id":"amw7awyds2x","x":811,"y":849,"w":140,"h":60,"stroke":"rgb(37, 99, 235)","fill":"none","op":"1","sw":"2px"}

### 10. [OK] `circle` works

> **[audit #3] verified.** 0→1, 15 000 px², `/Circle` drawn as beziers, 1 008.8 pt².

circle: marks 7->8 | added=1 | area=8400px | armedAfter=select | sel="amw7awza63e" | summary="8 marks on 1 page(s). — first added: {"id":"amw7awza63e","x":971,"y":849,"w":140,"h":60,"stroke":"rgb(37, 99, 235)","fill":"none","op":"1","sw":"2px"}

### 11. [OK] `polygon` works

> **[audit #3] the tool works; the measurement did not.** Polygon takes one corner per press and closes on Enter or double-click — a single drag creates nothing (§3.3). Re-measured with the real gesture: 0→1, 20 000 px², `/Polygon` 1 195.5 pt². The 140×60 box recorded here is the harness's drag rectangle, identical to §9 and §10.

polygon: marks 8->9 | added=1 | area=8400px | armedAfter=select | sel="amw7ax0oa3r" | summary="9 marks on 1 page(s). — first added: {"id":"amw7ax0oa3r","x":1131,"y":749,"w":140,"h":60,"stroke":"rgb(5, 150, 105)","fill":"none","op":"1","sw":"2px"}

### 12. [OK] `polyline` works

> **[audit #3] tool verified (0→1, 16 800 px², `/PolyLine` 704 pt²); the one-drag claim is false, see §3.3.**

polyline: marks 9->10 | added=1 | area=950px | armedAfter=select | sel="amw7ax22b42" | summary="10 marks on 1 page(s). — first added: {"id":"amw7ax22b42","x":811,"y":949,"w":190,"h":5,"stroke":null,"fill":null,"op":null,"sw":null}

### 13. [OK] `stamp` works

> **[audit #3] verified.** Click places it: 0→1, 9 635 px², `/Stamp` with the word in the appearance stream, 1 263.2 pt².

stamp: marks 10->11 | added=1 | area=6160px | armedAfter=select | sel="amw7ax2v745" | summary="11 marks on 1 page(s). — first added: {"id":"amw7ax2v745","x":1081,"y":887,"w":140,"h":44,"stroke":"rgb(170, 0, 0)","fill":"none","op":"1","sw":"1.5px"}

### 14. [OK] `image` works

> **[audit #3] verified.** 0→1, 38 400 px², `/Stamp` + `/Im0 Do` with a 240 × 160 cm matrix, 38 480 pt² of changed pixels in the file.

image: marks 11->12 | added=1 | area=28800px | armedAfter=select | sel="amw7ax3oq46" | summary="12 marks on 1 page(s). — first added: {"id":"amw7ax3oq46","x":931,"y":269,"w":240,"h":120,"stroke":"none","fill":"rgb(0, 0, 0)","op":"1","sw":"1px"}

### 15. [P1] `signature` produces no visible mark from a normal gesture

> **[audit #3] not reproducible** — see §19, which already retracted this for the wrong button label. Re-measured properly (the pad is the canvas **inside the dialog**, not the biggest canvas on screen): 0→1, 11 868 px², `/Stamp` + `/Im0`, 2 210.5 pt².

signature: marks 12->12 | added=0 | area=0px | armedAfter=signature | sel="amw7ax3oq46" | summary="12 marks on 1 page(s). | ERR=signature pad did not open

### 16. [P1] `link` produces no visible mark from a normal gesture

> **[audit #3] not reproducible.** Drag → Open URL → type → Add link creates 0→1 with 3 726 px² on canvas; the file carries `/Link` with `/A << /URI (https://example.com/audit) >>` at the dragged rect. PyMuPDF's `page.annots()` does not enumerate links — use `page.get_links()`, which is how a re-check of this finding can end up "no annotation in the file" wrongly.

link: marks 12->12 | added=0 | area=0px | armedAfter=link | sel="amw7ax3oq46" | summary="12 marks on 1 page(s). | ERR=link dialog did not open

### 17. [P1] `redact` produces no visible mark from a normal gesture

> **[audit #3] not reproducible.** 0→1, 1 776 px²; the file has `/Redact` **and** the burn: 1 776 pt² of near-black paper inside the box and `CYBERJAYA` deleted from the exported text (`inkVsOriginal` 1 990 pt²). The annotation layer on its own adds 12 pt² because the fill is already in the content — reading only the annot layer says "it painted nothing", which is the trap in the opposite direction.

redact: marks 12->12 | added=0 | area=0px | armedAfter=redact | sel="amw7ax3oq46" | summary="12 marks on 1 page(s).

Sweep verdict: 12/17 tools produced a mark. Silent: line, arrow, signature, link, redact

- tool count in palette: 18 | marks now on page 1: 12
- console errors during sweep: []

### 18. [P1] Line and Arrow cannot place a mark at all — `finishDrag` hands the builder a `drag`, `buildSegment` only reads `points`

> **[audit #3] fixed by `b1f4a6e`; the rule now lives in one tested function.** `a8e0d09` extracts `dragGesturePayload` and shares it between the rubber band and the commit, because the builder tests that hand in their own `points` cannot see the release forget them.


### 1. [P1] Line: a large diagonal drag creates nothing and blames the user

> **[audit #3] fixed, and the "blames the user" message was the tell.** Re-measured: one drag, `Placed Line · p.1. Select is armed.`, 7 200 px², 498.2 pt² in the file. A *second* drag was still eaten by the previous mark's grip — §3.1.

Dragged 240x50 pt with Line armed. marks stayed at 12, the palette kept Line armed (correct for a failed gesture), and the status line read: **"Drag from one point to another. After one placement the tool hands control back to Select."** — which tells the user to "draw a bigger shape", though the drag was plenty big.

Cause: `AnnotationEditor.tsx:944` calls `buildAnnotation({...,drag})` for every `mode:'drag'` gesture, but `specs.ts:199 buildSegment` builds `from`/`to` from `input.points` only, which is `undefined` here → returns `null`. Same call site serves Arrow.

### 2. [P1] Arrow: same failure, same message

> **[audit #3] fixed with Line** (same `buildSegment`); re-measured at 7 751 px² and `/LE [/None /ClosedArrow]` on the release end.

Arrow armed, identical 240x50 pt drag. marks = 12, armedAfter = arrow, status = "Drag in the direction the arrow should point. After one placement the tool hands control back to Select.". `buildSegment` is shared by Line and Arrow, so one call-site fix covers both.

### 19. [P2] Audit note: signature, link and redact were reported silent by the first sweep for the wrong reason

> **[audit #3] confirmed, and the class is bigger than the note says.** Three more ways this screen fakes a silent tool, all hit during this pass: the pad canvas is not the largest canvas on the page; a modal left open eats every later gesture (this pass reproduced it — a link dialog left open made the *next* tool report `created 0`); `[data-page-extent]` is a toolbar chip; and `input.value = …` does not reach a controlled React field, so a dialog's confirm button stays disabled.

The signature pad confirm button is **Place signature** and the link dialog button is **Add link**; the first sweep matched neither, the signature modal stayed open, and every gesture after it hit the modal instead of the page. Re-run below clears modals between tools.

- modal state before re-run: []
- signature pad canvas: {"x":467,"y":377.375,"w":560,"h":190}

### 3. [OK] Signature: pad → draw → "Place signature"

> **[audit #3] verified** with the dialog-scoped pad picker: 0→1, 11 868 px², `/Stamp` with a real embedded image.

marks 12->13; placed = [{"id":"amw7b88w247","x":751,"y":230,"w":200,"h":38,"stroke":"none","fill":"rgb(0, 0, 0)","op":"1","sw":"1px"}]; armedAfter=select; leftovers=clean
- link dialog opened with an "Add link" button: true | status: Drag the clickable area, then choose a page or a URL. After one placement the tool hands control back to Select.

### 4. [OK] Link: drag → URL dialog → Add link

> **[audit #3] verified:** 0→1, URI in the file. See §3.2 for why the file paints nothing, and the `get_links()` note in §16.

marks 13->14; placed=[{"id":"amw7b8bfd4o","x":1131,"y":256,"w":140,"h":43,"stroke":"rgb(37, 99, 235)","fill":"rgba(37, 99, 235, 0.08)","op":"1","sw":"1px"}]; armedAfter=select. Link is an invisible annotation by nature — the on-page outline is the only feedback.

### 5. [OK] Redact: drag over a line of text

> **[audit #3] verified end to end**, including the deletion: the redacted string is absent from the exported page text.

marks 14->15; placed=[{"id":"amw7b8cer55","x":951,"y":458,"w":157,"h":14,"stroke":"none","fill":"rgb(0, 0, 0)","op":"1","sw":"1px"}]; armedAfter=select; summary="15 marks on 1 page(s) · 1 redaction delete text on export"

- placed rasters on the page (`<image>` elements): dom=[{"w":0,"h":0,"href":"blob:http://localhost:5311"},{"w":0,"h":0,"href":"data:image/jpeg;base64,/9j"}] fetch=[{"ok":true,"len":798},{"ok":true,"len":12218}]

### 6. [OK] Placed image / signature survive a re-render — the shared blob URL is no longer revoked out from under them

> **[audit #3] inherited.** Not re-measured over a six-operation sequence. What this pass can say: Image and Signature marks paint on canvas and export real `/Im0` appearances, so nothing was revoked before the export ran.

Every <image> on the page still resolves and has non-zero natural size. Confirms the blob-revocation fix holds for Image and Signature marks after 6 further tool operations.
- final: marks on page 1 = 15 | {"page":"1","extent":"595x842@0","exportBtn":"Export annotated PDF (15)","summary":"15 marks on 1 page(s) · 1 redaction delete text on export","selection":"amw7b8cer55","handles":["nw","ne","sw","se"],"rotate":true,"marquee":false,"noteCards":0,"noteEditor":0,"editSurface":0,"selPanel":"single","selSummary":"1 MARKS SELECTED ON PAGE 1 — REDACT ×1","emptyMarks":[],"dark":false}
- console errors this phase: []

## 1b. Arming is not the confounder: repeated markup on one page, 1 → 2 → 3

- highlight: armed=clicked/state=highlight marks 0->1 nowArmed=select
- underline: armed=clicked/state=underline marks 1->1 nowArmed=underline
- strike: armed=clicked/state=strike marks 1->2 nowArmed=select
- highlight: armed=clicked/state=highlight marks 2->2 nowArmed=highlight
- underline: armed=clicked/state=underline marks 2->3 nowArmed=select
- strike: armed=clicked/state=strike marks 3->3 nowArmed=strike

### 1. [P1] Return-to-Select does not make the palette sticky: three markup tools each create on the 1st, 2nd and 3rd use

> **[audit #3] the data is real, the diagnosis was not.** Arming was never the confounder. Two causes, both fixed: §3.1 (a resize grip eating the pen's press) and §3.6 (a flat drag along a row classified as a click). Re-measured with three uses of each tool on the same row: `0→1 1→2 2→3` for highlight, underline, strike, line and arrow.

Every line below is one full arm → drag → assert cycle on page 2, on the same text row.

```
highlight: armed=clicked/state=highlight marks 0->1 nowArmed=select
underline: armed=clicked/state=underline marks 1->1 nowArmed=underline
strike: armed=clicked/state=strike marks 1->2 nowArmed=select
highlight: armed=clicked/state=highlight marks 2->2 nowArmed=highlight
underline: armed=clicked/state=underline marks 2->3 nowArmed=select
strike: armed=clicked/state=strike marks 3->3 nowArmed=strike
```

Arming is done through `[data-tool="<id>"]` (never a text matcher, so the icon + shortcut key inside the button label cannot break it) and the click result is asserted, then `[data-armed-tool]` is read back before dragging. This is the same probe the parent ran with an anchored `/^line$/i` label matcher; with the attribute selector the failures for line/arrow survive.

## 1c. Painted geometry of the three markup tools (the "recent fix" check)

- marks on page 2 with their rule hook: [{"id":"amw7bhksy5c","rule":null},{"id":"amw7bhmed5j","rule":"StrikeOut"},{"id":"amw7bhnzs5q","rule":"Underline"}]
  - n/a amw7bhksy5c: {"gb":{"x":299,"y":91.5,"w":5.5,"h":10},"kids":[{"tag":"polygon","x":1054,"y":301,"w":2.3,"h":10,"sw":"1px","stroke":"none","fill":"rgb(255, 235, 59)","y1":null,"y2":null,"d":""},{"tag":"polygon","x":1050,"y":302,"w":1.1,"h":7.5,"sw":"1px","stroke":"none","fill":"rgb(255, 235, 59)","y1":null,"y2":null,"d":""}]}
  - StrikeOut amw7bhmed5j: {"gb":{"x":299,"y":96,"w":5.5,"h":0.5},"kids":[{"tag":"line","x":1054,"y":306,"w":2.3,"h":0,"sw":"1px","stroke":"rgb(220, 38, 38)","fill":"rgb(0, 0, 0)","y1":"96.5","y2":"96.5","d":""},{"tag":"line","x":1050,"y":306,"w":1.1,"h":0,"sw":"1px","stroke":"rgb(220, 38, 38)","fill":"rgb(0, 0, 0)","y1":"96","y2":"96","d":""}]}
  - Underline amw7bhnzs5q: {"gb":{"x":299,"y":99.0999984741211,"w":5.5,"h":1.4000015258789062},"kids":[{"tag":"line","x":1054,"y":310,"w":2.3,"h":0,"sw":"1px","stroke":"rgb(27, 27, 24)","fill":"rgb(0, 0, 0)","y1":"100.5","y2":"100.5","d":""},{"tag":"line","x":1050,"y":309,"w":1.1,"h":0,"sw":"1px","stroke":"rgb(27, 27, 24)","fill":"rgb(0, 0, 0)","y1":"99.1","y2":"99.1","d":""}]}

- ground truth for the row every mark was dragged onto (PyMuPDF, page 1 geometry = page 2 layout): glyph box y ${81.5999984741211}..${109.13999938964844} pt → screen y 291.1..318.6, baseline ≈ 316.6


### 2. [OK] Highlight / underline / strikeout land on the text they were dragged over

> **[audit #3] conclusion holds, measurement did not.** The 2.3 px / 1.1 px marks in that table cannot come from a 150 px drag (§3.4). Re-measured from the real geometry: highlight `QuadPoints` covers the row end to end (`200 629.39 … 356.71 619.39`), the underline's rule is 134.07 pt long at the bottom of its quad, the strike 78.12 pt through the middle, and each one's ink is present in the exported bytes. `tests/pdf/ux-annotation.test.ts` and `tests/pdf/annotation-editor.test.ts` now assert that from the shared `markupRule` the file also uses.

Measured with each child element `getBoundingClientRect()` because a `<g>` wrapping a horizontal line reports height 0 — that artifact is why the first sweep called underline and strike "invisible" when the mark count says they were created.

Raw measurement of every painted child is listed above against the glyph box from the PDF. Highlight paints an axis-aligned band over the row (no self-crossing bowtie), underline sits at the bottom of the glyphs, strike crosses the middle. Exported geometry is re-checked in the PDF itself in section 4.

---

# Audit #3 — the verification pass (2026-11-08)

Audit #2 was written by a run that timed out mid-sweep. Its last sections are
truncated, the "section 4" its §1c promises — re-checking the exported geometry in
the PDF itself — was never written, and its headline verdict, *12/17 tools produced
a mark*, predates every fix it was testing for: the file's own timestamp is 12:13,
while the markup-rule fixes are `6176b27` (12:28) and `875c931` (12:44) and the
Line/Arrow release fix is `b1f4a6e` (12:37). So its findings describe a HEAD that
no longer exists, and four of its five "silent" tools were silent in the harness.

Everything below was measured again on `3736594`, which includes all three of
those commits. Every finding above now carries a `**[audit #3]**` status line under
its heading; nothing was deleted.

**Harness.** CDP over headless Chromium against the dev server on 5261,
`/tmp/sample.pdf` (10-page CV, page 1 = 595.28 × 841.89 pt), viewport 1500 × 1400
at deviceScaleFactor 1 so one CSS px is one PDF point at 100 % zoom and the whole
page is on screen. The harness is in the repo now, so this pass can be run again
rather than re-invented: `docs/research/audit3-cdp.mjs` (CDP session, painted-area
probe), `docs/research/audit3-sweep.mjs` (modes: default sweep, `--proof`,
`--edge`, `--repeat`) and `docs/research/audit3-bytescan.py` (the exported bytes).
The committed copies were used for the final measurements in this file, so
re-running the pass needs only the dev server on 5261 (override with `BASE`) and a
`/tmp/sample.pdf`. One fresh document load per tool, page
cleared first, so each exported file holds exactly one annotation and the bytes
are attributable to one gesture.

**Two measurement rules this pass insists on.**

1. *Painted area, from the paint, not from the box.* For each child element of
   `[data-mark]`: `max(width, stroke-width) × max(height, stroke-width)`, counted
   only when `fill` or `stroke` is actually visible, and never for `<g>` —
   `getComputedStyle(g).fill` is `rgb(0, 0, 0)` by inheritance, so a group that
   paints nothing measures as a filled box and double-counts its children. The
   box of a horizontal `<line>` is zero tall however thick its stroke: that
   artifact, not the renderer, is what produced §2 and §3 below.
2. *The file, not the canvas, is the deliverable.* Each exported blob is fetched
   back out of the page (`URL.createObjectURL` is hooked at document start;
   headless downloads do not land here) and read with PyMuPDF. Every annotation is
   listed with its `/Rect`, `/Subtype`, `/QuadPoints`, `/L`, `/LE`, `/IC`, `/CA`
   and its `/AP /N` stream, and the page is rendered twice inside the mark's box —
   once with annotations, once with the untouched original — so "the canvas lied
   about the file" shows up as a number: `inkAnnots` (what the annotation layer
   adds) and `inkVsOrig` (what the whole file changed against the original).

## Per-tool result at `3736594` — 17 of 17

"Gesture" is what a user does with that tool, run once from an empty page;
arming is asserted through `[data-armed-tool]` before every gesture. Canvas area
is CSS px² of visible ink on the overlay; file ink is pt² measured in the exported
bytes the same way. `0.0` next to a link is honest: see §3.2.

| tool | normal gesture | marks | canvas px² | exported annotation | file ink pt² | verdict |
| --- | --- | --- | --- | --- | --- | --- |
| highlight | drag along a text row | 0→1 | 1 567 | `/Highlight`, QuadPoints 200 629.39 … 356.71 619.39, CA 0.4 | 1 570.0 | verified |
| underline | drag along a text row | 0→1 | 134 | `/Underline` + rule `0 1 m 134.07 1 l S` | 134.5 | verified |
| strike | drag along a text row | 0→1 | 78 | `/StrikeOut` + rule `0 5 m 78.12 5 l S` | 78.5 | verified |
| note | click, type, Escape | 0→1 | 745 | `/Text`, `/Contents (Audit note)` | 689.0 | verified |
| freetext | click, type, Escape | 0→1 | 13 204 | `/FreeText`, box `240 56 re f` + border + text | 1 752.5 | verified; the string extracts from the page |
| ink | freehand wave | 0→1 | 7 176 | `/Ink`, 396 B stream of `m`/`l` | 693.5 | verified |
| line | one diagonal drag | 0→1 | 7 200 | `/Line`, `/L [59.64 81.39 299.64 51.39]`, `/LE [/None /None]` | 498.2 | **was §7/§8 — fixed** |
| arrow | one diagonal drag | 0→1 | 7 751 | `/Line`, same `/L`, `/LE [/None /ClosedArrow]` on the release end | 986.8 | **was §7/§8 — fixed** |
| polygon | three clicks + double-click | 0→1 | 20 000 | `/Polygon` | 1 195.5 | verified — but *not* by one drag, see §3.3 |
| polyline | three clicks + double-click | 0→1 | 16 800 | `/PolyLine` | 704.0 | verified — same caveat |
| square | drag a box | 0→1 | 18 000 | `/Square` `1 1 178 98 re S` | 1 201.5 | verified |
| circle | drag a box | 0→1 | 15 000 | `/Circle` (bezier `c` ops) | 1 008.8 | verified |
| stamp | click | 0→1 | 9 635 | `/Stamp`, text `Approved` | 1 263.2 | verified |
| image | click, choose PNG | 0→1 | 38 400 | `/Stamp` with `/Im0 Do`, 240 × 160 cm | 38 480.0 | verified |
| signature | click, draw in pad, Place signature | 0→1 | 11 868 | `/Stamp` with `/Im0 Do` | 2 210.5 | verified |
| link | drag, URL, Add link | 0→1 | 3 726 | `/Link` `/A << /URI (https://example.com/audit) >>` | 0.0 | verified as a link; see §3.2 |
| redact | drag over a text row | 0→1 | 1 776 | `/Redact` `0 0 148 12 re f` **and** the burn in the page content | 12.0 layer / 1 990.0 file | verified; `CYBERJAYA` is gone from the exported text |

Console/exception output for the whole sweep: none. Every file starts `%PDF-1.7`
and round-trips through PyMuPDF.

## 3.1 [fixed, `1851dfc`] A resize grip of the previous mark ate the next tool's press

The boring candidate from the brief, and the one that was still live at the HEAD
I was given. `[data-resize-hit]` and the rotate knob are 22 px squares sitting on
the corners of whatever is selected, and they were rendered for **every** armed
tool, each calling `stopPropagation` on `pointerdown`. So: draw a Line, then draw
another starting near the end you just released — where a hand naturally goes —
and the press grabbed the corner. Measured before the change, two drags in a row:

```text
#3 second line, press on the previous end  created=0  endpoints moved=true
```

The first mark's geometry changed, no second mark appeared, and Line stayed armed
because the gesture had created nothing: `armedAfter=line, added=0`, which is the
shape of §7 and §8. After the change, `created=1, endpoints moved=false`, and a
Line drag created at every one of twelve release points tried — inside the page,
200 px past its right edge, and below the old 1000 px fold
(`node docs/research/audit3-sweep.mjs --edge`, all twelve `created:1`; before the fix the same
sweep alternated `1,0,1,0` because the fixed press point was the corner of
whatever the previous probe had left selected). Handles and the knob are Select's
chrome now; the selection outline stays painted under a pen, so *which* mark
Delete and the inspector will act on is still visible. UX-BRIEF's own line —
"Nothing clickable looks inert" — argues the same way from the other side: a grip
the armed tool will not honour should not be painted.

## 3.2 [not a defect, worth knowing] A link's appearance stream is empty

The exported `/Link` carries `/AP << /N >>` whose form stream is exactly `q Q` —
four bytes that draw nothing — so the blue outline and the URL label the canvas
paints are authoring chrome and the file is invisible, which is the PDF
convention for links and matches what the re-run's finding 4 concluded above. Recording the number
because the audit's method is "the bytes decide": `inkAnnots = 0.0 pt²` for link
is expected, not a lie. (If a visible link is ever wanted, this stream is where
it goes.)

## 3.3 [new, P3] Polygon and PolyLine do not take a drag, and §11/§12 measured one that did not happen

`gesture: 'vertices'` adds one corner per press and finishes on Enter or a
double-click (`tools.ts:185`, `AnnotationOverlay` `onDoubleClick`). Measured with
one plain drag — the gesture §11 and §12 recorded — the result is
`createdByOneDrag: 0, armedAfter: polygon`, and the shape only appears when the
drag is closed (`afterDoubleClick: 1`). The 140 × 60 box §11 reports for Polygon
is the harness's own drag rectangle, the same numbers §9 and §10 report for
Square and Ellipse, so those two findings were never measuring what they said.
The tools themselves work; the claim needed correcting.

## 3.4 [new, P3] `[data-page-extent]` is a toolbar chip, not the page

The hook list at the top of §1 includes `[data-page-extent]` as a geometry
anchor. It is a 72 × 15 px `<span>` in the page toolbar
(`AnnotationEditor.tsx:2428`); its rect has nothing to do with the page. Any
harness that drags "relative to the page extent" drags across the toolbar and
then reports that the tool is broken — which is exactly what happened to the
first probe of this pass, and is a plausible contributor to §1's verdicts. The
page's own box is `canvas` / `[data-tool-gesture]`, both of which this pass uses.

## 3.5 [still open, filed] Things this pass found but did not change

Filed in `docs/tasks/segment-request.md`: exporting swaps the editor for the
shared result screen, so a per-tool byte check has to reload the document between
tools, and its *Download* is a button calling `downloadBlob` rather than an
`<a download>`, so a harness reads the bytes by hooking `URL.createObjectURL`.
Also filed there: `HANDLE_HIT_PX` is 22 px while UX-BRIEF's pointer rules ask for
targets of ~28 px, which is a number for the brief's owner rather than a
diff for this pass.

Two harness traps, each of which cost this pass a false finding and both of
which belong to the next auditor of this screen: a dialog left open swallows
every later gesture (that is how a redact drag came back as `created 0` here, and
how audit #2's first sweep lost signature, link and redact), and assigning
`input.value` does not reach a controlled React field — the type-in surfaces carry
`data-editing-surface` and `data-note-editor`, so drive them with real key
events. `Input.insertText` lands; `element.value = …` exports an empty box, and
the app is right to warn about it.

## 3.6 [fixed, `3736594`] A flat drag along a line of text was classified as a click

`MIN_DRAG_PX`'s own comment says "a drag smaller than this is treated as a
click"; `isMeaningfulDrag` implements that as size on **both** axes, so a drag
that covers 143 px of words with 0 px of height — the most normal markup gesture
there is — failed it and was taken for a click. `finishDrag` then looked for a
mark under that "click", found the one already on those words and stopped:

```text
highlight: 0→1, then "Selected Highlight · p.1 · “Muhammad Luqman Hakim Razlan”
           instead of drawing a second mark." × 2
```

which is §1b's alternation, reported there as a palette problem. Split into the
two questions — `isClickGesture` (did the pointer travel?) and `isMeaningfulDrag`
(does this describe a box?) — and moved the markup decision into
`markupTapTarget` so it is testable where it happens. `rectFromDrag` keeps the
box predicate, so a click still gets a default box. Select's marquee now honours
a flat band and paints it, instead of reading a horizontal sweep as a click that
drops the selection.

## Claims in audit #2 that turned out to be false

Re-measured personally unless marked *inherited*.

1. **§2 and §3 — "underline / strike produces no visible mark" (`area=0px`).**
   False as evidence: the hook measured element boxes, and a horizontal `<line>`
   box is zero tall. The marks painted the whole time. §1c found this and the
   status lines now say so; §2 and §3 stay in the file as the artifact they are.
2. **§1 verdict — "12/17 tools produced a mark. Silent: line, arrow, signature,
   link, redact".** Four of those five were harness artifacts, and line/arrow
   were fixed after the measurement. At `3736594` it is 17/17.
3. **§7 and §8 — "line / arrow produce no visible mark from a normal gesture".**
   True when measured (12:13, before `b1f4a6e`), false as of the HEAD this pass
   was given. The brief's "line and arrow create nothing from a normal drag" was
   stale by one commit — but the family of bug was real and still alive in a
   different place, which is §3.1 above.
4. **§18 / §1 / §2 (second run) — the box-vs-endpoints cause.** Correct, and the
   fix is in `b1f4a6e`; `a8e0d09` moved the rule into one named, tested function
   (`dragGesturePayload`) because a builder test that hands in `points` itself can
   never catch the release forgetting them.
5. **§11 and §12 — "polygon works / polyline works" from a drag.** False: they do
   not take a drag at all (§3.3). Their tool-level verdict was right by
   accident of the harness's numbers.
6. **§1b — "Return-to-Select does not make the palette sticky" with data showing
   markup failing on the 2nd and 3rd use of the same row.** The alternation was
   real, the reading was wrong: it was not arming. Two causes, both now fixed —
   the grip of the still-selected mark (§3.1) and a flat drag along a text
   row being classified as a click (§3.6 above, `3736594`). Re-measured with
   `--repeat`: three uses of the same tool on the same row each create —
   highlight `0→1 1→2 2→3`, underline, strike, line and arrow the same.
7. **§1c's raw measurement** — marks 2.3 px and 1.1 px wide, and the claim that
   they were "dragged onto" a whole text row. Impossible for a 150 px drag; see
   §3.4. The conclusion of §1c (the rule sits where the text is) is
   nevertheless true, and is now asserted numerically in
   `tests/pdf/ux-annotation.test.ts` against the shared `markupRule`.
8. **§1c's promise of "section 4"** — it was never written; the file ended
   mid-sentence-structure. The tables above are that section.
9. **From the brief, not the file:** *"this is a DIFFERENT bug from the rules
   one; do not assume the geometry work explains it"* — correct, and worth
   stating loudly because the geometry work did **not** explain it. And
   *"/tmp/v4mark.mjs as the CDP starting point"*: that script arms with
   `/^line$/i` against `innerText + aria-label`, which does not match the Line
   button (`innerText` is `"📏\nLine"`); run against 5261 it returned `false`
   and left the tool on `highlight`, so a probe built on it silently drags with
   the previous tool armed. Use `[data-tool="<id>"]`.

## What is re-measured and what is inherited here

**Re-measured on `3736594`:** every row of the 17-tool table (gesture, arming,
mark count, canvas painted area, exported `/Subtype`, `/Rect` and key entries,
file ink by rendering the file with and without annotations and against the
untouched original); the §1b repeat-use claim; the §18 line/arrow cause; the
off-page and off-window release sweep; the handle-swallow repro before and after;
the click-vs-drag classification before and after; cold-load arming
(`highlight`, as §1 says); the 18-button palette; the disabled-at-zero export
button; zero console errors during the sweep.

**Inherited, not re-checked:** the blob-revocation finding (§6) — this pass
confirms Image and Signature export real `/Im0` appearances but did not re-run
the "six further tool operations" survival test; the PyMuPDF glyph-box ground
truth quoted in §1c; every statement about pages 2-10 of the sample CV; all of
§1's per-finding prose written before this pass (marked as such by its own
status lines); the claim in the brief that CI deploys `875c931`.

**Fixed by this pass:** §3.1 (grips under a pen, `1851dfc`), §3.6 / the
flat-drag click (`3736594`), and the untested release seam (`a8e0d09`).

