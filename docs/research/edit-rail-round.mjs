// edit-lane rail round — drive page-mark rail tools in real Chromium with Network
// capture and pane-parity thumbnail clicks, in one tab per case.
//
//   CASES=/tmp/lane-edit/cases.json PORT=9831 node docs/research/edit-rail-round.mjs
//
// Each case: {name, tool, label, pdf, fields:{"Printed Label":"value"}, thumb, shot}
// Writes /tmp/lane-edit/<name>.pdf, /tmp/lane-edit/<name>-*.png, and
// /tmp/lane-edit/<name>.json ({readback, crossOrigin, screen, out}) per case, plus
// /tmp/lane-edit/round.jsonl summary lines. Field values are written the way a
// user's event reaches React and read back from the DOM before the click, exactly
// like colour-rail.mjs (whose control finder this reuses).
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, statSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5291';
const PORT = Number(process.env.PORT || 9831);
const OUTDIR = process.env.OUTDIR || '/tmp/lane-edit';
const CASES = JSON.parse(readFileSync(process.env.CASES, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/editround-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
let requests = [];
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
  } else if (m.method === 'Network.requestWillBeSent') {
    const r = m.params.request;
    requests.push({ url: r.url, method: r.method, bodyBytes: (r.postData || '').length, hasBody: !!r.hasPostData });
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = id++;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(`${method} #${i} unanswered`)); } }, 30000);
});
const ev = async (expr) => {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result?.value;
    } catch (error) { lastError = error; await sleep(500); }
  }
  throw lastError;
};
const wait = async (expr, ms = 180000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(200); }
  return false;
};

const CONTROL = (label) => `(()=>{
  const want=${JSON.stringify(String(label).toLowerCase())};
  const norm=(s)=>(s||'').replace(/\\s+/g,' ').trim().toLowerCase();
  const out=(kind,el,extra)=>JSON.stringify(Object.assign({kind},extra||{}));
  const lab=[...document.querySelectorAll('label[for]')].find((l)=>norm(l.innerText)===want);
  const byId=lab?document.getElementById(lab.getAttribute('for')):null;
  if(byId){
    if(byId.tagName==='TEXTAREA') return out('textarea',byId,{id:byId.id});
    if(byId.tagName==='SELECT') return out('select',byId,{id:byId.id,value:byId.value,options:[...byId.options].map(o=>[o.value,o.text])});
    return out('input',byId,{id:byId.id,type:byId.type,value:byId.value,min:byId.min,max:byId.max});
  }
  const hex=[...document.querySelectorAll('[aria-label]')].find((e)=>norm(e.getAttribute('aria-label'))===want+' hex value');
  if(hex) return out('input',hex,{type:hex.type,value:hex.value,aria:'hex'});
  const swatch=[...document.querySelectorAll('[aria-label]')].find((e)=>norm(e.getAttribute('aria-label'))===want+' colour');
  if(swatch) return out('input',swatch,{type:swatch.type,value:swatch.value,aria:'colour'});
  const box=[...document.querySelectorAll('label')].find((l)=>norm(l.innerText)===want&&l.querySelector('input[type=checkbox]'));
  if(box) return out('checkbox',box.querySelector('input[type=checkbox]'),{checked:box.querySelector('input[type=checkbox]').checked});
  const group=[...document.querySelectorAll('[role=group][aria-label]')].find((g)=>norm(g.getAttribute('aria-label'))===want);
  if(group){
    const picker=group.querySelector('input[type=file]');
    if(picker) return out('input',picker,{id:picker.id,type:'file',value:''});
    const chips=[...group.querySelectorAll('button')];
    if(chips.length) return out('group',group,{chips:chips.map((b)=>[b.innerText.trim(),b.getAttribute('aria-pressed')])});
    const opts=[...group.querySelectorAll('label')];
    if(opts.length) return out('options',group,{options:opts.map((l)=>[norm(l.innerText),!!l.querySelector('input:checked')])});
    const nums=[...group.querySelectorAll('input')];
    if(nums.length) return out('pair',group,{values:nums.map((i)=>i.value)});
  }
  const near=[...document.querySelectorAll('label')].find((l)=>norm(l.innerText).startsWith(want)&&!l.querySelector('input'));
  if(near){
    const scope=near.parentElement;
    const ctl=scope.querySelector('input:not([type=checkbox]),textarea,select');
    if(ctl){
      if(ctl.tagName==='TEXTAREA') return out('textarea',ctl,{id:ctl.id});
      if(ctl.tagName==='SELECT') return out('select',ctl,{id:ctl.id,value:ctl.value,options:[...ctl.options].map(o=>[o.value,o.text])});
      return out('input',ctl,{id:ctl.id,type:ctl.type,value:ctl.value,min:ctl.min,max:ctl.max});
    }
    const chips=[...scope.querySelectorAll('button')].filter((b)=>(b.innerText||'').trim());
    if(chips.length) return out('chiprow',scope,{chips:chips.map((b)=>[b.innerText.trim(),/chip-active/.test(b.className)])});
    const box=scope.querySelector('input[type=checkbox]');
    if(box) return out('checkbox',box,{checked:box.checked});
  }
  return out('none',null);
})()`;

