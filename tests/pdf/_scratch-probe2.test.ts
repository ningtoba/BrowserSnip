import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, StandardFonts, degrees, rgb } from '@maxwbh/pdf-lib';

const fileOf = (bytes: Uint8Array, name: string): File =>
  new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });

async function sheets(n: number, size: [number, number], label = 'sheet'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < n; i++) {
    const page = doc.addPage(size);
    page.drawText(`${label} ${i + 1}`, { x: 10, y: size[1] - 20, size: 12, font, color: rgb(0, 0, 0) });
  }
  return doc.save({ useObjectStreams: false });
}

function inflateAll(bytes: Uint8Array): string {
  let out = '';
  const raw = Buffer.from(bytes).toString('latin1');
  for (const match of raw.matchAll(/>>\s*stream\r?\n/g)) {
    const start = (match.index ?? 0) + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    try {
      out += inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1');
    } catch {
      out += raw.slice(start, end);
    }
  }
  return out;
}

async function run(toolId: string, values: Record<string, unknown>, files: File[]) {
  const { runPdfTool } = await import('@/lib/pdf/tools/runner');
  return runPdfTool({ toolId, files, values });
}

describe('probe2', () => {
  it('form fields across merge', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 100]);
    const form = doc.getForm();
    form.createTextField('answer');
    form.getTextField('answer').addToPage(page, { x: 20, y: 40, width: 80, height: 20 });
    const bytes = await doc.save({ useObjectStreams: false });
    const outcome = await run('merge', {}, [fileOf(bytes, 'form.pdf'), fileOf(await sheets(1, [200, 100]), 'b.pdf')]);
    const out = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
    const reopened = await PDFDocument.load(out);
    const hasForm = reopened.catalog.get(PDFName.of('AcroForm')) !== undefined;
    let fields = 0;
    try {
      fields = reopened.getForm().getFields().length;
    } catch (error) {
      fields = -1;
    }
    process.stderr.write(`MERGE FORM catalog=${hasForm} fields=${fields}\n`);
  });

  it('fix-page-size selection drops pages', async () => {
    const mixed = await sheets(3, [400, 300], 'big');
    const outcome = await run('fix-page-size', { size: 'a4', orientation: 'keep', fit: 'contain', pages: '1' }, [fileOf(mixed, 'm.pdf')]);
    const doc = await PDFDocument.load(new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()));
    process.stderr.write(`FIXPS pages=${doc.getPageCount()} sizes=${JSON.stringify(doc.getPages().map((p) => p.getSize()))} msg=${outcome.message} warn=${JSON.stringify(outcome.warnings)}\n`);
  });

  it('alternate-merge reverse-alternate', async () => {
    const a = await sheets(3, [200, 100], 'A');
    const b = await sheets(3, [200, 100], 'B');
    const outcome = await run('alternate-merge', { pattern: 'reverse-alternate' }, [fileOf(a, 'a.pdf'), fileOf(b, 'b.pdf')]);
    const bytes = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
    const text = inflateAll(bytes);
    const order = [...text.matchAll(/(?:A|B) \d/g)].map((m) => m[0]);
    process.stderr.write(`ALT order=${JSON.stringify(order)}\n`);
  });

  it('posterize tile scale', async () => {
    const { getPdfTool } = await import('@/lib/pdf/tools/registry');
    void getPdfTool;
    const one = await sheets(1, [200, 100], 'P');
    const outcome = await run('posterize', { columns: 2, rows: 2, bleed: 10, pages: 'all' }, [fileOf(one, 'p.pdf')]);
    const doc = await PDFDocument.load(new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()));
    process.stderr.write(`POSTER sizes=${JSON.stringify(doc.getPages().map((p) => p.getSize()))}\n`);
    for (let i = 0; i < doc.getPageCount(); i++) {
      const page = doc.getPages()[i];
      const res = page.node.Resources();
      const dict = res instanceof PDFRef ? doc.context.lookup(res, PDFDict) : res;
      const xo = dict instanceof PDFDict ? dict.get(PDFName.of('XObject')) : undefined;
      const forms = xo instanceof PDFRef ? doc.context.lookup(xo, PDFDict) : xo;
      const boxes: string[] = [];
      if (forms instanceof PDFDict) {
        for (const [, value] of forms.entries()) {
          const object = value instanceof PDFRef ? doc.context.lookup(value) : value;
          const d = object instanceof PDFRawStream ? object.dict : object;
          if (d instanceof PDFDict) {
            const bbox = d.get(PDFName.of('BBox'));
            boxes.push(bbox instanceof PDFArray ? Array.from({ length: bbox.size() }, (_, k) => Number(bbox.get(k).toString())).join(' ') : String(bbox));
          }
        }
      }
      process.stderr.write(`  tile ${i} bbox=${JSON.stringify(boxes)}\n`);
    }
  });

  it('nup text + rotation reset', async () => {
    const a = await sheets(2, [200, 100], 'T');
    const outcome = await run('n-up', { perSheet: 2, sheetSize: 'a4', landscape: false, gutter: 0, margin: 0, pages: 'all' }, [fileOf(a, 't.pdf')]);
    const bytes = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
    const inflated = inflateAll(bytes);
    process.stderr.write(`NUP text found=${/T \d/.test(inflated)} Tf=${/Tf/.test(inflated)} len=${inflated.length}\n`);
  });

  it('cbz ignores selection', async () => {
    const a = await sheets(4, [200, 100], 'C');
    const outcome = await run('pdf-to-cbz', { format: 'png', dpi: 72, pages: '1-2' }, [fileOf(a, 'c.pdf')]).catch((e: Error) => e);
    process.stderr.write(`CBZ ${outcome instanceof Error ? `ERR ${outcome.message}` : `files=${outcome.outputs.length} names=${JSON.stringify(outcome.outputs.map((o) => o.name))} msg=${outcome.message} warn=${JSON.stringify(outcome.warnings)}`}\n`);
  });

  it('remove-blank-pages in jsdom', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 100]);
    const p = doc.addPage([200, 100]);
    p.setRotation(degrees(90));
    const bytes = await doc.save();
    const outcome = await run('remove-blank-pages', { keepAnnotated: true }, [fileOf(bytes, 'b.pdf')]).catch((e: Error) => e);
    process.stderr.write(`RBP ${outcome instanceof Error ? `ERR ${outcome.message.slice(0, 160)}` : `msg=${outcome.message}`}\n`);
  });
});
