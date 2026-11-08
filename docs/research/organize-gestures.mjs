// organize gesture sweep — every interaction the campaign lists, in one real
// Chromium session, printing the plan the surface shows after each one.
//
//   node docs/research/organize-gestures.mjs
//   BASE=https://www.browsersnip.com PDF=/tmp/sample.pdf node docs/research/organize-gestures.mjs
//
// The last line is the plan string; feed it and the download to
// `organize-campaign-bytes.py` to ask whether the file is the plan.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5291';
const PDF = process.env.PDF || '/tmp/sample.pdf';
const OUT = process.env.OUT || '/tmp/organize-gestures.pdf';
const PORT = Number(process.env.PORT || 9741);
const SHOTS = process.env.SHOTS || '/tmp/organize-gestures';
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/organize-gestures-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
const mouse = (type, x, y, buttons = 0, modifiers = 0) => send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, buttons, modifiers });
const click = async (x, y, modifiers = 0) => { await mouse('mousePressed', x, y, 1, modifiers); await mouse('mouseReleased', x, y, 0, modifiers); };
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
await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{if(b&&b.type==='application/pdf')window.__blobs.push(b);return o(b)};return 1})()`);
const { root } = await send('DOM.getDocument', { depth: -1 });
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
await send('DOM.setFileInputFiles', { nodeId, files: [PDF] });
await wait(`document.querySelectorAll('[data-plan-card]').length >= 1`);
await sleep(3000);

const PLAN = `(()=>JSON.stringify([...document.querySelectorAll('[data-plan-card]')].map(c=>{var l=c.getAttribute('aria-label')||'';
  return (l.startsWith('Blank')?'blank':('pg'+(l.match(/page (\\d+)/)||[])[1]))+((l.match(/rotated (\\d+) degrees/)||[])[1]?('r'+(l.match(/rotated (\\d+) degrees/)||[])[1]):'')})))()`;
const SPEC = `(document.querySelector('#plan-order-field')||{}).value`;
const SELECTED = `[...document.querySelectorAll('[data-plan-card]')].filter(c=>c.getAttribute('aria-selected')==='true').length`;
const STATUS = `[...document.querySelectorAll('[aria-live]')].map(n=>n.textContent.trim()).join('|')`;
const box = async (i) => JSON.parse(await ev(`(()=>{const c=document.querySelector('[data-plan-card="${i}"]');if(!c)return 'null';c.scrollIntoView({block:'center'});const b=c.getBoundingClientRect();return JSON.stringify({x:b.x,y:b.y,w:b.width,h:b.height,cx:b.x+b.width/2,cy:b.y+b.height/2,hit:document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)?.closest('[data-plan-card]')?.getAttribute('data-plan-card')})})()`));
const step = async (name) => {
  const plan = JSON.parse(await ev(PLAN));
  console.log(`${name.padEnd(24)} ${plan.join(' ')}`);
  console.log(`${''.padEnd(24)}   selected ${await ev(SELECTED)} · status: ${(await ev(STATUS)).slice(0, 120)}`);
  await shot(name.replace(/[^a-z0-9]+/gi, '-').toLowerCase());
  return plan;
};

console.log('gesture sweep against', BASE, 'with', PDF, '— each line is the plan the grid paints');
await step('00 loaded');

// 1. drag: last mounted card onto the right half of the card three slots earlier
const mounted = JSON.parse(await ev(`(()=>JSON.stringify([...document.querySelectorAll('[data-plan-card]')].map(c=>Number(c.getAttribute('data-plan-card')))))()`));
const from = Math.max(...mounted);
const onto = mounted[Math.max(0, mounted.indexOf(from) - 3)];
await send('Input.setInterceptDrags', { enabled: true });
events.length = 0;
const fb = await box(from);
await mouse('mousePressed', fb.cx, fb.cy, 1);
await mouse('mouseMoved', fb.cx + 12, fb.cy + 14, 1);
await mouse('mouseMoved', fb.cx + 28, fb.cy + 22, 1);
let hit = null;
for (let i = 0; i < 40 && !hit; i++) { await sleep(50); hit = events.find((e) => e.method === 'Input.dragIntercepted'); }
if (!hit) throw new Error('no HTML5 drag was started by a mouse press on a card');
const data = hit.params.data;
const tb = await box(onto);
const px = tb.x + tb.w - 8, py = tb.y + tb.h / 2;
await mouse('mouseMoved', px, py);
await send('Input.dispatchDragEvent', { type: 'dragEnter', x: Math.round(px), y: Math.round(py), data });
await send('Input.dispatchDragEvent', { type: 'dragOver', x: Math.round(px), y: Math.round(py), data });
await sleep(250);
const claim = await ev(`(()=>{const i=document.querySelector('[data-gap-indicator]');return i?i.textContent.trim():null})()`);
await send('Input.dispatchDragEvent', { type: 'drop', x: Math.round(px), y: Math.round(py), data });
await send('Input.setInterceptDrags', { enabled: false });
await ev(`(()=>{const c=document.querySelector('[data-plan-card="${from}"]');if(c)c.dispatchEvent(new DragEvent('dragend',{bubbles:true,cancelable:true}));return 1})()`);
await mouse('mouseReleased', px, py);
await sleep(600);
console.log(`drag: indicator said ${claim}`);
await step('01 drag reorder');

// 2. keyboard reorder: focus a card, Space, arrow right twice, Space
const k = await box(0);
await click(k.cx, k.cy);
await sleep(250);
await key(' ', 'Space');
await key('ArrowRight', 'ArrowRight');
await key('ArrowRight', 'ArrowRight');
await sleep(200);
await key(' ', 'Space');
await sleep(500);
await step('02 keyboard carry');

// 3. multi-select: click one card, Shift-click two further, rotate the group
const m0 = await box(1);
const m2 = await box(3);
await click(m0.cx, m0.cy);
await sleep(200);
await click(m2.cx, m2.cy, 8);
await sleep(250);
console.log(`shift-range selected ${await ev(SELECTED)} cards`);
await key('r', 'KeyR');
await sleep(500);
await step('03 rotate multi-select');

// 4. duplicate the group
await key('d', 'KeyD');
await sleep(500);
await step('04 duplicate group');

// 5. insert a blank sheet after the group
await key('b', 'KeyB');
await sleep(500);
await step('05 insert blank');

// 6. delete one page through its own card button
const delTitle = await ev(`(()=>{const c=document.querySelector('[data-plan-card="0"]');const b=[...c.querySelectorAll('button')].find(x=>/\\u2715/.test(x.innerText));b.click();return b.title})()`);
await sleep(500);
console.log(`card button: ${delTitle}`);
await step('06 delete via card button');

// 7. undo twice, redo once
await key('z', 'KeyZ', 2);
await sleep(400);
await step('07 undo');
await key('z', 'KeyZ', 2);
await sleep(400);
await step('08 undo again');
await key('Z', 'KeyZ', 2 + 8);
await sleep(400);
await step('09 redo');

// 8. export
const spec = await ev(SPEC);
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Save reordered PDF/.test(x.innerText||''));b.click();return 1})()`);
const got = await wait('window.__blobs.length>0');
const b64 = await ev(`(async()=>{var b=window.__blobs.at(-1);if(!b)return null;var u=new Uint8Array(await b.arrayBuffer());var s='';for(var i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return btoa(s)})()`);
if (b64) writeFileSync(OUT, Buffer.from(b64, 'base64'));
console.log(`export captured=${got} bytes=${b64 ? Buffer.from(b64, 'base64').length : 0} → ${OUT}`);
console.log('plan to check:', spec);
console.log('verify with:  python3 docs/research/organize-campaign-bytes.py', PDF, OUT, JSON.stringify(spec));
console.log('console errors', JSON.stringify([...new Set(errors)].slice(0, 5)));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
