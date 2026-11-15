// font-to-outline with the engine's CDN cut — the live proof of the refusal, so
// the sentence is measured on a screen and not only asserted in a unit test.
//
//   BASE=http://localhost:5271 PDF=/tmp/triage/in/doc.pdf \
//     node docs/research/font-outline-blocked.mjs
//
// The Ghostscript WASM build is fetched from `cdn.jsdelivr.net` the first time the
// tool runs, and a fresh tab is required: the engine is a module singleton, so a
// tab that had already loaded it would answer from memory and prove nothing.
//
// Three things are asked of the screen: it must name **Ghostscript**, it must say
// **nothing was outlined** (no silent fallback that leaves the text and calls it
// done), and it must hand over no file. The screenshot is kept so the refusal can
// be read as a person sees it.
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const PDF = process.env.PDF || '/tmp/triage/in/doc.pdf';
const OUT = process.env.OUT || '/tmp/r29/blocked.txt';
const SHOT = process.env.SHOT || '/tmp/r29/blocked.png';
const PORT = Number(process.env.PORT || 9835);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/fo-blocked-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
const wait = async (expr, ms = 150000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(300); }
  return false;
};

await send('Page.enable');
await send('Network.enable');
await send('Runtime.enable');
// The engine's only host. Blocking it is what "offline, or a blocked CDN" means.
await send('Network.setBlockedURLs', { urls: ['*cdn.jsdelivr.net*'] });
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/font-to-outline` });
if (!(await wait(`document.readyState === 'complete' && !!document.querySelector('input[type=file]')`, 90000))) {
  throw new Error('no file input on the route');
}
await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
const { root } = await send('DOM.getDocument', { depth: -1 });
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
await send('DOM.setFileInputFiles', { nodeId, files: [PDF] });
await sleep(1500);

const clicked = await ev(`(()=>{const b=[...document.querySelectorAll('button')].find((x)=>(x.innerText||'').trim()==='Outline');if(!b)return 'NO BUTTON';if(b.disabled)return 'DISABLED';b.click();return 'clicked'})()`);
console.log('clicked:', clicked);
await wait(`(()=>{const p=document.querySelector('[data-run-status]');return p&&p.getAttribute('data-run-status')!=='running'})()`, 150000);
await sleep(1200);
const body = await ev(`(document.body.innerText||'')`);
writeFileSync(OUT, body);
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
const pdfBlobs = await ev(`window.__blobs.filter((b)=>b.type==='application/pdf').length`);
const rows = [
  ['names Ghostscript', /Ghostscript/i.test(body)],
  ['says nothing was outlined', /nothing was outlined/i.test(body)],
  ['says it could not be reached', /could not be reached/i.test(body)],
  ['sends the user to a connection, not settings', /online/i.test(body)],
  ['offers Rasterize PDF as the way round it', /Rasterize PDF/i.test(body)],
  ['no silent fallback file', pdfBlobs === 0],
];
console.log('PDF:', PDF);
for (const [row, ok] of rows) console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${row}`);
console.log('body:', OUT, '| screenshot:', SHOT, '| pdf blobs:', pdfBlobs);
console.log('console errors:', JSON.stringify([...new Set(errors)].slice(0, 3)));
ws.close();
chrome.kill('SIGKILL');
process.exit(rows.every(([, ok]) => ok) ? 0 : 1);
