/**
 * Drive `font-to-outline` on a real deployment and keep only what the tab says.
 *
 *   BASE=https://www.browsersnip.com PDF=/tmp/fo-fix/type.pdf OUT=/tmp/live.pdf \
 *     node docs/research/font-outline-live.mjs
 *
 * `colour-rail.mjs` counts "a blob was made after the click" as a finished run,
 * which a Ghostscript tool defeats on purpose: the 15 MB module it fetches
 * arrives as an object URL before the PDF does, so the rail can collect
 * `gs.js` and call it a day. This probe waits on one thing only — the app's own
 * `section[aria-label="Result"]` card, or its `[role=alert]` — presses the
 * card's Download button, and takes the bytes that go through `downloadBlob`.
 *
 * Status: the deployed evidence in `font-outline-proof.log` STEP 4 came from
 * `colour-rail.mjs`, which did land 3 runs and 3 files. This probe has not yet
 * produced its own clean pass in this sandbox — an earlier run asked for a CDP
 * page target and never got one, and nothing was measured (which is a fact about
 * the probe, not about the site). Other automation was on the machine at the
 * time: ten Chromium processes from a different profile, `/tmp/hns-9614`, none of
 * them started here. The loop is bounded and loud now.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

const CHROME = process.env.CHROME ?? '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE ?? 'https://www.browsersnip.com';
const PDF = process.env.PDF;
const OUT = process.env.OUT;
const PORT = Number(process.env.PORT ?? 9831);
const WAIT_MS = Number(process.env.WAIT_MS ?? 420_000);
/** Stage lines, flushed: a probe that dies quietly teaches nothing. */
const note = (text) => process.stderr.write(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${text}\n`);
const t0 = Date.now();
if (!PDF || !OUT) throw new Error('PDF=… OUT=… are required');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/fo-live-${PORT}`, 'about:blank',
], { stdio: 'ignore' });
note(`spawned ${CHROME}`);

let ws;
for (let attempt = 0; attempt < 90 && !ws; attempt++) {
  try {
    // Bounded, because an unbounded `fetch` here is what made this probe silent:
    // a Chromium that has claimed the port but not yet answered stalls the request
    // indefinitely, and a probe that prints nothing looks like a site that does
    // nothing. A dead endpoint is a measurement, not a hang.
    const response = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(4000) });
    const list = await response.json();
    const page = list.find((target) => target.type === 'page');
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    else if (attempt % 10 === 0) note(`no page target yet (${list.length} targets)`);
  } catch (error) {
    if (attempt % 10 === 0) note(`cdp endpoint not up: ${String(error).slice(0, 80)}`);
  }
  await sleep(400);
}
if (!ws) {
  chrome.kill('SIGKILL');
  throw new Error(`no CDP page target on ${PORT} within 36 s — the rig, not the site: nothing was measured`);
}
// The handshake is bounded too: a Chromium that answers `/json/list` but never
// completes the WebSocket is exactly how this probe once ran silent for 260 s,
// and "my measurement returned nothing" must not be readable as "the site is down".
await Promise.race([
  new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }),
  new Promise((_, reject) => setTimeout(() => reject(new Error('CDP WebSocket handshake unfinished after 20 s')), 20_000)),
]).catch((error) => {
  chrome.kill('SIGKILL');
  throw new Error(`${error.message} — the rig, not the site: nothing was measured`);
});
note('attached to the page over CDP');

let nextId = 1;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (raw) => {
  const message = JSON.parse(raw.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  } else if (message.method === 'Runtime.exceptionThrown') {
    pageErrors.push((message.params.exceptionDetails?.exception?.description ?? '').slice(0, 200));
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => {
    if (pending.has(id)) {
      pending.delete(id);
      reject(new Error(`${method} #${id} unanswered`));
    }
  }, 30_000);
});
const ev = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result?.value;
};
const waitFor = async (expression, ms) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await ev(expression).catch(() => false)) return true;
    await sleep(500);
  }
  return false;
};

