// reverse-pages pane probe — the screen half of this round.
//
// `rail-tool-bytes.mjs` shoots nothing before the click and `colour-rail.mjs` only
// shoots the result card, but this tool's pane is where the copy and the preview
// live, so both ends are photographed here, the pane **holding real content** and
// the card after the run. The download is taken the way the user takes it (the
// card's own Download button) so the file judged by PyMuPDF is the file the
// screen offered.
//
//   BASE=http://localhost:5271 PDF=/tmp/triage/colour.pdf \
//     PRE=/tmp/r/pane-before.png SHOT=/tmp/r/pane-after.png \
//     OUT=/tmp/r/pane-before.pdf PORT=9831 node docs/research/reverse-pages-pane.mjs
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const TOOL = process.env.TOOL || 'reverse-pages';
const PDF = process.env.PDF || '/tmp/triage/colour.pdf';
const OUT = process.env.OUT || `/tmp/r/${TOOL}.pdf`;
const PRE = process.env.PRE || '';
const SHOT = process.env.SHOT || '';
const PORT = Number(process.env.PORT || 9831);
const DARK = process.env.DARK === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/pane-${TOOL}-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
const shot = async (path) => {
  if (!path) return;
  const png = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path, Buffer.from(png.data, 'base64'));
  console.log('screenshot:', path);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/${TOOL}` });
await wait(`document.readyState === 'complete' && !!document.querySelector('input[type=file]')`, 90000);
if (DARK) {
  await ev(`(()=>{localStorage.setItem('browsersnip:theme','dark');document.documentElement.classList.add('dark');document.documentElement.dataset.theme='dark';return 1})()`);
  await send('Page.reload');
  await wait(`document.readyState === 'complete' && !!document.querySelector('input[type=file]')`, 90000);
}
await ev(`(()=>{window.__blobs=[];window.__urls=new Map();window.__files=[];
  const o=URL.createObjectURL.bind(URL);
  URL.createObjectURL=(b)=>{const u=o(b);window.__urls.set(u,b);window.__blobs.push(b);return u};
  const click=HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click=function(){ if(this.download&&window.__urls.has(this.href)){window.__files.push([this.download,this.href]);return;} return click.apply(this,arguments)};
  return 1})()`);
{
  const { root } = await send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId, files: [PDF] });
}
// The app acknowledging the file by name is what says the upload landed.
if (!(await wait(`document.body.innerText.includes(${JSON.stringify(basename(PDF))})`, 30000))) {
  throw new Error(`the app never acknowledged ${PDF}`);
}
await sleep(2500);
if (process.env.EXPAND === '1') {
  // The notes are folded behind a disclosure; a copy pass has to read them.
  await ev(`(()=>{const b=[...document.querySelectorAll('button,summary')].find((x)=>/honest notes/i.test(x.innerText||''));if(b)b.click();return !!b})()`);
  await sleep(600);
  console.log('notes:', JSON.stringify(await ev(`(document.body.innerText.match(/HONEST NOTES[\s\S]{0,1400}/)||[''])[0]`)));
}
await shot(PRE);
console.log('pane text:', JSON.stringify(await ev(`(document.querySelector('[data-surface],form,main')?.innerText || document.body.innerText).slice(0, 2600)`)));
console.log('pane headings/notes:', JSON.stringify(await ev(`JSON.stringify({
  theme: getComputedStyle(document.body).backgroundColor,
  headings: [...document.querySelectorAll('h1,h2,h3')].map((h)=>h.innerText.trim()).slice(0,10),
  strip: [...document.querySelectorAll('[data-page-thumb],[data-preview-pages]')].length,
  tiles: [...document.querySelectorAll('[data-page-thumb]')].map((t)=>t.getAttribute('aria-label')||t.innerText.trim()).slice(0,10),
  counts: [...document.querySelectorAll('[data-selection-count],[data-pane-count]')].map((c)=>c.innerText.trim()),
})`)));
const clicked = await ev(`(()=>{const b=document.querySelector('#tool-process-btn')||[...document.querySelectorAll('button')].find((x)=>/^reverse$/i.test((x.innerText||'').trim()));
  if(!b) return 'NO BUTTON'; if(b.disabled) return 'DISABLED'; b.click(); return 'click: '+b.innerText.trim();})()`);
console.log('run:', clicked);
if (!(await wait(`!!document.querySelector('section[aria-label="Result"]') || window.__blobs.length>0`, 120000))) {
  console.log('NO OUTPUT — the screen says:', JSON.stringify(await ev(`(document.body.innerText||'').slice(0,1600)`)));
  throw new Error('no output');
}
await sleep(1500);
await shot(SHOT);
const card = await ev(`(()=>{const c=document.querySelector('section[aria-label="Result"]');return c?c.innerText:''})()`);
console.log('card:', JSON.stringify(card));
await ev(`(()=>{const b=[...document.querySelectorAll('section[aria-label="Result"] button')].find((x)=>/^Download$/.test((x.innerText||'').trim()));if(b)b.click();return !!b})()`);
await wait('window.__files.length>0', 20000);
await sleep(500);
const href = await ev(`(window.__files[0]||[])[1] || ''`);
if (href) {
  const info = JSON.parse(await ev(`(async()=>{const b=window.__urls.get(${JSON.stringify(href)});const u=new Uint8Array(await b.arrayBuffer());let s='';for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return JSON.stringify({size:u.length,b64:btoa(s)})})()`));
  writeFileSync(OUT, Buffer.from(info.b64, 'base64'));
  console.log('output', JSON.stringify({ bytes: info.size, file: OUT }));
} else {
  console.log('no download button on the card');
}
console.log('console errors:', JSON.stringify([...new Set(errors)].slice(0, 3)));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
