import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import { pageContentStreams } from '@/lib/pdf/core/content';

const fileOf = (bytes: Uint8Array, name: string): File =>
  new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });

const line = (s: string): void => process.stderr.write(`${s}\n`);

async function sheets(n: number, label: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < n; i++) {
    const page = doc.addPage([200, 100]);
    page.drawText(`${label} ${i + 1}`, { x: 10, y: 60, size: 12, font, color: rgb(0, 0, 0) });
  }
  return doc.save({ useObjectStreams: false });
}

async function run(toolId: string, values: Record<string, unknown>, files: File[]) {
  const { runPdfTool } = await import('@/lib/pdf/tools/runner');
  return runPdfTool({ toolId, files, values });
}

describe('probe4', () => {
  it('inspect output streams', async () => {
    const bytes = await sheets(3, 'R');
    const direct = await PDFDocument.load(bytes);
    line(`FIXTURE streams=${pageContentStreams(direct.getPage(0)).length} head=${JSON.stringify(Buffer.from(pageContentStreams(direct.getPage(0))[0]?.bytes ?? new Uint8Array()).toString('latin1').slice(0, 120))}`);
    const outcome = await run('reverse-pages', {}, [fileOf(bytes, 'r.pdf')]);
    const raw = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
    const doc = await PDFDocument.load(raw);
    line(`OUT streams=${pageContentStreams(doc.getPage(0)).length}`);
    for (const s of pageContentStreams(doc.getPage(0))) {
      line(`  bytes=${s.bytes === undefined ? 'UNDEF' : Buffer.from(s.bytes).toString('latin1').slice(0, 160)}`);
    }
    line(`  flate? ${Buffer.from(raw).toString('latin1').includes('FlateDecode')}`);
    const node = doc.getPage(0).node;
    const res = node.Resources();
    const dict = res instanceof PDFRef ? doc.context.lookup(res, PDFDict) : res;
    line(`  resources ${dict instanceof PDFDict ? [...dict.keys()].map(String) : String(dict)}`);
    void PDFArray;
    void PDFName;
  });
});
