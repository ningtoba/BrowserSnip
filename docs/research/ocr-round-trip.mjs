// ocr-pdf round trip — plant known words, rasterise them with the shipped
// `rasterize-pdf`, then make the shipped `ocr-pdf` read the result back.
//
//   BASE=https://www.browsersnip.com DIR=/tmp/ocr node docs/research/ocr-round-trip.mjs
//
// The chain is self-validating: rasterise produces an image-only PDF (no text
// layer to lean on), so any planted word that comes back came through the
// recogniser, and if either tool regresses the checker (`ocr-check.py`) fails.
//
// Every run goes through the **rail**, with its fields written and read back out
// of the DOM before the click — dpi, output mode, language, the skip toggle and
// a page selection — the way `pdf-to-image-controls.mjs` does, so a control that
// never reaches the value layer is reported rather than assumed.
//
// Artifacts per run, in DIR:
//   scanned.pdf        the image-only PDF `rasterize-pdf` produced
//   ocr-<tag>.pdf      the file `ocr-pdf` downloaded, when it produces one
//   ocr-<tag>.txt      the visible screen text after the run (report lines,
//                      warnings, the recognised page text)
//   ocr-<tag>.json     field read-backs, the rail summary, console errors
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5291';
const DIR = process.env.DIR || '/tmp/ocr';
const PLANTED = process.env.PLANTED || `${DIR}/planted.pdf`;
const PORT = Number(process.env.PORT || 9791);
const OCR_DPI = process.env.OCR_DPI || '300';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/ocr-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
  // The rail mounts a pdf.js session when a file lands; a superseded execution
  // context quietly kills a pending evaluate, so each call gets three tries.
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
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(300); }
  return false;
};

/** React owns `value`: write through the prototype setter and fire both events. */
const setByLabel = (label, value) => {
  const assignment = typeof value === 'number' ? String(value) : JSON.stringify(value);
  return `(()=>{
    const lab=[...document.querySelectorAll('label[for]')].find(l=>(l.innerText||'').trim().toLowerCase()===${JSON.stringify(label.toLowerCase())});
    const input=lab&&document.getElementById(lab.getAttribute('for'));
    if(!input) return 'NO INPUT for ${label}';
    // A select field needs the select's own setter; writing through the input
    // prototype's would set a property React never reads back.
    const proto=input.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;
    const set=Object.getOwnPropertyDescriptor(proto,'value').set;
    set.call(input,${assignment});
    input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new Event('change',{bubbles:true}));
    return 'value='+input.value;
  })()`;
};
const readByLabel = (label) => `(()=>{
  const lab=[...document.querySelectorAll('label[for]')].find(l=>(l.innerText||'').trim().toLowerCase()===${JSON.stringify(label.toLowerCase())});
  const input=lab&&document.getElementById(lab.getAttribute('for'));
  if(!input) return 'NO INPUT';
  const text=input.tagName==='SELECT'?input.selectedOptions[0]?.innerText.trim():input.value;
  return 'value='+input.value+' label='+JSON.stringify(text);
})()`;

/** Click a segmented chip by its visible text, and read which one is pressed. */
const chip = (group, text) => `(()=>{
  const g=[...document.querySelectorAll('[role=group][aria-label]')].find(x=>(x.getAttribute('aria-label')||'').toLowerCase()===${JSON.stringify(group.toLowerCase())});
  if(!g) return 'NO GROUP ${group}';
  const b=[...g.querySelectorAll('button')].find(x=>(x.innerText||'').toLowerCase().includes(${JSON.stringify(text.toLowerCase())}));
  if(!b) return 'NO CHIP ${text}';
  b.click();
  return 'clicked='+b.innerText.trim();
})()`;
const chipState = (group) => `(()=>{
  const g=[...document.querySelectorAll('[role=group][aria-label]')].find(x=>(x.getAttribute('aria-label')||'').toLowerCase()===${JSON.stringify(group.toLowerCase())});
  return g?'pressed='+[...g.querySelectorAll('button')].filter(b=>b.getAttribute('aria-pressed')==='true').map(b=>b.innerText.trim()).join('|'):'NO GROUP';
})()`;

