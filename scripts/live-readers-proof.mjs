/**
 * Live proof: the two readers, on files MuPDF and libqpdf wrote, on the **deployed** site.
 *
 * `docs/research/readers-foreign-repro.md` measured this in Node, through the shipped
 * modules. This drives `https://www.browsersnip.com` the way a person does — headless
 * Chrome over CDP, drop the file on the tool's own card, press the button, keep the
 * download — and then judges what came back with readers that share no code with the app.
 *
 * Three probes, all on foreign fixtures from `tests/fixtures/readers/`:
 *
 *   report  `/tool/bookmarks`, `outlines-dests-ref.pdf`, empty box = "show me what is
 *           there". The sentence is the reader's own answer: before `7d1d1ad` it counted
 *           all three entries as **"without a page"**, because their destinations sat
 *           behind references.
 *   rotate  `/tool/rotate` on `labels-kids-mixed.pdf` — a page-labels round trip that
 *           does not touch the labels. MuPDF must read the same six labels out of the
 *           download as it reads out of the upload, and the `/Kids` store must still be
 *           in the file. This is the answer to "does a misread rewrite the document":
 *           no writer consults `readPageLabels`, and the bytes say so.
 *   replace `/tool/add-page-labels` on `labels-nums-r.pdf`, default ranges — the one
 *           sentence in the app that quotes `readPageLabels` back at the user ("The
 *           first 4 pages now read: …"), set against the numbering the download
 *           actually carries.
 *   copy    `/tool/extract-pages` on `outlines-names-dests-kids-ref.pdf` — the
 *           read-modify-write damage. Before the fix every bookmark came back as a
 *           caption: 3 items naming a destination in, **0 out**, while the run reported
 *           carrying three.
 *   label-copy
 *           `/tool/extract-pages` on `labels-kids-mixed.pdf` with `Pages: 4-6` — the
 *           numbering across a subset copy. MuPDF and pypdf must read `II, c, xA` out
 *           of the download, whose catalogue then holds `/Nums x3`; before the carry it
 *           read `1, 2, 3` out of a file with **no label store at all**.
 *
 *     node scripts/live-readers-proof.mjs [BASE]
 *
 * Env: `CHROME`, `PROBES` (comma list, default `report,rotate,replace,copy,label-copy`),
 * `PORT`. Needs `python3` with `pymupdf`, `pypdf`, `pikepdf`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME
  ?? '/home/nekophobia/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const BASE = process.argv[2] ?? process.env.BASE ?? 'https://www.browsersnip.com';
const PORT = Number(process.env.PORT ?? 9461);
const PROBES = (process.env.PROBES ?? 'report,rotate,replace,copy,label-copy').split(',').filter(Boolean);
const FIXTURES = 'tests/fixtures/readers';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-readers-'))}`,
  'about:blank',
], { stdio: 'ignore' });

let ws;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((tab) => tab.type === 'page');
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch { /* chrome is still starting */ }
  await sleep(500);
}
if (!ws) { console.log('no CDP page target'); chrome.kill(); process.exit(1); }
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let nextId = 1;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (message) => {
  let msg;
  try { msg = JSON.parse(message.data); } catch { return; }
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push((msg.params.exceptionDetails?.exception?.description ?? '').slice(0, 140));
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
  return result.error ? `ERR ${String(result.error).slice(0, 140)}` : String(result.value);
};
/** Exact-label click; a substring match has clicked the wrong card before. */
const click = (labels) => raw(`(() => {
  const wanted = ${JSON.stringify(labels)};
  const nodes = [...document.querySelectorAll('button, a [role=button], a')]
    .map((el) => ({ el, text: (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim() }))
    .filter(({ el, text }) => el.offsetParent !== null && wanted.some((w) => text === w || text.startsWith(w + ' ')));
  if (nodes.length === 0) {
    return 'MISSING ' + wanted.join('/') + '; on screen: ' + [...document.querySelectorAll('button')]
      .map((b) => JSON.stringify((b.innerText || '').trim())).filter((t) => t !== '""').join(' ').slice(0, 260);
  }
  const { el, text } = nodes[0];
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  el.click?.();
  return 'clicked <' + el.tagName.toLowerCase() + '> ' + text.slice(0, 40);
})()`).then((hit) => hit.value ?? `ERR ${String(hit.error).slice(0, 140)}`);

/** Type into a tool field by its group's own accessible name.
 *
 *  The rail folds every field but its lead one behind "▸ N more options", so the
 *  group is not in the DOM until that is opened — clicking it first is what makes the
 *  lookup work, and the failure is printed rather than swallowed because a probe that
 *  silently kept the default is a probe that measured the wrong run.
 */
const openMoreOptions = () => raw(`(() => {
  const fold = [...document.querySelectorAll('button')]
    .find((b) => b.offsetParent !== null && /more options?/i.test(b.innerText || ''));
  if (!fold) return 'no fold on screen';
  fold.click();
  return 'opened ' + fold.innerText.trim().slice(0, 30);
})()`).then((hit) => hit.value ?? `ERR ${String(hit.error).slice(0, 140)}`);

