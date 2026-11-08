/**
 * The one keeper harness for the edit-pdf palette audit.
 *
 *   node /tmp/sweep.mjs                 # every tool: gesture, canvas ink, exported bytes
 *   node /tmp/sweep.mjs line arrow      # a few of them
 *   SHOT=…/x.png node /tmp/sweep.mjs --proof   # one page with a Line and an Arrow
 *
 * Every tool starts from a freshly loaded document with an empty page, so the
 * exported file holds exactly one annotation and the bytes are attributable.
 * "Visible" is measured as painted area of the overlay elements a real browser
 * lays out — fill and stroke only, never the box of a zero-height `<line>` —
 * which is the mistake that closed the markup bug on a mark count.
 */
import { open, HELPERS, sleep } from './audit3-cdp.mjs';
import fs from 'node:fs';
// Run: node docs/research/audit3-sweep.mjs [tool … | --proof | --edge | --repeat]
// Needs the dev server on BASE (default http://localhost:5261) and /tmp/sample.pdf.

const OUT = '/tmp/sweep';
const proof = process.argv[2] === '--proof';
const only = proof ? [] : process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });

const h = await open();
const pick = async (sel) => {
  const { root } = await h.send('DOM.getDocument', { depth: -1 });
  return (await h.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel })).nodeId;
};
const surface = async () => JSON.parse(await h.ev('JSON.stringify(window.__surface())'));
const clickText = async (re) => h.ev(`(()=>{const b=[...document.querySelectorAll('button')].find((x) => new RegExp(${JSON.stringify(re)}, 'i').test((x.innerText || '').trim()));if (b) { b.click(); return true; } return false;})()`);

const loadDoc = async () => {
  await h.send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await h.send('Page.navigate', { url: 'http://localhost:5261/#/tool/edit-pdf' });
  await h.wait(`!!document.querySelector('input[type=file][accept*="pdf"]')`);
  await h.send('DOM.setFileInputFiles', { nodeId: await pick('input[type=file][accept*="pdf"]'), files: ['/tmp/sample.pdf'] });
  await h.wait(`!!document.querySelector('[data-tool-gesture]')`);
  await sleep(3500);
  await h.ev(HELPERS);
  await clearPage();
};

/** Start every tool from an empty page, whatever the tab still holds. */
const clearPage = async () => {
  for (let i = 0; i < 5; i++) {
    if (!(await h.ev('window.__count()'))) return 0;
    await h.ev(`window.__arm('select')`);
    await sleep(150);
    await h.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await h.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
    await sleep(200);
    await h.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await h.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await sleep(400);
  }
  return h.ev('window.__count()');
};

/** Read the exported bytes out of the page: headless downloads do not land here. */
const downloadExport = async (name) => {
  await h.ev(`document.querySelector('#tool-process-btn')?.click()`);
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const found = await h.ev(`(()=>{const b=(window.__blobs || []).filter((x) => x.type === 'application/pdf').pop();return b ? JSON.stringify(b) : '';})()`);
    if (!found) continue;
    const info = JSON.parse(found);
    const b64 = await h.ev(`(async()=>{try{const r=await fetch(${JSON.stringify(info.u)});if(!r.ok)return 'HTTP'+r.status;const b=new Uint8Array(await r.arrayBuffer());let s='';for(let i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);return btoa(s)}catch(e){return 'ERR'+e.message}})()`);
    if (typeof b64 !== 'string' || b64.startsWith('HTTP') || b64.startsWith('ERR')) return { ok: false, why: 'fetch ' + b64 };
    const buf = Buffer.from(b64, 'base64');
    fs.writeFileSync(`${OUT}/${name}.pdf`, buf);
    return { ok: true, bytes: buf.length, header: buf.slice(0, 8).toString('latin1') };
  }
  return { ok: false, why: 'no pdf blob after 30s' };
};

/* One normal gesture per tool, on the same 595x842 pt page at 100 % zoom.
   Text rows come out of the PDF itself, never guessed fractions. */
