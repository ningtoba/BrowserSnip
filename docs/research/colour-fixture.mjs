// Colour-tool fixtures — the sheets `invert-colors`, `adjust-colors` and
// `scanner-effect` are measured against.
//
//   node docs/research/colour-fixture.mjs --dir /tmp/colour
//
// The campaign's question for these three is not "is there ink" — a blank page
// inverts to a blank page, so ink-presence alone cannot tell a working colour tool
// from a broken one. What can is **polarity** and **direction**, and those need
// regions whose colour is known before anything is rasterised. `colour-ink.py`
// reads the fractional rectangles below out of both the source page and the
// produced one, so every claim is a comparison with the sheet it started from.
//
// Three sheets:
//  · `text`   — a solid black bar, 26 lines of body copy, and a clean white band.
//               The bar and the band are the two regions invert must swap.
//  · `colour` — solid red / green / blue squares for saturation, hue and greyscale,
//               plus two flat greys — one dark of centre, one light — because
//               `contrast` has a fixed point at the midpoint and a single 50 % grey
//               square cannot show which way a contrast setting turned a page.
//  · `empty`  — the control: nothing on it, so a pass that invents paper noise is
//               caught rather than averaged away.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { PDFDocument, StandardFonts, degrees, rgb } = createRequire(import.meta.url)('@maxwbh/pdf-lib');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};

const DIR = arg('dir', '/tmp/colour');
mkdirSync(DIR, { recursive: true });

/** A5-ish, matching `rasterize-fixture.mjs` so the campaign's numbers compare. */
const BOX = [420, 595];

/**
 * The named regions, as fractions of the *displayed* sheet from its top-left —
 * the same table `colour-ink.py` carries, in the same order. On a page carrying
 * `/Rotate` the two spaces differ, which is why `rotatedFixture` places its ink
 * through the turn rather than with `rectOf`.
 */
export const REGIONS = {
  bar: { x0: 0.10, y0: 0.10, x1: 0.90, y1: 0.22 },
  copy: { x0: 0.08, y0: 0.26, x1: 0.92, y1: 0.82 },
  band: { x0: 0.10, y0: 0.86, x1: 0.90, y1: 0.97 },
  red: { x0: 0.10, y0: 0.10, x1: 0.32, y1: 0.30 },
  green: { x0: 0.39, y0: 0.10, x1: 0.61, y1: 0.30 },
  blue: { x0: 0.68, y0: 0.10, x1: 0.90, y1: 0.30 },
  grey: { x0: 0.10, y0: 0.36, x1: 0.32, y1: 0.50 },
  wash: { x0: 0.39, y0: 0.36, x1: 0.61, y1: 0.50 },
};

const WORDS
  = 'Quarterly reconciliation of the scanned ledger sheets with the marginal notes retained'
    .split(' ');

function lineText(index) {
  const words = [];
  for (let w = 0; w < 9; w++) words.push(WORDS[(index * 5 + w) % WORDS.length]);
  return `${String(index + 1).padStart(2, '0')} ${words.join(' ')}`;
}

/** PDF-space rectangle for a fractional region of an unturned page, y from the bottom. */
function rectOf(region) {
  return {
    x: region.x0 * BOX[0],
    y: BOX[1] - region.y1 * BOX[1],
    width: (region.x1 - region.x0) * BOX[0],
    height: (region.y1 - region.y0) * BOX[1],
  };
}

/**
 * A displayed rectangle on a page carrying `/Rotate 90`, in that page's own coordinates.
 *
 * `colour-ink.py` names its regions in **displayed** fractions, because that is what
 * pdf.js paints and what PyMuPDF rasterises (`page.rect` is the turned box). On a turned
 * sheet the fixture therefore has to place its ink where the turn will leave it: rotating
 * the page clockwise sends its own left edge to the displayed top, so a displayed
 * rectangle (u across, v down) is written at stored `x = v`, `y = u`. Measured rather than
 * trusted — a mirrored inverse reads back as paper where the bar should be, which is
 * exactly how a colour row on a rotated page would compare the wrong features.
 */
function displayedRect(region) {
  return {
    x: region.y0 * BOX[0],
    y: region.x0 * BOX[1],
    width: (region.y1 - region.y0) * BOX[0],
    height: (region.x1 - region.x0) * BOX[1],
  };
}

async function colourFixture() {
  const doc = await PDFDocument.create();
  doc.setTitle('colour-tool fixture: bar + copy + band, colour squares, empty');
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const text = doc.addPage(BOX);
  text.drawRectangle({ ...rectOf(REGIONS.bar), color: rgb(0, 0, 0) });
  for (let line = 0; line < 26; line++) {
    text.drawText(lineText(line), {
      x: 34,
      y: BOX[1] - 172 - line * 13,
      size: 10,
      font,
      color: rgb(0, 0, 0),
    });
  }

  const colour = doc.addPage(BOX);
  colour.drawRectangle({ ...rectOf(REGIONS.red), color: rgb(0.9, 0.1, 0.1) });
  colour.drawRectangle({ ...rectOf(REGIONS.green), color: rgb(0.1, 0.7, 0.2) });
  colour.drawRectangle({ ...rectOf(REGIONS.blue), color: rgb(0.1, 0.2, 0.9) });
  // 89 and 166: each side of the contrast pivot at 128, so a contrast boost must
  // move them in *opposite* directions and a control that does the opposite of its
  // label cannot pass.
  colour.drawRectangle({ ...rectOf(REGIONS.grey), color: rgb(0.35, 0.35, 0.35) });
  colour.drawRectangle({ ...rectOf(REGIONS.wash), color: rgb(0.65, 0.65, 0.65) });
  colour.drawText('colour sheet', { x: 34, y: 60, size: 10, font, color: rgb(0, 0, 0) });

  doc.addPage(BOX); // the empty control

  // Sheet 4: the same displayed regions on a page that stores a portrait box and carries
  // `/Rotate 90`. It is the turned case the campaign asks a rasteriser to prove, and it is
  // what keeps this fixture's fractions honest.
  const turned = doc.addPage(BOX);
  turned.setRotation(degrees(90));
  turned.drawRectangle({ ...displayedRect(REGIONS.bar), color: rgb(0, 0, 0) });
  turned.drawRectangle({ ...displayedRect(REGIONS.copy), color: rgb(0.1, 0.7, 0.2) });
  turned.drawRectangle({ ...displayedRect(REGIONS.band), color: rgb(1, 1, 1) });
  return doc.save({ useObjectStreams: false });
}

const bytes = await colourFixture();
writeFileSync(`${DIR}/colour.pdf`, bytes);
console.log(`${DIR}/colour.pdf`, bytes.byteLength, 'bytes');
