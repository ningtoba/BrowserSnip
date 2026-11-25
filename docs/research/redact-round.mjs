// Drive `redact-pdf` in one real Chromium tab: upload, drag the marks it is asked
// for (one drag per case, page by page), press the pane's own Apply button and keep
// every download, every word the pane printed, and screenshots of the pane before
// and after (optionally magnified onto the marked band).
//
//   PDF=/tmp/r056/targets.pdf OUT=/tmp/r056/before.pdf DRAGS='[]' \
//     PORT=9821 SHOT=/tmp/r056/before.png node docs/research/redact-round.mjs
//
// A bespoke driver because this pane draws marks by hand: `colour-rail.mjs` can
// press a rail button but has no gesture. Drags are given as page *fractions* so
// the same list works on a `/Rotate 90` sheet, and are dispatched as real mouse
// events over the overlay, which is the only way `onStartDraw` hears them.
//
//   DRAGS   JSON array of steps: [{ "page": 1, "drags": [{"x0":0.3,"y0":0.15,
//           "x1":0.5,"y1":0.2, "shift": true}] }]  (page is 1-based, fractions
//           are of the displayed canvas, origin top-left)
//   FLIP    comma list: `alsoMetadata` (clicked by its printed sentence, read back)
//   FILL    colour typed into the pane's colour input, read back
//   ZOOM    1 clips the before/after screenshot onto the first mark at 3x
//   DARK=1  sets the theme class before the shots
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const PORT = Number(process.env.PORT || 9831);
const PDF = process.env.PDF;
const OUT = process.env.OUT;
const SHOT = process.env.SHOT;
const SHOT_BEFORE = process.env.SHOT_BEFORE;
const ZOOM_SHOT = process.env.ZOOM_SHOT;
const ZOOM_BEFORE = process.env.ZOOM_BEFORE;
const DARK = process.env.DARK === '1';
const ZOOM = process.env.ZOOM === '1';
const FILL = process.env.FILL || '';
const FLIP = (process.env.FLIP || '').split(',').filter(Boolean);
const STEPS = JSON.parse(process.env.DRAGS || '[]');
const ENDPAGE = Number(process.env.ENDPAGE || 0);
if (!PDF || !OUT) throw new Error('PDF and OUT are required');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LABELS = {
  alsoMetadata: 'Also clear matching text from metadata and bookmarks',
};

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/redact-${PORT}`, 'about:blank'], { stdio: 'ignore' });
let ws;
for (let i = 0; i < 60 && !ws; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch { /* not up yet */ }
  await sleep(300);
}
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 1;
const pending = new Map();
const errors = [];
// Network half: nothing may leave the tab but the page's own assets.
const net = [];
const SAME_ORIGIN = new URL(BASE).origin;
ws.onmessage = (raw) => {
  const m = JSON.parse(raw.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  } else if (m.method === 'Runtime.exceptionThrown') {
    errors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 200));
  } else if (m.method === 'Network.requestWillBeSent') {
    const r = m.params.request;
    net.push({ url: r.url, method: r.method, body: (r.postData || '').length,
      remote: !r.url.startsWith(SAME_ORIGIN) && !/^(data|blob|about):/.test(r.url) });
  }
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = id++; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const wait = async (expr, ms = 150000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(250); }
  return false;
};
const shot = async (path, clip) => {
  if (!path) return;
  const png = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
  writeFileSync(path, Buffer.from(png.data, 'base64'));
  console.log('screenshot:', path);
};
const mouse = (type, x, y, buttons = 0, modifiers = 0) =>
  send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, buttons, modifiers });

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/redact-pdf` });
if (!await wait(`!!document.querySelector('input[type=file]')`, 60000)) throw new Error('no file input on the route');
await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)}
  ${DARK ? "document.documentElement.classList.add('dark');try{localStorage.setItem('browsersnip:theme','dark')}catch{}" : ''}
  return 1})()`);
{
  const { root } = await send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId, files: [PDF] });
}
/**
 * `<canvas width>`/`<canvas height>` plus a cheap hash of the whole painted
 * bitmap. A freshly mounted canvas carries the HTML default 300×150
 * and passed the old `> 50` gate, so the first drag of every run was aimed at a
 * sheet pdf.js had not sized yet: it drew no mark, printed no notice, and the
 * `no words under that box` sentence the run then reported belonged to a 300×150
 * canvas, not to the page. The size says the sheet is laid out, the pixels say it
 * is the sheet the click is about to land on.
 */
const STAMP_EXPR = `(()=>{const c=[...document.querySelectorAll('canvas')].sort((a,b)=>b.width*b.height-a.width*a.height)[0];if(!c)return '';
  const g=c.getContext('2d');if(!g)return c.width+'x'+c.height+':nogc';
  const d=g.getImageData(0,0,c.width,c.height).data;
  let h=0;for(let i=0;i<d.length;i+=148)h=(h*31+d[i]+d[i+1]*3)>>>0;
  return c.width+'x'+c.height+':'+h})()`;
const canvasStamp = () => ev(STAMP_EXPR);
// The pane renders the first sheet with pdf.js; nothing may be drawn before the
// canvas has its viewport size.
const sheetSized = () => ev(`(()=>{const cs=[...document.querySelectorAll('canvas')];
  return cs.some(c=>!(c.width===300&&c.height===150)&&c.width>=100&&c.height>=100)})()`);
/**
 * The pane paints its first sheet from a `[pdfDoc, page]` effect, and the effect
 * that read the file only reaches `canvas.width` if React has already swapped the
 * loading branch out for the canvas. When the worker answers fast the two state
 * updates land in one commit and the canvas is still the browser's default
 * 300×150 — nothing repaints it until the sheet changes, so a turn (and back) is
 * both the recovery and the proof that the sheet is paintable at all.
 */
const nudgeForPaint = async () => {
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Next/.test(x.innerText));b&&!b.disabled&&b.click();return 1})()`);
  await sleep(1500);
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Prev/.test(x.innerText));b&&!b.disabled&&b.click();return 1})()`);
  await sleep(1500);
};
if (!await wait(`(()=>{const cs=[...document.querySelectorAll('canvas')];
  return cs.some(c=>!(c.width===300&&c.height===150)&&c.width>=100&&c.height>=100)})()`, 90000)) {
  await nudgeForPaint();
  if (!await wait(sheetSized, 30000)) {
    console.log('screen says:', JSON.stringify(await ev(`(document.body.innerText||'').slice(0,1200)`)));
    await shot(SHOT);
    throw new Error('the pane never rendered a page');
  }
  console.log('recovered: the first sheet only painted after a page turn');
}
console.log('canvas ready:', JSON.stringify(await canvasStamp()));
// The size lands before pdf.js finishes painting; a drag in that gap measures an
// empty text layer.
await sleep(1200);

if (FILL) {
  const written = await ev(`(()=>{const c=document.querySelector('input[type=color]');if(!c)return 'NO CONTROL';
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    set.call(c,${JSON.stringify(FILL)});
    c.dispatchEvent(new Event('input',{bubbles:true})); c.dispatchEvent(new Event('change',{bubbles:true})); return c.value})()`);
  console.log('fill read back:', written);
}
for (const key of FLIP) {
  const label = LABELS[key];
  await ev(`(()=>{const label=${JSON.stringify(label)};
    const body=[...document.querySelectorAll('label')].find(l=>l.innerText.trim().startsWith(label));
    if(!body) return 'NO CONTROL';
    body.querySelector('input[type=checkbox]').click(); return 1})()`);
  console.log('flipped:', key, '| read back:', await ev(`(()=>{const label=${JSON.stringify(label)};
    const body=[...document.querySelectorAll('label')].find(l=>l.innerText.trim().startsWith(label));
    const box=body&&body.querySelector('input[type=checkbox]');return box?(box.checked?'on':'off'):'NO CONTROL'})()`));
}

const canvasBox = async () => JSON.parse(await ev(`(()=>{const c=[...document.querySelectorAll('canvas')].sort((a,b)=>b.width*b.height-a.width*a.height)[0];const r=c.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height})})()`));
// The pane remembers the sheet it is on, so the walk has to as well: a step that
// drew nothing used to leave the counter behind and every later step skipped a
// sheet.
let atPage = 1;
const goPage = async (n) => {
  const label = () => ev(`(()=>{const m=(document.body.innerText||'').match(/^(\\d+) \\/ /m);return m?Number(m[1]):0})()`);
  while ((await label()) !== n) {
    const current = (await label()) || atPage;
    const forward = current < n;
    const painted = await canvasStamp();
    const ok = await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/${forward ? 'Next' : 'Prev'}/.test(x.innerText));if(!b||b.disabled)return 0;b.click();return 1})()`);
    if (!ok) throw new Error(`no ${forward ? 'Next' : 'Prev'} button to page ${n} from ${current}`);
    // A sheet with the same point size as the last one leaves `canvas.width`
    // untouched, so the pixels are the only signal that the new page is on the
    // canvas: dragging in the gap between the click and the paint measures the
    // previous sheet's text layer.
    if (!await wait(`${STAMP_EXPR} !== ${JSON.stringify(painted)}`, 20000)) {
      throw new Error(`the canvas still paints sheet ${current} after turning to ${n} (${JSON.stringify(painted)})`);
    }
    await sleep(400);
  }
  atPage = n;
  await sleep(500);
};

