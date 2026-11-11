// `digital-sign-pdf` on a live build: sign with a real certificate, take the bytes.
//
//   BASE=https://www.browsersnip.com PDF=/tmp/eight/ruled.pdf CERT=/tmp/eight/ada.pem \
//     KEY=/tmp/eight/ada.key.pem OUT=/tmp/eight/digital.pdf node docs/research/verify-digital-sign-run.mjs
//
// The card makes a security claim — "Sign with an X.509 certificate so tampering is
// detectable", "A signature that covers the bytes: change anything afterwards and
// validation says so" — so this is driven the way a person drives it: drop the
// document, choose the certificate and the key through the pane's own pickers, type
// the reason and location, name the page the block goes on, press Sign, keep the
// download. `verify-digital-sign-read.py` then asks openssl, MuPDF and poppler what
// the bytes actually carry.
import { writeFileSync } from 'node:fs';
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'https://www.browsersnip.com';
const PDF = process.env.PDF;
const CERT = process.env.CERT;
const KEY = process.env.KEY;
const OUT = process.env.OUT || '/tmp/eight/digital.pdf';
const SHOT = process.env.SHOT || '';
const PAGE = process.env.PAGE || '2';
const REASON = process.env.REASON || 'I approve this document';
const LOCATION = process.env.LOCATION || 'Cambridge';
const VISIBLE = process.env.VISIBLE !== '0';

for (const [name, value] of [['PDF', PDF], ['CERT', CERT], ['KEY', KEY]]) {
  if (!value) throw new Error(`${name} is required`);
}
const h = await open();
const rootId = async () => (await h.send('DOM.getDocument', { depth: -1 })).root.nodeId;

/**
 * Files reach a `FilePicker` through the hidden input inside its own group, not
 * through the document drop zone: the group is labelled with the field's label, and
 * the read-back is the text the pane paints afterwards ("1 file chosen").
 */
const dropInGroup = async (labelPattern, file) => {
  const marked = await h.ev(`(() => {
    const groups = [...document.querySelectorAll('[role=group]')];
    const group = groups.find((g) => new RegExp(${JSON.stringify(labelPattern)}, 'i').test(g.getAttribute('aria-label') || ''));
    if (!group) return 'groups on the page: ' + groups.map((g) => g.getAttribute('aria-label')).join(' | ');
    const input = group.querySelector('input[type=file]');
    if (!input) return 'the group has no file input';
    input.setAttribute('data-probe-target', '1');
    return 'marked';
  })()`);
  if (marked !== 'marked') return marked;
  const found = await h.send('DOM.querySelector', { nodeId: await rootId(), selector: 'input[data-probe-target]' });
  if (!found.nodeId) return 'the marked input cannot be reached over CDP';
  await h.send('DOM.setFileInputFiles', { nodeId: found.nodeId, files: [file] });
  await h.ev(`(() => { const i = document.querySelector('input[data-probe-target]');
    i.dispatchEvent(new Event('change', { bubbles: true })); i.removeAttribute('data-probe-target'); return 1; })()`);
  await sleep(800);
  return h.ev(`(() => {
    const groups = [...document.querySelectorAll('[role=group]')];
    const group = groups.find((g) => new RegExp(${JSON.stringify(labelPattern)}, 'i').test(g.getAttribute('aria-label') || ''));
    return (group?.innerText || '').split('\\n').slice(0, 3).join(' / ');
  })()`);
};

await h.send('Page.navigate', { url: `${BASE}/#/tool/digital-sign-pdf` });
if (!(await h.wait(`!!document.querySelector('input[type=file]')`, 60000))) throw new Error('no file input');
await h.ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
const docRoot = await rootId();
// The document drop zone is the file input that is not inside a labelled field group.
await h.ev(`(() => {
  const inputs = [...document.querySelectorAll('input[type=file]')];
  const intake = inputs.find((i) => !i.closest('[role=group]')) || inputs[0];
  if (!intake) return 'no file input at all';
  intake.setAttribute('data-probe-doc', '1');
  return 'marked ' + inputs.length + ' inputs; intake is ' + (intake.closest('[role=group]')?.getAttribute('aria-label') || 'the drop zone');
})()`).then(console.log);
const docField = await h.send('DOM.querySelector', { nodeId: docRoot, selector: 'input[data-probe-doc]' });
await h.send('DOM.setFileInputFiles', { nodeId: docField.nodeId, files: [PDF] });
console.log('document in:', PDF);
await sleep(20000);

