// `sign` on a live build: draw a signature with real mouse events, place it, drag
// it, change the zoom, export, and keep the bytes.
//
//   BASE=https://www.browsersnip.com PDF=/tmp/eight/ruled.pdf OUT=/tmp/eight/sign-a.pdf \
//     node docs/research/verify-sign-run.mjs
//
// The pane keeps its own idea of where the mark is (`x`/`y` as fractions of the
// page it sits on, `w`/`h` in points). This reads that back off the painted overlay
// — the mark's CSS box divided by the canvas box, with the page geometry the fixture
// was built with — presses "Place N signatures", and takes the produced blob. The
// second export happens after the viewport is resized, which is the zoom change: the
// overlay recomputes its scale, and a mark anchored to a PDF point must not move.
// One export is taken at the end, carrying both marks and both page geometries.
import { writeFileSync } from 'node:fs';
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'https://www.browsersnip.com';
const PDF = process.env.PDF;
const OUT = process.env.OUT || '/tmp/eight/sign.pdf';
const SHOT2 = process.env.SHOT2 || '';
const SHOT = process.env.SHOT || '';
/** Page boxes of the fixture, in order, as `595x842,400x300`. */
const PAGES = (process.env.PAGES || '595x842,595x842,400x300')
  .split(',').map((spec) => spec.split('x').map(Number));
/** Where to drag the mark, as fractions of the page: `left,bottom-from-pdf-origin`. */
const TARGET = (process.env.TARGET || '0.08,0.12').split(',').map(Number);
const TYPED = process.env.TYPED ?? 'Ada Lovelace';

if (!PDF) throw new Error('PDF is required');
const h = await open();
const pick = async (selector) => {
  const { root } = await h.send('DOM.getDocument', { depth: -1 });
  return (await h.send('DOM.querySelector', { nodeId: root.nodeId, selector })).nodeId;
};

await h.send('Page.navigate', { url: `${BASE}/#/tool/sign` });
if (!(await h.wait(`!!document.querySelector('input[type=file]')`, 60000))) {
  throw new Error(`${BASE} never offered a file input`);
}
await h.ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);
  URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
await h.send('DOM.setFileInputFiles', { nodeId: await pick('input[type=file]'), files: [PDF] });
if (!(await h.wait(`/placing on page/i.test(document.body.innerText)`, 60000))) {
  console.log('body:', await h.ev('document.body.innerText.slice(0,600)'));
  throw new Error('the sign pane never rendered the document');
}
await sleep(1500);

/** The overlay's marks, converted from CSS px back to the pane's own units. */
const marks = () => h.ev(`(() => {
  const sizes = ${JSON.stringify(PAGES)};
  const out = [];
  for (const el of document.querySelectorAll('[data-sign-placement]')) {
    const host = el.parentElement;
    if (!host) continue;
    const c = host.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const found = (el.getAttribute('aria-label') || '').match(/page (\\d+)/);
    const page = found ? Number(found[1]) : 1;
    const sz = sizes[page - 1] || [595, 842];
    const scale = c.width / sz[0];
    out.push({
      label: el.getAttribute('aria-label'),
      page: page,
      px: { x: +(r.x - c.x).toFixed(1), y: +(r.y - c.y).toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
      abs: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
      canvas: { w: +c.width.toFixed(1), h: +c.height.toFixed(1) },
      scale: +scale.toFixed(4),
      xFrac: +((r.x - c.x) / c.width).toFixed(4),
      yFrac: +(1 - (r.y - c.y + r.height) / c.height).toFixed(4),
      wPt: +(r.width / scale).toFixed(2),
      hPt: +(r.height / scale).toFixed(2),
    });
  }
  return JSON.stringify(out);
})()`);

const screen = () => h.ev(`(() => {
  const lines = document.body.innerText.split('\\n');
  const find = (re) => { for (const l of lines) { if (re.test(l)) return l.trim(); } return null; };
  const btn = document.querySelector('#tool-process-btn');
  const blocked = document.querySelector('[data-sign-blocked]');
  const off = document.querySelector('[data-sign-offpage]');
  return JSON.stringify({
    doc: find(/placing on page/i),
    blocked: blocked ? blocked.innerText.trim() : null,
    offpage: off ? off.getAttribute('data-sign-offpage') : null,
    button: btn ? btn.innerText.trim() : null,
    enabled: btn ? !btn.disabled : false,
    notice: find(/Mark was|could not|left out/i),
  });
})()`);

