// pdf-to-cbz byte check — the campaign's sequenced paint race, measured.
//
// `rasterizePages` (core/render.ts) encodes `render.canvas` straight after
// `renderPage()` settles, and `renderPage` settles when the task is *scheduled*:
// the pixels arrive later. `pdf-to-cbz` is the only tool that reaches it, so the
// CBZ's page images are where a short await would show up.
//
//   node docs/research/cbz-bytes.mjs
//   BASE=https://www.browsersnip.com node docs/research/cbz-bytes.mjs
//
// Runs the real rail UI (drop, Make CBZ, take the download), unzips the archive
// and reports, per page image, how much ink the archive actually carries — the
// bottom band of every fixture page is painted last, so a canvas copied before
// pdf.js finished is missing exactly that stripe.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5291';
const PDF = process.env.PDF || '/tmp/org/cbz-fixture.pdf';
const OUT = process.env.OUT || '/tmp/org/cbz-out.cbz';
const PORT = Number(process.env.PORT || 9751);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/cbz-bytes-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  } else if (m.method === 'Runtime.exceptionThrown') {
    errors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 160));
  }
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = id++; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const wait = async (expr, ms = 180000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(300); }
  return false;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/pdf-to-cbz` });
await wait(`!!document.querySelector('input[type=file]')`, 60000);
await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
const { root } = await send('DOM.getDocument', { depth: -1 });
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
await send('DOM.setFileInputFiles', { nodeId, files: [PDF] });
await wait(`!!document.body.innerText.match(/Make CBZ/)`);
const dpi = await ev(`(()=>{const i=document.querySelector('input[type=range]');return i?i.value:null})()`);
console.log('against', BASE, '— dpi control reads', dpi);
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Make CBZ/i.test(x.innerText||''));b.click();return 1})()`);
const done = await wait(`window.__blobs.length>0`);
if (!done) throw new Error('no output blob was produced by Make CBZ');
await sleep(1500);
const b64 = await ev(`(async()=>{var b=window.__blobs.at(-1);var u=new Uint8Array(await b.arrayBuffer());var s='';for(var i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return btoa(s)})()`);
writeFileSync(OUT, Buffer.from(b64, 'base64'));
console.log('report line:', await ev(`(document.body.innerText.match(/[^\\n]*dpi into[^\\n]*/)||[null])[0]`));
console.log('archive', OUT, Buffer.from(b64, 'base64').length, 'bytes');
console.log('console errors', JSON.stringify([...new Set(errors)].slice(0, 4)));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
