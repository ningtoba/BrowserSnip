pdf-to-pdfa — re-measured after `4ad2be3`, and the ENGINE row's inventory
==========================================================================

Run 2026-11-12 on `58cbaff`, in the BrowserSnip sandbox. Node v26, the engine the
tab downloads (`@bentopdf/gs-wasm@0.1.1`, GPL Ghostscript 10.06.0, cached at
`node_modules/.browsersnip-gs/gs.wasm` — 15 533 046 bytes, sha256 `c3373cd4a123f05b…`).
Every number below was printed by a command in this repo; nothing is retyped from
`font-outline-proof.log`.

## 1. Is the tool on its fallback today? No — the engine's bytes ship.

  0  python3 docs/research/font-outline-fixtures.py /tmp/fo-fix2
       type.pdf 2 416 B (2 pages, 107 extractable chars per page), type-art.pdf 9 186 B,
       art-only.pdf 6 937 B — same sizes the campaign recorded.
  1  BROWSERSNIP_GS_DUMP=/tmp/fo-argv-now.json npx vitest run tests/pdf/font-outline.test.ts
       `diff /tmp/fo-argv-now.json docs/research/font-outline-argv.json` → identical:
       the source still builds the glued `-sOutputFile=<path>` vector `4ad2be3` shipped.
  2  timeout 300 node docs/research/font-outline-wasm.mjs docs/research/font-outline-argv.json \
       /tmp/fo-fix2/type.pdf /tmp/fo-out
       convertToPdfA (pdf-to-pdfa) [split-output-file (pre-4ad2be3)] exit 1  out 0 B
       convertToPdfA (pdf-to-pdfa) [as-built]                          exit 0  out 5 515 B
       textToOutlines  [split] exit 1 0 B · [as-built] exit 0 22 177 B
       rebuildWithGhostscript [split] exit 1 0 B · [as-built] exit 0 3 113 B
     The pre-fix shape is still dead — every vector that splits the switch from its
     path writes nothing. That is the state in which `pdf-to-pdfa` shipped its file
     from `bestEffortPdfA` while the card said Ghostscript.
  3  the app's own tool, through `runPdfTool`, on the same fixture (probe #2, this
     file's §5): ENGINE 5 502 B, and the same seam call alone gives 5 502 B twice in
     one process. The rig's replay of the same argv on the same input is 5 515 B;
     the two files agree object for object on the catalogue and the XMP packet is
     1 568 B in both, differing only in `xmp:ModifyDate`/`CreateDate`/`MetadataDate`
     and `xmpMM:DocumentID` (and the random font-subset tag `NBLSWY+` vs `PCXERT+`).
     I did not attribute the remaining 13 B further.

     Producer, read by readers that did not write it (`pypdf`): `GPL Ghostscript
     10.06.0`. So — measured, not inferred — **`pdf-to-pdfa` runs Ghostscript today.**
     The fallback only runs when the engine is refused; forcing it (no address for
     `ghostscript`, which is what an offline tab hands the loader) gives 3 165 B with
     producer `BrowserSnip`.

## 2. The bigger finding: what each path's bytes actually carry