/** Tick / untick a checkbox by the text of its own label. */
const check = (labelText, want) => `(()=>{
  const lab=[...document.querySelectorAll('label')].find(l=>new RegExp(${JSON.stringify(labelText)},'i').test(l.innerText||''));
  const box=lab&&lab.querySelector('input[type=checkbox]');
  if(!box) return 'NO CHECKBOX';
  if(box.checked!==${want ? 'true' : 'false'}) box.click();
  return 'checked='+box.checked;
})()`;

async function loadRoute(tool) {
  // Home first, then the tool: the rail keeps its field values while the route
  // stays the same, so a second `#/tool/ocr-pdf` navigation would inherit the
  // previous run's Pages field and report a 1-page selection as if it were fresh.
  await send('Page.navigate', { url: `${BASE}/#/` });
  await sleep(600);
  await send('Page.navigate', { url: `${BASE}/#/tool/${tool}` });
  if (!(await wait(`document.readyState === 'complete' && !!document.querySelector('input[type=file]')`, 90000))) {
    throw new Error(`no file input on ${BASE}/#/tool/${tool}`);
  }
  await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
}

async function attach(file) {
  const { root } = await send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId, files: [file] });
  await sleep(1200);
  // The rail shows the file it actually holds. Slots are per tool and persist
  // across a route change, so an attach that silently did not land would leave
  // the next run answering about the *previous* document — which is a probe bug
  // that looks like a tool bug.
  const name = file.split('/').pop();
  const named = await wait(`(document.body.innerText||'').includes(${JSON.stringify(name)})`, 20000);
  if (!named) throw new Error(`attaching ${file} left the rail holding something else`);
  log.push(`attached ${name}: the rail names it`);
}

/**
 * Click the rail's run button and wait for the *run* to finish, not for a
 * download. `data-run-status` is the app's own phase (`running` → `done` /
 * `error`), which is what a report-mode run — a tool that deliberately produces
 * no file — has to be measured by.
 */
async function run(timeout = 300000) {
  const before = await ev(`window.__blobs.length`);
  const clicked = await ev(`(()=>{const b=document.querySelector('button[data-run]');if(!b||b.disabled)return 'NO BUTTON';const label=b.innerText.trim();b.click();return label})()`);
  if (clicked === 'NO BUTTON') throw new Error('the run button is missing or disabled');
  if (!(await wait(`(()=>{const p=document.querySelector('[data-run-status]');return p&&p.getAttribute('data-run-status')!=='running'})()`, timeout))) {
    throw new Error(`run ${JSON.stringify(clicked)} never reported a finished phase`);
  }
  await sleep(800);
  const blobs = await ev(`window.__blobs.length`);
  return { clicked, got: blobs > before, status: await ev(`document.querySelector('[data-run-status]')?.getAttribute('data-run-status')`) };
}

async function lastBlob(out) {
  const info = JSON.parse(await ev(`(async()=>{var b=window.__blobs.at(-1);if(!b)return JSON.stringify({size:0});var u=new Uint8Array(await b.arrayBuffer());var s='';for(var i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return JSON.stringify({type:b.type,size:u.length,b64:btoa(s)})})()`));
  if (info.size) writeFileSync(out, Buffer.from(info.b64, 'base64'));
  return { type: info.type, bytes: info.size, file: out };
}

const screenText = () => ev(`(document.body.innerText||'')`);

