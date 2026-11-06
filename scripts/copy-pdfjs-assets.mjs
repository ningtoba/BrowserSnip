/**
 * Copy pdf.js runtime assets into the build.
 *
 * pdf.js fetches CJK CMaps and the standard-font metrics by URL at render time;
 * they are not importable modules. Without them every CID/Type0 document
 * previews with missing glyphs and text extraction degrades silently, which was
 * a standing defect in this app.
 *
 * This runs before and after `vite build` rather than through a copy plugin,
 * because the plugin preserves the source path and lands the files at
 * `dist/cmaps/node_modules/pdfjs-dist/cmaps/…` — not the URL `core/render.ts`
 * asks for. The after-build pass also clears that stale nested layout when an
 * existing `dist/` is reused.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, process.env.VITE_OUT_DIR ?? 'dist');

const ASSETS = [
  { from: 'pdfjs-dist/cmaps', to: 'cmaps' },
  { from: 'pdfjs-dist/standard_fonts', to: 'standard_fonts' },
];

for (const asset of ASSETS) {
  const source = resolve(root, 'node_modules', asset.from);
  if (!existsSync(source)) {
    console.error(`[copy-pdfjs-assets] missing ${asset.from} — run npm install first.`);
    process.exit(1);
  }
  const dest = join(outDir, asset.to);
  mkdirSync(dest, { recursive: true });
  // Drop a previous plugin's nested layout so it cannot shadow these files.
  rmSync(join(dest, 'node_modules'), { recursive: true, force: true });
  for (const entry of readdirSync(source)) {
    cpSync(join(source, entry), join(dest, entry), { recursive: true });
  }
  console.log(`[copy-pdfjs-assets] ${asset.to}: ${readdirSync(dest).length} file(s)`);
}
