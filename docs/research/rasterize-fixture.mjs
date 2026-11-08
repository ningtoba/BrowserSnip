// rasterize-pdf fixtures — the four ink cases, and a page carrying /Rotate 90.
//
//   node docs/research/rasterize-fixture.mjs --dir /tmp/rasterize
//
// `ink.pdf` holds the four sheets the campaign measures a rasteriser against:
// body text, a photograph, one thin vector stroke, and an empty page. Drive the
// real tool with them (`rail-tool-bytes.mjs TOOL=rasterize-pdf`) and read the
// download with `rasterize-ink.py` (or `rail-measure.py` for plain ink figures).
//
// `rot90.pdf` carries `/Rotate 90`. `rasterize-pdf` must rasterise a page **as
// displayed**, so a rotated sheet is a second, different exposure from the one the
// `deskew-pdf` row recorded: the risk is sideways ink, a cropped band, or a swapped
// aspect. Its ink is two bands — along the sheet's own left edge and along its own
// top edge — which land on the *displayed* top and right edges once the page is
// turned clockwise, and copy running up the sheet so a mirror is visible too.
// `rasterize-ink.py` names the edges it sees and compares them with the source, so
// the orientation is read off the bytes rather than assumed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';

// See `deskew-fixture.mjs`: the package's ESM entry imports extensionless files,
// which Node will not resolve; the CommonJS build is enough for writing fixtures.
const { PDFDocument, StandardFonts, degrees, rgb } = createRequire(import.meta.url)(
  '@maxwbh/pdf-lib',
);

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};

const DIR = arg('dir', '/tmp/rasterize');
mkdirSync(DIR, { recursive: true });

/** A5-ish: big enough for real ink, small enough to rasterise at 200 dpi fast. */
const BOX = [420, 595];

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
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
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

/** A photograph: three gradients with film grain over them. */
const photograph = pngBytes(220, 300, (x, y) => {
  const n = y * 220 + x;
  const grain = (seed) => {
    const v = Math.sin(n * seed) * 43758.5453;
    return Math.round((v - Math.floor(v)) * 90) - 45;
  };
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return [
    clamp(40 + (x / 220) * 150 + grain(12.9898)),
    clamp(30 + (y / 300) * 140 + grain(78.233)),
    clamp(60 + ((x + y) / 520) * 120 + grain(39.425)),
  ];
});

/** The four ink cases. */
async function inkFixture() {
  const doc = await PDFDocument.create();
  doc.setTitle('rasterize-pdf ink fixture: text, photo, hairline, blank');
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const text = doc.addPage(BOX);
  for (let line = 0; line < 26; line++) {
    text.drawText(lineText(line), {
      x: 36,
      y: BOX[1] - 54 - line * 20,
      size: 12,
      font,
      color: rgb(0, 0, 0),
    });
  }

  const photo = doc.addPage(BOX);
  const image = await doc.embedPng(photograph);
  photo.drawImage(image, { x: 36, y: 140, width: BOX[0] - 72, height: 380 });
  photo.drawText('photograph page', { x: 36, y: BOX[1] - 60, size: 12, font });

  const stroke = doc.addPage(BOX);
  stroke.drawLine({
    start: { x: 36, y: 300 },
    end: { x: BOX[0] - 36, y: 300 },
    thickness: 0.3,
    color: rgb(0, 0, 0),
  });

  doc.addPage(BOX); // the empty control
  return doc.save({ useObjectStreams: false });
}

/**
 * One sheet carrying `/Rotate 90`: a band along its own left edge, one along its
 * own top edge, and copy running up the sheet. Displayed — turned clockwise —
 * that is a band across the top, one down the right, and text reading normally.
 */
async function rotatedFixture() {
  const doc = await PDFDocument.create();
  doc.setTitle('rasterize-pdf /Rotate 90 fixture');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(BOX);
  page.setRotation(degrees(90));
  page.drawRectangle({ x: 0, y: 0, width: 24, height: BOX[1], color: rgb(0, 0, 0) });
  page.drawRectangle({ x: 0, y: BOX[1] - 24, width: BOX[0], height: 24, color: rgb(0, 0, 0) });
  for (let line = 0; line < 10; line++) {
    page.drawText(lineText(line), {
      x: 60 + line * 22,
      y: 60,
      size: 11,
      font,
      color: rgb(0, 0, 0),
      rotate: degrees(90),
    });
  }
  return doc.save({ useObjectStreams: false });
}

const files = [['ink.pdf', await inkFixture()], ['rot90.pdf', await rotatedFixture()]];
for (const [name, bytes] of files) {
  writeFileSync(`${DIR}/${name}`, bytes);
  console.log(`${DIR}/${name}`, bytes.byteLength, 'bytes');
}
