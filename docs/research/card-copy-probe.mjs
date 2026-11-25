#!/usr/bin/env node
// duplex-collate card-copy probe: read the card the way a user does — the promise
// under the title, every control's help line, and the honest-notes panel EXPANDED —
// and shoot that surface. Copy claims are judged off this text and these pixels;
// the bytes are judged by duplex-round-bytes.py. One shot per run: `DARK=1` takes
// the dark-mode one.
//
//   BASE=http://localhost:5292 TOOL=duplex-collate PDF=/tmp/triage/colour.pdf \
//     PORT=9842 SHOT=/tmp/r/duplex-card-light.png node docs/research/card-copy-probe.mjs
//   ... DARK=1 SHOT=/tmp/r/duplex-card-dark.png ...   # the one dark shot a UI round owes
//
// Prints JSON: { title, subtitle, fields: [[label, help]], notes: [..], receipt }.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
// Node's built-in `WebSocket` global, the same one `colour-rail.mjs` drives with —
// `ws` is not a dependency of this workspace.

const CHROME = process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'http://localhost:5292';
const TOOL = process.env.TOOL || 'duplex-collate';
const PDF = process.env.PDF || '/tmp/triage/colour.pdf';
const PORT = Number(process.env.PORT || 9842);
const SHOT = process.env.SHOT || '';
const DARK = process.env.DARK || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/cardcopy-${TOOL}-${PORT}`, 'about:blank'], { stdio: 'ignore' });
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
    if (m.error) rej(new Error(JSON.stringify(m.error)));
    else res(m.result);
  }
};
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
const wait = async (expr, ms = 90000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await ev(expr)) return true; } catch { /* later */ } await sleep(200); }
  return false;
};
const shoot = async (path) => {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path, Buffer.from(shot.data, 'base64'));
  console.log('screenshot:', path);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1400, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/#/tool/${TOOL}` });
if (!(await wait(`document.readyState === 'complete' && !!document.querySelector('input[type=file]')`, 90000))) {
  throw new Error('no file input on the route');
}
{
  const { root } = await send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId, files: [PDF] });
}
await wait(`(()=>/READY/i.test(document.body.innerText||'')})()`, 90000);

// The theme flip goes BEFORE the panels are opened, the way `colour-rail.mjs` does
// it: flipping it after the paint came back with the whole rail area still holding the
// previous frame's blank paper (measured twice on 2026-11-25), which is the tiling the
// round-052 note in that driver describes. One shot per run, `DARK=1` takes the other.
if (DARK) {
  await ev(`(()=>{document.documentElement.classList.add('dark');try{localStorage.setItem('browsersnip:theme','dark')}catch{}return 1})()`);
  await sleep(900);
}
// Close whatever the ⌘K trigger may have opened, then expand ONLY the panels that
// hold the copy under audit: the rail's collapsed option groups and the honest-notes
// list. Clicking every collapsed button opened the command palette first, and the
// screenshots came back with the card behind the palette's blur (measured, 2026-11-25).
await ev(`(()=>{document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));for(const b of document.querySelectorAll('button')){const t=(b.innerText||'').toLowerCase();const e=(b.getAttribute('aria-expanded')||'').toLowerCase();if(e==='false'&&(/honest notes/.test(t)||/more option/.test(t)||/option/.test(t))) b.click()}return 1})()`);
await sleep(400);

const card = await ev(`(()=>{
  // The double backslash is deliberate: this is a template literal, so a bare
  // backslash-s arrives as plain "s" and the regex then eats every "s" in the card
  // (measured: "The collation i  a reordering and nothing el e").
  const norm=(s)=>String(s ?? '').replace(/\\s+/g,' ').trim();
  const h1=document.querySelector('h1');
  const sub=h1&&h1.parentElement?[...h1.parentElement.children].find((n)=>n!==h1&&norm(n.innerText)):null;
  const fields=[...document.querySelectorAll('label')].map((l)=>{
    // The rail can nest a field as a box holding only the label, with the help line
    // as its SIBLING, so looking inside the label's own div finds nothing (measured:
    // both duplex controls came back with an empty help). Climb until a long
    // paragraph appears.
    let scope=l.parentElement; let help=[];
    for(let i=0;i<4&&scope;i++){
      help=[...scope.querySelectorAll('p,span,small')].map(norm).filter((t)=>t.length>40&&!norm(l.innerText).includes(t.slice(0,20)));
      if(help.length) break;
      scope=scope.parentElement;
    }
    return [norm(l.innerText), help.join(' | ')];
  }).filter(([label])=>label);
  const notes=[...document.querySelectorAll('ul li')].map((li)=>norm(li.innerText)).filter((t)=>t.length>60);
  return JSON.stringify({title:norm(h1&&h1.innerText), subtitle:norm(sub&&sub.innerText), fields, notes});
})()`);
console.log(JSON.stringify(JSON.parse(card), null, 1));
await shoot(SHOT);
chrome.kill();
process.exit(0);
