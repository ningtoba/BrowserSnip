/**
 * `sanitize-pdf` on the half of sanitising nobody measures: **what it leaves.**
 *
 * The `CONTROL INERT` rows (`ff66110`) proved the script switch reaches the bytes;
 * the other direction is over-removal and under-removal — a switch that takes more
 * than it names, or takes less and says it took it. Measured before the fix, with
 * the run's own card beside the produced bytes:
 *
 * 1. **`Remove embedded files` never deleted the file.** It emptied the
 *    `/Names → /EmbeddedFiles` name tree and stopped, so the `/Type /EmbeddedFile`
 *    stream stayed in the output — a payload-bearing file came back "sanitized"
 *    with the payload still in it, while the field's own help promises the
 *    deletion is final in the copy.
 * 2. **An associated file (`/AF`) was not removed at all, and the card said there
 *    was none.** On a PDF/A-3 shaped file the run printed "no embedded files were
 *    present" and shipped the invoice XML, still named by `/AF` and still
 *    extractable — over a shape this app's own `listAttachments` reads (it reads
 *    `/AF`, `/FileAttachment` `/FS` and the name tree, which is exactly the three
 *    sites measured here). The flat walk knew one of them.
 * 3. With the switch **off** nothing was said about a payload that stays, though
 *    the script switch had already been taught that sentence.
 *
 * Everything below is read back out of the produced file, never a call count: the
 * `/AF` array, the file-specification dictionary, the decompressed payload, the
 * kept annotation's `/Rect`, and the page's own content stream byte for byte (a
 * sanitiser that re-renders the page is a different tool).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFStream } from '@maxwbh/pdf-lib';
import { cleanup } from '@testing-library/react';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import { fileFrom, firstPdf, installConvertToEnv, resetConvertToEnv, restoreConvertToEnv, run } from './convert-to-harness';

/** The one payload every fixture carries, so its survival is a byte search. */
const PAYLOAD = 'ZUGFERD-INVOICE-PAYLOAD-123';

const OFF = { javascript: false, attachments: false, metadata: false, info: false, annotations: false, hiddenLayers: false };

/**
 * A one-page PDF written the way generators write attachments: an `/AF` array off
 * the catalogue, a name-tree entry, a `/FileAttachment` annotation's `/FS`, each
 * naming the same file specification.
 */
function attachmentFixture(stores: { af?: boolean; tree?: boolean; annot?: boolean }): Uint8Array {
  const content = 'q BT /F1 12 Tf 20 100 Td (page body) Tj ET Q';
  const annots = stores.annot ? ' /Annots [7 0 R]' : '';
  const page = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R${annots}>>`;
  // 5 is the file specification, 7 the (optional) file-attachment annotation whose
  // `/FS` names it, 8 the payload stream `/EF` names. The numbers are fixed so a
  // store cannot shift the others.
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R${stores.af ? ' /AF [5 0 R]' : ''}`
      + `${stores.tree ? ' /Names << /EmbeddedFiles << /Names [(note.txt) 5 0 R] >> >>' : ''}>>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    page,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Filespec /F (note.txt) /UF (note.txt) /EF << /F 8 0 R >> >>',
    '<< /Type /EmbeddedFile /Length 8 >>\nstream\nplaceholder\nendstream',
    stores.annot ? '<< /Type /Annot /Subtype /FileAttachment /Rect [40 30 60 50] /FS 5 0 R /F 4 /Contents (note.txt) >>' : '<< >>',
    `<< /Type /EmbeddedFile /Length ${PAYLOAD.length} >>\nstream\n${PAYLOAD}\nendstream`,
  ];
  let body = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((source, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${source}\nendobj\n`;
  });
  const start = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, 'latin1'));
}

/** A PDF with nothing an attachment switch can find, and no annotations either. */
async function plainFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]).drawText('no attachments here', { x: 20, y: 100 });
  return new Uint8Array(await doc.save());
}

