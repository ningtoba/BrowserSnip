/**
 * One live round trip for the edit family, judged by eye and by pixels:
 * load, count canvas ink, open a block, type, export, RELOAD the exported
 * file into the same tool, count and shoot again; then dark mode.
 *
 *   python3 docs/research/text-e2e-round-fixture.py /tmp/er
 *   BASE=http://localhost:5291 CDP=98xx PDF=/tmp/er/sample.pdf TOOL=edit-pdf-text \
 *     BLOCK='Built the reporting' OUT=/tmp/er/exported.pdf SHOTDIR=/tmp/er node docs/research/text-e2e-round.mjs
 *
 * `TOOL=edit-pdf` skips the edit legs (the markup surface loads and reloads,
 * no block model to type into here). Shots: 1-loaded, 2-typed, 3-result,
 * 4-reloaded, 5-dark — read them, and measure the reload: the exported file
 * opened by the same tool is the only view where the written bytes are seen
 * the way the next reader will see them.
 */
import fs from 'node:fs';
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:5291';
const PDF = process.env.PDF || '/tmp/p0/mb/sample.pdf';
const TOOL = process.env.TOOL || 'edit-pdf-text';
const BLOCK = process.env.BLOCK || 'Built the reporting';
const OUT = process.env.OUT || '/tmp/p0/e2e-out.pdf';
const SHOTDIR = process.env.SHOTDIR || '/tmp/p0/e2e';
const EDIT = TOOL === 'edit-pdf-text';

fs.mkdirSync(SHOTDIR, { recursive: true });
const h = await open();
const ev = (x) => h.ev(x);

const upload = async (file, tag) => {
  const b64 = fs.readFileSync(file).toString('base64');
  await h.send('Page.navigate', { url: `${BASE}/#/tool/${TOOL}` });
  await h.wait(`!!document.querySelector('input[type=file][accept*="pdf"]')`, 40000);
  await ev(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), (c) => c.charCodeAt(0));
    const file = new File([bytes], ${JSON.stringify(tag)}, { type: 'application/pdf' });
    const input = document.querySelector('input[type=file][accept*="pdf"]');
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.files.length;
  })()`);
};

const canvasInk = () =>
  ev(`(() => {
    const c = document.querySelector('canvas');
    if (!c) return 'no canvas';
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let dark = 0, light = 0, other = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      if (d[i + 3] < 8) { other++; continue; }
      if (l < 110) dark++; else if (l > 235) light++; else other++;
    }
    return JSON.stringify({ w: c.width, h: c.height, dark, light, other });
  })()`);

console.log('== load ==');
await upload(PDF, 'sample.pdf');
await h.wait(`!!document.querySelector('canvas')`, 40000);
if (EDIT) await h.wait(`document.querySelectorAll('[data-editable-block]').length > 0`, 40000);
await sleep(3000);
console.log('canvas ink (source):', await canvasInk());
await h.shot(`${SHOTDIR}/1-loaded.png`);

if (EDIT) {
  const blockBox = await ev(`(() => {
    const want = ${JSON.stringify(BLOCK)};
    const nodes = [...document.querySelectorAll('[data-editable-block="yes"]')];
    const hit = nodes.find((n) => (n.getAttribute('aria-label') || '').includes(want));
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: (hit.getAttribute('aria-label') || '').slice(0, 90) };
  })()`);
  console.log('block:', blockBox);
  await h.click(blockBox.x, blockBox.y);
  await sleep(600);
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find((x)=>/^Edit$/i.test((x.innerText||'').trim()));if(b)b.click();return 1})()`);
  await sleep(900);
  await h.type('ZZEDITEDZZ');
  await sleep(400);
  await h.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await h.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(1500);
  await h.shot(`${SHOTDIR}/2-typed.png`);
  const clicked = await ev(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /export/i.test((x.getAttribute('aria-label') || '') + ' ' + (x.title || '') + ' ' + (x.innerText || '')) && !x.disabled);
    if (!b) return 'no export button';
    b.click();
    return 'clicked';
  })()`);
  console.log('export:', clicked);
  await sleep(12000);
  const blobs = await ev(`JSON.stringify((window.__blobs || []).filter((b) => /pdf/i.test(b.type || '')))`);
  const list = JSON.parse(blobs || '[]').sort((a, b) => (b.size || 0) - (a.size || 0));
  if (list.length) {
    const b64 = await ev(`(async () => {
      const r = await fetch(${JSON.stringify(list[list.length - 1].u)});
      const buf = new Uint8Array(await r.arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
      return btoa(s);
    })()`);
    fs.writeFileSync(OUT, Buffer.from(b64, 'base64'));
    console.log('wrote', OUT, fs.statSync(OUT).size, 'bytes');
  } else {
    console.log('NO BLOB');
  }
  await h.shot(`${SHOTDIR}/3-result.png`);
}

console.log('== reload the exported file ==');
await upload(EDIT ? OUT : PDF, EDIT ? 'edited.pdf' : 'sample.pdf');
await h.wait(`!!document.querySelector('canvas')`, 40000);
if (EDIT) await h.wait(`document.querySelectorAll('[data-editable-block]').length > 0`, 40000);
await sleep(3000);
console.log('canvas ink (reloaded export):', await canvasInk());
await h.shot(`${SHOTDIR}/4-reloaded.png`);

console.log('== dark mode ==');
await ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /theme|dark|light/i.test((x.getAttribute('aria-label') || '') + (x.title || ''))); if (b) b.click(); return 1 })()`);
await sleep(800);
console.log('html class:', await ev(`document.documentElement.className`));
console.log('canvas ink (dark):', await canvasInk());
await h.shot(`${SHOTDIR}/5-dark.png`);

console.log('errors:', h.errors.slice(0, 8));
h.chrome.kill();
process.exit(0);
