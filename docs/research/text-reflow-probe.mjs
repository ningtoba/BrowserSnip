/**
 * Re-flow probe for `edit-pdf-text`: where does a replacement that needs more
 * lines than the block came from actually land — on the pane, and in the file?
 *
 *   BASE=http://localhost:5271 node docs/research/text-reflow-probe.mjs
 *   CASE=short|long|rot BASE=... node docs/research/text-reflow-probe.mjs
 *
 * Cases (fixtures from `text-reflow-fixture.py`):
 *   long   reflow.pdf p1: the two-line target replaced with ten lines' worth —
 *          the collision case, and the pane screenshot.
 *   short  control.pdf: 40 characters into the same two-line block — it fits
 *          inside the block, so nothing may move and nothing may shrink (the
 *          instrument's control).
 *   rot    reflow.pdf p2, stored `/Rotate 90`: the same block in a turned frame.
 *
 * Prints, per case: the block's own origin and how far the painted text goes
 * past it, on screen (the committed overlay's own rect against the neighbouring
 * line's painted place on the canvas) and the export report's sentence. The
 * exported bytes are read back out of the page and written to OUT for
 * `text-reflow-measure.py`, which judges the file.
 */
import fs from 'node:fs';
import { open, HELPERS, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:5271';
const CASE = process.env.CASE || 'long';
const OUT = process.env.OUT || `/tmp/rf/out-${CASE}.pdf`;
const SHOT = process.env.SHOT || `docs/research/shots/reflow-${CASE}.png`;
const DIR = process.env.DIR || '/tmp/rf';

const CASE_FILE = { long: `${DIR}/reflow.pdf`, short: `${DIR}/control.pdf`, rot: `${DIR}/reflow.pdf`, rotmap: `${DIR}/reflow.pdf` };
const PAGE = { long: 1, short: 1, rot: 2, rotmap: 2 };

/** Ten lines' worth at the block's own width; 40 characters for the control. */
const LONG_TEXT =
  'TARGET ALPHA bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo ' +
  'sierra tango uniform victor whiskey xray yankee zulu again and again with more words still more words to fill more ' +
  'lines than the two this block came from because ten lines is the case and this sentence has to be long enough.';
const SHORT_TEXT = 'Short words only in this block.';

fs.mkdirSync('docs/research/shots', { recursive: true });
const h = await open();
const log = (label, value) => console.log(`\n## ${label}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`);

const pick = async (sel) => {
  const { root } = await h.send('DOM.getDocument', { depth: -1 });
  return (await h.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel })).nodeId;
};

await h.send('Page.navigate', { url: `${BASE}/#/tool/edit-pdf-text` });
await h.wait(`!!document.querySelector('input[type=file][accept*="pdf"]')`, 40000);
await sleep(4000);
// The intake re-renders while the tool definition loads, so a node id taken once
// can go stale between the query and the upload: take it again on failure.
for (let attempt = 0; attempt < 5; attempt++) {
  try {
    await h.send('DOM.setFileInputFiles', { nodeId: await pick('input[type=file][accept*="pdf"]'), files: [CASE_FILE[CASE]] });
    break;
  } catch (err) {
    if (attempt === 4) throw err;
    await sleep(600);
  }
}
await h.wait(`document.querySelectorAll('[data-editable-block="yes"]').length > 0`, 40000);
await sleep(2500);
await h.ev(HELPERS);

