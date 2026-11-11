// `add-stamps` on a live build: stamps on chosen pages, taken from the rail.
//
//   BASE=https://www.browsersnip.com PDF=/tmp/eight/stamps-source.pdf PAGES=1-4 \
//     POSITION=top-right STAMP=DRAFT OUT=/tmp/eight/stamped.pdf \
//     node docs/research/verify-stamps-run.mjs
//
// The triage only ever reached the editor surface, where a stamp has to be *placed*
// with a click before the button wakes up. The rail path is the one that answers the
// card's question — "one per page you click or per page you list" — so this lists
// pages, picks a corner and a stamp, and downloads. The pane's own sentence
// ("Placed N stamps on M pages") is read back and printed next to the bytes for
// `verify-stamps-read.py`, which asks where each mark actually is on each page.
import { writeFileSync } from 'node:fs';
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'https://www.browsersnip.com';
const PDF = process.env.PDF;
const OUT = process.env.OUT || '/tmp/eight/stamped.pdf';
const PAGES = process.env.PAGES || '1-4';
const POSITION = process.env.POSITION || 'top-right';
const STAMP = process.env.STAMP || 'DRAFT';
const WIDTH = process.env.WIDTH || '160';
const OPACITY = process.env.OPACITY || '0.5';
const SHOT = process.env.SHOT || '';
if (!PDF) throw new Error('PDF is required');

const h = await open();
const rootId = async () => (await h.send('DOM.getDocument', { depth: -1 })).root.nodeId;
await h.send('Page.navigate', { url: `${BASE}/#/tool/add-stamps` });
if (!(await h.wait(`!!document.querySelector('input[type=file]')`, 60000))) throw new Error('no file input');
await h.ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
await h.ev(`(() => { const i = [...document.querySelectorAll('input[type=file]')].find((x) => !x.closest('[role=group]')); if (i) i.setAttribute('data-probe-doc','1'); return !!i; })()`);
const docField = await h.send('DOM.querySelector', { nodeId: await rootId(), selector: 'input[data-probe-doc]' });
await h.send('DOM.setFileInputFiles', { nodeId: docField.nodeId, files: [PDF] });
console.log('document in:', PDF);
if (!(await h.wait(`/page/i.test(document.body.innerText)`, 60000))) throw new Error('the surface never reported the document');
await sleep(15000);
console.log('fold:', await h.ev(`(() => {
  const bar = [...document.querySelectorAll('[data-options-panel] button[aria-expanded="false"]')];
  if (bar.length === 0) return 'no closed disclosure';
  bar[0].click(); return 'opened ' + JSON.stringify(bar[0].innerText.trim().slice(0, 30));
})()`));
await sleep(900);

const write = async (id, value) => h.ev(`(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  if (!el) return 'missing #' + ${JSON.stringify(id)};
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(String(value))} }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return ${JSON.stringify(id)} + '=' + el.value;
})()`);
console.log('stamp   :', await write('tool-field-stamp', STAMP));
console.log('position:', await write('tool-field-position', POSITION));
console.log('width   :', await write('tool-field-width', WIDTH));
console.log('opacity :', await write('tool-field-opacity', OPACITY));
console.log('pages   :', await write('tool-field-pages', PAGES));
if (SHOT) await h.shot(SHOT);
console.log('census  :', await h.ev(`JSON.stringify({
  selects: [...document.querySelectorAll('select')].filter((s) => s.offsetParent).map((s) => s.id + '=' + s.value),
  numbers: [...document.querySelectorAll('input')].filter((s) => s.offsetParent && s.id).map((s) => s.id + '=' + s.value).slice(0, 12),
  button: (document.querySelector('#tool-process-btn')?.innerText || '').trim(),
  enabled: !(document.querySelector('#tool-process-btn')?.disabled ?? true),
  blocked: (document.body.innerText.match(/[^\\n]*(needs|place|click|disabled|Add a)[^\\n]*/g) || []).slice(0, 3),
})`));

const n = await h.ev('window.__blobs.length');
console.log('run:', await h.ev(`(() => { const b = document.querySelector('#tool-process-btn'); if (!b) return 'missing'; if (b.disabled) return 'disabled: ' + (b.title || ''); b.click(); return b.innerText.trim(); })()`));
if (!(await h.wait(`window.__blobs.length > ${n}`, 180000))) {
  console.log('body:', await h.ev('document.body.innerText.slice(0,1600)'));
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
console.log('result screen:', await h.ev(`(document.body.innerText.split('\\n').filter((l) => /stamp|Stamp|page/i.test(l)).slice(0, 8).join(' ;; '))`));
console.log('console errors', JSON.stringify([...new Set(h.errors)].slice(0, 4)));
h.chrome.kill('SIGKILL');
process.exit(0);
