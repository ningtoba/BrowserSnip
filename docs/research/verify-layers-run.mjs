// `pdf-layers` on a live build: switch layers off, export, ask what the file says.
//
//   BASE=https://www.browsersnip.com PDF=/tmp/eight/two-layers.pdf HIDE='Red revision' \
//     ADD='Revision C' OUT=/tmp/eight/layers.pdf node docs/research/verify-layers-run.mjs
//
// The card's claim is about the *default view*: "The optional-content groups of a CAD
// or GIS export, switched on or off in the default view", and per its help text the
// content stays in the file. So this picks the layers in the rail's own multiselects
// — which only exist once the disclosure has been opened over the opened document —
// adds a named one, exports, and prints the pane's sentence. `verify-layers-read.py`
// then reads `/OCProperties` with pikepdf and asks MuPDF and poppler whether the ink
// that layer paints is actually gone from the rendered page.
import { writeFileSync } from 'node:fs';
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'https://www.browsersnip.com';
const PDF = process.env.PDF;
const OUT = process.env.OUT || '/tmp/eight/layers.pdf';
const HIDE = (process.env.HIDE || '').split(',').filter(Boolean);
const SHOW = (process.env.SHOW || '').split(',').filter(Boolean);
const ADD = process.env.ADD || '';
const REMOVE = process.env.REMOVE || '';
const SHOT = process.env.SHOT || '';
if (!PDF) throw new Error('PDF is required');

const h = await open();
const rootId = async () => (await h.send('DOM.getDocument', { depth: -1 })).root.nodeId;
await h.send('Page.navigate', { url: `${BASE}/#/tool/pdf-layers` });
if (!(await h.wait(`!!document.querySelector('input[type=file]')`, 60000))) throw new Error('no file input');
await h.ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
await h.ev(`(() => { const i = [...document.querySelectorAll('input[type=file]')].find((x) => !x.closest('[role=group]')); if (i) i.setAttribute('data-probe-doc','1'); return !!i; })()`);
const docField = await h.send('DOM.querySelector', { nodeId: await rootId(), selector: 'input[data-probe-doc]' });
await h.send('DOM.setFileInputFiles', { nodeId: docField.nodeId, files: [PDF] });
console.log('document in:', PDF);
await sleep(18000);
console.log('fold:', await h.ev(`(() => {
  const bar = [...document.querySelectorAll('[data-options-panel] button[aria-expanded="false"]')];
  if (bar.length === 0) return 'no closed disclosure';
  bar[0].click(); return 'opened ' + JSON.stringify(bar[0].innerText.trim().slice(0, 30));
})()`));
await sleep(1200);
const census = () => h.ev(`JSON.stringify({
  groups: [...document.querySelectorAll('[role=group]')].map((g) => ({
    label: g.getAttribute('aria-label'),
    options: [...g.querySelectorAll('label')].map((l) => l.innerText.trim()),
    boxes: [...g.querySelectorAll('input[type=checkbox]')].map((b) => b.checked),
  })),
  texts: [...document.querySelectorAll('[id^=tool-field-]')].filter((e) => e.type === 'text' || e.tagName === 'TEXTAREA')
    .map((e) => e.id + '=' + JSON.stringify(e.value)),
  button: (document.querySelector('#tool-process-btn')?.innerText || '').trim(),
  enabled: !(document.querySelector('#tool-process-btn')?.disabled ?? true),
})`);
console.log('rail:', await census());

/** Tick (or clear) the box whose label matches, in the named group. */
const tick = (groupLabel, option, want = true) => h.ev(`(() => {
  const group = [...document.querySelectorAll('[role=group]')]
    .find((g) => (g.getAttribute('aria-label') || '') === ${JSON.stringify(groupLabel)});
  if (!group) return 'no group ' + ${JSON.stringify(groupLabel)};
  const label = [...group.querySelectorAll('label')].find((l) => l.innerText.trim() === ${JSON.stringify(option)});
  if (!label) return 'no option ' + ${JSON.stringify(option)} + ' among ' + [...group.querySelectorAll('label')].map((l) => l.innerText.trim()).join(' | ');
  const box = label.querySelector('input[type=checkbox]');
  if (!box) return 'label without a box';
  if (box.checked !== ${want ? 'true' : 'false'}) {
    (label.matches('label') ? label : box).click();
    box.click?.();
  }
  return ${JSON.stringify(groupLabel)} + ' / ' + ${JSON.stringify(option)} + ' checked=' + box.checked;
})()`);

for (const name of HIDE) console.log('hide:', await tick('Hide these layers', name));
for (const name of SHOW) console.log('show:', await tick('Show these layers', name));
const write = async (id, value) => h.ev(`(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  if (!el) return 'missing #' + ${JSON.stringify(id)};
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(value)} }));
  return ${JSON.stringify(id)} + '=' + el.value;
})()`);
if (ADD) console.log('add:', await write('tool-field-add', ADD));
if (REMOVE) console.log('remove:', await write('tool-field-remove', REMOVE));
await sleep(600);
console.log('rail after:', await census());
if (SHOT) await h.shot(SHOT);

const n = await h.ev('window.__blobs.length');
console.log('run:', await h.ev(`(() => { const b = document.querySelector('#tool-process-btn'); if (!b) return 'missing'; if (b.disabled) return 'disabled: ' + (b.title || ''); b.click(); return b.innerText.trim(); })()`));
if (!(await h.wait(`window.__blobs.length > ${n}`, 180000))) {
  console.log('body:', await h.ev('document.body.innerText.slice(0,1600)'));
  throw new Error('no output blob');
}
await sleep(1500);
const file = await h.ev(`(async () => {
  const b = [...window.__blobs].reverse().find((x) => x && typeof x.arrayBuffer === 'function');
  const u = new Uint8Array(await b.arrayBuffer());
  let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
  return JSON.stringify({ size: u.length, b64: btoa(s) });
})()`);
const info = JSON.parse(file);
writeFileSync(OUT, Buffer.from(info.b64, 'base64'));
console.log('wrote', OUT, info.size, 'bytes');
console.log('result screen:', await h.ev(`(document.body.innerText.split('\\n').filter((l) => /layer|Layer|hidden|visible|view/i.test(l)).slice(0, 10).join(' ;; '))`));
console.log('console errors', JSON.stringify([...new Set(h.errors)].slice(0, 4)));
h.chrome.kill('SIGKILL');
process.exit(0);
