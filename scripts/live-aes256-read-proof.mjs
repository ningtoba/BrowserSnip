/**
 * Live proof: does the **deployed** site open, edit and hand back an AES-256 file?
 *
 * The `encrypted-inputs` row measured this app refusing AES-256 outright — the
 * correct password answering `BAD_PASSWORD`, 12 of 36 operation runs producing no
 * file at all, and an owner-password-only file reported as locked where qpdf,
 * MuPDF and poppler all open it with nothing typed. The revision-6 read path in
 * `core/crypto.ts` is what changed; a local suite proves the derivation, and only
 * the deployed bundle proves the product.
 *
 * So this drives the site the way a person does — dashboard → Rotate PDF → drop an
 * outside-locked AES-256 file → type the open password → Rotate → Download — and
 * hands the downloaded bytes to readers that share no code with it. The input is
 * `tests/fixtures/encrypted/aes-256-user.pdf`, written by libqpdf 12.3.2 over a
 * MuPDF base: three pages that each name their own sheet, `/V 5 /R 6` with
 * `/CFM /AESV3`, user password `hunter2`.
 *
 * The verdict is not "the card said 3 pages". It is, on the downloaded file:
 *
 *   · MuPDF opens it with `hunter2`, refuses the wrong one, and returns the
 *     planted sentence on **3 of 3** sheets — a page count that survives while the
 *     words go missing is the exact failure this campaign chases;
 *   · every page reports `rotation 90`, so the edit landed on a file whose streams
 *     had to be decrypted to be rewritten;
 *   · libqpdf reads the dictionary it is handed and still calls it 256-bit AES
 *     (`/R 6`, `/CFM /AESV3`) — the copy is not silently downgraded or unlocked;
 *   · `qpdf --check`, run through the library's own job interface, reports the file
 *     valid.
 *
 *   node scripts/live-aes256-read-proof.mjs [BASE]
 *
 * Env: `CHROME` (a Chrome-family binary), `FIXTURE`, `PASSWORD`, `PORT`.
 * Needs `python3` with `pymupdf` and `pikepdf`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME
  ?? '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.argv[2] ?? process.env.BASE ?? 'https://www.browsersnip.com';
const PORT = Number(process.env.PORT ?? 9443);
const PASSWORD = process.env.PASSWORD ?? 'hunter2';
const WRONG = 'not-the-password';
const PLANTED = 'Lighthouse Inventory 1887';
const SHEETS = ['ALPHA', 'BRAVO', 'CHARLIE'];
const work = mkdtempSync(join(tmpdir(), 'live-aes256-'));

const input = join(work, 'aes-256-user.pdf');
const fixture = process.env.FIXTURE ?? 'tests/fixtures/encrypted/aes-256-user.pdf';
if (!existsSync(fixture)) {
  console.log(`missing fixture ${fixture}; run \`python3 scripts/encrypted-fixtures.py\``);
  process.exit(1);
}
copyFileSync(fixture, input);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-aes256-'))}`,
  'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let ws;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((tab) => tab.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch { /* chrome is still starting */ }
  await sleep(500);
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

const clickText = (pattern, what) => raw(`(() => {
  const re = new RegExp(${JSON.stringify(pattern)}, 'i');
  const matches = [...document.querySelectorAll('button, a, input, [role], label, span, p')]
    .filter((n) => re.test((n.innerText || n.textContent || n.getAttribute('aria-label') || '').trim()))
    .sort((a, b) => (a.innerText || a.textContent || '').length - (b.innerText || b.textContent || '').length;
  if (matches.length === 0) return 'MISSING:${what}';
  const leaf = matches[0];
  const el = leaf.closest('button, a, input, [role=switch], [role=checkbox], label') || leaf;
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return 'clicked <' + el.tagName.toLowerCase() + '> ' + (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 40);
})()`);

/**
 * Type the open password into the gate the rail shows for a locked file.
 *
 * Looked up by the placeholder the gate is the only field carrying, not by index:
 * the dashboard keeps other tools' password inputs in the DOM, and typing into one
 * of those runs with an empty secret, which is how an earlier harness proved
 * nothing about the file it thought it had opened.
 */
const typePassword = (value) => raw(`(() => {
  const fields = [...document.querySelectorAll('input[type=password]')]
    .filter((f) => f.offsetParent !== null);
  const gate = fields.find((f) => /not required unless/i.test(f.placeholder || '')) ?? fields[0];
  if (!gate) return 'no visible password field; fields: ' + fields.length;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  gate.focus();
  setter.call(gate, ${JSON.stringify(value)});
  gate.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(value)} }));
  gate.dispatchEvent(new Event('change', { bubbles: true }));
  return 'typed the open password into ' + (gate.id || gate.placeholder || 'the gate');
})()`);

const gateState = () => said(`(() => {
  const fields = [...document.querySelectorAll('input[type=password]')].filter((f) => f.offsetParent !== null);
  return fields.map((f) => (f.id || f.placeholder || 'gate') + '=' + (f.value ? JSON.stringify(f.value) : '(empty)')).join(' · ') || '(none)';
})()`);

await send('Runtime.enable');
await send('Page.enable');
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: work });
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

