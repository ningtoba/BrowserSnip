// The greyscale chart — the sheet every colour→grey path in this app is measured
// against.
//
//   node docs/research/greyscale-chart.mjs --dir /tmp/greyscale
//   node docs/research/greyscale-chart.mjs --dir /tmp/greyscale --check
//
// It is `colour-fixture.mjs` extended, not a second rig founded beside it: the sheet
// is drawn by that file's `BOX` / `rectOf` / `drawSwatchSheet`, so a swatch is the
// same "region of known colour" the campaign's colour row already meant, and the
// fractions are **written out** to `greyscale-chart.json` rather than copied into the
// next reader. `docs/research/greyscale-chart-read.py` reads that JSON and imports
// `colour-ink.py` for the raster maths; `tests/pdf/greyscale-standard.test.ts` reads
// the same JSON. One table, three consumers, zero hand-copied numbers.
//
// What the 24 swatches are, and why those:
//  · the inks an editor actually puts on a page — the annotation red, green, blue and
//    highlighter yellow of `SWATCHES` in `components/tools/pdf/editor/tools.ts`, plus
//    the text-marker wash and the pen's near-black;
//  · the campaign fixture's own red / green / blue, so the headline number of
//    `docs/research/greyscale-standard-decision.md` (230,26,26 → 87 under BT.601,
//    69 under Rec.709) is on the sheet that proves it rather than in prose;
//  · flat greys at 89 / 128 / 166, near-black at 10 and 0, near-white at 250 and
//    paper at 255 — the swatches a correct standard must leave **exactly** where they
//    started, because the luma weights sum to 1;
//  · a saturated cyan/magenta pair and the pure primaries, which are where two luma
//    standards disagree the most, so a merge would show up here first.
//
// `--check` rebuilds the sheet in a second process and fails if any byte moved except
// the producer's own timestamp, so the committed PDF, the committed JSON and the test
// cannot silently drift apart.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { BOX, drawSwatchSheet } from './colour-fixture.mjs';

const pdfLib = createRequire(import.meta.url)('@maxwbh/pdf-lib');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};

const DIR = arg('dir', '/tmp/greyscale');
const CHECK = process.argv.includes('--check');

/**
 * The swatches, in grid order. `source` names where each colour comes from, because a
 * chart made of invented colours proves things about the chart.
 */
export const SWATCHES = [
  { name: 'red-ink', rgb: [220, 38, 38], source: 'editor/tools.ts SWATCHES + strikeout default' },
  { name: 'green-ink', rgb: [5, 150, 105], source: 'editor/tools.ts SWATCHES' },
  { name: 'highlight', rgb: [255, 235, 59], source: 'editor/tools.ts highlighter default' },
  { name: 'marker-wash', rgb: [255, 243, 163], source: 'editor/tools.ts text-marker default' },
  { name: 'orange', rgb: [255, 152, 0], source: 'editor/tools.ts SWATCHES' },
  { name: 'pink', rgb: [233, 30, 99], source: 'editor/tools.ts SWATCHES' },
  { name: 'violet', rgb: [139, 92, 246], source: 'editor/tools.ts SWATCHES' },
  { name: 'blue-ink', rgb: [37, 99, 235], source: 'editor/tools.ts SWATCHES' },
  { name: 'pen-ink', rgb: [27, 27, 24], source: 'editor/tools.ts pen default' },
  { name: 'fixture-red', rgb: [230, 26, 26], source: 'colour-fixture.mjs sheet 2' },
  { name: 'fixture-green', rgb: [26, 178, 51], source: 'colour-fixture.mjs sheet 2' },
  { name: 'fixture-blue', rgb: [26, 51, 230], source: 'colour-fixture.mjs sheet 2' },
  { name: 'pure-red', rgb: [255, 0, 0], source: 'the widest 601/709 disagreement' },
  { name: 'pure-green', rgb: [0, 255, 0], source: 'the widest 601/709 disagreement' },
  { name: 'cyan', rgb: [0, 255, 255], source: 'the saturated pair the brief asks for' },
  { name: 'magenta', rgb: [255, 0, 255], source: 'the saturated pair the brief asks for' },
  { name: 'grey-89', rgb: [89, 89, 89], source: 'colour-fixture.mjs `grey`' },
  { name: 'grey-128', rgb: [128, 128, 128], source: 'the contrast pivot' },
  { name: 'grey-166', rgb: [166, 166, 166], source: 'colour-fixture.mjs `wash`' },
  { name: 'near-white', rgb: [250, 250, 250], source: 'paper that is not quite paper' },
  { name: 'paper', rgb: [255, 255, 255], source: 'the page itself' },
  { name: 'near-black', rgb: [10, 10, 10], source: 'ink that is not quite ink' },
  { name: 'text-black', rgb: [0, 0, 0], source: 'body copy' },
  { name: 'cmyk-look-red', rgb: [181, 21, 28], source: 'a print red, for the PDF/A path' },
];

