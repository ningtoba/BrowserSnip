# `edit-pdf-text` — what is broken, measured, and what fixes it

Spec and evidence for the in-place text editor's two user reports:
*"editing a text literally draws boxes on top of current text"* and
*"the font is changed"*. Written so the work can be resumed without the notes in
someone's head. Every number below comes from the rig in this directory; the
commands are at the bottom.

## 1. Phase 1 — why `removeTextInRects` fails, by cause

Corpus: eight documents, one producer each (`text-edit-fixture.py`). 734 text
blocks. Each block deleted **on its own** and, separately, the whole pipeline run
(`applyEdits` → save) and judged off the produced file.

"Before" is commit `b6f985b`, i.e. the shipped behaviour.

| cause | fixture that shows it | blocks before | after |
| --- | --- | --- | --- |
| text drawn inside a **Form XObject** — the walker never entered one, so the page read as having no text | `forms.pdf` (plain wrap, and nested with a `/Matrix`, 15 forms) | **192 of 192 not deleted at all** | 0 |
| **the numbers in a `TJ` array were ignored** — `[(left) -3600 (right)] TJ` paints `right` 43 pt along; measuring it beside `left` puts every rect in the wrong place | `distilled.pdf` (`gs pdfwrite` of the CV), `kerned.pdf` | **41 not deleted + 31 partial** | 0 |
| **showing text displaced the line matrix** as well as `Tm`, so every later line slid along the page (`(and field?)'` measured at x 177 for words printed at x 50) | `distilled.pdf` | inside the 31 partial above | 0 |
| **a partially covered operator was dropped whole** — editing one column deleted the column beside it | `kerned.pdf`, `distilled.pdf`, `sample.pdf` | **168 blocks lost 4 196 characters that were not theirs** (2 057 kerned, 2 086 distilled, 53 sample) | 0 |
| **standard-14 widths were indexed by position in a dense `CharMetrics` list** instead of by glyph name, so non-embedded Helvetica measured ~9 % too wide (262 pt for a run that paints 242.3) | every fixture with a base-14 font | tail of each line outside its own deletion box; survivors of an excision re-embarked up to 28 pt right | 0 |
| **`needsRasterFallback` invented a cause** — it fired on "heavily mixed `TJ`" and on any page holding one Type3 glyph | `cid.pdf`, `paper.pdf`, `scan.pdf`, `type3.pdf` | 4 of 4 single-block files reported "sits on image content the engine cannot repaint" with no image on the page | named reasons instead |

Cases that turned out **not** to be causes: kerned per-glyph `TJ` arrays as such
(positions are right once the numbers are applied), Type3 glyphs (deletable — it
is *re-encoding* them that fails), a run split across several show operators, and
invisible mode-3 OCR text.

Not counted as a fix, because it is not one: a block that could not be cleaned is
**skipped** by `applyEdits`, so its old words stay in the file and the new text is
never written. The "box" the user saw was the on-screen overlay — committed blocks
are painted in the page's own sampled colour over a canvas that still shows the
original bytes. `writePatchObject`'s rectangle is used for covering page *images*
and vector shapes, not for failed text. So the honest repair was (a) make deletion
work, (b) stop the screen claiming a finished edit for a block the export will
skip, (c) when a patch genuinely is needed, size it to the glyphs it hides.

## 2. Phase 2 — keeping the document's font

Measured before the change: **734 of 734** blocks were re-set in bundled Noto Sans
or a standard-14 face chosen by the editor, whatever the page used.

Reuse needs three answers about the source font, all readable from the file being
edited (`SourceFont` in `core/content.ts`, filled from the walker's per-glyph
`fontSource`):

1. **Can it spell the text?** its own code↔Unicode map — `/ToUnicode` for a CID
   font, `/Encoding` `/Differences` or the standard encoding for a simple one —
   reversed (`codeOf`).
2. **Does it give that code a width?** a subsetter leaves 0 behind, and a viewer
   paints .notdef.
3. **Does the embedded program actually hold the glyph?** `fontkit` on
   `/FontFile2`/`FontFile`/`FontFile3`, its cmap first and `CIDToGIDMap` (or the
   Identity mapping) second. A font with **no** program (a bare `/Helvetica`
   reference) skips this test — every viewer brings the whole face. A program that
   cannot be read is treated as *unknown*, and unknown means do not reuse: the
   failure mode is invisible, so guessing is not free.

Refusals, each reported per block with the font and the reason:

| reason | when | wording the user gets |
| --- | --- | --- |
| missing characters | the subsubset lacks them — 192 of 192 blocks on `distilled.pdf` | `EKJMMI+Helvetica-Bold could not be kept (the embedded subset has no glyphs for: # Q Z z), so this text is set in noto.` |
| weight / slant | the user asked for bold or italic and the face's `/BaseFont` says neither | `…has no bold weight…` |
| Type3 | glyph outlines are content streams; they cannot be re-encoded | `…is a Type3 font, which cannot be re-encoded` |
| family picked | the user chose a family in the Format panel | not a swap, so not reported |

Also pinned: faces are cached per style **and per text** — spellability is a
property of the text, and measuring a block in a face that cannot write it lays
out words the file then drops.

## 3. Left open, measured here

1. **Our own writer's subset is broken, independently of this row.** A Noto subset
   emitted by `UnicodeFaceEmbedder` (`core/fonts.ts`) — and by pdf-lib's own
   subsetter — carries glyph data that MuPDF, pdf.js *and* fontTools all fail to
   read past the second included glyph: `#`/`A`/`4` ink 1 213 / 1 042 / 961 px,
   `B`/`—`/`Z` ink **0**, while the text still extracts correctly (so copy and
   Ctrl-F are fine and the eye is not). Identical at `b6f985b` and at the tip, so
   it is not a regression from this row — but it *is* a "boxes where text should
   be" report, it lives in a file this row owns, and it only bites on the
   substitution path, which is one more argument for keeping the page's own face.
   Repro: `docs/research/text-edit-proof.mjs /tmp/tf/type3.pdf`, or
   `page.drawText` one character at a time with a `getFont(..., 'noto')` face and
   count ink per word with PyMuPDF.
2. **Re-flow is reported, not fitted.** A block whose new text needs more lines
   than it came from is announced (`no longer fit the lines they came from`) and
   drawn downward from its origin; it can run past the space the producer had.
3. **A form reached through an inherited `/Resources` is copied per page.**
   Correct, and 300 copies on a 300-page document.

## 4. Re-running the numbers

```sh
python3 docs/research/text-edit-fixture.py /tmp/tf          # the eight producers
(nohup npx vite --port 5311 --strictPort >/tmp/5311.log 2>&1 &)
BASE=http://localhost:5311 node docs/research/text-edit-probe.mjs /tmp/tf /tmp/tf/out
python3 docs/research/text-edit-measure.py /tmp/tf/out          # the verdict table
python3 docs/research/text-edit-measure.py /tmp/tf/out --json   # + per-block detail
BASE=http://localhost:5311 node docs/research/text-edit-proof.mjs /tmp/tf/sample.pdf
python3 docs/research/text-edit-revert.py                       # red count per reverted fix
```

`text-edit-measure.py` judges the produced file, not the engine: whether each
source word can still be found, whether each laid-out piece is painted at its own
x, baseline and size, which face draws it (`/BaseFont` read back out of the file),
and whether any filled rectangle was added. Against the pre-fix build, check the
same rig out at `b6f985b` (the probe falls back where a newer field is missing).
