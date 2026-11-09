// Rail probe — drive a shipped tool's *fields* in real Chromium, run it, and hand
// back every file it produced plus the exact words the app printed.
//
//   BASE=http://localhost:5291 TOOL=adjust-colors LABEL='Adjust colors' \
//     PDF=/tmp/colour/colour.pdf OUT=/tmp/colour/adjust-bright.pdf \
//     FIELDS='brightness=1.6 pages=1' node docs/research/colour-rail.mjs
//
//   BASE=https://www.browsersnip.com SPEC=docs/research/triage-spec.json \
//     OUTDIR=/tmp/triage/out JSONL=/tmp/triage/runs.jsonl node docs/research/colour-rail.mjs
//
// The first form is the one `colour-measure.sh` calls; it is unchanged. The second
// is the whole-catalogue triage (`docs/TOOL-TRIAGE.md`): one Chromium, one page,
// many runs described in a JSON array, each writing a JSONL record. Both forms use
// the *same* code path — open the tool, upload, set fields, read them back out of
// the DOM, click the run, take the blobs — because two harnesses over the same
// surface is how one path gets fixed and the other drifts.
//
// `rail-tool-bytes.mjs` clicks the rail's button with whatever the defaults hold,
// which for `adjust-colors` means every slider at its identity value — so that
// probe can show "ink arrived" but cannot show "brightness moved the histogram".
// These tools are *made of* their controls, and the campaign has repeatedly found a
// control wired to the form and not to the code, so each value is written the way a
// user's event reaches React (native value setter + bubbling `input`/`change`), read
// back out of the DOM before the run, and then looked for in the bytes by the paired
// checker (`colour-ink.py` for colour, `rail-measure.py --triage` for everything).
//
// FIELDS keys are the tools' own field keys (see FIELD_LABELS); SPEC runs name each
// control by the words the rail prints beside it, which is what a human reads.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5291';
const TOOL = process.env.TOOL;
const PDF = process.env.PDF || '/tmp/colour/colour.pdf';
const OUT = process.env.OUT || `/tmp/colour/${TOOL}.pdf`;
const LABEL = process.env.LABEL || '';
const PORT = Number(process.env.PORT || 9801);
const SPEC = process.env.SPEC || '';
const OUTDIR = process.env.OUTDIR || '/tmp/triage/out';
const JSONL = process.env.JSONL || '';
const TIMEOUT = Number(process.env.RUN_TIMEOUT || 240000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!SPEC && !TOOL) throw new Error('either TOOL (single run) or SPEC (batch) is required');

/** Field key → the words the rail prints next to its control. */
const FIELD_LABELS = {
  // The security panels: `mode` is 'Method' for the colour tools but 'Protection
  // type' here, so a spec run names that one by its printed words instead.
  userPassword: 'Open password',
  ownerPassword: 'Owner password',
  // The shared text-style model's rail keys: each tool renders these through
  // `textStyleFields`, so their labels are the same words everywhere.
  font: 'Typeface',
  bold: 'Bold',
  italic: 'Italic',
  fontSize: 'Font size',
  color: 'Colour',
  align: 'Alignment',
  lineSpacing: 'Line height',
  headerLeft: 'Header left',
  headerCenter: 'Header centre',
  headerRight: 'Header right',
  footerLeft: 'Footer left',
  footerCenter: 'Footer centre',
  footerRight: 'Footer right',
  stamp: 'Stamp',
  text: 'Text',
  prefix: 'Prefix',
  suffix: 'Suffix',
  position: 'Position',
  dpi: 'Resolution',
  pages: 'Pages',
  mode: 'Method',
  brightness: 'Brightness',
  contrast: 'Contrast',
  saturation: 'Saturation',
  hue: 'Hue rotate',
  threshold: 'Make black and white',
  grayscale: 'Greyscale',
  whitening: 'Whiten the background',
  sharpen: 'Sharpen edges',
};

const WANTED = Object.fromEntries(
  (process.env.FIELDS || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf('=');
      return [FIELD_LABELS[pair.slice(0, at)] ?? pair.slice(0, at), pair.slice(at + 1)];
    }),
);

