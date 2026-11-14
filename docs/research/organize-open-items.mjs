// organize — the three items the ledger row left open, measured.
//
//   PORT=9830 BASE=http://localhost:5271 node docs/research/organize-open-items.mjs
//
// Stage A: a page whose own `/Rotate` is 90, turned once in the grid. Prints what
//          the card paints, what the plan string says and what `Save` writes, so
//          the turn/an-absolute-`/Rotate` disagreement is a number pair.
// Stage A2: the same page turned three times — "straighten" — and the spec the
//          pane publishes for it (the serialiser used to drop a zero turn).
// Stage B: a 2-entry outline and an annot+link sheet, exported, so the outline,
//         the `/Annots` and the `/D [page /Fit]` goto can be read off the file.
// Stage C: `multiple` on the file input, then a second drop, and whether the
//          second file became a source (tab, `f2:3` token, `Use as base`).
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const PORT = Number(process.env.PORT || 9830);
const DIR = process.env.DIR || '/tmp/r/open-items';
const ROT = process.env.ROT || '/tmp/triage/colour.pdf';
const BOOK = process.env.BOOK || '/tmp/triage/in/bookmarked.pdf';
const ANNOT = process.env.ANNOT || '/tmp/triage/in/annot.pdf';
mkdirSync(DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const wait = async (expr, ms = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(200); }
  return false;
};
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${DIR}/${name}.png`, Buffer.from(data, 'base64'));
};
const setFiles = async (paths) => {
  const { root } = await send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId, files: paths });
};
const SPEC = `(document.querySelector('#plan-order-field')||{}).value ?? null`;
const CARDS = `(()=>JSON.stringify([...document.querySelectorAll('[data-plan-card]')].map(c=>c.getAttribute('aria-label'))))()`;
const click = async (index) => {
  const b = JSON.parse(await ev(`(()=>{const c=document.querySelector('[data-plan-card="${index}"]');if(!c)return 'null';c.scrollIntoView({block:'nearest'});const r=c.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()`));
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: Math.round(b.x), y: Math.round(b.y), button: 'left', clickCount: 1 });
  }
};
const press = async (key, code, vk) => {
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  }
};
const grab = async (name) => {
  const got = await wait('window.__blobs.length>0', 60000);
  const b64 = await ev(`(async()=>{var b=window.__blobs.pop();if(!b)return null;var u=new Uint8Array(await b.arrayBuffer());var s='';for(var i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return btoa(s)})()`);
  const file = `${DIR}/${name}.pdf`;
  if (b64) writeFileSync(file, Buffer.from(b64, 'base64'));
  return { captured: got, file: b64 ? file : null, bytes: b64 ? Buffer.from(b64, 'base64').length : 0 };
};
const save = async () => {
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Save reordered PDF/.test(x.innerText||''));b.click();return 1})()`);
  await wait('window.__blobs.length>0', 60000);
  await sleep(400);
};
let hop = 0;
const open = async (paths) => {
  // A distinct URL per stage: navigating to the identical hash does not remount
  // the route, so a second stage would inherit the previous stage's file list.
  hop += 1;
  // The query goes *before* the hash: a hash-only change does not reload the
  // document, so the previous stage's file list would survive.
  await send('Page.navigate', { url: `${BASE}/?s=${hop}#/tool/organize` });
  await wait(`!!document.querySelector('input[type=file]')`);
  await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{if(b&&b.type==='application/pdf')window.__blobs.push(b);return o(b)};return 1})()`);
  await setFiles(paths);
  await wait(`document.querySelectorAll('[data-plan-card]').length >= 1`);
  await sleep(2500);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

// ── stage A: turn the page that already carries /Rotate 90 ─────────────────
await open([ROT]);
console.log('A before', await ev(SPEC));
console.log('A card 3 label', JSON.parse(await ev(CARDS))[3]);
await click(3);
await press('r', 'KeyR', 82);
await sleep(500);
console.log('A after one turn, card 3 label', JSON.parse(await ev(CARDS))[3]);
console.log('A spec', await ev(SPEC));
await shot('A-turned');
await save();
console.log('A export', JSON.stringify(await grab('A-turned')));
console.log('A export button still live', await ev(`!![...document.querySelectorAll('button')].find(x=>/Save reordered PDF/.test(x.innerText||''))`));

// ── stage A2: three more turns straighten it; what does the spec say ───────
await open([ROT]);
await click(3);
for (let i = 0; i < 3; i += 1) { await press('r', 'KeyR', 82); await sleep(250); }
console.log('A2 straightened card 3 label', JSON.parse(await ev(CARDS))[3]);
console.log('A2 spec', await ev(SPEC));
await shot('A2-straightened');
await save();
console.log('A2 export', JSON.stringify(await grab('A2-straightened')));

// ── stage B: outline and annots across a rebuild ───────────────────────────
await open([BOOK]);
await shot('B-bookmarked');
await save();
console.log('B export', JSON.stringify(await grab('B-bookmarked')));

await open([ANNOT]);
await save();
console.log('B2 export', JSON.stringify(await grab('B-annot')));

// ── stage C: is a second file a source at all? ─────────────────────────────
await open([ROT]);
console.log('C input.multiple', await ev(`document.querySelector('input[type=file]').multiple`));
console.log('C accept', await ev(`document.querySelector('input[type=file]').accept`));
console.log('C sources after one file', await ev(`document.querySelectorAll('[role="tab"]').length`));
await setFiles([ANNOT]);
await sleep(2500);
console.log('C cards after second drop', await ev(`document.querySelectorAll('[data-plan-card]').length`));
console.log('C sources after second drop', await ev(`document.querySelectorAll('[role="tab"]').length`));
console.log('C body text has a second tab?', (await ev(`document.body.innerText`)).includes('annot.pdf'));
console.log('C "Use as base" present', (await ev(`document.body.innerText`)).includes('Use as base'));
// Reach the grammar the second file unlocks: pick file 2 in the tray, then base
// the plan on it. The tokens must carry the file prefix and the grid must show
// the second document's pages.
console.log('C tray tabs', await ev(`document.querySelectorAll('[role="tab"]').length`));
await ev(`(()=>{const tabs=[...document.querySelectorAll('[role="tab"]')];tabs[1]&&tabs[1].click();return tabs.length})()`);
await sleep(500);
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Use as base/i.test(x.innerText||''));b&&b.click();return 1})()`);
await sleep(800);
console.log('C spec after "Use as base" on file 2', await ev(SPEC));
console.log('C cards now', await ev(`document.querySelectorAll('[data-plan-card]').length`));
await shot('C-second-drop');
// Tokens only: the grid, the card and the panel in dark mode.
await ev(`(()=>{const b=document.querySelector('button[aria-label="Switch to dark mode"]');b&&b.click();return 1})()`);
await sleep(500);
await shot('D-dark');
console.log('D dark card bg', await ev(`(()=>{const c=document.querySelector('[data-plan-card]');return c?getComputedStyle(c).backgroundColor:null})()`));
console.log('console errors', JSON.stringify([...new Set(errors)].slice(0, 6)));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
