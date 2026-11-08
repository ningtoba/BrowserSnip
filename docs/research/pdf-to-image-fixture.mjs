// pdf-to-image fixtures — five sheets that differ in ink **and in size**.
//
//   node docs/research/pdf-to-image-fixture.mjs --dir /tmp/p2i
//
// The caller audit found the deployed export as "four identical 44 128-byte PNGs
// at 0.00 % ink", and that sentence has two causes: every page blank, or one page
// exported N times. A fixture whose pages are all the same size cannot tell them
// apart, because five blanks of one size are five identical files. Here every
// sheet has its own box (A5, A4, DL-tall, landscape, square) as well as its own
// ink (a dark block, a light block, body copy, a photograph, an empty control),
// so:
//
//   · distinct pixel sizes in the output ⇒ each page was rendered for itself;
//   · 0 non-white px in each of them   ⇒ the paint, not the selection, is missing;
//   · identical sizes                  ⇒ the loop is stuck on one page.
//
// Drive it with `pdf-to-image-controls.mjs` (rail fields, real clicks) and read
// the download with `pdf-to-image-ink.py`, which compares each image against the
// same page rasterised by PyMuPDF at the same dpi.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';

// The package's ESM entry imports extensionless files, which Node will not
// resolve; the CommonJS build is enough for writing fixtures. See
// `deskew-fixture.mjs` for the same workaround.
const { PDFDocument, StandardFonts, rgb } = createRequire(import.meta.url)('@maxwbh/pdf-lib');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};

const DIR = arg('dir', '/tmp/p2i');
mkdirSync(DIR, { recursive: true });

/** Every sheet's own box, in points — five sizes so blanks cannot be identical. */
const SHEETS = [
  { kind: 'dark', size: [420, 595] },
  { kind: 'light', size: [595, 842] },
  { kind: 'text', size: [300, 700] },
  { kind: 'photo', size: [640, 360] },
  { kind: 'empty', size: [500, 500] },
];

const WORDS
  = 'Quarterly reconciliation of the scanned ledger sheets with the marginal notes retained'
    .split(' ');

function lineText(index) {
  const words = [];
  for (let w = 0; w < 9; w++) words.push(WORDS[(index * 5 + w) % WORDS.length]);
  return `${String(index + 1).padStart(2, '0')} ${words.join(' ')}`;
}

/** A real 8-bit RGB PNG, so the reader on the other end has nothing to forgive. */
function pngBytes(px, py, tone) {
  const raw = Buffer.alloc(px * py * 4 + py);
  let at = 0;
  for (let y = 0; y < py; y++) {
    raw[at++] = 0; // filter: none
    for (let x = 0; x < px; x++) {
      const v = tone(x, y);
      raw[at++] = v;
      raw[at++] = v;
      raw[at++] = v;
      raw[at++] = 255;
    }
  }
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = -1;
    for (const byte of buf) c = (c >>> 8) ^ crcTable[(c ^ byte) & 0xff];
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, body) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length);
    const sum = Buffer.alloc(4);
    const joined = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    sum.writeUInt32BE(crc(joined));
    return Buffer.concat([head, joined, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(px, 0);
  ihdr.writeUInt32BE(py, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);

for (const { kind, size } of SHEETS) {
  const [width, height] = size;
  const page = doc.addPage(size);
  const block = (x0, y0, x1, y1, tone) => {
    page.drawRectangle({
      x: x0 * width,
      y: y0 * height,
      width: (x1 - x0) * width,
      height: (y1 - y0) * height,
      color: rgb(tone / 255, tone / 255, tone / 255),
    });
  };
  if (kind === 'dark') {
    // ~36 % of the sheet near-black: the case no instrument can call blank.
    block(0.1, 0.15, 0.7, 0.75, 12);
  } else if (kind === 'light') {
    // ~28 % at RGB 205 — light enough that a "is it dark?" test would miss it,
    // non-white enough that ink coverage counts every pixel of it.
    block(0.2, 0.1, 0.6, 0.8, 205);
  } else if (kind === 'text') {
    for (let line = 0; line < 26; line++) {
      page.drawText(lineText(line), {
        x: 24,
        y: height - 40 - line * 24,
        size: 12,
        font,
        color: rgb(0, 0, 0),
      });
    }
  } else if (kind === 'photo') {
    // Full-bleed halftone: every pixel a tone, the way a scan rasterises.
    const px = 160;
    const py = 90;
    const image = await doc.embedPng(pngBytes(px, py, (x, y) => (x * 5 + y * 11) % 256));
    page.drawImage(image, { x: 0, y: 0, width, height });
  }
  // 'empty' gets a page box and nothing drawn: the control that pins the probe.
}

const bytes = await doc.save({ useObjectStreams: false });
const out = `${DIR}/sheets.pdf`;
writeFileSync(out, bytes);
console.log(
  `${out}: ${SHEETS.length} pages `
  + `${SHEETS.map((s) => `${s.kind} ${s.size.join('x')}`).join(', ')} (${bytes.length} bytes)`,
);
