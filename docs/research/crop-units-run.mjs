// One `pdf-crop` run on a live build, in one unit, with the download kept.
//
//   BASE=https://www.browsersnip.com UNIT=mm MARGINS=7.62/10.16/15.24/20.32 \
//     PDF=/tmp/crop-units/sheets.pdf OUT=/tmp/crop-units/crop-units-mm.pdf \
//     node docs/research/crop-units-run.mjs
//
// The crop page mounts a pane, not a generated rail, so this drives the pane: it sets
// the unit select the way a person does (through the framework's own value setter, so
// React notices), types the four margins, reads the points the panel claims the file
// will hold, presses Apply and takes the produced blob. The claim and the bytes are
// printed side by side; `crop-units-read.py` is what reads the boxes.
//
// SHOT=<file.png> captures the panel after the margins are typed, which is the
// dark-mode record for the control.
import { writeFileSync } from 'node:fs';
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:5291';
const UNIT = process.env.UNIT || 'pt';
const MARGINS = (process.env.MARGINS || '21.6/28.8/43.2/57.6').split('/').map(Number);
const PDF = process.env.PDF;
const OUT = process.env.OUT || `/tmp/crop-units/crop-units-${UNIT}.pdf`;
const SHOT = process.env.SHOT || '';
/** Theme for the screenshot: `1` demands dark, `0` demands light, unset leaves it be. */
const DARK = process.env.DARK === undefined ? null : process.env.DARK === '1';
if (!PDF) throw new Error('PDF is required (see crop-units-fixture.mjs)');
if (MARGINS.length !== 4) throw new Error('MARGINS wants top/right/bottom/left');

const h = await open();
const pick = async (selector) => {
  const { root } = await h.send('DOM.getDocument', { depth: -1 });
  return (await h.send('DOM.querySelector', { nodeId: root.nodeId, selector })).nodeId;
};

await h.send('Page.navigate', { url: `${BASE}/#/tool/pdf-crop` });
if (!(await h.wait(`!!document.querySelector('input[type=file]')`, 60000))) {
  throw new Error(`${BASE} never offered a file input`);
}
await h.ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
if (DARK !== null) {
  // The theme is persisted, so the probe sets it rather than flipping it: clicking a
  // toggle blind once labelled a dark screenshot "light" because the previous run had
  // already switched the app over.
  const wantDark = DARK;
  console.log('theme:', await h.ev(`(() => {
    const isDark = document.documentElement.classList.contains('dark');
    if (isDark === ${wantDark ? 'true' : 'false'}) return 'already ' + (${wantDark ? '"dark"' : '"light"'});
    const b = [...document.querySelectorAll('button')].find((x) => /theme|dark|light/i.test((x.getAttribute('aria-label') || '') + (x.title || '')));
    if (!b) return 'no toggle found';
    b.click();
    return (b.getAttribute('aria-label') || b.title) + ' (persisted: ' + isDark + ')';
  })()`));
  await sleep(400);
}
await h.send('DOM.setFileInputFiles', { nodeId: await pick('input[type=file]'), files: [PDF] });

// The panel measures the document before a typed margin means anything.
if (!(await h.wait(`!!document.querySelector('#tool-field-unit') && !!document.querySelector('[data-crop-margin="top"]')`, 60000))) {
  throw new Error('the crop panel never mounted its unit control and margin fields');
}

/** Set a framework-controlled field the way a keyboard would. */
const write = async (selector, value) => h.ev(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return 'missing';
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value;
})()`);

const sides = ['top', 'right', 'bottom', 'left'];
// Always write the select, even for `pt`: the panel keeps whatever unit the last run
// left in the form, and a file named `-pt.pdf` that was cropped in millimetres is the
// kind of result a probe should not be able to produce.
await write('#tool-field-unit', UNIT);
for (const [index, side] of sides.entries()) {
  await write(`[data-crop-margin="${side}"]`, MARGINS[index]);
  await sleep(120);
}
const claims = await h.ev(`JSON.stringify({
  unit: document.querySelector('#tool-field-unit')?.value ?? null,
  typed: ['top','right','bottom','left'].map((s) => document.querySelector('[data-crop-margin="'+s+'"]')?.value ?? null),
  written: document.querySelector('[data-crop-written-pt]')?.textContent?.trim() ?? null,
  kept: document.querySelector('[data-crop-kept]')?.textContent?.trim() ?? null,
  doc: document.querySelector('[data-crop-doc-pages]')?.textContent?.trim() ?? null,
  enabled: !(document.querySelector('#tool-process-btn')?.disabled ?? true),
})`);
console.log('panel says:', claims);
const stated = JSON.parse(claims);
if (stated.unit !== UNIT) throw new Error(`the panel is in ${stated.unit}, not ${UNIT}`);
if (stated.written === null || !stated.enabled) {
  throw new Error(`the panel offered no prediction (${stated.written}) or no action (${stated.enabled})`);
}
if (SHOT) {
  // What the panel's own surfaces are painted with, so a hard-coded colour shows up
  // in the record rather than in someone's reading of the screenshot.
  console.log('paint:', await h.ev(`JSON.stringify({
    theme: document.documentElement.className,
    body: getComputedStyle(document.body).backgroundColor,
    input: (() => { const el = document.querySelector('[data-crop-margin="top"]'); const cs = el && getComputedStyle(el); return cs ? { bg: cs.backgroundColor, color: cs.color, border: cs.borderColor } : null; })(),
    select: (() => { const cs = getComputedStyle(document.querySelector('#tool-field-unit')); return { bg: cs.backgroundColor, color: cs.color }; })(),
  })`));
  await h.shot(SHOT);
}

const count = await h.ev('window.__blobs.length');
const clicked = await h.ev(`(() => { const b = document.querySelector('#tool-process-btn'); if (!b || b.disabled) return 'unavailable'; b.click(); return b.innerText.trim(); })()`);
console.log('clicked', JSON.stringify(clicked));
if (!(await h.wait(`window.__blobs.length > ${count}`, 120000))) {
  console.log('the screen says:', await h.ev(`(document.body.innerText || '').slice(0, 1200)`));
  throw new Error(`the ${UNIT} run produced no output blob`);
}
await sleep(1200);
// `audit3-cdp.mjs` keeps its own record beside this script's, and its entries are
// `{url, size}` rather than the blob, so the last *blob* is the produced file.
const file = await h.ev(`(async () => {
  const b = [...window.__blobs].reverse().find((x) => x && typeof x.arrayBuffer === 'function');
  if (!b) return JSON.stringify({ error: 'no blob in the record' });
  const u = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
  return JSON.stringify({ type: b.type, size: u.length, b64: btoa(s) });
})()`);
const info = JSON.parse(file);
if (info.error) throw new Error(info.error);
writeFileSync(OUT, Buffer.from(info.b64, 'base64'));
console.log('result screen:', await h.ev(`(document.body.innerText.match(/[^\\n]*(Crop|cropped|pt|were taken)[^\\n]*/gi) || []).slice(0, 8).join(' ;; ')`));
console.log('output', JSON.stringify({ type: info.type, bytes: info.size, file: OUT, unit: UNIT }));
console.log('console errors', JSON.stringify([...new Set(h.errors)].slice(0, 4)));
h.chrome.kill('SIGKILL');
process.exit(0);
