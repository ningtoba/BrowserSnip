# Page labels and outlines, foreign in — the reproduction and round-trip tables

Every input is in `tests/fixtures/readers/` and was written outside this repo
(`scripts/readers-foreign-fixtures.py`). The two app columns are generated, not typed:
`tests/pdf/readers-foreign.test.ts` drives the shipped reader and `runPdfTool` and writes
what each shape produces (`BROWSERSNIP_READERS_TABLE=… BROWSERSNIP_READERS_DUMP=… npx
vitest run tests/pdf/readers-foreign.test.ts`), `/tmp/before.json` comes from the same run
at the commit before the fix, and `docs/research/readers-foreign-table.py` renders the
rows below out of those two files plus `tests/fixtures/readers/census.json`. Same shape as
`attachments-foreign-repro.md`, because that is the pass that found this class.

**Readers on this box**: MuPDF 1.28.2 (PyMuPDF), pypdf 6.14.2, poppler 26.10.0
(`pdfinfo`), libqpdf 12.3.2 (pikepdf 10.9.1), Ghostscript 10.08.0. **No `qpdf` and no
`mutool` binary here**, so a census of these two structures is **two readers, not four**:
MuPDF and pypdf are the only ones that implement page labels and outline destinations at
all. poppler's `pdfinfo` prints neither, so it is used as a *parse witness* — every
fixture has to open in it, which the test asserts — rather than as a third opinion.

**Counts.** 26 of the 122 assertions in `tests/pdf/readers-foreign.test.ts` were red
before `7d1d1ad`; 122 are green after. 13 of the 34 shapes moved (5 label rows, 8 outline
rows) and every row that did not move is a control, not an accident.

## Why the outside columns cannot be argued with

`labels-nums-mixed.pdf` and `labels-kids-mixed.pdf` carry **the same three label ranges**
— `/S /r` from page 1, then `/S /D`, then `/S /A` with a `/P` prefix — one written as a
flat `/Nums` array and the other as a `/Kids` number tree. Flat, this app answered
`i, ii, 1, 2, Ex A, Ex B` (right, with both outside readers); as a tree, it answered
`1, 2, 3, 4, 5, 6`. That pair is what makes the `/Kids` rows a walk gap rather than a
label-formatting gap: the styles, offsets and prefixes were never the problem.

Two places the outside readers disagree with each other are recorded as disagreements
instead of being adjudicated by this app picking a side:

- **`/Kids` label ranges beyond their first page.** MuPDF carries a range until the next
  one starts, as §12.4.2 says; pypdf stops each range at its own start page, so
  `labels-kids-mixed.pdf` reads `i, ii, I, 4, c, xA` there and `i, ii, I, II, c, xA`
  here and under MuPDF. The same ranges written flat, where all three agree, are what
  pins the semantics.
- **A style the format does not define.** For `/S /G` MuPDF shows no label, pypdf counts
  from 1 and ignores `/St`, and this app counts in decimal from `/St` — the answer it has
  always given, pinned so a future change cannot pass silently.
