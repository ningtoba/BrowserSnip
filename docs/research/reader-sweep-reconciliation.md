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

| # | row (sweep) | functions, with `file:line` | CI tests that call it | opens a foreign file? | status at `74f6eb8` |
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

*That is the state at `74f6eb8`, which is what this table was written to establish. After
the measurements below, rows 7 to 13 all read **foreign-tested**: rows 7–10 because the
verdict the hand-run rig recorded is now asserted in CI, rows 11–13 because they have
per-shape fixtures and assertions of their own. The 17-vs-18 function count and the
two-vs-three unmeasured residue are corrected in the arithmetic above.*

## What this pass did with that

1. **Pinned the four "measured once, not pinned" rows into CI** — `listLayers`,
   `listAnnotations` + `annotationCount`, `listFormFields`, `readInfo` + `readXmp` are now
   asserted in `tests/pdf/readers-sweep-foreign.test.ts` against the outside columns in
   `tests/fixtures/foreign/census.json`.
2. **Measured the three unmeasured rows per shape** — 17 new fixtures in
   `tests/fixtures/foreign/` (29 files in the set at that point, byte-identical across
   two rebuilds in separate processes, each re-hashed against `MANIFEST.json` by the
   test), written by `scripts/foreign-structure-fixtures.py` — the rig that already
   produced the rows above, so this added shapes to one generator instead of founding a
   fourth — with `scripts/pdf_fixture_pkcs7.py` for the one thing no installed tool could
   do (write a signed PDF). The fix pass added three more shapes and re-cut one
   (`--check`: **32 fixtures**, byte-identical across two rebuilds), for the reason given
   in the row-11 table: a claimed shape has to be in the bytes.
3. **Reported what breaks and fixed nothing**: two defects and one blind spot were named
   below with the bytes that show them. No file under `src/lib/pdf/core/` was touched
   by *that* pass; `bc0bcdd` fixed both defects on one descent, and the rows and tickets
   below carry the correction.

### Where the measurements came from

MuPDF 1.28.2 (PyMuPDF) wrote the pages, the three faces (base-14 Helvetica, an embedded
TrueType subset, an OpenType/CFF face through `/FontFile3` + `/CIDFontType0C`) and the two
rasters (one `/FlateDecode`, one `/DCTDecode`, both behind an `[/ICCBased …]` colour
space). libqpdf 12.3.2 (pikepdf 10.9.1) wrote the resource layouts that survive a
libqpdf round trip, the eight script spellings, and every `/Sig`, `/ByteRange` and
`/Perms` dictionary; the two **inherited** layouts are cut by MuPDF after the freeze,
because libqpdf pushes inherited page attributes down onto every leaf as it opens a
file and so cannot commit them. OpenSSL 3.6.5 generated
the key pair (`tests/fixtures/foreign/signer-key.pem`, `signer-cert.pem`, serial `1337`,
validity 2023-01-01 → 2046-01-01) and **verifies every signature in the census**
(`openssl cms -verify -binary`), which is also what catches `sig-tampered.pdf`.
poppler 26.10.0 is the parse witness for all 32 files (`pdfinfo` must open each; the test
asserts the recorded answer) and, for the script row, its `JavaScript: yes/no` line is an
outside reader's conclusion about the same trees.

**Absent on this box, so no claim is made about them: `qpdf`, `mutool`, veraPDF, Java, and
any signing tool at all** — PyMuPDF 1.28.2 here exposes no `sign_file`/`sign_archive`, so
the PKCS#7 `SignedData` is encoded by `scripts/pdf_fixture_pkcs7.py` (deterministic:
PKCS#1 v1.5, a committed key, a fixed `signingTime`) from a certificate and private key
OpenSSL wrote. The fixture bytes are pinned; the *producer* of the CMS blob is this repo,
and its parsing is judged by OpenSSL. A second pass with a real signer should re-measure.

## Table M — row 11, `listFonts` / `listImages` (7 shapes)

The `this app` column is the walk **after** ticket 1 was fixed (`bc0bcdd`): both
inventories now run over `core/content.ts resourceScopes`, which is the one
`core/tree.ts descend` kernel handed the resource edge function. Rows 1, 4 and 5 read as
they did when they were measured; row 2 carries the correction its own bytes demanded,
row 6 is ticket 1, and rows 3 and 7 are the two shapes the fix pass added because the
five the measuring pass shipped could not tell a descent from a single step.

