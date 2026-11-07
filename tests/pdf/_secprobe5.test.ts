import { beforeAll, describe, expect, it } from 'vitest';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { inspectPdf } from '@/lib/pdf/core/guard';
import { readInfo, writeInfo, writeXmp } from '@/lib/pdf/core/metadata';
import { listAttachments } from '@/lib/pdf/core/attachments';
import type { PdfToolDefinition, ToolValues } from '@/lib/pdf/tools/types';

const latin1 = new TextDecoder('latin1');
const log = (label: string, value: unknown) => process.stderr.write(`\n[${label}] ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

async function richFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 3; index++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Secret Alice ${index + 1} Bravo`, { x: 60, y: 700, size: 18, font, color: rgb(0, 0, 0) });
  }
  const form = doc.getForm();
  const field = form.createTextField('applicant.name');
  field.setText('Ada Lovelace');
  form.createCheckBox('agree').check();
  const { addAnnotation } = await import('@/lib/pdf/core/annotations');
  addAnnotation(doc, { kind: 'Text', page: 0, rect: { x: 100, y: 500, width: 24, height: 24 }, contents: 'review me' });
  const { writeOutline } = await import('@/lib/pdf/core/bookmarks');
  writeOutline(doc, [{ title: 'Chapter Bravo one', page: 0 }]);
  const { addAttachments } = await import('@/lib/pdf/core/attachments');
  await addAttachments(doc, [{ name: 'source.csv', bytes: new TextEncoder().encode('a,b\n1,2\n'), mimeType: 'text/csv' }]);
  writeInfo(doc, { title: 'Secret Alice', author: 'Ada Lovelace', keywords: 'Alice, Bravo', subject: 'Bravo notes' });
  writeXmp(doc, `<?xpacket begin="\uFEFF"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999-02-22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Secret Alice</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta>`);
  return doc.save({ useObjectStreams: false });
}
function pdfFile(bytes: Uint8Array, name: string): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}
async function run(id: string, values: ToolValues = {}, files?: File[], password?: string) {
  const tool = getPdfTool(id) as PdfToolDefinition | undefined;
  expect(tool, `tool "${id}"`).toBeTruthy();
  return (await runPdfTool({ toolId: id, files: files ?? [pdfFile(await richFixture(), 'fixture.pdf')], values, password, onProgress: () => {}, onLog: () => {} })) as unknown as {
    outputs: { blob: Blob; name: string }[]; message?: string; warnings: string[];
    report?: { sections: { title: string; rows?: { label: string; value: string }[] }[]; message?: string };
  };
}
async function bytesOf(o: { outputs: { blob: Blob }[] }, i = 0) {
  return new Uint8Array(await o.outputs[i].blob.arrayBuffer());
}

beforeAll(() => {
  let p = `file://${process.cwd()}/node_modules/pdfjs-dist/build/pdf.worker.mjs`;
  Object.defineProperty(GlobalWorkerOptions, 'workerSrc', {
    configurable: true, get: () => p,
    set: (v: string) => { if (v.startsWith('file:') || v.startsWith('data:')) p = v; },
  });
});

