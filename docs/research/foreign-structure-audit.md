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
| `core/bookmarks.ts` `readOutline` | `/Outlines` tree, `/Dest` forms, `/Dests` | yes — `add-bookmarks`, `organize` | **no** — only a parity assertion over encrypted copies of a MuPDF file, which asserts "same as unlocked", not "same as MuPDF" |
| `core/bookmarks.ts` `readPageLabels` | `/PageLabels` number tree | yes — page-labels tool | **no** |
| `core/forms.ts` `listFormFields` | `/AcroForm`, field inheritance, widgets, quads | yes — fill-form, form editors, flatten | **no** — 3 test files, all documents built here |
| `core/layers.ts` `listLayers` | `/OCProperties`, `/OCGs`, `/D`, `/OFF`, usage dicts | yes — layer tools | **no** — 4 test files, all built here |
| `core/annotations.ts` `listAnnotations` / `annotationCount` | `/Annots`, subtypes, `/AP`, quads, `/C` | yes — stamps, annotate, flatten, redact | **no** — 6 test files, all built here |
| `core/metadata.ts` `readInfo` / `readXmp` | `/Info`, XMP packet | yes — `set-metadata`, `sanitize-pdf` | **no** |
| `core/metadata.ts` `listFonts` / `listImages` | `/Font` resources, `/FontFile*`, image XObjects | yes — every embed path | **no — and no test at all**: neither is called outside `metadata.ts` (the same dead-surface shape the font row counted for `engine-ops`) |
| `core/sanitize.ts` `inspectScript` / `stripScript` | `/OpenAction`, `/AA`, `/JS`, named scripts | yes — the writers that add actions | **no** (`inert-controls.test.ts` builds its own shapes; `scripts/attachments` never tested it) |
| `core/signature.ts` `readSignatures` | `/Perms`, `/ByteRange`, `/Contents`, `/SW` | yes — `sign-pdf` | **no** — every input is signed by this app |

**Count: of the 13 readers above, 4 have met a foreign file in CI — and 3 of those 4 are
the cipher trio plus content-stream decoding, which met foreign bytes only because a
password test had to. 9 have never been handed a file this repo did not write.** The
attachments row is the one that changed today, and it is also the proof that "never" did
not mean "fine": the reader had 8 passing tests and failed 10 of 15 foreign shapes.

## Table 2 — measured behaviour on foreign bytes

From `foreign-structure-audit-table.md`. Verdicts are this pass's; nothing here is fixed
except the attachments row.

| reader | foreign shape | outside reader | this app | verdict |
| --- | --- | --- | --- | --- |
| `listAttachments` | inline file spec (MuPDF's spelling) | MuPDF, pypdf, poppler all list `note.txt` | was "no embedded files", now the file | **fixed here**, pinned by 15 fixtures |
| `readOutline` | `/Outlines` with a child entry | MuPDF 3 entries / 2 levels; pypdf same | 3 nodes, depth 2 | correct |
| `readOutline` | `/Dest` naming an **inline** destination array | pypdf resolves both to pages 1 and 2 | pages 0 and 1 (0-based: correct sheets) | correct |
| `readOutline` | `/Dest` naming an array **behind a reference** | pypdf resolves both | **both `page: null`** | **same defect class** — `resolveNamedDestination` wants `value instanceof PDFArray` and never follows the reference |
| `readOutline` | `/Dests` as a `/Kids` + `/Limits` tree | pypdf walks it and resolves both | **both `page: null`** | **same defect class** — no `/Kids` walk |
| `readPageLabels` | `/PageLabels` as a `/Kids` number tree | MuPDF: 3 ranges (`i-1`, upper roman, lower alpha) | `["1","2","3"]` | **wrong, silently** — reads `/Nums` on the root only |
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
class, and the class has nine untested-at-foreign readers in it.

## Left deliberately

- **No fixes to the readers in Table 2** except attachments. Report, per the task; the
  `/Dests` and `/PageLabels` rows each need their own branch, a foreign fixture per
  shape, and — for `/PageLabels` — a decision about whether a tree-shaped label number
  tree is common enough in the wild to matter (the fixture proves our reader is wrong on
  it, not that users hit it).
- **The rig is not in CI.** `docs/research/foreign-structure.vitest.config.ts` keeps it
  out of `tests/**`, the same choice as the encrypted-inputs rig, because it reads
  committed fixture bytes that no CI assertion compares today. Making it CI means
  asserting the two wrong rows, which means fixing them first.
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
```
