/**
 * Live proof: does a real merge on the deployed site keep the bookmarks?
 *
 * Drives the same path a person does — dashboard → Merge → two files → Merge →
 * Download — in headless Chrome over CDP, lets the browser write the download to
 * disk, and leaves the verdict to an outside reader (`pymupdf`), not to a
 * sentence the app printed about its own file.
 *
 *   node scripts/live-merge-proof.mjs [BASE]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME
  ?? '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.argv[2] ?? process.env.BASE ?? 'https://www.browsersnip.com';
const port = Number(process.env.PORT ?? 9399);
const files = (process.env.FILES ?? '').split(',').filter(Boolean);
if (files.length < 2) throw new Error('FILES=a.pdf,b.pdf is required');
const dir = mkdtempSync(join(tmpdir(), 'live-merge-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-merge-'))}`, 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const p = list.find((t) => t.type === 'page');
    if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; }
  } catch { /* chrome is still starting */ }
  await sleep(500);
}
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let nextId = 1;
const pending = new Map();
ws.onmessage = (m) => {
  let msg;
  try { msg = JSON.parse(m.data); } catch { return; }
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
};
const evv = async (expression) => {
  const r = await ev(expression);
  return r.error ? 'ERR ' + String(r.error).slice(0, 160) : String(r.value);
};
const send = (method, params = {}) =>
  new Promise((res) => { const id = nextId++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return r.result?.exceptionDetails
    ? { error: r.result.exceptionDetails.exception?.description ?? 'eval error' }
    : { value: r.result?.result?.value };
};

await send('Runtime.enable');
await send('Page.enable');
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

// `pattern` is a source string, not a RegExp object: `JSON.stringify` turns a
// RegExp into `{}`, which evaluated as an empty object and never matched anything.
// The match is the *shortest* element whose text hits the pattern, so a label and
// the panel that contains it do not both qualify, and the click lands on whatever
// is interactive nearest to it — the rail's toggles are switches, not buttons.
const clickText = (pattern, what) => ev(`(() => {
  const re = new RegExp(${JSON.stringify(pattern)}, 'i');
  const matches = [...document.querySelectorAll('button, a, input, [role], label, span, p')]
    .filter((n) => re.test((n.innerText || n.textContent || n.getAttribute('aria-label') || '').trim()))
    .sort((a, b) => (a.innerText || a.textContent || '').length - (b.innerText || b.textContent || '').length);
  if (matches.length === 0) return 'MISSING:${what}';
  const leaf = matches[0];
  const el = leaf.closest('button, a, input, [role=switch], [role=checkbox], label') || leaf;
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  if (el instanceof HTMLInputElement && el.type === 'checkbox') el.click();
  return 'clicked <' + el.tagName.toLowerCase() + '> ' + (el.innerText || el.getAttribute('aria-label') || el.type || '').trim().slice(0, 40);
})()`);

console.log(`# ${BASE}`);
await send('Page.navigate', { url: `${BASE}/#/pdf` });
await sleep(6000);
// Clearing origin storage only takes effect on a fresh document, so the queue the
// app restored from the last run is dropped by loading the page a second time.
await send('Storage.clearDataForOrigin', { origin: new URL(BASE).origin, storageTypes: 'all' });
await send('Page.navigate', { url: 'about:blank' });
await sleep(1500);
await send('Page.navigate', { url: `${BASE}/#/pdf` });
await sleep(7000);
console.log('queue at start:', await evv(`(document.body.innerText.match(/(\\d+) IN THIS JOB/)?.[0]) ?? 'empty'`));
console.log('card:', (await clickText('Merge PDF', 'merge-card')).value);
await sleep(5000);

// Hand the two fixtures to the file input the same way an OS picker would.
const doc = await send('DOM.getDocument', { depth: -1 });
const input = await send('DOM.querySelector', {
  nodeId: doc.result.root.nodeId,
  selector: 'input[type=file]',
});
if (!input.result?.nodeId) throw new Error('no file input on the merge page');
await send('DOM.setFileInputFiles', { nodeId: input.result.nodeId, files });
console.log('files in:', files.join(', '));

await sleep(20000);
console.log('queue:', await evv(`(document.body.innerText.match(/(\\d+) IN THIS JOB/)?.[0]) ?? 'unknown'`));
console.log('switch before:', await evv(`(() => { const s = [...document.querySelectorAll('[role=switch],[role=checkbox],input[type=checkbox]')]; return s.map((n,i)=>i+':'+(n.getAttribute('aria-checked') ?? n.checked)).join(' '); })()`));
console.log('toggle:', (await clickText('Add a bookmark for each file', 'bookmarks-toggle')).value);
await sleep(1000);
console.log('switch after:', await evv(`(() => { const s = [...document.querySelectorAll('[role=switch],[role=checkbox],input[type=checkbox]')]; return s.map((n,i)=>i+':'+(n.getAttribute('aria-checked') ?? n.checked)).join(' '); })()`));
console.log('run:', (await clickText('^Merge$', 'merge-action')).value);
for (let i = 0; i < 40; i++) {
  await sleep(2000);
  const ready = await ev(`(() => {
    const t = document.body.innerText;
    return /download/i.test(t) && /pages?/i.test(t) ? t.slice(0, 0) || t.match(/[^\n]*(page|bookmark|attach|download)[^\n]*/gi)?.slice(0, 8).join(' / ') : null;
  })()`);
  if (ready.value) { console.log('result card:\n  ' + String(ready.value).replace(/\n/g, '\n  ')); break; }
  if (i === 39) { console.log('no result card appeared'); console.log('BODY:', await evv('document.body.innerText.slice(-1200)')); }
}
console.log('download:', (await clickText('^(Download|Save PDF|Download PDF)', 'download')).value);
let downloaded = [];
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  downloaded = readdirSync(dir).filter((n) => n.endsWith('.pdf'));
  if (downloaded.length > 0) break;
}
console.log('downloaded:', downloaded.map((n) => join(dir, n)).join(' ') || 'NOTHING');
if (!existsSync(dir)) throw new Error('download dir vanished');
ws.close();
chrome.kill();
