/**
 * Round-trip tests for §2 of docs/PDF-ENGINE-CONTRACT.md: the annotation
 * dictionaries are written by hand, so the only meaningful proof is
 * build → annotate → save → reload → inspect (and decompress) in the saved
 * file. Redaction is tested the same way: the rewritten content stream has to
 * come back out of the file without the redacted glyphs.
 */
import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFBool,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
} from '@maxwbh/pdf-lib';
import {
  ANNOTATION_KINDS,
  LINK_WASH_ALPHA,
  addAnnotation,
  addAnnotations,
  annotationCount,
  hexToRgb01,
  listAnnotations,
  markupRule,
  quadRing,
  removeAnnotations,
  rotatedRectBounds,
  applyRedactions,
  type AnnotationKind,
  type AnnotationSpec,
} from '@/lib/pdf/core/annotations';
import { appearanceInk, measureOps } from './appearance-harness';
import type { PDFPage } from '@maxwbh/pdf-lib';

/* ------------------------------------------------------------------ *
 * Helpers                                                            *
 * ------------------------------------------------------------------ */

async function docWithPages(pages = 1): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([300, 300]);
  return doc;
}

/** save → reload, so every assertion runs against bytes on the wire. */
async function roundTrip(doc: PDFDocument, useObjectStreams = false): Promise<PDFDocument> {
  const bytes = await doc.save({ useObjectStreams });
  return PDFDocument.load(bytes, { ignoreEncryption: true });
}

function annotationDicts(doc: PDFDocument, pageIndex = 0): PDFDict[] {
  const annots = doc.getPage(pageIndex).node.Annots();
  if (!annots) return [];
  const out: PDFDict[] = [];
  for (let i = 0; i < annots.size(); i += 1) {
    const dict = doc.context.lookupMaybe(annots.get(i), PDFDict);
    if (dict) out.push(dict);
  }
  return out;
}

function firstAnnotation(doc: PDFDocument, pageIndex = 0): PDFDict {
  const [dict] = annotationDicts(doc, pageIndex);
  if (!dict) throw new Error(`no annotation on page ${pageIndex}`);
  return dict;
}

function appearanceStream(doc: PDFDocument, dict: PDFDict): PDFRawStream {
  const ap = dict.lookupMaybe(PDFName.of('AP'), PDFDict);
  const normal = ap?.get(PDFName.of('N'));
  const stream = doc.context.lookupMaybe(normal ?? undefined, PDFStream);
  expect(stream, 'annotation has no /AP /N object').toBeTruthy();
  expect(stream, '/AP /N is not a stream').toBeInstanceOf(PDFRawStream);
  return stream as PDFRawStream;
}

/** Decompressed appearance operators — what a viewer actually paints. */
function appearanceOps(doc: PDFDocument, dict: PDFDict): string {
  return decode(doc, appearanceStream(doc, dict));
}

function appearanceResources(doc: PDFDocument, dict: PDFDict): PDFDict {
  const resources = appearanceStream(doc, dict).dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
  expect(resources, 'appearance stream has no /Resources').toBeTruthy();
  return resources as PDFDict;
}

function decode(doc: PDFDocument, stream: PDFRawStream): string {
  void doc;
  return new TextDecoder().decode(decodePDFRawStream(stream).decode());
}

/** The number form the appearance stream writes: three decimals, no `-0`. */
const num = (value: number): string => {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

/**
 * The `PDFRawStream` behind a dictionary/array entry, resolved through the
 * document's context. `lookupMaybe`'s overloads name the `PDFStream` base class
 * only, so the raw-stream check happens on the result, not in the lookup.
 */
function rawStream(doc: PDFDocument, entry: PDFObject | PDFRef | undefined): PDFRawStream | undefined {
  const stream = doc.context.lookupMaybe(entry, PDFStream);
  return stream instanceof PDFRawStream ? stream : undefined;
}

function numbers(value: unknown, doc: PDFDocument): number[] {
  const array = value instanceof PDFRef ? doc.context.lookupMaybe(value, PDFArray) : value;
  expect(array, 'expected an array value').toBeInstanceOf(PDFArray);
  return (array as PDFArray).asArray().map((entry) => {
    const resolved = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
    return (resolved as PDFNumber).asNumber();
  });
}

/** A number that may be stored directly or as an indirect object. */
function numberValue(dict: PDFDict, key: string, doc: PDFDocument): number {
  const raw = dict.get(PDFName.of(key));
  const value = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
  expect(value, `${key} is not a number`).toBeInstanceOf(PDFNumber);
  return (value as PDFNumber).asNumber();
}

function nameValue(dict: PDFDict, key: string, doc: PDFDocument): string {
  const raw = dict.get(PDFName.of(key));
  const value = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
  return value instanceof PDFName ? decodePdfName(value.asString()) : '';
}

/** Undo `#hh` name escaping and the leading slash. */
function decodePdfName(encoded: string): string {
  return encoded
    .replace(/^\//, '')
    .replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function textValue(dict: PDFDict, key: string, doc: PDFDocument): string {
  const raw = dict.get(PDFName.of(key));
  const value = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
  const holder = value as { decodeText?: () => string } | undefined;
  return typeof holder?.decodeText === 'function' ? holder.decodeText() : '';
}

/** Name arrays such as `/LE`, as bare names. */
function namesOf(value: unknown, doc: PDFDocument): string[] {
  const array = value instanceof PDFRef ? doc.context.lookup(value) : value;
  if (!(array instanceof PDFArray)) return [];
  return array.asArray().map((entry) => {
    const resolved = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
    return resolved instanceof PDFName ? decodePdfName(resolved.asString()) : String(resolved);
  });
}

/** Hex operands of a content stream, decoded back to text. */
function hexStrings(content: string): string {
  return [...content.matchAll(/<([0-9a-fA-F]+)>/g)]
    .map((m) => Buffer.from(m[1], 'hex').toString('latin1'))
    .join('|');
}

/**
 * The text a content stream shows, whichever of the three equivalent spellings
 * the producer (or a redaction pass) used: `(literal) Tj`, `<hex> Tj` and
 * `[<hex> …] TJ` — string syntaxes in PDF 32000-1 §7.2.2/§7.3.4.3, the operators
 * in §9.4.3. Assertions about *surviving* text go through this so they do not
 * depend on how the operand was written.
 */
function shownText(content: string): string {
  const parts: string[] = [];
  const pushHex = (hex: string) =>
    parts.push(Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex').toString('latin1'));
  for (const array of content.matchAll(/\[([^\]]*)]\s*TJ/g)) {
    for (const operand of array[1].matchAll(/<([0-9a-fA-F]+)>/g)) pushHex(operand[1]);
  }
  for (const standalone of content.matchAll(/<([0-9a-fA-F]+)>\s*Tj/g)) pushHex(standalone[1]);
  for (const literal of content.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) {
    parts.push(literal[1].replace(/\\([()\\])/g, '$1'));
  }
  return parts.join('');
}

/** The Form XObject a page draws under `key`, as decoded operators. */
function formOps(doc: PDFDocument, pageIndex: number, key: string): string {
  const xobjects = doc.getPage(pageIndex).node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  const stream = rawStream(doc, xobjects?.get(PDFName.of(key)));
  expect(stream, `page ${pageIndex} has no form /${key}`).toBeInstanceOf(PDFRawStream);
  return decode(doc, stream as PDFRawStream);
}

/** A plain fixed-width font dictionary, as any producer would write it. */
function registerFixedFont(doc: PDFDocument, width = 600): PDFRef {
  return doc.context.register(
    doc.context.obj({
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: 'TestSans',
      FirstChar: 32,
      LastChar: 126,
      Widths: Array.from({ length: 95 }, () => width),
      Encoding: 'WinAnsiEncoding',
      FontDescriptor: {
        Type: 'FontDescriptor',
        FontName: 'TestSans',
        Flags: 32,
        FontBBox: [0, -200, 1000, 800],
        ItalicAngle: 0,
        Ascent: 800,
        Descent: -200,
        CapHeight: 700,
        StemV: 90,
        MissingWidth: 500,
      },
    }),
  );
}

function setPageFont(doc: PDFDocument, page: PDFPage, key: string, ref: PDFRef): void {
  void doc;
  const { Font } = page.node.normalizedEntries();
  Font.set(PDFName.of(key), ref);
}

function setContent(doc: PDFDocument, page: PDFPage, ops: string): void {
  const stream = doc.context.flateStream(`${ops}\n`, {});
  stream.dict.set(PDFName.of('Length'), PDFNumber.of(stream.contents.length));
  page.node.set(PDFName.of('Contents'), doc.context.register(stream));
}

function pageContent(doc: PDFDocument, pageIndex = 0): string {
  const contents = doc.getPage(pageIndex).node.Contents();
  const entries = contents instanceof PDFArray ? contents.asArray() : [contents];
  return entries
    .map((entry) => {
      // A content entry may be the stream itself or a reference to one; either
      // way the context resolves it, and a non-raw stream decodes to nothing.
      const resolved = rawStream(doc, entry);
      return resolved ? decode(doc, resolved) : '';
    })
    .join('\n');
}

function setPageXObject(doc: PDFDocument, page: PDFPage, key: string, ref: PDFRef): void {
  void doc;
  const { XObject } = page.node.normalizedEntries();
  XObject.set(PDFName.of(key), ref);
}

/** Smallest believable JPEG: SOI, an SOF0 header, EOI. */
function fakeJpeg(width = 40, height = 20): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xc0, 0x00, 0x11, // SOF0, length 17
    0x08, // 8 bits/sample
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9, // EOI
  ]);
}

