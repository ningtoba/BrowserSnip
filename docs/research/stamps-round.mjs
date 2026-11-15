// `add-stamps` in its own surface, measured: one (or more) click placements, the
// inspector's own opacity and size controls written the way React receives them,
// the overlay's DOM read back, a screenshot, and the exported file.
//
//   BASE=http://localhost:5271 PDF=/tmp/triage/colour.pdf PAGES=1,4 \
//     STAMP_LABEL=Draft OPACITY=0.4 SIZE=30 \
//     OUT=/tmp/r/stamps.pdf SHOT=/tmp/r/stamps.png node docs/research/stamps-round.mjs
//
// `PAGES` is the list of 1-based pages to click, in order; the driver advances the
// editor's page strip to each. It reads every field back out of the DOM before the
// click and prints the mark's own DOM, so a run that wrote nothing looks like one.
// `stamps-check.py` then judges the pixels and the dictionary.
import { writeFileSync } from 'node:fs';
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:5271';
const PDF = process.env.PDF;
const OUT = process.env.OUT || '/tmp/r/stamps.pdf';
const SHOT = process.env.SHOT || '';
const PAGES = (process.env.PAGES || '1').split(',').map(Number);
const STAMP_LABEL = process.env.STAMP_LABEL || 'Draft';
const OPACITY = process.env.OPACITY || '';
const SIZE = process.env.SIZE || '';
if (!PDF) throw new Error('PDF is required');

const h = await open();
const rootId = async () => (await h.send('DOM.getDocument', { depth: -1 })).root.nodeId;
if (process.env.DARK) {
  await h.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
}
await h.send('Page.navigate', { url: `${BASE}/#/tool/add-stamps` });
await h.wait(`!!document.querySelector('input[type=file]')`, 60000);
const docField = await h.send('DOM.querySelector', { nodeId: await rootId(), selector: 'input[type=file]' });
await h.send('DOM.setFileInputFiles', { nodeId: docField.nodeId, files: [PDF] });
// Keep the blobs themselves: the shared harness records only their urls.
await h.ev(`(() => { window.__blobs = []; const make = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { window.__blobs.push(b); return make(b); }; return 1; })()`);
console.log('document in:', PDF);
if (!(await h.wait(`!!document.querySelector('[data-tool="stamp"]')`, 60000))) {
  throw new Error('the stamp tool never appeared in the toolbar');
}
await sleep(2500);

const extent = () => h.ev(`document.querySelector('[data-page-extent]')?.getAttribute('data-page-extent') ?? '?'`);

/** Pick the stamp kind, the way a person does from the inspector's list. */
console.log('stamp kind:', await h.ev(`(() => {
  const wanted = ${JSON.stringify(STAMP_LABEL)}.toLowerCase();
  for (const select of [...document.querySelectorAll('select')].filter((s) => s.offsetParent)) {
    const option = [...select.options].find((o) => (o.text || '').toLowerCase() === wanted);
    if (!option) continue;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, option.value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return 'selected ' + option.text;
  }
  return 'no select offering ' + JSON.stringify(${JSON.stringify(STAMP_LABEL)});
})()`));

/**
 * Write one labelled control and read it back. The panel carries two opacity
 * sliders — the selected mark's (first, while a mark is selected) and the default
 * for the next one — so the selected mark's is written first.
 */
const setField = async (label, value) => {
  if (!value) return `${label} untouched`;
  const did = await h.ev(`(() => {
    const numbers = [...document.querySelectorAll('input[type=number]')].filter((i) => i.offsetParent);
    let target = ${JSON.stringify(label)} === 'Size'
      ? numbers.find((n) => /size/i.test(n.parentElement?.parentElement?.innerText || '')) ?? null
      : null;
    if (!target) {
      const ranges = [...document.querySelectorAll('input[type=range]')].filter((i) => i.offsetParent);
      const selected = document.querySelectorAll('[data-mark]').length > 0;
      if (selected && ranges.length > 0) target = ranges[0];
      else {
        target = ranges.find((range) => (range.parentElement?.parentElement?.innerText || '')
          .trim().toLowerCase().startsWith(${JSON.stringify(label.toLowerCase())})) ?? null;
      }
    }
    if (!target) return 'no ' + ${JSON.stringify(label)} + ' control';
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(target, ${JSON.stringify(String(value))});
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return target.value;
  })()`);
  await sleep(400);
  return `${label}: ${JSON.stringify(value)} -> ${JSON.stringify(did)}`;
};

