// `timestamp-pdf` on a live build, in the chain the tool itself asks for.
//
//   BASE=https://www.browsersnip.com PDF=/tmp/eight/digital-fixed.pdf \
//     TSA=http://timestamp.digicert.com OUT=/tmp/eight/timestamped.pdf \
//     node docs/research/verify-timestamp-run.mjs
//
// The card refuses an unsigned file and says so — "Run Digital Signature on it first,
// then timestamp the signed file" — so the honest measurement is the chain: sign a
// document, hand the signed file to this tool, take the output. The default authority
// is a real RFC 3161 responder and the run is reported whether or not it can be
// reached: this is the one PDF step in the app that contacts a server, and the tool
// says the only thing it sends is a digest of the signature. The pane's own sentence
// is captured so `verify-timestamp-read.py` can be checked against it.
import { writeFileSync } from 'node:fs';
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'https://www.browsersnip.com';
const PDF = process.env.PDF;
const TSA = process.env.TSA || 'http://timestamp.digicert.com';
const OUT = process.env.OUT || '/tmp/eight/timestamped.pdf';
const FIELD = process.env.FIELD || '';
if (!PDF) throw new Error('PDF is required');

const h = await open();
const rootId = async () => (await h.send('DOM.getDocument', { depth: -1 })).root.nodeId;
await h.send('Page.navigate', { url: `${BASE}/#/tool/timestamp-pdf` });
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
  bar[0].click(); return 'opened';
})()`));
await sleep(800);
const write = async (id, value) => h.ev(`(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  if (!el) return 'missing #' + ${JSON.stringify(id)};
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(value)} }));
  return ${JSON.stringify(id)} + '=' + el.value;
})()`);
console.log('tsa   :', await write('tool-field-tsa', TSA));
if (FIELD) console.log('field :', await write('tool-field-fieldName', FIELD));
console.log('state :', await h.ev(`JSON.stringify({
  button: (document.querySelector('#tool-process-btn')?.innerText || '').trim(),
  enabled: !(document.querySelector('#tool-process-btn')?.disabled ?? true),
  note: (document.body.innerText.match(/[^\\n]*(signature|sign|network|authority)[^\\n]*/gi) || []).slice(0, 4),
})`));

const n = await h.ev('window.__blobs.length');
console.log('run:', await h.ev(`(() => { const b = document.querySelector('#tool-process-btn'); if (!b) return 'missing'; if (b.disabled) return 'disabled: ' + (b.title || ''); b.click(); return b.innerText.trim(); })()`));
const produced = await h.wait(`window.__blobs.length > ${n}`, 120000);
if (!produced) {
  console.log('refused with:', await h.ev(`(document.body.innerText.split('\\n').filter((l) => /signature|timestamp|network|failed|could not|no /i.test(l)).slice(0, 8).join(' ;; '))`));
  console.log('body tail:', await h.ev('document.body.innerText.slice(0,1200)'));
  h.chrome.kill('SIGKILL');
  process.exit(2);
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
console.log('result screen:', await h.ev(`(document.body.innerText.split('\\n').filter((l) => /timestamp|attested|authority|digest|network|warn/i.test(l)).slice(0, 8).join(' ;; '))`));
console.log('console errors', JSON.stringify([...new Set(h.errors)].slice(0, 4)));
h.chrome.kill('SIGKILL');
process.exit(0);
