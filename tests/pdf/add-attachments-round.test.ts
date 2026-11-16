/**
 * `add-attachments` judged on the bytes it saved, for the names a person's file
 * really has (round 061).
 *
 * The writer trims a name and `removeAttachments` matches case-insensitively, so
 * the stored key for `" note.txt "` is `note.txt` and a stored `note.txt` is what a
 * `Notes.txt` replaces. The tool's own diff used to compare the names exactly and
 * so reported the opposite of both: a padded name came with *"\" note.txt \" is not
 * in the saved file"* over a file that carries it, and a recased one was counted as
 * new while the count stayed put and the sentence still said "up from 1". Every
 * case below reads the saved attachment list back, so the sentence is only ever
 * checked against what the file really holds.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { PDFDocument } from '@maxwbh/pdf-lib';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { listAttachments } from '@/lib/pdf/core/attachments';
import type { ToolValues } from '@/lib/pdf/tools/types';

beforeAll(() => {
  Object.defineProperty(GlobalWorkerOptions, 'workerSrc', { configurable: true, get: () => '', set: () => {} });
});

const bytes = (text: string): Uint8Array => Uint8Array.from([...new TextEncoder().encode(text)]);
const latin1 = new TextDecoder('latin1');

const enclosure = (name: string, text: string) => ({
  name, mimeType: 'text/plain', bytes: bytes(text), size: text.length,
});

/** One page, plus the enclosures the case needs already stored. */
async function source(stored: string[] = ['notes.txt']): Promise<File> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  for (const name of stored) await doc.attach(bytes(`original ${name}`), name);
  return new File([await doc.save()], 'claim.pdf', { type: 'application/pdf' });
}

interface Outcome {
  outputs: { blob: Blob }[];
  message: string;
  warnings: string[];
}

async function run(values: ToolValues, input: File): Promise<{ outcome: Outcome; stored: [string, string][] }> {
  const outcome = (await runPdfTool({
    toolId: 'add-attachments', files: [input], values, onProgress: () => {}, onLog: () => {},
  })) as unknown as Outcome;
  const saved = await PDFDocument.load(new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()));
  return {
    outcome,
    stored: listAttachments(saved).map((entry) => [entry.name, latin1.decode(entry.bytes)]),
  };
}

describe('add-attachments speaks about the keys the file really holds', () => {
  it('treats a padded name as the stored name it becomes, with no false warning', async () => {
    const { outcome, stored } = await run({ files: [enclosure(' notes.txt ', 'padded')] }, await source());
    expect(stored).toEqual([['notes.txt', 'padded']]);
    expect(outcome.message).toMatch(/Embedded 0 new file\(s\) and replaced 1/);
    expect(outcome.message).not.toMatch(/up from/);
    expect(outcome.warnings.join(' ')).not.toMatch(/is not in the saved file/);
  }, 120_000);

  it('reports a recased name as the replacement it is, and not as growth', async () => {
    const { outcome, stored } = await run({ files: [enclosure('Notes.txt', 'recased')] }, await source());
    expect(stored).toEqual([['Notes.txt', 'recased']]);
    expect(outcome.message).toMatch(/Embedded 0 new file\(s\) and replaced 1/);
    expect(outcome.message).not.toMatch(/up from/);
    expect(outcome.warnings).toEqual([]);
  }, 120_000);

  it('says "down from" when a case-insensitive replace removes two stored keys', async () => {
    // Two keys differing only by case coexist only when one run carried both (a
    // later run's case-insensitive removal folds them).
    const first = await run({ files: [enclosure('A.txt', 'upper'), enclosure('a.txt', 'lower')] }, await source());
    expect(first.stored.map(([name]) => name)).toEqual(['notes.txt', 'A.txt', 'a.txt']);
    const third = await run(
      { files: [enclosure('a.txt', 'again')] },
      new File([await first.outcome.outputs[0].blob.arrayBuffer()], 'claim.pdf', { type: 'application/pdf' }),
    );
    expect(third.stored.map(([name]) => name)).toEqual(['notes.txt', 'a.txt']);
    expect(third.outcome.message).toMatch(/carries 2 attachment\(s\), down from 3/);
    expect(third.outcome.message).not.toMatch(/up from/);
  }, 180_000);

  it('still calls a genuinely new name new, and counts the growth', async () => {
    const { outcome, stored } = await run({ files: [enclosure('other.txt', 'fresh')] }, await source());
    expect(stored).toEqual([['notes.txt', 'original notes.txt'], ['other.txt', 'fresh']]);
    expect(outcome.message).toMatch(/Embedded 1 new file\(s\)/);
    expect(outcome.message).not.toMatch(/replaced/);
    expect(outcome.message).toMatch(/carries 2 attachment\(s\), up from 1/);
    expect(outcome.warnings).toEqual([]);
  }, 120_000);

  it('counts a case-colliding run as one replacement and one addition', async () => {
    const { outcome, stored } = await run(
      { files: [enclosure('A.txt', 'upper'), enclosure('a.txt', 'lower')] },
      await source(['a.txt']),
    );
    expect(stored.map(([name]) => name)).toEqual(['A.txt', 'a.txt']);
    expect(outcome.message).toMatch(/Embedded 1 new file\(s\) and replaced 1/);
    expect(outcome.message).toMatch(/up from 1/);
    expect(outcome.warnings).toEqual([]);
  }, 120_000);
});
