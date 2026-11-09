/**
 * Live proof: blank a page on the deployed site, then N-up the file it produced.
 *
 * `docs/TOOL-TRIAGE.md` ERRORS/NO-OP item 1 — seven tools refused any document
 * holding a page with no `/Contents`, including the output of this app's own
 * `add-blank-page`. This drives the deployed site exactly as a person does
 * (dashboard → tool card → drop the file → run → Download), twice in a row, and
 * hands the verdict to an outside reader: `pymupdf` counts the pages, extracts
 * the text and measures the ink of the bytes that came out of the browser. No
 * claim in the output comes from a sentence the app printed about its own file.
 *
 *   node scripts/live-blank-chain-proof.mjs [BASE]
 *
 * Needs a Chrome-family binary (`CHROME=…`) and `python3` with `pymupdf`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The fork ships no Node-usable `exports` map, so plain `import` of its ESM build
// fails under bare Node. The CommonJS entry resolves through `createRequire`.
const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts, rgb } = require('@maxwbh/pdf-lib');

const CHROME = process.env.CHROME
  ?? '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.argv[2] ?? process.env.BASE ?? 'https://www.browsersnip.com';
const port = Number(process.env.PORT ?? 9401);
const work = mkdtempSync(join(tmpdir(), 'live-blank-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Four inked sheets of distinct width: the text names them, the box sizes them. */
async function makeFixture(path) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 4; i++) {
    const page = doc.addPage([200 + i * 60, 300]);
    page.drawText(`sheet ${i + 1}`, { x: 12, y: 150, size: 22, font, color: rgb(0, 0, 0) });
  }
  writeFileSync(path, await doc.save({ useObjectStreams: false }));
}

const fixture = join(work, 'inked.pdf');
await makeFixture(fixture);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-blank-'))}`,
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
/** The lines of the panel that carry a claim, a count or a refusal. */
const readout = () => evv(`(() => {
  const t = document.body.innerText;
  const hit = t.match(/[^\\n]*(page|sheet|blank|can't|cannot|error|fail|unusable)[^\\n]*/gi) ?? [];
  return [...new Set(hit)].slice(0, 10).join(' / ');
})()`);

/**
 * One tool, driven end to end: card → drop the file → run → Download.
 *
 * Returns the path of the file the browser wrote, or `null` when the run refused
 * the input — in which case the panel's own words are printed, because a refusal
 * with no file is exactly what this proof is looking for.
 */
async function drive(toolId, cardPattern, runPattern, input) {
  const dir = mkdtempSync(join(tmpdir(), `live-out-${toolId}-`));
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
  await send('Page.navigate', { url: `${BASE}/#/pdf` });
  await sleep(6000);
  const opened = await evv(`(() => {
    const card = document.querySelector('button[data-tool="${toolId}"]');
    if (!card) return 'CARD MISSING';
    card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return 'opened';
  })()`);
  if (opened !== 'opened') throw new Error(`${toolId}: ${opened}`);
  await sleep(5000);

  const doc = await send('DOM.getDocument', { depth: -1 });
  const field = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' });
  if (!field.result?.nodeId) throw new Error(`${toolId}: no file input`);
  await send('DOM.setFileInputFiles', { nodeId: field.result.nodeId, files: [input] });

  // Wait for the rail to finish reading the file: its card names the page count.
  let ready = 'no';
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    ready = await evv(`(() => /${cardPattern}/i.test(document.body.innerText) || /${toolId === 'n-up' ? 'per sheet|pages per sheet' : 'blank|position'}/i.test(document.body.innerText)) ? 'yes' : 'no'`);
    if (ready === 'yes') break;
  }
  console.log(`[${toolId}] panel ready: ${ready}`);
  console.log(`[${toolId}] panel: ${await readout()}`);

  const clicked = await ev(`(() => {
    const re = new RegExp(${JSON.stringify(runPattern)}, 'i');
    const button = [...document.querySelectorAll('button')].find((b) => re.test((b.innerText || '').trim()) && !b.disabled);
    if (!button) return 'RUN BUTTON MISSING';
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return 'clicked';
  })()`);
  console.log(`[${toolId}] run: ${clicked.value ?? clicked.error}`);

  let download = 'no';
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const state = await evv(`(() => {
      const alert = document.querySelector('[role=alert]');
      if (alert) return 'REFUSED: ' + alert.innerText.replace(/\\s+/g, ' ').slice(0, 200);
      const t = document.body.innerText;
      return /download/i.test(t) ? 'ready' : 'waiting';
    })()`);
    if (state.startsWith('REFUSED:')) {
      console.log(`[${toolId}] ${state}`);
      console.log(`[${toolId}] panel after the refusal: ${await readout()}`);
      return null;
    }
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
  console.log(`[${toolId}] download: ${download}`);
  console.log(`[${toolId}] result card: ${await readout()}`);
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const files = readdirSync(dir).filter((n) => n.endsWith('.pdf') && !n.endsWith('.crdownload'));
    if (files.length > 0) {
      const out = join(dir, files[0]);
      const kept = join(work, `${toolId}.pdf`);
      copyFileSync(out, kept);
      return kept;
    }
  }
  console.log(`[${toolId}] nothing was written to ${dir}`);
  return null;
}

/** What an outside reader says about the bytes. */
function measure(paths) {
  const script = `
import json, sys, pymupdf
out = []
for path in sys.argv[1:]:
    doc = pymupdf.open(path)
    pages = []
    for page in doc:
        pix = page.get_pixmap(dpi=40)
        raw = pix.samples
        ink = sum(1 for i in range(0, len(raw), 3) if raw[i] < 240) / (pix.width * pix.height)
        pages.append({"chars": len(page.get_text().strip()), "ink": round(ink * 100, 3),
                      "w": round(page.rect.width, 1), "h": round(page.rect.height, 1)})
    out.append({"file": path.split("/")[-2] + "/" + path.split("/")[-1], "pages": pages})
print(json.dumps(out, indent=1))
`;
  const file = join(work, 'measure.py');
  writeFileSync(file, script);
  const run = spawnSync('python3', [file, ...paths], { encoding: 'utf8' });
  if (run.status !== 0) return `pymupdf failed: ${run.stderr.slice(0, 400)}`;
  return run.stdout;
}

console.log(`# ${BASE} — add-blank-page → n-up, measured by pymupdf`);
await send('Runtime.enable');
await send('Page.enable');
// The queue is restored from origin storage, so clear it and reload: a leftover
// file from an earlier run would be handed to the second tool by accident.
await send('Storage.clearDataForOrigin', { origin: new URL(BASE).origin, storageTypes: 'all' });
await send('Page.navigate', { url: 'about:blank' });
await sleep(1500);

const withBlank = await drive(
  'add-blank-page',
  'Add Blank Page|Insert|blank sheet',
  '^Add blanks$',
  fixture,
);
if (!withBlank) {
  console.log('VERDICT: the chain never started — add-blank-page produced no file');
} else {
  console.log(`\n${measure([fixture, withBlank])}`);
  const imposed = await drive('n-up', 'N-Up PDF|Pages per sheet', '^Lay out$', withBlank);
  if (!imposed) {
    console.log('\nVERDICT: RED — n-up refused the blank page this app just wrote (no file).');
  } else {
    console.log(`\n${measure([withBlank, imposed])}`);
    console.log('\nVERDICT: GREEN — the blank page survived the chain into the N-up file.');
  }
}

ws.close();
chrome.kill();
process.exit(0);
