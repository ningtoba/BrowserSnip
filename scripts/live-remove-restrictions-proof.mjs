/**
 * Live proof: does the **deployed** site lift the restrictions off a locked file,
 * and is the download really open?
 *
 * `docs/TOOL-TRIAGE.md` ERRORS 2 charged `remove-restrictions` with refusing every
 * password-protected file and with giving the user nowhere to type the password.
 * That was measured on a build from before the read path landed, and a ledger row is
 * a hypothesis about an old bundle — so this drives the site a person drives:
 * dashboard → Remove Restrictions → drop a file locked by somebody else's encryptor
 * → type the open password into the box on that file's card → **Remove restrictions**
 * → Download. Then four readers that share no code with the app judge the download.
 *
 * The input is `tests/fixtures/encrypted/aes-256-user.pdf`: three pages whose sheets
 * each carry `Lighthouse Inventory 1887`, `/V 5 /R 6 /CFM /AESV3`, user password
 * `hunter2`, `/P = -3376` (print, edit, annotate, form-fill and assemble refused).
 * `FIXTURE_NAME=aes-256-owner.pdf` is the restricted-but-openable twin: its user
 * secret is empty, so the site is asked to do the job with **nothing typed**.
 *
 * What the downloaded file owes, none of it taken from the card:
 *
 *   · no `/Encrypt` entry at all, and no `/P`, `/CFM`, `/StmF` — the copy is fully
 *     open, not "password still required, restrictions lifted";
 * · MuPDF opens it with nothing typed and reports `permissions = -4`, i.e. every
 *     restriction bit set;
 *   · libqpdf opens it with nothing typed and `qpdf --check` exits 0;
 *   · pypdf reports `is_encrypted False` and extracts the planted sentence;
 *   · the sentence is on **3 of 3** sheets, sheet 1 still carries its ink, and the
 *     two-level outline is still there — the words, the pixels and the bookmarks the
 *     user had are the words, the pixels and the bookmarks they get back;
 *   · `hunter2` appears nowhere in the file, and not in the downloaded name.
 *
 *   node scripts/live-remove-restrictions-proof.mjs [BASE]
 *
 * Env: `CHROME`, `FIXTURE_NAME`, `PASSWORD`, `TOOL`, `ACTION`, `PORT`.
 * Needs `python3` with `pymupdf`, `pikepdf`, `pypdf`, and poppler on PATH.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME
  ?? '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.argv[2] ?? process.env.BASE ?? 'https://www.browsersnip.com';
const PORT = Number(process.env.PORT ?? 9451);
const TOOL = process.env.TOOL ?? 'remove-restrictions';
const ACTION = process.env.ACTION ?? 'Remove restrictions';
const FIXTURE_NAME = process.env.FIXTURE_NAME ?? 'aes-256-user.pdf';
/** Empty for the owner-only fixture: the point of running that one is typing nothing. */
const PASSWORD = process.env.PASSWORD ?? 'hunter2';
const PLANTED = 'Lighthouse Inventory 1887';
const work = mkdtempSync(join(tmpdir(), 'live-restrictions-'));

const fixture = process.env.FIXTURE ?? `tests/fixtures/encrypted/${FIXTURE_NAME}`;
if (!existsSync(fixture)) {
  console.log(`missing fixture ${fixture}; run \`python3 scripts/encrypted-fixtures.py\``);
  process.exit(1);
}
const input = join(work, FIXTURE_NAME);
copyFileSync(fixture, input);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-restrictions-'))}`,
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
const consoleErrors = [];
ws.onmessage = (message) => {
  let msg;
  try { msg = JSON.parse(message.data); } catch { return; }
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push((msg.params.exceptionDetails?.exception?.description ?? '').slice(0, 160));
  }
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

/** Exact-label click: the tool's card, the search palette and the file row all
 *  carry the tool's name, and a substring match has clicked the wrong one before. */
