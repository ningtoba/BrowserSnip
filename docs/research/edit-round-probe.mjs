/**
 * Round 031 probe for `edit-pdf` — screen half and file half in one run.
 *
 *   BASE=http://localhost:5271 PDF=/tmp/triage/in/annot.pdf OUT=/tmp/edit031 \
 *     PORT=9831 node docs/research/edit-round-probe.mjs marks
 *   … node docs/research/edit-round-probe.mjs text
 *   … node docs/research/edit-round-probe.mjs epilogue
 *
 * One fresh document load per mark case, so every exported file holds exactly one
 * mark of one kind and its bytes are attributable to one gesture. Ink is measured
 * off the **captured bitmap** (a clip screenshot before and after the gesture,
 * diffed in `edit-round-check.py`), never off a node count: the campaign's whole
 * lesson is that a count passes while the paper is blank.
 *
 * The drawn rectangle is stated in PDF points and converted through the page's own
 * box, so the check can compare the ink against the place that was drawn.
 */
import { open, sleep, HELPERS } from './audit3-cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE || 'http://localhost:5271';
const PDF = process.env.PDF || '/tmp/triage/in/annot.pdf';
const OUT = process.env.OUT || '/tmp/edit031';
const PORT = Number(process.env.PORT || 9831);
const MODE = process.argv[2] || 'marks';
fs.mkdirSync(OUT, { recursive: true });

process.env.CDP = String(PORT);
console.log('# mode', MODE, 'port', process.env.CDP);
const h = await open();
const pick = async (sel) => {
  const { root } = await h.send('DOM.getDocument', { depth: -1 });
  return (await h.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel })).nodeId;
};
const surface = async () => JSON.parse(await h.ev('JSON.stringify(window.__surface())'));

/** Page box in points, read out of the file once: the fixture is fixed. */
const PAGE = { width: 420, height: 595 };

const geo = (s) => {
  const scale = s.h / PAGE.height;
  const P = (x, y) => [s.x + x * scale, s.y + (PAGE.height - y) * scale];
  return { scale, P };
};

const setValue = async (selectorExpr, value) =>
  h.ev(`(()=>{const c=${selectorExpr};if(!c)return 'missing';
    const set=Object.getOwnPropertyDescriptor(c.constructor.prototype,'value').set;
    set.call(c,${JSON.stringify(String(value))});
    c.dispatchEvent(new Event('input',{bubbles:true})); c.dispatchEvent(new Event('change',{bubbles:true}));
    return c.value})()`);

const LABEL_INPUT = (label) => `[...document.querySelectorAll('label')].map(l=>[l, (l.innerText||'').split('\\n')[0].trim()]).find(([,t])=>t===${JSON.stringify(label)})?.[0]?.querySelector('input')`;
const STROKE_INPUT = `document.querySelector('input[type=range][min="0.5"][max="12"]')`;

const arm = async (t) => {
  const r = await h.ev(`window.__arm('${t}')`);
  await sleep(220);
  return { arm: r, armed: await h.ev('window.__armed()') };
};

/** Set the pen colour through a real swatch click and read it back. */
const setColour = async (hex) => {
  const clicked = await h.ev(`(()=>{const b=document.querySelector('[aria-label="Use ${hex}"]');if(!b)return 0;b.click();return 1})()`);
  await sleep(180);
  return { clicked, shown: await h.ev(`(()=>{const c=document.querySelector('input[aria-label="Colour"]');return c?c.value:''})()`), wanted: hex };
};

const setStroke = async (pt) => {
  const read = await setValue(STROKE_INPUT, pt);
  await sleep(120);
  return { set: read, shown: await h.ev(`(()=>{const c=${STROKE_INPUT};return c?c.value:''})()`), wanted: String(pt) };
};

const loadDoc = async () => {
  await h.send('Page.navigate', { url: 'about:blank' });
  await sleep(250);
  await h.send('Page.navigate', { url: `${BASE}/#/tool/edit-pdf` });
  await h.wait(`!!document.querySelector('input[type=file][accept*="pdf"]')`);
  await h.send('DOM.setFileInputFiles', { nodeId: await pick('input[type=file][accept*="pdf"]'), files: [PDF] });
  await h.wait(`!!document.querySelector('[data-tool-gesture]')`);
  await sleep(3200);
  await h.ev(HELPERS);
};

