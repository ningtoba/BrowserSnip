// ocr-pdf fixture — a page whose text is known verbatim, plus the two other
// sheets the OCR answer has to tell apart.
//
//   node docs/research/ocr-fixture.mjs --dir /tmp/ocr
//
// `planted.pdf` holds three sheets:
//   1. copy whose every word is listed in `planted.json`, big enough (16 pt)
//      that a legible scan of it is something a recogniser must read;
//   2. one smooth gradient with no letter shapes at all — ink, but nothing to
//      read, which is the "read but found no text" case;
//   3. an empty sheet, which is the "page was blank" case and must be *measured*
//      rather than guessed from the absence of words.
//
// Sheet 1 goes through the shipped `rasterize-pdf` first (see `ocr-round-trip.mjs`)
// so what the OCR tool receives is an image-only PDF: no text layer to lean on,
// and the planted words can only come back through the recogniser.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';

// See `deskew-fixture.mjs`: the package's ESM entry imports extensionless files,
// which Node will not resolve; the CommonJS build is enough for writing fixtures.
const { PDFDocument, StandardFonts, rgb } = createRequire(import.meta.url)('@maxwbh/pdf-lib');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};

const DIR = arg('dir', '/tmp/ocr');
mkdirSync(DIR, { recursive: true });

/** A5-ish: legible at 200 dpi, quick enough to rasterise and re-render. */
const BOX = [420, 595];

/** The exact lines sheet 1 carries. The checker compares these strings. */
const LINES = [
  'Lighthouse Inventory 1887',
  'Quartermaster Peverell kept the glass',
  'Eleven brass candles and one spare wick',
  'The harbour master signed at Bristol',
  'Nineteen crates of salted cod',
  'A storm took the west stair away',
];

/** A real 8-bit RGB PNG (same writer `rasterize-fixture.mjs` uses). */
function pngBytes(px, py, tone) {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 0;
    table[n] = c >>> 0;
  }
  const crc = (buf) => {
    let c = -1;
    for (const byte of buf) c = (c >>> 8) ^ table[(c ^ byte) & 0xff];
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(px, 0);
  header.writeUInt32BE(py, 4);
  header[8] = 8;
  header[9] = 2; // truecolour, no alpha
  const stride = 1 + px * 3;
  const rows = Buffer.alloc(py * stride);
  for (let y = 0; y < py; y++) {
    for (let x = 0; x < px; x++) {
      const [r, g, b] = tone(x, y);
      const at = y * stride + 1 + x * 3;
      rows[at] = r;
      rows[at + 1] = g;
      rows[at + 2] = b;
    }
  }
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

/** Ink without letter shapes: one soft diagonal ramp, no edges, no strokes. */
const gradient = pngBytes(200, 260, (x, y) => {
  const v = 70 + (x / 200) * 90 + (y / 260) * 60;
  const c = Math.max(0, Math.min(255, Math.round(v)));
  return [c, c, c];
});

async function fixture() {
  const doc = await PDFDocument.create();
  doc.setTitle('ocr-pdf fixture: planted text, inkless letters, empty sheet');
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const page = doc.addPage(BOX);
  LINES.forEach((line, index) => {
    page.drawText(line, {
      x: 40,
      y: BOX[1] - 70 - index * 46,
      size: 16,
      font,
      color: rgb(0, 0, 0),
    });
  });

  const picture = doc.addPage(BOX);
  const image = await doc.embedPng(gradient);
  picture.drawImage(image, { x: 40, y: 170, width: BOX[0] - 80, height: 260 });

  doc.addPage(BOX); // the empty sheet
  return doc.save({ useObjectStreams: false });
}

const bytes = await fixture();
writeFileSync(`${DIR}/planted.pdf`, bytes);
writeFileSync(`${DIR}/planted.json`, `${JSON.stringify({ box: BOX, lines: LINES }, null, 2)}\n`);
console.log(`${DIR}/planted.pdf`, bytes.byteLength, 'bytes;', LINES.length, 'planted lines');
