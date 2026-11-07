import { beforeAll, describe, expect, it } from 'vitest';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { PDFDocument, PDFDict, PDFName, StandardFonts, rgb, degrees } from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { openRender } from '@/lib/pdf/core/render';
import type { PdfToolDefinition, ToolValues } from '@/lib/pdf/tools/types';

const latin1 = new TextDecoder('latin1');
const log = (label: string, value: unknown) => process.stderr.write(`\n[${label}] ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

async function textFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 3; index++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Secret Alice 42 Bravo on page ${index + 1}`, { x: 60, y: 700, size: 18, font, color: rgb(0, 0, 0) });
    if (index === 2) page.setRotation(degrees(90));
  }
  return doc.save({ useObjectStreams: false });
}
function pdfFile(bytes: Uint8Array, name: string): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}
async function run(id: string, values: ToolValues = {}, files?: File[], password?: string) {
  const tool = getPdfTool(id) as PdfToolDefinition | undefined;
  expect(tool, `tool "${id}"`).toBeTruthy();
  return (await runPdfTool({ toolId: id, files: files ?? [pdfFile(await textFixture(), 'f.pdf')], values, password, onProgress: () => {}, onLog: () => {} })) as unknown as {
    outputs: { blob: Blob }[]; message?: string; warnings: string[];
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

describe('probe7', () => {
  it('facts', async () => {
    const plain = await textFixture();
    for (const version of ['5', '4', '2', '1']) {
      const bytes = await bytesOf(await run('protect', {
        mode: 'both', userPassword: 'open-sesame', ownerPassword: 'owner-key', version,
        allowPrinting: false, printLevel: 'low', allowModifying: false, allowCopying: false,
        allowAnnotating: false, allowFillingForms: false, allowAccessibility: true, allowAssembling: false,
      }));
      const raw = latin1.decode(bytes);
      const start = raw.lastIndexOf('/Filter /Standard');
      log(`encrypt dict v${version}`, JSON.stringify(raw.slice(Math.max(0, start - 60), start + 460).replace(/\n/g, ' ')));
    }

    // checkbox state in the source
    const rich = await PDFDocument.create();
    rich.addPage([595, 842]);
    const f = rich.getForm();
    f.createTextField('applicant.name').setText('Ada Lovelace');
    f.createCheckBox('agree').check();
    const richBytes = await rich.save({ useObjectStreams: false });
    const reloaded = await PDFDocument.load(richBytes, { updateMetadata: false });
    const box = reloaded.getForm().getField('agree') as { isChecked?: () => boolean };
    log('checkbox in source', `checked=${String(box.isChecked?.())}`);
    log('raw /V in source', /\/V\s*\/[\w.]+/.test(latin1.decode(richBytes)));

    // redaction survivors
    const straight = await run('redact-pdf', {
      fill: '#000000', alsoMetadata: false, regions: [{ page: 0, x: 55, y: 118, width: 260, height: 34 }],
    }, [pdfFile(plain, 'f.pdf')]);
    log('straight narrow', `${straight.message} :: ${JSON.stringify(straight.warnings)}`);
    const wide = await run('redact-pdf', {
      fill: '#000000', alsoMetadata: false, regions: [{ page: 0, x: 40, y: 110, width: 340, height: 44 }],
    }, [pdfFile(plain, 'f.pdf')]);
    log('straight wide', `${wide.message} :: ${JSON.stringify(wide.warnings)}`);
    const turned = await run('redact-pdf', {
      fill: '#000000', alsoMetadata: false, regions: [{ page: 2, x: 685, y: 50, width: 60, height: 240 }],
    }, [pdfFile(plain, 'f.pdf')]);
    log('turned', `${turned.message} :: ${JSON.stringify(turned.warnings)}`);
    const session = await openRender(plain, {});
    const items = await session.textItems(3);
    await session.destroy();
    log('page3 items', JSON.stringify(items.map((i) => ({ str: i.str, x: Math.round(i.x), y: Math.round(i.y), w: Math.round(i.w), h: Math.round(i.h) }))));
  }, 300_000);
});

type PDFRef2 = { asBytes?: () => Uint8Array };