const AT = (label) => {
  const want = JSON.stringify(String(label).toLowerCase());
  return `(()=>{const want=${want};const norm=(s)=>(s||'').replace(/\\s+/g,' ').trim().toLowerCase();
    const lab=[...document.querySelectorAll('label[for]')].find((l)=>norm(l.innerText)===want);
    const el=lab?document.getElementById(lab.getAttribute('for')):null;
    if(el) return el;
    const aria=[...document.querySelectorAll('[aria-label]')].find((e)=>{const n=norm(e.getAttribute('aria-label'));return n===want+' hex value'||n===want+' colour';});
    if(aria) return aria;
    const box=[...document.querySelectorAll('label')].find((l)=>norm(l.innerText)===want&&l.querySelector('input[type=checkbox]'));
    if(box) return box.querySelector('input[type=checkbox]');
    const g=[...document.querySelectorAll('[role=group][aria-label]')].find((x)=>norm(x.getAttribute('aria-label'))===want);
    if(g) return g.querySelector('input[type=file]') ?? g;
    const near=[...document.querySelectorAll('label')].find((l)=>norm(l.innerText).startsWith(want)&&!l.querySelector('input'));
    if(near){
      const scope=near.parentElement;
      const ctl=scope.querySelector('input:not([type=checkbox]),textarea,select');
      if(ctl) return ctl;
      if(scope.querySelectorAll('button').length) return scope;
      const box=scope.querySelector('input[type=checkbox]');
      if(box) return box;
    }
    return null})()`;
};

const describe = async (label) => JSON.parse(await ev(`${CONTROL(label)}`));

function print(c) {
  if (c.kind === 'none') return 'NO CONTROL';
  if (c.kind === 'checkbox') return `checked=${c.checked}`;
  if (c.kind === 'group' || c.kind === 'chiprow') return `${c.kind}: ${c.chips.map(([t, p]) => t + (p === 'true' || p === true ? '*' : '')).join('|')}`;
  if (c.kind === 'options') return `options: ${c.options.map(([t, p]) => t + (p ? '*' : '')).join('|')}`;
  if (c.kind === 'select') return `select=${c.value} of ${c.options.map(([v]) => v).join('/')}`;
  if (c.kind === 'pair') return `pair=${(c.values ?? []).join('x')}`;
  return `${c.type ?? 'input'}=${c.value}`;
}