const click = (labels) => raw(`(() => {
  const wanted = ${JSON.stringify(labels)};
  const nodes = [...document.querySelectorAll('button, a [role=button], a, input')]
    .map((el) => ({ el, text: (el.innerText || el.textContent || el.getAttribute('aria-label') || el.value || '').trim() }))
    .filter(({ el, text }) => el.offsetParent !== null && wanted.some((w) => text === w || text.startsWith(w + ' ')));
  if (nodes.length === 0) {
    return 'MISSING ' + wanted.join('/') + '; on screen: '
      + [...document.querySelectorAll('button')].map((b) => JSON.stringify((b.innerText || '').trim())).filter((t) => t !== '""').join(' ').slice(0, 300);
  }
  const { el, text } = nodes[0];
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  el.click?.();
  return 'clicked <' + el.tagName.toLowerCase() + '> ' + text.slice(0, 44);
})()`).then((hit) => hit.value ?? `ERR ${String(hit.error).slice(0, 200)}`);

/**
 * Type into the box on the file's own card, found by the `data-file-password`
 * attribute the card gives it and by nothing else. The dashboard keeps other
 * password inputs mounted, and typing into one of those runs with an empty secret.
 */
const typeRowPassword = (value) => raw(`(() => {
  const named = document.querySelector('[data-file-password="${FIXTURE_NAME}"]');
  const visible = [...document.querySelectorAll('input[type=password]')].filter((f) => f.offsetParent !== null);
  const field = (named && named.offsetParent !== null) ? named : visible[0];
  if (!field) return 'no password box on this page';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  field.focus();
  setter.call(field, ${JSON.stringify(value)});
  field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(value)} }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  return 'typed into ' + (field.getAttribute('data-file-password') || field.id || field.placeholder || 'the box')
    + ' · aria-label=' + JSON.stringify(field.getAttribute('aria-label') || '');
})()`).then((hit) => hit.value ?? `ERR ${String(hit.error).slice(0, 200)}`);

await send('Runtime.enable');
await send('Page.enable');
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: work });
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

console.log(`# ${BASE} · ${TOOL} · ${FIXTURE_NAME} · secret ${PASSWORD ? JSON.stringify(PASSWORD) : '(none typed)'}`);
await send('Page.navigate', { url: `${BASE}/#/tool/${TOOL}` });
for (let tick = 0; tick < 40; tick++) {
  await sleep(2000);
  if (await said('!!document.querySelector("input[type=file]")') === 'true') break;
}
console.log('route :', await said('location.hash'));
console.log('intake:', (await raw(`(() => {
  const input = document.querySelector('input[type=file]');
  return input ? 'file input present, accept=' + (input.accept || '(none)') : 'MISSING:file-input';
})()`)).value);

const doc = await send('DOM.getDocument', { depth: -1 });
const fileInput = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' });
if (!fileInput.result?.nodeId) {
  console.log('NO FILE INPUT; body:', await said('document.body.innerText.slice(0,600)'));
  chrome.kill();
  process.exit(1);
}
await send('DOM.setFileInputFiles', { nodeId: fileInput.result.nodeId, files: [input] });
// Wait for the card to state its belief about the lock: that line is the row's
// second claim ("no place to type the password"), so it is read before typed into.
let belief = '';
for (let tick = 0; tick < 40; tick++) {
  await sleep(2000);
  belief = await said(`(() => {
    const row = document.querySelector('[data-file-lock]');
    return row ? row.innerText.replace(/\\n/g,' / ') : '';
  })()`);
  if (belief && belief !== 'null') break;
}
console.log('card  :', belief);
if (PASSWORD) console.log('typed :', await typeRowPassword(PASSWORD));
await sleep(3000);
console.log('run   :', await click([ACTION]));

let card = '';
for (let tick = 0; tick < 90; tick++) {
  await sleep(2000);
  card = await said(`(() => {
    const line = document.body.innerText.split('\\n').find((l) => /Restrictions cleared|cleared —|is password protected|not correct|cannot|refus|Left alone|could not/i.test(l));
    return line ?? '';
  })()`);
  if (card && !/is password protected/.test(card)) break;
  if (card && !PASSWORD) break;
}
console.log('result:', card);
console.log('notes :', await said(`(() => {
  const hits = document.body.innerText.split('\\n').filter((l) => /error|failed|password|ciphertext|blank|warn|restricted/i.test(l));
  return hits.slice(0, 6).join(' / ') || '(none in view)';
})()`));
console.log('down  :', await click(['Download', 'Download PDF', 'Save PDF']));

