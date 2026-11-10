/**
 * Screenshot harness for `password-anywhere`: the file row, in both themes.
 *
 * The row that carries an encrypted file's verdict and its one password box is new
 * chrome on every tool page, so "dark mode did not regress" has to be *seen*, not
 * asserted — its colours come from `html.dark`-aware tokens, which is exactly the
 * thing a jsdom test cannot judge.
 *
 * It serves the built `dist/` over a plain HTTP server (no vite, nothing that can
 * stall a foreground shell), drives the real app with CDP, hands a locked fixture to
 * the real file input, and photographs the row in four states:
 *
 *   password-anywhere-light-locked.png   AES-128 user-locked, nothing typed yet
 *   password-anywhere-light-opened.png   the same card, secret accepted
 *   password-anywhere-dark-locked.png    …and both again under `html.dark`
 *   password-anywhere-dark-opened.png
 *
 * The theme is changed with the shell's own toggle button, then the page is reloaded
 * so the app boots into that preference the way it does for a person who set it
 * yesterday. The row is waited for by its own `data-file-lock` value, and the words
 * it prints go to stdout beside the file they were taken from, so the picture and
 * the log cannot disagree.
 *
 *   npx vite build && node scripts/copy-pdfjs-assets.mjs
 *   node docs/research/password-anywhere-shots.mjs [OUT_DIR]
 *
 * Env: `CHROME` (a Chrome-family binary), `PORT`, `FIXTURE`.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFile } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const PORT = Number(process.env.PORT ?? 4181);
const DIST = join(process.cwd(), 'dist');
const FIXTURE = process.env.FIXTURE ?? join(process.cwd(), 'tests/fixtures/encrypted/aes-128-user.pdf');
const OUT = process.argv[2] ?? join(process.cwd(), 'docs/research/shots');
const PASSWORD = 'hunter2';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!existsSync(CHROME)) {
  console.log(`no chrome at ${CHROME}`);
  process.exit(1);
}
if (!existsSync(join(DIST, 'index.html'))) {
  console.log('no built app in dist/ — run `npx vite build` first');
  process.exit(1);
}
if (!existsSync(FIXTURE)) {
  console.log(`no fixture at ${FIXTURE}`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.pdf': 'application/pdf',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
  '.map': 'application/json',
};

const server = createServer((req, res) => {
  const clean = decodeURIComponent((req.url ?? '/').split('?')[0].split('#')[0]);
  const wanted = join(DIST, clean === '/' ? 'index.html' : clean);
  if (!wanted.startsWith(DIST) || !existsSync(wanted)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[wanted.slice(wanted.lastIndexOf('.'))] ?? 'application/octet-stream' });
  res.end(readFileSync(wanted));
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT + 1}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-pwshots-'))}`,
  '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });

let ws;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT + 1}/json/list`)).json();
    const page = list.find((tab) => tab.type === 'page');
    if (page) {
      ws = new WebSocket(page.webSocketDebuggerUrl);
      break;
    }
  } catch { /* chrome is still starting */ }
  await sleep(400);
}
if (!ws) {
  console.log('chrome never answered');
  process.exit(1);
}
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let nextId = 1;
const pending = new Map();
ws.onmessage = (message) => {
  let msg;
  try { msg = JSON.parse(message.data); } catch { return; }
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) =>
  new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const raw = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return result.result?.exceptionDetails
    ? { error: result.result.exceptionDetails.exception?.description ?? 'eval error' }
    : { value: result.result?.result?.value };
};
const said = async (expression) => {
  const result = await raw(expression);
  return result.error ? `ERR ${String(result.error).slice(0, 160)}` : String(result.value);
};
/** Wait for an in-page predicate, and say what the page ended up showing. */
async function until(predicate, label, attempts = 25) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if ((await said(`Boolean(${predicate})`)) === 'true') return true;
    await sleep(400);
  }
  console.log(`  no ${label}; card: ${await said("(document.querySelector('[data-card=\"0\"]')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 180)")}`);
  return false;
}

await send('Page.enable');
await send('DOM.enable');
await send('Runtime.enable');
await send('Log.enable');

