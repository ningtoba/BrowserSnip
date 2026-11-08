// ocr-pdf cause probe — tell the two candidate causes apart before anything is
// fixed, because an ink check on an export cannot do it here: `ocr-pdf`'s output
// is a sentence, not a picture.
//
//   PDF=/tmp/ocr/scanned.pdf node docs/research/ocr-cause-probe.mjs
//
// Three measurements, in the same tab, with the app's own modules off the dev
// server (`/src/lib/...`), so nothing is reimplemented:
//
//  A. ENGINE — does `initOcr()` reach `ready`, and does `recognizeCanvas` read a
//     canvas that 2D text was painted into? A painted canvas the reader answers
//     is what excludes "the engine never arrived" as the cause.
//  B. PAINT ORDER — the ink of the very canvas `ocrDocument` hands the reader:
//     measured the moment `renderPage` settles (what the tool reads today) and
//     again after `render.finished` (what it would read with the await).
//  C. END-TO-END — `recognizeCanvas` on the *awaited* page canvas of a PDF with
//     no text layer, which must return the planted words.
//
// Same PDF, same engine, same canvas: only the await differs, so B is the whole
// distinction and A/C say the reader is not the one at fault.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5291';
const PDF = process.env.PDF || '/tmp/ocr/planted.pdf';
/** Order matters: the recogniser keeps a module-level image cache, so which page
 *  is read first decides which page answers. `PAGES=2,3` reads them untouched. */
const PAGES = (process.env.PAGES || '').split(',').map((n) => Number(n.trim())).filter(Number.isFinite);
const PORT = Number(process.env.PORT || 9793);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bytes = readFileSync(PDF);
let b64 = '';
for (let i = 0; i < bytes.length; i += 8192) b64 += String.fromCharCode(...bytes.subarray(i, i + 8192));
b64 = Buffer.from(b64, 'latin1').toString('base64');

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/ocr-cause-${PORT}`, 'about:blank'], { stdio: 'ignore' });
let ws;
for (let i = 0; i < 60 && !ws; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch { /* chrome not up yet */ }
  await sleep(300);
}
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 1;
const pending = new Map();
const errors = [];
ws.onmessage = (raw) => {
  const m = JSON.parse(raw.data);
  if (m.id && pending.get(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) rej(new Error(JSON.stringify(m.error)));
    else res(m.result);
  } else if (m.method === 'Runtime.exceptionThrown') {
    errors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 200));
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = id++;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(`${method} unanswered`)); } }, 20000);
});
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: `${BASE}/#/tool/ocr-pdf` });
for (let i = 0; i < 120; i++) {
  try { if (await ev(`document.readyState === 'complete'`)) break; } catch { /* not yet */ }
  await sleep(250);
}

const report = await ev(`(async () => {
  const PDF_B64 = ${JSON.stringify(b64)};
  const ink = (ctx, w, h) => {
    const d = ctx.getImageData(0, 0, w, h).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      const luma = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (d[i + 3] > 12 && luma < 245) dark++;
    }
    return { px: dark, of: w * h, pct: +(100 * dark / (w * h)).toFixed(2) };
  };
  const out = { pdf: 'dev-server modules', steps: [] };
  const engine = await import('/src/lib/ocr/engine.ts');
  const render = await import('/src/lib/pdf/core/render.ts');

  // A. the engine, on a canvas this probe painted itself
  const c = document.createElement('canvas');
  c.width = 760; c.height = 120;
  const cx = c.getContext('2d');
  cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, c.width, c.height);
  cx.fillStyle = '#000000'; cx.font = '52px sans-serif'; cx.textBaseline = 'middle';
  cx.fillText('Lighthouse Inventory 1887', 24, 60);
  const t0 = performance.now();
  try {
    await engine.initOcr();
    out.statusAfterInit = engine.getOcrStatus();
    out.initMs = Math.round(performance.now() - t0);
    const painted = await engine.recognizeCanvas(c);
    out.engineOnPaintedCanvas = { text: painted.text, lines: painted.results.length };
  } catch (error) {
    out.engineError = String(error && error.message || error);
    out.statusAfterInit = engine.getOcrStatus();
  }

  // B. the canvas \`ocrDocument\` feeds the reader, measured at both moments
  const raw = atob(PDF_B64);
  const u8 = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
  const session = await render.openRender(u8);
  out.pages = session.numPages;
  out.pageHasTextLayer = [];
  for (let p = 1; p <= session.numPages; p++) {
    const items = await session.textItems(p);
    out.pageHasTextLayer.push({ page: p, chars: items.reduce((n, it) => n + (it.str || '').trim().length, 0) });
  }
  const scale = 300 / 72;
  out.pageInk = [];
  const PAGE_ORDER = ${JSON.stringify(PAGES)};
  const order = PAGE_ORDER.length ? PAGE_ORDER : Array.from({ length: session.numPages }, (_, i) => i + 1);
  out.readOrder = order;
  for (const p of order) {
    const r = await session.renderPage(p, scale, { background: '#ffffff' });
    // exactly where \`ocrDocument\` reads today: the statement after \`renderPage\`
    const atSettle = ink(r.ctx, r.width, r.height);
    await r.finished;
    const afterFinished = ink(r.ctx, r.width, r.height);
    // C. and what the reader says about the awaited bitmap
    let read = null;
    try {
      const res = await engine.recognizeCanvas(r.canvas);
      read = { text: (res.text || '').slice(0, 240), lines: res.results.length };
    } catch (error) { read = { error: String(error && error.message || error) }; }
    out.pageInk.push({ page: p, px: r.width, h: r.height, atSettle, afterFinished, recognisedAfterAwait: read });
    r.cancel();
  }
  await session.destroy();
  return JSON.stringify(out);
})()`);

const parsed = JSON.parse(report);
console.log(`PDF: ${PDF}`);
console.log(JSON.stringify(parsed, null, 2));
console.log('console errors:', JSON.stringify([...new Set(errors)].slice(0, 4)));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
