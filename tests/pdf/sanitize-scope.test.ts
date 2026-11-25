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
 * 4. **`Remove XMP metadata` took the pointer and shipped the packet.** The
 *    catalogue's `/Metadata` went, the stream stayed in the file unreferenced, and
 *    `<x:xmpmeta` was still searchable — on all six of the rail's XMP shapes
 *    (`2260 → 2250 B`, `2765 → 2756 B`, `3303 → 3296 B`) under *"XMP metadata removed"*.
 * 5. **`Remove annotations and form fields` took the pointer and shipped the
 *    payload.** `/Annots` emptied and the marks came off the sheet, while every
 *    annotation dictionary, its `/AP` appearance stream and the field subtree
 *    stayed — "A note from an outside writer" extracted from the ON output exactly as
 *    from the OFF one, 9 of 9 payloads on that file, `/V` answers on `form.pdf` —
 *    under *"5 annotation(s) removed"*.
 * 6. **`Remove the document info dictionary` read one of the two shapes a trailer
 *    can hold.** An `/Info` written *direct* into the trailer was neither removed nor
 *    admitted (ON and OFF byte-identical, MuPDF still titled the file) and the card
 *    said *"there was no info dictionary"*; the indirect shape deleted the object and
 *    left the trailer naming it, which poppler reads as `Syntax Error: Invalid XRef
 *    entry 6` and MuPDF as a slot it cannot find.
 *
 * Everything below is read back out of the produced file, never a call count: the
 * `/AF` array, the file-specification dictionary, the decompressed payload, the
 * kept annotation's `/Rect`, and the page's own content stream byte for byte (a
 * sanitiser that re-renders the page is a different tool).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

/* ── the payload, not the pointer: metadata / annotations / info (rail audit c2) ── */

/**
 * One file carrying every payload the three switches above are about, in the shapes
 * the rail drove: an `/Info` (indirect, or written straight into the trailer), an XMP
 * packet behind the catalogue's `/Metadata`, a FreeText note with an appearance
 * stream, a widget whose `/V` answer hangs in a field tree, a link with a popup of
 * its own, and an `/XFA` packet this tool promises to leave where it is. Object
 * numbers are fixed so a leftover cannot hide by shifting, and `null` entries keep
 * the numbering contiguous.
 */
function scopeFixture(shape: { directInfo?: boolean; inherited?: boolean } = {}): Uint8Array {
  const content = 'q BT /F1 12 Tf 20 100 Td (page body) Tj ET Q';
  const appearance = '0 g /Helv 10.0 Tf (SANJANNOTAP19) Tj';
  const packet = '<x:xmpmeta xmlns:x="adobe:ns:meta/">SANJXMPPACKET9</x:xmpmeta>';
  const xfa = '<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/">SANJXFAPACKET22</xdp:xdp>';
  const inlineInfo = '<< /Title (SANJINFOTITLE6) /Author (SANJINFOAUTH6) >>';
  const objects: (string | null)[] = [
    '<< /Type /Catalog /Pages 2 0 R /Metadata 9 0 R'
      + `${shape.inherited ? '' : ' /AcroForm 17 0 R'} >>`,
    shape.inherited
      ? '<< /Type /Pages /Kids [3 0 R] /Count 1 /Annots [14 0 R] >>'
      : '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 20 0 R >> >>'
      + ` /Contents 4 0 R${shape.inherited ? '' : ' /Annots [14 0 R 15 0 R 16 0 R]'} >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    null,
    shape.directInfo ? null : '<< /Title (SANJINFOTITLE6) /Author (SANJINFOAUTH6) >>',
    null,
    null,
    `<< /Type /Metadata /Subtype /XML /Length ${packet.length} >>\nstream\n${packet}\nendstream`,
    null,
    null,
    null,
    null,
    '<< /Type /Annot /Subtype /FreeText /Rect [10 40 220 70] /Contents (SANJANNOTNOTE14)'
      // Its appearance stream is shared with the popup below it, so the stream is
      // still held by a doomed object when the sweep first reaches it: the pass that
      // frees the popup has to come back for the stream.
      + ' /AP << /N 19 0 R >> /Popup 21 0 R >>',
    shape.inherited ? null : '<< /Type /Annot /Subtype /Widget /FT /Tx /T (answer) /V (SANJFIELDVAL15) /Parent 18 0 R /Rect [10 20 120 36] >>',
    '<< /Type /Annot /Subtype /Link /Rect [10 150 120 168] /Popup 21 0 R /A << /S /URI /URI (https://example.org/SANJLINKURI16) >> >>',
    shape.inherited ? null : '<< /Fields [18 0 R] /DR << /Font << /F1 20 0 R >> >> /XFA [(template) 22 0 R] >>',
    shape.inherited ? null : '<< /T (SANJGROUPFIELD18) /Kids [15 0 R] >>',
    `<< /Length ${appearance.length} >>\nstream\n${appearance}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Annot /Subtype /Popup /Parent 14 0 R /AP << /N 19 0 R >> /Rect [230 70 330 120] >>',
    shape.inherited ? null : `<< /Length ${xfa.length} >>\nstream\n${xfa}\nendstream`,
  ];
  const info = shape.directInfo ? ` /Info ${inlineInfo}` : ' /Info 6 0 R';
  return rawPdf(objects, ` /Root 1 0 R${info}`);
}

