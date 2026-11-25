// `validate-signature-pdf` on a live build: run it on a file, keep a screenshot
// and the report text.
//
// The tool is report-only (no blob), so `rail-probe.mjs` — which waits for a
// download — cannot drive it. It also has no field: the whole job is "drop the
// file, press Validate signatures", which is exactly what this does.
//
//   BASE=http://localhost:5271 PDF=/tmp/r/val-tampered.pdf SHOT=/tmp/r/x.png \
//     PORT=9830 node docs/research/validate-signature-probe.mjs
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const PDF = process.env.PDF;
const SHOT = process.env.SHOT || '';
const PORT = Number(process.env.PORT || 9830);
const TAG = process.env.TAG || 'validate-signature';
const DARK = process.env.DARK === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!PDF) throw new Error('PDF is required');

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/val-${PORT}`, 'about:blank'], { stdio: 'ignore' });
let ws;
for (let i = 0; i < 60 && !ws; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch { /* chrome booting */ }
  await sleep(300);
}
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 1;
const pending = new Map();
ws.onmessage = (raw) => {
  const m = JSON.parse(raw.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = id++;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const wait = async (expr, ms = 180000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(200); }
  return false;
};

await send('Page.enable');
await send('Runtime.enable');
// The network half: a report tool should ask nothing of the world. Every request
// from here on is recorded with its method and upload size.
const net = [];
const originalOnMessage = ws.onmessage;
ws.onmessage = (raw) => {
  try {
    const m = JSON.parse(raw.data);
    if (m.method === 'Fetch.requestPaused') {
      const req = m.params.request;
      net.push(`${req.method} ${req.url}${req.postData ? ` (${new TextEncoder().encode(req.postData).length} B up)` : ''}`);
      send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
    }
  } catch { /* not ours */ }
  originalOnMessage?.(raw);
};
await send('Fetch.enable', { patterns: [{ requestStage: 'Request' }] });
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/validate-signature-pdf` });
if (!(await wait(`!!document.querySelector('input[type=file]')`, 60000))) throw new Error('no file input');
if (DARK) {
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^Dark mode$/i.test(x.getAttribute('title')||''));b&&b.click();return !!b})()`);
  await sleep(300);
}
await ev(`(()=>{window.__seen=0;return 1})()`);
const { root } = await send('DOM.getDocument', { depth: -1 });
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
await send('DOM.setFileInputFiles', { nodeId, files: [PDF] });
if (!(await wait(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^validate signatures$/i.test((x.innerText||'').trim())&&!x.disabled);return !!b})()`, 60000))) {
  throw new Error('the validate button never enabled for ' + PDF);
}
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^validate signatures$/i.test((x.innerText||'').trim())&&!x.disabled);b.click();return 1})()`);
// The report replaces the rail; wait for a verdict row or the "no signature" line.
if (!(await wait(`/Byte range intact|no digital signature field|signature field exists but|this file is encrypted|Encrypted —|signature field is empty|not registered in the document form/i.test(document.body.innerText||'')`, 120000))) {
  console.log('NO REPORT — screen:', JSON.stringify((await ev('document.body.innerText') || '').slice(0, 2000)));
  throw new Error('no report rendered');
}
await sleep(600);
const text = await ev('document.body.innerText') || '';
writeFileSync(`/tmp/r/${TAG}.screen.txt`, text);
if (SHOT) {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
}
const start = text.indexOf('Digital signatures');
console.log('REPORT:', JSON.stringify(text.slice(start >= 0 ? start : 0, (start >= 0 ? start : 0) + 2200)));
const origin = new URL(BASE).origin;
const notable = net.filter((line) => !line.startsWith('GET ' + origin) && !line.startsWith('GET data:') && !line.startsWith('GET blob:'));
console.log(`NETWORK: ${net.length} request(s); non-same-origin-or-any-upload: ${notable.length === 0 ? 'none' : JSON.stringify(notable)}`);
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
