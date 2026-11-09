# `tests/fixtures/encrypted/` — files locked by somebody else's encryptor

The test suite's encrypted inputs. **Every locked file here was written by
libqpdf 12.3.2** (through `pikepdf`, which embeds it; the `qpdf` binary is not
installed on this box), over `plain.pdf`, which MuPDF 1.28.2 wrote.

They exist because this repo cannot make its own:

> `@maxwbh/pdf-lib`'s `save({ encrypt })` registers an `/Encrypt` dictionary and a
> `/ID`, and never calls `PDFSecurity.encryptStream` — every stream leaves as
> plaintext. A file this app locked is therefore evidence about a *gate* and no
> evidence whatever about a *cipher*, and an assertion built on one is pdf-lib
> reading its own output. See the `protect` and `encrypted-inputs` rows of
> `docs/TOOL-CAMPAIGN.md`, and `docs/research/encrypted-inputs-findings.md`.

Rebuild with `python3 scripts/encrypted-fixtures.py` (it re-verifies each file
with qpdf and MuPDF before it is kept). The same document, richer and measured
against five readers, is built for the audit rig by
`docs/research/encrypted-inputs-fixtures.py`.

## The files

One base document: 3 pages, each carrying `Lighthouse Inventory 1887 page N`, a
sheet word (`ALPHA` / `BRAVO` / `CHARLIE`) and a filled black rectangle on page 1,
plus an outline of two entries. So a fixture's words are countable, and a copy
that keeps its page count while losing its text is visible.

| file | `/Encrypt` | what it is | password |
| --- | --- | --- | --- |
| `plain.pdf` | — | the unlocked base, written by MuPDF | none needed |
| `rc4-128-user.pdf` | `/V 2 /R 3 /Length 128` | RC4-128, no crypt filters (they arrive with `/V 4`) | user `hunter2` |
| `rc4-128-owner.pdf` | `/V 2 /R 3 /Length 128` | RC4-128 with an **empty user password**: anyone can open it, the streams are still ciphertext | owner `hunter2` |
| `aes-128-user.pdf` | `/V 4 /R 4 /CF << /StdCF /CFM /AESV2 /Length 16 >> /StmF /StdCF /StrF /StdCF` | AES-128 | user `hunter2` |
| `aes-256-user.pdf` | `/V 5 /R 6 /CF << /StdCF /CFM /AESV3 /Length 32 >> /StmF /StdCF /StrF /StdCF` | AES-256 | user `hunter2` |

`/P` is `-3376` on all four locked files (copy and accessibility allowed; print,
modify, annotate, form-fill and assemble refused), which is the permission set the
`protect` row and the `encrypted-inputs` rig use.

No file here is written by this app. Its own password gate — `/V 4 /R 4` with an
empty `/CF` and no `/StmF`, i.e. the crypt filter `/None`, "the data are not
encrypted" — is produced in the tests by `core/doc.ts:saveEncrypted`, because that
is the case that must keep working while the four above are refused.
