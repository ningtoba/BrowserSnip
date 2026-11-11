// `add-stamps` in its own surface: arm the stamp, click pages, export.
//
//   BASE=https://www.browsersnip.com PDF=/tmp/eight/stamps-source.pdf CLICKS=0.8/0.08,0.2/0.85 \
//     OUT=/tmp/eight/stamped.pdf node docs/research/verify-stamps-pane.mjs
//
// `add-stamps` mounts the annotation editor, not a generated rail, so the fields the
// tool declares are reached through the editor's own toolbar and inspector. This
// dumps what the surface actually offers, arms the stamp tool with a real click,
// places one mark per page at a fractional point on the sheet (`CLICKS`, advanced with
// the page control), reads the count the button claims, and exports.
// `verify-stamps-read.py` then asks MuPDF, pikepdf and poppler where those marks are.
import { writeFileSync } from 'node:fs';
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'https://www.browsersnip.com';
const PDF = process.env.PDF;
const OUT = process.env.OUT || '/tmp/eight/stamped.pdf';
const CLICKS = (process.env.CLICKS || '0.8/0.1,0.75/0.12').split(',').map((pair) => pair.split('/').map(Number));
const STAMP_LABEL = process.env.STAMP_LABEL || 'Draft';
const SHOT = process.env.SHOT || '';
if (!PDF) throw new Error('PDF is required');

const h = await open();
const rootId = async () => (await h.send('DOM.getDocument', { depth: -1 })).root.nodeId;
await h.send('Page.navigate', { url: `${BASE}/#/tool/add-stamps` });
await h.wait(`!!document.querySelector('input[type=file]')`, 60000);
await h.ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
await h.ev(`(() => { const i = [...document.querySelectorAll('input[type=file]')].find((x) => !x.closest('[role=group]')); if (i) i.setAttribute('data-probe-doc','1'); return !!i; })()`);
const docField = await h.send('DOM.querySelector', { nodeId: await rootId(), selector: 'input[data-probe-doc]' });
await h.send('DOM.setFileInputFiles', { nodeId: docField.nodeId, files: [PDF] });
console.log('document in:', PDF);
if (!(await h.wait(`!!document.querySelector('[data-tool=\"stamp\"]')`, 60000))) {
  console.log('body:', await h.ev('document.body.innerText.slice(0,900)'));
  throw new Error('the stamp tool never appeared in the toolbar');
}
await sleep(2500);
console.log('surface census:', await h.ev(`JSON.stringify({
  tools: [...document.querySelectorAll('[data-tool]')].map((b) => b.getAttribute('data-tool')),
  armed: document.querySelector('[data-armed-tool]')?.getAttribute('data-armed-tool') ?? null,
  extent: document.querySelector('[data-page-extent]')?.getAttribute('data-page-extent') ?? null,
  selects: [...document.querySelectorAll('select')].filter((s) => s.offsetParent).map((s) => (s.id || s.getAttribute('aria-label') || 'unlabelled') + '=' + (s.options[s.selectedIndex]?.text ?? s.value)),
  pageControls: [...document.querySelectorAll('button,[role=button]')].filter((b) => b.offsetParent && /page|▸|◂|›|‹/i.test((b.innerText || '') + (b.getAttribute('aria-label') || '')).valueOf()).map((b) => (b.getAttribute('aria-label') || b.innerText.trim()).slice(0, 24)).slice(0, 12),
  export: (document.querySelector('#tool-process-btn, [data-export-btn]')?.innerText || '').trim() || null,
  status: document.querySelector('[data-editor-status]')?.innerText ?? null,
})`));

