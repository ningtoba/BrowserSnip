// The whole-catalogue triage spec — one JSON run per tool, plus one per control.
//
//   node docs/research/triage-spec.mjs [--dir /tmp/triage] [--flips]
//
// Reads the catalogue the app itself counts (`TOOL_CATALOGUE` from
// `src/lib/pdf/tools/registry.ts`, aliased ids folded, so nothing double-counts)
// and the video list from `src/lib/constants.ts`, and writes:
//
//   docs/research/triage-tool-list.txt   one id per line — the coverage claim
//   <dir>/catalogue.json                 every tool's fields, labels and bounds
//   <dir>/spec.json                      the runs `colour-rail.mjs SPEC=…` drives
//
// `--flips` adds one run per field that changes its value and nothing else, which
// is the only way to tell a wired control from one that reaches the form and stops
// there: `colour-rail.mjs` reads each value back out of the DOM before the run, and
// `rail-measure.py --triage` compares the produced file's content with the base
// run's, so "identical output, different setting" becomes a number.
//
// Fixtures are routed by what the tool is for, not by one file for all: an image
// converter gets an image, the OCR tools get a page with no text layer, the
// attachment tools get a file with an attachment, `repair` gets a damaged xref,
// `unlock` gets a document that is really encrypted. See `triage-fixtures.mjs`.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = join(import.meta.dirname, '..', '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const DIR = arg('dir', '/tmp/triage');
const IN = join(DIR, 'in');
const WITH_FLIPS = process.argv.includes('--flips');

// ── the catalogue, from the source that counts it ───────────────────────────
const entry = join(DIR, 'entry.ts');
writeFileSync(
  entry,
  [
    "export { TOOL_CATALOGUE, PDF_TOOLS, hasCustomMainView } from '@/lib/pdf/tools/registry';",
    "export { TOOLS, PDF_TOOL_COUNT, VIDEO_TOOL_COUNT, TOOL_COUNT } from '@/lib/constants';",
    '',
  ].join('\n'),
);
require('esbuild').buildSync({
  absWorkingDir: REPO,
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: join(DIR, 'catalogue-bundle.mjs'),
  alias: { '@': join(REPO, 'src') },
  define: { 'import.meta.env.DEV': 'false' },
  external: ['*?url'],
  logLevel: 'error',
  banner: {
    js: "import { createRequire as __cr } from 'module'; const require = __cr(process.cwd() + '/package.json');",
  },
});
const bundlePath = join(DIR, 'catalogue-bundle.mjs');
writeFileSync(
  bundlePath,
  readFileSyncSafe(bundlePath).replace(
    /^import (\w+) from "\/node_modules\/.*\?url";$/gm,
    'const $1 = "";',
  ),
);
function readFileSyncSafe(p) {
  return require('node:fs').readFileSync(p, 'utf8');
}
const mod = await import(`file://${bundlePath}`);
const catalogue = mod.TOOL_CATALOGUE;
const videoIds = mod.TOOLS.filter((t) => t.category === 'video').map((t) => t.id);

writeFileSync(
  join(REPO, 'docs', 'research', 'triage-tool-list.txt'),
  [...catalogue.map((t) => t.id), ...videoIds].join('\n') + '\n',
);

const dump = catalogue.map((tool) => ({
  id: tool.id,
  name: tool.name,
  category: tool.category,
  multiFile: !!tool.multiFile,
  bespoke: mod.hasCustomMainView(tool.id),
  accept: tool.accept ?? null,
  fields: (tool.fields ?? []).map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    default: f.default === undefined ? null : f.default,
    min: f.min ?? null,
    max: f.max ?? null,
    options: (f.options ?? []).map((o) => ({ value: o.value, label: o.label })),
    required: !!f.required,
    hasWhen: !!f.when,
  })),
}));
writeFileSync(join(DIR, 'catalogue.json'), JSON.stringify(dump, null, 1));

