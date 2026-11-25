/**
 * `edit-metadata` writes properties into a file that already has properties.
 *
 * The promise is that the *properties you can see* are rewritten, so the packet
 * is patched, not rebuilt: measured on a fixture carrying `pdf:PDFVersion`,
 * `xmp:CreateDate`, `xmp:MetadataDate`, `dc:rights` and `dc:language`, the six
 * fields the form owns were written and all five of those were gone from the
 * saved packet — a metadata editor deleting metadata. The XMP half is read back
 * with `readXmpText` and the property names are counted in the packet text, not
 * taken from the tool's `message`; the `/Info` half reads `Trapped` and the two
 * vendor keys out of the dictionary.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument } from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { openPDF } from '@/lib/pdf/core/doc';
import { parsePdfDateParts, readInfo, readXmp, readXmpText, writeInfo, writeXmp } from '@/lib/pdf/core/metadata';
import type { PdfToolDefinition, ToolValues } from '@/lib/pdf/tools/types';

const XMP = '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>'
  + '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999-02-22-rdf-syntax-ns#">'
  + '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"'
  + ' xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"'
  + ' pdf:PDFVersion="1.7" xmp:CreateDate="2026-01-01T01:01:01Z" xmp:MetadataDate="2026-01-03T09:00:00Z">'
  + '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">Original title</rdf:li></rdf:Alt></dc:title>'
  + '<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">(c) 2026 ACME</rdf:li></rdf:Alt></dc:rights>'
  + '<dc:language><rdf:Bag><rdf:li>en-GB</rdf:li></rdf:Bag></dc:language>'
  + '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';

/** A page, a rich packet, and the `/Info` keys the form does not show. */
async function fixture(options: { title?: string; lang?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  writeInfo(doc, {
    title: options.title,
    author: 'Triage Fixture',
    subject: 'A subject worth removing',
    keywords: 'alpha, beta',
    creator: 'Fixture Maker',
    producer: 'Fixture Writer',
    creationDate: "D:20260101010101Z00'00'",
    modDate: "D:20260102010101Z00'00'",
    trapped: 'Unknown',
    lang: options.lang === undefined ? 'en-GB' : options.lang,
    extra: { Vendor: 'ACME Press 4.2', AcmeJob: 'J-991' },
  });
  writeXmp(doc, XMP);
  return doc.save({ useObjectStreams: false });
}

function pdfFile(bytes: Uint8Array): File {
  return new File([new Uint8Array(bytes)], 'meta.pdf', { type: 'application/pdf' });
}

interface RunOutcome {
  outputs: { blob: Blob }[];
  message?: string;
}

async function run(source: Uint8Array, values: ToolValues): Promise<RunOutcome> {
  const tool = getPdfTool('edit-metadata') as PdfToolDefinition | undefined;
  expect(tool, 'edit-metadata is not registered').toBeTruthy();
  return (await runPdfTool({
    toolId: 'edit-metadata', files: [pdfFile(source)], values, onProgress: () => {}, onLog: () => {},
  })) as unknown as RunOutcome;
}

async function produced(outcome: RunOutcome): Promise<PDFDocument> {
  expect(outcome.outputs.length, 'the tool produced no output').toBeGreaterThan(0);
  // `updateMetadata: false`, or pdf-lib re-stamps /ModDate at *read* time and the
  // typed value is judged against its own clock instead of the file's.
  return openPDF(new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()), { updateMetadata: false });
}

