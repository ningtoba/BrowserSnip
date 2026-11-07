import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import type { PDFPage } from '@maxwbh/pdf-lib';
import { pageContentStreams, textRects } from '@/lib/pdf/core/content';
import { openPDF } from '@/lib/pdf/core/doc';
import { runPdfTool, type RunOutcome } from '@/lib/pdf/tools/runner';
import type { ToolValues } from '@/lib/pdf/tools/types';

const A4: [number, number] = [595.28, 841.89];

async function fixture(text = 'Body text'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage(A4).drawText(text, { x: 40, y: 780, size: 14, font, color: rgb(0, 0, 0) });
  doc.setTitle('Edit bytes');
  return doc.save({ useObjectStreams: false });
}

function file(bytes: Uint8Array, name = 'fixture.pdf'): File {
  return new File([new Uint8Array(bytes) as BlobPart], name, { type: 'application/pdf' });
}

async function run(id: string, values: ToolValues = {}, files?: File[]): Promise<RunOutcome> {
  const outcome = await runPdfTool({
    toolId: id,
    files: files ?? [file(await fixture())],
    values,
    onProgress: () => undefined,
    onLog: () => undefined,
  });
  return outcome!;
}

async function bytesOf(outcome: RunOutcome, index = 0): Promise<Uint8Array> {
  if (outcome.outputs.length === 0) return new Uint8Array(0);
  return new Uint8Array(await outcome.outputs[index].blob.arrayBuffer());
}

