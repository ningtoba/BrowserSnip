// Drive `flatten-pdf` in one real Chromium tab: upload, flip the toggles it is
// asked about (each read back out of the DOM before the run), press Flatten, keep
// every download, the card's words and, on request, the pane that shows the file.
//
//   PDF=/tmp/r055/variants.pdf OUT=/tmp/r055/after.pdf \
//     FLIP='keepLinks' SHOT=/tmp/r055/shot.png ZOOM=3 node docs/research/flatten-round.mjs
//
// A bespoke probe because the rail's three toggles print sentences ("Flatten
// comments", "Keep clickable links"), not the field keys, so `colour-rail.mjs`
// cannot address them by key and a run would silently go ahead on the defaults.
// The controls are clicked by those printed words and the state is read back.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const PORT = Number(process.env.PORT || 9826);
const PDF = process.env.PDF;
const OUT = process.env.OUT;
const SHOT = process.env.SHOT;
const DARK = process.env.DARK === '1';
const FLIP = (process.env.FLIP || '').split(',').filter(Boolean);
const RUNS = Number(process.env.RUNS || 1);
if (!PDF || !OUT) throw new Error('PDF and OUT are required');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LABELS = { forms: 'Flatten form fields', annotations: 'Flatten comments', keepLinks: 'Keep clickable links' };

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/flatten-${PORT}`, 'about:blank'], { stdio: 'ignore' });
let ws;
for (let i = 0; i < 60 && !ws; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch { /* not up yet */ }
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
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(300); }
  return false;
};
const shot = async (path) => {
  if (!path) return;
  const png = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path, Buffer.from(png.data, 'base64'));
  console.log('screenshot:', path);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/flatten-pdf` });
await wait(`!!document.querySelector('input[type=file]')`, 60000);
await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)}
  ${DARK ? "document.documentElement.classList.add('dark');try{localStorage.setItem('browsersnip:theme','dark')}catch{}" : ''}
  return 1})()`);
const { root } = await send('DOM.getDocument', { depth: -1 });
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
await send('DOM.setFileInputFiles', { nodeId, files: [PDF] });
if (!await wait(`[...document.querySelectorAll('button')].some(b=>/^Flatten$/.test(b.innerText.trim())&&!b.disabled)`, 90000)) {
  console.log('screen says:', JSON.stringify(await ev(`(document.body.innerText||'').slice(0,1200)`)));
  await shot(SHOT);
  throw new Error('the rail never offered an enabled Flatten button');
}
// Each toggle, clicked by its printed sentence, then read back off the checkbox.
// The rail folds two of the three behind a "N MORE OPTIONS" disclosure, so that
// is opened first — a flip that reads NO CONTROL otherwise leaves the default on.
for (const key of FLIP) {
  if (await ev(`[...document.querySelectorAll('button')].some(b=>/MORE OPTIONS/.test(b.innerText))`)) {
    await ev(`[...document.querySelectorAll('button')].find(b=>/MORE OPTIONS/.test(b.innerText)).click()`);
    await sleep(300);
  }
  const on = await ev(`(()=>{const label=${JSON.stringify(LABELS[key])};
    const body=[...document.querySelectorAll('label')].find(l=>l.innerText.trim().startsWith(label));
    if(!body) return 'NO CONTROL';
    const box=body.querySelector('input[type=checkbox]');
    box.click();
    return label+'='+(box.checked?'on':'off')})()`);
  console.log('flipped:', on, '| read back:', await ev(`(()=>{const label=${JSON.stringify(LABELS[key])};
    const body=[...document.querySelectorAll('label')].find(l=>l.innerText.trim().startsWith(label));
    const box=body&&body.querySelector('input[type=checkbox]');return box?(box.checked?'on':'off'):'NO CONTROL'})()`));
}
console.log('toggles:', JSON.stringify(await ev(`[...document.querySelectorAll('input[type=checkbox]')].map(b=>[b.closest('label')?.innerText.trim().slice(0,40),b.checked])`)));
// The pane before the run shows the input the way a viewer does: needed when the
// claim is "the page looks the same afterwards" and the ink is translucent.
await shot(process.env.SHOT_BEFORE);
for (let run = 1; run <= RUNS; run++) {
  const before = await ev('window.__blobs.length');
  await ev(`[...document.querySelectorAll('button')].find(b=>/^Flatten$/.test(b.innerText.trim())&&!b.disabled).click()`);
  if (!await wait(`window.__blobs.length>${before}`, 150000)) {
    console.log('NO OUTPUT — the screen says:', JSON.stringify(await ev(`(document.body.innerText||'').slice(0,1400)`)));
    await shot(SHOT);
    throw new Error('the tool produced no output blob');
  }
  await sleep(1200);
  const card = await ev(`(()=>{const c=document.querySelector('section[aria-label="Result"]');return c?c.innerText:(document.body.innerText||'').slice(0,1600)})()`);
  console.log(`card ${run}:`, JSON.stringify(card));
  const info = JSON.parse(await ev(`(async()=>{const b=window.__blobs.at(-1);const u=new Uint8Array(await b.arrayBuffer());let s='';for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return JSON.stringify({size:u.length,b64:btoa(s)})})()`));
  const path = RUNS > 1 ? OUT.replace(/\.pdf$/, `-${run}.pdf`) : OUT;
  writeFileSync(path, Buffer.from(info.b64, 'base64'));
  console.log(`output ${run}:`, path, info.size);
  // Zoom the preview the card holds so the baked ink can be looked at close.
  if (process.env.ZOOM) {
    // The bar is behind hover: a query without a pointer over the pane finds no
    // zoom control at all (measured).
    const box = await ev(`(()=>{const p=document.querySelector('[aria-label="Page preview"]')||document.querySelector('canvas');if(!p)return null;const r=p.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
    if (box) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(box[0]), y: Math.round(box[1]) });
    await sleep(400);
    for (let i = 0; i < Number(process.env.ZOOM); i++) {
      // Ctrl + wheel is the app's own zoom-to-cursor; the bar itself only renders
      // while the pointer is over the pane, which a headless click cannot promise.
      if (box) await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(box[0]), y: Math.round(box[1]), deltaX: 0, deltaY: -120, modifiers: 2 });
      await sleep(200);
    }
    for (let i = 0; i < Number(process.env.ZOOM); i++) {
      const hit = await ev(`(()=>{const b=document.querySelector('[aria-label="Zoom in"]');if(!b)return 'NO ZOOM';b.click();return 'zoomed'})()`);
      await sleep(250);
      if (hit === 'NO ZOOM') { console.log('no zoom control'); break; }
    }
    console.log('zoom now:', await ev(`(()=>{const el=[...document.querySelectorAll('button')].map(b=>b.getAttribute('aria-label')).filter(Boolean);return el.includes('Zoom in')?'ok':'?'})()`));
    console.log('zoom label:', await ev(`(()=>{const t=document.body.innerText.match(/\\d+\\s*%/);return t?t[0]:'none'})()`));
    await sleep(600);
  }
  await shot(SHOT);
}
await sleep(200);
console.log('console errors', JSON.stringify([...new Set(errors)].slice(0, 3)));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
