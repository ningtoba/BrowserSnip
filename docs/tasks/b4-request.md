# B4 requests — security tools

Foundations, not fixes. Nothing here was needed to make `tools/security.ts`
compile or its tests pass — each item is a place where a security promise is
being kept by a workaround inside my own file, and belongs where it is listed.

## 1. `core/signature.ts` — `readSignatures()` throws on an unsigned PDF

```text
Expected instance of PDFArray, but got instance of undefined
```

`PDFDocument.save()` creates an empty `/AcroForm`, so almost every PDF in the
world reaches `doc.context.lookup(fieldsValue, PDFArray)` with
`fieldsValue === undefined` and throws. "This document is not signed" was
therefore a red stack trace instead of an answer (`src/lib/pdf/core/signature.ts:133-142`).

`validate-signature-pdf` now asks `signatureFields(doc)` first and never calls
`readSignatures()` on a document with no signature; it also wraps the call in a
`try` so a future core throw is reported as "could not be read" rather than
killing the run. Please narrow the entry the same way upstream:

```ts
const fields = fieldsValue instanceof PDFArray
  ? fieldsValue
  : fieldsValue instanceof PDFRef
    ? doc.context.lookupMaybe(fieldsValue, PDFArray)
    : undefined;
if (!fields) return results;
```

Two related gaps in the same function, for whoever picks it up:

* It reads only `AcroForm /Fields`. A `/Sig` widget that lives in a page's
  `/Annots` but was never registered in the form is invisible to it, so a real
  signature reports as "unsigned". My pre-check walks `/Annots` as well and
  warns when the two counts disagree — the disagreement is the workaround.
* `verifyOne()` reports integrity only. It never compares `notBefore`/`notAfter`
  with the signing time, so an expired certificate reads as a clean signature.
  The tool states the expiry in a warning; the report row itself cannot say it.

## 2. `core/signature.ts` — `timestampBytes()` mistakes page content for a signature

`text.indexOf('/Contents')` matches the **page** `/Contents` key, and in a file
this app signs the signature dictionary is the *last* one. Measured on a
2-page signed document: `/Contents` occurs at bytes 888, 1248 and 1661, the
signature's being 1661 — so the parser reads a page stream's hex, fails, and
reports:

```text
The existing signature is not a PKCS#7 SignedData blob, so it cannot be timestamped.
```

That fires for **unsigned** documents (which have no signature at all, hence the
"sign it first" advice the tool now gives) *and* for correctly signed ones, so
`timestamp-pdf` cannot currently complete for any normal PDF. `timestamp-pdf`
pre-checks `signatureFields()` so an unsigned file is told the truth, and maps
the parse failure to "the signature could not be read, no timestamp was
attached, the file is unchanged" rather than reusing the network sentence.
Please locate the signature dictionary (`/Type /Sig`, via `AcroForm /Fields` as
`readSignatures` already does) instead of the first `/Contents` substring, and
note `findPlaceholderContents`/`patchSignature` in the same file already do this
correctly — reuse that lookup.

## 3. `core/doc.ts` — the engine writes an `/Encrypt` dictionary but no ciphertext

Verified against the installed fork (`@maxwbh/pdf-lib` 1.18.1):
`PDFSecurity.encryptData/encryptStream/encryptString` and the `decrypt*` pair
exist but have **no callers** — `PDFDocument.save({ encrypt })` only calls
`setupEncryption()`, which registers the dictionary (`/V`, `/R`, `/Length`,
`/P`, `/O`, `/U`, `/CF`), and the writer emits the streams and strings exactly as
they were parsed. Round-tripping through `load({ password })` succeeds because
the same code re-derives a key and then does nothing with it.

Consequences for the security category, all of them honest-reporting problems
rather than crashes:

* `protect` produces a file that prompts for a password and enforces `/P` in a
  well-behaved reader, but its page content is still readable by anything that
  ignores the trailer. The tool now detects this itself (it re-reads the saved
  bytes and compares a fingerprint of up to three sampled pages) and says so in
  `warnings`. When real stream encryption lands, that warning stops firing with
  no change to the tool.
* `unlock` can only ever remove protection this engine wrote. A third-party AES
  file whose streams really are encrypted would need decrypt-on-load; today a
  lenient load hands back ciphertext that `rebuildDocument` copies verbatim, and
  the tool's message would then be wrong about the copy being readable. The
  verification I added (a bare `PDFDocument.load` of the output plus a content
  fingerprint comparison) is what catches that case; please make
  `load({ password })` decrypt so the check can become a guarantee.