const nextPage = async () => {
  const spot = JSON.parse(await h.ev(`(() => {
    const nodes = [...document.querySelectorAll('button,a,[role=button],span,div')]
      .filter((b) => b.offsetParent && /^Next/.test((b.innerText || '').trim()));
    if (!nodes.length) return 'null';
    const el = nodes[nodes.length - 1];
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  })()`));
  await h.click(spot.x, spot.y);
  await sleep(1200);
};

let current = 1;
for (const page of PAGES) {
  while (current < page) {
    await nextPage();
    current += 1;
  }
  await h.ev(`document.querySelector('[data-tool="stamp"]').click()`);
  const box = JSON.parse(await h.ev(`(() => {
    const sheet = document.querySelector('[data-tool-gesture]') || document.querySelector('[data-page-extent]');
    const r = sheet.getBoundingClientRect();
    return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
  })()`));
  await h.click(box.x + box.w * 0.82, box.y + box.h * 0.08);
  await sleep(800);
  console.log(`place on p.${current}: extent ${await extent()}, sheet ${Math.round(box.w)}x${Math.round(box.h)} px`);
}
// Written after a placement: the inspector's selected-mark controls are the ones
// that reach that mark (the style defaults were measured to be a separate slider).
console.log('opacity:', await setField('Opacity', OPACITY));
console.log('size:', await setField('Size', SIZE));
await sleep(500);
// The inspector shows the last mark placed, so this is its frame and its type.
console.log('mark dom:', await h.ev(`(() => {
  const m = [...document.querySelectorAll('[data-mark]')].pop();
  return m ? m.outerHTML.slice(0, 400) : 'none';
})()`));
console.log('type dom:', await h.ev(`(() => {
  const g = [...document.querySelectorAll('[data-text-layout]')].pop();
  if (!g) return 'none';
  const t = g.querySelector('text');
  const box = g.getBoundingClientRect();
  const text = t?.getBoundingClientRect();
  return JSON.stringify({
    line: t ? { x: Number(t.getAttribute('x')), y: Number(t.getAttribute('y')), size: t.getAttribute('font-size'), txt: t.textContent } : null,
    layoutBox: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
    textBox: text ? [Math.round(text.x), Math.round(text.y), Math.round(text.width), Math.round(text.height)] : null,
  });
})()`));
if (SHOT) await h.shot(SHOT);

const before = await h.ev('window.__blobs.length');
console.log('export:', await h.ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /Export annotated PDF/i.test(x.innerText || ''));
  if (!b) return 'missing';
  if (b.disabled) return 'disabled: ' + (b.title || '');
  b.click();
  return b.innerText.trim();
})()`));
if (!(await h.wait(`window.__blobs.length > ${before}`, 180000))) {
  console.log('body:', await h.ev('document.body.innerText.slice(0,1200)'));
  throw new Error('no output blob');
}
await sleep(1500);
console.log('new blobs:', await h.ev(`JSON.stringify(window.__blobs.slice(${before}).map((x) => [x && x.type, x && x.size]))`));
const file = await h.ev(`(async () => {
  const fresh = window.__blobs.slice(${before}).filter((x) => x && typeof x.arrayBuffer === 'function');
  fresh.sort((a, b) => b.size - a.size);
  const b = fresh[0];
  if (!b) return 'no pdf blob';
  const u = new Uint8Array(await b.arrayBuffer());
  let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
  return JSON.stringify({ size: u.length, b64: btoa(s) });
})()`);
if (file === 'no pdf blob') throw new Error('no pdf blob');
const info = JSON.parse(file);
writeFileSync(OUT, Buffer.from(info.b64, 'base64'));
console.log('wrote', OUT, info.size, 'bytes');
console.log('status:', await h.ev(`document.querySelector('[data-editor-status]')?.innerText ?? null`));
console.log('console errors', JSON.stringify([...new Set(h.errors)].slice(0, 5)));
h.chrome.kill('SIGKILL');
process.exit(0);
