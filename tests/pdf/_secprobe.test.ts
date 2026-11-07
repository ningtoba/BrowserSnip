import { beforeAll, describe, expect, it } from 'vitest';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { PDFDocument, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { openRender } from '@/lib/pdf/core/render';
import type { PdfToolDefinition, ToolValues } from '@/lib/pdf/tools/types';

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

function pdfFile(bytes: Uint8Array, name: string): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}

async function run(id: string, values: ToolValues = {}, files?: File[], password?: string) {
  const tool = getPdfTool(id) as PdfToolDefinition | undefined;
  expect(tool, `tool "${id}" is not registered`).toBeTruthy();
  const inputs = files ?? [pdfFile(await plainFixture(), 'fixture.pdf')];
  return runPdfTool({ toolId: id, files: inputs, values, password, onProgress: () => {}, onLog: () => {} });
}

async function bytesOf(outcome: Awaited<ReturnType<typeof run>>, index = 0): Promise<Uint8Array> {
  return new Uint8Array(await (outcome as any).outputs[index].blob.arrayBuffer());
}

const PROTECTION_DEFAULTS: ToolValues = {
  mode: 'user',
  userPassword: 'hunter2',
  ownerPassword: '',
  version: '4',
  allowPrinting: true,
  printLevel: 'high',
  allowModifying: true,
  allowCopying: true,
  allowAnnotating: true,
  allowFillingForms: true,
  allowAccessibility: true,
  allowAssembling: false,
};

beforeAll(() => {
  let workerPath = `file://${process.cwd()}/node_modules/pdfjs-dist/build/pdf.worker.mjs`;
  Object.defineProperty(GlobalWorkerOptions, 'workerSrc', {
    configurable: true,
    get: () => workerPath,
    set: (value: string) => {
      if (value.startsWith('file:') || value.startsWith('data:')) workerPath = value;
    },
  });
});

describe('probe', () => {
  it('learn', async () => {
    const plain = await plainFixture();
    const s = await openRender(plain, {});
    console.log('PLAIN reader text', JSON.stringify((await s.textItems(1)).map((i) => i.str)));
    await s.destroy();

    const protectedRun = await run('protect', PROTECTION_DEFAULTS);
    const locked = await bytesOf(protectedRun);
    console.log('PROTECT message:', protectedRun.message);
    console.log('PROTECT warnings:', JSON.stringify(protectedRun.warnings));
    let withPw = 'ERR';
    try {
      const d = await openRender(locked, { password: 'hunter2' });
      withPw = JSON.stringify((await d.textItems(1)).map((i) => i.str));
      await d.destroy();
    } catch (error) {
      withPw = `throw ${(error as Error).name}: ${(error as Error).message}`;
    }
    console.log('locked+pw reader:', withPw);
    let noPw = 'ERR';
    try {
      const d = await openRender(locked, {});
      noPw = JSON.stringify((await d.textItems(1)).map((i) => i.str));
      await d.destroy();
    } catch (error) {
      noPw = `throw ${(error as Error).name}: ${(error as Error).message}`;
    }
    console.log('locked no-pw reader:', noPw);

    const unlocked = await run('unlock', { password: 'hunter2' }, [pdfFile(locked, 'locked.pdf')]);
    console.log('UNLOCK message:', unlocked.message);
    console.log('UNLOCK warnings:', JSON.stringify(unlocked.warnings));
    const free = await bytesOf(unlocked);
    const d2 = await openRender(free, {});
    console.log('unlocked reader:', JSON.stringify((await d2.textItems(1)).map((i) => i.str)));
    await d2.destroy();
    console.log('unlocked raw has /Encrypt:', /\/Encrypt[\s\d]/.test(latin1.decode(free)));

    const meta = await run('remove-metadata', { info: true, xmp: true, attachments: true, readerSettings: true }, [pdfFile(plain, 'clean.pdf')]);
    const mbytes = await bytesOf(meta);
    const raw = latin1.decode(mbytes);
    console.log('REMOVE-META message:', meta.message);
    console.log('has /Info trailer key:', /\/Info\s+\d+\s+\d+\s+R/.test(raw), '| /Info dict marker:', /\/Producer/.test(raw));
    console.log('has /Metadata:', /\/Metadata\s+\d+\s+\d+\s+R/.test(raw));

    const edited = await run('edit-metadata', {
      title: 'New Title', author: 'N. Author', subject: '', keywords: 'a, b',
      creator: '', producer: '', docLanguage: 'en-GB', syncXmp: true, touchDates: true,
    }, [pdfFile(plain, 'clean.pdf')]);
    const ebytes = await bytesOf(edited);
    const edoc = await PDFDocument.load(ebytes);
    console.log('EDIT-META info:', JSON.stringify({
      title: edoc.getTitle(), author: edoc.getAuthor(), keywords: edoc.getKeywords(),
      creator: edoc.getCreator(), producer: edoc.getProducer(),
      creationDate: edoc.getCreationDate()?.toISOString?.(), modDate: edoc.getModDate()?.toISOString?.(),
      lang: (edoc.catalog.lookupMaybe as any)?.call(edoc.catalog.context, edoc.catalog.get((await import('@maxwbh/pdf-lib')).PDFName.of('Lang'))),
    }));
    console.log('EDIT-META message:', edited.message, JSON.stringify(edited.warnings));

    const attach = await run('add-attachments', {
      files: [{ name: 'enclosure.csv', mimeType: 'text/csv', bytes: new TextEncoder().encode('x,y\n1,2\n'), size: 8 }],
      description: 'note',
    }, [pdfFile(plain, 'clean.pdf')]);
    console.log('ADD-ATT message:', attach.message, JSON.stringify(attach.warnings));
    const abytes = await bytesOf(attach);
    console.log('attachment bytes present:', latin1.decode(abytes).includes('x,y'));
    const extr = await run('extract-attachments', {}, [pdfFile(abytes, 'with.pdf')]);
    console.log('EXTRACT outputs:', (extr as any).outputs.map((o: any) => o.name));
    console.log('EXTRACT text:', JSON.stringify(extr.report?.message ?? extr.message));
  }, 180_000);
});
