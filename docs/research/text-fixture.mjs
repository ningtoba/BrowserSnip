// Text-shape fixture for the `text-color` audit — every way a producer paints a run.
//
//   node docs/research/text-fixture.mjs --dir /tmp/text
//
// `rail-measure.py` counts ink and `colour-ink.py` predicts pixels through a filter
// chain; neither can answer the question this card raises, which is whether a given
// SHOW OPERATOR got a colour operator in front of it. So each sheet here carries one
// run shape, written as raw content-stream bytes where pdf-lib would have normalised
// the shape away, and the paired checker (`text-shapes-check.py`) reads the operator
// in force at every `Tj`/`TJ` before and after the run.
//
//  1  three device-RGB runs (black, red, blue) + one that INHERITS its colour after a
//     path paint — the Word/print-driver shape an earlier round fixed
//  2  one `TJ` array with kerning adjustments
//  3  a Type0 / Identity-H CID run (a real embedded TTF, what every CJK export ships)
//  4  two Type3 fonts: a SAME-COLOURED glyph (inherits the page colour, so the recolour
//     must reach it) and a COLOURED glyph (its CharProc paints its own blue, so the
//     recolour cannot reach it and the card must not claim it did)
//  5  faux bold: `Tr 2` with a stroke width, where fill AND stroke are visible
//  6  `Tr 3` — the invisible OCR-layer shape `blanks.pdf` page 4 carries
//  7  a run painted through `/Pattern cs /P1 scn` — the note promises it is recoloured
//     in a device space for that run alone
//  8  a run painted in a non-device `/CalRGB` space, the same wrapper path
//  9  one page whose only text lives inside a Form XObject — the documented limit
// 10  a page with a drawing and no text at all (the count control)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { PDFDocument, PDFName, PDFRawStream, StandardFonts, rgb } = createRequire(
  import.meta.url)('@maxwbh/pdf-lib');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const DIR = arg('dir', '/tmp/text');
const TTF = arg('ttf', '/usr/share/fonts/TTF/DejaVuSans.ttf');

/** Install raw bytes as the page's only content stream, with a given font resource map. */
function raw(doc, page, body, fonts = {}) {
  const ref = doc.context.register(doc.context.stream(
    body.replace(/\n\s+/g, ' ').trim().replace(/\s+/g, ' '),
  ));
  page.node.set(PDFName.of('Contents'), ref);
  const dict = doc.context.obj({});
  for (const [name, value] of Object.entries(fonts)) dict.set(PDFName.of(name), value);
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: dict }));
  return page;
}

const doc = await PDFDocument.create();
const fontkit = createRequire(import.meta.url)('@pdf-lib/fontkit');
doc.registerFontkit(fontkit.default ?? fontkit);
const helv = await doc.embedFont(StandardFonts.Helvetica);
const NAME = helv.name; // the /F<n> the standard font got

// ── 1: device RGB runs + an inherited colour after a path paint ────────────────────
const p1 = doc.addPage([612, 400]);
raw(doc, p1, `
  BT /${NAME} 20 Tf 72 320 Td (plain black Tj) Tj ET
  1 0 0 rg
  BT /${NAME} 20 Tf 72 280 Td (after a red rg) Tj ET
  BT 0 0 1 rg /${NAME} 20 Tf 72 240 Td (blue inside BT) Tj ET
  BT /${NAME} 20 Tf 72 200 Td (inherits the blue: no colour op here) Tj ET
  0 0 0 rg
  72 150 m 300 150 l S
  BT /${NAME} 20 Tf 72 120 Td (inherits black after a path stroke) Tj ET
`, { [NAME]: helv.ref });
// pdf-lib already wrote its own stream for nothing here; `raw` replaced it.
p1.drawText('drawText appended after the raw stream', { x: 72, y: 60, size: 14, font: helv, color: rgb(0, 0.5, 0) });

