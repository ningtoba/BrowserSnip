// Does the browser hand the page a non-ASCII filename at all?
//
// `zip-campaign.mjs` drops `naïve.pdf` and `rotate` does too. Before blaming the
// app, read back what the file input actually holds after CDP sets it: an empty
// `FileList` is the harness, a populated one whose name is right is the app.
//
//   BASE=http://localhost:5271 FILE='/tmp/r020/naïve.pdf' PORT=9840 node docs/research/zip-unicode-probe.mjs
import { spawn } from 'node:child_process';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const FILE = process.env.FILE;
const PORT = Number(process.env.PORT || 9840);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/uni-${PORT}-${Date.now()}`, 'about:blank'], { stdio: 'ignore' });
let ws;
for (let i = 0; i < 60 && !ws; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch { /* not up */ }
  await sleep(300);
}
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 1;
const pending = new Map();
ws.onmessage = (raw) => {
  const m = JSON.parse(raw.data);
  if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = id++; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: `${BASE}/#/tool/pdfs-to-zip` });
await sleep(4000);
const { root } = await send('DOM.getDocument', { depth: -1 });
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
const set = await send('DOM.setFileInputFiles', { nodeId, files: [FILE] }).then(() => 'ok', (e) => String(e).slice(0, 200));
await sleep(3000);
const readBack = await ev(`(()=>{const i=document.querySelector('input[type=file]');return JSON.stringify({count:i.files.length,names:[...i.files].map(f=>f.name),sizes:[...i.files].map(f=>f.size)})})()`);
console.log(JSON.stringify({ file: FILE, set, readBack }));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
