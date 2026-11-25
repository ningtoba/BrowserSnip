/**
 * The properties report, judged by the file it claims to describe.
 *
 * Measured on the dev build over four fixtures (a full `/Info`, a file with none,
 * one whose values are all empty, and a hostile one): every property the file did
 * not hold was *absent from the panel* rather than named, a file with no `/Info`
 * at all was refused with the generic error, a value with a newline in it read
 * like a value with a space in it, a long key was ellipsised, dates were the raw
 * `D:` string with no human reading, an `/OpenAction`, linearisation and a
 * `/PieceInfo` were never mentioned, and an XMP packet that was not well-formed
 * XML (no `xmlns:rdf`, as MuPDF writes) printed a size and silently dropped its
 * `dc:title`.
 *
 * Each assertion below fails on the build before the fix, and the controls —
 * an untouched page, a key that *is* set — stay green in both states.
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { render, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from '@maxwbh/pdf-lib';
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFString, openPDF } from '@/lib/pdf/core/doc';
import { infoDict, metadataReport, toLocalBytes, type MetadataRow } from '@/lib/pdf/core/metadata';
import { ReportView } from '@/components/tools/pdf/shared/PdfToolPanel';

const FILE_SECTION = 'File';
const INFO_SECTION = 'Document information';
const XMP_SECTION = 'XMP metadata';

function rowsOf(sections: ReturnType<typeof metadataReport>, title: string): MetadataRow[] {
  const section = sections.find((candidate) => candidate.title === title);
  if (!section?.rows) throw new Error(`no ${title} section`);
  return section.rows;
}

function row(rows: MetadataRow[], label: string): string {
  const found = rows.find((candidate) => candidate.label === label);
  if (!found) throw new Error(`no ${label} row among ${rows.map((r) => r.label).join(', ')}`);
  return found.value;
}

/** A one-page document whose `/Info` holds exactly what the caller writes. */
async function docWith(
  write: (dict: PDFDict, doc: PDFDocument) => void,
  opts: { info?: boolean } = {},
): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  if (opts.info === false) {
    doc.context.trailerInfo.Info = undefined;
    return doc;
  }
  const dict = infoDict(doc, true);
  if (!dict) throw new Error('no /Info');
  write(dict, doc);
  return doc;
}

const bytesOf = (): Uint8Array => new TextEncoder().encode('%PDF-1.7\n');

