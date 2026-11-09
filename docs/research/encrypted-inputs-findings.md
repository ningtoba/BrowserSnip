# `encrypted-inputs` — what this app believes about a PDF somebody else locked

Evidence pass, 2025-11-09, on `9fbf2b5`. **Nothing in `src/` was changed.** Every
number below is a measurement, and the harness that produced it is committed
beside this file:

```
python3 docs/research/encrypted-inputs-fixtures.py /tmp/einp      # make + verify the inputs
ENCRYPTED_INPUTS_DIR=/tmp/einp npx vitest run \
  --config docs/research/encrypted-inputs.vitest.config.ts --disableConsoleIntercept
python3 docs/research/encrypted-inputs-readers.py  /tmp/einp      # judge the bytes with 5 readers
python3 docs/research/encrypted-inputs-table.py     /tmp/einp      # render the ledger tables
```

`docs/research/encrypted-inputs-run.sh` runs all four and leaves the logs in this
directory: `encrypted-inputs-fixtures.log`, `encrypted-inputs-app.log` (what the
app said, 12 documents × 12 probes), `encrypted-inputs-readers.log` (what the
bytes are) and `encrypted-inputs-table.md` (both tables). §2–§4 describe the run
that made this file, and the logs of **that** run are kept beside it as
`encrypted-inputs-{fixtures,app,readers}-pre-guard.log` and
`encrypted-inputs-table-pre-guard.md`; the un-hyphenated logs are the same rig
re-run after the ciphered-input guard landed, and §8 is what moved.

The question, from the `protect` row: an encrypted PDF arrives from an outside
tool. What does this app believe, and is the belief true?

## 1. The inputs, and why they are valid

One document, written by MuPDF, carrying everything a page copy is known to lose:
three text pages (each naming its own sheet — `ALPHA`/`BRAVO`/`CHARLIE`), a text
note, a highlight, a link, a text field worth `Ada Lovelace`, a checked checkbox,
two bookmarks (one nested) and an enclosure `source.csv`. Then ten locks, by two
independent encryptors, at three strengths, and in **both kinds of secret**:

```
qpdf --allow-weak-crypto --encrypt reader-pass owner-pass 128 --use-aes=n \
     --print=none --modify=none --annotate=n --form=n --assemble=n --extract=y \
     --accessibility=y -- base.pdf einp-q-r3-rc4-128-user.pdf
qpdf --encrypt reader-pass owner-pass 128 --use-aes=y …           → einp-q-r4-aes-128-user.pdf
qpdf --encrypt reader-pass owner-pass 256 …                       → einp-q-r6-aes-256-user.pdf
qpdf --encrypt ""    owner-pass <same options> …                   → …-owner.pdf   (3 files)
python3 -c "import pymupdf; d = pymupdf.open('base.pdf'); d.save('einp-mu-r6-aes-256-user.pdf',
        encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw='owner-pass', user_pw='reader-pass', …)"  (4 files)
```

