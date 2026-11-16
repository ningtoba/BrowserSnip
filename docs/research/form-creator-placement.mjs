// `form-creator` driven the way a person drives the designer, bytes kept.
//
//   BASE=http://localhost:5271 CASE=move CDP=9831 OUT=/tmp/r048/move.pdf \
//     SHOT=/tmp/r048/move.png node docs/research/form-creator-placement.mjs
//
// The pane is bespoke: pick a type from the chips, drag a rectangle on the sheet,
// name the field in the inspector, press "Save form", and take the produced bytes
// out of the page's own blob. One case per claim — `base5` (all five field types),
// `flags` (required + read-only + max length), `dup` (two fields, one name),
// `click` (a click with no drag), `offscreen` (drags begun in the grey beside the
// sheet), `page3` (a field on the third sheet), `move` (drag, then move it), and
// `fillmode` (a form that already has fields, saved twice).
//
// The instrument was proved against the source first: `base5` puts every rect
// where it was dragged, so a case that puts one elsewhere is the pane's fault.
// Judge the output with `form-creator-placement.py`, which reads /AcroForm through
// pypdf and MuPDF and then fills every widget through MuPDF's own API.
import { writeFileSync } from 'node:fs';
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:5271';
const CASE = process.env.CASE || 'base5';
const PDF = process.env.PDF || '/tmp/triage/in/form.pdf';
const OUT = process.env.OUT || `/tmp/r048/${CASE}.pdf`;
const SHOT = process.env.SHOT || `/tmp/r048/${CASE}.png`;

const h = await open();
const rootId = async () => (await h.send('DOM.getDocument', { depth: -1 })).root.nodeId;

async function upload(path) {
  const node = await h.send('DOM.querySelector', { nodeId: await rootId(), selector: 'input[data-probe-doc]' });
  await h.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [path] });
}

await h.send('Page.navigate', { url: `${BASE}/#/tool/form-creator` });
if (!(await h.wait(`!!document.querySelector('input[type=file]')`, 60000))) throw new Error('no file input');
await h.ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
await h.ev(`(() => { const i = [...document.querySelectorAll('input[type=file]')].find((x) => !x.closest('[role=group]')); if (i) i.setAttribute('data-probe-doc','1'); return !!i; })()`);

const sheet = async () => JSON.parse(await h.ev(`(() => {
  const c = [...document.querySelectorAll('canvas')].at(-1);
  if (!c) return 'null';
  const r = c.getBoundingClientRect();
  return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
})()`));

const arm = (label) => h.ev(`(() => {
  const g = document.querySelector('[role=group][aria-label="Field type to place"]');
  const b = [...(g?.querySelectorAll('button') || [])].find((x) => (x.innerText || '').trim().endsWith(${JSON.stringify(label)}));
  if (!b) return 'NO CHIP ' + ${JSON.stringify(label)};
  b.click();
  if (b.getAttribute('aria-pressed') !== 'true') return 'CHIP NOT ARMED';
  return 'armed';
})()`);

const setText = (aria, value) => h.ev(`(() => {
  const el = document.querySelector('[aria-label=${JSON.stringify(aria)}]');
  if (!el) return 'MISSING ' + ${JSON.stringify(aria)};
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
  el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value === ${JSON.stringify(String(value))} ? 'ok' : 'READBACK ' + el.value;
})()`);

const tick = (label) => h.ev(`(() => {
  const el = [...document.querySelectorAll('label')].find((l) => l.innerText.trim() === ${JSON.stringify(label)});
  if (!el) return 'NO ' + ${JSON.stringify(label)};
  const box = el.querySelector('input');
  if (!box || box.disabled) return 'DISABLED ' + ${JSON.stringify(label)};
  if (!box.checked) box.click();
  return box.checked ? 'ticked' : 'NOT TICKED';
})()`);

