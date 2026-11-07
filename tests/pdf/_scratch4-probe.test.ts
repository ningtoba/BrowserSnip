import { appendFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { PDFDocument, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import { openRender } from '@/lib/pdf/core/render';

function NOTE(...args: unknown[]) {
  appendFileSync('/tmp/security-probe4.log', args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
}
function pdfFile(bytes: Uint8Array, name: string): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}
async function plain(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText('Hello probe', { x: 60, y: 700, size: 18, font, color: rgb(0, 0, 0) });
  return doc.save({ useObjectStreams: false });
}
async function extract(bytes: Uint8Array, password?: string): Promise<string> {
  const session = await openRender(bytes, password ? { password } : {});
  try {
    return (await session.textItems(1)).map((i) => i.str).join('|');
  } finally {
    await session.destroy();
  }
}

describe('probe4', () => {
  beforeAll(() => {
    let workerPath = `file://${process.cwd()}/node_modules/pdfjs-dist/build/pdf.worker.mjs`;
    Object.defineProperty(GlobalWorkerOptions, 'workerSrc', {
      configurable: true, get: () => workerPath,
      set: (v: string) => { if (v.startsWith('file:') || v.startsWith('data:')) workerPath = v; },
    });
  });

  it('pdf.js on a spec-encrypted file from pdf-encrypt-lite', async () => {
    const lite = await import('@pdfsmaller/pdf-encrypt-lite');
    NOTE('lite exports:', Object.keys(lite));
    const source = await plain();
    const text = new TextDecoder('latin1').decode(source);
    const enc: any = (lite as any).encryptPDF;
    let out: Uint8Array | null = null;
    try {
      out = await enc(source, 'hunter2', 'owner');
    } catch (error) {
      NOTE('lite encrypt threw:', (error as Error).message);
    }
    NOTE('lite result type:', typeof out, out === null ? 'null' : out.length);
    if (out) {
      const bytes = new Uint8Array(out);
      const outText = new TextDecoder('latin1').decode(bytes);
      NOTE('lite bytes contain /Encrypt:', /\/Encrypt/.test(outText), 'still readable text:', outText.includes('Hello probe'));

      let r = '';
      try { r = await extract(bytes, 'hunter2'); } catch (e) { r = `THROWS ${(e as Error).message}`; }
      NOTE('pdf.js(lite, hunter2):', r);
      let wrong = '';
      try { wrong = await extract(bytes, 'nope'); } catch (e) { wrong = `THROWS ${(e as Error).message}`; }
      NOTE('pdf.js(lite, wrong):', wrong);
      let none = '';
      try { none = await extract(bytes); } catch (e) { none = `THROWS ${(e as Error).message}`; }
      NOTE('pdf.js(lite, none):', none);
    }
    expect(true).toBe(true);
  });
});