// ── 2: a TJ array with kerning ────────────────────────────────────────────────────
const p2 = doc.addPage([612, 200]);
raw(doc, p2, `
  BT 0 0 0 rg /${NAME} 22 Tf 60 120 Td [(Kern) -600 (ing) 300 ( TJ) -200 ( array)] TJ ET
`, { [NAME]: helv.ref });

// ── 3: a Type0 / Identity-H CID run (real embedded TTF) ───────────────────────────
const cid = await doc.embedFont(readFileSync(TTF), { subset: true });
const p3 = doc.addPage([612, 200]);
p3.drawText('CID Identity-H body text', { x: 60, y: 120, size: 22, font: cid, color: rgb(0, 0, 0) });

// ── 4: Type3 same-coloured and coloured glyphs ────────────────────────────────────
const charproc = (body) => doc.context.register(doc.context.stream(body, {}));
function type3Font(name, glyphBody) {
  const proc = charproc(glyphBody);
  return doc.context.register(doc.context.obj({
    Type: 'Font',
    Subtype: 'Type3',
    FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
    FontBBox: [0, -200, 700, 800],
    CharProcs: doc.context.obj({ G65: proc }),
    // A simple encoding, no /CodeSpace: with CodeSpace /Unicode a one-byte `<41>` is
    // read as a truncated scalar and MuPDF parses the glyph but paints nothing at all —
    // measured, which is how this line earned its comment.
    Encoding: doc.context.obj({
      Type: 'Encoding',
      Differences: [65, PDFName.of('G65')],
    }),
    Widths: [65, 700],
    FirstChar: 65,
    LastChar: 65,
    FontDescriptor: doc.context.register(doc.context.obj({
      Type: 'FontDescriptor',
      FontName: PDFName.of(name),
      Flags: 4,
      FontBBox: [0, -200, 700, 800],
      ItalicAngle: 0,
      Ascent: 800,
      Descent: -200,
      CapHeight: 700,
      StemV: 90,
      MissingWidth: 500,
    })),
  }));
}
// FontMatrix is 0.001, so the text space size is what makes the 700-unit box ~100 pt.
// A same-coloured Type3 glyph: the CharProc paints a path with NO colour operator, so
// whatever the page had in force shows through.
const t3same = type3Font('T3Same', '100 0 m 600 0 l 600 700 l 100 700 l f');
// A coloured Type3 glyph: the CharProc states its own blue, so a page-level colour
// cannot reach it.
const t3colour = type3Font('T3Colour', '0 0 1 rg 100 0 m 600 0 l 600 700 l 100 700 l f');
const p4 = doc.addPage([612, 260]);
raw(doc, p4, `
  q 1 0 0 1 60 120 cm BT /${'T3A'} 140 Tf <41> Tj ET Q
  q 1 0 0 1 340 120 cm BT /${'T3B'} 140 Tf <41> Tj ET Q
  BT 1 0 0 rg /${NAME} 14 Tf 60 90 Td (left: same-coloured Type3 (red page colour) right: coloured Type3 (its own blue)) Tj ET
`, { T3A: t3same, T3B: t3colour, [NAME]: helv.ref });

// ── 5: faux bold — Tr 2 paints fill AND stroke ───────────────────────────────────
const p5 = doc.addPage([612, 200]);
raw(doc, p5, `
  BT 0 0 0 rg 0 0 0 RG 1.2 w /${NAME} 24 Tf 2 Tr 60 120 Td (faux bold Tr 2) Tj 0 Tr ET
`, { [NAME]: helv.ref });

// ── 6: Tr 3 — invisible text (the OCR-layer shape) ────────────────────────────────
const p6 = doc.addPage([612, 200]);
raw(doc, p6, `
  BT 0 g /${NAME} 11 Tf 3 Tr 0.55 w 1 M [<496e76697369626c65204f43522074657874>] TJ ET
  BT 0 0 0 rg /${NAME} 14 Tf 0 Tr 60 60 Td (the visible caption under the invisible layer) Tj ET
`, { [NAME]: helv.ref });