Same fixture, both paths, read back with MuPDF 1.28.2 and pypdf 6.14.2 — neither of
which wrote the file (`docs/research/pdfa-attribution-readers.py`, whose full output
is quoted at the foot of this file):

                          engine (Ghostscript)   forced fallback (local path)
  bytes                     5 502 B                3 165 B
  /Producer (pypdf)         GPL Ghostscript 10.06.0   BrowserSnip
  XMP pdfaid:part/conf      2 / B                  2 / B
  /OutputIntents            absent, per MuPDF and pypdf both   array → [19 0 R]
  intent dictionary         —                      /S /GTS_PDFA1, /OutputConditionIdentifier
                                                   /sRGB IEC61966-2.1, /RegistryName
                                                   /http://www.color.org, and a 476-byte
                                                   /DestOutputProfile stream
  /MarkInfo /Marked true    absent                 present
  font on the page          NBLSWY+Helvetica (Type1, subset) whose descriptor carries
                            /FontFile3 15 0 R — EMBEDDED
                            Helvetica (Type1), no font file in the descriptor — not
                            embedded

  Ghostscript's own log for the run is empty (`exit 0`, `log: []`), so
  `-dPDFACompatibilityPolicy=1` had nothing to report, and the tool printed
  "Converted to PDF/A-2b with Ghostscript: 0 of 1 font(s) embedded, 0 conformance
  warning(s) reported" over a catalogue with no output intent at all — PDF/A
  §6.2.11.4 requires one — and over a subset font that MuPDF and pypdf both read as
  embedded.

  Consequences, in the order they matter:
  * **The fallback writes the more conforming catalogue** than the engine on this
    input: output intent, ICC profile and `/MarkInfo`, none of which the engine's
    file has. The tool's note ("A conforming conversion runs on Ghostscript … if it
    cannot be reached, BrowserSnip writes the XMP identification, an sRGB output
    intent and the tagging flag") reads as if the fallback is the weaker file;
    measured, the intent and the flag are the fallback's and the embedded font is the
    engine's. The engine path is still the one that can ship a PDF/A a validator
    accepts on fonts, which is what its description claims.
  * Two reporting bugs in the tool's own file, both fixed in this ticket's copy pass:
    the engine branch never looked at the catalogue it chose to keep, and `auditFonts`
    read `/FontFile*` off the **font dictionary** instead of its `/FontDescriptor`, so
    an embedded subset was announced as missing.
  * The absent output intent is an **invocation** gap in `core/engine-ops.ts`
    (`-dPDFA=2` with no ICC profile and no `pdfa_def.ps` prologue, so `pdfwrite`
    identifies without intending). Reported, not changed here: the argv is the logic
    that shipped today and its tests are the reference.

## 3. Every place the app claims an engine ran (the step-1 inventory)

Line numbers are as of `58cbaff`, before anything was changed.

Display
  * `src/components/tools/pdf/shared/ToolSurface.tsx:608` — `engine={engines[0] ??
    null}`: the ENGINE row's value is the tool's declaration. This is the defect.
  * `ToolSurface.tsx:562` — `degraded = warnings.some(/degrad/i)`: whether the run
    degraded is inferred by regexing prose. `pdf-to-pdfa`'s fallback sentence says
    "produced by the local path", which has no "degrad" in it, so a pdf-lib file was
    labelled Ghostscript *and* not degraded.
  * `ToolSurface.tsx:128`, `src/components/layout/ToolWorkspace.tsx:230` — both feed
    `engines` from `definition.engines` (a capability list) into that row.
  * `ResultCard.tsx:30-33` — the prop's own doc comment claims "Engine the run
    actually used"; nothing upstream ever produced such a value.
  * `ResultCard.tsx:52-56` + `:221-228` — renders the label, the `· degraded` suffix,
    and `pdf-lib core` when no engine is named.

Plumbing that cannot carry the fact
  * `src/lib/pdf/tools/types.ts:130-160` — `ToolResult` has `warnings`, `pages`,
    `message`; no field for who wrote the bytes.
  * `src/lib/pdf/tools/runner.ts:45-60` — `RunOutcome` likewise (`outputs`,
    `warnings`, `pagesOut`).
  * `runner.ts:318-326` — the `CAVEAT` regex bridge: the only channel by which an
    admission reaches the card today is prose that happens to match it.
  * `src/stores/process-store.ts:74-77`, `:161-162`, `:386-409` — an output is a
    blob + url + name; provenance has nowhere to travel.

