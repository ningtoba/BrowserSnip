/**
 * The WYSIWYG proof rig: drive each styled surface in real Chromium, take the
 * exported bytes, and let the paired checker read the answer out of the file.
 *
 *   BASE=http://localhost:5281 OUTDIR=/tmp/wysiwyg/after \
 *     SHOTS=docs/research/shots node docs/research/wysiwyg-rig.mjs
 *
 *   SURFACES=textbox,stamp,note,edittext  # a subset, for one surface at a time
 *
 * Every surface is driven the way a person drives it: arm the tool, set the pen in
 * the inspector, put the mark on the page, type, export. The screenshot is taken
 * with the mark on screen, and the download is captured from `createObjectURL` —
 * headless downloads do not reliably land, so the bytes are read out of the page
 * instead of trusted to a directory.
 *
 * What the rig does **not** do is decide whether the style worked. It records the
 * canvas and the file; `wysiwyg-bytes.py` answers from the file (which face the
 * glyph came from, what colour, where) and `wysiwyg-ink.py` from the paint. A probe
 * that asserts its own success is how three shipped controls stayed wired to a form
 * and not to the pixels.
 */
import fs from 'node:fs';
import path from 'node:path';
import { open, HELPERS, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:5281';
const OUTDIR = process.env.OUTDIR || '/tmp/wysiwyg';
const SHOTS = process.env.SHOTS || 'docs/research/shots';
const PDF = process.env.PDF || '/tmp/sample.pdf';
// The four surfaces whose type is set in an editor. The four rail tools go through
// `colour-rail.mjs` (see `wysiwyg-measure.sh`), which is the campaign's rail probe.
const SURFACES = (process.env.SURFACES || 'textbox,stamp,note,edittext')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);

// The words this campaign types: accents, a currency, and Japanese — the two places
// a substituted face shows up, and the reason the subsetter was just fixed.
const LATIN = 'Café naïve ¼ re-measured';
const CJK = '日本語のテキスト';
const BODY = `${LATIN} ${CJK}`;

fs.mkdirSync(OUTDIR, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

const h = await open();
await h.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__blobz = [];
    const make = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b) => { const u = make(b); window.__blobz.push({ u, b }); return u; };
  `,
});
const ev = (expression) => h.ev(expression);
const log = (label, value) =>
  console.log(`\n## ${label}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`);

const pick = async (selector) => {
  const { root } = await h.send('DOM.getDocument', { depth: -1 });
  return (await h.send('DOM.querySelector', { nodeId: root.nodeId, selector })).nodeId;
};

