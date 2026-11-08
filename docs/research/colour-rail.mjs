// Colour-tool rail probe — drive the *fields* of `invert-colors`,
// `adjust-colors` and `scanner-effect` in real Chromium and hand back the download.
//
//   BASE=http://localhost:5291 TOOL=adjust-colors LABEL='Adjust colors' \
//     PDF=/tmp/colour/colour.pdf OUT=/tmp/colour/adjust-bright.pdf \
//     FIELDS='brightness=1.6 pages=1' node docs/research/colour-rail.mjs
//
// `rail-tool-bytes.mjs` clicks the rail's button with whatever the defaults hold,
// which for `adjust-colors` means every slider at its identity value — so that
// probe can show "ink arrived" but cannot show "brightness moved the histogram".
// These three tools are *made of* their controls, and the campaign has twice found
// a control wired to the form and not to the code, so each value is written the way
// a user's event reaches React (native value setter + bubbling `input`/`change`),
// read back out of the DOM before the run, and then looked for in the bytes by
// `colour-ink.py`.
//
// FIELDS keys are the tools' own field keys:
//   dpi pages brightness contrast saturation hue threshold grayscale whitening sharpen
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5291';
const TOOL = process.env.TOOL;
const PDF = process.env.PDF || '/tmp/colour/colour.pdf';
const OUT = process.env.OUT || `/tmp/colour/${TOOL}.pdf`;
const LABEL = process.env.LABEL || '';
const PORT = Number(process.env.PORT || 9801);
if (!TOOL) throw new Error('TOOL is required');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Field key → the words the rail prints next to its control. */
const FIELD_LABELS = {
  dpi: 'Resolution',
  pages: 'Pages',
  mode: 'Method',
  brightness: 'Brightness',
  contrast: 'Contrast',
  saturation: 'Saturation',
  hue: 'Hue rotate',
  threshold: 'Make black and white',
  grayscale: 'Greyscale',
  whitening: 'Whiten the background',
  sharpen: 'Sharpen edges',
};