// ── Chromium over CDP ───────────────────────────────────────────────────────
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/colour-${TOOL || 'spec'}-${PORT}`, 'about:blank'], { stdio: 'ignore' });
let ws;
for (let i = 0; i < 60 && !ws; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch { /* chrome not up yet */ }
  await sleep(300);
}
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 1;
const pending = new Map();
const errors = [];
ws.onmessage = (raw) => {
  const m = JSON.parse(raw.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) rej(new Error(JSON.stringify(m.error)));
    else res(m.result);
  } else if (m.method === 'Runtime.exceptionThrown') {
    errors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 200));
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = id++;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => {
    if (pending.has(i)) {
      pending.delete(i);
      rej(new Error(`${method} #${i} unanswered: ${JSON.stringify(params).slice(0, 120)}`));
    }
  }, 30000);
});
const ev = async (expr) => {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result?.value;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }
  throw lastError;
};
const wait = async (expr, ms = TIMEOUT) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(200); }
  return false;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });

/**
 * One control, found the way a person finds it: by the words beside it.
 *
 * The rail renders a field as one of five shapes — a labelled input (`text`,
 * `number`, `slider`, `password`, `pages`, `file`), a `textarea`, a native
 * `select`, a checkbox inside its own `<label>` (`toggle`), a `role=group` of
 * chips (`segmented`) or of checkboxes (`multiselect`), or the colour pair whose
 * inputs answer to `"<label> hex value"` / `"<label> colour"`. Returning the
 * *kind* as well as the node is what lets the caller report "the rail has no such
 * control" instead of writing into the wrong one.
 */
const CONTROL = (label) => `(()=>{
  const want=${JSON.stringify(String(label).toLowerCase())};
  const norm=(s)=>(s||'').replace(/\\s+/g,' ').trim().toLowerCase();
  const out=(kind,el,extra)=>JSON.stringify(Object.assign({kind},extra||{}));
  const lab=[...document.querySelectorAll('label[for]')].find((l)=>norm(l.innerText)===want);
  const byId=lab?document.getElementById(lab.getAttribute('for')):null;
  if(byId){
    if(byId.tagName==='TEXTAREA') return out('textarea',byId,{id:byId.id});
    if(byId.tagName==='SELECT') return out('select',byId,{id:byId.id,value:byId.value,options:[...byId.options].map(o=>[o.value,o.text])});
    return out('input',byId,{id:byId.id,type:byId.type,value:byId.value,min:byId.min,max:byId.max});
  }
  const hex=[...document.querySelectorAll('[aria-label]')].find((e)=>norm(e.getAttribute('aria-label'))===want+' hex value');
  if(hex) return out('input',hex,{type:hex.type,value:hex.value,aria:'hex'});
  const swatch=[...document.querySelectorAll('[aria-label]')].find((e)=>norm(e.getAttribute('aria-label'))===want+' colour');
  if(swatch) return out('input',swatch,{type:swatch.type,value:swatch.value,aria:'colour'});
  const box=[...document.querySelectorAll('label')].find((l)=>norm(l.innerText)===want&&l.querySelector('input[type=checkbox]'));
  if(box) return out('checkbox',box.querySelector('input[type=checkbox]'),{checked:box.querySelector('input[type=checkbox]').checked});
  const group=[...document.querySelectorAll('[role=group][aria-label]')].find((g)=>norm(g.getAttribute('aria-label'))===want);
  if(group){
    // A file field renders inside its own role=group with a "Choose file" button;
    // that button is not a segmented value, so the picker is matched first.
    const picker=group.querySelector('input[type=file]');
    if(picker) return out('input',picker,{id:picker.id,type:'file',value:''});
    const chips=[...group.querySelectorAll('button')];
    if(chips.length) return out('group',group,{chips:chips.map((b)=>[b.innerText.trim(),b.getAttribute('aria-pressed')])});
    const opts=[...group.querySelectorAll('label')];
    if(opts.length) return out('options',group,{options:opts.map((l)=>[norm(l.innerText),!!l.querySelector('input:checked')])});
    const nums=[...group.querySelectorAll('input')];
    if(nums.length) return out('pair',group,{values:nums.map((i)=>i.value)});
  }
  // A heading label beside its control, which is how the eight video panels are
  // built: a label over a row of chips, or over an input, with no for attribute,
  // no role=group and no aria-pressed to read the state from.
  const near=[...document.querySelectorAll('label')].find((l)=>norm(l.innerText).startsWith(want)&&!l.querySelector('input'));
  if(near){
    const scope=near.parentElement;
    const ctl=scope.querySelector('input:not([type=checkbox]),textarea,select');
    if(ctl){
      if(ctl.tagName==='TEXTAREA') return out('textarea',ctl,{id:ctl.id});
      if(ctl.tagName==='SELECT') return out('select',ctl,{id:ctl.id,value:ctl.value,options:[...ctl.options].map(o=>[o.value,o.text])});
      return out('input',ctl,{id:ctl.id,type:ctl.type,value:ctl.value,min:ctl.min,max:ctl.max});
    }
    const chips=[...scope.querySelectorAll('button')].filter((b)=>(b.innerText||'').trim());
    if(chips.length) return out('chiprow',scope,{chips:chips.map((b)=>[b.innerText.trim(),/chip-active/.test(b.className)])});
    const box=scope.querySelector('input[type=checkbox]');
    if(box) return out('checkbox',box,{checked:box.checked});
  }
  return out('none',null);
})()`;

