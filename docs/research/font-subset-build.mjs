/**
 * Font-subset failure surface: produce one probe PDF per embedding path.
 *
 *   node docs/research/font-subset-build.mjs /tmp/fsb
 *
 * The probe runs the app's own `src/lib/pdf/core/fonts.ts` (bundled with esbuild
 * for node, with `fetch` served from `public/fonts` and a download cache), draws
 * **one character per row** through each path, and writes:
 *
 *   <out>/<face-id>.pdf      the produced file, for the pixel + reader side
 *   <out>/layout.json        what each row holds, and where the face came from
 *   <out>/faces/<file>       the source face bytes, for the outline comparison
 *
 * Rows are one character each so a per-glyph verdict needs no guesswork: MuPDF
 * reports a box per character, and that box is the cell to measure.
 * `font-subset-measure.py` and `font-subset-pdfjs.mjs` read these outputs.
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SCRIPT_CHARS } from './font-subset-chars.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = process.argv[2] || '/tmp/fsb';
const CACHE = join(OUT, 'faces');
const TAG = process.env.TAG || '';
const prefix = TAG ? `-${TAG}` : '';

mkdirSync(CACHE, { recursive: true });

/* ── 1. bundle the probe, so it imports the real module under test ─────────── */

const bundle = join(OUT, 'probe.mjs');
await build({
  entryPoints: [join(HERE, 'font-subset-entry.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: bundle,
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const probe = await import(`${pathToFileURL(bundle).href}?v=${Date.now()}`);

/* ── 2. the face fetch, served from disk so nothing hits the network twice ─── */

/** Local faces ship with the app; the rest are the on-demand script faces. */
const LOCAL = {
  'NotoSans-Regular.ttf': join(ROOT, 'public', 'fonts', 'NotoSans-Regular.ttf'),
  'NotoSans-Bold.ttf': join(ROOT, 'public', 'fonts', 'NotoSans-Bold.ttf'),
  // The third face the app embeds itself: code blocks in text/markdown to PDF.
  'jetbrains-mono-400.ttf': join(ROOT, 'public', 'fonts', 'jetbrains-mono-400.ttf'),
};

function cachedPath(url) {
  const base = decodeURIComponent(url.split('/').pop());
  if (LOCAL[base]) return LOCAL[base];
  return join(CACHE, base.replace(/[^A-Za-z0-9._-]/g, '_'));
}

async function download(url) {
  const file = cachedPath(url);
  if (!existsSync(file) || statSync(file).size === 0) {
    mkdirSync(dirname(file), { recursive: true });
    // jsDelivr answers a transient 404 for a package it is still warming, which
    // would otherwise be cached as a broken face.
    let res = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      // `realFetch`, not the stub: the stub is what answers *after* the cache is
      // filled, and a cache miss through it is the 404 it reports.
      res = await realFetch(url);
      if (res.ok) break;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'no response'} for ${url}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // A sfnt starts with a version tag; anything else is an error page in a
    // `.ttf` name, and caching that would hide the real failure.
    const magic = [...bytes.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (!['00010000', '4f54544f', '74727565', '74746366'].includes(magic)) {
      throw new Error(`${url} is not a sfnt (magic ${magic}, ${bytes.length} bytes)`);
    }
    writeFileSync(file, bytes);
    console.log(`  fetched ${file.split('/').pop()} ${(bytes.length / 1024).toFixed(0)} KB ${magic === '4f54544f' ? 'CFF' : 'TTF'}`);
  }
  return file;
}

const realFetch = globalThis.fetch;
globalThis.document = { baseURI: 'https://example.test/index.html' };
globalThis.location = { href: 'https://example.test/' };
globalThis.fetch = async (input) => {
  const url = String(input);
  const base = decodeURIComponent(url.split('/').pop());
  const file = LOCAL[base] || cachedPath(url);
  if (!existsSync(file)) {
    return new Response('', { status: 404, statusText: `not cached: ${file}` });
  }
  const bytes = new Uint8Array(readFileSync(file));
  return new Response(bytes, { headers: { 'content-type': 'font/ttf', 'content-length': String(bytes.length) } });
};
/* ── 3. the faces this app can embed ──────────────────────────────────────── */

console.log('faces:');
const urls = probe.faceUrls();
for (const face of urls) await download(face.url);

const LATIN = SCRIPT_CHARS.latin;
const jobs = [
  { id: 'noto-regular', label: 'bundled Noto Sans regular', url: LOCAL['NotoSans-Regular.ttf'], via: 'app', forceNoto: true, chars: LATIN },
  { id: 'noto-bold', label: 'bundled Noto Sans bold', url: LOCAL['NotoSans-Bold.ttf'], via: 'app', forceNoto: true, bold: true, chars: LATIN },
  { id: 'noto-italic', label: 'bundled Noto Sans, synthesised italic', url: LOCAL['NotoSans-Regular.ttf'], via: 'app', forceNoto: true, italic: true, chars: LATIN },
  { id: 'noto-pdflib-subset', label: 'pdf-lib own subsetter (TTF)', url: LOCAL['NotoSans-Regular.ttf'], via: 'pdflib-subset', chars: LATIN },
  { id: 'noto-pdflib-full', label: 'pdf-lib whole face, no subset (control)', url: LOCAL['NotoSans-Regular.ttf'], via: 'pdflib-full', chars: LATIN },
  // The ledger row's own characters, at the size its numbers came from, so this
  // table can be lined up against the one it replaces.
  { id: 'noto-ledger-set', label: 'bundled Noto Sans, the row\'s six characters at 40 pt', url: LOCAL['NotoSans-Regular.ttf'], via: 'app', forceNoto: true, size: 40, chars: [...'#A4B—Z'] },
  { id: 'standard-14', label: 'pdf-lib standard 14 (Helvetica)', url: null, via: 'standard14', chars: SCRIPT_CHARS.winAnsi },
  { id: 'mono-face', label: 'bundled JetBrains Mono, module writer (code blocks)', url: LOCAL['jetbrains-mono-400.ttf'], via: 'unicode-face', chars: SCRIPT_CHARS.winAnsi },
  { id: 'mono-pdflib', label: 'bundled JetBrains Mono, pdf-lib subsetter (before)', url: LOCAL['jetbrains-mono-400.ttf'], via: 'pdflib-subset', chars: SCRIPT_CHARS.winAnsi },
];
for (const face of urls) {
  const chars = SCRIPT_CHARS[face.id];
  if (!chars) continue;
  jobs.push({ id: `app-${face.id}`, label: `on-demand ${face.label}`, url: face.url, via: 'app', chars });
  // The text editor's own face resolver embeds these same bytes through
  // pdf-lib's subsetter, so measure that path on the faces it really uses.
  if (['jp', 'arabic', 'kr', 'thai'].includes(face.id)) {
    jobs.push({ id: `pdflib-${face.id}`, label: `pdf-lib own subsetter, ${face.label}`, url: face.url, via: 'pdflib-subset', chars });
  }
  if (['jp', 'arabic'].includes(face.id)) {
    // What the text editor's font picker does with the same bytes now.
    jobs.push({ id: `face-${face.id}`, label: `module writer, ${face.label} (font picker)`, url: face.url, via: 'unicode-face', chars });
  }
  // Whole-face controls: what the same face looks like when nobody subsets it.
  // One TrueType-flavour and one CFF-flavour face, so both slots are covered.
  if (['arabic', 'kr'].includes(face.id)) {
    jobs.push({ id: `full-${face.id}`, label: `whole ${face.label}, unsubsetted (control)`, url: face.url, via: 'pdflib-full', chars });
  }
}

/* ── 4. run ───────────────────────────────────────────────────────────────── */

const reports = await probe.runProbe(jobs);
const faces = [];
for (const report of reports) {
  if (report.error) {
    console.log(`  ${report.id}: FAILED ${report.error}`);
    continue;
  }
  const name = `${report.id}${prefix}.pdf`;
  writeFileSync(join(OUT, name), report.pdf);
  const source = report.url ? cachedPath(report.url) : null;
  faces.push({
    id: report.id,
    label: report.label,
    via: report.via,
    flavour: report.flavour,
    appSeesCff: report.appSeesCff,
    faceName: report.faceName,
    url: report.url,
    pdf: name,
    pdfBytes: report.pdf.length,
    sourceFace: source ? relative(source) : null,
    sourceFaceBytes: source ? statSync(source).size : null,
    chars: report.drawn,
    refused: report.refused,
    pageWidth: report.pageWidth,
    pageHeight: report.pageHeight,
    margin: 40,
    baselineStep: report.baselineStep,
    fontSize: report.fontSize,
  });
  const hash = createHash('sha256').update(report.pdf).digest('hex').slice(0, 12);
  console.log(
    `  ${report.id.padEnd(20)} ${report.flavour.padEnd(4)} rows ${String(report.drawn.length).padStart(3)}` +
      ` refused ${String(report.refused.length).padStart(3)}` +
      ` face ${report.faceName}` +
      ` file ${(report.pdf.length / 1024).toFixed(1)} KB sha ${hash}`,
  );
}

function relative(p) {
  return p.startsWith(OUT) ? p.slice(OUT.length + 1) : p;
}

writeFileSync(join(OUT, `layout${prefix}.json`), JSON.stringify({ generatedBy: 'font-subset-build.mjs', faces }, null, 1));
console.log(`\n${faces.length} probe PDFs in ${OUT}${prefix ? ` (layout${prefix}.json)` : ''}`);
if (process.env.CLEAN_CACHE === '1') rmSync(CACHE, { recursive: true, force: true });
globalThis.fetch = realFetch;
