/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { writeFileSync } from 'node:fs';

/**
 * A build id the running page can compare itself against.
 *
 * GitHub Pages serves `index.html` with `cache-control: max-age=600`, so a deploy
 * is invisible to an open tab — and even to a hard reload — for up to ten minutes
 * while the CDN keeps handing out the old shell. The app fetches `version.json`
 * (never cached) and reloads once when the id moves, so a fix is live when it is
 * deployed rather than when the edge feels like it.
 */
const BUILD_ID = (process.env.GITHUB_SHA ?? '').slice(0, 12) || String(Date.now());

function buildVersion(): {
  name: string;
  config: () => { define: Record<string, string> };
  closeBundle: () => void;
} {
  return {
    name: 'build-version',
    config: () => ({ define: { __BUILD_ID__: JSON.stringify(BUILD_ID) } }),
    closeBundle() {
      const out = path.resolve(__dirname, 'dist', 'version.json');
      // `closeBundle` runs after the bundle is written; a failed write must not
      // fail the build, the worst case is the old behaviour (no reload).
      try {
        writeFileSync(out, JSON.stringify({ id: BUILD_ID }));
      } catch { /* no dist on a dev run */ }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [
    react(),
    buildVersion(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util', 'pdfjs-dist'],
  },
  build: {
    // PyMuPDF/Ghostscript/CoherentPDF are lazy CDN imports, so the app chunk
    // itself stays small; this only stops the vendor split from being noisy.
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          pdfjs: ['pdfjs-dist'],
          pdflib: ['@maxwbh/pdf-lib'],
        },
      },
    },
  },
  server: {
    https: process.env.VITE_HTTPS === 'true',
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  worker: {
    format: 'es',
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    css: false,
  },
});
