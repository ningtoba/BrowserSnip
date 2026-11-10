/**
 * pdf.js over the damage corpus: the app's own renderer judging both sides.
 *
 *   node docs/research/repair-damage-pdfjs.mjs <dir>
 *
 * `repair-damage-readers.py` asks MuPDF, qpdf, poppler, pypdf and Ghostscript; this
 * asks the engine this app actually renders with, which is a different
 * implementation from the pdf-lib fork that wrote the produced bytes. It prints one
 * line per case: what pdf.js reads out of the damaged input, and what it reads out
 * of what `repair` wrote — page count plus, per sheet, whether a planted word
 * survives (`W`) and whether the display list holds any painting operator (`P`).
 *
 * The point of running it beside the Python readers is the campaign's standing rule:
 * a page count that agrees while every sheet is paper is the failure this project
 * keeps meeting, and only a reader that builds a display list can see it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDocument, GlobalWorkerOptions, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

GlobalWorkerOptions.workerSrc = `file://${process.cwd()}/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs`;

const PAINT_NAMES = [
  'stroke', 'closeStroke', 'fill', 'eoFill', 'fillStroke', 'shadingFill', 'paintXObject',
  'paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject',
  'showText', 'showSpacedText', 'nextLineShowText', 'nextLineSetSpacingShowText',
];
const PAINT_IDS = new Set(PAINT_NAMES.map((name) => OPS[name]));

const DIR = process.argv[2] ?? '/tmp/rd';
const WORDS = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')).sheet_words;

/** `P`/`.` for paints-or-not and `W`/`-` for a planted word, one pair per sheet. */
async function scan(path) {
  let doc;
  try {
    doc = await getDocument({
      data: new Uint8Array(readFileSync(path)),
      isEvalSupported: false,
      disableFontFace: true,
      standardFontDataUrl: `file://${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/`,
    }).promise;
  } catch (error) {
    return `refused (${String(error.message).slice(0, 28)})`;
  }
  const marks = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const [content, operators] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
    const text = content.items.map((item) => String('str' in item ? item.str : '')).join('');
    const paints = operators.fnArray.some((id) => PAINT_IDS.has(id));
    const words = WORDS.some((word) => text.includes(word));
    marks.push(`${paints ? 'P' : '.'}${words ? 'W' : '-'}`);
    page.cleanup();
  }
  const pages = doc.numPages;
  await doc.destroy();
  return `${pages}p [${marks.join(' ')}]`;
}

console.log('case                     pdf.js reads the input    pdf.js reads the repaired file');
for (const name of readdirSync(join(DIR, 'corpus')).filter((item) => item.endsWith('.pdf')).sort()) {
  const input = await scan(join(DIR, 'corpus', name));
  let outLine = 'no file';
  try {
    outLine = await scan(join(DIR, 'out', name));
  } catch { /* the tool refused this one, which `repair-damage-measure.mjs` records */ }
  console.log(`${name.replace('.pdf', '').padEnd(24)} ${input.padEnd(26)} ${outLine}`);
}
