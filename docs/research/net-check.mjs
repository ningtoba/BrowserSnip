// Network half of the client-side promise — drive a tool in real Chromium and
// report every request its tab made, with the bytes it put on the wire.
//
//   BASE=http://localhost:5292 TOOL=merge PORT=9842 \
//     PDFS='/tmp/triage/colour.pdf /tmp/triage/sheets.pdf' LABEL='^Merge$' \
//     OUT=/tmp/lane-organize/r/net-merge.pdf node docs/research/net-check.mjs
//
// The campaign's rule is that these tools never leave the tab. A green byte check
// cannot see a `fetch` that POSTed the document somewhere, so this probe enables
// CDP `Network`, runs the tool the same way the other probes do (upload through
// the real file input, fields written as user events, the card's own button
// clicked, the produced blob taken off `URL.createObjectURL`), and then prints
// every request whose URL is not the dev server's own origin, together with the
// upload size of each. Same-origin module/worker/font loads are listed by count
// only; anything foreign is named with the number of bytes it carried out.
//
// FIELDS is `Label=value` pairs, matched against the text of the control's own
// label (case-insensitive substring). Checkbox/radio labels are clicked when the
// DOM state differs from the wanted one; text, number and select values go in
// through the native setter plus a bubbling `input`/`change`, and are read back
// before the run.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5292';
const TOOL = process.env.TOOL;
const PDFS = (process.env.PDFS || process.env.PDF || '').split(/\s+/).filter(Boolean);
const LABEL = process.env.LABEL || '';
const OUT = process.env.OUT || '';
const SHOT = process.env.SHOT || '';
const PORT = Number(process.env.PORT || 9842);
const TIMEOUT = Number(process.env.RUN_TIMEOUT || 240000);
const DARK = process.env.DARK === '1';
const WANTED = (process.env.FIELDS || '')
  .split(/(?<=\S)\s+(?=\S+=)/)
  .filter(Boolean)
  .map((pair) => {
    const at = pair.indexOf('=');
    return [pair.slice(0, at), pair.slice(at + 1)];
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!TOOL || !PDFS.length) throw new Error('TOOL and PDFS are required');
const ORIGIN = new URL(BASE).origin;

const profile = `/tmp/net-check-${PORT}-${Date.now()}`;
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
let ws;
for (let i = 0; i < 60 && !ws; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch { /* chrome not up yet */ }
  await sleep(300);
}
if (!ws) throw new Error('chrome never came up');
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 1;
const pending = new Map();
const errors = [];
const requests = new Map();
ws.onmessage = (raw) => {
  const msg = JSON.parse(raw.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.rej(new Error(JSON.stringify(msg.error))); else p.res(msg.result);
    return;
  }
  if (msg.method === 'Network.requestWillBeSent') {
    const r = msg.params.request;
    requests.set(msg.params.requestId, {
      url: r.url, method: r.method, type: msg.params.type,
      upload: (r.hasPostData ? (r.postEntryData?.postEntries?.reduce((n, e) => n + (e.length || 0), 0) ?? r.body?.length ?? 0) : 0),
    });
  }
  if (msg.method === 'Network.loadingFinished') {
    const rec = requests.get(msg.params.requestId);
    if (rec) rec.encodedDataLength = msg.params.encodedDataLength;
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push(msg.params.entry.text.slice(0, 200));
  if (msg.method === 'Runtime.exceptionDetails') errors.push((msg.params.exceptionDetails.exception?.description || 'exception').slice(0, 200));
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = id++; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};
const wait = async (expr, ms = TIMEOUT) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await ev(`!!(${expr})`).catch(() => false)) return true;
    await sleep(200);
  }
  return false;
};
const shot = async (name) => {
  if (!name) return;
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  mkdirSync(dirname(name), { recursive: true });
  writeFileSync(name, Buffer.from(data, 'base64'));
  console.log('screenshot:', name);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable', { maxPostDataSize: 65536 });
await send('Log.enable').catch(() => {});
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/${TOOL}` });
await wait(`!!document.querySelector('input[type=file]')`);
if (DARK) {
  await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/dark/i.test(x.getAttribute('aria-label')||'')||x.innerText.trim()==='☾');if(b)b.click();return 1})()`);
  await sleep(400);
}
await ev(`(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`);
const { root } = await send('DOM.getDocument', { depth: -1 });
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
await send('DOM.setFileInputFiles', { nodeId, files: PDFS });
await wait(`document.querySelectorAll('button').length > 3`, 60000);
await sleep(2500);

