# TOOL TRIAGE — every tool in the catalogue, driven and measured

**Running tally — 130 of 130 ids accounted for: 5 BLANK OR WRONG OUTPUT (2 closed — `repair`
since `2ca815b`, and `txt-to-pdf` by `c2226b5` with its marker rig in `abdbbd5`) · 4 FALSE CLAIM ·
3 CONTROL INERT · 11 ERRORS/NO-OP ON VALID INPUT ·
81 CLEAN (MEASURED) · 26 NOT REACHED.**
Coverage: every one of the 130 ids was driven in real Chromium against the deployed site, and
**all 427 field flips of the PDF catalogue were run** (288 of them produced a file to compare,
139 stopped at a required input or a bespoke pane). ~750 runs in total across
`/tmp/triage/runs-{base,repair,verify,flips,disc}.jsonl` — working state, not committed, and
reproducible with `bash docs/research/triage-sweep.sh`; each id is named exactly once below. The id list is `docs/research/triage-tool-list.txt` — 130 lines,
one per tool, derived from `TOOL_CATALOGUE` in `src/lib/pdf/tools/registry.ts` (aliases folded,
so `redact`/`compare` do not double-count) plus the eight video ids from `src/lib/constants.ts`.
122 PDF + 8 video = 130, which is the number the deployed page prints in its footer
(`122 tools` on the PDF dashboard, `08 tools` on the video one, `130` on the landing page).
Everything was driven against `https://www.browsersnip.com`, the deployed build of `d3d32e3`.
No source file was modified.

**Rank order inside each bucket is by damage.** The eight video tools sit in NOT REACHED:
their panels load the clip and paint their controls, but every action returns
*“Could not finish — Codec probe in progress — wait a moment and try again.”* with the file card
still on `Probing codec…` after 420 s, so no ffmpeg output has been measured for any of them.
The first pass appeared to produce one only because the probe kept the panel's *input preview*
blob (same SHA in and out) — a harness bug, now fixed, and the reason those eight are listed as
a gap rather than as eight clean tools.

## How each row was produced

* **Driver** — `docs/research/colour-rail.mjs`, the probe `colour-measure.sh` already uses for
  the four colour tools, extended with a batch mode (`SPEC=…`): open the route, upload the
  fixture through CDP, write every field the run asks for *by the words the rail prints beside
  it*, read each value back out of the DOM before the click, press the run, then take the
  produced files by pressing the result card's own Download buttons and keeping the bytes that
  pass through `downloadBlob`. One Chromium for the whole sweep; no second harness.
* **Measurement** — `docs/research/rail-measure.py --triage`: page count, per-page non-white ink
  off the raster, text characters, image/link/annotation/widget counts, page boxes and
  rotations, and a **content digest** that ignores pdf-lib's timestamp so "the control changed
  nothing" is a comparison rather than a guess. Images are measured through PIL, ZIPs
  member-by-member, video through ffprobe, and an output a reader cannot open is reported as
  *unmeasured* rather than as blank.
* **Inputs** — `docs/research/triage-fixtures.mjs` regenerates the campaign's own discriminating
  fixtures into one directory and adds the rest: `colour.pdf` (text page + colour page + a page
  with **no `/Contents`** + a `/Rotate 90` page; max ink 56.93 %), `ink.pdf` (text, photograph,
  one 0.1 pt hairline, empty), `sheets.pdf` (five different page boxes), `a.pdf`/`b.pdf` (one
  planted 340×40 pt difference), `blanks.pdf` (eight sheets whose ink is 23.80 / 0.00 / 48.66 /
  0.00 / 0.00 / 0.21 / 0.00 / 0.38 %), `table.pdf` (a ruled 5-row grid), `scanned.pdf`
  (image-only, for OCR), `locked.pdf`/`locked128.pdf`/`lockedrc4.pdf` (AES-256 / AES-128 / RC4,
  user `reader-pass`, owner `owner-pass`), `form.pdf` (3 widgets), `annot.pdf` (note, free-text,
  highlight, link), `attach.pdf` (one embedded file), `layers.pdf` (two OCGs), `js.pdf`,
  `meta.pdf`, `bookmarked.pdf` (3-entry outline), `repaired-target.pdf` (damaged xref),
  `heavy.pdf` (6 photo pages), real rasters, office/ebook containers built by
  `tests/pdf/convert-to-harness.ts`, and a 3-second 320×240 H.264+AAC clip.
* **Specs** — `docs/research/triage-spec.mjs` reads each tool's own field list (label, type,
  bounds, options, `required`, `when`) out of the registry and emits one run per tool at its
  defaults, plus `--repair` reruns for the tools whose first answer came from the fixture rather
  than the tool. The control-flip pass (`--flips`, one run per field) **ran all 427 PDF-catalogue
  fields**: 288 produced a file whose content digest could be compared with the same tool's
  default run, and 139 stopped at a required input or a bespoke pane. Eleven of the 288 came back
  byte-equal; three are accused in CONTROL INERT and eight are cleared there with the run that
  shows the control does move.
* **Harness gaps this sweep found and closed in the probe** (all in `colour-rail.mjs`, none in
  `src/`): a bespoke pane's own file input is now found by retrying every `input[type=file]`
  until the app repeats the file's name back; a `file` field's picker is addressed by a marker
  attribute on the element its label resolved to, with the document handle re-read after the
  write (a stale node looks set and is not); and "a blob exists" no longer counts as "the run
  answered", because preview strips make object URLs while the tool is still at 5 % — which is
  what made the first `pdf-to-pdfa` and `ocr-pdf` rows read as if they had finished.

---

## BLANK OR WRONG OUTPUT

*file produced, but pages or ink contradict the source or the promise. Highest severity:
silently wrong.*

### 1. `unlock` — the unlocked file has four pages and no content on them

* Runs: `locked128.pdf` (AES-128, 4 pages, source max ink **56.93 %**, 1 792 text chars) →
  `locked128_unlocked.pdf`, **2 983 bytes**; `lockedrc4.pdf` (RC4-128) → **2 801 bytes**.
* App's line: *"Removed protection — the file opens without a password now: 4 page(s), page
  content verified, carrying no form fields, comments, bookmarks or embedded files."*
* Bytes: `needs_pass 0`, `is_encrypted false` — the password really is gone — but **every page
  measures 0.00 % ink and 0 characters**, and the reader says why: MuPDF logs
  `zlib error: incorrect header check` on each content stream and poppler logs
  `Unknown compression method in flate stream` / `Bad FCHECK in flate stream`. The streams are
  still ciphertext under a `/FlateDecode` filter, so the document opens as four blank sheets.
* "page content verified" is the sentence that hurts: the verification ran in the same tab that
  wrote the bytes, on the still-encrypted view of them.
* Third case: the AES-256 file (`locked.pdf`) is refused outright — *"That password is not
  correct for 'locked.pdf'"* — with **both** the user password and the owner password. See the
  `protect` row: the app writes the same broken v5/r6 dictionary it cannot read back.

### 2. `repair` — a file that three readers still open as 4 pages comes back as 1 blank one

* Input `repaired-target.pdf` (the colour fixture with its xref offset and `%%EOF` mangled):
  MuPDF opens it and reports **4 pages** (with content-stream syntax errors logged), poppler's
  `pdfinfo` reports 4 pages, source max ink **56.93 %**.
* Output: **1 page**, max ink **0.00 %**, 0 characters, 1 658 bytes. The card prints
  `PAGES 1` — no `→` — and the sentence is *"Repaired repaired-target.pdf: 1 page(s) readable."*
  Nothing says three pages were lost.
* Control run, same tool, undamaged input (`colour.pdf`): 4 pages in → 4 pages out, ink 56.93 %
  preserved, *"Repaired colour.pdf: 4 page(s) readable. 3.8 KB → 2.2 KB (-42%)"*. So the
  behaviour is specific to the damaged file, not to the measurement.
* Severity: this is the tool a user reaches for *because* a file looks broken, and its answer is
  a plausible file with less in it than the broken one.
