// rail-tool byte probe — run one shipped tool in real Chromium against a live
// build and hand back the download, so the answer is measured in the file.
//
//   TOOL=pdf-to-greyscale PDF=/tmp/org/colour.pdf LABEL='Convert to greyscale' \
//     node docs/research/rail-tool-bytes.mjs
//   BASE=https://www.browsersnip.com TOOL=deskew PDF=/tmp/org/skewed.pdf \
//     LABEL='Deskew' node docs/research/rail-tool-bytes.mjs
//
// Reports the line the tool printed and the bytes it produced; what "correct"
// means for those bytes is the caller's question (see the paired .py checks).
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5291';
const TOOL = process.env.TOOL;
const PDF = process.env.PDF;
const LABEL = process.env.LABEL || '';
const OUT = process.env.OUT || `/tmp/rail-${TOOL}${LABEL ? '-inked' : ''}.pdf`;
const PORT = Number(process.env.PORT || 9761);
if (!TOOL || !PDF) throw new Error('TOOL and PDF are required');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/rail-${TOOL}-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
    errors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 200));
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
await send('Page.navigate', { url: `${BASE}/#/tool/${TOOL}` });
await wait(`!!document.querySelector('input[type=file]')`, 60000);
await ev(`(()=>{window.__blobs=[];window.__urls=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
const { root } = await send('DOM.getDocument', { depth: -1 });
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
await send('DOM.setFileInputFiles', { nodeId, files: [PDF] });
if (!(await wait(`(()=>{const re=new RegExp(${JSON.stringify(LABEL)},'i');return [...document.querySelectorAll('button')].some(b=>re.test(b.innerText||'')&&!b.disabled)})()`))) {
  throw new Error(`no enabled button matching ${LABEL} after loading ${PDF}`);
}
await ev(`(()=>{const re=new RegExp(${JSON.stringify(LABEL)},'i');const b=[...document.querySelectorAll('button')].find(x=>re.test(x.innerText||'')&&!x.disabled);b.click();return b.innerText.trim()})()`).then((t) => console.log('clicked', JSON.stringify(t)));
if (!(await wait('window.__blobs.length>0', 60000))) {
  // A refusal is an answer too: print what the rail says instead of a download,
  // so a tool that turns down a legitimate file is caught by this probe.
  const text = await ev(`(document.body.innerText || '').slice(0, 1600)`);
  console.log('NO OUTPUT — the screen says:', JSON.stringify(text));
  throw new Error('the tool produced no output blob');
}
await sleep(1200);
const info = JSON.parse(await ev(`(async()=>{var b=window.__blobs.at(-1);var u=new Uint8Array(await b.arrayBuffer());var s='';for(var i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return JSON.stringify({type:b.type,size:u.length,b64:btoa(s)})})()`));
writeFileSync(OUT, Buffer.from(info.b64, 'base64'));
console.log('output', JSON.stringify({ type: info.type, bytes: info.size, file: OUT }));
console.log('result screen:', await ev(`(document.body.innerText.match(/[^\\n]*(page|pages|greyscale|skew|correct|blank|render)[^\\n]*/gi)||[]).slice(0,6).join(' ;; ')`));
console.log('console errors', JSON.stringify([...new Set(errors)].slice(0, 3)));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
