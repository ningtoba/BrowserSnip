// Is the dropped enclosure the app's doing, or the harness's?
//
//   BASE=... PDF=... node docs/research/verify-attachments-names.mjs
//
// `DOM.setFileInputFiles` hands Chrome a *path*; this builds the same File in the page
// with `new File(...)` + `DataTransfer` and dispatches the change React listens for, so
// a name that survives here but not there is a CDP artefact, not a product truth. It
// also looks for the tool's `description` field, which the rail did not render under
// any `tool-field-*` id.
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'https://www.browsersnip.com';
const PDF = process.env.PDF;
const h = await open();
await h.send('Page.navigate', { url: `${BASE}/#/tool/add-attachments` });
await h.wait(`!!document.querySelector('input[type=file]')`, 60000);
await h.ev(`(() => { const i = [...document.querySelectorAll('input[type=file]')].find((x) => !x.closest('[role=group]'));
  if (i) i.setAttribute('data-probe-doc','1'); return !!i; })()`);
const { root } = await h.send('DOM.getDocument', { depth: -1 });
const docField = await h.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[data-probe-doc]' });
await h.send('DOM.setFileInputFiles', { nodeId: docField.nodeId, files: [PDF] });
await sleep(18000);

const names = ['plain.txt', 'notes-éè.txt', 'résumé-final.PDF', 'unicode-中文.docx', 'a&b#c.pdf'];
for (const name of names) {
  const said = await h.ev(`(() => {
    const group = [...document.querySelectorAll('[role=group]')]
      .find((g) => /files to attach/i.test(g.getAttribute('aria-label') || ''));
    const input = group?.querySelector('input[type=file]');
    if (!input) return 'no picker';
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3, 4, 5])], ${JSON.stringify(name)}, { type: 'application/octet-stream' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return 'dispatched ' + input.files[0].name;
  })()`);
  await sleep(700);
  const readBack = await h.ev(`(() => {
    const group = [...document.querySelectorAll('[role=group)')] || [];
    return '';
  })()`);
  void readBack;
  const shown = await h.ev(`(() => {
    const group = [...document.querySelectorAll('[role=group]')]
      .find((g) => /files to attach/i.test(g.getAttribute('aria-label') || ''));
    return (group?.innerText || '').replace(/\\n/g, ' / ').slice(0, 160);
  })()`);
  console.log(`in-page ${JSON.stringify(name)} → ${said} → picker: ${shown}`);
}

console.log('description field:', await h.ev(`(() => {
  const byId = document.getElementById('tool-field-description');
  const byPlaceholder = [...document.querySelectorAll('input, textarea')]
    .find((el) => /enclosure|note stored|what this/i.test(el.placeholder || ''));
  const labels = [...document.querySelectorAll('label')].map((l) => l.innerText.trim()).filter(Boolean);
  return JSON.stringify({ byId: !!byId, byPlaceholder: byPlaceholder ? byPlaceholder.tagName + ':' + byPlaceholder.placeholder : null,
    labels: labels.slice(0, 12), textInputs: [...document.querySelectorAll('input[type=text], textarea')].map((el) => el.id || el.placeholder || el.name).slice(0, 12) });
})()`));
h.chrome.kill('SIGKILL');
process.exit(0);
