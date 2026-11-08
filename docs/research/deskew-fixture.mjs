// deskew fixture — a text page turned by a *known* angle, for the `deskew-pdf`
// row of docs/TOOL-CAMPAIGN.md.
//
//   node docs/research/deskew-fixture.mjs --dir /tmp/deskew --angles -6,-3,3,6
//
// `--angles` are **PDF user-space degrees, positive = counterclockwise as the
// page is viewed** — the same spelling as `/Rotate` and pdf-lib's `degrees()`.
// The whole content stream is wrapped in one `cm`, so every line carries exactly
// that tilt, which is what a skewed scan looks like. The page box grows to the
// rotated bounding rectangle so no glyph is clipped by the crop.
//
// Why the spelling is written down: the estimator reads the rendered bitmap,
// where y runs *downward*, so its angle is the negative of this number, and
// `applySkew` used to be handed the bitmap sign as if it were the user-space
// one. See `deskew-residual.py`, which measures the file rather than the report.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// The package's ESM entry is extensionless-import source, which Node refuses to
// resolve; the CommonJS build of the same version is what `require` answers with,
// and a research script only needs to *write* a fixture.
const { PDFDocument, PDFDict, PDFName, PDFRef, StandardFonts } = createRequire(import.meta.url)('@maxwbh/pdf-lib');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};

const DIR = arg('dir', '/tmp/deskew');
const ANGLES = String(arg('angles', '-6,-3,3,6'))
  .split(',')
  .map((part) => Number.parseFloat(part.trim()))
  .filter(Number.isFinite);
const LINE_COUNT = Number(arg('lines', 40));
const BOX = [595, 842]; // A4 portrait, the size this app's own tools produce

const WORDS =
  'Quarterly reconciliation of the scanned ledger sheets, with the marginal notes retained'.split(' ');

/** One line of plausible body copy; long enough that a 3° tilt moves its ends. */
function lineText(index) {
  const words = [];
  for (let w = 0; w < 12; w++) words.push(WORDS[(index * 7 + w) % WORDS.length]);
  return `${String(index + 1).padStart(2, '0')} ${words.join(' ')}`;
}

function esc(value) {
  return value.replace(/([\\()])/g, String.raw`\$1`);
}

/** Register a font on the page and return the resource name it landed under. */
function fontKey(page, doc, font) {
  page.drawText(' ', { x: 0, y: 0, size: 1, font });
  const entry = page.node.Resources()?.get(PDFName.of('Font'));
  const dict = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
  if (!(dict instanceof PDFDict)) throw new Error('the fixture page has no /Font to read');
  const [key] = [...dict.keys()];
  return `${key}`.replace(/^\//, '');
}

/** Build one page turned by `turn` user-space degrees and return its bytes. */
async function fixture(turn) {
  const doc = await PDFDocument.create();
  const page = doc.addPage(BOX);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const name = fontKey(page, doc, font);

  const lines = [];
  for (let i = 0; i < LINE_COUNT; i++) {
    const y = BOX[1] - 70 - i * 16;
    lines.push(`BT /${name} 11 Tf 72 ${y.toFixed(2)} Td (${esc(lineText(i))}) Tj ET`);
  }

  const rad = (turn * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners = [
    [0, 0],
    [BOX[0], 0],
    [0, BOX[1]],
    [BOX[0], BOX[1]],
  ].map(([x, y]) => [x * cos - y * sin, x * sin + y * cos]);
  const minX = Math.min(...corners.map((c) => c[0]));
  const maxX = Math.max(...corners.map((c) => c[0]));
  const minY = Math.min(...corners.map((c) => c[1]));
  const maxY = Math.max(...corners.map((c) => c[1]));

  const content = [
    'q',
    `${cos.toFixed(6)} ${sin.toFixed(6)} ${(-sin).toFixed(6)} ${cos.toFixed(6)} ${(-minX).toFixed(3)} ${(-minY).toFixed(3)} cm`,
    ...lines,
    'Q',
  ].join('\n');
  page.node.set(
    PDFName.of('Contents'),
    doc.context.register(doc.context.stream(content)),
  );
  page.setMediaBox(-minX, -minY, maxX - minX, maxY - minY);
  doc.setTitle(`Deskew fixture ${turn} degrees`);
  return {
    bytes: await doc.save({ useObjectStreams: false }),
    box: [maxX - minX, maxY - minY],
  };
}

const label = (turn) => `tilt-${turn < 0 ? `n${-turn}` : `p${turn}`}`;

mkdirSync(DIR, { recursive: true });
console.log('angle  file                       page box      bitmap/PyMuPDF sign');
for (const turn of ANGLES) {
  const { bytes, box } = await fixture(turn);
  const path = `${DIR}/${label(turn)}.pdf`;
  writeFileSync(path, bytes);
  console.log(
    `${String(turn).padStart(5)}  ${path}  ${box.map((v) => v.toFixed(1)).join(' x ')}` +
      `   ${(-turn).toFixed(2)}`,
  );
}