const log = [];
// A desktop viewport, so a saved screenshot shows the result card and its text
// rather than a 780 px column with the answer below the fold.
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false });
// ── half 1: rasterise the planted page into an image-only PDF ────────────────
await loadRoute('rasterize-pdf');
await attach(PLANTED);
await sleep(1200);
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/more option/i.test(x.innerText||''));if(b)b.click();return !!b})()`);
log.push(`rasterize pages field: ${await ev(setByLabel('Pages', 'all'))} → ${await ev(readByLabel('Pages'))}`);
const raster = await run();
log.push(`rasterize: clicked ${JSON.stringify(raster.clicked)}, download ${raster.got}, phase ${raster.status}`);
const scanned = await lastBlob(`${DIR}/scanned.pdf`);
log.push(`scanned.pdf: ${JSON.stringify(scanned)}`);

// ── half 2: OCR the image-only PDF, through the rail ─────────────────────────
async function ocrRun(tag, { mode, pages, dpi, language, skip, file = `${DIR}/scanned.pdf` }) {
  await loadRoute('ocr-pdf');
  await attach(file);
  await sleep(1400);
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/more option/i.test(x.innerText||''));if(b)b.click();return !!b})()`);
  await sleep(300);
  const applied = [];
  if (language) applied.push(`language=${language} → ${await ev(setByLabel('Language', language))}; state ${await ev(readByLabel('Language'))}`);
  if (mode) applied.push(`mode=${mode} → ${await ev(chip('Output', mode))}; state ${await ev(chipState('Output'))}`);
  if (skip !== undefined) applied.push(`skip=${skip} → ${await ev(check('Skip pages that already have text', skip))}`);
  if (dpi) applied.push(`dpi=${dpi} → ${await ev(setByLabel('Resolution', Number(dpi)))}; state ${await ev(readByLabel('Resolution'))}`);
  if (pages) applied.push(`pages=${pages} → ${await ev(setByLabel('Pages', pages))}; state ${await ev(readByLabel('Pages'))}`);
  log.push(`--- ocr ${tag} fields ---`);
  log.push(...applied);
  log.push(`ocr ${tag} rail says: ${JSON.stringify((await screenText()).match(/[^\n]*(dpi|page|Language)[^\n]*/g)?.slice(0, 6) ?? [])}`);
  const started = Date.now();
  const res = await run();
  log.push(`ocr ${tag}: clicked ${JSON.stringify(res.clicked)}, blob ${res.got}, phase ${res.status}, ${Math.round((Date.now() - started) / 1000)}s`);
  const out = `${DIR}/ocr-${tag}.pdf`;
  const info = res.got ? await lastBlob(out) : { bytes: 0, file: out };
  const text = await screenText();
  writeFileSync(`${DIR}/ocr-${tag}.txt`, text);
  // The screen half of the campaign's rule: the card, holding the result, as an
  // image — not only the text read out of the DOM. Scrolled to the report/preview
  // block first, because what has to be visible is the recognised text.
  await ev(`(()=>{const el=document.querySelector('[data-result]')||document.scrollingElement;el.scrollTop=el.scrollHeight;return 1})()`);
  await sleep(300);
  const image = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${DIR}/ocr-${tag}.png`, Buffer.from(image.data, 'base64'));
  writeFileSync(`${DIR}/ocr-${tag}.json`, JSON.stringify({ fields: applied, output: info, clicked: res.clicked }, null, 2));
  log.push(`ocr ${tag} output: ${JSON.stringify(info)}`);
  log.push(`ocr ${tag} screen tail: ${JSON.stringify(text.slice(-1400))}`);
  return info;
}

// A document that already carries its own text, with the skip toggle left on.
// This runs first because the tool's file slot outlives the route: attaching the
// source here, before anything else has been handed to `ocr-pdf`, is the only way
// to know which document answered.
await loadRoute('ocr-pdf');
await attach(PLANTED);
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/more option/i.test(x.innerText||''));if(b)b.click();return !!b})()`);
await sleep(300);
log.push(`ocr skip-control: pages ${await ev(setByLabel('Pages', 'all'))} → ${await ev(readByLabel('Pages'))}`);
log.push(`ocr skip-control: mode ${await ev(chip('Output', 'Invisible text layer'))}, state ${await ev(chipState('Output'))}, skip ${await ev(check('Skip pages that already have text', true))}`);
await sleep(300);
const skipRun = await run();
log.push(`ocr skip-control: blob ${skipRun.got}, phase ${skipRun.status}`);
const skipText = await screenText();
writeFileSync(`${DIR}/ocr-skip.txt`, skipText);
log.push(`ocr skip-control screen: ${JSON.stringify(skipText.slice(-900))}`);

// report mode next: the recognised text is on the screen, so this is the run
// that has to name the three outcomes differently.
await ocrRun('report', { mode: 'Just show me the text', dpi: OCR_DPI, pages: 'all' });
// then the file half: the invisible layer must carry the planted words.
await ocrRun('layer', { mode: 'Invisible text layer', dpi: OCR_DPI, pages: 'all' });
// page selection through the rail: only sheet 1 asked for.
await ocrRun('pick', { mode: 'Just show me the text', dpi: OCR_DPI, pages: '1' });
// the language hint: recorded, and it must not quietly become a different claim.
await ocrRun('lang', { mode: 'Just show me the text', dpi: OCR_DPI, pages: '1', language: 'de' });

writeFileSync(`${DIR}/round-trip.log`, `${log.join('\n')}\nconsole errors: ${JSON.stringify([...new Set(errors)].slice(0, 5))}\n`);
console.log(log.join('\n'));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