interface Facts {
  /** Text of the output, latin1: the payload is plain ASCII in every fixture. */
  bytes: string;
  af: boolean;
  names: boolean;
  specObjects: number;
  /** Decompressed payload found anywhere in the output, object streams included. */
  payload: boolean;
  annotRects: string[];
  annotFs: boolean;
  pageContent: string[];
  pages: number;
}

/**
 * Read the produced file the way the claim reads: does anything still name, or
 * hold, the payload?
 */
async function factsOf(bytes: Uint8Array): Promise<Facts> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const text = new TextDecoder('latin1').decode(bytes);
  let payload = text.includes(PAYLOAD);
  let specObjects = 0;
  const annotRects: string[] = [];
  let annotFs = false;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    // Saved bytes are packed into object streams, so the payload is only a needle
    // here when it was left uncompressed; the decompressed copy below is the check.
    const dict = object instanceof PDFDict ? object : undefined;
    if (dict?.lookupMaybe(PDFName.of('Type'), PDFName)?.asString() === '/Filespec') specObjects += 1;
    if (dict?.lookupMaybe(PDFName.of('Type'), PDFName)?.asString() === '/Annot') {
      annotFs ||= dict.has(PDFName.of('FS'));
      const rect = dict.lookupMaybe(PDFName.of('Rect'), PDFArray);
      if (rect) annotRects.push(rect.asArray().map((v) => String(v)).join(','));
    }
  }
  // Decompress everything: an uncompressed leftover would be found by the raw
  // search, but pdf-lib packs and flates on save, so ask the objects themselves.
  const { decodePDFRawStream } = await import('@maxwbh/pdf-lib');
  const streams: Uint8Array[] = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    const candidate = object as { dict?: PDFDict; getContents?: () => Uint8Array; contents?: Uint8Array };
    if (!candidate?.dict) continue;
    try {
      streams.push(decodePDFRawStream(object as never).decode());
    } catch {
      /* not a decodable stream */
    }
  }
  if (!payload) payload = streams.some((s) => new TextDecoder('latin1').decode(s).includes(PAYLOAD));
  const pages = doc.getPages();
  return {
    bytes: text,
    af: doc.catalog.has(PDFName.of('AF')),
    names: doc.catalog.has(PDFName.of('Names')),
    specObjects,
    payload,
    annotRects,
    annotFs,
    pageContent: pages.map((page) => new TextDecoder('latin1').decode(bytesOfContents(doc, page))),
    pages: pages.length,
  };
}

