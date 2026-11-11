// The ENGINE row on the deployed site, in both states, judged by the bytes.
//
//   BASE=https://www.browsersnip.com PDF=/tmp/fo-fix2/type.pdf \
//     node docs/research/engine-attribution-live.mjs
//
// One engine-backed tool (`pdf-to-pdfa`) is run twice, each time in a fresh headless
// Chromium with a fresh profile, because the engine loader is a module singleton: a tab
// that has already fetched Ghostscript would answer from memory and prove nothing.
//
//   blocked — `cdn.jsdelivr.net` is cut before the navigation, which is what "offline,
//             or a blocked CDN" means for this tool, so its local path must write the file
//   live    — nothing is cut, so the 15 MB engine is fetched and does the work
//
// For each pass the probe prints the card's `Engine` row and the run's own sentence, and
// takes the produced file out of the page as bytes: the producer string inside *those*
// bytes is the independent check that the row tells the truth. The old row printed
// `tool.engines[0]`, so both passes said "Ghostscript" and only one of them was right.
//
// CHROME defaults to the playwright chromium this repo's other rigs use.

import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const CHROME =
  process.env.CHROME || '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.env.BASE || 'https://www.browsersnip.com';
const PDF = process.env.PDF || '/tmp/fo-fix2/type.pdf';
const TOOL = process.env.TOOL || 'pdf-to-pdfa';
const OUT = process.env.OUT || '/tmp/engine-attribution-live.txt';
const PORT = Number(process.env.PORT || 9812);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The deployed bundle, and whether it carries this change's wording. */
async function bundleProvenance() {
  const html = await (await fetch(`${BASE}/`, { cache: 'no-store' })).text();
  const match = /assets\/index-[A-Za-z0-9_-]+\.js/.exec(html);
  if (!match) return { file: 'none', markers: [] };
  const body = await (await fetch(`${BASE}/${match[0]}`, { cache: 'no-store' })).text();
  const markers = [
    ['the fallback label', 'local path · '],
    ['silence is admitted', 'not reported'],
    ['per-file answers', 'see the list below'],
  ]
    .filter(([, needle]) => body.includes(needle))
    .map(([name]) => name);
  return { file: match[0], markers, bytes: body.length };
}

async function pass({ blocked, port }) {
  const userDataDir = `/tmp/engine-attribution-${blocked ? 'blocked' : 'live'}-${port}`;
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let ws;
  for (let i = 0; i < 60 && !ws; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch {
      /* chrome not up yet */
    }
    if (!ws) await sleep(300);
  }
  if (!ws) throw new Error('chromium never answered on the debugging port');
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });

  let id = 1;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (raw) => {
    const m = JSON.parse(raw.data);
    if (m.id && pending.get(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(JSON.stringify(m.error)));
      else res(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      errors.push((m.params.exceptionDetails?.exception?.description ?? '').slice(0, 200));
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = id++;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => {
        if (pending.has(i)) {
          pending.delete(i);
          rej(new Error(`${method} unanswered`));
        }
      }, 30000);
    });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  const wait = async (expr, ms = 300000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        if (await ev(expr)) return true;
      } catch {
        /* not yet */
      }
      await sleep(400);
    }
    return false;
  };

  await send('Page.enable');
  await send('Network.enable');
  await send('Runtime.enable');
  if (blocked) {
    await send('Network.setBlockedURLs', { urls: ['*cdn.jsdelivr.net*'] });
  }
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url: `${BASE}/#/tool/${TOOL}` });
  if (!(await wait(`document.readyState === 'complete' && !!document.querySelector('input[type=file]')`, 120000))) {
    ws.close();
    chrome.kill('SIGKILL');
    throw new Error('no file input on the route');
  }
  await ev(
    `(()=>{window.__blobs=[];const o=URL.createObjectURL.bind(URL);URL.createObjectURL=(b)=>{window.__blobs.push(b);return o(b)};return 1})()`,
  );
  const { root } = await send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId, files: [PDF] });
  await sleep(2000);

  const clicked = await ev(
    `(()=>{const b=document.querySelector('button[data-run]');if(!b||b.disabled)return 'NO BUTTON';const label=b.innerText.trim();b.click();return label})()`,
  );
  if (clicked === 'NO BUTTON') throw new Error('the run button is missing or disabled');
  if (
    !(await wait(
      `(()=>{const p=document.querySelector('[data-run-status]');return p&&p.getAttribute('data-run-status')!=='running'})()`,
      300000,
    ))
  ) {
    throw new Error('the run never reported a finished phase');
  }
  await sleep(1500);

  const rows = await ev(
    `[...document.querySelectorAll('[aria-label="Result"] dt')].map((dt)=>[dt.textContent.trim(),(dt.nextElementSibling?.textContent||'').trim()])`,
  );
  const card = await ev(`(document.querySelector('[aria-label="Result"]')?.innerText||'')`);
  const file = await ev(
    `(async()=>{const b=window.__blobs.at(-1);if(!b)return null;const u=new Uint8Array(await b.arrayBuffer());let s='';for(let i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return {size:u.length,b64:btoa(s)}})()`,
  );
  ws.close();
  chrome.kill('SIGKILL');
  return { clicked, rows, card, file, errors: [...new Set(errors)].slice(0, 3) };
}

const lines = [];
const say = (line) => {
  lines.push(line);
  console.log(line);
};

const proven = await bundleProvenance();
say(`target : ${BASE}`);
say(`bundle : ${proven.file} (${proven.bytes ?? '?'} bytes) carries ${proven.markers.length ? proven.markers.join(', ') : 'NONE of this change’s wording'}`);
say(`fixture: ${PDF} (${readFileSync(PDF).byteLength} bytes)`);

for (const [label, blocked] of [['blocked (engine unreachable)', true], ['live (engine fetched)', false]]) {
  say('');
  say(`── ${label} ──`);
  let result;
  try {
    result = await pass({ blocked, port: PORT + (blocked ? 0 : 1) });
  } catch (error) {
    say(`   rig problem, not a site verdict: ${error.message}`);
    continue;
  }
  say(`   pressed ${JSON.stringify(result.clicked)}`);
  for (const [term, value] of result.rows ?? []) say(`   ${term.toUpperCase()}: ${value}`);
  const bytes = result.file ? Buffer.from(result.file.b64, 'base64') : null;
  const text = bytes ? bytes.toString('latin1') : '';
  say(`   download: ${result.file ? `${result.file.size} bytes` : 'none'}`);
  say(`   producer inside those bytes: ${/GPL Ghostscript [0-9.]+/.test(text) ? 'GPL Ghostscript (the engine wrote it)' : 'no Ghostscript producer (the local path wrote it)'}`);
  say(`   the card says: ${(result.card || '').replace(/\s+/g, ' ').slice(0, 400)}`);
  if (result.errors.length) say(`   console errors: ${JSON.stringify(result.errors)}`);
}

writeFileSync(OUT, `${lines.join('\n')}\n`);
say('');
say(`artifact: ${OUT}`);
process.exit(0);
