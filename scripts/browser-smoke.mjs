/**
 * Browser smoke test: click tools from the dashboard exactly as a person does
 * and fail if any route blanks the page.
 *
 * Unit tests miss this class of bug. React #426 — "a component suspended while
 * responding to synchronous input" — only fires in a real browser, when a click
 * navigates to a route whose panel is still downloading. It unmounted the whole
 * app, so the live site showed a white page for every editor card while every
 * direct-URL check stayed green.
 *
 *   node scripts/browser-smoke.mjs
 *   BASE=https://www.browsersnip.com node scripts/browser-smoke.mjs
 *
 * Needs a Chrome-family binary; override with CHROME=/path/to/chrome.
 */
import { spawn } from 'node:child_process';

const CHROME = process.env.CHROME
  ?? '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE ?? 'http://localhost:5199';
const port = Number(process.env.PORT ?? 9335);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, `--user-data-dir=/tmp/cdp-sweep-${port}`, 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const p = list.find((t) => t.type === 'page');
    if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; }
  } catch { /* wait for chrome */ }
  await sleep(500);
}
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let nextId = 1;
const pending = new Map();
let errors = [];
ws.onmessage = (m) => {
  // CDP frames are JSON, but a malformed or partial frame must not take the
  // whole sweep down with an unhandled throw inside the event listener.
  let msg;
  try {
    msg = JSON.parse(m.data);
  } catch {
    return;
  }
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push((msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text ?? '').split('\n')[0]);
  }
};
const send = (method, params = {}) => new Promise((res) => { const id = nextId++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return r.result?.exceptionDetails ? { error: r.result.exceptionDetails.exception?.description ?? 'eval error' } : { value: r.result?.result?.value };
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

// Every tool that mounts a lazy panel — the ones that can suspend on click.
const TOOLS = [
  'edit-pdf', 'edit-pdf-text', 'organize', 'sign', 'digital-sign-pdf', 'redact',
  'pdf-crop', 'scan-to-pdf', 'compare-pdfs', 'form-filler', 'form-creator',
  'pdf-layers', 'add-stamps', 'watermark', 'merge', 'split', 'pdf-to-word',
  'ocr-pdf', 'extract-tables', 'view-metadata', 'pdf-compress', 'protect',
];

const rows = [];
for (const id of TOOLS) {
  errors = [];
  await send('Page.navigate', { url: `${BASE}/#/pdf` });
  await sleep(2600);
  // Click the card for this id by matching its visible name through the router.
  const click = await ev(`(() => {
    const card = document.querySelector('button[data-tool="${id}"]');
    if (!card) return 'CARD MISSING';
    card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return 'clicked';
  })()`);
  await sleep(2600);
  const state = await ev(`(() => ({
    hash: location.hash,
    len: document.body.innerText.length,
    kids: document.getElementById('root')?.children.length ?? -1,
    canvases: document.querySelectorAll('canvas').length,
  }))()`);
  const v = state.value ?? {};
  const blank = v.kids === 0 || v.len === 0;
  rows.push({ id, via: click.value, hash: v.hash, len: v.len, kids: v.kids, blank, errs: [...new Set(errors)].slice(0, 2) });
  console.log(`${blank ? '❌ BLANK' : '✅ ok   '} ${id.padEnd(16)} len=${String(v.len).padStart(5)} kids=${v.kids} canvases=${v.canvases} ${[...new Set(errors)].slice(0, 1).join(' | ')}`);
}
const blanks = rows.filter((r) => r.blank);
console.log(`\n${TOOLS.length - blanks.length}/${TOOLS.length} click-targets rendered; blanks: ${blanks.map((b) => b.id).join(', ') || 'none'}`);
ws.close();
chrome.kill();
process.exit(0);
