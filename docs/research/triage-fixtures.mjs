// Triage fixtures — the input set the whole-catalogue sweep drives every tool with.
//
//   node docs/research/triage-fixtures.mjs [--dir /tmp/triage]
//
// Nothing here reinvents a fixture. The four generators the campaign built for
// specific defects are re-run into one directory (`colour.pdf` from
// `colour-fixture.mjs`, `ink.pdf`/`rot90.pdf` from `rasterize-fixture.mjs`,
// `sheets.pdf` from `pdf-to-image-fixture.mjs`, `a.pdf`/`b.pdf`/`blank.pdf` from
// `compare-fixture.mjs`, `skewed*.pdf` from `deskew-fixture.mjs`,
// `planted.pdf` from `ocr-fixture.mjs`) because each was written to discriminate
// for a real defect: a text page, a photograph page, a one-hairline page, a blank
// page, five different page boxes, a planted-difference pair, a turned sheet.
// `triage-fixtures-images.py` adds the inputs a PDF generator cannot be (real
// rasters, a video clip, and PDFs carrying one kind of furniture each).
//
// The rest of this file writes the convert-to inputs. Their containers come from
// `tests/pdf/convert-to-harness.ts` — the same builders the byte tests use — so a
// DOCX/XLSX/PPTX/EPUB/ODF/XPS/CBZ/TIFF/PSD fixture here is byte-for-byte the shape
// the app's readers are already known to accept, and a refusal on the deployed site
// means the tool, not the file.
//
// Each tool's own input is chosen by `triage-spec.mjs`, which reads this inventory.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const REPO = join(import.meta.dirname, '..', '..');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};

const DIR = arg('dir', '/tmp/triage');
const IN = join(DIR, 'in');
mkdirSync(IN, { recursive: true });

/** Rerun an existing campaign generator into this directory. */
function reuse(script, extra = []) {
  const out = spawnSync(process.execPath, [join('docs', 'research', script), '--dir', DIR, ...extra], {
    cwd: REPO,
    encoding: 'utf8',
  });
  if (out.status !== 0) {
    throw new Error(`${script} failed: ${(out.stderr || out.stdout).slice(0, 400)}`);
  }
  return (out.stdout || '').trim().split('\n').at(-1) ?? '';
}

// ── the campaign's own fixtures ─────────────────────────────────────────────
console.log('campaign fixtures:');
for (const [script, extra] of [
  ['colour-fixture.mjs', []],
  ['rasterize-fixture.mjs', []],
  ['pdf-to-image-fixture.mjs', []],
  ['compare-fixture.mjs', []],
  ['deskew-fixture.mjs', ['--angles', '-6,-3,3,6']],
  ['ocr-fixture.mjs', []],
]) {
  console.log(' ', script, '→', reuse(script, extra));
}
const pdfToImageSheets = join(DIR, 'sheets.pdf');
if (!existsSync(pdfToImageSheets)) {
  throw new Error('expected sheets.pdf from pdf-to-image-fixture.mjs');
}

