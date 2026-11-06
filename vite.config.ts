/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import path from 'path';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    // pdf.js needs its CJK CMaps and the standard-font metrics at runtime.
    // Without them every CID/Type0 document previews with missing glyphs and
    // text extraction degrades. They are copied, not bundled, because pdf.js
    // fetches them by URL.
    viteStaticCopy({
      targets: [
        { src: 'node_modules/pdfjs-dist/cmaps/*', dest: 'cmaps' },
        { src: 'node_modules/pdfjs-dist/standard_fonts/*', dest: 'standard_fonts' },
      ],
    }),
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