/** A file with none of the six scopes in it, and no `/Info` in its trailer either. */
function emptyFixture(): Uint8Array {
  const content = 'q BT /F1 12 Tf 20 100 Td (nothing here) Tj ET Q';
  return rawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >>'
      + ` /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
}

/** Hand-written objects, 1-based and in order, into a file with a classic xref table. */
function rawPdf(objects: (string | null)[], trailer = ' /Root 1 0 R'): Uint8Array {
  let body = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((source, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${source ?? '<< >>'}\nendobj\n`;
  });
  const start = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1}${trailer} >>\nstartxref\n${start}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, 'latin1'));
}

/**
 * Every place a payload can hide once the file is written: the raw bytes, each
 * object's source, and each stream's decoded contents. `savePDF` packs and flates, so
 * a leftover is invisible in the raw bytes and obvious here — which is how the rail's
 * judge searched, and the only reading that can tell "the key is gone" from "the
 * thing is gone".
 */
async function readableOf(bytes: Uint8Array): Promise<string> {
  const { decodePDFRawStream } = await import('@maxwbh/pdf-lib');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const parts: string[] = [new TextDecoder('latin1').decode(bytes)];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    parts.push(String(object));
    try {
      parts.push(new TextDecoder('latin1').decode(decodePDFRawStream(object as never).decode()));
    } catch {
      /* not a stream */
    }
  }
  return parts.join('\n');
}

/** The references a value names, wherever it names them. */
function namedRefs(value: unknown, into: Set<string>): void {
  if (value instanceof PDFRef) into.add(value.toString());
  else if (value instanceof PDFArray) value.asArray().forEach((item) => namedRefs(item, into));
  else if (value instanceof PDFDict) for (const [, item] of value.entries()) namedRefs(item, into);
  else if (value instanceof PDFStream) for (const [, item] of value.dict.entries()) namedRefs(item, into);
}

/**
 * `N 0 R` written somewhere, and no object answering it. This is what makes MuPDF log
 * `cannot find object in xref (6 0 R)` and poppler `Syntax Error: Invalid XRef entry
 * 6` — a file that opens is not yet a file a reader can finish reading.
 */
async function danglingRefs(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const named = new Set<string>();
  for (const [, object] of doc.context.enumerateIndirectObjects()) namedRefs(object, named);
  for (const root of Object.values(doc.context.trailerInfo)) namedRefs(root, named);
  const missing: string[] = [];
  for (const tag of named) {
    const number = Number.parseInt(tag, 10);
    if (doc.context.lookup(PDFRef.of(number)) === undefined) missing.push(tag);
  }
  return missing;
}

/** The annotation dictionaries left in the file, by subtype. */
async function annotSubtypes(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const out: string[] = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    const dict = object instanceof PDFDict ? object : undefined;
    if (dict?.lookupMaybe(PDFName.of('Type'), PDFName)?.asString() === '/Annot') {
      out.push(dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() ?? '(none)');
    }
  }
  return out.sort();
}

/** How the trailer carries its `/Info`: by reference, written inline, or not at all. */
async function trailerInfoShape(bytes: Uint8Array): Promise<'ref' | 'inline' | 'none'> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const info = doc.context.trailerInfo.Info;
  if (info instanceof PDFRef) return 'ref';
  return info instanceof PDFDict ? 'inline' : 'none';
}

