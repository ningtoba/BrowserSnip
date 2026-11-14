// alternate-merge round probe — load the two documents, write the Pattern select
// the way a user's event reaches React, read it back out of the DOM, run the tool,
// and hand back the download plus a screenshot of the pane holding the files and of
// the result card.
//
//   PORT=9820 FILES='/tmp/triage/colour.pdf /tmp/triage/sheets.pdf' \
//     PATTERN='1-1' OUT=/tmp/alt/base.pdf SHOT_PANE=/tmp/alt/base-pane.png \
//     SHOT_RESULT=/tmp/alt/base-card.png node docs/research/alternate-merge-round.mjs
//
//   ... PATTERN='reverse-alternate' REORDER='Move sheets.pdf earlier' OUT=...
//
//   ... REORDER='Move sheets.pdf earlier' OUT=...        (file order control)
//
//   PORT=9821 FILES='/tmp/triage/colour.pdf' EXPECT=refusal   (one file)
//   PORT=9822 FILES='/tmp/triage/zero.pdf /tmp/triage/colour.pdf' EXPECT=refusal
//
// Every control is written the way the user's event reaches React and read back out
// of the DOM before the click, so a select wired to the form and not to the code is
// caught by the read-back rather than assumed away. A refusal is an answer: with
// EXPECT=refusal the probe prints the sentence and the buttons instead of demanding
// bytes.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const TOOL = process.env.TOOL || 'alternate-merge';
const FILES = (process.env.FILES || '').split(/\s+/).filter(Boolean);
const OUT = process.env.OUT || '';
const SHOT_PANE = process.env.SHOT_PANE || '';
const SHOT_RESULT = process.env.SHOT_RESULT || '';
const EXPECT = process.env.EXPECT || 'file';
const DARK = process.env.DARK === '1';
const PORT = Number(process.env.PORT || 9820);
const REORDER = (process.env.REORDER || '').split('|').filter(Boolean);
const PATTERN = process.env.PATTERN || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!FILES.length) throw new Error('FILES is required');

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/alt-${PORT}-${Date.now()}`, 'about:blank'], { stdio: 'ignore' });
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
// Counting is asynchronous and starts a beat after the drop, so "not counting right
// now" is not the same as settled: wait for the pane to read settled three polls in
// a row, or the screenshot catches a row still READING.
let settled = 0;
for (let i = 0; i < 150 && settled < 3; i++) {
  const busy = await ev(`/counting pages|READING/.test(document.body.innerText)`);
  settled = busy ? 0 : settled + 1;
  await sleep(200);
}
await sleep(600);

const tray = async () => JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('ol[aria-label="Files in this job"] li')].map((li)=>li.querySelector('p[data-file-name]')?.getAttribute('title')))`));
console.log('tray before reorder:', JSON.stringify(await tray()));

for (const label of REORDER) {
  const clicked = await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')===${JSON.stringify(label)});if(!b) return 'MISSING';if(b.disabled) return 'DISABLED';b.click();return b.getAttribute('aria-label')})()`);
  console.log('reorder click:', JSON.stringify(clicked));
  await sleep(500);
  if (clicked === 'MISSING' || clicked === 'DISABLED') throw new Error(`reorder ${label}: ${clicked}`);
}
console.log('tray after reorder:', JSON.stringify(await tray()));

if (PATTERN) {
  const readback = await ev(`(()=>{
    const s=document.querySelector('#tool-field-pattern');
    if(!s) return 'NO CONTROL';
    const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
    set.call(s,${JSON.stringify(PATTERN)});
    s.dispatchEvent(new Event('input',{bubbles:true}));
    s.dispatchEvent(new Event('change',{bubbles:true}));
    const opt=s.selectedOptions[0];
    return s.value+' | '+(opt?opt.textContent.trim():'')})()`);
  console.log('pattern readback:', JSON.stringify(readback));
  if (!String(readback).startsWith(PATTERN)) throw new Error(`pattern did not take: ${readback}`);
  await sleep(400);
}

// Is the run button reachable, and what does the pane still want?
const screenBefore = JSON.parse(await ev(`JSON.stringify({
  run: (()=>{const b=document.querySelector('#tool-process-btn');return b?{text:b.innerText.trim(),disabled:b.disabled}:null})(),
  still: [...document.querySelectorAll('*')].map((n)=>n.children.length===0?n.textContent:'').filter((t)=>/still needed/i.test(t)).join(' ').slice(0,200),
})`));
console.log('before run:', JSON.stringify(screenBefore));
await shot(SHOT_PANE);
if (EXPECT === 'refusal') {
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
  run: (()=>{const b=document.querySelector('#tool-process-btn');return b?{text:b.innerText.trim(),disabled:b.disabled}:null})(),
  buttons: [...document.querySelectorAll('button')].map((b)=>[b.innerText.trim().slice(0,40),!b.disabled]).filter(([t])=>t),
})`));
console.log('finished:', finished, 'screen:', JSON.stringify({ alert: screen.alert, result: screen.result, run: screen.run, buttons: screen.buttons.slice(0, 14) }, null, 1));
await shot(SHOT_RESULT);
if (!finished) throw new Error('timed out: no card, no alert, no blob');
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
const outDir = OUT ? dirname(OUT) : '/tmp/alt';
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
