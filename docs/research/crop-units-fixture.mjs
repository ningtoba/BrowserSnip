// The four sheets `pdf-crop`'s unit measurement is made on.
//
//   node docs/research/crop-units-fixture.mjs [out.pdf]
//
// Written by hand rather than borrowed from another probe because the point of this
// document is its geometry, and every sheet is there to make one specific mistake
// visible:
//
//   1. 500 x 970 with its /MediaBox at 18,24 — a conversion that forgets the page
//      origin lands on a different number, and 500 + 970 is 1470, close enough to the
//      other sheets that a box built from the wrong pair of edges still looks sane.
//   2. A4 (595.28 x 841.89) and 3. US Letter (612 x 792) together, because 72
//      pt-per-inch against 25.4 mm-per-inch mixed up reads plausible on one and wrong
//      on the other.
//   4. 400 x 700 carrying /Rotate 90: stored portrait, displayed landscape. The tool
//      writes margins into each page's own box, so margins applied in the preview's
//      frame move a corner by the difference between 400 and 700.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// The package's ESM entry is extensionless-import source, which Node refuses to
// resolve; the CommonJS build of the same version is what `require` answers with, and
// a research script only needs to *write* a fixture.
const { PDFDocument, degrees } = createRequire(import.meta.url)('@maxwbh/pdf-lib');

const out = process.argv[2] || '/tmp/crop-units/sheets.pdf';
const doc = await PDFDocument.create();
const sheets = [
  [18, 24, 500, 970, 0],
  [0, 0, 595.28, 841.89, 0],
  [0, 0, 612, 792, 0],
  [0, 0, 400, 700, 90],
];
for (const [x, y, width, height, rotation] of sheets) {
  const page = doc.addPage([width, height]);
  page.setMediaBox(x, y, width, height);
  page.setCropBox(x, y, width, height);
  if (rotation) page.setRotation(degrees(rotation));
  // One diagonal per sheet, so a reader can see which part of the page survived the
  // crop instead of trusting a box it has to take on faith.
  page.drawLine({
    start: { x: x + 8, y: y + 8 },
    end: { x: x + width - 8, y: y + height - 8 },
    thickness: 0.6,
  });
}
const bytes = await doc.save({ useObjectStreams: false });
mkdirSync(out.replace(/\/[^/]+$/, ''), { recursive: true });
writeFileSync(out, bytes);
console.log(`${out}: ${sheets.length} sheets, ${bytes.length} bytes`);