// Pick the stamp kind in the inspector, the way a person does from the list.
console.log('stamp kind:', await h.ev(`(() => {
  const wanted = ${JSON.stringify(STAMP_LABEL)}.toLowerCase();
  for (const select of [...document.querySelectorAll('select')].filter((s) => s.offsetParent)) {
    const option = [...select.options].find((o) => (o.text || '').toLowerCase().includes(wanted));
    if (!option) continue;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, option.value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return 'selected ' + option.text + ' in #' + (select.id || select.getAttribute('aria-label') || 'unlabelled');
  }
  return 'no select offering ' + JSON.stringify(STAMP_LABEL);
})()`));

const armStamp = () => h.ev(`(() => {
  const b = document.querySelector('[data-tool="stamp"]');
  if (!b) return 'missing';
  b.click();
  return 'armed=' + (document.querySelector('[data-armed-tool]')?.getAttribute('data-armed-tool') ?? '?');
})()`);
console.log('arm:', await armStamp());

/** Click at a fraction of the displayed sheet. */
const clickAt = async (fx, fy) => {
  const box = await h.ev(`(() => {
    const sheet = document.querySelector('[data-tool-gesture]') || document.querySelector('[data-page-extent]');
    if (!sheet) return null;
    const r = sheet.getBoundingClientRect();
    return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height, tag: sheet.tagName.toLowerCase(),
      extent: document.querySelector('[data-page-extent]')?.getAttribute('data-page-extent') ?? null });
  })()`);
  if (!box) return 'no sheet';
  const rect = JSON.parse(box);
  await h.click(rect.x + rect.w * fx, rect.y + rect.h * fy);
  await sleep(700);
  return `clicked ${fx}/${fy} of a ${Math.round(rect.w)}x${Math.round(rect.h)} px <${rect.tag}> showing ${rect.extent}`;
};

/** The editor's page strip is text, not an accessible control; aim at its box. */
const nextPage = async () => {
  const where = await h.ev(`(() => {
    const nodes = [...document.querySelectorAll('button,a,[role=button],span,div')]
      .filter((b) => b.offsetParent && /^Next/.test((b.innerText || '').trim()));
    if (nodes.length === 0) return null;
    const el = nodes[nodes.length - 1];
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, text: el.innerText.trim(), tag: el.tagName.toLowerCase() });
  })()`);
  if (!where) return 'no Next control';
  const spot = JSON.parse(where);
  await h.click(spot.x, spot.y);
  await sleep(1200);
  return `clicked <${spot.tag}> ${JSON.stringify(spot.text)} at ${Math.round(spot.x)},${Math.round(spot.y)}`;
};

for (const [index, [fx, fy]] of CLICKS.entries()) {
  if (index > 0) console.log('page:', await nextPage(), '· extent now',
    await h.ev(`document.querySelector('[data-page-extent]')?.getAttribute('data-page-extent') ?? '?'`));
  if (index > 0) await armStamp();
  console.log(`place ${index + 1}:`, await clickAt(fx, fy));
}
console.log('marks:', await h.ev(`JSON.stringify({
  count: document.querySelectorAll('[data-mark]').length,
  export: (document.body.innerText.match(/Export annotated PDF \\((\\d+)\\)/) || [])[1] ?? null,
  status: document.querySelector('[data-editor-status]')?.innerText ?? null,
})`));
if (SHOT) await h.shot(SHOT);

const n = await h.ev('window.__blobs.length');
console.log('export:', await h.ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /Export annotated PDF/i.test(x.innerText || ''));
  if (!b) return 'missing';
  if (b.disabled) return 'disabled: ' + (b.title || '');
  b.click(); return b.innerText.trim();
})()`));
if (!(await h.wait(`window.__blobs.length > ${n}`, 180000))) {
  console.log('body:', await h.ev('document.body.innerText.slice(0,1400)'));
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
console.log('result screen:', await h.ev(`(document.body.innerText.split('\\n').filter((l) => /stamp|Stamp|placed|Placed|page/i.test(l)).slice(0, 8).join(' ;; '))`));
console.log('console errors', JSON.stringify([...new Set(h.errors)].slice(0, 5)));
h.chrome.kill('SIGKILL');
process.exit(0);
