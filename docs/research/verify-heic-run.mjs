// `heic-to-pdf` on a live build: can this browser decode HEIC, and what comes out?
//
//   BASE=https://www.browsersnip.com FILES=/tmp/eight/tiny.heic,/tmp/eight/ios.heic \
//     OUT=/tmp/eight/heic.pdf node docs/research/verify-heic-run.mjs
//
// The card promises "Every HEIC you add becomes a PDF page, in the order you added
// them" — a claim about a *decoder the browser owns*. So this first asks the page, with
// real mouse-free but genuine in-page decodes (`createImageBitmap` and `<img>`, the two
// routes `core/images` uses), whether it can open the file at all; then drives the rail
// the way a person does and keeps the PDF. `verify-heic-read.py` compares the pixels
// that landed in the PDF against what Pillow/pi_heif decode from the same file.
import { writeFileSync, readFileSync } from 'node:fs';
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'https://www.browsersnip.com';
const FILES = (process.env.FILES || '/tmp/eight/tiny.heic').split(',').filter(Boolean);
const OUT = process.env.OUT || '/tmp/eight/heic.pdf';
const SHOT = process.env.SHOT || '';

const h = await open();
const rootId = async () => (await h.send('DOM.getDocument', { depth: -1 })).root.nodeId;
await h.send('Page.navigate', { url: `${BASE}/#/tool/heic-to-pdf` });
if (!(await h.wait(`!!document.querySelector('input[type=file]')`, 60000))) throw new Error('no file input');
await h.ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);

// ── Can this browser decode the bytes at all? ───────────────────────────────
for (const path of FILES) {
  const b64 = readFileSync(path).toString('base64');
  const name = path.split('/').pop();
  const verdict = await h.ev(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'image/heic' });
    const out = { file: ${JSON.stringify(name)}, bytes: bytes.length, ftyp: String.fromCharCode(...bytes.subarray(4, 12)) };
    try {
      const bitmap = await createImageBitmap(blob);
      out.createImageBitmap = bitmap.width + 'x' + bitmap.height;
      bitmap.close?.();
    } catch (error) { out.createImageBitmap = 'FAILED ' + (error && error.name); }
    const img = new Image();
    const url = URL.createObjectURL(blob);
    const loaded = await new Promise((resolve) => {
      img.onload = () => resolve('decoded ' + img.naturalWidth + 'x' + img.naturalHeight);
      img.onerror = () => resolve('FAILED (onerror)');
      img.src = url;
      setTimeout(() => resolve('FAILED (no event within 8s)'), 8000);
    });
    out.imgElement = loaded;
    URL.revokeObjectURL(url);
    return JSON.stringify(out);
  })()`);
  console.log('decode probe:', verdict);
}
// The blob hook above records the probe's own object URLs; start the run record clean.
await h.ev(`window.__blobs = []`);

const intakeRoot = await rootId();
await h.ev(`(() => { const i = [...document.querySelectorAll('input[type=file]')].find((x) => !x.closest('[role=group]')); if (i) i.setAttribute('data-probe-doc','1'); return !!i; })()`);
const docField = await h.send('DOM.querySelector', { nodeId: intakeRoot, selector: 'input[data-probe-doc]' });
await h.send('DOM.setFileInputFiles', { nodeId: docField.nodeId, files: FILES });
console.log('files in:', FILES.join(', '));
await sleep(12000);
console.log('state:', await h.ev(`JSON.stringify({
  names: (document.body.innerText.match(/[^\\n]*\\.heic[^\\n]*/gi) || []).slice(0, 4),
  button: (document.querySelector('#tool-process-btn')?.innerText || '').trim(),
  enabled: !(document.querySelector('#tool-process-btn')?.disabled ?? true),
  blocker: (document.body.innerText.match(/[^\\n]*(cannot|could not|refus|unsupported|depend)[^\\n]*/gi) || []).slice(0, 3),
})`));
if (SHOT) await h.shot(SHOT);

const n = await h.ev('window.__blobs.length');
console.log('run:', await h.ev(`(() => { const b = document.querySelector('#tool-process-btn'); if (!b) return 'missing'; if (b.disabled) return 'disabled: ' + (b.title || ''); b.click(); return b.innerText.trim(); })()`));
const madePdf = await h.wait(`[...window.__blobs].some((b) => /pdf/i.test((b && b.type) || ''))`, 180000);
if (!madePdf) {
  console.log('screen:', await h.ev(`(document.body.innerText.split('\\n').filter((l) => /heic|HEIC|page|refus|could not|failed|decode/i.test(l)).slice(0, 10).join(' ;; '))`));
  console.log('body:', await h.ev('document.body.innerText.slice(0,1400)'));
  h.chrome.kill('SIGKILL');
  process.exit(2);
}
await sleep(1500);
const file = await h.ev(`(async () => {
  // A PDF only: the intake and the file cards make object URLs of their own, and one
  // of those (the 472-byte HEIC preview) was mistaken for the output in an earlier run.
  const b = [...window.__blobs].reverse().find((x) => x && typeof x.arrayBuffer === 'function'
    && /pdf/i.test(x.type || ''));
  const u = new Uint8Array(await b.arrayBuffer());
  let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
  return JSON.stringify({ size: u.length, type: b.type, b64: btoa(s) });
})()`);
const info = JSON.parse(file);
writeFileSync(OUT, Buffer.from(info.b64, 'base64'));
console.log('wrote', OUT, info.size, 'bytes', info.type);
console.log('result screen:', await h.ev(`(document.body.innerText.split('\\n').filter((l) => /HEIC|heic|page|Page|embedded|refus|warn/i.test(l)).slice(0, 8).join(' ;; '))`));
console.log('console errors', JSON.stringify([...new Set(h.errors)].slice(0, 4)));
h.chrome.kill('SIGKILL');
process.exit(0);
