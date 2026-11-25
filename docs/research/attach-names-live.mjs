// `add-attachments` NAME BATTERY, driven live in Chromium (chunk c4).
//
//   BASE=http://localhost:5294 CDP=9844 DOC=/tmp/triage/colour.pdf \
//     BATTERY=/tmp/lane-security/c4/live-battery.json OUT=/tmp/lane-security/c4/live \
//     SHOTS=1 DARK=0 node docs/research/attach-names-live.mjs
//
// `BATTERY` is a JSON array of `{case, doc?, description?, files:[{name, src}]}`. The
// names are handed over in-page through `DataTransfer` — `DOM.setFileInputFiles` gives
// Chrome a *path* and takes the basename, so `report (draft.txt`, `über-𓂀.txt` and a
// name with a backslash can only arrive as a File the page itself built (the harness
// lesson already recorded in `verify-attachments-names.mjs`). Every set is read back out
// of the chip list before the run: a case whose picker does not carry exactly the
// requested names is reported as `picker-mismatch` and not run, because then the run
// would be the harness's, not the tool's.
//
// Per case it writes `<case>.pdf` (the produced bytes), `<case>-light.png` (and
// `-dark.png` when DARK=1), and a `census.json` with the card's message, its warnings,
// the chip names, the blob list, and every request the tab made — with the byte size of
// any request body, which is what the network half is judged on (client-side mandate:
// no file bytes may leave the tab).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:5294';
const DOC = process.env.DOC;
const BATTERY = process.env.BATTERY;
const OUT = process.env.OUT || '/tmp/lane-security/c4/live';
const SHOTS = process.env.SHOTS === '1';
const DARK = process.env.DARK === '1';
if (!BATTERY) throw new Error('BATTERY is required');

const cases = JSON.parse(readFileSync(BATTERY, 'utf8'));
mkdirSync(OUT, { recursive: true });

const h = await open();
const rootId = async () => (await h.send('DOM.getDocument', { depth: -1 })).root.nodeId;

const requests = [];
await h.send('Network.enable', { maxTotalBufferSize: 200 * 1024 * 1024, maxResourceBufferSize: 60 * 1024 * 1024 });
h.ws.addEventListener?.('message', () => {});
const pending = new Map();
const onMessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.method === 'Network.requestWillBeSent') {
    const r = msg.params.request;
    pending.set(msg.params.requestId, { url: r.url, method: r.method, initiated: msg.params.type });
  } else if (msg.method === 'Network.loadingFinished' && pending.has(msg.params.requestId)) {
    const info = pending.get(msg.params.requestId);
    info.encodedDataLength = msg.params.encodedDataLength;
    requests.push(info);
    pending.delete(msg.params.requestId);
  } else if (msg.method === 'Network.loadingFailed' && pending.has(msg.params.requestId)) {
    const info = pending.get(msg.params.requestId);
    info.failed = msg.params.errorText;
    requests.push(info);
    pending.delete(msg.params.requestId);
  }
};
h.ws.addEventListener('message', onMessage);

const chipCount = `(() => [...document.querySelectorAll('[role=group]')]
  .find((x) => /files to attach/i.test(x.getAttribute('aria-label') || ''))
  ?.querySelectorAll('button[aria-label^="Remove "]').length || 0)()`;
const chipNames = `(() => {
  const g = [...document.querySelectorAll('[role=group]')]
    .find((x) => /files to attach/i.test(x.getAttribute('aria-label') || ''));
  return [...(g?.querySelectorAll('button[aria-label^="Remove "]') || [])].map((b) => b.getAttribute('aria-label').slice(7));
})()`;

