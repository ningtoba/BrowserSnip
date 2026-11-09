/**
 * Live proof: does every sheet an n-up run produces carry its pages **on the paper**?
 *
 * `n-up` numbered its cells across the whole run instead of within a sheet, so a
 * 4-up of an eight-page document put sheet 2's four pages one row *below* the media
 * box: in the file, invisible on the page. `tests/pdf/grid-placement.test.ts` pins
 * that out of the bytes in jsdom; this drives the deployed site exactly as a person
 * does — dashboard → tool card → "4" per sheet → drop the file → Lay out →
 * Download — and hands the download to `pymupdf`, which answers the only two
 * questions that matter:
 *
 *   · how much ink does each sheet have **inside its own page box**,
 *   · which of the eight source pages is findable as text on each sheet.
 *
 * A page count cannot see this defect (2 sheets was always the right answer), and
 * neither can "the file contains 8 form XObjects". Ink per sheet, measured off the
 * rendered page, can.
 *
 *   node scripts/live-nup-placement-proof.mjs [BASE]
 *
 * Needs a Chrome-family binary (`CHROME=…`) and `python3` with `pymupdf`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The pdf-lib fork ships no Node-usable `exports` map, so the CommonJS entry has
// to be reached through `createRequire` (see scripts/live-blank-chain-proof.mjs).
const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts, rgb } = require('@maxwbh/pdf-lib');

const CHROME = process.env.CHROME
  ?? '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.argv[2] ?? process.env.BASE ?? 'https://www.browsersnip.com';
const PER_SHEET = Number(process.env.PER_SHEET ?? 4);
const PAGES = Number(process.env.PAGES ?? 8);
const port = Number(process.env.PORT ?? 9411);
const work = mkdtempSync(join(tmpdir(), 'live-nup-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `PAGES` sheets, each naming itself, each with ink in **all four quadrants**.
 *
 * A cell with no ink in it cannot tell "the page is off the paper" from "this
 * quarter of the source was empty", so every quarter of every sheet is marked.
 */
async function makeFixture(path) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 0; i < PAGES; i++) {
    const page = doc.addPage([300, 420]);
    page.drawText(`PAGE ${i + 1}`, { x: 40, y: 200, size: 34, font, color: rgb(0, 0, 0) });
    for (const [fx, fy] of [[20, 20], [200, 20], [20, 320], [200, 320]]) {
      page.drawRectangle({ x: fx, y: fy, width: 70, height: 60, color: rgb(0, 0, 0) });
    }
  }
  writeFileSync(path, await doc.save({ useObjectStreams: false }));
}

const fixture = join(work, 'eight-pages.pdf');
await makeFixture(fixture);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-nup-'))}`,
  'about:blank',
], { stdio: 'ignore' });

