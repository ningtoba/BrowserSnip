// Why does the mark not move? A step-by-step pointer probe on the sign overlay.
//
//   BASE=http://localhost:5299 PDF=/tmp/eight/ruled.pdf node docs/research/verify-sign-drag.mjs
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:5299';
const PDF = process.env.PDF;
const h = await open();
const pick = async (selector) => {
  const { root } = await h.send('DOM.getDocument', { depth: -1 });
  return (await h.send('DOM.querySelector', { nodeId: root.nodeId, selector })).nodeId;
};
await h.send('Page.navigate', { url: `${BASE}/#/tool/sign` });
await h.wait(`!!document.querySelector('input[type=file]')`, 60000);
await h.send('DOM.setFileInputFiles', { nodeId: await pick('input[type=file]'), files: [PDF] });
await h.wait(`/placing on page/i.test(document.body.innerText)`, 60000);
await sleep(1500);
// A typed mark, so there is exactly one on the page.
await h.ev(`(() => {
  const f = document.querySelector('#sig-panel-text input[type=text]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, 'Ada');
  f.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'Ada' }));
  [...document.querySelectorAll('button')].find((b) => /Add text to PDF/.test(b.textContent)).click();
  return 1;
})()`);
await sleep(800);
const read = () => h.ev(`(() => {
  const el = document.querySelector('[data-sign-placement]');
  if (!el) return 'no mark';
  const r = el.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    selected: /· selected/.test(document.body.innerText),
    hit: (() => { const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return t ? t.tagName + '.' + String(t.className).slice(0, 30) : null; })() });
})()`);
console.log('before:', await read());
const box = JSON.parse(await h.ev(`(() => { const r = document.querySelector('[data-sign-placement]').getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height}); })()`));
const cx = box.x + box.w / 2;
const cy = box.y + box.h / 2;
await h.mouse('mousePressed', cx, cy, 1);
await sleep(200);
console.log('after press:', await read());
for (const [dx, dy] of [[-40, 0], [-90, 60], [-150, 140]]) {
  await h.mouse('mouseMoved', cx + dx, cy + dy, 1);
  await sleep(200);
  console.log(`move ${dx},${dy}:`, await read());
}
await h.mouse('mouseReleased', cx - 150, cy + 140, 0);
await sleep(300);
console.log('after release:', await read());
h.chrome.kill('SIGKILL');
process.exit(0);