// ── 7: a Pattern colour space ─────────────────────────────────────────────────────
// A tiling pattern IS a stream object: its dict carries the pattern keys, so it is built
// with `PDFRawStream.of` rather than as a dict holding a `/Content` value (an inline
// stream written inside a dict serialises as `… endstream >> endobj`, which no reader
// parses, and MuPDF paints the run as nothing at all).
const pattern = doc.context.register(PDFRawStream.of(
  doc.context.obj({
    Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 2,
    BBox: [0, 0, 6, 6], XStep: 6, YStep: 6, Matrix: [1, 0, 0, 1, 0, 0], Resources: {},
  }),
  // The tile paints green: the run reads green until it is recoloured. A tiling
  // pattern IS a stream object — an inline `/Content` inside a dict serialises as
  // `… endstream >> endobj`, which no reader parses.
  new TextEncoder().encode('0 1 0 rg 0 0 6 6 re f'),
));
const p7 = doc.addPage([612, 200]);
const p7ref = doc.context.register(doc.context.stream(
  `BT /Pattern cs /P1 scn /${NAME} 26 Tf 60 110 Td (pattern-painted run) Tj ET`,
));
p7.node.set(PDFName.of('Contents'), p7ref);
p7.node.set(PDFName.of('Resources'), doc.context.obj({
  Font: doc.context.obj({ [NAME]: helv.ref }),
  Pattern: doc.context.obj({ P1: pattern }),
}));

// ── 8: a non-device /CalRGB space ─────────────────────────────────────────────────
const calrgb = doc.context.register(doc.context.obj([
  'CalRGB', doc.context.obj({ Gamma: arrayNums([0.6, 0.2, 0.2]), Matrix: arrayNums(
    [0.4124, 0.2126, 0.0193, 0.3576, 0.7152, 0.1192, 0.1805, 0.0722, 0.9505]), WhitePoint: arrayNums([0.9505, 1, 1.089]) }),
]));
function arrayNums(values) { return doc.context.obj(values); }
const p8 = doc.addPage([612, 200]);
raw(doc, p8, `
  BT /CalRGB cs 0.7 0.2 0.2 scn /${NAME} 24 Tf 60 110 Td (CalRGB run) Tj ET
`, { [NAME]: helv.ref });
p8.node.set(PDFName.of('Resources'), doc.context.obj({
  Font: doc.context.obj({ [NAME]: helv.ref }),
  ColorSpace: doc.context.obj({ CalRGB: calrgb }),
}));

// ── 9: text only inside a Form XObject ────────────────────────────────────────────
const inner = await PDFDocument.create();
const innerFont = await inner.embedFont(StandardFonts.Helvetica);
const innerDoc = inner.addPage([612, 200]);
innerDoc.drawText('text inside the XObject', {
  x: 60, y: 120, size: 24, font: innerFont, color: rgb(0, 0, 0),
});
const p9 = doc.addPage([612, 200]);
const [embedded] = await doc.embedPages((await PDFDocument.load(await inner.save())).getPages());
p9.drawPage(embedded, { x: 0, y: 0, width: 612, height: 200 });

// ── 10: a drawing and no text ────────────────────────────────────────────────────
const p10 = doc.addPage([612, 200]);
p10.drawRectangle({ x: 60, y: 60, width: 200, height: 80, color: rgb(0, 0, 0) });

// ── 11: a near-black scan grey, the value "Black only" must not match ─────────────
const p11 = doc.addPage([612, 200]);
raw(doc, p11, `
  BT 0.05 g /${NAME} 22 Tf 60 120 Td (near-black scanner grey, 0.05) Tj ET
  BT 0 0 0 rg /${NAME} 22 Tf 60 80 Td (true black) Tj ET
`, { [NAME]: helv.ref });

const bytes = await doc.save({ useObjectStreams: false });
mkdirSync(DIR, { recursive: true });
writeFileSync(`${DIR}/text.pdf`, bytes);
console.log(`${DIR}/text.pdf`, bytes.byteLength, 'bytes');
