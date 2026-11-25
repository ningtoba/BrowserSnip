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
import { PDFDocument, PDFName, PDFRawStream } from '@maxwbh/pdf-lib';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { addAttachments, listAttachments } from '@/lib/pdf/core/attachments';
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

/**
 * The c4 name battery (instrument `tests/pdf/c4-add-names-battery.test.ts`,
 * judged by MuPDF, libqpdf, pypdf and poppler in `docs/research/attach-names-check.py`)
 * caught the writer's own escape in the bytes: `doc.attach` serialises the `/F`
 * name as a literal string, and the fork copies a literal's characters out
 * UNESCAPED ("we will not bother escaping them"). So `report (draft.txt` let its
 * `(` swallow the rest of the dictionary, and Arabic `ة` — U+0629, low byte `)` —
 * closed the string early. Six of 45 shapes produced a PDF MuPDF refused with
 * `bad xref`, qpdf read an unnamed Filespec or lost the entry whole, while the
 * app's own reader — it prefers `/UF` — kept listing the name and the card kept
 * promising "Readers with an attachments panel will list them". The cure is the
 * module's own `nameString` hex encoder, the call `renameAttachments` has always
 * used: a hex string cannot end early whatever the name holds.
 */
describe('add-attachments writes /F as hex so a bracket in a name cannot end it', () => {
  const payload = (seed: number): Uint8Array =>
    Uint8Array.from({ length: 48 }, (_, i) => (seed * 31 + i) & 0xff);

  const hexUtf16 = (name: string): string => {
    let hex = 'FEFF';
    for (let index = 0; index < name.length; index++) {
      hex += name.charCodeAt(index).toString(16).padStart(4, '0').toUpperCase();
    }
    return hex;
  };

  it('ships filespecs whose /F cannot break the file, with a healthy neighbour', async () => {
    const names = ['plain.txt', 'report (draft.txt', 'report draft).txt', 'back\\slash.txt', 'تقرير سنة.txt'];
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    await addAttachments(doc, names.map((name, index) => ({
      name, bytes: payload(index + 1), mimeType: 'text/plain',
    })));
    // Without object streams: the question here is what the serialised `/F`
    // literal actually looks like in the file, so it must stand in plaintext.
    const saved = new Uint8Array(await doc.save({ useObjectStreams: false }));
    const raw = latin1.decode(saved);
    expect(raw.match(/\/F \(/g) ?? []).toEqual([]);
    expect(raw.match(/\/F <[0-9A-Fa-f]+>/g)).toHaveLength(names.length);
    // The Arabic name's `/F` carries its code units whole — not truncated to
    // low bytes, where the `ة` became the `)` that ate the file. The plain
    // neighbour is one-byte hex, the spelling old readers expect.
    expect(raw).toContain(`/F <${hexUtf16('تقرير سنة.txt')}>`);
    expect(raw).toContain('/F <706C61696E2E747874>');
    // The re-parse gate: every name comes back as typed, payload intact.
    const back = await PDFDocument.load(saved, { ignoreEncryption: true, updateMetadata: false });
    const carried = new Map(listAttachments(back).map((entry) => [entry.name, latin1.decode(entry.bytes)]));
    expect([...carried.keys()].sort()).toEqual([...names].sort());
    names.forEach((name, index) => {
      expect(carried.get(name)).toBe(latin1.decode(payload(index + 1)));
    });
  }, 180_000);
});

/**
 * A browser hands the picker `File.type === ''` for every type it does not
 * recognise — any .csv, .txt, .dat, anything exotic (the c4 battery shapes
 * `empty-mime-known-ext` and `no-mime-no-ext`, mime:'' in `mime-declared`).
 * The tool used to pass that empty string straight to the writer, where
 * `mimeType ?? mimeForFile(name)` only falls through on null/undefined, so an
 * empty string VETOED the extension inference: the embedded stream shipped
 * `/Subtype /` — a name token with nothing in it — where `shot.png` could have
 * been named `image/png` for every reader that prints an attachment list. The
 * tool now folds '' to undefined so the inference runs, and an unknown
 * extension leaves `/Subtype` off, not named empty.
 */
describe('add-attachments lets an empty File.type reach the extension guess', () => {
  /** The `/Subtype` of every EmbeddedFile stream, in creation order. */
  async function embeddedSubtypes(blob: Blob): Promise<(string | null)[]> {
    const doc = await PDFDocument.load(new Uint8Array(await blob.arrayBuffer()), {
      ignoreEncryption: true, updateMetadata: false,
    });
    const subs: (string | null)[] = [];
    for (const [, object] of doc.context.enumerateIndirectObjects()) {
      if (object instanceof PDFRawStream && String(object.dict.lookup(PDFName.of('Type'))) === '/EmbeddedFile') {
        const subtype = object.dict.lookup(PDFName.of('Subtype'));
        subs.push(subtype === undefined ? null : String(subtype));
      }
    }
    return subs;
  }

  it('names the type an extension knows and omits the one it does not', async () => {
    const typed = { name: 'shot.png', mimeType: '', bytes: bytes('png-bytes'), size: 9 };
    const unknown = { name: 'mystery', mimeType: '', bytes: bytes('whoknows'), size: 8 };
    const declared = { name: 'kept.dat', mimeType: 'application/octet-stream', bytes: bytes('kept'), size: 4 };
    const outcome = (await runPdfTool({
      toolId: 'add-attachments', files: [await source([])],
      values: { files: [typed, unknown, declared] }, onProgress: () => {}, onLog: () => {},
    })) as unknown as Outcome;
    const subs = await embeddedSubtypes(outcome.outputs[0].blob);
    // No `/Subtype /` empty-name anywhere: the typeless image is inferred from
    // its extension, the typeless mystery names nothing, the declared type survives.
    expect(subs).not.toContain('/');
    expect(subs.sort()).toEqual(['/application#2Foctet-stream', '/image#2Fpng', null]);
  }, 180_000);
});
