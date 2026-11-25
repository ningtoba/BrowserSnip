// view-metadata / edit-metadata pane probe (chunk c3).
//
// One Chromium tab, one fixture: upload, run, then take the *rendered* property
// table out of the DOM row by row, screenshot every scroll position of the
// result pane, and keep every byte the card handed out. Report rows, not node
// counts: the campaign judges what a person reads.
//
//   BASE=http://localhost:5294 PORT=9844 TOOL=view-metadata PDF=/tmp/.../vm-rich.pdf \
//     OUTDIR=/tmp/lane-security/c3/rich node docs/research/c3-metadata-probe.mjs
//
// Env: LABEL (button words, default the tool's own name), FIELDS_JSON (raw JSON
// object of field key -> value, written the way a user's event reaches React and
// read back out of the DOM before the click), SHOT_STEPS, DARK=1, TIMEOUT.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5294';
const PORT = Number(process.env.PORT || 9844);
const TOOL = process.env.TOOL || 'view-metadata';
const PDF = process.env.PDF;
const OUTDIR = process.env.OUTDIR || `/tmp/lane-security/c3/${TOOL}`;
const LABEL = process.env.LABEL || '';
const FIELDS = process.env.FIELDS_JSON ? JSON.parse(process.env.FIELDS_JSON) : {};
const DARK = process.env.DARK === '1';
const TIMEOUT = Number(process.env.RUN_TIMEOUT || 180000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!PDF) throw new Error('PDF is required');
rmSync(OUTDIR, { recursive: true, force: true });
mkdirSync(OUTDIR, { recursive: true });
rmSync(`/tmp/c3-profile-${PORT}`, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/c3-profile-${PORT}`,
  '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars',
  '--window-size=1500,1000', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
chrome.stdout.on('data', () => {});
chrome.stderr.on('data', () => {});

let wsId = 0;
const pending = new Map();
const events = [];
const errors = [];
const net = [];
function send(method, params = {}, sessionId) {
  const id = ++wsId;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
const cmd = (method, params) => send(method, params, pageSession);

// Chrome writes its DevToolsActivePort file a beat after the process starts, and
// a WebSocket connect before it listens is an immediate ECONNREFUSED.
let browserWsUrl = '';
for (let attempt = 0; attempt < 240 && !browserWsUrl; attempt += 1) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    browserWsUrl = (await res.json()).webSocketDebuggerUrl;
  } catch {
    await sleep(250);
  }
}
if (!browserWsUrl) throw new Error('chromium never opened its debugging port');
const ws = new WebSocket(browserWsUrl);
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`${msg.method}: ${msg.error.message}`));
    else resolve(msg.result);
  } else if (msg.method) {
    events.push(msg);
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') errors.push(msg.params.entry.text);
    if (msg.method === 'Network.requestWillBeSent') {
      const r = msg.params.request;
      net.push({ url: r.url, method: r.method, hasBody: !!r.postData, bodyBytes: r.postData ? r.postData.length : 0, type: (r.headers['Content-Type'] || '').slice(0, 40) });
    }
    if (msg.method === 'Network.loadingFinished') {
      const last = net[net.length - 1];
      if (last && last.encodedDataLength === undefined) last.encodedDataLength = msg.params.encodedDataLength;
    }
  }
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId: pageSession } = await send('Target.attachToTarget', { targetId, flatten: true });
await cmd('Page.enable');
await cmd('Runtime.enable');
await cmd('Network.enable');
await cmd('Log.enable');
await cmd('DOM.enable');

const ev = async (expression) => {
  const r = await cmd('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};
const wait = async (expr, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ev(`!!(${expr})`).catch(() => false)) return true;
    await sleep(200);
  }
  return false;
};

const url = `${BASE}/?probe=c3-${basename(PDF, '.pdf')}#${TOOL === 'view-metadata' ? '/tool/view-metadata' : `/tool/${TOOL}`}`;
await cmd('Page.navigate', { url });
if (!(await wait(`document.readyState==='complete' && !!document.querySelector('input[type=file], [data-intake]')`, 120000))) {
  throw new Error('the tool surface never mounted');
}
await ev(`(()=>{
  window.__blobs=[]; window.__urls=new Map(); window.__files=[];
  const o=URL.createObjectURL.bind(URL);
  URL.createObjectURL=(b)=>{const u=o(b); window.__urls.set(u,b); window.__blobs.push(b); return u};
  const click=HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click=function(){
    if(this.download && window.__urls.has(this.href)){ window.__files.push([this.download,this.href]); return; }
    return click.apply(this,arguments);
  };
  return 1})()`);

// upload the fixture
const { root } = await cmd('DOM.getDocument', { depth: -1 });
const inputs = await cmd('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' });
let taken = false;
for (const nodeId of (inputs.nodeIds ?? []).filter((n) => n > 0)) {
  try {
    await cmd('DOM.setFileInputFiles', { nodeId, files: [PDF] });
  } catch {
    continue;
  }
  taken = await wait(`document.body.innerText.includes(${JSON.stringify(basename(PDF))})`, 15000);
  if (taken) break;
}
if (!taken) throw new Error('the app never acknowledged the upload');

