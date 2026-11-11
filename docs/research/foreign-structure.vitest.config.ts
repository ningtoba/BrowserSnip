/// <reference types="vitest/config" />
/**
 * Config for the foreign-structure audit rig, which lives in `docs/research/` beside
 * the fixtures it reads.
 *
 * Separate from CI's config on purpose, for the same reason as
 * `encrypted-inputs.vitest.config.ts`: the default `include` is `tests/**`, so the
 * suite that runs on every push does not depend on committed fixture bytes that only
 * this pass compares. It still needs the repo's alias, React plugin and jsdom setup,
 * because it drives the shipped readers — the question is what *this app* believes
 * about a file it did not write, not what pdf-lib can be coaxed into saying.
 *
 *   npx vitest run --config docs/research/foreign-structure.vitest.config.ts
 *   BROWSERSNIP_FOREIGN_AUDIT=/tmp/audit.md npx vitest run \
 *     --config docs/research/foreign-structure.vitest.config.ts
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
    include: ['docs/research/foreign-structure-audit.test.ts'],
    css: false,
  },
});
