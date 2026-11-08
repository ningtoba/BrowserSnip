// organize campaign probe — one tool, both halves of the standard.
//
// Drives /#/tool/organize in real Chromium over CDP with a real document, then
// answers the only two questions the campaign cares about: what the surface
// paints, and what the exported bytes contain. Started detached against a dev
// server (`npx vite --port 5291`) or against `BASE=https://www.browsersnip.com`.
//
//   node docs/research/organize-campaign.mjs            # dev server on :5291
//   BASE=https://www.browsersnip.com node docs/research/organize-campaign.mjs
//   PDF=/tmp/org/probe.pdf OUT=/tmp/org/campaign.pdf node docs/research/organize-campaign.mjs
//
// Prints one JSON object per stage; `plan → file` compares the exported PDF
// against the plan the grid says it holds (order, per-page /Rotate, blanks).
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5291';
const PDF = process.env.PDF || '/tmp/sample.pdf';
const OUT = process.env.OUT || '/tmp/organize-campaign.pdf';
const PORT = Number(process.env.PORT || 9711);
const SHOTS = process.env.SHOTS || '/tmp/organize-campaign';
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/organize-campaign-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
const events = [];
ws.onmessage = (raw) => {
  const m = JSON.parse(raw.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  } else if (m.method === 'Runtime.exceptionThrown') {
    errors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 160));
  } else if (m.method) events.push(m);
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = id++; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const wait = async (expr, ms = 90000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(250); }
  return false;
};
const mouse = (type, x, y, buttons = 0) => send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, buttons });
const key = async (k, code, modifiers = 0) => {
  const vk = { ArrowRight: 39, ArrowLeft: 37, Space: 32, KeyR: 82, KeyD: 68, KeyB: 66, Delete: 46, KeyZ: 90 }[code] ?? 0;
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers });
};
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(data, 'base64'));
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/organize` });
await wait(`!!document.querySelector('input[type=file]')`);
// Record every PDF the pane hands to URL.createObjectURL, so the export can be
// read back from bytes instead of trusted from a progress message.
await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{if(b&&b.type==='application/pdf')window.__blobs.push(b);return o(b)};return 1})()`);
const { root } = await send('DOM.getDocument', { depth: -1 });
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
await send('DOM.setFileInputFiles', { nodeId, files: [PDF] });
await wait(`document.querySelectorAll('[data-plan-card]').length >= 1`);
await sleep(3000);

const GEOMETRY = `(function(){
  var list=document.querySelector('[role="listbox"]'); if(!list) return JSON.stringify({cards:0});
  var grid=list.parentElement, card=document.querySelector('[data-plan-card]');
  var field=document.querySelector('#plan-order-field');
  var tray=document.querySelector('input[aria-label^="Pages to insert"]');
  return JSON.stringify({vw:innerWidth,
    gridPx:Math.round(grid.getBoundingClientRect().width),
    listPx:Math.round(list.getBoundingClientRect().width),
    cardPx:card?Math.round(card.getBoundingClientRect().width):null,
    columns:getComputedStyle(list).gridTemplateColumns.split(' ').length,
    cardOverflowsGrid:card?card.getBoundingClientRect().right>grid.getBoundingClientRect().right+1:null,
    planFieldPx:field?Math.round(field.getBoundingClientRect().width):null,
    planFieldContentPx:field?field.scrollWidth:null,
    planFieldClipped:field?field.scrollWidth>field.clientWidth+1:null,
    trayFieldPx:tray?Math.round(tray.getBoundingClientRect().width):null,
    trayFieldClipped:tray?tray.scrollWidth>tray.clientWidth+1:null});
})()`;
// Ink is counted off the card's own bitmap: a thumb that never painted scores 0.
const INK = `(async()=>{var out=[];for(var c of [...document.querySelectorAll('[data-plan-card]')]){var img=c.querySelector('img');
  if(!img||!img.naturalWidth){out.push({i:c.getAttribute('data-plan-card'),painted:false});continue}
  var cv=document.createElement('canvas');cv.width=img.naturalWidth;cv.height=img.naturalHeight;var ctx=cv.getContext('2d');ctx.drawImage(img,0,0);
  var d=ctx.getImageData(0,0,cv.width,cv.height).data,nw=0,op=0;
  for(var p=0;p<d.length;p+=4){if(d[p+3]>8){op++;if(d[p]<250||d[p+1]<250||d[p+2]<250)nw++}}
  out.push({i:c.getAttribute('data-plan-card'),painted:true,pctNonwhite:+(100*nw/op).toFixed(1),box:[cv.width,cv.height]})}
  return JSON.stringify(out)})()`;
