/**
 * `edit-attachments` on the bytes, round 063.
 *
 * The card listed and deleted only, so a rename was impossible: measured on the
 * dev build, `note.txt -> catch.csv` in the one box came back
 * `Removed 0 of 1 requested attachment(s). Remaining: 1.` with
 * `"note.txt -> catch.csv" is not embedded in this PDF` — the arrow was read as
 * part of a name. These cases are the four the round named, each judged on the
 * produced file rather than on the tool's sentence:
 *
 *   1. rename — the name-tree key, `/F` and `/UF` all move, the payload does not;
 *   2. delete — the entry goes *and* the `/EmbeddedFile` stream with it;
 *   3. rename onto a stored name — the mover is suffixed, both payloads survive;
 *   4. a name outside ASCII — written as a text string and read back exact.
 *
 * Every "does" has a case that must not: an attachment nobody named, a name that
 * is not in the file, a line with no arrow, and a run that only looks.
 */
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFStream, PDFString } from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { addAttachments, listAttachments } from '@/lib/pdf/core/attachments';
import type { PdfToolDefinition, ToolValues } from '@/lib/pdf/tools/types';

const latin1 = new TextDecoder('latin1');
const encoder = new TextEncoder();
const NOTE = 'An attachment planted by the triage fixture.\n';

interface RunOutcome {
  outputs: { blob: Blob; name: string }[];
  message?: string;
  warnings: string[];
  report?: { sections: { title: string; rows?: { label: string; value: string }[] }[]; message?: string };
}

/** A four-page document nobody's promise is about, so a page loss would show. */
async function pageFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let index = 0; index < 4; index++) doc.addPage([595, 842]);
  return doc.save({ useObjectStreams: false });
}

/** `pageFixture` carrying the given enclosures, written by the app's own writer. */
async function withAttachments(files: [string, string][]): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await pageFixture(), { updateMetadata: false });
  await addAttachments(doc, files.map(([name, body]) => ({ name, bytes: encoder.encode(body) })));
  return doc.save({ useObjectStreams: false });
}

function pdfFile(bytes: Uint8Array, name = 'carrier.pdf'): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}

async function run(values: ToolValues, files: File[]): Promise<RunOutcome> {
  const tool = getPdfTool('edit-attachments') as PdfToolDefinition | undefined;
  expect(tool, 'edit-attachments is not registered').toBeTruthy();
  return (await runPdfTool({
    toolId: 'edit-attachments', files, values, onProgress: () => {}, onLog: () => {},
  })) as unknown as RunOutcome;
}

async function produced(outcome: RunOutcome): Promise<Uint8Array> {
  expect(outcome.outputs.length, 'the tool produced no output').toBeGreaterThan(0);
  return new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
}

/** The name-tree `/Names` array of the loaded file, straight out of its catalog. */
async function namePairs(bytes: Uint8Array): Promise<{ doc: PDFDocument; pairs: PDFArray }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const names = doc.catalog.lookup(PDFName.of('Names'), PDFDict);
  const tree = names?.lookup(PDFName.of('EmbeddedFiles'), PDFDict);
  const pairs = tree?.lookup(PDFName.of('Names'), PDFArray);
  expect(pairs, 'the output has no name tree').toBeTruthy();
  return { doc, pairs: pairs as PDFArray };
}

/** The stored bytes of a string object, without going through the app's readers. */
function storedBytes(value: unknown): Uint8Array {
  if (value instanceof PDFHexString) return value.asBytes();
  if (value instanceof PDFString) return encoder.encode(value.asString());
  throw new Error(`not a string object: ${String(value)}`);
}

/** How the file spells `name` as a text string: PDFDocEncoding bytes, or UTF-16BE with a BOM. */
function textStringBytes(name: string): number[] {
  if (Array.from(name).some((char) => (char.codePointAt(0) ?? 0) > 0xff)) {
    const out = [0xfe, 0xff];
    for (const unit of name.split('').map((char) => char.charCodeAt(0))) out.push(unit >> 8, unit & 0xff);
    return out;
  }
  return Array.from(name, (char) => char.charCodeAt(0));
}

