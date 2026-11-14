// pdf-to-cbz probe — run the tool in real Chromium, keep the archive and the
// screenshots, and hand both to `cbz-campaign.py`.
//
//   PDF=/tmp/triage/ink.pdf PORT=9821 OUT=/tmp/r021/before.cbz \
//     SHOT_DIR=/tmp/r021 node docs/research/cbz-campaign.mjs
//
//   PDF=/tmp/triage/ink.pdf PORT=9822 FIELDS='format=png' OUT=/tmp/r021/png.cbz \
//     node docs/research/cbz-campaign.mjs
//
// `cbz-bytes.mjs` measures ink only; the container questions (real magic, entry
// order, unique names that sort, ComicInfo, the first entry being page 1, and
// whether each control reaches the bytes) need the field flips and the pane and
// card screenshots this probe takes. Fields are written the way a user's event
// reaches React and read back out of the DOM before the click, as `colour-rail`.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const PDF = process.env.PDF;
const OUT = process.env.OUT || '/tmp/r021/out.cbz';
const PORT = Number(process.env.PORT || 9821);
const SHOT_DIR = process.env.SHOT_DIR || '/tmp/r021';
const TAG = process.env.TAG || 'run';
const LABEL = process.env.LABEL || '^Make CBZ$';
const TIMEOUT = Number(process.env.RUN_TIMEOUT || 300000);
if (!PDF) throw new Error('PDF is required');
mkdirSync(SHOT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Field key → the words the rail prints beside the control.
const FIELD_LABELS = { format: 'File format', dpi: 'Resolution', pages: 'Pages', quality: 'JPEG quality' };
const WANTED = Object.fromEntries(
  (process.env.FIELDS || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf('=');
      const key = pair.slice(0, at);
      return [FIELD_LABELS[key] ?? key, pair.slice(at + 1)];
    }),
);

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/cbz-campaign-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    errors.push(`log: ${m.params.entry.text.slice(0, 200)}`);
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
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(250); }
  return false;
};
const shot = async (name) => {
  const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const path = `${SHOT_DIR}/${TAG}-${name}.png`;
  writeFileSync(path, Buffer.from(res.data, 'base64'));
  console.log('screenshot:', path);
  return path;
};

/**
 * Write one control the way a user does. Returns what the DOM read back, so a
 * miss is visible in the record instead of the run silently using defaults.
 */
