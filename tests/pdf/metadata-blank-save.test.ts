/**
 * `edit-metadata` and `view-metadata`, judged by the bytes and by what a person
 * is shown — the chunk-c3 re-audit.
 *
 * Measured on the dev build (`docs/research/c3-metadata-probe.mjs`, Chromium on
 * :5294, CDP 9844) against freshly built fixtures and two real producer files (a
 * Microsoft Word 2021 paper and a pdfTeX paper):
 *
 * 1. A save with every box blank **deleted properties**. On the real pdfTeX paper
 *    `/Title` and `/Subject` were present as empty strings; `stringValue() ||
 *    current.title` handed `writeInfo` an empty string, which it reads as a
 *    delete, so the keys vanished — and the packet's `dc:title`/`dc:creator`
 *    vanished with them, because the sync patch saw no `/Info` twin.
 * 2. Keywords were split by **two different rules**: commas only for `/Info`,
 *    commas *and* semicolons for `dc:subject`. Typing `alpha; beta , gamma` wrote
 *    two keywords into one store and three into the other, so the two stores
 *    disagreed about how many keywords the document has — with the sync toggle on.
 *    (`view-metadata`'s own findings are pinned in `view-metadata-stores.test.ts`.)
 *
 * The date-format findings from the same audit are `SEAM` items in
 * `src/lib/pdf/core/metadata.ts` and are pinned at the bottom, blocked, with the
 * exact strings the seam fix has to produce.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument } from '@maxwbh/pdf-lib';
import { PDFHexString, PDFName, PDFString } from '@/lib/pdf/core/doc';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { openPDF } from '@/lib/pdf/core/doc';
import {
  infoDict, parsePdfDateParts, readInfo, readXmp, readXmpText, writeInfo, writeXmp,
} from '@/lib/pdf/core/metadata';
import type { PdfToolDefinition, ToolValues } from '@/lib/pdf/tools/types';

/** The canonical RDF namespace (`1999/02/22-…`), as every real producer writes it. */
const RDF = 'http://www.w3.org/1999' + '/02/22-rdf-syntax-ns#';

/** A packet that owns facts `/Info` does not hold. */
const PACKET = '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>'
  + '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="' + RDF + '">'
  + '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"'
  + ' xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">'
  + '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Keep me please</rdf:li></rdf:Alt></dc:title>'
  + '<dc:creator><rdf:Seq><rdf:li>Packet only author</rdf:li></rdf:Seq></dc:creator>'
  + '<dc:description><rdf:Alt><rdf:li xml:lang="x-default">Packet only description</rdf:li></rdf:Alt></dc:description>'
  + '<dc:subject><rdf:Bag><rdf:li>packetword</rdf:li></rdf:Bag></dc:subject>'
  + '<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">(c) ACME keep me</rdf:li></rdf:Alt></dc:rights>'
  + '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';

/**
 * The shape the real pdfTeX paper had: `/Title` and `/Subject` present but empty,
 * `/Creator`/`/Producer`/dates filled, and a packet that owns the description.
 */
async function realShaped(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  const dict = infoDict(doc, true)!;
  dict.set(PDFName.of('Title'), PDFString.of(''));
  dict.set(PDFName.of('Subject'), PDFString.of(''));
  dict.set(PDFName.of('Creator'), PDFHexString.fromText('LaTeX with hyperref'));
  dict.set(PDFName.of('Producer'), PDFHexString.fromText('pdfTeX'));
  dict.set(PDFName.of('CreationDate'), PDFString.of("D:20250909180054-03'00'"));
  dict.set(PDFName.of('ModDate'), PDFString.of("D:20250909180054-03'00'"));
  writeXmp(doc, PACKET);
  return doc.save({ useObjectStreams: false });
}

function pdfFile(bytes: Uint8Array, name = 'paper.pdf'): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}

interface RunOutcome {
  outputs: { blob: Blob }[];
  message?: string;
  report?: { message?: string; sections: { title: string; rows?: { label: string; value: string }[] }[] };
}

async function run(toolId: string, source: Uint8Array, values: ToolValues): Promise<RunOutcome> {
  expect(getPdfTool(toolId) as PdfToolDefinition | undefined, `${toolId} is not registered`).toBeTruthy();
  return (await runPdfTool({
    toolId, files: [pdfFile(source)], values, onProgress: () => {}, onLog: () => {},
  })) as unknown as RunOutcome;
}

async function produced(outcome: RunOutcome): Promise<PDFDocument> {
  expect(outcome.outputs.length, 'the tool produced no output').toBeGreaterThan(0);
  return openPDF(new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()), { updateMetadata: false });
}

function keys(doc: PDFDocument): string[] {
  const dict = infoDict(doc);
  return dict ? [...dict.keys()].map((key) => key.decodeText()) : [];
}

function rawOf(doc: PDFDocument): string {
  const found = doc.catalog.lookup(PDFName.of('Metadata'));
  void found;
  return readXmpText(doc) ?? '';
}