// Everything the page complains about, printed unconditionally at the end: a row
// that never arrives has a reason, and in a headless harness the only way to hear it
// is to listen.
const complaints = [];
ws.addEventListener('message', (message) => {
  try {
    const msg = JSON.parse(String(message.data));
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      complaints.push(`${msg.params.entry.source}: ${msg.params.entry.text}`.slice(0, 220));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      complaints.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`.slice(0, 220));
    }
  } catch { /* a notification this harness does not model */ }
});

/**
 * The rotate page, holding a locked file.
 *
 * Reached from a blank tab rather than by changing the hash: the app reads each
 * `(file, secret)` pair once, and a same-document navigation leaves the page mounted
 * with the file it had already read, so a harness that only moved the hash would
 * photograph a page that never re-read anything.
 */
async function openLockedFile() {
  const url = `http://127.0.0.1:${PORT}/index.html#/tool/rotate`;
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(800);
  await send('Page.navigate', { url });
  await sleep(6000);
  for (let attempt = 0; attempt < 25; attempt++) {
    const probe = await send('DOM.getDocument');
    const found = await send('DOM.querySelector', { nodeId: probe.result.root.nodeId, selector: 'input[type=file]' });
    if (found.result?.nodeId) {
      await send('DOM.setFileInputFiles', { nodeId: found.result.nodeId, files: [FIXTURE] });
      break;
    }
    await sleep(400);
  }
  const box = await until("document.querySelector('[data-file-password]')", 'password box');
  if (!box) {
    console.log(`  rows: ${await said("[...document.querySelectorAll('[data-file-lock]')].map((r) => r.getAttribute('data-file-lock')).join(',') || 'none'")}`);
    console.log(`  crypto.subtle: ${await said('Boolean(window.crypto && window.crypto.subtle)')}`);
  }
  return box;
}

/**
 * Put the page in the wanted theme with the shell's own button.
 *
 * The toggle is the control whose consequence is being photographed, so the harness
 * clicks it rather than writing `html.dark` itself — a page styled by the test is a
 * state no user reaches.
 */
async function setTheme(mode) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const dark = (await said("document.documentElement.classList.contains('dark')")) === 'true';
    if (dark === (mode === 'dark')) return true;
    await raw(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((el) => /^Switch to (dark|light) mode$/.test(el.getAttribute('aria-label') || ''));
      if (!button) return 'no toggle';
      button.click();
      return 'clicked ' + button.getAttribute('aria-label');
    })()`);
    await sleep(400);
  }
  return (await said("document.documentElement.classList.contains('dark')")) === String(mode === 'dark');
}

/**
 * Type into the box the way a person does.
 *
 * A React-controlled input ignores a bare `.value =`, so the value goes in through
 * the native setter with the `input` event the framework listens for; anything less
 * would photograph a state the app never reached.
 */
const typeSecret = (value) => raw(`(() => {
  const field = document.querySelector('input[data-file-password]');
  if (!field) return 'no field';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(field, ${JSON.stringify(value)});
  field.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed ' + field.value.length + ' chars';
})()`);

const rowText = () => said("(document.querySelector('[data-file-lock]')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 260)");
const themeOf = () => said("document.documentElement.classList.contains('dark') ? 'dark' : 'light'");

async function shoot(name) {
  const png = await send('Page.captureScreenshot', { format: 'png' });
  const data = png.result?.data;
  if (!data) {
    console.log(`  ${name}: no pixels`);
    return;
  }
  const path = join(OUT, name);
  await new Promise((resolve) => writeFile(path, Buffer.from(data, 'base64'), resolve));
  console.log(`  wrote ${path} (${Buffer.from(data, 'base64').length} bytes)`);
}

for (const mode of ['light', 'dark']) {
  console.log(`\n${mode}: loading a locked file into the rotate page`);
  if (!(await openLockedFile())) continue;
  if (!(await setTheme(mode))) console.log(`  theme did not become ${mode}`);
  console.log(`  theme ${await themeOf()}, row ${await said("document.querySelector('[data-file-lock]')?.getAttribute('data-file-lock')")}`);
  console.log(`  says: ${await rowText()}`);
  await shoot(`password-anywhere-${mode}-locked.png`);
  console.log(`  typing: ${JSON.stringify(await typeSecret(PASSWORD))}`);
  const accepted = await until("document.querySelector('[data-file-lock=\"opened\"]')", 'accepted verdict');
  console.log(`  says after typing: ${await rowText()} (accepted: ${accepted})`);
  await shoot(`password-anywhere-${mode}-opened.png`);
}

chrome.kill();
server.close();
console.log(`\npage complaints (${complaints.length}):`);
for (const line of complaints.slice(0, 12)) console.log(`  ${line}`);