console.log(`# ${BASE} · rotate · AES-256 (/V 5 /R 6 /AESV3) · password ${JSON.stringify(PASSWORD)}`);
await send('Page.navigate', { url: `${BASE}/#/pdf` });
await sleep(6000);
await send('Storage.clearDataForOrigin', { origin: new URL(BASE).origin, storageTypes: 'all' });
await send('Page.navigate', { url: 'about:blank' });
await sleep(1500);
await send('Page.navigate', { url: `${BASE}/#/pdf` });
await sleep(7000);
console.log('card  :', (await clickText('Rotate PDF', 'rotate-card')).value);
await sleep(5000);

const doc = await send('DOM.getDocument', { depth: -1 });
const fileInput = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' });
if (!fileInput.result?.nodeId) {
  console.log('NO FILE INPUT; body:', await said('document.body.innerText.slice(0,600)'));
  chrome.kill();
  process.exit(1);
}
await send('DOM.setFileInputFiles', { nodeId: fileInput.result.nodeId, files: [input] });
console.log('file  :', input);
await sleep(22000);
// What the site believes about the lock is part of the measurement, printed before
// anything is typed: the row's second belief error was an AES-256 file the rail
// called locked when the readers called it open.
console.log('notice:', await said(`(() => {
  const line = document.body.innerText.split('\\n').find((l) => /password|protected|encrypted|restricted/i.test(l));
  return line ?? '(no lock line in view)';
})()`));
console.log('gate  :', await gateState());
console.log('typed :', (await typePassword(PASSWORD)).value);
await sleep(1500);
console.log('gate  :', await gateState());
console.log('run   :', (await clickText('^Rotate$', 'rotate-action')).value);

let card = '';
for (let tick = 0; tick < 60; tick++) {
  await sleep(2000);
  card = await said(`(() => {
    const line = document.body.innerText.split('\\n').find((l) => /Rotated|could not|not correct|cannot|refus/i.test(l));
    return line ?? '';
  })()`);
  if (card) break;
}
console.log('result:', card);
console.log('errors:', await said(`(() => {
  const hits = document.body.innerText.split('\\n').filter((l) => /error|failed|password|ciphertext|blank/i.test(l));
  return hits.slice(0, 6).join(' / ') || '(none in view)';
})()`));
console.log('down  :', (await clickText('^(Download|Save PDF|Download PDF)', 'download')).value);

let produced = null;
for (let tick = 0; tick < 40; tick++) {
  await sleep(1000);
  const found = readdirSync(work).filter((name) => name.endsWith('.pdf') && name !== 'aes-256-user.pdf');
  const pdf = found.map((name) => join(work, name)).find((path) => readFileSync(path).subarray(0, 5).toString('latin1') === '%PDF-');
  if (pdf) { produced = pdf; break; }
}
if (!produced) { console.log('NOTHING DOWNLOADED'); chrome.kill(); process.exit(1); }
const out = join(work, 'deployed-aes256.pdf');
writeFileSync(out, readFileSync(produced));
console.log('file  :', out, `${readFileSync(out).length} bytes`);
ws.close();
chrome.kill();

const judge = `
import json, sys
import pikepdf, pymupdf
path, wrong, key, planted, sheets = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5].split(',')
report = {}
with pikepdf.open(path, password=key) as pdf:
    enc = pdf.trailer['/Encrypt']
    cf = enc['/CF'][enc['/StmF']]
    report['qpdf_opens'] = True
    report['V'] = int(enc['/V']); report['R'] = int(enc['/R'])
    report['CFM'] = str(cf['/CFM']); report['cf_length'] = int(cf['/Length'])
    report['pages'] = len(pdf.pages)
    report['has_OE'] = '/OE' in enc and len(bytes(enc['/OE'])) == 32
    report['has_UE'] = '/UE' in enc and len(bytes(enc['/UE'])) == 32
    report['has_Perms'] = '/Perms' in enc and len(bytes(enc['/Perms'])) == 16
try:
    pikepdf.open(path, password=wrong); report['qpdf_refuses_wrong'] = False
except pikepdf.PasswordError:
    report['qpdf_refuses_wrong'] = True
job = pikepdf.Job(['qpdf', '--password=' + key, '--check', path])
job.run(); report['qpdf_check_exit'] = job.exit_code
doc = pymupdf.open(path)
report['mupdf_needs_pass'] = bool(doc.needs_pass)
report['mupdf_accepts_password'] = bool(doc.authenticate(key))
report['mupdf_refuses_empty'] = not bool(pymupdf.open(path).authenticate(''))
texts = [page.get_text() for page in doc]
report['planted_pages'] = sum(1 for t in texts if planted in t)
report['sheets'] = [w for w in sheets if any(w in t for t in texts)]
report['rotations'] = [int(p.rotation) for p in doc]
report['chars'] = sum(len(t) for t in texts)
doc.close()
print(json.dumps(report))
`;
const judged = spawnSync('python3', ['-c', judge, out, WRONG, PASSWORD, PLANTED, SHEETS.join(',')],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
console.log('# outside readers, on the file the deployed site downloaded');
console.log((judged.stdout || '').trim());
if (judged.status !== 0) console.log('reader harness failed:', (judged.stderr || '').slice(0, 800));
console.log('workdir:', work);
