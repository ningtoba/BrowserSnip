/**
 * Fixtures for the eight tools the triage never reached.
 *
 * Each one is built so an outside reader can answer the tool's own question
 * without knowing anything about how the app writes: page sizes differ (so a
 * placement computed against the wrong page shows up), every page is labelled and
 * ruled (so "the mark landed off the sheet" is visible in the numbers, not just in
 * a screenshot), and the text on the page is planted per page (so a tool that
 * silently loses a page is caught).
 *
 *   node docs/research/verify-eight-fixtures.mjs <dir>
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts, rgb } = require('@maxwbh/pdf-lib');

const out = process.argv[2];
if (!out) throw new Error('usage: verify-eight-fixtures.mjs <dir>');
mkdirSync(out, { recursive: true });

/** Page 1 A4 portrait, page 2 A4 portrait, page 3 a small 400x300 sheet. */
export const SIZES = [[595, 842], [595, 842], [400, 300]];

/** A page that reports its own size and edges, and carries a sentence. */
function ruledPage(doc, font, index, [width, height]) {
  const page = doc.addPage([width, height]);
  const line = (x1, y1, x2, y2) => page.drawLine({
    start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
    thickness: 1, color: rgb(0.6, 0.6, 0.6),
  });
  line(20, 20, width - 20, 20);
  line(20, height - 20, width - 20, height - 20);
  line(20, 20, 20, height - 20);
  line(width - 20, 20, width - 20, height - 20);
  page.drawText(`PAGE ${index + 1} ${width}x${height}`, { x: 30, y: height - 45, size: 14, font, color: rgb(0, 0, 0) });
  page.drawText(`alice${index + 1}bravo`, { x: 30, y: height / 2, size: 12, font, color: rgb(0, 0, 0) });
  page.drawText('lower-left', { x: 30, y: 30, size: 10, font, color: rgb(0.3, 0.3, 0.3) });
  return page;
}

async function ruled() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const [index, size] of SIZES.entries()) ruledPage(doc, font, index, size);
  doc.setTitle('Eight-tool fixture');
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

/** A PDF with an embedded file already inside, for the editor/extractor direction. */
async function plain() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText('PLAIN ONE PAGE', { x: 40, y: 700, size: 16, font });
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

writeFileSync(join(out, 'ruled.pdf'), await ruled());
writeFileSync(join(out, 'plain.pdf'), await plain());
console.log('wrote', join(out, 'ruled.pdf'), join(out, 'plain.pdf'));
