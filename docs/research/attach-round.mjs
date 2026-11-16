// `add-attachments` round probe (061): hand the pane a named list of enclosures,
// run it, and take both halves back — the bytes it produced and a screenshot of
// the list it showed.
//
//   BASE=http://localhost:5271 PDF=/tmp/triage/in/attach.pdf \
//     FILES='/tmp/r/in/table.csv,/tmp/r/in/notes.txt' SHOT=/tmp/r/attach-a.png \
//     OUT=/tmp/r/attach-a.pdf PORT=9821 node docs/research/attach-round.mjs
//
// `FILES` is a comma-separated absolute list; the attachment name is the basename,
// so a name with spaces or accents is the file's own. `DOM.setFileInputFiles`
// cannot deliver a non-ASCII *path* to this Chromium, so those files are handed
// over in-page through `DataTransfer` with their exact bytes (the harness lesson
// from `verify-attachments-run.mjs`). Every file set is read back out of the DOM
// before the run: if the chip list does not carry the names, the run is wrong.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:5271';
const PDF = process.env.PDF;
const OUT = process.env.OUT || '/tmp/r/attach.pdf';
const SHOT = process.env.SHOT || '';
const DESC = process.env.DESC ?? '';
const DARK = process.env.DARK === '1';
// No `trim()` on the parts: a file legitimately named " note.txt " must arrive padded.
const FILES = (process.env.FILES || '').split(',').filter((f) => f.length > 0);
if (!PDF || FILES.length === 0) throw new Error('PDF and FILES are required');

const h = await open();
const rootId = async () => (await h.send('DOM.getDocument', { depth: -1 })).root.nodeId;

await h.send('Page.navigate', { url: `${BASE}/#/tool/add-attachments` });
if (!(await h.wait(`!!document.querySelector('input[type=file]')`, 60000))) throw new Error('no file input');
await h.ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
const intakeRoot = await rootId();
await h.ev(`(() => { const i = [...document.querySelectorAll('input[type=file]')].find((x) => !x.closest('[role=group]')); if (i) i.setAttribute('data-probe-doc','1'); return !!i; })()`);
const docField = await h.send('DOM.querySelector', { nodeId: intakeRoot, selector: 'input[data-probe-doc]' });
await h.send('DOM.setFileInputFiles', { nodeId: docField.nodeId, files: [PDF] });
console.log('document in:', PDF, readFileSync(PDF).length);
await sleep(16000);
console.log('fold:', await h.ev(`(() => {
  const bar = [...document.querySelectorAll('[data-options-panel] button[aria-expanded="false"]')];
  if (bar.length === 0) return 'no closed disclosure';
  bar[0].click();
  return 'opened ' + JSON.stringify(bar[0].innerText.trim().slice(0, 40));
})()`));
await sleep(900);

// One `DataTransfer` carrying every file, one `change`: a second dispatch whose
// `files` already holds the first one makes the picker append them twice, and the
// run then reports a duplicate the input never had.
const TYPES = { '.txt': 'text/plain', '.csv': 'text/csv', '.png': 'image/png', '.pdf': 'application/pdf' };
const payload = FILES.map((path) => ({
  name: basename(path),
  b64: readFileSync(path).toString('base64'),
  type: TYPES[path.slice(path.lastIndexOf('.'))] || 'application/octet-stream',
}));
console.log('in-page add:', await h.ev(`(() => {
  const g = [...document.querySelectorAll('[role=group]')].find((x) => /files to attach/i.test(x.getAttribute('aria-label') || ''));
  const i = g?.querySelector('input[type=file]'); if (!i) return 'no picker';
  const dt = new DataTransfer();
  for (const f of ${JSON.stringify(payload)}) {
    const raw = atob(f.b64); const u = new Uint8Array(raw.length);
    for (let k = 0; k < raw.length; k++) u[k] = raw.charCodeAt(k);
    dt.items.add(new File([u], f.name, { type: f.type }));
  }
  i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true }));
  return 'dispatched ' + i.files.length;
})()`));
await sleep(1200);
console.log('chips:', await h.ev(`(() => [...document.querySelectorAll('[role=group]')]
  .find((x) => /files to attach/i.test(x.getAttribute('aria-label') || ''))?.innerText.replace(/\\n/g, ' / ') || 'missing')()`));
const chipsRead = await h.ev(`(() => [...document.querySelectorAll('[role=group]')]
  .find((x) => /files to attach/i.test(x.getAttribute('aria-label') || ''))
  ?.querySelectorAll('button[aria-label^="Remove "]').length || 0)()`);
// Hydration can land after the dispatch and swallow it, and a re-dispatch appends
// to whatever is already in the picker. Poll, re-dispatch once if nothing arrived,
// then drop the duplicate chips so the panel is exactly the payload — otherwise the
// run warns about a collision the input never had.
const countChips = `(() => [...document.querySelectorAll('[role=group]')]
  .find((x) => /files to attach/i.test(x.getAttribute('aria-label') || ''))
  ?.querySelectorAll('button[aria-label^="Remove "]').length || 0)()`;
