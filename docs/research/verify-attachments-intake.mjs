// Which enclosures does `add-attachments`'s own picker accept? One at a time.
//
//   BASE=... PDF=... node docs/research/verify-attachments-intake.mjs
//
// The deployed run chose three files and the pane reported "2 files chosen": the one
// with a non-ASCII name never appeared. This isolates that — same picker, one file
// per pass — and reports the names of every field the rail actually renders, since the
// note field (`description`) was not on the page either.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'https://www.browsersnip.com';
const PDF = process.env.PDF;
const work = mkdtempSync(join(tmpdir(), 'attach-intake-'));
const cases = [
  ['plain.txt', Buffer.from('plain ascii name\n', 'utf8')],
  ['notes-éè.txt', Buffer.from('non-ascii name α\n', 'utf8')],
  ['spaced name.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/7AAAAABJRU5ErkJggg==', 'base64')],
  ['résumé-final.PDF', Buffer.from('%PDF-1.4\n%%EOF\n', 'utf8')],
  ['unicode-中文.docx', Buffer.from('PK\x03\x04 bytes\n', 'utf8')],
];

const h = await open();
const rootId = async () => (await h.send('DOM.getDocument', { depth: -1 })).root.nodeId;
await h.send('Page.navigate', { url: `${BASE}/#/tool/add-attachments` });
await h.wait(`!!document.querySelector('input[type=file]')`, 60000);
const intakeRoot = await rootId();
await h.ev(`(() => { const i = [...document.querySelectorAll('input[type=file]')].find((x) => !x.closest('[role=group]')); if (i) i.setAttribute('data-probe-doc','1'); return !!i; })()`);
const docField = await h.send('DOM.querySelector', { nodeId: intakeRoot, selector: 'input[data-probe-doc]' });
await h.send('DOM.setFileInputFiles', { nodeId: docField.nodeId, files: [PDF] });
await sleep(18000);
console.log('fields rendered by the rail:', await h.ev(`JSON.stringify({
  ids: [...document.querySelectorAll('[id^=tool-field-]')].map((el) => el.id + ':' + el.tagName.toLowerCase() + (el.type ? '/' + el.type : '')),
  groups: [...document.querySelectorAll('[role=group]')].map((g) => g.getAttribute('aria-label')),
})`));

for (const [name, bytes] of cases) {
  const path = join(work, name);
  writeFileSync(path, bytes);
  const marked = await h.ev(`(() => {
    const group = [...document.querySelectorAll('[role=group]')]
      .find((g) => /files to attach/i.test(g.getAttribute('aria-label') || ''));
    const input = group?.querySelector('input[type=file]');
    if (!input) return 'no picker';
    input.setAttribute('data-probe-target', '1');
    return 'marked';
  })()`);
  if (marked !== 'marked') { console.log(`${name}: ${marked}`); continue; }
  const found = await h.send('DOM.querySelector', { nodeId: await rootId(), selector: 'input[data-probe-target]' });
  await h.send('DOM.setFileInputFiles', { nodeId: found.nodeId, files: [path] });
  await h.ev(`(() => { const i = document.querySelector('input[data-probe-target]');
    i.dispatchEvent(new Event('change', { bubbles: true })); i.removeAttribute('data-probe-target'); return 1; })()`);
  await sleep(900);
  const readBack = await h.ev(`(() => {
    const group = [...document.querySelectorAll('[role=group]')]
      .find((g) => /files to attach/i.test(g.getAttribute('aria-label') || ''));
    return (group?.innerText || '').replace(/\\n/g, ' / ').slice(0, 200);
  })()`);
  console.log(`chose ${JSON.stringify(name)} (${bytes.length}B) → picker says: ${readBack}`);
}
console.log('workdir:', work);
h.chrome.kill('SIGKILL');
process.exit(0);