async function setField(label, raw) {
  const at = AT(label);
  const before = await describe(label);
  if (before.kind === 'none') return { label, want: raw, before: 'NO CONTROL', after: 'NO CONTROL' };
  if (before.kind === 'group' || before.kind === 'chiprow') {
    const active = before.kind === 'group' ? "c.getAttribute('aria-pressed')==='true'" : '/chip-active/.test(c.className)';
    await ev(`(()=>{const g=${at};const chips=[...g.querySelectorAll('button')];
      const want=${JSON.stringify(String(raw).toLowerCase())};
      const chip = want==='toggle' ? chips.find((c)=>!(${active})) : chips.find((c)=>(c.innerText||'').toLowerCase().includes(want));
      if(!chip) return 'NO CHIP'; chip.click(); return 1;})()`);
  } else if (before.kind === 'options') {
    await ev(`(()=>{const g=${at};const norm=(s)=>(s||'').replace(/\\s+/g,' ').trim().toLowerCase();
      const want=${JSON.stringify(String(raw).toLowerCase())};
      const rows=[...g.querySelectorAll('label')];
      const row = want==='toggle' ? rows.find((l)=>!l.querySelector('input:checked')) : rows.find((l)=>norm(l.innerText).includes(want));
      if(!row) return 'NO OPTION'; row.querySelector('input[type=checkbox]').click(); return 1;})()`);
  } else if (before.kind === 'checkbox') {
    const invert = raw === 'toggle';
    const want = invert ? !before.checked : (raw === '1' || raw === 'true' || raw === 'on');
    await ev(`(()=>{const c=${at}; if(c.checked!==${want}) c.click(); return 1})()`);
  } else if (before.kind === 'select') {
    await ev(`(()=>{const s=${at};const want=${JSON.stringify(String(raw).toLowerCase())};
      const o=[...s.options].find((x)=>String(x.value).toLowerCase()===want)||[...s.options].find((x)=>(x.text||'').toLowerCase().includes(want));
      if(!o) return 'NO OPTION';
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,o.value);
      s.dispatchEvent(new Event('input',{bubbles:true})); s.dispatchEvent(new Event('change',{bubbles:true})); return 1;})()`);
  } else if (before.kind === 'textarea') {
    await ev(`(()=>{const t=${at};
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,${JSON.stringify(String(raw))});
      t.dispatchEvent(new Event('input',{bubbles:true})); t.dispatchEvent(new Event('change',{bubbles:true})); return 1;})()`);
  } else if (before.kind === 'input' && before.type === 'file') {
    // DOM.setFileInputFiles sets `files` but — measured on this Chromium build —
    // its event never reaches React here, so the field stays "Still needed" while
    // `files.length` reads 1. The reliable shape is what a drop does: assign
    // `DataTransfer.files` in-page and dispatch a bubbling `change`.
    const { readFileSync } = await import('node:fs');
    const b64 = readFileSync(String(raw)).toString('base64');
    const name = String(raw).split('/').pop();
    const kind = await ev(`(async()=>{const bin=atob(${JSON.stringify(b64)});const u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);const el=${AT(label)};if(!el)return 'NO CONTROL';const dt=new DataTransfer();dt.items.add(new File([u],${JSON.stringify(name)},{type:/\\.png$/i.test(${JSON.stringify(name)})?'image/png':/\\.jpe?g$/i.test(${JSON.stringify(name)})?'image/jpeg':'application/octet-stream'}));el.files=dt.files;el.dispatchEvent(new Event('change',{bubbles:true}));return 'set'})()`);
    await sleep(500);
    return { label, want: raw, before: 'file input', after: kind };
  } else {
    const numeric = before.type === 'range' || before.type === 'number';
    const written = numeric ? JSON.stringify(Number(raw)) : JSON.stringify(String(raw));
    await ev(`(()=>{const c=${at};
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(c,${written});
      c.dispatchEvent(new Event('input',{bubbles:true})); c.dispatchEvent(new Event('change',{bubbles:true})); return 1;})()`);
  }
  await sleep(200);
  return { label, want: raw, before: print(before), after: print(await describe(label)) };
}

