// Overlay probe — drive `overlay-pdf` in real Chromium with **two** files, set its
// controls the way a user's events reach React, read them back out of the DOM,
// click the run, and hand back the download plus a screenshot.
//
//   BASE=http://localhost:5271 TOOL=overlay-pdf \
//     PDF=/tmp/triage/colour.pdf PDF2=/tmp/triage/sheets.pdf \
//     LABEL='^Overlay$' PORT=9821 OUT=/tmp/r/overlay.pdf \
//     node docs/research/overlay-rail.mjs
//
//   ... FIELDS='mode=underlay scale=0.5' SHOT=/tmp/r/overlay-under.png ...
//
// `colour-rail.mjs` uploads one file, so it cannot reach a `multiFile` tool at
// all; this is the same shape (upload → gesture → capture blob → screenshot) with
// the picker given both paths in queue order, base first.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const TOOL = process.env.TOOL || 'overlay-pdf';
const PDF = process.env.PDF;
const PDF2 = process.env.PDF2;
const OUT = process.env.OUT || `/tmp/r/${TOOL}.pdf`;
const SHOT = process.env.SHOT || '';
const LABEL = process.env.LABEL || '';
const PORT = Number(process.env.PORT || 9821);
const TIMEOUT = Number(process.env.RUN_TIMEOUT || 120000);
if (!PDF || !PDF2) throw new Error('PDF and PDF2 are required (base, stamp)');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Field key → the words the rail prints beside it. */
const FIELD_LABELS = {
  mode: 'mode',
  mapping: 'which stamp page for each base page',
  opacity: 'opacity',
  scale: 'stamp size',
};

const WANTED = Object.fromEntries(
  (process.env.FIELDS || '').split(/\s+/).filter(Boolean).map((pair) => {
    const at = pair.indexOf('=');
    return [FIELD_LABELS[pair.slice(0, at)] ?? pair.slice(0, at), pair.slice(at + 1)];
  }),
);

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--force-dark-mode',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/overlay-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
    errors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 300));
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = id++;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => {
    if (pending.has(i)) { pending.delete(i); rej(new Error(`${method} #${i} unanswered`)); }
  }, 30000);
});
const ev = async (expr) => {
  let last;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result?.value;
    } catch (e) { last = e; await sleep(700); }
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
await send('Page.navigate', { url: `${BASE}/#/tool/${TOOL}` });
await wait(`!!document.querySelector('input[type=file]')`, 60000);
await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);

const { root } = await send('DOM.getDocument', { depth: -1 });
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
await send('DOM.setFileInputFiles', { nodeId, files: [PDF, PDF2] });
// Both files must be in the queue, in order, before anything is clicked.
if (!(await wait(`(()=>{
  const t=document.body.innerText||'';
  return t.includes(${JSON.stringify(basename(PDF))}) && t.includes(${JSON.stringify(basename(PDF2))});
})()`, 30000))) {
  console.log('QUEUE MISSING — screen says:', JSON.stringify((await ev(`document.body.innerText`)).slice(0, 1200)));
  throw new Error('both files did not land in the queue');
}
const order = await ev(`(()=>{const t=document.body.innerText||'';
  const a=t.indexOf(${JSON.stringify(basename(PDF))}), b=t.indexOf(${JSON.stringify(basename(PDF2))});
  return a>=0&&b>=0&&a<b?'base-first':'REVERSED'})()`);
console.log('queue order:', order, JSON.stringify([basename(PDF), basename(PDF2)]));