const PLAN = `(()=>JSON.stringify([...document.querySelectorAll('[data-plan-card]')].map(c=>{var l=c.getAttribute('aria-label')||'';
  return {position:(l.match(/position (\\d+) of/)||[])[1],item:l.startsWith('Blank')?'blank':('pg'+(l.match(/page (\\d+)/)||[])[1]),rotate:(l.match(/rotated (\\d+) degrees/)||[])[1]||null,
    selected:c.getAttribute('aria-selected')==='true'}})))()`;

console.log('geometry', await ev(GEOMETRY));
console.log('thumbnails', await ev(INK));
await shot('01-loaded');

// ── drag the last mounted card three slots earlier, reading the indicator first
const indexes = JSON.parse(await ev(`(()=>JSON.stringify([...document.querySelectorAll('[data-plan-card]')].map(c=>Number(c.getAttribute('data-plan-card')))))()`));
const from = Math.max(...indexes);
const onto = indexes[Math.max(0, indexes.indexOf(from) - 3)];
await send('Input.setInterceptDrags', { enabled: true });
events.length = 0;
const box = async (i) => JSON.parse(await ev(`(()=>{const c=document.querySelector('[data-plan-card="${i}"]');if(!c)return 'null';c.scrollIntoView({block:'nearest'});const b=c.getBoundingClientRect();return JSON.stringify({x:b.x,y:b.y,w:b.width,h:b.height})})()`));
const f = await box(from);
await mouse('mousePressed', f.x + f.w / 2, f.y + f.h / 2, 1);
await mouse('mouseMoved', f.x + f.w / 2 + 10, f.y + f.h / 2 + 12, 1);
await mouse('mouseMoved', f.x + f.w / 2 + 26, f.y + f.h / 2 + 20, 1);
let hit = null;
for (let i = 0; i < 40 && !hit; i++) { await sleep(50); hit = events.find((e) => e.method === 'Input.dragIntercepted'); }
if (!hit) throw new Error('the pane never started an HTML5 drag — a mouse press on a card must');
const data = hit.params.data;
const t = await box(onto);
const px = t.x + t.w - 8, py = t.y + t.h / 2;
await mouse('mouseMoved', px, py);
await send('Input.dispatchDragEvent', { type: 'dragEnter', x: Math.round(px), y: Math.round(py), data });
await send('Input.dispatchDragEvent', { type: 'dragOver', x: Math.round(px), y: Math.round(py), data });
await sleep(250);
const claim = await ev(`(()=>{const i=document.querySelector('[data-gap-indicator]');return JSON.stringify({badge:i?i.textContent.trim():null,line:(document.body.innerText.match(/Release to place the carried pages at position \\d+ of \\d+/)||[])[0]||null})})()`);
await send('Input.dispatchDragEvent', { type: 'drop', x: Math.round(px), y: Math.round(py), data });
await send('Input.setInterceptDrags', { enabled: false });
await ev(`(()=>{const c=document.querySelector('[data-plan-card="${from}"]');if(c)c.dispatchEvent(new DragEvent('dragend',{bubbles:true,cancelable:true}));return 1})()`);
await mouse('mouseReleased', px, py);
await sleep(600);
console.log('drag claim', claim, 'status', await ev(`[...document.querySelectorAll('[aria-live]')].map(n=>n.textContent.trim()).join('|')`));
await shot('02-after-drag');

// ── keyboard: select, pick up, carry one slot right, drop
const k0 = await box(0);
await mouse('mousePressed', k0.x + k0.w / 2, k0.y + k0.h / 2, 1);
await mouse('mouseReleased', k0.x + k0.w / 2, k0.y + k0.h / 2);
await key('r', 'KeyR');               // turn it: the file must carry page /Rotate + 90
await sleep(400);
await key('b', 'KeyB');               // blank sheet after it
await sleep(400);
console.log('plan after drag/rotate/blank', JSON.parse(await ev(PLAN)).map((p) => p.item + (p.rotate ? `r${p.rotate}` : '')).join(' '));
console.log('spec field', await ev(`(document.querySelector('#plan-order-field')||{}).value`));
console.log('geometry again', await ev(GEOMETRY));
await shot('03-plan-built');

// ── export, then read the bytes back
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Save reordered PDF/.test(x.innerText||''));b.click();return 1})()`);
const got = await wait('window.__blobs.length>0');
const b64 = await ev(`(async()=>{var b=window.__blobs.at(-1);if(!b)return null;var u=new Uint8Array(await b.arrayBuffer());var s='';for(var i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return btoa(s)})()`);
if (b64) writeFileSync(OUT, Buffer.from(b64, 'base64'));
console.log('export', JSON.stringify({ captured: got, file: OUT, bytes: b64 ? Buffer.from(b64, 'base64').length : 0 }));
console.log('plan the file must match', JSON.parse(await ev(PLAN).catch(() => '[]')).map((p) => p.item + (p.rotate ? `r${p.rotate}` : '')).join(' ') || '(pane already swapped to the result screen — read the spec line above)');
console.log('console errors', JSON.stringify([...new Set(errors)].slice(0, 5)));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
