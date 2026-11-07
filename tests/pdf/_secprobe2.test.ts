import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFDict, PDFRawStream, PDFRef, streamUtils } from '@maxwbh/pdf-lib';
import { StandardFonts, rgb } from '@maxwbh/pdf-lib';
import { inflateSync } from 'node:zlib';

const latin1 = new TextDecoder('latin1');

async function plainFixture(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Ordinary page ${index + 1}`, { x: 60, y: 700, size: 18, font, color: rgb(0, 0, 0) });
  }
  return doc.save({ useObjectStreams: false });
}

describe('encrypt probe', () => {
  it('what does save({encrypt}) really write', async () => {
    const plain = await plainFixture();
    const doc = await PDFDocument.load(plain);
    const enc = await doc.save({
      encrypt: {
        userPassword: 'hunter2',
        ownerPassword: 'hunter2',
        version: 4 as never,
        permissions: { printing: true, modifying: true, copying: true, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: false } as never,
      },
    } as never);
    const raw = latin1.decode(enc);
    console.log('plain text present in encrypted file:', raw.includes('Ordinary page 1'));
    const dictMatch = /<<[^>]*\/Filter[^>]*>>/.exec(raw.slice(raw.lastIndexOf('/Encrypt')));
    console.log('tail:', JSON.stringify(raw.slice(-600)));
    const loaded = await PDFDocument.load(enc, { ignoreEncryption: true, updateMetadata: false });
    const trailer = loaded.context.trailerInfo as unknown as Record<string, unknown>;
    console.log('trailer keys:', Object.keys(trailer));
    const encObj = trailer.Encrypt instanceof PDFRef
      ? loaded.context.lookup(trailer.Encrypt as PDFRef)
      : trailer.Encrypt;
    console.log('Encrypt dict:', encObj instanceof PDFDict ? (encObj as PDFDict).toString() : String(encObj));
    let content = '';
    for (const [, object] of loaded.context.enumerateIndirectObjects()) {
      if (object instanceof PDFRawStream) {
        const bytes = object.getContents();
        content += latin1.decode(bytes).replace(/\s+/g, ' ').slice(0, 120) + '\n';
      }
    }
    console.log('raw stream payloads:\n', content.slice(0, 900));
    let inflated = '';
    for (const [, object] of loaded.context.enumerateIndirectObjects()) {
      if (object instanceof PDFRawStream) {
        try {
          inflated += latin1.decode(inflateSync(Buffer.from(object.getContents()))) + '\n';
        } catch {
          inflated += '(not flate)\n';
        }
      }
    }
    console.log('inflated payloads:', JSON.stringify(inflated.slice(0, 600)));
    console.log('has xref stream:', /\/Type\s*\/XRef/.test(raw));
    expect(dictMatch === null).toBe(true || false);
  }, 120_000);
});