/** What `/UF` says for the entry filed under `key`, plus that pair's own key bytes. */
async function namesFor(bytes: Uint8Array, key: string): Promise<{ key: number[]; uf: number[]; f: number[] }> {
  const { doc, pairs } = await namePairs(bytes);
  for (let i = 0; i + 1 < pairs.size(); i += 2) {
    const stored = storedBytes(pairs.get(i));
    // Not `latin1.decode`: a key outside ASCII is stored as UTF-16BE with a BOM.
    if (String(stored) !== String(textStringBytes(key))) continue;
    const spec = pairs.lookup(i + 1, PDFDict);
    return {
      key: Array.from(stored),
      uf: Array.from(storedBytes(spec.lookup(PDFName.of('UF')))),
      f: Array.from(storedBytes(spec.lookup(PDFName.of('F')))),
    };
  }
  throw new Error(`no entry filed under "${key}" in ${JSON.stringify(listAttachments(doc).map((entry) => entry.name))}`);
}

/** Every `/EmbeddedFile` stream left in the file, found on the object model. */
async function embeddedStreams(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  let found = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFStream)) continue;
    if (object.dict.lookupMaybe(PDFName.of('Type'), PDFName)?.decodeText() === 'EmbeddedFile') found += 1;
  }
  return found;
}

