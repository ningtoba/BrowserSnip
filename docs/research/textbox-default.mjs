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

if (process.env.DARK) {
  await h.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await h.ev(`localStorage.setItem('browsersnip.theme','dark')`).catch(() => {});
}
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

if (process.env.PAGE) {
  await h.ev(`(()=>{const i=document.querySelector('input[aria-label*="Page" i]')||[...document.querySelectorAll('input')].find((x)=>x.type==='number');
    if(!i)return 'no page field';const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'${process.env.PAGE}');
    i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}));return i.value})()`).then((v)=>console.log('page',v));
  await sleep(2500);
}
const tool = await h.ev(`(()=>{const b=[...document.querySelectorAll('button')].find((x)=>/Text box/i.test(x.innerText||''));if(!b)return 'none';b.click();return b.innerText.trim()})()`);
console.log('tool', JSON.stringify(tool));
await sleep(500);

const box = json(await h.ev(`(()=>{const s=document.querySelector('[data-tool-gesture]');const r=s.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height})})()`));
const x0 = box.x + 160;
const y0 = box.y + 220;
if (process.env.CLICKBOX) {
  // "or click for a default one": a click, no drag.
  await h.click(x0, y0);
} else {
  await h.drag(x0, y0, x0 + 300, y0 + 60, Number(process.env.STEPS || 10));
}
await sleep(900);
const surface = await h.ev(`(()=>{const t=document.querySelector('textarea[data-editing-surface]');if(!t)return 'no surface';t.focus();return 'surface'})()`);
console.log('surface', surface);
const typed = process.env.TEXT || 'Plain type on the page';
if (process.env.KEYS) {
  // One real key event per character, which is how a person types: `insertText`
  // jumps straight to the value and skips the per-keystroke path.
  for (const ch of typed) {
    if (ch === '\n') {
      await h.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await h.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      continue;
    }
    await h.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch });
    await h.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
  }
} else {
  await h.send('Input.insertText', { text: typed });
}
await sleep(400);
if (process.env.ARM) {
  // Arm another tool straight after typing: the draft must be committed, not
  // dropped, because the editor drops the *gesture* when a pen is armed.
  await h.ev(`(()=>{const b=[...document.querySelectorAll('button')].find((x)=>/^Select/i.test(x.innerText||''));b&&b.click();return !!b})()`);
  await sleep(900);
  console.log('after-arm', await h.ev(`JSON.stringify({textarea: document.querySelectorAll('textarea[data-editing-surface]').length, layouts: document.querySelectorAll('[data-text-layout] text').length, list: [...document.querySelectorAll('[data-page-mark]')].length})`));
  console.log('row', await h.ev(`[...document.querySelectorAll('li,div')].map((n)=>n.textContent||'').find((t)=>/Plain type/.test(t))?.slice(0,60) ?? 'no row'`));
  if (SHOT) { const r = await h.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(SHOT.replace('.png','-arm.png'), Buffer.from(r.data,'base64')); console.log('arm-shot'); }
  if (process.env.STOP) { process.exit(0); }
}
if (process.env.WATCH) {
  await h.click(box.x + 40, box.y + 120);
  await sleep(400);
  console.log('build', await h.ev(`JSON.stringify(performance.getEntriesByType('resource').map((e)=>e.name).filter((n)=>/AnnotationEditor/.test(n)))`));
  console.log('box', await h.ev(`(()=>{const g=document.querySelector('[data-mark]');if(!g)return 'no mark';const r=g.getBoundingClientRect();return JSON.stringify({w:r.width|0,h:r.height|0})})()`));
  for (let i = 0; i < 24; i += 1) {
    if (i === 6 || i === 14) {
      // Force a re-render the way a hand does: change the zoom and put it back.
      await h.ev(`(()=>{const b=[...document.querySelectorAll('button')].filter((x)=>/^[−-]$|^\+$/.test(x.innerText.trim()));if(b[0])b[0].click();if(b[1])b[1].click();return b.length})()`);
    }
    const snap = await h.ev(`JSON.stringify({lines:[...document.querySelectorAll('[data-text-lines]')].map((g)=>g.getAttribute('data-text-lines')), divs:document.querySelectorAll('[data-tool-gesture] div').length, svgText:document.querySelectorAll('[data-text-layout] text').length})`);
    console.log('t+' + (i * 0.5).toFixed(1), snap);
    await sleep(500);
  }
  if (SHOT) { const r = await h.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(SHOT.replace('.png','-watch.png'), Buffer.from(r.data,'base64')); console.log('watch-shot'); }
}
if (process.env.HOVER) {
  await h.click(box.x + 60, box.y + 120);
  await sleep(600);
  // Point at the middle of the box: the extent hint is a hover, so it appears
  // for the pointer and vanishes when it leaves.
  await h.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x0 + 60), y: Math.round(y0 + 20), buttons: 0 });
  await sleep(500);
  if (SHOT) { const r = await h.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(SHOT.replace('.png','-hover.png'), Buffer.from(r.data,'base64')); console.log('hover-shot'); }
  await h.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(box.x + 20), y: Math.round(box.y + 500), buttons: 0 });
  await sleep(400);
  if (SHOT) { const r = await h.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(SHOT.replace('.png','-away.png'), Buffer.from(r.data,'base64')); console.log('away-shot'); }
}
if (process.env.ONECLICK) {
  // The gesture a person makes: type, then click the paper once.
  await h.click(box.x + 60, box.y + 120);
  await sleep(900);
  console.log('panel', await h.ev(`document.querySelector('[data-selection-panel]')?.dataset.selectionPanel ?? 'none'`));
  console.log('render', await h.ev(`JSON.stringify({divs:[...document.querySelectorAll('[data-tool-gesture] div')].map((d)=>[d.textContent,getComputedStyle(d).color]), layouts:document.querySelectorAll('[data-text-layout] text').length})`));
  if (SHOT) { const r = await h.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(SHOT.replace('.png','-oneclick.png'), Buffer.from(r.data,'base64')); console.log('oneclick-shot'); }
}
if (process.env.DESELECT) {
  // Commit, then clear the selection: the mark is then painted like any other,
  // with no selection chrome to hide behind.
  await h.click(box.x + 40, box.y + 40);
  await sleep(500);
  await h.ev(`(()=>{const b=[...document.querySelectorAll('button')].find((x)=>/Select/i.test(x.innerText||''));b&&b.click();return 1})()`);
  await h.click(box.x + 60, box.y + 20);
  await sleep(300);
  await h.click(box.x + 60, box.y + 20);
  await sleep(700);
  console.log('selection', await h.ev(`document.querySelector('[data-selection-panel]')?.dataset.selectionPanel ?? 'none'`));
  console.log('paint', await h.ev(`JSON.stringify({
    layouts: document.querySelectorAll('[data-text-layout]').length,
    divs: [...document.querySelectorAll('[data-tool-gesture] div')].map((d)=>[d.textContent, getComputedStyle(d).color, d.getBoundingClientRect().width|0]),
    svgTexts: [...document.querySelectorAll('[data-tool-gesture] svg text')].map((t)=>[t.textContent, t.getAttribute('fill')]),
    marks: document.querySelectorAll('[data-tool-gesture] svg g').length })`));
  console.log('stack', await h.ev(`JSON.stringify([...document.querySelectorAll('canvas, svg')].map((n)=>{const r=n.getBoundingClientRect();const cs=getComputedStyle(n);
    return {tag:n.tagName, z:cs.zIndex, pos:cs.position, rect:[r.x|0,r.y|0,r.width|0,r.height|0], parentClass:n.parentElement?.className?.toString().slice(0,40)}}))`));
  console.log('at', await h.ev(`(()=>{const t=document.querySelector('[data-text-layout] text');const r=t.getBoundingClientRect();
    const el=document.elementFromPoint(r.x+4, r.y+r.height/2);return JSON.stringify({hit:el?.tagName+'.'+String(el?.getAttribute('class')||'').slice(0,30), parent:el?.parentElement?.tagName})})()`));
  console.log('attrs', await h.ev(`JSON.stringify([...document.querySelectorAll('[data-text-layout] text')].slice(0,2).map((t)=>[t.getAttribute('x'),t.getAttribute('y'),t.getAttribute('font-size')]))`));
  console.log('svgbox', await h.ev(`(()=>{const s=document.querySelector('svg.absolute');const r=s.getBoundingClientRect();return JSON.stringify({x:r.x|0,y:r.y|0,w:r.width|0,h:r.height|0, vb:s.getAttribute('viewBox')})})()`));
  console.log('red', await h.ev(`(()=>{const ts=[...document.querySelectorAll('[data-text-layout] text')];ts.forEach((t)=>{t.setAttribute('fill','red');t.setAttribute('font-size','24')});return ts.length})()`));
  await sleep(300);
  if (SHOT) { const r = await h.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(SHOT.replace('.png','-red.png'), Buffer.from(r.data,'base64')); console.log('redshot'); }
  // A/B: with and without the clip, the same mark, straight from the DOM.
  if (SHOT) {
    await h.ev(`[...document.querySelectorAll('[data-text-layout]')].forEach((g)=>g.style.clipPath='none')`);
    await sleep(300);
    const open = await h.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOT.replace('.png', '-noclip.png'), Buffer.from(open.data, 'base64'));
    await h.ev(`[...document.querySelectorAll('[data-text-layout]')].forEach((g)=>g.style.clipPath='')`);
    await sleep(300);
    const closed = await h.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(SHOT.replace('.png', '-clip.png'), Buffer.from(closed.data, 'base64'));
    console.log('shots', SHOT.replace('.png', '-noclip.png'), SHOT.replace('.png', '-clip.png'));
  }
  console.log('clips', await h.ev(`JSON.stringify([...document.querySelectorAll('clipPath')].map((cp)=>{const r=cp.querySelector('rect');const b=r?r.getBoundingClientRect():null;return {id:cp.id, rect:b?[b.x|0,b.y|0,b.width|0,b.height|0]:null, attrs:r?[r.getAttribute('x'),r.getAttribute('y'),r.getAttribute('width'),r.getAttribute('height')]:null}}))`));
  console.log('css', await h.ev(`(()=>{const g=document.querySelector('[data-text-layout]');const t=g&&g.querySelector('text');if(!t)return 'no text';
    const cs=getComputedStyle(t); const gs=getComputedStyle(g);
    return JSON.stringify({fill:cs.fill, op:cs.opacity, vis:cs.visibility, display:cs.display, clip:cs.clipPath, mask:cs.mask, filter:cs.filter, gcl:gs.clipPath, gfilter:gs.filter, gmask:gs.mask, gtransform:gs.transform})})()`));
  console.log('clip', await h.ev(`(()=>{const g=document.querySelector('[data-text-layout]');
    const raw=(g.getAttribute('clip-path')||''); const id=raw.replace(/^url\(["']?#?|["']?\)$/g,'');
    const cp=document.getElementById(id); if(!cp) return 'missing '+id;
    const r=cp.querySelector('rect'); const b=r?r.getBoundingClientRect():null;
    const t=g.querySelector('text').getBoundingClientRect();
    return JSON.stringify({id, clip:[b?b.x|0:null,b?b.y|0:null,b?b.width|0:null,b?b.height|0:null], text:[t.x|0,t.y|0,t.width|0,t.height|0]})})()`));
  console.log('geo', await h.ev(`JSON.stringify([...document.querySelectorAll('[data-text-layout]')].map((g)=>{
    const t=g.querySelector('text'); const tb=t.getBoundingClientRect();
    const id=g.getAttribute('clip-path'); const clip=document.querySelector(id.replace(/url\\(#|\\)/g,''));
    const cb=clip?clip.querySelector('rect').getBoundingClientRect():null;
    return {clip:id, text:[tb.x|0,tb.y|0,tb.width|0,tb.height|0], clipRect:cb?[cb.x|0,cb.y|0,cb.width|0,cb.height|0]:null, opacity:getComputedStyle(g).opacity, vis:getComputedStyle(g).visibility, disp:getComputedStyle(g).display};
  }))`));
}
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