/** The `when` guard is a function on the field; ask it what makes the field visible. */
const live = new Map(catalogue.map((t) => [t.id, t]));
function defaults(tool) {
  const v = {};
  for (const f of tool.fields ?? []) v[f.key] = f.default ?? (f.type === 'toggle' ? false : null);
  return v;
}
function candidates(f) {
  switch (f.type) {
    case 'toggle':
      return [true, false];
    case 'select':
    case 'segmented':
      return (f.options ?? []).map((o) => o.value);
    case 'number':
    case 'slider':
      return [f.min ?? 0, f.max ?? 100, f.default ?? 1];
    default:
      return ['', 'x'];
  }
}
function enableFor(tool, field) {
  if (!field.when) return {};
  const base = defaults(tool);
  if (field.when(base)) return {};
  for (const other of tool.fields ?? []) {
    if (other === field || other.when) continue;
    for (const value of candidates(other)) {
      if (field.when({ ...base, [other.key]: value })) return { [other.key]: value };
    }
  }
  for (const other of tool.fields ?? []) {
    if (other === field) continue;
    for (const value of candidates(other)) {
      if (field.when({ ...base, [other.key]: value })) {
        return { [other.key]: value, ...enableFor(tool, other) };
      }
    }
  }
  return null;
}

// ── fixture routing ─────────────────────────────────────────────────────────
// `triage-fixtures.mjs` regenerates the campaign's own fixtures at the top of DIR
// (colour.pdf, ink.pdf, sheets.pdf, a.pdf, b.pdf, planted.pdf, tilt-*.pdf) and the
// new inputs under DIR/in. Both names are used below, so the split is stated once.
const F = (name) => join(IN, name);
const T = (name) => join(DIR, name);
const PDF = T('colour.pdf');
const TWO = [T('colour.pdf'), T('sheets.pdf')];