Tool-side sentences that credit an engine
  * `optimize.ts:1564` — pdfa engine branch: "Converted to PDF/A-2b with Ghostscript".
  * `optimize.ts:1569` — pdfa catch: "…produced by the local path" (true, invisible).
  * `optimize.ts:1548` — pdfa: Ghostscript's file discarded for not reopening, the
    local conversion ships, the row said Ghostscript.
  * `optimize.ts:1470-1471` — linearize: "Linearized with CoherentPDF" / "Rewritten
    by CoherentPDF" (both observed off the kept engine bytes).
  * `optimize.ts:1477`, `:1493-1500` — linearize: engine unreachable, or its output
    discarded; the local rebuild ships while the row said `cpdf`.
  * `optimize.ts:1150-1184` — repair: keeps `engine: 'pdf-lib' | 'ghostscript'` in a
    local and credits Ghostscript in a warning, but declares no `engines`, so the row
    is absent even when Ghostscript wrote the file.
  * `optimize.ts:1665-1669` — font-to-outline: three headlines naming Ghostscript,
    accurate only because the tool has no fallback path.
  * `components/tools/pdf/text-editor/draw.ts:808`, `text-editor/engine.ts:78` —
    "N blocks cleaned by the optional PyMuPDF engine": observed from the repair set.
  * `src/hooks/usePdfTool.ts:323-331` — the blocker "Connect to the internet to load
    X — this tool cannot run without it", printed for the two tools that do have a
    local path (pdfa, linearize).

Copy that is a capability claim read as a run claim
  * `optimize.ts:1511` (description), `:1518` (promise), `:1535-1536` (notes) — pdfa.
  * `optimize.ts:1438-1445` — linearize description/note.
  * `optimize.ts:1610-1622` — font-to-outline description/promise/notes, including
    "This tool has no degraded path", which the campaign still refuses to soften.

Shape of it: **one display site reads config, one inference site regexes prose, four
tool branches already know the truth, and the plumbing between them has no field for
it.** Fixed by carrying an observed `producedBy` from the branch that wrote the bytes
through the runner and the store to the card, per output.

## 4. What the attribution now reports (after the change)

`ToolResult.producedBy` / `ToolOutputFile.producedBy`, stamped by the branch that wrote
the bytes and carried per output through `RunOutput` → the process store's
`outputSources` → the card:

| reported by the run | the `ENGINE` row prints |
| --- | --- |
| `{ via: 'engine', engine: 'ghostscript' }` | `Ghostscript` |
| `{ via: 'fallback', engine: 'ghostscript' }` | `local path · Ghostscript not used` (warn token) |
| `{ via: 'core' }` | `local path · no engine` |
| a mixed batch | `mixed · see the list below`, each file's own label on its row |
| nothing, on a tool that declares an engine | `not reported` (warn token) |
| nothing, on a tool that declares none | no row at all |

The row is never filled from `tool.engines` again — the declaration is read only to
decide whether silence deserves calling out. Two more sentences changed to agree with
the bytes: `pdf-to-pdfa`'s engine headline now prints `an output intent in the
catalogue` or `no output intent in the catalogue`, read back off the file it is handing
over, and `auditFonts` looks for a font program on the `/FontDescriptor` (§2's last
bullet) instead of reporting Ghostscript's embedded subset as missing.

## 5. Reproduce

  # fixture sizes + both paths + the producer read back by MuPDF/pypdf
  python3 docs/research/font-outline-fixtures.py /tmp/fo-fix2
  node docs/research/font-outline-wasm.mjs docs/research/font-outline-argv.json \
       /tmp/fo-fix2/type.pdf /tmp/fo-out
  python3 docs/research/pdfa-attribution-readers.py \
    "/tmp/fo-out/type.convertToPdfA_(pdf-to-pdfa).as-built.pdf" \
    /tmp/fo-fix2/type.gsvg-0.pdf /tmp/fo-fix2/type.fallback.pdf /tmp/fo-fix2/type.pdf
  # the app's own paths, with and without an address for Ghostscript, asserted on
  # the bytes: `BROWSERSNIP_GS=live npx vitest run tests/pdf/engine-attribution.test.ts`

The two `/tmp/fo-fix2/type.gsvg-*.pdf` files and `type.fallback.pdf` are written by
the live block of `tests/pdf/engine-attribution.test.ts`, which prints each size and
the catalogue reading it asserts, so §1 and §2 are output rather than prose.

```
$ python3 docs/research/pdfa-attribution-readers.py \
    "/tmp/fo-out/type.convertToPdfA_(pdf-to-pdfa).as-built.pdf" \
    /tmp/fo-fix2/type.gsvg-0.pdf /tmp/fo-fix2/type.fallback.pdf /tmp/fo-fix2/type.pdf
