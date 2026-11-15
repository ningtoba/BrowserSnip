// `form-filler` on a live build: fill the pane the way a person fills it, keep the
// produced bytes, and keep a screenshot of the pane while it holds the answers.
//
//   BASE=http://localhost:5271 CASES=/tmp/f047/cases.json OUTDIR=/tmp/f047/out \
//     CDP=9821 node docs/research/form-filler-round.mjs
//
// The pane (`edit/FormFillMain`) is bespoke: it mounts the live pdf.js page and
// puts one real control over each widget, plus the same control again in the flat
// field list. Both copies answer to the field's own label (`/TU`, else `/T`), so
// this driver addresses controls by that label, writes them the way a user's event
// reaches React, and **reads every one back out of the DOM before it clicks save** —
// a read-back that does not match is a broken run, not a tool result.
//
// Two fixtures: `/tmp/triage/in/form.pdf` (text, dropdown with a value already in
// it, checked box) and `docs/research/form-filler-fixture.pdf`, built by
// `docs/research/f047-mk-fixture.ts` to carry every field type the card claims —
// text, multiline, maxlen, read-only, checkbox, radio group, filled dropdown,
// list, required text and a push button.
//
// Every produced file is taken from the object URL `savePDF` hands to `downloadBlob`,
// then measured by `form-filler-round.py` (pypdf: `/V`, `/AS`, `/AP /N`, `/Annots`,
// `/AcroForm`, `/Info`; MuPDF: ink and text on the page).
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:5271';
const CASES = JSON.parse(readFileSync(process.env.CASES || '/tmp/f047/cases.json', 'utf8'));
const OUTDIR = process.env.OUTDIR || '/tmp/f047/out';
const LABEL = process.env.LABEL || 'Fill and save';
mkdirSync(OUTDIR, { recursive: true });

const h = await open();
await h.send('Page.enable');

const ready = `(()=>{
  const t = document.body.innerText || '';
  if (!/all fields/i.test(t)) return false;
  return !!document.querySelector('[data-form-draft]') || /no form fields|None of this PDF/.test(t);
})()`;

/** Set one control, then read it back. Returns the readback (matches the want or not). */
async function setControl(field, value, kind) {
  const label = JSON.stringify(field);
  if (kind === 'toggle') {
    await h.ev(`(()=>{const l=[...document.querySelectorAll('label')].find(x=>/Fill and flatten/.test(x.innerText||''));const c=l&&l.querySelector('input[type=checkbox]');if(c&&c.checked!==${value === 'true'})c.click();return 1})()`);
    await sleep(150);
    return h.ev(`(()=>{const l=[...document.querySelectorAll('label')].find(x=>/Fill and flatten/.test(x.innerText||''));const c=l&&l.querySelector('input[type=checkbox]');return c?(c.checked?'true':'false'):'NO CONTROL'})()`);
  }
  if (kind === 'check') {
    // A checkbox field. A kept draft means the start state is not the file's, so
    // it is normalised to unchecked first; two flips then land Off and leaving it
    // Off is read back out of the DOM.
    await h.ev(`(()=>{const c=document.querySelector('[aria-label="'+${label}+'"]');if(!c)return 0;if(c.checked)c.click();return 1})()`);
    await sleep(120);
    await h.ev(`(()=>{const c=document.querySelector('[aria-label="'+${label}+'"]');if(!c)return 0;c.click();return 1})()`);
    await sleep(120);
    const first = await h.ev(`(()=>{const c=document.querySelector('[aria-label="'+${label}+'"]');return c?(c.checked?'true':'false'):'NO CONTROL'})()`);
    await h.ev(`(()=>{const c=document.querySelector('[aria-label="'+${label}+'"]');if(c)c.click();return 1})()`);
    await sleep(120);
    const second = await h.ev(`(()=>{const c=document.querySelector('[aria-label="'+${label}+'"]');return c?(c.checked?'true':'false'):'NO CONTROL'})()`);
    return `${first}->${second}`;
  }
  if (kind === 'radio') {
    await h.ev(`(()=>{const g=document.querySelector('[role=radiogroup][aria-label="'+${label}+'"]');if(!g)return 0;
      const r=[...g.querySelectorAll('input[type=radio]')].find(x=>x.value===${JSON.stringify(value)});
      if(!r)return 0;r.click();return 1})()`);
    await sleep(150);
    return h.ev(`(()=>{const g=document.querySelector('[role=radiogroup][aria-label="'+${label}+'"]');if(!g)return 'NO CONTROL';
      const on=[...g.querySelectorAll('input[type=radio]')].find(x=>x.checked);return on?on.value:'none'})()`);
  }
  if (kind === 'select') {
    await h.ev(`(()=>{const s=document.querySelector('select[aria-label="'+${label}+'"]');if(!s)return 0;
      const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
      set.call(s,${JSON.stringify(value)});s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`);
    await sleep(150);
    return h.ev(`(()=>{const s=document.querySelector('select[aria-label="'+${label}+'"]');return s?s.value:'NO CONTROL'})()`);
  }
  // text / textarea: the native setter, then the events React listens for.
  const proto = kind === 'textarea' ? 'HTMLTextAreaElement' : 'HTMLInputElement';
  await h.ev(`(()=>{const c=document.querySelector('${kind === 'textarea' ? 'textarea' : 'input'}[aria-label="'+${label}+'"]');if(!c)return 0;
    const set=Object.getOwnPropertyDescriptor(${proto}.prototype,'value').set;
    set.call(c,${JSON.stringify(value)});c.dispatchEvent(new Event('input',{bubbles:true}));c.dispatchEvent(new Event('change',{bubbles:true}));return 1})()`);
  await sleep(150);
  return h.ev(`(()=>{const c=document.querySelector('${kind === 'textarea' ? 'textarea' : 'input'}[aria-label="'+${label}+'"]');return c?c.value:'NO CONTROL'})()`);
}