* **Closed since `2ca815b`, on a corpus rather than this one file.** The cause was two-deep:
  `repairPDF` never rebuilt the cross-reference it advertised — on a parse throw it fell to a
  regex harvest of `stream…endstream` payloads — and that harvest pasted `/FlateDecode`
  ciphertext into a page whose dictionary claimed plaintext, after round-tripping every byte
  through `TextDecoder('latin1')` (windows-1252, so 0x80-0x9F come back changed). It now rebuilds
  the index over the file's own objects, decodes what it harvests, and scores each candidate on
  sheets that hold a drawing operator. The report says what it gave up: this input's own shape,
  re-generated by script, now answers *"Repaired ledger-32-input.pdf: 4 page(s) recovered: 3
  still hold content, 1 is blank."* and all four outside readers open 4 sheets at
  24.5 / 19.8 / 0.0 / 57.0 % ink — the input's own profile — where the run above produced 1 sheet
  at 0.00 %. Nine damage classes (truncated tail, lying `/xref`, missing `startxref`, wrong
  `/ObjStm` offsets, duplicate and missing `endobj`, garbage in a content stream, this shape on
  two bases) are measured before and after in `docs/research/repair-damage-{app,readers,pdfjs}.log`
  and pinned by `tests/pdf/repair-damage.test.ts`; see the `repair` row of `docs/TOOL-CAMPAIGN.md`.

### 3. `protect` — an `/Encrypt` dictionary that MuPDF and Ghostscript will not open

* Run: `colour.pdf` (4 pages, max ink 56.93 %) → `colour_protected.pdf`, **2 695 bytes**, card
  `PAGES 4 → 4`, `3.8 KB → 2.6 KB · 31% smaller`.
* App's line: *"Protected with AES-256 and an open password. As written to the file: printing
  allowed (any resolution), editing allowed, copying allowed, comments allowed, form filling
  allowed, screen readers allowed, page assembly blocked. Re-read by the built-in engine only;
  no independent reader could confirm the gate."*
* Bytes: `/V 5 /R 6 /Length 256` with 32-byte `/O` and `/U` and **no `/OE`, `/UE` or `/Perms`**
  (which PDF 2.0 r6 requires), while `/CF/StdCF` declares **`/CFM /AESV2` with `/Length 16`** —
  the 128-bit filter. Measured outside the app: **MuPDF cannot open it at all**
  (`FileDataError: encryption dictionary missing owner encryption key`), **Ghostscript 10.08
  dies** (`Unrecoverable error, exit code 1`), **poppler prints** `Syntax Error: Invalid
  encryption key length … ownerEncIsString: 0, ownerEncLength: 18446744073709551615` and then
  recovers with 4 pages. So pages-in/pages-out of the protected copy are **unmeasured**, not
  zero-ink: no independent reader would open the file to measure it.
* The card's third warning is a defect of its own: *"No PDF reader could be started in this
  browser to re-check the saved file (Invalid argument for stringToBytes)"* — the self-check
  throws and reports the throw rather than checking.
* Same writer path is used by `change-permissions` (its own FALSE CLAIM row below) and is the
  reason `unlock` cannot read an AES-256 file it was given.

### 4. `txt-to-pdf` — 968 of the source's 2 861 characters reach the file

* Run: `doc.txt` (46 lines, **2 861 chars**, plain ASCII) → `doc_from_text.pdf`, 21 396 bytes,
  two A4 sheets (595.28 × 841.89 pt), ink 0.82 % on page 1 and 4.21 % on page 2.
* Measured out of the produced file: **968 characters** — page 1 **159**, page 2 **809** — and
  page 2 stops mid-line at `12 A repeated line` of 40 numbered lines. **34 % of the file
  arrived; no line of the report says one was lost.**
* App's line: *"Typeset 1 text source(s) into 2 page(s)."* — true of the page count, and the
  page count is what hides the loss (`PAGES 2`, with no in-side to compare to).
* Family check on the same sheet: `markdown-to-pdf` wrote 168 chars from a 221-byte source, `html-to-pdf` 102 of 419, `rtf-to-pdf` 130 of 239, `xml-to-pdf` 106 of 170, `word-to-pdf` 95 from a 1 520-byte DOCX — those are markup doing what markup should. `doc.txt` has no markup to lose, which is why the truncation is pinned to this tool alone.
* **Closed by the `txt-to-pdf` row of `docs/TOOL-CAMPAIGN.md` (`c2226b5`, rig `abdbbd5`).** Not a
  size cap: one missing page turn. `core/layout.ts` `renderBlocks` asks once whether a paragraph
  or quote block fits the space left — `if (needs(height)) await turn()` — and then paints every
  wrapped line from wherever the block began, so a block taller than a sheet continues below
  `y = 0`, where the content stream holds the words and no reader shows them. On a source built to
  be counted (120 numbered rows, 8 800 bytes, markers at 0/25/50/75/100 %), MuPDF reads
  **724 characters off 2 sheets with 51 of 482 text runs inside a page box**, the first missing
  marker at byte 1 770; the same fixture after the fix is **7 131 characters off 12 sheets,
  492 of 492 runs in a box**, ending on row 120, and the sentence's page count is the file's.
  Both tables are committed: `docs/research/text-tail-{before,after}.txt`, produced by
  `docs/research/text-tail-rig.test.ts` and judged by `text-tail-measure.py`.
* The branch is shared, so the truncation was never unique to plain text: markdown, HTML, XML and
  Word showed the same 724/818-of-8 800 shape on one tall block and now land every marker.
  `csv`, `json` as a list, `xml` as items, `word` as paragraphs, monospace and one-paragraph-per-line
  sources were unaffected before and after — measured, not assumed.
* Two findings measured and left for their own branches, with the numbers: **a Markdown list item
  taller than a sheet** (818 characters of 8 802, 2 sheets, 52 of 426 runs in a box, first missing
  `MK25` at byte 1 771) and **a table cell taller than a sheet** (`json-to-pdf` over
  `{"note": "<one 8 800-byte string>"}`: **16 characters of 7 365**, 3 sheets, 4 of 510 runs in a
  box). Both are the same missing per-line turn in `renderList` / `renderTable`.
* A tab was costing the whole file on the text route — one `\t` in a proportional run threw
  `WinAnsi cannot encode "\t"` and produced **no PDF at all** — and is now expanded to spaces the
  way the code branch already expands them at draw time. Markdown keeps its throw (`marked` holds
  the tab inside the run) and is reported, not fixed, here.
* The one limit that survives is now in the tool's own notes instead of being found by the user: a
  single word longer than the column is not broken, so of a 7 980-character word **99 characters**
  are inside the page box. The page count is not capped: a 298 921-byte source reaches 349 sheets
  with its last line on the last one.

### 5. `flatten-pdf` — annotation flattening does nothing to the annotations, and says it did

* Run A, `form.pdf` (4 pages, **3 widgets**, 0 other annotations) → `form_flattened.pdf`,
  4 pages, **0 widgets**: the form half is real and measured. The card still prints
  *"0 annotation(s) drawn into the content of 0 page(s) and 3 form field(s) removed…"*
  **and** a warning about comments that this file does not contain.
* Run B, `annot.pdf` (4 pages, **3 annotations on page 1 + 1 link annotation**, 0 widgets) →
  `annot_flattened.pdf`, 4 pages, **3 annotations still live**, 0 links, 0 new drawings
  (`draw` 9 in and 9 out, `imgs` 0 and 0). Nothing was drawn into the content; the marks were
  only carried across.
* App's line for that run: *"0 annotation(s) drawn into the content of 0 page(s) and 0 form
  field(s) removed from the form; **4 comment(s) still live** in the saved file."* — beside
  *"This PDF had nothing of the selected kind to flatten, so the file is effectively
  unchanged."* A file with four live annotations is described as having nothing to flatten.
* The tool's promise is *"annotations drawn into the page content"*; on this input the pages are
  byte-for-byte as unflattened as they arrived, so the promise is denied by the output while one
  of the two warnings contradicts the other.