const WANTED = Object.fromEntries(
  (process.env.FIELDS || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf('=');
      return [pair.slice(0, at), pair.slice(at + 1)];
    }),
);

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/colour-${TOOL}-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
if (!(await wait(`(()=>{const re=new RegExp(${JSON.stringify(LABEL || TOOL)},'i');return [...document.querySelectorAll('button')].some(b=>re.test(b.innerText||'')&&!b.disabled)})()`, 90000))) {
  console.log('buttons:', JSON.stringify(await ev(`JSON.stringify([...document.querySelectorAll('button')].map(b=>[b.innerText.trim().slice(0,30),!b.disabled]))`)));
  throw new Error(`no enabled button matching ${LABEL || TOOL} after loading ${PDF}`);
}
// The rail folds everything but its lead field behind "N more options".
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/more option/i.test(x.innerText||''));if(b)b.click();return !!b})()`);
await sleep(400);

/**
 * Find the control a human reads the name beside, whichever of the three shapes a
 * field takes: a labelled range/number/text input, or a checkbox inside its label.
 */
function locator(label) {
  return `(()=>{
    const want=${JSON.stringify(label.toLowerCase())};
    const lab=[...document.querySelectorAll('label[for]')].find((l)=>(l.innerText||'').trim().toLowerCase()===want);
    if(lab){const input=document.getElementById(lab.getAttribute('for'));if(input) return input;}
    const box=[...document.querySelectorAll('label')].find((l)=>{
      const t=(l.innerText||'').trim().toLowerCase();
      return t===want && l.querySelector('input[type=checkbox]');
    });
    return box?box.querySelector('input[type=checkbox]'):null;
  })()`;
}

async function describe(label) {
  return ev(`(()=>{
    const c=${locator(label)};
    if(c) return c.type==='checkbox' ? 'checked='+c.checked : 'value='+c.value+(c.min!==''?'/min'+c.min+'/max'+c.max:'');
    const g=${groupLocator(label)};
    if(g) return 'group('+g.getAttribute('aria-label')+'): '+[...g.querySelectorAll('button')].map((b)=>b.innerText.trim()+(b.getAttribute('aria-pressed')==='true'?'*':'')).join('|');
    return 'NO CONTROL';})()`);
}

/** A segmented control is a group of chips, not an input — `aria-pressed` is its value. */
function groupLocator(label) {
  return `(()=>{const want=${JSON.stringify(label.toLowerCase())};
    return [...document.querySelectorAll('[role=group][aria-label]')].find((g)=>(g.getAttribute('aria-label')||'').trim().toLowerCase()===want)})()`;
}

function clickChip(label, value) {
  return `(()=>{const g=${groupLocator(label)}; if(!g) return 'NO GROUP';
    const chip=[...g.querySelectorAll('button')].find((b)=>(b.innerText||'').toLowerCase().includes(${JSON.stringify(String(value).toLowerCase())}));
    if(!chip) return 'NO CHIP for the value'; chip.click(); return 'clicked='+chip.innerText.trim();})()`;
}

const applied = [];
for (const [key, raw] of Object.entries(WANTED)) {
  const label = FIELD_LABELS[key];
  if (!label) throw new Error(`unknown field key ${key}`);
  const before = await describe(label);
  if (before === 'NO CONTROL') {
    applied.push(`${key}: NO CONTROL for "${label}"`);
    continue;
  }
  if (before.startsWith('group(')) {
    // A segment: the run asks for one of its chips by a word of its own label.
    await ev(clickChip(label, raw));
  } else if (before.startsWith('checked=')) {
    const want = raw === '1' || raw === 'true' || raw === 'on';
    await ev(`(()=>{const c=${locator(label)}; if(c.checked!==${want}) c.click(); return 1})()`);
  } else if (label === 'Pages') {
    await ev(`(()=>{const c=${locator(label)};
      const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      set.call(c,${JSON.stringify(raw)});
      c.dispatchEvent(new Event('input',{bubbles:true}));
      c.dispatchEvent(new Event('change',{bubbles:true})); return 1})()`);
  } else {
    // A range input owns its value in React; write through the prototype setter so
    // the component sees a real change rather than a value it will overwrite.
    await ev(`(()=>{const c=${locator(label)};
      const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      set.call(c,${Number(raw)});
      c.dispatchEvent(new Event('input',{bubbles:true}));
      c.dispatchEvent(new Event('change',{bubbles:true})); return 1})()`);
  }
  await sleep(250);
  const after = await describe(label);
  applied.push(`${key}=${raw}: "${before}" → "${after}"`);
}
console.log('fields:', JSON.stringify(applied, null, 1));

await ev(`(()=>{const re=new RegExp(${JSON.stringify(LABEL || TOOL)},'i');const b=[...document.querySelectorAll('button')].find(x=>re.test(x.innerText||'')&&!x.disabled);b.click();return b.innerText.trim()})()`).then((t) => console.log('clicked', JSON.stringify(t)));
if (!(await wait('window.__blobs.length>0', 240000))) {
  console.log('NO OUTPUT — the screen says:', JSON.stringify(await ev(`(document.body.innerText||'').slice(0,1200)`)));
  throw new Error('the tool produced no output blob');
}
await sleep(1000);
if (process.env.SHOT) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(process.env.SHOT, Buffer.from(shot.data, 'base64'));
  console.log('screenshot:', process.env.SHOT);
}
const info = JSON.parse(await ev(`(async()=>{var b=window.__blobs.at(-1);var u=new Uint8Array(await b.arrayBuffer());var s='';for(var i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return JSON.stringify({type:b.type,size:u.length,b64:btoa(s)})})()`));
writeFileSync(OUT, Buffer.from(info.b64, 'base64'));
console.log('output', JSON.stringify({ type: info.type, bytes: info.size, file: OUT }));
console.log('report line:', await ev(`(document.body.innerText.match(/[^\\n]*(page|pages|dpi|invert|adjust|scan)[^\\n]*/gi)||[]).slice(0,6).join(' ;; ')`));
console.log('console errors:', JSON.stringify([...new Set(errors)].slice(0, 3)));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
