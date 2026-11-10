// cbz-to-pdf `Page size`, run against a deployed build and read back by another tool.
//
// The ledger's CONTROL INERT row 1 was measured in the browser, so the fix has to be
// re-measured there: same rail, same drop, same Run button — and then the boxes come
// out of the downloaded PDF through a reader that is not this app's own code
// (`docs/research/cbz-page-size-boxes.py`, pymupdf/pypdf).
//
//   node docs/research/cbz-page-size-proof.mjs
//   BASE=https://www.browsersnip.com SIZES=a4,a5 node docs/research/cbz-page-size-proof.mjs
//
// Each size writes OUT-<size>.pdf and prints the result card's own line, so the
// sentence and the geometry can be compared against each other rather than one
// standing in for the other.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5291';
const CBZ = process.env.CBZ || '/tmp/org/inert-photos.cbz';
const OUT = process.env.OUT || '/tmp/org/cbz-page-size';
const SIZES = (process.env.SIZES || 'fit,a4,letter,a5').split(',').map((s) => s.trim()).filter(Boolean);
const PORT = Number(process.env.PORT || 9761);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/cbz-page-size-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
const wait = async (expr, ms = 120000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(300); }
  return false;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
mkdirSync(OUT, { recursive: true });

// Which build is this? The fix names its hug choice in the rail, so the string is the
// version stamp — checked before any run is believed.
const bundle = await (await fetch(`${BASE}/`, { cache: 'no-store' })).text();
const entry = /src="(\/?[^\"]*index[^\"]*\.js)"/.exec(bundle)?.[1] ?? '';
const assetBase = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/') + 1) : 'assets/';
console.log('entry script', entry);

const PICK = `(()=>{const l=[...document.querySelectorAll('label[for]')].find(x=>/^\\s*page size\\b/i.test(x.textContent||''));return l?document.getElementById(l.getAttribute('for')):null})()`;

/** Back to the intake, the way the result screen offers it. */
async function startOver() {
  const again = await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Do another/i.test(x.innerText||''));if(b){b.click();return true}return false})()`);
  if (again) await sleep(900);
  await ev(`(()=>{window.__blobs=[];return 1})()`);
}

async function dropArchive() {
  if (!await wait(`!!document.querySelector('input[type=file]')`, 60000)) throw new Error('no file input on the intake');
  const { root } = await send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  if (!nodeId) throw new Error('the file input could not be addressed');
  await send('DOM.setFileInputFiles', { nodeId, files: [CBZ] });
  if (!await wait(`!![...document.querySelectorAll('button')].find(b=>/Create PDF/i.test(b.innerText||''))`, 60000)) {
    throw new Error('the rail never offered its Create PDF action');
  }
}

await send('Page.navigate', { url: `${BASE}/#/tool/cbz-to-pdf` });
await sleep(2500);
await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
await dropArchive();

const choices = await ev(`(()=>{const select=${PICK};
  return select?{value:select.value,options:[...select.options].map(o=>o.value+':'+o.textContent)}:null;
})()`);
console.log('rail Page size', JSON.stringify(choices));
if (!choices) throw new Error('no Page size select on the rail — this is not the surface the row accused');

for (const size of SIZES) {
  await startOver();
  await dropArchive();
  const wrote = await ev(`(()=>{
    const select=${PICK};
    if(!select||![...select.options].some(o=>o.value===${JSON.stringify(size)})) return false;
    const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
    setter.call(select,${JSON.stringify(size)});
    select.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  })()`);
  if (!wrote) { console.log(`  ${size}: not an option on this build`); continue; }
  await sleep(500);
  const readBack = await ev(`(()=>{const select=${PICK};return select?select.value:null})()`);
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Create PDF/i.test(x.innerText||''));b.click();return 1})()`);
  if (!await wait('window.__blobs.length>0', 120000)) throw new Error(`${size}: no output blob`);
  await sleep(1200);
  const b64 = await ev(`(async()=>{var b=window.__blobs.at(-1);var u=new Uint8Array(await b.arrayBuffer());var s='';for(var i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return btoa(s)})()`);
  const bytes = Buffer.from(b64, 'base64');
  const file = `${OUT}-${size}.pdf`;
  writeFileSync(file, bytes);
  const card = await ev(`(()=>{const m=document.body.innerText.match(/[^\\n]*comic pages[^\\n]*/);return m?m[0]:null})()`);
  console.log(`  ${size} (read back ${readBack}) → ${file.split('/').pop()} ${bytes.length} bytes  card: ${card}`);
}

console.log('console errors', JSON.stringify([...new Set(errors)].slice(0, 4)));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