let ws;
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const p = list.find((t) => t.type === 'page');
    if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; }
  } catch { /* chrome is still starting */ }
  await sleep(500);
}
if (!ws) {
  chrome.kill();
  console.error('VERDICT: no Chrome to drive (set CHROME=…)');
  process.exit(1);
}
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let nextId = 1;
const pending = new Map();
ws.onmessage = (m) => {
  let msg;
  try { msg = JSON.parse(m.data); } catch { return; }
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
};
const send = (method, params = {}) =>
  new Promise((res) => { const id = nextId++; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return r.result?.exceptionDetails
    ? { error: r.result.exceptionDetails.exception?.description ?? 'eval error' }
    : { value: r.result?.result?.value };
};
const evv = async (expression) => {
  const r = await ev(expression);
  return r.error ? `ERR ${String(r.error).slice(0, 160)}` : String(r.value);
};

console.log(`# ${BASE} — ${PAGES} pages through n-up at ${PER_SHEET} per sheet, measured by pymupdf`);
await send('Runtime.enable');
await send('Page.enable');
// A file left in the queue by an earlier run would be handed to this one.
await send('Storage.clearDataForOrigin', { origin: new URL(BASE).origin, storageTypes: 'all' });
await send('Page.navigate', { url: `${BASE}/#/pdf` });
await sleep(8000);

const opened = await evv(`(() => {
  const card = document.querySelector('button[data-tool="n-up"]');
  if (!card) return 'CARD MISSING';
  card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return 'opened';
})()`);
if (opened !== 'opened') { console.log(`VERDICT: ${opened}`); ws.close(); chrome.kill(); process.exit(1); }
await sleep(5000);

const dir = mkdtempSync(join(tmpdir(), 'live-nup-out-'));
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
const doc = await send('DOM.getDocument', { depth: -1 });
const field = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' });
if (!field.result?.nodeId) { console.log('VERDICT: no file input'); ws.close(); chrome.kill(); process.exit(1); }
await send('DOM.setFileInputFiles', { nodeId: field.result.nodeId, files: [fixture] });

let ready = 'no';
for (let i = 0; i < 30; i++) {
  await sleep(2000);
  ready = await evv(`(() => /${PAGES} pages|${PAGES} page\\b/i.test(document.body.innerText) ? 'yes' : 'no')()`);
  if (ready === 'yes') break;
}
console.log(`[n-up] panel holds the file: ${ready}`);

// The rail folds every field but its lead one behind "▸ N more options", and the
// panel only exists once a file is in the queue, so the disclosure is opened here —
// a control that is not in the DOM cannot be pressed.
const expanded = await ev(`(() => {
  const closed = document.querySelector('[data-options-panel="closed"]');
  if (!closed) return 'no panel';
  const button = [...closed.querySelectorAll('button')].find((b) => /more option/i.test(b.innerText || ''));
  if (!button) return 'DISCLOSURE MISSING (already open?)';
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return 'opened';
})()`);
console.log(`[n-up] options panel: ${expanded.value ?? expanded.error}`);
await sleep(2000);

// The segmented "Pages per sheet" control, pressed and then read back out of the
// DOM: the run must be judged against the settings it actually used.
const group = `[role=group][aria-label="Pages per sheet"]`;
const pressed = await ev(`(() => {
  const scope = document.querySelector(${JSON.stringify(group)});
  if (!scope) return 'GROUP MISSING';
  const button = [...scope.querySelectorAll('button')].find((b) => b.innerText.trim() === ${JSON.stringify(String(PER_SHEET))});
  if (!button) return 'OPTION MISSING: ' + [...scope.querySelectorAll('button')].map((b) => b.innerText.trim()).join(',');
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return 'clicked';
})()`);
console.log(`[n-up] per-sheet press: ${pressed.value ?? pressed.error}`);
console.log(`[n-up] per-sheet read back: ${await evv(`(() => {
  const scope = document.querySelector(${JSON.stringify(group)});
  return [...(scope?.querySelectorAll('button') ?? [])]
    .map((b) => b.innerText.trim() + '=' + (b.getAttribute('aria-pressed') ?? '?')).join(' ');
})()`)}`);

const clicked = await ev(`(() => {
  const button = [...document.querySelectorAll('button')].find((b) => /^Lay out$/.test((b.innerText || '').trim()) && !b.disabled);
  if (!button) return 'RUN BUTTON MISSING';
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return 'clicked';
})()`);
console.log(`[n-up] run: ${clicked.value ?? clicked.error}`);
console.log(`[n-up] panel says: ${await evv(`(() => {
  const t = document.body.innerText;
  const hit = t.match(/[^\\n]*(sheet|page|placed)[^\\n]*/gi) ?? [];
  return [...new Set(hit)].slice(0, 8).join(' / ');
})()`)}`);

let download = 'no';
for (let i = 0; i < 60; i++) {
  await sleep(2000);
  const state = await evv(`(() => {
    const alert = document.querySelector('[role=alert]');
    if (alert) return 'REFUSED: ' + alert.innerText.replace(/\\s+/g, ' ').slice(0, 200);
    return /download/i.test(document.body.innerText) ? 'ready' : 'waiting';
  })()`);
  if (state.startsWith('REFUSED:')) { console.log(`[n-up] ${state}`); ws.close(); chrome.kill(); process.exit(1); }
  if (state === 'ready') {
    download = await evv(`(() => {
      const re = /^(Download|Save PDF|Download PDF)$/i;
      const b = [...document.querySelectorAll('button, a')].find((n) => re.test((n.innerText || '').trim()));
      if (!b) return 'DOWNLOAD MISSING';
      b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return 'clicked';
    })()`);
    break;
  }
}
console.log(`[n-up] download: ${download}`);

let produced = null;
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  const files = readdirSync(dir).filter((n) => n.endsWith('.pdf') && !n.endsWith('.crdownload'));
  if (files.length > 0) {
    produced = join(work, 'nup.pdf');
    copyFileSync(join(dir, files[0]), produced);
    break;
  }
}
if (!produced) {
  console.log(`VERDICT: RED — nothing was written to ${dir}`);
  ws.close();
  chrome.kill();
  process.exit(1);
}

