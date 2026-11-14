// remove-pages round probe — load one document into the Delete Pages pane, type
// the sheet list the way a user's event reaches React, read it back out of the
// DOM, run it, and hand back the download plus a screenshot of the pane and of
// whatever the run answered.
//
//   PORT=9830 PDF=/tmp/triage/colour.pdf PAGES=2 OUT=/tmp/rp/drop2.pdf \
//     SHOT_PANE=/tmp/rp/drop2-pane.png SHOT_RESULT=/tmp/rp/drop2-card.png \
//     node docs/research/remove-pages-round.mjs
//
//   PORT=9830 PDF=/tmp/triage/colour.pdf CHIP=all EXPECT=refusal \
//     SHOT_PANE=/tmp/rp/all-pane.png node docs/research/remove-pages-round.mjs
//
//   PORT=9830 PDF=/tmp/triage/colour.pdf PAGES=9 EXPECT=disabled \
//     SHOT_PANE=/tmp/rp/oob-pane.png node docs/research/remove-pages-round.mjs
//
//   PORT=9830 PDF=/tmp/triage/in/bookmarked.pdf PAGES=4 DARK=1 \
//     OUT=/tmp/rp/book-dark.pdf SHOT_RESULT=/tmp/rp/book-dark.png
//
// The read-back is checked before the click: a run whose field did not take is
// the probe's fault, not the tool's. A refusal is an answer — EXPECT=refusal
// prints the sentence and the pane's own words instead of demanding bytes, and
// EXPECT=disabled records the disabled run button with the reason under it.
//
// The panes it takes are judged with the eye first and then by
// `docs/research/remove-pages-bytes.py` on the file the card's own Download
// button produced, against the same measurement of the source.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const TOOL = 'remove-pages';
const PDF = process.env.PDF;
const PAGES = process.env.PAGES ?? null;
const CHIP = process.env.CHIP || '';
const OUT = process.env.OUT || '';
const SHOT_PANE = process.env.SHOT_PANE || '';
const SHOT_RESULT = process.env.SHOT_RESULT || '';
const EXPECT = process.env.EXPECT || 'file';
const DARK = process.env.DARK === '1';
const PORT = Number(process.env.PORT || 9830);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!PDF) throw new Error('PDF is required');

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/rp-${PORT}-${Date.now()}`, 'about:blank'], { stdio: 'ignore' });
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
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = id++;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(`${method} unanswered`)); } }, 30000);
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
const shot = async (path) => {
  if (!path) return null;
  mkdirSync(dirname(path), { recursive: true });
  const out = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path, Buffer.from(out.data, 'base64'));
  console.log('screenshot:', path);
  return path;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/${TOOL}` });
if (!(await wait(`document.readyState==='complete' && !!document.querySelector('input[type=file]')`, 60000))) {
  throw new Error('route did not mount a file input');
}
if (DARK) {
  await ev(`(()=>{document.documentElement.classList.add('dark');try{localStorage.setItem('theme','dark')}catch{}return 1})()`);
  await sleep(400);
}
await ev(`(()=>{
  window.__blobs=[]; window.__urls=new Map(); window.__files=[];
  const o=URL.createObjectURL.bind(URL);
  URL.createObjectURL=(b)=>{const u=o(b); window.__urls.set(u,b); window.__blobs.push(b); return u};
  const click=HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click=function(){
    if(this.download && window.__urls.has(this.href)){ window.__files.push([this.download,this.href]); return; }
    return click.apply(this,arguments);
  };
  return 1})()`);

const { root } = await send('DOM.getDocument', { depth: -1 });
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
await send('DOM.setFileInputFiles', { nodeId, files: [PDF] });
if (!(await wait(`document.body.innerText.includes(${JSON.stringify(basename(PDF))})`, 30000))) {
  throw new Error(`the pane never acknowledged ${basename(PDF)}`);
}
// The picker resolves the file itself before it renders the counted field, so
// wait for the strip to stop saying "counting" and for the field to exist.
await wait(`!/counting pages/i.test(document.body.innerText)`, 30000);
if (!(await wait(`!!document.querySelector('label[for]')`, 30000))) throw new Error('the pages field never mounted');
await sleep(500);

const FIELD = `(()=>{const l=[...document.querySelectorAll('label[for]')].find((x)=>/^pages$/i.test(x.innerText.trim()));return l?document.getElementById(l.getAttribute('for')):null})()`;
const describe = `(()=>{
  const f=${FIELD};
  const strip=document.querySelector('p.font-mono');
  return JSON.stringify({
    value: f?f.value:null,
    counter: strip?strip.innerText.trim():null,
    problem: [...document.querySelectorAll('p.text-danger')].map((p)=>p.innerText.trim()),
    run: (()=>{const b=document.querySelector('#tool-process-btn');return b?{text:b.innerText.trim(),disabled:b.disabled}:null})(),
  })})()`;
if (!(await ev(`!!${FIELD}`))) throw new Error('no Pages field');