const gestures = {
  highlight: async (P) => h.drag(...P(202, 216), ...P(352, 216)),
  underline: async (P) => h.drag(...P(202, 256), ...P(330, 256)),
  strike: async (P) => h.drag(...P(202, 296), ...P(278, 296)),
  note: async (P) => { await h.click(...P(460, 120)); await sleep(400); if (await h.ev(`(()=>{const x=document.querySelector('textarea,input[type=text]');if(!x)return 0;x.focus();return 1})()`)) await h.type('Audit note'); await sleep(300); await h.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(300); },
  freetext: async (P) => { await h.click(...P(300, 640)); await sleep(400); if (await h.ev(`(()=>{const x=document.querySelector('textarea');if(!x)return 0;x.focus();return 1})()`)) await h.type('Audit text box'); await sleep(300); await h.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(300); },
  ink: async (P) => { const a = P(60, 700); await h.mouse('mousePressed', a[0], a[1], 1); for (let i = 1; i <= 24; i++) { const b = P(60 + i * 8, 700 + Math.sin(i / 2) * 20); await h.mouse('mouseMoved', b[0], b[1], 1); } await h.mouse('mouseReleased', ...P(252, 700), 0); },
  line: async (P) => h.drag(...P(60, 760), ...P(300, 790)),
  arrow: async (P) => h.drag(...P(60, 760), ...P(300, 790)),
  polygon: async (P) => { for (const q of [[80, 700], [280, 700], [180, 600]]) { await h.click(...P(...q)); await sleep(120); } await sleep(200); await h.doubleClick(...P(180, 600)); },
  polyline: async (P) => { for (const q of [[80, 700], [180, 620], [290, 700]]) { await h.click(...P(...q)); await sleep(120); } await sleep(200); await h.doubleClick(...P(290, 700)); },
  square: async (P) => h.drag(...P(60, 620), ...P(240, 720)),
  circle: async (P) => h.drag(...P(60, 620), ...P(210, 720)),
  stamp: async (P) => h.click(...P(300, 500)),
  image: async (P) => { await h.click(...P(300, 300)); await sleep(400); await h.send('DOM.setFileInputFiles', { nodeId: await pick('input[type=file][accept*="image"]'), files: ['/tmp/sweep-asset.png'] }); },
  signature: async (P) => {
    await h.click(...P(300, 300)); await sleep(500);
    // The page canvas is the biggest one on screen; the pad is the one in the dialog.
    const pad = JSON.parse(await h.ev(`(()=>{const cs=[...document.querySelectorAll('canvas')].map((c) => ({ r: c.getBoundingClientRect(), inDialog: !!c.closest('.fixed') })).filter((c) => c.inDialog).map((c) => c.r);const b=cs.sort((x,y)=>y.width*y.height-x.width*x.height)[0];return JSON.stringify(b?{x:b.x,y:b.y,w:b.width,h:b.height}:null)})()`));
    if (!pad) return 'no pad canvas';
    await h.mouse('mousePressed', pad.x + 40, pad.y + pad.h - 40, 1);
    for (let i = 1; i <= 20; i++) await h.mouse('mouseMoved', pad.x + 40 + i * 12, pad.y + pad.h / 2 + Math.sin(i / 3) * 30, 1);
    await h.mouse('mouseReleased', pad.x + 280, pad.y + 40, 0);
    await sleep(300);
    const placed = await clickText('Place signature');
    await sleep(600);
    return 'place-signature clicked=' + placed;
  },
  link: async (P) => {
    await h.drag(...P(202, 336), ...P(350, 348)); await sleep(400);
    const url = await clickText('^Open URL$'); await sleep(250);
    if (await h.ev(`(()=>{const i=document.querySelector('input[type=url]');if(!i)return 0;i.focus();return 1})()`)) await h.type('https://example.com/audit');
    await sleep(300);
    const add = await clickText('^Add link$'); await sleep(500);
    return 'openUrl=' + url + ' addLink=' + add;
  },
  redact: async (P) => h.drag(...P(202, 376), ...P(350, 388)),
};

