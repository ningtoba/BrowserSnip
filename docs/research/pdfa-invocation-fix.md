# `pdf-to-pdfa` — the invocation fixed, and what "PDF/A" may be claimed

Measured 2026-11-12 on this build (source `76d7b63` + this ticket's commits), in the
BrowserSnip sandbox. Engine: the one the tab downloads, `@bentopdf/gs-wasm@0.1.1`
(GPL Ghostscript 10.06.0), `node_modules/.browsersnip-gs/gs.wasm` — 15 533 046 bytes,
sha256 `c3373cd4a123f05b…`. Fixtures are the campaign's own
(`python3 docs/research/font-outline-fixtures.py /tmp/pdfa-fix`): `type.pdf` 2 416 B,
`type-art.pdf` 9 186 B, `art-only.pdf` 6 933 B, plus an `alpha.pdf` (8 404 B: one RGBA
image → an `/SMask`, one 50 % rectangle → an `/ExtGState` with `/ca 0.5`).

## 0. Which validators exist here — read this before any sentence about conformance

Checked on this box, not assumed:

| tool | here? | version |
| --- | --- | --- |
| veraPDF | **no** | not on `PATH`, no jar under `/usr/share/java`, no python module; `pip install pyverapdf` → *"No matching distribution found"*, and `github.com/verapdf/*` answers 404 through this network, so the distribution cannot be fetched either |
| qpdf / `qpdf --check` | **no** | `which qpdf` empty (libqpdf 12.3.2 *is* present through `pikepdf 10.9.1`, which checks structure, not PDF/A) |
| `mutool` CLI | **no** | MuPDF 1.28.2 only as a library, through PyMuPDF |
| Java | yes | OpenJDK 27.0.1.0.3 — a JVM alone validates nothing |
| Ghostscript (disk) | yes | 10.08.0 — converts, does not validate |
| poppler | yes | `pdfinfo`/`pdftotext` 26.10.0 — readers, not validators |
| PyMuPDF / pypdf / pikepdf / pypdfium2 / pdfminer.six | yes | 1.28.2 / 6.14.2 / 10.9.1 / 5.10.1 / 20260107 |
| lcms2 (through Pillow 12.3.0) | yes | parses the ICC profile and builds a transform with it |

So: **no PDF/A validator runs here, and none can run in a browser tab.** Everything
below is asserted on structure visible in the bytes, read by engines that did not
write them. "The dictionary entries are present" is weaker than "the file conforms",
and the tool's copy now says the weaker thing.

## 1. Both findings reproduced on the build before the change

`flag-only (pre-fix)` below is the vector `core/engine-ops.ts` shipped — `-dPDFA=2`
and nothing else — replayed through the published WASM build; `as-built` is the vector
it ships now. Read by MuPDF and pypdf (`docs/research/pdfa-attribution-readers.py`):

                            engine, pre-fix   engine, now     local fallback
  bytes (type.pdf 2 416 B)     5 543 B          6 078 B         3 165 B
  /Producer                 GPL Ghostscript  GPL Ghostscript  BrowserSnip
  XMP pdfaid:part/conf           2 / B            2 / B           2 / B
  /OutputIntents                 absent           present         present
  intent dictionary                —      /S /GTS_PDFA1,   /S /GTS_PDFA1,
                                          /RegistryName,   /RegistryName,
                                          /Info, /DestOutputProfile → 476 B   /DestOutputProfile → 476 B
                                          stream, /N 3
  /MarkInfo /Marked true           absent         present         present
  font on the page          NBLSWY+Helvetica, descriptor carries /FontFile3 — embedded

Finding 1 is therefore **confirmed and closed**: the engine path used to be the one
that reported success while shipping the *less* conformant catalogue.

Finding 2 was already closed on this build by `4ed4e3e` (the audit reads the
descriptor, `docs/research/pdfa-attribution-recheck.md` §4 claimed); it is **re-proved
here against bytes rather than a claim**: `tests/pdf/pdfa-structure.test.ts` builds a
document whose five faces carry their program in each of the three legal places —
`/FontFile2` on the font dict, `/FontFile2` on the descriptor, `/FontFile3` on the
descriptor under an `NBLSWY+` subset tag, `/FontFile2` on a `/Type0` descendant's
descriptor, and one bare `/Helvetica` with nothing — and pins the figure the card
prints at **"1 of 5 font(s) are not embedded"**. Reverting `auditFonts` to look only
at the font dictionary reddens **3 of 157** tests across `pdfa-structure`,
`optimize-bytes`, `edge-optimize` and `convert-to-bytes` (the live engine run, whose subset must read as
embedded, is the third).

## 2. What the WASM build can actually supply, and what it silently ignores

Measured, not reasoned:

* **Its sandbox ships no resources.** Walking `FS.readdir` over the loaded module
  gives 17 entries — `/tmp`, `/home/web_user`, `/dev/*`, `/proc/self/fd` — and
  **0** `.ps` or `.icc` files. Ghostscript's disk build reads its PDF/A prefix from
  `lib/PDFA_def.ps`; this engine has nothing to read, so the app must write the
  prolog itself. It does: `pdfaProlog()` in `core/engine-ops.ts`, the same pdfmarks
  as `PDFA_def.ps` (`/_objdef … /type /stream /OBJ`, `/N 3`, `{ICCProfile (r) file}`,
  `[{Catalog} <</OutputIntents […]>> /PUT`) plus `/MarkInfo << /Marked true >>`,
  which that sample file does not write.
* **The colour profile costs 0 downloaded bytes.** `srgbIccProfile()` (moved from
  `tools/optimize.ts` to `core/metadata.ts` so both paths share one generator) writes
  a **476-byte** minimal sRGB profile at run time — lcms2 parses it and builds a
  transform with it. No asset is bundled and nothing is fetched for it. It is the
  same 476 bytes the local path has always embedded, and it lands in the engine's
  sandbox as data, not as a job.
* **The prolog must come after `-sOutputFile`.** `prolog-first` in the table below is
  the same vector with the jobs swapped, and Ghostscript answers with the sentence
  this session has already chased once:

      prolog-first: exit 1  out 0 B  (in 2 416 B)
         gs: GPL Ghostscript 10.06.0: Device 'pdfwrite' requires an output file but no file was specified.
             **** Unable to open the initial device, quitting.

  The pdfmark opens the device, so a prefix named before the output path means the
  device opens with nothing to write to. `gsCommandLine` now appends
  switches → `-sOutputFile` → jobs → input, and the order is pinned by a test.
* **A file named on the command line is a job, not data.** The first version of this
  fix handed `Object.keys(files)` to the command line, so the ICC file was *also*
  interpreted as PostScript; the run died with *"Current allocation mode is local /
  Current file position is 11"* and the tool fell back — quietly, with an honest
  "the file below was produced by the local path" over a Ghostscript-shaped input.
  Only the `.ps` is a job now; the profile is opened by the prolog. The test asserts
  the non-switch arguments are exactly `[prolog, input]`.
* **`-sColorConversionStrategy=RGB` is not decoration.** The intent's stream says
  `/N 3`; if the device space were left to Ghostscript's choice for a CMYK input the
  intent and the data could disagree. `-dColorConversionStrategy=RGB` (the shape the
  first attempt used) is a *different* switch — `ColorConversionStrategy` is a string
  parameter, and the argv pin is what caught the typo.
* **What it silently ignores:** `-dPDFACompatibilityPolicy=1` reported nothing on
  every fixture (`log: []`, exit 0) — "no violations reported", not "conforms".
  `-dDetectDuplicateImages`, the `-d*ImageResolution` trio and
  `-dCompressFonts` were left in place from the old vector and are not measured here;
  nothing in this ticket claims to have checked what the build does with them.

## 3. A third reporting bug, found by the read-back this ticket added

While building the "read it back off the file" reporting, the live Ghostscript run
printed:

    The output carries no pdfaid:part in its XMP, so no reader will identify it as PDF/A at all.

over a file that MuPDF, pypdf and this app's own `readXmp` all read as
`pdfaid:part=2, conformance=B`. Cause: the new reader looked for the identification
with a small regular expression, `pdfaid:part="?([0-9]+)`, which matches the form
**this repo writes** — `pdfaid:part="2"` — while Ghostscript quotes its whole packet
with single quotes:

    <rdf:Description rdf:about="" xmlns:pdfaid='http://www.aiim.org/pdfa/ns/id/' pdfaid:part='2' pdfaid:conformance='B'/>

so the pattern saw no digits. Fixed by asking `core/metadata`'s `readXmp` — the module
that already parses XMP, and already handles both quote styles — instead of parsing
the packet a second time inside the tool. Pinned by
`reads an identification quoted the way Ghostscript quotes it`, which is
**1 of 15** red when the reading goes back to a local pattern.

Worth keeping in view: the old `/pdfaid:part\s*=\s*"?\d/` in the fallback branch had
the same blind spot and never showed it, because that branch only ever read files this
app had just written. A reader that is only ever pointed at your own output is
untested in the direction that matters.

## 4. The vectors, replayed (rig output, verbatim)

    $ BROWSERSNIP_PDFA_DUMP=/tmp/pdfa-inv BROWSERSNIP_GS=live npx vitest run tests/pdf/pdfa-structure.test.ts
    $ node docs/research/pdfa-invocation.mjs /tmp/pdfa-inv /tmp/pdfa-fix/type.pdf /tmp/pdfa-inv-type

    input : /tmp/pdfa-fix/type.pdf — 2416 bytes
    as-built: exit 0  out 6078 B  (in 2416 B)
    prolog-first: exit 1  out 0 B  (in 2416 B)      Device 'pdfwrite' requires an output file
    flag-only (pre-fix): exit 0  out 5543 B  (in 2416 B)

Same three runs on the other fixtures — every one exit 0 as-built, every one 0 bytes
prolog-first:

    type-art.pdf  9 186 B → 9 557 B (as-built) / 9 019 B (flag-only)
    art-only.pdf  6 933 B → 5 255 B (as-built) / 4 714 B (flag-only)
    alpha.pdf     8 404 B → 6 306 B (as-built) / 5 767 B (flag-only)

and the catalogue reading of all four as-built files is the same: `/OutputIntents`
array → `/S /GTS_PDFA1` with a 476-byte `/DestOutputProfile` (`/N 3`),
`/MarkInfo` present, `pdfaid:part` matching the chosen part, subset font embedded,
producer `GPL Ghostscript 10.06.0`.

**No content lost** (`docs/research/font-outline-readers.py`, `type-art.pdf` in →
as-built out, per page): text chars `107 → 107`, images painted `1 → 1`
(`images listed 1 → 0` is the XObject moving into a form, as the earlier log records),
vector paths `2 → 2`, ink `14.43 % → 14.43 %` and `14.96 % → 14.96 %`, page boxes and
count unchanged, and MuPDF, pypdf, `pdftotext`, `pdfinfo` and disk Ghostscript all
open the result.

**Transparency.** Part 1 forbids it and the tool now looks: on `alpha.pdf` at PDF/A-1b
the engine left `0` soft masks and `0` alpha states (it removed them, and the file
paid 8 404 B → 239 429 B for it); at 2b it keeps them, which is legal there, and the
local path keeps them at 1b too — where the tool now says so:

    PDF/A-1b does not allow transparency, and this file still carries 1 image soft
    mask(s) and 1 graphic state(s) with alpha: a validator would report it.

## 5. What each path's card says now

The live engine run, on a 2-page text fixture, printed exactly:

    Converted to PDF/A-2b with Ghostscript: 1 of 1 font(s) embedded, an output intent
    in the catalogue (GTS_PDFA1, 476 B RGB profile, /N 3), the tagging flag, 0
    conformance warning(s) reported. 1.5 KB → 5.6 KB (+264%). Read back off the file
    being handed over; no validator ran, so conformance to ISO 19005 is not claimed.

and no warnings. The fallback's headline names the same three entries and ends with
the sentence that it was "this app's own path, not Ghostscript".

## 6. The other verbs on the same seam (not touched, and verified not to have moved)

`font-outline-wasm.mjs` re-run on the rebuilt `docs/research/font-outline-argv.json`,
`type.pdf`, both shapes:

    textToOutlines   [split] exit 1 0 B      [as-built] exit 0 22 177 B
    convertToPdfA    [split] exit 1 0 B      [as-built] exit 0  5 628 B
    rebuildWithGs    [split] exit 1 0 B      [as-built] exit 0  3 113 B

i.e. `font-to-outline` and `repair` build exactly the vectors they built before — the
test asserts both write only `/tmp/input.pdf`, name no `-dPDFA`, and pin no colour
strategy. The rig gained one thing: it now writes any `/tmp/*.ps|icc` a dumped vector
names, which the PDF/A vector needs (see `docs/research/pdfa_prefix.ps`,
`docs/research/pdfa_profile.icc`, the reference copies the test dumps).

State of the neighbours, reported rather than fixed: `repair`'s "could not be reached"
collapse is still open (it escalates to Ghostscript and can now fail *after* the
download, the same wording flaw `font-to-outline` had); the sweep's five dead verbs —
`compressWithCpdf`, `readBookmarksWithCpdf`, `listFontsWithCpdf`, `scrubWithPyMuPDF`,
`deskewWithPyMuPDF` — still have no caller in `src/`; and the 24 typed CoherentPDF /
PyMuPDF call sites still pin no argument values.

## 7. Red without the fix, counted

* invocation reverted (`convertToPdfA` back to the flag-only vector, no prolog, no
  profile, no colour strategy): **5 of 34** fail across `pdfa-structure.test.ts` and
  `engine-attribution.test.ts` — both argv pins, both live engine byte cases, the
  live part-1 transparency case, and the attribution row that now expects an intent.
* `auditFonts` reverted to reading only the font dictionary: **3 of 157** fail across
  `pdfa-structure`, `optimize-bytes`, `edge-optimize` and `convert-to-bytes`.
* the identification read back through a local pattern instead of `readXmp`: **1 of
  15** fail — the single-quoted packet (§3).

## 8. Reproduce

    python3 docs/research/font-outline-fixtures.py /tmp/pdfa-fix
    BROWSERSNIP_PDFA_DUMP=/tmp/pdfa-inv BROWSERSNIP_GS=live \
      npx vitest run tests/pdf/pdfa-structure.test.ts
    node docs/research/pdfa-invocation.mjs /tmp/pdfa-inv /tmp/pdfa-fix/type.pdf /tmp/pdfa-inv-type
    python3 docs/research/pdfa-attribution-readers.py /tmp/pdfa-inv-type/*.pdf
    # the two paths the app itself runs, asserted on bytes:
    BROWSERSNIP_GS=live npx vitest run tests/pdf/pdfa-structure.test.ts tests/pdf/engine-attribution.test.ts
    # what each produced file is, by readers that did not write it:
    python3 docs/research/pdfa-attribution-readers.py /tmp/pdfa-structure-engine.pdf /tmp/pdfa-structure-fallback.pdf
