/// <reference types="vitest/config" />
/**
 * Config for the `csv-to-pdf` structure rig: same shape as
 * `text-tail.vitest.config.ts` — it drives the shipped tool and writes evidence to
 * `/tmp/csvstruct` for `csv-struct-measure.py` instead of asserting.
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
    include: ['docs/research/csv-struct-rig.test.ts'],
    css: false,
  },
});
