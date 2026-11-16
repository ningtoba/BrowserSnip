// Probe for `image-to-pdf`: a multi-image intake, the tool's own controls, the
// produced bytes and the screen, in one real Chromium tab.
//
//   BASE=http://localhost:5271 FILES=/tmp/triage/in/wide.png:/tmp/triage/in/tiny.png \
//     FIELDS_JSON='{"Fit":"Stretch"}' SHOT=/tmp/r/itp.png OUT=/tmp/r/itp.pdf \
//     PORT=9821 node docs/research/images-to-pdf-round.mjs
//
// `upload-two-refuse` mode loads `FILES` and reports only the sentences the pane
// printed (a refused batch never reaches the run button).
//
// Why this exists and `colour-rail.mjs` is not enough: that probe's single-run
// mode sets one file, and the questions here are order and mixed sizes across a
// batch — two images have to arrive in one intake, in a named order.
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const TOOL = process.env.TOOL || 'image-to-pdf';
const FILES = (process.env.FILES || '').split(':').filter(Boolean);
const LABEL = process.env.LABEL || 'Create PDF';
const OUT = process.env.OUT || '/tmp/r/itp.pdf';
const SHOT = process.env.SHOT || '';
const DARK = !!process.env.DARK;
const MODE = process.env.MODE || 'run';
const PORT = Number(process.env.PORT || 9821);
const FIELDS = JSON.parse(process.env.FIELDS_JSON || '{}');
const TIMEOUT = Number(process.env.RUN_TIMEOUT || 180000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (FILES.length === 0) throw new Error('FILES is required');

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/itp-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
    if (pending.has(i)) { pending.delete(i); rej(new Error(`${method} unanswered`)); }
  }, 30000);
});
const ev = async (expr) => {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result?.value;
    } catch (error) { last = error; await sleep(400); }
  }
  throw last;
};
const wait = async (expr, ms = TIMEOUT) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(200); }
  return false;
};
const shoot = async (path) => {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path, Buffer.from(shot.data, 'base64'));
  console.log('screenshot:', path);
};
const screen = () => ev(`(document.body.innerText || '').replace(/\\n{2,}/g,'\\n').slice(0, 2000)`);

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/${TOOL}` });
if (!(await wait(`document.readyState === 'complete' && !!document.querySelector('input[type=file]')`, 60000))) {
  throw new Error('no file input on the route');
}
await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
{
  const { root } = await send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId, files: FILES });
}
// The intake is a controlled queue; wait until every file is in it before a
// field is touched, or a late state write wipes the values.
// The intake clears the picker's own `value` after reading it, so the proof the
// files arrived is their names on the card, not `input.files`.
const wanted = FILES.map((f) => f.split('/').pop());
if (!(await wait(`(()=>{const t=document.body.innerText||'';return ${JSON.stringify(wanted)}.every((n)=>t.includes(n))})()`, 30000))) {
  throw new Error(`the intake did not take every file: ${JSON.stringify(await screen())}`);
}
await sleep(800);

const CONTROL = (label) => `(()=>{
  const want=${JSON.stringify(String(label).toLowerCase())};
  const norm=(s)=>(s||'').replace(/\\s+/g,' ').trim().toLowerCase();
  const lab=[...document.querySelectorAll('label[for]')].find((l)=>norm(l.innerText)===want);
  if(lab){const el=document.getElementById(lab.getAttribute('for'));
    if(el) return JSON.stringify({kind:el.tagName==='SELECT'?'select':el.tagName==='TEXTAREA'?'textarea':'input',type:el.type,id:el.id,value:el.value,options:el.tagName==='SELECT'?[...el.options].map((o)=>[o.value,o.text]):[]});}
  const box=[...document.querySelectorAll('label')].find((l)=>norm(l.innerText)===want&&l.querySelector('input[type=checkbox]'));
  if(box){const c=box.querySelector('input[type=checkbox]');return JSON.stringify({kind:'checkbox',checked:c.checked});}
  const range=[...document.querySelectorAll('label')].find((l)=>norm(l.innerText).startsWith(want)&&l.parentElement.querySelector('input[type=range]'));
  if(range){const c=range.parentElement.querySelector('input[type=range]');return JSON.stringify({kind:'input',type:'range',value:c.value});}
  const near=[...document.querySelectorAll('label')].find((l)=>norm(l.innerText).startsWith(want)&&!l.querySelector('input'));
  if(near){const ctl=near.parentElement.querySelector('select');if(ctl) return JSON.stringify({kind:'select',value:ctl.value,options:[...ctl.options].map((o)=>[o.value,o.text])});}
  return JSON.stringify({kind:'none'});})()`;

const AT = (label) => `(()=>{const want=${JSON.stringify(String(label).toLowerCase())};
  const norm=(s)=>(s||'').replace(/\\s+/g,' ').trim().toLowerCase();
  const lab=[...document.querySelectorAll('label[for]')].find((l)=>norm(l.innerText)===want);
  if(lab) return document.getElementById(lab.getAttribute('for'));
  const box=[...document.querySelectorAll('label')].find((l)=>norm(l.innerText)===want&&l.querySelector('input[type=checkbox]'));
  if(box) return box.querySelector('input[type=checkbox]');
  const near=[...document.querySelectorAll('label')].find((l)=>norm(l.innerText).startsWith(want)&&!l.querySelector('input'));
  if(near) return near.parentElement.querySelector('select,textarea,input');
  return null})()`;

// The pane keeps every control but page size behind a "N MORE OPTIONS"
// disclosure, so a field inside it is not mounted until the summary is clicked.
// Without this a FIELDS run reports NO CONTROL and the run silently uses defaults.
if (process.env.EXPAND) {
  console.log('expand:', await ev(`(()=>{const re=new RegExp(${JSON.stringify(process.env.EXPAND)},'i');
    const b=[...document.querySelectorAll('button,summary,a')].find((x)=>re.test(x.innerText||''));
    if(!b) return 'NO DISCLOSURE'; b.click(); return 'clicked '+b.innerText.trim()})()`));
  await sleep(400);
}

const readback = [];
for (const [label, value] of Object.entries(FIELDS)) {
  const at = AT(label);
  const before = JSON.parse(await ev(CONTROL(label)));
  if (before.kind === 'none') { readback.push(`${label}: NO CONTROL`); continue; }
  if (before.kind === 'select') {
    console.log('select:', await ev(`(()=>{const s=${at};const want=${JSON.stringify(String(value).toLowerCase())};
      const o=[...s.options].find((x)=>String(x.value).toLowerCase()===want)||[...s.options].find((x)=>(x.text||'').toLowerCase().includes(want));
      if(!o) return 'NO OPTION';
      const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
      set.call(s,o.value); s.dispatchEvent(new Event('input',{bubbles:true})); s.dispatchEvent(new Event('change',{bubbles:true})); return 'selected '+o.text;})()`));
  } else if (before.kind === 'input' && before.type === 'range') {
    await ev(`(()=>{const c=${at};const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      set.call(c,${JSON.stringify(String(value))});
      c.dispatchEvent(new Event('input',{bubbles:true})); c.dispatchEvent(new Event('change',{bubbles:true})); return 1})()`);
  } else if (before.kind === 'checkbox') {
    await ev(`(()=>{const c=${at};const want=${['1','true','on'].includes(String(value))};if(c.checked!==want)c.click();return 1})()`);
  }
  await sleep(150);
}
for (const [label] of Object.entries(FIELDS)) {
  const after = JSON.parse(await ev(CONTROL(label)));
  readback.push(`${label}: kind=${after.kind} value=${JSON.stringify(after.value ?? after.checked)}`);
}
console.log('readback:', JSON.stringify(readback));

if (DARK) {
  await ev(`(()=>{document.documentElement.classList.add('dark');try{localStorage.setItem('browsersnip:theme','dark')}catch{}return 1})()`);
  await sleep(900);
}
if (SHOT) await shoot(SHOT);

if (MODE === 'screen') { console.log('screen:', JSON.stringify(await screen())); ws.close(); chrome.kill('SIGKILL'); process.exit(0); }

if (!(await wait(`(()=>{const re=new RegExp(${JSON.stringify(LABEL)},'i');return [...document.querySelectorAll('button')].some((b)=>re.test(b.innerText||'')&&!b.disabled)})()`, 90000))) {
  console.log('NO ENABLED RUN BUTTON — the screen says:', JSON.stringify(await screen()));
  throw new Error('run button never enabled');
}
await ev(`(()=>{const re=new RegExp(${JSON.stringify(LABEL)},'i');const b=[...document.querySelectorAll('button')].find((x)=>re.test(x.innerText||'')&&!x.disabled);b.click();return b.innerText.trim()})()`).then((t) => console.log('clicked', JSON.stringify(t)));
if (!(await wait('window.__blobs.length>0', 120000))) {
  console.log('NO OUTPUT — the screen says:', JSON.stringify(await screen()));
  throw new Error('no output blob');
}
await sleep(1500);
const info = JSON.parse(await ev(`(async()=>{const b=window.__blobs.at(-1);const u=new Uint8Array(await b.arrayBuffer());let s='';for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return JSON.stringify({type:b.type,size:u.length,b64:btoa(s)})})()`));
writeFileSync(OUT, Buffer.from(info.b64, 'base64'));
console.log('output', JSON.stringify({ type: info.type, bytes: info.size, file: OUT }));
if (SHOT) await shoot(SHOT.replace(/\.png$/, '-result.png'));
console.log('screen:', JSON.stringify(await screen()));
console.log('console errors', JSON.stringify([...new Set(errors)].slice(0, 3)));
void readFileSync;
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
