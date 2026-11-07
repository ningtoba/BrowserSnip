# S2 → other workers

S2 landed "engines are silent, not deleted". Nothing here needs a decision from
you unless you own the file named.

## What changed under S2's ownership

- `src/lib/pdf/engines/EngineGate.tsx` **deleted** (`EngineGate`,
  `EngineBadge`, `EngineSettingsDialog`, `useEngineStatus`).
- `src/lib/pdf/engines/auto.ts` **added**: `ensureEngine(id, { onStatus })`
  resolves the built-in jsDelivr address, runs the loader once per tab, never
  throws, and returns `{ ok:false, reason }` when the network refuses. Loaders
  are called from exactly one place, so a tool cannot start a second download.
- `core/engine-ops.ts`: every operation provisions its own engine and accepts
  `{ onStatus }`; a failed fetch becomes `EngineUnavailable` whose message names
  the engine, the host and the cause — and never a setting.
- `tools/runner.ts`: the `NEEDS_ENGINE` pre-flight **is gone**. A tool that
  declares `engines` simply runs; `engines` is now only a promise about what the
  run will use.
- `tools/optimize.ts`: `linearize-pdf` / `pdf-to-pdfa` always try the engine and
  degrade into `result.warnings`; `font-to-outline` and `repair` have no
  fallback, so they fail with the reason.
- `tests/pdf/engine-auto.test.ts` guards the module graph: no file in `src/` may
  mention `EngineGate`, `EngineSettingsDialog`, `EngineBadge`,
  `EngineRequirementBadge` or `useEngineStatus` again.

## S1 — no action needed

AppLayout's chip, dialog and `EngineRequirementBadge` are gone and
`npx tsc --noEmit` is clean for every path S2 owns. If you touch engines again,
the ratchet above will tell you.

## M2 — `text-editor/**` (wave 2, do it when you get there)

S2 edited `TextEditor.tsx` because deleting `EngineGate.tsx` left its import
dangling and M2 was not running. **Four lines removed, nothing else:**

- `import { EngineSettingsDialog } from '@/lib/pdf/engines/EngineGate';` (was 141)
- `const [engineSettingsOpen, setEngineSettingsOpen] = useState(false);` (was 192)
- the `if (action === 'open-engine') { setEngineSettingsOpen(true); return; }`
  branch of `runAdviceAction` (was 571-574)
- `<EngineSettingsDialog open={engineSettingsOpen} … />` (was 1455)

Two consequences you own:

1. `pageAdvice.ts` still offers `'open-engine'` (label "Load the optional
   engine", `pageAdvice.ts:41,77,122`). That chip now does nothing. Remove the
   action, or repoint it at something real.
2. `engineRepairAvailable()` is now **always true** — an engine has an address
   whether or not the tab can reach the CDN — so the `Optional engine offline:`
   branch at `TextEditor.tsx:1445-1448` is dead, and the sentence it replaces
   ("PyMuPDF engine is reachable") can be a lie while offline. The honest signal
   is already in the export path: `repairWithPyMuPDF()` returns `null` when
   provisioning fails and the blocks are reported instead. Do not restore a
   *pre-run* promise; report the fall-back **after** the attempt, in the same
   warning/toast channel, naming which blocks were left alone.

## M5 — `hooks/usePdfTool.ts`, `shared/PdfToolPanel.tsx` (wave 2)

- `usePdfTool.ts:180-185` still builds a blocker `Needs the optional X module.
  …` off `engineReady`. The runner no longer refuses, so this blocks a Run
  button on a setting that no longer exists. Delete the blocker (or turn it into
  the fetch notice: `engineFetchNotice` is gone; `enginePurpose(id)` remains).
- `PdfToolPanel.tsx:348-363` `EngineNotice` says "Advanced engine ready" whenever
  an address exists — which is always. It should say what will happen instead:
  the file is processed in this tab, and the module is fetched once from
  jsDelivr the first time it is needed.

## S3 — `scan-to-pdf` hangs your own test

`tests/pdf/edge-optimize.test.ts:942` ("refuses to run from the Run button…")
times out at 5 s. All four pane tools now have `run`, so the `/own editor pane/i`
premise is gone, and `runPdfTool({ toolId: 'scan-to-pdf' })` never settles with
one image input:

```text
sign=rejected "Sign PDF needs a signature placed on the page…"
pdf-crop=rejected "Crop PDF needs a crop rectangle from its own editor…"
scan-to-pdf=HUNG
compare=rejected "This tool needs at least 2 files — 1 added."
```

`edge-optimize.test.ts` is in S2's must-be-green list, so S2 adjusted only the
two assertions that encoded the deleted engine concept (`:570`, and the
linearize "not configured" case at `:689`). This fourth failure is not about
engines and S2 left it alone.
