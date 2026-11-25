// organize — the typed plan, end to end: type a `pageOrder`, press Apply, press
// Save, and hand back the bytes the pane produced plus what the pane said.
//
//   BASE=http://localhost:5292 PORT=9842 PDF=/tmp/org/labels.pdf \
//     PLAN='4-6, 1' OUT=/tmp/org/plan.pdf SHOT=/tmp/org/plan.png \
//     node docs/research/organize-plan-export.mjs
//
// The campaign's other organize probes build the plan with gestures, which is
// right for the grid and wrong for the field: the notes tell the user they can
// type the plan themselves, so the field's own round trip — type it, Apply, and
// the file the Save button writes — has to be measured, not assumed. Every stage
// is read back out of the DOM before the next one is clicked: the field's value,
// the plan the grid paints from it, the status line the pane announced, and the
// refusal if the pane refused.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5292';
const PDF = process.env.PDF;
const PLAN = process.env.PLAN ?? '';
const APPLY = process.env.APPLY === '0' ? false : true;
// Thumbnails are still painting for a moment after the cards mount, and a Save
// pressed during that window is refused by the pane ("Rendering thumbnails…") —
// the probe has to wait like a user would, not conclude the pane is broken.
const SETTLE = Number(process.env.SETTLE || 8000);
const PORT = Number(process.env.PORT || 9842);
const OUT = process.env.OUT || '';
const SHOT = process.env.SHOT || '';
const DARK = process.env.DARK === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!PDF) throw new Error('PDF is required');

const profile = `/tmp/organize-plan-${PORT}-${Date.now()}`;
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
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
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.rej(new Error(JSON.stringify(m.error))); else p.res(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionDetails') errors.push((m.params.exceptionDetails.exception?.description || 'exception').slice(0, 200));
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = id++; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};
const wait = async (expr, ms = 120000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(`!!(${expr})`)) return true; } catch { /* not yet */ } await sleep(200); }
  return false;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable', { maxPostDataSize: 65536 }).catch(() => {});
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/organize` });
await wait(`!!document.querySelector('input[type=file]')`);
// DARK=1 paints the theme before the document loads; DARK=2 presses the header's
// own theme button once the grid holds content, which is the order a user does it
// in — and the only order that tells you whether the pane repaints its thumbnails.
if (DARK === '1') await ev(`(()=>{document.documentElement.classList.add('dark');try{localStorage.setItem('theme','dark')}catch{}return 1})()`);
// Every blob the tab makes, keyed by the URL it was handed out under, plus the
// anchor clicks: the last blob is not necessarily the one the user downloads (the
// result screen paints its preview after it), so the download is identified by the
// name on the anchor that carried it away.
await ev(`(()=>{window.__blobs=[];window.__urls=new Map();window.__files=[];
  const o=URL.createObjectURL.bind(URL);
  URL.createObjectURL=(b)=>{const u=o(b);window.__urls.set(u,b);window.__blobs.push(b);return u};
  const click=HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click=function(){if(this.download&&window.__urls.has(this.href)){window.__files.push([this.download,this.href]);return}return click.apply(this,arguments)};
  return 1})()`);
const { root } = await send('DOM.getDocument', { depth: -1 });
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
await send('DOM.setFileInputFiles', { nodeId, files: [PDF] });
await wait(`document.querySelectorAll('[data-plan-card]').length >= 1`);
await sleep(2500);

if (PLAN !== '') {
  const typed = await ev(`(()=>{const f=document.querySelector('#plan-order-field');if(!f)return null;
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    set.call(f,${JSON.stringify(PLAN)});
    f.dispatchEvent(new Event('input',{bubbles:true}));f.dispatchEvent(new Event('change',{bubbles:true}));return f.value})()`);
  console.log('field written', JSON.stringify(PLAN), 'read back', JSON.stringify(typed));
  if (APPLY) {
    console.log('apply clicked', await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^Apply$/.test((x.innerText||'').trim()));if(!b)return 'NO APPLY BUTTON';b.click();return 'apply'})()`));
    await sleep(800);
  }
}
const cards = JSON.parse(await ev(`(()=>JSON.stringify([...document.querySelectorAll('[data-plan-card]')].map(c=>{const l=c.getAttribute('aria-label')||'';
  return {n:c.getAttribute('data-plan-card'),item:l.startsWith('Blank')?'blank':('pg'+((l.match(/page (\\d+)/)||[])[1]||'?')),rot:(l.match(/rotated (\\d+) degrees/)||[])[1]||null}})))()`));