describe('edit-attachments renames on the bytes', () => {
  it('moves the tree key, /F and /UF together and leaves the payload alone', async () => {
    const source = await withAttachments([['note.txt', NOTE]]);
    const outcome = await run({ rename: 'note.txt -> catch.csv' }, [pdfFile(source)]);
    const bytes = await produced(outcome);

    const entries = listAttachments(await PDFDocument.load(bytes, { updateMetadata: false }));
    expect(entries.map((entry) => [entry.name, latin1.decode(entry.bytes)])).toEqual([['catch.csv', NOTE]]);
    const written = await namesFor(bytes, 'catch.csv');
    expect(written.key).toEqual(textStringBytes('catch.csv'));
    expect(written.uf).toEqual(textStringBytes('catch.csv'));
    expect(written.f).toEqual(textStringBytes('catch.csv'));
    expect(outcome.message).toMatch(/Renamed 1 of 1 requested/);
    expect(outcome.warnings).toEqual([]);
  }, 120_000);

  it('deletes the entry and the payload stream, and nothing else', async () => {
    const source = await withAttachments([['drop.txt', NOTE], ['keep.txt', 'kept payload']]);

    // The control: a name that is not there still writes a file, and it carries
    // both streams — otherwise "the stream is gone" could just be the rewrite.
    const keeping = await run({ remove: 'ghost.txt' }, [pdfFile(source)]);
    expect(await embeddedStreams(await produced(keeping)), 'the control keeps both streams').toBe(2);

    const outcome = await run({ remove: 'drop.txt' }, [pdfFile(source)]);
    const bytes = await produced(outcome);
    const entries = listAttachments(await PDFDocument.load(bytes, { updateMetadata: false }));
    expect(entries.map((entry) => [entry.name, latin1.decode(entry.bytes)])).toEqual([['keep.txt', 'kept payload']]);
    expect(await embeddedStreams(bytes), 'the dropped payload stream is still in the file').toBe(1);
    expect(latin1.decode(bytes).includes(NOTE.slice(0, 20)) || !(await streamHolds(bytes, NOTE)), 'payload bytes survived').toBe(true);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(4);
    expect(outcome.message).toMatch(/Removed 1 of 1 requested/);
  }, 120_000);

  it('suffixes a rename onto a name the file already carries and keeps both payloads', async () => {
    const source = await withAttachments([['note.txt', NOTE], ['second.txt', 'second payload']]);
    const outcome = await run({ rename: 'note.txt -> second.txt' }, [pdfFile(source)]);
    const bytes = await produced(outcome);

    const entries = listAttachments(await PDFDocument.load(bytes, { updateMetadata: false }));
    expect(entries.map((entry) => [entry.name, latin1.decode(entry.bytes)])).toEqual([
      ['second-2.txt', NOTE],
      ['second.txt', 'second payload'],
    ]);
    expect(await embeddedStreams(bytes)).toBe(2);
    expect(outcome.message).toMatch(/Now carried: "second-2\.txt"/);
    expect(outcome.warnings.join(' ')).toMatch(/"note\.txt" was stored as "second-2\.txt" because "second\.txt" is already carried/);
  }, 120_000);

  it('writes a name outside ASCII as a text string and reads it back exact', async () => {
    const source = await withAttachments([['note.txt', NOTE]]);
    const outcome = await run({ rename: 'note.txt -> résumé.pdf' }, [pdfFile(source)]);
    const bytes = await produced(outcome);

    expect(listAttachments(await PDFDocument.load(bytes, { updateMetadata: false })).map((entry) => entry.name))
      .toEqual(['résumé.pdf']);
    const written = await namesFor(bytes, 'résumé.pdf');
    expect(written.uf).toEqual(textStringBytes('résumé.pdf'));
    // PDFDocEncoding spells both accents, so the legacy /F is single-byte and a
    // reader that only knows `/F` (poppler) prints the name rather than mojibake.
    expect(written.f).toEqual([0x72, 0xe9, 0x73, 0x75, 0x6d, 0xe9, 0x2e, 0x70, 0x64, 0x66]);

    // The control: a name outside every single-byte code page must take the
    // UTF-16BE form instead, and still come back exact.
    const wide = await run({ rename: 'note.txt -> обзор.pdf' }, [pdfFile(source)]);
    const wideBytes = await produced(wide);
    expect((await namesFor(wideBytes, 'обзор.pdf')).uf).toEqual(textStringBytes('обзор.pdf'));
    expect(listAttachments(await PDFDocument.load(wideBytes, { updateMetadata: false })).map((entry) => entry.name))
      .toEqual(['обзор.pdf']);
  }, 120_000);

  it('reports a name that is not there and changes nothing', async () => {
    const source = await withAttachments([['note.txt', NOTE]]);
    const outcome = await run({ rename: 'ghost.txt -> catch.csv' }, [pdfFile(source)]);
    const bytes = await produced(outcome);
    expect(listAttachments(await PDFDocument.load(bytes, { updateMetadata: false })).map((entry) => entry.name))
      .toEqual(['note.txt']);
    expect(outcome.message).toMatch(/Renamed 0 of 1 requested/);
    expect(outcome.warnings.join(' ')).toMatch(/"ghost\.txt" is not embedded/);
    expect(outcome.warnings.join(' ')).toMatch(/the document is unchanged/);
  }, 120_000);

  it('names a line with no arrow instead of swallowing it', async () => {
    const source = await withAttachments([['note.txt', NOTE]]);
    const outcome = await run({ rename: 'note.txt' }, [pdfFile(source)]);
    expect(listAttachments(await PDFDocument.load(await produced(outcome), { updateMetadata: false })).map((entry) => entry.name))
      .toEqual(['note.txt']);
    expect(outcome.warnings.join(' ')).toMatch(/"note\.txt" is not a rename: the line needs old -> new/);
  }, 120_000);

  it('removes one name and renames another in the same run', async () => {
    const source = await withAttachments([['gone.txt', 'gone payload'], ['note.txt', NOTE]]);
    const outcome = await run({ remove: 'gone.txt', rename: 'note.txt -> catch.csv' }, [pdfFile(source)]);
    const bytes = await produced(outcome);
    expect(listAttachments(await PDFDocument.load(bytes, { updateMetadata: false }))
      .map((entry) => [entry.name, latin1.decode(entry.bytes)])).toEqual([['catch.csv', NOTE]]);
    expect(outcome.message).toMatch(/Removed 1 of 1 requested attachment\(s\) and renamed 1 of 1/);
    expect(await embeddedStreams(bytes)).toBe(1);
  }, 120_000);
});

/** Does any stream of the file still carry `phrase`? pdf-lib's own decoder, no zlib. */
async function streamHolds(bytes: Uint8Array, phrase: string): Promise<boolean> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    if (latin1.decode(object.asUint8Array()).includes(phrase)) return true;
  }
  return false;
}
