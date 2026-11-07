import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import { flattenAnnotations } from '@/lib/pdf/core/flatten';
import { openRender } from '@/lib/pdf/core/render';
import { GlobalWorkerOptions } from 'pdfjs-dist';

describe('probe6', () => {
  it('flatten failure trace', async () => {
    let p = `file://${process.cwd()}/node_modules/pdfjs-dist/build/pdf.worker.mjs`;
    Object.defineProperty(GlobalWorkerOptions, 'workerSrc', {
      configurable: true, get: () => p,
      set: (v: string) => { if (v.startsWith('file:') || v.startsWith('data:')) p = v; },
    });
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([595, 842]);
    page.drawText('Body text', { x: 60, y: 700, size: 18, font, color: rgb(0, 0, 0) });
    const { addAnnotation } = await import('@/lib/pdf/core/annotations');
    addAnnotation(doc, { kind: 'Text', page: 0, rect: { x: 100, y: 500, width: 24, height: 24 }, contents: 'review me' });
    const bytes = await doc.save({ useObjectStreams: false });
    const loaded = await PDFDocument.load(bytes);
    const session = await openRender(bytes, {});
    try {
      const out = await flattenAnnotations(loaded, session, { keepLinks: true });
      process.stderr.write(`\n[flatten] ${JSON.stringify(out)}\n`);
    } catch (error) {
      process.stderr.write(`\n[flatten threw] ${(error as Error).message}\n${(error as Error).stack}\n`);
    }
    await session.destroy();
    expect(true).toBe(true);
  }, 120_000);
});