describe('probe5', () => {
  it('facts', async () => {
    const rich = await richFixture();

    // redaction read-back wording, unrotated
    const red = await run('redact-pdf', { fill: '#000000', alsoMetadata: false, regions: [{ page: 0, x: 55, y: 120, width: 260, height: 30 }] }, [pdfFile(rich, 'r.pdf')]);
    log('redact msg', `${red.message} :: ${JSON.stringify(red.warnings)}`);
    const rr = await PDFDocument.load(await bytesOf(red), { ignoreEncryption: true, updateMetadata: false });
    let all = '';
    for (const [, o] of rr.context.enumerateIndirectObjects()) {
      if (o instanceof PDFRawStream) {
        try { all += latin1.decode((await import('node:zlib')).inflateSync(Buffer.from(o.getContents()))); } catch { all += '(raw)'; }
      }
    }
    log('redacted streams contain Bravo?', JSON.stringify(all.includes('Bravo') || all.includes('427261766f')));
    log('redacted info', JSON.stringify(readInfo(rr)));

    // redaction with alsoMetadata on
    const red2 = await run('redact-pdf', { fill: '#000000', alsoMetadata: true, regions: [{ page: 0, x: 55, y: 120, width: 260, height: 30 }] }, [pdfFile(rich, 'r.pdf')]);
    log('redact+meta', `${red2.message} :: ${JSON.stringify(red2.warnings)}`);
    const rr2 = await PDFDocument.load(await bytesOf(red2), { ignoreEncryption: true, updateMetadata: false });
    log('redact+meta info', JSON.stringify(readInfo(rr2)));

    // flatten with annotations on (no canvas in jsdom)
    const flat = await run('flatten-pdf', { forms: true, annotations: true, keepLinks: true, dpi: 96 }, [pdfFile(rich, 'r.pdf')]);
    log('flatten ann on', `${flat.message} :: ${JSON.stringify(flat.warnings)}`);
    const fd = await PDFDocument.load(await bytesOf(flat), { ignoreEncryption: true, updateMetadata: false });
    log('flatten fields left', JSON.stringify({ fields: fd.getForm().getFields().map((f) => f.getName()), marks: fd.getPages().map((p) => (p.node.get(PDFName.of('Annots')) ? 1 : 0)) }));

    // does an unrelated op keep a permissions-only file protected?
    const ownerOnly = await bytesOf(await run('protect', {
      mode: 'owner', userPassword: '', ownerPassword: 'owner-only', version: '4',
      allowPrinting: false, printLevel: 'low', allowModifying: false, allowCopying: false, allowAnnotating: false, allowFillingForms: false, allowAccessibility: true, allowAssembling: false,
    }, [pdfFile(rich, 'r.pdf')]));
    const edited = await run('edit-metadata', { title: 'Renamed', syncXmp: false, touchDates: true }, [pdfFile(ownerOnly, 'locked.pdf')]);
    const eb = await bytesOf(edited);
    const ei = await inspectPdf(eb, 'out.pdf');
    log('edit-metadata on permissions-only', `${edited.message} :: ${JSON.stringify(edited.warnings)} :: e=${ei.encrypted} oep=${ei.opensWithEmptyPassword} pages=${ei.pages}`);
    const noPw = await inspectPdf(ownerOnly, 'locked.pdf');
    log('guard on permissions-only', `e=${noPw.encrypted} np=${noPw.needsPassword} oep=${noPw.opensWithEmptyPassword} perms=${JSON.stringify(noPw.permissions)}`);
    const rawP = /\/P\s+(-?\d+)/.exec(latin1.decode(ownerOnly));
    log('raw /P', String(rawP?.[1]));

    // view-metadata rows for the permissions-only file (post-fix check happens later)
    const view = await run('view-metadata', {}, [pdfFile(ownerOnly, 'locked.pdf')]);
    log('view rows', JSON.stringify(view.report?.sections.find((s) => s.title === 'Protection')?.rows));
    log('view fonts', JSON.stringify(view.report?.sections.find((s) => s.title === 'Fonts')?.rows));

    // attachments: replace + remove, and the messages
    const added2 = await run('add-attachments', {
      files: [{ name: 'source.csv', mimeType: 'text/csv', bytes: new TextEncoder().encode('replaced\n'), size: 9 }],
      description: '',
    }, [pdfFile(rich, 'r.pdf')]);
    log('add replace', `${added2.message} :: ${JSON.stringify(added2.warnings)}`);
    const one = await run('extract-attachments', {}, [pdfFile(rich, 'r.pdf')]);
    log('extract one', JSON.stringify({ names: one.outputs.map((o) => o.name), msg: one.message ?? one.report?.message }));
    const oneBytes = await one.outputs[0].blob.arrayBuffer();
    log('extract one content', JSON.stringify(latin1.decode(new Uint8Array(oneBytes))));
    const cut = await run('edit-attachments', { remove: 'source.csv' }, [pdfFile(rich, 'r.pdf')]);
    const cd = await PDFDocument.load(await bytesOf(cut), { ignoreEncryption: true, updateMetadata: false });
    log('edit-attachments', `${cut.message} :: ${JSON.stringify(cut.warnings)} :: left=${JSON.stringify(listAttachments(cd).map((a) => a.name))}`);
  }, 300_000);
});
