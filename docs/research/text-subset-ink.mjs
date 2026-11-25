/**
 * Per-glyph ink proof for the UnicodeFaceEmbedder subset seam (findings §3.1):
 * draw one character at a time with a `getFont(..., 'noto')` face and hand the
 * file to `text-subset-ink.py`, which counts ink per cell and parses the
 * embedded program.
 *
 *   BASE=http://localhost:5291 CDP=98xx node docs/research/text-subset-ink.mjs /tmp/subset.pdf
 *   python3 docs/research/text-subset-ink.py /tmp/subset.pdf
 *
 * The defect read as: `#`/`A`/`4` carried ink, `B`/`—`/`Z` measured ink 0, and
 * the text still extracted — because fontkit's subsetter halves every `loca`
 * offset in the short form and the bundled Noto faces keep glyph records at odd
 * bytes. `alignTrueTypeGlyphs` (aae5110) fixes it at the two places face bytes
 * enter the embedder; disabling either call brings the zero-ink tail back.
 */
import fs from 'node:fs';
import path from 'node:path';
import { open } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:5291';
const OUT = process.argv[2] || '/tmp/subset-ink.pdf';
const CHARS = (process.env.CHARS || '#A4B\u2014Z').split('');

const h = await open();
await h.send('Page.navigate', { url: `${BASE}/` });
await h.wait(`!!document.querySelector('#root')`, 40000);
const b64 = await h.ev(`(async () => {
  const doc = await import('/src/lib/pdf/core/doc.ts');
  const fonts = await import('/src/lib/pdf/core/fonts.ts');
  const d = await doc.PDFDocument.create();
  const p = d.addPage([595, 842]);
  const chars = ${JSON.stringify(CHARS)};
  let x = 60;
  const cells = [];
  for (const ch of chars) {
    const f = await fonts.getFont(d, { text: ch, size: 30, fontFamily: 'noto' });
    p.drawText(ch, { x, y: 700, size: 30, font: f });
    cells.push({ ch, x, w: 60 });
    x += 70;
  }
  const bytes = await doc.savePDF(d);
  let s = ''; const u = new Uint8Array(bytes);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return JSON.stringify({ pdf: btoa(s), cells });
})()`);
const { pdf, cells } = JSON.parse(b64);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.from(pdf, 'base64'));
fs.writeFileSync(`${OUT}.cells.json`, JSON.stringify(cells));
console.log('wrote', OUT, fs.statSync(OUT).size, 'bytes — measure with text-subset-ink.py');
h.chrome.kill();
process.exit(0);