| fixture | the shape | MuPDF, and a libqpdf walk over the resolved resources | this app | verdict |
| --- | --- | --- | --- | --- |
| `resources-plain.pdf` | each page names its own `/Resources` — the control | 3 faces + 2 rasters on sheet 1 | 3 faces (`Fixture Sans Regular`/Type0/`/FontFile3`, `NotoSans-Regular`/Type0/`/FontFile2`, `Helvetica`/Type1/not embedded), 2 rasters (40×24, 8-bit, ICCBased, 47 B Flate + 619 B DCT, page [1]) | **correct** |
| `resources-inherited.pdf` | `/Resources` on the `/Pages` node and on no page (§7.7.3.3) | 3 faces + 2 rasters on all three sheets, reached by ascending `/Parent` | the same 3 faces; each image listed once with `pages: [1,2,3]` | **fixed with ticket 1** — and the row as first written did not describe the file: **libqpdf pushes inherited page attributes down onto every leaf as it opens the document**, so the generator's freeze (a libqpdf re-save) had restored a `/Resources` on all three pages and the file was the `shared` shape wearing another row's sentence. It is now cut by MuPDF *after* the freeze, and `census.json` carries `page_tree_layout` — read off MuPDF's object layer, because pikepdf cannot see this shape at all — which `readers-sweep-foreign.test.ts` asserts per row. A page-level walk reads **nothing** from the real bytes: `page.node.get('/Resources')` has no answer for a leaf that names none. |
| `resources-inherited-parent.pdf` | an intermediate `/Pages` node carries the dictionary for pages 1–2 — two `/Parent` hops — while page 3 names its own | MuPDF counts `[3, 3, 1]` fonts and `[2, 2, 0]` images by sheet; the libqpdf walk resolves the first two up the chain and takes the third from the leaf | 3 faces; both rasters with `pages: [1,2]`; sheet 3 claims nothing it does not name | **correct since the same fix**, and the shape that separates a walk that ascends from one that only looks at the father |
| `resources-shared.pdf` | three pages naming the *same* `/Resources` object | idem | idem, deduplicated by name and by object | **correct** |
| `resources-subset.pdf` | the two embedded faces renamed `BCDFEE+…` / `ABCDEA+…` | the tags are in `/BaseFont`, on both the Type0 and its descendant | `subset: 'BCDFEE'` split out of `name: 'BCDFEE+NotoSans-Regular'`; the name is the **descendant's** `/BaseFont` where MuPDF prints the Type0's (`BCDFEE+Noto Sans Regular`) — two spellings of one face, pinned so a change cannot pass silently | **correct** |
| `resources-xobject.pdf` | sheet 1 draws one Form XObject that carries every font and image | MuPDF: 3 fonts and 2 images on page 1, 1 XObject; the libqpdf walk finds them under `form-xobject:/Fm0` | 3 faces, and 2 rasters listed against page [1] | **fixed — ticket 1** (was: 1 face borrowed from sheets 2–3 and *no images*, which the `view-metadata` card printed as “None · no raster images are embedded”) |
| `resources-form-in-form.pdf` | a Form XObject that draws a second form, the inventory split across the two levels | MuPDF lists 2 XObjects, 2 images and 4 font placements on sheet 1 (three faces: `/outer` and `/helv` are one object named twice); the walk finds the base-14 face under `form-xobject:/Fm0` and the rest under `form-xobject:/Inner` | 3 faces, 2 rasters on page [1] | **correct since the same fix** — and the shape that separates a descent from a single step into the first form |

Two things the fixed walk deliberately does **not** claim, both pinned in
`tests/pdf/descent-nesting.test.ts`: a form whose own stream dictionary declares
`/XObject` with no `/Resources` wrapper is not followed (no viewer resolves names
there, so listing that raster would tell the user the page draws a picture it never
draws — `core/compress.ts` keeps tolerating the spelling for re-encoding, where a
rewrite cannot make the file wrong), and a form written without `/Resources` hands
back the *enclosing* dictionary (§8.10.1) which the descent has already visited, so
its faces are listed once rather than twice.

## Table M — row 12, `inspectScript` / `stripScript` (9 shapes)

The outside column is `pdfinfo`'s `JavaScript:` line and an entry-by-entry walk written
over the libqpdf model for this census (`qpdf_script_sites`); the app column is
`inspectScript`, then `stripScript` and what survives in the bytes it wrote (each
fixture carries distinct planted code, and the saved file is inflated with `node:zlib`
before it is searched).