function baseSpec(kind: AnnotationKind, over: Partial<AnnotationSpec> = {}): AnnotationSpec {
  return {
    kind,
    page: 0,
    rect: { x: 40, y: 200, width: 120, height: 24 },
    author: 'Zoë ✓',
    contents: 'a note',
    createdAt: new Date(Date.UTC(2024, 0, 2, 3, 4, 5)),
    ...over,
  };
}

/* ------------------------------------------------------------------ *
 * Dictionaries                                                        *
 * ------------------------------------------------------------------ */

describe('addAnnotation — dictionary keys', () => {
  it('writes the shared annotation keys for every kind, in a saved file', async () => {
    for (const kind of ANNOTATION_KINDS) {
      const doc = await docWithPages();
      addAnnotation(doc, baseSpec(kind));
      const reloaded = await roundTrip(doc);
      const dict = firstAnnotation(reloaded);

      expect(nameValue(dict, 'Type', reloaded), kind).toBe('Annot');
      expect(['Line', kind]).toContain(nameValue(dict, 'Subtype', reloaded));
      expect(numbers(dict.get(PDFName.of('Rect')), reloaded)).toEqual([40, 200, 160, 224]);
      // /P points at the page object the annotation lives on.
      expect(reloaded.context.lookup(dict.get(PDFName.of('P')) as PDFRef)).toBe(reloaded.getPage(0).node);
      expect(numbers(dict.get(PDFName.of('C')), reloaded)).toHaveLength(3);
      expect(numberValue(dict, 'CA', reloaded)).toBe(1);
      expect(nameValue(dict, 'BM', reloaded)).toBe('Normal');
      expect(textValue(dict, 'T', reloaded)).toBe('Zoë ✓');
      expect(textValue(dict, 'Contents', reloaded)).toBe('a note');
      expect(textValue(dict, 'M', reloaded)).toMatch(/^D:20240102030405Z$/);
      expect(textValue(dict, 'CreationDate', reloaded)).toMatch(/^D:20240102030405Z$/);
      expect(dict.get(PDFName.of('NM'))).toBeTruthy();
      expect(numberValue(dict, 'F', reloaded)).toBe(4); // Print
      expect(dict.get(PDFName.of('BS'))).toBeInstanceOf(PDFDict);
      expect(appearanceStream(reloaded, dict).dict.get(PDFName.of('BBox'))).toBeInstanceOf(PDFArray);
    }
  });

  it('normalises the rect and documents the lower-left origin', async () => {
    const doc = await docWithPages();
    addAnnotation(doc, baseSpec('Square', { rect: { x: 100, y: 100, width: -40, height: -20 } }));
    const reloaded = await roundTrip(doc);
    // Negative extents flip the origin so /Rect stays [llx lly urx ury].
    expect(numbers(firstAnnotation(reloaded).get(PDFName.of('Rect')), reloaded)).toEqual([60, 80, 100, 100]);
  });

  it('maps opacity, custom flags and colours onto /CA, /F, /C, /IC', async () => {
    const doc = await docWithPages();
    addAnnotation(doc, baseSpec('Square', {
      color: '#ff0000',
      fillColor: '#00ff00',
      borderColor: '#0000ff',
      opacity: 0.25,
      flags: ['Print', 'ReadOnly', 'Locked'],
      borderWidth: 3,
    }));
    const reloaded = await roundTrip(doc);
    const dict = firstAnnotation(reloaded);
    expect(numbers(dict.get(PDFName.of('C')), reloaded)).toEqual(hexToRgb01('#0000ff'));
    expect(numbers(dict.get(PDFName.of('IC')), reloaded)).toEqual(hexToRgb01('#00ff00'));
    expect(numberValue(dict, 'CA', reloaded)).toBe(0.25);
    expect(numberValue(dict, 'F', reloaded)).toBe(4 | 64 | 128);
    const bs = dict.lookupMaybe(PDFName.of('BS'), PDFDict);
    expect((bs?.get(PDFName.of('W')) as PDFNumber).asNumber()).toBe(3);
  });

  it('returns the index inside the page /Annots array', async () => {
    const doc = await docWithPages(2);
    expect(addAnnotation(doc, baseSpec('Highlight'))).toBe(0);
    expect(addAnnotation(doc, baseSpec('Text', { page: 1 }))).toBe(0);
    expect(addAnnotation(doc, baseSpec('Ink', { page: 1 }))).toBe(1);
    const reloaded = await roundTrip(doc);
    expect(annotationDicts(reloaded, 0)).toHaveLength(1);
    expect(annotationDicts(reloaded, 1)).toHaveLength(2);
  });

  it('writes /QuadPoints for text markup and derives one from the rect', async () => {
    const doc = await docWithPages();
    addAnnotation(doc, baseSpec('Highlight', { quadPoints: [40, 224, 160, 224, 40, 200, 160, 200, 40, 180, 160, 180, 40, 156, 160, 156] }));
    addAnnotation(doc, baseSpec('Underline'));
    const reloaded = await roundTrip(doc);
    const [highlight, underline] = annotationDicts(reloaded);
    expect(numbers(highlight.get(PDFName.of('QuadPoints')), reloaded)).toHaveLength(16);
    // The fallback quad is the rect itself: upper-left, upper-right, lower-left, lower-right.
    expect(numbers(underline.get(PDFName.of('QuadPoints')), reloaded)).toEqual([40, 224, 160, 224, 40, 200, 160, 200]);
  });

  it('paints the markup from the same geometry it stores', async () => {
    const doc = await docWithPages();
    const quad = [40, 224, 160, 224, 40, 200, 160, 200];
    addAnnotation(doc, baseSpec('Underline', { quadPoints: quad, borderWidth: 1 }));
    addAnnotation(doc, baseSpec('StrikeOut', { quadPoints: quad, borderWidth: 1 }));
    addAnnotation(doc, baseSpec('Highlight', { quadPoints: quad }));
    const reloaded = await roundTrip(doc);
    const [under, strike, highlight] = annotationDicts(reloaded);

    // The dictionary keeps the stored order whatever the stream is drawn with.
    expect(numbers(under.get(PDFName.of('QuadPoints')), reloaded)).toEqual(quad);

    // An appearance stream lives in its own space, the rect's origin subtracted,
    // so the expected corners are built the same way the writer builds them.
    const rect = { x: 40, y: 200, width: 120, height: 24 };
    const corners = [
      { x: quad[0] - rect.x, y: quad[1] - rect.y },
      { x: quad[2] - rect.x, y: quad[3] - rect.y },
      { x: quad[4] - rect.x, y: quad[5] - rect.y },
      { x: quad[6] - rect.x, y: quad[7] - rect.y },
    ];
    const stroked = (kind: 'Underline' | 'StrikeOut'): string => {
      const rule = markupRule(corners, kind, 1);
      // The writer emits one operator per line.
      return `${num(rule.x1)} ${num(rule.y1)} m\n${num(rule.x2)} ${num(rule.y2)} l`;
    };
    const underOps = stroked('Underline');
    const strikeOps = stroked('StrikeOut');
    // The bytes match the shared rule, so the file paints what the overlay drew.
    expect(appearanceOps(reloaded, under)).toContain(underOps);
    expect(appearanceOps(reloaded, strike)).toContain(strikeOps);
    // And the two are different lines: the underline below the baseline of a box
    // re-anchored on the ink, the strike above it. Both inside the /Rect, where a
    // viewer cannot clip them at the edge of the mark's own box.
    const yOf = (ops: string): number => Number(ops.match(/([-\d.]+) m/)?.[1]);
    expect(yOf(strikeOps)).toBeGreaterThan(yOf(underOps));
    expect(yOf(underOps)).toBeGreaterThan(0);
    expect(yOf(strikeOps)).toBeLessThan(rect.height);

    // A highlight fills the ring, never the stored order: a path that crosses
    // itself paints two triangles meeting in the middle of the line.
    const ring = quadRing(corners)
      .map((p, i) => `${num(p.x)} ${num(p.y)} ${i === 0 ? 'm' : 'l'}`)
      .join(' ');
    expect(appearanceOps(reloaded, highlight)).toContain(ring);
  });

  it('writes /DA and /DR for FreeText so the dictionary and appearance agree', async () => {
    const doc = await docWithPages();
    addAnnotation(doc, baseSpec('FreeText', {
      rect: { x: 40, y: 180, width: 180, height: 60 },
      color: '#000000',
      fillColor: '#ffffff',
      freeText: { text: 'Type here', fontSize: 14, fontFamily: 'times', bold: true },
    }));
    const reloaded = await roundTrip(doc);
    const dict = firstAnnotation(reloaded);
    const da = textValue(dict, 'DA', reloaded);
    expect(da).toMatch(/^\/F1 14 Tf 0 0 0 rg$/);
    const dr = dict.lookupMaybe(PDFName.of('DR'), PDFDict);
    const fontRef = dr?.lookupMaybe(PDFName.of('Font'), PDFDict)?.get(PDFName.of('F1'));
    const font = reloaded.context.lookupMaybe(fontRef ?? undefined, PDFDict);
    expect(font).toBeInstanceOf(PDFDict);
    expect(nameValue(font as PDFDict, 'Subtype', reloaded)).toBe('Type1');
    expect(textValue(font as PDFDict, 'BaseFont', reloaded)).toBe('Times-Bold');
  });

  it('uses /Line plus /LE for arrows and keeps a plain line headless', async () => {
    const doc = await docWithPages();
    addAnnotation(doc, baseSpec('Arrow', { lineEnds: [40, 200, 160, 224] }));
    addAnnotation(doc, baseSpec('Line', { lineEnds: [40, 200, 160, 224] }));
    addAnnotation(doc, baseSpec('Line', { lineEnds: [40, 200, 160, 224], lineArrow: 'both' }));
    const reloaded = await roundTrip(doc);
    const [arrow, line, doubleLine] = annotationDicts(reloaded);
    expect(nameValue(arrow, 'Subtype', reloaded)).toBe('Line');
    expect(namesOf(arrow.get(PDFName.of('LE')), reloaded)).toEqual(['None', 'ClosedArrow']);
    expect(namesOf(line.get(PDFName.of('LE')), reloaded)).toEqual(['None', 'None']);
    expect(namesOf(doubleLine.get(PDFName.of('LE')), reloaded)).toEqual(['OpenArrow', 'OpenArrow']);
    expect(listAnnotations(reloaded).map((a) => a.kind)).toEqual(['Arrow', 'Line', 'Arrow']);
  });

  it('writes /IC for ink and keeps the stroke geometry', async () => {
    const doc = await docWithPages();
    addAnnotation(doc, baseSpec('Ink', {
      color: '#ff0000',
      inkPath: [[[40, 200], [80, 220], [120, 200]], [[40, 210], [120, 210]]],
      borderWidth: 2,
    }));
    const reloaded = await roundTrip(doc);
    const dict = firstAnnotation(reloaded);
    expect(numbers(dict.get(PDFName.of('IC')), reloaded)).toEqual(hexToRgb01('#ff0000'));
    const ops = appearanceOps(reloaded, dict);
    expect(ops.match(/\bm\b/g)).toHaveLength(2);
    expect(ops).toContain('2 w');
    expect(ops).toContain('S');
  });

  it('marks an annotation for redaction with /Redact and paints a Redact box', async () => {
    const doc = await docWithPages();
    addAnnotation(doc, baseSpec('Highlight', { redact: true }));
    addAnnotation(doc, baseSpec('Redact', { fillColor: '#123456' }));
    const reloaded = await roundTrip(doc);
    const [markup, redact] = annotationDicts(reloaded);
    expect((markup.get(PDFName.of('Redact')) as PDFBool).asBoolean()).toBe(true);
    expect(nameValue(redact, 'Subtype', reloaded)).toBe('Redact');
    expect(numbers(redact.get(PDFName.of('IC')), reloaded)).toEqual(hexToRgb01('#123456'));
    expect(appearanceOps(reloaded, redact)).toMatch(/0\.071 0\.204 0\.337 rg/);
  });

  it('records the stamp name in /S and rejects a bad colour or flag', async () => {
    const doc = await docWithPages();
    addAnnotation(doc, baseSpec('Stamp', { stampName: 'Draft', rect: { x: 20, y: 20, width: 120, height: 40 } }));
    const reloaded = await roundTrip(doc);
    expect(nameValue(firstAnnotation(reloaded), 'S', reloaded)).toBe('Draft');
    expect(() => addAnnotation(doc, baseSpec('Text', { color: 'nope' }))).toThrow(/hex value/);
    expect(() => addAnnotation(doc, baseSpec('Text', { flags: ['Spicy'] }))).toThrow(/annotation flag/);
    expect(() => addAnnotation(doc, { ...baseSpec('Text'), kind: 'Nope' as AnnotationKind })).toThrow(/annotation type/);
    await expect(roundTrip(doc)).resolves.toBeInstanceOf(PDFDocument);
  });

  it('links to a page with /A and /Dest, and to a URI with /A', async () => {
    const doc = await docWithPages(3);
    addAnnotation(doc, baseSpec('Link', { rect: { x: 10, y: 10, width: 40, height: 12 }, link: { type: 'goTo', page: 2 } }));
    addAnnotation(doc, baseSpec('Link', { rect: { x: 10, y: 30, width: 40, height: 12 }, link: { type: 'uri', uri: 'https://example.com/x' } }));
    const reloaded = await roundTrip(doc);
    const [goTo, uri] = annotationDicts(reloaded);
    const goAction = goTo.lookupMaybe(PDFName.of('A'), PDFDict);
    expect(nameValue(goAction as PDFDict, 'S', reloaded)).toBe('GoTo');
    const dest = (goAction as PDFDict).get(PDFName.of('D'));
    expect(namesOf(dest, reloaded)[1]).toBe('Fit');
    expect(goTo.get(PDFName.of('Dest'))).toBeInstanceOf(PDFArray);
    const uriAction = uri.lookupMaybe(PDFName.of('A'), PDFDict);
    expect(nameValue(uriAction as PDFDict, 'S', reloaded)).toBe('URI');
    expect(textValue(uriAction as PDFDict, 'URI', reloaded)).toBe('https://example.com/x');
  });

  it('rejects a page index outside the document', async () => {
    const doc = await docWithPages(1);
    expect(() => addAnnotation(doc, baseSpec('Text', { page: 4 }))).toThrow(/has 1 page/);
  });
});