libqpdf 12.3.2 (what `pikepdf` embeds — the `qpdf` binary itself is not on this
box, so the CLI option set runs through the library's own job interface) and
MuPDF 1.28.2; `pypdf` 6.14.2, poppler's `pdfinfo`/`pdftotext` and Ghostscript
10.08 as the judges. Each file's own dictionary, its `qpdf --is-encrypted` verdict
(`encrypted` + `password_incorrect`), whether qpdf and MuPDF open it with its
password, whether they **refuse** the wrong one, and its object census are printed
in the fixtures log — the six user-password files refuse it under both tools
(`qpdf_rejects_the_wrong_one: "yes"`, `mupdf_accepts_the_wrong_one: false`), and the
four owner-only files report `n/a (no user secret set)`, which is the difference
this row is about. In 10/10 the census is identical to `base.pdf`, so nothing below
can be blamed on the encryptor. `manifest.json` carries all of it, and the
rig reads the manifest rather than a copy of its assumptions.

Every locked file, read by MuPDF: `pages 3, annots 2 (+6 raw /Annots entries:
2 widgets, 1 link, 1 popup), fields 2 ["Ada Lovelace","Yes"], bookmarks 2,
attachments ["source.csv"], 182 chars, planted sentence on 3/3 sheets, sheet-1 ink
0.46 %`. That is the baseline the operations are scored against.

The two kinds of secret behave as the spec says and the readers confirm:

| | qpdf `--is-encrypted` | MuPDF | poppler, **no password** | pypdf |
| --- | --- | --- | --- | --- |
| `-user` file (any strength) | `encrypted, password_incorrect: true` | `needs_pass=True`, opens with `reader-pass`, refuses the wrong one | `Command Line Error: Incorrect password` | `decrypt(user)=1`, `(owner)=2` |
| `-owner` file (any strength) | `encrypted, password_incorrect: **false**` | `needs_pass=False`, `authenticate("")` succeeds | **`pages=3`, planted text found, no error** | `decrypt("")=1` |

## 2. What this app believes (Table 1 of `encrypted-inputs-table.md`)

Sound, and measured sound on all ten files:

* **It asks.** `inspectPdf` with no password → `needsPassword=true error=PASSWORD_REQUIRED`, and a
  routine `rotate` run is refused before any work with `isPasswordRequired=true`
  and the sentence `"…" is password protected.`
* **The right password works** at RC4-128 and AES-128 (`accepted=true pages=3`), and a **wrong one
  fails clearly** (`error=BAD_PASSWORD`, `That password is not correct for "…"`).
* **The page count is right**: `app=3 MuPDF=3`, ten times, and `/P=-3376` is decoded
  correctly from the dictionary.
* **The preview draws and so does a thumbnail.** pdf.js — which implements the
  ciphers itself — returns `pages=3 ops=25 text="Lighthouse Inventory 1887 page 1
  Sheet ALPHA body copy"` and, through the shipped `renderToCanvas`/`thumbnails()`
  path, `fill 55, stroke 1, fillRect 1, drawImage 1, clip 1, path2d 27` on every
  one of the ten files, AES-256 included.

Wrong, in three distinguishable ways:

1. **AES-256 (`/V 5 /R 6`) is refused outright.** The correct password answers
   `accepted=false error=BAD_PASSWORD`; the owner password too; and all three
   operations abort — 12 of the 36 operation runs produced no file at all, with
   `That password is not correct for "einp-q-r6-aes-256-user.pdf"`. Same for the
   file MuPDF wrote itself (`einp-mu-r6-…`), so it is the handler, not the producer.
   The engine cannot even be asked for its census: `PDFDocument.load` throws
   `Input document to PDFDocument.load is encrypted`.
2. **An owner-password-only AES-256 file is reported as locked.** qpdf says
   `password_incorrect: false`, MuPDF `needs_pass=False`, poppler prints its three
   pages without being given anything — and this app answers
   `needsPassword=true error=PASSWORD_REQUIRED`, then `BAD_PASSWORD` for the real
   owner secret. The guard decides "restricted, not locked" by *loading with the
   empty password*, and that load is the R6 check that fails, so a file anybody can
   read is withheld from every tool. At RC4-128/AES-128 the same probe is honest:
   `opensEmpty=true`, "Restricted, not locked — it opens without a password."
3. **The two secrets are not distinguished, and a wrong one is "accepted" on a
   permissions-only file.** At every readable strength the owner password comes
   back `accepted=true` where a reader would have refused it, and on the `-owner`
   files the deliberately wrong password also comes back `accepted=true` — because
   `passwordAccepted` is `Boolean(password)` once the empty-password load has
   succeeded. pypdf keeps them apart on the same bytes (`user=1`, `owner=2`).

And underneath all of it, the reason the `protect` row pointed here: the engine
that every editing tool holds is handed **ciphertext it is never asked to undo**.
Page 1 of `einp-q-r3-rc4-128-user.pdf`, opened with the correct password:
`7b 73 7d f5 /Filter /FlateDecode — ciphertext behind its own /Filter`. The
consequences the app itself reports: field values arrive as mojibake
(`["checked", "Š¹—ãá¸;ùÀÈ[˝"]` where MuPDF reads `Ada Lovelace`), and `protect`'s
own result sentence, `change-permissions`, `flatten`, the text and page tools all
reason over those bytes. Two census differences visible in the same line —
`bookmarks 1 / 2` and `attachments [] / ['source.csv']` — are **not** cipher
effects: the unencrypted control `base.pdf` reads the same way (1 and `[]`), so
those belong to `readOutline`'s and `listAttachments`'s treatment of a
MuPDF-written name tree, and are recorded here so nobody re-attributing this table
blames them on encryption.

## 3. The three routine operations (Table 2)

`rotate` 90°, `remove-pages` page 2, `protect` again with a new password — 36 runs,
each scored by the app's own claims and then by MuPDF, qpdf, poppler, pypdf and
Ghostscript against the census of the file it started from.

**No tool reports a failure, and 18 of 18 produced files are blank.** For every RC4-128 and
AES-128 fixture — qpdf-written or MuPDF-written, user password or owner-only — the
app says, e.g. after `rotate` on `einp-q-r3-rc4-128-user.pdf`:

```
claims encrypted=true algorithm=no cipher needsPassword=false pages=3 /P=-3376 accepted=true error=—
gate (this app): none:PASSWORD_REQUIRED user:opens owner:BAD_PASSWORD again:BAD_PASSWORD
pdf.js pages=3 ops=2 text=" |  | "   draws: fillRect 1, drawImage 1, clip 1
engine pages=3 annots=6/entries 6 fields=0 [] bookmarks=0 attachments=[] · page 1: ae be c5 e2 — ciphertext
runner: pagesOut=3   message: "Rotated 3 pages by 90°."
```

and the bytes say:

```
MuPDF  "opens_with": ["user"], "cipher": "Standard V4 R4 128-bit None", "permissions": -4, pages 3
       planted_pages 3→0, sheet-1 ink 0.46 %→0.0 %, text 182→0 chars,
       fields 2→<UnicodeDecodeError …>, bookmarks 2→0, attachments 1→0
qpdf   --check: errors detected; dictionary /V 4 /R 4, /CF empty, no /StmF → the file now
       claims the /None filter, i.e. "these bytes are not encrypted", over RC4 bytes
poppler opens it with no password at all: "Unsupported version/revision (4/4) of Standard
       security handler" + "Unknown compression method in flate stream", 3 characters
pypdf  decrypt(user)=2 (owner), planted=false
gs     1 page of 3
```

Counted over the 18 files produced from foreign fixtures: **18/18 with
`planted_pages = 0`, 18/18 with `ink_page1_percent = 0.0`, 18/18 rejected by
`qpdf --check`, 12/18 still opening with the password the user holds** (the other
6 are the `protect` runs, which answer to the new password instead). Counts and
verdicts are stable across two independent runs of the rig — 36 runs, 12 aborted,
18 produced, 18/18 `silent-loss`, and both control tables identical — and what moves
between runs is the random key's output: the ciphertext bytes, the mojibake they
produce in the field values, and how many of the produced files are bad enough to
crash pdf.js (three in the first run, six in the logged one). Every one of them
`verdict: silent-loss`. `delete page 2` is the same shape with `pages=2` — the
count it reports is correct, which is exactly what makes it slip past a
page-count check. `MuPDF opens_with=[empty,user,owner,again,again-owner]` on the
owner-only runs: the restrictions went away with the dictionary.

**On the MuPDF-written inputs the corrupted copy can also crash the preview.** In
the logged run, six of the eighteen — all three operations on each of
`einp-mu-r3-rc4-128-user.pdf` and `einp-mu-r4-aes-128-user.pdf` — hand back a page
that makes **this app's own pdf.js throw**: `UnknownErrorException: Invalid number: j
(charCode 106)`. The count moved between two runs of this rig (three, then six)
because which bytes land in a `/Contents` position depends on the random key, so the
claim is stated as far as the measurement goes: *on MuPDF-written RC4-128 and
AES-128 inputs the produced file sometimes crashes the preview; on qpdf-written ones
in these two runs it never did*. Same for the exact ciphertext head — `ae be c5 e2`
in the log, `7b 73 7d f5` in the earlier run — the fact recorded is *"not `78 …`, so
not flate, so ciphertext"*, not the bytes. In the `protect` run the tool noticed
something and blamed the wrong party — twice in this log, once per MuPDF-written
strength:

> `No PDF reader could be started in this browser to re-check the saved file
> (Invalid number: j (charCode 106)), so only the built-in engine's own view of it was verified.`

> `No PDF reader could be started in this browser to re-check the saved file
> (Illegal character: 41), so only the built-in engine's own view of it was verified.`

A reader *was* started — it read the file and threw. The sentence reports a missing
reader where the bytes are the fault, which is the same misreading as in the other
produced files except that in those the app says nothing at all.

## 4. The verdict on the `rotate`-preserves-protection ruling

The ruling stands as an intention; its **evidence does not**. It was written and
tested against files this engine wrote itself — `tests/pdf/edge-organize.test.ts`
builds its locked input with `doc.save({ encrypt: … })`, i.e. the dictionary the
`protect` row proved sits over plaintext — so `expect(text(bytes)).toMatch(/\/Encrypt/)`
and `PDFDocument.load(bytes, { password: 'hunter2' })` are pdf-lib reading its own
output. Nothing in the suite fed it a file with a cipher behind the dictionary.

This pass re-ran the ruling on both kinds of input, in the same rig
(`base.pdf` → this app's `protect` → the same three operations):

| input | rotate | delete a page | protect again |
| --- | --- | --- | --- |
| `base.pdf`, unencrypted | **reads**: 3/3 planted, ink 0.46 %, bookmarks 2 and the enclosure kept | 2/2 planted, ink 0.46 %; bookmarks 2→0 and the enclosure lost with the rebuilt tree | **reads**, objects intact |
| `own-protected.pdf`, this app's gate | **words read** (3/3 planted, ink 0.46 %) and the gate opens with `user`; bookmarks 2→0 and the enclosure lost — the page-copy loss other rows already carry | same shape, 2/2 planted | **reads**, 2/2 objects intact |
| the 6 foreign RC4-128/AES-128 files | **silent-loss** ×6 | **silent-loss** ×6 | **silent-loss** ×6 |
| the 4 foreign AES-256 files | aborted | aborted | aborted |

(`own-protected.pdf` itself, before any operation, reads 3/3 planted at 0.46 % ink
with bookmarks 2 and the enclosure — so the losses in its two rebuild rows belong
to the page copy, and are the same ones the `organize` and `remove-blank-pages`
rows carry. They are not encryption damage, and they are not what the foreign rows
above are: those lose the **words**.)

So the answer, plainly: **preserved *and* corrupted — corrupted-but-silent.** The
gate is genuinely re-issued and MuPDF does open the rotated file with the same
password; what the ruling did not know is that the bytes it re-keyed were never
decrypted, so the copy is ciphertext now described by a dictionary that says
"no crypt filter", i.e. a page that every conforming reader renders blank. On a
file this app locked itself the very same code path keeps the words — which is
why the tests are green and why they are not evidence. The `protect` row's
left-open item (3) ("`preserveProtection` re-keys a document whose ciphertext it
never undid") is therefore confirmed, and is worse than it reads: the password
still matches, so even a check of "does the password still work" passes.

## 5. Limited by this test environment, not by the deployed app

* **jsdom has no 2-D raster.** "The preview draws" and "the thumbnail draws" are
  reported as pdf.js's operator count and its drawing calls into a recording
  canvas (`encrypted-inputs-canvas.ts`), not as pixel percentages; `dark=0` in
  those rows is the shim, not the app. Pixel ink *is* measured — for the produced
  files, by MuPDF's `get_pixmap` (`ink_page1_percent`), which is the half that has
  to be true in the browser too.
* **pdf.js glyph paths** are missing under jsdom (`getPathGenerator … Helvetica_path_N`),
  which is why the collector filters that family; it inflates no count that matters.
* **Reader differences are the readers'.** poppler reports `Unsupported
  version/revision (4/4)` and treats this app's `/None` gate as no gate (already
  recorded in the `protect` row); Ghostscript reaches 1 page of 3. Both were run as
  CLIs here, so the numbers describe those tools, not this app's users in general.
  Nothing in §3 depends on them: MuPDF, qpdf and pdf.js agree independently.
* **The deployed bundle is the same code path** for the ciphertext rows —
  `runPdfTool`/`core/doc.ts`/`core/guard.ts` are what ships — so §2 and §3 apply to
  the site, not only to the test run. The preview/thumbnail rows are the ones to
  re-measure in Chromium if a fix needs screen evidence.

## 6. Not measured, and why

* `unlock`, `change-permissions`, `remove-restrictions` and the other ~119 tools:
  this pass was scoped to the three operations the task named. `unlock` is already
  measured in the current row (four pages, no content) and shares `core/doc.ts`.
* Whether the **annotation and form writers** corrupt ciphertext further (e.g.
  `add-text-annotation` writing plaintext into a file whose dictionary claims
  AES): out of scope for three operations.
* **Non-ASCII / R4-`/Crypt` / AES-256 alternative-handler files** (`/R 5`,
  `/Identify X.509`, no `/Filter /Standard`): not produced here, so unproven.
* **Real user files** from Word/Preview/Acrobat: the ten fixtures are
  synthetically rich but single-producer-per-lock.

## 7. Severity and the next step

**Severity: blocker, unchanged in kind and raised in reach** — `core/doc.ts:openPDF`
is the shared intake of every tool in the catalogue, and this pass measured that a
routine edit of any genuinely encrypted file yields a file that reports success,
counts the right pages, still answers to the user's password, and prints blank
paper (18/18), while AES-256 files cannot be edited at all (12/12 runs aborted) and
owner-password-only AES-256 files are refused as locked. Not "this is fine, close
it": the control shows the same operations are honest on this app's own files, so
the difference is this app's read path, not the format.

**Recommendation, in one paragraph.** Do the read half before the write half, and
do it as one seam: add the decrypt-on-load pass in `core/doc.ts:openPDF` (the fork
exports `PDFSecurity.decryptStream` and never calls it, so the missing work is
wired-in rather than invented), fix the R6 user-password verification in the same
change since it is the same module's cipher table and currently turns AES-256 into
"every tool refuses this file", and re-run *this* rig as the acceptance test —
`planted_pages 3→3`, `ink_page1_percent > 0` and `qpdf --check` clean on all 18
produced files, plus the four AES-256 fixtures reaching an output at all. Sequence
it ahead of the AES-128 encrypt-on-save work the `protect` row asks for: a cipher
this app can write but not read would turn its own protected downloads back into
blank pages the second a user re-opens them here, and the round-trip tests would
still be green because they read what they wrote. Until that pass lands, the
honest product answer is the one the intake already half-gives: an encrypted file
previews correctly, and every operation on it should be gated behind "this copy may
need re-doing in the tool that locked it" rather than reported as a success.

## 8. The guard, re-measured with this rig

That last sentence is what shipped, on `3f4f188` and `7dfe088`, and the same rig
was run again to score it. Nothing else about the harness moved: same twelve
documents, same twelve probes, same five readers.

**A refusal, not a rewrite, wherever a cipher is really in force.** Every one of
the ten outside-locked fixtures is now classified from its **effective crypt
filter** — `/StmF` and `/StrF` resolved through `/CF`, with `/None` and `/Identity`
predefined and `/V 1`–`/V 3` implying RC4 — as `ciphered`, and every tool that
hands back a rebuilt PDF is refused before any work, through `preflightPdf`. 30 of the 30 operation runs on those fixtures (10 files × rotate,
delete a page, protect) answer:

```
after rotate: refused: UNSUPPORTED isPasswordRequired=false · ""einp-q-r3-rc4-128-user.pdf" is encrypted with RC4-128 (revision 3): its pages are stored as ciphertext, and this app cannot decrypt them yet."
       hint: "Decrypt the file in the program that locked it, … A file locked the way this app's own Protect locks it — a password gate with no crypt filter — is edited normally."
```

naming the cipher the file actually selects — 40 sentences in all, counting the ten
no-password probes beside the 30 operation runs: 12 RC4-128, 12 AES-128, 16
AES-256 — and never promising that encryption as such is unsupported, because it
is not. `isPasswordRequired` is false on the refusal: asking for a password the
tool cannot use would send the user to do work that changes nothing.

**The count the §3 verdict line was made of:**

| | before (`…-pre-guard.log`) | after |
| --- | --- | --- |
| files produced from the ten outside-locked fixtures | 18 | **0** |
| of those, judged `silent-loss` by MuPDF/qpdf/pypdf | 18 of 18 (100 %) | — |
| `qpdf --check` errors on produced files | 18 of 18 | — |
| operation runs that produced nothing at all | 12 (the AES-256 aborts) + 18 blanks | 30 refusals, each with a reason |
| files produced from the two controls | 6 | 6, judged 3 `reads` + 3 `partial-loss` |
| `own-protected.pdf` after rotate | 3/3 planted pages, 0.46 % ink, opens with `user` | identical |

The controls are the half that had to stay working, and it did, byte for byte:
`own-protected.pdf` — this app's `/None` gate over the same document — still
rotates, still answers to the user password, still carries the words and the ink
(`planted_pages 3`, `sheet 1 ink 0.46 %`), and still loses only the bookmarks and
the enclosure the page copy has always lost. A gate is not a cipher, and now
nothing in the intake treats it as one.

**One hole the guard exposed on the way in, and its measurement.**
`core/doc.ts:looksEncrypted` — the cheap trailer scan that decides whether the
pre-flight parses at all — recognised only qpdf's reference spelling
(`/Encrypt 12 0 R`). MuPDF inlines the dictionary (`/Encrypt<</Filter/Standard…>>`),
so every MuPDF-written fixture read as unencrypted in front of the parse and walked
straight through into the rewriting tools. The run before the scan was fixed is the
measurement: it wrote 6 produced files, all of them from `einp-mu-r3-rc4-128-user`
and `einp-mu-r4-aes-128-user`, and answered `BAD_PASSWORD` and `PASSWORD_REQUIRED`
for the two MuPDF AES-256 files — and the rig's own new assertion,
`einp-mu-r3-rc4-128-user.pdf was rewritten`, is what caught it. The scan now matches
`/Encrypt` unless a word character follows — which still excludes the
`/EncryptMetadata` key in the same trailer — and `tests/fixtures/encrypted/` carries
MuPDF-locked files, in both spellings, so the two producers stay covered.

**What is still open, unchanged by this.** The decrypt pass on load in
`core/doc.ts:openPDF` (the recommendation above), the R6 user-password check, and
the two secrets not being distinguished. The guard is the stop-loss, not the fix:
the AES-256 fixtures are now refused for a *true* reason instead of a false one,
and a file with a real cipher is still not editable here — the rig's acceptance
criterion for the decrypt pass (`planted_pages 3→3` on the foreign fixtures) is
therefore **not** met yet, and this row stays open. One more seam this pass did not
widen into, named so the next reader does not have to rediscover it: the guard
lives in `preflightPdf`, which is what `runPdfTool` calls, so the seven panes that
open a document themselves (`PageOrganizer`, `CropTool`, `FormFillMain`,
`FormCreatorMain`, `AnnotationEditor`, `TextEditor`, `CompareTool`) still reach
`core/doc.ts:openPDF` without it — a ciphered file dropped on the Organize, Crop,
Sign, Redact, Form or Text pane can still come back empty. Measured? No: those
paths have no rig of their own, which is stated as an absence rather than a result.

## 9. The decrypt pass, re-measured with this rig

`6e914fc` and `9b7eba1` put the read half in: `core/crypto.ts` derives the key and
undoes the cipher, `core/doc.ts:openPDF` runs it before any tool sees the document,
and `core/guard.ts` refuses on `PdfEncryption.supported` instead of on the presence
of a cipher. Nothing else about the harness moved: same twelve documents, same twelve
probes, same five readers, same `bash docs/research/encrypted-inputs-run.sh`.

**Words, counted on the files rather than read out of a message.** Every one of the
six fixtures locked at the two strengths `core/crypto` claims — RC4-128 (`/V 2 /R 3`)
and AES-128 (`/V 4 /R 4 /CFM /AESV2`), qpdf-written and MuPDF-written, user-password
and owner-only — produced all three operations this time, and the readers judged them:

| | §3, before (`…-pre-guard.log`) | §8, the guard | now |
| --- | --- | --- | --- |
| files produced from the 10 outside-locked fixtures | 18 | 0 (30 refusals) | **18** (16 AES-256 refusals remain) |
| judged `silent-loss` | **18 of 18** | — | **0** |
| judged `reads` / `partial-loss` | 0 / 18 | — | 6 / 12 |
| `planted_pages` (rotate, protect) | `3 → 0` | no file | **3 → 3** |
| `planted_pages` (delete page 2) | `3 → 2` files, `0` with words | no file | **2 → 2** |
| extracted characters | `182 → 0` | no file | **182** (127 on the 2-page file) |
| sheet-1 ink | `0.46 % → 0.0 %` | no file | **0.46 %** |
| form values, MuPDF | `UnicodeDecodeError` | no file | **`Ada Lovelace`, `Yes`** |
| `qpdf --check` errors on produced files | 18 of 18 | — | **0 of 25** |

The AES-256 half is unchanged in behaviour and sharper in wording: 16 sentences name
`AES-256 (crypt filter /StdCF, revision 6)` and say this app reads RC4-128 and
AES-128 and cannot undo a 256-bit one *yet*; none of the four R6 fixtures produced a
file; the blanket `cannot decrypt them yet` that used to cover AES-128 too is gone,
because for AES-128 it is now false.

**What the copy is.** `preserveProtection` re-issues this app's own gate over the
decrypted bytes, so `einp-q-r4-aes-128-user--rotate.pdf` reports
`encrypted=true algorithm=no cipher` to this app and `opens_with: user`,
`is_encrypted: {encrypted: true, password_incorrect: true}`, `planted: true` to MuPDF
and pypdf — a password a reader honours, over bytes that are plaintext, which is the
shape the `protect` row proved. Run with nothing typed (the owner-only fixtures) the
copy opens unlocked and the runner says so: `The source was protected (AES-128); the
result opens without one.`

**Two belief errors this closes, and one it does not.** The owner-only files at the
two readable strengths now answer `needsPassword=false opensEmpty=true` — they were
reported locked because "restricted, not locked" was *inferred from a failed load*.
And a deliberately wrong password on such a file answers `accepted=false`, where
`Boolean(password)` used to answer `accepted=true`; the check is against `/U`, and
`passwordLevel` says which of the two secrets actually opened the file. The R6 user
check is untouched and still says `PASSWORD_REQUIRED` / `BAD_PASSWORD` for the right
secret on all four AES-256 fixtures, including the owner-only ones that every outside
reader opens with nothing typed. That is the AES-256 task, not this one.

**The pre-existing losses, confirmed pre-existing.** `bookmarks 1 / 2` and
`attachments [] / ['source.csv']` in the engine census reproduce *identically on the
unlocked control* `base.pdf` in this same run, so they are `readOutline`'s and
`listAttachments'` treatment of a MuPDF-written name tree, not cipher damage — handed
on with those numbers. The page-copy losses are likewise unchanged and unrelated:
rotate and delete-a-page still take `bookmarks 2 → 0` and the enclosure with them
(`partial-loss`, words intact), which is what the `organize` row already carries.

**One hole the pass found on its way in, and how it is shut.** A dictionary can claim
a cipher its producer never ran — that is pdf-lib's own `save({ encrypt })`, `/CFM
/AESV2` over plaintext. Decrypting *that* would invent garbage out of readable bytes,
the same mistake pointed the other way, so `core/crypto:readObstacle` names it
(`plaintext-claim`) and the guard refuses it; the other obstacle it names is
`object-streams`, where `@maxwbh/pdf-lib` inflates an object stream while it parses,
before any decryptor exists, so a ciphered file's page tree is simply absent. Neither
is a return to the blanket refusal: both are answered by name, and 18 of 18 real
ciphers now read.