/** Address the control `CONTROL` just described, by the same words. */
const AT = (label) => {
  const want = JSON.stringify(String(label).toLowerCase());
  return `(()=>{const want=${want};const norm=(s)=>(s||'').replace(/\\s+/g,' ').trim().toLowerCase();
    const lab=[...document.querySelectorAll('label[for]')].find((l)=>norm(l.innerText)===want);
    const el=lab?document.getElementById(lab.getAttribute('for')):null;
    if(el) return el;
    const aria=[...document.querySelectorAll('[aria-label]')].find((e)=>{const n=norm(e.getAttribute('aria-label'));return n===want+' hex value'||n===want+' colour';});
    if(aria) return aria;
    const box=[...document.querySelectorAll('label')].find((l)=>norm(l.innerText)===want&&l.querySelector('input[type=checkbox]'));
    if(box) return box.querySelector('input[type=checkbox]');
    const g=[...document.querySelectorAll('[role=group][aria-label]')].find((x)=>norm(x.getAttribute('aria-label'))===want);
    if(g) return g;
    const near=[...document.querySelectorAll('label')].find((l)=>norm(l.innerText).startsWith(want)&&!l.querySelector('input'));
    if(near){
      const scope=near.parentElement;
      const ctl=scope.querySelector('input:not([type=checkbox]),textarea,select');
      if(ctl) return ctl;
      if(scope.querySelectorAll('button').length) return scope;
      const box=scope.querySelector('input[type=checkbox]');
      if(box) return box;
    }
    return null})()`;
};

const describe = async (label) => {
  const raw = await ev(`${CONTROL(label)}`);
  return JSON.parse(raw);
};