// Page 2 of the rotated case.
if (PAGE[CASE] === 2) {
  await h.ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => (x.title || '') === 'Next page');
    if (!b) return 'no next button';
    b.click();
    return 'clicked';
  })()`);
  await sleep(2500);
  console.log('page field now', await h.ev(`document.querySelector('input[aria-label="Jump to page"]')?.value ?? '?'`));
}

/** The block that holds the target's first words, and the neighbour under it. */
const geometry = async () =>
  h.ev(`(() => {
    const want = 'TARGET ALPHA';
    const canvas = document.querySelector('canvas');
    const nodes = [...document.querySelectorAll('[data-editable-block="yes"]')];
    const hit = nodes.find((n) => (n.getAttribute('aria-label') || '').includes(want));
    if (!hit || !canvas) return null;
    const r = hit.getBoundingClientRect();
    const c = canvas.getBoundingClientRect();
    const scale = canvas.width ? c.width / canvas.width : 1;
    // The neighbour is the next block down the page, in the same (viewer) frame.
    const below = nodes
      .filter((n) => n !== hit)
      .map((n) => ({ r: n.getBoundingClientRect(), label: n.getAttribute('aria-label') || '' }))
      .filter((e) => e.r.top > r.top + 1)
      .sort((a, b) => a.r.top - b.r.top)[0];
    return {
      zoom: +(c.width / (canvas.width || 1)).toFixed(4),
      dprScale: +scale.toFixed(3),
      canvas: { x: c.x, y: c.y, w: c.width, h: c.height, pxW: canvas.width, pxH: canvas.height },
      block: { x: r.x, y: r.y, w: r.width, h: r.height, styleH: hit.style.height, styleTop: hit.style.top },
      neighbour: below ? { y: below.r.y, h: below.r.height, label: below.label.slice(0, 60) } : null,
      aria: (hit.getAttribute('aria-label') || '').slice(0, 80),
      neighbourAria: below ? below.label.slice(0, 60) : null,
      blocks: nodes.length,
      // Ten lines' worth of text is ~460 characters; the block it lands in is
      // two lines of ~46, i.e. the replacement needs ~10.
      hover: r.x + r.width / 2,
      y: r.y + r.height / 2,
    };
  })()`);

// `rotmap`: where is the painted text, and where does the pane think it is?
if (CASE === 'rotmap') {
  log('ink vs blocks', await h.ev(`(() => {
    const c = document.querySelector('canvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, ink = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      const l = 0.2126 * d[i] + 0.7152 * d[i+1] + 0.0722 * d[i+2];
      if (d[i+3] > 8 && l < 140) { ink++; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    }
    const zoomTo = c.width ? c.getBoundingClientRect().width / c.width : 1;
    const boxes = [...document.querySelectorAll('[data-editable-block]')].map((n) => {
      const r = n.getBoundingClientRect();
      return { label: (n.getAttribute('aria-label') || '').slice(30, 60), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });
    const canvas = c.getBoundingClientRect();
    const toViewer = (r) => ({ x: Math.round((r.x - canvas.x) / zoomTo), y: Math.round((r.y - canvas.y) / zoomTo), w: Math.round(r.width / zoomTo), h: Math.round(r.height / zoomTo) });
    return { canvas: { w: c.width, h: c.height }, ink, inkBox: ink ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null, boxes: boxes.map((b) => ({ ...b, viewer: toViewer({ x: b.x, y: b.y, width: b.w, height: b.h }) })) };
  })()`));
  await h.shot(SHOT.replace('.png', '-map.png'));
  h.chrome.kill();
  process.exit(0);
}

const before = await geometry();
log('before', before);
if (!before) { console.log('no target block'); process.exit(1); }

// Enter on the focused block is the pane's own keyboard route and does not
// depend on where a pointer lands; the double-click is the fallback.
await h.ev(`(() => {
  const nodes = [...document.querySelectorAll('[data-editable-block="yes"]')];
  const hit = nodes.find((n) => (n.getAttribute('aria-label') || '').includes('TARGET ALPHA'));
  if (!hit) return 'no block';
  hit.focus();
  hit.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return 'opened';
})()`);
await h.wait(`!!document.querySelector('[contenteditable="true"]')`, 5000);
if (!(await h.ev(`!!document.querySelector('[contenteditable="true"]')`))) {
  await h.doubleClick(before.hover, before.y);
  await sleep(900);
}

// Select everything in the open block, then type over it.
log('editable', await h.ev(`(() => {
  const node = document.querySelector('[contenteditable="true"]');
  if (!node) return 'no editor';
  node.focus();
  const range = document.createRange();
  range.selectNodeContents(node);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return { paragraphs: node.querySelectorAll('[data-paragraph]').length, text: node.textContent.slice(0, 40) };
})()`));
await h.type(CASE === 'short' ? SHORT_TEXT : LONG_TEXT);
await sleep(500);
await h.shot(SHOT.replace('.png', '-typing.png'));
// Escape is a window-level shortcut here and its dispatch can be swallowed by
// the focused contenteditable, so the pane's own Done button is what commits.
await h.ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === 'Done');
  if (!b) return 'no Done';
  b.click();
  return 'clicked';
})()`);
await h.wait(`!document.querySelector('[contenteditable="true"]')`, 5000);
await sleep(1200);
await h.shot(SHOT);

/** Where the committed block's painted text really goes, on the pane. */
log('committed overlay', await h.ev(`(() => {
  const box = document.querySelector('[data-block-state]');
  if (!box) return 'no committed block';
  const host = box.firstElementChild;
  const outer = box.getBoundingClientRect();
  const inner = host ? host.getBoundingClientRect() : null;
  const canvas = document.querySelector('canvas');
  const c = canvas.getBoundingClientRect();
  const nodes = [...document.querySelectorAll('[data-editable-block="yes"]')];
  const hit = nodes.find((n) => (n.getAttribute('aria-label') || '').includes('TARGET ALPHA'));
  const beside = nodes
    .filter((n) => n !== hit)
    .map((n) => n.getBoundingClientRect())
    .filter((r) => r.top > outer.top + 1)
    .sort((a, b) => a.top - b.top)[0];
  // Ink rows: how far down the painted block actually reaches, and whether the
  // neighbour's own row is inside it.
  return {
    state: box.getAttribute('data-block-state'),
    title: box.getAttribute('title'),
    outer: { top: +outer.top.toFixed(1), bottom: +outer.bottom.toFixed(1), h: +outer.height.toFixed(1) },
    inner: inner ? { top: +inner.top.toFixed(1), bottom: +inner.bottom.toFixed(1), h: +inner.height.toFixed(1) } : null,
    overflowPx: inner ? +(inner.bottom - outer.bottom).toFixed(1) : null,
    neighbourTop: beside ? +beside.top.toFixed(1) : null,
    // How many px of the painted text are past the block's own box, and how far
    // past the neighbour's own top (i.e. printed over it).
    overNeighbourPx: inner && beside ? +(inner.bottom - beside.top).toFixed(1) : null,
    pageBottom: +c.bottom.toFixed(1),
    pastPagePx: inner ? +(inner.bottom - c.bottom).toFixed(1) : null,
    lines: (host ? host.innerText : '').split('\\n').length,
  };
})()`));


const clicked = await h.ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /export|save/i.test((x.getAttribute('aria-label') || '') + ' ' + (x.title || '') + ' ' + (x.innerText || '')) && !x.disabled);
  if (!b) return 'no export button';
  b.click();
  return 'clicked ' + ((b.getAttribute('aria-label') || b.innerText || 'button').slice(0, 40));
})()`);
log('export', clicked);
await sleep(45000);

// The result card's own words, which is where a skip or a re-flow is named.
log('result words', await h.ev(`(() => {
  const text = document.body.innerText;
  return text.split('\\n').map((t) => t.trim()).filter((t) => t.length > 8 && /Wrote|re-flow|instead of|could not|skipped|patch|Repair/i.test(t)).slice(0, 12);
})()`));

const blobs = JSON.parse((await h.ev(`JSON.stringify((window.__blobs || []).filter((b) => /pdf/i.test(b.type || '')))`)) || '[]');
if (blobs.length) {
  const b64 = await h.ev(`(async () => {
    const r = await fetch(${JSON.stringify(blobs[blobs.length - 1].u)});
    const buf = new Uint8Array(await r.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    return btoa(s);
  })()`);
  if (typeof b64 === 'string' && b64.length > 100) {
    fs.writeFileSync(OUT, Buffer.from(b64, 'base64'));
    console.log('\nwrote', OUT, fs.statSync(OUT).size, 'bytes');
  } else console.log('\nblob fetch failed:', b64);
} else console.log('\nno pdf blob');

await h.shot(SHOT.replace('.png', '-result.png'));
console.log('\nerrors:', h.errors.slice(0, 6));
h.chrome.kill();
process.exit(0);
