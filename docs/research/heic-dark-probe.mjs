// c2 probe: the stopped-file card in dark mode — real toggle, computed styles.
// PORT=9847 BASE=http://localhost:5296 node docs/research/heic-dark-probe.mjs
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5296';
const PORT = Number(process.env.PORT || 9847);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/heicdark-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = id++;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(`${method} unanswered`)); } }, 30000);
});
const ev = (expr) => send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  .then((r) => r.result?.value);

await send('Page.enable'); await send('Runtime.enable'); await send('DOM.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/heic-to-pdf` });
for (let i = 0; i < 90; i++) {
  if (await ev(`!!document.querySelector('input[type=file]')`)) break;
  await sleep(400);
}
// Use the app's own theme control: the header button whose title mentions theme/dark.
if (process.env.INJECT === 'notes') {
  const { root: r2 } = await send('DOM.getDocument', { depth: -1 });
  const { nodeId: n2 } = await send('DOM.querySelector', { nodeId: r2.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId: n2, files: ['/tmp/lane-convert/fx/real.heic'] });
  await sleep(1200);
  await ev(`(() => {
    const b = [...document.querySelectorAll('button, summary, [role=button]')].find((x) => /honest notes/i.test((x.textContent || '') + (x.getAttribute('aria-label') || '')));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(900);
  const texts = await ev(`(() => {
    const list = document.querySelector('#tool-notes-list');
    const foot = [...document.querySelectorAll('*')].filter((x) => x.children.length === 0 && /Accepts \.heic/i.test(x.textContent)).map((x) => x.textContent)[0] ?? null;
    return { footNote: foot, notes: list ? [...new Set([...list.querySelectorAll('li, p, div')].map((x) => (x.textContent ?? '').trim()).filter((t) => t.length > 20))].slice(0, 20) : null };
  })()`);
  await sleep(600);
  console.log(JSON.stringify(texts, null, 1));
  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync('/tmp/lane-convert/out/c2-notes-expanded.png', Buffer.from(shot2.data, 'base64'));
  console.log('shot: /tmp/lane-convert/out/c2-notes-expanded.png');
  ws.close(); chrome.kill('SIGKILL');
  process.exit(0);
}
const toggled = process.env.INJECT === 'pre'
  ? await ev(`(() => { document.documentElement.classList.add('dark'); try { localStorage.setItem('theme', 'dark'); } catch {} return 'injected: ' + document.documentElement.className; })()`)
  : process.env.INJECT === 'post'
    ? 'post mode: stays light until refusal'
    : await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /theme|dark|light/i.test((x.getAttribute('aria-label')||'') + (x.title||'') + (x.textContent||'')));
  if (!b) return 'no button';
  b.click();
  return document.documentElement.className + ' | storage: ' + Object.keys(localStorage).filter((k) => /theme/.test(k)).map((k) => k + '=' + localStorage.getItem(k)).join(',');
})()`);
await sleep(700);
console.log('after app toggle:', toggled);
const darkNow = await ev(`document.documentElement.classList.contains('dark') || document.documentElement.dataset.theme || null`);
console.log('dark now:', darkNow);

// Upload one real HEIC and run it, so the card reaches STOPPED in dark.
const { root } = await send('DOM.getDocument', { depth: -1 });
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
await send('DOM.setFileInputFiles', { nodeId, files: ['/tmp/lane-convert/fx/real.heic'] });
await sleep(1500);
const clicked = await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Create PDF');
  if (!b) return 'no button'; b.click(); return 1; })()`);
console.log('run clicked:', clicked);
for (let i = 0; i < 90; i++) {
  const err = await ev(`/could not be decoded/.test(document.body.innerText)`);
  if (err) break;
  await sleep(500);
}
await sleep(800);
if (process.env.INJECT === 'post') {
  await ev(`(()=>{document.documentElement.classList.add('dark');try{localStorage.setItem('theme','dark')}catch{}return 1})()`);
  await sleep(900);
}
await ev(`(() => { window.scrollTo(0, 0); return 1; })()`);
await sleep(400);
const styles = await ev(`(() => {
  const card = document.querySelector('[data-card-thumb]')?.closest('li, [class*=card], div[class*=rounded]');
  const meta = card?.querySelector('*');
  const stopped = [...document.querySelectorAll('*')].find((x) => x.children.length === 0 && /^Stopped$/i.test(x.textContent.trim()));
  const name = [...document.querySelectorAll('*')].find((x) => x.children.length === 0 && /real\\.heic/.test(x.textContent));
  const cs = (el) => el ? { bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color } : null;
  return {
    htmlClass: document.documentElement.className,
    pageBg: getComputedStyle(document.body).backgroundColor,
    card: cs(card), cardClass: card?.className?.slice(0, 200),
    stoppedLine: cs(stopped),
    nameLine: cs(name), nameText: name?.textContent?.trim().slice(0, 40),
  };
})()`);
console.log(JSON.stringify(styles, null, 1));
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('/tmp/lane-convert/out/c2-dark-appshot.png', Buffer.from(shot.data, 'base64'));
console.log('shot: /tmp/lane-convert/out/c2-dark-appshot.png');
ws.close(); chrome.kill('SIGKILL');
process.exit(0);
