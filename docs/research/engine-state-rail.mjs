// One engine-backed tool, one state, one real Chromium — the bytes it hands over,
// the words its card printed, and every request the tab made.
//
//   BASE=http://localhost:5295 TOOL=linearize-pdf LABEL='^Linearize$' \
//     PDF=/tmp/triage/colour.pdf PORT=9845 BLOCK=0 \
//     OUTDIR=/tmp/lane-optimize2/lin TAG=live-heavy FIELDS_JSON='{"part":"1b"}' \
//     SHOT=1 DARK=1 node docs/research/engine-state-rail.mjs
//
// Why a separate probe from `colour-rail.mjs`: an engine loader is a module
// singleton, so a tab that has already fetched Ghostscript answers the next run
// from memory. "Is the tool honest when the CDN is unreachable" is only a question
// you can ask a browser that has never seen the engine — hence one Chrome, one
// fresh profile, one state, per invocation. `BLOCK=1` both cuts the host through
// Chrome's own resolver (`MAP … 127.0.0.1:1`) and refuses the URL through CDP, so
// the failure is the network's and not the tool's.
//
// The download is taken the way a user takes it — press the card's own Download
// button and keep what goes through `downloadBlob` — and the ENGINE row, the
// sentence and the warnings are read out of the result card, not from the tool
// definition. Requests are summarised as: same-origin assets, off-origin GETs (the
// engine fetch) and, the thing that would be a defect, any POST/PUT of file bytes.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5295';
const TOOL = process.env.TOOL;
const LABEL = process.env.LABEL || '';
const PDF = process.env.PDF;
const PORT = Number(process.env.PORT || 9845);
const BLOCK = process.env.BLOCK === '1';
const OUTDIR = process.env.OUTDIR || '/tmp/lane-optimize2/out';
const TAG = process.env.TAG || 'run';
const FIELDS = process.env.FIELDS_JSON ? JSON.parse(process.env.FIELDS_JSON) : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!TOOL || !PDF) throw new Error('TOOL and PDF are required');

const args = [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/esr-${TOOL}-${PORT}`, 'about:blank',
];
if (BLOCK) args.push('--host-resolver-rules=MAP cdn.jsdelivr.net 127.0.0.1:1,MAP data.jsdelivr.com 127.0.0.1:1');
const chrome = spawn(CHROME, args, { stdio: 'ignore' });

let ws;
for (let i = 0; i < 80 && !ws; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch { /* chrome not up yet */ }
  if (!ws) await sleep(300);
}
if (!ws) throw new Error('chromium never answered');
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 1;
const pending = new Map();
const errors = [];
const net = [];
ws.onmessage = (raw) => {
  const m = JSON.parse(raw.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  } else if (m.method === 'Runtime.exceptionThrown') {
    errors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 200));
  } else if (m.method === 'Network.requestWillBeSent') {
    const r = m.params.request;
    net.push({ url: r.url, method: r.method, post: (r.postData || '').length, init: r.initiator?.type ?? '?' });
  }
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
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
const wait = async (expr, ms = 300000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await ev(expr)) return true; } catch { /* not yet */ }
    await sleep(400);
  }
  return false;
};

await send('Page.enable');
await send('Network.enable');
await send('Runtime.enable');
if (BLOCK) await send('Network.setBlockedURLs', { urls: ['*jsdelivr*'] });
await send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 1100, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/${TOOL}` });
if (!(await wait(`!!document.querySelector('input[type=file]')`, 90000))) throw new Error('no file input');
await ev(`(()=>{window.__blobs=[];window.__urls=new Map();window.__files=[];
  const o=URL.createObjectURL.bind(URL);
  URL.createObjectURL=(b)=>{const u=o(b);window.__urls.set(u,b);window.__blobs.push(b);return u};
  const c=HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click=function(){ if(this.download&&window.__urls.has(this.href)){window.__files.push([this.download,this.href]);return;} return c.apply(this,arguments); };
  return 1})()`);