let firstMark = null;
for (const step of STEPS) {
  await goPage(step.page);
  const box = await canvasBox();
  for (const drag of step.drags) {
    const mod = drag.shift ? 8 : 0;
    const x0 = box.x + drag.x0 * box.w;
    const y0 = box.y + drag.y0 * box.h;
    const x1 = box.x + drag.x1 * box.w;
    const y1 = box.y + drag.y1 * box.h;
    await mouse('mouseMoved', x0, y0, 0, mod);
    await mouse('mousePressed', x0, y0, 1, mod);
    for (let s = 1; s <= 6; s++) await mouse('mouseMoved', x0 + (x1 - x0) * s / 6, y0 + (y1 - y0) * s / 6, 1, mod);
    await mouse('mouseReleased', x1, y1, 0, mod);
    await sleep(250);
    console.log(`  drag ${JSON.stringify(drag)} -> marks ${await ev(`document.querySelectorAll('[data-redact-mark]').length`)}, notice ${JSON.stringify(await ev(`document.querySelector('[role=status]')?.innerText||''`))}`);
    if (!firstMark) firstMark = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  }
  console.log(`page ${step.page}: ${await ev(`document.querySelectorAll('[data-redact-mark]').length`)} mark(s) on it, notice ${JSON.stringify(await ev(`document.querySelector('[role=status]')?.innerText||''`))}`);
}
// Back to the sheet the screenshots are of: the pane stays on the last sheet a
// mark was drawn on, and the result card previews page 1 either way.
for (let i = 1; i < ENDPAGE; i++) {
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Prev/.test(x.innerText));if(b&&!b.disabled)b.click();return 1})()`);
  await sleep(1000);
}
console.log('canvas:', JSON.stringify(await canvasBox()));
console.log('selected readout:', JSON.stringify(await ev(`(()=>{const m=[...document.querySelectorAll('p')].map(p=>p.innerText).find(t=>/^SELECTED/i.test(t));return m?m.replace(/\\s+/g,' '):null})()`)));
console.log('pane says:', JSON.stringify(await ev(`(()=>{const p=document.querySelector('[data-redact-proof]');return p?p.innerText:null})()`)));
console.log('marks:', JSON.stringify(await ev(`[...document.querySelectorAll('[data-redact-mark]')].map((m)=>[m.getAttribute('data-redact-mark'),m.getAttribute('data-redact-lines')])`)));
// The zoom shot is the first mark's own box, which is the band a reader has to be
// able to see the cut in — the drag band is narrower than the mark the pane
// actually creates, so clipping to the gesture would hide the over-redaction.
const clipFor = async () => {
  if (!ZOOM) return null;
  const box = JSON.parse(await ev(`(()=>{const m=document.querySelector('[data-redact-mark]');if(!m)return 'null';const r=m.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height})})()`));
  if (!box) return null;
  return { x: Math.max(0, box.x - 30), y: Math.max(0, box.y - 18), width: box.w + 60, height: box.h + 36, scale: 3 };
};
if (SHOT_BEFORE) await shot(SHOT_BEFORE);
if (ZOOM_BEFORE) await shot(ZOOM_BEFORE, await clipFor());

const before = await ev('window.__blobs.length');
const clicked = await ev(`(()=>{const b=document.querySelector('#tool-process-btn');if(!b)return 'NO BUTTON';if(b.disabled)return 'DISABLED';b.click();return b.innerText.replace(/\\s+/g,' ').trim()})()`);
console.log('pressed:', JSON.stringify(clicked));
if (clicked === 'DISABLED' || clicked === 'NO BUTTON') {
  // Back to the sheet the screenshots are of: the pane stays on the last sheet a
// mark was drawn on, and the result card previews page 1 either way.
for (let i = 1; i < ENDPAGE; i++) {
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Prev/.test(x.innerText));if(b&&!b.disabled)b.click();return 1})()`);
  await sleep(1000);
}
console.log('pane says:', JSON.stringify(await ev(`(document.body.innerText||'').slice(0,1600)`)));
  if (SHOT) await shot(SHOT);
  throw new Error(`Apply was ${clicked}`);
}
if (!await wait(`window.__blobs.length>${before}`, 150000)) {
  console.log('NO OUTPUT — the screen says:', JSON.stringify(await ev(`(document.body.innerText||'').slice(0,1800)`)));
  if (SHOT) await shot(SHOT);
  throw new Error('the tool produced no output blob');
}
await sleep(1500);
console.log('result:', JSON.stringify(await ev(`(()=>{const c=document.querySelector('section[aria-label="Result"]');return c?c.innerText:(document.body.innerText||'').slice(0,1600)})()`)));
console.log('warnings:', JSON.stringify(await ev(`(()=>{const w=document.querySelector('[data-redact-warnings]');return w?w.innerText:null})()`)));
console.log('console errors:', JSON.stringify([...new Set(errors)].slice(0, 5)));
if (SHOT) await shot(SHOT);
if (ZOOM_SHOT) await shot(ZOOM_SHOT, await clipFor());
// Keep the download itself, not a preview blob.
const dl = await ev(`(()=>{const b=[...document.querySelectorAll('section[aria-label="Result"] button[aria-label^="Download "]')];if(b.length){b.forEach((x)=>x.click());return 'each:'+b.length}
  const one=[...document.querySelectorAll('section[aria-label="Result"] button')].find((x)=>/^(Download|Download all)$/.test((x.innerText||'').trim()));if(one){one.click();return 'one'}return 'none'})()`);
await sleep(1200);
const info = JSON.parse(await ev(`(async()=>{const b=window.__blobs.at(-1);const u=new Uint8Array(await b.arrayBuffer());let s='';for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return JSON.stringify({size:u.length,b64:btoa(s)})})()`));
writeFileSync(OUT, Buffer.from(info.b64, 'base64'));
console.log('output:', OUT, info.size, 'B | download click:', dl);
console.log('network:', JSON.stringify({ total: net.length, sameOrigin: net.filter((r) => !r.remote).length,
  remote: [...new Set(net.filter((r) => r.remote).map((r) => `${r.method} ${r.url.slice(0, 110)}`))],
  bodies: net.filter((r) => r.body > 0).map((r) => `${r.method} ${r.url.slice(0, 80)} ${r.body}B`) }));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
