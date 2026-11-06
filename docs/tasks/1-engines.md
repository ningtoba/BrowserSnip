Implement §1 (optional CDN engines) of `docs/PDF-ENGINE-CONTRACT.md`. Cwd = repo root.

STRICT FILE OWNERSHIP — create/edit ONLY:
  src/lib/pdf/engines/provider.ts, pymupdf.ts, ghostscript.ts, cpdf.ts, EngineGate.tsx, index.ts
  tests/pdf/engines-provider.test.ts, tests/setup.ts
Do NOT touch package.json, vite.config.ts, src/lib/constants.ts, src/types/index.ts, src/components/layout/**, src/lib/pdf/core/**, src/lib/pdf/tools/**. No npm install. No git.

EVIDENCE — read the actual production bundles yourself before coding:
  /tmp/bento/assets/wasm-provider-Cp29wuFm.js
  /tmp/bento/assets/pymupdf-loader-DepifpKa.js
  /tmp/bento/assets/cpdf-helper-jUoWoX-F.js
  /tmp/bento/assets/ghostscript-loader-*.js and ghostscript-dynamic-loader-*.js (download if absent)
Verified facts to honour: default CDN URLs
  pymupdf    https://cdn.jsdelivr.net/npm/@bentopdf/pymupdf-wasm@0.11.16/
  ghostscript https://cdn.jsdelivr.net/npm/@bentopdf/gs-wasm@0.1.1/assets/
  cpdf       https://cdn.jsdelivr.net/npm/coherentpdf@2.5.5/dist/
Probe files for URL validation: dist/index.js, gs.js, coherentpdf.browser.min.js.
PyMuPDF: `await import(base+'dist/index.js')` → `new mod.PyMuPDF({assetPath: base+'assets/'})` → `await load()`; their loader also refuses to run unless ghostscript is configured — replicate honestly.
cpdf: classic script that sets `window.coherentpdf`; inject a <script> once and await onload.
Trusted-host set = location.hostname + default URL hosts; a URL the user deliberately saves becomes trusted; stale/foreign stored URLs are refused and scrubbed. Our localStorage key: 'browsersnip:wasm-engines'.
Fetch the REAL PyMuPDF API from https://cdn.jsdelivr.net/npm/@bentopdf/pymupdf-wasm@0.11.16/types/index.d.ts and mirror actual method names — do not guess.

DELIVERABLES: provider singleton per §1 (incl. subscribe, validateUrl with 10s AbortController timeout, reset, snapshot) + EngineUnavailable{engine, remediation}; memoised concurrent-safe loaders; EngineGate.tsx (EngineBadge, EngineGate, EngineSettingsDialog, useEngineStatus) styled with the app's EXISTING vocabulary only — read src/index.css, src/components/ui/FileDropZone.tsx and src/components/tools/pdf/security/ProtectTool.tsx first (doodle-btn, doodle-input, doodle-chip, rounded-doodle-md, bg-cream, text-ink, text-ink-muted, border-cream-border, shadow-doodle-card, accent/success/warn/danger; framer-motion like ProtectTool). The dialog: per-engine URL input, Test, Recommended + copy, status pill, Save/Reset, and an honest note that the module downloads once from a CDN and is cached, the PDF never leaves the device, and these three engines are AGPL-3.0 while BrowserSnip is MIT. Barrel index.ts.

TESTS: vitest/jsdom with localStorage — defaults, trust list, stale-prefix rejection, setUrl/removeUrl/reset, validateUrl against stubbed fetch. Create tests/setup.ts importing '@testing-library/jest-dom/vitest' if missing (you own it).

VERIFY: `npx tsc --noEmit -p tsconfig.json` and `npx vitest run tests/pdf/engines-provider.test.ts`. Report file list, implemented API, deviations, test output. Report (do not fix) pre-existing errors in files you do not own.