/** The outside-written files the rail drove, read from the committed bank. */
const foreign = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(resolve(process.cwd(), 'tests/fixtures/foreign', name)));

const sanitize = (values: Partial<typeof OFF>, bytes: Uint8Array, name = 'scope.pdf') =>
  run('sanitize-pdf', { ...OFF, ...values }, [fileFrom(bytes, name, 'application/pdf')]);

describe('sanitize-pdf Remove XMP metadata takes the packet, not just the catalogue key', () => {
  it('deletes the /Metadata stream object, so the packet is out of the bytes', async () => {
    const source = scopeFixture();
    expect(await readableOf(source), 'the fixture must carry the packet').toContain('SANJXMPPACKET9');
    const outcome = await sanitize({ metadata: true }, source);
    const bytes = await firstPdf(outcome);
    const readable = await readableOf(bytes);
    expect(readable).not.toContain('SANJXMPPACKET9');
    expect(readable).not.toContain('<x:xmpmeta');
    expect(outcome.message).toMatch(/XMP metadata removed/);
    // Payload out means bytes off the file: the packet is 62 B of this fixture.
    const kept = await firstPdf(await sanitize({}, source));
    expect(bytes.byteLength).toBeLessThan(kept.byteLength);
    expect(await danglingRefs(bytes)).toEqual([]);
  });

  it('leaves the packet in place, and named, when the switch is off', async () => {
    const outcome = await sanitize({}, scopeFixture());
    expect(await readableOf(await firstPdf(outcome))).toContain('SANJXMPPACKET9');
    expect(outcome.message).not.toMatch(/XMP metadata removed/);
  });

  it('still says there was no packet on a file that has none', async () => {
    const outcome = await sanitize({ metadata: true }, emptyFixture(), 'empty.pdf');
    expect(outcome.message).toMatch(/there was no XMP packet to remove/);
    expect(outcome.message).toMatch(/^Nothing to remove/);
  });
});

describe('sanitize-pdf Remove annotations takes the dictionaries, the appearances and the field tree', () => {
  it('deletes every annotation dictionary and the appearance stream drawn for it', async () => {
    const source = scopeFixture();
    expect(await annotSubtypes(source), 'the fixture must carry the marks').toEqual(
      ['/FreeText', '/Link', '/Popup', '/Widget'],
    );
    const outcome = await sanitize({ annotations: true }, source);
    const bytes = await firstPdf(outcome);
    const readable = await readableOf(bytes);
    expect(readable, 'the page itself went with its annotations').toContain('page body');
    for (const needle of ['SANJANNOTNOTE14', 'SANJANNOTAP19', 'SANJLINKURI16']) {
      expect(readable, `${needle} is still in the download`).not.toContain(needle);
    }
    expect(await annotSubtypes(bytes)).toEqual([]);
    expect(outcome.message).toMatch(/3 annotation\(s\) including 1 form field\(s\) removed/);
    expect(await danglingRefs(bytes)).toEqual([]);
  });

  it('deletes the typed /V answer and the field subtree it hangs in, and keeps the XFA packet the card names', async () => {
    const outcome = await sanitize({ annotations: true }, scopeFixture());
    const readable = await readableOf(await firstPdf(outcome));
    expect(readable).not.toContain('SANJFIELDVAL15');
    expect(readable).not.toContain('SANJGROUPFIELD18');
    // The popup is named only by a deleted annotation, so it goes with it.
    expect(await annotSubtypes(await firstPdf(outcome))).toEqual([]);
    // `notes` promises the XFA packet stays: this switch drops the pointer, not the XML.
    expect(readable).toContain('SANJXFAPACKET22');
    expect(outcome.warnings.join(' ')).toMatch(/filled-in answers/);
  });

  it('keeps what a surviving page also names', async () => {
    const outcome = await sanitize({ annotations: true }, scopeFixture());
    const readable = await readableOf(await firstPdf(outcome));
    // Object 20 is the face both the page's /Resources and the form's /DR name.
    expect(readable).toContain('/BaseFont /Helvetica');
    const before = await factsOf(scopeFixture());
    const after = await factsOf(await firstPdf(outcome));
    expect(after.pages).toBe(before.pages);
    expect(after.pageContent, 'the sheet was redrawn along with its marks').toEqual(before.pageContent);
  });

  it('stops the note being extractable from an outside-written file, and its answers from a form', async () => {
    const source = foreign('annotations.pdf');
    expect(await readableOf(source)).toContain('A note from an outside writer');
    const off = await firstPdf(await sanitize({}, source, 'annotations.pdf'));
    expect(await readableOf(off)).toContain('A note from an outside writer');
    const on = await sanitize({ annotations: true }, source, 'annotations.pdf');
    const readable = await readableOf(await firstPdf(on));
    expect(readable).not.toContain('A note from an outside writer');
    expect(readable).not.toContain('Free text, drawn inline');
    expect(on.message).toMatch(/removed/);

    const form = foreign('form.pdf');
    const answers = await readableOf(form);
    const cleared = await readableOf(await firstPdf(await sanitize({ annotations: true }, form, 'form.pdf')));
    for (const match of answers.matchAll(/\/V\s*\(((?:[^()\\]|\\.)*)\)/g)) {
      const answer = match[1];
      if (answer.trim() === '') continue;
      expect(cleared, `the /V answer "${answer}" is still in the file`).not.toContain(answer);
    }
  });

  it('leaves an /Annots inherited from the /Pages node exactly where it was', async () => {
    const source = scopeFixture({ inherited: true });
    const off = await firstPdf(await sanitize({}, source, 'inherited.pdf'));
    const on = await firstPdf(await sanitize({ annotations: true }, source, 'inherited.pdf'));
    expect(Buffer.from(on).equals(Buffer.from(off)), 'the inherited shape changed under this fix').toBe(true);
    expect(await readableOf(on)).toContain('SANJANNOTNOTE14');
    expect((await sanitize({ annotations: true }, source, 'inherited.pdf')).message)
      .toMatch(/no annotations were present/);
  });
});

