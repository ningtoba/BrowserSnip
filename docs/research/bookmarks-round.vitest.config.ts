/// <reference types="vitest/config" />
/**
 * Config for the `bookmarks` round rig, which lives in `docs/research/` beside
 * the fixtures and the readers it is measured against.
 *
 * It is a separate config on purpose: the default `include` is `tests/**`, so CI
 * never runs this file. It still needs the repo's alias, React plugin and jsdom
 * setup because it drives the shipped `runPdfTool` — the point of the pass is
 * what *this app* writes, not what pdf-lib can be coaxed into saying.
 *
 *   npx vitest run --config docs/research/bookmarks-round.vitest.config.ts
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
    include: ['docs/research/bookmarks-round-rig.test.ts'],
    css: false,
  },
});
