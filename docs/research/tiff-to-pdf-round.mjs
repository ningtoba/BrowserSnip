// round 073 probe — tiff-to-pdf. Upload TIFFs, read the whole card back off the
// screen, capture every produced blob, screenshot the result.
//
//   CASES=frames,cmyk,fax,cut,fake PORT=9821 node docs/research/tiff-to-pdf-round.mjs
//
// Adapted from docs/research/webp-to-pdf-round.mjs (same blob wrapper, same
// `document.body.innerText` read-back, same screenshot route). Every fixture is
// built by docs/research/tiff-to-pdf-fixtures.py so the same bytes can be handed
// to Pillow as the oracle.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const TOOL = process.env.TOOL || 'tiff-to-pdf';
const PORT = Number(process.env.PORT || 9821);
const DIR = process.env.DIR || '/tmp/r73';
const TAG = process.env.TAG || 'before';
const CASES = (process.env.CASES || '').split(',').filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CASES_SPEC = {
  // one page per frame, in frame order, each page that frame's pixels
  frames: { files: [`${DIR}/frames.tif`], out: `${DIR}/${TAG}-frames.pdf`, shot: `${DIR}/${TAG}-frames-card.png` },
  // the corpus fixture is itself a two-frame TIFF
  corpus: { files: ['/tmp/triage/in/photo.tif'], out: `${DIR}/${TAG}-corpus.pdf`, shot: `${DIR}/${TAG}-corpus-card.png` },
  // CMYK quadrants (cyan, magenta, yellow, black) must be converted, not read as RGB
  cmyk: { files: [`${DIR}/cmyk.tif`], out: `${DIR}/${TAG}-cmyk.pdf`, shot: `${DIR}/${TAG}-cmyk-card.png` },
  // the same question in mid-tones, where a wrong formula still reads plausible
  cmykmid: { files: [`${DIR}/cmykmid.tif`], out: `${DIR}/${TAG}-cmykmid.pdf`, shot: `${DIR}/${TAG}-cmykmid-card.png` },
  // 64 bytes appended to a complete file: a reader may ignore trailing data
  pad: { files: [`${DIR}/padded.tif`], out: `${DIR}/${TAG}-pad.pdf`, shot: `${DIR}/${TAG}-pad-card.png` },
  // big-endian header, and a 1-bit Group 4 fax
  fax: { files: [`${DIR}/fax4.tif`, `${DIR}/bigendian.tif`], out: `${DIR}/${TAG}-fax.pdf`, shot: `${DIR}/${TAG}-fax-card.png` },
  // a file cut at 40 % of its bytes, beside the complete one
  cut: { files: [`${DIR}/cut.tif`, `${DIR}/full.tif`], out: `${DIR}/${TAG}-cut.pdf`, shot: `${DIR}/${TAG}-cut-card.png` },
  // PNG and JPEG bytes under a .tif name, beside a real TIFF
  fake: { files: [`${DIR}/png-in.tif`, `${DIR}/jpg-in.tif`, `${DIR}/single.tif`], out: `${DIR}/${TAG}-fake.pdf`, shot: `${DIR}/${TAG}-fake-card.png` },
};

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/r73-profile-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
const send = (method, params = {}) => new Promise((res, rej) => { const i = id++; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const wait = async (expr, ms = 180000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(300); }
  return false;
};
const shoot = async (path) => {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path, Buffer.from(shot.data, 'base64'));
  console.log('screenshot:', path);
};
const expandNotes = async () => {
  await ev(`(()=>{const d=[...document.querySelectorAll('button')].find(x=>/^honest notes/i.test(x.innerText||''));if(d)d.click();return 1})()`);
  await sleep(400);
};
const card = async () => JSON.stringify((await ev(`(document.body.innerText||'')`)).slice(0, 4000));

/** One upload-and-press on the current page. Returns after the card settles. */
const drive = async (spec, label) => {
  // Navigating to the same hash route does not remount the job, so a previous
  // run's files would still be in the input and every page count would be a
  // running total. "Do another" empties it first.
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^Do another$/i.test((x.innerText||'').trim()));if(b)b.click();return 1})()`);
  await sleep(700);
  await wait(`!!document.querySelector('input[type=file]')`, 60000);
  await sleep(700);
  console.log(`${label} card before:`, await card());
  await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
  const { root } = await send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId, files: spec.files });
  // The notes panel only exists once the job holds a file.
  if (await wait(`[...document.querySelectorAll('button')].some(x=>/^honest notes/i.test(x.innerText||''))`, 20000)) {
    await sleep(500);
    await expandNotes();
    console.log(`${label} notes:`, JSON.stringify((await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^honest notes/i.test(x.innerText||''));return b?b.parentElement.innerText:''})()`)).slice(0, 3000)));
    await expandNotes();
  }
  const ok = await wait(`(()=>{const re=/Create PDF/i;return [...document.querySelectorAll('button')].some(b=>re.test(b.innerText||'')&&!b.disabled)})()`, 90000);
  if (ok) {
    await ev(`(()=>{const re=/Create PDF/i;const b=[...document.querySelectorAll('button')].find(x=>re.test(x.innerText||'')&&!x.disabled);b.click();return 1})()`);
    await wait('window.__blobs.length>0 || /could not|not a TIFF|Nothing|left out|no readable/i.test(document.body.innerText||"")', 120000);
    await sleep(2500);
    await expandNotes();
    if (process.env.DARK) {
      await ev(`(()=>{localStorage.setItem('browsersnip.theme','dark');document.documentElement.dataset.theme='dark';document.documentElement.classList.add('dark');return 1})()`);
      await sleep(600);
    }
    if (spec.shot) await shoot(spec.shot);
    console.log(`${label} after:`, await card());
    if (spec.out && await ev('window.__blobs.length>0')) {
      const info = JSON.parse(await ev(`(async()=>{var b=window.__blobs.at(-1);var u=new Uint8Array(await b.arrayBuffer());var s='';for(var i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return JSON.stringify({type:b.type,size:u.length,b64:btoa(s)})})()`));
      writeFileSync(spec.out, Buffer.from(info.b64, 'base64'));
      console.log('output', JSON.stringify({ type: info.type, bytes: info.size, file: spec.out }));
    } else {
      console.log('NO OUTPUT');
    }
  } else {
    console.log(`${label} button never enabled; screen:`, await card());
    await expandNotes();
    if (spec.shot) await shoot(spec.shot);
  }
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false });
for (const name of CASES) {
  const spec = CASES_SPEC[name];
  if (!spec) { console.log('unknown case', name); continue; }
  await send('Page.navigate', { url: `${BASE}/#/tool/${spec.tool ?? TOOL}` });
  await drive(spec, name);
}
console.log('console errors', JSON.stringify([...new Set(errors)].slice(0, 5)));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
