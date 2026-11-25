/// <reference types="vitest/config" />
/**
 * Config for the `txt-to-pdf` encoding-and-shape rig, which lives in
 * `docs/research/` beside the tables it produces. Same shape as
 * `text-tail.vitest.config.ts`: it drives the shipped tool over the shipped
 * layout engine and writes its evidence to `/tmp/txtenc` instead of asserting.
 *
 *   npx vitest run --config docs/research/txt-enc.vitest.config.ts
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
    include: ['docs/research/txt-enc-rig.test.ts'],
    css: false,
  },
});
