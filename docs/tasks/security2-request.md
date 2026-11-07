# SECURITY-2 requests — changes needed in files this worker does not own

Owned and audited here: `src/lib/pdf/tools/security.ts`, `src/lib/pdf/core/metadata.ts`,
`tests/pdf/edge-security.test.ts`, `tests/pdf/security-bytes.test.ts` (34 + 43 tests,
green; `npx tsc -b` clean, `npm run typecheck:tests` clean for these four paths;
`parity-definitions` and `registry` green).

Nothing below blocks me: each item names the fact, the file and line, and the
assertion that already pins it so a fix has something to aim at.

## 1. `src/lib/pdf/core/flatten.ts:140` — "Flatten comments" bakes nothing (owner: SECURITY category)

`drawAppearance` asks for the annotation's normal appearance as a **dictionary**:

```ts
const appearance = doc.context.lookup(appearanceRef, PDFDict);   // :140
if (!appearance) return false;
```

An appearance is a **stream** (`/Subtype /Form`, with `/BBox` and `/Matrix` in its own
`dict`), so `PDFContext.lookup` throws instead of returning `undefined` — the `!appearance`
guard on the next line is dead code. The thrown text, verbatim, from a document this app
made itself (`addAnnotation({kind: 'Text', …})`):

```
Error: Expected instance of PDFDict, but got instance of PDFRawStream
    at PDFContext.lookup (node_modules/@maxwbh/pdf-lib/src/core/PDFContext.ts:166:11)
    at drawAppearance              (src/lib/pdf/core/flatten.ts:140:34)
    at flattenAnnotations          (src/lib/pdf/core/flatten.ts:82:21)
```