await send('Page.enable');
note(`chromium attached over CDP on ${PORT}`);
await send('Runtime.enable');
await send('DOM.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/font-to-outline` });
note(`navigated to ${BASE}/#/tool/font-to-outline`);
if (!(await waitFor(`!!document.querySelector('#tool-process-btn')`, 120_000)) &&
    !(await waitFor(`document.readyState==='complete'`, 20_000))) {
  throw new Error('the tool route never mounted');
}
await sleep(2500);

// The bytes that reach a Download click, kept by URL.
await ev(`(()=>{
  window.__urls=new Map(); window.__files=[];
  const make=URL.createObjectURL.bind(URL);
  URL.createObjectURL=(b)=>{const u=make(b); window.__urls.set(u,b); return u};
  const click=HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click=function(){
    if(this.download && window.__urls.has(this.href)){ window.__files.push([this.download,this.href]); return; }
    return click.apply(this,arguments);
  };
  return 1})()`);

const { root } = await send('DOM.getDocument', { depth: -1 });
const input = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
await send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [PDF] });
const stem = PDF.split('/').pop();
note('file written into the intake input');
if (!(await waitFor(`document.body.innerText.includes(${JSON.stringify(stem)})`, 30_000))) {
  throw new Error(`the app never acknowledged ${stem}`);
}
note(`the app acknowledges ${stem}`);

const answer = await ev(`(()=>{
  const b=document.querySelector('#tool-process-btn');
  if(!b||b.disabled) return 'NO BUTTON';
  b.click(); return b.innerText.trim()})()`);
note(`pressed ${JSON.stringify(answer)}`);

const verdict = await waitFor(
  `!!document.querySelector('section[aria-label="Result"], [role=alert]')`,
  WAIT_MS,
);
note(`card or alert present: ${verdict}`);
const said = JSON.parse(await ev(`JSON.stringify({
  result: document.querySelector('section[aria-label="Result"]')?.innerText ?? null,
  alert: document.querySelector('[role=alert]')?.innerText ?? null,
  engineRow: [...document.querySelectorAll('section[aria-label="Result"] dt')]
    .map((dt,i)=>[dt.innerText.trim(), dt.parentElement.querySelector('dd')?.innerText.trim()]),
})`));

let saved = null;
note(`the run answered: ${JSON.stringify(said.result ?? said.alert ?? '').slice(0, 240)}`);
if (said.result) {
  await ev(`(()=>{const b=[...document.querySelectorAll('section[aria-label="Result"] button[aria-label^="Download "]')]
    .map(x=>x).at(0) || [...document.querySelectorAll('section[aria-label="Result"] button')]
    .find(x=>/^Download/.test((x.innerText||'').trim())); if(b) b.click(); return !!b})()`);
  await waitFor('window.__files.length>0', 30_000);
  const named = JSON.parse(await ev('JSON.stringify(window.__files)'));
  if (named.length) {
    const info = JSON.parse(await ev(`(async()=>{const b=window.__urls.get(${JSON.stringify(named[0][1])});
      const u=new Uint8Array(await b.arrayBuffer()); let s='';
      for(let i=0;i<u.length;i+=8192) s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));
      return JSON.stringify({name:${JSON.stringify(named[0][0])},type:b.type,size:u.length,b64:btoa(s)})})()`));
    writeFileSync(OUT, Buffer.from(info.b64, 'base64'));
    saved = { name: info.name, type: info.type, bytes: info.size, out: OUT };
  }
}

console.log(JSON.stringify({
  base: BASE,
  clicked: answer,
  answered: verdict,
  input: stem,
  inputBytes: readFileSync(PDF).length,
  output: saved,
  card: said.result?.replace(/\s*\n\s*/g, ' | ') ?? null,
  alert: said.alert?.replace(/\s*\n\s*/g, ' | ') ?? null,
  rows: said.engineRow ?? null,
  pageErrors: [...new Set(pageErrors)].slice(0, 3),
}, null, 1));

ws.close();
chrome.kill('SIGKILL');
process.exit(0);
