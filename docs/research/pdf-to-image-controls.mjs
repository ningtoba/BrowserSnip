// pdf-to-image control probe — drive the *rail fields*, not just the button.
//
//   BASE=https://www.browsersnip.com PDF=/tmp/p2i/sheets.pdf \
//     PAGES=all FORMAT=png DPI=200 OUT=/tmp/p2i/deploy-200.png.zip \
//     node docs/research/pdf-to-image-controls.mjs
//
// `rail-tool-bytes.mjs` clicks the rail's action with whatever the defaults are,
// which is why `rasterize-pdf`'s row could not reach the PNG branch and this row
// starts by being able to: the campaign asks whether `dpi`, the format choice, the
// JPEG quality and a page selection *move the output*, and none of that is
// reachable without setting a segmented control, a range and a text field.
//
// Every field is written the way a user's event reaches React (native value setter
// + bubbling `input`/`change`), then read back out of the DOM before the run, so a
// control the app ignored is reported rather than assumed. The produced blob is
// handed back as bytes; `pdf-to-image-ink.py` measures them.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5277';
const TOOL = process.env.TOOL || 'pdf-to-image';
const PDF = process.env.PDF || '/tmp/p2i/sheets.pdf';
const OUT = process.env.OUT || '/tmp/p2i/out.zip';
const PORT = Number(process.env.PORT || 9781);
const LABEL = process.env.LABEL || 'Export images';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** What to set, in order: `FORMAT`/`DPI`/`QUALITY`/`PAGES`/`ZIP`. */
const WANTED = [
  ['format', process.env.FORMAT],
  ['dpi', process.env.DPI],
  ['quality', process.env.QUALITY],
  ['pages', process.env.PAGES],
  ['zip', process.env.ZIP],
].filter(([, value]) => value !== undefined && value !== '');

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/p2i-${TOOL}-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
  // A CDP call that never answers must not hang the run: say which one it was.
  setTimeout(() => {
    if (pending.has(i)) {
      pending.delete(i);
      rej(new Error(`${method} #${i} unanswered: ${JSON.stringify(params).slice(0, 120)}`));
    }
  }, 30000);
});
const ev = async (expr) => {
  // Three tries, because the rail opens a pdf.js session and mounts a thumbnail
  // strip the moment a file lands; a dev-server reload or a superseded execution
  // context quietly destroys a pending `Runtime.evaluate`, and a probe that hangs
  // reports nothing at all.
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
const wait = async (expr, ms = 180000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(200); }
  return false;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/${TOOL}` });
if (!(await wait(`document.readyState === 'complete' && !!document.querySelector('input[type=file]')`, 90000))) {
  throw new Error('no file input on the route');
}
await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
const { root } = await send('DOM.getDocument', { depth: -1 });
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
await send('DOM.setFileInputFiles', { nodeId, files: [PDF] });

// The rail folds everything but its lead field behind "N more options".
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/more option/i.test(x.innerText||''));if(b)b.click();return !!b})()`);
await sleep(400);

/**
 * Write the fields and read them back.
 *
 * `labelFor` finds the control a human reads the name next to, so a field that is
 * present but disconnected from the value layer shows up as `readBack` ≠ asked.
 */
const SETTERS = {
  format: (value) => `(()=>{
    const group=[...document.querySelectorAll('[role=group][aria-label]')].find(g=>/file format/i.test(g.getAttribute('aria-label')));
    if(!group) return 'NO GROUP';
    const chip=[...group.querySelectorAll('button')].find(b=>b.innerText.trim().toUpperCase()===${JSON.stringify(value.toUpperCase())});
    if(!chip) return 'NO CHIP';
    chip.click();
    return 'clicked='+chip.innerText.trim();
  })()`,
  pages: (value) => setByLabel('Pages', String(value)),
  dpi: (value) => setByLabel('Resolution', Number(value)),
  quality: (value) => setByLabel('JPEG quality', Number(value)),
  zip: (value) => `(()=>{
    const want=${JSON.stringify(value)}==='1';
    const lab=[...document.querySelectorAll('label')].find(l=>/zip when there is more than one/i.test(l.innerText||''));
    const box=lab?.querySelector('input[type=checkbox]')||[...document.querySelectorAll('input[type=checkbox]')].find(i=>/zip/i.test(i.closest('label')?.innerText||''));
    if(!box) return 'NO CHECKBOX';
    if(box.checked!==want){box.click();}
    return 'checked='+box.checked;
  })()`,
};

/** What the app actually holds after each write — the control, read back. */
const READBACK = {
  format: () => `(()=>{const g=[...document.querySelectorAll('[role=group][aria-label]')].find(x=>/file format/i.test(x.getAttribute('aria-label')));return 'aria-pressed='+(g?[...g.querySelectorAll('button')].filter(b=>b.getAttribute('aria-pressed')==='true').map(b=>b.innerText.trim()).join('|'):'NO GROUP')})()`,
  pages: () => readValueByLabel('Pages'),
  dpi: () => readValueByLabel('Resolution'),
  quality: () => readValueByLabel('JPEG quality'),
  zip: () => `(()=>{const l=[...document.querySelectorAll('label')].find(x=>/zip when there is more than one/i.test(x.innerText||''));const b=l&&l.querySelector('input[type=checkbox]');return b?'checked='+b.checked:'NO CHECKBOX'})()`,
};