const census = [];
for (const testCase of cases) {
  const doc = testCase.doc || DOC;
  // A hash-only `Page.navigate` to the URL the tab already holds does not reload the
  // document, so the tray of the previous case is still mounted and every chip list
  // afterwards reads as a picker mismatch. Go somewhere else first, then back.
  await h.send('Page.navigate', { url: `${BASE}/#/tools` });
  await sleep(600);
  await h.send('Page.navigate', { url: `${BASE}/#/tool/add-attachments` });
  if (!(await h.wait(`!!document.querySelector('input[type=file]')`, 60000))) throw new Error('no file input');
  await h.wait(`(() => { const g = [...document.querySelectorAll('[role=group]')]
    .find((x) => /files to attach/i.test(x.getAttribute('aria-label') || ''));
    return !!g && g.querySelectorAll('button[aria-label^="Remove "]').length === 0; })()`, 20000);
  await h.ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
  const intakeRoot = await rootId();
  await h.ev(`(() => { const i = [...document.querySelectorAll('input[type=file]')].find((x) => !x.closest('[role=group]')); if (i) i.setAttribute('data-probe-doc','1'); return !!i; })()`);
  const docField = await h.send('DOM.querySelector', { nodeId: intakeRoot, selector: 'input[data-probe-doc]' });
  await h.send('DOM.setFileInputFiles', { nodeId: docField.nodeId, files: [doc] });
  const docBytes = readFileSync(doc).length;
  // Wait for the pane to have read the document, not for a fixed sleep.
  const ready = await h.wait(`(() => {
    const b = document.querySelector('#tool-process-btn');
    return !!b && !b.disabled;
  })()`, 90000);
  await sleep(2500);
  await h.ev(`(() => { const bar = document.querySelector('[data-options-panel][data-options-panel] button[aria-expanded="false"]')
    || [...document.querySelectorAll('[data-options-panel] button[aria-expanded="false"]')][0]; if (bar) bar.click(); return !!bar; })()`);
  await sleep(700);

  // Whether or not the route remounted, the tray must start empty: click every Remove
  // chip (one click per evaluate, because a stale React closure removes the same chip
  // twice) before handing over this case's files.
  for (let guard = 0; guard < 40; guard++) {
    const dropped = await h.ev(`(() => {
      const g = [...document.querySelectorAll('[role=group]')].find((x) => /files to attach/i.test(x.getAttribute('aria-label') || ''));
      const b = g?.querySelector('button[aria-label^="Remove "]'); if (!b) return '';
      const name = b.getAttribute('aria-label').slice(7); b.click(); return name;
    })()`);
    if (!dropped) break;
    await sleep(200);
  }
  const payload = testCase.files.map((file) => {
    const bytes = readFileSync(file.src);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return { name: file.name, b64: Buffer.from(binary, 'binary').toString('base64'), type: file.type || 'application/octet-stream' };
  });
  await h.ev(`(() => {
    const g = [...document.querySelectorAll('[role=group]')].find((x) => /files to attach/i.test(x.getAttribute('aria-label') || ''));
    const i = g?.querySelector('input[type=file]'); if (!i) return 'no picker';
    const dt = new DataTransfer();
    for (const f of ${JSON.stringify(payload)}) {
      const raw = atob(f.b64); const u = new Uint8Array(raw.length);
      for (let k = 0; k < raw.length; k++) u[k] = raw.charCodeAt(k);
      dt.items.add(new File([u], f.name, { type: f.type }));
    }
    i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true }));
    return 'dispatched ' + i.files.length;
  })()`);
  let chips = 0;
  for (let tick = 0; tick < 20 && chips === 0; tick++) { await sleep(350); chips = await h.ev(chipCount); }
  const inChips = await h.ev(chipNames);
  const wanted = payload.map((f) => f.name);
  if (JSON.stringify(inChips) !== JSON.stringify(wanted)) {
    census.push({ case: testCase.case, requested: wanted, doc, docBytes, ready, 'picker-mismatch': inChips });
    continue;
  }
  if (testCase.description !== undefined) {
    await h.ev(`(() => {
      const el = document.getElementById('tool-field-description'); if (!el) return 'missing';
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(testCase.description)});
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(testCase.description)} }));
      return el.value;
    })()`);
  }
  const shown = await h.ev(`(() => {
    const g = [...document.querySelectorAll('[role=group]')].find((x) => /files to attach/i.test(x.getAttribute('aria-label') || ''));
    return (g?.innerText || '').replace(/\\n/g, ' | ').slice(0, 400);
  })()`);
  const readBack = await h.ev(`document.getElementById('tool-field-description')?.value ?? null`);
  if (DARK) await h.ev(`(()=>{document.documentElement.classList.add('dark');try{localStorage.setItem('browsersnip:theme','dark')}catch{};return 1})()`);
  await sleep(400);
  if (SHOTS) await h.shot(join(OUT, `${testCase.case}-${DARK ? 'dark' : 'light'}.png`));

  const before = await h.ev('window.__blobs.length');
  const clicked = await h.ev(`(() => { const b = document.querySelector('#tool-process-btn'); if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return b.innerText.trim(); })()`);
  const ran = await h.wait(`window.__blobs.length > ${before}`, 180000);
  await sleep(1200);
  const card = await h.ev(`(() => document.body.innerText.split('\n')
    .filter((l) => /Embed|carries|attach|Attach|enclosure|saved|Reader|name|file/i.test(l))
    .slice(0, 14).join(' ;; '))()`);
  const warnings = await h.ev(`(() => [...document.querySelectorAll('[data-result-warnings] li, [data-result-warnings] p, [data-result-warnings] div')]
    .map((x) => x.innerText.trim()).filter(Boolean))()`);
  const blob = await h.ev(`(async () => {
    const b = [...window.__blobs].reverse().find((x) => x && typeof x.arrayBuffer === 'function');
    if (!b) return null;
    const u = new Uint8Array(await b.arrayBuffer());
    let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
    return JSON.stringify({ type: b.type, size: u.length, b64: btoa(s) });
  })()`);
  let outPath = null;
  if (blob) {
    const info = JSON.parse(blob);
    outPath = join(OUT, `${testCase.case}.pdf`);
    writeFileSync(outPath, Buffer.from(info.b64, 'base64'));
  }
  const fileNames = await h.ev(`(() => [...document.querySelectorAll('[data-file-name], [data-output-name]')].map((x) => x.textContent.trim()))()`);
  // The whole screen after the run, as text and as a picture: the sentence, the
  // warnings and the preview pane are judged by eye, not by a filtered line.
  const fullText = await h.ev('document.body.innerText');
  writeFileSync(join(OUT, `${testCase.case}-screen.txt`), fullText);
  if (SHOTS) await h.shot(join(OUT, `${testCase.case}-result${DARK ? '-dark' : ''}.png`));
  census.push({
    case: testCase.case, doc, docBytes, ready, ran, clicked,
    requested: wanted, chips: inChips, shown,
    description: testCase.description ?? null, descriptionReadBack: readBack,
    card, warnings, fileNames, canvas: await h.ev(`(() => [...document.querySelectorAll('canvas')].map((c) => {
      const r = c.getBoundingClientRect();
      const g = c.getContext('2d');
      let ink = 0;
      try { const d = g.getImageData(0, 0, c.width, c.height).data; for (let i = 0; i < d.length; i += 4) if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) ink++; } catch {}
      return { w: Math.round(r.width), h: Math.round(r.height), ink };
    }))()`),
    out: outPath,
    outBytes: outPath ? readFileSync(outPath).length : 0,
    blobType: blob ? JSON.parse(blob).type : null,
    errors: [...new Set(h.errors)].slice(0, 6),
  });
  console.log(`${testCase.case}: ran=${ran} out=${outPath ?? 'none'} chips=${JSON.stringify(inChips)}`);
  console.log(`   card: ${card.replace(/\n/g, ' | ').slice(0, 500)}`);
}

writeFileSync(join(OUT, 'census.json'), `${JSON.stringify({ census, requests }, null, 1)}\n`);
console.log('\nrequests with bodies:', JSON.stringify(requests.filter((r) => /POST|PUT/.test(r.method)).map((r) => [r.method, r.url, r.encodedDataLength])));
console.log('off-origin:', JSON.stringify([...new Set(requests.map((r) => r.url).filter((u) => !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:')))]));
h.chrome.kill('SIGKILL');
process.exit(0);
