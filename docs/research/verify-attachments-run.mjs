// `add-attachments` on a live build: attach files, take the bytes, hash them back.
//
//   BASE=https://www.browsersnip.com PDF=/tmp/eight/plain.pdf NOTE='Board pack' \
//     OUT=/tmp/eight/attached.pdf node docs/research/verify-attachments-run.mjs
//
// The card promises "The files carried inside the PDF itself" and "embedded whole,
// not referenced", so the only question that matters is whether the bytes that come
// out are the bytes that went in. This drives the rail the way a person does — drop
// the document, choose the enclosures in the field's own picker, type the note,
// Attach files — and prints what the pane claimed. `verify-attachments-read.py`
// extracts each enclosure with three outside readers and hashes them.
import { writeFileSync, readdirSync, mkdtempSync, writeFileSync as w, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'https://www.browsersnip.com';
const PDF = process.env.PDF;
const OUT = process.env.OUT || '/tmp/eight/attached.pdf';
const NOTE = process.env.NOTE ?? 'Board pack of 2026-11-11';
const SHOT = process.env.SHOT || '';

const work = mkdtempSync(join(tmpdir(), 'attach-'));
/** Three shapes: text with a non-ASCII name, a real PNG, and a byte-everything file. */
const enclosures = [
  { name: 'pixel.png', type: 'image/png', bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/7AAAAABJRU5ErkJggg==', 'base64') },
  { name: 'bin-handshake.bin', type: 'application/octet-stream', bytes: (() => {
    const b = Buffer.alloc(1024);
    for (let i = 0; i < b.length; i++) b[i] = (i * 37 + 214) & 0xff;
    return b;
  })() },
  // Named with non-ASCII letters but carrying ASCII bytes: the file is handed to the
  // picker inside the page (see below), so the name is the thing under test.
  { name: 'notes-éè.txt', type: 'text/plain', bytes: Buffer.from('attachment note\n', 'utf8'), inPage: true },
];
const written = enclosures.map((file) => {
  const path = join(work, file.name);
  w(path, file.bytes);
  return { path, file };
}).filter((entry) => !entry.file.inPage).map((entry) => entry.path);
console.log('enclosures:', enclosures.map((f) => `${f.name} ${f.bytes.length}B`).join(' · '));
const { createHash } = await import('node:crypto');
writeFileSync(join(work, 'hashes.txt'), enclosures.map((f) =>
  `${createHash('sha256').update(f.bytes).digest('hex')}  ${f.bytes.length}  ${f.name}`).join('\n') + '\n');

if (!PDF) throw new Error('PDF is required');
const h = await open();
const rootId = async () => (await h.send('DOM.getDocument', { depth: -1 })).root.nodeId;

/** Mark the picker inside the named group so CDP can hand it files. */
const dropInGroup = async (labelPattern, files) => {
  const marked = await h.ev(`(() => {
    const groups = [...document.querySelectorAll('[role=group]')];
    const group = groups.find((g) => new RegExp(${JSON.stringify(labelPattern)}, 'i').test(g.getAttribute('aria-label') || ''));
    if (!group) return 'groups: ' + (groups.map((g) => g.getAttribute('aria-label')).join(' | ') || '(none)');
    const input = group.querySelector('input[type=file]');
    if (!input) return 'the group has no file input';
    input.setAttribute('data-probe-target', '1');
    return 'marked';
  })()`);
  if (marked !== 'marked') return marked;
  const found = await h.send('DOM.querySelector', { nodeId: await rootId(), selector: 'input[data-probe-target]' });
  if (!found.nodeId) return 'the marked input cannot be reached over CDP';
  await h.send('DOM.setFileInputFiles', { nodeId: found.nodeId, files });
  await h.ev(`(() => { const i = document.querySelector('input[data-probe-target]');
    i.dispatchEvent(new Event('change', { bubbles: true })); i.removeAttribute('data-probe-target'); return 1; })()`);
  await sleep(900);
  return h.ev(`(() => {
    const groups = [...document.querySelectorAll('[role=group]')];
    const group = groups.find((g) => new RegExp(${JSON.stringify(labelPattern)}, 'i').test(g.getAttribute('aria-label') || ''));
    return (group?.innerText || '').replace(/\\n/g, ' / ').slice(0, 200);
  })()`);
};

await h.send('Page.navigate', { url: `${BASE}/#/tool/add-attachments` });
if (!(await h.wait(`!!document.querySelector('input[type=file]')`, 60000))) throw new Error('no file input');
await h.ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
const intakeRoot = await rootId();
await h.ev(`(() => { const i = [...document.querySelectorAll('input[type=file]')].find((x) => !x.closest('[role=group]')); if (i) i.setAttribute('data-probe-doc','1'); return !!i; })()`);
const docField = await h.send('DOM.querySelector', { nodeId: intakeRoot, selector: 'input[data-probe-doc]' });
await h.send('DOM.setFileInputFiles', { nodeId: docField.nodeId, files: [PDF] });
console.log('document in:', PDF);
await sleep(18000);
// The disclosure is the control with `aria-expanded="false"`; its label counts in
// singular or plural, so a search for the words alone misses a one-option fold.
console.log('fold:', await h.ev(`(() => {
  const bar = [...document.querySelectorAll('[data-options-panel] button[aria-expanded="false"]')];
  if (bar.length === 0) return 'no closed disclosure';
  bar[0].click();
  return 'opened ' + JSON.stringify(bar[0].innerText.trim().slice(0, 40));
})()`));
await sleep(900);
console.log('files field:', await dropInGroup('Files to attach', written));
// One file is added through the page's own `DataTransfer`, because a CDP
// `setFileInputFiles` path with non-ASCII letters never reaches the picker - and
// blaming the app for that would be blaming the harness.
for (const file of enclosures.filter((f) => f.inPage)) {
  console.log('in-page add:', await h.ev(`(() => {
    const group = [...document.querySelectorAll('[role=group]')]
      .find((g) => /files to attach/i.test(g.getAttribute('aria-label') || ''));
    const input = group?.querySelector('input[type=file]');
    if (!input) return 'no picker';
    const dt = new DataTransfer();
    for (const existing of input.files) dt.items.add(existing);
    dt.items.add(new File([new Uint8Array(${JSON.stringify([...file.bytes])})], ${JSON.stringify(file.name)}, { type: ${JSON.stringify(file.type)} }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'dispatched ' + input.files.length + ' files';
  })()`));
  await sleep(900);
}
console.log('note field :', await h.ev(`(() => {
  const el = document.getElementById('tool-field-description');
  if (!el) return 'missing #tool-field-description';
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(NOTE)});
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(NOTE)} }));
  return 'description=' + el.value;
})()`));
if (SHOT) await h.shot(SHOT);
const n = await h.ev('window.__blobs.length');
console.log('run:', await h.ev(`(() => { const b = document.querySelector('#tool-process-btn'); if (!b) return 'missing'; if (b.disabled) return 'disabled: ' + (b.title || ''); b.click(); return b.innerText.trim(); })()`));
if (!(await h.wait(`window.__blobs.length > ${n}`, 180000))) {
  console.log('body:', await h.ev('document.body.innerText.slice(0,1800)'));
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
console.log('result screen:', await h.ev(`(document.body.innerText.split('\\n').filter((l) => /attach|Attach|embed|carried|warn/i.test(l)).slice(0, 10).join(' ;; '))`));
console.log('hashes:', readFileSync(join(work, 'hashes.txt'), 'utf8').trim());
console.log('workdir:', work);
console.log('console errors', JSON.stringify([...new Set(h.errors)].slice(0, 4)));
h.chrome.kill('SIGKILL');
process.exit(0);
