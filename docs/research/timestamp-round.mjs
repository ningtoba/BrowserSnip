// `timestamp-pdf` on a live build, screen half and file half, one run per case.
//
//   BASE=http://localhost:5271 PDF=/tmp/r66/signed.pdf OUT=/tmp/r66/ts.pdf \
//     SHOT=/tmp/r66/ts.png TSA=http://timestamp.digicert.com \
//     PORT=9822 node docs/research/timestamp-round.mjs
//
// The card is the only tool in the app that needs the network, and its default
// authority has to answer *this page*. So the run drives the pane the way a person
// does — drop the signed document, write the authority address, read it back out of
// the DOM, press `Add timestamp` — screenshots the pane in the state it reaches, and
// takes the produced blob off the page. `timestamp-read.py` judges the bytes.
//
// DARK=1 screenshots the same pane in dark mode; LABEL/SHOT are only about the
// screen half and never touch the file.
import { writeFileSync } from 'node:fs';
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:5271';
const PDF = process.env.PDF;
const TSA = process.env.TSA || '';
const OUT = process.env.OUT || '/tmp/r66/timestamped.pdf';
const SHOT = process.env.SHOT || '';
const FIELD = process.env.FIELD || '';
if (!PDF) throw new Error('PDF is required');

const h = await open();
const rootId = async () => (await h.send('DOM.getDocument', { depth: -1 })).root.nodeId;
await h.send('Page.navigate', { url: `${BASE}/#/tool/timestamp-pdf` });
if (!(await h.wait(`!!document.querySelector('input[type=file]')`, 60000))) throw new Error('no file input');
await h.ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
await h.ev(`(() => { const i = [...document.querySelectorAll('input[type=file]')].find((x) => !x.closest('[role=group]')); if (i) i.setAttribute('data-probe-doc','1'); return !!i; })()`);
const docField = await h.send('DOM.querySelector', { nodeId: await rootId(), selector: 'input[data-probe-doc]' });
await h.send('DOM.setFileInputFiles', { nodeId: docField.nodeId, files: [PDF] });
console.log('document in:', PDF, 'size', (await import('node:fs')).statSync(PDF).size);
await sleep(Number(process.env.SETTLE || 16000));
console.log('fold:', await h.ev(`(() => {
  const bar = [...document.querySelectorAll('[data-options-panel] button[aria-expanded="false"]')];
  if (bar.length === 0) return 'no closed disclosure';
  bar[0].click(); return 'opened';
})()`));
await sleep(700);
const write = async (id, value) => h.ev(`(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  if (!el) return 'missing #' + ${JSON.stringify(id)};
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(value)} }));
  return ${JSON.stringify(id)} + '=' + el.value;
})()`);
if (TSA) console.log('tsa   :', await write('tool-field-tsa', TSA));
if (FIELD) console.log('field :', await write('tool-field-fieldName', FIELD));
// The rail has its own theme button; emulating the media query alone leaves the
// app's stored preference in charge, so the button is pressed and the class
// change read back.
if (process.env.DARK) {
  console.log('dark  :', await h.ev(`(() => {
    const button = [...document.querySelectorAll('button')].find((b) => /^[\u2600\u263e]$/.test((b.innerText || '').trim()));
    if (!button) return 'no theme button';
    button.click();
    return document.documentElement.className || 'clicked, no class';
  })()`));
  await sleep(600);
}
console.log('card  :', await h.ev(`JSON.stringify({
  button: (document.querySelector('#tool-process-btn')?.innerText || '').trim(),
  enabled: !(document.querySelector('#tool-process-btn')?.disabled ?? true),
  what: (document.body.innerText.match(/[^\\n]{0,120}(network|authority that answers|offline)[^\\n]{0,120}/gi) || []).slice(0, 3),
})`));
// The network half, measured every run from two sides: what the page handed to
// `fetch` (exact bytes, length, whether any of the document is in there) and what
// actually left as a request. The card promises a digest and nothing else, so the
// body has to be a ~70 B `TimeStampReq` with no `%PDF` inside.
await h.ev(`(() => {
  window.__posts = [];
  const real = window.fetch.bind(window);
  window.fetch = async (url, init) => {
    const body = init && init.body;
    if (body instanceof Uint8Array) {
      window.__posts.push({
        url: String(url), method: init.method, bytes: body.length,
        head: Array.from(body.subarray(0, 12)).map((b) => b.toString(16).padStart(2, '0')).join(' '),
        startsWithPdf: body.subarray(0, 5).join() === '37,80,68,70,45',
      });
    } else if (body) {
      window.__posts.push({ url: String(url), method: init.method, bytes: body.byteLength ?? String(body).length, type: body.constructor.name });
    }
    return real(url, init);
  };
  return 1;
})()`);
const net = [];
const originalOnMessage = h.ws.onmessage;
h.ws.onmessage = (e) => {
  try {
    const m = JSON.parse(e.data);
    if (m.method === 'Fetch.requestPaused') {
      const req = m.params.request;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        net.push(`${req.method} ${req.url}${req.hasPOSTData ? ' (has a body)' : ''}`);
      }
      h.send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {});
    }
  } catch { /* not ours */ }
  originalOnMessage?.(e);
};
await h.send('Runtime.enable');
await h.send('Network.enable');
await h.send('Fetch.enable', { patterns: [{ requestStage: 'Request' }] });

const n = await h.ev('window.__blobs.length');
console.log('run:', await h.ev(`(() => { const b = document.querySelector('#tool-process-btn'); if (!b) return 'missing'; if (b.disabled) return 'disabled: ' + (b.title || ''); b.click(); return b.innerText.trim(); })()`));
const produced = await h.wait(`window.__blobs.length > ${n}`, Number(process.env.RUNWAIT || 120000));
await sleep(2000);
console.log('verdict:', produced ? 'produced a file' : 'refused, nothing produced');
console.log('result:', await h.ev(`(document.body.innerText.split('\\n').filter((l) => /timestamp|could not|refus|authority|digest|signature|no /i.test(l)).slice(0, 8).join(' ;; '))`));
if (SHOT) { await h.shot(SHOT); console.log('shot:', SHOT); }
if (produced) {
  const file = await h.ev(`(async () => {
    const b = [...window.__blobs].reverse().find((x) => x && typeof x.arrayBuffer === 'function');
    const u = new Uint8Array(await b.arrayBuffer());
    let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
    return JSON.stringify({ size: u.length, b64: btoa(s) });
  })()`);
  const info = JSON.parse(file);
  writeFileSync(OUT, Buffer.from(info.b64, 'base64'));
  console.log('wrote', OUT, info.size, 'bytes');
}
console.log('console errors', JSON.stringify([...new Set(h.errors)].slice(0, 4)));
console.log('fetch from the page:', await h.ev('JSON.stringify(window.__posts)'));
console.log('requests that left the page:', net.length === 0 ? 'none' : JSON.stringify(net));
h.chrome.kill('SIGKILL');
process.exit(produced ? 0 : 2);