const dispatch = `(() => {
  const g = [...document.querySelectorAll('[role=group]')].find((x) => /files to attach/i.test(x.getAttribute('aria-label') || ''));
  const i = g?.querySelector('input[type=file]'); if (!i) return 'no picker';
  const dt = new DataTransfer();
  for (const f of ${JSON.stringify(payload)}) {
    const raw = atob(f.b64); const u = new Uint8Array(raw.length);
    for (let k = 0; k < raw.length; k++) u[k] = raw.charCodeAt(k);
    dt.items.add(new File([u], f.name, { type: f.type }));
  }
  i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true }));
  return 'dispatched ' + i.files.length;
})()`;
let chipsNow = 0;
for (let tick = 0; tick < 15 && chipsNow === 0; tick++) {
  await sleep(400);
  chipsNow = await h.ev(countChips);
}
if (chipsNow === 0) console.log('re-dispatch:', await h.ev(dispatch));
for (let tick = 0; tick < 15 && chipsNow < payload.length; tick++) {
  await sleep(400);
  chipsNow = await h.ev(countChips);
}
// A stale React closure makes a burst of Remove clicks remove the same chip over
// and over, so the dedupe is one click per evaluate. React's `pick` appends, and a
// re-dispatch therefore duplicates the payload; the panel must end up carrying the
// payload once, or the run's own collision warning would be the harness talking.
const namesIn = `(() => {
  const g = [...document.querySelectorAll('[role=group]')].find((x) => /files to attach/i.test(x.getAttribute('aria-label') || ''));
  return [...(g?.querySelectorAll('button[aria-label^="Remove "]') || [])].map((b) => b.getAttribute('aria-label').slice(7));
})()`;
const clickDup = `(() => {
  const g = [...document.querySelectorAll('[role=group]')].find((x) => /files to attach/i.test(x.getAttribute('aria-label') || ''));
  const buttons = [...(g?.querySelectorAll('button[aria-label^="Remove "]') || [])];
  const seen = new Set();
  for (const b of buttons) {
    const name = b.getAttribute('aria-label').slice(7);
    if (seen.has(name)) { b.click(); return name; }
    seen.add(name);
  }
  return '';
})()`;
for (let guard = 0; guard < 12; guard++) {
  const dropped = await h.ev(clickDup);
  if (!dropped) break;
  console.log('dup chip dropped:', dropped);
  await sleep(350);
}
const chipNames = await h.ev(namesIn);
console.log('chips read back:', JSON.stringify(chipNames), 'of', JSON.stringify(payload.map((f) => f.name)),
  JSON.stringify(chipNames) === JSON.stringify(payload.map((f) => f.name)) ? 'OK' : 'MISMATCH');
if (JSON.stringify(chipNames) !== JSON.stringify(payload.map((f) => f.name))) {
  throw new Error('the picker does not carry exactly the payload; the run would be wrong');
}
if (DESC) {
  console.log('note field:', await h.ev(`(() => {
    const el = document.getElementById('tool-field-description'); if (!el) return 'missing';
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(DESC)});
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(DESC)} }));
    return 'description=' + el.value;
  })()`));
}
if (DARK) await h.ev(`(()=>{document.documentElement.classList.add('dark');try{localStorage.setItem('browsersnip:theme','dark')}catch{};return 1})()`);
await sleep(400);
if (SHOT) await h.shot(SHOT);
const n = await h.ev('window.__blobs.length');
console.log('run:', await h.ev(`(() => { const b = document.querySelector('#tool-process-btn'); if (!b) return 'missing'; if (b.disabled) return 'disabled: ' + (b.title || ''); b.click(); return b.innerText.trim(); })()`));
if (!(await h.wait(`window.__blobs.length > ${n}`, 150000))) {
  console.log('body:', await h.ev('document.body.innerText.slice(0,1500)'));
  throw new Error('no output blob');
}
await sleep(1200);
const file = await h.ev(`(async () => {
  const b = [...window.__blobs].reverse().find((x) => x && typeof x.arrayBuffer === 'function');
  const u = new Uint8Array(await b.arrayBuffer());
  let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
  return JSON.stringify({ size: u.length, b64: btoa(s) });
})()`);
const info = JSON.parse(file);
writeFileSync(OUT, Buffer.from(info.b64, 'base64'));
console.log('wrote', OUT, info.size, 'bytes');
console.log('result screen:', await h.ev(`(document.body.innerText.split('\\n').filter((l) => /attach|Attach|embed|carried|replaced|warn|attachment/i.test(l)).slice(0, 12).join(' ;; '))`));
console.log('console errors', JSON.stringify([...new Set(h.errors)].slice(0, 4)));
h.chrome.kill('SIGKILL');
process.exit(0);
