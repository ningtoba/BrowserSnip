/**
 * Live proof: is a file `protect` downloads from the deployed site really ciphered?
 *
 * The site is the product, and the row's own history is a card that described a
 * dictionary rather than the bytes (`AES-256` over plaintext streams, then an
 * honest `/None` gate that poppler read without asking and Ghostscript collapsed to
 * one page of three). So this drives the deployed app exactly as a person does —
 * dashboard → Protect → drop a file → type the two passwords → Protect → Download —
 * and hands the download to readers that share no code with it, asked **both
 * ways**: with no secret offered, and with the password that was just typed.
 *
 * The verdict is not "the card said AES-128". It is:
 *
 *   · every reader refuses the *content* without the password — MuPDF will not
 *     load a page, poppler exits `Incorrect password`, qpdf raises
 *     `PasswordError`, pypdf answers `decrypt('') = 0`, Ghostscript writes no page;
 *   · every one of them returns the planted sentence, exactly, with it;
 *   · `qpdf --check` is clean on the file;
 *   · the dictionary MuPDF names is `128-bit AES`, not `None`.
 *
 *   node scripts/live-protect-proof.mjs [BASE]
 *
 * Env: `CHROME` (a Chrome-family binary), `USER_PASSWORD`, `OWNER_PASSWORD`,
 * `CIPHER` (`AES-128` or `AES-256`; unset leaves the control at its default),
 * `PAGES`, `PORT`. Needs `python3` with `pymupdf` and `pikepdf`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The pdf-lib fork ships no Node-usable `exports` map, so the CommonJS entry has
// to be reached through `createRequire` (see scripts/live-blank-chain-proof.mjs).
const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts, rgb } = require('@maxwbh/pdf-lib');

const CHROME = process.env.CHROME
  ?? '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.argv[2] ?? process.env.BASE ?? 'https://www.browsersnip.com';
const PORT = Number(process.env.PORT ?? 9433);
const PAGES = Number(process.env.PAGES ?? 3);
const USER_PASSWORD = process.env.USER_PASSWORD ?? 'open-sesame';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD ?? 'owner-key';
const CIPHER = process.env.CIPHER ?? '';
const WORDS = 'Secret Alice 42 Bravo';
const work = mkdtempSync(join(tmpdir(), 'live-protect-'));

/** The fixture: one planted sentence per page, named so a lost page is visible. */
async function buildFixture() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < PAGES; index++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`${WORDS} on page ${index + 1}`, { x: 60, y: 700, size: 18, font, color: rgb(0, 0, 0) });
  }
  doc.setTitle('Live protect proof');
  const bytes = await doc.save({ useObjectStreams: false });
  const path = join(work, 'claim.pdf');
  writeFileSync(path, bytes);
  return path;
}

const fixture = await buildFixture();
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-protect-'))}`,
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

// `pattern` is a source string: `JSON.stringify` turns a RegExp into `{}`. The
// shortest element whose text matches wins, and the click lands on the nearest
// interactive ancestor — the form's toggles are switches, not buttons.
const clickText = (pattern, what) => raw(`(() => {
  const re = new RegExp(${JSON.stringify(pattern)}, 'i');
  const matches = [...document.querySelectorAll('button, a, input, [role], label, span, p')]
    .filter((n) => re.test((n.innerText || n.textContent || n.getAttribute('aria-label') || '').trim()))
    .sort((a, b) => (a.innerText || a.textContent || '').length - (b.innerText || b.textContent || '').length);
  if (matches.length === 0) return 'MISSING:${what}';
  const leaf = matches[0];
  const el = leaf.closest('button, a, input, [role=switch], [role=checkbox], label') || leaf;
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  if (el instanceof HTMLInputElement && el.type === 'checkbox') el.click();
  return 'clicked <' + el.tagName.toLowerCase() + '> ' + (el.innerText || el.getAttribute('aria-label') || el.type || '').trim().slice(0, 40);
})()`);

