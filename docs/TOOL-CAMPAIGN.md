# TOOL CAMPAIGN — one tool per agent

The queue for auditing every tool against the live build. One row per tool, one
agent per tool, no agent touches a file it does not own.

**The rule.** A tool is verified only by measuring **what the user sees, and what
the file contains.** Both halves or neither:

- **browser evidence** — a real Chromium tab against a live dev server (started
  *detached*: `(nohup npx vite --port 52xx --strictPort >/tmp/xx.log 2>&1 &)`),
  a screenshot of the tool holding real content, and ink measured **off the
  canvas bitmap** — never inferred from a node count or a reported total.
- **a byte-level check of the exported file** — open the download with PyMuPDF
  and measure what the file itself draws (`get_pixmap` ink vs. the untouched
  source), not merely that an object exists in it.

A green unit run is neither half. Every assertion written around this area so far
has been about **counts and presence** — blocks extracted, marks added, objects
written — and never about output. That is the same shape as the markup bowtie,
the vacuous image compression and the zero-ink link: `edit-pdf` once shipped a
`area=0` mark with 1,400 passing tests. The symptom was real; the tests were
blind.

**Status** — `unexamined` → `defect-found` → `fixed+deployed` → `verified-good`.
A row may only reach `verified-good` with both evidence halves recorded.
`blocker:` in the last column means the true cause sits in a shared module the
tool's owner must not edit without a decision; the fix is sequenced, not
improvised.

Harness beside this file: `research/audit3-cdp.mjs` (CDP driver),
`research/audit3-sweep.mjs` (canvas ink + exported bytes),
`research/audit3-bytescan.py` (file-side measure),
`research/text-campaign-repro.mjs` (edit-pdf-text: load → open block → export →
dump the content stream), `research/text-campaign-dark.mjs` (same, dark mode).

| tool | status | cause / evidence | owner seam |
| --- | --- | --- | --- |
| `edit-pdf-text` | fixed+deployed | **Blank page whose words were still selectable.** Canvas measured `opaque 0 / ink 0` of 500 395 px while the pane reported `20 text block(s)`; `edit-pdf` measured `100 % / 1.08 %` on the same build (`docs/research/shots/campaign-text-before-1-loaded.png` vs `campaign-text-1-loaded.png`, `…-before-2-block-open.png` shows the overlay's `#000000` fallback colour painting over a page with nothing under it). Cause: `core/render.ts` `renderToCanvas` copied pdf.js's intermediate canvas **before the render task had painted** and then cancelled that task — one `await` short. After the fix the same measurement is `opaque 500 395 / ink 5 407`, dark mode included, and the `RenderingCancelledException` is gone. **The exported file was never blank** — on-screen only. Its content stream carries `… 0 Tr … <glyphs> Tj` with an opaque fill, and PyMuPDF rasterises "Talently Self-Assessment" at `[48, 75.6, 279.6, 102.9]`, 20 900 dark px in that strip. The fill was the `#000000` fallback, because `readPalette` was sampling a transparent canvas; with the page painted the same block exports in the document's own `#18181b`. Fix `694e007`, ledger `d6439a9`, CI green on `42458236025`, and the **deployed** site re-measured after the push: `https://www.browsersnip.com/#/tool/edit-pdf-text` → `opaque 100 % / ink 1.08 %` with no console error — the same probe that read `0 / 0` is what the report was about. | `text-editor/**` + `core/render.ts` (shared — editing it approved by the parent, 2025-11-08) |
| `edit-pdf` | verified-good | Audit #3 (`research/edit-pdf-audit.md`): 17 tools' canvas ink and exported bytes measured; the three defects found are fixed in `0ea6eac`, `9d6ef0b`. | `editor/**` |

## Sequenced from the `edit-pdf-text` row — not fixed there

1. **13 call sites read a `renderPage` canvas without awaiting `finished`**
   (`grep -rn "await [^)]*renderPage(" src/ | grep -v core/render.ts | wc -l`):
   `core/measure.ts` (`isBlankPage`, `detectSkew`, the rasterise pair),
   `core/ocr.ts`, `tools/{convert-from,edit,optimize,security}.ts`,
   `edit/{FormCreatorMain,FormFillMain}.tsx`,
   `editor/AnnotationEditor.tsx:2766`. They race the same paint the text editor
   lost; several look healthy only because image encoding yields to the event loop
   long enough for pdf.js to catch up. None is measured here — each belongs to its
   own tool's row, where the bytes can be checked. (`thumbnails()` renders through
   `page.render` itself and is not affected.)
2. **`shared/PreviewPane.tsx` is imported by nothing in `src/`**
   (`grep -rln PreviewPane src/` → only itself; its only consumers are
   `tests/pdf/ux-rail.test.ts` and `tests/app/shared-ui.test.tsx`). Dead code with
   a live-looking name: agents keep reasoning about the UI as though it were
   mounted. Cleanup candidate for a layout pass — **do not delete it here**, since
   whether something is still expected to mount it is a layout question.
3. **A rewritten block lands ~6 pt above the run it replaced** — original span
   bbox top `81.6`, the file's rewritten top `75.6` at the same 20 pt size. Screen
   and file agree (both come from `model.layoutBlock`), so it is placement
   accuracy, not invisibility. P2, text-editor's own seam.