/** The page's own content-stream bytes, concatenated. */
function bytesOfContents(doc: PDFDocument, page: { node: { Contents(): PDFStream | PDFArray | undefined } }): Uint8Array {
  const contents = page.node.Contents();
  if (!contents) return new Uint8Array();
  const entries = contents instanceof PDFArray
    ? Array.from({ length: contents.size() }, (_, index) => contents.get(index))
    : [contents];
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const stream = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
    const data = (stream as { getContents?: () => Uint8Array })?.getContents?.();
    if (data) parts.push(data);
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

beforeAll(() => { installConvertToEnv(); });
afterEach(() => {
  resetConvertToEnv();
  cleanup();
  useProcessStore.getState().reset();
  useFileStore.getState().setFiles([]);
});
afterAll(() => { restoreConvertToEnv(); });

describe('sanitize-pdf Remove embedded files takes the payload, not just the pointer', () => {
  it('removes a catalog /AF associated file and its bytes, and says it did', async () => {
    const source = attachmentFixture({ af: true });
    expect((await factsOf(source)).payload, 'the fixture must carry the payload').toBe(true);
    const outcome = await run('sanitize-pdf', { ...OFF, attachments: true }, [fileFrom(source, 'af.pdf', 'application/pdf')]);
    const after = await factsOf(await firstPdf(outcome));
    expect(after.af, '/AF still names a file').toBe(false);
    expect(after.specObjects, 'the file specification is still in the file').toBe(0);
    expect(after.payload, 'the payload is still in the file').toBe(false);
    expect(outcome.message).toMatch(/1 embedded file\(s\) removed/);
    expect(outcome.message).not.toMatch(/no embedded files were present/);
  });

  it('removes a name-tree attachment and its bytes', async () => {
    const outcome = await run('sanitize-pdf', { ...OFF, attachments: true }, [fileFrom(attachmentFixture({ tree: true }), 'tree.pdf', 'application/pdf')]);
    const after = await factsOf(await firstPdf(outcome));
    expect(after.names).toBe(false);
    expect(after.payload).toBe(false);
    expect(outcome.message).toMatch(/1 embedded file\(s\) removed/);
  });

  it('counts one file once when the same payload is in the name tree and on /AF', async () => {
    const outcome = await run('sanitize-pdf', { ...OFF, attachments: true }, [fileFrom(attachmentFixture({ tree: true, af: true }), 'both.pdf', 'application/pdf')]);
    const after = await factsOf(await firstPdf(outcome));
    expect(after.payload).toBe(false);
    // Two references, one file: "2 removed" would be a double count.
    expect(outcome.message).toMatch(/^Sanitized: 1 embedded file\(s\) removed/);
  });

  it('takes the payload off a kept /FileAttachment annotation and leaves the mark', async () => {
    const source = attachmentFixture({ annot: true });
    expect((await factsOf(source)).annotRects).toEqual(['40,30,60,50']);
    const outcome = await run('sanitize-pdf', { ...OFF, attachments: true }, [fileFrom(source, 'mark.pdf', 'application/pdf')]);
    const after = await factsOf(await firstPdf(outcome));
    expect(after.annotFs, 'the annotation still points at a payload nowhere in the file').toBe(false);
    expect(after.annotRects, 'the kept annotation lost its place on the page').toEqual(['40,30,60,50']);
    expect(after.payload).toBe(false);
  });

  it('leaves the page content stream byte-identical, and every page in place', async () => {
    const source = attachmentFixture({ af: true, tree: true, annot: true });
    const before = await factsOf(source);
    const outcome = await run('sanitize-pdf', { ...OFF, attachments: true }, [fileFrom(source, 'page.pdf', 'application/pdf')]);
    const after = await factsOf(await firstPdf(outcome));
    expect(after.pages).toBe(before.pages);
    expect(after.pageContent).toEqual(before.pageContent);
  });

  it('keeps everything and says the payload stays when the switch is off', async () => {
    const outcome = await run('sanitize-pdf', { ...OFF }, [fileFrom(attachmentFixture({ af: true, tree: true }), 'off.pdf', 'application/pdf')]);
    const after = await factsOf(await firstPdf(outcome));
    expect(after.af).toBe(true);
    expect(after.names).toBe(true);
    expect(after.payload).toBe(true);
    expect(outcome.message).toMatch(/1 embedded file\(s\) left in place/);
    expect(outcome.warnings.join(' ')).toMatch(/stay in the output/);
  });

  it('still says there were none on a file without an attachment', async () => {
    const outcome = await run('sanitize-pdf', { ...OFF, attachments: true }, [fileFrom(await plainFixture(), 'plain.pdf', 'application/pdf')]);
    expect(outcome.message).toMatch(/no embedded files were present/);
    expect(outcome.message).toMatch(/^Nothing to remove/);
  });

  it('says no annotations were present instead of "0 annotation(s) removed"', async () => {
    const outcome = await run('sanitize-pdf', { ...OFF, annotations: true }, [fileFrom(await plainFixture(), 'plain.pdf', 'application/pdf')]);
    expect(outcome.message).toMatch(/no annotations were present/);
    expect(outcome.message).not.toMatch(/0 annotation\(s\) removed/);
  });
});