/* ------------------------------------------------------------------ *
 * Appearance streams                                                  *
 * ------------------------------------------------------------------ */

describe('appearance streams', () => {
  it('registers self-contained Form XObjects with a correct /Length', async () => {
    const doc = await docWithPages();
    addAnnotations(doc, ANNOTATION_KINDS.map((kind) => baseSpec(kind, {
      freeText: kind === 'FreeText' ? { text: 'hello', fontSize: 12 } : undefined,
    })));
    const reloaded = await roundTrip(doc, true);
    for (const dict of annotationDicts(reloaded)) {
      const stream = appearanceStream(reloaded, dict);
      expect(nameValue(stream.dict, 'Type', reloaded)).toBe('XObject');
      expect(nameValue(stream.dict, 'Subtype', reloaded)).toBe('Form');
      const bbox = numbers(stream.dict.get(PDFName.of('BBox')), reloaded);
      expect(bbox[0]).toBe(0);
      expect(bbox[1]).toBe(0);
      const rect = numbers(dict.get(PDFName.of('Rect')), reloaded);
      expect(bbox[2]).toBeCloseTo(rect[2] - rect[0], 3);
      expect(bbox[3]).toBeCloseTo(rect[3] - rect[1], 3);
      // /Length must be the encoded length or every viewer truncates the stream.
      const declared = (stream.dict.get(PDFName.of('Length')) as PDFNumber).asNumber();
      expect(declared).toBe(stream.contents.length);
      expect(decode(reloaded, stream).trim().length).toBeGreaterThan(0);
    }
  });

  it('declares /Font and /XObject in /Resources only when referenced', async () => {
    const doc = await docWithPages();
    addAnnotation(doc, baseSpec('Square'));
    addAnnotation(doc, baseSpec('FreeText', { freeText: { text: 'text', fontSize: 12 } }));
    addAnnotation(doc, baseSpec('Stamp', { stampImage: fakeJpeg(), rect: { x: 10, y: 10, width: 80, height: 40 } }));
    const reloaded = await roundTrip(doc);
    const [square, freeText, stamp] = annotationDicts(reloaded);

    const squareResources = appearanceResources(reloaded, square);
    expect(squareResources.get(PDFName.of('Font'))).toBeUndefined();
    expect(squareResources.get(PDFName.of('XObject'))).toBeUndefined();
    expect(appearanceOps(reloaded, square)).toContain('re');

    const fontResources = appearanceResources(reloaded, freeText);
    expect(fontResources.lookupMaybe(PDFName.of('Font'), PDFDict)?.get(PDFName.of('F1'))).toBeInstanceOf(PDFRef);
    expect(fontResources.get(PDFName.of('XObject'))).toBeUndefined();

    const stampResources = appearanceResources(reloaded, stamp);
    expect(stampResources.get(PDFName.of('Font'))).toBeUndefined();
    expect(stampResources.lookupMaybe(PDFName.of('XObject'), PDFDict)?.get(PDFName.of('Im0'))).toBeInstanceOf(PDFRef);
    expect(appearanceOps(reloaded, stamp)).toContain('/Im0 Do');

    const image = rawStream(
      reloaded,
      stampResources.lookupMaybe(PDFName.of('XObject'), PDFDict)?.get(PDFName.of('Im0')),
    );
    expect(image, 'the stamp appearance embeds no image stream').toBeInstanceOf(PDFRawStream);
    const imageStream = image as PDFRawStream;
    expect((imageStream.dict.get(PDFName.of('Width')) as PDFNumber).asNumber()).toBe(40);
    expect((imageStream.dict.get(PDFName.of('Height')) as PDFNumber).asNumber()).toBe(20);
    expect(nameValue(imageStream.dict, 'Filter', reloaded)).toBe('DCTDecode');
    expect(imageStream.contents.length).toBe(fakeJpeg().length);
  });

  it('decompresses to the operators each kind needs', async () => {
    const doc = await docWithPages();
    addAnnotation(doc, baseSpec('Highlight', { color: '#ffff00' }));
    addAnnotation(doc, baseSpec('Underline'));
    addAnnotation(doc, baseSpec('StrikeOut'));
    addAnnotation(doc, baseSpec('Squiggly'));
    addAnnotation(doc, baseSpec('Caret'));
    addAnnotation(doc, baseSpec('Circle', { rect: { x: 10, y: 10, width: 60, height: 40 } }));
    addAnnotation(doc, baseSpec('PolyLine', { inkPath: [[[0, 0], [10, 5], [20, 0]]] }));
    addAnnotation(doc, baseSpec('Polygon', { inkPath: [[[0, 0], [10, 5], [20, 0]]], fillColor: '#ff0000' }));
    addAnnotation(doc, baseSpec('Arrow', { lineEnds: [40, 200, 160, 224] }));
    addAnnotation(doc, baseSpec('Text'));
    const reloaded = await roundTrip(doc);
    const [highlight, underline, strike, squiggly, caret, circle, polyline, polygon, arrow, note] =
      annotationDicts(reloaded).map((dict) => appearanceOps(reloaded, dict));

    expect(highlight).toMatch(/\/GS1 gs/);
    expect(highlight).toMatch(/1 1 0 rg/);
    expect(highlight).toMatch(/m[\s\S]*l[\s\S]*l[\s\S]*l[\s\S]*h\s+f/);
    expect(underline).toMatch(/m\s*.+\sl\s+S/);
    expect(strike).toMatch(/m\s*.+\sl\s+S/);
    expect(squiggly).toMatch(/c\s+S/);
    expect(caret.match(/re/g)?.length).toBeGreaterThanOrEqual(3);
    expect(circle.match(/c/g)?.length).toBeGreaterThanOrEqual(4);
    expect(polyline).not.toContain(' h');
    expect(polygon).toContain(' h');
    expect(polygon).toMatch(/1 0 0 rg/);
    expect(arrow).toMatch(/h f/); // filled arrow head
    expect(note).toMatch(/f[\s\S]*S/); // filled icon, stroked outline
  });

  it('draws FreeText as real selectable text, wrapped to the box', async () => {
    const doc = await docWithPages();
    addAnnotation(doc, baseSpec('FreeText', {
      rect: { x: 20, y: 200, width: 120, height: 60 },
      fillColor: '#ffffff',
      freeText: { text: 'alpha beta gamma delta epsilon', fontSize: 10, align: 'center' },
    }));
    const reloaded = await roundTrip(doc);
    const ops = appearanceOps(reloaded, firstAnnotation(reloaded));
    expect(ops).toMatch(/BT[\s\S]*\/F1 10 Tf[\s\S]*ET/);
    expect(ops.match(/Tj/g)?.length).toBeGreaterThanOrEqual(2);
    expect(ops).toMatch(/^\d+(\.\d+)? \d+(\.\d+)? Td$/m);
    // The hex operand decodes back to the wrapped words.
    expect(hexStrings(ops)).toContain('alpha');
    expect(hexStrings(ops)).toContain('epsilon');
  });

  it('substitutes characters Helvetica cannot encode instead of throwing', async () => {
    const doc = await docWithPages();
    expect(() =>
      addAnnotation(doc, baseSpec('FreeText', { freeText: { text: '你好 ✓ ok', fontSize: 12 } })),
    ).not.toThrow();
    const reloaded = await roundTrip(doc);
    const ops = appearanceOps(reloaded, firstAnnotation(reloaded));
    // '你好 ✓' becomes '?' per character instead of throwing in the encoder.
    expect(hexStrings(ops)).toContain('ok');
    expect(ops).toMatch(/<3f3f203f206f6b>/);
  });
});