describe('a save that types nothing keeps what the document holds', () => {
  it('leaves a present-but-empty /Title and /Subject standing', async () => {
    const source = await realShaped();
    const doc = await produced(await run('edit-metadata', source, { touchDates: false }));
    const dict = infoDict(doc)!;
    expect(keys(doc), 'the blank save deleted keys the user never touched').toEqual(
      expect.arrayContaining(['Title', 'Subject']),
    );
    expect(dict.get(PDFName.of('Title')), '/Title stopped being an empty string').toBeDefined();
    expect(readInfo(doc).title, '/Title gained a value out of nowhere').toBe('');
    // And the dates were left alone, as the toggle says.
    expect(readInfo(doc).modDate).toBe("D:20250909180054-03'00'");
  }, 180_000);

  it('keeps the packet’s own title, author, description and keywords', async () => {
    const doc = await produced(await run('edit-metadata', await realShaped(), { touchDates: false }));
    const packet = rawOf(doc);
    const summary = readXmp(doc);
    expect(summary?.readable, 'the packet is still XML').toBe(true);
    expect(packet, 'dc:title was deleted because /Info holds an empty string').toContain('Keep me please');
    expect(packet, 'dc:creator was deleted').toContain('Packet only author');
    expect(packet, 'dc:description was deleted').toContain('Packet only description');
    expect(packet, 'dc:subject was deleted').toContain('packetword');
    expect(packet, 'dc:rights was deleted').toContain('(c) ACME keep me');
    // Nothing was invented in /Info either: the box was blank, so the key keeps
    // the empty string the file already held.
    expect(readInfo(doc).title, 'a blank box rewrote /Title').toBe('');
    expect(readInfo(doc).author, 'a blank box wrote an /Author').toBeUndefined();
  }, 180_000);

  it('still writes what the user typed, and syncing off still leaves the packet alone', async () => {
    const typed = await produced(await run('edit-metadata', await realShaped(), {
      title: 'Typed title', touchDates: false,
    }));
    expect(readInfo(typed).title).toBe('Typed title');
    expect(readXmp(typed)?.title, 'the packet disagrees with /Info with syncing on').toBe('Typed title');

    const before = rawOf(await openPDF(await realShaped(), { updateMetadata: false }));
    const off = await produced(await run('edit-metadata', await realShaped(), {
      title: 'Only /Info', syncXmp: false, touchDates: false,
    }));
    expect(rawOf(off), 'syncing off rewrote the packet anyway').toBe(before);
    expect(readInfo(off).title).toBe('Only /Info');
  }, 180_000);
});

describe('one keyword rule for both stores', () => {
  it('splits a semicolon list the same way in /Info and in dc:subject', async () => {
    const doc = await produced(await run('edit-metadata', await realShaped(), {
      keywords: 'alpha; beta , gamma', touchDates: false,
    }));
    const info = readInfo(doc).keywords ?? '';
    const items = (rawOf(doc).match(/<rdf:li>[\s\S]*?<\/rdf:li>/g) ?? [])
      .map((li) => li.replace(/<[^>]+>/g, ''))
      .filter((word) => ['alpha', 'beta', 'gamma'].includes(word));
    expect(info, '/Info kept the semicolon and so holds a different list').toBe('alpha, beta, gamma');
    expect(items, 'the two stores do not hold the same keywords').toEqual(['alpha', 'beta', 'gamma']);
  }, 180_000);

  it('leaves an untouched keyword string exactly as the file wrote it', async () => {
    const doc = await produced(await run('edit-metadata', await realShaped(), {
      title: 'Nothing to do with keywords', touchDates: false,
    }));
    // The packet owned `packetword`; /Info held no /Keywords, and a blank box
    // writes none — the packet keeps its word either way.
    expect(readInfo(doc).keywords, 'a blank box wrote /Keywords').toBeUndefined();
    expect(rawOf(doc), 'the packet lost its keyword').toContain('packetword');
  }, 180_000);
});

/**
 * SEAM (`src/lib/pdf/core/metadata.ts`) — measured live, pinned blocked so the
 * seam fix has a flip-target. Both are read out of the same `humanDate` /
 * `parsePdfDateParts` pair the properties pane renders.
 */
describe('a date keeps the zone its own text stated — seam 32b784f on master', () => {
  it('prints a zone-less PDF date as the wall clock the file holds', () => {
    // Measured live on `vm-dates.pdf`: the pane printed
    // `1 January 2026 at 19:04:05 local time, no offset recorded` for a file whose
    // stored wall clock is `2 January 2026 03:04:05`.
    const parts = parsePdfDateParts('D:20260102030405');
    expect(parts, 'the date must still be recognised').toBeTruthy();
    // The exact sentence the row has to render:
    // `2 January 2026 at 03:04:05 local time, no offset recorded · stored as D:20260102030405`
    const hour = parts === undefined ? -1 : new Date(parts.date).getHours();
    expect(hour, 'the parsed instant moved off the typed hour').toBe(3);
  });

  it('keeps the Z a typed ISO date carried, and the day it named', () => {
    // Measured live: typed `2026-03-04T13:06:07Z` stored
    // `D:20260304210607+08'00'`, and a date-only `2026-01-31` stored
    // `D:20260131080000+08'00'` at +08 but `D:20260130190000-05'00'` under an
    // emulated America/New_York tab — the day the user typed moved.
    expect(parsePdfDateParts('2026-03-04T13:06:07Z')?.offsetMinutes, 'the Z is parsed away').toBe(0);
    expect(parsePdfDateParts('2026-01-31')?.offsetMinutes, 'a date-only value has no zone to claim').toBeUndefined();
  });
});
