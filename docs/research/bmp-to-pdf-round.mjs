// round 070 probe — bmp-to-pdf. Upload BMPs, read the card text back off the
// screen, capture every produced blob, and then do the cross-format control on
// jpg-to-pdf with a real BMP in the same tab.
//
//   FILES=/tmp/r70/up24.bmp,/tmp/r70/pal8.bmp OUT=/tmp/r70/before.pdf \
//     SHOT=/tmp/r70/before-card.png CROSS=/tmp/triage/in/photo.bmp \
//     PORT=9821 node docs/research/bmp-to-pdf-round.mjs
//
// Adapted from docs/research/png-to-pdf-round.mjs (same blob wrapper, same
// read-back of `document.body.innerText`, same screenshot route).
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const TOOL = process.env.TOOL || 'bmp-to-pdf';
const FILES = (process.env.FILES || '').split(',').filter(Boolean);
const OUT = process.env.OUT || '/tmp/r70/out.pdf';
const PORT = Number(process.env.PORT || 9821);
const SHOT = process.env.SHOT || '';
const SHOT_BEFORE = process.env.SHOT_BEFORE || '';
const SHOT_DARK = process.env.SHOT_DARK || '';
const CROSS = (process.env.CROSS || '').split(',').filter(Boolean);
const CROSS_SHOT = process.env.CROSS_SHOT || '';
const CROSS_OUT = process.env.CROSS_OUT || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/r70-profile-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
const expandNotes = async () => {
  await ev(`(()=>{const d=[...document.querySelectorAll('button')].find(x=>/^honest notes/i.test(x.innerText||''));if(d)d.click();return 1})()`);
  await sleep(400);
};

/** One upload-and-press on the current page. Returns the card text. */
const drive = async (files, shot, dark, out, label) => {
  await wait(`!!document.querySelector('input[type=file]')`, 60000);
  await sleep(700);
  console.log(`${label} card:`, JSON.stringify((await ev(`(document.body.innerText||'')`)).slice(0, 4000)));
  if (shot && shot.before) await shoot(shot.before);

  await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
  const { root } = await send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId, files });
  if (process.env.SHOT_PANE && label === 'bmp') {
    // The notes panel only exists once the job holds a file.
    await wait(`[...document.querySelectorAll('button')].some(x=>/^honest notes/i.test(x.innerText||''))`, 20000);
    await sleep(600);
    await expandNotes();
    await shoot(process.env.SHOT_PANE);
    console.log('notes panel:', JSON.stringify((await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^honest notes/i.test(x.innerText||''));return b?b.parentElement.innerText:''})()`)).slice(0, 2500)));
  }
  const ok = await wait(`(()=>{const re=/Create PDF/i;return [...document.querySelectorAll('button')].some(b=>re.test(b.innerText||'')&&!b.disabled)})()`, 90000);
  if (ok) {
    await ev(`(()=>{const re=/Create PDF/i;const b=[...document.querySelectorAll('button')].find(x=>re.test(x.innerText||'')&&!x.disabled);b.click();return 1})()`);
    await wait('window.__blobs.length>0 || /could not|not a BMP|Nothing|left out/i.test(document.body.innerText||"")', 120000);
    await sleep(2500);
    if (process.env.EXPAND_NOTES) await expandNotes();
    if (shot && shot.after) await shoot(shot.after);
    if (dark) { await ev(`(()=>{localStorage.setItem('browsersnip.theme','dark');document.documentElement.dataset.theme='dark';document.documentElement.classList.add('dark');return 1})()`); await sleep(600); await shoot(dark); }
    console.log(`${label} after:`, JSON.stringify((await ev(`(document.body.innerText||'')`)).slice(0, 3000)));
    if (out && await ev('window.__blobs.length>0')) {
      const info = JSON.parse(await ev(`(async()=>{var b=window.__blobs.at(-1);var u=new Uint8Array(await b.arrayBuffer());var s='';for(var i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return JSON.stringify({type:b.type,size:u.length,b64:btoa(s)})})()`));
      writeFileSync(out, Buffer.from(info.b64, 'base64'));
      console.log('output', JSON.stringify({ type: info.type, bytes: info.size, file: out }));
    } else {
      console.log('NO OUTPUT');
    }
  } else {
    console.log(`${label} button never enabled; screen:`, JSON.stringify((await ev(`(document.body.innerText||'')`)).slice(0, 2400)));
    if (shot && shot.after) await shoot(shot.after);
    if (dark) { await ev(`(()=>{localStorage.setItem('browsersnip.theme','dark');document.documentElement.dataset.theme='dark';document.documentElement.classList.add('dark');return 1})()`); await sleep(600); await shoot(dark); }
  }
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/${TOOL}` });
await drive(FILES, { before: SHOT_BEFORE, after: SHOT }, SHOT_DARK, OUT, 'bmp');

if (CROSS.length) {
  await send('Page.navigate', { url: `${BASE}/#/tool/jpg-to-pdf` });
  await wait('1', 2000);
  await drive(CROSS, { after: CROSS_SHOT }, '', CROSS_OUT, 'cross');
}
console.log('console errors', JSON.stringify([...new Set(errors)].slice(0, 5)));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
