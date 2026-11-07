import { appendFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { PDFDocument, PDFName, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { openRender } from '@/lib/pdf/core/render';
import { listAttachments } from '@/lib/pdf/core/attachments';
import type { ToolValues } from '@/lib/pdf/tools/types';

function NOTE(...args: unknown[]) {
  appendFileSync('/tmp/security-probe2.log', args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
}

function pdfFile(bytes: Uint8Array, name: string): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}

async function run(id: string, values: ToolValues = {}, files?: File[], password?: string) {
  const tool = getPdfTool(id)!;
  const inputs = files ?? [pdfFile(await plain(), 'fixture.pdf')];
  return runPdfTool({ toolId: id, files: inputs, values, password, onProgress: () => {}, onLog: () => {} });
}

async function plain(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Ordinary page ${i + 1}`, { x: 60, y: 700, size: 18, font, color: rgb(0, 0, 0) });
  }
  return doc.save({ useObjectStreams: false });
}

async function annotated(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Annotated body', { x: 60, y: 700, size: 14, font, color: rgb(0, 0, 0) });
  const { addAnnotation } = await import('@/lib/pdf/core/annotations');
  addAnnotation(doc, { kind: 'Highlight', page: 0, rect: { x: 60, y: 690, width: 200, height: 18 }, quadPoints: [{ x: 60, y: 690, width: 200, height: 18 }] });
  addAnnotation(doc, { kind: 'Text', page: 0, rect: { x: 300, y: 600, width: 20, height: 20 }, contents: 'note body' });
  return doc.save({ useObjectStreams: false });
}

async function extract(bytes: Uint8Array, password?: string): Promise<string[]> {
  const session = await openRender(bytes, password ? { password } : {});
  try {
    const out: string[] = [];
    for (let page = 1; page <= session.numPages; page++) {
      out.push((await session.textItems(page)).map((i) => i.str).join('|'));
    }
    return out;
  } finally {
    await session.destroy();
  }
}

const PROTECT: ToolValues = {
  mode: 'user', userPassword: 'hunter2', ownerPassword: '', version: '4',
  allowPrinting: true, printLevel: 'high', allowModifying: true, allowCopying: true,
  allowAnnotating: true, allowFillingForms: true, allowAccessibility: true, allowAssembling: false,
};

describe('probe2', () => {
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

  it('pdf.js view of a protected file', async () => {
    const source = await plain();
    NOTE('BEFORE', await extract(source));
    const out = await run('protect', PROTECT);
    const bytes = new Uint8Array(await out.outputs[0].blob.arrayBuffer());
    NOTE('PROTECT msg', out.message, '| warnings', out.warnings);
    let withPassword: unknown;
    try { withPassword = await extract(bytes, 'hunter2'); } catch (e) { withPassword = `THROWS ${(e as Error).message}`; }
    NOTE('AFTER-PROTECT pdf.js(hunter2)', withPassword);
    let noPassword: unknown;
    try { noPassword = await extract(bytes); } catch (e) { noPassword = `THROWS ${(e as Error).message}`; }
    NOTE('AFTER-PROTECT pdf.js(none)', noPassword);

    const back = await run('unlock', { password: 'hunter2' }, [pdfFile(bytes, 'locked.pdf')]);
    const unlocked = new Uint8Array(await back.outputs[0].blob.arrayBuffer());
    NOTE('UNLOCK msg', back.message, '| warnings', back.warnings);
    NOTE('AFTER-UNLOCK pdf.js', await extract(unlocked));
  });

  it('flatten with annotations on (own app annotation)', async () => {
    const source = await annotated();
    let outcome: Awaited<ReturnType<typeof run>> | null = null;
    let failure = '';
    try {
      outcome = await run('flatten-pdf', { forms: true, annotations: true, keepLinks: true, dpi: 200 }, [pdfFile(source, 'notes.pdf')]);
    } catch (error) {
      failure = `${(error as Error).name}: ${(error as Error).message}`;
    }
    NOTE('FLATTEN failure:', failure || 'none');
    if (outcome) NOTE('FLATTEN msg:', outcome.message, '| warnings:', outcome.warnings);
    expect(true).toBe(true);
  });

  it('add-attachments count when the document already has some', async () => {
    const doc = await PDFDocument.load(await plain(1));
    const { addAttachments } = await import('@/lib/pdf/core/attachments');
    await addAttachments(doc, [{ name: 'already.pdf', bytes: new TextEncoder().encode('old'), mimeType: 'application/pdf' }]);
    const source = await doc.save({ useObjectStreams: false });
    const outcome = await run('add-attachments', {
      files: [{ name: 'new-note.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('fresh'), size: 5 }],
      description: '',
    }, [pdfFile(source, 'has-one.pdf')]);
    const bytes = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
    const reopened = await PDFDocument.load(bytes);
    NOTE('ADD msg:', outcome.message, '| warnings:', outcome.warnings);
    NOTE('ADD names in output:', listAttachments(reopened).map((a) => `${a.name}:${new TextDecoder().decode(a.bytes)}`));
    // duplicate names inside one run
    const dup = await run('add-attachments', {
      files: [
        { name: 'same.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('one'), size: 3 },
        { name: 'same.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('two'), size: 3 },
      ],
      description: '',
    }, [pdfFile(source, 'has-one.pdf')]);
    const dupBytes = new Uint8Array(await dup.outputs[0].blob.arrayBuffer());
    NOTE('DUP msg:', dup.message, '| names:', listAttachments(await PDFDocument.load(dupBytes)).map((a) => a.name));
    // empty attachment
    let emptyMsg = '';
    try {
      const empty = await run('add-attachments', {
        files: [{ name: 'zero.bin', mimeType: 'application/octet-stream', bytes: new Uint8Array(0), size: 0 }],
        description: '',
      }, [pdfFile(source, 'has-one.pdf')]);
      emptyMsg = empty.message ?? '';
    } catch (error) {
      emptyMsg = `THROWS ${(error as Error).message}`;
    }
    NOTE('ZERO-BYTE attachment:', emptyMsg);
    expect(true).toBe(true);
  });

  it('remove-metadata byte truth', async () => {
    const doc = await PDFDocument.load(await plain(1));
    doc.setTitle('Secret Title');
    doc.setAuthor('Ada');
    const { writeXmp } = await import('@/lib/pdf/core/metadata');
    writeXmp(doc, '<?xpacket begin="\uFEFF" id="w"><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Secret Title</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>');
    doc.catalog.set(PDFName.of('PageMode'), PDFName.of('FullScreen'));
    const source = await doc.save({ useObjectStreams: false });
    const outcome = await run('remove-metadata', { info: true, xmp: true, attachments: false, readerSettings: true }, [pdfFile(source, 'doc.pdf')]);
    const bytes = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
    const reopened = await PDFDocument.load(bytes, { updateMetadata: false });
    const { readInfo, readXmp } = await import('@/lib/pdf/core/metadata');
    NOTE('RM msg:', outcome.message);
    NOTE('RM info after:', readInfo(reopened));
    NOTE('RM xmp after:', readXmp(reopened)?.raw?.slice(0, 60));
    NOTE('RM pageMode after:', String(reopened.catalog.get(PDFName.of('PageMode'))));
    expect(true).toBe(true);
  });
});
