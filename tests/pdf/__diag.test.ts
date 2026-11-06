import { describe, expect, it } from 'vitest';
import { appendFileSync } from 'node:fs';
const log = (m: string) => appendFileSync('/tmp/diag.log', m + '\n');
import { PDFDocument, PDFName, PDFNumber, PDFArray, PDFDict, PDFRef, PDFRawStream, decodePDFRawStream } from '@maxwbh/pdf-lib';
import { applyRedactions } from '@/lib/pdf/core/annotations';

async function docWithPages(pages = 1): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([300, 300]);
  return doc;
}

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

function setContent(doc: PDFDocument, page: any, ops: string): void {
  const stream = doc.context.flateStream(`${ops}\n`, {});
  stream.dict.set(PDFName.of('Length'), PDFNumber.of(stream.contents.length));
  page.node.set(PDFName.of('Contents'), doc.context.register(stream));
}

function decode(stream: PDFRawStream): string {
  return new TextDecoder().decode(decodePDFRawStream(stream).decode());
}

function pageContent(doc: PDFDocument, pageIndex = 0): string {
  const contents = doc.getPage(pageIndex).node.Contents();
  const entries = contents instanceof PDFArray ? contents.asArray() : [contents];
  return entries
    .map((entry) => {
      const resolved = entry instanceof PDFRef ? doc.context.lookupMaybe(entry, PDFRawStream) : doc.context.lookupMaybe(entry as any, PDFRawStream);
      return resolved ? decode(resolved) : `<nonstream:${String(entry)}>`;
    })
    .join('\n');
}

describe('diag', () => {
  it('t1 partial line', async () => {
    const doc = await docWithPages();
    const page = doc.getPage(0);
    page.node.normalizedEntries().Font.set(PDFName.of('F1'), registerFixedFont(doc));
    setContent(doc, page, ['BT', '/F1 12 Tf', '1 0 0 1 50 200 Tm', '[(Secret) -250 (Agent)] TJ', '0 -14 Td', '(Public line) Tj', 'ET'].join('\n'));
    const result = applyRedactions(doc, [{ page: 0, rect: { x: 45, y: 195, width: 40, height: 14 } }]);
    log('RESULT', JSON.stringify(result));
    const reloaded = await PDFDocument.load(await doc.save());
    log('RELOADED>>>\n' + pageContent(reloaded) + '<<<');
    expect(true).toBe(true);
  });

  it('t4 images', async () => {
    const doc = await docWithPages();
    const page = doc.getPage(0);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 8, 0, 8, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
    const image = doc.context.register(
      doc.context.stream(jpeg, {
        Type: '/XObject',
        Subtype: '/Image',
        Width: 8,
        Height: 8,
        BitsPerComponent: 8,
        ColorSpace: '/DeviceRGB',
        Filter: '/DCTDecode',
        Length: jpeg.length,
      }),
    );
    page.node.normalizedEntries().XObject.set(PDFName.of('Im0'), image);
    setContent(doc, page, ['q', '1 0 0 1 20 20 cm', '100 60 re', 'f', '100 0 0 60 20 20 cm', '/Im0 Do', 'Q'].join('\n'));
    const result = applyRedactions(doc, [{ page: 0, rect: { x: 40, y: 40, width: 20, height: 20 } }], { onImage: 'blackout' });
    log('RESULT4', JSON.stringify(result));
    const r4 = await PDFDocument.load(await doc.save());
    log('CONTENT4>>>\n' + pageContent(r4) + '<<<');
    expect(true).toBe(true);
  });

  it('t5 form', async () => {
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
    doc.getPage(0).node.normalizedEntries().XObject.set(PDFName.of('Frm'), first);
    doc.getPage(1).node.normalizedEntries().XObject.set(PDFName.of('Frm'), second);
    doc.getPage(1).node.normalizedEntries().XObject.set(PDFName.of('FrmShared'), first);
    setContent(doc, doc.getPage(0), 'q 1 0 0 1 40 180 cm /Frm Do Q');
    setContent(doc, doc.getPage(1), 'q 1 0 0 1 40 40 cm /FrmShared Do Q');
    const result = applyRedactions(doc, [{ page: 0, rect: { x: 45, y: 185, width: 40, height: 14 } }]);
    log('RESULT5', JSON.stringify(result));
    const r5 = await PDFDocument.load(await doc.save());
    log('P0>>>\n' + pageContent(r5) + '<<<');
    log('P1>>>\n' + pageContent(r5, 1) + '<<<');
    for (const [key, value] of r5.context.enumerateIndirectObjects()) {
      if (value instanceof PDFRawStream) console.log('STREAM', key.toString(), JSON.stringify(decode(value)).slice(0, 220));
      if (value instanceof PDFDict) console.log('DICT', key.toString(), String(value));
    }
    expect(true).toBe(true);
  });
});
