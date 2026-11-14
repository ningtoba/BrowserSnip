// Extract-pages probe — drive the extract rail in real Chromium, one case at a
// time, and hand back *every* file it produced, the words it printed, and a
// screenshot of the pane and the result card.
//
//   BASE=http://localhost:5271 PORT=9821 CASES=/tmp/xp/cases.json \
//     OUTDIR=/tmp/xp/out node docs/research/extract-pages-round.mjs
//
// `colour-rail.mjs` keeps only the last blob on a single run and its spec mode
// cannot hand down a per-case screenshot; extract answers in N files whenever
// the combine toggle is off, and the pane and the card are half of the evidence.
// So this is the same CDP shape as `split-campaign.mjs` (native value setter, the
// field read back out of the DOM before the click, every blob caught through a
// `URL.createObjectURL` hook, each card Download pressed) with two additions the
// tool needs: the `Combine into a single PDF` checkbox, and the page picker's own
// `none` chip for the empty-selection case.
//
// CASES is a JSON array: [{ "id": "...", "pdf": "...", "pages": "3,1",
// "combine": false, "zip": true, "dark": true, "shotBefore": true, "shot": true }]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const PORT = Number(process.env.PORT || 9821);
const CASES = process.env.CASES;
const OUTDIR = process.env.OUTDIR || '/tmp/xp/out';
const PDF = process.env.PDF || '/tmp/triage/colour.pdf';
const TIMEOUT = Number(process.env.RUN_TIMEOUT || 180000);
if (!CASES) throw new Error('CASES is required');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUTDIR, { recursive: true });

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/xp-${PORT}`, 'about:blank'], { stdio: 'ignore' });
let ws;
for (let i = 0; i < 80 && !ws; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch { /* chrome not up yet */ }
  await sleep(300);
}
if (!ws) throw new Error('chrome never answered on the debug port');
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

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false });

const CONTROL = (label) => `(()=>{
  const want=${JSON.stringify(String(label).toLowerCase())};
  const norm=(s)=>(s||'').replace(/\\s+/g,' ').trim().toLowerCase();
  const out=(kind,el,extra)=>JSON.stringify(Object.assign({kind},extra||{}));
  const lab=[...document.querySelectorAll('label[for]')].find((l)=>norm(l.innerText)===want);
  const byId=lab?document.getElementById(lab.getAttribute('for')):null;
  if(byId){
    if(byId.tagName==='TEXTAREA') return out('textarea',byId,{id:byId.id});
    if(byId.tagName==='SELECT') return out('select',byId,{id:byId.id,value:byId.value,options:[...byId.options].map(o=>[o.value,o.text])});
    return out(byId.type==='checkbox'?'checkbox':'input',byId,{id:byId.id,type:byId.type,value:byId.value,checked:byId.checked});
  }
  const box=[...document.querySelectorAll('label')].find((l)=>norm(l.innerText)===want&&l.querySelector('input[type=checkbox]'));
  if(box) return out('checkbox',box.querySelector('input[type=checkbox]'),{checked:box.querySelector('input[type=checkbox]').checked});
  const group=[...document.querySelectorAll('[role=group][aria-label]')].find((g)=>norm(g.getAttribute('aria-label'))===want);
  if(group){
    const chips=[...group.querySelectorAll('button')];
    if(chips.length) return out('group',group,{chips:chips.map((b)=>[b.innerText.trim(),b.getAttribute('aria-pressed')])});
  }
  return out('none',null);
})()`;

const AT = (label) => `(()=>{const want=${JSON.stringify(String(label).toLowerCase())};
  const norm=(s)=>(s||'').replace(/\\s+/g,' ').trim().toLowerCase();
  const lab=[...document.querySelectorAll('label[for]')].find((l)=>norm(l.innerText)===want);
  const el=lab?document.getElementById(lab.getAttribute('for')):null;
  if(el) return el;
  const box=[...document.querySelectorAll('label')].find((l)=>norm(l.innerText)===want&&l.querySelector('input[type=checkbox]'));
  if(box) return box.querySelector('input[type=checkbox]');
  const g=[...document.querySelectorAll('[role=group][aria-label]')].find((x)=>norm(x.getAttribute('aria-label'))===want);
  return g||null})()`;

const print = (c) => {
  if (c.kind === 'none') return 'NO CONTROL';
  if (c.kind === 'checkbox') return `checked=${c.checked}`;
  if (c.kind === 'select') return `select=${c.value} of ${c.options.map(([v]) => v).join('/')}`;
  return `${c.type ?? 'input'}=${JSON.stringify(c.value)}`;
};

/** Write the value the way a user's event reaches React, then read it back. */
async function setField(label, raw) {
  const before = JSON.parse(await ev(CONTROL(label)));
  if (before.kind === 'none') return { label, want: raw, before: 'NO CONTROL', after: 'NO CONTROL' };
  const at = AT(label);
  if (before.kind === 'checkbox') {
    const want = raw === true || raw === 'true' || raw === '1';
    await ev(`(()=>{const c=${at}; if(c.checked!==${want}) c.click(); return 1})()`);
  } else if (raw === 'none-chip') {
    // The page picker's own "none" chip: a user clears the field with it rather
    // than emptying the box by hand, and it is the state validate() refuses.
    await ev(`(()=>{const c=${at};
      const picker=c.closest('div');
      const chip=[...picker.parentElement.querySelectorAll('button')].find((b)=>b.innerText.trim()==='none');
      if(!chip) return 'NO CHIP'; chip.click(); return 1})()`);
  } else {
    await ev(`(()=>{const c=${at};
      const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      set.call(c,${JSON.stringify(String(raw))});
      c.dispatchEvent(new Event('input',{bubbles:true})); c.dispatchEvent(new Event('change',{bubbles:true})); return 1})()`);
  }
  await sleep(250);
  const after = JSON.parse(await ev(CONTROL(label)));
  return { label, want: raw, before: print(before), after: print(after) };
}

const SCREEN = `(()=>{
  const pick=(sel)=>{const e=document.querySelector(sel);return e?e.innerText.trim():null};
  const card=document.querySelector('section[aria-label="Result"]');
  return JSON.stringify({
    result: pick('section[aria-label="Result"]'),
    alert: pick('[role=alert]'),
    status: pick('[role=status]'),
    run: (()=>{const b=document.querySelector('#tool-process-btn');return b?{text:b.innerText.trim(),disabled:!!b.disabled}:null})(),
    reason: pick('#tool-run-reason'),
    pickerLine: (document.querySelector('#tool-field-pages')?.closest('div')?.parentElement?.innerText||'').slice(0,300),
    cardAttrs: card?[...card.querySelectorAll('[data-output-name],[data-preview-pages]')].map((e)=>[e.getAttribute('data-output-name'),e.getAttribute('data-preview-pages')]):null,
    buttons: [...document.querySelectorAll('button')].map((b)=>[b.innerText.trim().slice(0,34),!b.disabled]).filter(([t])=>t).slice(0,40),
    headings: [...document.querySelectorAll('h1,h2,h3')].map((h)=>h.innerText.trim()).slice(0,8),
    screen: (document.body.innerText||'').slice(0,3000),
  });
})()`;

async function save(name, href) {
  const info = JSON.parse(await ev(`(async()=>{var b=window.__urls.get(${JSON.stringify(href)});if(!b) return JSON.stringify({missing:true});
    var u=new Uint8Array(await b.arrayBuffer());var s='';for(var i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));
    return JSON.stringify({type:b.type,size:u.length,b64:btoa(s)})})()`));
  if (info.missing) return null;
  return { name, type: info.type, bytes: info.size, data: Buffer.from(info.b64, 'base64') };
}

const sanitize = (n) => n.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-70);

async function runCase(kase) {
  const record = { id: kase.id, fields: {}, outputs: [], readback: [], ok: false, fail: null };
  const pdf = kase.pdf ?? PDF;
  await send('Page.navigate', { url: `${BASE}/?c=${encodeURIComponent(kase.id)}#/tool/extract-pages` });
  if (!(await wait(`document.readyState==='complete' && !!document.querySelector('#tool-process-btn, input[type=file]')`, 120000))) {
    record.fail = 'route did not mount'; return record;
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
  const inputs = await send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' });
  let taken = false;
  for (const nodeId of (inputs.nodeIds ?? []).filter((n) => n > 0)) {
    try { await send('DOM.setFileInputFiles', { nodeId, files: [pdf] }); } catch { continue; }
    taken = await wait(`document.body.innerText.includes(${JSON.stringify(basename(pdf))})`, 12000);
    if (taken) break;
  }
  record.uploaded = taken;
  if (kase.dark) {
    record.theme = await ev(`(()=>{
      if(document.documentElement.classList.contains('dark')) return 'already dark';
      const b=[...document.querySelectorAll('button')].find((x)=>/[☀☾]/u.test(x.innerText||''));
      if(!b) return 'NO THEME BUTTON'; b.click();
      return document.documentElement.classList.contains('dark')?'dark':'CLICK DID NOT STICK'})()`);
    await sleep(600);
  }
  if (!taken) { record.fail = 'upload not acknowledged'; return record; }
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/more option/i.test(x.innerText||''));if(b)b.click();return !!b})()`);
  await sleep(400);
  if (kase.pages !== undefined) {
    const got = await setField('Pages', kase.pages);
    if (got.before === 'NO CONTROL') record.missingField = 'Pages';
    record.fields.pages = kase.pages;
    record.readback.push(got);
  }
  if (kase.combine !== undefined) {
    const got = await setField('Combine into a single PDF', kase.combine);
    record.fields.combine = kase.combine;
    record.readback.push(got);
  }
  await sleep(250);
  record.before = JSON.parse(await ev(SCREEN));
  if (kase.shotBefore) {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    record.shotBeforePath = join(OUTDIR, `${kase.id}-pane.png`);
    writeFileSync(record.shotBeforePath, Buffer.from(shot.data, 'base64'));
  }
  const blobsBefore = await ev(`window.__blobs.length`);
  record.clicked = await ev(`(()=>{const b=document.querySelector('#tool-process-btn');if(!b) return 'NO BUTTON';if(b.disabled) return 'DISABLED';b.click();return 'run'})()`);
  if (record.clicked === 'DISABLED') {
    record.fail = 'run button disabled';
    record.after = JSON.parse(await ev(SCREEN));
    if (kase.shot) {
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      record.shot = join(OUTDIR, `${kase.id}.png`);
      writeFileSync(record.shot, Buffer.from(shot.data, 'base64'));
    }
    return record;
  }
  const finished = await wait(
    `!!document.querySelector('section[aria-label="Result"]') || !!document.querySelector('[role=alert]')`,
    TIMEOUT,
  );
  await sleep(1200);
  record.after = JSON.parse(await ev(SCREEN));
  if (kase.shot) {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    record.shot = join(OUTDIR, `${kase.id}.png`);
    writeFileSync(record.shot, Buffer.from(shot.data, 'base64'));
  }
  record.errors = [...new Set(errors)].slice(0, 4);
  if (!finished) { record.fail = 'timed out'; return record; }
  if (record.after?.alert && !record.after?.result) { record.fail = 'error'; return record; }
  if (record.after?.result) {
    record.downloadClicked = await ev(`(()=>{
      const card=document.querySelector('section[aria-label="Result"]');
      const per=[...card.querySelectorAll('button[aria-label^="Download "]')];
      if(per.length){per.forEach((b)=>b.click()); return 'each:'+per.length;}
      const one=[...card.querySelectorAll('button')].find((b)=>(b.innerText||'').trim()==='Download');
      if(one){one.click(); return 'one';}
      return 'none'})()`);
    const want = Number(record.downloadClicked.startsWith('each:') ? record.downloadClicked.slice(5) : 1);
    await wait(`window.__files.length >= ${Math.max(1, want)}`, 25000);
    await sleep(2200);
    if (kase.zip) {
      // The card offers "Download as zip" for a multi-file result, and that
      // archive is where the entry names meet a folder's own sort.
      record.zipClicked = await ev(`(()=>{const b=[...document.querySelectorAll('section[aria-label="Result"] button')].find((x)=>/zip/i.test(x.innerText||''));if(!b) return 'NO ZIP BUTTON';b.click();return 'zip'})()`);
      await wait(`window.__files.length >= ${Math.max(1, want) + 1}`, 25000);
      await sleep(1500);
    }
  }
  const named = JSON.parse(await ev(`JSON.stringify(window.__files)`));
  let n = 0;
  for (const [name, href] of named) {
    const saved = await save(name, href);
    if (!saved) continue;
    n += 1;
    const path = join(OUTDIR, `${sanitize(kase.id)}__${String(n).padStart(3, '0')}__${sanitize(name)}`);
    writeFileSync(path, saved.data);
    record.outputs.push({ name, path, bytes: saved.bytes, type: saved.type });
  }
  record.ok = record.outputs.length > 0 || !!record.after?.result;
  if (!record.ok && !record.fail) record.fail = 'no file';
  record.blobsAfter = (await ev(`window.__blobs.length`)) - blobsBefore;
  return record;
}

const cases = JSON.parse(readFileSync(CASES, 'utf8'));
const records = [];
for (const kase of cases) {
  let record;
  try { record = await runCase(kase); }
  catch (error) { record = { id: kase.id, ok: false, fail: `probe error: ${String(error).slice(0, 200)}` }; }
  records.push(record);
  console.log(`${kase.id} -> ${record.ok ? 'ok' : 'FAIL'}${record.fail ? ` (${record.fail})` : ''}`
    + ` | clicked ${record.clicked ?? '-'} | files ${(record.outputs ?? []).length}`
    + ` | ${(record.outputs ?? []).map((o) => `${o.name}:${o.bytes}B`).join(' ').slice(0, 200)}`);
  if (record.readback?.length) console.log(`   readback: ${record.readback.map((r) => `${r.label} ${r.before} → ${r.after}`).join(' ; ').slice(0, 300)}`);
  if (record.after?.alert) console.log(`   alert: ${record.after.alert.replace(/\n/g, ' / ').slice(0, 400)}`);
  if (record.after?.result) console.log(`   card: ${record.after.result.replace(/\n/g, ' / ').slice(0, 500)}`);
}
writeFileSync(join(OUTDIR, 'records.json'), JSON.stringify(records, null, 1));
console.log(`done: ${records.length} case(s)`);
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