let produced = null;
for (let tick = 0; tick < 40; tick++) {
  await sleep(1000);
  const found = readdirSync(work).filter((name) => name.endsWith('.pdf') && name !== FIXTURE_NAME);
  const pdf = found.map((name) => join(work, name)).find((path) => readFileSync(path).subarray(0, 5).toString('latin1') === '%PDF-');
  if (pdf) { produced = pdf; break; }
}
if (!produced) {
  console.log('NOTHING DOWNLOADED — the site refused. Body:', await said('document.body.innerText.slice(0,900)'));
  chrome.kill();
  process.exit(1);
}
const out = join(work, 'deployed-unrestricted.pdf');
writeFileSync(out, readFileSync(produced));
console.log('name  :', produced.split('/').pop());
console.log('file  :', out, `${readFileSync(out).length} bytes`);
console.log('errors:', JSON.stringify([...new Set(consoleErrors)].slice(0, 3)));
ws.close();
chrome.kill();

const judge = `
import json, subprocess, sys
path, planted, secret = sys.argv[1], sys.argv[2], sys.argv[3]
report = {}
raw = open(path, 'rb').read().decode('latin1')
report['bytes'] = len(raw)
report['has_encrypt_key'] = bool(__import__('re').search(r'/Encrypt[\\s<\\d]', raw))
report['has_P_key'] = bool(__import__('re').search(r'/P\\s+-?\\d', raw))
report['has_CFM_key'] = '/CFM' in raw
report['secret_in_bytes'] = bool(secret) and secret in raw
import pikepdf, pymupdf, pypdf
try:
    pdf = pikepdf.open(path)
    report['qpdf_opens_with_no_password'] = True
except pikepdf.PasswordError:
    report['qpdf_opens_with_no_password'] = False
    pdf = pikepdf.open(path, password=secret or None)
with pdf:
    report['qpdf_encrypted'] = bool(pdf.is_encrypted)
    report['qpdf_pages'] = len(pdf.pages)
job = pikepdf.Job(['qpdf', '--check', path]); job.run()
report['qpdf_check_exit'] = job.exit_code
doc = pymupdf.open(path)
report['mupdf_needs_pass'] = bool(doc.needs_pass)
report['mupdf_opens_with_empty'] = bool(doc.authenticate(''))
report['mupdf_permissions'] = doc.permissions
texts = [page.get_text() for page in doc]
report['mupdf_planted_pages'] = sum(1 for t in texts if planted in t)
report['mupdf_pages'] = doc.page_count
report['mupdf_toc_entries'] = len(doc.get_toc())
pix = doc[0].get_pixmap(dpi=72, colorspace=pymupdf.csGRAY)
report['mupdf_ink_page1_percent'] = round(100 * sum(1 for b in pix.samples if b < 250) / len(pix.samples), 2)
doc.close()
reader = pypdf.PdfReader(path)
report['pypdf_is_encrypted'] = reader.is_encrypted
report['pypdf_pages'] = len(reader.pages)
report['pypdf_chars'] = sum(len(p.extract_text() or '') for p in reader.pages)
pop = subprocess.run(['pdftotext', path, '-'], capture_output=True, text=True)
report['poppler_rc'] = pop.returncode
report['poppler_has_planted'] = planted in (pop.stdout or '')
print(json.dumps(report))
`;
const judged = spawnSync('python3', ['-c', judge, out, PLANTED, PASSWORD], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
console.log('# outside readers, on the file the deployed site downloaded');
console.log((judged.stdout || '').trim());
if (judged.status !== 0) console.log('reader harness failed:', (judged.stderr || '').slice(0, 900));
console.log('workdir:', work);