/** Tools whose job needs a specific kind of input, or more than one file. */
const ROUTES = {
  // multi-file organize
  merge: { files: TWO },
  'alternate-merge': { files: TWO },
  'overlay-pdf': { files: TWO },
  'pdfs-to-zip': { files: TWO },
  'bates-numbering': { files: TWO },
  organize: { files: [PDF], bespoke: true, label: 'Save reordered PDF' },
  // rasterising / colour / extract
  'rasterize-pdf': { files: [T('ink.pdf')] },
  'pdf-to-cbz': { files: [T('ink.pdf')] },
  'extract-images': { files: [T('ink.pdf')] },
  'pdf-to-image': { files: [T('sheets.pdf')] },
  'pdf-to-png': { files: [T('sheets.pdf')] },
  'pdf-to-jpg': { files: [T('sheets.pdf')] },
  'pdf-to-webp': { files: [T('sheets.pdf')] },
  'pdf-to-bmp': { files: [T('sheets.pdf')] },
  'pdf-to-tiff': { files: [T('sheets.pdf')] },
  'pdf-compress': { files: [F('heavy.pdf')] },
  repair: { files: [F('repaired-target.pdf')] },
  'deskew-pdf': { files: [T('tilt-p6.pdf')] },
  'ocr-pdf': { files: [F('scanned.pdf')], timeout: 420000 },
  'remove-blank-pages': { files: [F('blanks.pdf')] },
  // forms, annotations, furniture
  'form-filler': { files: [F('form.pdf')], bespoke: true, label: 'Fill and save' },
  'form-creator': { files: [F('form.pdf')] },
  'flatten-pdf': { files: [F('form.pdf')] },
  'remove-annotations': { files: [F('annot.pdf')] },
  'sanitize-pdf': { files: [F('js.pdf')] },
  'pdf-layers': { files: [F('layers.pdf')] },
  'add-attachments': { files: [PDF] },
  'extract-attachments': { files: [F('attach.pdf')] },
  'edit-attachments': { files: [F('attach.pdf')] },
  'view-metadata': { files: [F('meta.pdf')] },
  'edit-metadata': { files: [F('meta.pdf')] },
  'remove-metadata': { files: [F('meta.pdf')] },
  unlock: { files: [F('locked.pdf')] },
  'change-permissions': { files: [F('locked.pdf')] },
  'remove-restrictions': { files: [F('locked.pdf')] },
  'compare-pdfs': { files: [T('a.pdf'), T('b.pdf')], bespoke: true, label: 'Generate comparison PDF' },
  'redact-pdf': { files: [F('annot.pdf')], bespoke: true, label: 'Apply redactions' },
  'edit-pdf': { files: [F('annot.pdf')], bespoke: true },
  'edit-pdf-text': { files: [F('colour.pdf')], bespoke: true },
  'add-stamps': { files: [PDF], bespoke: true },
  sign: { files: [PDF], bespoke: true, label: 'Place signatures' },
  'pdf-crop': { files: [PDF], bespoke: true },
  'scan-to-pdf': { files: [F('photo.jpg')], bespoke: true, label: 'Generate PDF' },
  'digitize-document': { files: [F('scanned.pdf')], timeout: 420000 },
  // convert-to: the container each tool reads
  'image-to-pdf': { files: [F('photo.jpg'), F('photo.png')] },
  'jpg-to-pdf': { files: [F('photo.jpg')] },
  'png-to-pdf': { files: [F('photo.png')] },
  'webp-to-pdf': { files: [F('photo.webp')] },
  'heic-to-pdf': { files: existsSync(F('photo.heic')) ? [F('photo.heic')] : [F('photo.jpg')] },
  'bmp-to-pdf': { files: [F('photo.bmp')] },
  'tiff-to-pdf': { files: [F('photo.tif')] },
  'psd-to-pdf': { files: [F('flat.psd')] },
  'svg-to-pdf': { files: [F('drawing.svg')] },
  'cbz-to-pdf': { files: [F('pages.cbz')] },
  'txt-to-pdf': { files: [F('doc.txt')] },
  'markdown-to-pdf': { files: [F('doc.md')] },
  'html-to-pdf': { files: [F('doc.html')] },
  'csv-to-pdf': { files: [F('table.csv')] },
  'json-to-pdf': { files: [F('data.json')] },
  'xml-to-pdf': { files: [F('data.xml')] },
  'rtf-to-pdf': { files: [F('doc.rtf')] },
  'word-to-pdf': { files: [F('doc.docx')] },
  'excel-to-pdf': { files: [F('sheet.xlsx')] },
  'powerpoint-to-pdf': { files: [F('deck.pptx')] },
  'epub-to-pdf': { files: [F('book.epub')] },
  'email-to-pdf': { files: [F('mail.eml')] },
  'odt-to-pdf': { files: [F('letter.odt')] },
  'ods-to-pdf': { files: [F('data.ods')] },
  'odp-to-pdf': { files: [F('slides.odp')] },
  'xps-to-pdf': { files: [F('doc.xps')] },
  'fb2-to-pdf': { files: [F('book.fb2')] },
  'mobi-to-pdf': { files: [F('book.mobi')] },
  'pages-to-pdf': { files: [F('legacy.pages')] },
  'pub-to-pdf': { files: [F('legacy.pub')] },
  'vsd-to-pdf': { files: [F('legacy.vsd')] },
  'wpd-to-pdf': { files: [F('legacy.wpd')] },
  'wps-to-pdf': { files: [F('legacy.wps')] },
  'odg-to-pdf': { files: [F('legacy.odg')] },
};

/**
 * Values a tool cannot run without, keyed by the field's own `key` so the label
 * the rail prints is looked up rather than guessed. Anything here is written into
 * every run of that tool — base and flips — because a run that stops at "type a
 * password" tells nothing about the control being flipped.
 */
const REQUIRED_BY_KEY = {
  userPassword: 'reader-pass',
  ownerPassword: 'owner-pass',
  password: 'reader-pass',
  certificate: F('signer-cert.pem'),
  privateKey: F('signer-key.pem'),
  files: F('note.txt'),
  fieldSpecs: 'text:q1|Alpha question\ntext:q2|Beta question\nnumber:q3|37',
};

/**
 * Per-field overrides where a generic marker string is not valid input, keyed
 * `tool:field` when the same key means different grammars in two tools — `ranges`
 * is a page selection on `split` and a label plan on `add-page-labels`, and
 * feeding the second grammar to the first is a fixture bug, not a tool defect.
 */
