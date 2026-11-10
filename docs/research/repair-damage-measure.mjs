#!/usr/bin/env node
/**
 * What this app says about the damage corpus — the first half of the
 * `repair` measurement, the app's own voice.
 *
 *   node docs/research/repair-damage-measure.mjs --dir /tmp/rd
 *
 * Runs the shipped `repair` tool over every file `repair-damage-corpus.mjs`
 * wrote, dumps each produced file into `<dir>/out/`, and records the sentence and
 * the warnings the tool printed in `<dir>/app.json`. It asserts nothing: the
 * judging is `repair-damage-readers.py`, which reads the same produced files with
 * MuPDF, qpdf, poppler, pypdf and Ghostscript. The split is the campaign's standing
 * rule — this app's writer cannot grade this app's repair.
 *
 * The tool runs from `src/` through esbuild (`repair-damage-entry.ts`), so this is
 * the module graph the rail calls, not a re-implementation of `repairPDF`.
 */
import { build } from 'esbuild';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};

const DIR = arg('dir', '/tmp/rd');
const CORPUS = join(DIR, 'corpus');
const OUT = join(DIR, 'out');
mkdirSync(OUT, { recursive: true });

const bundleDir = join(DIR, 'probe');
mkdirSync(bundleDir, { recursive: true });
await build({
  absWorkingDir: REPO,
  entryPoints: [
    join(HERE, 'repair-damage-entry.ts'),
    join(HERE, 'repair-damage-internals.ts'),
  ],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: bundleDir,
  alias: { '@': join(REPO, 'src') },
  define: { 'import.meta.env.DEV': 'false' },
  external: ['*?url'],
  logLevel: 'error',
  banner: {
    js: "import { createRequire as __cr } from 'module'; const require = __cr(process.cwd() + '/package.json');",
  },
});
// The `?url` imports are Vite-only — a bundled probe resolves them to nothing.
for (const built of readdirSync(bundleDir).filter((name) => name.endsWith('.js'))) {
  const at = join(bundleDir, built);
  writeFileSync(at, readFileSync(at, 'utf8').replace(/^import\s+(\w+)\s+from\s+"[^"]*\?url";$/gm, 'const $1 = "";'));
}
// The bundles are ESM; the scratch dir has no `package.json` to say so.
writeFileSync(join(bundleDir, 'package.json'), '{"type":"module"}\n');
const probe = await import(pathToFileURL(join(bundleDir, 'repair-damage-entry.js')).href);
const inspect = await import(pathToFileURL(join(bundleDir, 'repair-damage-internals.js')).href);

const files = readdirSync(CORPUS).filter((name) => name.endsWith('.pdf')).sort();
const answers = [];
const seen = [];
for (const name of files) {
  const bytes = new Uint8Array(readFileSync(join(CORPUS, name)));
  const { produced, ...answer } = await probe.answer(name, bytes);
  if (answer.ok && produced?.byteLength) writeFileSync(join(OUT, name), produced);
  answers.push(answer);
  const facts = await inspect.internals(name, bytes);
  seen.push(facts);
  const verdict = answer.ok
    ? `${answer.pages} page(s) claimed · parsed ${answer.outPages ?? `refused (${answer.outError})`} · ${answer.bytes} B`
    : `refused: ${answer.message.slice(0, 70)}`;
  console.log(`${name.padEnd(26)} in ${answer.inPages}${answer.inDeclared !== null ? `/${answer.inDeclared}` : ''} → ${verdict}`);
  const read = `loader ${facts.lenient ?? facts.lenientError} · pdf.js ${facts.pdfjs ?? facts.pdfjsError}`;
  const held = `page objects ${facts.rawPageObjects} · /Count ${facts.rawPageCount} · streams ${facts.rawStreams}`;
  console.log(`  ${read} · ${held}`);
  if (answer.ok) console.log(`  ${answer.message}`);
  for (const warning of answer.warnings) console.log(`  ! ${warning}`);
}

writeFileSync(join(DIR, 'app.json'), `${JSON.stringify(answers, null, 2)}\n`);
writeFileSync(join(DIR, 'internals.json'), `${JSON.stringify(seen, null, 2)}\n`);
console.log(`\nwrote ${OUT} (${answers.filter((item) => item.ok).length}/${files.length} produced files) and ${join(DIR, 'app.json')}`);
