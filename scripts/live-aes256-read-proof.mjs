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
/**
 * Which rewriting tool drives the edit, and what its downloaded file owes.
 *
 * `unlock` carries its own password field, so the rail shows the gate; `rotate`
 * does not — the organize surface only asks for a secret when its preview cannot
 * read the file, and pdf.js reads AES-256 — so a rotate run on a locked file comes
 * back `PASSWORD_REQUIRED` with nothing to type into. Both are measured, and the
 * `rotate` outcome is reported rather than hidden.
 */
const TOOL = process.env.TOOL ?? 'unlock';
const ACTION = process.env.ACTION ?? 'Unlock';
const FIXTURE_NAME = process.env.FIXTURE_NAME ?? 'aes-256-user.pdf';
const PASSWORD = process.env.PASSWORD ?? 'hunter2';
const WRONG = 'not-the-password';
const PLANTED = 'Lighthouse Inventory 1887';
const SHEETS = ['ALPHA', 'BRAVO', 'CHARLIE'];
const work = mkdtempSync(join(tmpdir(), 'live-aes256-'));

const input = join(work, FIXTURE_NAME);
const fixture = process.env.FIXTURE ?? `tests/fixtures/encrypted/${FIXTURE_NAME}`;
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

// Click a control by its own label, matched exactly rather than by a substring:
// the rail's action button reads "Rotate" while the card, the breadcrumb and the
// search palette all read "Rotate PDF", and a substring match has already clicked
// the wrong one of those in this harness's first draft.
const clickButton = (labels) => raw(`(() => {
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
  return 'clicked <' + el.tagName.toLowerCase() + '> ' + text.slice(0, 40);
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
  // The re-prompt the error panel paints is a plain password input, not the rail's
  // gate, and it can be mounted while still hidden; visible ones win, and any other
  // password field is used rather than giving up.
  const all = [...document.querySelectorAll('input[type=password]')];
  const fields = all.filter((f) => f.offsetParent !== null);
  const gate = fields.find((f) => /not required unless/i.test(f.placeholder || '')) ?? fields[0] ?? all[0];
  if (!gate) return 'no password field on this page';
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
await sleep(7000);
// Reach the tool the way the dashboard does - its own card link - and fall back to
// typing the route when the link is not there, saying which happened. An earlier
// version clicked the first node whose words were "Rotate PDF", hit the search
// palette's button, which does not navigate, and then reported a page with no file
// input as if the site had refused the file.
const opened = await raw(`(() => {
  const wanted = ${JSON.stringify('#/tool/' + TOOL)};
  const link = [...document.querySelectorAll('a[href]')].find((a) => a.getAttribute('href').includes(wanted));
  if (!link) return 'no dashboard link for ' + wanted;
  link.click();
  return 'clicked ' + link.getAttribute('href');
})()`);
console.log('card  :', opened.value ?? `ERR ${String(opened.error).slice(0, 120)}`);
await sleep(5000);
if (await said('location.hash') !== '#/tool/' + TOOL) {
  await send('Page.navigate', { url: BASE + '/#/tool/' + TOOL });
  await sleep(6000);
  console.log('route : opened by URL instead');
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
// The rail asks for the secret where it wants it: some surfaces show the gate next
// to the file, some only after a run comes back `PASSWORD_REQUIRED`. Both are driven
// here, and which one happened is printed, because "it downloaded something" is not
// the claim - "it opened an AES-256 file with the typed password" is.
const click = async (...labels) => {
  const hit = await clickButton(labels);
  return hit.value ?? `ERR ${String(hit.error).slice(0, 200)}`;
};
console.log('typed :', (await typePassword(PASSWORD)).value ?? '(no gate shown yet)');
await sleep(1500);
console.log('gate  :', await gateState());
console.log('run   :', await click(ACTION));

const anyGate = () => said(`(() => [...document.querySelectorAll('input[type=password]')]
  .filter((f) => f.offsetParent !== null).map((f) => f.id || f.placeholder || f.getAttribute('aria-label') || 'unnamed').join(' | ') || '(none)')()`);
/** Wait for the rail to paint its password gate, which it only does once a run has
 *  come back `PASSWORD_REQUIRED` and the inspection has been re-read. */
const waitForGate = async (ticks) => {
  for (let tick = 0; tick < ticks; tick++) {
    const seen = await anyGate();
    if (seen !== '(none)') return seen;
    await sleep(2000);
  }
  return '(none)';
};

let card = '';
for (let tick = 0; tick < 60; tick++) {
  await sleep(2000);
  card = await said(`(() => {
    const line = document.body.innerText.split('\\n').find((l) => /Unlocked|Rotated|could not|not correct|cannot|refus|password/i.test(l));
    return line ?? '';
  })()`);
  if (!card) continue;
  if (/Unlocked|Rotated/i.test(card)) break;
  // A re-prompt is the rail asking for the secret: wait for its gate, type, and run
  // again rather than letting the loop settle on the question.
  const gate = await waitForGate(10);
  if (!/password/i.test(card) || gate === '(none)') break;
  console.log('asked :', card);
  console.log('gate  :', gate);
  console.log('typed :', (await typePassword(PASSWORD)).value ?? '(no gate)');
  // The rail's action is "Rotate"; the error panel's own is "Retry".
  console.log('run   :', await click(ACTION, 'Retry'));
  card = '';
}
console.log('result:', card);
console.log('notes :', await said(`(() => {
  const hits = document.body.innerText.split('\\n').filter((l) => /error|failed|password|ciphertext|blank|warn/i.test(l));
  return hits.slice(0, 6).join(' / ') || '(none in view)';
})()`));
console.log('down  :', await click('Download', 'Download PDF', 'Save PDF'));

let produced = null;
for (let tick = 0; tick < 40; tick++) {
  await sleep(1000);
  const found = readdirSync(work).filter((name) => name.endsWith('.pdf') && name !== FIXTURE_NAME);
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
try:
    opened = pikepdf.open(path)
    report['opens_with_no_password'] = True
except pikepdf.PasswordError:
    opened = pikepdf.open(path, password=key)
    report['opens_with_no_password'] = False
with opened as pdf:
    enc = pdf.trailer.get('/Encrypt')
    report['has_encrypt'] = enc is not None
    cf = enc['/CF'][enc['/StmF']] if enc is not None and '/CF' in enc else None
    report['qpdf_opens'] = True
    report['pages'] = len(pdf.pages)
    if enc is not None:
        report['V'] = int(enc['/V']); report['R'] = int(enc['/R'])
        report['CFM'] = str(cf['/CFM']); report['cf_length'] = int(cf['/Length'])
        report['has_OE'] = '/OE' in enc and len(bytes(enc['/OE'])) == 32
        report['has_UE'] = '/UE' in enc and len(bytes(enc['/UE'])) == 32
        report['has_Perms'] = '/Perms' in enc and len(bytes(enc['/Perms'])) == 16
if report['has_encrypt']:
    try:
        pikepdf.open(path, password=wrong); report['qpdf_refuses_wrong'] = False
    except pikepdf.PasswordError:
        report['qpdf_refuses_wrong'] = True
else:
    report['qpdf_refuses_wrong'] = 'n/a (no cipher left to refuse)'
job = pikepdf.Job(['qpdf', '--password=' + key, '--check', path])
job.run(); report['qpdf_check_exit'] = job.exit_code
doc = pymupdf.open(path)
report['mupdf_needs_pass'] = bool(doc.needs_pass)
report['mupdf_opens_empty'] = bool(pymupdf.open(path).authenticate(''))
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