const count = () => h.ev('window.__count()');

const pageClip = (s) => ({ x: s.x, y: s.y, w: s.w, h: s.h });

/** Clear the selection so the mark's own ink is captured, not Select's chrome. */
const deselect = async () => {
  for (let i = 0; i < 3; i++) {
    if (!(await h.ev(`document.querySelector('[data-selection]')?.dataset.selection`))) return i;
    await h.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await h.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(260);
  }
  return 3;
};

/** The mark's own box, converted back to PDF points from the DOM. */
const markBoxPdf = async (s) => {
  const gb = JSON.parse(await h.ev(`(()=>{const g=document.querySelector('[data-mark]');if(!g)return 'null';const r=g.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height})})()`));
  if (!gb) return null;
  const k = s.h / PAGE.height;
  const sw = Number(await h.ev(`(()=>{const p=document.querySelector('[data-mark] rect,[data-mark] polygon,[data-mark] ellipse,[data-mark] polyline,[data-mark] line');return p?getComputedStyle(p).strokeWidth:'0'})()`)) || 0;
  return {
    x1: +(gb.x - s.x) / k,
    y1: PAGE.height - (gb.y - s.y + gb.h) / k,
    x2: +(gb.x - s.x + gb.w) / k,
    y2: PAGE.height - (gb.y - s.y) / k,
    stroke: sw,
  };
};

const clipPng = async (file, rect) => {
  const r = await h.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(Math.round(rect.w), 1), height: Math.max(Math.round(rect.h), 1), scale: 1 },
  });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
};

const exportPdf = async (name) => {
  await h.ev(`document.querySelector('#tool-process-btn')?.click()`);
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const found = await h.ev(`(()=>{const b=(window.__blobs || []).filter((x) => x.type === 'application/pdf').pop();return b ? JSON.stringify(b) : '';})()`);
    if (!found) continue;
    const info = JSON.parse(found);
    const b64 = await h.ev(`(async()=>{try{const r=await fetch(${JSON.stringify(info.u)});if(!r.ok)return 'HTTP'+r.status;const b=new Uint8Array(await r.arrayBuffer());let s='';for(let i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);return btoa(s)}catch(e){return 'ERR'+e.message}})()`);
    if (typeof b64 !== 'string' || /^(HTTP|ERR)/.test(b64)) return { ok: false, why: `fetch ${b64}` };
    const buf = Buffer.from(b64, 'base64');
    fs.writeFileSync(path.join(OUT, `${name}.pdf`), buf);
    return { ok: true, bytes: buf.length, header: buf.slice(0, 8).toString('latin1') };
  }
  return { ok: false, why: 'no pdf blob after 30s' };
};

/** Paint the mark's own pixels from the DOM (a cross-check on the bitmap). */
const markPaint = async () => JSON.parse(await h.ev('JSON.stringify(window.__marks())'));

const textBox = async (x, y, body) => {
  await h.click(x, y);
  await sleep(450);
  const focused = await h.ev(`(()=>{const t=document.querySelector('[data-editing-surface]');if(!t)return 0;t.focus();return 1})()`);
  if (focused) await h.type(body);
  await sleep(300);
  await h.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(400);
  return { focused, body };
};

