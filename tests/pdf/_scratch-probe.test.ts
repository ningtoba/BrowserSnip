import { appendFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts, degrees, rgb } from '@maxwbh/pdf-lib';
import { saveEncrypted } from '@/lib/pdf/core/doc';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { stripXmp, readXmp, writeXmp } from '@/lib/pdf/core/metadata';
import type { ToolValues } from '@/lib/pdf/tools/types';

const latin1 = new TextDecoder('latin1');

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

/** A rich document: form field, annotation, bookmark, attachment. */
async function rich(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Rich body text', { x: 60, y: 700, size: 14, font });
  const form = doc.getForm();
  const field = form.createTextField('applicant.name');
  field.setText('Ada Lovelace');
  const { addAnnotation } = await import('@/lib/pdf/core/annotations');
  addAnnotation(doc, { kind: 'Text', page: 0, rect: { x: 100, y: 500, width: 24, height: 24 }, contents: 'review me' });
  const { writeOutline } = await import('@/lib/pdf/core/bookmarks');
  writeOutline(doc, [{ title: 'Chapter one', page: 0 }]);
  const { addAttachments } = await import('@/lib/pdf/core/attachments');
  await addAttachments(doc, [{ name: 'source.csv', bytes: new TextEncoder().encode('a,b\n1,2\n'), mimeType: 'text/csv' }]);
  return doc.save({ useObjectStreams: false });
}

function NOTE(...args: unknown[]) {
  appendFileSync('/tmp/security-probe.log', args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
}

function toLocalBytes(bytes: Uint8Array): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes;
  const src = bytes as unknown as { length: number; [i: number]: number };
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i];
  return out;
}