const typeField = (label, value) => raw(`(() => {
  const group = document.querySelector('[role=group][aria-label=${JSON.stringify(label)}]');
  let field = group
    && (group.querySelector('textarea') || group.querySelector('input:not([type=checkbox]):not([type=radio])'));
  if (!field) {
    // A "pages" control is labelable rather than a group: its caption is a label
    // element pointing at the input, and that is the only way the probe can name it.
    // The caption is styled uppercase and innerText reports what is rendered, so the
    // comparison ignores case — a probe that quietly found nothing would type into no
    // field at all and then report a whole-document run as if it had been a subset.
    const wanted = ${JSON.stringify(label)}.toLowerCase();
    const caption = [...document.querySelectorAll('label')].find(
      (el) => (el.innerText || el.textContent || '').trim().toLowerCase() === wanted && el.htmlFor);
    field = caption ? document.getElementById(caption.htmlFor) : null;
  }
  if (!field) return 'no field for group ' + ${JSON.stringify(label)};
  const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, ${JSON.stringify(value)});
  field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(value)} }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  return 'typed ' + JSON.stringify(${JSON.stringify(value)}) + ' into ' + field.tagName.toLowerCase()
    + ' in ' + (field.closest('[role=group]')?.getAttribute('aria-label')
      ?? 'the ' + ${JSON.stringify(label)} + ' field');
})()`).then((hit) => hit.value ?? `ERR ${String(hit.error).slice(0, 140)}`);

const bodyLine = (pattern) => said(`(() => {
  const re = ${pattern};
  const hit = document.body.innerText.split('\\n').find((l) => re.test(l));
  return hit ?? '';
})()`);

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

const bundle = await (await fetch(BASE)).text();
console.log(`# ${BASE}`);
console.log('bundle:', bundle.match(/assets\/index-[\w-]+\.js/)?.[0] ?? '(no index chunk in the HTML)');

const judge = `
import hashlib, json, sys
import pikepdf, pymupdf, pypdf
out = {}
for tag, path in zip(sys.argv[1::2], sys.argv[2::2]):
    doc = pymupdf.open(path)
    report = {
        'bytes': len(open(path, 'rb').read()),
        'sha256': hashlib.sha256(open(path, 'rb').read()).hexdigest(),
        'pages': doc.page_count,
        'mupdf_labels_per_page': [page.get_label() for page in doc],
        'mupdf_label_ranges': doc.get_page_labels(),
        'mupdf_toc': doc.get_toc(),
        'planted_pages': sum(1 for page in doc if 'Lighthouse Inventory 1887' in page.get_text()),
    }
    doc.close()
    reader = pypdf.PdfReader(path)
    report['pypdf_labels'] = list(reader.page_labels)
    def walk(items):
        found = []
        for item in items:
            if isinstance(item, list):
                found.extend(walk(item)); continue
            try:
                found.append([getattr(item, 'title', None), reader.get_destination_page_number(item)])
            except Exception:
                found.append([getattr(item, 'title', None), None])
        return found
    try:
        report['pypdf_outline'] = walk(reader.outline)
    except Exception as error:
        report['pypdf_outline'] = [['ERR', type(error).__name__]]
    with pikepdf.open(path) as pdf:
        tree = pdf.Root.get('/PageLabels')
        report['label_store'] = ('absent' if tree is None else
                                 '/Nums x%d' % (len(tree['/Nums']) // 2) if '/Nums' in tree else
                                 '/Kids x%d' % len(tree['/Kids']) if '/Kids' in tree else 'other')
        root = pdf.Root.get('/Outlines')
        named, total = 0, 0
        if root is not None and '/First' in root:
            stack = [root['/First']]
            while stack:
                node = stack.pop()
                item = node.get_object() if hasattr(node, 'get_object') else node
                if isinstance(item, pikepdf.Dictionary):
                    total += 1
                    if any(k in item for k in ('/Dest', '/Destination', '/A')):
                        named += 1
                    for key in ('/First', '/Next'):
                        child = item.get(key)
                        if child is not None:
                            stack.append(child)
        report['outline_items_total'] = total
        report['outline_items_naming_a_target'] = named
    out[tag] = report
print(json.dumps(out, ensure_ascii=False))
`;

const work = mkdtempSync(join(tmpdir(), 'live-readers-'));
const results = [];

