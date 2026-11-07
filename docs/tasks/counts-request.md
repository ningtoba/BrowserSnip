# counts → owners: what still cannot say how many pages it produced

Context: the result screen prints `N → M` for a run, or `N in · out not counted`
when nothing counted the output. `docs/tasks/shell3-request.md` §2 recorded why a
count cannot be read back off the bytes cheaply (a cheap inspection returns no
page count at all, and this app's own saves keep the page tree inside a compressed
object stream), and left two ways to close the gap. This pass took the first one. Of the **33
hand-written PDF returns** in
`src/lib/pdf/tools/{security,optimize,edit,convert-to,convert-from,legacy}.ts` —
the ones that never went through `helpers.pdfResult`, which has counted since it
was written — **29 now set `pages`** from the document the producer is holding at
the moment it saves (`doc.getPageCount()`, one line per site, no behaviour
change). Tests: `tests/pdf/pages-out.test.ts`.

The guard half of that ask is done too: `core/guard.ts` now says in three places
(module header, `PdfInspection.pages`, `InspectOptions.cheap`, plus a comment on
the cheap branch of `probePdf`) that a cheap inspection reports **no** page count
and that `pages: 0` means "not read", never "an empty document".

## 1. Producers that hold no document - 3 closed, 1 left (linearize)

Each of these returns bytes written by someone else, and the only number in reach
is one this project already decided not to guess. Three of the four turned out to
have a real number in reach after all and now print it; only the CoherentPDF path
still prints `N in · out not counted`, which is true:

| Tool | Site | Who wrote the bytes | Ask |
|---|---|---|---|
| `pdf-compress` | `tools/optimize.ts:884` | **CLOSED.** `compressPDF` returns `pages` beside `{ bytes, report }`, read from `runCompression` while the document is still open — so the branch that discards a rebuild for being larger counts too, and the `compressToTarget` ladder passes it through. `optimize.ts` forwards it. |
| `repair` | `tools/optimize.ts:1172` | **CLOSED.** This tool already ran a full `inspectPdf` over the bytes it wrote and printed "N page(s) readable" in its own message while the result screen said "out not counted" — one screen contradicting the other. It passes `pages: after.pages` now, and the parse was already paid for. |
| `linearize-pdf` | `tools/optimize.ts:1305` | CoherentPDF (`core/engine-ops.linearizeWithCpdf`) | The engine hands back a finished file. Either return its page count from `core/engine-ops`, or accept that a cpdf-produced file is uncounted. |
| `pdf-to-greyscale` (re-render mode) | `tools/convert-from.ts:1124` | **CLOSED.** The caller resolves the page selection itself and hands it in as a spec, so it reports `pages: wanted.length` instead of changing `applyColorFilter`'s return shape. `pages-out.test.ts` re-parses the produced file, so the two resolutions cannot drift silently. |

Not a gap: `pdf-to-pdfa` (`optimize.ts:1399`) and `font-to-outline`
(`optimize.ts:1502`) run on Ghostscript, but each already re-opens the engine's
output as a `PDFDocument` for its own font audit, so the count is read off that
document — exact, already parsed, no guessing. Flagging it here because it is a
judgement call: if the rule you want is "engine output is never counted", delete
those two lines rather than extend them.

## 2. Two counts that come from a producer's own number, not a document

`tools/legacy.ts:266` (`scan-to-pdf`) uses `packed.pages` and
`tools/legacy.ts:319` (`compare`) uses `outcome.compared`, both from
`pdf-engine/commands.ts`. Each was checked against that module: `scanImagesToPdf`
returns `doc.getPageCount()` of the document it just saved, and `comparePDFs` adds
exactly one output page per compared page. They are real counts, not message text
re-used as a number — but they are one hop further from the document than the
other 27, so they are listed for the reviewer.

## 3. Not asked for, not done

The inflate-and-regex fallback (`/Count` inside the trailer region's
`/Type /ObjStm`) is still unbuilt for the reason in shell3 §2: it is real work
against our own container format to recover a number that is free at save time.
Nothing in this pass depends on it, and the four sites above should be fixed at
the producer instead.
