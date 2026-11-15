// digitize-document round — three photos of known content into one run, so the
// "the recogniser found nothing to write on it" sentence is measured on a blank
// sheet *and* on an inked sheet with no letters, side by side, in one file.
//
//   BASE=http://localhost:5271 DIR=/tmp/ocr046 PORT=9822 \
//     node docs/research/ocr-digitize-round.mjs
//
// The three inputs are renders of the same fixture `ocr-round-trip.mjs` plants:
// page 1 (six lines of copy), page 2 (a gradient — 35 % ink, no letters), page 3
// (empty paper). Sheet 1 must come back with words, sheet 2 must be told apart
// from sheet 3 by the ink the tool itself measured, and sheet 3 must be called
// blank rather than folded into one sentence about "found nothing".
//
// Artifacts, in DIR: `digitize.json` (the run's phase, the warnings painted on
// the card with the header's own count, the message, console errors),
// `digitize-screen.txt` and `digitize.png`.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const DIR = process.env.DIR || '/tmp/ocr046';
const PORT = Number(process.env.PORT || 9822);
const FILES = ['page-letters.png', 'page-gradient.png', 'page-block.png', 'page-blank.png'].map((n) => `${DIR}/${n}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/ocr-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
  if (m.id && pending.has(m.id)) {
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
    if (pending.has(i)) {
      pending.delete(i);
      rej(new Error(`${method} #${i} unanswered`));
    }
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
const wait = async (expr, ms = 150000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(300); }
  return false;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1600, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/` });
await sleep(600);
await send('Page.navigate', { url: `${BASE}/#/tool/digitize-document` });
if (!(await wait(`document.readyState === 'complete' && !!document.querySelector('input[type=file]')`, 90000))) {
  throw new Error('no file input');
}
await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);

const { root } = await send('DOM.getDocument', { depth: -1 });
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
await send('DOM.setFileInputFiles', { nodeId, files: FILES });
const named = await wait(`(document.body.innerText||'').includes('page-blank.png')`, 30000);
if (!named) throw new Error('the rail did not take the three photos');
console.log('attached:', FILES.map((f) => f.split('/').pop()).join(', '));

const clicked = await ev(`(()=>{const b=document.querySelector('button[data-run]');if(!b||b.disabled)return 'NO BUTTON';const l=b.innerText.trim();b.click();return l})()`);
if (clicked === 'NO BUTTON') throw new Error('run button missing or disabled');
const done = await wait(`(()=>{const p=document.querySelector('[data-run-status]');return p&&p.getAttribute('data-run-status')!=='running'})()`, 240000);
const status = await ev(`document.querySelector('[data-run-status]')?.getAttribute('data-run-status')`);
await sleep(800);
const text = await ev(`document.body.innerText||''`);
writeFileSync(`${DIR}/digitize-screen.txt`, text);
await ev(`(()=>{const el=document.querySelector('[data-result]')||document.scrollingElement;el.scrollTop=el.scrollHeight;return 1})()`);
await sleep(300);
const image = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(`${DIR}/digitize.png`, Buffer.from(image.data, 'base64'));

// The unselected field controls are read back too: an empty run over the wrong
// file would otherwise read like a defect in the tool.
const card = await ev(`(()=>{
  const bullets=[...document.querySelectorAll('[data-result-warnings] li')].map(li=>li.textContent.trim());
  const heads=[...document.querySelectorAll('[data-result-warnings] p')].map(p=>p.textContent.trim());
  const out=document.querySelector('[aria-label=Result]');
  return JSON.stringify({heads,bullets,output:out?.querySelector('[data-output-name]')?.textContent?.trim()??null});
})()`);
writeFileSync(`${DIR}/digitize.json`, JSON.stringify({
  clicked, status, done, card: JSON.parse(card), console: [...new Set(errors)].slice(0, 5),
}, null, 2));
console.log(`clicked ${JSON.stringify(clicked)} → phase ${status}, finished ${done}`);
console.log('card:', card);
console.log('screen tail:', JSON.stringify(text.slice(-1200)));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
