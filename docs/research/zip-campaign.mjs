// ZIP container probe — drive `pdfs-to-zip` with N files in real Chromium, capture
// the archive it writes plus a screenshot of the pane/card, and hand both back.
//
//   BASE=http://localhost:5271 FILES='/tmp/r020/colour.pdf,/tmp/r020/sheets.pdf' \
//     SHOT=/tmp/r020/base.png OUT=/tmp/r020/base.zip PORT=9821 \
//     node docs/research/zip-campaign.mjs
//
// The rail-tool driver (`rail-tool-bytes.mjs`) loads exactly one file; this tool is
// a container, so its evidence lives in the archive: every entry name and its
// compression method come from the central directory (`unzip -v`), and every entry
// is extracted and SHA-256'd against its input by the caller.
//
// `DROP='name@/path;name2@/path2'` delivers the files through a synthetic drop
// instead of the file input, so a name the *page* must handle can be set exactly —
// `../evil.pdf` cannot exist on disk, and a non-ASCII path does not survive
// `DOM.setFileInputFiles` in this Chromium (the FileList comes back empty).
//
// `PASSWORD` types the job's one open password into the row's lock box the way a
// keystroke arrives (native setter + `input`), and waits for the lock to clear.
//
// CASE=base|single|dupe|odd|locked|noreport
//   base     the two corpus files
//   single   only the first file (the card's one-file note)
//   dupe     the first file twice (clash handling)
//   odd      names with spaces and unicode, and `../`-style names, from FILES
//   locked   the two locked fixtures (they must go in as-is)
//   noreport the manifest toggle off
//
// Prints one JSON line: the pane's words, the card's numbers and the archive's own
// central directory, so a disagreement between them is measurable.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const TOOL = process.env.TOOL || 'pdfs-to-zip';
const FILES = (process.env.FILES || '').split(',').filter(Boolean);
const DROP = (process.env.DROP || '').split(';').filter(Boolean).map((pair) => {
  const at = pair.lastIndexOf('@');
  return { name: pair.slice(0, at), path: pair.slice(at + 1) };
});
const LABEL = process.env.LABEL || 'Pack ZIP';
const OUT = process.env.OUT || '';
const SHOT = process.env.SHOT || '';
const PORT = Number(process.env.PORT || 9821);
const CASE = process.env.CASE || 'base';
const TIMEOUT = Number(process.env.TIMEOUT || 120000);
if (FILES.length === 0 && DROP.length === 0) throw new Error('FILES or DROP is required');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  // Fresh profile per run: the app keeps the loaded queue in IndexedDB, so a reused
  // directory hands the next run the previous run's files.
  `--user-data-dir=/tmp/zip-${CASE}-${PORT}-${Date.now()}`, 'about:blank'], { stdio: 'ignore' });
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
    errors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 300));
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = id++;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(`${method} unanswered`)); } }, 30000);
});
const ev = async (expr) => {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result?.value;
    } catch (error) { last = error; await sleep(300); }
  }
  throw last;
};
const wait = async (expr, ms = TIMEOUT) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(250); }
  return false;
};
const shot = async (file) => {
  await sleep(400);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(data, 'base64'));
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/${TOOL}` });
await wait(`!!document.querySelector('input[type=file]')`, 60000);
await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
if (DROP.length > 0) {
  const { readFileSync } = await import('node:fs');
  const payload = DROP.map(({ name, path: file }) => ({ name, b64: readFileSync(file).toString('base64') }));
  const dropIn = async (items) => ev(`(()=>{const items=${JSON.stringify(items)}.map(({name,b64})=>{const raw=atob(b64);const u=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)u[i]=raw.charCodeAt(i);return new File([u],name,{type:'application/pdf'})});const dt=new DataTransfer();for(const f of items)dt.items.add(f);window.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));return items.map(f=>f.name)})()`);
  await dropIn(payload).then((names) => console.log('dropped', JSON.stringify(names)));
  // A second drop: the intake copy says further files "join this job in order", so
  // the earlier queue must survive it.
  const SECOND = (process.env.DROP2 || '').split(';').filter(Boolean).map((pair) => {
    const at = pair.lastIndexOf('@');
    return { name: pair.slice(0, at), b64: readFileSync(pair.slice(at + 1)).toString('base64') };
  });
  if (SECOND.length > 0) {
    await sleep(2500);
    await dropIn(SECOND).then((names) => console.log('dropped2', JSON.stringify(names)));
  }
} else {
  const { root } = await send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId, files: FILES });
}
// Queue settled: the rail must list one row per file and enable the action.
// The queue gets bounded time of its own: a file the app never finishes reading
// leaves the action disabled, and that is a finding, not a harness stall.
const loaded = await wait(`(()=>{const re=new RegExp(${JSON.stringify(LABEL)},'i');return [...document.querySelectorAll('button')].some(b=>re.test(b.innerText||'')&&!b.disabled)})()`, Number(process.env.LOAD_MS || 30000));
const queueAt = await ev(`(()=>[...document.querySelectorAll('li')].map(n=>(n.innerText||'').trim()).filter(Boolean).slice(0,10))()`);
if (!loaded) {
  const text = await ev(`(document.body.innerText||'').slice(0,1600)`);
  console.log(JSON.stringify({ case: CASE, notQueued: true, files: FILES, drop: DROP.map((d) => d.name), queue: queueAt, screen: text }));
  if (SHOT) await shot(SHOT);
  ws.close(); chrome.kill('SIGKILL');
  process.exit(0);
}
// The manifest toggle: flip it the way a user's click arrives, then read it back.
if (CASE === 'noreport') {
  const flipped = await ev(`(()=>{const re=/manifest/i;const el=[...document.querySelectorAll('button[role=switch],input[type=checkbox],[role=switch]')].find(n=>re.test((n.closest('label,div')||n).innerText||''));if(!el)return 'none';el.click();return el.getAttribute('aria-checked')??String(el.checked)})()`);
  console.log(JSON.stringify({ case: CASE, toggleAfterClick: flipped }));
}
// NOTES=1 opens the notes disclosure so the note text is in the capture.
if (process.env.NOTES) {
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/honest notes/i.test(x.innerText||''));if(b)b.click();return 1})()`);
  await sleep(500);
}
const queue = await ev(`(()=>[...document.querySelectorAll('[data-testid=file-row],[class*=file-row],li')].map(n=>(n.innerText||'').trim()).filter(Boolean).slice(0,10))()`);
if (SHOT) await shot(SHOT.replace(/\.png$/, '-queued.png'));
// DARK=1 flips the theme before anything is dropped (the surface is UI, so the
// brief wants it seen in dark too; tokens only, no hex).
if (process.env.DARK) {
  await ev(`(()=>{const b=document.querySelector('button[aria-label*=theme i],button[aria-label*=dark i],button[title*=theme i]');if(b){b.click();return 1}return 0})()`);
  await sleep(600);
}
const btnExpression = `(()=>{const re=new RegExp(${JSON.stringify(LABEL)},'i');const b=[...document.querySelectorAll('button')].find(x=>re.test(x.innerText||'')&&!x.disabled);b.click();return b.innerText.trim()})()`;
const PASSWORD = process.env.PASSWORD || '';
const typePassword = async () => {
  const boxes = await ev(`document.querySelectorAll('input[type=password]').length`);
  if (PASSWORD && boxes > 0) {
    await ev(`(()=>{const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;for(const i of document.querySelectorAll('input[type=password]')){set.call(i,${JSON.stringify(PASSWORD)});i.dispatchEvent(new Event('input',{bubbles:true}))}return 1})()`);
    // The box settles before the lock probe re-reads: wait for READY/STOPPED.
    await wait(`(()=>{const t=document.body.innerText;return !/PASSWORD FOR THIS FILE/.test(t)||/READY|STOPPED/.test(t)})()`, 15000);
    await sleep(1200);
  }
  return boxes;
};
await typePassword().then((n) => console.log(JSON.stringify({ case: CASE, passwordBoxes: n })));
const btn = await ev(btnExpression);
if (!(await wait('window.__blobs.length>0', TIMEOUT))) {
  const text = await ev(`(document.body.innerText||'').slice(0,1600)`);
  console.log(JSON.stringify({ case: CASE, noOutput: true, queue: queueAt, screen: text }));
  if (SHOT) await shot(SHOT);
  ws.close(); chrome.kill('SIGKILL');
  process.exit(0);
}
await sleep(1500);
const info = JSON.parse(await ev(`(async()=>{var b=window.__blobs.at(-1);var u=new Uint8Array(await b.arrayBuffer());var s='';for(var i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return JSON.stringify({type:b.type,size:u.length,b64:btoa(s)})})()`));
if (OUT) writeFileSync(OUT, Buffer.from(info.b64, 'base64'));
// The result pane and the card, as the user reads them, with the ink of the card.
const screen = await ev(`(document.body.innerText||'').slice(0,4000)`);
const entryList = await ev(`(()=>[...document.querySelectorAll('li,[data-entry],[class*=entry]')].map(n=>(n.innerText||'').trim()).filter(Boolean).slice(0,40))()`);
if (SHOT) await shot(SHOT);
console.log(JSON.stringify({
  case: CASE, button: btn, queue, bytes: info.size, type: info.type, out: OUT || null, shot: SHOT || null,
  screen, entryList, consoleErrors: [...new Set(errors)].slice(0, 3),
}));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
