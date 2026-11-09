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
bytes are) and `encrypted-inputs-table.md` (both tables).

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
engine pages=3 annots=6/entries 6 fields=0 [] bookmarks=0 attachments=[] · page 1: 7b 73 7d f5 — ciphertext
runner: pagesOut=3   message: "Rotated 3 pages by 90°."
```

and the bytes say:

```
MuPDF  opens_with=[user] cipher='Standard V4 R4 128-bit None' /P=-4 pages=3
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
`qpdf --check`, 12/18 still opening with the password the user holds** (the other 6
are the `protect` runs, which answer to the new one instead). Every one of them
`verdict: silent-loss`. `delete page 2` is the same shape with `pages=2` — the
count it reports is correct, which is exactly what makes it slip past a
page-count check. `MuPDF opens_with=[empty,user,owner,again,again-owner]` on the
owner-only runs: the restrictions went away with the dictionary.

**Three of the eighteen are louder, and only on the screen.** All three operations on
`einp-mu-r3-rc4-128-user.pdf` — the RC4-128 file MuPDF wrote — produce a file that
makes **this app's own preview throw**: `UnknownErrorException: Invalid number:  (charCode 19)`.
In the `protect` run the tool noticed something and blamed the wrong party:

> `No PDF reader could be started in this browser to re-check the saved file
> (Invalid number:  (charCode 19)), so only the built-in engine's own view of it was verified.`

A reader *was* started — it read the file and threw. The sentence reports a missing
reader where the bytes are the fault, which is the same misreading as the other
fifteen cases except that in those fifteen the app says nothing at all.

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