| fixture | the shape | outside | this app, before and after a strip | verdict |
| --- | --- | --- | --- | --- |
| `script-openaction-inline.pdf` | `/OpenAction` with the action inline | poppler `yes`, 1 site | 1 (`catalogue /OpenAction`) → 0, no code left | **correct** |
| `script-openaction-ref.pdf` | `/OpenAction` naming the action behind a reference | poppler `yes`, 1 site | 1 → 0, and the orphaned action object is deleted | **correct** |
| `script-openaction-array.pdf` | `/OpenAction` naming **two** actions in one entry | poppler **`no`**, 1 site | 1 → 0 | **correct**, and a recorded disagreement: this app counts the entry, poppler's `pdfinfo` does not report the array form at all |
| `script-js-key-only.pdf` | an action with `/JS` and no `/S` | poppler **`no`**, 1 site | 1 → 0 | **correct** by the module's documented rule (a viewer runs it); poppler's refusal is recorded, not adjudicated |
| `script-names-flat.pdf` | `/Names » /JavaScript` flat, one value inline, one referenced | poppler `yes`, 2 sites | 1 (`the JavaScript name tree`) → 0, tree gone, **both** bodies gone | **correct** — one entry per entry point, two per action; the units are pinned so the two columns are never compared as numbers |
| `script-names-kids.pdf` | the same two scripts inside a `/Kids` + `/Limits` subtree, one leaf per script | poppler **`yes`**, 2 sites | 1 — the tree — and **both** bodies go with it: the inline `/JS` is emptied before `/Names » /JavaScript` is deleted, so the saved bytes hold no `console.clear()` | **fixed — ticket 2** (`bc0bcdd`). As first measured it reported `a dictionary in the file /JS` (the leftover sweep, not the tree) and `console.clear()` survived, because that action is an **inline name-tree value with no object number**, which no indirect sweep can reach. The fixture was re-cut at the same time: its two scripts now sit in two leaves with their own `/Limits`, which is what a balanced tree looks like. |
| `script-names-kids-nested.pdf` | a `/Kids` JavaScript tree whose kid is itself a `/Kids` node | poppler **`yes`**, 2 sites | 1, the tree; nothing survives | **correct since the same fix** — the shape that separates a descent from one step into `/Kids` |
| `script-hosts-aa.pdf` | page `/AA /O`, annot `/AA /E`, field `/AA /K`, field `/A`, and a field with neither | poppler `yes`, 4 sites | 4, naming all four hosts (`page 1 /AA /O`, `form field “totals” /AA /K`, `form field “heading” /A`, `the annotation on page 1 /AA /E`) → 0 | **correct**, including the field that carries no action |
| `script-xfa.pdf` | `/AcroForm /XFA` whose script lives in the packet's XML | poppler `no`, 0 sites, XFA present | 0 + `unreachable: "the script inside its XFA form packet…"`, and the packet's code is still there afterwards | **correct** — it says what it cannot reach instead of claiming a clean file |

## Table M — row 13, `readSignatures` (5 shapes)

| fixture | the shape | OpenSSL (`cms -verify` over the two `/ByteRange` spans) | this app | verdict |
| --- | --- | --- | --- | --- |
| `sig-detached.pdf` | `/FT /Sig`, `/V` behind a reference, `adbe.pkcs7.detached`, SHA-256, one line of hex | verifies | `digestMatches: true`, `byteRange [0, 854, 4950, 2346]` — the same four numbers the file spells, zero-padded | **correct** |
| `sig-contents-wrapped.pdf` | the same with `/Contents` wrapped across lines, as Acrobat writes it | verifies | `digestMatches: true`; `readHexString` unfolds the whitespace | **correct** |
| `sig-two-fields.pdf` | two `/Sig` fields: the first covers only its own generation (last span 0), the second the whole file | verifies, both | both `digestMatches: true`, in `/Fields` order | **correct** |
| `sig-perms.pdf` | a signed file that also declares `/Perms /DocMDP` with `/P 1` | verifies | `digestMatches: true` — and **nothing about `/Perms`**: the reader consults `/AcroForm /Fields`, `/T`, `/V`, `/ByteRange`, `/Contents` and the CMS, never `/Perms` (`grep -c Perms core/signature.ts` = 0) | correct as far as it goes — **blind spot 3** |
| `sig-tampered.pdf` | one byte of the field name changed after signing | **refuses** (`CMS_SignerInfo_verify_content: verification failure`) | `digestMatches: false`, `fieldName: 'Signature7'` — the very byte that was changed is what it prints | **correct**, and the control that shows the digest comparison is a computation |