* Copy defect in the same sentence, measured verbatim:
  *"The comments could not be drawn into the page content (**Expected instance of oe, but got
  instance of Jt**), so they were left as live annotations…"* — minified exception text inside a
  user-facing warning. On the deployed build from run A it reads *"Expected instance of me, but
  got instance of undefined"*. `ErrorPanel.readableMessage` exists precisely to keep that class of
  string off the page, and the warning path does not go through it.
* **Closed by `cc19e56`, and the two exception strings were the two causes.** Re-measured on this
  tree first (`0c1df4c`), because `core/flatten.ts` had not been touched since the feature landed:
  `drawAppearance` asked `context.lookup(appearanceRef, PDFDict)` for the object `/AP /N` names,
  an appearance is a **stream** (`PDFRawStream extends PDFStream extends PDFObject`), and the
  fork's `lookup` throws `UnexpectedObjectTypeError` on a class mismatch rather than answering
  undefined — so the first annotation with an appearance ended the whole pass, and
  `PDFDocument.load`'s own `Annots()` answering undefined for a blank sheet was the
  `got instance of undefined` variant. The bake now resolves the stream through the three shapes
  PDF writes it in, copies its operators into the page with `inlineFormXObject` (the seam
  `flattenForm` already uses, so the mark's words stay searchable), carries `/Rotate`, `/CA` and
  `/BM` through the page's own graphics state because those belong to the annotation and not to
  its stream, and only then drops the object from `/Annots` — with its `/Popup`, which left behind
  is an orphan every reader still lists as a comment. `doc.getForm()` is no longer called at the
  end of the pass: on a document with no form it *creates* one.
* Judged by ink, not by the absence of an error (`docs/research/flatten-readers.py`, same fixture
  either side of the fix, each mark's own box measured with MuPDF twice — once as displayed, once
  with `annots=False` so only page content is painted). Ink at the note's box
  `0.0 → 98.67`, the highlight `0.0 → 96.64`, the ink stroke `0.0 → 6.01`, the square
  `0.0 → 99.99`, the 40 % square on the `/Rotate 90` sheet `0.0 → 100.0`; annotations `5 → 0`,
  widgets `3 → 0`, `AcroForm /Fields` `3 → 0`; page ink as displayed `1.3 / 2.34 / 0 / 1.53 %`
  before and after, and *content-only* comes to the same four numbers. Before the fix those same
  boxes measured 0.0 content-only while the annotation still painted them.
* What is deliberately **not** flattened, counted and said: a mark with no appearance to copy, one
  flagged `Invisible`/`Hidden`/`NoView` (a viewer never paints it, so baking it prints ink the
  user never saw), a `/Link` the "keep clickable" toggle keeps, and every `/Widget` — widgets
  belong to the form pass, and drawing one here left `/AcroForm /Fields` naming a field whose box
  had vanished, which is neither interactive nor flattened. The promise line is unchanged
  ("comments baked wherever they have an appearance to draw — the result counts what is still
  live") because that is now what the bytes do; the dead `Resolution` slider went, since its help
  promised re-drawing at a dpi nothing read.
* The contradictory sentence is fixed at its cause: "nothing of the selected kind to flatten" is
  now compared against what the **input** held, and a library exception never reaches the card —
  the warning says what was left live and the counts come from re-reading the saved file.
* Pinned by `tests/pdf/flatten-truth.test.ts` (15) per annotation kind, reading the page's own
  content streams back with `node:zlib`. Nine reverts, each run: the `PDFDict` lookup restored
  turns **10** red, the missing-`/Annots` guard **5**, the unpainted-flag guard 2, and the popup
  carry, the `/CA` state, the widget guard and the `getForm()` side effect 1 each.
* **Re-measured on the deployed site** after CI `42762230426`, through the rail's own `Flatten`
  button with the default toggles: *"5 annotation(s) drawn into the content of 3 page(s) and 3
  form field(s) removed from the form; nothing of the selected kind is left live."* with no console
  error, and the download read back by MuPDF and pypdf answers annotations `5 → 0`, widgets
  `3 → 0`, fields `['Signature1','answer','tick'] → []`, page ink unchanged, the form's answer
  still extractable from the sheet. The one entry pypdf still counts — `[0, 1, 0, 0]` per page — is
  the `/Link` the "keep clickable links" toggle was asked to leave live.
* **Re-measured on the deployed site** after CI `42762230426`, through the rail's own `Flatten`
  button with default toggles: the card prints *"5 annotation(s) drawn into the content of 3
  page(s) and 3 form field(s) removed from the form; nothing of the selected kind is left live."*
  with no console error, and the download read back by MuPDF and pypdf answers annotations
  `5 → 0`, widgets `3 → 0`, fields `['Signature1','answer','tick'] → []`, page ink unchanged, the
  form's answer still extractable from the sheet. The one entry pypdf still counts — `[0, 1, 0, 0]`
  per page — is the `/Link` the "keep clickable links" toggle was asked to leave live.

---

## FALSE CLAIM

*output fine; the report line, `promise` or `notes` asserts something the bytes deny.*

### 1. `change-permissions` — names the cipher the file does not carry

* Run: `locked128.pdf` — **AES-128** — with the owner password → `locked128_permissions.pdf`,
  3 306 bytes, `PAGES 4 → 4`.
* App's line: *"Restrictions as recorded in the file (AES-256): printing allowed (any
  resolution), editing allowed, copying allowed, comments allowed, form filling allowed, screen
  readers allowed, page assembly blocked."*
* Bytes: the output's `/Encrypt` dictionary is `/V 4 /R 4` with `/CFM /AESV2` — that is
  AES-128 — and the sentence names it AES-256. The permissions themselves are reported as the
  dictionary says, and the produced file is the broken v5/r6 shape again, so it could not be
  re-opened by MuPDF to check the page content (`unmeasured`, not blank).
* Why it matters: the tool's promise is "the result reports what the saved file actually
  recorded", and the one word it adds — the cipher — is the one the bytes contradict.
* **Already fixed by `9d064f5`, re-measured on this tree (`f111c00`).** The same run —
  `tests/fixtures/encrypted/aes-128-user.pdf`, owner secret, print/copy/modifying off,
  assembly on — now answers *"Restrictions as recorded in the file: printing blocked, editing
  blocked, copying blocked, comments blocked, form filling allowed, screen readers blocked, page
  assembly allowed. A PDF reader opens it with no password: 3 page(s) readable."* No cipher is
  named at all (`9d064f5` deleted `(${cipherName})` from the line rather than guessing at it), the
  saved `/Encrypt` is `/V 4 /R 4 /CFM /AESV2`, and this app's own guard reads it back as
  `AES-128`. Pinned in `tests/pdf/edge-security.test.ts`: the message may not match
  `/AES|RC4|\b256\b|\b128\b/`, and the flags it names have to be the flags `/P` holds.

### 2. `bates-numbering` — the card prints the first file's page count as the job's

* Run: `colour.pdf` + `sheets.pdf` (9 pages between them) with `perFile` at its default →
  **two** files, `colour_bates.pdf` (4 pages) and `sheets_bates.pdf` (5 pages), 8 228 bytes
  together.
* Card: `PAGES 9 → 4`, beside *"Applied 9 Bates numbers across 2 files."* and the warning
  *"The last number written was 000009."*
* Bytes: 4 + 5 = **9 pages out**, and 9 numbers written. The `→ 4` is page 1 of the two-file
  result's first member (`RunOutcome.pagesOut` for a multi-file job), printed in the row the
  user reads as "pages in your file, pages out". The sentence is right and the number beside it
  is wrong by 5 pages.
* **Real on this tree, fixed in the sentence by `f111c00`; the number itself is another seam's
  contract.** Re-measured with 4 + 5 sheets: `pagesOut` 4, outputs 4 and 5 pages, message
  *"Applied 9 Bates numbers across 2 files."* `RunOutcome.pagesOut` means *the primary output* by
  design — `tests/pdf/pages-out.test.ts` pins this very tool with "reports the first produced
  document, never a sum of both" — while `pagesIn` is summed over every loaded file in
  `usePdfTool`, so the `in → out` row compares a total against one member. Moving either half is
  a shared-UI decision (`ResultCard` / `usePdfTool` / that pinned contract), not a byte this entry
  owns. What the entry can do is refuse to let the row stand alone, and it now says
  *"Applied 9 Bates numbers across 2 files (colour_bates.pdf 4 pages, sheets_bates.pdf 5 pages)."*
  — counts read off the documents that were saved, with `pagesOut` unchanged at 4. Both halves
  pinned in `tests/pdf/edge-edit.test.ts`.

### 3. `extract-pages` — "Extracted 4 pages of 4 pages" beside its own contradiction

* Run: `colour.pdf`, the rail's default `Pages = all` → `colour_extracted.pdf`, 2 208 bytes,
  4 pages in → 4 out, ink and text preserved (56.93 %, 1 792 chars).
* App's lines, in this order on the same card: *"Extracted 4 pages of 4 pages."* and
  *"You selected every page, so the extracted file matches the original's content (4 pages)."*
* The output is correct — a control run with `Pages = 2-3` gives `Extracted 2 pages of 4 pages.`
  with 2 pages out, so the sentence is only false in the all-pages case, where nothing was
  extracted *out of* anything. Recorded as a copy defect, not an output defect.
* **Real on this tree, fixed by `f111c00`.** The whole-document case now reads *"Copied all 4
  pages into a new file."* and the note keeps to what the run does hold — the page count and the
  order — instead of asserting that the content matches, which is `notePageCopy`'s business when a
  rebuild loses something. `Pages = 1-3` still reads *"Extracted 3 pages of 4 pages."* Pinned in
  `tests/pdf/edge-organize.test.ts`.

### 4. `remove-annotations` — counts five marks and two pages where the file has four and one

* Run: `annot.pdf`, rail `Pages = 1-2` → `annot_clean.pdf`, 4 pages in → 4 out, 3 309 bytes.
* Bytes: the source carries **3 annotations** (sticky note, free-text, highlight) and **1 link
  annotation**, all four inside page 1 — per-page annots `[3, 0, 0, 0]`, links `[1, 0, 0, 0]`.
  The output has `[0, 0, 0, 0]` and `[0, 0, 0, 0]`: everything selected is gone, which is the
  behaviour, and pages 2-4 had nothing to remove.
* App's line: *"Removed 5 annotations from 2 pages."* Both numbers are contradicted by the file
  it just wrote: **four** marks were removed, from **one** page.
* The count comes from the operator/display-list scan rather than from the annotation array the
  output loses, so a highlight that also paints and a link that pdf.js lists twice are counted
  as marks; the "pages" half counts pages it looked at, not pages it changed.
* **Real on this tree, fixed by `f111c00` — with the cause one step away from the hypothesis.**
  The count *does* come from the annotation array (`removeAnnotations` removes entries from
  `/Annots`); the fifth entry is the sticky note's own **`/Popup`**, which sits in the array but is
  not a mark a reader lists — MuPDF reports `Text, FreeText, Highlight` plus the link, four, over
  the five objects in page 1's array. The "pages" half was exactly as recorded: `pages.length`, the
  selection. Now both are what the file says: *"Removed 4 annotations and 1 note pop-up from 1
  page."*, pop-ups named apart and pages counted by whose array actually shrank. Pinned in
  `tests/pdf/edge-edit.test.ts` against a fixture that carries the popup.

---

## ERRORS / NO-OP ON VALID INPUT

### 1. Seven organize tools refuse any document containing a page with no `/Contents` — including the app's own output

One cause, seven shipped tools, all measured on the deployed site with the same file
(`colour.pdf`, 4 pages, of which page 3 is the fixture's *empty* sheet):

| tool | what the user gets |
| --- | --- |
| `rotate-custom` | `COLOUR.PDF — Can't embed page with missing Contents` |
| `n-up` | same sentence |
| `booklet` | same sentence |
| `combine-single-page` | same sentence |
| `posterize` | same sentence |
| `divide-pages` | same sentence |
| `fix-page-size` | same sentence |

* The input is legal: `pdfinfo` reads it as 4 pages, MuPDF rasterises all four (the empty sheet
  measures 0.00 % ink because it has nothing to draw), and its page 3 simply carries **no
  `/Contents` key at all** (`page.get_contents() == []`) — which is what PDF says a blank page
  looks like.
* Cause pinned by re-running the same seven on `heavy.pdf` (6 pages, every page has a content
  stream): **all seven succeeded** — `rotate-custom` 6 → 6 pages *"Turned 6 pages by 2°
  clockwise"*, `n-up` 6 → 3 *"Placed 6 pages on 3 sheets (2 per sheet)"*, `booklet` 6 → 4,
  `combine-single-page` 6 → 1, `posterize` 6 → 24 tiles, `divide-pages` 6 → 12,
  `fix-page-size` 6 → 6. And re-running `n-up` on `bookmarked.pdf` (the colour fixture plus an
  outline, so still holding the no-`/Contents` page) brings the error back: the outline is not
  the trigger, the empty page is.
* Why this is worse than a fixture curiosity: **the app writes such pages itself.**
  `add-blank-page` produced `colour_with_blanks.pdf` (4 → 5 pages) in this same sweep, and
  `organize`'s blank sheet is written the same way — so a blank page added here cannot be
  imposed, tiled, divided, re-sized or turned by these seven tools afterwards.
* The refusal is at least loud: an `role=alert` panel with the sentence, a `Retry` button, and
  no file. Nothing is silently wrong here — but a legal file is turned away.

### 2. `remove-restrictions` refuses every password-protected file, and has no place to type the password

* Runs: `locked.pdf` (AES-256), `locked128.pdf`, `lockedrc4.pdf` — three schemes, one answer:
  *"LOCKED128.PDF — 'locked128.pdf' is password protected. Enter the password for
  'locked128.pdf' and run again."*
* The tool declares **zero fields** (`catalogue.json`: `remove-restrictions` f0), so there is no
  field to enter it in, and the surface's `Still needed:` line is the last word the user gets.
  Its promise — *"Every restriction lifted — the copy opens, prints, copies and edits without a
  password or an owner key"* — is unreachable for any file that is protected by a password,
  which is most of the files the tool is asked about.
* Not inferred: three different ciphers, same refusal, no output blob in any run.
* **Stale on this tree: the refusal is gone and the box exists.** Re-measured against
  `tests/fixtures/encrypted/` — libqpdf 12.3.2 and MuPDF 1.28.2 as producers, RC4-128
  (`/V 2 /R 3`), AES-128 (`/V 4 /R 4 /CFM /AESV2`) and AES-256 (`/V 5 /R 6 /CFM /AESV3`),
  each as a **user-password** file and, where that producer wrote one, an **owner-only**
  file: 40 runs of `remove-restrictions` / `unlock` / `change-permissions` through the
  shipped `runPdfTool`, **40 files produced**. The row's cause was the read path, not the
  tool: `core/crypto.ts` undoes all three strengths on load and the file's own card has
  held a password box for every tool with no field of its own since the password-anywhere
  pass. Judged by other people's readers on the produced bytes, with **nothing typed**
  (`docs/research/remove-restrictions-readers.py` → `-readers.log`, with the 40 files it judged committed in `docs/research/remove-restrictions-produced/`): no `/Encrypt` key and
  no `/P` survive, MuPDF answers `needs_pass=False` and `permissions=-4` — every
  restriction bit set — the planted sentence is still on 3 of 3 sheets, sheet-1 ink is the
  fixture's own 1.51 %, `qpdf --check` is clean on 40 of 40, and `hunter2` appears in
  neither the bytes nor the download name. So the promise is reachable, and the copy is
  **fully open** — the dictionary goes, which takes the user password with it; the sibling
  that lifts restrictions and keeps a dictionary is `change-permissions action: set`, whose
  10 files carry `/P = -3104` where every fixture arrived at `-3376`, and lift those flags
  under MuPDF only for the owner secret the tool was given (`auth=4 permissions=-4`; the
  empty user secret answers `auth=2` with the flags still in force, a wrong one `auth=0`).
  What still refuses,
  and owns the refusal: nothing typed on a file with a non-empty **user** secret asks for it
  (`PASSWORD_REQUIRED`, `passwordRequired=true`), and AES-256 under a handler revision this
  app does not derive is refused by `core/guard.ts`, naming
  `AES-256 (crypt filter /StdCF, revision 5)` — never by the tool's own `validate`, which
  it does not have. Pinned by `tests/pdf/remove-restrictions.test.ts` (34 cases, one per
  strength and producer); forcing `classifyEncryption` to answer `supported: false` for
  AES-256 reddens 16 of them, which is what makes the pin worth having. On the deployed
  build the same run is driven end to end by `scripts/live-remove-restrictions-proof.mjs`
  (`docs/research/remove-restrictions-deployed.log`): the card names the lock, the box on
  that card takes the secret, and the 2 816-byte download answers
  `has_encrypt_key False`, `qpdf_check_exit 0`, `mupdf_permissions -4`,
  `mupdf_planted_pages 3`, `secret_in_bytes False` — with the owner-only file answering the
  same shape at 2 701 bytes and nothing typed.

### 3. `font-to-outline` — the optional engine is reached and fails on a plain text page

* Run: `colour.pdf` → no file; alert: *"COLOUR.PDF — Ghostscript could not be reached, so
  nothing was outlined: Ghostscript stopped with exit code 1: GPL Ghostscript 10.06.0:
  Device 'pdfwrite' requires an output file but no file was specified. / **** Unable to open
  the initial device, quitting."*
* Measured, and worth separating from an "engine unavailable" case: the wasm Ghostscript
  **loaded and ran** — this is a wrong invocation (`pdfwrite` without `-sOutputFile=`), not a
  missing download. The card's `ENGINE` row is absent because no output was produced, while
  `pdf-to-pdfa` in the same sweep shows `ENGINE Ghostscript` and a real file, so the engine
  itself is fine.

### 4. `extract-attachments` · `edit-attachments` — cannot see an attachment that is there

* Input `attach.pdf`: the catalogue holds one file, and the bytes say so —
  `Names → EmbeddedFiles → FileSpec (note.txt, /EF /F 12 0 R)` — and MuPDF answers
  `embfile_names() == ['note.txt']`.
* `extract-attachments` produced no file and reported: *"No attachments found. — This PDF
  contains no embedded files."* `edit-attachments` refused: *"ATTACH.PDF — This PDF has no
  attachments to edit."*
* The two tools also disagree with the app's own writer in the other direction:
  `add-attachments` was driven here and the rerun (below) is the chain that will say whether
  the reader only recognises what `pdf-lib` wrote. Recorded as measured-on-this-input, cause
  not inferred.

### 5. A note on tools that start blocked — which is the design, not a defect

(These two are counted in CLEAN below, where their produced files are measured; they are
described here so the blocked first run is not mistaken for an entry in this bucket.)

* With the rail's default empty selection `split` and `remove-pages` both print
  *"Still needed: …"* and the run button stays disabled; given `1-2` and `1` they answered `Created 1 file from 4 pages.` (2 pages out,
  1 960 bytes) and `Removed 1 page, kept 3 pages.` (3 pages, 1 248 bytes). Listed here so the
  blocked first run is not mistaken for a failure, and counted once — under CLEAN below, where
  the numbers are.


---

## CONTROL INERT

*a field the user can set that provably changes nothing — each one proven by changing the
value, reading it back out of the DOM, and diffing the produced file's content digest (which
ignores pdf-lib's timestamp, so "identical" means identical and not "same size").*

**Re-measured against this tree (post-`d3d32e3`), row by row:** row 1 was real and is
fixed (`1941921`); row 2 does not reproduce — the choice reaches the bytes, and what is
actually unreachable on that surface is the entry's `Fit` select, which the pane pins to
`contain`; row 3 was real and is fixed (`ff66110`). The census that asked *how big the
class is* is `docs/research/inert-field-sweep.md`, with its numbers, pinned as
`tests/pdf/inert-field-sweep.test.ts`.

### 1. `cbz-to-pdf` — `Page size` never reaches the page boxes

| run | rail value, read back out of the DOM | page boxes in the produced file |
| --- | --- | --- |
| default | `select=a4 of a4/letter/legal/a3/a5/tabloid` | **420 × 300, 640 × 200, 24 × 24** |
| Page size = US Letter | `select=letter of a4/letter/legal/a3/a5/tabloid` | **420 × 300, 640 × 200, 24 × 24** |
| Page size = A5 | `select=a5 of …` | **420 × 300, 640 × 200, 24 × 24** |

* Input `photos.cbz`: three real photographs (420×300, 640×200, 24×24 px) — not the harness's
  1×1 pixel archive, where every page is 100 % ink whatever the tool does.
* All three outputs are 15 355 bytes with **identical page geometry** and identical images; only
  `/CreationDate` differs (`3b56da5f27` / `1e6ac3cace` / `93412f7178` are the file shas, the
  content digests are equal).
* The card is the same in all three: *"3 comic pages → 3 PDF page(s)."* — the field is a
  chooser between three answers, one of which is what always happens ("hug each image").

### 2. `scan-to-pdf` — the rail's `Page size` is overridden by the pane's own state

*Does not reproduce on this tree (`f4cb8f5`'s re-measurement): `scan-to-pdf` answers on a
bespoke surface, so no generated rail is mounted at all — the `Page size` select a
visitor touches *is* the pane's, and driving it writes `letter` 612 × 792 pt,
`a4` 595.28 × 841.89 pt and `fit` the capture plus the margin. Pinned by
`tests/pdf/inert-controls.test.ts`, which mounts `ScanTool` and reads the boxes back. The
 residue this row was reaching for: the entry declares a three-way `Fit` select that no
 surface renders while the pane sends `fit: 'contain'` on every run.*

* Default run (rail reads `select=a4`, the field's own default): page box **612 × 792 pt** —
  US Letter, not A4 (595 × 842).
* Run with `Page size` set to `letter` and read back (`select=letter of a4/letter/fit/original`):
  page box **612 × 792 pt**, image rect **10.0, 184.6, 602.0, 607.4** — *the same numbers*.
* So the rail's A4/Letter/Fit/Original select changes nothing; the pane (`ScanMain`) keeps its own
  size state, which is what the file gets. Both cards say
  *"Built a 1 page PDF from 1 capture; each page is a photograph, so it is not searchable until
  you run OCR."* with `PAGES 1` and 73.7 KB — a 1-byte difference between the two runs
  (75 428 vs 75 429), which is the timestamp, not the geometry.

### 3. `sanitize-pdf` — `Remove JavaScript and automatic actions` cannot see the document's action

*Real, and worse than "cannot see the document's action": the pass deleted `JS`,
`JavaScript` and `AA` keys **on** each dictionary it enumerated, so every inline action —
`/OpenAction << /S /JavaScript /JS (…) >>` written inside the catalogue, an annotation or
field `/A` written inside its owner — was invisible to both the counter and the stripper,
and the tool reported "no script references were present" over a file that runs code on
open. Turning the switch off said nothing at all, and with every switch off the card
printed the empty sentence "Nothing to remove: ." Fixed in `ff66110` (`core/sanitize.ts`
walks the entries that *run* actions and counts the same set it removes); the five shapes
— catalogue `/OpenAction`, page `/AA`, annotation `/A`, referenced field `/A`, named
script — are proved gone with the switch on, proved present with it off, and named in the
sentence either way by `tests/pdf/inert-controls.test.ts`.*

* Input `js.pdf`: `/OpenAction << /S /JavaScript /JS (app.alert('triage')) >>` in the catalogue,
  confirmed out of the file (`xref_get_key(catalog,'OpenAction')` before and after).
* Run with the toggle at its default **on**: output keeps the `/OpenAction` dictionary, byte for
  byte (2 424 bytes). Run with the toggle **off**: the same 2 424 bytes, the same `/OpenAction`,
  identical content digest.
* Both cards say *"Nothing to remove: no script references were present, no embedded files were
  present, there was no XMP packet to remove."* — while the help line for the field promises
  *"Removes the /OpenAction and /JS entries a document runs when it opens."*
* The same file answers the other two toggles correctly, which is what makes this one a dead
  switch rather than a broken tool: on `attach.pdf`, `Remove embedded files` on → **2 615 bytes
  and no `/EmbeddedFiles`**, off → **2 694 bytes with the file still inside**; on `meta.pdf`,
  `Remove XMP metadata` on → **2 651 bytes with 0 bytes of XMP left**, off → **2 658 bytes and the
  fixture's 233-byte packet still in the file** (both keep the Info `/Title`, which this field does
  not claim).

### Cleared, not accused: the other ten flips that looked inert on the first digest

The rows below are named by their **field**, not by a tool id, because they are the audit trail of
what the digest flagged and the follow-up run cleared — not members of this bucket.

| field (tool) | why the digest matched anyway, and the run that proves it works |
| --- | --- |
| Remove JavaScript, on a file with no script (`sanitize-pdf` / `annot.pdf`) | the file genuinely has none |
| Largest angle to correct, Confidence needed (`deskew-pdf`) | a 6° tilt is corrected at both 10° and 23°: the residual is 0.00° either way. Lowered to **2°** the tool refuses (*"Nothing to do: no page was tilted past 2° at a confidence of 0.35"*) and `deskew-residual.py` measures **−6.00°** left in the file — the control moves, at 2° versus 10° |
| Flate-compress, Object streams, Drop orphans (`optimize-pdf`) | the tool returns the **original bytes** and says so: *"Already tight: a rebuild would give 79.8 KB from 79.6 KB, so the original is returned."* Identical output is the designed answer, not an inert switch — but it also means this fixture cannot discriminate them; a file with a large raw stream would |
| File format (`pdf-to-cbz`, `pdf-to-image`) | the sweep's chip value was wrong for these two fields (`<PREFIX>-<PAGE:4>` — a `bates-numbering` format string leaking through a shared key name, since fixed in `triage-spec.mjs`), so no chip was pressed and the readback proves it: `group: JPG*|PNG` before **and** after. Re-pressed properly: PNG → **801 KB**, JPG → **944 KB** |
| Pages (`extract-images`) | the only embedded image in `ink.pdf` is on page 2, which both selections include. Selecting **3-4**, where there is no image, produced no file and a report-only answer |
| Page size look-alikes (`cbz-to-pdf`, `scan-to-pdf`, `pdf-to-cbz`) | see the three findings above: `cbz-to-pdf` and `sanitize-pdf` were real and are fixed; the `scan-to-pdf` row does not reproduce, and what that surface really leaves unreachable is its `Fit` select |

---

## CLEAN — MEASURED

Sorted by category, then by the order the dashboard lists them. Ink is the maximum per-page non-white coverage at 100 dpi, source against output; `—` means the file has no pages to measure (an image, a ZIP, a text export) or no reader could open it (see the row's own note).

| tool | pages in → out | source ink → output ink (max %) | text chars out | produced files | the app's line |
| --- | --- | --- | --- | --- | --- |
| `merge` | 9 | 9 | 95.73 → 95.73 | 3185 | pdf 9p 5368B | “Merged 2 files into 9 pages.” |
| `split` | 4 | 2 | 56.93 → 21.76 | 1792 | pdf 2p 1960B | “Created 1 file from 4 pages.” |
| `remove-pages` | 4 | 3 | 56.93 → 56.93 | 13 | pdf 3p 1248B | “Removed 1 page, kept 3 pages.” |
| `organize` | 4 | 4 | 56.93 → 56.93 | 1792 | pdf 4p 2226B | “(no line captured)” |
| `rotate` | 4 | 4 | 56.93 → 56.79 | 1792 | pdf 4p 2301B | “Rotated 4 pages by 90°.” |
| `reverse-pages` | 4 | 4 | 56.93 → 56.93 | 1792 | pdf 4p 2209B | “Reversed 4 pages.” |
| `add-blank-page` | 4 | 5 | 56.93 → 56.93 | 1792 | pdf 5p 2233B | “Inserted 1 page at position 5 — the file now has 5 pages.” |
| `alternate-merge` | 9 | 9 | 95.73 → 95.73 | 3185 | pdf 9p 5233B | “Mixed 9 pages from 2 files.” |
| `duplex-collate` | 4 | 4 | 56.93 → 56.93 | 1792 | pdf 4p 2209B | “Collated 4 pages from a 2 + 2 scan.” |
| `overlay-pdf` | 9 | 4 | 95.73 → 67.83 | 3185 | pdf 4p 8577B | “Overlaid 4 pages with "sheets.pdf".” |
| `remove-blank-pages` | 8 | 7 | 49.04 → 49.04 | 1900 | pdf 7p 80055B | “Removed 1 page (2), kept 7 pages.” |
| `pdfs-to-zip` | 9 | 0 | 95.73 → — | 0 | zip 3 entries 5398B | “Packed 2 PDFs (9.1 KB) into one ZIP.” |
| `pdf-to-cbz` | 4 | 0 | 53.09 → — | 0 | zip 4 entries 944205B | “The file came out bigger than the one you started with. Nothing was overwritten — download the original unless you need this variant.” |
| `pdf-compress` | 6 | 6 | 97.05 → 97.06 | 1812 | pdf 6p 37482B | “Compressed 79.6 KB → 36.6 KB (-54%). 1 of 1 image(s) re-encoded, 0 left untouched.” |
| `optimize-pdf` | 4 | 4 | 56.93 → 56.93 | 1792 | pdf 4p 2294B | “Losslessly tidied 3.8 KB → 2.2 KB (-41%). no uncompressed stream was large enough to be worth compressing; no unreferenced objects were found.” |
| `rasterize-pdf` | 4 | 4 | 53.09 → 53.45 | 0 | pdf 4p 775012B | “Rasterised 4 page(s) to JPEG at 200 dpi. 183 KB → 757 KB (+314%).” |
| `linearize-pdf` | 4 | 4 | 56.93 → 56.93 | 1792 | pdf 4p 2294B | “Rebuilt with object streams and 0 newly compressed stream(s): 3.8 KB → 2.2 KB (-41%). This is not a conforming linearized PDF.” |
| `pdf-to-pdfa` | 4 | 4 | 56.93 → 56.93 | 1792 | pdf 4p 3366B | “Wrote PDF/A-2B identification (pdfaid:part=2, conformance=B), an sRGB output intent and the tagging flag. 3.8 KB → 3.3 KB (-14%).” |
| `deskew-pdf` | 1 | 1 | 11.55 → 9.42 | 3640 | pdf 1p 6903B | “Straightened 1 page(s): 1 (tilt -6.00°, turned 6.00° clockwise). 7.1 KB → 6.7 KB (-5%).” |
| `page-numbers` | 4 | 4 | 56.93 → 57.03 | 1840 | pdf 4p 3399B | “Numbered 4 pages, 1 to 4.” |
| `watermark` | 4 | 4 | 56.93 → 56.93 | 1816 | pdf 4p 3540B | “Watermarked 4 pages.” |
| `header-footer` | 4 | 4 | 56.93 → 57.84 | 2128 | pdf 4p 5025B | “Added headers and footers to 4 pages.” |
| `add-page-labels` | 4 | 4 | 56.93 → 56.93 | 1792 | pdf 4p 2329B | “Applied 2 label ranges. The first 4 pages now read: i, ii, iii, 1.” |
| `bookmarks` | 4 | 4 | 56.93 → 56.93 | 1792 | pdf 4p 2455B | “Wrote 1 bookmark (1 top-level one), replacing the 3 bookmarks already in the document.” |
| `table-of-contents` | 4 | 5 | 56.93 → 56.93 | 1845 | pdf 5p 3244B | “Inserted a 1 page table of contents at page 1, listing 3 entries from the outline.” |
| `background-color` | 4 | 4 | 56.93 → 99.71 | 1792 | pdf 4p 3236B | “Painted a #f7f7f4 background behind 4 pages.” |
| `text-color` | 4 | 4 | 56.93 → 56.93 | 1792 | pdf 4p 8686B | “Recoloured 27 text runs to #000000.” |
| `invert-colors` | 4 | 4 | 56.93 → 100 | 0 | pdf 4p 393383B | “Inverted 4 pages at 200 dpi. Text is now part of the image, so it is no longer selectable or searchable.” |
| `adjust-colors` | 4 | 4 | 56.93 → 57.23 | 0 | pdf 4p 393090B | “Adjusted 4 pages at 200 dpi. Text is now part of the image, so it is no longer selectable or searchable.” |
| `scanner-effect` | 4 | 4 | 56.93 → 56.95 | 0 | pdf 4p 483865B | “Applied the scanner effect to 4 pages at 220 dpi. Text is now part of the image, so it is no longer selectable or searchable.” |
| `ocr-pdf` | 3 | 3 | 35.53 → 35.53 | 204 | pdf 3p 106799B | “Added 33 recognised words to 1 page as an invisible layer — the scan looks unchanged but the text is now selectable and searchable.” |
| `form-filler` | 4 | 4 | 56.93 → 56.93 | 1800 | pdf 4p 4222B | “(no line captured)” |
| `compare-pdfs` | 6 | 3 | 8.03 → 8.68 | 60 | pdf 3p 86069B | “Compared 3 pages of "a.pdf" against "b.pdf" and painted the differences onto the copy.” |
| `view-metadata` | 4 | 0 | 56.93 → — | 0 |  | “Finished — nothing to download, the answer is in the report” |
| `edit-metadata` | 4 | 4 | 56.93 → 56.93 | 1792 | pdf 4p 3414B | “Updated the document properties.” |
| `remove-metadata` | 4 | 4 | 56.93 → 56.93 | 1792 | pdf 4p 2171B | “Removed 9 properties, XMP packet.” |
| `validate-signature-pdf` | 4 | 0 | 56.93 → — | 0 |  | “Finished — nothing to download, the answer is in the report” |
| `image-to-pdf` | 0 | 2 | 0 → 96.95 | 0 | pdf 2p 170532B | “The file came out bigger than the one you started with. Nothing was overwritten — download the original unless you need this variant.” |
| `jpg-to-pdf` | 0 | 1 | 0 → 32.38 | 0 | pdf 1p 165212B | “The file came out bigger than the one you started with. Nothing was overwritten — download the original unless you need this variant.” |
| `png-to-pdf` | 0 | 1 | 0 → 32.36 | 0 | pdf 1p 6018B | “Each page is one flat image: there is no text layer to select or search, and colour profile, EXIF and GPS metadata are dropped.” |
| `webp-to-pdf` | 0 | 1 | 0 → 32.38 | 0 | pdf 1p 215707B | “The file came out bigger than the one you started with. Nothing was overwritten — download the original unless you need this variant.” |
| `bmp-to-pdf` | 0 | 1 | 0 → 32.36 | 0 | pdf 1p 6018B | “Each page is one flat image: there is no text layer to select or search, and colour profile, EXIF and GPS metadata are dropped.” |
| `tiff-to-pdf` | 0 | 2 | 0 → 33.13 | 0 | pdf 2p 9750B | “Each page is one flat image: there is no text layer to select or search, and colour profile, EXIF and GPS metadata are dropped.” |
| `psd-to-pdf` | 0 | 1 | 0 → 23.4 | 0 | pdf 1p 21507B | “Each page is one flat image: there is no text layer to select or search, and colour profile, EXIF and GPS metadata are dropped.” |
| `svg-to-pdf` | 0 | 1 | 0 → 8.13 | 0 | pdf 1p 4075B | “The file came out bigger than the one you started with. Nothing was overwritten — download the original unless you need this variant.” |
| `markdown-to-pdf` | 0 | 1 | 0 → 2.89 | 168 | pdf 1p 2516B | “Rendered 1 Markdown source(s) into 1 page(s).” |
| `html-to-pdf` | 0 | 1 | 0 → 2.63 | 102 | pdf 1p 1712B | “Laid out 1 HTML source(s) into 1 page(s).” |
| `csv-to-pdf` | 0 | 1 | 0 → 2.21 | 74 | pdf 1p 1746B | “Tabulated 1 file(s) into 1 page(s).” |
| `json-to-pdf` | 0 | 2 | 0 → 13.57 | 284 | pdf 2p 5123B | “Reported 1 JSON file(s) into 2 page(s).” |
| `xml-to-pdf` | 0 | 1 | 0 → 0.55 | 106 | pdf 1p 1516B | “Printed 1 XML file(s) into 1 page(s).” |
| `rtf-to-pdf` | 0 | 1 | 0 → 0.55 | 130 | pdf 1p 6809B | “Converted 1 RTF file(s) into 1 page(s).” |
| `word-to-pdf` | 0 | 1 | 0 → 0.37 | 95 | pdf 1p 1291B | “Converted 1 document(s) via mammoth (bundled, offline) into 1 page(s).” |
| `excel-to-pdf` | 0 | 1 | 0 → 2.02 | 48 | pdf 1p 1515B | “Converted 1 worksheet(s) into 1 page(s).” |
| `powerpoint-to-pdf` | 0 | 2 | 0 → 0.52 | 40 | pdf 2p 1296B | “Converted 1 presentation(s) via OOXML reader into 2 page(s).” |
| `epub-to-pdf` | 0 | 2 | 0 → 0.36 | 71 | pdf 2p 1641B | “Reflowed 1 ebook(s) into 2 page(s).” |
| `email-to-pdf` | 0 | 1 | 0 → 5.56 | 318 | pdf 1p 3271B | “Printed 1 message(s) into 1 page(s).” |
| `digitize-document` | 0 | 1 | 97.09 → 83.55 | 0 | pdf 1p 165205B | “The file came out bigger than the one you started with. Nothing was overwritten — download the original unless you need this variant.” |
| `pdf-to-text` | 4 | 0 | 56.93 → — | 1802 | text 1802B | “Extracted 262 words from 4 page(s).” |
| `pdf-to-markdown` | 4 | 0 | 56.93 → — | 1793 | text 1793B | “Wrote 4 lines of Markdown from 4 page(s).” |
| `pdf-to-json` | 4 | 0 | 56.93 → — | 13449 | text 13449B | “The file came out bigger than the one you started with. Nothing was overwritten — download the original unless you need this variant.” |
| `prepare-pdf-for-ai` | 4 | 0 | 56.93 → — | 2027 | text 2027B | “Produced 1 reference document(s) from 4 page(s), ready for an index.” |
| `pdf-to-csv` | 1 | 0 | 1.01 → — | 107 | text 109B | “Extracted 1 table(s) totalling 5 rows.” |
| `extract-tables` | 1 | 0 | 1.01 → — | 759 | text 759B | “Finished — one file ready to download” |
| `pdf-to-excel` | 1 | 0 | 1.01 → — | 0 | zip 11 entries 17344B | “The file came out bigger than the one you started with. Nothing was overwritten — download the original unless you need this variant.” |
| `pdf-to-word` | 4 | 0 | 56.93 → — | 0 | zip 22 entries 8888B | “Wrote a Word document from 4 page(s). Text is editable; original positions are not preserved.” |
| `pdf-to-svg` | 4 | 0 | 56.93 → — | 6251 | text 4933B, text 699B, text 202B (+1 more) | “The file came out bigger than the one you started with. Nothing was overwritten — download the original unless you need this variant.” |
| `extract-images` | 4 | 0 | 53.09 → — | 0 | img 220px 207664B | “The file came out bigger than the one you started with. Nothing was overwritten — download the original unless you need this variant.” |
| `pdf-to-image` | 5 | 0 | 95.73 → — | 0 | zip 5 entries 401412B | “The file came out bigger than the one you started with. Nothing was overwritten — download the original unless you need this variant.” |
| `pdf-to-png` | 5 | 0 | 95.73 → — | 0 | zip 5 entries 401412B | “The file came out bigger than the one you started with. Nothing was overwritten — download the original unless you need this variant.” |
| `pdf-to-jpg` | 5 | 0 | 95.73 → — | 0 | zip 5 entries 405959B | “The file came out bigger than the one you started with. Nothing was overwritten — download the original unless you need this variant.” |
| `pdf-to-webp` | 5 | 0 | 95.73 → — | 0 | zip 5 entries 214024B | “The file came out bigger than the one you started with. Nothing was overwritten — download the original unless you need this variant.” |
| `pdf-to-bmp` | 5 | 0 | 95.73 → — | 0 | zip 5 entries 316445B | “The file came out bigger than the one you started with. Nothing was overwritten — download the original unless you need this variant.” |
| `pdf-to-tiff` | 5 | 0 | 95.73 → — | 0 | img 1166px 33335440B | “The file came out bigger than the one you started with. Nothing was overwritten — download the original unless you need this variant.” |
| `pdf-to-greyscale` | 4 | 4 | 56.93 → 56.93 | 1792 | pdf 4p 9026B | “Converted 36 colour operation(s) to grey across 4 page(s). Text stays selectable.” |
| `page-dimensions` | 4 | 0 | 56.93 → — | 0 |  | “Finished — nothing to download, the answer is in the report” |
| `odt-to-pdf` | 0 | 1 | 0 → 0.24 | 58 | pdf 1p 1118B | “Converted the OpenDocument text file with selectable text into 1 page(s).” |
| `ods-to-pdf` | 0 | 1 | 0 → 2.49 | 34 | pdf 1p 1350B | “Converted the OpenDocument spreadsheet with selectable text into 1 page(s).” |
| `odp-to-pdf` | 0 | 2 | 0 → 0.13 | 44 | pdf 2p 1298B | “Converted the OpenDocument presentation into 2 page(s).” |
| `xps-to-pdf` | 0 | 2 | 0 → 0.1 | 47 | pdf 2p 1363B | “Converted the XPS document with selectable text into 2 page(s).” |
| `fb2-to-pdf` | 0 | 1 | 0 → 0.8 | 143 | pdf 1p 1835B | “Converted the FictionBook file with selectable text into 1 page(s).” |
| `pdf-crop` | 4 | 0 | 56.93 → — | 0 |  | “The page shows only the rectangle you keep, on every page you select.” |

---

## NOT REACHED

*Could not be driven in this pass, with the reason and what it would take. Never counted as
clean.*

| tool | what was tried, and what stopped it |
| --- | --- |
| `sign` | Upload now lands in the pane (`colour.pdf · 4 pages · placing on page 1`), and its `Place signatures` button is **disabled** until a mark exists. Needs a drawn stroke or a typed name in the pane's own canvas: a pointer drag on `SignMain`, then the button. |
| `redact-pdf` | File loads; the pane reports `0 MARKS · 0 REGIONS · DRAG ACROSS WORDS` and mounts no run button at all. Needs a drag rectangle over a word (`RedactMain`), then its apply/export. |
| `add-stamps` | Bespoke (shares `AnnotationEditor`); with the stamp picked from the rail the action button stayed disabled — a stamp has to be *placed* on the page first. Needs one click/drag in the editor canvas. |
| `edit-pdf` | Same editor surface; it mounted a run button and left it disabled (`Drag across the words — the mark snaps to each text line it crosses`). Needs a mark placed through the toolbar. `docs/research/edit-pdf-audit.md` is the prior measurement for this pane. |
| `edit-pdf-text` | The text editor mounts **no** run button of the kind the probe presses; its empty state offers only `⬆ Select PDF file`. Needs the pane's own block-open → rewrite → save sequence, which is what `text-campaign-repro.mjs` does — that script is the handle, and this pass did not use it. |
| `form-creator` | The pane's `Save form` button is disabled until a field exists, and the rail field the sweep wrote (`Fields`) is **`NO CONTROL`** on this route — the bespoke pane does not mount the generated form the definition declares. Needs the pane's own `TText` / `☑Checkbox` chips plus a drag onto the page. |
| `digital-sign-pdf` | `Sign` stayed disabled with both file fields written: the probe marks the picker input its label resolved to and sets the file through CDP, and the readback still says `file input` — `FilePicker` keeps the value in React state from the `change` event CDP does not fire the way a click does. Needs a `DOM.setFileInputFiles` on the input *inside* the group plus a dispatched `change`, or the pane's own file dialog. |
| `add-attachments` | Same picker problem, stated by the tool: *"Choose at least one file to attach."* — with a `file` field the write never reached React. |
| `pdf-layers` | Run button disabled: the `Hide these layers` / `Show these layers` **multiselect** renders its options from the opened document, and the probe's group locator found `NO CONTROL` for it (the disclosure had collapsed when the file landed). The rerun opens the panel again and picks the first unchecked row. |
| `timestamp-pdf` | Refuses honestly — *"This PDF has no digital signature to timestamp. Run Digital Signature on it first, then timestamp the signed file."* — and the chain it asks for is blocked by `digital-sign-pdf` above. |
| `heic-to-pdf` | No HEIC encoder on this machine (`ffmpeg` has no `heic` muxer), so the fixture is JPEG bytes under a `.heic` name. The tool's answer was measured and is correct: *"photo.heic is a JPEG image, not a HEIC/HEIF image or a HEIF image. Re-save it in the advertised format, or use Images to PDF."* The HEIC **decode** path itself is unexamined. |
| `mobi-to-pdf`, `pages-to-pdf`, `pub-to-pdf`, `vsd-to-pdf`, `wpd-to-pdf`, `wps-to-pdf`, `odg-to-pdf` | Seven tools that declare themselves unavailable by design. All seven were driven: the intake accepts the file (`book.mobi · 256 B`, `legacy.pub · 14 B`, …), the run button stays disabled, and the surface prints the tool's own reason — e.g. `MOBI to PDF — Listed so the capability is findable. MOBI is not converted offline — the notes name a format that is.` No conversion exists to mark good or bad, so they are recorded here rather than as CLEAN. |
| `trim`, `resize`, `crop`, `compress`, `gif`, `audio`, `speed`, `metadata` | The panel loads the clip and paints its controls (`START TIME (SECONDS) 00:00:00.000`, `SELECTED DURATION 3.000s`), and the button is pressed (`clicked "named Trim Video"`). What comes back is the panel's own refusal: **`Could not finish — Codec probe in progress — wait a moment and try again.`**, with the file card still reading `clip.mp4 · Probing codec…` after **420 seconds**, and no exception in the console (`errors: []`). The first pass appeared to produce a file only because the probe kept the panel's *input preview* blob — `sha b5cb2c880ae2077a` in and out, 86 492 bytes both sides. So: no ffmpeg output has been measured for any of the eight, because the codec probe never completes on the deployed origin. What it needs: a run where `FileProbe`'s result is awaited with a visible failure, and a probe that waits on the store's output rather than the wall clock — which is also how to tell "the wasm core never loads here" from "the probe hangs". |

---
## What this file is for

The ranked rows above are the queue. Each one is a measurement, not an inference: the number
that indicts the tool is written next to the number that would have cleared it. The eleven
families `docs/TOOL-CAMPAIGN.md` already closed are in CLEAN — MEASURED with fresh numbers from
this pass where the sweep could reach them, which is the point of running it: "unexamined" and
"verified fine" are different words, and until this pass nothing distinguished them for 118 of
the 130 tools.