const record = { tool: TOOL, tag: TAG, base: BASE, blocked: BLOCK, file: basename(PDF), fields: FIELDS, errors: [] };
const { root } = await send('DOM.getDocument', { depth: -1 });
const inputs = (await send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' })).nodeIds ?? [];
for (const nodeId of inputs) {
  if (!nodeId) continue;
  try { await send('DOM.setFileInputFiles', { nodeId, files: [PDF] }); } catch { continue; }
  if (await wait(`document.body.innerText.includes(${JSON.stringify(basename(PDF))})`, 20000)) break;
}
await sleep(600);

// Fields by the words the rail prints beside them; a control that is not there is
// recorded, because a run on defaults is not a run on the value the spec asked for.
record.readback = [];
for (const [label, want] of Object.entries(FIELDS)) {
  record.readback.push(await ev(`(()=>{
    const norm=(s)=>(s||'').replace(/\\s+/g,' ').trim().toLowerCase();
    const want=${JSON.stringify(String(label).toLowerCase())};
    const sel=[...document.querySelectorAll('select')].find((s)=>{const lab=s.closest('label')||document.querySelector('label[for="'+s.id+'"]');
      return norm((lab&&lab.innerText)||s.getAttribute('aria-label'))===want;});
    if(sel){const o=[...sel.options].find((x)=>norm(x.text).includes(norm(${JSON.stringify(String(want))})));
      if(!o) return 'NO OPTION '+want;
      const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
      set.call(sel,o.value); sel.dispatchEvent(new Event('input',{bubbles:true})); sel.dispatchEvent(new Event('change',{bubbles:true}));
      return 'set '+want+' -> '+o.text;}
    const box=[...document.querySelectorAll('label')].find((l)=>norm(l.innerText)===want&&l.querySelector('input[type=checkbox]'));
    if(box){const c=box.querySelector('input[type=checkbox]');const on=c.checked;
      const want1=['1','true','on','yes'].includes(norm(${JSON.stringify(String(want))}));
      if(on!==want1) c.click();
      return 'checkbox '+want1+' -> '+c.checked;}
    return 'NO CONTROL '+want;})()`));
}
await sleep(300);
if (process.env.DARK) {
  await ev(`(()=>{document.documentElement.classList.add('dark');try{localStorage.setItem('browsersnip:theme','dark')}catch{}return 1})()`);
}

const clicked = await ev(`(()=>{const b=document.querySelector('#tool-process-btn')||document.querySelector('button[data-run]');
  if(!b) return 'NO BUTTON'; if(b.disabled) return 'DISABLED'; const t=b.innerText.trim(); b.click(); return t;})()`);
record.pressed = clicked;
const finished = await wait(
  `!!document.querySelector('section[aria-label="Result"]') || !!document.querySelector('[role=alert]')`
  + ` || (()=>{const p=document.querySelector('[data-run-status]');return p&&p.getAttribute('data-run-status')!=='running'})()`,
  300000,
);
await sleep(1200);
record.card = await ev(`(document.querySelector('section[aria-label="Result"]')?.innerText||document.querySelector('[role=alert]')?.innerText||'')`);
record.rows = await ev(`[...document.querySelectorAll('section[aria-label="Result"] dt')].map((d)=>[d.textContent.trim(),(d.nextElementSibling?.textContent||'').trim()])`);
mkdirSync(OUTDIR, { recursive: true });
// The bytes are taken by pressing the card's own Download button, so what lands on
// disk is what a user's file manager would show.
record.download = await ev(`(()=>{
  const per=[...document.querySelectorAll('section[aria-label="Result"] button[aria-label^="Download "]')];
  if(per.length){per.forEach((b)=>b.click());return 'each:'+per.length;}
  const all=[...document.querySelectorAll('section[aria-label="Result"] button')].find((b)=>/^(Download|Download all)$/.test((b.innerText||'').trim()));
  if(all){all.click();return 'one';}
  return 'none';})()`);
await wait('window.__files.length > 0', 30000);
await sleep(1500);
if (process.env.SHOT) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUTDIR, `${TAG}${BLOCK ? '-blocked' : '-live'}${process.env.DARK ? '-dark' : ''}.png`), Buffer.from(shot.data, 'base64'));
}
const files = JSON.parse(await ev(`JSON.stringify(window.__files)`));
record.outputs = [];
for (const [name, href] of files) {
  const info = JSON.parse(await ev(`(async()=>{const b=window.__urls.get(${JSON.stringify(href)});if(!b)return JSON.stringify({missing:true});
    const u=new Uint8Array(await b.arrayBuffer());let s='';for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));
    return JSON.stringify({size:u.length,b64:btoa(s)})})()`));
  if (info.missing) continue;
  const path = join(OUTDIR, `${TAG}-${name}`);
  writeFileSync(path, Buffer.from(info.b64, 'base64'));
  record.outputs.push({ name, path, bytes: info.size });
}
const ORIGIN = new URL(BASE).origin;
const remote = net.filter((r) => { try { return new URL(r.url).origin !== ORIGIN && !r.url.startsWith('data:'); } catch { return false; } });
record.network = {
  total: net.length,
  offOrigin: remote.map((r) => `${r.method} ${r.url.slice(0, 120)}`),
  fileBytesPosted: net.filter((r) => r.method !== 'GET' && r.post > 200).map((r) => `${r.method} ${r.url.slice(0, 90)} ${r.post}B`),
};
record.errors = [...new Set(errors)].slice(0, 4);
record.finished = finished;
console.log(JSON.stringify(record, null, 1));
writeFileSync(join(OUTDIR, `${TAG}.json`), JSON.stringify(record, null, 1) + "\n");
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
