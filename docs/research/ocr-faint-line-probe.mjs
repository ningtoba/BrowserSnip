// preprocessForOcr, measured on nearly-uniform sheets — does the contrast
// stretch lose a faint line, or a uniform page?
//
//   BASE=http://localhost:5271 node docs/research/ocr-faint-line-probe.mjs
//
// `src/lib/ocr/engine.ts` stretch-maps every page between its own darkest and
// lightest pixel before the recogniser sees it. Two cases can go wrong where a
// normal scan cannot: a page that is *nearly* uniform (one faint line — the
// stretch has almost no range to work with) and a page that is *exactly*
// uniform (min == max, the divisor `|| 1` keeps it, and every pixel lands on 0).
//
// Each case is a canvas this probe paints, so the tones are exact and the words
// are known. Per case it records the raw tone span, the preprocessed span, how
// many pixels of the line's own box are still ink after preprocessing, and what
// the shipped `recognizeCanvas` answers when handed the raw canvas (it
// preprocesses internally — that is the path the tool takes). `line-180` is the
// control: a clear line that must be read, or the instrument is broken.
import { spawn } from 'node:child_process';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const PORT = Number(process.env.PORT || 9823);
const OUT = process.env.OUT || '/tmp/ocr046/faint-line-probe.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/ocr-faint-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
  setTimeout(() => {
    if (pending.has(i)) { pending.delete(i); rej(new Error(`${method} #${i} unanswered`)); }
  }, 30000);
});
const ev = async (expr) => {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result?.value;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  throw lastError;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/ocr-pdf` });
for (let i = 0; i < 120; i++) {
  try { if (await ev(`document.readyState === 'complete'`)) break; } catch { /* not yet */ }
  await sleep(250);
}

const report = await ev(`(async () => {
  const W = 1000, H = 1414;
  const LINE = { x: 60, y: 300, w: 880, h: 120 };
  const WORD = 'Lighthouse Inventory 1887';
  const paint = (paper, inkTone, jitter) => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const cx = c.getContext('2d');
    cx.fillStyle = 'rgb(' + paper + ',' + paper + ',' + paper + ')';
    cx.fillRect(0, 0, W, H);
    if (inkTone !== null) {
      cx.fillStyle = 'rgb(' + inkTone + ',' + inkTone + ',' + inkTone + ')';
      cx.font = 'bold 64px sans-serif';
      cx.textBaseline = 'middle';
      cx.fillText(WORD, LINE.x, LINE.y + LINE.h / 2);
    }
    if (jitter) {
      // Sensor noise on a blank sheet: every pixel a level or two either way.
      const img = cx.getImageData(0, 0, W, H);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const tone = Math.max(0, Math.min(255, paper + Math.round((Math.random() * 2 - 1) * jitter)));
        d[i] = tone; d[i + 1] = tone; d[i + 2] = tone;
      }
      cx.putImageData(img, 0, 0);
    }
    return c;
  };
  const stats = (cx, w, h, inkCut) => {
    const d = cx.getImageData(0, 0, w, h).data;
    let min = 255, max = 0, mean = 0, inked = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (l < min) min = l;
      if (l > max) max = l;
      mean += l; n += 1;
      if (l < inkCut) inked += 1;
    }
    return { min, max, span: max - min, mean: +(mean / n).toFixed(2), inked, of: n, pct: +(100 * inked / n).toFixed(3) };
  };
  // How much of the line's own box survived: raw pixels off the paper tone, and
  // preprocessed pixels in the ink half of the new scale.
  const boxInk = (cx, cut) => {
    const d = cx.getImageData(LINE.x, LINE.y, LINE.w, LINE.h).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (l < cut) n += 1;
    }
    return { px: n, of: (LINE.w * LINE.h), pct: +(100 * n / (LINE.w * LINE.h)).toFixed(3) };
  };
  const engine = await import('/src/lib/ocr/engine.ts');
  const out = { word: WORD, steps: [] };
  try { await engine.initOcr(); out.status = engine.getOcrStatus().status; }
  catch (error) { out.initError = String(error && error.message || error); return JSON.stringify(out); }

  const CASES = [
    { name: 'uniform-white', paper: 255, ink: null },
    { name: 'uniform-grey-200', paper: 200, ink: null },
    { name: 'blank-noise-2', paper: 252, ink: null, jitter: 2 },
    { name: 'blank-noise-8', paper: 250, ink: null, jitter: 8 },
    { name: 'blank-rare-speck', paper: 255, ink: null, speck: 225 },
    { name: 'faint-250', paper: 255, ink: 250 },
    { name: 'faint-240', paper: 255, ink: 240 },
    { name: 'faint-225', paper: 255, ink: 225 },
    { name: 'line-180-control', paper: 255, ink: 180 },
    { name: 'grey-paper-line-190', paper: 210, ink: 190 },
  ];
  for (const c of CASES) {
    const canvas = paint(c.paper, c.ink, c.jitter);
    if (c.speck) {
      // One stray mark on an otherwise clean sheet: 0.02 % of the pixels.
      const scx = canvas.getContext('2d');
      scx.fillStyle = 'rgb(' + c.speck + ',' + c.speck + ',' + c.speck + ')';
      for (let i = 0; i < 260; i++) scx.fillRect(Math.random() * W, Math.random() * H, 3, 3);
    }
    const rawCtx = canvas.getContext('2d');
    const before = stats(rawCtx, W, H, c.paper - 12);
    const beforeBox = c.ink === null ? null : boxInk(rawCtx, c.paper - 12);
    const processed = engine.preprocessForOcr(canvas);
    const pctx = processed.getContext('2d');
    const after = stats(pctx, W, H, 128);
    const afterBox = c.ink === null ? null : boxInk(pctx, 128);
    let read;
    try {
      const res = await engine.recognizeCanvas(canvas);
      read = { text: (res.text || '').trim().slice(0, 120), lines: res.results.length };
    } catch (error) { read = { error: String(error && error.message || error) }; }
    out.steps.push({ name: c.name, jitter: c.jitter ?? 0, specks: c.speck ?? null, raw: before, beforeBox, processed: after, afterBox, read });
    processed.width = 0; processed.height = 0;
  }
  return JSON.stringify(out);
})()`);

const parsed = JSON.parse(report);
console.log(JSON.stringify(parsed, null, 2));
console.log('console errors:', JSON.stringify([...new Set(errors)].slice(0, 4)));
const { writeFileSync } = await import('node:fs');
writeFileSync(OUT, `${JSON.stringify(parsed, null, 2)}\n`);
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
