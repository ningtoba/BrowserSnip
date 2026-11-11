# The reader sweep, reconciled: which functions are still foreign-untested

The sweep (`docs/research/foreign-structure-audit.md`, `370cefb`) turned "our readers
might only understand our own output" into a count: **13 rows, 4 had met a foreign file
in a CI test, 9 had never.** Two of those nine were then fixed and pinned
(`7d1d1ad` — `readPageLabels`, `readOutline`), and the rig beside them handed a verdict
to four more. This file is the arithmetic over the code rather than over the prose, so
"unknown" becomes a number.

Everything below was read out of the tree at `74f6eb8`; each row names `file:line` for
every function, the test files that call it, and whether any of those tests opens a PDF
this repo did not write. The only foreign-produced PDFs in the repo are
`tests/fixtures/encrypted/`, `tests/fixtures/attachments/`, `tests/fixtures/foreign/`
and `tests/fixtures/readers/` (generators `scripts/*-fixtures.py`, all four frozen for
byte-reproducibility and censused by outside readers).

## The count, corrected

* **Rows: 13.** Agrees with the sweep.
* **Named functions: 18, not 17.** The sweep's "17 exported functions, the same 13 walks
  behind them" is one short. Summing the function names printed in its own Table 1:
  1 + 1 + 1 + 2 + 1 + 1 + 1 + 1 + 2 + 2 + 2 + 2 + 1 = **18**. The rows that carry two
  names are `content.ts` (`streamBytes`, `pageContentStreams`), `annotations.ts`
  (`listAnnotations`, `annotationCount`), `metadata.ts` `/Info` (`readInfo`, `readXmp`),
  `metadata.ts` resources (`listFonts`, `listImages`) and `sanitize.ts` (`inspectScript`,
  `stripScript`). It is a floor as well as an error: the same `/Info` row omits
  `metadata.ts:413 readXmpText`, which `readXmp` is built on and which the XMP tests
  never feed a foreign packet.
* **Foreign-tested in CI now: 6 rows** (the sweep's 4, plus `readOutline` and
  `readPageLabels` since `7d1d1ad`). This is what the sweep's own line 57 says today, and
  it is the number that replaced the original 4/9 split.
* **Never foreign-tested: 7 rows.**
* **Of those 7, four carry a measured verdict** from the audit rig
  (`docs/research/foreign-structure-audit-table.md`, run by
  `docs/research/foreign-structure.vitest.config.ts`, not in CI): `listLayers`,
  `listAnnotations` + `annotationCount`, `listFormFields`, `readInfo` + `readXmp` — all
  four answered correctly on MuPDF/libqpdf-written bytes.
* **So the residue is three rows, not two:**

  | row | functions | why nothing measured it |
  | --- | --- | --- |
  | `core/metadata.ts` | `listFonts` (`:883`), `listImages` (`:940`) | **zero test references anywhere in `tests/` or in the rig** — the sweep's own row said "no test at all", and the rig's Table 2 never asked them a question |
  | `core/sanitize.ts` | `inspectScript` (`:321`), `stripScript` (`:339`) | zero direct references; reached in CI only through `sanitize-pdf` in `tests/pdf/inert-controls.test.ts`, on a document built here |
  | `core/signature.ts` | `readSignatures` (`:135`) | 5 CI test files, every input signed by this app (`signDocument` + `createSelfSignedCertificate`); no foreign `/Sig` exists in the repo |

  The "roughly two" in the task brief counted `listFonts`/`listImages` out as dead code.
  **They are not dead**: `metadataReport` calls both (`metadata.ts:779`, `:797`) and
  `metadataReport` is the `view-metadata` tool (`tools/security.ts:938`), whose rail
  prints a font and an image inventory to a user. The sweep's parenthetical — "neither is
  called outside `metadata.ts`" — is literally true and easy to misread, which is what
  happened here. The one CI test of `metadataReport` (`tests/pdf/metadata.test.ts:183`)
  builds its document with `newPDF()` and adds no font and no image at all, so the two
  functions have never been run on any file, foreign or native, in CI.

**Answer to the question the sweep was built to answer: 3 rows / 5 functions remain
foreign-untested at the start of this pass**, and the corrected ledger is below.

## Table R — every reader the sweep counted, against the code