// ── office / ebook / archive containers from the test harness builders ──────
const bundle = join(DIR, 'harness.mjs');
require('esbuild').buildSync({
  absWorkingDir: REPO,
  entryPoints: [join('tests', 'pdf', 'convert-to-harness.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: bundle,
  alias: { '@': join(REPO, 'src') },
  define: { 'import.meta.env.DEV': 'false' },
  external: ['*?url'],
  logLevel: 'error',
  banner: {
    js: "import { createRequire as __cr } from 'module'; const require = __cr(process.cwd() + '/package.json');",
  },
});
// The ?url imports are Vite-only; a fixture writer never touches ffmpeg.
const bundled = require('node:fs')
  .readFileSync(bundle, 'utf8')
  .replace(/^import (\w+) from "\/node_modules\/.*\?url";$/gm, 'const $1 = "";');
require('node:fs').writeFileSync(bundle, bundled);
const h = await import(`file://${bundle}`);

const write = (name, bytes) => {
  writeFileSync(join(IN, name), bytes);
  return name;
};


// ── text sources ────────────────────────────────────────────────────────────
const DOCX_BODY = '<w:p><w:r><w:t>Lighthouse inventory, quarter three.</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t>Forty-one crates were checked against the ledger by hand.</w:t></w:r></w:p>';
const BASE_LINE = 'A repeated line of body copy, long enough to wrap twice on A4.';

const TXT = `Lighthouse Inventory - quarter three

Forty-one crates were checked against the ledger by hand.
The marginal notes from the 1887 survey were copied verbatim.

Second paragraph, so a page break has something to fall over.
${Array.from({ length: 40 }, (_, i) => `${String(i + 1).padStart(2, '0')} ${BASE_LINE}`).join('\n')}
`;

const MARKDOWN = `# Lighthouse Inventory

A paragraph of body copy under the heading, with **bold** and *italic* runs.

| Item | Qty | Price |
| --- | --- | --- |
| Widget | 3 | 9.99 |
| Gizmo | 12 | 4.50 |

- First bullet
- Second bullet
`;

const HTML = `<!doctype html><html><head><title>Lighthouse Inventory</title></head><body>
<h1>Lighthouse Inventory</h1>
<p>A paragraph with <strong>strong</strong> text and an inline image:
<img alt="dot" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="></p>
<table><tr><th>Item</th><th>Qty</th></tr><tr><td>Widget</td><td>3</td></tr></table>
</body></html>`;

const CSV = 'Item,Qty,Price\nWidget,3,9.99\nGizmo,12,4.50\nSprocket,7,1.25\nFlange,2,18.00\n';
const JSON_TEXT = JSON.stringify(
  { title: 'Lighthouse Inventory', crates: 41, items: [{ name: 'Widget', qty: 3 }, { name: 'Gizmo', qty: 12 }], nested: { a: { b: { c: [1, 2, 3] } } } },
  null,
  2,
);
const XML_TEXT = `<?xml version="1.0" encoding="UTF-8"?>
<inventory><crate id="41"><item>Widget</item><qty>3</qty></crate><crate id="42"><item>Gizmo</item><qty>12</qty></crate></inventory>`;

const RTF = String.raw`{\rtf1\ansi\ansicpg1252\deff0
{\fonttbl{\f0 Times New Roman;}}
\pard\plain\f0\fs28 Lighthouse Inventory\par
\fs22 Forty-one crates were checked against the ledger by hand.\par
Second paragraph of the RTF body, with a \b bold\b0  run.\par
}`;

const EML = [
  'From: keeper@example.com',
  'To: harbour@example.com',
  'Subject: Lighthouse inventory quarter three',
  'Date: Mon, 01 Jan 2026 09:00:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="triage"',
  '',
  '--triage',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Forty-one crates were checked against the ledger by hand.',
  'A second line of body text so the plain part is not empty.',
  '',
  '--triage',
  'Content-Type: text/plain; name="note.txt"',
  'Content-Disposition: attachment; filename="note.txt"',
  '',
  'attached note',
  '',
  '--triage--',
  '',
].join('\r\n');

const FB2 = `<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
<description><title-info><book-title>Lighthouse Inventory</book-title></title-info></description>
<body>
<p>Forty-one crates were checked against the ledger by hand.</p>
<p>The marginal notes from the 1887 survey were copied verbatim.</p>
</body></FictionBook>
`;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160" viewBox="0 0 240 160">
<rect x="0" y="0" width="240" height="160" fill="#ffffff"/>
<rect x="20" y="20" width="120" height="30" fill="#000000"/>
<circle cx="180" cy="120" r="30" fill="#cc2222"/>
<text x="20" y="90" font-size="16" fill="#000000">Lighthouse Inventory</text>
</svg>`;

console.log('office + ebook + image containers (from tests/pdf/convert-to-harness.ts):');
const containers = {
  'doc.docx': await h.docxBytes(DOCX_BODY),
  'sheet.xlsx': await h.workbookBytes(),
  'deck.pptx': await h.pptxBytes(['Opening slide title', 'Closing slide title']),
  'book.epub': await h.epubBytes(['Alpha chapter body text', 'Beta chapter body text']),
  'letter.odt': await h.odtBytes(['First ODT paragraph about the ledger', 'Second ODT paragraph']),
  'data.ods': await h.odsBytes([['Item', 'Qty'], ['Widget', '3'], ['Gizmo', '12']]),
  'slides.odp': await h.odpBytes([{ title: 'Alpha slide', body: 'Alpha body' }, { title: 'Beta slide', body: 'Beta body' }]),
  'doc.xps': await h.xpsBytes(['First XPS page of text', 'Second XPS page of text']),
  'flat.psd': h.psdBytes(120, 60),
  'pages.tif': h.tiffBytes([{ width: 120, height: 90 }, { width: 120, height: 90 }]),
  'pages.cbz': await h.cbzBytes(3),
  // The four "needs a converter we do not bundle" families, in their real magic.
  'book.mobi': h.palmBytes(),
  'legacy.doc': h.OLE_BYTES,
  'archive.rar': h.RAR_BYTES,
};
for (const [name, bytes] of Object.entries(containers)) {
  console.log(' ', write(name, bytes), bytes.length, 'bytes');
}
// `.pages`, `.pub`, `.vsd`, `.wpd`, `.wps`, `.odg` are all answered the same way
// (registered, unavailable, and pointing at a route that works), so one payload
// per extension is enough to drive each entry.
for (const ext of ['pages', 'pub', 'vsd', 'wpd', 'wps', 'odg']) {
  console.log(' ', write(`legacy.${ext}`, h.OLE_BYTES), h.OLE_BYTES.length, 'bytes');
}
for (const [name, text] of Object.entries({
  'doc.txt': TXT,
  'doc.md': MARKDOWN,
  'doc.html': HTML,
  'table.csv': CSV,
  'data.json': JSON_TEXT,
  'data.xml': XML_TEXT,
  'doc.rtf': RTF,
  'mail.eml': EML,
  'book.fb2': FB2,
  'drawing.svg': SVG,
})) {
  write(name, Buffer.from(text, 'utf8'));
}
console.log('text sources written:', ['doc.txt', 'doc.md', 'doc.html', 'table.csv', 'data.json', 'data.xml', 'doc.rtf', 'mail.eml', 'book.fb2', 'drawing.svg'].join(' '));

// ── rasters, video and furniture-bearing PDFs (python half) ────────────────
const py = spawnSync('python3', [join(REPO, 'docs', 'research', 'triage-fixtures-images.py'), '--dir', DIR], {
  cwd: REPO,
  encoding: 'utf8',
});
if (py.status !== 0) {
  throw new Error(`triage-fixtures-images.py failed:\n${(py.stderr || py.stdout).slice(-1200)}`);
}
console.log('python half:');
console.log(py.stdout.trim());

// A signature needs a certificate; node-forge is already a dependency.
const forge = require('node-forge');
const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = '01';
cert.validity.notBefore = new Date(Date.UTC(2024, 0, 1));
cert.validity.notAfter = new Date(Date.UTC(2034, 0, 1));
const attrs = [{ name: 'commonName', value: 'BrowserSnip Triage' }, { name: 'organizationName', value: 'Triage' }];
cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.setExtensions([{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', digitalSignature: true, nonRepudiation: true }]);
cert.sign(keys.privateKey, forge.md.sha256.create());
writeFileSync(join(IN, 'signer-cert.pem'), forge.pki.certificateToPem(cert));
writeFileSync(join(IN, 'signer-key.pem'), forge.pki.privateKeyToPem(keys.privateKey));
console.log('signer-cert.pem + signer-key.pem written');

const inventory = execFileSync('ls', ['-l', IN], { encoding: 'utf8' });
console.log(inventory);