/** Every field the rail exposes right now, and what a fold would be hiding. */
const fieldCensus = () => h.ev(`(() => {
  const fold = [...document.querySelectorAll('button')].find((b) => /more options|options$/i.test((b.innerText || '').trim()) && b.offsetParent !== null);
  const boxes = [...document.querySelectorAll('input, select, textarea')]
    .filter((el) => el.type !== 'file' && el.offsetParent !== null)
    .map((el) => (el.id || el.name || el.type) + '=' + JSON.stringify(String(el.value).slice(0, 18)));
  return JSON.stringify({
    groups: [...document.querySelectorAll('[role=group]')].map((g) => g.getAttribute('aria-label')),
    boxes,
    fold: fold ? fold.innerText.trim() : null,
  });
})()`);
console.log('fields before the fold:', await fieldCensus());
console.log('fold:', await h.ev(`(() => {
  const fold = [...document.querySelectorAll('button')].find((b) => /more options|options$/i.test((b.innerText || '').trim()) && b.offsetParent !== null);
  if (!fold) return 'no fold';
  fold.click(); return 'opened ' + fold.innerText.trim();
})()`));
await sleep(1200);
console.log('fields after the fold :', await fieldCensus());

console.log('cert field:', await dropInGroup('Certificate', CERT));
console.log('key field :', await dropInGroup('Private key', KEY));

const write = async (id, value) => h.ev(`(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  if (!el) return 'missing #' + ${JSON.stringify(id)};
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(String(value))} }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return ${JSON.stringify(id)} + '=' + el.value;
})()`);
console.log('reason  :', await write('tool-field-reason', REASON));
console.log('location:', await write('tool-field-location', LOCATION));
console.log('page    :', await write('tool-field-page', PAGE));
const visibleState = await h.ev(`(() => {
  const el = document.getElementById('tool-field-visible');
  if (!el) return 'no visible control';
  return el.type + ' checked=' + (el.checked ?? el.value);
})()`);
console.log('visible :', visibleState, VISIBLE ? '(left as it is)' : '(toggled off)');
if (!VISIBLE) {
  await h.ev(`(() => { const el = document.getElementById('tool-field-visible'); (el.closest('[role=switch],button,label') || el).click(); return 1; })()`);
}
if (SHOT) await h.shot(SHOT);
console.log('screen  :', await h.ev(`(() => {
  const btn = document.querySelector('#tool-process-btn') || [...document.querySelectorAll('button')].find((b) => /^Sign$/.test(b.innerText.trim()));
  return JSON.stringify({ button: btn ? btn.innerText.trim() : null, enabled: btn ? !btn.disabled : false,
    blocker: (document.body.innerText.match(/[^\\n]*(Choose|needed|required|locked)[^\\n]*/g) || []).slice(0, 3) });
})()`));

const n = await h.ev('window.__blobs.length');
console.log('run:', await h.ev(`(() => {
  const btn = document.querySelector('#tool-process-btn') || [...document.querySelectorAll('button')].find((b) => /^Sign$/.test(b.innerText.trim()));
  if (!btn) return 'missing';
  if (btn.disabled) return 'disabled: ' + (btn.title || '');
  btn.click(); return btn.innerText.trim();
})()`));
if (!(await h.wait(`window.__blobs.length > ${n}`, 180000))) {
  console.log('body:', await h.ev('document.body.innerText.slice(0,2500)'));
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
console.log('result screen:', await h.ev(`(document.body.innerText.split('\\n').filter((l) => /sign|Sign|verif|warn|check|invalid|certif/i.test(l)).slice(0, 12).join(' ;; '))`));
console.log('console errors', JSON.stringify([...new Set(h.errors)].slice(0, 5)));
h.chrome.kill('SIGKILL');
process.exit(0);