console.log('the grid now paints', cards.map((c) => c.item + (c.rot ? `@${c.rot}` : '')).join(' '));
console.log('status', await ev(`[...document.querySelectorAll('[aria-live]')].map(n=>n.textContent.trim()).join('|').slice(0,300)`));
console.log('input error', await ev(`(()=>{const p=[...document.querySelectorAll('p.text-danger, [role=alert]')];return p.map(n=>n.innerText.trim()).join(' | ')||null})()`));

await sleep(SETTLE);
if (DARK === '2') {
  console.log('theme button', await ev(`(()=>{const b=[...document.querySelectorAll('button')].find((x)=>/[☀☾]/u.test(x.innerText||''));if(!b)return 'NO BUTTON';b.click();return document.documentElement.classList.contains('dark')?'dark':'CLICK DID NOT STICK'})()`));
  await sleep(1500);
}
console.log('cards after settle', await ev(`document.querySelectorAll('[data-plan-card]').length`), '· painted', await ev(`(()=>[...document.querySelectorAll('[data-plan-card] img')].filter((i)=>i.naturalWidth).length)()`));
if (SHOT) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  mkdirSync(dirname(SHOT), { recursive: true });
  writeFileSync(SHOT, Buffer.from(data, 'base64'));
  console.log('screenshot:', SHOT);
}
console.log('the grid still paints', await ev(`(()=>JSON.stringify([...document.querySelectorAll('[data-plan-card]')].map(c=>{const l=c.getAttribute('aria-label')||'';return l.startsWith('Blank')?'blank':('pg'+((l.match(/page (\\d+)/)||[])[1]||'?'))})))()`));
console.log('field now holds', await ev(`(()=>{const f=document.querySelector('#plan-order-field');return f?f.value:null})()`));
console.log('save ready?', await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Save reordered PDF/.test(x.innerText||''));return b?!b.disabled:'no button'})()`));

const before = await ev('window.__blobs.length');
console.log('save button', await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Save reordered PDF/.test(x.innerText||''));if(!b)return 'NO BUTTON';if(b.disabled)return 'DISABLED: '+(b.title||'');b.click();return 'saved'})()`));
const got = await wait(`window.__blobs.length > ${before} || window.__files.length > 0`, 120000);
if (OUT && got) {
  // Prefer the blob that left through a download anchor; fall back to the last.
  const at = await ev(`(()=>{const f=window.__files.at(-1);if(!f)return window.__blobs.length-1;
    for(let i=window.__blobs.length-1;i>=0;i--)if(window.__urls.get(f[1])===window.__blobs[i])return i;return window.__blobs.length-1})()`);
  console.log('blob index', at, 'names', await ev(`(()=>JSON.stringify(window.__files.map(f=>f[0])))()`));
  const b64 = await ev(`(async()=>{var b=window.__blobs[${at}];var u=new Uint8Array(await b.arrayBuffer());var s='';for(var i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return btoa(s)})()`);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, Buffer.from(b64, 'base64'));
  console.log('export', JSON.stringify({ file: OUT, bytes: Buffer.from(b64, 'base64').length }));
} else {
  console.log('export', JSON.stringify({ captured: got, bytes: 0 }));
}
console.log('after save', await ev(`[...document.querySelectorAll('[aria-live]')].map(n=>n.textContent.trim()).join('|').slice(0,300)`));
console.log('console errors', JSON.stringify([...new Set(errors)].slice(0, 5)));
ws.close();
chrome.kill('SIGKILL');
await sleep(300);
spawn('rm', ['-rf', profile], { stdio: 'ignore' });
process.exit(0);
