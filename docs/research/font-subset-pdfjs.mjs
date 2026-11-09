/**
 * The pdf.js half of the font-subset measurement: paint each probe PDF in
 * Chromium with the app's own renderer and count ink per character.
 *
 *   (nohup npx vite --port 5311 --strictPort >/tmp/5311.log 2>&1 &)
 *   BASE=http://localhost:5311 node docs/research/font-subset-pdfjs.mjs /tmp/fsb
 *
 * MuPDF and fontTools are read by `font-subset-measure.py`; pdf.js is the reader
 * the app itself draws previews with, so its verdict has to come from a real
 * browser. Each row of a probe PDF holds exactly one character, so pdf.js's own
 * text runs name the glyph whose ink is being counted — a run that extracts with
 * nothing painted under it is the user report this rig exists for.
 *
 * Writes `pdfjs<TAG>.json` next to the layout, which the table merges into its
 * `pdf.js` column.
 */
import fs from 'node:fs';
import path from 'node:path';
import { open } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:5311';
const OUT = process.argv[2] || '/tmp/fsb';
const TAG = process.env.TAG || '';
const prefix = TAG ? `-${TAG}` : '';
const DPI = Number(process.env.DPI || 150);
const SCALE = DPI / 72;

const install = async () => {
  const render = await import('/src/lib/pdf/core/render.ts');
  window.__pdfjsWarnings = [];
  const warns = console.warn.bind(console);
  const errors = console.error.bind(console);
  console.warn = (...args) => {
    window.__pdfjsWarnings.push(String(args.map(String).join(' ')).slice(0, 200));
    warns(...args);
  };
  console.error = (...args) => {
    window.__pdfjsWarnings.push(String(args.map(String).join(' ')).slice(0, 200));
    errors(...args);
  };

  /** One face: paint the file, then measure the ink under each extracted run. */
  window.__measure = async (base64, scale) => {
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    const session = await render.openRender(bytes);
    const canvas = document.createElement('canvas');
    const ink = {};
    const pages = session.numPages;
    for (let page = 1; page <= pages; page += 1) {
      const size = await session.renderToCanvas(page, canvas, scale);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) continue;
      const data = ctx.getImageData(0, 0, size.width, size.height).data;
      const items = await session.textItems(page);
      for (const item of items) {
        const text = item.str;
        if (text.length !== 1 || text.trim() === '') continue;
        // Item boxes come back in PDF user space at scale 1, origin top-left; the
        // bitmap is the same page at `scale`, so one multiplication lines them up.
        const x1 = Math.max(0, Math.floor(item.x * scale));
        const y1 = Math.max(0, Math.floor(item.y * scale));
        const x2 = Math.min(size.width, Math.ceil((item.x + item.w) * scale) + 2);
        const y2 = Math.min(size.height, Math.ceil((item.y + item.h) * scale) + 2);
        let dark = 0;
        for (let y = y1; y < y2; y += 1) {
          for (let x = x1; x < x2; x += 1) {
            const at = (y * size.width + x) * 4;
            if (at + 3 >= data.length || data[at + 3] < 8) continue;
            if (data[at] < 245 || data[at + 1] < 245 || data[at + 2] < 245) dark += 1;
          }
        }
        ink[text] = (ink[text] || 0) + dark;
      }
    }
    await session.destroy();
    return { pages, ink };
  };
  return 'ready';
};

const layout = JSON.parse(fs.readFileSync(path.join(OUT, `layout${prefix}.json`), 'utf8'));
const h = await open();
await h.send('Page.navigate', { url: `${BASE}/#/tool/edit-pdf-text` });
await h.wait("!!document.querySelector('input[type=file]')", 90000);
const installed = await h.ev(`(${install.toString()})()`);
if (installed !== 'ready') {
  console.error('install failed:', installed);
  process.exit(1);
}

const faces = [];
for (const face of layout.faces) {
  const file = path.join(OUT, face.pdf);
  if (!fs.existsSync(file)) {
    console.log(`  ${face.id}: no ${face.pdf}`);
    continue;
  }
  const base64 = fs.readFileSync(file).toString('base64');
  const painted = await h.ev(`window.__measure(${JSON.stringify(base64)}, ${SCALE})`);
  if (typeof painted === 'string' || !painted) {
    console.log(`  ${face.id}: pdf.js could not open the file (${String(painted).slice(0, 120)})`);
    faces.push({ id: face.id, error: String(painted).slice(0, 200), chars: 0, inked: 0, lost: 0, blank: [], warnings: [] });
    continue;
  }
  const ink = painted.ink || {};
  const expected = face.chars.filter((ch) => ch.trim() !== '');
  const blank = expected.filter((ch) => !ink[ch]);
  faces.push({
    id: face.id,
    chars: expected.length,
    inked: expected.length - blank.length,
    lost: blank.length,
    blank: blank.slice(0, 200).join(''),
    sample: expected.slice(0, 6).map((ch) => `${ch} ${ink[ch] || 0}`),
    pages: painted.pages,
  });
  const warnings = await h.ev('window.__pdfjsWarnings.splice(0)');
  faces[faces.length - 1].warnings = (warnings || []).slice(0, 12);
  console.log(
    `  ${face.id.padEnd(20)} pdf.js inked ${String(faces[faces.length - 1].inked).padStart(3)}` +
      `/${String(faces[faces.length - 1].chars).padStart(3)} lost ${String(blank.length).padStart(3)}` +
      ` warnings ${faces[faces.length - 1].warnings.length}`,
  );
}

const pageErrors = (h.errors || []).slice(0, 10);
fs.writeFileSync(
  path.join(OUT, `pdfjs${prefix}.json`),
  JSON.stringify({ base: BASE, dpi: DPI, faces, pageErrors }, null, 1),
);
console.log(`\nwrote ${path.join(OUT, `pdfjs${prefix}.json`)}`);
await h.send('Browser.close').catch(() => undefined);
h.chrome.kill();
process.exit(0);