const FIELD_VALUES = {
  'split:ranges': '1-2',
  'n-up:pages': '1-3',
  'add-page-labels:ranges': '1-2: i, 3-4: 1',
  'bookmarks:outline': 'Chapter One 1\nChapter Two 3',
  'edit-attachments:remove': 'note.txt',
  'watermark:text': 'TRIAGE MARK',
  'pageOrder': '1,2,3,4',
  outline: 'Chapter One 1\nChapter Two 3',
  fieldSpecs: 'text:q1|Alpha question\ntext:q2|Beta question\nnumber:q3|37',
  add: 'TriageLayer',
  hide: 'LayerOff',
  show: 'LayerOn',
  'bates-numbering:format': '<PREFIX>-<PAGE:4>',
  prefix: 'TRIAGE',
  title: 'Triage title',
  headerLeft: 'Triage header left',
  headerCenter: 'Triage header centre',
  headerRight: 'Triage header right',
  footerLeft: 'Triage footer left',
  footerCenter: 'Triage footer centre',
  footerRight: 'Triage footer right',
  paste: 'Triage pasted paragraph, long enough to be laid out on a page of its own.',
  extra: 'Triage note for the AI-ready file',
  tsa: 'http://timestamp.digicert.com',
  reason: 'Triage reason',
  location: 'Triage location',
  contact: 'triage@example.com',
  docLanguage: 'en-US',
  producer: 'Triage producer',
  creator: 'Triage creator',
  author: 'Triage author',
  subject: 'Triage subject',
  keywords: 'triage, sweep',
};

/** The value a flip writes, by field type. */
function flipValue(f, toolId) {
  const scoped = FIELD_VALUES[`${toolId}:${f.key}`] ?? FIELD_VALUES[f.key];
  if (scoped !== undefined) return scoped;
  switch (f.type) {
    case 'toggle':
      return 'toggle';
    case 'slider': {
      const min = Number(f.min ?? 0);
      const max = Number(f.max ?? 100);
      if (/resolution|dpi/i.test(f.label)) return String(Math.min(150, max));
      const far = min + (max - min) * 0.75;
      return String(Number.isInteger(min) && Number.isInteger(max) ? Math.round(far) : far.toFixed(2));
    }
    case 'number': {
      const base = Number(f.default ?? f.min ?? 0);
      const max = Number(f.max ?? base + 20);
      return String(Math.min(max, base === max ? base - 1 : Math.max(base + 1, Math.round((base + max) / 2))));
    }
    case 'select':
    case 'segmented': {
      const other = (f.options ?? []).find((o) => String(o.value) !== String(f.default));
      return other ? String(other.label).split(' ')[0] : 'toggle';
    }
    case 'multiselect':
      return 'toggle';
    case 'color':
      return String(f.default ?? '').toLowerCase() === '#ff0000' ? '#00ff00' : '#ff0000';
    case 'password':
      return 'triage-pass';
    case 'pages':
      return '2-3';
    case 'dimensions':
      return '300x200';
    case 'file':
      return F('tiny.png');
    case 'text':
    case 'textarea':
      return 'TRIAGE MARK';
    case 'signature-style':
      return 'toggle';
    default:
      return 'TRIAGE';
  }
}

/** The values a base run needs: whatever the tool requires, plus the known blockers. */
function baseFields(tool) {
  const out = {};
  for (const f of tool.fields ?? []) {
    if (REQUIRED_BY_KEY[f.key] !== undefined) {
      out[f.label] = REQUIRED_BY_KEY[f.key];
      continue;
    }
    if (!f.required) continue;
    const known = REQUIRED_FIELD_VALUE[f.type];
    if (known !== undefined) out[f.label] = known;
  }
  return out;
}
const REQUIRED_FIELD_VALUE = {
  password: 'triage-pass',
  file: F('tiny.png'),
  text: 'TRIAGE',
  textarea: 'TRIAGE',
};