/** Write into a React-controlled input the way a user's event reaches it. */
const setInput = (selector, value) =>
  ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 'missing';
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  })()`);

/**
 * The shared control set, addressed by the words it prints.
 *
 * `TextStylingControls` is the one component every styled surface mounts, so the
 * same six selectors drive the annotation inspector and the text editor's format
 * panel — which is the point of the component, and the point of driving it here.
 */
const STYLE_CONTROLS = {
  family: 'select[aria-label="Font family"]',
  size: 'input[aria-label="Text size in points"]',
  color: 'input[aria-label="Text colour"]',
  lineHeight: 'input[aria-label="Line height as a multiple of the text size"]',
  align: (which) => `[role="group"][aria-label="Alignment"] button[title="${which}"]`,
  posture: (letter) => `button[title^="${letter}"]`,
};

const readStyle = () =>
  ev(`(() => {
    const q = (s) => document.querySelector(s);
    const press = (t) => { const b = [...document.querySelectorAll('button[aria-pressed]')].find((x) => (x.title||'').startsWith(t)); return b ? {pressed: b.getAttribute('aria-pressed'), disabled: b.disabled, title: b.title} : null; };
    return {
      family: q(${JSON.stringify(STYLE_CONTROLS.family)})?.value ?? null,
      familyTitle: q(${JSON.stringify(STYLE_CONTROLS.family)})?.options[
        q(${JSON.stringify(STYLE_CONTROLS.family)})?.selectedIndex]?.text ?? null,
      size: q(${JSON.stringify(STYLE_CONTROLS.size)})?.value ?? null,
      color: q(${JSON.stringify(STYLE_CONTROLS.color)})?.value ?? null,
      lineSpacing: q(${JSON.stringify(STYLE_CONTROLS.lineHeight)})?.value ?? null,
      align: [...document.querySelectorAll('[role="group"][aria-label="Alignment"] button')].map((b) => [b.title, b.getAttribute('aria-pressed')]),
      bold: press('Bold'),
      italic: press('Italic'),
    };
  })()`);

/** Set the pen through the control set; returns what the DOM holds afterwards. */
async function applyStyle(style) {
  if (style.family !== undefined) await ev(`(() => { window.__pickFamily = ${JSON.stringify(style.family)}; return 'ok'; })()`);
  const out = {};
  if (style.family !== undefined) out.family = await setInput(STYLE_CONTROLS.family, style.family);
  // A posture is *set*, not toggled: the stamp's default is bold, and a blind click
  // turned it off — which the first pass of this proof read as "bold does not reach
  // the file" and was the probe's own bug.
  const posture = (letter, want) => ev(`(() => {
    const b = [...document.querySelectorAll('button[title^="${letter}"]')][0];
    if (!b) return 'missing';
    if (b.disabled) return 'disabled: ' + b.title;
    const on = b.getAttribute('aria-pressed') === 'true';
    if (on !== ${String(Boolean(want))}) b.click();
    return (b.getAttribute('aria-pressed') ?? null);
  })()`);
  if (style.bold !== undefined) out.bold = await posture('Bold', style.bold);
  if (style.italic !== undefined) out.italic = await posture('Italic', style.italic);
  if (style.size !== undefined) out.size = await setInput(STYLE_CONTROLS.size, style.size);
  if (style.color) {
    out.color = await setInput(STYLE_CONTROLS.color, style.color);
    if (out.color === 'missing') {
      // A sticky note has no text-style card at all, so its colour is the pen's
      // swatch — the only colour its annotation dictionary can carry (`/C`).
      out.swatch = await setInput('input[aria-label="Colour"]', style.color);
    }
  }
  if (style.align) {
    const title = style.align === 'left' ? 'Align left' : style.align === 'right' ? 'Align right' : 'Centre';
    out.align = await ev(`(() => { const b=document.querySelector(${JSON.stringify(`[role="group"][aria-label="Alignment"] button[title="${title}"]`)}); if(!b) return 'missing'; b.click(); return b.getAttribute('aria-pressed'); })()`);
  }
  if (style.lineSpacing !== undefined) {
    out.lineSpacing = await ev(`(() => {
      const el = document.querySelector(${JSON.stringify(STYLE_CONTROLS.lineHeight)});
      if (!el) return 'missing';
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${String(style.lineSpacing)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value;
    })()`);
  }
  return out;
}

/**
 * Open a tool and hand it the document.
 *
 * `about:blank` between surfaces is not decoration: the annotation editor keeps each
 * document's marks in a module-level cache, so a same-document navigation hands the
 * next surface the previous surface's marks — and a file carrying three marks proves
 * nothing about the one it was meant to hold. The blank page costs a document reload
 * and buys one mark per exported file.
 *
 * The upload is retried against a freshly queried DOM because `DOM.setFileInputFiles`
 * holds a node id, and a node id from a document that has not finished swapping is the
 * "Could not find node with given id" that otherwise reads as a broken tool.
 */
const openTool = async (tool) => {
  await h.send('Page.navigate', { url: 'about:blank' });
  await sleep(500);
  await h.send('Page.navigate', { url: `${BASE}/#/tool/${tool}` });
  await h.wait(`!!document.querySelector('input[type=file][accept*="pdf"]')`, 90000);
  const name = PDF.split('/').pop();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const nodeId = await pick('input[type=file][accept*="pdf"]');
    try {
      await h.send('DOM.setFileInputFiles', { nodeId, files: [PDF] });
    } catch {
      await sleep(700);
      continue;
    }
    if (await ev(`document.body.innerText.includes(${JSON.stringify(name)})`)) return;
    await sleep(900);
  }
  throw new Error(`${tool}: the app never acknowledged ${name}`);
};

/** The blobs the app has made, newest first, as base64 — the export, from the page. */
const lastBlob = async (mime = 'application/pdf') =>
  ev(`(async () => {
    const list = (window.__blobz || []).filter((x) => !x.b || !x.b.type || x.b.type.includes(${JSON.stringify(mime)}));
    const newest = list[list.length - 1];
    if (!newest) return null;
    // The retained Blob, not its URL: the app revokes the URL the moment the
    // download link is clicked, and a revoked URL's fetch fails — which reads as
    // "the export produced nothing" when the file is in fact in the page.
    const buf = new Uint8Array(await newest.b.arrayBuffer());
    let out = '';
    for (let i = 0; i < buf.length; i += 4096) out += String.fromCharCode.apply(null, buf.subarray(i, i + 4096));
    return { size: buf.length, b64: btoa(out) };
  })()`);

