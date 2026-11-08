// Compare probe — drive the `compare-pdfs` route with TWO documents in real
// Chromium, read the verdict the pane publishes, and hand back the exported file.
//
//   BASE=https://www.browsersnip.com DIR=/tmp/compare node docs/research/compare-rail.mjs
//   BASE=http://localhost:5291 DIR=/tmp/compare PAGE=2 SHOT=/tmp/compare/pane.png \
//     node docs/research/compare-rail.mjs
//
// `colour-rail.mjs` is the model for the CDP half (hook `URL.createObjectURL`,
// `DOM.setFileInputFiles`, click the action, write the blob); what differs is that
// this route takes two files and has no rail form — `ToolWorkspace` mounts the
// bespoke panel for `compare-pdfs`, so the only action on the page is the panel's
// "Generate comparison PDF".
//
// It prints one JSON line per surface of the tool, because the defect this row had
// to explain was a disagreement between them: the verdict the pane publishes, and
// the file the export writes.
//
//   {"verdict":{...}}   what the user reads, plus ink measured off the pane's own
//                        canvas bitmaps (never off a node count)
//   {"export":{...}}     the downloaded file, its size and the button that wrote it
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5291';
const DIR = process.env.DIR || '/tmp/compare';
const A = process.env.A || `${DIR}/a.pdf`;
const B = process.env.B || `${DIR}/b.pdf`;
const OUT = process.env.OUT || `${DIR}/export.pdf`;
/** 1-based page of the pair to look at before the export runs. */
const PAGE = Number(process.env.PAGE || 1);
/** `pair` (default) loads a.pdf + b.pdf; `same` loads a.pdf twice; `blank` two empties. */
const CASE = process.env.CASE || 'pair';
const PORT = Number(process.env.PORT || 9811);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FILES_BY_CASE = {
  same: [A, A],
  blank: [`${DIR}/blank.pdf`, `${DIR}/blank.pdf`],
  pair: [A, B],
};
const FILES = FILES_BY_CASE[CASE] ?? FILES_BY_CASE.pair;

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/compare-${CASE}-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = id++;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => {
    if (pending.has(i)) {
      pending.delete(i);
      rej(new Error(`${method} #${i} unanswered: ${JSON.stringify(params).slice(0, 120)}`));
    }
  }, 30000);
});
const ev = async (expr) => {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result?.value;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  throw lastError;
};
const wait = async (expr, ms = 240000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(200); }
  return false;
};

/**
 * Everything the pane and its panel publish, plus the ink of the two page canvases.
 *
 * The canvas ink is the browser half of the campaign rule: a painted page measures
 * non-white pixels, an unpainted one does not, and the difference is not inferred
 * from a node count or a reported total. Canvas A is the first `canvas` inside
 * `[data-compare-scroll]`, canvas B the second; the third is the diff overlay.
 *
 * `opaque` and `ink` are counted apart, because they name two different failures:
 * an opaque sheet with no ink is a page that was painted and is empty (a blank
 * sheet, or a page whose source has nothing on it), while a sheet with 0 opaque px
 * is a canvas nobody ever drew into — transparent black, which a naive ink count
 * reads as 100 % ink.
 */
