/**
 * Replay the app's own PDF/A invocation through the published Ghostscript WASM
 * build, so "the engine writes an output intent now" is a measurement and not a
 * sentence about a manual page.
 *
 *   BROWSERSNIP_PDFA_DUMP=/tmp/pdfa-inv npx vitest run tests/pdf/pdfa-structure.test.ts
 *   node docs/research/pdfa-invocation.mjs /tmp/pdfa-inv /tmp/pdfa-structure-input.pdf /tmp/pdfa-inv-out
 *
 * `<dump>` holds the argument vector and the sandbox files `convertToPdfA` built
 * (`argv.json`, `pdfa_prefix.ps`, `pdfa_profile.icc`), written by the test rather
 * than retyped here — the same rule `font-outline-wasm.mjs` follows, because a
 * proof script that re-enters the command line drifts from the code it proves.
 *
 * Three vectors, on the same input:
 *
 *   as-built        exactly what the source handed the engine;
 *   prolog-first    the prolog named before `-sOutputFile`, which is the shape a
 *                   reasonable person writes next: `pdfwrite` opens the device at
 *                   the pdfmark, with no output file named yet, and the run dies
 *                   with *"Device 'pdfwrite' requires an output file"*;
 *   flag-only       the pre-fix invocation: `-dPDFA=2` and no prolog, the file that
 *                   identifies itself as PDF/A with no `/OutputIntents` at all.
 *
 * It also lists the engine's sandbox filesystem, because the claim "the WASM build
 * has no `PDFA_def.ps` to read" is the reason the app writes its own prolog.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const [dumpDir, input, outDir] = process.argv.slice(2);
if (!dumpDir || !input || !outDir) {
  throw new Error('usage: pdfa-invocation.mjs <dumpDir> <input.pdf> <outdir>');
}

const CACHE = path.join(process.cwd(), 'node_modules', '.browsersnip-gs');
for (const file of ['gs.js', 'gs.wasm']) {
  if (!fs.existsSync(path.join(CACHE, file))) {
    throw new Error(
      `${CACHE} holds no ${file} — run \`BROWSERSNIP_GS=live npx vitest run tests/pdf/pdfa-structure.test.ts\` first`,
    );
  }
}
fs.mkdirSync(outDir, { recursive: true });

const vector = JSON.parse(fs.readFileSync(path.join(dumpDir, 'argv.json'), 'utf8'));
const prologArg = vector.args.find((arg) => arg.endsWith('.ps'));
if (!prologArg || !fs.existsSync(path.join(dumpDir, path.basename(prologArg)))) {
  throw new Error(`dump in ${dumpDir} holds no prolog named by ${JSON.stringify(vector.args)}`);
}
// The profile is not on the command line — the prolog opens it by name — so read
// that name out of the prolog and check the dump carries the file it points at.
const prologText = fs.readFileSync(path.join(dumpDir, path.basename(prologArg)), 'utf8');
const profileName = /\/ICCProfile\s+\((\/[^)]+)\)/.exec(prologText)?.[1];
if (!profileName || !fs.existsSync(path.join(dumpDir, path.basename(profileName)))) {
  throw new Error(`${prologArg} names no readable /ICCProfile in ${dumpDir}: ${profileName ?? 'none'}`);
}

let lines = [];
const load = await import(pathToFileURL(path.join(CACHE, 'gs.js')).href);
const gs = await load.default({
  locateFile: (file) => path.join(CACHE, file),
  print: (line) => lines.push(line),
  printErr: (line) => lines.push(line),
});

console.log(`engine: ${path.relative(process.cwd(), CACHE)}/gs.wasm — `
  + `${fs.statSync(path.join(CACHE, 'gs.wasm')).size} bytes, sha256 `
  + `${createHash('sha256').update(fs.readFileSync(path.join(CACHE, 'gs.wasm'))).digest('hex').slice(0, 16)}…`);
console.log(`input : ${input} — ${fs.statSync(input).size} bytes`);
console.log(`vector: ${vector.tool}\n        ${vector.args.join(' ')}`);

/** Every path in the engine's own filesystem: what a prefix file could have come from. */
function listSandbox(dir = '/', depth = 0, out = []) {
  if (depth > 6) return out;
  let entries = [];
  try {
    entries = gs.FS.readdir(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === '.' || name === '..') continue;
    const p = dir === '/' ? `/${name}` : `${dir}/${name}`;
    let isDir = false;
    try {
      isDir = gs.FS.stat(p).mode !== undefined && (gs.FS.stat(p).mode & 0o170000) === 0o040000;
    } catch { /* unreadable */ }
    out.push(p + (isDir ? '/' : ''));
    if (isDir) listSandbox(p, depth + 1, out);
  }
  return out;
}

const sandbox = listSandbox();
console.log(`\nsandbox filesystem before any run: ${sandbox.length} entries — ${sandbox.join(' ')}`);
console.log(`  .ps or .icc files shipped by the build: ${sandbox.filter((p) => /\.(ps|icc|icm)$/i.test(p)).length}`);
console.log('  (so `PDFA_def.ps`, which a disk build keeps in its `lib/` folder, is'
  + ' not something this engine can read: the app has to write the prolog itself)');

function runOnce(args, tag) {
  lines = [];
  const inputBytes = new Uint8Array(fs.readFileSync(input));
  gs.FS.writeFile('/tmp/input.pdf', inputBytes);
  gs.FS.writeFile(prologArg, fs.readFileSync(path.join(dumpDir, path.basename(prologArg))));
  gs.FS.writeFile(profileName, fs.readFileSync(path.join(dumpDir, path.basename(profileName))));
  let exit = 'threw';
  try {
    exit = gs.callMain(args.slice());
  } catch (error) {
    console.log(`${tag}: threw in the host — ${error.message}`);
  }
  let bytes = null;
  try {
    bytes = Buffer.from(gs.FS.readFile('/tmp/output.pdf'));
    const stem = `${path.basename(input, '.pdf')}.${tag}`.replace(/[^A-Za-z0-9._()-]+/g, '_');
    fs.writeFileSync(path.join(outDir, `${stem}.pdf`), bytes);
  } catch { /* the device wrote nothing */ }
  for (const p of ['/tmp/input.pdf', '/tmp/output.pdf', prologArg, profileName]) {
    try { gs.FS.unlink(p); } catch { /* never written */ }
  }
  const said = lines.filter((line) => /error|unable|cannot|requires|abort/i.test(line))
    .map((line) => line.trim()).slice(0, 3);
  console.log(`${tag}: exit ${exit}  out ${bytes ? bytes.length : 0} B  (in ${inputBytes.length} B)`
    + (said.length ? `\n   gs: ${said.join('\n   gs: ')}` : ''));
  return { exit, bytes: bytes ? bytes.length : 0 };
}

console.log('');
runOnce(vector.args, 'as-built');
// The shape a reasonable person writes next: the prolog named before the output file.
const switches = vector.args.filter((arg) => arg !== prologArg
  && arg !== '/tmp/input.pdf'
  && !arg.startsWith('-sOutputFile='));
runOnce([...switches, prologArg, '-sOutputFile=/tmp/output.pdf', '/tmp/input.pdf'], 'prolog-first');
// The pre-fix invocation: the same switches, no prolog job at all.
runOnce(vector.args.filter((arg) => arg !== prologArg), 'flag-only (pre-fix)');

console.log(`\nproduced, in ${outDir}: ${fs.readdirSync(outDir).join(' ')}`);
console.log('read them with an outside reader:');
console.log(`  python3 docs/research/pdfa-attribution-readers.py ${outDir}/*.pdf`);