/** Write a value the way a user's event reaches React, then read it back. */
async function setField(label, raw) {
  const at = AT(label);
  const before = await describe(label);
  if (before.kind === 'none') return { label, want: raw, before: 'NO CONTROL', after: 'NO CONTROL' };
  if (before.kind === 'group' || before.kind === 'chiprow') {
    // A segmented control's value is `aria-pressed` in the rail and a
    // `doodle-chip-active` class in the video panels; 'toggle' picks the inactive chip.
    const active = before.kind === 'group' ? "c.getAttribute('aria-pressed')==='true'" : '/chip-active/.test(c.className)';
    await ev(`(()=>{const g=${at};const chips=[...g.querySelectorAll('button')];
      const want=${JSON.stringify(String(raw).toLowerCase())};
      const chip = want==='toggle'
        ? chips.find((c)=>!(${active}))
        : chips.find((c)=>(c.innerText||'').toLowerCase().includes(want));
      if(!chip) return 'NO CHIP'; chip.click(); return 'clicked '+chip.innerText.trim();})()`);
  } else if (before.kind === 'options') {
    await ev(`(()=>{const g=${at};const norm=(s)=>(s||'').replace(/\\s+/g,' ').trim().toLowerCase();
      const want=${JSON.stringify(String(raw).toLowerCase())};
      const rows=[...g.querySelectorAll('label')];
      const row = want==='toggle'
        ? rows.find((l)=>!l.querySelector('input:checked'))
        : rows.find((l)=>norm(l.innerText).includes(want));
      if(!row) return 'NO OPTION'; const box=row.querySelector('input[type=checkbox]'); box.click(); return 'clicked '+row.innerText.trim();})()`);
  } else if (before.kind === 'checkbox') {
    const invert = raw === 'toggle';
    const want = invert ? !before.checked : (raw === '1' || raw === 'true' || raw === 'on');
    await ev(`(()=>{const c=${at}; if(c.checked!==${want}) c.click(); return 1})()`);
  } else if (before.kind === 'select') {
    await ev(`(()=>{const s=${at};const want=${JSON.stringify(String(raw).toLowerCase())};
      const o=[...s.options].find((x)=>String(x.value).toLowerCase()===want)||[...s.options].find((x)=>(x.text||'').toLowerCase().includes(want));
      if(!o) return 'NO OPTION';
      const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
      set.call(s,o.value); s.dispatchEvent(new Event('input',{bubbles:true})); s.dispatchEvent(new Event('change',{bubbles:true})); return 'selected '+o.text;})()`);
  } else if (before.kind === 'textarea') {
    await ev(`(()=>{const t=${at};
      const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      set.call(t,${JSON.stringify(String(raw))});
      t.dispatchEvent(new Event('input',{bubbles:true})); t.dispatchEvent(new Event('change',{bubbles:true})); return 1})()`);
  } else if (before.kind === 'input' && before.type === 'file') {
    // A `file` field is filled through CDP, not through the DOM. The rail's picker
    // has no id of its own, so tag the element the label resolved to and let the
    // caller address that exact node — writing to `input[type=file]` by position
    // hits the page's intake instead, and the field silently stays empty.
    await ev(`(()=>{const c=${at}; if(c){c.setAttribute('data-triage-file','1'); return 1} return 0})()`);
    return { label, want: raw, before: 'file input', after: 'file input', file: String(raw), marker: true };
  } else if (before.kind === 'pair') {
    // `dimensions`: width and height in one group, written "400x300".
    const [w, h] = String(raw).split(/[x,]/);
    await ev(`(()=>{const g=${at};const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      const ins=[...g.querySelectorAll('input')];
      set.call(ins[0],${JSON.stringify(String(w ?? ''))}); ins[0].dispatchEvent(new Event('input',{bubbles:true}));
      if(ins[1]&&${JSON.stringify(String(h ?? ''))}!==''){set.call(ins[1],${JSON.stringify(String(h ?? ''))}); ins[1].dispatchEvent(new Event('input',{bubbles:true)});}
      return 1})()`);
  } else {
    const numeric = before.type === 'range' || before.type === 'number';
    const written = numeric ? JSON.stringify(Number(raw)) : JSON.stringify(String(raw));
    await ev(`(()=>{const c=${at};
      const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      set.call(c,${written});
      c.dispatchEvent(new Event('input',{bubbles:true})); c.dispatchEvent(new Event('change',{bubbles:true})); return 1})()`);
  }
  await sleep(200);
  const after = await describe(label);
  return {
    label,
    want: raw,
    before: print(before),
    after: print(after),
    file: before.kind === 'input' && before.type === 'file' ? String(raw) : undefined,
  };
}

/** One line describing what the rail holds for a control, before and after. */
function print(c) {
  if (c.kind === 'none') return 'NO CONTROL';
  if (c.kind === 'checkbox') return `checked=${c.checked}`;
  if (c.kind === 'group' || c.kind === 'chiprow') {
    const rows = c.kind === 'group' ? c.chips : c.chips.map(([t, on]) => [t, on ? 'true' : 'false']);
    return `${c.kind}: ${rows.map(([t, p]) => t + (p === 'true' ? '*' : '')).join('|')}`;
  }
  if (c.kind === 'options') return `options: ${c.options.map(([t, p]) => t + (p ? '*' : '')).join('|')}`;
  if (c.kind === 'select') return `select=${c.value} of ${c.options.map(([v]) => v).join('/')}`;
  if (c.kind === 'pair') return `pair=${(c.values ?? []).join('x')}`;
  return `${c.type ?? 'input'}=${c.value}`;
}