/** The two standards, spelled here so the table says which is which. */
const LUMA_709 = [0.2126, 0.7152, 0.0722];
const LUMA_601 = [0.299, 0.587, 0.114];
const luma = (w, [r, g, b]) => w[0] * r + w[1] * g + w[2] * b;

/** The sheet twice: once as stored, once turned, so both spaces are measured. */
async function chartFixture() {
  const doc = await pdfLib.PDFDocument.create();
  doc.setTitle('greyscale chart: 24 swatches of known colour, stored and turned');
  const sheet = drawSwatchSheet(doc, SWATCHES, 0);
  // The same page again carrying `/Rotate 90`, because every raster path photographs
  // the page *as displayed* while the vector path rewrites the operators as stored. A
  // standard that only holds in one of those two spaces has not been unified.
  drawSwatchSheet(doc, SWATCHES, 90);
  return { doc, regions: sheet.regions };
}

const { doc, regions } = await chartFixture();
const bytes = await doc.save({ useObjectStreams: false });

/** `/ModDate` and the `/ID` move every run; nothing else may. */
const stripStamp = (buf) => {
  const text = Buffer.from(buf).toString('latin1');
  return text.replace(/\/(ModDate|CreationDate) \(D:[^)]*\)/g, '/$DATE').replace(/\/ID \[[^\]]*\]/g, '/ID');
};

const table = {
  sheet: { widthPt: BOX[0], heightPt: BOX[1] },
  pages: [
    { page: 1, rotate: 0, label: 'as stored' },
    { page: 2, rotate: 90, label: 'displayed through /Rotate 90' },
  ],
  luma: { used: 'Rec.709', coefficients: LUMA_709, retired: LUMA_601 },
  swatches: SWATCHES.map((s) => ({
    name: s.name,
    rgb: s.rgb,
    source: s.source,
    region: regions[s.name],
    grey709: luma(LUMA_709, s.rgb),
    grey601: luma(LUMA_601, s.rgb),
  })),
};

if (CHECK) {
  const previous = readFileSync(`${DIR}/greyscale-chart.pdf`);
  const a = stripStamp(previous);
  const b = stripStamp(bytes);
  if (a !== b) {
    console.error('greyscale-chart: the rebuilt sheet differs from the committed one.');
    process.exit(1);
  }
  console.log(`greyscale-chart: reproducible, ${SWATCHES.length} swatches.`);
} else {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/greyscale-chart.pdf`, bytes);
  writeFileSync(`${DIR}/greyscale-chart.json`, `${JSON.stringify(table, null, 2)}\n`);
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  console.log(
    `${DIR}/greyscale-chart.pdf`,
    bytes.byteLength,
    'bytes',
    digest,
    `· ${SWATCHES.length} swatches · table greyscale-chart.json`,
  );
}

export { table };
