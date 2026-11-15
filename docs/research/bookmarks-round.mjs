// The `bookmarks` pane probe: type an outline into the card's textarea, read it
// back out of the DOM, run it, and hand back the produced file and a screenshot.
//
// The tool's only free-text field is multi-line and `colour-rail.mjs` splits its
// FIELDS on whitespace, so a newline can never survive that form. This probe
// carries its cases as real JavaScript strings for that reason, and follows the
// same shape as the other campaign drivers: one Chromium tab per case, every
// field written the way a user's event reaches React and read back before the
// click, every produced file taken through `downloadBlob`'s own object URL, one
// screenshot per case.
//
//   BASE=http://localhost:5271 OUTDIR=/tmp/bm/shots node docs/research/bookmarks-round.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const OUTDIR = process.env.OUTDIR || '/tmp/bm/shots';
const PDFDIR = process.env.PDFDIR || '/tmp/triage/in';
const PORT = Number(process.env.PORT || 9821);
const TIMEOUT = Number(process.env.RUN_TIMEOUT || 150000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The cases. `typed` is what a person types, verbatim.
 *
 * `tag` is the fixture and the record's identity; `replace: false` flips the
 * card's toggle off; `dark` takes the shot with the shell's dark token class,
 * which is the one shot a UI round owes.
 */
const CASES = [
  {
    id: 'outer-then-typed',
    file: 'bookmarked.pdf',
    note: 'the box empty over a document that holds three entries',
  },
  {
    id: 'typed-nesting',
    file: 'bookmarked.pdf',
    typed: 'Chapter One\n  Section One.A\nChapter Two\n\tTab Child\n    Four-Space Grandchild :: 3',
    note: 'levels by spaces and by a tab, one entry with a page',
  },
  {
    id: 'typed-specials',
    file: 'bookmarked.pdf',
    typed: 'Report (final) :: 1\nBack\\slash :: 2\nA :: B :: 3\nCafé ☕ :: 4\nРусский :: 1',
    note: 'parentheses, a backslash, a colon pair, non-ASCII',
  },
  {
    id: 'append',
    file: 'bookmarked.pdf',
    typed: 'Appended :: 2',
    replace: false,
    note: 'replace off: what happens to the three entries already there',
  },
  {
    id: 'edges-forty',
    file: 'bookmarked.pdf',
    typed: [
      'Past the end :: 9',
      '',
      'Only a heading',
      ' :: 2',
      ':: 3',
      'Last :: 4',
      ...Array.from({ length: 40 }, (_, i) => (i % 10 === 0 ? `Group ${i + 1}` : `\tItem ${i + 1} :: ${(i % 4) + 1}`)),
    ].join('\n'),
    note: 'past the last page, a blank line, two empty titles, 40 entries, tabs',
    dark: true,
  },
];

mkdirSync(OUTDIR, { recursive: true });

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/bm-chrome-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
    if (pending.has(i)) { pending.delete(i); rej(new Error(`${method} #${i} unanswered`)); }
  }, 30000);
});
const ev = async (expr) => {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result?.value;
    } catch (error) { last = error; await sleep(400); }
  }
  throw last;
};
const wait = async (expr, ms = TIMEOUT) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(200); }
  return false;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });

const norm = `const norm=(s)=>(s||'').replace(/\\s+/g,' ').trim().toLowerCase();`;
/** The outline textarea, found by the words the card prints above it. */
const OUTLINE = `(()=>{${norm}
  const lab=[...document.querySelectorAll('label[for]')].find((l)=>norm(l.innerText)==='outline');
  return lab?document.getElementById(lab.getAttribute('for')):null})()`;
/** The replace toggle, found by the words printed beside its box. */
const REPLACE = `(()=>{${norm}
  const box=[...document.querySelectorAll('label')].find((l)=>norm(l.innerText)==='replace the existing outline');
  return box?box.querySelector('input[type=checkbox]'):null})()`;

