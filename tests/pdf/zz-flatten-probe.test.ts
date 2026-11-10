/**
 * Temporary probe: write the flatten fixture and its output to /tmp so an
 * outside reader (MuPDF, pypdf) can judge them. Deleted before commit.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { writeFileSync } from 'node:fs';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRef,
  PDFString,
  StandardFonts,
  rgb,
} from '@maxwbh/pdf-lib';
import { addAnnotation } from '@/lib/pdf/core/annotations';
import { createFormField } from '@/lib/pdf/core/forms';
import { runPdfTool, type RunOutcome } from '@/lib/pdf/tools/runner';
import type { ToolValues } from '@/lib/pdf/tools/types';

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

function file(bytes: Uint8Array, name = 'annot.pdf'): File {
  return new File([new Uint8Array(bytes) as BlobPart], name, { type: 'application/pdf' });
}

export async function flattenFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText('Contract body line one', { x: 60, y: 760, size: 16, font, color: rgb(0, 0, 0) });
  page.drawText('The quick brown fox jumps over the lazy dog', { x: 60, y: 720, size: 12, font, color: rgb(0, 0, 0) });

  addAnnotation(doc, { kind: 'Text', page: 0, rect: { x: 480, y: 740, width: 20, height: 20 }, contents: 'A sticky note' });
  addAnnotation(doc, {
    kind: 'Highlight', page: 0, rect: { x: 60, y: 712, width: 120, height: 14 },
    quadPoints: [60, 712, 180, 712, 60, 726, 180, 726], contents: 'a highlighted phrase',
  });
  addAnnotation(doc, {
    kind: 'Ink', page: 0, rect: { x: 200, y: 600, width: 140, height: 60 },
    inkPath: [[[200, 600, 240, 650, 280, 610, 330, 655]]], color: '#101010', borderWidth: 2,
  });
  addAnnotation(doc, {
    kind: 'Square', page: 0, rect: { x: 60, y: 500, width: 120, height: 60 },
    color: '#aa0000', fillColor: '#ffeeee', borderWidth: 2,
  });

  createFormField(doc, 0, {
    type: 'text', name: 'answer', rect: { x: 60, y: 420, width: 200, height: 22 },
    value: 'Ada Lovelace', label: 'Answer',
  });
  createFormField(doc, 0, {
    type: 'checkbox', name: 'tick', rect: { x: 60, y: 380, width: 16, height: 16 },
    value: 'true', label: 'Tick',
  });

  // A signature widget with a hand-drawn appearance: what a signed file looks like.
  const context = doc.context;
  const signatureRef = context.register(context.flateStream(
    ['q', '0.05 0.05 0.3 RG', '3 w', '10 20 m', '30 50 l', '50 15 l', '70 48 l', '90 20 l', 'S', 'Q'].join('\n'),
    { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 60] } as never,
  ));
  const valueRef = context.register(context.obj(
    { Type: 'Sig', FT: 'Sig', Name: 'Signature1' } as never,
  ));
  const widgetRef = context.register(context.obj({
    Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('Signature1'),
    Rect: [360, 300, 460, 360], P: page.ref, V: valueRef,
    AP: { N: signatureRef }, F: 4,
  } as never));
  const acroForm = doc.catalog.get(PDFName.of('AcroForm'));
  const acroDict = (acroForm instanceof PDFRef ? context.lookup(acroForm, PDFDict) : acroForm) as PDFDict;
  (acroDict.get(PDFName.of('Fields')) as PDFArray).push(widgetRef);
  const annots = (page.node.Annots() ?? context.obj([])) as PDFArray;
  annots.push(widgetRef);
  return doc.save({ useObjectStreams: false });
}

async function bytesOf(outcome: RunOutcome): Promise<Uint8Array> {
  return new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
}

describe('flatten probe', () => {
  it('writes before/after to /tmp', async () => {
    const source = await flattenFixture();
    writeFileSync('/tmp/flatten-before.pdf', source);
    const outcome = await runPdfTool({
      toolId: 'flatten-pdf',
      files: [file(source)],
      values: { forms: true, annotations: true, keepLinks: true, dpi: 96 } as ToolValues,
      onProgress: () => undefined,
      onLog: () => undefined,
    });
    expect(outcome).toBeTruthy();
    const bytes = await bytesOf(outcome!);
    writeFileSync('/tmp/flatten-after.pdf', bytes);
    writeFileSync('/tmp/flatten-report.json', JSON.stringify({
      message: outcome!.message,
      warnings: outcome!.warnings,
      pages: outcome!.pages,
    }, null, 2));
  }, 300_000);
});
