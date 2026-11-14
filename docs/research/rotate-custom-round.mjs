// rotate-custom — the pane half and the bytes half of the round, in one probe.
//
//   PORT=9841 BASE=http://localhost:5271 PDF=/tmp/triage/colour.pdf \
//     DIR=/tmp/r/rc node docs/research/rotate-custom-round.mjs
//
// Every field is written the way a user's event reaches React and read back out of
// the DOM before the click; if the read-back differs the run is wrong, not the tool.
// Each case screenshots the pane *before* the click (so the angle the pane claims can
// be compared with the angle the file gets) and the card after, and hands back the
// produced bytes for `rotate-custom-bytes.py`.
//
// The `degrees` cases are the tool's own steady state; the `pane` stage is the
// screenshot a person would look at, taken with the tool holding real content.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const PORT = Number(process.env.PORT || 9841);
const DIR = process.env.DIR || '/tmp/r/rc';
const PDF = process.env.PDF || '/tmp/triage/colour.pdf';
const SOURCE = process.env.SOURCE || PDF;
mkdirSync(DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// angle a positive and a negative value, a right-angle, the two no-ops, the box
// question on both fit modes, and the sheet that already carries /Rotate 90.
const CASES = JSON.parse(process.env.CASES || JSON.stringify([
  { name: 'A-all-30-grow', fields: { angle: '30', fit: 'grow', pages: 'all' } },
  { name: 'B-all-neg30-grow', fields: { angle: '-30', fit: 'grow', pages: 'all' } },
  { name: 'C-all-0-grow', fields: { angle: '0', fit: 'grow', pages: 'all' } },
  { name: 'D-all-360-grow', fields: { angle: '360', fit: 'grow', pages: 'all' } },
  { name: 'E-all-45-keep', fields: { angle: '45', fit: 'keep', pages: 'all' } },
  { name: 'F-all-90-grow', fields: { angle: '90', fit: 'grow', pages: 'all' } },
  { name: 'G-all-neg90-grow', fields: { angle: '-90', fit: 'grow', pages: 'all' } },
  { name: 'H-p4-0-grow', fields: { angle: '0', fit: 'grow', pages: '4' } },
  { name: 'I-p4-30-grow', fields: { angle: '30', fit: 'grow', pages: '4' } },
  { name: 'J-p4-90-grow', fields: { angle: '90', fit: 'grow', pages: '4' } },
  { name: 'K-p3-empty-30-grow', fields: { angle: '30', fit: 'grow', pages: '3' } },
  { name: 'L-p1-30-grow', fields: { angle: '-30', fit: 'grow', pages: '1' } },
  // controls: nothing chosen (a refusal), and a 30° turn of a blank sheet
  { name: 'M-none-30-grow', fields: { angle: '30', pages: 'none' } },
]));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${DIR}/profile-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(`${method} #${i} unanswered`)); } }, 30000);
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const wait = async (expr, ms = 90000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(200); }
  return false;
};
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${DIR}/${name}.png`, Buffer.from(data, 'base64'));
};

/** Address a control by the words printed beside it. */
const AT = (label) => `(()=>{const want=${JSON.stringify(label.toLowerCase())};const norm=(s)=>(s||'').replace(/\\s+/g,' ').trim().toLowerCase();
  const lab=[...document.querySelectorAll('label[for]')].find((l)=>norm(l.innerText)===want);
  if(lab) return document.getElementById(lab.getAttribute('for'));
  const g=[...document.querySelectorAll('[role=group][aria-label]')].find((x)=>norm(x.getAttribute('aria-label'))===want);
  if(g) return g;
  // A label whose innerText also holds the field's help sentence will not match
  // exactly; fall back to the control inside that label's block.
  const near=[...document.querySelectorAll('label')].find((l)=>norm(l.innerText).startsWith(want)&&!l.querySelector('input,select,textarea'));
  if(near){ const ctl=near.parentElement.querySelector('select,input:not([type=checkbox]),textarea'); if(ctl) return ctl; }
  return null})()`;
const describe = async (label) => JSON.parse(await ev(`(()=>{const el=${AT(label)};
  if(!el) return JSON.stringify({kind:'none'});
  if(el.tagName==='SELECT') return JSON.stringify({kind:'select',value:el.value,options:[...el.options].map((o)=>o.value)});
  if(el.tagName==='INPUT') return JSON.stringify({kind:'input',type:el.type,value:el.value});
  return JSON.stringify({kind:'group',chips:[...el.querySelectorAll('button')].map((b)=>[b.innerText.trim(),b.getAttribute('aria-pressed')])})})()`));
const setField = async (label, raw) => {
  const before = await describe(label);
  if (before.kind === 'none') return { label, want: raw, before: 'NO CONTROL', after: 'NO CONTROL' };
  if (before.kind === 'group') {
    await ev(`(()=>{const g=${AT(label)};const want=${JSON.stringify(String(raw).toLowerCase())};
      const chip=[...g.querySelectorAll('button')].find((c)=>(c.innerText||'').toLowerCase().includes(want));
      if(chip) chip.click(); return !!chip})()`);
  } else if (before.kind === 'select') {
    await ev(`(()=>{const s=${AT(label)};const want=${JSON.stringify(String(raw).toLowerCase())};
      const o=[...s.options].find((x)=>x.value.toLowerCase()===want)||[...s.options].find((x)=>(x.text||'').toLowerCase().includes(want));
      if(!o) return 'NO OPTION';
      const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
      set.call(s,o.value); s.dispatchEvent(new Event('input',{bubbles:true})); s.dispatchEvent(new Event('change',{bubbles:true})); return 1})()`);
  } else {
    const numeric = before.type === 'range' || before.type === 'number';
    const written = numeric ? JSON.stringify(Number(raw)) : JSON.stringify(String(raw));
    await ev(`(()=>{const c=${AT(label)};
      const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      set.call(c,${written});
      c.dispatchEvent(new Event('input',{bubbles:true})); c.dispatchEvent(new Event('change',{bubbles:true})); return 1})()`);
  }
  await sleep(250);
  const after = await describe(label);
  return { label, want: raw, before: JSON.stringify(before), after: JSON.stringify(after) };
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1400, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/rotate-custom` });
if (!(await wait(`!!document.querySelector('input[type=file]')`, 90000))) throw new Error('no file input on the route');
await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
{
  const { root } = await send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId, files: [PDF] });
}
await wait(`document.body.innerText.includes(${JSON.stringify(basename(PDF))})`, 20000);
await sleep(1500);
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find((x)=>/more option/i.test(x.innerText||''));if(b)b.click();return !!b})()`);
await sleep(600);

// Stage PANE — the form as a person first meets it, and with 30° written.
console.log('card:', JSON.stringify(await ev(`(()=>{const s=document.querySelector('[data-surface]');return (s?s.innerText:document.body.innerText).slice(0,1800)})()`)));
console.log('defaults:', JSON.stringify({
  angle: await describe('Angle'), fit: await describe('Page size'), pages: await describe('Pages'),
}));
console.log('thumbs:', await ev(`document.querySelectorAll('[data-thumb]').length`));
await shot('pane-default');
const probe = await setField('Angle', '30');
console.log('angle readback:', JSON.stringify(probe));
await sleep(1200);
console.log('pane after 30°:', JSON.stringify(await ev(`(()=>{const s=document.querySelector('[data-surface]');return (s?s.innerText:document.body.innerText).slice(0,1800)})()`)));
await shot('pane-30');

// Stage CASES
const records = [];
for (const c of CASES) {
  await send('Page.navigate', { url: `${BASE}/#/tool/rotate-custom` });
  await wait(`!!document.querySelector('input[type=file]')`, 90000);
  await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
  const { root } = await send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId, files: [PDF] });
  await wait(`document.body.innerText.includes(${JSON.stringify(basename(PDF))})`, 20000);
  await sleep(1200);
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find((x)=>/more option/i.test(x.innerText||''));if(b)b.click();return !!b})()`);
  await sleep(500);
  const readback = [];
  // the fields are keyed, the controls are found by their printed words
  const WORDS = { fit: 'Page size' };
  for (const [key, value] of Object.entries(c.fields)) readback.push(await setField(WORDS[key] ?? key, value));
  console.log(c.name, 'readback:', JSON.stringify(readback));
  const mismatch = readback.filter((r) => {
    if (r.after === 'NO CONTROL') return true;
    const a = JSON.parse(r.after);
    const want = String(r.want).toLowerCase();
    if (a.kind === 'input') return a.type === 'range' || a.type === 'number' ? Number(a.value) !== Number(r.want) : !a.value.toLowerCase().includes(want);
    if (a.kind === 'select') return a.value.toLowerCase() !== want;
    return false;
  });
  await sleep(1200);
  await shot(`${c.name}-pane`);
  const btn = await ev(`(()=>{const b=document.querySelector('#tool-process-btn')||[...document.querySelectorAll('button')].find((x)=>/^Turn$/.test((x.innerText||'').trim()));
    if(!b) return 'NO BUTTON'; return b.disabled ? 'DISABLED' : 'ok'})()`);
  const record = { name: c.name, fields: c.fields, readback, mismatch: mismatch.length, button: btn, ok: false };
  if (btn !== 'ok') {
    record.screen = await ev(`(document.body.innerText||'').replace(/\\n{2,}/g,' | ').slice(0,1200)`);
    records.push(record);
    console.log(c.name, '->', btn, JSON.stringify(record.screen.slice(-260)));
    continue;
  }
  const before = await ev(`window.__blobs.length`);
  await ev(`(()=>{const b=document.querySelector('#tool-process-btn')||[...document.querySelectorAll('button')].find((x)=>/^Turn$/.test((x.innerText||'').trim()));b.click();return 1})()`);
  const done = await wait(`!!document.querySelector('section[aria-label="Result"]') || !!document.querySelector('[role=alert]') || window.__blobs.length>${before}`, 120000);
  await sleep(900);
  record.finished = done;
  record.screen = await ev(`(()=>{const s=document.querySelector('section[aria-label="Result"]');return s?s.innerText:((document.querySelector('[role=alert]')||document.body).innerText||'').slice(0,1200)})()`);
  await shot(`${c.name}-card`);
  const isResult = await ev(`!!document.querySelector('section[aria-label="Result"]')`);
  if (isResult) {
    await ev(`(()=>{const b=[...document.querySelectorAll('section[aria-label="Result"] button')].find((x)=>/^Download$/.test((x.innerText||'').trim()));if(b)b.click();return !!b})()`);
    await sleep(1200);
  }
  const b64 = await ev(`(async()=>{const b=window.__blobs.at(-1);if(!b)return null;const u=new Uint8Array(await b.arrayBuffer());let s='';for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return btoa(s)})()`);
  if (b64) { writeFileSync(join(DIR, `${c.name}.pdf`), Buffer.from(b64, 'base64')); record.bytes = Buffer.from(b64, 'base64').length; record.ok = true; }
  records.push(record);
  console.log(c.name, '->', record.ok ? `ok ${record.bytes}B` : 'FAIL', 'mismatch', record.mismatch, '|', JSON.stringify(record.screen.replace(/\n+/g, ' | ').slice(0, 400)));
}

writeFileSync(join(DIR, 'records.json'), JSON.stringify(records, null, 1));
console.log('console errors:', JSON.stringify([...new Set(errors)].slice(0, 5)));
console.log('source:', SOURCE, 'dir:', DIR);
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
