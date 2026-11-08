/**
 * Dark-mode check for the campaign row: the same paint measurement with the
 * `dark` class forced on, plus a screenshot for the record.
 *
 *   CDP=9745 BASE=http://localhost:5281 node docs/research/text-campaign-dark.mjs
 */
import { open, sleep } from './audit3-cdp.mjs';

const h = await open();
const pick = async (sel) => {
  const { root } = await h.send('DOM.getDocument', { depth: -1 });
  return (await h.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel })).nodeId;
};
await h.send('Page.navigate', { url: `${process.env.BASE}/#/tool/edit-pdf-text` });
await h.wait(`!!document.querySelector('input[type=file][accept*="pdf"]')`, 40000);
await h.ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /theme|dark|light/i.test((x.getAttribute('aria-label') || '') + (x.title || ''))); if (b) { b.click(); return b.getAttribute('aria-label'); } document.documentElement.classList.add('dark'); return 'forced'; })()`);
await sleep(400);
console.log('dark class:', await h.ev(`document.documentElement.className`));
await h.send('DOM.setFileInputFiles', { nodeId: await pick('input[type=file][accept*="pdf"]'), files: ['/tmp/sample.pdf'] });
await h.wait(`document.querySelectorAll('[data-editable-block]').length > 0`, 40000);
await sleep(5000);
console.log('canvas:', await h.ev(`(() => {
  const c = document.querySelector('canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let opaque = 0, dark = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 8) opaque++;
    if (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] < 110 && d[i + 3] > 8) dark++;
  }
  return JSON.stringify({ opaque, dark, page: c.width * c.height });
})()`));
console.log('body bg:', await h.ev(`getComputedStyle(document.body).backgroundColor`));
await h.shot(process.env.SHOT || 'docs/research/shots/campaign-text-5-dark.png');
console.log('errors:', h.errors.slice(0, 5));
h.chrome.kill();
process.exit(0);
