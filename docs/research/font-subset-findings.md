# The font subsetter — what broke, which readers saw it, what fixed it

The `edit-pdf-text` row left this open: *"a Noto subset emitted by
`UnicodeFaceEmbedder` (and by pdf-lib's own subsetter) carries glyph data that
MuPDF, pdf.js and fontTools all fail to read past the second included glyph"* —
text that paints nothing while still extracting, so copy-paste and Ctrl-F and
"does the file open" are all blind to it. This document is the failure surface in
numbers, the byte that disagrees, the fix, and the re-measurement.

Everything here is measured by the rig in this directory; the committed tables are
`font-subset-before.txt` (the same rig against the pre-fix tree, `git checkout
aae5110^ -- src/...`) and `font-subset-after.txt`. Re-run commands at the bottom.

## 1. Failure surface, before the fix

One character per row, 20 pt, through the app's own writer; **lost** = MuPDF
finds the character on the page, the source face has an outline for it, and the
box it paints in holds zero non-white pixels at 150 dpi. `pdf.js` is the same
measurement painted in Chromium with the app's own `openRender`. `fontTools`
reads the `/FontFile*` program back out and decompiles each glyph against the
same glyph in the untouched face.

| face (how it is embedded) | flavour | glyphs | lost MuPDF | lost pdf.js | glyph programs that differ | what the readers say |
| --- | --- | --- | --- | --- | --- | --- |
| bundled Noto Sans regular — `getFont` | TTF | 267 | **216** | 211 | 122 | `FT_Load_Glyph(…,2,…): invalid outline` |
| bundled Noto Sans bold — `getFont` | TTF | 267 | **216** | 216 | 129 | same |
| bundled Noto, synthesised italic | TTF | 267 | **216** | 211 | 122 | same |
| bundled Noto — **pdf-lib's own subsetter** | TTF | 267 | **216** | 211 | 122 | same |
| bundled Noto — whole face, unsubsetted *(control)* | TTF | 267 | 0 | 2 | 0 | clean |
| standard 14 Helvetica *(control)* | — | 160 | 0 | 2 | n/a | clean |
| JetBrains Mono — pdf-lib's subsetter | TTF | 160 | 0 | 1 | 0 | offsets not long-word aligned |
| Noto Sans Arabic / Hebrew / Devanagari / Bengali / Tamil / Telugu / Kannada / Malayalam / Thai / Lao / Khmer / Myanmar / Georgian / Armenian / Ethiopic — `getFont` | TTF | 26–47 each | 0 | 0 | 0 | clean (see §2: these faces are even-offset) |
| **Noto Sans JP — `getFont`** | CFF | 76 | **76 (all)** | 0 | 76 | `FT_New_Memory_Face(…): unknown file format` |
| **Noto Sans KR — `getFont`** | CFF | 53 | **53 (all)** | 0 | 53 | same |
| **Noto Sans SC — `getFont`** | CFF | 38 | **38 (all)** | 0 | 38 | same |
| **Noto Sans TC — `getFont`** | CFF | 34 | **34 (all)** | 0 | 34 | same |
| Noto Sans JP / KR — pdf-lib's own subsetter | CFF | 76 / 53 | **all** | 0 | all | same, from the `/FontFile3` slot |
| Noto Sans KR — pdf-lib, whole face | CFF | 53 | 29 | 44 | — | `FT_Load_Glyph: invalid argument` |

So: three separate defects, and the split is by **face**, not by reader.

* The bundled Noto faces lose 216 of every 267 characters, in **all three**
  readers.
* The fifteen TTF-flavour on-demand faces survive MuPDF (their source offsets are
  even, see §2) and so were invisible to this row until the byte audit named them.
* The four **CJK** faces — every face the app fetches for Japanese, Korean and
  Chinese, all `OTTO`/CFF — painted **nothing at all** in MuPDF and in
  fontTools, and only survived in pdf.js, which sniffs the program instead of
  trusting the slot it is written into. Page numbers, headers and footers,
  stamps, watermarks and text/markdown→PDF in CJK were blank in every MuPDF-based
  viewer (Chrome's, Apple's, `pdftotext`-adjacent tools) while copying still
  worked.

The six characters the ledger row named, at 40 pt through the app's writer, with
the reference ink from the same face drawn by MuPDF itself:

| character | `#` | `A` | `4` | `B` | `—` | `Z` |
| --- | --- | --- | --- | --- | --- | --- |
| ink before the fix | 1 221 | 1 116 | 1 055 | **0** | **0** | **0** |
| ink after the fix | 1 221 | 1 116 | 1 055 | 1 439 | 539 | 1 048 |
| reference (the untouched face) | 1 221 | 1 116 | 1 055 | 1 439 | 539 | 1 048 |

pdf.js painted blanks for `B`, `—` and `Z` in the same subset and none after. The
row's numbers (`#` 1 213, `A` 1 042, `4` 961, the rest 0) are the same
measurement at its own box padding.

## 2. Which stage breaks, and the byte that says so

Nothing about the CID mapping, the widths or `/ToUnicode` was wrong — that is why
the text kept extracting. **All three causes are in the glyph program.**

### Cause 1 — `loca` in the short form, halving an odd offset

`@pdf-lib/fontkit`'s TrueType subsetter copies glyph records verbatim, accumulates
their lengths into byte offsets, and then `tables.loca.preEncode` chooses the
16-bit form whenever the table ends under 64 KB and does `offsets[i] >>>= 1` —
half the byte offset, **rounded down**. That is only exact when every offset is
even, and `NotoSans-Regular.ttf` does not hold that precondition: 2 149 of its
4 689 glyph offsets are odd (glyph 37 begins at byte 2 641). So in the subset of
the ledger's six characters the table read

```
loca (as written)  0  40  112  216  312  386  432  456
where the records actually begin   0  40  112  217  313  387  432  456
                                          ^^^  ^^^  ^^^   the B, # and 4 records
```

and every glyph after the first odd offset started one byte inside the record
before it. In the 267-character subset the audit reports **146 of 276 entries not
long-word aligned and 175 whose span disagrees with the record** — first at
`loca[2] = 40`, giving a glyph 56 bytes where the record is 57. FreeType calls
that `invalid outline`, fontTools gets an IndexError unpacking the point table,
pdf.js paints nothing.

The fifteen on-demand TTF faces escaped the ink loss because `@expo-google-fonts`
ships them with `indexToLocFormat = 0` — a 16-bit index can only hold even
offsets, so halving is exact. Their subsets still disagreed with the spec's
long-word rule (89 of JetBrains Mono's, 22 of Arabic's), which is why the byte
audit flagged them.

### Cause 2 — `face.cff` is a property this fontkit never sets

`getFont` handed CFF-flavoured faces to pdf-lib with

```ts
if (face.cff) return doc.embedFont(bytes, { subset: true });
```

and `@pdf-lib/fontkit` keeps a face's tables under their four-character tags: the
table is `face['CFF ']`, and `face.cff` is `undefined` for every face — measured
on all nineteen on-demand faces and the bundled ones. The guard was dead, so the
CFF charstrings went into `/FontFile2` under a `/CIDFontType2` with a
`/CIDToGIDMap`, which is a TrueType slot holding a CFF program. MuPDF answered
`FT_New_Memory_Face(…): unknown file format` and drew the whole face from a
substitute, losing every glyph.

### Cause 3 — fontkit's CFF encoder mislabels its own header

A CFF header is `major, minor, hdrSize, firstOffset`, and `firstOffset` is the
absolute position of the Name INDEX. fontkit's subset output reads

```
01 00 04 18 00 01 01 01 13 4e 6f 74 6f …      firstOffset = 24
01 00 04 04 00 01 01 01 13 4e 6f 74 6f …      the source face it was cut from
```

with the Name INDEX sitting at byte 4 in both (`00 01` = one name, `01` = 1-byte
offsets, `13` = the 19-character name "NotoSansJP-Regular"). FreeType believes the
header and rejects the font; fontTools walks the indexes and never looks at it,
which is how the same bytes read clean in one reader and broken in another.
Setting byte 3 to 4 in an already-produced subset took MuPDF from 0 to 76 of 76
kana painted.

## 3. The fix, and what was chosen

All of it is in `src/lib/pdf/core/fonts.ts`; subsetting was **kept**.

* **`alignTrueTypeGlyphs(bytes)`** — before a face is handed to fontkit, its
  `glyf` is rebuilt with every record padded to a long word, `loca` rewritten in
  the 32-bit form, `head.indexToLocFormat` set to 1, and the sfnt re-serialised
  with recomputed table checksums. The subsetter's halving is then exact by
  construction, because every copied length is a multiple of four. A face whose
  records are already aligned (the CFF faces, and any face with nothing to move)
  is returned untouched, and the work happens once per face behind `fontCache`.
* **`faceIsCff(font)`** — reads `font['CFF ']` and the absence of `loca`, so the
  flavour test says what the bytes are.
* **`UnicodeFaceEmbedder` now writes both flavours**: TrueType keeps
  `/FontFile2` + `/CIDToGIDMap` + `/CIDFontType2`; CFF writes `/FontFile3` with
  `/Subtype /CIDFontType0C` under a `/CIDFontType0`, with no map, and its codes
  are the subset's glyph ids because a CFF maps CIDs through its own charset (a
  subset's charset is identity). `repairCffHeader` fixes the one header byte.
* **`embedUnicodeFace(doc, bytes)`** is exported, and the callers that used to
  hand raw bytes to pdf-lib — `core/layout.ts`'s monospace face,
  `text-editor/faces.ts`'s script and local-system faces — use it, because
  pdf-lib's own `isCFF()` tests the same missing property and its TrueType
  subsets carry the same halved `loca`.

Sizes, which the row's parent asked to keep honest: the fix does **not** fall back
to whole-face embedding. A 267-character Noto subset is 19.5 KB of program in a
30.1 KB file; the JP subset is 19.9 KB against a 4.4 MB face, KR 36.5 KB against
4.7 MB, SC 45.3 KB against 8.5 MB. The unsubsetted control costs 298.6 KB (Noto)
and 3.9 MB (KR) — so subsetting was worth keeping once it could be proved
byte-exact, and the proof is §4.

## 4. After the fix, same rig, same instrument

Every face the app can embed, through the app's own paths:

| face | lost MuPDF | lost pdf.js | glyph programs that differ | MuPDF |
| --- | --- | --- | --- | --- |
| Noto regular / bold / italic (app) | 0 | 2 (the probe's box floor) | 0 | no warnings |
| Noto regular, whole face *(control)* | 0 | 2 | 0 | no warnings |
| standard 14 *(control)* | 0 | 2 | n/a | no warnings |
| JetBrains Mono via `embedUnicodeFace` | 0 | 1 | 0 | no warnings |
| all fifteen TTF script faces (app) | 0 | 0 | 0 | no warnings |
| JP / KR / SC / TC (app) | 0 | 0 | 0 | no warnings |

`2` for the Noto rows is `_` and `µ`, which the unsubsetted control and the
standard-14 reference also report: those two characters' ink falls outside the
box pdf.js returns for them, so it names the probe, not the bytes. Every other
row is 0.

The remaining non-zero rows in `font-subset-after.txt` (`noto-pdflib-subset` 216,
`pdflib-jp`/`pdflib-kr` all, `full-kr` 29) are the **counter-examples kept in the
table on purpose**: they call `doc.embedFont(bytes, { subset: true })` on raw
bytes, which is what pdf-lib does with the two library defects and what no caller
in this app does any more.

### Through a real tool, on a real page

`font-subset-tool.mjs` types text into the header-footer rail (a real user path
that draws user text through this module), reads every value back out of the DOM,
runs the tool and keeps the download; `font-subset-tool-measure.py` then measures
the ink of each character MuPDF finds in the produced file.

Header left `#ABZ4—ŠžΩФабв`, header right `漢字あアイ`, 36 pt (the rail clamps 40),
rule off, one 1500 × 500 pt page:

| | `#` | `A` | `B` | `Z` | `4` | `—` | `Š` | `ž` | `Ω` | `Ф` | `а` | `б` | `в` | `漢` | `字` | `あ` | `ア` | `イ` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| deployed before the fix | 1 039 | 914 | 239 | 6 | 842 | 420 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| after the fix | 1 039 | 914 | 239 | 848 | 842 | 420 | 994 | 762 | 1 138 | 1 298 | 758 | 1 023 | 897 | 2 150 | 1 544 | 1 615 | 913 | 733 |

Twelve of the eighteen characters typed into the rail painted nothing on the
deployed build, and all twelve extract normally in the same file: `extractText`
and Ctrl-F return `ŠžΩФабв` and `漢字あアイ` exactly as typed.

The deployed run also printed both causes against the produced file —
`FT_Load_Glyph(…,3,…): invalid outline` with `loca[3] = 208` giving a glyph 104
bytes where the record is 105, and `FT_New_Memory_Face(NotoSansJP-…): unknown file
format` with the CFF header disagreeing — and the fixed run reports **no MuPDF
warnings**, a `/FontFile2` TrueType program for the Latin/Cyrillic face and a
`/FontFile3 /CIDFontType0C` program under a `/CIDFontType0` for the JP face.

`Z` is the sharp one: 6 px of noise before (a record read from the wrong byte),
848 px after, at the same place, in the same tool run — while `#`, `A`, `B`, `4`
and `—` measured the same pixels both times. Which glyphs survive a bad `loca`
also depends on the reader: FreeType re-derives glyph lengths when the index looks
wrong, and fontTools walks the index as written, so a subset can print a *shape*
for one reader and nothing for another. That is why the regression guard compares
the glyph program and the index against the table's own records, and not only the
pixels.

## 5. Regression guard

`tests/pdf/fonts.test.ts` (14 tests) reads every embedded face back out of the
saved bytes: the slot and the stream's `/Subtype`, the glyph outline a viewer is
told to paint compared with the same glyph in the unsubsetted face, non-empty
outlines for every character the face holds, long-word alignment of the subset's
`loca`, the CFF header pointing at the Name INDEX that is really there, and full
`/W` and `/ToUnicode` coverage. `tests/fixtures/cff-face.otf` is a 4-glyph
CFF-flavoured face (752 B, built with fontTools) so the CFF half is testable
offline — the app's own CJK faces are all `OTTO` and come from a CDN.

`python3 docs/research/font-subset-revert.py` reverts one behaviour at a time and
prints the red count: alignment 3, routing the run through this module 1, reading
the flavour from the tables 2, the CFF header repair 1 — and 0 red before the
tests existed, which is how this shipped.

## 6. Left for other rows (measured, not touched)

* pdf-lib's own `CustomFontEmbedder.isCFF()` tests the same missing `font.cff`, so
  a **whole** CFF-flavoured face goes into `/FontFile2` (`full-kr`: 29 of 53 lost
  in MuPDF, 44 of 64 in pdf.js — and those numbers are the paint of a *substitute*
  font, so the truth is worse than the count). No caller in this app reaches it
  now; a caller that does should use `embedUnicodeFace`.
* fontkit's two encoder defects live in `@pdf-lib/fontkit@1.1.1`, vendored here.
  Anything that subsets a face without coming through this module inherits them.
* The `edit-pdf-text` row's left-open item (1) — *"our own writer's subset is
  broken independently of this row"* — is closed by `aae5110` and `0e748f5`;
  keeping the document's own face is still the better outcome for fidelity, but it
  is no longer the only way to get visible text.

## 7. Re-running the numbers

```sh
# 1. produce one probe PDF per embedding path (uses src/ as it stands)
node docs/research/font-subset-build.mjs /tmp/fsb
TAG=prefix node docs/research/font-subset-build.mjs /tmp/fsb     # the *-prefix set

# 2. MuPDF ink + fontTools audits, and pdf.js ink painted in Chromium
python3 docs/research/font-subset-measure.py /tmp/fsb --json
BASE=http://localhost:5311 node docs/research/font-subset-pdfjs.mjs /tmp/fsb
BASE=http://localhost:5311 TAG=prefix node docs/research/font-subset-pdfjs.mjs /tmp/fsb
python3 docs/research/font-subset-measure.py /tmp/fsb --tag prefix --json

# 3. a real tool, on a live build
python3 - <<'PY'
import pymupdf; d=pymupdf.open(); d.new_page(width=1500,height=500); d.save('/tmp/toolfix/wide.pdf')
PY
BASE=https://www.browsersnip.com TOOL=header-footer LABEL='Add header and footer' \
  PDF=/tmp/toolfix/wide.pdf OUT=/tmp/toolfix/hf.pdf PORT=9826 \
  FIELDS='{"headerLeft":"#ABZ4—ŠžΩФабв","headerRight":"漢字あアイ","fontSize":"40","rule":false,"footerCenter":"","footerLeft":"","footerRight":""}' \
  node docs/research/font-subset-tool.mjs
python3 docs/research/font-subset-tool-measure.py /tmp/toolfix/hf.pdf --expect '#ABZ4—ŠžΩФабв漢字あアイ'

# 4. the guard, one behaviour at a time
python3 docs/research/font-subset-revert.py
```