/**
 * What an outside reader says about the bytes.
 *
 * For every sheet: its own page box, the ink **inside** that box as a percentage of
 * the box, the ink the file puts outside it, and which source pages are findable as
 * text on it. The last column is what makes "0 % ink" mean something: the words are
 * in the file, they are just not on the page.
 */
const script = `
import json, re, sys, pymupdf

def boxes(page):
    out = []
    for d in page.get_drawings():
        if d.get("rect"): out.append(pymupdf.Rect(d["rect"]))
    for b in page.get_text("blocks"):
        out.append(pymupdf.Rect(b[:4]))
    return out

def sheets_of(path):
    doc = pymupdf.open(path)
    rows = []
    for number, page in enumerate(doc):
        clip = page.rect
        pix = page.get_pixmap(dpi=40)
        raw = pix.samples
        inside_px = sum(1 for i in range(0, len(raw), 3) if raw[i] < 240)
        # Anything the file draws that misses the page box entirely.
        drawn = boxes(page)
        off = [r for r in drawn if (r & clip).get_area() <= 0]
        words = " ".join(page.get_text().split())
        rows.append({
            "sheet": number + 1,
            "box": [round(v, 2) for v in (clip.x0, clip.y0, clip.x1, clip.y1)],
            "ink_inside_pct": round(100 * inside_px / (pix.width * pix.height), 3),
            "drawn_boxes": len(drawn),
            "drawn_boxes_off_page": len(off),
            "off_page_example": [round(v, 2) for v in off[0]] if off else None,
            "pages_found": sorted({int(w) for w in re.findall(r"PAGE (\\d+)", page.get_text())}),
            "words": words[:120],
        })
    return rows

print(json.dumps({"input": {"file": sys.argv[1], "sheets": sheets_of(sys.argv[1])},
                  "output": {"file": sys.argv[2], "sheets": sheets_of(sys.argv[2])}}, indent=1))
`;
const file = join(work, 'measure.py');
writeFileSync(file, script);
const run = spawnSync('python3', [file, fixture, produced], { encoding: 'utf8' });
const measured = run.stdout ? JSON.parse(run.stdout) : null;
console.log(measured ? JSON.stringify(measured, null, 1) : `pymupdf failed: ${run.stderr.slice(0, 600)}`);

// The verdict is read off the produced file's measurement, not off a sentence in
// this script.
const sheets = measured?.output.sheets ?? [];
const expected = Math.ceil(PAGES / PER_SHEET);
const later = sheets.slice(1);
const blankLater = later.filter((s) => s.ink_inside_pct <= 0.001);
const missingPages = new Set(
  Array.from({ length: PAGES }, (_, i) => i + 1)
    .filter((n) => !sheets.some((s) => s.pages_found.includes(n))),
);
console.log(`\nexpected sheets ${expected}, measured ${sheets.length}; `
  + `sheets after the first with no ink on the page: ${blankLater.length}; `
  + `source pages nowhere in the output: ${[...missingPages].join(', ') || 'none'}; `
  + `boxes drawn off their page: ${sheets.reduce((total, s) => total + s.drawn_boxes_off_page, 0)}`);
console.log(sheets.length === expected && blankLater.length === 0 && missingPages.size === 0
  ? 'VERDICT: GREEN — every sheet carries its pages inside its own page box.'
  : 'VERDICT: RED — content is in the file but not on the paper.');

ws.close();
chrome.kill();
process.exit(0);
