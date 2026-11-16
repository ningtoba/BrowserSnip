// round 069 probe — png-to-pdf. Multi-file upload, card text before and after,
// the produced blob, and screenshots. Adapted from docs/research/rail-tool-bytes.mjs.
//
//   FILES=/tmp/r69/alpha.png,/tmp/r69/opaque.png OUT=/tmp/r69/before.pdf \
//     SHOT=/tmp/r69/card.png PORT=9835 node docs/research/png-to-pdf-round.mjs
//
// `document.body.innerText` comes back whole so the card's counts, warnings and
// notes are read off the screen rather than guessed; every blob the tool creates
// is captured through an `URL.createObjectURL` wrapper, so a refusal shows up as
// a screenshot plus the sentence instead of an empty file.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const TOOL = process.env.TOOL || 'png-to-pdf';
const FILES = (process.env.FILES || '').split(',').filter(Boolean);
const OUT = process.env.OUT || '/tmp/r69/out.pdf';
const PORT = Number(process.env.PORT || 9831);
const SHOT = process.env.SHOT || '';
const SHOT_BEFORE = process.env.SHOT_BEFORE || '';
const DARK = process.env.DARK || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/r69-profile-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
const wait = async (expr, ms = 180000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(300); }
  return false;
};
const shoot = async (path) => {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path, Buffer.from(shot.data, 'base64'));
  console.log('screenshot:', path);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/${TOOL}` });
await wait(`!!document.querySelector('input[type=file]')`, 60000);
await sleep(800);
if (DARK) {
  await ev(`(()=>{localStorage.setItem('browsersnip.theme','dark');document.documentElement.dataset.theme='dark';document.documentElement.classList.add('dark');return 1})()`);
  await sleep(400);
}
console.log('card before:', JSON.stringify((await ev(`(document.body.innerText||'')`)).slice(0, 2200)));
if (SHOT_BEFORE) await shoot(SHOT_BEFORE);
await ev(`(()=>{window.__blobs=[];window.__urls=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
const { root } = await send('DOM.getDocument', { depth: -1 });
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
await send('DOM.setFileInputFiles', { nodeId, files: FILES });
if (process.env.SHOT_PANE) {
  await sleep(600);
  await ev(`(()=>{const d=[...document.querySelectorAll('button')].find(x=>/^honest notes/i.test(x.innerText||''));if(d)d.click();return 1})()`);
  await sleep(400);
  await shoot(process.env.SHOT_PANE);
  await ev(`(()=>{const d=[...document.querySelectorAll('button')].find(x=>/^honest notes/i.test(x.innerText||''));if(d)d.click();return 1})()`);
}
const ok = await wait(`(()=>{const re=/Create PDF/i;return [...document.querySelectorAll('button')].some(b=>re.test(b.innerText||'')&&!b.disabled)})()`, 90000);
if (ok) {
  await ev(`(()=>{const re=/Create PDF/i;const b=[...document.querySelectorAll('button')].find(x=>re.test(x.innerText||'')&&!x.disabled);b.click();return 1})()`);
  await wait('window.__blobs.length>0 || /could not|not a PNG|Nothing could/i.test(document.body.innerText||"")', 120000);
  await sleep(2000);
  if (process.env.EXPAND_NOTES) {
    await ev(`(()=>{const d=[...document.querySelectorAll('button')].find(x=>/^honest notes/i.test(x.innerText||''));if(d)d.click();return 1})()`);
    await sleep(500);
  }
  if (SHOT) await shoot(SHOT);
  if (process.env.SHOT_DARK) {
    await ev(`(()=>{localStorage.setItem('browsersnip.theme','dark');document.documentElement.dataset.theme='dark';document.documentElement.classList.add('dark');return 1})()`);
    await sleep(600);
    await shoot(process.env.SHOT_DARK);
  }
  console.log('after:', JSON.stringify((await ev(`(document.body.innerText||'')`)).slice(0, 2600)));
  if (await ev('window.__blobs.length>0')) {
    const info = JSON.parse(await ev(`(async()=>{var b=window.__blobs.at(-1);var u=new Uint8Array(await b.arrayBuffer());var s='';for(var i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return JSON.stringify({type:b.type,size:u.length,b64:btoa(s)})})()`));
    writeFileSync(OUT, Buffer.from(info.b64, 'base64'));
    console.log('output', JSON.stringify({ type: info.type, bytes: info.size, file: OUT }));
  } else {
    console.log('NO OUTPUT');
  }
} else {
  console.log('button never enabled; screen:', JSON.stringify((await ev(`(document.body.innerText||'')`)).slice(0, 2000)));
  if (process.env.EXPAND_NOTES) {
    await ev(`(()=>{const d=[...document.querySelectorAll('button')].find(x=>/^honest notes/i.test(x.innerText||''));if(d)d.click();return 1})()`);
    await sleep(500);
  }
  if (SHOT) await shoot(SHOT);
  if (process.env.SHOT_DARK) {
    await ev(`(()=>{localStorage.setItem('browsersnip.theme','dark');document.documentElement.dataset.theme='dark';document.documentElement.classList.add('dark');return 1})()`);
    await sleep(600);
    await shoot(process.env.SHOT_DARK);
  }
}
console.log('console errors', JSON.stringify([...new Set(errors)].slice(0, 5)));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