await send('Page.enable');
await send('Network.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });

const summary = [];
for (const c of CASES) {
  requests = [];
  const localErrors = [];
  // A hash-only navigate does NOT reload the tab: the case would inherit the
  // previous form's uploads and field values (measured: `skip=5` leaked into the
  // next case as "skip first 1 covers all of them"). Force a real load.
  await send('Page.navigate', { url: `about:blank` });
  await sleep(150);
  await send('Page.navigate', { url: `${BASE}/#/tool/${c.tool}` });
  await wait(`!!document.querySelector('input[type=file]')`, 60000);
  await ev(`(()=>{window.__blobs=[];window.__blobUrls={};const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
  const { root } = await send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { files: c.pdfs ?? [c.pdf], nodeId });
  const btnReady = await wait(`[...document.querySelectorAll('button')].some(b=>new RegExp(${JSON.stringify(c.label)},'i').test((b.innerText||'').trim())&&!b.disabled)`, 60000);
  if (!btnReady) throw new Error(`${c.name}: no enabled button matching ${c.label} after upload`);

  const readback = [];
  const unfold = () => ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/more option/i.test(x.innerText||''));if(b)b.click();return !!b})()`);
  await unfold();
  await sleep(300);
  for (const [k, v] of Object.entries(c.fields || {})) {
    let r = await setField(k, String(v));
    if (r.after === 'NO CONTROL') { await unfold(); await sleep(300); r = await setField(k, String(v)); }
    readback.push(r);
  }

  const beforeCount = await ev('window.__blobs.length');
  const srcSize = (c.pdfs ?? [c.pdf]).reduce((n, f) => n + statSync(f).size, 0);
  const clicked = await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>new RegExp(${JSON.stringify(c.label)},'i').test((x.innerText||'').trim())&&!x.disabled);if(b){b.click();return b.innerText.trim()}return null})()`);
  let gotOut = false;
  if (clicked !== null) {
    await wait(`window.__blobs.length>${beforeCount} && window.__blobs.slice(${beforeCount}).some(b=>/^application\\/(pdf|zip)$/.test(b.type)&&b.size!==${srcSize})`, 60000);
    gotOut = await ev(`window.__blobs.slice(${beforeCount}).some(b=>/^application\\/(pdf|zip)$/.test(b.type)&&b.size!==${srcSize})`);
  }
  await sleep(800);
  if (c.shotForm) {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${OUTDIR}/${c.name}-form.png`, Buffer.from(s.data, 'base64'));
  }
  if (c.thumb) {
    await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^Page ${c.thumb}$/.test(x.getAttribute('aria-label')||''));if(b)b.click();return !!b})()`);
    await sleep(1500);
  }
  if (c.dark) { await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/dark/i.test(x.getAttribute('aria-label')||''));if(b)b.click();return !!b})()`); await sleep(600); }
  const s2 = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUTDIR}/${c.name}${c.thumb ? `-p${c.thumb}` : ''}.png`, Buffer.from(s2.data, 'base64'));
  let out = null;
  if (gotOut) {
    const info = await ev(`(async()=>{const i=window.__blobs.map((b,j)=>[b,j]).slice(${beforeCount}).find(([b])=>/^application\\/(pdf|zip)$/.test(b.type)&&b.size!==${srcSize});if(!i)return null;const b=i[0];const u=new Uint8Array(await b.arrayBuffer());let s='';for(let k=0;k<u.length;k+=8192)s+=String.fromCharCode.apply(null,u.subarray(k,k+8192));return JSON.stringify({size:u.length,type:b.type,b64:btoa(s)})})()`);
    if (info) {
      out = JSON.parse(info);
      writeFileSync(`${OUTDIR}/${c.name}.pdf`, Buffer.from(out.b64, 'base64'));
    }
  }
  const screen = await ev(`(document.body.innerText||'').slice(0,3000)`);
  const cross = requests.filter((r) => !r.url.startsWith(BASE) && !r.url.startsWith('data:') && !r.url.startsWith('blob:'));
  writeFileSync(`${OUTDIR}/${c.name}.json`, JSON.stringify({ readback, out: out && { size: out.size, type: out.type }, crossOrigin: cross, totalRequests: requests.length, screen }, null, 1));
  const line = { case: c.name, tool: c.tool, ran: gotOut, bytes: out?.size ?? 0, crossOrigin: cross, errors: localErrors };
  summary.push(line);
  console.log(JSON.stringify(line));
}
writeFileSync(`${OUTDIR}/round.jsonl`, summary.map((l) => JSON.stringify(l)).join('\n') + '\n');
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