/** The words the app itself printed about this run. */
const SCREEN = `(()=>{
  const pick=(sel)=>{const e=document.querySelector(sel);return e?e.innerText.trim():null};
  const btn=(sel)=>{const e=document.querySelector(sel);return e?{text:e.innerText.trim(),disabled:!!e.disabled}:null};
  return JSON.stringify({
    result: pick('section[aria-label="Result"]'),
    alert: pick('[role=alert]'),
    status: pick('[role=status]'),
    previewPages: document.querySelector('[data-preview-pages]')?.getAttribute('data-preview-pages') ?? null,
    surface: document.querySelector('[data-surface]')?.getAttribute('data-surface') ?? null,
    surfaceText: (document.querySelector('[data-surface]')?.innerText || '').slice(0, 3000),
    run: btn('#tool-process-btn'),
    buttons: [...document.querySelectorAll('button')].map((b)=>[b.innerText.trim().slice(0,34),!b.disabled]).filter(([t])=>t).slice(0,40),
    headings: [...document.querySelectorAll('h1,h2,h3')].map((h)=>h.innerText.trim()).slice(0,8),
    screen: (document.body.innerText||'').slice(0,2200),
  });
})()`;

async function screen() {
  return JSON.parse(await ev(SCREEN));
}

/** One full drive of one tool: load, upload, set, run, take the files. */
async function runTool(run) {
  const files = run.files ?? (run.file ? [run.file] : []);
  const record = {
    tool: run.tool,
    tag: run.tag ?? 'base',
    files: files.map((f) => basename(f)),
    fields: run.fields ?? {},
    readback: [],
    ok: false,
    fail: null,
    outputs: [],
    errors: [],
  };
  const url = `${BASE}/#${run.route ?? `/tool/${run.tool}`}`;
  await send('Page.navigate', { url });
  const loaded = await wait(`document.readyState==='complete' && !!document.querySelector('#tool-process-btn, input[type=file], [data-intake]')`, 120000);
  if (!loaded) {
    record.fail = 'route did not mount a tool surface';
    record.screen = await screen().catch(() => null);
    return record;
  }
  // Catch every produced file by name: the result card's Download buttons run
  // `downloadBlob`, which makes an object URL and clicks an <a download=…>.
  await ev(`(()=>{
    window.__blobs=[]; window.__urls=new Map(); window.__files=[];
    const o=URL.createObjectURL.bind(URL);
    // The url-to-blob map is deliberately never cleared: downloadBlob revokes its
    // URL the moment it has clicked, and a revoked URL's blob is the one thing the
    // probe still needs in order to hand the file back.
    URL.createObjectURL=(b)=>{const u=o(b); window.__urls.set(u,b); window.__blobs.push(b); return u};
    const click=HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click=function(){
      if(this.download && window.__urls.has(this.href)){ window.__files.push([this.download,this.href]); return; }
      return click.apply(this,arguments);
    };
    return 1})()`);
  const { root } = await send('DOM.getDocument', { depth: -1 });
  if (files.length) {
    // A bespoke pane may mount its own file input ahead of the page's intake, and
    // writing to the wrong one looks exactly like a successful upload: the call
    // returns, the page keeps saying "Select PDF file". So try every input until
    // the app itself acknowledges the file by name.
    const inputs = await send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' });
    const names = (inputs.nodeIds ?? []).filter((n) => n > 0);
    let taken = false;
    for (const nodeId of names.length ? names : [0]) {
      if (!nodeId) break;
      try {
        await send('DOM.setFileInputFiles', { nodeId, files });
      } catch {
        continue;
      }
      taken = await wait(
        `document.body.innerText.includes(${JSON.stringify(basename(files[0]))})`, 12000,
      );
      if (taken) break;
    }
    record.uploaded = taken;
    if (!taken) await wait(`document.body.innerText.length > 0`, 3000);
  }
  if (run.waitFor) {
    if (!(await wait(run.waitFor, 60000))) record.waitForMissing = run.waitFor;
  }
  // The rail folds everything but its lead field behind "N more options".
  if (run.openOptions !== false) {
    await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/more option/i.test(x.innerText||''));if(b)b.click();return !!b})()`);
    await sleep(300);
  }
  for (const [label, value] of Object.entries(run.fields ?? {})) {
    let result = await setField(label, value);
    if (result.before === 'NO CONTROL') {
      // Options whose list comes from the opened document (a layer picker, a form
      // field chooser) mount a beat later than the static ones, and the disclosure
      // may have collapsed when the file landed. Open it once more and retry.
      await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/more option/i.test(x.innerText||''));if(b&&/more/i.test(b.innerText))b.click();return 1})()`);
      await sleep(1200);
      result = await setField(label, value);
      result.retriedAfterOpeningOptions = true;
    }
    record.readback.push(result);
    if (result.file) {
      // A `file` field's own input, not the page's intake. The document handle is
      // re-read here because the pane re-rendered when the field was touched, and a
      // stale nodeId writes into a detached element: the DOM looks set, React's
      // onChange never fires, and the tool still says "choose at least one file".
      const fresh = await send('DOM.getDocument', { depth: -1 });
      let selector = 'input[type=file]';
      if (result.marker) selector = 'input[data-triage-file]';
      else if (result.id) selector = `#${result.id}`;
      const node = await send('DOM.querySelector', { nodeId: fresh.root.nodeId, selector });
      if (node.nodeId) await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [result.file] });
    }
  }
  await sleep(200);
  // An escape hatch for panels the rail's field contract does not describe: the
  // spec may name DOM expressions to run (a chip with no label, a scrubber handle),
  // and expressions whose value is worth reading back into the record.
  for (const expr of run.eval ?? []) {
    record.readback.push(`eval: ${String(await ev(expr).catch((e) => `threw ${e}`)).slice(0, 160)}`);
  }
  for (const expr of run.readback ?? []) {
    record.readback.push(`read: ${String(await ev(expr).catch((e) => `threw ${e}`)).slice(0, 160)}`);
  }
  // Blob index before the click: a video pane makes an object URL of the *input*
  // for its preview, so "the biggest blob" would hand back the file it started with.
  const blobsBefore = await ev(`window.__blobs.length`).catch(() => 0);
  const beforeErrorCount = errors.length;

  const clicked = await ev(`(()=>{
    const b=document.querySelector('#tool-process-btn')||document.querySelector('[data-run]');
    if(b){ if(b.disabled) return 'DISABLED'; b.click(); return 'run'; }
    const re=${JSON.stringify(run.label ?? '')};
    if(re){const x=[...document.querySelectorAll('button')].find((y)=>new RegExp(re,'i').test(y.innerText||'')&&!y.disabled); if(x){x.click(); return 'named '+x.innerText.trim();}}
    return 'NO RUN BUTTON';})()`);
  record.clicked = clicked;
  if (clicked === 'DISABLED' || clicked === 'NO RUN BUTTON') {
    record.fail = clicked === 'DISABLED' ? 'run button disabled' : 'no run button on this surface';
    record.screen = await screen();
    return record;
  }
  const finished = await wait(
    // Two things count as an answer. The app's own sentence — a result card, an
    // error, or a report with nothing to download — or a blob made *after* the
    // click: a video pane has no result card at all, and preview strips make
    // object URLs of their own while a PDF run is still at 5 %, so the blob test
    // is only honest when it starts counting from the click.
    `!!document.querySelector('section[aria-label="Result"]')`
    + ` || !!document.querySelector('[role=alert]')`
    + ` || /nothing to download|finished in this tab/i.test(document.querySelector('[data-surface]')?.innerText || '')`
    + ` || window.__blobs.length>${blobsBefore}`
    + ` || window.__files.length>0`,
    run.timeout ?? TIMEOUT,
  );
  await sleep(900);
  record.screen = await screen();
  record.errors = [...new Set(errors.slice(beforeErrorCount))].slice(0, 4);
  if (!finished) {
    record.fail = 'timed out with no output and no error';
    return record;
  }
  if (record.screen?.alert && !record.screen.result) {
    record.fail = 'error';
    record.alert = record.screen.alert;
    return record;
  }
  // Every file the run produced, taken the way a user takes it: press the card's
  // own Download buttons and keep the bytes that go through `downloadBlob`. The
  // blob list alone cannot be trusted — preview strips make object URLs too.
  record.blobCount = await ev(`window.__blobs.length`);
  if (record.screen?.result) {
    record.downloadClick = await ev(`(()=>{
      const per=[...document.querySelectorAll('section[aria-label="Result"] button[aria-label^="Download "]')];
      if(per.length){per.forEach((b)=>b.click()); return 'each:'+per.length;}
      const all=[...document.querySelectorAll('section[aria-label="Result"] button')]
        .find((b)=>/^(Download|Download all)$/.test((b.innerText||'').trim()));
      if(all){all.click(); return 'one';}
      return 'none';})()`);
    await wait(`window.__files.length >= ${record.downloadClick?.startsWith('each:') ? record.downloadClick.slice(5) : 1}`, 20000);
    // Multi-file tools stagger their downloads (`index * 220ms`), so read the list
    // only after the last one has had its turn.
    await sleep(2200);
  }
  record.hook = JSON.parse(await ev(`JSON.stringify({blobs:window.__blobs.length,urls:window.__urls.size,files:window.__files.length})`));
  const named = JSON.parse(await ev(`JSON.stringify(window.__files)`));
  for (const [name, href] of named) {
    const saved = await save(name, href);
    if (saved) record.outputs.push(saved);
  }
  if (!record.outputs.length && record.blobCount > blobsBefore) {
    // No card, or a card whose download the hook did not catch: keep the biggest
    // blob made *after* the run started, so the bytes are still measurable.
    const at = await ev(`window.__blobs.slice(${blobsBefore}).map((b,i)=>[i+${blobsBefore},b.size]).sort((a,b)=>b[1]-a[1])[0][0]`);
    const href = await ev(`(()=>{const e=[...window.__urls.entries()].find(([,b])=>b===window.__blobs[${at}]);return e?e[0]:''})()`);
    if (href) {
      const saved = await save(`blob-${at}`, href);
      if (saved) record.outputs.push(saved);
    }
  }
  if (!record.outputs.length && !record.screen?.result && record.screen?.surface === 'result') {
    // A report-only result (metadata, page dimensions) answers in prose, not bytes.
    record.reportOnly = true;
  }
  record.ok = record.reportOnly || record.outputs.length > 0;
  if (!record.ok && !record.fail) record.fail = 'produced no file and no report';
  return record;
}

