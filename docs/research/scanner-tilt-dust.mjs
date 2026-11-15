// Two sheets `scanner-effect` is asked about by round 045, and `colour-fixture.mjs`
// does not carry.
//
//   node docs/research/scanner-tilt-dust.mjs --dir /tmp/colour
//
//  · `tilt.pdf` — the campaign's body copy with every line and a solid bar turned
//    **3°**, so "does the tool straighten anything" is an angle measured off the
//    produced pixels rather than an adjective. The tool is a grader with no geometry
//    stage (`tools/edit.ts` `scanner-effect` → `rerasterise`: filter, whiten,
//    sharpen), so the expected answer is 3.00° in and 3.00° out, and the copy must
//    not imply otherwise.
//  · `dust.pdf` — 40 isolated 1 pt dots on clean paper. Nothing in that pipeline
//    deletes a small dark blob, so the dots are the control for a card that might
//    claim a speckle pass.
//
// `scanner-tilt-dust.py` reads both back: the bar's top edge as a least-squares
// angle, and the dots as connected dark components inside the grid.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { PDFDocument, StandardFonts, degrees, rgb } = createRequire(import.meta.url)('@maxwbh/pdf-lib');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};

const DIR = arg('dir', '/tmp/colour');
const BOX = [420, 595];
const WORDS
  = 'Quarterly reconciliation of the scanned ledger sheets with marginal notes retained'
    .split(' ');

async function tilt() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(BOX);
  page.drawRectangle({ x: 40, y: 520, width: 340, height: 14, color: rgb(0, 0, 0), rotate: degrees(3) });
  for (let line = 0; line < 24; line++) {
    let text = '';
    for (let w = 0; w < 8; w++) text += ` ${WORDS[(line * 3 + w) % WORDS.length]}`;
    page.drawText(text.trim(), {
      x: 40,
      y: 470 - line * 14,
      size: 10,
      font,
      color: rgb(0, 0, 0),
      rotate: degrees(3),
    });
  }
  return doc.save({ useObjectStreams: false });
}

async function dust() {
  const doc = await PDFDocument.create();
  const page = doc.addPage(BOX);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('dust control sheet', { x: 40, y: 540, size: 10, font, color: rgb(0, 0, 0) });
  // 8 × 5 grid of 68 × 52 pt cells: no dot can touch another, so each one is a
  // component of its own whatever the pipeline does to its edges.
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 5; col++) {
      page.drawRectangle({ x: 40 + col * 68, y: 460 - row * 52, width: 1, height: 1, color: rgb(0, 0, 0) });
    }
  }
  return doc.save({ useObjectStreams: false });
}

mkdirSync(DIR, { recursive: true });
for (const [name, build] of [['tilt', tilt], ['dust', dust]]) {
  const bytes = await build();
  writeFileSync(`${DIR}/${name}.pdf`, bytes);
  console.log(`${DIR}/${name}.pdf`, bytes.byteLength, 'bytes');
}
