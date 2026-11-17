// `edit-pdf`'s text box, on a live build: does it open as bare type?
//
//   BASE=http://localhost:5271 PDF=/tmp/triage/colour.pdf \
//     SHOT=/tmp/textbox-editor.png OUT=/tmp/textbox.pdf node docs/research/textbox-default.mjs
//
// Drags a box with real mouse events, types into it, leaves it, exports, and keeps
// both the screen the person would see and the bytes. What "correct" means for
// those bytes is the caller's question — `textbox-default.py` reads them.
import { writeFileSync } from 'node:fs';
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:5271';
const PDF = process.env.PDF || '/tmp/triage/colour.pdf';
const OUT = process.env.OUT || '/tmp/textbox.pdf';
const SHOT = process.env.SHOT || '';

const h = await open();
/** `JSON.parse` with the page's answer in the message: a probe that dies on
 *  "Unexpected token P" tells nobody what the page actually said. */
const json = (raw, what) => {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${what}: the page answered ${JSON.stringify(String(raw).slice(0, 120))}`);
  }
};
const pick = async (selector) => {
  const { root } = await h.send('DOM.getDocument', { depth: -1 });
  return (await h.send('DOM.querySelector', { nodeId: root.nodeId, selector })).nodeId;
};

await h.send('Page.navigate', { url: `${BASE}/#/tool/edit-pdf` });
if (!(await h.wait(`!!document.querySelector('input[type=file]')`, 60000))) throw new Error('no file input');
await h.ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);
  URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
await h.send('DOM.setFileInputFiles', { nodeId: await pick('input[type=file]'), files: [PDF] });
if (!(await h.wait(`!!document.querySelector('[data-tool-gesture]')`, 60000))) {
  console.log('body:', (await h.ev('document.body.innerText')).slice(0, 400));
  throw new Error('the editor never mounted a surface');
}
await sleep(2500);

const tool = await h.ev(`(()=>{const b=[...document.querySelectorAll('button')].find((x)=>/Text box/i.test(x.innerText||''));if(!b)return 'none';b.click();return b.innerText.trim()})()`);
console.log('tool', JSON.stringify(tool));
await sleep(500);

const box = json(await h.ev(`(()=>{const s=document.querySelector('[data-tool-gesture]');const r=s.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height})})()`));
const x0 = box.x + 160;
const y0 = box.y + 220;
await h.drag(x0, y0, x0 + 300, y0 + 60, Number(process.env.STEPS || 10));
await sleep(900);
const surface = await h.ev(`(()=>{const t=document.querySelector('textarea[data-editing-surface]');if(!t)return 'no surface';t.focus();return 'surface'})()`);
console.log('surface', surface);
await h.send('Input.insertText', { text: 'Plain type on the page' });
await sleep(400);
if (process.env.FILL) {
  // The mark is placed, so the tool has dropped back to Select: click the mark
  // itself to get the *selection* panel, which is where a placed box is changed.
  // First click commits the typing (the textarea blurs), second one selects the
  // placed mark so the selection panel is the one that answers.
  await h.click(x0 + 40, y0 + 18);
  await sleep(500);
  await h.click(x0 + 60, y0 + 20);
  await sleep(700);
  const state = await h.ev(`(()=>{const panel=document.querySelector('[data-selection-panel]');
    if(!panel)return 'no selection panel';
    const box=[...panel.querySelectorAll('input[type=checkbox]')].find((i)=>/^Fill$/i.test(i.closest('label')?.innerText.trim()||''));
    if(!box)return 'no fill control in '+panel.dataset.selectionPanel;
    box.click();return 'clicked'})()`);
  await sleep(500);
  // Read it back after React has re-rendered: a controlled checkbox read in the
  // same expression answers the DOM's transient value, not the state.
  console.log('fill', state, '→', await h.ev(`(()=>{const panel=document.querySelector('[data-selection-panel]');
    const box=panel&&[...panel.querySelectorAll('input[type=checkbox]')][0];return box?box.checked:'gone'})()`));
  await sleep(400);
}
if (SHOT) {
  const shot = await h.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
  console.log('screenshot', SHOT);
}
if (!process.env.NO_CLICK) { await h.click(box.x + 40, box.y + 40); await sleep(700); }
const pressed = await h.ev(`(()=>{const b=[...document.querySelectorAll('button')].find((x)=>/Export|Apply|Save/i.test(x.innerText||'')&&!x.disabled);if(!b)return 'none';b.click();return b.innerText.trim()})()`);
console.log('button', JSON.stringify(pressed));
if (!(await h.wait(`window.__blobs.length>0`, 60000))) {
  console.log('screen:', (await h.ev('document.body.innerText')).slice(0, 600));
  throw new Error('no output blob');
}
await sleep(1200);
// `__blobs` holds the object URL and its metadata, not the Blob: the bytes come
// back through the URL, which is same-origin.
const info = json(await h.ev(`(async()=>{const entry=window.__blobs.at(-1);
  const u=new Uint8Array(await (await fetch(entry.u)).arrayBuffer());
  let s='';for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));
  return JSON.stringify({n:u.length,b64:btoa(s)})})()`), 'the export');
writeFileSync(OUT, Buffer.from(info.b64, 'base64'));
console.log('bytes', info.n, 'errors', JSON.stringify(h.errors.slice(0, 3)));
process.exit(0);
