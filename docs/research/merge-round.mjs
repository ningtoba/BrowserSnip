// merge round probe — load two documents into the merge rail, drive its tray
// order and its two toggles, run it, and hand back the download plus a
// screenshot of the pane holding the files and of the result card.
//
//   PORT=9810 FILES='/tmp/triage/colour.pdf /tmp/triage/sheets.pdf' \
//     OUT=/tmp/merge/base.pdf SHOT_PANE=/tmp/merge/base-pane.png \
//     SHOT_RESULT=/tmp/merge/base-card.png node docs/research/merge-round.mjs
//
//   PORT=9810 FILES='/tmp/triage/colour.pdf /tmp/triage/sheets.pdf' \
//     REORDER='Move sheets.pdf earlier' OUT=/tmp/merge/swapped.pdf \
//     node docs/research/merge-round.mjs
//
//   PORT=9810 FILES='/tmp/triage/colour.pdf' EXPECT=refusal \
//     node docs/research/merge-round.mjs
//
// Every field is written the way a user's event reaches React and read back out
// of the DOM before the run, so a rail that ignores a toggle is caught by the
// read-back rather than assumed away. A refusal is an answer: with EXPECT=refusal
// the probe prints the sentence and the buttons instead of demanding bytes.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const TOOL = process.env.TOOL || 'merge';
const FILES = (process.env.FILES || '').split(/\s+/).filter(Boolean);
const OUT = process.env.OUT || '';
const SHOT_PANE = process.env.SHOT_PANE || '';
const SHOT_RESULT = process.env.SHOT_RESULT || '';
const EXPECT = process.env.EXPECT || 'file';
const DARK = process.env.DARK === '1';
const PORT = Number(process.env.PORT || 9810);
const REORDER = (process.env.REORDER || '').split('|').filter(Boolean);
const WANTED = (process.env.FIELDS || '')
  .split(/\s+/)
  .filter(Boolean)
  .map((pair) => {
    const at = pair.indexOf('=');
    return [pair.slice(0, at), pair.slice(at + 1)];
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!FILES.length) throw new Error('FILES is required');

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/merge-${PORT}-${Date.now()}`, 'about:blank'], { stdio: 'ignore' });
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
await send('DOM.setFileInputFiles', { nodeId, files: FILES });
for (const file of FILES) {
  const acked = await wait(`document.body.innerText.includes(${JSON.stringify(basename(file))})`, 20000);
  if (!acked) throw new Error(`the pane never acknowledged ${basename(file)}`);
}
await wait(`!/counting pages/.test(document.body.innerText)`, 30000);
await sleep(600);

// A shared secret typed on the row that carries the lock, the way a user types it.
const PASS = process.env.PASS || '';
if (PASS) {
  const typed = await ev(`(()=>{const c=document.querySelector('input[aria-label^="Open password for "]');if(!c) return 'NO BOX';
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    set.call(c,${JSON.stringify(PASS)}); c.dispatchEvent(new Event('input',{bubbles:true})); c.dispatchEvent(new Event('change',{bubbles:true})); return c.value})()`);
  console.log('password typed:', JSON.stringify(typed));
  await sleep(2500);
  console.log('lock after typing:', await ev(`(document.querySelector('input[aria-label^="Open password for "]')?.closest('li').innerText || '').match(/READY|LOCKED|WRONG|NEEDS/i)?.[0] ?? 'none'`));
}

const tray = async () => JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('ol[aria-label="Files in this job"] li')].map((li)=>li.querySelector('p[data-file-name]')?.getAttribute('title')))`));
console.log('tray before reorder:', JSON.stringify(await tray()));

for (const label of REORDER) {
  const clicked = await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')===${JSON.stringify(label)});if(!b) return 'MISSING';if(b.disabled) return 'DISABLED';b.click();return b.getAttribute('aria-label')})()`);
  console.log('reorder click:', JSON.stringify(clicked));
  await sleep(500);
  if (clicked === 'MISSING' || clicked === 'DISABLED') throw new Error(`reorder ${label}: ${clicked}`);
}
console.log('tray after reorder:', JSON.stringify(await tray()));

await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/more option/i.test(x.innerText||''));if(b)b.click();return !!b})()`);
await sleep(300);

const readback = [];
for (const [key, want] of WANTED) {
  const r = await ev(`(()=>{
    const norm=(s)=>(s||'').replace(/\\s+/g,' ').trim().toLowerCase();
    const lab=[...document.querySelectorAll('label')].find((l)=>l.querySelector('input[type=checkbox]') && norm(l.innerText).includes(${JSON.stringify(key.toLowerCase())}));
    if(!lab) return 'NO CONTROL';
    const box=lab.querySelector('input[type=checkbox]');
    const on = ${JSON.stringify(want)} === '1' || ${JSON.stringify(want)} === 'true';
    if(box.checked!==on) box.click();
    return box.checked ? 'checked' : 'unchecked';})()`);
  readback.push(`${key}=${want} -> ${r}`);
  await sleep(250);
}
console.log('readback:', JSON.stringify(readback, null, 1));
await shot(SHOT_PANE);

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
  surface: document.querySelector('[data-surface]')?.getAttribute('data-surface') ?? null,
  surfaceText: (document.querySelector('[data-surface]')?.innerText || '').slice(0, 1500),
  run: (()=>{const b=document.querySelector('#tool-process-btn');return b?{text:b.innerText.trim(),disabled:b.disabled}:null})(),
  buttons: [...document.querySelectorAll('button')].map((b)=>[b.innerText.trim().slice(0,40),!b.disabled]).filter(([t])=>t),
})`));
console.log('finished:', finished, 'screen:', JSON.stringify({ alert: screen.alert, result: screen.result, run: screen.run, buttons: screen.buttons.slice(0, 14) }, null, 1));
await shot(SHOT_RESULT);
if (!finished) {
  console.log('surfaceText:', JSON.stringify(screen.surfaceText));
  if (EXPECT === 'refusal') { ws.close(); chrome.kill('SIGKILL'); process.exit(0); }
  throw new Error('timed out: no card, no alert, no blob');
}

if (EXPECT === 'refusal') {
  console.log('console errors:', JSON.stringify([...new Set(errors)].slice(0, 3)));
  ws.close(); chrome.kill('SIGKILL'); process.exit(0);
}
if (screen.alert && !screen.result) {
  console.log('REFUSED —', JSON.stringify(screen.alert));
  console.log('console errors:', JSON.stringify([...new Set(errors)].slice(0, 3)));
  ws.close(); chrome.kill('SIGKILL'); process.exit(0);
}

// Take the download the way a user takes it.
const dl = await ev(`(()=>{
  const per=[...document.querySelectorAll('section[aria-label="Result"] button[aria-label^="Download "]')];
  if(per.length){per.forEach((b)=>b.click()); return 'each:'+per.length;}
  const all=[...document.querySelectorAll('section[aria-label="Result"] button')].find((b)=>/^(Download|Download all)$/.test((b.innerText||'').trim()));
  if(all){all.click(); return 'one';}
  return 'none';})()`);
await wait(`window.__files.length>0`, 20000);
await sleep(1500);
const named = JSON.parse(await ev(`JSON.stringify(window.__files)`));
console.log('downloads:', JSON.stringify({ how: dl, names: named.map(([n]) => n) }));
const outDir = OUT ? dirname(OUT) : '/tmp/merge';
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
