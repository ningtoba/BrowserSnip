/**
 * Drive a real text tool in Chromium against a live build and keep its file.
 *
 *   BASE=https://www.browsersnip.com TOOL=header-footer \
 *     LABEL='Add header and footer' PDF=/tmp/toolfix/blank.pdf \
 *     FIELDS='{"headerLeft":"#ABZ4—ŠžΩФабв","headerRight":"漢字あアイ","fontSize":"40","rule":false}' \
 *     OUT=/tmp/toolfix/hf.pdf node docs/research/font-subset-tool.mjs
 *
 * `FIELDS` is keyed by the words the rail prints, so a control that is wired to
 * the form and not to the code shows up in the read-back.
 *
 * This is the pixel-and-reader proof for the font fix: the text is typed into
 * the rail the way a user types it, the tool's own run produces the file, and
 * `font-subset-tool.py` measures what each character painted. `rail-tool-bytes.mjs`
 * cannot do this job because it clicks with the defaults, and the characters are
 * the point here.
 *
 * Every field written is read back out of the DOM before the run and reported,
 * so a control wired to the form but not to the code shows up as a mismatch
 * rather than as a plausible-looking file.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5311';
const TOOL = process.env.TOOL || 'header-footer';
const LABEL = process.env.LABEL || 'Add header and footer';
const PDF = process.env.PDF;
const OUT = process.env.OUT || `/tmp/toolfix/${TOOL}-${new URL(BASE).hostname}.pdf`;
const FIELDS = JSON.parse(process.env.FIELDS || '{}');
const PORT = Number(process.env.PORT || 9817);
const TIMEOUT = Number(process.env.RUN_TIMEOUT || 240000);
if (!PDF) throw new Error('PDF=/path/to/fixture.pdf is required');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/font-tool-${TOOL}-${PORT}`, 'about:blank'], { stdio: 'ignore' });

let ws;
for (let i = 0; i < 60 && !ws; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch { /* chrome not up yet */ }
  if (!ws) await sleep(300);
}
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 1;
const pending = new Map();
const errors = [];
ws.onmessage = (raw) => {
  const message = JSON.parse(raw.data);
  if (message.id && pending.has(message.id)) {
    const { res, rej } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) rej(new Error(JSON.stringify(message.error)));
    else res(message.result);
  } else if (message.method === 'Runtime.exceptionThrown') {
    errors.push((message.params.exceptionDetails?.exception?.description ?? '').slice(0, 200));
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const at = id++;
  pending.set(at, { res, rej });
  ws.send(JSON.stringify({ id: at, method, params }));
  setTimeout(() => {
    if (pending.has(at)) {
      pending.delete(at);
      rej(new Error(`${method} #${at} unanswered`));
    }
  }, TIMEOUT).unref?.();
});
const ev = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
};
const wait = async (expression, ms = TIMEOUT) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    try {
      if (await ev(expression)) return true;
    } catch { /* not yet */ }
    await sleep(300);
  }
  return false;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/${TOOL}` });
if (!(await wait("!!document.querySelector('input[type=file]')", 90000))) {
  throw new Error(`${BASE}/#/tool/${TOOL} never showed a file input`);
}
await ev("(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()");

const { root } = await send('DOM.getDocument', { depth: -1 });
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
await send('DOM.setFileInputFiles', { nodeId, files: [PDF] });
if (!(await wait(`(()=>{const re=new RegExp(${JSON.stringify(LABEL)},'i');return [...document.querySelectorAll('button')].some(b=>re.test(b.innerText||'')&&!b.disabled)})()`))) {
  throw new Error(`no enabled button matching "${LABEL}" after loading ${PDF}`);
}

/**
 * Write one rail field the way a keystroke does, then read it back.
 *
 * Each key is the rail's own field key (`headerLeft`): the panel gives every
 * control the id `tool-field-<key>`, which survives the CSS-uppercased label
 * text and the collapsed "more options" group. React owns these inputs, so
 * `el.value = x` alone would be overwritten on the next render — the value goes
 * through the prototype's setter with a bubbling `input` event, which is the path
 * a real keystroke takes. The value is then read out of the DOM again, so a
 * control that is wired to the form but not to the code is caught here rather
 * than in the bytes.
 */
const findControl = (key) => `(() => {
  const want = ${JSON.stringify(String(key).toLowerCase())};
  const byId = document.getElementById('tool-field-' + ${JSON.stringify(String(key))});
  if (byId) return byId;
  for (const label of document.querySelectorAll('label')) {
    const control = label.querySelector('input, textarea, select')
      || document.getElementById(label.htmlFor || '');
    if (control && (label.innerText || '').toLowerCase().includes(want)) return control;
  }
  return [...document.querySelectorAll('input, textarea')].find((el) =>
    (el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').toLowerCase().includes(want)) || null;
})()`;

const setField = async (key, value) => {
  const before = await ev(`(()=>{const el = (${findControl(key)}); return el ? String(el.value ?? '') : '<<no control for ${key}>>'})()`);
  const after = await ev(`(()=>{
    const el = (${findControl(key)});
    if (!el) return '<<no control>>';
    if (el.type === 'checkbox') {
      const want = ${JSON.stringify(Boolean(value))};
      if (Boolean(el.checked) !== want) el.click();
      return String(el.checked);
    }
    const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return String(el.value);
  })()`);
  return { key, want: value, before, after };
};

// The rail folds its less-used controls behind "10 more options", and a probe
// that cannot reach them proves nothing about them.
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/more options/i.test(x.innerText||''));if(b)b.click();return !!b})()`);
await sleep(400);

const applied = [];
for (const [key, value] of Object.entries(FIELDS)) {
  applied.push(await setField(key, value));
}
console.log('fields:', JSON.stringify(applied, null, 1));

const clicked = await ev(`(()=>{const re=new RegExp(${JSON.stringify(LABEL)},'i');const b=[...document.querySelectorAll('button')].find(x=>re.test(x.innerText||'')&&!b_disabled(x));function b_disabled(x){return x.disabled}b.click();return b.innerText.trim()})()`);
console.log('clicked:', JSON.stringify(clicked));
if (!(await wait('window.__blobs.length>0'))) {
  console.log('NO OUTPUT — the screen says:', JSON.stringify(await ev('(document.body.innerText||"").slice(0,1500)')));
  throw new Error(`${TOOL} produced no output file`);
}
await sleep(1200);
if (process.env.SHOT) {
  mkdirSync(dirname(process.env.SHOT), { recursive: true });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(process.env.SHOT, Buffer.from(shot.data, 'base64'));
  console.log('screenshot:', process.env.SHOT);
}
const info = JSON.parse(await ev(`(async()=>{const b=window.__blobs.at(-1);const u=new Uint8Array(await b.arrayBuffer());let s='';for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return JSON.stringify({type:b.type,size:u.length,b64:btoa(s)})})()`));
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(info.b64, 'base64'));
console.log('output:', JSON.stringify({ type: info.type, bytes: info.size, file: OUT }));
console.log('report:', JSON.stringify(await ev(`(()=>{const card=document.querySelector('section[aria-label="Result"]');return card?card.innerText.slice(0,600):(document.body.innerText.match(/[^\\n]*(added|page|header|footer)[^\\n]*/gi)||[]).slice(0,6).join(' ;; ')})()`)));
console.log('console errors:', JSON.stringify([...new Set(errors)].slice(0, 4)));
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
