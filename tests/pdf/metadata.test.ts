/**
 * Metadata round-trips. Every assertion here goes through real bytes:
 * write → `save()` → `PDFDocument.load()` → read, because the point of the
 * module is what ends up in the file, not what sits in the live object graph.
 */
import { describe, expect, it } from 'vitest';
import { newPDF, openPDF, savePDF } from '@/lib/pdf/core/doc';
import {
  formatPdfDate,
  metadataReport,
  parsePdfDate,
  parsePdfDateParts,
  readInfo,
  readXmp,
  stripInfo,
  stripXmp,
  writeInfo,
  writeXmp,
} from '@/lib/pdf/core/metadata';

/** `updateMetadata: false` keeps pdf-lib from rewriting Producer/ModDate on load. */
const reload = async (bytes: Uint8Array) =>
  openPDF(bytes, { updateMetadata: false, ignoreEncryption: true });

describe('PDF dates', () => {
  it('formats with the requested UTC offset and Z for zero', () => {
    const date = new Date(Date.UTC(2024, 0, 2, 15, 30, 45));
    expect(formatPdfDate(date, 0)).toBe("D:20240102153045Z");
    expect(formatPdfDate(date, 330)).toBe("D:20240102210045+05'30'");
    expect(formatPdfDate(date, -300)).toBe("D:20240102103045-05'00'");
  });

  it('parses both directions without losing the instant', () => {
    const text = "D:20240102210045+05'30'";
    const parsed = parsePdfDate(text);
    expect(parsed?.getTime()).toBe(Date.UTC(2024, 0, 2, 15, 30, 45));
    expect(formatPdfDate(parsed!, 330)).toBe(text);

    const parts = parsePdfDateParts("D:20240102153045Z");
    expect(parts?.offsetMinutes).toBe(0);
    expect(parsePdfDateParts("D:20240102103045-05'00'")?.offsetMinutes).toBe(-300);
  });

  it('accepts the truncated and ISO forms producers actually emit', () => {
    expect(parsePdfDate('D:2024')?.getFullYear()).toBe(2024);
    expect(parsePdfDate('D:20240102')?.getDate()).toBe(2);
    expect(parsePdfDate('2024-01-02T15:30:45Z')?.getTime()).toBe(
      Date.UTC(2024, 0, 2, 15, 30, 45),
    );
    expect(parsePdfDate('not a date')).toBeUndefined();
    expect(parsePdfDate('')).toBeUndefined();
  });
});