- **An item with both `/Dest` and `/A`.** MuPDF honours `/Dest`, pypdf honours `/A`. This
  app follows `/Dest` (MuPDF's answer) and the row says so; the fix did not touch it.

MuPDF also prints a non-ASCII `/P` prefix escaped — `§I` comes back as `<A7>I` from
`page.get_label()`, and a UTF-16BE prefix this app wrote as `<FEFF0043…>`. That is its
printing convention, not a different label: pypdf decodes both to the same text.

### labels: every shape, both readers, this app before and after

| fixture | shape the format allows | the readers that did not write it | this app before the fix | this app now |
| --- | --- | --- | --- | --- |
| `labels-absent.pdf` | no /PageLabels at all — the negative control | MuPDF `['', '', '', '']`; pypdf `['1', '2', '3', '4']` | `[`1`, `2`, `3`, `4`]` | `[`1`, `2`, `3`, `4`]` — same |
| `labels-kids-deep.pdf` | a /Kids tree whose leaves sit under a second /Kids level | MuPDF `['', '', '', '', '', '']`; pypdf `['i', 'ii', '1', '4', 'Ex A', '6']` | `[`1`, `2`, `3`, `4`, `5`, `6`]` | `[`i`, `ii`, `1`, `2`, `Ex A`, `Ex B`]` — **moved** |
| `labels-kids-mixed.pdf` | /Kids + /Limits number tree, one style per section | MuPDF `['i', 'ii', 'I', 'II', 'c', 'xA']`; pypdf `['i', 'ii', 'I', '4', 'c', 'xA']` | `[`1`, `2`, `3`, `4`, `5`, `6`]` | `[`i`, `ii`, `I`, `II`, `c`, `xA`]` — **moved** |
| `labels-kids-prefix.pdf` | a /Kids tree carrying /P prefixes and /St offsets | MuPDF `['<A7>I', '<A7>II', 'A-21', 'A-22']`; pypdf `['§I', '2', 'A-21', '4']` | `[`1`, `2`, `3`, `4`]` | `[`§I`, `§II`, `A-21`, `A-22`]` — **moved** |
| `labels-native-mupdf.pdf` | the ranges MuPDF's own set_page_labels writes | MuPDF `['i', 'ii', 'x-7', 'x-8']`; pypdf `['i', 'ii', 'x-7', 'x-8']` | `[`i`, `ii`, `x-7`, `x-8`]` | `[`i`, `ii`, `x-7`, `x-8`]` — same |
| `labels-nums-A-st2.pdf` | flat /Nums, /S /A with /St 2 (uppercase alphabetic, offset start) | MuPDF `['B', 'C', 'D', 'E']`; pypdf `['B', 'C', 'D', 'E']` | `[`B`, `C`, `D`, `E`]` | `[`B`, `C`, `D`, `E`]` — same |
| `labels-nums-R-st4.pdf` | flat /Nums, /S /R with /St 4 (uppercase roman, offset start) | MuPDF `['IV', 'V', 'VI', 'VII']`; pypdf `['IV', 'V', 'VI', 'VII']` | `[`IV`, `V`, `VI`, `VII`]` | `[`IV`, `V`, `VI`, `VII`]` — same |
| `labels-nums-a.pdf` | flat /Nums, /S /a (lowercase alphabetic) | MuPDF `['a', 'b', 'c', 'd']`; pypdf `['a', 'b', 'c', 'd']` | `[`a`, `b`, `c`, `d`]` | `[`a`, `b`, `c`, `d`]` — same |
| `labels-nums-d.pdf` | flat /Nums, /S /D with /St 1 — a genuinely arabic file | MuPDF `['1', '2', '3', '4']`; pypdf `['1', '2', '3', '4']` | `[`1`, `2`, `3`, `4`]` | `[`1`, `2`, `3`, `4`]` — same |
| `labels-nums-empty-dict.pdf` | a range whose dictionary is empty — no /S, no /P, no /St | MuPDF `['', '', '', '']`; pypdf `['', '', '', '']` | `[`1`, `2`, `3`, `4`]` | `[``, ``, ``, ``]` — **moved** |
| `labels-nums-inline-dicts.pdf` | flat /Nums whose range dictionaries are inline, not referenced | MuPDF `['i', 'ii', '1', '2', 'Ex A', 'Ex B']`; pypdf `['i', 'ii', '1', '2', 'Ex A', 'Ex B']` | `[`i`, `ii`, `1`, `2`, `Ex A`, `Ex B`]` | `[`i`, `ii`, `1`, `2`, `Ex A`, `Ex B`]` — same |
| `labels-nums-mixed.pdf` | flat /Nums, a mixed sequence across three sections (/r, /D, /A + /P) | MuPDF `['i', 'ii', '1', '2', 'Ex A', 'Ex B']`; pypdf `['i', 'ii', '1', '2', 'Ex A', 'Ex B']` | `[`i`, `ii`, `1`, `2`, `Ex A`, `Ex B`]` | `[`i`, `ii`, `1`, `2`, `Ex A`, `Ex B`]` — same |
| `labels-nums-prefix-only.pdf` | a range with /P and no /S — a prefix-only label | MuPDF `['Cover ', 'Cover ', 'of i', 'of ii']`; pypdf `['Cover ', 'Cover ', 'of i', 'of ii']` | `[`Cover 1`, `Cover 2`, `of i`, `of ii`]` | `[`Cover `, `Cover `, `of i`, `of ii`]` — **moved** |
| `labels-nums-prefix.pdf` | flat /Nums with /P prefixes on a decimal and a roman range | MuPDF `['i-1', 'i-2', '<A7>i', '<A7>ii']`; pypdf `['i-1', 'i-2', '§i', '§ii']` | `[`i-1`, `i-2`, `§i`, `§ii`]` | `[`i-1`, `i-2`, `§i`, `§ii`]` — same |
| `labels-nums-r.pdf` | flat /Nums, /S /r (lowercase roman) | MuPDF `['i', 'ii', 'iii', 'iv']`; pypdf `['i', 'ii', 'iii', 'iv']` | `[`i`, `ii`, `iii`, `iv`]` | `[`i`, `ii`, `iii`, `iv`]` — same |
| `labels-nums-unknown-style.pdf` | a range whose /S names a style the format does not define (/G) | MuPDF `['', '', '', '']`; pypdf `['1', '2', '3', '4']` | `[`2`, `3`, `4`, `5`]` | `[`2`, `3`, `4`, `5`]` — same |

### outlines: every shape, both readers, this app before and after

| fixture | shape the format allows | the readers that did not write it | this app before the fix | this app now |
| --- | --- | --- | --- | --- |
| `outlines-absent.pdf` | no /Outlines at all — empty, not null-everywhere | pypdf `[]`; MuPDF `[]` | `[]` | `[]` — same |
| `outlines-action-array.pdf` | item /A /GoTo with the /D destination array inline (no name tree) | pypdf `[['Chapter One', 0], ['Section One.A', 1], ['Chapter Two', 2]]`; MuPDF `[['Chapter One', 1], ['Section One.A', 2], ['Chapter Two', 3]]` | `[Chapter One→0, Section One.A→1 (level 2), Chapter Two→2]` | `[Chapter One→0, Section One.A→1 (level 2), Chapter Two→2]` — same |
| `outlines-action-name.pdf` | item /A /GoTo whose /D is a NAME into a referenced /Dests value | pypdf `[['Chapter One', None], ['Section One.A', None], ['Chapter Two', None]]`; MuPDF `[['Chapter One', 0], ['Section One.A', 0], ['Chapter Two', 0]]` | `[Chapter One→no page, Section One.A→no page (level 2), Chapter Two→no page]` | `[Chapter One→0, Section One.A→1 (level 2), Chapter Two→2]` — **moved** |
| `outlines-action-string.pdf` | item /A /GoTo whose /D is a STRING into the /Names → /Dests tree | pypdf `[['Chapter One', 0], ['Section One.A', 1], ['Chapter Two', 2]]`; MuPDF `[['Chapter One', 1], ['Section One.A', 2], ['Chapter Two', 3]]` | `[Chapter One→no page, Section One.A→no page (level 2), Chapter Two→no page]` | `[Chapter One→0, Section One.A→1 (level 2), Chapter Two→2]` — **moved** |
| `outlines-dest-and-action.pdf` | an item carrying /Dest **and** /A on the same entry | pypdf `[['Chapter One', 0], ['Section One.A', 1], ['Chapter Two', 2]]`; MuPDF `[['Chapter One', 1], ['Section One.A', 1], ['Chapter Two', 1]]` | `[Chapter One→0, Section One.A→0 (level 2), Chapter Two→0]` | `[Chapter One→0, Section One.A→0 (level 2), Chapter Two→0]` — same |
| `outlines-dest-name.pdf` | item /Dest written as a NAME object naming /Dests, values behind references | pypdf `[['Chapter One', None], ['Section One.A', None], ['Chapter Two', None]]`; MuPDF `[['Chapter One', 0], ['Section One.A', 0], ['Chapter Two', 0]]` | `[Chapter One→no page, Section One.A→no page (level 2), Chapter Two→no page]` | `[Chapter One→0, Section One.A→1 (level 2), Chapter Two→2]` — **moved** |
| `outlines-dests-inline.pdf` | /Dests flat /Names with the destination array inline, item /Dest a string | pypdf `[['Chapter One', 0], ['Section One.A', 1], ['Chapter Two', 2]]`; MuPDF `[['Chapter One', 0], ['Section One.A', 0], ['Chapter Two', 0]]` | `[Chapter One→0, Section One.A→1 (level 2), Chapter Two→2]` | `[Chapter One→0, Section One.A→1 (level 2), Chapter Two→2]` — same |
| `outlines-dests-kids-ref.pdf` | /Dests as a /Kids + /Limits tree with referenced destinations | pypdf `[['Chapter One', 0], ['Section One.A', 1], ['Chapter Two', 2]]`; MuPDF `[['Chapter One', 0], ['Section One.A', 0], ['Chapter Two', 0]]` | `[Chapter One→no page, Section One.A→no page (level 2), Chapter Two→no page]` | `[Chapter One→0, Section One.A→1 (level 2), Chapter Two→2]` — **moved** |
| `outlines-dests-ref.pdf` | /Dests flat /Names with each destination behind a reference — the reported failure | pypdf `[['Chapter One', 0], ['Section One.A', 1], ['Chapter Two', 2]]`; MuPDF `[['Chapter One', 0], ['Section One.A', 0], ['Chapter Two', 0]]` | `[Chapter One→no page, Section One.A→no page (level 2), Chapter Two→no page]` | `[Chapter One→0, Section One.A→1 (level 2), Chapter Two→2]` — **moved** |
| `outlines-empty.pdf` | /Outlines present with /Count 0 and no /First — empty, not null-everywhere | pypdf `[]`; MuPDF `[]` | `[]` | `[]` — same |
| `outlines-flat-chain.pdf` | a flat /First → /Next chain of two items with inline /Dest arrays — the control | pypdf `[['Chapter One', 0], ['Chapter Two', 1]]`; MuPDF `[['Chapter One', 1], ['Chapter Two', 2]]` | `[Chapter One→0, Chapter Two→1]` | `[Chapter One→0, Chapter Two→1]` — same |
| `outlines-names-dests-dict.pdf` | /Names → /Dests whose value is a destination DICTIONARY behind a reference | pypdf `[['Chapter One', 0], ['Section One.A', 1], ['Chapter Two', 2]]`; MuPDF `[['Chapter One', 1], ['Section One.A', 2], ['Chapter Two', 3]]` | `[Chapter One→no page, Section One.A→no page (level 2), Chapter Two→no page]` | `[Chapter One→0, Section One.A→1 (level 2), Chapter Two→2]` — **moved** |
| `outlines-names-dests-kids-ref.pdf` | the PDF 1.4 location: /Names → /Dests as a /Kids tree with referenced destinations | pypdf `[['Chapter One', 0], ['Section One.A', 1], ['Chapter Two', 2]]`; MuPDF `[['Chapter One', 1], ['Section One.A', 2], ['Chapter Two', 3]]` | `[Chapter One→no page, Section One.A→no page (level 2), Chapter Two→no page]` | `[Chapter One→0, Section One.A→1 (level 2), Chapter Two→2]` — **moved** |
| `outlines-native-mupdf.pdf` | MuPDF's own /Outlines: /A /GoTo with the /D array inline, two levels, /XYZ | pypdf `[['Chapter One', 0], ['Section One.A', 1], ['Chapter Two', 2]]`; MuPDF `[['Chapter One', 1], ['Section One.A', 2], ['Chapter Two', 3]]` | `[Chapter One→0, Section One.A→1 (level 2), Chapter Two→2]` | `[Chapter One→0, Section One.A→1 (level 2), Chapter Two→2]` — same |
| `outlines-native-pikepdf.pdf` | libqpdf's own outline: /Dest as an inline array, nesting through /First | pypdf `[['Chapter One', 0], ['Section One.A', 1], ['Chapter Two', 2]]`; MuPDF `[['Chapter One', 1], ['Section One.A', 2], ['Chapter Two', 3]]` | `[Chapter One→0, Section One.A→1 (level 2), Chapter Two→2]` | `[Chapter One→0, Section One.A→1 (level 2), Chapter Two→2]` — same |
| `outlines-native-pypdf.pdf` | pypdf's own outline: /A /GoTo with an inline /D array, nested through /First | pypdf `[['Chapter One', 0], ['Section One.A', 1], ['Chapter Two', 2]]`; MuPDF `[['Chapter One', 1], ['Section One.A', 2], ['Chapter Two', 3]]` | `[Chapter One→0, Section One.A→1 (level 2), Chapter Two→2]` | `[Chapter One→0, Section One.A→1 (level 2), Chapter Two→2]` — same |
| `outlines-redactable.pdf` | the referenced-/Dests failure, titles matching the page's own words, with a /Info dictionary | pypdf `[['Lighthouse One', 0], ['Inventory Two', 1], ['Sheet Three', 2]]`; MuPDF `[['Lighthouse One', 0], ['Inventory Two', 0], ['Sheet Three', 0]]` | `[Lighthouse One→no page, Inventory Two→no page (level 2), Sheet Three→no page]` | `[Lighthouse One→0, Inventory Two→1 (level 2), Sheet Three→2]` — **moved** |
| `outlines-targetless.pdf` | items with no destination at all: a heading, a /URI action, an /SE-only entry | pypdf `[['Chapter One', None], ['Section One.A', None], ['Chapter Two', None]]`; MuPDF `[['Chapter One', -1], ['Section One.A', -1], ['Chapter Two', -1]]` | `[Chapter One→no page, Section One.A→no page (level 2), Chapter Two→no page]` | `[Chapter One→no page, Section One.A→no page (level 2), Chapter Two→no page]` — same |

## Does a round trip preserve the file, or overwrite it? — measured first

A misread that only *reports* is a display bug; a misread that feeds a *writer* damages
files. This was measured before either reader was touched, and the answer is different for
the two structures.

The files that came back from the shipped tools are judged by the readers that did not
write them — `docs/research/readers-round-trip.py` asks MuPDF and pypdf the same two
questions of the input and of the output, and both runs are kept:
`readers-round-trip-before.log` (the app as it was) and `readers-round-trip-after.log`
(the app as it is now). Asking this app's own reader would have proved nothing: an entry
the reader lost and the writer rewrote as a heading reads back as "no page" either way.
The third column, *items naming a target in the bytes*, counts the outline item
dictionaries that still carry `/Dest`, `/Destination` or `/A` — a fact about the file, not
an opinion of a reader.

### Page labels: no writer consults the reader, so nothing was rewritten

| run | tool | what the output's own label store says |
| --- | --- | --- |
| `rotate-labels` | rotate 90°, all pages | `/Kids x2` in → `/Kids x2` out; MuPDF `i, ii, I, II, c, xA` both sides |
| `folios` | page-numbers (bottom-centre folios) | `/Kids x2` → `/Kids x2`, labels identical before and after |
| `header-footer` | header-footer | `/Kids x2` → `/Kids x2`, labels identical |
| `replace-labels` | add-page-labels, `1-2 roman 1 / 3-6 decimal 1` | 4 ranges → 2, `i, ii, I, II, c, xA` → `i, ii, 1, 2, 3, 4` — the replacement the tool promises |
| `keep-labels` | add-page-labels, `1-4 none 1 Cover` | writes `/P` with no `/S`; pypdf reads `Cover, Cover, Cover, Cover` |
| `copy-labels` | extract-pages `1-3` | `/Kids x2` → **absent**; MuPDF finds 0 ranges, pypdf falls back to `1, 2, 3` |
| `merge-labels` | merge of two labelled files | `/Kids x2` + `/Nums x1` → **absent** |

`readPageLabels` has exactly **one** caller in `src/` — `add-page-labels`, reading back
the ranges it wrote a line earlier (`src/lib/pdf/tools/edit.ts:1046`). `page-numbers`,
`header-footer`, `bates-numbering` and `table-of-contents` count *sheets*; they draw a
folio and never look at the numbering a viewer shows. So the roman-to-arabic misread could
not have been rewriting anybody's document — it was reporting one wrongly, and the only
thing it could have corrupted was a future "carry the labels across a copy" built on top
of it, which is exactly the fix that this table now makes safe.

**The label damage that is real is not the reader's.** A page copy — `extract-pages`,
`merge`, `split`, `organize`, and everything else that goes through
`core/doc.ts:carryPageFurniture` — does not carry `/PageLabels` at all, so a file labelled
`i, ii, I, II, c, xA` comes back with **no label store**, and every reader on the planet
then numbers it `1, 2, 3`. That is data loss wearing the same clothes, and it is a
different seam: the copy carries bookmarks and embedded files and has never carried the
numbering. Left as found, pinned in
`tests/pdf/readers-foreign.test.ts › a page copy drops /PageLabels altogether — recorded,
not fixed here`, because fixing it means deciding what a merge of two labelled documents
should do, which is a product call and outside this pass.

### Outlines: the misread did reach writers, and it did destroy things

| run | tool | items naming a target, in → out | pypdf resolves, in → out |
| --- | --- | --- | --- |
| `append-bookmarks` | bookmarks, "replace" off, appending one entry | **3 → 1** before, 4 → 4 now | 3 of 3 → 1 of 4 before; 4 of 4 now |
| `redact-titles` | redact-pdf, word scrubbed out of bookmark titles | **3 → 0** before, 3 → 3 now | 3 of 3 → 0 of 3 before; 3 of 3 now |
| `copy-outline` | extract-pages over a `/Names → /Dests` tree | **3 → 0** before, 3 → 3 now | 3 of 3 → 0 of 3 before; 3 of 3 now |
| `toc` | table-of-contents | 3 → 3 (the outline is not rewritten) | 3 of 3 both sides — but the inserted sheet had **no page numbers at all** before, and admits it: *"3 entries has no page target, so it is listed without a number."* |

`bookmarks` with append on, and `redact-pdf`'s title scrub, both do
read-modify-write: `readOutline(doc)` into the model, `writeOutline(doc, …)` back out.
An entry whose destination the reader could not resolve became a heading, so the rewrite
**deleted the `/Dest` from the file** and the run still reported success. Redacting a
name out of one bookmark title silently unpointed every bookmark in the document — on the
`/Dests`-behind-a-reference shape, which is what pypdf and Acrobat-style producers write.
The page copy had the same failure with the count rubbed salt in: three bookmarks went
in, three came out, none of them named a page any more, and the tool said it had carried
three.

So, plainly: **item 1 (labels) was a wrong report, item 2 (outlines) was data loss.** The
fix landed for both, and the copy path's separate label loss is recorded rather than
quietly folded in.

## The shared walk: one walk, and where it lives

`docs/research/foreign-structure-audit.md` named the pattern — *"three of the four
failures are the same two lines of code, written three times"* — and this is the fourth
instance of it being closed by extraction rather than by a third copy.

The attachments fix (`9f4116b`) introduced `collectNameTree` in `core/attachments.ts`:
`/Names` pairs whose value may be inline **or** a reference, plus `/Kids` subtrees, depth
bounded. `core/bookmarks.ts` had two parallel walks of its own — one for `/Dests`
(flat `/Names`, value must *be* an array) and one for `/PageLabels` (root `/Nums` only).
Comparing them line by line, the divergence was **by accident**: the attachments walk is
strictly the general case of the other two, the format rules (§7.9.6 for names, §7.9.7 for
numbers) are the same rules, and neither of the bookmarks walks had a fixture, a comment
or a test asking for the narrower behaviour. The only thing attachments needed and the
bookmarks readers did not was the *identity of the array a pair came from*, for removal.

`src/lib/pdf/core/tree.ts` is now that one walk — `collectTreePairs(doc, root)` yields
every pair in document order with the value left **as stored** and its host array named,
plus `followRef` (the "ask what it is, don't confirm a hope" helper that
`core/attachments.ts` shipped with and that `readOutline` needed for the same reason).
All three readers call it:

- `core/attachments.ts:collectNameTree` kept its name, its `FilespecSite` record and its
  inline-versus-reference handling, and delegates the traversal. Its behaviour is
  unchanged and `tests/pdf/attachments-foreign.test.ts` (77 assertions over 15 foreign
  fixtures) is green on the extracted helper — the reference implementation still covers
  the shared code, which was the condition on touching a file that shipped hours ago.
- `core/bookmarks.ts:destinationArray` resolves all four spellings §12.3.2 allows — inline
  array, array behind a reference, destination dictionary behind a reference, name or
  string key into the tree — over both stores (`/Dests` and `/Names → /Dests`).
- `core/bookmarks.ts:readPageLabels` takes its ranges from the whole number tree.

Nothing else in `core/attachments.ts` moved: `looksLikeFilespec`, the `/EF` preference
order, the `/AF` and annotation walks, removal, and `md5Hex` are untouched.

## Re-running this

```sh
python3 scripts/readers-foreign-fixtures.py            # rebuild + census + MANIFEST
python3 scripts/readers-foreign-fixtures.py --check    # 34 fixtures, two processes, identical bytes
BROWSERSNIP_READERS_TABLE=/tmp/after.json BROWSERSNIP_READERS_DUMP=/tmp/after \
  npx vitest run tests/pdf/readers-foreign.test.ts
python3 docs/research/readers-round-trip.py /tmp/after > docs/research/readers-round-trip-after.log
python3 docs/research/readers-foreign-table.py /tmp/before.json /tmp/after.json /tmp/tables.md
npx vitest run tests/pdf/readers-foreign.test.ts tests/pdf/attachments-foreign.test.ts \
  tests/pdf/edge-organize.test.ts tests/pdf/edge-edit.test.ts tests/pdf/field-reach.test.ts
```

The fixtures are byte-reproducible the way the attachment set is: timestamps and both
halves of the trailer `/ID` pinned by `scripts/pdf_fixture_determinism.py`, `--check`
rebuilding through the CLI in two separate processes with a pause longer than the
producers' one-second stamp resolution, `MANIFEST.json` recording the SHA-256 of what came
out — and `tests/pdf/readers-foreign.test.ts` asserting that every committed file still
hashes to its recorded digest, that `census.json` covers exactly the files the test
asserts on, and that poppler opens each one. A red row therefore means the reader changed,
not that somebody re-ran the generator.