// The rail tucks the secondary controls behind an expander; a run that writes an
// `opacity` into a collapsed panel would report "not found" and measure nothing.
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/more options/i.test(x.innerText||'')&&x.getAttribute('aria-expanded')==='false');if(b)b.click();return 1})()`);
await sleep(700);

// Each control is found by the words the rail prints beside it, written through
// React's native setter, then read back so a silent no-op is the run's fault.
for (const [key, want] of Object.entries(WANTED)) {
  const read = await ev(`(async()=>{
    const norm=(s)=>(s||'').replace(/\\s+/g,' ').trim().toLowerCase();
    const want=${JSON.stringify(key.toLowerCase())};
    const normVal=${JSON.stringify(String(want).toLowerCase())};
    const raw=${JSON.stringify(String(want))};
    const lab=[...document.querySelectorAll('label[for]')].find((l)=>norm(l.innerText)===want);
    const el=lab?document.getElementById(lab.getAttribute('for')):null;
    const fire=(node)=>['input','change'].forEach((e)=>node.dispatchEvent(new Event(e,{bubbles:true})));
    if(el&&el.tagName==='SELECT'){
      const opt=[...el.options].find((o)=>o.value.toLowerCase()===normVal||norm(o.text)===normVal);
      if(!opt) return JSON.stringify({kind:'select',err:'no option',options:[...el.options].map(o=>o.text)});
      const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
      set.call(el,opt.value); fire(el);
      return JSON.stringify({kind:'select',value:el.value});
    }
    if(el){
      let proto=Object.getPrototypeOf(el), desc;
      while(proto&&!(desc=Object.getOwnPropertyDescriptor(proto,'value')))proto=Object.getPrototypeOf(proto);
      const set=desc.set;
      set.call(el,raw); fire(el);
      return JSON.stringify({kind:'input',value:el.value,type:el.type,id:el.id});
    }
    const group=[...document.querySelectorAll('[role=group][aria-label]')].find((g)=>norm(g.getAttribute('aria-label'))===want);
    if(group){
      const chip=[...group.querySelectorAll('button')].find((b)=>norm(b.innerText)===normVal
        || norm(b.innerText).includes(normVal) || normVal.includes(norm(b.innerText)));
      if(chip){chip.click();
        // React re-renders on the next tick, so the pressed state is read after it.
        const before=chip.getAttribute('aria-pressed');
        for(let i=0;i<20&&chip.getAttribute('aria-pressed')===before;i++) await new Promise((r)=>setTimeout(r,50));
        return JSON.stringify({kind:'chip',pressed:chip.getAttribute('aria-pressed'),text:chip.innerText.trim()});}
    }
    const box=[...document.querySelectorAll('label')].find((l)=>norm(l.innerText)===want&&l.querySelector('input[type=checkbox]'));
    if(box){const c=box.querySelector('input[type=checkbox]');
      if(String(c.checked)!==String(want==='true'))c.click();
      return JSON.stringify({kind:'checkbox',checked:c.checked});}
    return JSON.stringify({kind:'none'});
  })()`);
  console.log('field', key, '=', want, '→', read);
  const parsed = JSON.parse(read);
  if (parsed.kind === 'none' || parsed.err) throw new Error(`control ${key} not found on the rail`);
}

if (!(await wait(`(()=>{const re=new RegExp(${JSON.stringify(LABEL || '^Overlay$')},'i');
  return [...document.querySelectorAll('button')].some(b=>re.test(b.innerText||'')&&!b.disabled)})()`))) {
  console.log('NO ENABLED BUTTON — screen says:', JSON.stringify((await ev(`document.body.innerText`)).slice(0, 1600)));
  throw new Error(`no enabled button matching ${LABEL}`);
}
await ev(`(()=>{const re=new RegExp(${JSON.stringify(LABEL || '^Overlay$')},'i');
  const b=[...document.querySelectorAll('button')].find(x=>re.test(x.innerText||'')&&!x.disabled);b.click();
  return b.innerText.trim()})()`).then((t) => console.log('clicked', JSON.stringify(t)));

if (SHOT) {
  if (process.env.DARK) {
    // The shell's own token class, the way `merge-round.mjs` flips it: no hex
    // literals are written here, only the theme switch the app ships.
    await ev(`(()=>{document.documentElement.classList.add('dark');try{localStorage.setItem('theme','dark')}catch{}return 1})()`);
  }
  await sleep(1200);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  mkdirSync(dirname(SHOT), { recursive: true });
  writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
  console.log('shot', SHOT);
}

if (!(await wait('window.__blobs.length>0', 90000))) {
  console.log('NO OUTPUT — the screen says:', JSON.stringify((await ev(`document.body.innerText`)).slice(0, 1600)));
  console.log('exceptions:', JSON.stringify(errors));
  throw new Error('the tool produced no output blob');
}
const bytes = await ev(`(async()=>{const b=window.__blobs[window.__blobs.length-1];
  const buf=await b.arrayBuffer();const u=new Uint8Array(buf);let s='';for(let i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);
  return btoa(s)})()`);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(bytes, 'base64'));
console.log('wrote', OUT, Buffer.from(bytes, 'base64').length, 'bytes');
await sleep(800);
const said = await ev(`document.body.innerText`);
console.log('SCREEN SAYS:', JSON.stringify((said || '').slice(0, 1600)));
console.log('exceptions:', JSON.stringify(errors));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
