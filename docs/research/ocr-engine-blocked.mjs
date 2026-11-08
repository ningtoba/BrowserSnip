// ocr-pdf with the reader cut off — the live proof of the "engine unavailable"
// branch, so the sentence is measured rather than asserted only in a unit test.
//
//   PDF=/tmp/ocr/scanned.pdf node docs/research/ocr-engine-blocked.mjs
//
// The models are fetched on first use from `media.githubusercontent.com` /
// `raw.githubusercontent.com`, and onnxruntime-web's wasm from jsdelivr. Blocking
// all three is what "offline, or a blocked CDN" means for this tool. A fresh tab
// is required: the engine is a module singleton, so a tab that already loaded it
// would answer from memory and prove nothing.
//
// The assertion is about wording: the run must name the reader, say the file was
// **not read**, and say what would fix it — and must not say anything about the
// pages, which it never looked at.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5291';
const PDF = process.env.PDF || '/tmp/ocr/scanned.pdf';
const OUT = process.env.OUT || '/tmp/ocr/engine-blocked.txt';
const PORT = Number(process.env.PORT || 9795);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/ocr-blocked-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
const wait = async (expr, ms = 240000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(300); }
  return false;
};

await send('Page.enable');
await send('Network.enable');
await send('Runtime.enable');
await send('Network.setBlockedURLs', {
  urls: [
    '*media.githubusercontent.com*',
    '*raw.githubusercontent.com*',
    '*cdn.jsdelivr.net*',
  ],
});
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/ocr-pdf` });
if (!(await wait(`document.readyState === 'complete' && !!document.querySelector('input[type=file]')`, 90000))) {
  throw new Error('no file input on the route');
}
await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
const { root } = await send('DOM.getDocument', { depth: -1 });
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
await send('DOM.setFileInputFiles', { nodeId, files: [PDF] });
await sleep(1500);

const clicked = await ev(`(()=>{const b=document.querySelector('button[data-run]');if(!b||b.disabled)return 'NO BUTTON';const label=b.innerText.trim();b.click();return label})()`);
if (clicked === 'NO BUTTON') throw new Error('the run button is missing or disabled');
if (!(await wait(`(()=>{const p=document.querySelector('[data-run-status]');return p&&p.getAttribute('data-run-status')!=='running'})()`, 240000))) {
  throw new Error('the run never reported a finished phase');
}
await sleep(1200);
const body = await ev(`(document.body.innerText||'')`);
writeFileSync(OUT, body);
const said = (body.match(/[^\n]*(recogniser|OCR|read|blank|recognised)[^\n]*/gi) ?? []).slice(-8);
console.log('PDF:', PDF);
console.log('clicked:', JSON.stringify(clicked));
console.log('blobs (downloads):', await ev(`window.__blobs.length`));
console.log('the screen says:');
for (const line of said) console.log('  ', line.trim());
console.log('artifact:', OUT);
console.log('console errors:', JSON.stringify([...new Set(errors)].slice(0, 3)));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
