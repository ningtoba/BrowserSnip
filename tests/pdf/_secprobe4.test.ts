import { beforeAll, describe, expect, it } from 'vitest';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts, rgb, degrees } from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { openRender } from '@/lib/pdf/core/render';
import { inspectPdf } from '@/lib/pdf/core/guard';
import { readXmp, readInfo, writeXmp, writeInfo, toLocalBytes } from '@/lib/pdf/core/metadata';
import { listAttachments } from '@/lib/pdf/core/attachments';
import { annotationCount } from '@/lib/pdf/core/annotations';
import { readOutline } from '@/lib/pdf/core/bookmarks';
import { readZip } from '@/lib/pdf/core/archive';
import type { PdfToolDefinition, ToolValues } from '@/lib/pdf/tools/types';

const latin1 = new TextDecoder('latin1');

async function fixture(pages = 2, rotate = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Secret Alice ${index + 1} Bob`, { x: 60, y: 700, size: 18, font, color: rgb(0, 0, 0) });
    if (rotate) page.setRotation(degrees(rotate));
  }
  return doc.save({ useObjectStreams: false });
}
function pdfFile(bytes: Uint8Array, name: string): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}
async function run(id: string, values: ToolValues = {}, files?: File[], password?: string) {
  const tool = getPdfTool(id) as PdfToolDefinition | undefined;
  expect(tool, `tool "${id}"`).toBeTruthy();
  const inputs = files ?? [pdfFile(await fixture(), 'fixture.pdf')];
  return (await runPdfTool({ toolId: id, files: inputs, values, password, onProgress: () => {}, onLog: () => {} })) as unknown as {
    outputs: { blob: Blob; name: string }[]; message?: string; warnings: string[];
    report?: { sections: { title: string; rows?: { label: string; value: string }[] }[]; message?: string };
  };
}
async function bytesOf(o: { outputs: { blob: Blob }[] }, i = 0) {
  return new Uint8Array(await o.outputs[i].blob.arrayBuffer());
}
const log = (label: string, value: unknown) => process.stderr.write(`\n[${label}] ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

const BASE: ToolValues = {
  version: '4', allowPrinting: false, printLevel: 'low', allowModifying: false, allowCopying: false,
  allowAnnotating: false, allowFillingForms: false, allowAccessibility: true, allowAssembling: false,
};

beforeAll(() => {
  let p = `file://${process.cwd()}/node_modules/pdfjs-dist/build/pdf.worker.mjs`;
  Object.defineProperty(GlobalWorkerOptions, 'workerSrc', {
    configurable: true, get: () => p,
    set: (v: string) => { if (v.startsWith('file:') || v.startsWith('data:')) p = v; },
  });
});

describe('probe3', () => {
  it('facts', async () => {
    // 1. permissions-only: does a bare load (no password option) work?
    const ownerOnly = await bytesOf(await run('protect', { ...BASE, mode: 'owner', userPassword: '', ownerPassword: 'owner-only' }));
    let bare = 'resolves';
    try { await PDFDocument.load(ownerOnly); } catch (e) { bare = `throws ${(e as Error).name}: ${(e as Error).message}`; }
    log('bare load of permissions-only', bare);
    const oi = await inspectPdf(ownerOnly, 'o.pdf');
    log('guard permissions-only', { e: oi.encrypted, np: oi.needsPassword, oep: oi.opensWithEmptyPassword, p: oi.permissions });

    // 4. unlock with no password at all
    const unlocked = await run('unlock', {}, [pdfFile(ownerOnly, 'owner.pdf')]);
    log('unlock(no password) on permissions-only', `${unlocked.message} :: ${JSON.stringify(unlocked.warnings)}`);
    const ub = await bytesOf(unlocked);
    log('unlocked raw /Encrypt', /\/Encrypt/.test(latin1.decode(ub)));

    // 2. inlined /Metadata
    const doc = await PDFDocument.load(await fixture(1));
    const ctx = doc.context;
    const packet = `<?xpacket begin="\uFEFF"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999-02-22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">Inline Title</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta>`;
    const inlined = ctx.stream(toLocalBytes(new TextEncoder().encode(packet)), { Type: 'Metadata', Subtype: 'XML' });
    doc.catalog.set(PDFName.of('Metadata'), inlined);
    doc.setTitle('Info Title');
    const inlineBytes = await doc.save({ useObjectStreams: false });
    const reload = await PDFDocument.load(inlineBytes);
    log('inlined xmp visible to readXmp', JSON.stringify(readXmp(reload)?.title));
    const stripped = await run('remove-metadata', { info: true, xmp: true, attachments: true, readerSettings: true }, [pdfFile(inlineBytes, 'inline.pdf')]);
    log('remove-metadata (inlined)', `${stripped.message} :: ${JSON.stringify(stripped.warnings)}`);
    const sbytes = await bytesOf(stripped);
    log('inlined xmp after strip: xmpmeta in bytes', latin1.decode(sbytes).includes('x:xmpmeta'));
    log('Info Title after strip', latin1.decode(sbytes).includes('I.n.f.o') || /\/Title/.test(latin1.decode(sbytes)));
    const reReload = await PDFDocument.load(sbytes);
    log('readXmp/readInfo after strip', JSON.stringify({ xmp: readXmp(reReload), title: readInfo(reReload).title, producer: readInfo(reReload).producer }));

    // 3. rotated page redaction
    const rotated = await fixture(1, 90);
    const red = await run('redact-pdf', { fill: '#000000', alsoMetadata: false, regions: [{ page: 0, x: 660, y: 45, width: 240, height: 30 }] }, [pdfFile(rotated, 'rot.pdf')]);
    log('redact rotated', `${red.message} :: ${JSON.stringify(red.warnings)}`);
    const rbytes = await bytesOf(red);
    const rdoc = await PDFDocument.load(rbytes, { ignoreEncryption: true });
    let rtext = '';
    for (const [, o] of rdoc.context.enumerateIndirectObjects()) {
      if (!(o instanceof PDFRawStream)) continue;
      try {
        rtext += latin1.decode((await import('node:zlib')).inflateSync(Buffer.from(o.getContents())));
      } catch {
        rtext += '(not flate)';
      }
    }
    log('rotated redaction stream text', JSON.stringify(rtext.slice(0, 300)));

    // 5. edit-metadata
    const src = await fixture(1);
    const seed = await PDFDocument.load(src);
    writeXmp(seed, `<?xpacket begin="\uFEFF"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999-02-22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description></rdf:RDF></x:xmpmeta>`);
    seed.setTitle('Old');
    writeInfo(seed, { creationDate: "D:20010203040506Z", modDate: "D:20010203040506+00'00'" });
    const seeded = await seed.save({ useObjectStreams: false });
    const edited = await run('edit-metadata', {
      title: 'New Title', author: 'A. Author', subject: '', keywords: 'k1, k2', creator: 'Creo', producer: 'Prod', docLanguage: 'en-GB', syncXmp: true, touchDates: true,
    }, [pdfFile(seeded, 'seed.pdf')]);
    const ebytes = await bytesOf(edited);
    const edoc = await PDFDocument.load(ebytes);
    const einfo = readInfo(edoc);
    log('edit-metadata info', { ...einfo, trapped: undefined });
    log('edit-metadata xmp', readXmp(edoc)?.raw?.slice(0, 800));
    log('edit-metadata message', `${edited.message} :: ${JSON.stringify(edited.warnings)}`);
    const edRaw = latin1.decode(ebytes);
    log('lang in bytes', /\/Lang/.test(edRaw));

    // 6. round trip with distinct passwords through the tools
    const full = await PDFDocument.load(await fixture(2));
    const form = full.getForm();
    form.createTextField('applicant.name');
    form.createCheckBox('agree');
    const { addAnnotation } = await import('@/lib/pdf/core/annotations');
    addAnnotation(full, { kind: 'Text', page: 0, rect: { x: 100, y: 500, width: 24, height: 24 }, contents: 'review me' });
    const { writeOutline } = await import('@/lib/pdf/core/bookmarks');
    writeOutline(full, [{ title: 'Chapter one', page: 0 }]);
    const { addAttachments } = await import('@/lib/pdf/core/attachments');
    await addAttachments(full, [{ name: 'source.csv', bytes: new TextEncoder().encode('a,b\n1,2\n'), mimeType: 'text/csv' }]);
    const rich = await full.save({ useObjectStreams: false });
    const protectedRun = await run('protect', { ...BASE, mode: 'both', userPassword: 'open-pw', ownerPassword: 'owner-pw' }, [pdfFile(rich, 'rich.pdf')]);
    const pwb = await bytesOf(protectedRun);
    const withPw = await inspectPdf(pwb, 'p.pdf', { password: 'open-pw' });
    log('protect(both) read back', { pages: withPw.pages, accepted: withPw.passwordAccepted, e: withPw.encrypted, msg: protectedRun.message, warn: protectedRun.warnings });
    const back = await run('unlock', { password: 'open-pw' }, [pdfFile(pwb, 'p.pdf')]);
    log('unlock round trip', `${back.message} :: ${JSON.stringify(back.warnings)}`);
    const bbytes = await bytesOf(back);
    const bdoc = await PDFDocument.load(bbytes);
    log('round trip structure', {
      pages: bdoc.getPageCount(),
      fields: bdoc.getForm().getFields().map((f) => f.getName()),
      annots: annotationCount(bdoc),
      bookmarks: readOutline(bdoc).map((n) => n.title),
      attachments: listAttachments(bdoc).map((a) => a.name),
    });
    const ra = await openRender(rich, {}); const ta = (await ra.textItems(1)).map((i) => i.str).join('|'); await ra.destroy();
    const rb = await openRender(bbytes, {}); const tb = (await rb.textItems(1)).map((i) => i.str).join('|'); await rb.destroy();
    log('round trip text', `source=${JSON.stringify(ta)} output=${JSON.stringify(tb)} equal=${ta === tb}`);

    // 8/9/10 attachments
    const attached = await run('add-attachments', {
      files: [
        { name: 'one.csv', mimeType: 'text/csv', bytes: new TextEncoder().encode('x,y\n1,2\n'), size: 8 },
        { name: 'two.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('second'), size: 6 },
      ],
      description: 'note',
    });
    log('add-attachments', `${attached.message} :: ${JSON.stringify(attached.warnings)}`);
    const ab = await bytesOf(attached);
    const adoc = await PDFDocument.load(ab);
    log('attachments in bytes', JSON.stringify(listAttachments(adoc).map((a) => ({ n: a.name, s: a.size, d: a.description, bytes: latin1.decode(a.bytes) }))));
    const session = await openRender(ab, {});
    log('pdf.js attachments', JSON.stringify(Object.entries(await session.attachments()).map(([k, v]) => [k, latin1.decode(v as Uint8Array)])));
    await session.destroy();
    const one = await run('extract-attachments', {}, [pdfFile(attached.outputs.length ? await bytesOf(attached, 0) : ab, 'a.pdf')]);
    log('extract two', JSON.stringify({ names: one.outputs.map((o) => o.name), msg: one.message ?? one.report?.message }));
    if (one.outputs[0].name.endsWith('.zip')) {
      log('zip entries', JSON.stringify((await readZip(one.outputs[0].blob)).map((z) => [z.name, latin1.decode(z.data)])));
    }
    const single = await run('extract-attachments', {}, [pdfFile(await bytesOf(await run('add-attachments', { files: [{ name: 'solo.csv', mimeType: 'text/csv', bytes: new TextEncoder().encode('s,oLO'), size: 5 }] }), 'one.pdf'), 'one.pdf')]);
    log('extract one', JSON.stringify({ names: single.outputs.map((o) => o.name), msg: single.message ?? single.report?.message }));
    const removed = await run('edit-attachments', { remove: 'one.csv' }, [pdfFile(ab, 'a.pdf')]);
    log('edit-attachments', `${removed.message} :: ${JSON.stringify(removed.warnings)}`);
    const rm = await PDFDocument.load(await bytesOf(removed));
    log('attachments after removal', JSON.stringify(listAttachments(rm).map((a) => ({ n: a.name, v: latin1.decode(a.bytes) }))));
  }, 300_000);
});
