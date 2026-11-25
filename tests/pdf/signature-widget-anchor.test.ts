// @vitest-environment node
/**
 * Seam wave 2E / census #17 — the visible signature widget anchored at the stored
 * top-left (rotation-blind `page.getWidth()/getHeight()`), so on a /Rotate 90/180/270
 * sheet the block showed in a different corner than "top-left" and its appearance
 * read turned (D4 render: the block landed displayed top-**right**, text running
 * down the edge). The ruled intent is that the block must appear where placed,
 * upright as displayed (wave 2D's standard).
 *
 * `installSignatureField` now sizes/aims the block in the displayed frame and maps
 * it through the shared `viewerRectToUserSpace` table (census row 4), and bakes the
 * inverse turn into the appearance stream (the `core/annotations.uprightMatrix`
 * recipe, census row 9), so `/Rotate 90` reads normally. `/Rotate 0` is unchanged.
 *
 * The MuPDF render + pdf.js `getAnnotations` checks in
 * `tests/pdf/signature-widget-display.test.ts` judge the *pixels*; the assertions
 * here pin the bytes (rect + appearance matrix) that produce them.
 */
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, degrees } from '@maxwbh/pdf-lib';
import { createSelfSignedCertificate, signDocument } from '@/lib/pdf/core/signature';
import { viewerRectToUserSpace, viewerSizeOf, type PageFrame } from '@/lib/pdf/core/tables';

const cert = await createSelfSignedCertificate('Ada Lovelace');
const enc = (s: string) => new TextEncoder().encode(s);

async function signed(rotation: 0 | 90 | 180 | 270, w = 400, h = 600) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([w, h]);
  page.setRotation(degrees(rotation));
  const result = await signDocument(doc, {
    certificate: enc(cert.certificatePem),
    privateKey: enc(cert.privateKeyPem),
    visible: true,
    page: 0,
  });
  const signedDoc = await PDFDocument.load(result.bytes);
  const root = signedDoc.context.lookup(signedDoc.context.trailerInfo.Root) as PDFDict;
  const form = signedDoc.context.lookup(root.get(PDFName.of('AcroForm'))!) as PDFDict;
  const fields = signedDoc.context.lookup(form.get(PDFName.of('Fields'))!) as PDFArray;
  const field = signedDoc.context.lookup(fields.asArray()[0]!) as PDFDict;
  const kids = signedDoc.context.lookup(field.get(PDFName.of('Kids'))!) as PDFArray;
  const widget = signedDoc.context.lookup(kids.asArray()[0]!) as PDFDict;
  const rect = (signedDoc.context.lookup(widget.get(PDFName.of('Rect'))!) as PDFArray).asArray().map(Number);
  const ap = signedDoc.context.lookup(widget.get(PDFName.of('AP'))!) as PDFDict;
  const normal = signedDoc.context.lookup(ap.get(PDFName.of('N'))!) as unknown as { dict: PDFDict };
  const bbox = (normal.dict.get(PDFName.of('BBox')) as PDFArray).asArray().map(Number);
  const content = await decode(normal);
  return { rect, bbox, content, signedDoc };
}

async function decode(stream: { dict: PDFDict } & Record<string, unknown>): Promise<string> {
  const { decodePDFRawStream } = await import('@maxwbh/pdf-lib');
  const buf = (decodePDFRawStream(stream as never).decode()) as Uint8Array;
  return new TextDecoder('latin1').decode(buf);
}

describe('the visible signature widget lands where placed, upright as displayed (#17)', () => {
  for (const rotation of [0, 90, 180, 270] as const) {
    it(`/Rotate ${rotation}: the /Rect is the displayed top-left mapped through the table`, async () => {
      const { rect } = await signed(rotation);
      const frame: PageFrame = { x0: 0, y0: 0, width: 400, height: 600, rotation };
      const sheet = viewerSizeOf(frame);
      const dLeft = Math.min(Math.max(36, 4), Math.max(sheet.width - 220 - 4, 4));
      const dTop = Math.min(Math.max(36, 4), Math.max(sheet.height - 90 - 4, 4));
      const area = viewerRectToUserSpace({ x: dLeft, y: dTop, width: 220, height: 90 }, frame);
      expect([rect[0], rect[1], rect[2], rect[3]].map((v) => Math.round(v)))
        .toEqual([area.x, area.y, area.x + area.width, area.y + area.height].map((v) => Math.round(v)));
    });
  }

  it('the appearance reads upright: it is authored in the DISPLAYED size and turned inside the stream', async () => {
    const turned = await signed(90);
    // BBox is the stored rect's own (swapped) size, and the stream carries the
    // inverse-turn `cm` — without that matrix the block reads down the edge (D4).
    expect(turned.bbox).toEqual([0, 0, 90, 220]);
    expect(turned.content).toMatch(/0 1 -1 0 90 0 cm/);
    expect(turned.content).toContain('Digitally signed by');
    // A /Rotate 0 sheet is unchanged: identity, no wrapping cm.
    const flat = await signed(0);
    expect(flat.bbox).toEqual([0, 0, 220, 90]);
    expect(flat.content).not.toMatch(/^\s*q\n0 1 -1 0/s);
    expect(flat.content.startsWith('q\n1 1 1 rg')).toBe(true);
  });

  it('a quarter-turned sheet keeps its block entirely on the displayed paper', async () => {
    for (const rotation of [90, 180, 270] as const) {
      const { rect, signedDoc } = await signed(rotation, 300, 640);
      const box = signedDoc.getPage(0).getMediaBox();
      const on = rect[0] >= box.x - 0.5 && rect[1] >= box.y - 0.5
        && rect[2] <= box.x + box.width + 0.5 && rect[3] <= box.y + box.height + 0.5;
      expect(on, `rot ${rotation}: rect ${rect} off the ${box.width}x${box.height} sheet`).toBe(true);
    }
  });
});
