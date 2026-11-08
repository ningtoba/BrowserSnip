// Compare fixtures — two documents whose only difference is a rectangle at a
// *known place*, so a verdict can be checked against a coordinate instead of
// against a feeling.
//
//   node docs/research/compare-fixture.mjs --dir /tmp/compare
//
// Writes:
//   a.pdf   — three sheets: body copy, a second page of copy, and an empty one.
//   b.pdf   — the same bytes of layout, plus ONE solid 340×40 pt black block at
//             KNOWN.x0, KNOWN.y0 from the top-left of sheet 1. 340×40 is the
//             rectangle the caller audit measured (`docs/TOOL-CAMPAIGN.md`, the
//             `pdf-engine/commands.ts:442` row), so the numbers here are comparable
//             with that row's "every output page 0.13 % ink".
//   blank.pdf — one empty sheet: the pair "blank versus blank" needs, because a
//             tool that marks two empty pages as different is as wrong as one that
//             marks a planted block as nothing.
//
// Sheet 1 carries the difference, sheet 2 is a *second* page both files have and
// nothing else changes on it (a diff that paints the whole document is the failure
// mode an ink-percentage check cannot see), and sheet 3 is blank in both.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { PDFDocument, StandardFonts, rgb } = createRequire(import.meta.url)('@maxwbh/pdf-lib');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};

const DIR = arg('dir', '/tmp/compare');
mkdirSync(DIR, { recursive: true });

/** Points, the campaign's usual A5-ish sheet. */
export const BOX = [420, 595];

/**
 * The planted difference, in points measured from the **top-left of sheet 1 as
 * displayed** (x right, y down) — the space the pane reports its changed areas in.
 */
export const KNOWN = { page: 1, x0: 40, y0: 60, x1: 380, y1: 100 };

const LINES = [
  'Warehouse transfer log — bay 4',
  'Pallet 118 signed in at 06:40 by R. Adeyemi',
  'Pallet 119 held for re-weigh at the bridge',
  'Forklift 3 serviced; lockout tag removed 07:15',
  'Cold room door gasket ordered, part 88-2241',
  'Two damaged cartons returned to stowage',
  'Shift handover notes carried to page two',
];

const LINES2 = [
  'Handover continued',
  'Bay 4 floor marked, no obstruction noted',
  'Scale calibration certificate on file',
  'Driver manifest reconciled with the WMS',
  'Nothing outstanding for the night shift',
];

async function build(withBlock) {
  const doc = await PDFDocument.create();
  doc.setProducer('compare-fixture');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of [LINES, LINES2]) {
    const page = doc.addPage(BOX);
    lines.forEach((line, index) => {
      // pdf-lib's origin is bottom-left; the listing runs from the top of the sheet.
      page.drawText(line, {
        x: 40,
        y: BOX[1] - 150 - index * 20,
        size: 12,
        font,
        color: rgb(0, 0, 0),
      });
    });
  }
  const blank = doc.addPage(BOX);
  if (withBlock) {
    doc.getPages()[KNOWN.page - 1].drawRectangle({
      x: KNOWN.x0,
      // top-left y down → bottom-left y up
      y: BOX[1] - KNOWN.y1,
      width: KNOWN.x1 - KNOWN.x0,
      height: KNOWN.y1 - KNOWN.y0,
      color: rgb(0, 0, 0),
    });
  }
  void blank;
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

const a = await build(false);
const b = await build(true);
writeFileSync(`${DIR}/a.pdf`, a);
writeFileSync(`${DIR}/b.pdf`, b);

const solo = await PDFDocument.create();
solo.addPage(BOX);
const blankBytes = new Uint8Array(await solo.save({ useObjectStreams: false }));
writeFileSync(`${DIR}/blank.pdf`, blankBytes);

console.log(JSON.stringify({
  dir: DIR,
  box: BOX,
  known: KNOWN,
  pages: { a: 3, b: 3, blank: 1 },
  bytes: { a: a.length, b: b.length, blank: blankBytes.length },
}));
