// poster-round — drive `posterize` in real Chromium, write every field the way a
// user's event reaches React, read it back out of the DOM, take the tile file and
// two screenshots (card before, pane after).
//
//   BASE=http://localhost:5271 PDF=/tmp/triage/colour.pdf \
//     FIELDS_JSON='{"Tiles across":3,"Tiles down":2,"Overlap for trimming":0,"Pages":"1"}' \
//     OUT=/tmp/poster/t-a.pdf SHOT=/tmp/poster/s-a.png PORT=9831 \
//     node docs/research/poster-round.mjs
//
// `colour-rail.mjs` takes FIELDS as whitespace-separated pairs, so a label with a
// space in it ("Tiles across") cannot be addressed by its own words there; this
// probe takes a JSON object keyed by the exact label the rail prints, resolved by
// the same `label[for]` walk, and refuses the run when the read-back disagrees.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const PDF = process.env.PDF || '/tmp/triage/colour.pdf';
const OUT = process.env.OUT || '/tmp/poster/tiles.pdf';
const SHOT = process.env.SHOT || '';
const BEFORE = process.env.SHOT_BEFORE || '';
const PORT = Number(process.env.PORT || 9831);
const TIMEOUT = Number(process.env.RUN_TIMEOUT || 120000);
const FIELDS = JSON.parse(process.env.FIELDS_JSON || '{}');
const DARK = process.env.DARK === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(dirname(OUT), { recursive: true });
if (SHOT) mkdirSync(dirname(SHOT), { recursive: true });

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/poster-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
  setTimeout(() => {
    if (pending.has(i)) {
      pending.delete(i);
      rej(new Error(`${method} #${i} unanswered: ${JSON.stringify(params).slice(0, 120)}`));
    }
  }, 30000);
});
const ev = async (expr) => {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result?.value;
    } catch (error) {
      last = error;
      await sleep(500);
    }
  }
  throw last;
};
const wait = async (expr, ms = TIMEOUT) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(200); }
  return false;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });

/** The control a person finds by the words beside it: a `label[for]` and its input. */
const CONTROL = (label) => `(()=>{
  const want=${JSON.stringify(String(label).toLowerCase())};
  const norm=(s)=>(s||'').replace(/\\s+/g,' ').trim().toLowerCase();
  const lab=[...document.querySelectorAll('label[for]')].find((l)=>norm(l.innerText)===want);
  const el=lab?document.getElementById(lab.getAttribute('for')):null;
  if(!el) return JSON.stringify({kind:'none'});
  return JSON.stringify({kind:'input',id:el.id,type:el.type,value:el.value,min:el.min,max:el.max});
})()`;
const describe = async (label) => JSON.parse(await ev(CONTROL(label)));

/** Write the value, read it back, and refuse the run when the read-back differs. */
async function setField(label, raw) {
  const before = await describe(label);
  if (before.kind === 'none') return { label, ok: false, before: 'NO CONTROL', after: 'NO CONTROL' };
  const numeric = before.type === 'range' || before.type === 'number';
  const written = numeric ? JSON.stringify(Number(raw)) : JSON.stringify(String(raw));
  await ev(`(()=>{const c=document.getElementById(${JSON.stringify(before.id)});
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    set.call(c,${written});
    c.dispatchEvent(new Event('input',{bubbles:true}));c.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`);
  await sleep(250);
  const after = await describe(label);
  const want = numeric ? String(Number(raw)) : String(raw);
  return { label, want, before: `${before.type}=${before.value}`, after: `${after.type}=${after.value}`, ok: after.value === want };
}