const spec = [];
for (const tool of dump) {
  const route = ROUTES[tool.id] ?? { files: [PDF] };
  const live_tool = live.get(tool.id);
  const base = { tool: tool.id, tag: 'base', files: route.files, timeout: route.timeout ?? 240000 };
  if (route.bespoke) base.fields = {};
  if (route.label) base.label = route.label;
  const required = baseFields(live_tool);
  if (Object.keys(required).length) base.fields = { ...base.fields, ...required };
  spec.push(base);
  if (!WITH_FLIPS) continue;
  for (const f of tool.fields ?? []) {
    const enable = enableFor(live_tool, (live_tool.fields ?? []).find((x) => x.key === f.key) ?? {});
    if (enable === null) {
      spec.push({ tool: tool.id, tag: `flip-${f.key}`, files: route.files, note: 'no assignment makes this field visible' });
      continue;
    }
    const labels = {};
    for (const [key, value] of Object.entries(enable)) {
      const other = (tool.fields ?? []).find((x) => x.key === key);
      if (other) labels[other.label] = value === true ? 'toggle' : String(value);
    }
    const fields = { ...required, ...labels };
    // The enabling value for a *visible-only-when-another-changed* field must be
    // written literally (a select value), not toggled, or the field stays hidden.
    for (const [key, value] of Object.entries(enable)) {
      const other = (tool.fields ?? []).find((x) => x.key === key);
      if (other && other.type !== 'toggle') fields[other.label] = String(value);
    }
    const value = flipValue(f, tool.id);
    if (f.type === 'file' && value === f.default) continue;
    fields[f.label] = value;
    spec.push({ tool: tool.id, tag: `flip-${f.key}`, files: route.files, timeout: route.timeout ?? 240000, fields });
  }
}


// ── the eight video tools ───────────────────────────────────────────────────
// They are not in the PDF registry: `src/lib/constants.ts` declares them and
// `ToolWorkspace` mounts a hand-built panel per id, with chips instead of a
// segmented field and no rail form to describe them. So each run names its own
// button, and a control that only a chip has gets a DOM expression plus a readback
// — the same "write it, read it back, then look in the bytes" discipline the rail
// probe uses, because a video tool whose settings never reach ffmpeg is exactly the
// defect this sweep is looking for.
const CLIP = F('clip.mp4');
const chip = (text) =>
  `(()=>{const b=[...document.querySelectorAll('button')].find((x)=>(x.innerText||'').trim()===${JSON.stringify(text)});if(!b)return 'NO CHIP';b.click();return 'clicked '+b.innerText.trim()})()`;
const rangeByMax = (max, value) =>
  `(()=>{const i=[...document.querySelectorAll('input[type=range]')].find((x)=>Number(x.max)===${max});if(!i)return 'NO RANGE';const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,${JSON.stringify(String(value))});i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new Event('change',{bubbles:true}));return 'range='+i.value})()`;
const readRange = (max) =>
  `[...document.querySelectorAll('input[type=range]')].filter((x)=>Number(x.max)===${max}).map((x)=>x.value).join(',')`;

const VIDEO = [
  { id: 'trim', button: 'Trim Video', out: 'trim', flips: [
    { tag: 'flip-start', fields: { 'Start Time': '1', 'End Time': '2' } },
  ] },
  { id: 'resize', button: 'Resize Video', out: 'resize', flips: [
    { tag: 'flip-preset-720', eval: [chip('720p')] },
    { tag: 'flip-width', fields: { Width: '160' } },
  ] },
  { id: 'crop', button: 'Crop Video', out: 'crop', flips: [
    { tag: 'flip-square', eval: [chip('1:1')] },
    { tag: 'flip-story', eval: [chip('9:16')] },
  ] },
  { id: 'compress', button: 'Compress Video', out: 'compress', flips: [
    { tag: 'flip-target', eval: [rangeByMax(25, 1)], readback: [readRange(25)] },
  ] },
  { id: 'gif', button: 'Convert to GIF', out: 'gif', flips: [
    { tag: 'flip-duration', fields: { 'Duration (max 10s)': '2' } },
    { tag: 'flip-width', fields: { Width: '160' } },
  ] },
  { id: 'audio', button: 'Apply Audio Changes', out: 'audio', flips: [
    { tag: 'flip-mute', eval: [chip('Mute')] },
    { tag: 'flip-extract', eval: [chip('Extract MP3')] },
    { tag: 'flip-volume', eval: [chip('Volume'), rangeByMax(3, 2)], readback: [readRange(3)] },
  ] },
  { id: 'speed', button: 'Apply Speed Change', out: 'speed', flips: [
    { tag: 'flip-2x', eval: [chip('2x')] },
    { tag: 'flip-half', eval: [chip('0.5x')] },
  ] },
  { id: 'metadata', button: 'Strip Metadata', out: 'metadata', flips: [] },
];
for (const tool of VIDEO) {
  const base = { tool: tool.id, tag: 'base', route: `/tool/${tool.id}`, files: [CLIP], label: tool.button, timeout: 420000 };
  spec.push(base);
  for (const flip of tool.flips) {
    spec.push({
      ...base,
      tag: flip.tag,
      fields: flip.fields ?? {},
      ...(flip.eval ? { eval: flip.eval } : {}),
      ...(flip.readback ? { readback: flip.readback } : {}),
    });
  }
}