const saveBlob = async (file) => {
  const blob = await lastBlob();
  if (!blob) return null;
  if (typeof blob !== 'object' || !blob.b64) return { error: `no bytes: ${String(blob).slice(0, 120)}` };
  fs.writeFileSync(file, Buffer.from(blob.b64, 'base64'));
  return { bytes: blob.size, file };
};

const armed = () => ev(`window.__armed ? window.__armed() : null`);

/** Arm a palette tool and report that the palette took it. */
const arm = async (tool) => {
  await ev(`(() => { const b=document.querySelector('[data-tool="${tool}"]'); if (b) b.click(); return 'ok'; })()`);
  await sleep(250);
  return armed();
};

/**
 * The annotation editor's page, with the helpers the rig needs.
 *
 * `__dragBox` drags inside the paper at a fraction of its width, which survives a
 * different pane size between runs; `__clickAt` places a click-placed mark.
 */
const EDITOR_HELPERS = `(() => {
  window.__page = () => { const r = document.querySelector('[data-tool-gesture]').getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; };
  window.__dragBox = async (x0,y0,x1,y1) => {
    const send = (type, x, y, buttons) => new Promise((res)=>res());
    return 'use cdp';
  };
  window.__typed = (text) => {
    const el = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
    if (!el) return 'no surface';
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    if (el.tagName === 'TEXTAREA') {
      const s = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      s.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value;
    }
    el.focus();
    el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.textContent;
  };
  window.__layout = () => [...document.querySelectorAll('[data-text-layout]')].map((g) => ({
    id: g.getAttribute('data-text-layout'),
    family: g.getAttribute('data-text-family'),
    size: g.getAttribute('data-text-size'),
    shrank: g.getAttribute('data-text-shrank'),
    lines: [...g.querySelectorAll('text')].map((t) => ({ x: +t.getAttribute('x'), y: +t.getAttribute('y'), size: +t.getAttribute('font-size'), fill: t.getAttribute('fill'), weight: t.getAttribute('font-weight'), text: t.textContent })),
  }));
  // The button the surface actually offers: "Export annotated PDF (N)" in the
  // annotation editor, "Export" in the text editor, the rail's own action label on
  // a form tool. Matching all three is what lets one rig drive every surface.
  window.__export = () => {
    const wants = (x) => /^\s*(Export|Save|Add|Place|Number|Watermark|Draw|Convert)/i.test((x.innerText || '').trim());
    const list = [...document.querySelectorAll('button')].filter((x) => wants(x) && !x.disabled);
    const b = list.find((x) => /export/i.test(x.innerText)) || list[0];
    if (!b) return 'no export button';
    b.click();
    return 'clicked: ' + (b.innerText || '').trim().slice(0, 40);
  };
  window.__noticeText = () => (document.querySelector('[data-editor-status]')?.innerText || document.body.innerText.match(/Exported[^\\n]*/)?.[0] || null);
  return 'ok';
})()`;

async function annotateSurface(name, tool, style, options = {}) {
  await openTool('edit-pdf');
  await h.wait(`!!document.querySelector('[data-tool-gesture]')`, 60000);
  await ev(HELPERS);
  await ev(EDITOR_HELPERS);
  await sleep(2500);
  const armedNow = await arm(tool);
  // The pen is set before the mark exists, so the mark inherits it — the way the
  // palette's own defaults work, and the only order in which "per-tool defaults"
  // can be checked.
  const applied = await applyStyle(style);
  const geom = await ev(`window.__page()`);
  if (options.drag) {
    const box = { x0: geom.x + geom.w * 0.12, y0: geom.y + geom.h * 0.18, x1: geom.x + geom.w * 0.62, y1: geom.y + geom.h * 0.34 };
    await h.drag(box.x0, box.y0, box.x1, box.y1, 10);
  } else {
    await h.click(geom.x + geom.w * 0.3, geom.y + geom.h * 0.22);
  }
  await sleep(600);
  if (options.text) {
    const typed = await ev(`window.__typed(${JSON.stringify(options.text)})`);
    if (typed === 'no surface') log(`${name}: type-in surface`, 'MISSING');
    await sleep(400);
    await ev(`(() => { const el=document.querySelector('textarea'); if (el) { el.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); el.blur(); } return 'ok'; })()`);
    await sleep(700);
  }
  const screen = await ev(`(() => {
    const g = document.querySelector('[data-text-layout]');
    const t = g ? g.querySelector('text') : null;
    return { layout: window.__layout(), marks: window.__ids().length, canvas: !!document.querySelector('canvas') };
  })()`);
  await h.shot(path.join(SHOTS, `wysiwyg-${name}-screen.png`));
  const exportLine = await ev(`window.__export()`);
  await h.wait(`(window.__blobs||[]).length > 0`, 60000);
  await sleep(1500);
  const saved = await saveBlob(path.join(OUTDIR, `${name}.pdf`));
  const notice = await ev(`window.__noticeText()`);
  const zoom = await ev(`document.querySelector('[data-zoom]')?.getAttribute('data-zoom') ?? null`);
  fs.writeFileSync(
    path.join(OUTDIR, `${name}.json`),
    JSON.stringify({ surface: name, zoom: zoom ? Number(zoom) / 100 : null, screen: screen, pen: applied, dom: await readStyle() }, null, 2),
  );
  log(name, {
    armed: armedNow,
    pen: applied,
    domStyle: await readStyle(),
    screen,
    export: exportLine,
    saved,
    notice,
    errors: h.errors.slice(-4),
  });
  await h.send('Page.navigate', { url: `${BASE}/#/` });
  await sleep(500);
}