await send('Page.navigate', { url: `${BASE}/#/tool/posterize` });
if (!(await wait(`document.readyState === 'complete' && !!document.querySelector('input[type=file]')`, 90000))) {
  throw new Error('no file input on the route');
}
// Every produced file, caught by name: the result card's Download runs
// `downloadBlob`, which makes an object URL and clicks an <a download=…>.
await ev(`(()=>{window.__blobs=[];window.__urls=new Map();window.__files=[];
  const o=URL.createObjectURL.bind(URL);
  URL.createObjectURL=(b)=>{const u=o(b); window.__urls.set(u,b); window.__blobs.push(b); return u};
  const click=HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click=function(){
    if(this.download && window.__urls.has(this.href)){window.__files.push([this.download,this.href]);return}
    return click.apply(this,arguments)};
  return 1})()`);
{
  const { root } = await send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId, files: [PDF] });
}
if (!(await wait(`document.body.innerText.length > 0`, 30000))) throw new Error('loading text never appeared');
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/more option/i.test(x.innerText||''));if(b)b.click();return !!b})()`);
await sleep(400);
if (DARK) await ev(`(()=>{document.documentElement.classList.add('dark');try{localStorage.setItem('theme','dark')}catch{}return 1})()`);
if (BEFORE) {
  await sleep(500);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(BEFORE, Buffer.from(shot.data, 'base64'));
  console.log('shot-before:', BEFORE);
}

const applied = [];
let mismatch = null;
for (const [label, raw] of Object.entries(FIELDS)) {
  const result = await setField(label, raw);
  applied.push(result);
  if (!result.ok) mismatch = result;
}
console.log('fields:', JSON.stringify(applied.map((a) => `${a.label}: "${a.before}" -> "${a.after}"${a.ok ? '' : ' MISMATCH'}`), null, 1));
if (mismatch) throw new Error(`read-back disagreed for ${mismatch.label}: wanted ${mismatch.want}, DOM holds ${mismatch.after}`);

if (!(await wait(`(()=>{const re=/Make poster/i;return [...document.querySelectorAll('button')].some(b=>re.test(b.innerText||'')&&!b.disabled)})()`, 60000))) {
  console.log('buttons:', JSON.stringify(await ev(`JSON.stringify([...document.querySelectorAll('button')].map(b=>[b.innerText.trim().slice(0,30),!b.disabled]))`)));
  // Screenshot FIRST, throw second: the disabled button is the finding, and a
  // rig that dies before the capture leaves no proof of what it saw (r4: the
  // run aborted with no pane image).
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log('shot (disabled button):', SHOT);
  } catch { /* the tab is gone; the throw below carries the reason */ }
  throw new Error('no enabled "Make poster" button');
}
console.log('clicked', JSON.stringify(await ev(`(()=>{const re=/Make poster/i;const b=[...document.querySelectorAll('button')].find(x=>re.test(x.innerText||'')&&!x.disabled);b.click();return b.innerText.trim()})()`)));

const finished = await wait(`!!document.querySelector('section[aria-label="Result"]') || !!document.querySelector('[role=alert]')`, TIMEOUT);
await sleep(900);
const screen = JSON.parse(await ev(`(()=>{const pick=(s)=>{const e=document.querySelector(s);return e?e.innerText.trim():null};
  return JSON.stringify({result:pick('section[aria-label="Result"]'),alert:pick('[role=alert]'),
  status:pick('[role=status]'),previewPages:document.querySelector('[data-preview-pages]')?.getAttribute('data-preview-pages')??null,
  headings:[...document.querySelectorAll('h1,h2,h3')].map((h)=>h.innerText.trim()).slice(0,6),
  screen:(document.body.innerText||'').slice(0,2000)})})()`));
console.log('screen:', JSON.stringify({ result: screen.result, alert: screen.alert, status: screen.status }));
if (SHOT) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
  console.log('shot:', SHOT);
}
if (!finished) console.log('TIMED OUT with no result and no alert');
if (screen.result) {
  const clickedDown = await ev(`(()=>{const per=[...document.querySelectorAll('section[aria-label="Result"] button[aria-label^="Download "]')];
    if(per.length){per.forEach((b)=>b.click());return 'each:'+per.length}
    const all=[...document.querySelectorAll('section[aria-label="Result"] button')].find((b)=>/^(Download|Download all)$/.test((b.innerText||'').trim()));
    if(all){all.click();return 'one'} return 'none'})()`);
  await sleep(2500);
  console.log('download:', clickedDown);
}
const named = JSON.parse(await ev(`JSON.stringify(window.__files)`));
console.log('files:', JSON.stringify(named.map(([n]) => n)));
const take = named.length ? named[0][1] : await ev(`(()=>{const e=[...window.__urls.entries()].filter(([,b])=>b.type==='application/pdf').at(-1);return e?e[0]:''})()`);
const info = JSON.parse(await ev(`(async()=>{const b=window.__urls.get(${JSON.stringify(take)});if(!b)return JSON.stringify({missing:true});
  const u=new Uint8Array(await b.arrayBuffer());let s='';for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));
  return JSON.stringify({type:b.type,size:u.length,b64:btoa(s)})})()`));
if (info.missing) console.log('NO FILE CAPTURED');
else {
  writeFileSync(OUT, Buffer.from(info.b64, 'base64'));
  console.log('output', JSON.stringify({ type: info.type, bytes: info.size, file: OUT }));
}
console.log('console errors:', JSON.stringify([...new Set(errors)].slice(0, 3)));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
