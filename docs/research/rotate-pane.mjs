// rotate — the pane half of the round: what the screen shows *before* a run, so
// the angle the picker paints can be compared with the angle the file gets.
//
//   PORT=9831 BASE=http://localhost:5271 node docs/research/rotate-pane.mjs
//
// Stage A: colour.pdf, page 4 (its own `/Rotate` is 90) picked in the strip and
//          270 written on the Rotation field. Screenshots the pane before the
//          click and prints each tile's `data-turn-to`, so a preview showing the
//          source orientation can be read against the `/Rotate` 0 the run writes.
// Stage B: the run itself — the card's sentence, the download, and a screenshot.
// Stage C: the same source again with one 90° turn, to read the card's sentence
//          for a page that is not straightened.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const PORT = Number(process.env.PORT || 9831);
const DIR = process.env.DIR || '/tmp/r/rot';
const PDF = process.env.PDF || '/tmp/triage/colour.pdf';
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
    if (m.error) rej(new Error(JSON.stringify(m.error)));
    else res(m.result);
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
const click = async (selector) => {
  const box = JSON.parse(await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return 'null';e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2})})()`));
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: Math.round(box.x), y: Math.round(box.y), button: 'left', clickCount: 1 });
  }
};
const pickChip = async (words) => {
  await ev(`(()=>{const g=[...document.querySelectorAll('[role=group][aria-label]')].find((x)=>x.getAttribute('aria-label')==='Rotation');
    if(!g) return 'NO GROUP';
    const c=[...g.querySelectorAll('button')].find((b)=>(b.innerText||'').includes(${JSON.stringify(words)}));
    if(!c) return 'NO CHIP'; c.click(); return 'clicked '+c.innerText.trim()})()`);
};
const TILES = `JSON.stringify([...document.querySelectorAll('[data-thumb]')].map((e)=>[e.getAttribute('aria-label'),e.dataset.thumb,e.dataset.turnTo??null]))`;
const runIt = async (name) => {
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find((x)=>/^Rotate$/.test((x.innerText||'').trim())&&!x.disabled); if(b) b.click(); return !!b})()`);
  const got = await wait('window.__blobs && window.__blobs.length>0', 60000);
  const b64 = await ev(`(async()=>{var b=window.__blobs.pop();if(!b)return null;var u=new Uint8Array(await b.arrayBuffer());var s='';for(var i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return btoa(s)})()`);
  if (b64) writeFileSync(`${DIR}/${name}.pdf`, Buffer.from(b64, 'base64'));
  const words = await ev(`(document.body.innerText||'').replace(/\\n{2,}/g,'\\n').slice(0,900)`);
  await shot(`${name}-card`);
  return { got, bytes: b64 ? Buffer.from(b64, 'base64').length : 0, words };
};
const upload = async () => {
  const { root } = await send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId, files: [PDF] });
  await sleep(2000);
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find((x)=>/MORE OPTION/i.test(x.innerText||''));if(b)b.click();return !!b})()`);
  await wait(`document.querySelectorAll('[data-thumb]').length>0`, 30000);
  await sleep(1200);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1300, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/rotate` });
await wait(`!!document.querySelector('input[type=file]')`, 60000);
await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
await upload();

// Stage A — page 4 (its own /Rotate is 90) picked, 270 chosen. The sum is 0.
// The field starts at `all`, so a tile click *deselects*; `none` first is the
// route to a one-sheet job, and the all-selected preview is measured as it is.
console.log('tiles at rest (all picked):', await ev(TILES));
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='none');if(b)b.click();return !!b})()`);
await sleep(900);
console.log('tiles with none picked:', await ev(TILES));
await click('[aria-label^="Page 4"]');
await sleep(500);
await pickChip('270');
await sleep(2500);
console.log('tiles with 270 on page 4:', await ev(TILES));
console.log('footer:', JSON.stringify(await ev(`(()=>{const s=[...document.querySelectorAll('span')].map((x)=>x.innerText||'').find((x)=>/selected$|pick pages/.test(x));return s||null})()`)));
console.log('headings:', JSON.stringify(await ev(`[...document.querySelectorAll('h4')].map((h)=>h.innerText)`)));
await shot('pane-270-page4');
console.log('pane before the run:', JSON.stringify((await ev(`(document.body.innerText||'').replace(/\\n{2,}/g,'\\n').slice(0,900)`))));

// Stage B — the run.
const first = await runIt('after270-p4');
console.log('run 1:', first.got, first.bytes, JSON.stringify(first.words));

// Stage C — the same sheet, one 90° turn: the sum is 180, which is not a straighten.
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find((x)=>/Do another/i.test(x.innerText||''));if(b)b.click();return !!b})()`);
await wait(`!!document.querySelector('input[type=file]')`, 60000);
await upload();
await wait(`document.body.innerText.includes('READY')`, 30000);
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim()==='none');if(b)b.click();return !!b})()`);
await sleep(900);
await click('[aria-label^="Page 4"]');
await sleep(500);
await pickChip('90');
await wait(`(()=>{const b=[...document.querySelectorAll('button')].find((x)=>/^Rotate$/.test((x.innerText||'').trim()));return !!b && !b.disabled})()`, 20000);
await sleep(800);
console.log('tiles with 90 on page 4:', await ev(TILES));
const second = await runIt('after90-p4');
console.log('run 2:', second.got, second.bytes, JSON.stringify(second.words));

console.log('console errors:', JSON.stringify(errors));
chrome.kill('SIGKILL');
process.exit(0);