const place = async (type, fx, fy, w, hh, name, extra = {}) => {
  const s = await sheet();
  console.log(`place ${type} ${name}:`, await arm(type));
  if (w === 0 && hh === 0) await h.click(s.x + s.w * fx, s.y + s.h * fy);
  else await h.drag(s.x + s.w * fx, s.y + s.h * fy, s.x + s.w * (fx + w), s.y + s.h * (fy + hh), 8);
  await sleep(700);
  if (name) console.log('  name:', await setText('Field name', name));
  if (extra.tooltip) console.log('  tooltip:', await setText('Field tooltip', extra.tooltip));
  if (extra.maxLength) console.log('  maxlen:', await setText('Maximum text length', extra.maxLength));
  if (extra.options) console.log('  options:', await setText('Choice options, one per line', extra.options));
  if (extra.required) console.log('  required:', await tick('Required'));
  if (extra.readOnly) console.log('  readonly:', await tick('Read-only'));
  await sleep(300);
  return h.ev(`(() => { const e = [...document.querySelectorAll('[role=button][aria-label*="field "]')].at(-1); if (!e) return 'NO FIELD'; const r = e.getBoundingClientRect(); return e.getAttribute('aria-label') + ' @' + Math.round(r.width) + 'x' + Math.round(r.height); })()`);
};

const gotoPage = (n) => h.ev(`(() => {
  const el = document.querySelector('[aria-label="Page number"]');
  if (!el) return 'NO PAGE INPUT';
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(String(n))});
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'page ' + el.value;
})()`);

const state = () => h.ev(`(() => ({
  problems: [...document.querySelectorAll('ul li')].map((x) => x.innerText.trim()).filter((t) => /unique|small|option|name/i.test(t)),
  count: (document.body.innerText.match(/\\d+ fields?( · \\d+ to fix)?/) || ['?'])[0],
  status: (document.querySelector('[aria-live=polite]') || {}).innerText,
  save: (() => { const b = [...document.querySelectorAll('button')].find((x) => /Save form/.test(x.innerText)); return b ? (b.disabled ? 'disabled' : 'enabled') : 'missing'; })(),
  list: [...document.querySelectorAll('ol li')].map((x) => x.innerText.replace(/\\s+/g, ' ').trim()),
}))()`);