describe('a property the file does not hold is named absent', () => {
  it('reports a file with no /Info dictionary instead of refusing it', async () => {
    const doc = await docWith(() => {}, { info: false });
    const sections = metadataReport(doc, bytesOf());
    const rows = rowsOf(sections, INFO_SECTION);
    expect(row(rows, 'Info dictionary')).toMatch(/^absent — the file carries no \/Info/);
    for (const label of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer']) {
      expect(row(rows, label), label).toBe(`not set — the file has no /${label}`);
    }
    expect(row(rows, 'Creation date')).toBe('not set — the file has no /CreationDate');
    expect(row(rows, 'Trapped')).toBe('not set — the file has no /Trapped');
    expect(row(rows, 'Language')).toMatch(/^not set — the catalogue carries no \/Lang/);
  });

  it('does not call a present-but-empty dictionary "no /Info entries"', async () => {
    const doc = await docWith((dict) => {
      for (const key of ['Title', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate']) {
        dict.set(PDFName.of(key), PDFString.of(''));
      }
      dict.set(PDFName.of('Author'), PDFString.of('Somebody'));
    });
    const rows = rowsOf(metadataReport(doc, bytesOf()), INFO_SECTION);
    expect(row(rows, 'Info dictionary')).toMatch(/^present, \d+ key\(s\)$/);
    expect(row(rows, 'Title')).toBe('present, empty — /Title is an empty string');
    expect(row(rows, 'Creation date')).toBe('present, empty — /CreationDate is an empty string');
    // The control: a key that IS set reads its value, not one of the absence sentences.
    expect(row(rows, 'Author')).toBe('Somebody');
  });
});

describe('a value is shown verbatim', () => {
  it('keeps a newline, and the padding around a value', async () => {
    const doc = await docWith((dict) => {
      dict.set(PDFName.of('Author'), PDFHexString.fromText('Line one\nLine two'));
      dict.set(PDFName.of('Title'), PDFHexString.fromText('  padded  '));
    });
    const rows = rowsOf(metadataReport(doc, bytesOf()), INFO_SECTION);
    expect(row(rows, 'Author')).toBe('Line one\nLine two');
    expect(row(rows, 'Title')).toBe('  padded  ');
  });

  it('keeps astral and CJK characters', async () => {
    const doc = await docWith((dict) => {
      dict.set(PDFName.of('Subject'), PDFHexString.fromText('Ünïcode ✓ 漢字 𓂀'));
    });
    const rows = rowsOf(metadataReport(doc, bytesOf()), INFO_SECTION);
    expect(row(rows, 'Subject')).toBe('Ünïcode ✓ 漢字 𓂀');
  });

  it('does not cut a long value, and lists a long custom key in full', async () => {
    const long = 'L'.repeat(1500);
    const key = 'Very'.repeat(30);
    const doc = await docWith((dict) => {
      dict.set(PDFName.of('Title'), PDFHexString.fromText(long));
      dict.set(PDFName.of(key), PDFHexString.fromText('custom value'));
    });
    const rows = rowsOf(metadataReport(doc, bytesOf()), INFO_SECTION);
    expect(row(rows, 'Title')).toHaveLength(1500);
    expect(rows.map((candidate) => candidate.label)).toContain(key);
    expect(row(rows, key)).toBe('custom value');
  });

  it('keeps a value that is not a string rather than dropping the key', async () => {
    const doc = await docWith((dict) => {
      dict.set(PDFName.of('Keywords'), PDFNumber.of(7));
    });
    expect(row(rowsOf(metadataReport(doc, bytesOf()), INFO_SECTION), 'Keywords'))
      .toMatch(/^present, but not a text object/);
  });
});

describe('dates are readable without losing the stored string', () => {
  it('renders a human date beside the raw D: string', async () => {
    const doc = await docWith((dict) => {
      dict.set(PDFName.of('CreationDate'), PDFString.of("D:20260102010101Z00'00'"));
    });
    const value = row(rowsOf(metadataReport(doc, bytesOf()), INFO_SECTION), 'Creation date');
    expect(value).toContain('2 January 2026 at 01:01:01 UTC');
    expect(value).toContain("stored as D:20260102010101Z00'00'");
  });

  it('keeps the raw text of a date that will not parse', async () => {
    const doc = await docWith((dict) => {
      dict.set(PDFName.of('ModDate'), PDFString.of('not-a-date'));
    });
    const value = row(rowsOf(metadataReport(doc, bytesOf()), INFO_SECTION), 'Modification date');
    expect(value).toBe('not a date this can read: not-a-date — shown exactly as the file stores it');
  });

  it('reads an offset into a wall clock and its zone', async () => {
    const doc = await docWith((dict) => {
      dict.set(PDFName.of('CreationDate'), PDFString.of("D:20260102010101+02'00'"));
    });
    const value = row(rowsOf(metadataReport(doc, bytesOf()), INFO_SECTION), 'Creation date');
    expect(value).toContain('2 January 2026 at 01:01:01 +02:00');
  });
});

describe('the structures a reviewer asks about by name', () => {
  it('names a linearisation dictionary it finds and its absence when there is none', async () => {
    const doc = await docWith(() => {});
    const plain = rowsOf(metadataReport(doc, bytesOf()), FILE_SECTION);
    expect(row(plain, 'Linearized')).toMatch(/^no —/);
    const linear = toLocalBytes(new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<< /Linearized 1 /L 4000 >>\nendobj\n'));
    expect(row(rowsOf(metadataReport(doc, linear), FILE_SECTION), 'Linearized')).toContain('linearisation dictionary');
  });

  it('says what an /OpenAction runs, and names the absence when there is none', async () => {
    const doc = await docWith(() => {});
    expect(row(rowsOf(metadataReport(doc, bytesOf()), FILE_SECTION), 'Open action')).toMatch(/^none —/);
    const js = doc.context.obj({ S: PDFName.of('JavaScript'), JS: PDFString.of("app.alert('probe')") });
    doc.catalog.set(PDFName.of('OpenAction'), doc.context.register(js));
    expect(row(rowsOf(metadataReport(doc, bytesOf()), FILE_SECTION), 'Open action'))
      .toContain("runs JavaScript on open: app.alert('probe')");
  });

  it('resolves a /GoTo open action to the sheet it lands on', async () => {
    const doc = await docWith(() => {});
    const second = doc.addPage([200, 200]);
    const destination = PDFArray.withContext(doc.context);
    destination.push(second.ref);
    destination.push(PDFName.of('Fit'));
    doc.catalog.set(PDFName.of('OpenAction'), doc.context.obj({ S: PDFName.of('GoTo'), D: destination }));
    expect(row(rowsOf(metadataReport(doc, bytesOf()), FILE_SECTION), 'Open action')).toBe('yes — jumps to page 2');
  });

  it('lists a page /PieceInfo and the absence when there is none', async () => {
    const doc = await docWith(() => {});
    expect(row(rowsOf(metadataReport(doc, bytesOf()), FILE_SECTION), 'Piece info')).toMatch(/^none —/);
    const layout = doc.context.obj({ Private: doc.context.obj({ Mark: PDFName.of('Made-up') }) });
    doc.getPages()[0].node.set(PDFName.of('PieceInfo'), doc.context.obj({ Layout: layout }));
    expect(row(rowsOf(metadataReport(doc, bytesOf()), FILE_SECTION), 'Piece info'))
      .toBe('declared page 1 (keys: Layout) — private data an application keeps for itself');
  });
});

describe('XMP', () => {
  const writePacket = (doc: PDFDocument, packet: string) => {
    doc.catalog.set(
      PDFName.of('Metadata'),
      doc.context.register(doc.context.stream(toLocalBytes(new TextEncoder().encode(packet)), { Type: 'Metadata', Subtype: 'XML' })),
    );
  };

  it('names an absent packet', async () => {
    const doc = await docWith(() => {});
    expect(row(rowsOf(metadataReport(doc, bytesOf()), XMP_SECTION), 'Packet'))
      .toBe('absent — the catalogue has no /Metadata stream');
  });

  it('shows declared presence and every property, not the XML', async () => {
    const doc = await docWith(() => {});
    writePacket(doc, "<?xpacket?><x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='http://www.w3.org/1999-02-22-rdf-syntax-ns#'>"
      + "<rdf:Description xmlns:dc='http://purl.org/dc/elements/1.1/'><dc:title><rdf:Alt>"
      + "<rdf:li xml:lang='x-default'>XMP title</rdf:li></rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta>");
    const rows = rowsOf(metadataReport(doc, bytesOf()), XMP_SECTION);
    expect(row(rows, 'Packet')).toMatch(/^present, \d+(\.\d+)? (B|KiB) at catalogue \/Metadata$/);
    // The property names as the packet declares them — the pane used to answer
    // `Title`/`Creator` rows and call everything the six names excluded absent.
    expect(row(rows, 'dc:title')).toBe('XMP title');
    expect(rows.some((candidate) => candidate.label === 'Title')).toBe(false);
    expect(rows.some((candidate) => candidate.value === 'not in the packet')).toBe(false);
    expect(rows.some((candidate) => candidate.value.includes('<rdf:'))).toBe(false);
  });

  it('reads the fields of a packet that is not well-formed XML, and says so', async () => {
    // MuPDF's shape: `rdf:` is used and never declared, so DOMParser emits a
    // parsererror. The values are still in the file.
    const doc = await docWith(() => {});
    writePacket(doc, "<x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:dc='http://purl.org/dc/elements/1.1/'>"
      + "<rdf:Description><dc:title><rdf:Alt><rdf:li xml:lang='x-default'>Broken packet title</rdf:li>"
      + '</rdf:Alt></dc:title></rdf:Description></rdf:RDF></x:xmpmeta>');
    const rows = rowsOf(metadataReport(doc, bytesOf()), XMP_SECTION);
    expect(row(rows, 'Well-formed')).toMatch(/^not XML this could parse/);
    expect(row(rows, 'Title')).toBe('Broken packet title');
  });

  it('survives a hostile 6 KiB packet', async () => {
    const doc = await docWith(() => {});
    writePacket(doc, "<x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='http://www.w3.org/1999-02-22-rdf-syntax-ns#'>"
      + "<rdf:Description xmlns:dc='http://purl.org/dc/elements/1.1/'><dc:description><rdf:Alt><rdf:li xml:lang='x-default'>"
      + 'Pad sentence. '.repeat(400) + '</rdf:li></rdf:Alt></dc:description></rdf:Description></rdf:RDF></x:xmpmeta>');
    const rows = rowsOf(metadataReport(doc, bytesOf()), XMP_SECTION);
    expect(row(rows, 'Packet')).toMatch(/KiB at catalogue/);
    expect(row(rows, 'dc:description').startsWith('Pad sentence.')).toBe(true);
  });
});

describe('the XMP section enumerates what a reader enumerates', () => {
  /** Property names pikepdf 10.9.1 (`Pdf.open_metadata()`) lists for each committed
   * carrier, rendered with the prefixes those packets declare. Produced by the same
   * enumeration sweep the c3 audit recorded (`/tmp/lane-security/c3/audit-view-metadata.md`
   * D1: the pane showed 6-7 of 23/21; the fallback path for broken packets listed MORE
   * than the parseable one). */
  const PDFTEX_PROPERTIES = [
    'dc:date', 'dc:format', 'dc:language', 'dc:rights', 'dc:source', 'dc:type',
    'pdf:Keywords', 'pdf:PDFVersion', 'pdf:Producer',
    'pdfaExtension:schemas',
    'prism:complianceProfile', 'prism:pageCount',
    'xmp:CreateDate', 'xmp:CreatorTool', 'xmp:MetadataDate', 'xmp:ModifyDate',
    'xmpMM:DocumentID', 'xmpMM:InstanceID', 'xmpMM:RenditionClass', 'xmpMM:VersionID',
    'xmpRights:Marked', 'xmpRights:WebStatement',
    'xmpTPg:NPages',
  ];
  const RICH_PROPERTIES = [
    'acme:JobId', 'acme:Vendor',
    'dc:creator', 'dc:description', 'dc:language', 'dc:rights', 'dc:subject', 'dc:title',
    'pdf:Keywords', 'pdf:Producer',
    'pdfaid:conformance', 'pdfaid:part',
    'xmp:CreateDate', 'xmp:CreatorTool', 'xmp:MetadataDate', 'xmp:ModifyDate',
    'xmpMM:DocumentID', 'xmpMM:InstanceID',
  ];

  async function packetRows(fixture: string): Promise<MetadataRow[]> {
    const bytes = new Uint8Array(readFileSync(join(process.cwd(), 'tests', 'fixtures', 'foreign', fixture)));
    const doc = await openPDF(bytes, { updateMetadata: false });
    return rowsOf(metadataReport(doc, bytes), XMP_SECTION);
  }

  it('lists every property of the real pdfTeX-derived packet, names and values', async () => {
    const rows = await packetRows('xmp-pdftex.pdf');
    const named = rows.filter((r) => r.label !== 'Packet').map((r) => r.label).sort();
    expect(named).toEqual([...PDFTEX_PROPERTIES].sort());
    // Values verbatim, not summaries of them (the audit's invisible list, judged read).
    const value = (label: string) => rows.find((r) => r.label === label)?.value ?? '';
    expect(value('xmpRights:WebStatement')).toBe('https://creativecommons.org/licenses/by/4.0/deed.en');
    expect(value('dc:rights')).toContain('Creative Commons');
    expect(value('xmpMM:DocumentID')).toMatch(/^uuid:/u);
    expect(value('pdf:Producer')).toContain('pdfTeX');
    expect(value('xmp:CreateDate')).toBe('2025-09-09T18:00:54-03:00');
    // A long structured value is admitted with its length, not a silent wall.
    expect(value('pdfaExtension:schemas')).toMatch(/\(\d+ characters\)$/u);
  });

  it('lists every property of the rich synthetic packet, arrays readable', async () => {
    const rows = await packetRows('xmp-rich.pdf');
    const named = rows.filter((r) => r.label !== 'Packet').map((r) => r.label).sort();
    expect(named).toEqual([...RICH_PROPERTIES].sort());
    const value = (label: string) => rows.find((r) => r.label === label)?.value ?? '';
    // Unknown prefixes render as the packet declares them; alts and bags flatten.
    expect(value('acme:Vendor')).toBe('Acme Corp');
    expect(value('dc:title')).toBe('Packet title (XMP only); Paket-Titel (de-DE)');
    expect(value('dc:subject')).toBe('alpha; beta');
    expect(value('dc:rights')).toBe('(c) 2026 ACME, all rights reserved');
    expect(value('xmpMM:InstanceID')).toBe('xmp.iid:DDDD-4444');
    // Control: the pane never shows raw XML, and absence is omission, not a lie —
    // this packet has no `pdf:PDFVersion`, and no row claims one.
    expect(value('pdf:PDFVersion')).toBe('');
    expect(rows.some((r) => r.value.includes('<rdf:'))).toBe(false);
  });
});

describe('the pane renders what the rows hold', () => {
  it('keeps whitespace in a value and does not ellipsise a label', () => {
    cleanup();
    const { container } = render(h(ReportView, {
      report: {
        message: '',
        sections: [{ title: 'Document information', rows: [{ label: 'Very'.repeat(30), value: 'Line one\nLine two' }] }],
      },
    }) as never);
    const value = container.querySelector('dd');
    const label = container.querySelector('dt');
    expect(value?.className).toContain('whitespace-pre-wrap');
    expect(value?.textContent).toBe('Line one\nLine two');
    expect(label?.className).toContain('break-words');
    expect(label?.className).not.toContain('truncate');
  });
});