function readValueByLabel(label) {
  return `(()=>{const lab=[...document.querySelectorAll('label[for]')].find(l=>(l.innerText||'').trim().toLowerCase()===${JSON.stringify(label.toLowerCase())});const input=lab&&document.getElementById(lab.getAttribute('for'));return input?'value='+input.value:'NO INPUT'})()`;
}

/** React owns `value`; write through the prototype setter and fire both events. */
function setByLabel(label, value) {
  // Numbers are written as literals, strings get quoted once — double-encoding
  // here is how a `pages=all` run ended up holding the text `"all"`, which the
  // picker refused and the rail disabled Export for.
  const assignment = typeof value === 'number' ? String(value) : JSON.stringify(value);
  return `(()=>{
    const lab=[...document.querySelectorAll('label[for]')].find(l=>(l.innerText||'').trim().toLowerCase()===${JSON.stringify(label.toLowerCase())});
    const input=lab&&document.getElementById(lab.getAttribute('for'));
    if(!input) return 'NO INPUT for ${label}';
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    set.call(input,${assignment});
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new Event('change',{bubbles:true}));
    return 'value='+input.value;
  })()`;
}

const applied = [];
for (const [key, value] of WANTED) {
  const action = await ev(SETTERS[key](value));
  // React re-renders on the next tick, so the *state it now holds* is read after
  // the click rather than inside it: a chip read in the same task as its own
  // `click()` still reports the previous selection, which is how a control that
  // works could be reported as one that does not.
  await sleep(250);
  const readBack = await ev(READBACK[key] ? READBACK[key]() : 'unchanged');
  applied.push(`${key}=${value} → ${action}; state now ${readBack}`);
}
console.log('fields:', JSON.stringify(applied));
console.log('screen spec:', await ev(`(document.body.innerText.match(/\\d+ of \\d+ pages picked|all \\d+ pages picked/)||['-'])[0]`));

if (!(await wait(`(()=>{const re=new RegExp(${JSON.stringify(LABEL)},'i');return [...document.querySelectorAll('button')].some(b=>re.test(b.innerText||'')&&!b.disabled)})()`, 60000))) {
  // Dump what the page does offer: a missing action button is usually the file
  // never reaching the store, and "disabled" is not the same news as "absent".
  console.log('buttons:', JSON.stringify(await ev(`JSON.stringify([...document.querySelectorAll('button')].map(b=>[b.innerText.trim().slice(0,28),!b.disabled]))`)));
  console.log('screen:', JSON.stringify(await ev(`(document.body.innerText||'').slice(0,900)`)));
  throw new Error(`no enabled button matching ${LABEL} after loading ${PDF}`);
}
// What the rail says it will do, before it does it: the summary line is the app's
// own reading of the fields, so a control that never reached the value layer
// disagrees with this rather than with an assumption.
console.log('rail summary:', await ev(`(document.body.innerText.match(/[^\\n]*(dpi|PNG|JPG|WEBP|TIFF|BMP)[^\\n]*/g)||[]).slice(0,4).join(' ;; ')`));
console.log('clicked:', await ev(`(()=>{const re=new RegExp(${JSON.stringify(LABEL)},'i');const b=[...document.querySelectorAll('button')].find(x=>re.test(x.innerText||'')&&!x.disabled);b.click();return b.innerText.trim()})()`));
if (!(await wait('window.__blobs.length>0', 180000))) {
  console.log('NO OUTPUT — the screen says:', JSON.stringify(await ev(`(document.body.innerText||'').slice(0,1200)`)));
  throw new Error('the tool produced no output blob');
}
await sleep(1000);
// The screen half of the campaign's rule: the result card holding the pages it
// just exported, so "inked" is also visible and not only counted.
if (process.env.SHOT) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(process.env.SHOT, Buffer.from(shot.data, 'base64'));
  console.log('screenshot:', process.env.SHOT);
}
const info = JSON.parse(await ev(`(async()=>{var b=window.__blobs.at(-1);var u=new Uint8Array(await b.arrayBuffer());var s='';for(var i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return JSON.stringify({type:b.type,size:u.length,b64:btoa(s)})})()`));
writeFileSync(OUT, Buffer.from(info.b64, 'base64'));
console.log('output:', JSON.stringify({ type: info.type, bytes: info.size, file: OUT }));
console.log('report line:', await ev(`(document.body.innerText.match(/[^\\n]*(image|page|zip|dpi)[^\\n]*/gi)||[]).slice(0,6).join(' ;; ')`));
console.log('console errors:', JSON.stringify([...new Set(errors)].slice(0, 3)));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
