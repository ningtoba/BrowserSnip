/**
 * Where a placed signature actually lands, in the bytes.
 *
 * `sign` promises "your mark, placed where you drop it, drawn into the page in this
 * tab", and the pane stores a placement as *fractions of the page the mark sits on*
 * plus a size in points. Three things can go wrong where those numbers meet the
 * document, and all three were measured against the deployed site rather than
 * assumed: a mark converted against the first page's size lands in the wrong corner
 * of every page that differs; a visual signature could be written as something the
 * card does not claim (an annotation, or a `/Sig` field implying cryptography the
 * tool says it does not do); and a typed name could ask `core/fonts` for an embedded
 * face — a network fetch — for the very families the standard 14 already supply.
 *
 * The browser half — draw a stroke with real mouse events, drag it, read the box the
 * overlay painted, export — is `docs/research/verify-sign-run.mjs`, judged by
 * `docs/research/verify-sign-read.py`, with its record in `docs/research/sign-deployed.log`.
 */
import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFContentStream,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  StandardFonts,
  decodePDFRawStream,
  rgb,
} from '@maxwbh/pdf-lib';
import { drawSignatureMarks, type SignatureMark } from '@/lib/pdf-engine/commands';

/** 1x1 opaque PNG, the same shape the other byte tests reach for. */
const PIXEL = Uint8Array.from(atob(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/7AAAAABJRU5ErkJggg==',
), (c) => c.charCodeAt(0));

/** A4 portrait, then a 400x300 sheet: two marks that must not share geometry. */
async function mixedDocument() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const big = doc.addPage([595, 842]);
  big.drawText('alice1bravo', { x: 30, y: 421, size: 12, font, color: rgb(0, 0, 0) });
  const small = doc.addPage([400, 300]);
  small.drawText('alice2bravo', { x: 30, y: 150, size: 12, font, color: rgb(0, 0, 0) });
  return doc;
}

/** Every operator the page's content streams hold, decoded and joined. */
function contentText(doc: PDFDocument, index: number): string {
  const node = doc.getPage(index).node;
  const contents = node.get(PDFName.of('Contents'));
  const items = contents instanceof PDFArray
    ? contents.asArray()
    : contents instanceof PDFRef
      ? [contents]
      : [];
  return items.map((item) => {
    const resolved = doc.context.lookup(item);
    // A page built in this tab holds its operators in a `PDFContentStream`; one that
    // came back from bytes holds a possibly-compressed `PDFRawStream`.
    if (resolved instanceof PDFContentStream) return resolved.getContentsString();
    return resolved instanceof PDFRawStream
      ? new TextDecoder().decode(decodePDFRawStream(resolved).decode())
      : '';
  }).join('\n');
}

