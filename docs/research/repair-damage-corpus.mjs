#!/usr/bin/env node
/**
 * Write the `repair` damage corpus to disk.
 *
 *   node docs/research/repair-damage-corpus.mjs --dir /tmp/rd
 *
 * The damage definitions live in `tests/pdf/repair-damage-corpus.ts` — the same
 * module `tests/pdf/repair-damage.test.ts` pins the fix against — and are bundled
 * here with esbuild so the campaign's fixtures and the test's fixtures are one
 * spelling and cannot drift apart.
 *
 * Writes `<dir>/corpus/<case>.pdf` plus `<dir>/manifest.json`, which records what
 * each case broke and what the healthy document holds (one planted word per sheet,
 * one line of body copy, one solid bar) so a reader can say whether a "repaired"
 * file still holds the document rather than just a page count.
 */
import { build } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
};

const DIR = arg('dir', '/tmp/rd');
const CORPUS = join(DIR, 'corpus');
mkdirSync(CORPUS, { recursive: true });

const bundleDir = join(DIR, 'probe');
mkdirSync(bundleDir, { recursive: true });
await build({
  absWorkingDir: REPO,
  entryPoints: [join(REPO, 'tests', 'pdf', 'repair-damage-corpus.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: bundleDir,
  logLevel: 'error',
});
writeFileSync(join(bundleDir, 'package.json'), '{"type":"module"}\n');

const corpus = await import(pathToFileURL(join(bundleDir, 'repair-damage-corpus.js')).href);
const built = await corpus.buildDamageCorpus();

for (const base of built.bases) writeFileSync(join(CORPUS, base.name), base.bytes);

/**
 * The literal input of `docs/TOOL-TRIAGE.md` §2, rebuilt from the campaign's own
 * fixture rather than quoted: `colour.pdf` with a comment after its header, its
 * last 40 bytes cut and `%%EOF` shortened to `%%EO` — the same edit
 * `triage-fixtures-images.py` applied when the row was written.
 *
 * It earns its place because it is the one case that shows the headline symptom
 * rather than a cousin of it: the page content is plaintext, so the byte harvest
 * finds streams, and the file came back as pages that draw nothing with the
 * sentence "N page(s) readable" over them.
 */
function ledgerCase() {
  const colour = join(DIR, 'colour.pdf');
  const run = spawnSync(process.execPath, [join(HERE, 'colour-fixture.mjs'), '--dir', DIR], {
    cwd: REPO,
    encoding: 'utf8',
  });
  if (run.status !== 0 || !existsSync(colour)) {
    console.log(`  ledger case skipped: ${(run.stderr || run.stdout).slice(0, 120) || 'no colour.pdf'}`);
    return null;
  }
  const raw = readFileSync(colour);
  const damaged = new Uint8Array(Buffer.concat([
    raw.subarray(0, 12),
    Buffer.from('\n% damaged by triage\n', 'latin1'),
    raw.subarray(12, raw.length - 40),
    Buffer.from('\n%%EO\n', 'latin1'),
  ]));
  writeFileSync(join(CORPUS, 'ledger-32-input.pdf'), damaged);
  return damaged.length;
}

const ledgerBytes = ledgerCase();

const manifest = {
  corpus: CORPUS,
  pages: corpus.SHEET_WORDS.length,
  sheet_words: corpus.SHEET_WORDS,
  sentence: corpus.SENTENCE,
  bases: built.bases.map((base) => ({ name: base.name, bytes: base.bytes.byteLength })),
  cases: [],
};
for (const item of built.cases) {
  writeFileSync(join(CORPUS, item.name), item.bytes);
  manifest.cases.push({
    name: item.case.id,
    file: `corpus/${item.name}`,
    base: item.case.base,
    breaks: item.case.breaks,
    bytes: item.bytes.byteLength,
    expect: item.case.expect,
  });
}
if (ledgerBytes) {
  manifest.cases.push({
    name: 'ledger-32-input',
    file: 'corpus/ledger-32-input.pdf',
    base: 'classic',
    breaks: 'the literal input of `docs/TOOL-TRIAGE.md` §2: the campaign colour fixture with its index shifted and its tail cut',
    bytes: ledgerBytes,
    expect: { inputPages: 4, inputSheetsWithWords: 4, repairedSheetsWithWords: 4, mustProduce: true },
  });
}

writeFileSync(join(DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`corpus: ${CORPUS}`);
for (const item of manifest.cases) {
  console.log(`  ${item.name.padEnd(24)} ${String(item.bytes).padStart(6)} B  from ${item.base} · ${item.breaks}`);
}
