// `form-creator` on a live build: drop fields, name them, save, keep the bytes.
//
//   BASE=https://www.browsersnip.com PDF=/tmp/eight/plain.pdf OUT=/tmp/eight/form.pdf \
//     node docs/research/verify-form-creator-run.mjs
//
// The pane is its own designer, so this is driven the way a person drives it: pick a
// field type from the chips, click where it should sit, type the name the pane offers
// in its inspector, repeat, then "Save form". What the pane counted and what the file
// carries are printed side by side; `verify-form-creator-read.py` asks MuPDF and pypdf
// whether the fields are there, named, typed, and **fillable**.
import { writeFileSync } from 'node:fs';
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'https://www.browsersnip.com';
const PDF = process.env.PDF;
const OUT = process.env.OUT || '/tmp/eight/form.pdf';
const SHOT = process.env.SHOT || '';
/** [chip label, x fraction, y fraction, name, extra options for a choice list] */
const PLAN = process.env.PLAN === 'simple'
  ? [['Text', 0.3, 0.75, 'applicant.name', '']]
  : [
    ['Text', 0.25, 0.8, 'applicant.name', ''],
    ['Text', 0.25, 0.68, 'applicant.notes', ''],
    ['Checkbox', 0.25, 0.58, 'agree.terms', ''],
    ['Dropdown', 0.55, 0.45, 'country', 'Finland\nFrance\nGermany'],
  ];
if (!PDF) throw new Error('PDF is required');

const h = await open();
const rootId = async () => (await h.send('DOM.getDocument', { depth: -1 })).root.nodeId;
await h.send('Page.navigate', { url: `${BASE}/#/tool/form-creator` });
if (!(await h.wait(`!!document.querySelector('input[type=file]')`, 60000))) throw new Error('no file input');
await h.ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
await h.ev(`(() => { const i = [...document.querySelectorAll('input[type=file]')].find((x) => !x.closest('[role=group]')); if (i) i.setAttribute('data-probe-doc','1'); return !!i; })()`);
const docField = await h.send('DOM.querySelector', { nodeId: await rootId(), selector: 'input[data-probe-doc]' });
await h.send('DOM.setFileInputFiles', { nodeId: docField.nodeId, files: [PDF] });
console.log('document in:', PDF);
if (!(await h.wait(`!!document.querySelector('[role=group][aria-label="Field type to place"]')`, 60000))) {
  console.log('body:', await h.ev('document.body.innerText.slice(0,900)'));
  throw new Error('the designer chips never appeared');
}
await sleep(2500);

const sheetBox = async () => h.ev(`(() => {
  const el = document.querySelector('[data-form-sheet]') || [...document.querySelectorAll('canvas')].at(-1);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height, tag: el.tagName.toLowerCase() });
})()`);
console.log('sheet:', await sheetBox());

const chip = (label) => h.ev(`(() => {
  const group = document.querySelector('[role=group][aria-label="Field type to place"]');
  const b = [...(group?.querySelectorAll('button') || [])].find((x) => (x.innerText || '').trim().endsWith(${JSON.stringify(label)}));
  if (!b) return 'no ' + ${JSON.stringify(label)} + ' chip';
  b.click();
  return 'armed ' + b.getAttribute('aria-pressed');
})()`);

const typeInto = (aria, value) => h.ev(`(() => {
  const el = document.querySelector('[aria-label=${JSON.stringify(aria)}]');
  if (!el) return 'missing [aria-label=${aria}]; visible: ' + [...document.querySelectorAll('[aria-label]')].map((x) => x.getAttribute('aria-label')).filter(Boolean).slice(0, 10).join(' | ');
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(String(value))} }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return ${JSON.stringify(aria)} + '=' + el.value;
})()`);

for (const [label, fx, fy, name, options] of PLAN) {
  console.log(`\n— planning ${name} (${label})`);
  console.log('chip:', await chip(label));
  const box = JSON.parse(await sheetBox());
  if (!box) throw new Error('no page surface to click on');
  await h.click(box.x + box.w * fx, box.y + box.h * fy);
  await sleep(900);
  console.log('drafts:', await h.ev(`JSON.stringify([...document.querySelectorAll('[role=button][aria-label*="field"]')].map((e) => ({
    label: e.getAttribute('aria-label'),
    box: (() => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
  })))`));
  console.log('name:', await typeInto('Field name', name));
  if (options) console.log('options:', await typeInto('Choice options, one per line', options));
  await sleep(600);
  console.log('count line:', await h.ev(`(document.body.innerText.match(/\\d+ fields?( · \\d+ to fix)?/) || ['?'])[0]`));
  console.log('save button:', await h.ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /Save form/.test(x.innerText)); return b ? (b.disabled ? 'disabled' : 'enabled: ' + b.innerText.trim()) : 'missing'; })()`));
}
if (SHOT) await h.shot(SHOT);

const n = await h.ev('window.__blobs.length');
console.log('\nsave:', await h.ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /Save form/.test(x.innerText)); if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return b.innerText.trim(); })()`));
if (!(await h.wait(`window.__blobs.length > ${n}`, 180000))) {
  console.log('body:', await h.ev('document.body.innerText.slice(0,1600)'));
  throw new Error('no output blob');
}
await sleep(2000);
const file = await h.ev(`(async () => {
  const b = [...window.__blobs].reverse().find((x) => x && typeof x.arrayBuffer === 'function');
  const u = new Uint8Array(await b.arrayBuffer());
  let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
  return JSON.stringify({ size: u.length, b64: btoa(s) });
})()`);
const info = JSON.parse(file);
writeFileSync(OUT, Buffer.from(info.b64, 'base64'));
console.log('wrote', OUT, info.size, 'bytes');
console.log('result screen:', await h.ev(`(document.body.innerText.split('\\n').filter((l) => /field|Field|form|Form|download|Save/i.test(l)).slice(0, 10).join(' ;; '))`));
console.log('console errors', JSON.stringify([...new Set(h.errors)].slice(0, 5)));
h.chrome.kill('SIGKILL');
process.exit(0);