/** Every blob made after this call, with the bytes read out of it. */
const armBlob = () => h.ev(`(()=>{window.__taken=[];window.__blobs=[];
  if(!window.__hooked){window.__hooked=1;const o=URL.createObjectURL.bind(URL);
    URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};}
  return 1})()`);

const drainBlobs = () => h.ev(`(async()=>{
  try {
    const out=[];
    for (const b of (window.__blobs||[])) {
      if (!b || typeof b.arrayBuffer !== 'function') continue;
      if (!b.type || b.type.indexOf('pdf') < 0) continue;
      const buf=new Uint8Array(await b.arrayBuffer());
      let s=''; for (let i=0;i<buf.length;i+=4096) s+=String.fromCharCode.apply(null, buf.subarray(i,i+4096));
      out.push(btoa(s));
    }
    return JSON.stringify({count:out.length, bytes:out[0]||''});
  } catch (e) { return JSON.stringify({count:-1, error:String(e)}); }
})()`);

const records = [];
for (const [i, c] of CASES.entries()) {
  const record = { case: c.case, fixture: basename(c.pdf), sets: [], readback: [], ok: false, fail: null };
  console.error(`-- ${c.case}: navigate`);
  await h.send('Page.navigate', { url: `${BASE}/?c=${i}#/tool/form-filler` });
  if (!(await h.wait(`!!document.querySelector('input[type=file]')`, 60000))) {
    record.fail = 'no file input';
    records.push(record);
    continue;
  }
  await armBlob();
  const { root } = await h.send('DOM.getDocument', { depth: -1 });
  const inputs = await h.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' });
  let taken = false;
  for (const nodeId of inputs.nodeIds ?? []) {
    try { await h.send('DOM.setFileInputFiles', { nodeId, files: [c.pdf] }); } catch { continue; }
    taken = await h.wait(`document.body.innerText.includes(${JSON.stringify(basename(c.pdf))})`, 15000);
    if (taken) break;
  }
  console.error(`-- ${c.case}: uploaded=${taken}, waiting for the field list`);
  if (!(await h.wait(ready, 45000))) {
    record.fail = 'pane never listed the fields';
    record.screen = ((await h.ev('document.body.innerText')) || '').slice(0, 1200);
    records.push(record);
    continue;
  }
  await sleep(1200);
  record.pane = await h.ev(`(()=>{
    const list=(document.querySelectorAll('aside li')||[]);
    return JSON.stringify({
      header:(document.querySelector('[class*="text-[10px]"]')||{}).innerText||'',
      fields:[...list].map(li=>({
        label:(li.querySelector('label,span')||{}).innerText||'',
        meta:((li.querySelector('[class*=font-mono]'))||{}).innerText||'',
        control:(()=>{const el=li.querySelector('input,textarea,select,span');return el?el.tagName.toLowerCase()+':'+(el.type||''):'none'})(),
        editable:!!li.querySelector('input:not([disabled]),textarea,select'),
      })),
      overlayControls:document.querySelectorAll('[aria-label]').length,
      status:(document.querySelector('p[aria-live]')||{}).innerText||'',
    })})()`);
  for (const s of c.sets) {
    const readback = await setControl(s.field, s.value, s.kind);
    record.sets.push(`${s.kind}:${s.field}=${s.value}`);
    record.readback.push(`${s.field}: ${readback}`);
    record[`match_${s.field}`] = String(readback) === String(s.expect ?? s.value);
  }
  for (const expr of c.reads ?? []) {
    record.readback.push(`read: ${String(await h.ev(expr).catch((e) => `threw ${e}`)).slice(0, 200)}`);
  }
  await sleep(300);
  const shotPath = join(OUTDIR, `${i}-${c.case}-pane.png`);
  await h.shot(shotPath);
  record.shot = shotPath;
  if (c.dark) {
    await h.ev(`(()=>{document.documentElement.classList.add('dark');try{localStorage.setItem('browsersnip:theme','dark')}catch{}return 1})()`);
    await sleep(400);
    record.darkShot = join(OUTDIR, `${i}-${c.case}-dark.png`);
    await h.shot(record.darkShot);
  }
  const clicked = await h.ev(`(()=>{
    const b=[...document.querySelectorAll('button')].find(x=>new RegExp(${JSON.stringify(LABEL)},'i').test(x.innerText||''));
    if(!b) return 'NO SAVE BUTTON';
    if(b.disabled) return 'DISABLED';
    b.click(); return 'clicked ' + b.innerText.trim();})()`);
  record.clicked = clicked;
  const done = await h.wait(`!!document.querySelector('section[aria-label="Result"]') || !!document.querySelector('[role=alert]') || /saved|filled|flatten/i.test(document.querySelector('p[aria-live]')?.innerText||'')`, 150000);
  await sleep(1500);
  record.screen = await h.ev(`(()=>JSON.stringify({
    result:(document.querySelector('section[aria-label="Result"]')||{}).innerText||null,
    alert:(document.querySelector('[role=alert]')||{}).innerText||null,
    status:(document.querySelector('p[aria-live]')||{}).innerText||null,
    saveError:(document.querySelector('.text-danger[class*=border-b]')||{}).innerText||null,
    required:[...document.querySelectorAll('[data-form-required]')].map(e=>e.innerText),
    invalid:[...document.querySelectorAll('[aria-invalid=true]')].map(e=>e.getAttribute('aria-label')),
    count:(document.body.innerText.match(/Filled [^.]*\\./g)||[]).join(' | ')}))()`);
  record.afterShot = join(OUTDIR, `${i}-${c.case}-after.png`);
  await h.shot(record.afterShot);
  record.afterText = ((await h.ev('document.body.innerText')) || '').slice(0, 2500);
  const drained = JSON.parse((await drainBlobs()) || '{"count":-1}');
  record.blobs = drained.count;
  if (drained.count > 0) {
    const out = join(OUTDIR, `${i}-${c.case}-out.pdf`);
    writeFileSync(out, Buffer.from(drained.bytes, 'base64'));
    record.out = out;
  }
  if (drained.error) record.blobError = drained.error;
  // A control the rail kept at its old value makes every later claim void.
  record.ok = taken && done && String(clicked).startsWith('clicked') && Object.entries(record)
    .filter(([k]) => k.startsWith('match_')).every(([, v]) => v);
  if (!record.ok) record.fail = record.blobs < 1 ? 'no produced file' : 'a control did not read back';
  records.push(record);
}
writeFileSync(join(OUTDIR, 'records.json'), JSON.stringify(records, null, 1));
for (const r of records) {
  console.log(`\n== ${r.case} (${r.fixture})`);
  console.log(JSON.stringify(r, null, 1).slice(0, 4000));
}
const bad = records.filter((r) => !r.ok);
console.log(`\n${records.length - bad.length}/${records.length} cases drove every control to its value`);
h.chrome.kill();
process.exit(bad.length ? 1 : 0);