if (proof) {
  // One page, a Line and an Arrow, each from a single drag: the evidence behind
  // "line and arrow create nothing" being false at this HEAD.
  await loadDoc();
  const s = await surface();
  const P = (x, y) => [s.x + x, s.y + y];
  const placed = [];
  for (const [tool, a, b] of [['line', [60, 740], [300, 772]], ['arrow', [60, 800], [300, 768]]]) {
    await h.ev(`window.__arm('${tool}')`);
    await sleep(250);
    const armedBefore = await h.ev('window.__armed()');
    const c0 = await h.ev('window.__count()');
    await h.drag(...P(...a), ...P(...b));
    await sleep(700);
    const marks = JSON.parse(await h.ev('JSON.stringify(window.__marks())'));
    placed.push({ tool, armedBefore, marks: `${c0}->${await h.ev('window.__count()')}`, paintedPx: marks.at(-1)?.area, box: marks.at(-1)?.box });
  }
  console.log('# proof', JSON.stringify(placed));
  await h.shot(process.env.SHOT || 'docs/research/shots/audit3-line-and-arrow.png');
  h.ws.close(); h.chrome.kill('SIGKILL'); process.exit(0);
}


/* `node /tmp/sweep.mjs --edge` — where does a released drag stop reaching the
   page? Press at a fixed point inside the page, release along a sweep of x and y,
   and report the first coordinate that creates nothing. If that boundary is the
   emulated viewport, the harness dropped the event; if it is the page rect, the
   editor did. */
if (process.argv[2] === '--edge') {
  await loadDoc();
  const sv = await surface();
  const probe = async (x, y) => {
    await h.ev(`window.__arm('line')`);
    await sleep(200);
    const c0 = await h.ev('window.__count()');
    await h.mouse('mousePressed', sv.x + 120, sv.y + 300, 1);
    for (let i = 1; i <= 4; i++) await h.mouse('mouseMoved', sv.x + 120 + (x - sv.x - 120) * i / 4, sv.y + 300 + (y - sv.y - 300) * i / 4, 1);
    await h.mouse('mouseReleased', x, y, 0);
    await sleep(350);
    const c1 = await h.ev('window.__count()');
    const draft = await h.ev(`(()=>{const g=document.querySelector('[data-tool-gesture] svg');return g?g.querySelectorAll('g:not([data-mark])').length:-1})()`);
    return { x: Math.round(x), y: Math.round(y), created: Number(c1) - Number(c0), draftGroupsLeft: draft };
  };
  const rows = [];
  // Each probe starts from an empty page: a leftover mark is SELECTED, and the
  // press point of the next probe is the corner of its resize handle — which
  // resizes that mark instead of starting a new one. That is what made the first
  // version of this sweep alternate between 1 and 0 created.
  for (const x of [1200, 1340, 1400, 1460, 1490, 1499]) { await clearPage(); rows.push(await probe(x, sv.y + 340)); }
  for (const y of [900, 990, 999, 1005, 1090, 1390]) { await clearPage(); rows.push(await probe(sv.x + 200, y)); }
  // And the release is not the only question: does a vertices tool take a drag?
  for (const t of ['polygon', 'polyline', 'link', 'redact']) {
    await clearPage();
    await h.ev(`window.__arm('${t}')`);
    await sleep(200);
    const c0 = await h.ev('window.__count()');
    await h.drag(sv.x + 100, sv.y + 300, sv.x + 260, sv.y + 380);
    await sleep(400);
    const dragOnly = { tool: t, createdByOneDrag: Number(await h.ev('window.__count()')) - Number(c0), armedAfter: await h.ev('window.__armed()') };
    // finish a vertices gesture the way the UI offers: double-click to close it
    if (t !== 'link') { await h.doubleClick(sv.x + 300, sv.y + 340); await sleep(400); dragOnly.afterDoubleClick = await h.ev('window.__count()'); }
    rows.push(dragOnly);
  }
  console.log('# viewport', await h.ev('JSON.stringify({w: innerWidth, h: innerHeight})'), 'surface', JSON.stringify(sv));
  for (const r of rows) console.log(JSON.stringify(r));
  h.ws.close(); h.chrome.kill('SIGKILL'); process.exit(0);
}


