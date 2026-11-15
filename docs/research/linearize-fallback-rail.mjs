// Drive one run with the qpdf CDN address made unreachable, so the tool's own
// rebuild path is what produces the file. Also takes a dark-mode screenshot.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const PORT = Number(process.env.PORT || 9827);
const PDF = process.env.PDF;
const OUT = process.env.OUT;
const SHOT = process.env.SHOT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--host-resolver-rules=MAP cdn.jsdelivr.net 127.0.0.1:1', `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/fb-${PORT}`, 'about:blank'], { stdio: 'ignore' });
let ws;
for (let i = 0; i < 60 && !ws; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find((t) => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; } } catch {}
  await sleep(300);
}
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 1; const pend = new Map();
ws.onmessage = (raw) => { const m = JSON.parse(raw.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const i = id++; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
await send('Page.enable'); await send('Runtime.enable');
await send('Page.navigate', { url: 'http://localhost:5271/' });
await sleep(1500);
await ev(`localStorage.setItem('browsersnip:wasm-engines', JSON.stringify({ qpdf: 'https://cdn.jsdelivr.net/npm/qpdf-wasm@0.0.1/' }))`);
await send('Page.navigate', { url: 'http://localhost:5271/#/tool/linearize-pdf' });
await sleep(2500);
await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};document.documentElement.classList.add('dark');try{localStorage.setItem('browsersnip:theme','dark')}catch{};return 1})()`);
const { root } = await send('DOM.getDocument', { depth: -1 });
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
await send('DOM.setFileInputFiles', { nodeId, files: [PDF] });
for (let i = 0; i < 60; i++) { await sleep(300); if (await ev(`[...document.querySelectorAll('button')].some(b=>/^Linearize$/.test(b.innerText.trim())&&!b.disabled)`)) break; }
await ev(`[...document.querySelectorAll('button')].find(b=>/^Linearize$/.test(b.innerText.trim())&&!b.disabled).click()`);
for (let i = 0; i < 200; i++) { await sleep(300); if (await ev('window.__blobs.length>0')) break; }
await sleep(1500);
const info = JSON.parse(await ev(`(async()=>{const b=window.__blobs.at(-1);const u=new Uint8Array(await b.arrayBuffer());let s='';for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return JSON.stringify({size:u.length,b64:btoa(s)})})()`));
writeFileSync(OUT, Buffer.from(info.b64, 'base64'));
if (SHOT) { const shot = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(SHOT, Buffer.from(shot.data, 'base64')); }
console.log('screen:', await ev(`(document.body.innerText||'').slice(0,900)`));
console.log('output', OUT, info.size);
ws.close(); chrome.kill('SIGKILL'); process.exit(0);