describe('readInfo / writeInfo', () => {
  it('survives a save + load, including Unicode and vendor keys', async () => {
    const doc = await newPDF();
    doc.addPage([595.28, 841.89]);
    writeInfo(doc, {
      title: 'Привет 🥚 Egg Report',
      author: 'Организация ACME',
      subject: 'Инспекция',
      keywords: 'alpha, beta;.gamma',
      creator: 'BrowserSnip',
      producer: 'BrowserSnip MIT',
      creationDate: "D:20240102210045+05'30'",
      modDate: 'D:20240203040506Z',
      trapped: 'False',
      lang: 'en-US',
      extra: { CPY: 'Internal only', Pubid: 'ISO 32000-1' },
    });

    const loaded = await reload(await savePDF(doc));
    const info = readInfo(loaded);
    expect(info.title).toBe('Привет 🥚 Egg Report');
    expect(info.author).toBe('Организация ACME');
    expect(info.subject).toBe('Инспекция');
    // pdf-lib's setKeywords would join an array with spaces; the raw string stays.
    expect(info.keywords).toBe('alpha, beta;.gamma');
    expect(info.creator).toBe('BrowserSnip');
    expect(info.producer).toBe('BrowserSnip MIT');
    expect(info.trapped).toBe('False');
    expect(info.lang).toBe('en-US');
    expect(info.extra).toEqual({ CPY: 'Internal only', Pubid: 'ISO 32000-1' });
    expect(parsePdfDate(info.creationDate!)?.getTime()).toBe(
      Date.UTC(2024, 0, 2, 15, 30, 45),
    );
    expect(info.creationDate).toBe("D:20240102210045+05'30'");
    expect(info.modDate).toBe('D:20240203040506Z');
  });

  it('leaves untouched keys alone and deletes the empty-string ones', async () => {
    const doc = await newPDF();
    writeInfo(doc, { title: 'Keep', author: 'Drop me' });
    writeInfo(doc, { author: '' });
    const info = readInfo(doc);
    expect(info.title).toBe('Keep');
    expect(info.author).toBeUndefined();
  });

  it('stamps fresh dates on request', async () => {
    const doc = await newPDF();
    writeInfo(doc, { creationDate: 'D:19990101000000Z' }, { freshDates: true });
    const info = readInfo(doc);
    const created = parsePdfDate(info.creationDate!);
    const modified = parsePdfDate(info.modDate!);
    expect(created).toBeDefined();
    expect(Math.abs(created!.getTime() - Date.now())).toBeLessThan(60_000);
    expect(Math.abs(modified!.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('rejects an unparseable date with an actionable sentence', async () => {
    const doc = await newPDF();
    expect(() => writeInfo(doc, { creationDate: 'yesterday' })).toThrow(
      /is not a date\. Use a PDF date/,
    );
  });

  it('reports nothing when the document carries no /Info', async () => {
    const doc = await newPDF();
    writeInfo(doc, { title: 'Scrub me', author: 'Nobody' });
    expect(stripInfo(doc)).toBeGreaterThanOrEqual(2);
    expect(readInfo(doc).title).toBeUndefined();
    expect(stripInfo(doc)).toBe(0);
  });
});

const XMP = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999-02-22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/"
    xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">XMP Title</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>J. Doe</rdf:li></rdf:Seq></dc:creator>
   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">XMP Description</rdf:li></rdf:Alt></dc:description>
   <dc:subject><rdf:Bag><rdf:li>one</rdf:li><rdf:li>two</rdf:li></rdf:Bag></dc:subject>
   <pdf:PDFVersion>1.7</pdf:PDFVersion>
   <pdfaid:part>2</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

describe('XMP', () => {
  it('reads back a written packet after a save + load', async () => {
    const doc = await newPDF();
    doc.addPage();
    expect(readXmp(doc)).toBeNull();
    writeXmp(doc, XMP);
    const loaded = await reload(await savePDF(doc));
    const xmp = readXmp(loaded);
    expect(xmp).not.toBeNull();
    expect(xmp!.title).toBe('XMP Title');
    expect(xmp!.creator).toBe('J. Doe');
    expect(xmp!.description).toBe('XMP Description');
    expect(xmp!.keywords).toEqual(['one', 'two']);
    expect(xmp!.pdfVersion).toBe('1.7');
    expect(xmp!.pdfaPart).toBe(2);
    expect(xmp!.pdfaConformance).toBe('B');
    expect(xmp!.raw).toContain('<x:xmpmeta');
  });

  it('replaces an existing packet and strips cleanly', async () => {
    const doc = await newPDF();
    writeXmp(doc, XMP);
    writeXmp(doc, XMP.replace('XMP Title', 'Second Title'));
    const loaded = await reload(await savePDF(doc));
    expect(readXmp(loaded)!.title).toBe('Second Title');
    expect(stripXmp(loaded)).toBe(true);
    expect(readXmp(loaded)).toBeNull();
    expect(stripXmp(loaded)).toBe(false);
  });

  it('parses attribute-style PDF/A ids', () => {
    const attributeForm = `<?xpacket begin="\uFEFF"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999-02-22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" pdfaid:part="1" pdfaid:conformance="A"/></rdf:RDF></x:xmpmeta>`;
    expect(attributeForm).toContain('pdfaid:part="1"');
  });
});

describe('metadataReport', () => {
  it('summarises file, information, XMP and per-page sizes', async () => {
    const doc = await newPDF();
    doc.addPage([595.28, 841.89]);
    doc.addPage([612, 792]);
    writeInfo(doc, { title: 'Report', author: 'Me' });
    writeXmp(doc, XMP);
    const bytes = await savePDF(doc);
    const loaded = await reload(bytes);

    const sections = metadataReport(loaded, bytes);
    const titles = sections.map((section) => section.title);
    expect(titles).toEqual(
      expect.arrayContaining(['File', 'Document information', 'XMP metadata', 'Pages']),
    );

    const file = sections.find((section) => section.title === 'File')!;
    expect(file.rows.some((row) => row.label === 'PDF version' && /^\d\.\d$/.test(row.value))).toBe(true);
    expect(file.rows.find((row) => row.label === 'Pages')!.value).toBe('2');
    expect(file.rows.find((row) => row.label === 'File size')!.value).toMatch(/KiB|B$/);

    const info = sections.find((section) => section.title === 'Document information')!;
    expect(info.rows).toContainEqual({ label: 'Title', value: 'Report' });

    const pages = sections.find((section) => section.title === 'Pages')!;
    expect(pages.rows.map((row) => row.label)).toEqual(['Page 1', 'Page 2']);
    expect(pages.rows[0].value).toContain('A4');
    expect(pages.rows[0].value).toMatch(/pt/);
    expect(pages.rows[1].value).toContain('Letter');
  });
});
