// What the app's own reader (pdf.js) paints, sampled per pixel: the reader the
// preview pane draws with, so a translucent mark and a multiplied one can be
// judged on screen instead of in a spec argument.
//
//   node docs/research/flatten-pdfjs-colour.mjs /tmp/r055/opacity.pdf /tmp/r055/out-opacity.pdf
//
// MuPDF, poppler and Ghostscript all ignore an annotation `/CA` and `/BM` on an
// appearance that carries no state of its own, so a bake that lost them looks
// correct in those three readers. pdf.js applies both, which is why this exists.
import fs from 'node:fs';
import { open } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:5271';
// Points in PDF user space, origin bottom-left, as `/Rect` is written.
const POINTS = (process.env.POINTS || '150,455;150,280').split(';').map((pair) => pair.split(',').map(Number));

const install = async () => {
  const render = await import('/src/lib/pdf/core/render.ts');
  window.__sample = async (base64, points) => {
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    const session = await render.openRender(bytes);
    const canvas = document.createElement('canvas');
    const size = await session.renderToCanvas(1, canvas, 2);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const out = points.map(([x, y]) => {
      const at = (Math.round((size.height / 2 - y) * 2) * size.width + Math.round(x * 2)) * 4;
      const data = ctx.getImageData(0, 0, size.width, size.height).data;
      return { x, y, rgb: [data[at], data[at + 1], data[at + 2], data[at + 3]] };
    });
    await session.destroy();
    return out;
  };
  return 'ready';
};

const h = await open();
await h.send('Page.navigate', { url: `${BASE}/#/tool/flatten-pdf` });
await h.wait('!!document.querySelector("input[type=file]")', 60000);
if ((await h.ev(`(${install.toString()})()`)) !== 'ready') throw new Error('install failed');
for (const file of process.argv.slice(2)) {
  const base64 = fs.readFileSync(file).toString('base64');
  console.log(file, JSON.stringify(await h.ev(`window.__sample(${JSON.stringify(base64)}, ${JSON.stringify(POINTS)})`)));
}
console.log('page errors', JSON.stringify((h.errors || []).slice(0, 3)));
await h.send('Browser.close').catch(() => undefined);
h.chrome.kill();
process.exit(0);