describe('edit-metadata patches the XMP packet instead of rebuilding it', () => {
  it('keeps every packet property the form does not own, and writes the one it does', async () => {
    const before = readXmp(await openPDF(await fixture()))!;
    expect(before.raw, 'the control fixture must carry a packet').toContain('dc:rights');
    const doc = await produced(await run(await fixture(), { title: 'Renamed Title', touchDates: false }));

    const packet = readXmpText(doc) ?? '';
    expect(readXmp(doc)?.readable, 'the packet is still XML').toBe(true);
    // What the form wrote.
    expect(readXmp(doc)?.title).toBe('Renamed Title');
    // What it must not have taken away.
    expect(packet, 'dc:rights was dropped').toContain('(c) 2026 ACME');
    expect(packet, 'pdf:PDFVersion was dropped').toContain('pdf:PDFVersion="1.7"');
    expect(packet, 'xmp:CreateDate was dropped').toContain('xmp:CreateDate');
    expect(packet, 'xmp:MetadataDate was dropped').toContain('xmp:MetadataDate');
    expect(packet, 'dc:language was dropped').toContain('en-GB');
    // And the packet did not grow a second copy of the title.
    expect(packet.match(/<dc:title>/g) ?? []).toHaveLength(1);
  }, 120_000);

  it('keeps the packet alone when syncing is off, so the disagreement is the user’s choice', async () => {
    const doc = await produced(await run(await fixture(), { title: 'Only Info', syncXmp: false, touchDates: false }));
    expect(readInfo(doc).title).toBe('Only Info');
    expect(readXmp(doc)?.title, 'the packet was rewritten anyway').toBe('Original title');
  }, 120_000);

  it('never writes an empty property, and keeps one only the packet holds', async () => {
    // Chunk c3 refined this: the property is dropped when *neither* store holds a
    // value (an empty `<rdf:li>` is a title a reader prefers over `/Info`), but a
    // value the packet holds on its own is the document's current value — a save
    // that typed nothing has to keep it, not delete it.
    const doc = await produced(await run(await fixture({ title: undefined, lang: '' }), { author: 'Only Author', touchDates: false }));
    const packet = readXmpText(doc) ?? '';
    expect(readInfo(doc).title, 'the control: this file has no /Title').toBeUndefined();
    expect(packet, 'the packet-only title was deleted by a blank box').toContain('Original title');
    expect(packet, 'an empty dc:title reader-trusted titles stay blank').not.toContain('<dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\"></rdf:li>');
    expect(packet, 'a dc:language neither store declares disagrees with /Lang').not.toContain('dc:language');
  }, 120_000);

  it('carries the typed language into dc:language', async () => {
    const doc = await produced(await run(await fixture(), { docLanguage: 'ja', touchDates: false }));
    expect(readInfo(doc).lang).toBe('ja');
    expect(readXmpText(doc) ?? '', 'dc:language still says en-GB').toContain('<rdf:li>ja</rdf:li>');
  }, 120_000);
});

describe('edit-metadata dates are typed, written as PDF dates, and refused when unreadable', () => {
  it('writes both typed dates and leaves them when nothing is typed', async () => {
    const typed = await produced(await run(await fixture(), {
      creationDate: '2026-03-04T05:06:07Z', modDate: '2026-03-05', touchDates: true,
    }));
    const info = readInfo(typed);
    // The typed instant survives the trip, written back in the file's own form
    // (`D:` with the runtime's offset) rather than as the ISO text typed. UTC
    // writes the `Z` the format allows for zero offset, which a UTC CI runner
    // produces and a local machine does not — both are the same instant.
    expect(info.creationDate).toMatch(/^D:\d{14}([+-]\d\d'\d\d'|Z)$/);
    expect(parsePdfDateParts(info.creationDate!)?.date.toISOString()).toBe('2026-03-04T05:06:07.000Z');
    expect(parsePdfDateParts(info.modDate!)?.date.toISOString()).toBe('2026-03-05T00:00:00.000Z');
    // A typed ModDate wins over the "set to now" toggle, which is on here.
    expect(parsePdfDateParts(info.modDate!)?.date.toISOString()).not.toBe(undefined);

    const kept = await produced(await run(await fixture(), { title: 'no dates', touchDates: false }));
    expect(readInfo(kept).creationDate, 'the birthday moved').toBe('D:20260101010101Z');
    expect(readInfo(kept).modDate, 'ModDate moved with the toggle off').toBe('D:20260102010101Z');
  }, 120_000);

  it('refuses text that is not a date, and keeps the key it would have replaced', async () => {
    await expect(run(await fixture(), { modDate: 'not-a-date' })).rejects.toThrow(/is not a date/);
    expect(parsePdfDateParts('not-a-date')).toBeUndefined();
  }, 120_000);
});