describe('probe', () => {
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

  it('clearing trailerInfo.Encrypt saves a plaintext, structure-preserving file', async () => {
    const source = await rich();
    const locked = await saveEncrypted(await PDFDocument.load(source), {
      userPassword: 'gate', ownerPassword: 'owner-gate', version: 4,
    });
    const doc = await PDFDocument.load(locked, { password: 'gate', updateMetadata: false });
    const encRef = doc.context.trailerInfo.Encrypt;
    if (encRef instanceof PDFName || encRef instanceof (await import('@maxwbh/pdf-lib')).PDFRef) {
      doc.context.trailerInfo.Encrypt = undefined;
      // @ts-expect-error delete is fine on the record
      if (typeof (doc.context as { delete?: unknown }).delete === 'function') {
        (doc.context as unknown as { delete: (r: never) => void }).delete(encRef as never);
      }
    }
    const bytes = await doc.save({ useObjectStreams: false });
    const text = latin1.decode(bytes);
    NOTE('HAS /Encrypt in trailer:', /\/Encrypt[\s\d]/.test(latin1.decode(bytes.subarray(bytes.length - 4096))));
    const reopened = await PDFDocument.load(bytes);
    NOTE('pages:', reopened.getPageCount(), 'isEncrypted:', reopened.isEncrypted);
    NOTE('fields:', reopened.getForm().getFields().map((f) => f.getName()));
    NOTE('xmp-in-bytes /Chapter one:', /Chapter one/.test(text));
    NOTE('attachment source.csv:', /source\.csv/.test(text));
    const { listAttachments } = await import('@/lib/pdf/core/attachments');
    NOTE('attachment count:', listAttachments(reopened).length);
    const { readOutline } = await import('@/lib/pdf/core/bookmarks');
    NOTE('outline:', readOutline(reopened).map((n) => n.title));
    NOTE('annotation count:', text.match(/\/Subtype\s*\/Widget/g)?.length, text.match(/\/Annots/g)?.length);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('unlock on a permissions-only file', async () => {
    const locked = await run('protect', {
      mode: 'owner', userPassword: '', ownerPassword: 'owner-only', version: '4',
      allowPrinting: true, printLevel: 'high', allowModifying: true, allowCopying: false,
      allowAnnotating: true, allowFillingForms: true, allowAccessibility: true, allowAssembling: false,
    });
    const bytes = new Uint8Array(await locked.outputs[0].blob.arrayBuffer());
    let err = '';
    let ok = '';
    try {
      const out = await run('unlock', { password: '' }, [pdfFile(bytes, 'restricted.pdf')]);
      ok = out.message ?? '';
    } catch (error) {
      err = `${(error as { code?: string }).code} ${(error as Error).message}`;
    }
    NOTE('UNLOCK-RESTRICTED ok:', ok, 'err:', err);
    expect(true).toBe(true);
  });

  it('change-permissions honours printLevel low?', async () => {
    const out = await run('change-permissions', {
      action: 'set', ownerPassword: 'owner', version: '4', printLevel: 'low',
      allowPrinting: true, allowModifying: true, allowCopying: true, allowAnnotating: true,
      allowFillingForms: true, allowAccessibility: true, allowAssembling: false,
    });
    const bytes = new Uint8Array(await out.outputs[0].blob.arrayBuffer());
    const { inspectPdf } = await import('@/lib/pdf/core/guard');
    const gate = await inspectPdf(bytes, 'o.pdf');
    NOTE('PERMS:', JSON.stringify(gate.permissions));
    NOTE('MSG:', out.message);
    expect(true).toBe(true);
  });

  it('inline /Metadata survives stripXmp?', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const ctx = doc.context;
    const stream = ctx.stream(toLocalBytes(new TextEncoder().encode('<?xpacket begin="?"><x:xmpmeta>InlineMarker</x:xmpmeta><?xpacket end="w"?>')), {
      Type: 'Metadata', Subtype: 'XML',
    });
    doc.catalog.set(PDFName.of('Metadata'), stream);
    const stripped = stripXmp(doc);
    NOTE('stripXmp(inline) =', stripped, 'readXmp:', readXmp(doc)?.raw?.slice(0, 40));
    const bytes = await doc.save({ useObjectStreams: false });
    NOTE('InlineMarker still in bytes:', latin1.decode(bytes).includes('InlineMarker'));
    expect(true).toBe(true);
  });

  it('add-attachments count semantics', async () => {
    const source = await rich();
    const outcome = await run('add-attachments', {
      files: [
        { name: 'notes.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('hello'), size: 5 },
        { name: 'source.csv', mimeType: 'text/csv', bytes: new TextEncoder().encode('x,y\n3,4\n'), size: 6 },
      ],
      description: '',
    }, [pdfFile(source, 'with-one.pdf')]);
    NOTE('ADD MSG:', outcome.message, 'WARN:', outcome.warnings);
    expect(true).toBe(true);
  });

  it('protect mode user: owner password == user password?', async () => {
    const out = await run('protect', {
      mode: 'user', userPassword: 'hunter2', ownerPassword: '', version: '5',
      allowPrinting: true, printLevel: 'high', allowModifying: false, allowCopying: false,
      allowAnnotating: false, allowFillingForms: false, allowAccessibility: true, allowAssembling: false,
    });
    const bytes = new Uint8Array(await out.outputs[0].blob.arrayBuffer());
    // Owner password 'hunter2' should unlock restrictions: try loading with it.
    const viaUser = await PDFDocument.load(bytes, { password: 'hunter2' }).then(() => 'ok').catch((e) => String(e));
    NOTE('PROTECT-USER msg:', out.message);
    NOTE('PROTECT-USER warnings:', out.warnings);
    NOTE('load with hunter2:', viaUser);
    expect(true).toBe(true);
  });

  it('redaction on embedded CID text + rotated page', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const { drawTextU } = await import('@/lib/pdf/core/fonts');
    await drawTextU(page, { text: 'Confidential Zebraquota amount', x: 60, y: 700, size: 18 });
    doc.insertPage(1, [595, 842]);
    const rotated = doc.getPage(1);
    rotated.setRotation(degrees(90));
    await drawTextU(rotated, { text: 'RotatedSecretWord', x: 60, y: 700, size: 18 });
    const bytes = await doc.save({ useObjectStreams: false });

    const { openRender } = await import('@/lib/pdf/core/render');
    const session = await openRender(bytes);
    const p1 = (await session.textItems(1)).map((i) => i.str).join('|');
    const p2 = (await session.textItems(2)).map((i) => i.str).join('|');
    NOTE('BEFORE p1:', p1);
    NOTE('BEFORE p2:', p2);
    await session.destroy();

    const out = await run('redact-pdf', {
      fill: '#000000', alsoMetadata: false,
      regions: [
        { page: 0, x: 40, y: 690, width: 320, height: 24 },
        { page: 1, x: 40, y: 690, width: 320, height: 24 },
      ],
    }, [pdfFile(bytes, 'cid.pdf')]);
    NOTE('REDACT MSG:', out.message, out.warnings);
    const after = new Uint8Array(await out.outputs[0].blob.arrayBuffer());
    const s2 = await openRender(after);
    NOTE('AFTER p1:', (await s2.textItems(1)).map((i) => i.str).join('|'));
    NOTE('AFTER p2:', (await s2.textItems(2)).map((i) => i.str).join('|'));
    await s2.destroy();
    expect(true).toBe(true);
  });

  it('flatten leaves orphan widget live?', async () => {
    const doc = await PDFDocument.load(await rich());
    // Add a widget annotation that is NOT registered in AcroForm /Fields.
    const page = doc.getPage(0);
    const widget = doc.context.register(doc.context.obj({
      Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: 'OrphanSig',
      Rect: [300, 600, 500, 660],
    }));
    const annots = page.node.get(PDFName.of('Annots'));
    const list = annots instanceof PDFRawStream ? null : (annots as unknown as { push: (r: unknown) => void });
    list?.push(widget);
    const source = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
    const out = await run('flatten-pdf', { forms: true, annotations: true, keepLinks: true, dpi: 200 }, [pdfFile(source, 'orphan.pdf')]);
    NOTE('FLATTEN MSG:', out.message);
    NOTE('FLATTEN WARN:', out.warnings);
    const bytes = new Uint8Array(await out.outputs[0].blob.arrayBuffer());
    const re = await PDFDocument.load(bytes);
    NOTE('fields after:', re.getForm().getFields().map((f) => f.getName()));
    NOTE('widget annots after:', latin1.decode(bytes).match(/\/Subtype\s*\/Widget/g)?.length);
    NOTE('any annots:', re.getPages().map((p) => p.node.get(PDFName.of('Annots'))?.toString()));
    expect(true).toBe(true);
  });
});
