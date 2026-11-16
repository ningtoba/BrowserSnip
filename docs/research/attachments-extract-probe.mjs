// extract-attachments probe — one foreign attachment shape per run, in real Chromium.
//
//   TOOL=extract-attachments PDF=tests/fixtures/attachments/af-only.pdf \
//     LABEL='Extract attachments' OUT=/tmp/r/att-af.out PORT=9841 \
//     SHOT=/tmp/r/att-af.png node docs/research/attachments-extract-probe.mjs
//
// Prints the card's own sentence, the download NAME the browser would use, and
// every blob the tool created (base64, so the caller can hash the real bytes).
// A shape with no attachment is not a failure: a report is printed as a refusal.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const TOOL = process.env.TOOL || 'extract-attachments';
const PDF = process.env.PDF;
const LABEL = process.env.LABEL || 'Extract attachments';
const OUT = process.env.OUT || '/tmp/r/att.out';
const SHOT = process.env.SHOT || '';
const PORT = Number(process.env.PORT || 9841);
// `DARK=1` presses the app's own theme toggle before the upload, so the shot is the
// real dark surface and not an emulated `prefers-color-scheme`.
const DARK = process.env.DARK === '1';
if (!PDF) throw new Error('PDF is required');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/att-probe-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
    errors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 240));
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
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(250); }
  return false;
};
const shoot = async (path) => {
  await sleep(600);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path, Buffer.from(data, 'base64'));
  console.log('screenshot:', path);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/${TOOL}` });
await wait(`!!document.querySelector('input[type=file]')`, 60000);
if (DARK) {
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^Dark mode$/i.test(x.getAttribute('title')||''));b&&b.click();return !!b})()`);
  await sleep(300);
}
// `downloadBlob` makes the name only at click time and revokes the URL at once,
// so the anchor click is hooked and the revoke is made a no-op: the name the
// browser would have saved under is recorded, not guessed from the card copy.
await ev(`(()=>{window.__blobs=[];window.__names=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};URL.revokeObjectURL=()=>{};HTMLAnchorElement.prototype.click=function(){window.__names.push(this.getAttribute('download'));};return 1})()`);
const { root } = await send('DOM.getDocument', { depth: -1 });
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
await send('DOM.setFileInputFiles', { nodeId, files: [PDF] });
// `data-surface=ready` is the page's own answer that the file is read and the
// action is live; a click during `reading` runs against a 0-byte drop.
if (!(await wait(`(()=>{const s=document.querySelector('[data-surface]');const re=new RegExp(${JSON.stringify(LABEL)},'i');return s&&s.dataset.surface==='ready'&&[...document.querySelectorAll('button')].some(b=>re.test(b.innerText||'')&&!b.disabled)})()`))) {
  throw new Error(`no ready surface with an enabled button matching ${LABEL} after loading ${PDF}`);
}
await ev(`(()=>{const re=new RegExp(${JSON.stringify(LABEL)},'i');const b=[...document.querySelectorAll('button')].find(x=>re.test(x.innerText||'')&&!x.disabled);b.click();return 1})()`);
// Done = a blob, or a report card with no blob, or a refusal sentence.
await wait(`window.__blobs.length>0 || !!document.querySelector('[class*=result]')`, 60000);
await sleep(1500);

// Press Download so the produced name is captured, then report.
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^Download$/i.test((x.innerText||'').trim()));b&&b.click();return 1})()`);
await sleep(400);
const report = await ev(`(()=>{
  const body = (document.body.innerText||'').replace(/\\n{2,}/g,'\\n');
  const links = window.__names;
  const buttons = [...document.querySelectorAll('button')].map(b=>(b.innerText||'').trim()).filter(Boolean).slice(0,20);
  return JSON.stringify({ body: body.slice(0, 2200), downloadNames: links, buttons });
})()`);
const blobs = JSON.parse(await ev(`(async()=>{const out=[];for(const b of window.__blobs){const u=new Uint8Array(await b.arrayBuffer());let s='';for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));out.push({type:b.type,size:u.length,b64:btoa(s)})}return JSON.stringify(out)})()`));
writeFileSync(OUT, JSON.stringify({ pdf: PDF, ...JSON.parse(report), blobs }));
if (SHOT) await shoot(SHOT);
console.log('result:', report);
console.log('blobs:', JSON.stringify(blobs.map((b) => ({ type: b.type, size: b.size }))));
console.log('out:', OUT);
console.log('console errors', JSON.stringify([...new Set(errors)].slice(0, 3)));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