// open the folded rail and write the fields a run needs
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/more option/i.test(x.innerText||''));if(b)b.click();return !!b})()`);
await sleep(400);
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const readback = [];
for (const [key, value] of Object.entries(FIELDS)) {
  const want = String(value.__label ?? key).toLowerCase();
  const rawValue = typeof value === 'object' && value !== null ? value.value : value;
  const r = await ev(`(()=>{
    const norm=(s)=>(s||'').replace(/\\s+/g,' ').trim().toLowerCase();
    const want=${JSON.stringify(want)};
    const lab=[...document.querySelectorAll('label[for]')].find((l)=>norm(l.innerText)===want);
    const byId=lab?document.getElementById(lab.getAttribute('for')):null;
    // A rail toggle is a checkbox inside its own label, with no for attribute at
    // all — addressed by the label's printed words, the way a person clicks it.
    const box=byId ?? [...document.querySelectorAll('label')]
      .filter((l)=>norm(l.innerText)===want)
      .map((l)=>l.querySelector('input[type=checkbox]'))
      .find(Boolean);
    if(box && box.type==='checkbox'){
      const on=${JSON.stringify(String(rawValue))}.toLowerCase()==='true';
      if(box.checked!==on) box.click();
      return JSON.stringify({key:${JSON.stringify(key)},kind:'toggle',readback:String(box.checked)});
    }
    const el=byId;
    if(!el) return JSON.stringify({key:${JSON.stringify(key)},kind:'NO CONTROL'});
    const set=(node,val)=>{
      const proto=node instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:(node instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype);
      const d=Object.getOwnPropertyDescriptor(proto,'value');
      d.set.call(node,val);
      node.dispatchEvent(new Event('input',{bubbles:true}));
      node.dispatchEvent(new Event('change',{bubbles:true}));
    };
    set(el,${JSON.stringify(String(rawValue))});
    return JSON.stringify({key:${JSON.stringify(key)},kind:el.tagName.toLowerCase(),readback:el.value});
  })()`);
  readback.push(JSON.parse(r));
}
await sleep(300);

// `TZ=UTC` (or any IANA zone) emulates a viewer whose clock sits elsewhere: a date
// the file stores without an offset must not change its stated wall clock when the
// person reading the properties lives in another zone.
if (process.env.TZ_OVERRIDE) {
  await cmd('Emulation.setTimezoneOverride', { timezoneId: process.env.TZ_OVERRIDE });
  await sleep(400);
}

if (DARK) {
  await ev(`(()=>{document.documentElement.classList.add('dark');try{localStorage.setItem('browsersnip:theme','dark')}catch{}return 1})()`);
  await sleep(900);
}

// the screen before the run: the card's promise and its standing notes
const beforeText = await ev(`(document.querySelector('[data-surface]')?.innerText || document.body.innerText).slice(0,9000)`);
writeFileSync(join(OUTDIR, 'screen-before.txt'), beforeText);
const shot = async (path) => {
  const s = await cmd('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path, Buffer.from(s.data, 'base64'));
  return path;
};
await shot(join(OUTDIR, 'pane-before.png'));

const blobsBefore = await ev('window.__blobs.length');
const netBefore = net.length;
const clicked = await ev(`(()=>{
  const re=${JSON.stringify(LABEL || 'read metadata|save properties|remove metadata')};
  const b=[...document.querySelectorAll('button')].find(x=>new RegExp(re,'i').test(x.innerText||'')&&!x.disabled);
  if(!b) return 'NO RUN BUTTON';
  b.click(); return b.innerText.trim();})()`);
const done = await wait(
  `!!document.querySelector('section[aria-label="Result"]') || !!document.querySelector('[role=alert]')`
  + ` || !!document.querySelector('[data-surface] div.space-y-4 > section > h3')`
  + ` || window.__blobs.length>${blobsBefore}`,
  TIMEOUT,
);
await sleep(1200);

// the rendered property table, row by row, exactly as the DOM holds it
const report = JSON.parse(await ev(`JSON.stringify((()=>{
  const card=document.querySelector('section[aria-label="Result"]');
  const scope=document.querySelector('[data-surface]')||document.body;
  const view=scope.querySelector('div.space-y-4')||scope;
  return {
    cardText: card?card.innerText:null,
    surfaceText: (scope.innerText||'').slice(0,12000),
    alert: document.querySelector('[role=alert]')?.innerText||null,
    sections: [...view.querySelectorAll(':scope > section')].map((s)=>({
      title: s.querySelector('h3')?.innerText||'',
      rows: [...s.querySelectorAll(':scope > dl > div')].map((d)=>[d.querySelector('dt')?.innerText, d.querySelector('dd')?.innerText]),
      pre: s.querySelector(':scope > pre')?.innerText||null,
    })),
    message: view.querySelector(':scope > p')?.innerText||null,
    scrollerHeight: (()=>{const c=[...document.querySelectorAll('*')].filter((e)=>e.scrollHeight>e.clientHeight+40);return c.map((e)=>[e.className.slice(0,40),e.scrollHeight,e.clientHeight])})(),
  };})())`));
writeFileSync(join(OUTDIR, 'report.json'), JSON.stringify(report, null, 1));

// Is the padding in a value actually painted? `innerText` keeps the characters;
// only a Range over the text node says where the ink starts. Measured against the
// `<dd>`'s own content box, a row whose value begins with spaces must start its
// first glyph to the right of a row that does not.
if (process.env.GEOM) {
  report.geometry = JSON.parse(await ev(`JSON.stringify((()=>{
    const view=document.querySelector('[data-surface] div.space-y-4');
    if(!view) return [];
    return [...view.querySelectorAll(':scope > section')].flatMap((s)=>[...s.querySelectorAll(':scope > dl > div')].map((d)=>{
      const dd=d.querySelector('dd');
      const node=[...(dd?.childNodes||[])].find((n)=>n.nodeType===3);
      if(!dd||!node) return null;
      const text=node.textContent||'';
      const firstNonSpace=[...text].findIndex((c)=>!/\\s/.test(c));
      const at=(i)=>{const r=document.createRange(); r.setStart(node,Math.min(i,text.length)); r.setEnd(node,Math.min(i+1,text.length)); const b=r.getBoundingClientRect(); return {left:Math.round(b.left), width:Math.round(b.width)};};
      const box=dd.getBoundingClientRect();
      return {
        section: s.querySelector('h3')?.innerText,
        label: d.querySelector('dt')?.innerText,
        value: text.slice(0,40),
        whiteSpace: getComputedStyle(dd).whiteSpace,
        ddLeft: Math.round(box.left),
        char0: firstNonSpace > 0 ? at(0) : null,
        firstGlyph: firstNonSpace >= 0 ? at(firstNonSpace) : null,
        leadingSpaces: firstNonSpace > 0 ? firstNonSpace : 0,
      };
    }).filter(Boolean));
  })())`));
  writeFileSync(join(OUTDIR, 'report.json'), JSON.stringify(report, null, 1));
}

// every scroll position of the answer, as a PNG a human looks at
const shots = [];
const scrollerInfo = await ev(`(()=>{const c=[...document.querySelectorAll('*')].filter((e)=>e.scrollHeight>e.clientHeight+40);
  if(!c.length) return JSON.stringify([]);
  return JSON.stringify(c.map((e)=>[...e.classList].join('.')).slice(0,4))})()`);
const steps = Number(process.env.SHOT_STEPS || 4);
for (let i = 0; i < steps; i += 1) {
  await ev(`(()=>{const list=[...document.querySelectorAll('*')].filter((e)=>e.scrollHeight>e.clientHeight+40);
    for(const e of list){ const max=e.scrollHeight-e.clientHeight; e.scrollTop = Math.round(max*${i / (steps - 1)}); }
    window.scrollTo(0, Math.round((document.body.scrollHeight-innerHeight)*${i / (steps - 1)}));
    return 1})()`);
  await sleep(350);
  shots.push(await shot(join(OUTDIR, `answer-${i}.png`)));
}
// press the card's own Download buttons and keep the bytes that go through them
const downloadClick = await ev(`(()=>{
  const per=[...document.querySelectorAll('section[aria-label="Result"] button[aria-label^="Download "]')];
  if(per.length){per.forEach((b)=>b.click()); return 'each:'+per.length;}
  const all=[...document.querySelectorAll('section[aria-label="Result"] button')].find((b)=>/^(Download|Download all)$/.test((b.innerText||'').trim()));
  if(all){all.click(); return 'one';}
  return 'none';})()`);
await wait(`window.__files.length >= ${downloadClick.startsWith('each:') ? downloadClick.slice(5) : 1}`, 20000);
await sleep(1500);
const named = JSON.parse(await ev('JSON.stringify(window.__files)'));
const outputs = [];
for (const [name, href] of named) {
  const info = JSON.parse(await ev(`(async()=>{var b=window.__urls.get(${JSON.stringify(href)});if(!b) return JSON.stringify({missing:true});
    var u=new Uint8Array(await b.arrayBuffer());var s='';for(var i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));
    return JSON.stringify({name:${JSON.stringify(name)},type:b.type,size:u.length,b64:btoa(s)})})()`));
  if (info.missing) continue;
  const path = join(OUTDIR, `${i0(name)}`);
  writeFileSync(path, Buffer.from(info.b64, 'base64'));
  outputs.push({ name: info.name, type: info.type, size: info.size, path });
}
function i0(name) { return name.replace(/[^A-Za-z0-9._-]/g, '_'); }

const network = net.slice(netBefore).map((r) => ({ ...r, offOrigin: !r.url.startsWith(BASE) && !/^data:|^blob:|^chrome-extension:/.test(r.url) }));
const session = net.map((r) => ({ ...r, offOrigin: !r.url.startsWith(BASE) && !/^data:|^blob:|^chrome-extension:/.test(r.url) }));
const summary = {
  tool: TOOL, fixture: PDF, clicked, done, downloadClick, readback,
  sessionRequests: session.length,
  sessionOffOrigin: session.filter((r) => r.offOrigin).map((r) => r.url.slice(0, 110)),
  sessionRemoteBodies: session.filter((r) => r.offOrigin && r.hasBody).map((r) => [r.url.slice(0, 90), r.bodyBytes]),
  sections: report.sections.map((s) => ({ title: s.title, rows: s.rows.length })),
  outputs, network: network.map((r) => ({ url: r.url, method: r.method, offOrigin: r.offOrigin, hasBody: r.hasBody, bodyBytes: r.bodyBytes })),
  remoteBodies: network.filter((r) => r.offOrigin && r.hasBody),
  errors: [...new Set(errors)].slice(0, 6),
  scrollerInfo,
  shots,
};
writeFileSync(join(OUTDIR, 'run.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
ws.close();
chrome.kill('SIGKILL');
rmSync(`/tmp/c3-profile-${PORT}`, { recursive: true, force: true });
process.exit(0);