Cheapest useful slice: apply `encryptStream`/`decryptStream` in the writer and
parser for `/StdCF` + `/Identity`-free ciphers, RC4-40/128 and AES-128 first
(AES-256 in this fork is `V:5, R:6` with MD5/RC4 key derivation and an `AESV2`
crypt filter, so it is not yet PDF 2.0 anyway — see the `CF` block it writes).

## 4. `core/guard.ts` — a permissions-only PDF is reported as needing a password

An empty `/U` check means the file opens on the empty password; `PDFSecurity`
proves it by trying `verifyPassword('')` before anything else. But
`load()` refuses any `isEncrypted` document without a password, so
`inspectPdf(permOnlyBytes, name)` returns `PASSWORD_REQUIRED` +
`"perm.pdf" is password protected`, and `openPdfInput` throws.

That is correct for E4 in general and wrong for the three tools whose entire job
is restrictions without an open password (`unlock`, `change-permissions`,
`remove-restrictions`): a user who just wants to lift "no copying" is told to
type a password the file never asked for. Workaround in my file: those tools run
`PDFDocument.load(bytes, { password: '' })` as the reader's point of view when
verifying "opens without a password", and the tests assert on it.

Requested shape (A1's file, small): in `load()`, when `password` is undefined,
try an empty-password load first and only report `PASSWORD_REQUIRED` if that
fails; keep `BAD_PASSWORD` for a supplied password that does not open it. Also
worth exposing on `PdfInspection`: `opensWithEmptyPassword: boolean`, so the
queue can say "restricted, not locked".

## 5. `tools/helpers.ts` — result builders cannot carry `warnings`

`pdfResult()` and `reportResult()` take `{ message }` / `{ message, files }` but
no `warnings`, so a tool that wants to admit something has to build the
`ToolResult` literal by hand (`security.ts` now does this in four places). One
optional field, `warnings?: string[]`, merged into the returned object, keeps
`ResultCard`/`ToolResult.warnings` the single channel A1 intended.

## 6. `core/redact.ts` — `applyRedactions()` does not say *what* it deleted

`RedactionResult` is `{ removed, rasterised }`. The `redact-pdf` field
"Also clear matching text from metadata and bookmarks" cannot be honoured
exactly: without the removed strings there is nothing to match `/Info`, the XMP
packet or outline titles against. Rather than fake a scrub, the tool now names
the stores that still hold words and points at Remove Metadata. If
`applyRedactions` returned `removedText: string[]` (it already decodes every
glyph it drops), the field could do its stated job.

## 7. `core/content.ts` — `textRects()` loses most characters

`walkText()` emits one segment per glyph with
`text: chars.length === 1 ? chars[0] : ''`, and
`font.unicodeOf(code)` returns `undefined` for the glyph ids of the fonts this
fork embeds for the standard 14. `textRects()` then filters
`segments.filter((s) => s.text.length > 0)`, so a page whose content reads
"Literal Bravo Content" extracts as `"L"`.

The security tests therefore assert against decoded stream bytes
(`pageContentStreams` + every stream object in the file) rather than
`textRects`. Anything that answers "does this page have a text layer?" (E10) or
"what text is under this rectangle?" (E13 for redaction, the editor's quick
pick) is under-reporting by roughly the length of every string on the page.

## 8. `tools/optimize.ts` — `sanitize-pdf` (B2's file): already per-category

Checked while writing this: `sanitize-pdf` now reports each category it was
asked about — `"${found} script reference(s) removed"` vs
`"no script references were present"`, `"there was no XMP packet to remove"`, a
`${left} script reference(s) survived in a place this tool does not look`
warning, and a `Nothing to remove: …` message when nothing was — so the E13 half
is done in B2's file and needs nothing from me. Its `notes` also state the
boundary ("this hides and removes optional parts, it does not redact").

What it cannot reach without core support, and the same limit applies to
`remove-metadata` in my file: `stripJavaScript` (`core/content.ts`) already walks
the catalog, every indirect dictionary and stream, the `/Names` tree and the
page annotations, so the honest ceiling is the two stores it does not look at —
**XFA**, which carries its own `<if:document>` script (removable with
`doc.getForm().deleteXFA()`, as `core/forms.ts` already does when flattening),
and **`/EmbeddedAudit`** (PAdES audit trail). Naming those two in the tool, and
sharing `objectAudit` for the enumeration, beats the generic "a place this tool
does not look" sentence. Flagged rather than filed against a specific owner
because both keys live in B2's file's reach, not mine.
