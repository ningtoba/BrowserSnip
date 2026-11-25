// `sign` on a turned page, and `pdf-crop`'s clamp card — the two pane drives the
// existing rigs do not cover in one shot: a mark placed on a `/Rotate 90` sheet
// (the overlay measures the *displayed* page; the run converts against the stored
// one), and the result card `pdf-crop` prints when three of four sheets are too
// small for the typed margins.
//
//   SCENARIO=sign-turned PDF=/tmp/lane-q3/rich.pdf OUT=/tmp/lane-q3/sign-turned.pdf \
//     SHOT=/tmp/lane-q3/shots/sign-turned.png node docs/research/legacy-pane-cards.mjs
//   SCENARIO=crop-clamp PDF=/tmp/lane-q3/crop/sheets.pdf node docs/research/legacy-pane-cards.mjs
//
// Both print the pane's own claim (the overlay box in page fractions / the panel's
// written-margins line), the result card's full text, and keep the produced blob.
// `verify-sign-read.py` / `crop-units-read.py` judge the bytes; for the turned page
// this rig also prints the mark's fractions as the pane measured them, so the file
// can be checked in the *displayed* frame the user looked at.
import { writeFileSync } from 'node:fs';
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:5296';
const SCENARIO = process.env.SCENARIO || 'sign-turned';
const PDF = process.env.PDF;
const OUT = process.env.OUT || `/tmp/legacy-${SCENARIO}.pdf`;
const SHOT = process.env.SHOT || '';
const TYPED = process.env.TYPED ?? 'TURNPROBE';
/** Where to drag the mark on the turned page, as displayed-page fractions. */
const TARGET = (process.env.TARGET || '0.05,0.72').split(',').map(Number);
if (!PDF) throw new Error('PDF is required');

const h = await open();
const pick = async (selector) => {
  const { root } = await h.send('DOM.getDocument', { depth: -1 });
  return (await h.send('DOM.querySelector', { nodeId: root.nodeId, selector })).nodeId;
};
await h.send('Page.navigate', { url: `${BASE}/#/tool/${SCENARIO === 'sign-turned' ? 'sign' : 'pdf-crop'}` });
if (!(await h.wait(`!!document.querySelector('input[type=file]')`, 60000))) {
  throw new Error(`${BASE} never offered a file input`);
}
await h.ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
await h.send('DOM.setFileInputFiles', { nodeId: await pick('input[type=file]'), files: [PDF] });

const card = () => h.ev(`(() => {
  const section = document.querySelector('section[aria-label="Result"]');
  return section ? section.innerText : (document.body.innerText || '').slice(0, 1200);
})()`);