/* ------------------------------------------------------------------ *
 * A link's appearance: the box the user dragged, in the bytes         *
 * ------------------------------------------------------------------ *
 *
 * `docs/research/edit-pdf-audit.md` §3.2 recorded an exported `/Link` whose
 * `/AP /N` was four bytes — `q Q` — against 3 726 px² of painted canvas. A link
 * with no appearance is invisible to any viewer that renders `/AP`, so the file
 * disagreed with the page that was marked. These are the bytes that answer it.
 */

const LINK_BOX = { x: 40, y: 200, width: 148, height: 12 };

function linkSpec(over: Partial<AnnotationSpec> = {}): AnnotationSpec {
  return baseSpec('Link', {
    rect: LINK_BOX,
    color: '#2563eb',
    link: { type: 'uri', uri: 'https://example.com/audit' },
    ...over,
  });
}

describe('a link paints the box it was dragged over', () => {
  it('writes real ink and keeps the action that makes it a link', async () => {
    const doc = await docWithPages();
    addAnnotation(doc, linkSpec());
    const reloaded = await roundTrip(doc);
    const dict = firstAnnotation(reloaded);
    expect(nameValue(dict, 'Subtype', reloaded)).toBe('Link');
    const action = dict.lookupMaybe(PDFName.of('A'), PDFDict);
    expect(nameValue(action as PDFDict, 'S', reloaded)).toBe('URI');
    expect(textValue(action as PDFDict, 'URI', reloaded)).toBe('https://example.com/audit');

    const ops = appearanceOps(reloaded, dict);
    expect(ops.trim()).not.toBe('q Q');
    // The wash, in the mark's own colour at its own alpha, then the same colour
    // as a dashed rule: what the overlay draws, in points.
    expect(ops).toMatch(/\/GS1 gs/);
    expect(ops).toMatch(/0\.145 0\.388 0\.922 rg/);
    expect(ops).toMatch(/0\.145 0\.388 0\.922 RG/);
    expect(ops).toMatch(/\[5 3\] 0 d/);
    expect(ops).toMatch(/1 w/);
    expect(ops.match(/re/g)).toHaveLength(2);
    expect(ops).toMatch(/f[\s\S]*S/);
    expect(appearanceInk(reloaded, dict).inkPt2).toBeGreaterThan(0);
  });

  it('keeps the dragged rect as the click target and strokes the rule inside it', async () => {
    const doc = await docWithPages();
    addAnnotation(doc, linkSpec());
    addAnnotation(doc, linkSpec({ rect: { x: 40, y: 100, width: 148, height: 0.6 } }));
    const reloaded = await roundTrip(doc);
    const [normal, thin] = annotationDicts(reloaded);
    // An appearance is clipped to its /BBox, so the rule is inset by half its
    // width instead of the rect being grown to fit the ink.
    expect(numbers(normal.get(PDFName.of('Rect')), reloaded)).toEqual([40, 200, 188, 212]);
    expect(rectangles(appearanceOps(reloaded, normal))).toEqual([
      [0, 0, 148, 12],
      [0.5, 0.5, 147, 11],
    ]);
    expect(numbers(thin.get(PDFName.of('Rect')), reloaded)).toEqual([40, 100, 188, 100.6]);
    const [wash, border] = rectangles(appearanceOps(reloaded, thin));
    expect(wash).toEqual([0, 0, 148, 0.6]);
    // Half of a 1 pt rule would fall outside a 0.6 pt box and be cut, so the inset
    // gives up to the box's own shorter side; `rectPath` keeps a flat rect drawn.
    expect(border[0]).toBeCloseTo(0.3, 6);
    expect(border[2]).toBeCloseTo(148 - 0.6, 6);
    expect(border[3]).toBeCloseTo(0.01, 6);
    expect(appearanceInk(reloaded, thin).inkPt2).toBeGreaterThan(0);
  });

  it('describes the border in /BS the way the stream strokes it', async () => {
    const doc = await docWithPages();
    // No `borderWidth`: the writer's own default has to agree with the rule it paints.
    addAnnotation(doc, linkSpec({ borderWidth: undefined }));
    const reloaded = await roundTrip(doc);
    const dict = firstAnnotation(reloaded);
    const border = dict.lookupMaybe(PDFName.of('BS'), PDFDict) as PDFDict;
    expect((border.get(PDFName.of('W')) as PDFNumber).asNumber()).toBe(1);
    expect(numbers(border.get(PDFName.of('D')), reloaded)).toEqual([5, 3]);
    expect(appearanceOps(reloaded, dict)).toMatch(/1 w/);
    expect(appearanceOps(reloaded, dict)).toMatch(/\[5 3\] 0 d/);
  });

  it('publishes the wash alpha as an /ExtGState the stream names', async () => {
    const doc = await docWithPages();
    addAnnotation(doc, linkSpec());
    const reloaded = await roundTrip(doc);
    const dict = firstAnnotation(reloaded);
    const states = appearanceResources(reloaded, dict).lookupMaybe(PDFName.of('ExtGState'), PDFDict);
    expect(states, 'the link appearance declares no /ExtGState').toBeTruthy();
    const wash = reloaded.context.lookup(states!.get(PDFName.of('GS1'))) as PDFDict;
    expect((wash.get(PDFName.of('ca')) as PDFNumber).asNumber()).toBe(LINK_WASH_ALPHA);
    // Only the fill is translucent: a rule faded to 8 % is not the box the user drew.
    expect(wash.get(PDFName.of('CA'))).toBeUndefined();
  });

  it('measures the link box at its alpha, not at the size of its rect', async () => {
    const doc = await docWithPages();
    addAnnotation(doc, linkSpec());
    const reloaded = await roundTrip(doc);
    const dict = firstAnnotation(reloaded);
    const boxArea = LINK_BOX.width * LINK_BOX.height;
    const frame = 2 * (LINK_BOX.width - 1 + LINK_BOX.height - 1);
    // Wash + dashed rule, worked out by hand from the operators the test above
    // named. An estimate that matched the box exactly would not be measuring ink.
    expect(appearanceInk(reloaded, dict).inkPt2).toBeCloseTo(
      boxArea * LINK_WASH_ALPHA + frame * 1 * (5 / 8),
      2,
    );
  });

  it('reports no ink for a link the file hides with /CA 0', async () => {
    // The measure has to be able to say "nothing visible", or every row of the
    // per-subtype table is a tautology: `q Q` and a hidden box both paint paper.
    const doc = await docWithPages();
    addAnnotation(doc, linkSpec({ opacity: 0 }));
    const reloaded = await roundTrip(doc);
    const dict = firstAnnotation(reloaded);
    expect(appearanceOps(reloaded, dict)).toMatch(/re/);
    expect(appearanceInk(reloaded, dict).inkPt2).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Reading ink out of an appearance stream                             *
 * ------------------------------------------------------------------ */

describe('measuring what an appearance stream lays down', () => {
  it('reads an empty stream as no ink', () => {
    const empty = measureOps('q Q\n');
    expect(empty.inkPt2).toBe(0);
    expect(empty.paintOps).toEqual([]);
    expect(measureOps('q\n0 0 148 12 re\nn\nQ').inkPt2).toBe(0);
  });

  it('measures a flat rule by its stroke, not by a bounding box', () => {
    // The trap that reported underline and strike-out as invisible: a horizontal
    // rule encloses no area, and every one of these marks is nothing but a stroke.
    const rule = measureOps('q\n0 0 0 RG\n1 w\n0 5 m\n100 5 l\nS\nQ');
    expect(rule.inkPt2).toBeCloseTo(100, 6);
    expect(measureOps('0 0 0 RG 0.8 w 0 0 m 60 0 l 60 40 l S').inkPt2).toBeCloseTo(80, 6);
  });

  it('subtracts the gaps a dash leaves open', () => {
    const solid = measureOps('0 0 0 RG 1 w 0 5 m 100 5 l S');
    const dashed = measureOps('0 0 0 RG 1 w [5 3] 0 d 0 5 m 100 5 l S');
    expect(dashed.inkPt2).toBeCloseTo(solid.inkPt2 * (5 / 8), 6);
  });

  it('counts a placed image at the size the transform gives it', () => {
    // A raster stamp writes `w 0 0 h 0 0 cm /Im0 Do` and an `/Image` carries no
    // `/BBox`: the unit square is its space. Pricing it at nothing would call a
    // signature invisible in a file that plainly holds the pixels.
    const placed = measureOps('q\n120 0 0 40 10 10 cm\n/Im0 Do\nQ', imageResources());
    expect(placed.inkPt2).toBeCloseTo(120 * 40, 6);
    expect(measureOps('q\n120 0 0 40 10 10 cm\n/Nope Do\nQ', imageResources()).inkPt2).toBe(0);
  });

  it('counts a nested form by its own /BBox', () => {
    const placed = measureOps('q\n2 0 0 2 0 0 cm\n/Fm0 Do\nQ', formResources([0, 0, 30, 10]));
    expect(placed.inkPt2).toBeCloseTo(30 * 10 * 4, 6);
  });

  it('counts a shown text run, and refuses an invisible render mode', () => {
    const shown = measureOps('/F1 12 Tf 4 20 Td <61626364> Tj');
    expect(shown.inkPt2).toBeGreaterThan(0);
    expect(measureOps('/F1 12 Tf 3 Tr <61626364> Tj').inkPt2).toBe(0);
    expect(measureOps('/F1 12 Tf 0 Tr <> Tj').inkPt2).toBe(0);
  });

  it('applies an /ExtGState alpha the stream asks for', () => {
    const half = measureOps('/GS1 gs 1 0 0 rg 0 0 10 10 re f', stateResources(0.5));
    expect(half.inkPt2).toBeCloseTo(50, 6);
    const hidden = measureOps('/GS1 gs 1 0 0 rg 0 0 10 10 re f', stateResources(0));
    expect(hidden.inkPt2).toBe(0);
  });
});

/** A one-pixel `/Im0` image, as `embedRasterImage` registers it: no `/BBox`. */
function imageResources(): PDFDict {
  const context = PDFContext.create();
  const image = context.register(
    context.flateStream('x', { Type: 'XObject', Subtype: 'Image', Width: 1, Height: 1, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 }),
  );
  return context.obj({ XObject: { Im0: image } }) as PDFDict;
}

/** A nested form XObject, which is priced by the `/BBox` it declares. */
function formResources(bbox: number[]): PDFDict {
  const context = PDFContext.create();
  const form = context.register(
    context.flateStream('q Q', { Type: 'XObject', Subtype: 'Form', BBox: bbox }),
  );
  return context.obj({ XObject: { Fm0: form } }) as PDFDict;
}

/** A `/GS1` state carrying one fill alpha, as an appearance declares it. */
function stateResources(ca: number): PDFDict {
  const context = PDFContext.create();
  const state = context.register(context.obj({ Type: 'ExtGState', ca }));
  return context.obj({ ExtGState: { GS1: state } }) as PDFDict;
}

/** Every `x y w h re` in an appearance stream, in the order they are built. */
function rectangles(ops: string): number[][] {
  const out: number[][] = [];
  const found = ops.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re/g);
  for (const match of found) out.push(match.slice(1, 5).map(Number));
  return out;
}

/* ------------------------------------------------------------------ *
 * listAnnotations / removeAnnotations on foreign documents            *
 * ------------------------------------------------------------------ */

describe('reading and removing annotations', () => {
  it('lists what was written, after a save/load round trip', async () => {
    const doc = await docWithPages(2);
    addAnnotations(doc, [
      baseSpec('Highlight', { contents: 'first', color: '#ff0000' }),
      baseSpec('Text', { page: 1, contents: 'sticky' }),
      baseSpec('Redact', { page: 1 }),
    ]);
    const reloaded = await roundTrip(doc);
    const listed = listAnnotations(reloaded);
    expect(listed.map((a) => a.kind)).toEqual(['Highlight', 'Text', 'Redact']);
    expect(listed.map((a) => a.page)).toEqual([0, 1, 1]);
    expect(listed[0].contents).toBe('first');
    expect(listed[0].color).toBe('#ff0000');
    expect(listed[0].rect).toEqual({ x: 40, y: 200, width: 120, height: 24 });
    expect(listed[0].readonly).toBe(false);
    expect(listed[0].flags).toBe(4);
    expect(annotationCount(reloaded)).toBe(3);
  });

  it('handles inherited page /Annots, direct entries and indirect rect numbers', async () => {
    const doc = await docWithPages(2);
    const context = doc.context;

    // 1. an indirect annotation dict with an indirect /Rect array of indirect numbers
    const indirectRect = context.register(context.obj([
      context.register(PDFNumber.of(5)),
      context.register(PDFNumber.of(6)),
      context.register(PDFNumber.of(15)),
      context.register(PDFNumber.of(16)),
    ]));
    const indirectAnnot = context.register(context.obj({
      Type: 'Annot',
      Subtype: 'Square',
      Rect: indirectRect,
      C: [0, 0, 1],
      F: context.register(PDFNumber.of(64)),
      Contents: PDFString.of('indirect'),
    }));

    // 2. a direct annotation dict inside the page array
    const directAnnot = context.obj({
      Type: 'Annot',
      Subtype: 'Highlight',
      Rect: [1, 2, 3, 4],
      QuadPoints: [3, 4, 1, 4, 3, 2, 1, 2],
      Contents: PDFString.of('direct'),
    });

    doc.getPage(0).node.set(PDFName.of('Annots'), context.register(context.obj([indirectAnnot, directAnnot])));

    // 3. an annotation only reachable through the page tree (inherited entry)
    const inheritedAnnot = context.register(context.obj({
      Type: 'Annot',
      Subtype: 'FileAttachment',
      Rect: [9, 9, 20, 20],
      P: doc.getPage(1).node,
    }));
    const parent = doc.getPage(1).node.Parent();
    expect(parent).toBeTruthy();
    parent?.set(PDFName.of('Annots'), context.obj([inheritedAnnot]));

    const reloaded = await roundTrip(doc);
    const listed = listAnnotations(reloaded);
    expect(listed).toHaveLength(3);
    const [square, highlight, attached] = listed;
    expect(square.rect).toEqual({ x: 5, y: 6, width: 10, height: 10 });
    expect(square.readonly).toBe(true);
    expect(square.color).toBe('#0000ff');
    expect(highlight.kind).toBe('Highlight');
    expect(highlight.contents).toBe('direct');
    // /P on the annotation wins over the array it was found in.
    expect(attached.kind).toBe('FileAttachment');
    expect(attached.page).toBe(1);
    // The direct entry was made indirect so it can be removed later.
    expect(reloaded.getPage(0).node.Annots()?.get(1)).toBeInstanceOf(PDFRef);

    expect(removeAnnotations(reloaded, { kinds: ['FileAttachment' as AnnotationKind] })).toBe(1);
    expect(removeAnnotations(reloaded, { pages: [0] })).toBe(2);
    expect(annotationCount(reloaded)).toBe(0);
  });

  it('removes by kind and by exception, leaving the objects deleted', async () => {
    const doc = await docWithPages(2);
    addAnnotations(doc, [
      baseSpec('Highlight'),
      baseSpec('Ink', { inkPath: [[[40, 200], [100, 220]]] }),
      baseSpec('Text', { page: 1 }),
    ]);
    const reloaded = await roundTrip(doc);
    const before = listAnnotations(reloaded);
    expect(removeAnnotations(reloaded, { kinds: ['Highlight', 'Ink'] })).toBe(2);
    expect(before[0].ref ? true : false).toBe(true);
    expect(annotationCount(reloaded)).toBe(1);
    expect(reloaded.context.lookup(before[0].ref)).toBeUndefined();

    // `except` keeps the whitelisted-out kinds.
    expect(removeAnnotations(reloaded, { except: ['Text'] })).toBe(0);
    expect(removeAnnotations(reloaded, { except: ['Ink'] })).toBe(1);
    expect(annotationCount(reloaded)).toBe(0);
    // No filter at all is treated as a caller bug, not "delete everything".
    expect(removeAnnotations(reloaded, {})).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Redaction                                                           *
 * ------------------------------------------------------------------ */

describe('applyRedactions', () => {
  it('deletes the glyphs inside the rect and keeps the rest of the line in place', async () => {
    const doc = await docWithPages();
    const page = doc.getPage(0);
    const font = registerFixedFont(doc);
    setPageFont(doc, page, 'F1', font);
    setContent(doc, page, [
      'BT',
      '/F1 12 Tf',
      '1 0 0 1 50 200 Tm',
      '[(Secret) -250 (Agent)] TJ',
      '0 -14 Td',
      '(Public line) Tj',
      'ET',
    ].join('\n'));

    // 600/1000 em at 12pt = 7.2pt per glyph: "Secret" spans x 50…92.
    const result = applyRedactions(doc, [{ page: 0, rect: { x: 45, y: 195, width: 40, height: 14 } }]);
    expect(result.rasterised).toBe(false);
    expect(result.removed).toBeGreaterThan(0);

    const reloaded = await roundTrip(doc);
    const content = pageContent(reloaded);
    const visible = [...content.matchAll(/\[([^\]]*)\]\s*TJ/g)]
      .flatMap((m) => [...m[1].matchAll(/<([0-9a-f]{2})>/g)].map((c) => String.fromCharCode(Number.parseInt(c[1], 16))))
      .join('');
    expect(visible).not.toContain('Secret');
    expect(visible).toContain('Agent');
    expect(visible).toContain('Public line');
    // Kern displacement survives, so the rest of the run does not shift.
    expect(content).toMatch(/\[ .*-[\d.]+ .*] TJ/);
    // The fill rect is burned in last.
    expect(content).toMatch(/0 0 0 rg/);
    expect(content).toContain('45 195 40 14 re');
    // Balanced text objects: the rewrite never leaves a dangling BT.
    expect(content.match(/BT/g)?.length).toBe(content.match(/ET/g)?.length);
    expect(content.match(/T\*/g) === null).toBe(true);
  });

  it('removes a whole run without breaking the following lines', async () => {
    const doc = await docWithPages();
    const page = doc.getPage(0);
    setPageFont(doc, page, 'F1', registerFixedFont(doc));
    setContent(doc, page, [
      'BT',
      '/F1 12 Tf',
      '14 TL',
      '1 0 0 1 50 250 Tm',
      '(hidden one) Tj',
      'T*',
      '(visible two) Tj',
      'T*',
      '(visible three) Tj',
      'ET',
    ].join('\n'));

    const result = applyRedactions(doc, [{ page: 0, rect: { x: 45, y: 244, width: 80, height: 12 } }]);
    expect(result.removed).toBe(1);
    const reloaded = await roundTrip(doc);
    const content = pageContent(reloaded);
    const decoded = [...content.matchAll(/<([0-9a-f]+)>\s*Tj|\[([^\]]*)\]\s*TJ/g)]
      .map((m) => Buffer.from(m[1] ?? (m[2].match(/<([0-9a-f]+)>/g) ?? []).join('').replace(/[<>]/g, ''), 'hex').toString('latin1'))
      .join('|');
    expect(decoded).not.toContain('hidden one');
    expect(decoded).toContain('visible two');
    expect(decoded).toContain('visible three');
    // The line breaks are still there, so the surviving lines did not move up.
    expect(content.match(/T\*/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('tracks Td, TD, Tz and the q/Q/cm stack when measuring', async () => {
    const doc = await docWithPages();
    const page = doc.getPage(0);
    setPageFont(doc, page, 'F1', registerFixedFont(doc));
    setContent(doc, page, [
      'q',
      '1 0 0 1 100 0 cm',
      'BT',
      '/F1 10 Tf',
      '50 Tz',          // half the horizontal advance: 600/1000*10*0.5 = 3pt per glyph
      '1 0 0 1 0 150 Td',
      '(scaled) Tj',
      'TD',
      'ET',
      'Q',
    ].join('\n').replace('TD\n', '0 -20 TD\n(visible) Tj\n'));

    // The cm shift moves the text to x 100…118, so a rect at 90…120 catches it.
    const result = applyRedactions(doc, [{ page: 0, rect: { x: 90, y: 140, width: 30, height: 14 } }]);
    expect(result.removed).toBe(1);
    const reloaded = await roundTrip(doc);
    const content = pageContent(reloaded);
    // The covered run is gone and the line after it keeps its own `TD` move, so
    // it lands where the producer put it. The surviving run is re-emitted as a
    // `TJ` array of hex operands, because one cut makes the whole text object
    // get rewritten from the measured state — the bytes of `(visible) Tj` would
    // prove nothing that `shownText` does not already prove here.
    expect(content).toContain('0 -20 TD');
    expect(shownText(content)).toContain('visible');
    expect(content).not.toContain(Buffer.from('scaled').toString('hex'));
    expect(shownText(content)).not.toContain('scaled');
  });

  it('reports rasterised for image XObjects and inline images, and can leave them unpainted', async () => {
    const doc = await docWithPages();
    const page = doc.getPage(0);
    const image = doc.context.register(
      doc.context.stream(fakeJpeg(8, 8), {
        Type: '/XObject',
        Subtype: '/Image',
        Width: 8,
        Height: 8,
        BitsPerComponent: 8,
        ColorSpace: '/DeviceRGB',
        Filter: '/DCTDecode',
        Length: fakeJpeg(8, 8).length,
      }),
    );
    setPageXObject(doc, page, 'Im0', image);
    setContent(doc, page, ['q', '1 0 0 1 20 20 cm', '100 60 re', 'f', '100 0 0 60 20 20 cm', '/Im0 Do', 'Q'].join('\n'));

    const covering = applyRedactions(doc, [{ page: 0, rect: { x: 40, y: 40, width: 20, height: 20 } }], { onImage: 'blackout' });
    expect(covering.rasterised).toBe(true);

    const reloaded = await roundTrip(doc);
    expect(pageContent(reloaded)).toContain('40 40 20 20 re');

    const kept = applyRedactions(doc, [{ page: 0, rect: { x: 40, y: 40, width: 20, height: 20 } }], { onImage: 'keep' });
    expect(kept.rasterised).toBe(true);
    const afterKeep = await roundTrip(doc);
    // `keep` removes text but does not double-burn the pixels.
    expect(pageContent(afterKeep).match(/40 40 20 20 re/g)?.length).toBe(1);

    // Miss-area rects do not report raster content.
    const elsewhere = applyRedactions(doc, [{ page: 0, rect: { x: 200, y: 200, width: 20, height: 20 } }]);
    expect(elsewhere.rasterised).toBe(false);

    // An inline image is pixels as much as an `Image` XObject is: `BI … ID … EI`
    // has to report too, or a scan under the rect survives the redaction.
    const scanned = await docWithPages();
    setContent(
      scanned,
      scanned.getPage(0),
      ['q', '40 0 0 40 40 40 cm', 'BI /W 4 /H 4 /BPC 8 /F /ASCIIHexDecode /L 8 ID', '61626364656667', 'EI', 'Q'].join('\n'),
    );
    const inline = applyRedactions(scanned, [{ page: 0, rect: { x: 45, y: 45, width: 10, height: 10 } }]);
    expect(inline.rasterised).toBe(true);
    const clear = applyRedactions(scanned, [{ page: 0, rect: { x: 200, y: 200, width: 10, height: 10 } }]);
    expect(clear.rasterised).toBe(false);
  });

  it('redacts text nested in a Form XObject and copies a form another page shares', async () => {
    const doc = await docWithPages(2);
    const font = registerFixedFont(doc);
    const formContent = ['BT', '/F1 12 Tf', '1 0 0 1 10 10 Tm', '(form secret) Tj', 'ET'].join('\n');
    const makeForm = () => {
      const stream = doc.context.flateStream(`${formContent}\n`, {
        Type: '/XObject',
        Subtype: '/Form',
        BBox: [0, 0, 120, 40],
        Resources: { Font: { F1: font } },
      });
      stream.dict.set(PDFName.of('Length'), PDFNumber.of(stream.contents.length));
      return doc.context.register(stream);
    };
    const first = makeForm();
    const second = makeForm();
    setPageXObject(doc, doc.getPage(0), 'Frm', first);
    setPageXObject(doc, doc.getPage(1), 'Frm', second);
    // Both pages reach the same form object: the redaction must copy it first.
    setPageXObject(doc, doc.getPage(1), 'FrmShared', first);
    setContent(doc, doc.getPage(0), 'q 1 0 0 1 40 180 cm /Frm Do Q');
    setContent(doc, doc.getPage(1), 'q 1 0 0 1 40 40 cm /FrmShared Do Q');

    const result = applyRedactions(doc, [{ page: 0, rect: { x: 45, y: 185, width: 40, height: 14 } }]);
    expect(result.removed).toBe(1);

    const reloaded = await roundTrip(doc);
    // A form's operators live in the form XObject's own stream and the page
    // stream only holds the `Do` (PDF 32000-1 §8.10.1), so the two copies are
    // read through the resources of the page that draws them.
    expect(pageContent(reloaded, 0)).toContain('/Frm Do');
    expect(pageContent(reloaded, 1)).toContain('/FrmShared Do');
    // Page 1 keeps the original, un-redacted form…
    expect(shownText(formOps(reloaded, 1, 'FrmShared'))).toContain('form secret');
    // …while the copy this page got lost the glyphs under the rect and kept the
    // ones beside it.
    const form = formOps(reloaded, 0, 'Frm');
    expect(shownText(form)).not.toContain('form');
    expect(shownText(form)).toContain('secret');
  });

  it('applies the requested fill colour and rejects an out-of-range page', async () => {
    const doc = await docWithPages(1);
    setContent(doc, doc.getPage(0), 'q 0 0 10 10 re f Q');
    applyRedactions(doc, [{ page: 0, rect: { x: 1, y: 1, width: 4, height: 4 } }], { fill: '#ff0000' });
    const reloaded = await roundTrip(doc);
    expect(pageContent(reloaded)).toContain('1 0 0 rg');
    expect(() => applyRedactions(doc, [{ page: 7, rect: { x: 0, y: 0, width: 5, height: 5 } }])).toThrow(/has 1 page/);
    expect(() => applyRedactions(doc, [{ page: 0, rect: { x: 0, y: 0, width: 5, height: 5 } }], { fill: 'oops' })).toThrow(/hex value/);
    expect(applyRedactions(doc, [])).toEqual({ removed: 0, rasterised: false });
  });
});

/* ------------------------------------------------------------------ *
 * A mark turned to an angle                                           *
 * ------------------------------------------------------------------ */

describe('a rotated annotation in the file', () => {
  /** The declared `/Rotate`, or 0 when the dictionary does not carry one. */
  const declared = (dict: PDFDict) => dict.lookupMaybe(PDFName.of('Rotate'), PDFNumber)?.asNumber() ?? 0;
  const line = (over: Partial<AnnotationSpec> = {}) =>
    baseSpec('Line', { lineEnds: [40, 212, 160, 212], lineArrow: 'none', ...over });

  it('writes /Rect as the box the turned shape occupies, never the box it was drawn in', async () => {
    const doc = await docWithPages();
    const drawn = baseSpec('Square').rect;
    addAnnotation(doc, baseSpec('Square', { rotation: 30 }));
    addAnnotation(doc, baseSpec('Square', {}));
    const [turned, straight] = listAnnotations(await roundTrip(doc));
    // The turned box, measured from the corners the writer itself turns. A flat
    // mark swept 30° gets taller and narrower, so the claim is only ever
    // "/Rect is the bounding box", never "/Rect grew".
    const box = rotatedRectBounds(drawn, 30);
    expect(turned.rect.x).toBeCloseTo(box.x, 1);
    expect(turned.rect.y).toBeCloseTo(box.y, 1);
    expect(turned.rect.width).toBeCloseTo(box.width, 1);
    expect(turned.rect.height).toBeCloseTo(box.height, 1);
    expect(turned.rect.height).toBeGreaterThan(straight.rect.height);
    expect(turned.rect).not.toEqual(straight.rect);
  });

  it('bakes the turn into the appearance stream, so the page cannot paint it straight', async () => {
    const doc = await docWithPages();
    addAnnotation(doc, baseSpec('Square', { rotation: 30 }));
    addAnnotation(doc, baseSpec('Square', {}));
    const [turnedOps, straightOps] = annotationDicts(doc).map((dict) => appearanceOps(doc, dict));
    expect(turnedOps).toMatch(/cm/);
    expect(turnedOps.trimStart().startsWith('q')).toBe(true);
    expect(turnedOps.trimEnd().endsWith('Q')).toBe(true);
    // An unrotated mark keeps the operators it always had: no matrix, no claim.
    expect(straightOps).not.toMatch(/cm/);
  });

  it('declares /Rotate only where PDF allows it, and only in right angles', async () => {
    const doc = await docWithPages();
    const quad = [40, 224, 160, 224, 40, 200, 160, 200];
    addAnnotation(doc, line({ rotation: 90 }));
    addAnnotation(doc, baseSpec('Underline', { rotation: 90, quadPoints: quad }));
    addAnnotation(doc, baseSpec('Highlight', { rotation: 90, quadPoints: quad }));
    addAnnotation(doc, baseSpec('Square', { rotation: 90 }));
    addAnnotation(doc, line({ rotation: 30 }));
    const dicts = annotationDicts(doc);
    expect(declared(dicts[0])).toBe(90);
    expect(declared(dicts[1])).toBe(90);
    // Highlight is the one markup subtype PDF denies /Rotate, so the writer turns
    // its quads itself. A second turn by the reader would double it.
    expect(declared(dicts[2])).toBe(0);
    expect(declared(dicts[3])).toBe(0);
    expect(declared(dicts[4])).toBe(0);
    const turnedQuads = numbers(dicts[2].get(PDFName.of('QuadPoints')), doc);
    expect(turnedQuads).not.toEqual(quad);
    expect(numbers(dicts[4].get(PDFName.of('L'))!, doc)).not.toEqual([40, 212, 160, 212]);
  });

  it('reads a declared angle back out, and keeps a baked one in the geometry', async () => {
    const doc = await docWithPages();
    addAnnotation(doc, line({ rotation: 90 }));
    addAnnotation(doc, baseSpec('Square', { rotation: 30 }));
    const [turnedLine, square] = listAnnotations(await roundTrip(doc));
    expect(turnedLine.rotation).toBe(90);
    // A baked angle is not lost, it is never in /Rotate: /Rect and the stream hold
    // it, which is why `rotation` reads back 0 for a mark that is visibly turned.
    expect(square.rotation).toBe(0);
    expect(square.rect.height).toBeGreaterThan(24);
  });

  it('turns a highlight one quad per line, so the lines keep their leading', async () => {
    const doc = await docWithPages();
    const quads = [
      40, 224, 160, 224, 40, 200, 160, 200, // line one
      40, 184, 160, 184, 40, 160, 160, 160, // line two
    ];
    addAnnotation(doc, baseSpec('Highlight', { rect: { x: 40, y: 160, width: 120, height: 64 }, quadPoints: quads, rotation: 45 }));
    const points = numbers(firstAnnotation(doc).get(PDFName.of('QuadPoints')), doc);
    expect(points).toHaveLength(16);
    // Still one quad per line: eight numbers, not a box drawn around both.
    const xs = points.filter((_, index) => index % 2 === 0);
    const ys = points.filter((_, index) => index % 2 === 1);
    const rect = numbers(firstAnnotation(doc).get(PDFName.of('Rect')), doc);
    expect(rect[0]).toBeLessThanOrEqual(Math.min(...xs) + 0.01);
    expect(rect[1]).toBeLessThanOrEqual(Math.min(...ys) + 0.01);
    expect(rect[2]).toBeGreaterThanOrEqual(Math.max(...xs) - 0.01);
    expect(rect[3]).toBeGreaterThanOrEqual(Math.max(...ys) - 0.01);
  });
});