/**
 * Type into a React-controlled field.
 *
 * The field renderer stamps every input with `tool-field-<key>`, so a box is
 * identified by that id and not by its words: the owner field's own placeholder is
 * "Blank reuses the open password", and matching on text typed the wrong one.
 *
 * Setting the value directly leaves React's own state untouched — the input
 * renders the password back out and the run starts with an empty one — so the
 * native setter is called and an input event dispatched. The event has to be an
 * InputEvent carrying the text: a bare Event is not the one React's synthetic
 * onChange recognises, and the field repaints itself empty.
 */
const typeInto = (which, value) => raw(`(() => {
  const wanted = ${JSON.stringify(which)};
  const labelFor = (el) => {
    const labelled = el.id && document.querySelector('label[for="' + el.id + '"]');
    return ((labelled?.innerText || el.getAttribute('aria-label') || el.placeholder || '') + '').trim();
  };
  // The owner box is not on the panel until the mode needs it, and the dashboard
  // keeps other tools' password fields in the DOM — an earlier version typed into
  // one of those, ran with an empty open password, and every outside reader then
  // refused a file the harness had never gated. So: by id, and reported honestly
  // when the id is not there rather than matched on words.
  const id = wanted.toLowerCase().startsWith('open') ? 'tool-field-userPassword' : 'tool-field-ownerPassword';
  const el = document.getElementById(id);
  if (!el) {
    return 'no #' + id + ' on this page — password fields present: '
      + (([...document.querySelectorAll('input[type=password]')]
        .map((f) => f.id || labelFor(f) || 'unlabelled').join(' | ')) || '(none)');
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  el.focus();
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(value)} }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  // Reported from what was looked up and what was handed over, not from the node
  // afterwards: React re-renders on the input event and may hand this very DOM node
  // to another field, which made an earlier version print the owner id for a write
  // into the open-password box. The "fields after" line below is the read-back.
  return 'typed ' + wanted + ' → #' + id + (el.offsetParent === null ? ' (in the DOM, not on screen)' : '');
})()`);

/** Every password field's label and current value, so "did it take" is read back. */
const fieldState = () => said(`(() => {
  const labelFor = (el) => {
    const labelled = el.id && document.querySelector('label[for="' + el.id + '"]');
    return ((labelled?.innerText || el.getAttribute('aria-label') || el.placeholder || '') + '').trim();
  };
  return [...document.querySelectorAll('input[type=password]')]
    .filter((f) => f.offsetParent !== null)
    .map((f, i) => i + ':' + (f.id || labelFor(f) || 'unlabelled') + '=' + JSON.stringify(f.value)).join(' · ') || '(none)';
})()`);

/**
 * Choose the Cipher control, when the run is asked to.
 *
 * Same rule as the password boxes: address it by the id the field renderer stamps
 * (`tool-field-cipher`), write through the prototype's setter so React's own state
 * moves and not just the DOM's, and report the value and option text read back off
 * the live panel. A proof that named the strength the *harness* meant, while the
 * select still showed the default, would be worth nothing.
 */
const pickCipher = (value) => raw(`(() => {
  const el = document.getElementById('tool-field-cipher');
  if (!el) {
    return 'no #tool-field-cipher on this page; selects present: '
      + ([...document.querySelectorAll('select')].map((s) => s.id || s.getAttribute('aria-label') || 'unlabelled').join(' | ') || '(none)');
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  el.focus();
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'cipher → #' + el.id + ' = ' + JSON.stringify(el.value)
    + ' (option: ' + JSON.stringify(el.options[el.selectedIndex]?.text ?? '') + ')';
})()`);

await send('Runtime.enable');
await send('Page.enable');
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: work });
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

