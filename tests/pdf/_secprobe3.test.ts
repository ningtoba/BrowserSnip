import { beforeAll, describe, it, expect } from 'vitest';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { PDFDocument, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { openRender } from '@/lib/pdf/core/render';
import { inspectPdf } from '@/lib/pdf/core/guard';
import type { PdfToolDefinition, ToolValues } from '@/lib/pdf/tools/types';

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
  return (await runPdfTool({ toolId: id, files: inputs, values, password, onProgress: () => {}, onLog: () => {} })) as unknown as {
    outputs: { blob: Blob; name: string }[]; message?: string; warnings: string[];
  };
}
async function bytesOf(o: Awaited<ReturnType<typeof run>>, i = 0) {
  return new Uint8Array(await o.outputs[i].blob.arrayBuffer());
}
async function reader(bytes: Uint8Array, password?: string) {
  try {
    const s = await openRender(bytes, password ? { password } : {});
    const text = (await s.textItems(1)).map((it) => it.str).join(' ');
    const n = s.numPages;
    await s.destroy();
    return `opens pages=${n} text=${JSON.stringify(text)}`;
  } catch (error) {
    return `throw ${(error as Error).name}: ${(error as Error).message}`;
  }
}

const BASE: ToolValues = {
  version: '4', allowPrinting: false, printLevel: 'low', allowModifying: true, allowCopying: false,
  allowAnnotating: true, allowFillingForms: true, allowAccessibility: true, allowAssembling: false,
};

beforeAll(() => {
  let p = `file://${process.cwd()}/node_modules/pdfjs-dist/build/pdf.worker.mjs`;
  Object.defineProperty(GlobalWorkerOptions, 'workerSrc', {
    configurable: true,
    get: () => p,
    set: (v: string) => { if (v.startsWith('file:') || v.startsWith('data:')) p = v; },
  });
});

describe('probe2', () => {
  it('modes', async () => {
    const userMode = await run('protect', { ...BASE, mode: 'user', userPassword: 'hunter2', ownerPassword: '' });
    const ub = await bytesOf(userMode);
    process.stderr.write(`\n[protect user] msg=${userMode.message}\n  warn=${JSON.stringify(userMode.warnings)}\n  guard(no pw)=${JSON.stringify(await (async () => { const i = await inspectPdf(ub, 'o.pdf'); return { e: i.encrypted, np: i.needsPassword, oep: i.opensWithEmptyPassword, pages: i.pages, err: i.error }; })())}\n  reader(nopw)=${await reader(ub)}\n  reader(pw)=${await reader(ub, 'hunter2')}\n`);

    const ownerMode = await run('protect', { ...BASE, mode: 'owner', userPassword: '', ownerPassword: 'owner-only' });
    const ob = await bytesOf(ownerMode);
    const oi = await inspectPdf(ob, 'o.pdf');
    process.stderr.write(`[protect owner] msg=${ownerMode.message}\n  warn=${JSON.stringify(ownerMode.warnings)}\n  guard(no pw)= e=${oi.encrypted} np=${oi.needsPassword} oep=${oi.opensWithEmptyPassword} pages=${oi.pages} err=${oi.error} alg=${oi.algorithm} perms=${JSON.stringify(oi.permissions)}\n  reader(nopw)=${await reader(ob)}\n  reader(owner)=${await reader(ob, 'owner-only')}\n`);

    const cp = await run('change-permissions', { ...BASE, action: 'set', ownerPassword: 'owner', version: '4' });
    const cb = await bytesOf(cp);
    const ci = await inspectPdf(cb, 'o.pdf');
    process.stderr.write(`[change-permissions set] msg=${cp.message}\n  warn=${JSON.stringify(cp.warnings)}\n  guard= e=${ci.encrypted} oep=${ci.opensWithEmptyPassword} pages=${ci.pages} alg=${ci.algorithm}\n  reader(nopw)=${await reader(cb)}\n`);

    const viewOwner = await run('view-metadata', {}, [pdfFile(ob, 'owner.pdf')]);
    process.stderr.write(`[view-metadata owner] sections=${JSON.stringify((viewOwner as unknown as { report?: { sections: { title: string; rows?: { label: string; value: string }[] }[] } }).report?.sections.map((s) => `${s.title}:${JSON.stringify(s.rows)}`), null, 1)}\n`);
    const viewUser = await run('view-metadata', {}, [pdfFile(ub, 'user.pdf')]);
    const prot = (viewUser as unknown as { report?: { sections: { title: string; rows?: { label: string; value: string }[] }[] } }).report?.sections.find((s) => s.title === 'Protection');
    process.stderr.write(`[view-metadata user-mode protection rows]=${JSON.stringify(prot?.rows)}\n`);

    const sign = await run('remove-restrictions', {}, [pdfFile(ob, 'owner.pdf')], 'owner-only');
    process.stderr.write(`[remove-restrictions on owner-only file] msg=${sign.message}\n  warn=${JSON.stringify(sign.warnings)}\n`);
  }, 300_000);
});