/* ── marks: every family, a light and a dark ink ─────────────────────── */
const MARK_CASES = [
  { id: 'ink-light', tool: 'ink', colour: '#FFEB3B', gesture: 'path', at: [[60, 300], [110, 340], [170, 300], [230, 340]] },
  { id: 'ink-dark', tool: 'ink', colour: '#1B1B18', gesture: 'path', at: [[60, 300], [110, 340], [170, 300], [230, 340]] },
  { id: 'square-light', tool: 'square', colour: '#FFEB3B', gesture: 'drag', at: [[60, 300], [200, 380]] },
  { id: 'square-dark', tool: 'square', colour: '#DC2626', gesture: 'drag', at: [[60, 300], [200, 380]] },
  { id: 'circle-light', tool: 'circle', colour: '#FFEB3B', gesture: 'drag', at: [[60, 300], [200, 380]] },
  { id: 'circle-dark', tool: 'circle', colour: '#059669', gesture: 'drag', at: [[60, 300], [200, 380]] },
  { id: 'line-light', tool: 'line', colour: '#FFEB3B', gesture: 'drag', at: [[60, 300], [240, 380]] },
  { id: 'line-dark', tool: 'line', colour: '#2563EB', gesture: 'drag', at: [[60, 300], [240, 380]] },
  { id: 'arrow-dark', tool: 'arrow', colour: '#1B1B18', gesture: 'drag', at: [[60, 300], [240, 380]] },
  { id: 'highlight-light', tool: 'highlight', colour: '#FFEB3B', gesture: 'row' },
  { id: 'highlight-dark', tool: 'highlight', colour: '#8B5CF6', gesture: 'row' },
  { id: 'note', tool: 'note', colour: '#1B1B18', gesture: 'note', at: [360, 480] },
  { id: 'stamp', tool: 'stamp', colour: '#DC2626', gesture: 'click', at: [300, 480] },
  { id: 'image', tool: 'image', colour: '#1B1B18', gesture: 'image', at: [300, 300] },
  { id: 'text-dark', tool: 'freetext', colour: '#1B1B18', gesture: 'text', at: [60, 300] },
  { id: 'text-light', tool: 'freetext', colour: '#FFFFFF', gesture: 'text', at: [60, 300] },
  // dark mode, on paper that stays white: a light stroke and a dark text box
  { id: 'dark-square-light', tool: 'square', colour: '#FFEB3B', gesture: 'drag', at: [[70, 300], [210, 380]], dark: true },
  { id: 'dark-square-dark', tool: 'square', colour: '#1B1B18', gesture: 'drag', at: [[70, 300], [210, 380]], dark: true },
  { id: 'dark-text', tool: 'freetext', colour: '#1B1B18', gesture: 'text', at: [60, 300], dark: true },
];
const ROW = { x1: 60, x2: 260, y: 425 };