const readback = [];
for (const [key, want] of WANTED) {
  const r = await ev(`(()=>{
    const norm=(s)=>(s||'').replace(/\\s+/g,' ').trim().toLowerCase();
    const want=${JSON.stringify(want.toLowerCase())}, key=norm(${JSON.stringify(key)});
    const lab=[...document.querySelectorAll('label')].find((l)=>norm(l.innerText).includes(key));
    if(!lab) return 'no label';
    const box=lab.querySelector('input[type=checkbox],input[type=radio]');
    if(box){const on=box.checked||(box.type==='radio'&&box.checked);const wantOn=['true','on','yes','1'].includes(want);
      if(on!==wantOn) box.click();
      return String((lab.querySelector('input[type=checkbox],input[type=radio]')||{}).checked);}
    const inp=lab.querySelector('input,select,textarea');
    if(!inp) return 'no control';
    const proto=inp.tagName==='SELECT'?HTMLSelectElement.prototype:(inp.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype);
    Object.getOwnPropertyDescriptor(proto,'value').set.call(inp,${JSON.stringify(want)});
    inp.dispatchEvent(new Event('input',{bubbles:true}));inp.dispatchEvent(new Event('change',{bubbles:true}));
    let after=inp.value;
    const opt=after===${JSON.stringify(want)}?'':[...inp.options||[]].find((o)=>norm(o.text)===want)?.value;
    if(opt){Object.getOwnPropertyDescriptor(proto,'value').set.call(inp,opt);inp.dispatchEvent(new Event('change',{bubbles:true}));after=inp.value;}
    return after;
  })()`).catch((e) => `throw ${e.message}`);
  readback.push(`${key}=${want} -> ${r}`);
}
console.log('readback:', JSON.stringify(readback));

const before = await ev('window.__blobs.length');
const clicked = await ev(`(()=>{const re=new RegExp(${JSON.stringify(LABEL)});const b=[...document.querySelectorAll('button')].find(x=>re.test((x.innerText||'').replace(/\\s+/g,' ').trim()));if(!b)return null;b.click();return (b.innerText||'').trim()})()`);
console.log('run button:', JSON.stringify(clicked));
const got = await wait(`window.__blobs.length > ${before}`, TIMEOUT);
await sleep(600);
const screen = await ev(`(()=>{const m=document.querySelector('main')||document.body;return m.innerText.slice(-900)})()`);
console.log('finished:', got);
console.log('tail of surface:', JSON.stringify(screen.slice(-500)));
await shot(SHOT);
if (OUT) {
  const at = await ev(`(()=>{const a=window.__blobs.slice(${before});if(!a.length)return -1;let k=0;for(let i=1;i<a.length;i++)if(a[i].size>a[k].size)k=i;return ${before}+k})()`);
  if (at >= 0) {
    const b64 = await ev(`(async()=>{var b=window.__blobs[${at}];var u=new Uint8Array(await b.arrayBuffer());var s='';for(var i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return btoa(s)})()`);
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, Buffer.from(b64, 'base64'));
    console.log('saved', OUT, Buffer.from(b64, 'base64').length, 'bytes');
  } else console.log('saved: no blob produced');
}

const all = [...requests.values()];
const foreign = all.filter((r) => { try { return new URL(r.url).origin !== ORIGIN; } catch { return false; } });
const byOrigin = {};
for (const r of foreign) {
  const o = new URL(r.url).origin;
  byOrigin[o] = byOrigin[o] || { count: 0, uploaded: 0, downloaded: 0, sample: [] };
  byOrigin[o].count += 1;
  byOrigin[o].uploaded += r.upload || 0;
  byOrigin[o].downloaded += r.encodedDataLength || 0;
  if (byOrigin[o].sample.length < 6) byOrigin[o].sample.push(`${r.method} ${r.url.slice(0, 130)} up=${r.upload || 0}`);
}
console.log(JSON.stringify({
  sameOriginRequests: all.length - foreign.length,
  foreignOrigins: byOrigin,
  biggestForeignUpload: foreign.reduce((n, r) => Math.max(n, r.upload || 0), 0),
  consoleErrors: [...new Set(errors)].slice(0, 6),
}, null, 1));
ws.close();
chrome.kill('SIGKILL');
await sleep(300);
spawn('rm', ['-rf', profile], { stdio: 'ignore' });
process.exit(0);