The certificate columns are pinned against `openssl x509` too: `signer`/`issuer`
`Foreign Signer`, `notBefore` 2023-01-01, `notAfter` 2046-01-01, `signedAt`
2024-01-01T12:00:00Z (a signed attribute fixed in the fixture, not a clock),
`digestAlgorithm` SHA-256 against `:sha256WithRSAEncryption` in the DER.

## Tickets: two broken, one blind — and the two broken ones are now fixed

Items 1 and 2 were filed unfixed by the measuring pass and are **closed by
`bc0bcdd`**, on one descent rather than two repairs; item 3 is still open. The
shape chosen, and why, is in the two entries below.

**The seam.** `core/tree.ts` already owned the rule “follow this reference, read what
you find, visit each dictionary once, stop at the bound”, but only in the form of
`collectTreePairs` — a name/number tree walk with `/Kids` as its one edge. `bc0bcdd`
extracts that recursion into `descend(doc, root, edges, maxDepth)` and expresses both
readers on it: `collectTreePairs` hands it the `/Kids` edge and reads `/Names` or `/Nums`
pairs off each node, and `core/content.ts:resourceScopes` hands it the `/XObject → /Form
→ /Resources` edge and starts from the page's resources resolved up the `/Parent` chain.
One descent, two edge functions — so the next reader that needs to descend adds an edge
function rather than a third copy of the loop, which is the thing that let these two drift
apart. The order is unchanged (a node before its children, children in edge order), which
matters: `attachments.ts` splices the host array it was handed.

1. **READER-SWEEP-1 — the resource inventories never entered a Form XObject. Fixed.**
   `core/metadata.ts listFonts` / `listImages` read
   `page.node → /Resources → /Font|/XObject` and stopped. `resources-xobject.pdf` holds
   `Resources << /XObject << /Fm0 n 0 R >> >>` on sheet 1 with the three faces and both
   rasters inside `/Fm0`'s own `/Resources` — MuPDF counts 3 fonts and 2 images for that
   page, the app reported one face (borrowed from sheets 2–3) and *no images at all*, and
   the `view-metadata` card printed `None · no raster images are embedded` over the file.
   Both functions now walk `resourceScopes`. Three consequences the fix had to answer
   rather than inherit: a form written **without** `/Resources` inherits the enclosing
   scope (§8.10.1), which the descent has already visited, so it is handed back rather
   than re-walked and its faces are listed once; a form whose own stream dictionary names
   `/XObject` with no `/Resources` wrapper is **not** followed, because the inventory
   says what the page draws and no viewer resolves names there (`core/compress.ts` keeps
   its tolerance for the rewrite case, where a missed image costs bytes rather than
   truth); and an image named twice on one sheet — two keys, or two forms — used to
   accumulate `pages: [1, 1]`, which prints “on 2 pages” about a single sheet.
   The same fix caught a third instance in the same card: `attachmentCount` read the
   `/EmbeddedFiles` root's own `/Names` array only, so
   `tests/fixtures/attachments/kids-tree.pdf` — two enclosures, one per kid — rendered as
   `Attachments: 0` beside a listing of both.
2. **READER-SWEEP-2 — the script walk did not enter a `/Kids` name tree. Fixed.**
   `core/sanitize.ts:namedScriptTree` read `tree.lookupMaybe('/Names', PDFArray)` on the
   `/Names » /JavaScript` root only: the 4th instance of the pattern `collectTreePairs`
   exists to end (attachments `9f4116b`, `/Dests` + `/PageLabels` `7d1d1ad`). The tree now
   goes through `collectTreePairs`, so both spellings of a pair’s value are reached — and
   the inline one is the half that mattered: an action stored **inside** a leaf has no
   object number, so it is not in `context.enumerateIndirectObjects()` and no leftover
   sweep can see it, which is why `console.clear()` sat in the output of a run whose card
   said the file was clean. The unit question the ticket left open — trees or actions —
   stays as the module had it: **one entry per entry point**, the tree, pinned against the
   outside column’s two script sites so the two numbers are never compared as one number
   (`script-names-flat.pdf` was already this shape and was already correct).