if (SCENARIO === 'sign-turned') {
  if (!(await h.wait(`/placing on page/i.test(document.body.innerText)`, 60000))) {
    throw new Error('the sign pane never rendered the document');
  }
  await sleep(1500);
  // Walk the pane to the last page — the fixture's turned sheet.
  for (let step = 0; step < (Number(process.env.GOTO_PAGE || 3)) - 1; step++) {
    await h.ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /^Next/.test(x.innerText.trim()) && !x.disabled); if (b) b.click(); return !!b })()`);
    await sleep(1200);
  }
  console.log('pane is at:', (await h.ev(`(document.body.innerText.match(/placing on page \\d+/g) || []).join(',')`)));
  await h.ev(`(()=>{const b=[...document.querySelectorAll('button')].find((x)=>x.textContent.trim()==='Text');b&&b.click()})()`);
  await sleep(400);
  await h.ev(`(() => {
    const el = document.querySelector('#sig-panel-text input[type=text]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(TYPED)});
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(TYPED)} }));
    return 1;
  })()`);
  await sleep(300);
  console.log('add text:', await h.ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /Add text to PDF|Add to PDF/i.test(x.textContent));
    if (!b) return 'no add-text button';
    if (b.disabled) return 'disabled';
    b.click(); return b.textContent.trim();
  })()`));
  await sleep(700);
  // The overlay's display-space box, the way the pane painted it.
  const claim = await h.ev(`(() => {
    const el = document.querySelector('[data-sign-placement]');
    const host = el?.parentElement;
    if (!el || !host) return 'no mark';
    const c = host.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return JSON.stringify({
      canvas: { w: +c.width.toFixed(1), h: +c.height.toFixed(1) },
      xFrac: +((r.x - c.x) / c.width).toFixed(4),
      yBottomFrac: +(1 - (r.y - c.y + r.height) / c.height).toFixed(4),
      wFrac: +(r.width / c.width).toFixed(4),
      hFrac: +(r.height / c.height).toFixed(4),
    });
  })()`);
  console.log('pane claim at default:', claim);
  // Drag it to the asymmetric spot so any frame confusion lands far away.
  const geo = JSON.parse(await h.ev(`(() => {
    const el = document.querySelector('[data-sign-placement]');
    const c = el.parentElement.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return JSON.stringify({ cx: c.x, cy: c.y, cw: c.width, ch: c.height, mx: r.x, my: r.y, mw: r.width, mh: r.height });
  })()`));
  const wantX = geo.cx + geo.cw * TARGET[0];
  const wantY = geo.cy + geo.ch * (1 - TARGET[1]) - geo.mh;
  await h.drag(geo.mx + geo.mw / 2, geo.my + geo.mh / 2, wantX + geo.mw / 2, wantY + geo.mh / 2, 12);
  await sleep(600);
  console.log('pane claim after drag (target ' + TARGET.join(',') + '):', await h.ev(`(() => {
    const el = document.querySelector('[data-sign-placement]');
    const c = el.parentElement.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return JSON.stringify({ xFrac: +((r.x - c.x) / c.width).toFixed(4), yBottomFrac: +(1 - (r.y - c.y + r.height) / c.height).toFixed(4) });
  })()`));
  if (SHOT) await h.shot(SHOT);
  const n = await h.ev('window.__blobs.length');
  console.log('clicked:', await h.ev(`(() => { const b = document.querySelector('#tool-process-btn'); if (!b || b.disabled) return 'unavailable'; b.click(); return b.innerText.trim() })()`));
  if (!(await h.wait(`window.__blobs.length > ${n}`, 120000))) throw new Error('no output blob');
  await sleep(1500);
  console.log('card:', JSON.stringify(await card()));
  const file = await h.ev(`(async () => {
    const b = [...window.__blobs].reverse().find((x) => x && typeof x.arrayBuffer === 'function');
    const u = new Uint8Array(await b.arrayBuffer());
    let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
    return JSON.stringify({ size: u.length, b64: btoa(s) });
  })()`);
  const info = JSON.parse(file);
  writeFileSync(OUT, Buffer.from(info.b64, 'base64'));
  console.log('wrote', OUT, info.size, 'bytes');
} else if (SCENARIO === 'crop-clamp') {
  if (!(await h.wait(`!!document.querySelector('#tool-process-btn')`, 60000))) {
    throw new Error('the crop pane never rendered');
  }
  await sleep(1500);
  const sides = (process.env.MARGINS || '1000/1000/1000/1000').split('/');
  const write = async (selector, value) => h.ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'missing';
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  })()`);
  if (!(await h.wait(`!!document.querySelector('[data-crop-margin="top"]')`, 60000))) {
    throw new Error('the crop panel never mounted its margin fields');
  }
  await write('#tool-field-unit', process.env.UNIT || 'pt');
  for (const [key, value] of [['top', sides[0]], ['right', sides[1]], ['bottom', sides[2]], ['left', sides[3]]]) {
    await write(`[data-crop-margin="${key}"]`, value);
    await sleep(150);
  }
  console.log('panel says:', await h.ev(`JSON.stringify({
    written: document.querySelector('[data-crop-written-pt]')?.textContent?.trim() ?? null,
    kept: document.querySelector('[data-crop-kept]')?.textContent?.trim() ?? null,
    enabled: !(document.querySelector('#tool-process-btn')?.disabled ?? true),
  })`));
  const n = await h.ev('window.__blobs.length');
  console.log('clicked:', await h.ev(`(() => { const b = document.querySelector('#tool-process-btn'); if (!b) return 'missing'; if (b.disabled) return 'disabled: ' + (b.title || ''); b.click(); return b.innerText.trim() })()`));
  if (!(await h.wait(`window.__blobs.length > ${n}`, 120000))) {
    console.log('screen:', JSON.stringify(await h.ev(`(document.body.innerText || '').slice(0, 1200)`)));
    throw new Error('no output blob');
  }
  await sleep(1500);
  console.log('card:', JSON.stringify(await card()));
  const file = await h.ev(`(async () => {
    const b = [...window.__blobs].reverse().find((x) => x && typeof x.arrayBuffer === 'function');
    const u = new Uint8Array(await b.arrayBuffer());
    let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
    return JSON.stringify({ size: u.length, b64: btoa(s) });
  })()`);
  const info = JSON.parse(file);
  writeFileSync(OUT, Buffer.from(info.b64, 'base64'));
  console.log('wrote', OUT, info.size, 'bytes');
} else {
  throw new Error(`unknown SCENARIO ${SCENARIO}`);
}
console.log('network page errors:', JSON.stringify([...new Set(h.errors)].slice(0, 3)));
h.chrome.kill('SIGKILL');
process.exit(0);
