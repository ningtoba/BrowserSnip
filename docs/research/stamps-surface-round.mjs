// `add-stamps` on its own surface, measured: pick the stamp in the inspector, arm the
// pen, click a placement per page, write the inspector's opacity / size / colour,
// export, and keep both the download and the overlay's own DOM.
//
//   CASES=/tmp/lane-edit/c5/cases-st.json PORT=9837 OUTDIR=/tmp/lane-edit/c5 \
//     BASE=http://localhost:5291 node docs/research/stamps-surface-round.mjs
//
// Per case: upload, pick the stamp kind from the panel's select, arm the stamp pen,
// click a fraction of the sheet on each listed page (advancing the editor's page
// strip), write the labelled opacity / size / colour controls, optionally type a
// Placements string, read the overlay's DOM back, export, and keep the download.
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5291';
const PORT = Number(process.env.PORT || 9837);
const OUTDIR = process.env.OUTDIR || '/tmp/lane-edit/c5';
const CASES = JSON.parse(readFileSync(process.env.CASES, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/stampsurf-${PORT}`, 'about:blank'], { stdio: 'ignore' });
let ws;
for (let i = 0; i < 60 && !ws; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch { await sleep(300); }
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
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') errors.push(String(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 200));
  if (m.method === 'Network.requestWillBeSent') {
    const r = m.params.request;
    requests.push({ url: r.url, method: r.method, bodyBytes: (r.postData || '').length });
  }
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = id++; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return 'PAGEERR ' + String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 240);
  return r.result?.value;
};
const wait = async (expr, ms = 120000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { } await sleep(250); } return false; };
const mouse = (type, x, y, b = 0) => send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, buttons: b });
const click = async (x, y) => { await mouse('mousePressed', x, y, 1); await sleep(60); await mouse('mouseReleased', x, y, 0); };

/** Write a labelled panel control (opacity slider, size number, colour input). */
const setControl = async (label, value, kind = 'range') => {
  if (value === undefined || value === null || value === '') return `${label}: untouched`;
  const did = await ev(`(() => {
    const want = ${JSON.stringify(label.toLowerCase())};
    const pick = () => {
      if (${JSON.stringify('KIND')} === 'number') return [...document.querySelectorAll('input[type=number]')].filter((i) => i.offsetParent)
        .find((n) => (n.closest('label')?.innerText || n.parentElement?.parentElement?.innerText || '').toLowerCase().includes(want));
      if (${JSON.stringify(kind)} === 'color') return [...document.querySelectorAll('input[type=color]')].filter((i) => i.offsetParent)
        .find((n) => (n.closest('label')?.innerText || n.parentElement?.parentElement?.innerText || '').toLowerCase().includes(want));
      const ranges = [...document.querySelectorAll('input[type=range]')].filter((i) => i.offsetParent);
      return ranges.find((r) => (r.closest('label')?.innerText || r.parentElement?.parentElement?.innerText || '').toLowerCase().trim().startsWith(want))
        ?? (document.querySelectorAll('[data-mark]').length > 0 ? ranges[0] : undefined);
    };
    const el = pick();
    if (!el) return 'no ' + ${JSON.stringify(label)} + ' control';
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  })()`);
  await sleep(350);
  return `${label}: ${JSON.stringify(value)} -> ${JSON.stringify(did)}`;
};

const summary = [];
await send('Page.enable');
await send('Network.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });

for (const c of CASES) {
  requests = [];
  const record = { case: c.name, readback: [], errors: [] };
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(150);
  await send('Page.navigate', { url: `${BASE}/#/tool/add-stamps${c.probe ? `?probe=${c.probe}` : ''}` });
  await wait(`!!document.querySelector('input[type=file]')`, 60000);
  await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
  const { root } = await send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { files: [c.pdf], nodeId });
  const armed = await wait(`!!document.querySelector('[data-tool="stamp"]')`, 60000);
  if (!armed) throw new Error(`${c.name}: the stamp pen never appeared`);
  await sleep(2500);
  record.panel = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('select,input,textarea')]
    .filter((e)=>e.offsetParent)
    .map((e)=>({tag:e.tagName.toLowerCase(),type:e.type||'',label:(e.closest('label')?.innerText||e.getAttribute('aria-label')||(e.parentElement?.parentElement?.innerText||'')).replace(/\\s+/g,' ').trim().slice(0,44),value:String(e.value).slice(0,24),options:e.tagName==='SELECT'?[...e.options].map((o)=>o.text).slice(0,24):undefined})))`));

  if (c.stamp) {
    record.readback.push(`stamp: ${JSON.stringify(await ev(`(() => {
      const wanted = ${JSON.stringify(String(c.stamp))}.toLowerCase();
      for (const select of [...document.querySelectorAll('select')].filter((s) => s.offsetParent)) {
        const option = [...select.options].find((o) => (o.text || '').toLowerCase() === wanted);
        if (!option) continue;
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, option.value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return 'selected ' + option.text;
      }
      return 'no select offering ' + wanted;
    })()`))}`);
    await sleep(700);
  }
  if (c.image) {
    const b64 = readFileSync(c.image).toString('base64');
    record.readback.push(`image: ${JSON.stringify(await ev(`(async()=>{const bin=atob(${JSON.stringify(b64)});const u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);
      const el=[...document.querySelectorAll('input[type=file]')].find((x)=>x.closest('[role=group]'));
      if(!el) return 'no image picker';
      const dt=new DataTransfer();dt.items.add(new File([u],'logo.png',{type:'image/png'}));el.files=dt.files;
      el.dispatchEvent(new Event('change',{bubbles:true}));return 'set '+el.files.length})()`))}`);
    await sleep(1200);
  }
  if (c.placements !== undefined) {
    record.readback.push(`placements: ${JSON.stringify(await ev(`(() => {
      const els = [...document.querySelectorAll('input[type=text],input:not([type]),textarea')].filter((e) => e.offsetParent);
      const el = els.find((e) => (e.closest('label')?.innerText || e.parentElement?.parentElement?.innerText || '').toLowerCase().includes('placement'))
        ?? els.find((e) => /page:\\d/.test(e.value || ''));
      if (!el) return 'no placements control';
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(c.placements))});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'written ' + el.value;
    })()`))}`);
    await sleep(500);
  }

  const pages = c.pages ?? [1];
  let current = 1;
  for (const page of pages) {
    while (current < page) {
      const spot = JSON.parse(await ev(`(() => {
        const nodes = [...document.querySelectorAll('button,a,[role=button],span,div')]
          .filter((b) => b.offsetParent && /^Next/.test((b.innerText || '').trim()));
        if (!nodes.length) return 'null';
        const r = nodes[nodes.length - 1].getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
      })()`));
      if (spot === null) throw new Error(`${c.name}: no Next control to reach page ${page}`);
      await click(spot.x, spot.y);
      current += 1;
      await sleep(1100);
    }
    await ev(`document.querySelector('[data-tool="stamp"]').click()`);
    await sleep(450);
    const box = JSON.parse(await ev(`(() => {
      const sheet = document.querySelector('[data-tool-gesture]') || document.querySelector('[data-page-extent]');
      const r = sheet.getBoundingClientRect();
      return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
    })()`));
    const [fx, fy] = c.click ?? [0.82, 0.08];
    await click(box.x + box.w * fx, box.y + box.h * fy);
    await sleep(800);
    record.readback.push(`placed on p.${current} at ${fx}/${fy} of a ${Math.round(box.w)}x${Math.round(box.h)} sheet`);
  }

  record.readback.push(await setControl('Opacity', c.opacity, 'range'));
  record.readback.push(await setControl('Size', c.size, 'number'));
  record.readback.push(await setControl('Colour', c.colour, 'color'));
  await sleep(400);
  record.marks = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-mark]')].map((m)=>{
    const r=m.getBoundingClientRect();return {rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],html:m.outerHTML.slice(0,160)}}))`));
  record.extents = await ev(`[...document.querySelectorAll('[data-page-extent]')].map((e)=>e.getAttribute('data-page-extent')).join('|')`);

  if (c.dark) {
    await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/dark/i.test(x.getAttribute('aria-label')||''));if(b)b.click();return !!b})()`);
    await sleep(700);
  }
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUTDIR}/${c.name}${c.dark ? '-dark' : ''}.png`, Buffer.from(shot.data, 'base64'));
  if (c.canvas) {
    const grab = await ev(`(()=>{const cv=[...document.querySelectorAll('canvas')].sort((a,b)=>b.width*b.height-a.width*a.height)[0];
      if(!cv) return JSON.stringify({missing:true});
      const r=cv.getBoundingClientRect();
      try{return JSON.stringify({w:cv.width,h:cv.height,css:[r.x,r.y,r.width,r.height],png:cv.toDataURL('image/png')})}
      catch(e){return JSON.stringify({error:String(e&&e.message||e)})}})()`);
    const g = JSON.parse(grab);
    if (g.png) {
      writeFileSync(`${OUTDIR}/${c.name}-canvas.png`, Buffer.from(g.png.split(',')[1], 'base64'));
      writeFileSync(`${OUTDIR}/${c.name}-canvas.json`, JSON.stringify({ w: g.w, h: g.h, css: g.css }));
    } else {
      record.canvasError = g;
    }
  }

  const before = await ev('window.__blobs.length');
  record.export = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /Export annotated PDF/i.test(x.innerText || ''));
    if (!b) return 'missing';
    if (b.disabled) return 'disabled: ' + (b.title || '');
    const label = b.innerText.trim(); b.click(); return label;
  })()`);
  if (!String(record.export).startsWith('disabled')) {
    await wait(`window.__blobs.length > ${before} && [...window.__blobs].slice(${before}).some(b=>b&&/application\\/pdf/.test(b.type)&&b.size!==${statSync(c.pdf).size})`, 180000);
    const info = await ev(`(async()=>{const fresh=[...window.__blobs].slice(${before}).filter((x)=>x&&typeof x.arrayBuffer==='function'&&/application\\/pdf/.test(x.type)&&x.size!==${statSync(c.pdf).size});
      fresh.sort((a,b)=>b.size-a.size);const b=fresh[0];if(!b)return null;
      const u=new Uint8Array(await b.arrayBuffer());let s='';for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));
      return JSON.stringify({size:u.length,b64:btoa(s)})})()`);
    if (info) {
      const parsed = JSON.parse(info);
      writeFileSync(`${OUTDIR}/${c.name}.pdf`, Buffer.from(parsed.b64, 'base64'));
      record.bytes = parsed.size;
    }
  }
  await sleep(600);
  record.status = await ev(`document.querySelector('[data-editor-status]')?.innerText ?? null`);
  record.screen = await ev(`(document.body.innerText||'').slice(0,3000)`);
  record.crossOrigin = requests.filter((r) => !r.url.startsWith(BASE) && !/^data:|^blob:/.test(r.url));
  record.errors = [...new Set(errors)].slice(0, 4);
  writeFileSync(`${OUTDIR}/${c.name}.json`, JSON.stringify(record, null, 1));
  summary.push({ case: c.name, bytes: record.bytes ?? 0, export: record.export, marks: (record.marks || []).length, status: record.status, cross: record.crossOrigin.length });
  console.log(JSON.stringify(summary[summary.length - 1]));
}
writeFileSync(`${OUTDIR}/round.jsonl`, summary.map((l) => JSON.stringify(l)).join('\n') + '\n');
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
