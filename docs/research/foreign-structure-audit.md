# Foreign-fixture audit — has this reader ever seen a file it didn't write?

Started from one sentence the bytes contradicted: `extract-attachments` said *"This PDF
contains no embedded files"* about a file whose catalogue names `note.txt`
(`docs/TOOL-TRIAGE.md` ERRORS 4). The cause was not the attachment code specifically — it
was that `collectNameTree` accepted a name-tree value only when it was a `PDFRef`, which
is the shape pdf-lib writes, while ISO 32000-1 §7.9.6 allows a reference **or** an inline
dictionary, and MuPDF writes the inline one. The reader recognised its own writer.

That is the third instance this session after font subsetting and the Ghostscript argv
(`docs/TOOL-CAMPAIGN.md`), so this file asks the question of the rest rather than
declaring one bug found.

## What was checked, and how

Two kinds of answer, kept apart because they are not equally strong:

1. **Has a CI test ever fed it a foreign file?** Answered by grep: for each reader, the
   test files that call it, and whether any of them reads `tests/fixtures/encrypted/`,
   `tests/fixtures/attachments/` or `tests/fixtures/foreign/` — the only PDFs in this
   repo that another implementation wrote.
2. **What does it actually do with one?** Measured by `docs/research/foreign-structure-audit.test.ts`
   (own vitest config; not in CI's `tests/**` include) over `tests/fixtures/foreign/`,
   built by `scripts/foreign-structure-fixtures.py`. Its output is
   `foreign-structure-audit-table.md`, generated, not typed.

Producers and readers on this box, named because a previous agent inherited someone
else's claim about them: **libqpdf 12.3.2** (through pikepdf 10.9.1), **MuPDF 1.28.2**
(through PyMuPDF), **pypdf 6.14.2**, **poppler 26.10.0** (`pdfdetach`, `pdfinfo`),
Ghostscript 10.08.0. There is **no `qpdf` binary and no `mutool` binary here**, so every
"qpdf" number in this repo comes from libqpdf through pikepdf, and every census is four
readers, not five.

Every fixture is frozen for byte-reproducibility (timestamps and both halves of the
trailer `/ID`) and re-verified by an outside reader **after** the freeze, so the census
describes the bytes that are kept. `--check` rebuilds the set twice in separate
processes with a two-second pause: 11 + 16 fixtures, byte-identical each time.

## Table 1 — coverage: fed a foreign file in CI?

| reader | structure | our writer produces it too | foreign file in a CI test |
| --- | --- | --- | --- |
| `core/attachments.ts` `listAttachments` | `/EmbeddedFiles` name tree, file specs, `/AF`, `/Annots` | yes — `addAttachments` | **yes, since this pass** (15 fixtures; before it: only pdf-lib files, plus one rig line) |
| `core/guard.ts` `classifyEncryption` | `/Encrypt` dictionary, effective crypt filter | yes — `protect`, `change-permissions` | **yes** (12 files, libqpdf + MuPDF) |
| `core/crypto.ts` `decryptDocument` | RC4 / AES-128 stream and string ciphers | yes — `saveEncrypted` | **yes** (same 12) |
| `core/content.ts` `streamBytes`, `pageContentStreams` | content and object streams, filters | yes — every drawing path | **yes**, incidentally (the cipher tests read foreign streams) |
| `core/bookmarks.ts` `readOutline` | `/Outlines` tree, `/Dest` forms, `/Dests` | yes — `add-bookmarks`, `organize` | **yes, since `7d1d1ad`** — 18 foreign shapes in `tests/pdf/readers-foreign.test.ts`; before it, only a parity assertion over encrypted copies of a MuPDF file, which asserts "same as unlocked", not "same as MuPDF" |
| `core/bookmarks.ts` `readPageLabels` | `/PageLabels` number tree | yes — page-labels tool | **yes, since `7d1d1ad`** — 16 foreign shapes in the same file, flat and `/Kids`, every style, with and without `/St` and `/P` |
| `core/forms.ts` `listFormFields` | `/AcroForm`, field inheritance, widgets, quads | yes — fill-form, form editors, flatten | **no** — 3 test files, all documents built here |
| `core/layers.ts` `listLayers` | `/OCProperties`, `/OCGs`, `/D`, `/OFF`, usage dicts | yes — layer tools | **no** — 4 test files, all built here |
| `core/annotations.ts` `listAnnotations` / `annotationCount` | `/Annots`, subtypes, `/AP`, quads, `/C` | yes — stamps, annotate, flatten, redact | **no** — 6 test files, all built here |
| `core/metadata.ts` `readInfo` / `readXmp` | `/Info`, XMP packet | yes — `set-metadata`, `sanitize-pdf` | **no** |
| `core/metadata.ts` `listFonts` / `listImages` | `/Font` resources, `/FontFile*`, image XObjects | yes — every embed path | **no — and no test at all**: neither is called outside `metadata.ts` (the same dead-surface shape the font row counted for `engine-ops`) |
| `core/sanitize.ts` `inspectScript` / `stripScript` | `/OpenAction`, `/AA`, `/JS`, named scripts | yes — the writers that add actions | **no** (`inert-controls.test.ts` builds its own shapes; `scripts/attachments` never tested it) |
| `core/signature.ts` `readSignatures` | `/Perms`, `/ByteRange`, `/Contents`, `/SW` | yes — `sign-pdf` | **no** — every input is signed by this app |

**Count: of the 13 rows above, 6 have met a foreign file in CI and 7 have never been
handed a file this repo did not write** — 4 when this audit ran, plus `readOutline` and
`readPageLabels`, which the follow-up pass (`docs/research/readers-foreign-repro.md`)
fixed and pinned. Counted by row, because two rows group entry
points over a single walk (`listAnnotations` with `annotationCount`, `readInfo` with
`readXmp`) and one row covers two functions that no longer have a caller at all
(`listFonts` / `listImages`) — 17 exported functions, the same 13 walks behind them. And
3 of the 4 "yes" rows are the cipher trio plus content-stream decoding, which met foreign
bytes only because a password test had to: the app was not looking for a foreign
*structure*, it was looking for a foreign *cipher*.

The attachments row is the one that changed today, and it is also the proof that
"never" did not mean "fine": that reader had 8 passing tests and failed 10 of 15 foreign
shapes.

## Table 2 — measured behaviour on foreign bytes

From `foreign-structure-audit-table.md`. Verdicts are this pass's; nothing here is fixed
except the attachments row.

| reader | foreign shape | outside reader | this app | verdict |
| --- | --- | --- | --- | --- |
| `listAttachments` | inline file spec (MuPDF's spelling) | MuPDF, pypdf, poppler all list `note.txt` | was "no embedded files", now the file | **fixed here**, pinned by 15 fixtures |
| `readOutline` | `/Outlines` with a child entry | MuPDF 3 entries / 2 levels; pypdf same | 3 nodes, depth 2 | correct |
| `readOutline` | `/Dest` naming an **inline** destination array | pypdf resolves both to pages 1 and 2 | pages 0 and 1 (0-based: correct sheets) | correct |
| `readOutline` | `/Dest` naming an array **behind a reference** | pypdf resolves both | was **both `page: null`**, now both pages | **fixed since** — `resolveNamedDestination` wanted `value instanceof PDFArray` and never followed the reference; `core/tree.ts:collectTreePairs` + `destinationArray` do |
| `readOutline` | `/Dests` as a `/Kids` + `/Limits` tree | pypdf walks it and resolves both | was **both `page: null`**, now both pages | **fixed since** — the walk is shared now, so there is no "no `/Kids` walk" left to make |
| `readOutline` | the same store under the PDF 1.4 `/Names → /Dests`, and as a destination *dictionary* | MuPDF and pypdf both resolve | was `page: null`, now both pages | **fixed since**; found by the per-shape sweep, not in the original table |
| `readPageLabels` | `/PageLabels` as a `/Kids` number tree | MuPDF: 3 ranges (`i-1`, upper roman, lower alpha) | was `["1","2","3"]`, now the labels | **fixed since** — it read `/Nums` on the root only |
| `readPageLabels` | a range with `/P` and **no `/S`**, and an empty range dictionary | MuPDF and pypdf both show the prefix and no number | was `Cover 1`, now `Cover ` | **fixed since**; this is also the shape `add-page-labels` writes for its own `none` style |
| `readPageLabels` | the same ranges in a flat `/Nums` | MuPDF: same 3 ranges | `["i-1","I","c"]` | correct — which is what makes the row above a walk gap, not a labels gap |
| `listLayers` | two OCGs, one `/OFF`, content drawn through one | MuPDF: 2 groups | 2 layers, on/off right | correct |
| `listAnnotations` | note + pop-up + free-text + highlight + link | MuPDF's `annots()` shows 3 (hides the link and the pop-up); the raw array holds 5 | 5, kinds right | correct, and more complete than the comparison |
| `listFormFields` | AcroForm with a text field and a checkbox | MuPDF: `answer`, `tick`; `/V /Yes` on the box | 2 fields, `checked: true` | correct; reports the checked state as `On` where the file spells it `/Yes` — a label, not a byte claim |
| `readInfo` / `readXmp` | `/Info` from one tool, XMP from another | MuPDF: title `Foreign structures` | title and author read, XMP parsed | correct |

## What the pattern is, stated once

Three of the four failures are the **same two lines of code, written three times**: a
name/number tree is read as a flat array, and a value is required to *be* the object
rather than a reference to it. Attachments had both and is fixed; `/Dests` has both;
`/PageLabels` has the tree half. The fourth failure mode is different and older —
asking pdf-lib for a typed object at a key whose type varies (`/EF` holding a stream)
and letting `UnexpectedObjectTypeError` reach the user as an engine sentence, which is
what the `flatten` row closed for annotation appearances.

So "our tests pass on our own output" was not the attachments bug. It is the shape of a
class, and the class still has seven untested-at-foreign readers in it.

## Left deliberately

- **`/PageLabels` and `/Dests` are fixed and pinned** (`7d1d1ad`,
  `docs/research/readers-foreign-repro.md`) — this section used to say they were left for
  someone else. What was left *out* of that pass on purpose: the page-copy path
  (`core/doc.ts:carryPageFurniture`) still drops `/PageLabels` entirely, so a labelled
  document loses its numbering through `extract-pages`, `merge` and friends. Measured,
  recorded, and a product decision about merges rather than a walk bug.
- **The rig is not in CI.** `docs/research/foreign-structure.vitest.config.ts` keeps it
  out of `tests/**`, the same choice as the encrypted-inputs rig. The rows that rig found
  wrong are now asserted in `tests/pdf/readers-foreign.test.ts` instead, so the two wrong
  verdicts in Table 2 no longer depend on a hand-run rig; the rest of the table (layers,
  annotations, fields, metadata) still does.
- **Not foreign-tested at all, still:** signatures (`readSignatures` — the fixtures carry
  none), `listFonts`/`listImages` (no callers), and every reader above against a *real*
  Word/Preview/Acrobat export rather than a hand-shaped file.

## Re-running this

```sh
python3 scripts/foreign-structure-fixtures.py --check      # determinism of the fixtures
python3 scripts/foreign-structure-fixtures.py              # rebuild + census + MANIFEST
npx vitest run --config docs/research/foreign-structure.vitest.config.ts
python3 scripts/attachments-foreign-fixtures.py --check     # the attachments set
npx vitest run tests/pdf/attachments-foreign.test.ts
python3 scripts/readers-foreign-fixtures.py --check         # the labels/outlines set
npx vitest run tests/pdf/readers-foreign.test.ts            # 122 assertions, in CI
```