`status` is one of `foreign-tested` (a CI test opens a file this repo did not write),
`never tested` (CI only ever feeds it this app's own output), `measured once, not pinned`
(the hand-run rig has a verdict but nothing in `tests/**` asserts it), `not applicable
(dead code)`.

| # | row (sweep) | functions, with `file:line` | CI tests that call it | opens a foreign file? | status |
| --- | --- | --- | --- | --- | --- |
| 1 | `attachments.ts` | `listAttachments` `core/attachments.ts:325` | `attachments-foreign`, `attachments`, `edge-security`, `security-bytes`, `protect-spec`, `page-copy-fidelity` | yes — 15 shapes in `tests/fixtures/attachments/` (16 files, one is the shared `_base.pdf`) | **foreign-tested** |
| 2 | `guard.ts` | `classifyEncryption` `core/guard.ts:322` | `encrypted-guard`, `password-anywhere`, `remove-restrictions` | yes — `tests/fixtures/encrypted/` (libqpdf + MuPDF ciphers) | **foreign-tested** (for a cipher, not a structure) |
| 3 | `crypto.ts` | `decryptDocument` `core/crypto.ts:1066` | `crypto-decrypt`, `crypto-encrypt`, `crypto-aes256` | yes — same 12 files | **foreign-tested** (cipher) |
| 4 | `content.ts` | `streamBytes` `core/content.ts:1049`, `pageContentStreams` `:1076` | 19 test files | yes — `crypto-decrypt.test.ts:29` and `crypto-aes256.test.ts:35` import `streamBytes` and run it over `tests/fixtures/encrypted/`; `readers-foreign.test.ts:34` runs `pageContentStreams` over MuPDF's bytes | **foreign-tested** (incidentally) |
| 5 | `bookmarks.ts` outline | `readOutline` `core/bookmarks.ts:245` | `readers-foreign`, `page-copy-fidelity`, `bookmarks`, `edge-edit`, `edge-security`, `security-bytes`, `protect-spec`, `crypto-aes256` | yes — 18 foreign outline shapes since `7d1d1ad` | **foreign-tested** |
| 6 | `bookmarks.ts` labels | `readPageLabels` `core/bookmarks.ts:1144` (+ `readPageLabelRanges` `:1096`) | `readers-foreign`, `page-labels-copy`, `page-copy-fidelity`, `bookmarks` | yes — 16 foreign label shapes since `7d1d1ad` | **foreign-tested** |
| 7 | `forms.ts` | `listFormFields` `core/forms.ts:229` | `edge-forms-core`, `edge-edit`, `page-copy-fidelity` | no — MuPDF's `form.pdf` verdict only in the hand-run rig | measured once, not pinned (correct) |
| 8 | `layers.ts` | `listLayers` `core/layers.ts:77` | `optional-content`, `edge-forms-core`, `edge-edit`, `optimize-bytes` | no — `layers.pdf` only in the rig | measured once, not pinned (correct) |
| 9 | `annotations.ts` | `listAnnotations` `core/annotations.ts:601`, `annotationCount` `:688` | `annotations`, `annotation-editor`, `edge-edit`, `edit-bytes`, `edge-security`, `security-bytes`, `protect-spec` | no — `annotations.pdf` only in the rig | measured once, not pinned (correct) |
| 10 | `metadata.ts` `/Info` | `readInfo` `core/metadata.ts:243`, `readXmp` `:421` (and `readXmpText` `:413`, uncounted) | `metadata`, `security-bytes`, `pdfa-structure` | no — `metadata.pdf` only in the rig | measured once, not pinned (correct) |
| 11 | `metadata.ts` resources | `listFonts` `core/metadata.ts:883`, `listImages` `:940` | **none** | no | **never tested** |
| 12 | `sanitize.ts` | `inspectScript` `core/sanitize.ts:321`, `stripScript` `:339` | only via `sanitize-pdf` in `inert-controls` | no | **never tested** |
| 13 | `signature.ts` | `readSignatures` `core/signature.ts:135` | `signature`, `edge-security`, `edge-signature-core`, `ux-text`, `editor-surface` | no — every input signed here | **never tested** |

Totals over the code: **13 rows, 18 named functions, 6 rows foreign-tested in CI, 4 rows
with a hand-run verdict and no pin, 3 rows with neither.**

## What this pass does with that

1. **Pins the four "measured once, not pinned" rows into CI**, so a verdict that today
   lives in a markdown table cannot rot: the rig's fixtures are asserted in
   `tests/pdf/` against outside-reader answers recorded in `census.json`.
2. **Measures the three unmeasured rows per shape** against MuPDF 1.28.2 (PyMuPDF),
   pypdf 6.14.2, libqpdf 12.3.2 (pikepdf 10.9.1) and OpenSSL as the outside witnesses —
   new fixtures in `tests/fixtures/foreign/`, written by
   `scripts/foreign-structure-fixtures.py` (the rig that already produced the rows above,
   so this adds shapes to one generator rather than founding a fourth).
3. **Reports what breaks, and fixes nothing** beyond one-line exceptions listed at the
   end.

### Readers on this box, named rather than inherited

Producers and outside readers available here: **MuPDF 1.28.2** (PyMuPDF), **pypdf
6.14.2**, **libqpdf 12.3.2** (pikepdf 10.9.1), **poppler 26.10.0** (`pdfinfo`,
`pdfdetach`), **Ghostscript 10.08.0**, **OpenSSL** (`openssl cms`, used as the witness
for a PKCS#7 blob this repo hand-assembles). **Absent: `qpdf`, `mutool`, veraPDF,
Java**, and PyMuPDF 1.28.2 here exposes no `sign_file`/`sign_archive`, so no outside tool
*writes* a signed PDF on this box — the signature fixtures are assembled from a
libqpdf-written dictionary plus an OpenSSL-generated key/certificate and a PKCS#7
`SignedData` encoded by `scripts/pdf_fixture_pkcs7.py` and verified by `openssl cms
-verify`, which is the closest thing to a foreign signer available.
