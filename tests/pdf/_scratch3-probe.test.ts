import { appendFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { PDFDocument, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { openRender } from '@/lib/pdf/core/render';
import type { ToolValues } from '@/lib/pdf/tools/types';

function NOTE(...args: unknown[]) {
  appendFileSync('/tmp/security-probe3.log', args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
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
async function extract(bytes: Uint8Array, password?: string): Promise<string> {
  const session = await openRender(bytes, password ? { password } : {});
  try {
    return (await session.textItems(1)).map((i) => i.str).join('|');
  } finally {
    await session.destroy();
  }
}

const BASE: ToolValues = {
  allowPrinting: true, printLevel: 'high', allowModifying: true, allowCopying: true,
  allowAnnotating: true, allowFillingForms: true, allowAccessibility: true, allowAssembling: false,
};

describe('probe3', () => {
  beforeAll(() => {
    let workerPath = `file://${process.cwd()}/node_modules/pdfjs-dist/build/pdf.worker.mjs`;
    Object.defineProperty(GlobalWorkerOptions, 'workerSrc', {
      configurable: true, get: () => workerPath,
      set: (v: string) => { if (v.startsWith('file:') || v.startsWith('data:')) workerPath = v; },
    });
  });

  it('pdf.js acceptance per cipher and mode', async () => {
    for (const version of ['5', '4', '2', '1']) {
      const out = await run('protect', { ...BASE, mode: 'user', userPassword: 'hunter2', ownerPassword: '', version });
      const bytes = new Uint8Array(await out.outputs[0].blob.arrayBuffer());
      let pw = '';
      try { pw = await extract(bytes, 'hunter2'); } catch (e) { pw = `THROWS ${(e as Error).message}`; }
      let none = '';
      try { none = await extract(bytes); } catch (e) { none = `THROWS ${(e as Error).message}`; }
      NOTE(`cipher ${version} user-mode: pdf.js(hunter2)=`, pw, '| pdf.js(none)=', none);
    }
    const owner = await run('protect', { ...BASE, mode: 'owner', userPassword: '', ownerPassword: 'owner-key', version: '4' });
    const ownerBytes = new Uint8Array(await owner.outputs[0].blob.arrayBuffer());
    let o1 = '';
    try { o1 = await extract(ownerBytes); } catch (e) { o1 = `THROWS ${(e as Error).message}`; }
    NOTE('owner-mode restrictions-only: pdf.js(no password) =', o1);
    // engine load without a password (what the app itself does)
    NOTE('owner-mode: PDFDocument.load(bytes) ok?', await PDFDocument.load(ownerBytes).then((d) => `yes, ${d.getPageCount()} pages, isEncrypted=${d.isEncrypted}`).catch((e) => `THROWS ${(e as Error).message}`));
    const userOut = await run('protect', { ...BASE, mode: 'user', userPassword: 'hunter2', ownerPassword: '', version: '4' });
    const userBytes = new Uint8Array(await userOut.outputs[0].blob.arrayBuffer());
    NOTE('user-mode: PDFDocument.load(bytes) ok?', await PDFDocument.load(userBytes).then((d) => `yes ${d.isEncrypted}`).catch((e) => `THROWS ${(e as Error).message}`));
    NOTE('user-mode: load({password:"hunter2"}) ok?', await PDFDocument.load(userBytes, { password: 'hunter2' }).then((d) => `yes ${d.getPageCount()} pages`).catch((e) => `THROWS ${(e as Error).message}`));
    NOTE('user-mode: load({password:"owner-key"}) ok?', await PDFDocument.load(userBytes, { password: 'owner-key' }).then(() => 'yes').catch((e) => `THROWS ${(e as Error).message}`));
    expect(true).toBe(true);
  });
});