// ── the repair pass ─────────────────────────────────────────────────────────
// Reruns for the tools whose first pass was answered by the *fixture* rather than
// by the tool: a table tool handed a page with no table, an attachment tool handed
// a file it could not see, the encrypted trio handed only the AES-256 variant, and
// the seven page-layout tools that all stopped at "Can't embed page with missing
// Contents" on a document whose only unusual page is an empty one — the last group
// is re-run on a file with no empty page, which is what tells a fixture artefact
// from a defect. `REPAIR=1` writes spec-repair.json instead of spec.json.
if (process.argv.includes('--repair')) {
  const label = (id, key) => (dump.find((t) => t.id === id)?.fields ?? []).find((f) => f.key === key)?.label;
  const pages = (id) => label(id, 'pages');
  const reruns = [
    // Table-shaped input for the three tools that reported "no tables found".
    { tool: 'pdf-to-csv', files: [F('table.pdf')] },
    { tool: 'extract-tables', files: [F('table.pdf')] },
    { tool: 'pdf-to-excel', files: [F('table.pdf')] },
    // A document that really has an outline.
    { tool: 'bookmarks', files: [F('bookmarked.pdf')], fields: { [label('bookmarks', 'outline')]: 'New Chapter 2' } },
    { tool: 'table-of-contents', files: [F('bookmarked.pdf')] },
    // Attachments: the app writes one, then reads the file it wrote back.
    { tool: 'add-attachments', files: [PDF], fields: { [label('add-attachments', 'files')]: F('note.txt'), [label('add-attachments', 'description')]: 'triage note' } },
    { tool: 'extract-attachments', files: [F('attach.pdf')] },
    { tool: 'edit-attachments', files: [F('attach.pdf')], fields: { [label('edit-attachments', 'remove')]: 'note.txt' } },
    // Encryption: three schemes, so "wrong password" can be told from "AES-256 is not readable here".
    { tool: 'unlock', tag: 'aes128', files: [F('locked128.pdf')], fields: { [label('unlock', 'password')]: 'reader-pass' } },
    { tool: 'unlock', tag: 'rc4', files: [F('lockedrc4.pdf')], fields: { [label('unlock', 'password')]: 'reader-pass' } },
    { tool: 'unlock', tag: 'aes256-owner', files: [F('locked.pdf')], fields: { [label('unlock', 'password')]: 'owner-pass' } },
    { tool: 'change-permissions', tag: 'aes128', files: [F('locked128.pdf')], fields: { [label('change-permissions', 'ownerPassword')]: 'owner-pass' } },
    { tool: 'remove-restrictions', tag: 'aes128', files: [F('locked128.pdf')] },
    { tool: 'remove-restrictions', tag: 'rc4', files: [F('lockedrc4.pdf')] },
    // A selection where the rail requires one.
    { tool: 'split', tag: 'ranges', files: [PDF], fields: { [label('split', 'ranges')]: '1-2' } },
    { tool: 'remove-pages', files: [PDF], fields: { [pages('remove-pages')]: '1' } },
    { tool: 'extract-pages', tag: 'select-2-3', files: [PDF], fields: { [pages('extract-pages')]: '2-3' } },
    { tool: 'pdf-layers', files: [F('layers.pdf')], fields: { [label('pdf-layers', 'hide')]: 'toggle' } },
    // The seven that all stopped at the same sentence, re-run on a file with no empty page.
    { tool: 'rotate-custom', tag: 'no-empty-page', files: [F('heavy.pdf')] },
    { tool: 'n-up', tag: 'no-empty-page', files: [F('heavy.pdf')] },
    { tool: 'booklet', tag: 'no-empty-page', files: [F('heavy.pdf')] },
    { tool: 'combine-single-page', tag: 'no-empty-page', files: [F('heavy.pdf')] },
    { tool: 'posterize', tag: 'no-empty-page', files: [F('heavy.pdf')] },
    { tool: 'divide-pages', tag: 'no-empty-page', files: [F('heavy.pdf')] },
    { tool: 'fix-page-size', tag: 'no-empty-page', files: [F('heavy.pdf')] },
    // The page-layout seven again, this time with every empty page removed from
    // the input, which is the other half of the same cause test.
    { tool: 'n-up', tag: 'bookmarked-input', files: [F('bookmarked.pdf')] },
    // Signature chain and the blockers that name themselves.
    { tool: 'digital-sign-pdf', files: [PDF], fields: { [label('digital-sign-pdf', 'certificate')]: F('signer-cert.pem'), [label('digital-sign-pdf', 'privateKey')]: F('signer-key.pem'), [label('digital-sign-pdf', 'reason')]: 'Triage signature' } },
    { tool: 'timestamp-pdf', files: [PDF] },
    { tool: 'font-to-outline', files: [PDF] },
    { tool: 'repair', tag: 'clean-input', files: [PDF] },
    { tool: 'extract-images', tag: 'sheets', files: [T('sheets.pdf')] },
    { tool: 'pdf-to-pdfa', files: [PDF], timeout: 420000 },
    { tool: 'ocr-pdf', files: [F('scanned.pdf')], timeout: 600000 },
    // Image-only input for the digitiser, which refused a PDF.
    { tool: 'digitize-document', files: [F('photo.jpg')], timeout: 600000 },
    // CBZ built from real photographs rather than 1×1 pixels.
    { tool: 'cbz-to-pdf', tag: 'photo-archive', files: [F('photos.cbz')] },
    // Bespoke surfaces: the pane's own button, named.
    { tool: 'organize', files: [PDF], label: 'Save reordered PDF' },
    { tool: 'form-filler', files: [F('form.pdf')], label: 'Fill and save' },
    { tool: 'form-creator', files: [PDF], label: 'Create fields|Add fields|Create' },
    { tool: 'pdf-crop', files: [PDF], label: 'Apply crop|Crop|Save' },
    { tool: 'compare-pdfs', files: [T('a.pdf'), T('b.pdf')], label: 'Generate comparison PDF' },
    { tool: 'redact-pdf', files: [F('annot.pdf')], label: 'Apply redaction|Redact|Save' },
    { tool: 'sign', files: [PDF], label: 'Place signatures|Add text to PDF' },
    { tool: 'add-stamps', files: [PDF], label: 'Save|Apply|Add stamp' },
    { tool: 'scan-to-pdf', files: [F('photo.jpg')], label: 'Generate PDF' },
    { tool: 'edit-pdf', files: [F('annot.pdf')], label: 'Save|Download|Apply' },
    { tool: 'edit-pdf-text', files: [PDF], label: 'Save|Download|Apply' },
  ];
  const repair = reruns.map((r) => ({ tag: 'base', timeout: 240000, fields: {}, ...r }));
  writeFileSync(join(DIR, 'spec-repair.json'), JSON.stringify(repair, null, 1));
  console.log(`repair spec: ${repair.length} run(s) → ${join(DIR, 'spec-repair.json')}`);
  const missing = repair.filter((r) => Object.values(r.fields ?? {}).some((v) => v === undefined));
  for (const r of missing) console.log(`  NOTE ${r.tool}: a field label did not resolve`, JSON.stringify(r.fields));
  process.exit(0);
}

writeFileSync(join(DIR, 'spec.json'), JSON.stringify(spec, null, 1));
console.log(
  `catalogue ${catalogue.length} PDF + ${videoIds.length} video = ${mod.TOOL_COUNT} (the app's own count: ${mod.TOOL_COUNT})`,
);
console.log(`spec: ${spec.length} run(s)${WITH_FLIPS ? ' (base + one per field)' : ' (base only)'}`);
console.log(`tool list: docs/research/triage-tool-list.txt (${catalogue.length + videoIds.length} ids)`);
for (const [id, count] of Object.entries(counts())) {
  console.log(`  ${id}: ${count}`);
}
function counts() {
  const c = {};
  for (const run of spec) c[run.files.map((f) => f.split('/').pop()).join('+')] = (c[run.files.map((f) => f.split('/').pop()).join('+')] ?? 0) + 1;
  return c;
}