`flattenAnnotations` has no per-annotation catch, so one appearance aborts the whole page
loop: `flatten-pdf` with *Flatten comments* on reports `0 annotation(s) drawn into the
content of 0 page(s)` on any document whose annotations carry appearances — which is every
document ever commented in any reader. `security.ts` catches the throw and says what is
still live (that part is honest, and `tests/pdf/security-bytes.test.ts` → *"names a comment
it could not draw instead of counting it as baked"* proves it), but the capability is broken.

Fix shape: look the reference up as a `PDFStream`, read `/BBox` and `/Matrix` off
`stream.dict`, and keep the "no appearance" answer as `false` rather than a throw. The
same `lookup(…, PDFDict)`-throws pattern is one line earlier at `:135` for `/AP` itself
(a producer may put the stream straight in `/AP`), so both want the narrowing form
(`value instanceof PDFDict ? value : undefined`).

When it is fixed, the assertion that must start passing is in the test named above:
`claimed + live === marksBefore` with `claimed === 1`, `live === 0`, and no
"could not be drawn" warning.

## 2. `src/lib/pdf/core/doc.ts` + `@maxwbh/pdf-lib` — protection is a dictionary, not ciphertext (owner: doc.ts / C3)

`saveEncrypted()` is documented as "Real encryption". It writes the `/Encrypt` dictionary
and nothing else: the fork defines `PDFSecurity.encryptStream` and **never calls it**
(`grep -rln encryptStream node_modules/@maxwbh/pdf-lib/src/` → only
`src/core/crypto/PDFSecurity.ts`). Three measured facts about the file `protect` produces
from a 3-page document whose page text is `Secret Alice 42 Bravo on page 1`:

1. The page streams leave the tab in the clear. Inflating them with `node:zlib` (no pdf-lib
   decoding, `tests/pdf/security-bytes.test.ts` → *records /Encrypt…*) still finds the run's
   hex spelling, and `security.ts` admits it in a warning.
2. The AES-256 option writes a self-contradictory dictionary — `/V 5 /R 6 /Length 256`
   beside `/CF << /StdCF << /CFM /AESV2 /Length 16 >> >> /StmF /StdCF /StrF /StdCF`.
   `/AESV2` *is* AES-128. `core/guard.ts:196 algorithmOf()` answers from `/V` alone, so the
   app reports "AES-256" and the crypt filter says otherwise; `security.ts` now names the
   disagreement in a warning ("the file's crypt filter declares /AESV2").
3. No file this app protects can be opened by pdf.js — the reader this app renders with.
   pdf.js applies the declared crypt filter to plaintext streams and gets garbage:
   `Invalid stream: "FormatError: Unknown compression method in flate stream"`,
   `XRef.parse - Invalid "Root" reference`, then `PasswordException` — *with the correct
   password*, phrased as "That password is not correct for this PDF." For `/V 5` it dies
   later with `Invalid argument for stringToBytes`. A protected download therefore loses
   its preview, its text layer and its compare/redact pass inside this very app.

So "the bytes are encrypted" was never true of the page content, and the two claims that
depend on it now live in the warnings instead of the copy. What I changed on my side: the
`protect` panel says the streams are copied through and names the in-app alternative
(PDF to Images → Images to PDF); `verifyProtection` re-reads the cipher dictionary and
reports the mismatch; `probeReader` asks pdf.js and reports what it answered rather than
assuming the gate is portable.

What someone has to decide (out of my ownership):

* Either make `saveEncrypted` really encrypt — call `PDFSecurity.encryptStream` (and the
  string encryptor) from the write path, and write `/CFM /AESV3 /Length 32` for the AES-256
  option — or
* route the AES-256 option at the dependency already in `package.json`,
  `@pdfsmaller/pdf-encrypt-lite`, whose README states real RC4-128 with `/V 2 /R 3` that
  readers accept — in which case the AES-256 row of `CIPHER_OPTIONS` has to say so, because
  today it is one of four labels over three behaviours.

Tests that will flip when the bytes change, so the fix is visible rather than silent:
`security-bytes.test.ts` → *records /Encrypt, the hashes and the /P bits* (pins `/CFM /AESV2`
and the conditional "no independent reader could confirm the gate") and
`edge-security.test.ts` → *admits when the engine recorded protection without rewriting the
page content*, *records exactly the flags it was given, on a file that opens freely*.

## 3. `src/lib/pdf/core/render.ts` — `ExtractedTextItem.x/y/w/h` are not in displayed space on a turned page

The field is documented as "Bounding box in PDF user space, origin top-left of the
**rotated** page" (`render.ts:126`). Measured on a 595 × 842 page with `/Rotate 90` whose
run was drawn at user space `(60, 700)`, pdf.js returns:

```
{ str: "Secret Alice 42 Bravo on page 3", x: 60, y: -123, w: 258, h: 18 }
```

That is unrotated space (x along the sheet's 595 width) and not even a top-left flip of it —
`y` is negative, where the top-left origin answer would be ≈ 124. Anything that compares
those boxes to a mark the user drew on the rendered page is therefore wrong on rotated pages.
The one consumer in my category is `redact-pdf`'s word re-check (`readMarkedWords` in
`security.ts`), which now says *"no whole word under the marks could be located in the page
text layer, so the deletion was confirmed from the page content alone"* instead of pretending
— see `security-bytes.test.ts` → *reads a mark on a turned page in the space the editor drew
it in*, which proves the deletion itself is correct (the fill rect lands at user space
`50 685 240 60` for a mark at displayed `685 50 60 240`) and that only the text-layer audit
is blind there.

If the boxes are normalised to displayed space (the same quarter-turn maths
`viewerRectToUserSpace` in `core/tables.ts` already does, and which `cropBox` +
`normaliseRotation` make available), that branch becomes reachable and redaction gets its
byte-level proof on rotated pages too. Worth checking the other readers of those four fields
before deciding — I did not touch them.

## 4. Recorded so nobody re-derives it: redaction really does remove the text

`core/redact.ts` is not mine and needs nothing. Verified here on bytes inflated with
`node:zlib`: a mark over a line deletes the run — the phrase's hex spelling is gone from
every stream in the file, including a run reachable only through a *nested* Form XObject
(`edge-security.test.ts`), and the fill rectangle is still painted. Partial coverage is
reported, not hidden: a box one character short leaves `“1”` selectable and the result says
"covered, not gone". `alsoMetadata` additionally deletes the words from the `/Info` strings,
the XMP packet and the bookmark titles through `scrubMetadataText` (`core/metadata.ts`,
mine), whole words only, and the leftover comma in `/Keywords` is tidied.
