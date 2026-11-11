/**
 * Replay the app's own Ghostscript command lines through the published WASM
 * build, so the invocation defect and its fix are measured rather than quoted.
 *
 *   node docs/research/font-outline-wasm.mjs <vectors.json> <input.pdf> <outdir>
 *
 * `<vectors.json>` is dumped by `tests/pdf/font-outline.test.ts` when it runs
 * with `BROWSERSNIP_GS_DUMP=…`, so every array here is the array the source
 * built — retyping it in a proof script is how a proof drifts from the code.
 *
 * Each vector is run twice: as built, and with `-sOutputFile=<path>` split back
 * into two arguments, which is the shape the tools shipped until `4ad2be3`. The
 * engine is the one the tab downloads (`@bentopdf/gs-wasm@0.1.1`), cached under
 * `node_modules/.browsersnip-gs` by the test suite.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const [vectorsFile, input, outDir] = process.argv.slice(2);
if (!vectorsFile || !input || !outDir) {
  throw new Error('usage: font-outline-wasm.mjs <vectors.json> <input.pdf> <outdir>');
}

const CACHE = path.join(process.cwd(), 'node_modules', '.browsersnip-gs');
if (!fs.existsSync(path.join(CACHE, 'gs.wasm'))) {
  throw new Error(
    `${CACHE} holds no gs.wasm — run \`BROWSERSNIP_GS_DUMP=… npx vitest run tests/pdf/font-outline.test.ts\` first`,
  );
}
fs.mkdirSync(outDir, { recursive: true });

const load = await import(pathToFileURL(path.join(CACHE, 'gs.js')).href);
const gs = await load.default({
  locateFile: (file) => path.join(CACHE, file),
  print: () => {},
  printErr: (line) => lines.push(line),
});

const IN = '/tmp/input.pdf';
const OUT = '/tmp/output.pdf';
let lines = [];
const collected = new Set();

/** The pre-fix shape: the switch in one argument, its path in the next. */
function splitOutputFile(args) {
  return args.flatMap((arg) =>
    arg.startsWith('-sOutputFile=')
      ? ['-sOutputFile', arg.slice('-sOutputFile='.length)]
      : [arg],
  );
}

function runOnce(args, tag, vector) {
  lines = [];
  gs.FS.writeFile(IN, new Uint8Array(fs.readFileSync(input)));
  let exit;
  try {
    exit = gs.callMain(args.slice());
  } catch (error) {
    console.log(`${vector} [${tag}] threw in the host: ${error.message}`);
    return null;
  }
  let bytes = 0;
  try {
    const out = gs.FS.readFile(OUT);
    bytes = out.length;
    // The input's name is part of the output's: one directory, several fixtures,
    // and a proof that overwrites itself measures nothing.
    const stem = `${path.basename(input, '.pdf')}.${vector}.${tag}`.replace(/[^A-Za-z0-9._()-]+/g, '_');
    fs.writeFileSync(path.join(outDir, `${stem}.pdf`), Buffer.from(out));
    collected.add(`${vector} [${tag}] → ${stem}.pdf`);
  } catch {
    /* no output file at all — the defect */
  }
  try {
    gs.FS.unlink(IN);
    gs.FS.unlink(OUT);
  } catch {
    /* never created */
  }
  const said = lines.filter((l) => /error|unable|requires/i.test(l)).map((l) => l.trim());
  console.log(`${vector} [${tag}] exit ${exit}  out ${bytes} B${said.length ? `  gs said: ${said.join(' / ')}` : ''}`);
  return { exit, bytes };
}

console.log(`engine: ${path.relative(process.cwd(), CACHE)}/gs.wasm — `
  + `${fs.statSync(path.join(CACHE, 'gs.wasm')).size} bytes, `
  + `sha256 ${createHash('sha256').update(fs.readFileSync(path.join(CACHE, 'gs.wasm'))).digest('hex').slice(0, 16)}…`);
console.log(`input : ${input} — ${fs.statSync(input).size} bytes`);

for (const { tool, args } of JSON.parse(fs.readFileSync(vectorsFile, 'utf8'))) {
  runOnce(splitOutputFile(args), 'split-output-file (pre-4ad2be3)', tool);
  runOnce(args, 'as-built', tool);
}

if (collected.size) {
  console.log('\nproduced, in <outdir>:');
  for (const line of [...collected].sort()) console.log(`  ${line}`);
}
