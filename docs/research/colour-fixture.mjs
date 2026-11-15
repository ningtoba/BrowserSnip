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
//  · `black` / `white` — a sheet of one tone each, the two ends of the inverse. A
//               black sheet inverted is paper, and paper on the produced page's own
//               white sheet is indistinguishable from margins: this pair is the only
//               way to see that the produced page is the *size of the sheet* rather
//               than the size of its ink.
//  · `turned-landscape` — a stored 595×420 box carrying `/Rotate 90`, so the
//               displayed sheet is portrait. A tool that copies the stored box
//               instead of the displayed one answers 595×420 here, which is the
//               opposite of the 420×595 sheet 4 (`stored portrait`, displayed
//               landscape) and cannot be passed by copying either.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { PDFDocument, StandardFonts, degrees, rgb } = createRequire(import.meta.url)('@maxwbh/pdf-lib');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};

const DIR = arg('dir', '/tmp/colour');

/** A5-ish, matching `rasterize-fixture.mjs` so the campaign's numbers compare. */
export const BOX = [420, 595];

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
export function rectOf(region) {
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

/**
 * One sheet of solid swatches in a regular grid, and the table that says where each
 * one landed.
 *
 * Shared with `greyscale-chart.mjs` so the chart that measures the greyscale standard
 * is drawn by the same code that drew the campaign's colour sheet: one placement rule,
 * one notion of "a region of known colour", and the fractions come *out* of the writer
 * into a JSON sidecar that `greyscale-chart-read.py` reads back. A second hand-copied
 * region table is how a rig starts measuring the wrong square.
 */
export function swatchGrid(count, columns = 4) {
  const rows = Math.ceil(count / columns);
  const margin = 0.06;
  const gap = 0.025;
  const cellW = (1 - 2 * margin - (columns - 1) * gap) / columns;
  const cellH = (1 - 2 * margin - (rows - 1) * gap) / rows;
  const regions = {};
  for (let i = 0; i < count; i++) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    regions[i] = {
      x0: margin + col * (cellW + gap),
      y0: margin + row * (cellH + gap),
      x1: margin + col * (cellW + gap) + cellW,
      y1: margin + row * (cellH + gap) + cellH,
    };
  }
  return regions;
}

/**
 * Draw `swatches` (`{ name, rgb }`, channels 0..255) as one sheet of solid blocks.
 *
 * With `rotate: 90` the page stores a portrait box and carries `/Rotate 90`, and the ink
 * is placed **through** the turn by `displayedRect` — so the fractions that come back are
 * *displayed* fractions in both cases, which is the only space in which pdf.js, PyMuPDF
 * and the reader below agree about which square is which. Writing them at stored
 * fractions instead would leave the turned sheet's table describing a page nobody sees.
 */
export function drawSwatchSheet(doc, swatches, rotate = 0) {
  const regions = swatchGrid(swatches.length);
  const page = doc.addPage(BOX);
  const place = rotate === 90 ? displayedRect : rectOf;
  if (rotate) page.setRotation(degrees(rotate));
  swatches.forEach((swatch, index) => {
    page.drawRectangle({
      ...place(regions[index]),
      color: rgb(swatch.rgb[0] / 255, swatch.rgb[1] / 255, swatch.rgb[2] / 255),
    });
  });
  const out = {};
  swatches.forEach((swatch, index) => {
    out[swatch.name] = { ...regions[index], rgb: [...swatch.rgb] };
  });
  return { page, regions: out };
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

  // Sheets 5 and 6: one whole tone each, edge to edge, so there is no white margin
  // anywhere on the source and the whole produced page's tone is the answer.
  doc.addPage(BOX).drawRectangle({ x: 0, y: 0, width: BOX[0], height: BOX[1], color: rgb(0, 0, 0) });
  doc.addPage(BOX).drawRectangle({ x: 0, y: 0, width: BOX[0], height: BOX[1], color: rgb(1, 1, 1) });

  // Sheet 7: the same turn the other way round. It stores a *landscape* box and
  // carries `/Rotate 90`, so the displayed sheet is 420×595 — portrait from a
  // landscape store. Sheet 4 is portrait stored and landscape displayed, so the two
  // together say the produced box follows the display and not the store.
  const wide = doc.addPage([BOX[1], BOX[0]]);
  wide.setRotation(degrees(90));
  // In this page's own (turned) coordinates: `/Rotate 90` sends the stored left edge
  // to the displayed top and the stored bottom edge to the displayed left, so a
  // displayed rectangle (u across, v down) is written at stored `x = v × stored
  // width`, `y = u × stored height` — the same rule `displayedRect` applies with the
  // stored box swapped. The bar is the displayed top band, so it runs down the
  // stored left side.
  const W = BOX[1];
  const H = BOX[0];
  wide.drawRectangle({
    x: REGIONS.bar.y0 * W,
    y: REGIONS.bar.x0 * H,
    width: (REGIONS.bar.y1 - REGIONS.bar.y0) * W,
    height: (REGIONS.bar.x1 - REGIONS.bar.x0) * H,
    color: rgb(0, 0, 0),
  });

  // Sheet 8: a cropped sheet. The 420×595 box is still the /MediaBox, but the page is
  // *displayed* and printed as its /CropBox, so a rasteriser that sizes the output
  // from the media box answers 420×595 here and pads the crop margin into the picture.
  // The crop is exactly the bar region, so every fraction of this sheet is ink and a
  // reader with the wrong box reads the margin as part of the sheet.
  const cropped = doc.addPage(BOX);
  cropped.drawRectangle({ ...rectOf(REGIONS.bar), color: rgb(0, 0, 0) });
  const crop = rectOf(REGIONS.bar);
  cropped.setCropBox(crop.x, crop.y, crop.width, crop.height);
  return doc.save({ useObjectStreams: false });
}

// Running this file *as a script* writes the campaign's three-plus-one sheets. Importing
// it (which `greyscale-chart.mjs` does, to reuse `BOX` / `rectOf` / `drawSwatchSheet`) must
// not, or every chart build would also rewrite `/tmp/colour/colour.pdf`.
const runDirectly
  = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (runDirectly) {
  mkdirSync(DIR, { recursive: true });
  const bytes = await colourFixture();
  writeFileSync(`${DIR}/colour.pdf`, bytes);
  console.log(`${DIR}/colour.pdf`, bytes.byteLength, 'bytes');
}

export { colourFixture };