function dump(log: string[], label: string, value: unknown): void {
  log.push(`${label} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

const step = async (log: string[], name: string, fn: () => Promise<void>): Promise<void> => {
  try { await fn(); } catch (error) { log.push(`STEP ${name} THREW ` + (error instanceof Error ? error.message : String(error))); }
};

describe('probe', () => {
  it('inspects labels, recolour, toc links, flatten, layers', async () => {
    const log: string[] = [];
    await step(log, 'all', async () => {
    // 1. page labels
    const labels = await run('add-page-labels', { ranges: '1-3 Roman 1\n2-4 decimal 1 DOC' });
    dump(log, 'labels.message', labels.message);
    dump(log, 'labels.warnings', labels.warnings);
    const labelDoc = await openPDF(await bytesOf(labels));
    dump(log, 'catalog keys', [...labelDoc.catalog.entries()].map(([k]) => k.asString()));
    const pl = labelDoc.catalog.lookupMaybe(PDFName.of('PageLabels'), PDFDict);
    dump(log, 'PageLabels?', String(pl instanceof PDFDict));
    const nums = pl?.lookupMaybe(PDFName.of('Nums'), PDFArray);
    dump(log, 'nums size', nums?.size());
    if (nums) {
      for (let i = 0; i + 1 < nums.size(); i += 2) {
        const d = nums.get(i + 1) as PDFDict;
        dump(log, `range@${(nums.get(i) as PDFNumber).asNumber()}`, {
          S: String(d.get(PDFName.of('S'))),
          P: String(d.get(PDFName.of('P'))),
          St: String(d.get(PDFName.of('St'))),
        });
      }
    }

    // 2. recolour
    const recolour = await run('text-color', { to: '#ff0000', from: 'any', pages: 'all' });
    dump(log, 'recolour.message', recolour.message);
    const rdoc = await openPDF(await bytesOf(recolour));
    const rpage = rdoc.getPages()[0];
    dump(log, 'recolour streams', pageContentStreams(rpage).map((s) => Buffer.from(s.bytes).toString('latin1')));
    dump(log, 'recolour rects', textRects(rpage));

    // 3. toc links
    const marked = await run('bookmarks', { outline: 'Alpha :: 2\nBeta :: 3', replace: true }, [file(await fixture())]);
    dump(log, 'bookmarks message', marked.message);
    const toc = await run('table-of-contents', { insertAt: 1 }, [file(await bytesOf(marked))]);
    const tdoc = await openPDF(await bytesOf(toc));
    dump(log, 'toc pages', tdoc.getPageCount());
    const annots = tdoc.getPages()[0].node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    dump(log, 'annots size', annots?.size());
    for (const value of annots?.asArray() ?? []) {
      const dict = value instanceof PDFRef ? (tdoc.context.lookup(value) as PDFDict) : (value as PDFDict);
      dump(log, 'annot', String(dict.get(PDFName.of('A'))) + ' / Dest=' + String(dict.get(PDFName.of('Dest'))));
    }
    const outlines = tdoc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
    const first = outlines?.lookupMaybe(PDFName.of('First'), PDFDict);
    dump(log, 'outline first dest', String(first?.get(PDFName.of('Dest'))));
    dump(log, 'toc warnings', toc.warnings);

    // 4. flatten path of form-filler
    const created = await run('form-creator', { fieldSpecs: [{ type: 'text', name: 'name', rect: { x: 60, y: 700, width: 200, height: 20 }, value: 'flattened words' }] });
    const filled = await run('form-filler', { fieldValues: { name: 'flattened words' }, flatten: true }, [file(await bytesOf(created))]);
    dump(log, 'filled message', filled.message);
    dump(log, 'filled warnings', filled.warnings);

    // 5. layers
    const added = await run('pdf-layers', { add: 'LayerOne' });
    dump(log, 'layers added message', added.message);
    const both = await run('pdf-layers', { hide: ['LayerOne'], show: ['LayerOne'], remove: ['Ghost'] }, [file(await bytesOf(added))]);
    dump(log, 'layers both message', both.message);
    dump(log, 'layers both warnings', both.warnings);
    const ldoc = await openPDF(await bytesOf(both));
    const props = ldoc.catalog.lookupMaybe(PDFName.of('OCProperties'), PDFDict);
    dump(log, 'ocproperties', String(props?.get(PDFName.of('OCGs'))) + ' D=' + String(props?.get(PDFName.of('D'))));

    // 6. stamps
    const stamped = await run('add-stamps', { stamp: 'APPROVED', pages: '1', position: 'top-right', width: 120 });
    const sdoc = await openPDF(await bytesOf(stamped));
    const sa = sdoc.getPages()[0].node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    const sdict = sa && (sa.get(0) instanceof PDFRef ? (sdoc.context.lookup(sa.get(0) as PDFRef) as PDFDict) : (sa.get(0) as PDFDict));
    dump(log, 'stamp dict keys', [...(sdict?.entries() ?? [])].map(([k]) => k.asString()));

    // 7. images on a page
    const inverted = await run('invert-colors', { pages: '1' });
    const idoc = await openPDF(await bytesOf(inverted));
    const res = idoc.getPages()[0].node.lookupMaybe(PDFName.of('Resources'), PDFDict);
    const xo = res && (res.get(PDFName.of('XObject')) instanceof PDFRef ? idoc.context.lookup(res.get(PDFName.of('XObject')) as PDFRef, PDFDict) : res.get(PDFName.of('XObject')));
    dump(log, 'xobject entries', [...(((xo as PDFDict) ?? undefined)?.entries() ?? [])].map(([k, v]) => `${k.asString()}=${v.constructor.name}`));

    // 8. odp page count / blank first page
    const zip = new (await import('jszip')).default();
    zip.file('content.xml', `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
<office:body><office:presentation><draw:page><draw:shape><draw:text-box><text:p>Open slide</text:p></draw:text-box></draw:shape></draw:page><draw:page><draw:shape><draw:text-box><text:p>Second body</text:p></draw:text-box></draw:shape></draw:page></office:presentation></office:body></office:document-content>`);
    zip.file('mimetype', 'application/vnd.oasis.opendocument.presentation');
    const odpBytes = new Uint8Array(await zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' }));
    const odp = await run('odp-to-pdf', { slideSize: '4:3' }, [new File([odpBytes as BlobPart], 'deck.odp', { type: 'application/vnd.oasis.opendocument.presentation' })]);
    const odoc = await openPDF(await bytesOf(odp));
    dump(log, 'odp pages', odoc.getPageCount());
    dump(log, 'odp text per page', odoc.getPages().map((p: PDFPage) => textRects(p).map((r) => r.text).join('|')));

    });
    (await import('node:fs')).writeFileSync('/tmp/b3edit-probe3.txt', log.join('\n'));
    expect(log.length).toBeGreaterThan(0);
  });
});
