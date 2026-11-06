# B2 requests (optimize / legacy category)

Things I need from files I do not own. Nothing here blocks my own tests; each
item says what breaks if it stays as it is.

## 1. `src/lib/pdf/core/doc.ts` — a way to raise the PDF version header

`optimize-pdf`, `linearize-pdf` and `rasterize-pdf` write PDF 1.5 structures
(object streams) into documents whose header still says `%PDF-1.4`, because
pdf-lib keeps the parsed header and `PDFContext.header` is not typed
(`core/doc.pdfVersion` reads it through a cast). A strict 1.4 reader may ignore
`/ObjStm` and lose the xref.

Request: `setPdfVersion(doc, '1.5' | '1.7')` in `core/doc`, next to the existing
`pdfVersion(doc)`, so those tools can bump the header they are invalidating
instead of only warning about it. Today `optimize.ts` emits a `versionWarning()`
sentence naming the mismatch; when this lands, the sentence becomes the fix and
the warning can go.

Owner: A1/core. Not urgent — the file opens in every viewer tested here.

## 2. `src/lib/pdf/core/compress.ts` — report the size the rebuild *would* have had

`compressPDF` returns the **input bytes** whenever its own rebuild was larger,
and rewrites `report.after = source.byteLength`, so the tool cannot tell the
user by how much the attempt lost (E14 wants "report the delta"). Request:
keep the honest numbers on the report, e.g. `report.rebuildBytes: number`
alongside `after`, and `B2` will print `would have been X from Y`.

Owner: A1/core (or whoever owns `core/compress`). My message is correct-but-
vague until then: it says the original is returned, not what the attempt cost.

Related decision already taken in `tools/optimize.ts` (E14 says "report the
delta; offer to keep the original"): the tools hand back the original bytes
when their rebuild is larger, and say so in the message plus `result.warnings`,
so the user always keeps the original without having to ask. If the product
wants a literal choice — "download both" — that is a `ResultCard` affordance
(multiple outputs for one run), not something a tool definition can express.
Flagging it so it is a decision rather than a silent omission.

## 3. `src/components/dashboard/ToolCard.tsx` — stale blurbs

The hand-written `BLURB` map repeats tool copy that the registry now owns.
`scan-to-pdf`'s card claims edge detection and perspective correction; the pane
(A4's `ScanMain`) only greyscales and stretches contrast, so the card promises a
capability that does not exist — the exact defect class in
`docs/REFINEMENT-BRIEF.md`. I fixed the description in `tools/legacy.ts`; the
card override needs the same sentence, or the entry deleted so the card falls
back to the registry description.

Owner: A3 (shell/dashboard).

## 4. `src/hooks/usePDFEngine.ts` — the legacy dispatch bypasses every guard

`executeToolCommand` (used by the bespoke panes for `sign`, `compare`,
`scan-to-pdf`) calls `pdf-engine/commands` directly: no `openInputs`, no
`clampFields`, no `ToolInputError`, so E1/E2/E15 do not apply there. The four
legacy definitions carry honest notes instead, and every tool in
`tools/optimize.ts` re-clamps its own numbers so it is safe when called that
way. Request (optional, larger): route the hook through `runPdfTool` for tools
that have a `run`, so there is one gate.

Owner: whoever owns `src/hooks/usePDFEngine.ts`.

## 5. Not a request — note for the reviewer

`sanitize-pdf` used to declare `engines: ['cpdf']` while never calling
CoherentPDF, which made the rail show a download badge for a tool that needs no
download. The declaration is gone and `tests/pdf/edge-optimize.test.ts` asserts
it stays gone. If the intent was that sanitizing *should* use cpdf, that is a
product decision above my grade — the current behaviour is fully local.
