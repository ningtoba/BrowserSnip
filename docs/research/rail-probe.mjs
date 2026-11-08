// Rail probe — drive one shipped tool through the real UI in real Chromium and
// write out EVERY blob it produced, with its download name, so the answer is
// measured in the bytes rather than in the report line.
//
//   TOOL=merge LABEL=Merge FILES=/tmp/probe/a.pdf,/tmp/probe/b.pdf \
//     SET=bookmarks:off node docs/research/rail-probe.mjs
//
//   TOOL   route id (/#/tool/<TOOL>)                     LABEL  action button text regex
//   FILES  comma-separated input files                    SET    comma-separated field writes
//          key=<value>      text/number/select/slider by field key (id tool-field-<key>)
//          label:<text>=on|off   a toggle/checkbox whose caption matches <text>
//          chip:<text>      a segmented option / button to click
//   TAG    filename prefix (default TOOL)
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5291';
const TOOL = process.env.TOOL;
const LABEL = process.env.LABEL || TOOL;
const FILES = (process.env.FILES || '').split(',').filter(Boolean);
const OUTDIR = process.env.OUTDIR || '/tmp/probe/out';
const TAG = process.env.TAG || TOOL;
const PORT = Number(process.env.PORT || 9821);
const RUNWAIT = Number(process.env.RUNWAIT || 240000);
if (!TOOL) throw new Error('TOOL is required');
if (!existsSync(OUTDIR)) mkdirSync(OUTDIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A previous run that died on an uncaught error leaves its Chrome holding the
// debug port; attaching to *that* page replays a stale init script, so clear it
// and make sure this one always dies with the browser.
spawn('pkill', ['-f', `probe-cd-${PORT}`], { stdio: 'ignore' });
await sleep(600);

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/probe-cd-${PORT}`, 'about:blank'], { stdio: 'ignore' });

let ws;
for (let i = 0; i < 80 && !ws; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch { /* chrome booting */ }
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
    errors.push('exc: ' + String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').slice(0, 240));
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    errors.push('log: ' + String(m.params.entry.text).slice(0, 240));
  }
};
const send = (method, params = {}) => new Promise((res, rej) => { const i = id++; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
  return r.result?.value;
};
const wait = async (expr, ms = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* not yet */ } await sleep(250); }
  return false;
};

const finish = (code) => { try { ws.close(); } catch { /* already gone */ } chrome.kill('SIGKILL'); process.exit(code); };
process.on('uncaughtException', (e) => { console.error('probe failed:', e.message); finish(1); });
process.on('unhandledRejection', (e) => { console.error('probe failed:', e && e.message); finish(1); });

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__blobs = []; window.__dl = {};
    (function () {
      const orig = URL.createObjectURL.bind(URL);
      window.__objs = [];
      URL.createObjectURL = (b) => { const u = orig(b); window.__blobs.push({ u, type: b && b.type, size: b && b.size }); window.__objs.push(b); return u; };
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download && this.href && this.href.startsWith('blob:')) window.__dl[this.href] = this.download;
        return click.apply(this, arguments);
      };
    })();`,
});
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1200, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/${TOOL}` });
if (!(await wait(`!!document.querySelector('input[type=file]')`, 90000))) throw new Error('no file input on the route');

const openPanel = () => ev(`(()=>{let n=0;for(const b of document.querySelectorAll('button[aria-expanded="false"][aria-controls]')){b.click();n++}return n})()`);

const pick = async (sel) => {
  const { root } = await send('DOM.getDocument', { depth: -1 });
  return (await send('DOM.querySelector', { nodeId: root.nodeId, selector: sel })).nodeId;
};
const inputs = await ev(`[...document.querySelectorAll('input[type=file]')].map((n,i)=>i+':'+(n.accept||'')+':'+n.multiple).join(' | ')`);
console.log('file inputs:', inputs);
const mainNodeId = await pick('input[type=file]');
if (!FILES.length) throw new Error('FILES is required');
await send('DOM.setFileInputFiles', { nodeId: mainNodeId, files: FILES });
// The options fold only exists once a document is loaded and the rail knows the
// page count, so every field write waits for this.
await wait(`(()=>{const re=new RegExp(${JSON.stringify(LABEL)},'i');return [...document.querySelectorAll('button')].some(b=>re.test(b.innerText||''))})()`, 60000);
await openPanel();
await sleep(400);

// Some rails ask for a second file on their own `file` field (merge with a
// second input, sign with an image…). Report them rather than guessing.
const extra = await ev(`[...document.querySelectorAll('input[type=file]')].length`);
if (extra > 1) console.log('note: the rail exposes', extra, 'file inputs; only the first was loaded');

if (process.env.SET) {
  for (const item of process.env.SET.split(';').map((s) => s.trim()).filter(Boolean)) {
    const eq = item.indexOf('=');
    const key = eq < 0 ? item : item.slice(0, eq);
    const val = eq < 0 ? '' : item.slice(eq + 1);
    const expr = key.startsWith('label:')
      ? `(()=>{const t=${JSON.stringify(key.slice(6))};const l=[...document.querySelectorAll('label')].find(x=>new RegExp(t,'i').test(x.innerText||''));const c=l&&l.querySelector('input[type=checkbox]');if(!c)return 'toggle not found';const want=${JSON.stringify(val)}==='on';if(c.checked!==want)c.click();return 'toggle '+t+' -> '+c.checked})()`
      : key.startsWith('ph:')
        ? `(()=>{const n=document.querySelector('input[placeholder^=${JSON.stringify(key.slice(3))}]');if(!n)return 'placeholder ${key.slice(3)} not in DOM';const set=Object.getOwnPropertyDescriptor(n.constructor.prototype,'value').set;set.call(n,${JSON.stringify(val)});n.dispatchEvent(new Event('input',{bubbles:true}));return 'pw set: '+n.value})()`
      : key.startsWith('chip:')
        ? `(()=>{const t=${JSON.stringify(key.slice(5))};const b=[...document.querySelectorAll('button')].find(x=>new RegExp(t,'i').test((x.innerText||'').trim()));if(!b)return 'chip not found';b.click();return 'chip '+t+' clicked'})()`
        : `(()=>{const n=document.getElementById('tool-field-${key}');if(!n)return 'field ${key} not in DOM';const set=Object.getOwnPropertyDescriptor(n.constructor.prototype,'value').set;set.call(n,${JSON.stringify(val)});n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));return 'set ${key} = '+n.value})()`;
    console.log('SET', item, '->', await ev(expr));
    if (!(await ev(`document.querySelector('[data-options-panel]')?.getAttribute('data-options-panel')==='open'`))) await openPanel();
  }
}

// The primary action, not a card that happens to contain the same word.
const findBtn = `(()=>{const re=new RegExp(${JSON.stringify(LABEL)},'i');const bs=[...document.querySelectorAll('button')].filter(b=>re.test(b.innerText||'')&&!b.disabled);return bs.find(b=>(b.innerText||'').trim().toLowerCase()===${JSON.stringify(LABEL.toLowerCase())})||bs[0]||null})()`;
if (!(await wait(`!!(${findBtn})`, 90000))) {
  console.log('SCREEN:', JSON.stringify((await ev(`document.body.innerText`) || '').slice(0, 2500)));
  throw new Error(`no enabled button matching ${LABEL} after loading ${FILES.join(',')}`);
}
console.log('clicked', await ev(`(()=>{const b=${findBtn};b.click();return b.innerText.trim()})()`));

if (!(await wait('window.__blobs.length>0', RUNWAIT))) {
  console.log('NO OUTPUT — the screen says:', JSON.stringify((await ev('document.body.innerText') || '').slice(0, 3000)));
  writeFileSync(`${OUTDIR}/${TAG}.screen.txt`, await ev('document.body.innerText'));
  throw new Error('the tool produced no output blob');
}
await sleep(1500);
const list = JSON.parse(await ev('JSON.stringify(window.__blobs.map((b,i)=>({i,u:b.u,type:b.type,size:b.size,name:window.__dl[b.u]||null})))'));
console.log('blobs:', JSON.stringify(list.map(({ _u, ...r }) => r)));
for (const b of list) {
  const info = JSON.parse(await ev(`(async()=>{const b=window.__objs[${b.i}];const u=new Uint8Array(await b.arrayBuffer());let s='';for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return JSON.stringify({b64:btoa(s)})})()`));
  const buf = Buffer.from(info.b64, 'base64');
  const name = `${TAG}-${String(b.i).padStart(2, '0')}-${b.name || 'blob'}`;
  writeFileSync(`${OUTDIR}/${name}`, buf);
  console.log('wrote', name, buf.length, 'bytes', `(blob said ${b.size})`);
}
const screen = await ev('document.body.innerText') || '';
writeFileSync(`${OUTDIR}/${TAG}.screen.txt`, screen);
console.log('report lines:', JSON.stringify((screen.match(/[^\n]*(page|Page|file|File|smaller|KB|MB|warning|Warning|error|blank|ink)[^\n]*/g) || []).slice(0, 14)));
console.log('console errors', JSON.stringify([...new Set(errors)].slice(0, 4)));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