const runProbe = async ({ tag, tool, fixture, fill, action, download }) => {
  const local = join(work, fixture);
  if (!existsSync(join(FIXTURES, fixture))) {
    console.log(`${tag}: missing ${fixture}`);
    return null;
  }
  copyFileSync(join(FIXTURES, fixture), local);
  const dir = mkdtempSync(join(tmpdir(), 'live-readers-dl-'));
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
  await send('Page.navigate', { url: `${BASE}/#/tool/${tool}` });
  for (let tick = 0; tick < 40; tick++) {
    await sleep(2000);
    if (await said('!!document.querySelector("input[type=file]")') === 'true') break;
  }
  const doc = await send('DOM.getDocument', { depth: -1 });
  const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type=file]' });
  if (!input.result?.nodeId) {
    console.log(`${tag}: NO FILE INPUT; body:`, await said('document.body.innerText.slice(0,400)'));
    return null;
  }
  const uploads = [local];
  await send('DOM.setFileInputFiles', { nodeId: input.result.nodeId, files: uploads });
  let intake = '';
  for (let tick = 0; tick < 30; tick++) {
    await sleep(2000);
    intake = await bodyLine('/pages|Page|bookmark|Loaded|ready/i');
    if (intake) break;
  }
  console.log(`\n## ${tag} — /tool/${tool} · ${fixture}`);
  console.log('intake :', intake.slice(0, 200));
  if (fill) {
    console.log('fold   :', await openMoreOptions());
    await sleep(1500);
  }
  for (const [label, value] of fill ?? []) {
    const typed = await typeField(label, value);
    console.log('field  :', typed);
    if (/^no field/.test(typed)) { console.log('ABORT: the field the probe needs was not found'); return null; }
  }
  await sleep(1500);
  console.log('run    :', await click([action]));
  // The sentence the run leaves on screen, read out of the page in Node rather than in
  // an injected script: it is the claim being compared with the bytes, so it is kept
  // verbatim.
  let message = '';
  for (let tick = 0; tick < 45; tick++) {
    await sleep(2000);
    const body = await said('document.body.innerText');
    const lines = String(body).split('\n').map((line) => line.trim()).filter(Boolean);
    const hits = lines.filter((line) =>
      /bookmark|label|Rotated|Extracted|Merged|without a page|no page target|error|refus|Applied|Found/i.test(line)
      && !/^Edit Bookmarks$|^Add Page Labels$|^Rotate PDF$|^Merge PDFs$/.test(line));
    message = hits.join(' ⏎ ');
    if (message) break;
  }
  console.log('result :', message.slice(0, 500) || '(nothing on screen)');
  if (!download) return { tag, file: local };
  console.log('down   :', await click(['Download', 'Download PDF', 'Save PDF']));
  let produced = null;
  for (let tick = 0; tick < 45; tick++) {
    await sleep(1000);
    const found = readdirSync(dir).filter((name) => name.endsWith('.pdf'));
    if (found.length) { produced = join(dir, found[0]); break; }
  }
  if (!produced) {
    console.log('NOTHING DOWNLOADED; body:', await said('document.body.innerText.slice(0,700)'));
    return null;
  }
  const kept = join(work, `${tag}__${fixture}`);
  writeFileSync(kept, readFileSync(produced));
  console.log('name   :', produced.split('/').pop(), `${readFileSync(kept).length} bytes`);
  return { tag, file: kept };
};

for (const tag of PROBES) {
  if (tag === 'report') {
    results.push(await runProbe({
      tag, tool: 'bookmarks', fixture: 'outlines-dests-ref.pdf', download: false,
      action: 'Save bookmarks',
    }));
  } else if (tag === 'rotate') {
    results.push(await runProbe({
      tag, tool: 'rotate', fixture: 'labels-kids-mixed.pdf', action: 'Rotate', download: true,
    }));
  } else if (tag === 'replace') {
    // The same file through the tool that *replaces* the numbering, on its own default
    // ranges, so the card's "now read:" sentence can be compared with what the download
    // really holds — the one place a page-label reader's answer reaches a user.
    results.push(await runProbe({
      tag: 'replace-labels', tool: 'add-page-labels', fixture: 'labels-nums-r.pdf',
      action: 'Apply labels', download: true,
    }));
  } else if (tag === 'copy') {
    // No field typed: `Pages` defaults to the whole document, and the point is the
    // copy itself — every page goes through `collectPages` and `carryPageFurniture`.
    results.push(await runProbe({
      tag, tool: 'extract-pages', fixture: 'outlines-names-dests-kids-ref.pdf',
      action: 'Extract', download: true,
    }));
  } else if (tag === 'label-copy') {
    // The subset case: pages 4-6 of a file whose six sheets are numbered
    // i, ii, I, II, c, xA. The download has to read II, c, xA — the one surviving
    // range re-based onto its own first sheet with /St moved with it. Before the
    // carry every reader said 1, 2, 3, because the copy wrote no /PageLabels at all
    // and a three-page result looked like a clean run.
    results.push(await runProbe({
      tag: 'subset-copy-labels', tool: 'extract-pages', fixture: 'labels-kids-mixed.pdf',
      fill: [['Pages', '4-6']], action: 'Extract', download: true,
    }));
  }
}

console.log('\nerrors:', JSON.stringify([...new Set(consoleErrors)].slice(0, 4)));
const pairs = results.filter(Boolean).flatMap((entry) => [entry.tag, entry.file]);
const judged = spawnSync('python3', ['-c', judge, ...pairs], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
console.log('# the readers that did not write the fixture, over what the deployed site produced');
console.log((judged.stdout || '').trim());
if (judged.status !== 0) console.log('judge failed:', (judged.stderr || '').slice(0, 600));
console.log('workdir:', work);
ws.close();
chrome.kill();