async function editTextSurface() {
  await openTool('edit-pdf-text');
  await h.wait(`document.querySelectorAll('[data-editable-block]').length > 0`, 60000);
  await sleep(3000);
  await ev(HELPERS);
  await ev(EDITOR_HELPERS);
  // Open the first editable block, then style it from the format panel.
  const opened = await ev(`(() => {
    const blocks = [...document.querySelectorAll('[data-editable-block="yes"]')];
    if (!blocks.length) return 'no editable block';
    const r = blocks[0].getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, n: blocks.length };
  })()`);
  if (typeof opened === 'string') return log('edittext', opened);
  await h.doubleClick(opened.x, opened.y);
  await sleep(1500);
  const typed = await ev(`window.__typed(${JSON.stringify(`${BODY} edited`)})`);
  await sleep(400);
  await ev(`(() => { const el=document.querySelector('[contenteditable="true"]'); if (el) el.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); return 'ok'; })()`);
  await sleep(800);
  const applied = await applyStyle({ family: 'std:times', bold: true, size: 20, color: '#8B5CF6', align: 'center' });
  await h.shot(path.join(SHOTS, 'wysiwyg-edittext-screen.png'));
  const exportLine = await ev(`window.__export()`);
  await h.wait(`(window.__blobs||[]).length > 0`, 90000);
  await sleep(2000);
  const saved = await saveBlob(path.join(OUTDIR, 'edittext.pdf'));
  log('edittext', {
    opened,
    typed,
    applied,
    domStyle: await readStyle(),
    export: exportLine,
    saved,
    errors: h.errors.slice(-4),
  });
}

/*
   The four rail tools are *not* driven here: `colour-rail.mjs` is the campaign's
   proven rail probe — it opens the collapsed "N more options", writes each control the
   way a user's event reaches React, reads the value back out of the DOM before the run,
   and catches the download by name. Two harnesses over the same surface is how one path
   gets fixed and the other drifts, so the rail half of this run is:

     TOOL=page-numbers FIELDS='font=std:times italic=1 fontSize=22 color=#ff0000' \
       PDF=/tmp/sample.pdf OUT=/tmp/wysiwyg/after/pagenumbers.pdf node docs/research/colour-rail.mjs

   and `wysiwyg-bytes.py` measures what came back. `docs/research/wysiwyg-measure.sh`
   runs all eight surfaces in one go.
*/

await ev(`(() => { window.__blobs = []; return 'reset'; })()`);
for (const name of SURFACES) {
  try {
    if (name === 'textbox') await annotateSurface('textbox', 'freetext', { family: 'noto', bold: true, size: 22, color: '#8B5CF6', align: 'left', lineSpacing: 2 }, { drag: true, text: BODY });
    if (name === 'stamp') await annotateSurface('stamp', 'stamp', { family: 'std:times', bold: true, size: 30, color: '#DC2626', align: 'left' }, { drag: true });
    if (name === 'note') await annotateSurface('note', 'note', { color: '#059669' }, { text: 'A note about the figures', drag: false });
    // The note is the surface with *no* style control, so the proof is that its export
    // carries a colour and no text style, and that the card says why.
    if (name === 'edittext') await editTextSurface();
  } catch (error) {
    log(`${name}: FAILED`, String(error && error.stack ? error.stack : error));
  }
}

log('console errors', h.errors.slice(-8));
await ev(`(() => { window.close(); return 'ok'; })()`);
h.chrome.kill('SIGKILL');
process.exit(0);
