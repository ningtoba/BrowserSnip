# C1 requests — follow-ups to the signature/guard core fixes

Landed in my files (`src/lib/pdf/core/signature.ts`, `src/lib/pdf/core/guard.ts`),
proved by `tests/pdf/edge-signature-core.test.ts` (18 tests; 13 of them fail
against the previous core):

1. **`readSignatures()` answers "no signatures" instead of throwing.** `/AcroForm`
   and `/Fields` are now read and narrowed (`signatureFields()`), so a document
   with no form — or a form with no field list — returns `[]`. Nothing else about
   the result changed: a field with no value still reports
   `error: 'The signature value object is missing.'`, and now carries its
   `fieldName` too.
2. **`timestampBytes()` finds the real signature.** It resolves `AcroForm /Fields`
   → the `/Sig` value that carries `/SubFilter`, honours `options.fieldName`, and
   locates the placeholder by comparing each `/Contents` hex against the parsed
   value, refusing when `/ByteRange` says the gap is elsewhere. It then patches
   inside that span, so the file keeps its length and the signature still
   verifies afterwards (`readSignatures(bytes)[0].digestMatches === true`).
   An unsigned file is told `This PDF has no signature to timestamp — sign it
   first.`; a signature it cannot splice says `could not be read from these
   bytes`. Both still match the patterns `timestampFailure()` already maps.
3. **`needsPassword` reflects the user password only.** A permissions-only PDF
   (owner password set, empty user password) now inspects as
   `{ encrypted: true, needsPassword: false, error: null,
   opensWithEmptyPassword: true, algorithm: 'AES-128', permissions: … }`, and its
   message ends `Restricted, not locked — it opens without a password.`
   `openPdfInput` hands back a usable document. A file with a real user password
   still refuses with `PASSWORD_REQUIRED`, a wrong one with `BAD_PASSWORD`, and
   `inspectPdf(bytes, name, { cheap: true })` is unchanged (it cannot read the
   hash, so it still reports `encrypted` + `PASSWORD_REQUIRED`); `preflightPdf`
   now re-asks with the parser before refusing, which is what stops the run gate
   blocking a restricted file.

## For B4 — `src/lib/pdf/tools/security.ts` (delete these workarounds)

* `validate-signature-pdf`: the `signatureFields(doc).length === 0` pre-check
  exists because `readSignatures` threw. It can go — an empty array is now the
  "nobody has signed this" answer. Keep the `/Annots` half of that helper for as
  long as the annotation-only widget gap below is open, since that is what makes
  the "N field(s) sit in page annotations" warning true.
* `timestamp-pdf`: the pre-check is still worth keeping for the *count* (it lets
  the tool name the advice), but `timestampFailure()`'s "could not be read"
  branch should now only fire for a genuinely unreadable signature, not for every
  normal file. The stub-free proof is in my test
  `timestamps a real signature in place and leaves the signature intact`.
* `unlock` / `change-permissions` / `remove-restrictions`: the
  `PDFDocument.load(bytes, { password: '' })` "reader's point of view" probe (and
  the tests that assert on it) is now answered by the guard itself — read
  `inspection.opensWithEmptyPassword` / `inspection.needsPassword` instead.

## For A2 — `shared/FileQueue.tsx`, `shared/PdfToolPanel.tsx`, `usePdfTool.ts`

* `PdfInspection.opensWithEmptyPassword` is the missing state for a queue row:
  `encrypted && opensWithEmptyPassword` → "restricted, not locked" (a lock icon
  with a strike, not a password gate); `encrypted && needsPassword` → gate.
  `tools/runner.ts`'s `inspectFiles` already returns it, so no new plumbing.
* `PdfToolPanel`'s `LockedNotice` text ("This PDF is password protected. Enter
  its password above and run again.") should key off
  `error === 'PASSWORD_REQUIRED' | 'BAD_PASSWORD'`, which the guard now only sets
  for a real user password.

## Still open in core (not mine this round, not silently fixed)

* A `/Sig` widget that lives only in a page's `/Annots` and was never registered
  in `AcroForm /Fields` is invisible to `readSignatures` (b4 #1, second bullet).
  `signatureFields()` is the single place that would have to walk both and
  dedupe by the value reference.
* `verifyOne()` never compares the signing time with `notBefore`/`notAfter`, so an
  expired certificate reads as clean (b4 #1, third bullet). The data is already on
  `SignatureInfo`; the row cannot say it.
* The engine still writes an `/Encrypt` dictionary without ciphertext (b4 #3), so
  `unlock` of a third-party AES file remains a copy, not a decryption.
