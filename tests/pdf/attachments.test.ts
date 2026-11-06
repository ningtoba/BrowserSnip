/**
 * Attachment round-trips.
 *
 * `PDFDocument#attach` only writes the `/EmbeddedFiles` name tree during
 * `flush()`, so the interesting cases are (a) visible after `addAttachments`
 * without a save and (b) still visible after a real save + load. Both are
 * asserted, together with byte-exact payloads, the MD5 `/CheckSum` this module
 * adds, and removal that leaves nothing behind.
 */
import { describe, expect, it } from 'vitest';
import { newPDF, openPDF, savePDF, PDFName, PDFArray } from '@/lib/pdf/core/doc';
import {
  addAttachments,
  listAttachments,
  md5Hex,
  removeAttachments,
  replaceAttachment,
} from '@/lib/pdf/core/attachments';
import { parsePdfDate } from '@/lib/pdf/core/metadata';

const utf8 = (text: string) => new Uint8Array([...text].map((c) => c.charCodeAt(0)));

const reload = (bytes: Uint8Array) =>
  openPDF(bytes, { updateMetadata: false, ignoreEncryption: true });

const NOTES = utf8('hello');
const BINARY = Uint8Array.from(Array.from({ length: 256 }, (_, i) => i));

async function docWithPages(pages = 2) {
  const doc = await newPDF();
  for (let i = 0; i < pages; i++) doc.addPage([595.28, 841.89]);
  return doc;
}

describe('addAttachments / listAttachments', () => {
  it('sees newly attached files without a save, because it flushes', async () => {
    const doc = await docWithPages();
    const count = await addAttachments(doc, [
      { name: 'notes.txt', bytes: NOTES, mimeType: 'text/plain', description: 'Say hello' },
    ]);
    expect(count).toBe(1);
    const [entry] = listAttachments(doc);
    expect(entry.name).toBe('notes.txt');
    expect(entry.mimeType).toBe('text/plain');
  });

  it('survives a save + load with bytes, checksum, dates and description', async () => {
    const doc = await docWithPages();
    await addAttachments(doc, [
      { name: 'notes.txt', bytes: NOTES, mimeType: 'text/plain', description: 'Say hello' },
      { name: 'table.bin', bytes: BINARY },
    ]);
    const loaded = await reload(await savePDF(doc));
    const entries = listAttachments(loaded);
    expect(entries.map((entry) => entry.name)).toEqual(['notes.txt', 'table.bin']);

    const notes = entries[0];
    expect(Array.from(notes.bytes)).toEqual(Array.from(NOTES));
    expect(notes.size).toBe(NOTES.length);
    expect(notes.filename).toBe('notes.txt');
    expect(notes.description).toBe('Say hello');
    expect(notes.mimeType).toBe('text/plain');
    // The MD5 the PDF spec stores in /Params /CheckSum.
    expect(notes.checksum).toBe('5d41402abc4b2a76b9719d911017c592');
    expect(notes.checksum).toBe(md5Hex(NOTES));
    expect(parsePdfDate(notes.creationDate!)).toBeInstanceOf(Date);
    expect(parsePdfDate(notes.modificationDate!)).toBeInstanceOf(Date);

    const binary = entries[1];
    expect(Array.from(binary.bytes)).toEqual(Array.from(BINARY));
    expect(binary.checksum).toBe(md5Hex(BINARY));
    expect(binary.mimeType).toBeUndefined();
  });

  it('replaces a repeated name instead of duplicating the tree key', async () => {
    const doc = await docWithPages();
    await addAttachments(doc, [{ name: 'a.txt', bytes: utf8('first') }]);
    await addAttachments(doc, [{ name: 'a.txt', bytes: utf8('second') }]);
    const loaded = await reload(await savePDF(doc));
    const entries = listAttachments(loaded);
    expect(entries).toHaveLength(1);
    expect(new TextDecoder().decode(entries[0].bytes)).toBe('second');
  });

  it('reports attachments as zero when the document has none', async () => {
    const doc = await docWithPages(1);
    expect(listAttachments(doc)).toEqual([]);
    expect(removeAttachments(doc, ['ghost.txt'])).toBe(0);
  });
});

describe('replaceAttachment', () => {
  it('swaps the payload and keeps the description and MIME type', async () => {
    const doc = await docWithPages();
    await addAttachments(doc, [
      { name: 'spec.pdf', bytes: utf8('%PDF-1.4 old'), mimeType: 'application/pdf', description: 'The spec' },
    ]);
    expect(await replaceAttachment(doc, 'spec.pdf', utf8('%PDF-2.0 new'))).toBe(true);
    const loaded = await reload(await savePDF(doc));
    const [entry] = listAttachments(loaded);
    expect(new TextDecoder().decode(entry.bytes)).toBe('%PDF-2.0 new');
    expect(entry.mimeType).toBe('application/pdf');
    expect(entry.description).toBe('The spec');
    expect(entry.checksum).toBe(md5Hex(utf8('%PDF-2.0 new')));
    expect(entry.size).toBe(utf8('%PDF-2.0 new').length);
  });

  it('returns false for a name that is not attached', async () => {
    const doc = await docWithPages(1);
    expect(await replaceAttachment(doc, 'missing.txt', utf8('x'))).toBe(false);
  });
});

describe('removeAttachments', () => {
  it('splices the name tree, the /AF array and the stream objects', async () => {
    const doc = await docWithPages();
    await addAttachments(doc, [
      { name: 'keep.txt', bytes: utf8('keep') },
      { name: 'drop.txt', bytes: utf8('drop') },
    ]);
    expect(removeAttachments(doc, ['drop.txt'])).toBe(1);
    expect(listAttachments(doc).map((entry) => entry.name)).toEqual(['keep.txt']);

    const loaded = await reload(await savePDF(doc));
    expect(listAttachments(loaded).map((entry) => entry.name)).toEqual(['keep.txt']);
    const af = loaded.catalog.lookupMaybe(PDFName.of('AF'), PDFArray);
    expect(af?.size()).toBe(1);
  });

  it('matches names case-insensitively and removes several at once', async () => {
    const doc = await docWithPages();
    await addAttachments(doc, [
      { name: 'Alpha.txt', bytes: utf8('a') },
      { name: 'Beta.txt', bytes: utf8('b') },
      { name: 'Gamma.txt', bytes: utf8('c') },
    ]);
    expect(removeAttachments(doc, ['alpha.txt', 'BETA.TXT'])).toBe(2);
    const loaded = await reload(await savePDF(doc));
    expect(listAttachments(loaded).map((entry) => entry.name)).toEqual(['Gamma.txt']);
  });
});