async function runMark(c) {
  await loadDoc();
  if (c.dark) {
    await h.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/dark|light/i.test(x.getAttribute('aria-label')||x.title||''));if(b){b.click();return 1}return 0})()`);
    await sleep(700);
  }
  const s = await surface();
  const { P } = geo(s);
  const record = { id: c.id, tool: c.tool, colour: c.colour, dark: Boolean(c.dark), theme: await h.ev('document.documentElement.className'), arm: await arm(c.tool) };
  if (c.gesture === 'path') record.path = c.at;
  record.stroke = await setStroke(4);
  record.colourSet = await setColour(c.colour);
  record.countBefore = await count();
  // The drawn rectangle, in PDF points, for the check to judge the ink against.
  let drawn;
  if (c.gesture === 'path' || c.gesture === 'drag') {
    const xs = c.at.map((q) => q[0]);
    const ys = c.at.map((q) => q[1]);
    drawn = { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
    await clipPng(path.join(OUT, `${c.id}-before.png`), pageClip(s));
    if (c.gesture === 'path') {
      let p = P(...c.at[0]);
      await h.mouse('mousePressed', p[0], p[1], 1);
      for (let i = 1; i < c.at.length; i++) { p = P(...c.at[i]); await h.mouse('mouseMoved', p[0], p[1], 1); }
      await h.mouse('mouseReleased', p[0], p[1], 0);
    } else {
      await h.drag(...P(...c.at[0]), ...P(...c.at[1]));
    }
  } else if (c.gesture === 'row') {
    drawn = { x1: ROW.x1, y1: ROW.y - 8, x2: ROW.x2, y2: ROW.y + 8 };
    await clipPng(path.join(OUT, `${c.id}-before.png`), pageClip(s));
    await h.drag(...P(ROW.x1, ROW.y), ...P(ROW.x2, ROW.y));
  } else if (c.gesture === 'note') {
    drawn = { x1: c.at[0], y1: c.at[1] - 26, x2: c.at[0] + 26, y2: c.at[1] };
    await clipPng(path.join(OUT, `${c.id}-before.png`), pageClip(s));
    await h.click(...P(...c.at));
    await sleep(450);
    if (await h.ev(`(()=>{const t=document.querySelector('[data-note-editor]');if(!t)return 0;t.focus();return 1})()`)) await h.type('Round 031 note');
    await sleep(250);
    await h.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(350);
  } else if (c.gesture === 'click') {
    drawn = { x1: c.at[0] - 70, y1: c.at[1] - 22, x2: c.at[0] + 70, y2: c.at[1] + 22 };
    await clipPng(path.join(OUT, `${c.id}-before.png`), pageClip(s));
    await h.click(...P(...c.at));
    await sleep(500);
  } else if (c.gesture === 'image') {
    drawn = { x1: c.at[0] - 120, y1: c.at[1] - 80, x2: c.at[0] + 120, y2: c.at[1] + 80 };
    await clipPng(path.join(OUT, `${c.id}-before.png`), pageClip(s));
    await h.click(...P(...c.at));
    await sleep(450);
    await h.send('DOM.setFileInputFiles', { nodeId: await pick('input[type=file][accept*="image"]'), files: ['/tmp/edit031/asset.png'] });
    await sleep(700);
  } else if (c.gesture === 'text') {
    drawn = { x1: c.at[0], y1: c.at[1] - 40, x2: c.at[0] + 200, y2: c.at[1] + 40 };
    await clipPng(path.join(OUT, `${c.id}-before.png`), pageClip(s));
    record.typed = await textBox(...P(...c.at), 'Measured text box');
  }
  await sleep(700);
  record.countAfter = await count();
  record.markBox = await markBoxPdf(s);
  record.deselected = await deselect();
  record.armed = await h.ev('window.__armed()');
  const marks = await markPaint();
  record.painted = marks.map((m) => ({ box: m.box, area: m.area, kids: m.kids }));
  record.notice = JSON.parse(await h.ev('JSON.stringify(window.__notice())')).text;
  record.summary = await h.ev(`document.querySelector('[data-export-summary]')?.textContent`);
  record.laidOut = await h.ev(`(()=>{const g=document.querySelector('[data-text-layout]');return g?JSON.stringify({family:g.dataset.textFamily,size:g.dataset.textSize,shrank:g.dataset.textShrank,lines:[...g.querySelectorAll('text')].map(t=>({t:t.textContent,x:+t.getAttribute('x'),y:+t.getAttribute('y'),size:t.getAttribute('font-size'),fill:t.getAttribute('fill'),weight:t.getAttribute('font-weight'),slant:t.getAttribute('font-style')}))}):''})()`);
  await clipPng(path.join(OUT, `${c.id}-after.png`), pageClip(s));
  record.drawn = drawn;
  record.scale = s.h / PAGE.height;
  record.page = { x: s.x, y: s.y, w: s.w, h: s.h };
  record.exp = await exportPdf(c.id);
  fs.writeFileSync(path.join(OUT, `${c.id}.json`), JSON.stringify(record, null, 1));
  console.log(JSON.stringify({ id: c.id, count: `${record.countBefore}->${record.countAfter}`, colour: record.colourSet, stroke: record.stroke, area: record.painted.map((p) => p.area), exp: record.exp.ok }));
}

/* ── text: five properties, each against a control ───────────────────── */
const PROPERTY_CASES = [
  { id: 'base', patch: {} },
  { id: 'face-times', patch: { family: 'std:times' } },
  { id: 'size-28', patch: { size: 28 } },
  { id: 'colour-red', patch: { colour: '#DC2626' } },
  { id: 'bold', patch: { bold: true } },
  { id: 'italic', patch: { italic: true } },
  { id: 'face-noto', patch: { family: 'noto' } },
];

async function runProperty(c) {
  await loadDoc();
  const s = await surface();
  const { P } = geo(s);
  const record = { id: c.id, patch: c.patch, arm: await arm('freetext') };
  await setStroke(1);
  record.applied = {};
  if (c.patch.family) record.applied.family = await setValue(`document.querySelector('[data-text-styling] select')`, c.patch.family);
  if (c.patch.size) record.applied.size = await setValue(`document.querySelector('[data-text-styling] input[aria-label="Text size in points"]')`, c.patch.size);
  if (c.patch.colour) {
    record.applied.colour = await setValue(`document.querySelector('[data-text-styling] input[aria-label="Text colour"]')`, c.patch.colour);
  }
  if (c.patch.bold) record.applied.bold = await h.ev(`(()=>{const b=[...document.querySelectorAll('[data-text-styling] button')].find(x=>(x.textContent||'').trim()==='B');if(!b)return 'missing';if(b.disabled)return 'disabled';b.click();return b.title})()`);
  if (c.patch.italic) record.applied.italic = await h.ev(`(()=>{const b=[...document.querySelectorAll('[data-text-styling] button')].find(x=>(x.textContent||'').trim()==='I');if(!b)return 'missing';if(b.disabled)return 'disabled';b.click();return b.title})()`);
  await sleep(250);
  record.claim = await h.ev(`(()=>{const p=document.querySelector('[data-family-claim]');return p?p.textContent:''})()`);
  record.shown = JSON.parse(await h.ev(`(()=>{const r=document.querySelector('[data-text-styling]');return JSON.stringify({family:r?.dataset.family,size:r?.querySelector('input[aria-label="Text size in points"]')?.value,colour:r?.querySelector('input[aria-label="Text colour"]')?.value,bold:r?.querySelector('button[aria-label^="Bold"]')?.getAttribute('aria-pressed'),italic:r?.querySelector('button[aria-label^="Italic"]')?.getAttribute('aria-pressed')})})()`));
  // A box wide enough to hold the sentence on one line at 20 pt.
  const rect = { x1: 60, y1: 260, x2: 360, y2: 340 };
  await clipPng(path.join(OUT, `text-${c.id}-before.png`), pageClip(s));
  await h.drag(...P(rect.x1, rect.y2), ...P(rect.x2, rect.y1));
  await sleep(500);
  record.typed = await (async () => {
    const focused = await h.ev(`(()=>{const t=document.querySelector('[data-editing-surface]');if(!t)return 0;t.focus();return 1})()`);
    if (focused) await h.type('Hamburg fig 128');
    await sleep(300);
    await h.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(500);
    return { focused, body: 'Hamburg fig 128' };
  })();
  record.count = await count();
  record.colourSet = { wanted: record.shown.colour || '#1B1B18' };
  record.markBox = await markBoxPdf(s);
  record.deselected = await deselect();
  record.laidOut = await h.ev(`(()=>{const g=document.querySelector('[data-text-layout]');return g?JSON.stringify({family:g.dataset.textFamily,size:g.dataset.textSize,shrank:g.dataset.textShrank,lines:[...g.querySelectorAll('text')].map(t=>({t:t.textContent,x:+t.getAttribute('x'),y:+t.getAttribute('y'),size:t.getAttribute('font-size'),fill:t.getAttribute('fill'),weight:t.getAttribute('font-weight'),slant:t.getAttribute('font-style')}))}):''})()`);
  record.summary = await h.ev(`document.querySelector('[data-export-summary]')?.textContent`);
  record.emptyMarks = await h.ev(`document.querySelector('[data-empty-marks]')?.innerText.replace(/\\n+/g,' ')`);
  await clipPng(path.join(OUT, `text-${c.id}-after.png`), pageClip(s));
  record.drawn = rect;
  record.scale = s.h / PAGE.height;
  record.page = { x: s.x, y: s.y, w: s.w, h: s.h };
  record.exp = await exportPdf(`text-${c.id}`);
  fs.writeFileSync(path.join(OUT, `text-${c.id}.json`), JSON.stringify(record, null, 1));
  console.log(JSON.stringify({ id: c.id, applied: record.applied, shown: record.shown, claim: record.claim, laid: record.laidOut?.slice(0, 200), count: record.count, exp: record.exp.ok }));
}

/* ── clip: a box too small for the words typed into it ───────────────── */
async function runClip() {
  await loadDoc();
  const s = await surface();
  const { P } = geo(s);
  const rect = { x1: 60, y1: 500, x2: 180, y2: 540 };
  const body = 'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma';
  const out = { body, drag: rect, scale: s.h / PAGE.height };
  await arm('freetext');
  await setColour('#1B1B18');
  await clipPng(path.join(OUT, 'clip-before.png'), pageClip(s));
  await h.drag(...P(rect.x1, rect.y2), ...P(rect.x2, rect.y1));
  await sleep(450);
  const focused = await h.ev(`(()=>{const t=document.querySelector('[data-editing-surface]');if(!t)return 0;t.focus();return 1})()`);
  if (focused) await h.type(body);
  await sleep(400);
  out.whileTyping = JSON.parse(await h.ev(`(()=>{const t=document.querySelector('[data-editing-surface]');if(!t)return 'null';const r=t.getBoundingClientRect();return JSON.stringify({w:r.width,h:r.height,scrollH:t.scrollHeight,clientH:t.clientHeight,overflow:getComputedStyle(t).overflow})})()`));
  await h.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(500);
  out.count = await count();
  out.markBox = await markBoxPdf(s);
  out.laidOut = await h.ev(`(()=>{const g=document.querySelector('[data-text-layout]');if(!g)return '';const box=document.querySelector('[data-mark]')?.getBoundingClientRect();const t=box?box.top:0;return JSON.stringify({size:g.dataset.textSize,lines:[...g.querySelectorAll('text')].map(x=>({y:+x.getAttribute('y'),t:x.textContent,visibleAt:+(box?x.getBoundingClientRect().top-t:0).toFixed(1)}))})})()`);
  out.summary = await h.ev(`document.querySelector('[data-export-summary]')?.textContent`);
  out.emptyMarks = await h.ev(`document.querySelector('[data-empty-marks]')?.innerText.replace(/\n+/g,' ')`);
  out.deselected = await deselect();
  await clipPng(path.join(OUT, 'clip-after.png'), pageClip(s));
  out.notice = await h.ev(`document.querySelector('[data-overflow-marks]')?.innerText.replace(/\\n+/g,' ') ?? ''`);
  await h.shot(path.join(OUT, 'clip-pane.png'));
  out.exp = await exportPdf('clip');
  fs.writeFileSync(path.join(OUT, 'clip.json'), JSON.stringify({ ...out, tool: 'freetext', colourSet: { wanted: '#1B1B18' }, drawn: rect, typed: { focused, body }, page: s }, null, 1));
  console.log(JSON.stringify({ clip: out.count, markBox: out.markBox, laid: out.laidOut, whileTyping: out.whileTyping, summary: out.summary }));
}

/* ── epilogue: history, delete, off-page, preservation, counts, dark ─── */
async function runEpilogue() {
  await loadDoc();
  const s = await surface();
  const { P } = geo(s);
  const out = { page: s };
  const press = async (key, code, modifiers = 0) => {
    await h.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), modifiers });
    await h.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), modifiers });
    await sleep(350);
  };
  await arm('square');
  await setStroke(3);
  const steps = [];
  // three different mark kinds on one page
  await setColour('#DC2626');
  await h.drag(...P(60, 500), ...P(150, 560)); await sleep(400);
  steps.push(await count());
  await arm('ink'); await setColour('#2563EB'); await sleep(150);
  let p = P(60, 440); await h.mouse('mousePressed', p[0], p[1], 1);
  for (const q of [[100, 470], [150, 440], [200, 480]]) { p = P(...q); await h.mouse('mouseMoved', p[0], p[1], 1); }
  await h.mouse('mouseReleased', p[0], p[1], 0); await sleep(400);
  steps.push(await count());
  await arm('freetext'); await setColour('#1B1B18'); await sleep(150);
  await textBox(...P(60, 380), 'Three kinds on one page');
  steps.push(await count());
  out.created = steps;
  // The screenshot the round is judged on: the editor holding three kinds + the page.
  await h.shot(path.join(OUT, 'epilogue-three-kinds.png'));
  out.summary = await h.ev(`document.querySelector('[data-export-summary]')?.textContent`);
  out.paintedInk = JSON.parse(await h.ev('JSON.stringify(window.__marks())')).map((m) => m.area);

  // undo / redo — the key first, then the button, so "the history is empty" and
  // "the key never arrived" are different answers.
  await h.ev(`window.__arm('select')`); await sleep(300);
  out.undoDisabled = await h.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.title==='Undo (Ctrl+Z)');return b?b.disabled:'missing'})()`);
  out.focusTag = await h.ev(`document.activeElement?.tagName`);
  await press('z', 'KeyZ', 2); out.afterUndoKey = await count();
  out.afterUndoKeyNotice = (JSON.parse(await h.ev('JSON.stringify(window.__notice())')).text || '').slice(0, 120);
  await h.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.title==='Undo (Ctrl+Z)');if(b)b.click()})()`);
  await sleep(350);
  out.afterUndoButton = await count();
  await press('z', 'KeyZ', 10); out.afterRedoKey = await count();
  await h.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.title==='Redo (Ctrl+Shift+Z)');if(b)b.click()})()`);
  await sleep(350);
  out.afterRedoButton = await count();

  // delete the remaining marks one by one through the Select-all + Delete path
  for (let i = 0; i < 4; i++) {
    await h.ev(`window.__arm('select')`); await sleep(120);
    await press('a', 'KeyA', 2); await press('Delete', 'Delete', 0);
  }
  out.afterDeleteAll = await count();

  // a mark dragged outside the page box: half over the right edge
  await arm('square'); await setColour('#059669'); await sleep(150);
  await h.drag(...P(360, 200), ...P(480, 260)); await sleep(500);
  out.offPage = { count: await count(), painted: JSON.parse(await h.ev('JSON.stringify(window.__marks())')).map((m) => ({ box: m.box, area: m.area })), page: s };
  await h.shot(path.join(OUT, 'epilogue-offpage.png'));
  out.offPageExp = await exportPdf('epilogue-offpage');

  // dark mode: a light mark and a text box on the same page
  await loadDoc();
  const s2 = await surface();
  const g2 = geo(s2);
  await h.ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/dark|light/i.test(x.getAttribute('aria-label')||x.title||''));if(b){b.click();return 1}return 0})()`);
  await sleep(600);
  out.themeAfter = await h.ev(`JSON.stringify({cls:document.documentElement.className, attr:document.documentElement.getAttribute('data-theme'), body:getComputedStyle(document.body).backgroundColor})`);
  await arm('square'); await setStroke(4); await setColour('#FFEB3B'); await sleep(150);
  await h.drag(...g2.P(60, 500), ...g2.P(200, 570)); await sleep(400);
  await arm('freetext'); await setColour('#1B1B18'); await sleep(150);
  await textBox(...g2.P(60, 400), 'Dark mode box');
  out.dark = { count: await count(), painted: JSON.parse(await h.ev('JSON.stringify(window.__marks())')).map((m) => m.area) };
  await h.shot(path.join(OUT, 'epilogue-dark.png'));
  const dRect = { x: g2.P(40, 590)[0], y: g2.P(40, 590)[1], w: 240, h: 240 };
  await clipPng(path.join(OUT, 'dark-light-mark.png'), dRect);
  await clipPng(path.join(OUT, 'dark-textbox.png'), { x: g2.P(40, 440)[0], y: g2.P(40, 440)[1], w: 260, h: 120 });
  out.darkExp = await exportPdf('epilogue-dark');
  fs.writeFileSync(path.join(OUT, 'epilogue.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out));
}

const modes = MODE.split(',');
if (modes.includes('marks')) { for (const c of MARK_CASES) await runMark(c); }
if (modes.includes('text')) { for (const c of PROPERTY_CASES) await runProperty(c); }
if (modes.includes('clip')) { await runClip(); }
if (modes.includes('epilogue')) { await runEpilogue(); }
console.log('# page errors', JSON.stringify(h.errors.slice(0, 8)));
h.ws.close(); h.chrome.kill('SIGKILL'); process.exit(0);
