# `tests/fixtures/encrypted/` — files locked by somebody else's encryptor

The test suite's encrypted inputs. **Every locked file here was written by
somebody else's encryptor**, over `plain.pdf`:

- `rc4-128-*`, `aes-128-user`, `aes-256-user` — libqpdf 12.3.2, through `pikepdf`
  (the `qpdf` binary is not installed on this box, so qpdf's CLI option set runs
  through the library that embeds it);
- `mu-*` — MuPDF 1.28.2;
- `plain.pdf` — MuPDF 1.28.2, unlocked: the base every lock starts from.

They exist because this repo cannot make its own:

> `@maxwbh/pdf-lib`'s `save({ encrypt })` registers an `/Encrypt` dictionary and a
> `/ID`, and never calls `PDFSecurity.encryptStream` — every stream leaves as
> plaintext. A file this app locked is therefore evidence about a *gate* and no
> evidence whatever about a *cipher*, and an assertion built on one is pdf-lib
> reading its own output. See the `protect` and `encrypted-inputs` rows of
> `docs/TOOL-CAMPAIGN.md`, and `docs/research/encrypted-inputs-findings.md`.

Rebuild with `python3 scripts/encrypted-fixtures.py` (it re-verifies each file
with qpdf and MuPDF before it is kept, and prints the dictionary, the trailer
spelling and the command that wrote it). The same document, richer and measured
against five readers, is built for the audit rig by
`docs/research/encrypted-inputs-fixtures.py`.

## The files

One base document: 3 pages, each carrying `Lighthouse Inventory 1887 page N`, a
sheet word (`ALPHA` / `BRAVO` / `CHARLIE`) and a filled black rectangle on page 1,
plus an outline of two entries. So a fixture's words are countable, and a copy
that keeps its page count while losing its text is visible.

| file | `/Encrypt` | trailer | cipher | password |
| --- | --- | --- | --- | --- |
| `plain.pdf` | — | none | unlocked base, MuPDF | none needed |
| `rc4-128-user.pdf` | `/V 2 /R 3 /Length 128` | reference | RC4-128, no crypt filters (they arrive with `/V 4`) | user `hunter2` |
| `rc4-128-owner.pdf` | `/V 2 /R 3 /Length 128` | reference | RC4-128 with an **empty user password**: anyone can open it, the streams are still ciphertext | owner `hunter2` |
| `aes-128-user.pdf` | `/V 4 /R 4 /CF << /StdCF /CFM /AESV2 /Length 16 >> /StmF /StdCF /StrF /StdCF` | reference | AES-128 | user `hunter2` |
| `aes-256-user.pdf` | `/V 5 /R 6 /CF << /StdCF /CFM /AESV3 /Length 32 >> /StmF /StdCF /StrF /StdCF` | reference | AES-256 | user `hunter2` |
| `aes-256-owner.pdf` | same `/V 5 /R 6` dictionary | reference | AES-256 with an **empty user password**: five outside readers open it with nothing typed | owner `hunter2` |
| `mu-rc4-128-user.pdf` | `/V 2 /R 3 /Length 128` | **inlined** (`/Encrypt<<…>>`) | RC4-128 by the second producer | user `hunter2` |
| `mu-aes-128-user.pdf` | `/V 4 /R 4 /CF << /StdCF /CFM /AESV2 >> /StmF /StdCF /StrF /StdCF` | **inlined** | AES-128 by the second producer | user `hunter2` |
| `mu-aes-256-user.pdf` | `/V 5 /R 6 /CF << /StdCF /CFM /AESV3 >> /StmF /StdCF /StrF /StdCF` | **inlined** | AES-256 by the second producer | user `hunter2` |
| `mu-aes-256-owner.pdf` | same `/V 5 /R 6` dictionary | **inlined** | AES-256, empty user password, second producer | owner `hunter2` |

The two AES-256 rows carry the revision-6 spellings the read path has to handle:
`/O` and `/U` are **48** bytes (32-byte hash, 8-byte validation salt, 8-byte key
salt) rather than 32, `/OE` and `/UE` hold the file key wrapped by the owner and
user secrets, and `/Perms` is a 16-byte check value. Both producers write all of
them, and `scripts/encrypted-fixtures.py` prints each file's own dictionary when
it rebuilds the corpus.

The two trailer spellings are not decoration: `core/doc.ts:looksEncrypted` is the
cheap pre-parse scan, and a version of it that recognised only `/Encrypt <ref>`
reported every MuPDF-locked file as unencrypted — the audit rig's `einp-mu-*` rows
are the measurement of what that cost. `tests/pdf/encrypted-guard.test.ts` pins
both spellings.

`/P` is `-3376` on every locked file (copy and accessibility allowed; print,
modify, annotate, form-fill and assemble refused), which is the permission set the
`protect` row and the `encrypted-inputs` rig use.

No file here is written by this app.

Two of its shapes still matter and neither can be made here any more:

- **a password gate with no cipher** (`/V 4 /R 4`, empty `/CF`, no `/StmF`) is what
  `core/doc.ts:saveEncrypted` wrote while the vendor ran no cipher, and is what
  files out in the wild carry. Since `89a5b7e` that writer produces AES-128
  ciphertext instead, so tests build the gate with `tests/pdf/gate-harness.ts` —
  a fixture that came from the writer would silently change meaning every time the
  writer did, which is how `save({ encrypt })` once made an assertion prove
  nothing.
- **this app's own AES-128 file** is produced in the tests by `saveEncrypted`, and
  it is evidence about the write path only in combination with a reader that is not
  this app's — see `tests/pdf/crypto-encrypt.test.ts` (pdf.js, and the outside
  reader table in `docs/research/protect-readers-aes128.log`).
