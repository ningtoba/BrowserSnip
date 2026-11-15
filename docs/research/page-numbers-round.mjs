// page-numbers round probe — load a document, set the rail's own controls the way
// a user's event reaches React, read them back out of the DOM, run the tool, then
// *show the page the folio was asked for* in the result preview and hand back the
// download plus a screenshot of the pane.
//
//   PORT=9831 PDF=/tmp/triage/colour.pdf FIELDS='Pages=4 Font size=48' \
//     SHOW=4 OUT=/tmp/pn/big.pdf SHOT=/tmp/pn/big.png \
//     node docs/research/page-numbers-round.mjs
//
// The batch driver (`colour-rail.mjs`) always leaves the preview on page 1 of the
// result, which is the one page a `pages=4` run did *not* number — so the screen
// half of this round needed a probe whose last act is picking the page. `SHOW`
// clicks the output strip's own chip (`button[aria-label="Page 4, …"]`), which is
// what a person does to look at a folio.
//
// The read-back is checked before the click: a run whose field did not take is
// the probe's fault, not the tool's. The panes are judged with the eye and the
// file by `docs/research/page-numbers-place.py`.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const TOOL = 'page-numbers';
const PDF = process.env.PDF;
const FIELDS = process.env.FIELDS || '';
const SHOW = process.env.SHOW || '';
const OUT = process.env.OUT || '';
const SHOT = process.env.SHOT || '';
const DARK = process.env.DARK === '1';
const PORT = Number(process.env.PORT || 9831);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!PDF) throw new Error('PDF is required');

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/pn-${PORT}-${Date.now()}`, 'about:blank'], { stdio: 'ignore' });
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
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(`${method} unanswered`)); } }, 30000);
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const wait = async (expr, ms = 150000) => {
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
  await sleep(500);
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
await sleep(600);
// The rail folds everything but its lead field behind "N more options".
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/more option/i.test(x.innerText||''));if(b)b.click();return !!b})()`);
await sleep(400);

/** The control the rail prints `label` beside, by the same words. */
const AT = (label) => `(()=>{const want=${JSON.stringify(String(label).toLowerCase())};
  const norm=(s)=>(s||'').replace(/\\s+/g,' ').trim().toLowerCase();
  const lab=[...document.querySelectorAll('label[for]')].find((l)=>norm(l.innerText)===want);
  return lab?document.getElementById(lab.getAttribute('for')):null})()`;

const applied = [];
for (const pair of FIELDS.split(/\s+/).filter(Boolean)) {
  const at = pair.indexOf('=');
  const label = pair.slice(0, at).replace(/_/g, ' ');
  const value = pair.slice(at + 1).replace(/_/g, ' ');
  const kind = await ev(`(()=>{const c=${AT(label)};return c?c.tagName:'NONE'})()`);
  if (kind === 'NONE') throw new Error(`the rail has no "${label}" control`);
  await ev(`(()=>{const c=${AT(label)};
    const proto = c.tagName==='SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const set=Object.getOwnPropertyDescriptor(proto,'value').set;
    const want=${JSON.stringify(value)};
    set.call(c, c.tagName==='SELECT' ? ([...c.options].find((o)=>o.value===want||o.text.toLowerCase().includes(want.toLowerCase()))||{}).value ?? want : want);
    c.dispatchEvent(new Event('input',{bubbles:true})); c.dispatchEvent(new Event('change',{bubbles:true})); return 1})()`);
  await sleep(150);
  const back = await ev(`(()=>{const c=${AT(label)};return c?c.value:'NONE'})()`);
  if (back !== value && back.toLowerCase() !== value.toLowerCase()) {
    throw new Error(`read-back ${JSON.stringify(back)} !== ${JSON.stringify(value)} for "${label}"`);
  }
  applied.push(`${label}=${back}`);
}
console.log('fields:', JSON.stringify(applied));

const blobsBefore = await ev(`window.__blobs.length`);
const clicked = await ev(`(()=>{const b=document.querySelector('#tool-process-btn');if(!b) return 'NO BUTTON';if(b.disabled) return 'DISABLED';b.click();return b.innerText.trim()})()`);
console.log('run button:', JSON.stringify(clicked));
const finished = await wait(
  `!!document.querySelector('section[aria-label="Result"]') || !!document.querySelector('[role=alert]') || window.__blobs.length>${blobsBefore}`,
  150000,
);
await sleep(1500);
const screen = JSON.parse(await ev(`JSON.stringify({
  alert: document.querySelector('[role=alert]')?.innerText?.trim() ?? null,
  result: document.querySelector('section[aria-label="Result"]')?.innerText?.trim() ?? null,
})`));
console.log('finished:', finished, 'alert:', JSON.stringify(screen.alert));
console.log('card:', JSON.stringify(screen.result));
if (!finished) throw new Error('timed out: no card, no alert, no blob');

// Look at the page the folio was asked for, by pressing that chip in the output
// strip — the preview opens on page 1, which a `pages=4` run did not touch.
if (SHOW) {
  const picked = await ev(`(()=>{
    const chip=[...document.querySelectorAll('button[aria-label]')]
      .find((b)=>/^Page ${SHOW}(,|$)/.test(b.getAttribute('aria-label')||''));
    if(!chip) return 'MISSING';
    chip.click(); return chip.getAttribute('aria-label')})()`);
  console.log('preview page:', JSON.stringify(picked));
  await sleep(1800);
  console.log('caption:', JSON.stringify(await ev(`document.querySelector('[data-preview-caption]')?.innerText?.trim() ?? null`)));
}
await shot(SHOT);

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
const outDir = OUT ? dirname(OUT) : '/tmp/pn';
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