3. **`readSignatures` is blind to `/Perms`, measured not assumed.** It answers who signed
   and whether the bytes still match, and says nothing about a `/DocMDP` lock that
   forbids changes after signing (`sig-perms.pdf`, `/P 1`). Not called a defect here — the
   reader's contract is the signature, not the policy — but it is now counted, and a card
   that promises "what restricts this file" cannot be answered from it.

**Open seam, unchanged in name and wider in reach:** `core/metadata.ts:176 infoDict`
still throws `Expected instance of PDFDict, but got instance of undefined` for a document
with no `/Info`, the common MuPDF shape. The audit recorded it against `redact-pdf`; this
pass found the second consequence — `metadataReport` (and so the `view-metadata` card)
cannot render at all for those files, and `infoDict(doc, true)` throws too, so even the
creating path is unreachable. Both halves are pinned in
`tests/pdf/readers-sweep-foreign.test.ts` rather than fixed.

## The count, after this pass

**0 of the 13 rows are foreign-untested.** Six were before this pass, four more were
pinned here, and the three that had never been measured now have per-shape CI
assertions — which is where the two tickets came from, and both of those tickets are
closed: `93aa4fd` extracted the shared descent, `bc0bcdd` fixed `listFonts` /
`listImages` / `inspectScript` / `stripScript` (and `attachmentCount`, the third instance
found on the same card) on top of it, `d227879` + `2b31e0c` pinned the nesting the
foreign set does not carry. Over the 18 named functions the
same statement, with its limits:

* 18/18 now execute against bytes this repo did not write inside `tests/**`;
* "foreign" here means MuPDF, libqpdf and pypdf wrote the structures and MuPDF, poppler,
  pypdf and OpenSSL judged them — **not** a Word, Preview or Acrobat export, which is
  still the audit's open caveat and the reason tickets 1 and 2 are about shapes real
  producers are known to write rather than about hand-made oddities;
* no conformance claim: veraPDF and Java are absent from this box, and the signature
  fixtures' CMS blob is assembled here and *verified* by OpenSSL, not *produced* by a
  signer.

Re-run:

```sh
python3 scripts/foreign-structure-fixtures.py            # rebuild + census + MANIFEST
python3 scripts/foreign-structure-fixtures.py --check    # 32 fixtures, two processes, identical bytes
npx vitest run tests/pdf/readers-sweep-foreign.test.ts   # 81 assertions
npx vitest run tests/pdf/descent-nesting.test.ts         # 13 assertions, the kernel + the claims
npx vitest run tests/pdf/readers-foreign.test.ts tests/pdf/attachments-foreign.test.ts \
  tests/pdf/page-labels-copy.test.ts tests/pdf/engine-attribution.test.ts
```

The reverts that show the 81 assertions are load-bearing, each run against the file as
it stood: `listFonts` not consulting the descendant CID font → **4 red**; `listImages`
accepting only an inline XObject → **4 red**; `readHexString` keeping its whitespace →
**2 red**; `verifyOne` not comparing the recomputed digest → **2 red**; `isJavaScriptAction`
demanding `/S` → **1 red**; `jsActions` skipping an `/OpenAction` array → **1 red**;
`annotationCount` excluding pop-ups → **1 red**; `listLayers` ignoring `/OFF` → **1 red**;
`listFormFields` losing a checkbox state → **1 red**; `readXmp` dropping `dc:title` →
**1 red**.

### The counts the fix pass moved, and the ones it added

Reverting `listFonts` / `listImages` to the page-level walk and `namedScriptTree` to the
flat `/Names` read — `git checkout bc0bcdd~1` over those two files, with
`resourceScopes` left in place so the tests still import — turns **18 assertions red**:
10 in `readers-sweep-foreign.test.ts` (4 resource rows, the two per-shape descent tests,
the card row, and both script rows) and 8 in `descent-nesting.test.ts` (the two form
descents, the page-tree inheritance, both deduplication guards, the card, the attachment
count, the inline-`/Kids` strip). The other 5 in `descent-nesting` are green in both
states and are the controls: the three kernel rules, the form that keeps its names
outside `/Resources`, and the cycle test.

Two numbers in this file were wrong when they were written and are corrected here rather
than left standing: `resources-inherited.pdf` did not hold the shape its row named (see
the table), and the resource row is 7 shapes, not 5 — the two added by the fix pass are
the nested form and the `/Parent` hop two levels deep.


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