const setField = async (label, value) => {
  /** The control's clickable neighbourhood: climb from the label to the first
 * ancestor that holds an input, select, textarea or button. The label sits in a
 * header div beside a value span, and the chip row is its *uncle*, so a single
 * `closest('div')` stops one level short of every control. */
const SCOPE_FN = `const scopeFor=(words)=>{let n=[...document.querySelectorAll('label,legend,span,p,div,h3,h4')]
  .find(x=>x.children.length===0 && (x.textContent||'').trim().toLowerCase().replace(/:$/,'')===words.toLowerCase());
  for(let i=0;n&&i<5;i++){ if(n.querySelector('input:not([type=file]),select,textarea,button')) return n; n=n.parentElement; }
  return null;};`;

const find = `(()=>{
    const words=${JSON.stringify(label)};
    // The label's own element, not a container that merely starts with its
    // words: a wrapper beginning "File format" also holds the resolution slider,
    // and writing "png" into a range makes the browser choose the midpoint (236)
    // while the card goes on saying JPG. Measured, which is why this is here.
    const at=[...document.querySelectorAll('label,legend,span,p,div,h3,h4')]
      .find(n=>n.children.length===0
        && (n.textContent||'').trim().toLowerCase().replace(/:$/,'')===words.toLowerCase());
    if (!at) return JSON.stringify({error:'NO CONTROL'});
    return '';
  })()`;
  const scopeOf = (words) => `(()=>{
    const at=[...document.querySelectorAll('label,legend,span,p,div,h3,h4')]
      .find(n=>n.children.length===0
        && (n.textContent||'').trim().toLowerCase().replace(/:$/,'')===${JSON.stringify(String(label).toLowerCase())});
    return at ? (at.closest('label,fieldset,div')||at.parentElement) : null;
  })()`;
  const found = JSON.parse(await ev(`(()=>{${SCOPE_FN}
    const words=${JSON.stringify(label)};
    const value=${JSON.stringify(String(value))};
    const at=[...document.querySelectorAll('label,legend,span,p,div,h3,h4')]
      .find(n=>n.children.length===0
        && (n.textContent||'').trim().toLowerCase().replace(/:$/,'')===words.toLowerCase());
    if (!at) return JSON.stringify({error:'NO CONTROL'});
    const scope=scopeFor(words);
    if (!scope) return JSON.stringify({error:'NO CONTROL'});
    // A segmented control: the "input" is a button group of chips.
    const chip=[...scope.querySelectorAll('button')].find(b=>new RegExp('^'+value+'$','i').test((b.textContent||'').trim()));
    if (chip) { chip.click(); return JSON.stringify({kind:'chip',after:value}); }
    const ctl=scope.querySelector('input:not([type=file]),select,textarea');
    if (!ctl) return JSON.stringify({error:'NO CONTROL'});
    const kind=ctl.tagName==='SELECT'?'select':(ctl.type||'text');
    const before=ctl.value;
    if (kind==='range') {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(ctl,String(value));
      ctl.dispatchEvent(new Event('input',{bubbles:true}));
      ctl.dispatchEvent(new Event('change',{bubbles:true}));
    } else if (kind==='select') {
      const opt=[...ctl.options].find(o=>new RegExp('^'+value+'$','i').test(o.textContent||'')||o.value===value);
      if (!opt) return JSON.stringify({error:'NO OPTION',options:[...ctl.options].map(o=>o.textContent)});
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(ctl,opt.value);
      ctl.dispatchEvent(new Event('change',{bubbles:true}));
    } else {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(ctl,String(value));
      ctl.dispatchEvent(new Event('input',{bubbles:true}));
      ctl.dispatchEvent(new Event('change',{bubbles:true}));
    }
    return JSON.stringify({kind,before,after:ctl.value});
  })()`));
  await sleep(250);
  // Read it back out of the DOM: a write React ignored looks like a success.
  const read = JSON.parse(await ev(`(()=>{${SCOPE_FN}
    const words=${JSON.stringify(label)};
    const at=[...document.querySelectorAll('label,legend,span,p,div,h3,h4')]
      .find(n=>n.children.length===0
        && (n.textContent||'').trim().toLowerCase().replace(/:$/,'')===words.toLowerCase());
    if (!at) return JSON.stringify({error:'gone'});
    const scope=scopeFor(words);
    if (!scope) return JSON.stringify({error:'gone'});
    const pressed=[...scope.querySelectorAll('button')]
      .filter(b=>/aria-pressed="true"|aria-selected="true"|data-state="on"/i.test(b.outerHTML))
      .map(b=>(b.textContent||'').trim());
    const ctl=scope.querySelector('input:not([type=file]),select,textarea');
    return JSON.stringify({value:ctl?ctl.value:null,pressed});
  })()`));
  return { label, written: found, readback: read };
};

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/pdf-to-cbz` });
await wait(`!!document.querySelector('input[type=file]')`, 60000);
await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
const { root } = await send('DOM.getDocument', { depth: -1 });
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
await send('DOM.setFileInputFiles', { nodeId, files: [PDF] });
const took = await wait(`document.body.innerText.includes(${JSON.stringify(PDF.split('/').pop())})`, 60000);
console.log('uploaded', took);
if (!took) throw new Error('the pane never names the uploaded file');
// The rail folds the secondary fields behind a disclosure.
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/more option/i.test(x.innerText||''));if(b)b.click();return !!b})()`);
await sleep(400);
const readbacks = [];
for (const [label, value] of Object.entries(WANTED)) readbacks.push(await setField(label, value));
for (const r of readbacks) console.log('field', JSON.stringify(r));
// Preset chips (`all`/`none`) are pressed, not typed: the empty *value* they leave
// behind is what the run reads, so typing "" is not the same gesture.
const CLICKS = (process.env.CLICKS || '').split(',').filter(Boolean);
for (const words of CLICKS) {
  const hit = await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim().toLowerCase()===${JSON.stringify(words.toLowerCase())});if(!b)return 'NO CHIP';b.click();return 'clicked'})()`);
  await sleep(350);
  const state = await ev(`(()=>{const t=[...document.querySelectorAll('input[type=text],textarea')].map(i=>i.value);return JSON.stringify({chips:[...document.querySelectorAll('button')].filter(b=>/aria-pressed="true"/.test(b.outerHTML)).map(b=>(b.innerText||'').trim()),fields:t,tiles:[...document.querySelectorAll('[aria-selected="true"],[data-state="on"]')].length})})()`);
  console.log('chip', words, hit, state);
}
if (process.env.DARK) { await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='\u2600');if(b)b.click();return !!b})()`); await sleep(700); }
console.log('dpi slider reads', await ev(`(()=>{const i=document.querySelector('input[type=range]');return i?i.value:null})()`));
await shot('pane');
const t0 = Date.now();
const clicked = await ev(`(()=>{const re=new RegExp(${JSON.stringify(LABEL)},'i');const b=[...document.querySelectorAll('button')].find(x=>re.test(x.innerText||'')&&!x.disabled);if(!b)return 'NO BUTTON';b.click();return 'clicked'})()`);
console.log('run button:', clicked);
// Peak heap, not the heap after the dust settles: a claim about memory must be
// sampled while the run is holding it.
let peak = 0;
let peakRss = 0;
let polling = true;
const sample = (async () => {
  while (polling) {
    const use = await send('Runtime.getHeapUsage').catch(() => null);
    if (use?.usedSize) peak = Math.max(peak, use.usedSize);
    // The canvas backing store is outside the V8 heap, so the whole browser
    // process tree this profile owns is what a memory claim is about.
    try {
      const rss = execSync(`ps -eo rss=,args= | grep 'cbz-campaign-${PORT}' | grep -v grep | awk '{s+=$1} END{print s+0}'`).toString().trim();
      peakRss = Math.max(peakRss, Number(rss) * 1024);
    } catch { /* ps is not always there */ }
    await sleep(120);
  }
})();
const done = await wait('window.__blobs.length>0', TIMEOUT);
polling = false;
await sample;
console.log('peak heap', Math.round(peak / 1024 / 1024), 'MB · peak process tree', Math.round(peakRss / 1024 / 1024), 'MB');
console.log('seconds', ((Date.now() - t0) / 1000).toFixed(1));
if (!done) {
  console.log('NO OUTPUT — the screen says:', JSON.stringify((await ev(`document.body.innerText`)).slice(0, 1200)));
  await shot('refused');
  throw new Error('no output blob');
}
await sleep(2500);
const info = JSON.parse(await ev(`(async()=>{var b=window.__blobs.at(-1);var u=new Uint8Array(await b.arrayBuffer());var s='';for(var i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return JSON.stringify({type:b.type,size:u.length,b64:btoa(s)})})()`));
writeFileSync(OUT, Buffer.from(info.b64, 'base64'));
console.log('output', JSON.stringify({ type: info.type, bytes: info.size, file: OUT }));
// How much this tab actually held, against the note's own pixel estimate: the
// canvas is freed per page and only the encoded blobs are kept, so a "552 MB in
// this tab" claim has to be measured, not assumed.
if (process.env.MEM) {
  const heap = await send('Runtime.getHeapUsage').catch(() => null);
  const mem = await send('Performance.getMetrics').then((r) => Object.fromEntries((r.metrics || []).map((m) => [m.name, m.value]))).catch(() => ({}));
  console.log('heap', JSON.stringify({ used: Math.round(heap?.usedSize ?? 0), total: Math.round(heap?.totalSize ?? 0), domNodes: mem.Nodes, jsHeap: Math.round(mem.JSHeapUsedSize ?? 0) }));
}
console.log('card:', JSON.stringify((await ev(`document.body.innerText`)).slice(0, 900)));
await shot('card');
console.log('console errors', JSON.stringify([...new Set(errors)].slice(0, 4)));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