describe('sanitize-pdf Remove the info dictionary clears the trailer, in both shapes', () => {
  it('deletes an indirect /Info without leaving the trailer naming it', async () => {
    const source = scopeFixture();
    expect(await trailerInfoShape(source), 'the fixture must name /Info by reference').toBe('ref');
    const outcome = await sanitize({ info: true }, source);
    const bytes = await firstPdf(outcome);
    const readable = await readableOf(bytes);
    expect(readable).not.toContain('SANJINFOTITLE6');
    expect(readable).not.toContain('SANJINFOAUTH6');
    expect(await trailerInfoShape(bytes)).toBe('none');
    // The dangling slot this used to write: poppler `Invalid XRef entry 6`, MuPDF a
    // slot it cannot find.
    expect(await danglingRefs(bytes)).toEqual([]);
    expect(outcome.message).toMatch(/the info dictionary was removed/);
    expect(outcome.message).not.toMatch(/there was no info dictionary/);
  });

  it('deletes a /Info written direct into the trailer, and the run differs from the one that left it', async () => {
    const source = scopeFixture({ directInfo: true });
    expect(await trailerInfoShape(source), 'the fixture must write /Info into the trailer').toBe('inline');
    const off = await firstPdf(await sanitize({}, source, 'inline.pdf'));
    expect(await readableOf(off)).toContain('SANJINFOTITLE6');
    expect(await trailerInfoShape(off)).toBe('inline');
    const outcome = await sanitize({ info: true }, source, 'inline.pdf');
    const bytes = await firstPdf(outcome);
    const readable = await readableOf(bytes);
    expect(readable).not.toContain('SANJINFOTITLE6');
    expect(readable).not.toContain('SANJINFOAUTH6');
    expect(await trailerInfoShape(bytes)).toBe('none');
    expect(Buffer.from(bytes).equals(Buffer.from(off)), 'ON and OFF wrote the same bytes').toBe(false);
    expect(outcome.message).toMatch(/the info dictionary was removed/);
    expect(outcome.message).not.toMatch(/there was no info dictionary/);
    expect(await danglingRefs(bytes)).toEqual([]);
  });

  it('says there was no info dictionary only when the trailer names none', async () => {
    const outcome = await sanitize({ info: true }, emptyFixture(), 'empty.pdf');
    expect(outcome.message).toMatch(/there was no info dictionary/);
    expect(outcome.message).toMatch(/^Nothing to remove/);
  });
});
