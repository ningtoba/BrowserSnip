/// <reference types="vitest/config" />
/**
 * Config for the `txt-to-pdf` tail rig, which lives in `docs/research/` beside the
 * tables it produces.
 *
 * Separate from CI's config on purpose — `test.include` is `tests/**`, and this rig
 * writes fixtures and run counts out to `/tmp/txttail` for `text-tail-measure.py`
 * rather than asserting on them. It still needs the repo alias, the React plugin
 * and the jsdom setup, because it drives the shipped `runPdfTool` over the shipped
 * `core/layout.ts`.
 *
 *   npx vitest run --config docs/research/text-tail.vitest.config.ts
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');

export default defineConfig({
  root: repo,
  plugins: [react()],
  resolve: { alias: { '@': path.join(repo, 'src') } },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: [path.join(repo, 'tests/setup.ts')],
    include: ['docs/research/text-tail-rig.test.ts'],
    css: false,
  },
});