// A tile clicked in the strip, the way a pointer picks a sheet.
for (const tile of (process.env.TILE || '').split('|').filter(Boolean)) {
  const got = await ev(`(()=>{const b=[...document.querySelectorAll('button[aria-label]')].find((x)=>/^Page \\d+$/.test(x.getAttribute('aria-label')||''));const want=document.querySelector('button[aria-label="Page ${tile}"]');
    if(!want) return 'MISSING'; want.click(); return 'clicked page ${tile} pressed=' + want.getAttribute('aria-pressed')})()`);
  console.log('tile', tile, '->', got);
  await sleep(300);
}
for (const chip of CHIP.split('|').filter(Boolean)) {
  const got = await ev(`(()=>{const b=[...document.querySelectorAll('button')].find((x)=>x.innerText.trim().toLowerCase()===${JSON.stringify(chip.toLowerCase())});if(!b) return 'MISSING';b.click();return 'clicked'})()`);
  console.log('chip', chip, '->', got);
  await sleep(300);
}
if (PAGES !== null) {
  const wrote = await ev(`(()=>{const f=${FIELD};
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    set.call(f,${JSON.stringify(PAGES)});
    f.dispatchEvent(new Event('input',{bubbles:true})); f.dispatchEvent(new Event('change',{bubbles:true})); return f.value})()`);
  await sleep(400);
  const read = JSON.parse(await ev(describe));
  console.log('field written', JSON.stringify(wrote), 'read back', JSON.stringify(read.value));
  if (read.value !== PAGES) throw new Error(`read-back ${JSON.stringify(read.value)} !== ${JSON.stringify(PAGES)}`);
}
const pane = JSON.parse(await ev(describe));
console.log('pane:', JSON.stringify(pane, null, 1));
await shot(SHOT_PANE);

if (EXPECT === 'disabled') {
  console.log('refused before the run:', JSON.stringify(pane.problem));
  console.log('console errors:', JSON.stringify([...new Set(errors)].slice(0, 3)));
  ws.close(); chrome.kill('SIGKILL'); process.exit(0);
}

const blobsBefore = await ev(`window.__blobs.length`);
const clicked = await ev(`(()=>{const b=document.querySelector('#tool-process-btn');if(!b) return 'NO BUTTON';if(b.disabled) return 'DISABLED';b.click();return b.innerText.trim()})()`);
console.log('run button:', JSON.stringify(clicked));
const finished = await wait(
  `!!document.querySelector('section[aria-label="Result"]') || !!document.querySelector('[role=alert]') || window.__blobs.length>${blobsBefore}`,
  clicked === 'DISABLED' ? 8000 : 240000,
);
await sleep(1200);
const screen = JSON.parse(await ev(`JSON.stringify({
  alert: document.querySelector('[role=alert]')?.innerText?.trim() ?? null,
  result: document.querySelector('section[aria-label="Result"]')?.innerText?.trim() ?? null,
  surfaceText: (document.querySelector('[data-surface]')?.innerText || '').slice(0, 1500),
})`));
console.log('finished:', finished, 'alert:', JSON.stringify(screen.alert));
console.log('card:', JSON.stringify(screen.result));
await shot(SHOT_RESULT);
if (!finished) {
  console.log('surfaceText:', JSON.stringify(screen.surfaceText));
  if (EXPECT === 'refusal') { ws.close(); chrome.kill('SIGKILL'); process.exit(0); }
  throw new Error('timed out: no card, no alert, no blob');
}
if (EXPECT === 'refusal' || (screen.alert && !screen.result)) {
  console.log('REFUSED —', JSON.stringify(screen.alert));
  console.log('console errors:', JSON.stringify([...new Set(errors)].slice(0, 3)));
  ws.close(); chrome.kill('SIGKILL'); process.exit(0);
}

const dl = await ev(`(()=>{
  const per=[...document.querySelectorAll('section[aria-label="Result"] button[aria-label^="Download "]')];
  if(per.length){per.forEach((b)=>b.click()); return 'each:'+per.length;}
  const all=[...document.querySelectorAll('section[aria-label="Result"] button')].find((b)=>/^(Download|Download all)$/.test((b.innerText||'').trim()));
  if(all){all.click(); return 'one';}
  return 'none';})()`);
await wait(`window.__files.length>0`, 20000);
await sleep(1200);
const named = JSON.parse(await ev(`JSON.stringify(window.__files)`));
console.log('downloads:', JSON.stringify({ how: dl, names: named.map(([n]) => n) }));
const outDir = OUT ? dirname(OUT) : '/tmp/rp';
mkdirSync(outDir, { recursive: true });
for (const [name, href] of named) {
  const info = JSON.parse(await ev(`(async()=>{const b=window.__urls.get(${JSON.stringify(href)});if(!b) return JSON.stringify({missing:true});
    const u=new Uint8Array(await b.arrayBuffer());let s='';for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));
    return JSON.stringify({size:u.length,b64:btoa(s)})})()`));
  if (info.missing) { console.log('missing blob for', name); continue; }
  const path = named.length === 1 && OUT ? OUT : `${outDir}/${name.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
  writeFileSync(path, Buffer.from(info.b64, 'base64'));
  console.log('saved', path, info.size, 'bytes');
}
console.log('console errors:', JSON.stringify([...new Set(errors)].slice(0, 3)));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