console.log('screen at intake:', await screen());

// ── Draw a signature with real mouse events on the pad ───────────────────────
await h.ev(`(()=>{const b=[...document.querySelectorAll('button')].find((x)=>x.textContent.trim()==='Draw');b&&b.click();return !!b})()`);
await sleep(400);
const pad = await h.ev(`(() => {
  const c = document.querySelector('#sig-panel-draw canvas');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
})()`);
if (!pad) throw new Error('the Draw tab has no canvas');
const box = JSON.parse(pad);
// A zig-zag stroke, so the exported pixels have a recognisable bounding box.
const stroke = [[0.1, 0.7], [0.28, 0.2], [0.46, 0.75], [0.64, 0.25], [0.86, 0.6]];
await h.mouse('mousePressed', box.x + box.w * stroke[0][0], box.y + box.h * stroke[0][1], 1);
for (const [fx, fy] of stroke.slice(1)) {
  await h.mouse('mouseMoved', box.x + box.w * fx, box.y + box.h * fy, 1);
  await sleep(60);
}
await h.mouse('mouseReleased', box.x + box.w * stroke.at(-1)[0], box.y + box.h * stroke.at(-1)[1], 0);
await sleep(400);
console.log('pad drawn, ink pixels:', await h.ev(`(() => {
  const c = document.querySelector('#sig-panel-draw canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
  return n;
})()`));
const addDraw = await h.ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /Add drawing to PDF/i.test(x.textContent));
  if (!b || b.disabled) return 'unavailable';
  b.click(); return b.textContent.trim();
})()`);
console.log('clicked', JSON.stringify(addDraw));
await sleep(600);
console.log('marks after add:', await marks());
console.log('screen after add:', await screen());

// ── Type a second signature ─────────────────────────────────────────────────
await h.ev(`(()=>{const b=[...document.querySelectorAll('button')].find((x)=>x.textContent.trim()==='Text');b&&b.click()})()`);
await sleep(400);
const typedState = await h.ev(`(() => {
  const el = [...document.querySelectorAll('input')].find((i) => /type the name|your name/i.test(i.placeholder || '') || i.closest('#sig-panel-text'));
  if (!el) return 'no text field in the Text panel; inputs: ' + [...document.querySelectorAll('input')].map((i) => i.placeholder || i.type).join(' | ');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(TYPED)});
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(TYPED)} }));
  return 'typed into ' + (el.placeholder || el.type);
})()`);
console.log('typed:', typedState);
await sleep(300);
console.log('add text:', await h.ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /Add text to PDF|Add to PDF/i.test(x.textContent));
  if (!b) return 'no add-text button';
  if (b.disabled) return 'disabled: ' + (b.title || '');
  b.click(); return b.textContent.trim();
})()`));
await sleep(600);
console.log('marks now:', await marks());

// ── Drag the first mark to a chosen spot, with real mouse events ─────────────
const before = JSON.parse(await marks());
if (before.length === 0) throw new Error('nothing was placed on the page at all');
const first = before[0];
// The pointer events are in viewport coordinates; `px` is relative to the canvas.
const cx = first.abs.x + first.abs.w / 2;
const cy = first.abs.y + first.abs.h / 2;
// Target: left edge at TARGET[0] of the canvas width, bottom edge at TARGET[1].
const wantX = first.canvas.w * TARGET[0] + first.px.w / 2;
const wantY = first.canvas.h * (1 - TARGET[1]) - first.px.h / 2;
await h.drag(cx, cy, cx + (wantX - first.px.x - first.px.w / 2), cy + (wantY - first.px.y - first.px.h / 2), 12);
await sleep(600);
console.log('marks after drag:', await marks());
const claim = (list) => list.map((m) => `${m.page},${m.xFrac},${m.yFrac},${m.wPt},${m.hPt}`).join(';');
console.log('PANEL CLAIM (page,xFrac,yFrac,wPt,hPt):', claim(JSON.parse(await marks())));
if (SHOT) await h.shot(SHOT);