const READ_VERDICT = `(async()=>{
  const box=document.querySelector('[data-compare-scroll]');
  const all=box?[...box.querySelectorAll('canvas')]:[];
  // DOM order inside A's frame is [page A, overlay], then B's frame holds [page B];
  // the overlay is picked out by its own attribute rather than by index.
  const overlayEl=all.find((c)=>c.hasAttribute('data-compare-overlay'))||null;
  const canvases=all.filter((c)=>c!==overlayEl);
  const ink=(c)=>{
    if(!c||!c.width||!c.height) return null;
    let d;
    try { d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; } catch { return null; }
    let opaque=0,n=0,red=0;
    for(let i=0;i<d.length;i+=4){
      if(d[i+3]===0) continue;
      opaque++;
      if(d[i]<245||d[i+1]<245||d[i+2]<245) n++;
      if(d[i]-Math.max(d[i+1],d[i+2])>60) red++;
    }
    const total=d.length/4;
    return {opaque,opaquePct:Math.round(opaque/total*10000)/100,px:n,pct:Math.round(n/total*10000)/100,mark:red};
  };
  const num=(el,name)=>el?el.getAttribute(name):null;
  const status=document.querySelector('[role=status][data-compare-counts]');
  const panel=document.querySelector('[data-compare-diff]');
  const areas=[...document.querySelectorAll('[data-compare-area]')].map((el)=>el.getAttribute('data-compare-area'));
  const nums=areas.map((a)=>a.split(',').map(Number));
  return JSON.stringify({
    mounted:all.length,
    sizes:canvases.map((c)=>[c.width,c.height]),
    pageInk:canvases.map(ink),
    overlaySize:overlayEl?[overlayEl.width,overlayEl.height]:null,
    overlayInk:ink(overlayEl),
    verdictLine:status?status.innerText.trim():null,
    read:num(status,'data-compare-read'),
    counts:num(status,'data-compare-counts'),
    pixels:Number(num(status,'data-compare-pixels')??0),
    identical:num(status,'data-compare-identical'),
    panelPercent:panel?panel.innerText.trim():null,
    areas:nums,
    areaText:areas,
    panelIdentical:!!document.querySelector('[data-compare-identical]'),
    buttons:[...document.querySelectorAll('button')].map((b)=>[b.innerText.trim().slice(0,34),!b.disabled]).filter(([t])=>t),
  });
})()`;

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1150, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/compare-pdfs` });
if (!(await wait(`document.readyState === 'complete' && !!document.querySelector('input[type=file][multiple], input[type=file]')`, 90000))) {
  throw new Error('no file input on the route');
}
await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
const { root } = await send('DOM.getDocument', { depth: -1 });
const pick = await send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' });
let input = pick.nodeIds[0];
for (const candidate of pick.nodeIds) {
  const multiple = await ev(`(()=>{const i=document.querySelectorAll('input[type=file]')[${pick.nodeIds.indexOf(candidate)}];return i?!!i.multiple:false})()`);
  if (multiple) { input = candidate; break; }
}
await send('DOM.setFileInputFiles', { nodeId: input, files: FILES });
if (!(await wait(`!!document.querySelector('[data-compare-scroll]')`, 120000))) {
  console.log('screen:', JSON.stringify(await ev('(document.body.innerText||"").slice(0,900)')));
  throw new Error('the compare pane never mounted after two files were loaded');
}
// The verdict for `PAGE` — the pane only paints the page in view, so a page turn is
// driven the way a user drives it (the Next chip), not by writing to its store.
for (let p = 1; p < PAGE; p++) {
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Next/.test(x.innerText||''));if(!b||b.disabled) return 0;b.click();return 1})()`);
  await sleep(2500);
}
// `WARM=1` turns to the next page and back before reading anything. That is the
// experiment that separates "the pane cannot compute a verdict" from "the pane's
// first render never reached a canvas": the page-turn effect runs against mounted
// canvases, while the file-load effect used to run against the loading placeholder.
if (process.env.WARM) {
  const turn = (words) => ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>new RegExp(${JSON.stringify(words)},'i').test(x.innerText||''));if(!b||b.disabled) return 0;b.click();return 1})()`);
  const forward = Number(await turn('Next'));
  await sleep(2500);
  const back = forward ? Number(await turn('Prev')) : 0;
  if (back) await sleep(2500);
  console.log('warm', JSON.stringify({ turnedToNext: forward, turnedBack: back }));
}
await sleep(1500);
const verdict = JSON.parse(await ev(READ_VERDICT));
console.log('verdict', JSON.stringify(verdict));
if (process.env.VERDICT) writeFileSync(process.env.VERDICT, JSON.stringify(verdict, null, 1));

if (process.env.SHOT) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(process.env.SHOT, Buffer.from(shot.data, 'base64'));
  console.log('screenshot:', process.env.SHOT);
}

const clicked = await ev(`(()=>{
  const b=document.getElementById('tool-process-btn')
    ||[...document.querySelectorAll('button')].find(x=>/comparison/i.test(x.innerText||''));
  if(!b||b.disabled) return b?('disabled: '+b.innerText.trim()):'NO BUTTON';
  b.click(); return b.innerText.trim();
})()`);
console.log('export clicked', JSON.stringify(clicked));
if (!(await wait('window.__blobs.length>0', 240000))) {
  console.log('NO OUTPUT — the screen says:', JSON.stringify(await ev(`(document.body.innerText||'').slice(0,1400)`)));
  throw new Error('the comparison produced no output blob');
}
await sleep(1200);
const info = JSON.parse(await ev(`(async()=>{var b=window.__blobs.at(-1);var u=new Uint8Array(await b.arrayBuffer());var s='';for(var i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return JSON.stringify({type:b.type,size:u.length,b64:btoa(s)})})()`));
writeFileSync(OUT, Buffer.from(info.b64, 'base64'));
console.log('export', JSON.stringify({
  type: info.type, bytes: info.size, file: OUT, case: CASE, page: PAGE,
  report: await ev(`(document.body.innerText.match(/[^\\n]*(Compared|differ|page\\(s\\)|changed area)[^\\n]*/gi)||[]).slice(0,8).join(' ;; ')`),
}));
if (process.env.SHOT2) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(process.env.SHOT2, Buffer.from(shot.data, 'base64'));
  console.log('screenshot:', process.env.SHOT2);
}
console.log('console errors:', JSON.stringify([...new Set(errors)].slice(0, 3)));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
