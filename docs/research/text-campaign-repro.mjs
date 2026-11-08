/**
 * Repro harness for the edit-pdf-text campaign row: does an edited block paint?
 *
 *   node docs/research/text-campaign-repro.mjs            # load, click a block, type, export
 *   OUT=/tmp/x.pdf node docs/research/text-campaign-repro.mjs
 *
 * Needs the dev server on BASE (default http://localhost:5281) and /tmp/sample.pdf.
 * The exported bytes are read out of the page (headless downloads do not land),
 * so the content stream can be inspected rather than trusted.
 */
import fs from 'node:fs';
import { open, HELPERS, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:5281';
const OUT = process.env.OUT || '/tmp/text-export.pdf';
const SHOTS = process.env.SHOTS || 'docs/research/shots';
const TARGET = process.env.BLOCK_TEXT || 'Nekharee';

fs.mkdirSync(SHOTS, { recursive: true });
const h = await open();

const pick = async (sel) => {
  const { root } = await h.send('DOM.getDocument', { depth: -1 });
  return (await h.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel })).nodeId;
};
const ev = (x) => h.ev(x);

await h.send('Page.navigate', { url: `${BASE}/#/tool/edit-pdf-text` });
await h.wait(`!!document.querySelector('input[type=file][accept*="pdf"]')`, 40000);
await h.send('DOM.setFileInputFiles', { nodeId: await pick('input[type=file][accept*="pdf"]'), files: ['/tmp/sample.pdf'] });
await h.wait(`document.querySelectorAll('[data-editable-block]').length > 0`, 40000);
await sleep(3000);
await h.ev(HELPERS);

const log = (label, value) => console.log(`\n## ${label}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`);

await h.shot(`${SHOTS}/campaign-text-1-loaded.png`);

log('pane census', await ev(`(() => {
  const bars = [...document.querySelectorAll('span, p, div')].map((n) => n.textContent || '');
  return {
    blocks: document.querySelectorAll('[data-editable-block]').length,
    editable: document.querySelectorAll('[data-editable-block="yes"]').length,
    status: bars.find((t) => /text block\\(s\\)/.test(t)) || null,
    advice: document.querySelector('[data-page-advice]')?.getAttribute('data-page-advice') ?? null,
  };
})()`));

// Is the page itself painted on the canvas? Count dark pixels in the render.
log('canvas ink', await ev(`(() => {
  const c = document.querySelector('canvas');
  if (!c) return 'no canvas';
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let dark = 0, light = 0, other = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    if (d[i + 3] < 8) { other++; continue; }
    if (l < 110) dark++; else if (l > 235) light++; else other++;
  }
  return { w: c.width, h: c.height, dark, light, other, darkPct: +(100 * dark / (dark + light + other)).toFixed(2) };
})()`));

// Click the first block that holds the target word, then look at what got painted.
const blockBox = await ev(`(() => {
  const want = ${JSON.stringify(TARGET)};
  const nodes = [...document.querySelectorAll('[data-editable-block="yes"]')];
  const hit = nodes.find((n) => (n.getAttribute('aria-label') || '').includes(want)) || nodes[0];
  if (!hit) return null;
  const r = hit.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: hit.getAttribute('aria-label') };
})()`);
log('target block', blockBox);
if (!blockBox) { console.log('no block to click'); process.exit(1); }

await h.click(blockBox.x, blockBox.y);
await sleep(600);
await h.click(blockBox.x, blockBox.y);
await sleep(800);
await h.shot(`${SHOTS}/campaign-text-2-block-open.png`);

log('opened block DOM', await ev(`(() => {
  const box = document.querySelector('[data-paragraph]');
  const host = box ? box.closest('div[style*="font-size"]') || box.parentElement : null;
  const cs = (n) => n ? (({ color, backgroundColor, opacity, visibility, display, mixBlendMode, fontSize, fontFamily, WebkitTextFillColor }) =>
    ({ color, backgroundColor, opacity, visibility, display, mixBlendMode, fontSize, fontFamily, WebkitTextFillColor }))(getComputedStyle(n)) : null;
  const textNode = box ? box.querySelector('span') : null;
  return {
    host: cs(host),
    paragraph: cs(box),
    run: cs(textNode),
    text: box ? box.textContent.slice(0, 80) : null,
    editableHosts: [...document.querySelectorAll('[contenteditable="true"]')].length,
  };
})()`));

if (process.env.TYPE) {
  await ev(`(() => { const b=[...document.querySelectorAll('[data-editable-block="yes"]')]; return b.length; })()`);
  await h.type('ZZEDITEDZZ');
  await sleep(400);
  await h.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await h.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(1500);
  await h.shot(`${SHOTS}/campaign-text-3-typed.png`);
  log('after typing', await ev(`(() => {
    const preview = [...document.querySelectorAll('[data-paragraph]')].map((p) => ({
      text: p.textContent.slice(0, 60),
      run: (() => { const s = p.querySelector('span'); const cs = getComputedStyle(s || p); return { color: cs.color, fontSize: cs.fontSize }; })(),
      hostColor: (() => { let n = p; for (let i = 0; i < 4 && n; i++) n = n.parentElement; return n ? getComputedStyle(n).backgroundColor : null; })(),
    }));
    return preview.slice(0, 4);
  })()`));
}

// Export: click the toolbar's export button, then read the blob back out of the page.
const clickedExport = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /export/i.test((x.getAttribute('aria-label') || '') + ' ' + (x.title || '') + ' ' + (x.innerText || '')) && !x.disabled);
  if (!b) return 'no export button';
  b.click();
  return 'clicked ' + (b.getAttribute('aria-label') || b.innerText || 'button').slice(0, 40);
})()`);
log('export', clickedExport);
await sleep(6000);
const blobs = await ev(`JSON.stringify((window.__blobs || []).filter((b) => /pdf/i.test(b.type || '')))`);
log('blobs', blobs);
const list = JSON.parse(blobs || '[]');
if (list.length) {
  const b64 = await ev(`(async () => {
    const r = await fetch(${JSON.stringify(list[list.length - 1].u)});
    const buf = new Uint8Array(await r.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
    return btoa(s);
  })()`);
  if (typeof b64 === 'string' && b64.length > 100) {
    fs.writeFileSync(OUT, Buffer.from(b64, 'base64'));
    console.log('\nwrote', OUT, fs.statSync(OUT).size, 'bytes');
  } else {
    console.log('\nblob fetch failed:', b64);
  }
}

log('export report', await ev(`(() => {
  const n = [...document.querySelectorAll('p, div, span')].map((x) => (x.innerText || '').trim()).filter((t) => /Wrote|skipped|block/i.test(t) && t.length < 300);
  return [...new Set(n)].slice(0, 6);
})()`));

await h.shot(`${SHOTS}/campaign-text-4-exported.png`);
console.log('\nerrors:', h.errors.slice(0, 8));
h.chrome.kill();
process.exit(0);