/tmp/fo-out/type.convertToPdfA_(pdf-to-pdfa).as-built.pdf
  bytes 5515  pages 2
  producer GPL Ghostscript 10.06.0
  xmp_pdfaid 2 conformance B
  output_intents absent
  markinfo absent
  fonts NBLSWY+Helvetica (Type1) embedded
  pypdf_catalog_output_intents absent
/tmp/fo-fix2/type.gsvg-0.pdf                          # same argv through core/engine-ops
  bytes 5502  pages 2
  producer GPL Ghostscript 10.06.0
  xmp_pdfaid 2 conformance B
  output_intents absent
  markinfo absent
  fonts NBLSWY+Helvetica (Type1) embedded
  pypdf_catalog_output_intents absent
/tmp/fo-fix2/type.fallback.pdf   # pdf-to-pdfa with no address for Ghostscript
  bytes 3165  pages 2
  producer BrowserSnip
  xmp_pdfaid 2 conformance B
  output_intents array  <</Type/OutputIntent/S/GTS_PDFA1/OutputConditionIdentifier/sRGB#20IEC61966-2.1/RegistryName/http:#2F#2Fwww.color.org/Info/sRGB#20IEC61966-2.1#20#28minimal#20profile#20written#20by#20BrowserSnip#29/DestOutputProfile 18 0 R>> | DestOutputProfile stream 476 B
  markinfo present
  fonts Helvetica (Type1) NOT embedded
  pypdf_catalog_output_intents present
/tmp/fo-fix2/type.pdf                                      # the input, for comparison
  bytes 2416  pages 2
  producer none
  xmp_pdfaid no conformance no
  output_intents absent
  markinfo absent
  fonts Helvetica (Type1) NOT embedded
  pypdf_catalog_output_intents absent
```

## 6. On the deployed site, in both states, judged by the download

Rig: `docs/research/engine-attribution-live.mjs` (headless Chromium over CDP, one fresh
profile per pass because the engine loader is a module singleton; `pdf-to-pdfa`, the
campaign's own 2 416-byte `type.pdf`; the produced file is taken out of the page as
bytes and searched for Ghostscript's producer string). Full output committed as
`docs/research/engine-attribution-live.log`.

    BASE=https://www.browsersnip.com PDF=/tmp/fo-fix2/type.pdf \
      node docs/research/engine-attribution-live.mjs

bundle `assets/index-CIIyqWlH.js` — fetched and grepped first, so the claim is about the
deployed build: it carries `local path · `, `not reported` and `see the list below`.

| pass | the card's `ENGINE` row | download | producer inside those bytes |
| --- | --- | --- | --- |
| `cdn.jsdelivr.net` blocked before navigation | `local path · Ghostscript not used` | 3 165 B | none |
| nothing blocked (the engine is fetched) | `Ghostscript` | 5 506 B | GPL Ghostscript |

The blocked pass is the demonstration the label needed: the same tool, the same
declaration, the same fixture — the card no longer credits Ghostscript for a file it did
not write, and the sentence under it says "with this app's own path, not Ghostscript".
The live pass prints `Converted to PDF/A-2b with Ghostscript: 1 of 1 font(s) embedded,
no output intent in the catalogue`, which is §2 read back off the file rather than
asserted by the switch list: the font audit fix (the descriptor, not the font dictionary)
turns the old false `0 of 1` into `1 of 1`, and the absent output intent is now said.

Four runs of the same vector on the same input — 5 502 B (this file's §1), 5 506 B
(deployed), 5 507 B (the same build previewed locally), 5 515 B (the wasm rig) — land
13 B apart. Ghostscript's `/ID`, its XMP dates and its random subset tag vary per run;
the catalogues and the 1 568-byte XMP packets are identical, so the size is not a
signal of a different invocation. The producer string is.