// ── Export ────────────────────────────────────────────────────────────────────
const takeBlob = async (path) => {
  const n = await h.ev('window.__blobs.length');
  const clicked = await h.ev(`(() => { const b = document.querySelector('#tool-process-btn'); if (!b) return 'missing'; if (b.disabled) return 'disabled: ' + (b.title || ''); b.click(); return b.innerText.trim(); })()`);
  console.log('run click:', JSON.stringify(clicked));
  if (String(clicked).startsWith('disabled')) {
    // The pane's own reason is the verdict: a mark is on the page and the button
    // still refuses. Wait a little, in case the run is slow to start anyway.
    await sleep(4000);
    if (!(await h.ev(`window.__blobs.length > ${n}`))) {
      console.log('VERDICT: the action refused to run —', clicked);
      return false;
    }
  }
  if (!(await h.wait(`window.__blobs.length > ${n}`, 120000))) {
    console.log('screen:', await h.ev('document.body.innerText.slice(0,1200)'));
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
  writeFileSync(path, Buffer.from(info.b64, 'base64'));
  console.log('wrote', path, info.size, 'bytes');
  return true;
};
console.log('result screen:', await h.ev(`(document.body.innerText.match(/[^\\n]*(signature|Signature|placed|Placed)[^\\n]*/g) || []).slice(0, 8).join(' ;; ')`));
console.log('PANEL CLAIM, page 1 (page,xFrac,yFrac,wPt,hPt):', claim(JSON.parse(await marks())));

// ── A mark on the small page: the same fractions mean different points ────────
const atPage = () => h.ev(`(() => {
  const line = document.body.innerText.split('\\n').find((l) => /placing on page/i.test(l)) || '';
  const found = line.match(/placing on page (\\d+)/);
  return found ? Number(found[1]) : -1;
})()`);
const goNext = async (want) => {
  for (let step = 0; step < want; step++) {
    const before = await atPage();
    const clicked = await h.ev(`(() => {
      const list = [...document.querySelectorAll('button')].filter((x) => /^Next/.test(x.innerText.trim()) && !x.disabled);
      if (list.length !== 1) return 'candidates: ' + list.length;
      list[0].click();
      return 'clicked';
    })()`);
    await sleep(1200);
    console.log(`page ${before} -> ${await atPage()} (Next: ${clicked})`);
  }
  return atPage();
};
const shown = await goNext(2);
const onSmall = await h.ev(`(() => {
  const list = [...document.querySelectorAll('[aria-label^="Place the"]')];
  if (list.length === 0) return 'no place-again buttons';
  list[0].click();
  return 'duplicated ' + list[0].getAttribute('aria-label');
})()`);
await sleep(600);
console.log('small page:', onSmall, '· pane is showing page', shown, 'of 3');
console.log('marks on the page the pane is showing:', await marks());
console.log('PANEL CLAIM, page 3 (page,xFrac,yFrac,wPt,hPt):', claim(JSON.parse(await marks())));
const notice = await h.ev(`(document.querySelector('[data-sign-blocked]')?.innerText || '').trim()`);
console.log('pane notice:', JSON.stringify(notice));

// ── Zoom: the same mark has to describe the same point of the page ────────────
const beforeZoom = JSON.parse(await marks());
await h.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await sleep(2500);
const afterZoom = JSON.parse(await marks());
console.log('zoomed to 1280x900, marks:', JSON.stringify(afterZoom));
// The claim is read back off a CSS box, so it is only accurate to a screen pixel:
// at the smaller scale one pixel is 1/0.8775 = 1.14 pt of the page. A mark anchored
// to a page point must stay inside that noise; string equality would be a stricter
// test than the measurement can support.
const drift = beforeZoom.map((m, i) => {
  const o = afterZoom[i] ?? {};
  return { page: m.page, dx: +(o.xFrac - m.xFrac).toFixed(4), dy: +(o.yFrac - m.yFrac).toFixed(4), dw: +(o.wPt - m.wPt).toFixed(2) };
});
const settled = drift.every((d) => Math.abs(d.dx) < 0.002 && Math.abs(d.dy) < 0.002 && Math.abs(d.dw) < 0.5);
console.log('zoom drift (fractions of the page, and pt):', JSON.stringify(drift),
  '·', settled ? 'the same point of the page at the new scale' : 'MOVED WITH ZOOM');
await h.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1400, deviceScaleFactor: 1, mobile: false });
await sleep(2000);
if (SHOT2) await h.shot(SHOT2);
await takeBlob(OUT);
console.log('screen after the run:', await screen());
console.log('console errors', JSON.stringify([...new Set(h.errors)].slice(0, 4)));
h.chrome.kill('SIGKILL');
process.exit(0);