console.log(`# ${BASE} · protect · user ${JSON.stringify(USER_PASSWORD)} · cipher ${JSON.stringify(CIPHER || '(control default)')}`);
await send('Page.navigate', { url: `${BASE}/#/pdf` });
await sleep(6000);
// Storage is cleared on a fresh document, so the queue a previous run left behind
// is dropped by loading the page a second time.
await send('Storage.clearDataForOrigin', { origin: new URL(BASE).origin, storageTypes: 'all' });
await send('Page.navigate', { url: 'about:blank' });
await sleep(1500);
await send('Page.navigate', { url: `${BASE}/#/pdf` });
await sleep(7000);
console.log('card:', (await clickText('Protect PDF', 'protect-card')).value);
await sleep(5000);

const doc = await send('DOM.getDocument', { depth: -1 });
const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' });
if (!input.result?.nodeId) { console.log('NO FILE INPUT; body:', await said('document.body.innerText.slice(0,600)')); chrome.kill(); process.exit(1); }
await send('DOM.setFileInputFiles', { nodeId: input.result.nodeId, files: [fixture] });
console.log('file in:', fixture);
await sleep(20000);
// `mode` defaults to "Both", which is the case this proof is for: an open password
// that gates reading and an owner password that lifts the restrictions.
console.log('mode is the default "Both"; fields before:', await fieldState());
console.log((await typeInto('Open password', USER_PASSWORD)).value);
console.log((await typeInto('Owner password', OWNER_PASSWORD)).value);
if (CIPHER) console.log('cipher      :', (await pickCipher(CIPHER)).value);
await sleep(1000);
console.log('fields after    :', await fieldState());
console.log('selects after   :', await said(`[...document.querySelectorAll('select')]
  .filter((s) => s.offsetParent !== null)
  .map((s) => (s.id || 'unlabelled') + '=' + JSON.stringify(s.value)).join(' · ') || '(none)'`));
console.log('run:', (await clickText('^Protect$', 'protect-action')).value);

let card = '';
for (let tick = 0; tick < 60; tick++) {
  await sleep(2000);
  card = await said(`(() => {
    const line = document.body.innerText.split('\\n').find((l) => /Protected with|ciphered|password reader|no independent reader/i.test(l));
    return line ?? '';
  })()`);
  if (card) break;
}
console.log('result card:', card);
const warnings = await said(`(() => {
  const t = document.body.innerText;
  const hits = t.split('\\n').filter((l) => /warn|check the copy|refused|did not|could not/i.test(l));
  return hits.slice(0, 6).join(' / ') || '(no warning line in view)';
})()`);
console.log('warnings    :', warnings);
console.log('download:', (await clickText('^(Download|Save PDF|Download PDF)', 'download')).value);

let produced = null;
for (let tick = 0; tick < 40; tick++) {
  await sleep(1000);
  const found = readdirSync(work).filter((name) => name.endsWith('.pdf') && name !== 'claim.pdf');
  const pdf = found.map((name) => join(work, name)).find((path) => readFileSync(path).subarray(0, 5).toString('latin1') === '%PDF-');
  if (pdf) { produced = pdf; break; }
}
if (!produced) { console.log('NOTHING DOWNLOADED'); chrome.kill(); process.exit(1); }
const out = join(work, 'deployed-protected.pdf');
writeFileSync(out, readFileSync(produced));
console.log('downloaded:', out, `${readFileSync(out).length} bytes`);
ws.close();
chrome.kill();

// The judgement is the row's own rig, not a new one: `protect-readers.py` asks
// MuPDF, poppler, qpdf, pypdf and Ghostscript the same four questions of the
// downloaded bytes — opens, gate, planted text, `/P` — and tries the empty
// password before the real one, which is the "both ways" the row is judged on.
const judged = spawnSync('python3', ['docs/research/protect-readers.py', work, WORDS, USER_PASSWORD],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
console.log('# outside readers, on the file the deployed site downloaded');
console.log(judged.stdout || '');
if (judged.status !== 0) console.log('reader harness failed:', (judged.stderr || '').slice(0, 800));
console.log('workdir:', work);
