// Lane probe: watch the tab's network while an image route runs, so a tool that
// ships file bytes off-machine is caught (user mandate: strictly client-side).
//   PORT=9846 BASE=http://localhost:5296 node docs/research/convert-lane-net.mjs
// Each run opens the tool, uploads real bytes, writes the named fields, clicks the
// rail's own button, and records every request the tab made during the run that is
// NOT same-origin. The page itself is loaded before the capture window starts, so
// ordinary dev-server assets do not drown the answer.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5296';
const PORT = Number(process.env.PORT || 9846);
const TIMEOUT = Number(process.env.RUN_TIMEOUT || 180000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RUNS = JSON.parse(process.env.RUNS || '[]');
if (!RUNS.length) throw new Error('RUNS=[{tool,files,fields,label}] is required');

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/net-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
const requests = [];
ws.onmessage = (raw) => {
  const m = JSON.parse(raw.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) rej(new Error(JSON.stringify(m.error)));
    else res(m.result);
  } else if (m.method === 'Network.requestWillBeSent') {
    if (!capturing) return;
    const u = new URL(m.params.request.url);
    requests.push({
      method: m.params.request.method,
      host: u.host,
      path: (u.pathname + u.search).slice(0, 90),
      bytes: m.params.request.postData?.length ?? m.params.request.hasPostData ? 1 : 0,
      type: m.params.type,
    });
  }
};
let capturing = false;
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = id++;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(`${method} unanswered`)); } }, 30000);
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
const wait = async (expr, ms = TIMEOUT) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(200); }
  return false;
};
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');

const report = [];
for (const run of RUNS) {
  await send('Page.navigate', { url: `${BASE}/?net=1#/tool/${run.tool}` });
  await wait(`document.readyState==='complete' && !!document.querySelector('#tool-process-btn, input[type=file]')`, 60000);
  const { root } = await send('DOM.getDocument', { depth: -1 });
  const inputs = await send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' });
  let taken = false;
  for (const nodeId of (inputs.nodeIds ?? []).filter((n) => n > 0)) {
    try { await send('DOM.setFileInputFiles', { nodeId, files: run.files }); } catch { continue; }
    taken = await wait(`document.body.innerText.includes(${JSON.stringify(run.files[0].split('/').pop())})`, 10000);
    if (taken) break;
  }
  const rec = { tool: run.tool, tag: run.tag ?? 'base', uploaded: taken, remote: [], sameOrigin: 0, result: null };
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/more option/i.test(x.innerText||''));if(b)b.click();return 1})()`);
  for (const [label, value] of Object.entries(run.fields ?? {})) {
    await ev(`(()=>{const want=${JSON.stringify(label.toLowerCase())};
      const norm=(s)=>(s||'').replace(/\\s+/g,' ').trim().toLowerCase();
      const lab=[...document.querySelectorAll('label[for]')].find((l)=>norm(l.innerText)===want);
      const el=lab?document.getElementById(lab.getAttribute('for')):null; if(!el) return 0;
      if(el.tagName==='SELECT'){const s=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
        const o=[...el.options].find((x)=>x.value.toLowerCase()===${JSON.stringify(String(value).toLowerCase())})||[...el.options].find((x)=>(x.text||'').toLowerCase().includes(${JSON.stringify(String(value).toLowerCase())}));
        if(!o) return 0; s.call(el,o.value); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return 1;}
      const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      set.call(el,${JSON.stringify(String(value))}); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return 1})()`);
    await sleep(150);
  }
  requests.length = 0;
  capturing = true;
  await ev(`(()=>{const b=document.querySelector('#tool-process-btn');if(b&&!b.disabled)b.click();return 1})()`);
  await wait(`!!document.querySelector('section[aria-label="Result"]') || !!document.querySelector('[role=alert]')`, TIMEOUT);
  await sleep(1200);
  capturing = false;
  for (const r of requests) {
    if (/^localhost:/.test(r.host)) rec.sameOrigin += 1;
    else rec.remote.push(`${r.method} ${r.host}${r.path}${r.bytes ? ` [POST body ~${r.bytes}B]` : ''}`);
  }
  rec.result = await ev(`(()=>{const c=document.querySelector('section[aria-label="Result"]')||document.querySelector('[role=alert]');return c?c.innerText.slice(0,500):null})()`);
  report.push(rec);
  console.log(`${rec.tool}/${rec.tag}: uploaded=${rec.uploaded} same-origin=${rec.sameOrigin} remote=${JSON.stringify([...new Set(rec.remote)])}`);
  console.log(`  card: ${JSON.stringify((rec.result ?? '').slice(0, 220))}`);
}
writeFileSync('/tmp/lane-convert/net.json', JSON.stringify(report, null, 1));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