const SCREEN = `(()=>{
  const pick=(sel)=>{const e=document.querySelector(sel);return e?e.innerText.trim():null};
  return JSON.stringify({
    result: pick('section[aria-label="Result"]'),
    alert: pick('[role=alert]'),
    status: pick('[role=status]'),
    surface: document.querySelector('[data-surface]')?.getAttribute('data-surface') ?? null,
    pane: (document.querySelector('[data-surface]')?.innerText || '').slice(0, 4000),
    help: [...document.querySelectorAll('[id$="-help"],p')].map((p)=>p.innerText.trim()).filter((t)=>/::/.test(t)).slice(0,3),
    run: (()=>{const b=document.querySelector('#tool-process-btn');return b?{text:b.innerText.trim(),disabled:b.disabled}:null})(),
  });
})()`;

const rows = [];
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
for (const run of CASES) {
  if (ONLY && !ONLY.has(run.id)) continue;
  const record = { case: run.id, note: run.note, typed: run.typed ?? '', readback: [], outputs: [], ok: false };
  await send('Page.navigate', { url: `${BASE}/?probe=${encodeURIComponent(run.id)}#/tool/bookmarks` });
  const loaded = await wait(`document.readyState==='complete' && !!document.querySelector('input[type=file], #tool-process-btn')`, 120000);
  if (!loaded) { record.fail = 'route did not mount'; rows.push(record); continue; }
  await ev(`(()=>{
    window.__blobs=[]; window.__urls=new Map(); window.__files=[];
    const o=URL.createObjectURL.bind(URL);
    URL.createObjectURL=(b)=>{const u=o(b); window.__urls.set(u,b); window.__blobs.push(b); return u};
    const click=HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click=function(){
      if(this.download && window.__urls.has(this.href)){ window.__files.push([this.download,this.href]); return; }
      return click.apply(this,arguments);
    };
    return 1})()`);
  const { root } = await send('DOM.getDocument', { depth: -1 });
  const inputs = await send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' });
  const file = join(PDFDIR, run.file);
  let taken = false;
  for (const nodeId of (inputs.nodeIds ?? []).filter((n) => n > 0)) {
    try { await send('DOM.setFileInputFiles', { nodeId, files: [file] }); } catch { continue; }
    taken = await wait(`document.body.innerText.includes(${JSON.stringify(basename(file))})`, 12000);
    if (taken) break;
  }
  record.uploaded = taken;
  if (!taken) { record.fail = 'upload not acknowledged'; rows.push(record); continue; }
  await wait(`!!document.querySelector('#tool-process-btn')`, 30000);
  const opened = await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/more option/i.test(x.innerText||''));if(b)b.click();return !!b})()`);
  record.openedOptions = opened;
  await sleep(300);

  if (run.replace === false) {
    const before = await ev(`${REPLACE}?.checked ?? null`);
    await ev(`(()=>{const c=${REPLACE}; if(!c) return 'NO TOGGLE'; if(c.checked) c.click(); return 1})()`);
    await sleep(200);
    record.readback.push(`replace: ${before} -> ${await ev(`${REPLACE}?.checked ?? null`)}`);
  }
  if (run.typed) {
    await ev(`(()=>{const t=${OUTLINE}; if(!t) return 'NO BOX';
      const set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      set.call(t,${JSON.stringify(run.typed)});
      t.dispatchEvent(new Event('input',{bubbles:true})); t.dispatchEvent(new Event('change',{bubbles:true})); return 1})()`);
    await sleep(300);
    const back = await ev(`${OUTLINE}?.value ?? null`);
    record.readback.push(`outline read back identical: ${back === run.typed} (${back?.length} chars vs ${run.typed.length})`);
    if (back !== run.typed) record.readback.push(`got: ${JSON.stringify(back)}`);
  }
  if (run.dark) await ev(`(()=>{document.documentElement.classList.add('dark');try{localStorage.setItem('browsersnip:theme','dark')}catch{}return 1})()`);
  const shotBefore = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUTDIR, `${run.id}-typed.png`), Buffer.from(shotBefore.data, 'base64'));
  record.shotBefore = join(OUTDIR, `${run.id}-typed.png`);

  const { root: root2 } = await send('DOM.getDocument', { depth: -1 });
  const button = await send('DOM.querySelector', { nodeId: root2.nodeId, selector: '#tool-process-btn' });
  record.button = await ev(`(()=>{const b=document.querySelector('#tool-process-btn');return b?{text:b.innerText.trim(),disabled:b.disabled}:null})()`);
  if (!button.nodeId || record.button?.disabled) { record.fail = 'run button disabled'; record.screen = JSON.parse(await ev(SCREEN)); rows.push(record); continue; }
  const blobsBefore = await ev(`window.__blobs.length`);
  await ev(`document.querySelector('#tool-process-btn').click()`);
  const finished = await wait(
    `!!document.querySelector('section[aria-label="Result"]') || !!document.querySelector('[role=alert]')`
    + ` || /nothing to download/i.test(document.querySelector('[data-surface]')?.innerText || '')`
    + ` || window.__files.length>0`,
    TIMEOUT,
  );
  await sleep(900);
  record.screen = JSON.parse(await ev(SCREEN));
  const shotAfter = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUTDIR, `${run.id}-result.png`), Buffer.from(shotAfter.data, 'base64'));
  record.shot = join(OUTDIR, `${run.id}-result.png`);
  record.errors = [...new Set(errors)].slice(0, 4);
  if (!finished) { record.fail = 'timed out, no card and no error'; rows.push(record); continue; }
  if (record.screen.result) {
    record.downloadClick = await ev(`(()=>{
      const per=[...document.querySelectorAll('section[aria-label="Result"] button[aria-label^="Download "]')];
      if(per.length){per.forEach((b)=>b.click()); return 'each:'+per.length;}
      const all=[...document.querySelectorAll('section[aria-label="Result"] button')]
        .find((b)=>/^(Download|Download all)$/.test((b.innerText||'').trim()));
      if(all){all.click(); return 'one';}
      return 'none';})()`);
    await wait(`window.__files.length > 0`, 20000);
    await sleep(1500);
  }
  const named = JSON.parse(await ev(`JSON.stringify(window.__files)`));
  for (const [name, href] of named) {
    // The URL is revoked by `downloadBlob` the moment it has clicked, so the blob
    // is fetched out of the map the hook kept, never by re-requesting the URL.
    const info = JSON.parse(await ev(`(async()=>{const b=window.__urls.get(${JSON.stringify(href)});if(!b) return JSON.stringify({missing:true});
      const u=new Uint8Array(await b.arrayBuffer());let s='';for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));
      return JSON.stringify({b64:btoa(s),size:u.length,type:b.type})})()`));
    if (info.missing) continue;
    const out = join(OUTDIR, `${run.id}-${name.replace(/[^A-Za-z0-9._-]+/g, '_')}`);
    writeFileSync(out, Buffer.from(info.b64, 'base64'));
    record.outputs.push(out);
    record.bytes = info.size;
  }
  record.ok = named.length > 0 || Boolean(record.screen.result || record.screen.alert);
  record.blobDelta = (await ev(`window.__blobs.length`)) - blobsBefore;
  rows.push(record);
}

writeFileSync(join(OUTDIR, `browser-runs${process.env.ONLY ? '-partial' : ''}.json`), `${JSON.stringify(rows, null, 1)}\n`);
console.log(JSON.stringify(rows.map((r) => ({
  case: r.case, uploaded: r.uploaded, button: r.button, clicked: r.downloadClick,
  readback: r.readback, outputs: r.outputs, fail: r.fail,
  message: r.screen?.result ?? r.screen?.alert, errors: r.errors,
})), null, 1));
chrome.kill('SIGKILL');
ws.close();