async function save(dir) {
  const n = await h.ev('window.__blobs.length');
  console.log('save:', await h.ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /Save form/.test(x.innerText)); if (!b) return 'missing'; if (b.disabled) return 'DISABLED'; b.click(); return 'clicked'; })()`));
  if (!(await h.wait(`window.__blobs.length > ${n}`, 120000))) {
    console.log('screen:', await h.ev('document.body.innerText.slice(0,1200)'));
    throw new Error('no output blob');
  }
  await sleep(1500);
  const blob = await h.ev(`(async () => {
    const b = [...window.__blobs].reverse().find((x) => x && typeof x.arrayBuffer === 'function');
    const u = new Uint8Array(await b.arrayBuffer());
    let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
    return JSON.stringify({ size: u.length, b64: btoa(s) });
  })()`);
  const info = JSON.parse(blob);
  writeFileSync(dir, Buffer.from(info.b64, 'base64'));
  console.log('wrote', dir, info.size, 'bytes');
  console.log('result screen:', await h.ev(`document.body.innerText.split('\\n').filter((l) => /field|Field|form|Form|download|Download|warn|Warn|know/i.test(l)).slice(0, 14).join(' ;; ')`));
}

async function ready() {
  await upload(PDF);
  if (!(await h.wait(`!!document.querySelector('[role=group][aria-label="Field type to place"]')`, 60000))) {
    console.log('body:', await h.ev('document.body.innerText.slice(0,700)'));
    throw new Error('chips never appeared');
  }
  await sleep(2500);
  console.log('sheet:', JSON.stringify(await sheet()));
}

// ── cases ───────────────────────────────────────────────────────────────────
try {
  if (CASE === 'base5') {
    await ready();
    const seen = [];
    seen.push(await place('Text', 0.15, 0.10, 0.35, 0.04, 'applicant.name', { tooltip: 'Your full name' }));
    seen.push(await place('Checkbox', 0.15, 0.20, 0.05, 0.03, 'agree.terms'));
    seen.push(await place('Dropdown', 0.15, 0.30, 0.35, 0.04, 'country', { options: 'Finland\nFrance\nGermany' }));
    seen.push(await place('List box', 0.15, 0.42, 0.35, 0.12, 'colours', { options: 'red\nblue\ngreen' }));
    seen.push(await place('Radio group', 0.60, 0.42, 0.30, 0.12, 'size', { options: 'S\nM\nL' }));
    console.log('placed:', JSON.stringify(seen));
    console.log('state:', JSON.stringify(await state()));
    await h.shot(SHOT);
    await save(OUT);
  }

  if (CASE === 'flags') {
    await ready();
    console.log(await place('Text', 0.15, 0.10, 0.35, 0.04, 'zip', { required: true, maxLength: 3, readOnly: true }));
    console.log('state:', JSON.stringify(await state()));
    await save(OUT);
  }

  if (CASE === 'dup') {
    await ready();
    console.log(await place('Text', 0.15, 0.10, 0.35, 0.04, 'same'));
    console.log(await place('Text', 0.15, 0.20, 0.35, 0.04, 'same'));
    console.log('state:', JSON.stringify(await state()));
    await h.shot(SHOT);
    await save(OUT);
  }

  if (CASE === 'click') {
    await ready();
    console.log('text click:', await place('Text', 0.30, 0.30, 0, 0, 'clicked.text'));
    console.log('check click:', await place('Checkbox', 0.30, 0.50, 0, 0, 'clicked.box'));
    console.log('state:', JSON.stringify(await state()));
    await h.shot(SHOT);
    await save(OUT);
  }

  if (CASE === 'offscreen') {
    await ready();
    const s = await sheet();
    console.log('arm:', await arm('Text'));
    // press 80 px below the sheet, drag up into it; and 80 px right of it, drag left
    await h.drag(s.x + s.w * 0.2, s.y + s.h + 80, s.x + s.w * 0.45, s.y + s.h - 40, 8);
    await sleep(600);
    console.log('below-start field:', await h.ev(`(() => { const e = [...document.querySelectorAll('[role=button][aria-label*="field "]')].at(-1); if (!e) return 'NO FIELD'; const r = e.getBoundingClientRect(); return JSON.stringify({ label: e.getAttribute('aria-label'), x: Math.round(r.x - ${Math.round(s.x)}), y: Math.round(r.y - ${Math.round(s.y)}), w: Math.round(r.width), h: Math.round(r.height) }); })()`));
    console.log('name:', await setText('Field name', 'below.start'));
    await arm('Checkbox');
    await h.drag(s.x + s.w + 90, s.y + s.h * 0.7, s.x + s.w - 60, s.y + s.h * 0.66, 8);
    await sleep(600);
    console.log('right-start field:', await h.ev(`(() => { const e = [...document.querySelectorAll('[role=button][aria-label*="field "]')].at(-1); if (!e) return 'NO FIELD'; const r = e.getBoundingClientRect(); return JSON.stringify({ label: e.getAttribute('aria-label'), x: Math.round(r.x - ${Math.round(s.x)}), y: Math.round(r.y - ${Math.round(s.y)}), w: Math.round(r.width), h: Math.round(r.height) }); })()`));
    await setText('Field name', 'right.start');
    console.log('state:', JSON.stringify(await state()));
    await h.shot(SHOT);
    await save(OUT);
  }

  if (CASE === 'page3') {
    await ready();
    console.log(await gotoPage(3));
    await sleep(2200);
    console.log(await place('Text', 0.2, 0.3, 0.4, 0.05, 'third.page'));
    console.log('state:', JSON.stringify(await state()));
    await h.shot(SHOT);
    await save(OUT);
  }

  if (CASE === 'fillmode') {
    await ready();
    // the fixture already carries q1.name / q1.pick / q1.on
    console.log('conflict bar:', await h.ev(`(document.body.innerText.match(/already has an AcroForm[^\\n]*/) || ['none'])[0]`));
    console.log(await place('Text', 0.15, 0.70, 0.35, 0.04, 'extra.added'));
    console.log('state:', JSON.stringify(await state()));
    await save(OUT);
    // second save: re-open the produced file and add one more
    await sleep(2500);
    await h.send('Page.navigate', { url: `${BASE}/#/tool/form-creator` });
    await sleep(1500);
    await h.ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
    await h.ev(`(() => { const i = [...document.querySelectorAll('input[type=file]')].find((x) => !x.closest('[role=group]')); if (i) i.setAttribute('data-probe-doc','1'); return !!i; })()`);
    await h.wait(`!!document.querySelector('input[type=file]')`, 30000);
    await upload(OUT);
    await h.wait(`!!document.querySelector('[role=group][aria-label="Field type to place"]')`, 60000);
    await sleep(2500);
    console.log('second pass bar:', await h.ev(`(document.body.innerText.match(/already has an AcroForm[^\\n]*/) || ['none'])[0]`));
    console.log(await place('Text', 0.15, 0.80, 0.35, 0.04, 'extra.second'));
    console.log('state2:', JSON.stringify(await state()));
    await save('/tmp/r048/twice.pdf');
  }


  if (CASE === 'move') {
    await ready();
    console.log(await place('Text', 0.15, 0.10, 0.35, 0.04, 'moved.field'));
    const s = await sheet();
    console.log('select chip:', await h.ev(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /Select/.test(x.innerText)); if (!b) return 'NO SELECT'; b.click(); return b.getAttribute('aria-pressed'); })()`));
    await sleep(300);
    // grab the middle of where the field actually is drawn, drag it +40 px right, +60 px down
    const at = JSON.parse(await h.ev(`(() => { const e = [...document.querySelectorAll('[role=button][aria-label*="field "]')].at(-1); const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
    console.log('grab at', JSON.stringify(at), 'px rel', Math.round(at.x - s.x), Math.round(at.y - s.y));
    await h.drag(at.x, at.y, at.x + 40, at.y + 60, 8);
    await sleep(700);
    console.log('status after move:', await h.ev(`(document.querySelector('[aria-live=polite]') || {}).innerText`));
    console.log('box after move:', await h.ev(`(() => { const e = [...document.querySelectorAll('[role=button][aria-label*="field "]')].at(-1); const r = e.getBoundingClientRect(); return JSON.stringify({ relx: Math.round(r.x - ${Math.round(s.x)}), rely: Math.round(r.y - ${Math.round(s.y)}), w: Math.round(r.width), h: Math.round(r.height) }); })()`));
    await h.shot(SHOT);
    await save(OUT);
  }

  if (CASE === 'dark') {
    await ready();
    await h.ev(`(() => { document.documentElement.classList.add('dark'); try { localStorage.setItem('browsersnip:theme','dark') } catch {} ; return 1 })()`);
    await sleep(500);
    console.log(await place('Text', 0.15, 0.10, 0.35, 0.04, 'dark.field'));
    await h.shot(SHOT);
    console.log('dark?', await h.ev(`document.documentElement.className + '|' + getComputedStyle(document.body).backgroundColor`));
  }
} catch (error) {
  console.log('FAILED:', error.message);
  console.log('screen:', await h.ev('document.body.innerText.slice(0,1500)'));
} finally {
  console.log('console errors', JSON.stringify([...new Set(h.errors)].slice(0, 4)));
  h.chrome.kill('SIGKILL');
  process.exit(0);
}