/** Pull one blob out of the tab by its object URL and write it under OUTDIR. */
async function save(name, href) {
  const info = JSON.parse(await ev(`(async()=>{var b=window.__urls.get(${JSON.stringify(href)});if(!b) return JSON.stringify({missing:true});
    var u=new Uint8Array(await b.arrayBuffer());var s='';for(var i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));
    return JSON.stringify({type:b.type,size:u.length,b64:btoa(s)})})()`));
  if (info.missing) return null;
  const path = join(OUTDIR, `${run_prefix}_${sanitize(name)}`);
  writeFileSync(path, Buffer.from(info.b64, 'base64'));
  return { name, path, bytes: info.size, type: info.type };
}

const sanitize = (n) => n.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-64);
let run_prefix = 'run';

// ── batch mode ──────────────────────────────────────────────────────────────
if (SPEC) {
  const spec = JSON.parse(readFileSync(SPEC, 'utf8'));
  const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
  mkdirSync(OUTDIR, { recursive: true });
  const out = JSONL || null;
  let done = 0;
  for (const run of spec) {
    if (only && !only.has(run.tool)) continue;
    run_prefix = sanitize(`${run.tool}__${run.tag ?? 'base'}`);
    let record;
    try {
      record = await runTool(run);
    } catch (error) {
      record = { tool: run.tool, tag: run.tag ?? 'base', ok: false, fail: `probe error: ${String(error).slice(0, 200)}` };
    }
    record.outdirPrefix = run_prefix;
    done += 1;
    if (out) writeFileSync(out, `${JSON.stringify(record)}\n`, { flag: 'a' });
    console.log(
      `${done} ${run.tool}/${run.tag ?? 'base'} -> ${record.ok ? 'ok' : 'FAIL'}`
      + (record.fail ? ` (${record.fail})` : '')
      + ` | files ${(record.outputs ?? []).length}`
      + ` | ${(record.outputs ?? []).map((o) => `${o.name}:${o.bytes}B`).join(' ').slice(0, 140)}`,
    );
  }
  console.log(`spec complete: ${done} run(s)`);
  ws.close();
  chrome.kill('SIGKILL');
  process.exit(0);
}

