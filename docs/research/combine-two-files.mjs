// Does `combine-single-page` say anything when two files are dropped at once?
//
//   BASE=http://localhost:5271 PDF=/tmp/triage/colour.pdf PDF2=/tmp/r15/second.pdf \
//     SHOT=/tmp/r15/two-files-intake.png PORT=9827 \
//     node docs/research/combine-two-files.mjs
//
// The tool is a single-document tool by design (BentoPDF's page is "A single PDF
// file"), but its pane offers "Use another file", so a visitor can arrive with
// two. This writes both into the page's own intake input at once and reports the
// words the app printed about it — the sentence, or the silence.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5271';
const TOOL = process.env.TOOL || 'combine-single-page';
const FILES = [process.env.PDF || '/tmp/triage/colour.pdf', process.env.PDF2 || '/tmp/r15/second.pdf'];
const PORT = Number(process.env.PORT || 9827);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/rail-two-${PORT}`, 'about:blank'], { stdio: 'ignore' });
let ws;
for (let i = 0; i < 60 && !ws; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch { /* not up yet */ }
  await sleep(300);
}
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 1;
const pending = new Map();
ws.onmessage = (raw) => {
  const m = JSON.parse(raw.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = id++; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const wait = async (expr, ms = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(300); }
  return false;
};

await send('Page.navigate', { url: `${BASE}/#/tool/${TOOL}` });
if (!(await wait(`document.readyState === 'complete' && !!document.querySelector('input[type=file]')`, 90000))) {
  throw new Error('no file input on the route');
}
const { root } = await send('DOM.getDocument', { depth: -1 });
console.log('file inputs:', JSON.stringify(await ev(`[...document.querySelectorAll('input[type=file]')].map((i)=>({accept:i.accept, multiple:i.multiple, cls:i.className, inside:i.closest('[data-intake]')?.getAttribute('data-intake') ?? null}))`)));
const { nodeIds } = await send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' });
await send('DOM.setFileInputFiles', { nodeId: nodeIds[0], files: FILES });
console.log('files in input:', await ev(`document.querySelector('input[type=file]').files.length`));
await sleep(4000);
console.log('status attrs:', JSON.stringify(await ev(`(()=>{const n=document.querySelector('[data-run-status]');return n?{phase:n.getAttribute('data-run-status'),cls:n.className,text:n.innerText}:null})()`)));
console.log('cards:', JSON.stringify(await ev(`[...document.querySelectorAll('section[aria-label="Your file"] li, [data-file-card]')].map((n)=>n.innerText.trim().split('\\n')[0])`)));
console.log('notice:', JSON.stringify(await ev(`(()=>{const n=document.querySelector('[role=status]');return n?n.innerText.trim():null})()`)));
console.log('mentions the dropped name:', await ev(`document.body.innerText.includes(${JSON.stringify(FILES[1].split('/').pop())})`));
console.log('screen:', JSON.stringify((await ev(`document.body.innerText`)).slice(0, 700)));
if (process.env.NOTES) {
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find((x)=>/honest notes/i.test(x.innerText||''));if(b)b.click();return !!b})()`);
  await sleep(400);
  console.log('honest notes:', JSON.stringify(await ev(`(()=>{const b=[...document.querySelectorAll('button')].find((x)=>/honest notes/i.test(x.innerText||''));return b?b.parentElement.innerText:null})()`)));
}
if (process.env.SHOT) {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(process.env.SHOT, Buffer.from(shot.data, 'base64'));
  console.log('screenshot:', process.env.SHOT);
}
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