/** Every `a b c d e f cm` matrix in the page's content, in order. */
function placedBoxes(text: string): string[] {
  return text.match(/[\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+ cm/g) ?? [];
}

/**
 * The image operators pdf-lib writes for one placed picture: a translation to the
 * lower-left corner, then a matrix that is the picture's own size.
 */
function imagePaint(text: string) {
  const boxes = placedBoxes(text);
  const size = boxes.find((m) => !m.startsWith('1 0 0 1 '));
  const move = boxes.find((m) => m.startsWith('1 0 0 1 '));
  return { size: size ?? '', move: move ?? '' };
}

/** The text a page actually shows, recovered from its hex-encoded `Tj` literals. */
function pageWords(text: string): string {
  const runs = text.match(/<([0-9A-Fa-f]+)>\s*Tj/g) ?? [];
  const plain = runs.map((run) => {
    const hex = run.slice(1, run.indexOf('>'));
    let out = '';
    for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return out;
  });
  return [...plain, ...(text.match(/\((.*?)\)\s*Tj/g) ?? [])].join(' ');
}

const imageMark = (over: Partial<SignatureMark>): SignatureMark => ({
  type: 'image', text: '', image: PIXEL, mime: 'image/png',
  page: 1, x: 0.4, y: 0.5, width: 120, height: 40, ...over,
});

describe('a placed signature lands where the pane put it', () => {
  it('converts the fractions against the mark’s own page, not the first one', async () => {
    const doc = await mixedDocument();
    const outcome = await drawSignatureMarks(doc, [
      imageMark({ page: 2, x: 0.3992, y: 0.4753 }),
    ]);
    expect(outcome.notes).toEqual([]);
    expect(outcome.placed).toBe(1);

    const small = doc.getPage(1);
    expect([small.getMediaBox().width, small.getMediaBox().height]).toEqual([400, 300]);
    const paint = imagePaint(contentText(doc, 1));
    // 0.3992 x 400 = 159.68 pt from the left, 0.4753 x 300 = 142.59 pt from the
    // bottom. Against page 1's 595x842 those fractions would have been 237.5/401.
    expect(paint.move).toMatch(/^1 0 0 1 159\.\d+ 142\.\d+ cm$/);
    expect(paint.size).toMatch(/^120(\.0+)? 0 0 40(\.0+)? 0 0 cm$/);
    expect(contentText(doc, 1), 'the mark is an XObject painted into the page content')
      .toMatch(/\/[A-Za-z0-9_-]+\s+Do/);
  });

  it('writes a typed name as text, with the family the overlay shows, no annotation', async () => {
    const doc = await mixedDocument();
    const outcome = await drawSignatureMarks(doc, [{
      type: 'text', text: 'Ada Lovelace', page: 1, x: 0.0291, y: 0.1198,
      width: 180, height: 40, color: '#1b1b18', fontFamily: 'Helvetica',
    }]);
    expect(outcome.placed).toBe(1);
    expect(outcome.notes).toEqual([]);
    const text = contentText(doc, 0);
    expect(pageWords(text)).toContain('Ada Lovelace');
    // The pane paints the mark in Helvetica (26 pt is 65 % of the 40 pt box, the
    // rule `clampFontSize` applies); a standard name must not be traded for an
    // embedded face, which is the branch that reaches for the site's font file.
    expect(text).toMatch(/\/Helvetica[\w-]* 26 Tf/);
    expect(text, 'a WinAnsi-safe name must not embed a Unicode face').not.toContain('NotoSans');
    const raw = Buffer.from(await doc.save({ useObjectStreams: false })).toString('latin1');
    expect(raw).toContain('/BaseFont /Helvetica');
    expect(raw, 'a WinAnsi-safe name must not embed a Unicode face').not.toContain('NotoSans');
    // "It is not a cryptographic signature" has to be true of the bytes as well as
    // of the copy: no widget, no AcroForm, no /Sig, and no annotation on the page.
    expect(raw).not.toMatch(/\/AcroForm/);
    expect(raw).not.toMatch(/\/Sig\b/);
    expect(raw).not.toMatch(/\/Subtype\s*\/(Widget|Stamp|FreeText|Ink|Popup)\b/);
    for (const listed of raw.match(/\/Annots\s*\[[^\]]*\]/g) ?? []) {
      expect(listed, 'a placed signature adds no annotation').toMatch(/^\/Annots\s*\[\s*\]$/);
    }
  });

  it('keeps the document intact around the marks', async () => {
    const doc = await mixedDocument();
    await drawSignatureMarks(doc, [
      imageMark({ page: 1 }),
      { type: 'text', text: 'Ada', page: 2, x: 0.1, y: 0.1, width: 100, height: 30, fontFamily: 'Courier' },
    ]);
    const bytes = await doc.save();
    const again = await PDFDocument.load(bytes);
    expect(again.getPageCount()).toBe(2);
    expect(again.getPage(0).getMediaBox().width).toBe(595);
    expect(again.getPage(1).getMediaBox().width).toBe(400);
  });

  it('names a mark that points at a page the document does not have', async () => {
    const doc = await mixedDocument();
    const outcome = await drawSignatureMarks(doc, [imageMark({ page: 9 })]);
    expect(outcome.placed).toBe(0);
    expect(outcome.notes.join(' ')).toMatch(/1 signature pointed at a page/i);
  });

  it('pulls a mark that would hang off the paper back inside it, and says so', async () => {
    const doc = await mixedDocument();
    // 380 pt wide on a 400 pt page, aimed at its right edge.
    const outcome = await drawSignatureMarks(doc, [
      imageMark({ page: 2, x: 0.9, y: 0.1, width: 380, height: 40 }),
    ]);
    expect(outcome.placed).toBe(1);
    expect(outcome.notes.join(' ')).toMatch(/hung past the edge of its page and was pulled back inside it/i);
    const paint = imagePaint(contentText(doc, 1));
    expect(paint.move).toBe('1 0 0 1 20 30 cm');
    expect(paint.size).toMatch(/^380(\.0+)? 0 0 40(\.0+)? 0 0 cm$/);
  });
});