// ── single-run mode (the form colour-measure.sh calls) ──────────────────────
await send('Page.navigate', { url: `${BASE}/#/tool/${TOOL}` });
if (!(await wait(`document.readyState === 'complete' && !!document.querySelector('input[type=file]')`, 90000))) {
  throw new Error('no file input on the route');
}
await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
{
  const { root } = await send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId, files: [PDF] });
}
// The rail folds everything but its lead field behind "N more options".
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/more option/i.test(x.innerText||''));if(b)b.click();return !!b})()`);
await sleep(400);

const applied = [];
for (const [label, raw] of Object.entries(WANTED)) {
  const result = await setField(label, raw);
  applied.push(`${result.label}=${result.want}: "${result.before}" → "${result.after}"`);
}

// Asked *after* the fields are written, because a rail whose required field is
// still empty disables its own run button — `protect` among them. Waiting first
// made the probe report "no enabled button" for a tool that runs fine, and the
// list of buttons it printed was the disabled one.
if (!(await wait(`(()=>{const re=new RegExp(${JSON.stringify(LABEL || TOOL)},'i');return [...document.querySelectorAll('button')].some(b=>re.test(b.innerText||'')&&!b.disabled)})()`, 90000))) {
  console.log('buttons:', JSON.stringify(await ev(`JSON.stringify([...document.querySelectorAll('button')].map(b=>[b.innerText.trim().slice(0,30),!b.disabled]))`)));
  console.log('fields:', JSON.stringify(applied, null, 1));
  throw new Error(`no enabled button matching ${LABEL || TOOL} after loading ${PDF}`);
}
console.log('fields:', JSON.stringify(applied, null, 1));

await ev(`(()=>{const re=new RegExp(${JSON.stringify(LABEL || TOOL)},'i');const b=[...document.querySelectorAll('button')].find(x=>re.test(x.innerText||'')&&!x.disabled);b.click();return b.innerText.trim()})()`).then((t) => console.log('clicked', JSON.stringify(t)));
if (!(await wait('window.__blobs.length>0', TIMEOUT))) {
  console.log('NO OUTPUT — the screen says:', JSON.stringify(await ev(`(document.body.innerText||'').slice(0,1200)`)));
  throw new Error('the tool produced no output blob');
}
await sleep(1000);
if (process.env.SHOT) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(process.env.SHOT, Buffer.from(shot.data, 'base64'));
  console.log('screenshot:', process.env.SHOT);
}
const info = JSON.parse(await ev(`(async()=>{var b=window.__blobs.at(-1);var u=new Uint8Array(await b.arrayBuffer());var s='';for(var i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return JSON.stringify({type:b.type,size:u.length,b64:btoa(s)})})()`));
writeFileSync(OUT, Buffer.from(info.b64, 'base64'));
console.log('output', JSON.stringify({ type: info.type, bytes: info.size, file: OUT }));
console.log('report line:', await ev(`(()=>{const card=document.querySelector('section[aria-label="Result"]');if(card) return card.innerText;return (document.body.innerText.match(/[^\\n]*(page|pages|dpi|invert|adjust|scan)[^\\n]*/gi)||[]).slice(0,6).join(' ;; ')})()`));
console.log('console errors:', JSON.stringify([...new Set(errors)].slice(0, 3)));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