/* `node /tmp/sweep.mjs --repeat` — the audit's §1b: the same markup tool used
   three times in a row on the same row of text, arming asserted every time. Its
   own log alternated created 1, 0, 1, 0, which it blamed on palette stickiness. */
if (process.argv[2] === '--repeat') {
  await loadDoc();
  const sv = await surface();
  const P = (x, y) => [sv.x + x, sv.y + y];
  const rows = [];
  for (const [tool, y] of [['highlight', 216], ['underline', 256], ['strike', 296], ['line', 480], ['arrow', 520]]) {
    const per = [];
    for (let n = 0; n < 3; n++) {
      await h.ev(`window.__arm('${tool}')`);
      await sleep(220);
      const armed = await h.ev('window.__armed()');
      const c0 = await h.ev('window.__count()');
      // Every use starts from the same press point, one word in from the margin.
      await h.drag(...P(202, y), ...P(345, y + (tool === 'line' || tool === 'arrow' ? 26 : 0)));
      await sleep(500);
      per.push({ use: n + 1, armed, marks: `${c0}->${await h.ev('window.__count()')}`, armedAfter: await h.ev('window.__armed()'), status: (JSON.parse(await h.ev('JSON.stringify(window.__notice())')).text || '').slice(0, 120), sel: await h.ev(`document.querySelector('[data-selection]')?.dataset.selection || ''`), emptyMarks: await h.ev(`document.querySelector('[data-empty-marks]')?.innerText.replace(/\\n+/g,' ') || ''`) });
    }
    rows.push({ tool, per });
    console.log(JSON.stringify({ tool, per }));
  }
  h.ws.close(); h.chrome.kill('SIGKILL'); process.exit(0);
}

const tools = only.length ? only : Object.keys(gestures);
const rows = [];
for (const tool of tools) {
  await loadDoc();
  const s = await surface();
  const P = (x, y) => [s.x + x, s.y + y];
  const arm = await h.ev(`window.__arm('${tool}')`);
  await sleep(250);
  const armed = await h.ev('window.__armed()');
  const c0 = await h.ev('window.__count()');
  const ids0 = JSON.parse(await h.ev('JSON.stringify(window.__ids())'));
  const note = await gestures[tool](P);
  await sleep(900);
  const c1 = await h.ev('window.__count()');
  const fresh = JSON.parse(await h.ev('JSON.stringify(window.__marks())')).filter((m) => !ids0.includes(m.id));
  const row = {
    tool, arm, armed, c0, c1, note: note || null,
    nowArmed: await h.ev('window.__armed()'),
    fresh: fresh.map((f) => ({
      area: f.area,
      pdfRect: [+(f.box.x - s.x).toFixed(1), +(f.box.y - s.y).toFixed(1), +f.box.w.toFixed(1), +f.box.h.toFixed(1)],
      kids: f.kids.map((k) => `${k.tag}:${k.w}x${k.h}:sw${k.sw}:fill:${k.fill}:stroke:${k.stroke}`),
    })),
    msg: (JSON.parse(await h.ev('JSON.stringify(window.__notice())')).text || '').slice(0, 110),
    summary: await h.ev(`document.querySelector('[data-export-summary]')?.textContent`),
    emptyMarks: await h.ev(`document.querySelector('[data-empty-marks]')?.innerText.replace(/\\n+/g,' ')`),
  };
  if (!fresh.length) {
    row.screen = await h.ev(`JSON.stringify({fixed: [...document.querySelectorAll('.fixed')].map((d) => d.innerText.replace(/\\n+/g, ' | ').slice(0, 120)), canvases: [...document.querySelectorAll('canvas')].map((c) => { const r = c.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })})`);
  }
  row.exp = await downloadExport(tool);
  rows.push(row);
  fs.writeFileSync('/tmp/sweep-results.json', JSON.stringify(rows, null, 1));
  console.log(JSON.stringify(row));
}
console.log('# page errors', JSON.stringify(h.errors.slice(0, 8)));
h.ws.close(); h.chrome.kill('SIGKILL'); process.exit(0);
