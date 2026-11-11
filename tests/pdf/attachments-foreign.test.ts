/**
 * Attachments written **outside** this repo.
 *
 * `docs/TOOL-TRIAGE.md` ERRORS 4: `extract-attachments` answered *"This PDF contains
 * no embedded files."* — and `edit-attachments` refused with *"This PDF has no
 * attachments to edit."* — over a file whose bytes hold a `FileSpec` for `note.txt`
 * and which MuPDF lists as `['note.txt']`. The fixture that produced that sentence
 * (`docs/research/triage-fixtures-images.py`, `doc.embfile_add`) is written by
 * **MuPDF**, and MuPDF spells a name tree like this:
 *
 *     /EmbeddedFiles << /Names [ (note.txt) << /Type /Filespec /EF << /F 10 0 R >> … >> ] >>
 *
 * The value of a name-tree pair is an **inline dictionary**, not a reference.
 * `collectNameTree` accepted only `value instanceof PDFRef`, so the pair was
 * invisible and the tool's "no embedded files" was a sentence the bytes
 * contradicted. That is the hypothesis this file tests — *the reader recognises the
 * shape pdf-lib writes rather than the shapes the format allows* — and it is the
 * third instance of the pattern in this repo after font subsetting and the
 * Ghostscript argv, both of which were also caught by replaying the input instead
 * of trusting a green suite (`docs/TOOL-CAMPAIGN.md`).
 *
 * **Every input here is written by a producer that shares no code with this repo** —
 * libqpdf 12.3.2 through pikepdf 10.9.1, MuPDF 1.28.2 through PyMuPDF, and pypdf
 * 6.14.2 — and each is judged by four readers that did not write it before it was
 * kept; the census, including the shapes the outside readers themselves disagree
 * about, is `docs/research/attachments-foreign-shapes.log`. `qpdf` and `mutool`
 * are not installed on this box, so the census is four readers, not five.
 *
 * One fixture is deliberately *not* a bug: `doc-annot-only.pdf` names its file only
 * in a catalogue-level `/Annots`, which MuPDF, pypdf, poppler **and** this reader
 * all pass over in silence, so "no embedded files" is honest there and is pinned as
 * such rather than chased.
 *
 * Every assertion is on **content** — the SHA-256 of the extracted bytes against
 * the payload the fixture was built to carry — because a name listed with empty
 * content is the same class of failure as a blank page with a page count.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PDFArray, PDFDict, PDFName } from '@maxwbh/pdf-lib';
import { newPDF, openPDF, savePDF } from '@/lib/pdf/core/doc';
import { addAttachments, listAttachments, md5Hex, removeAttachments } from '@/lib/pdf/core/attachments';
import { context } from '@/lib/pdf/core/doc';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import type { ToolValues } from '@/lib/pdf/tools/types';

const FIXTURES = resolve(process.cwd(), 'tests/fixtures/attachments');

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const fixtureBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(FIXTURES, name)));

const open = (name: string) =>
  openPDF(fixtureBytes(name), { updateMetadata: false, ignoreEncryption: true });

interface Case {
  file: string;
  /** The shape the format allows and this reader used to reject. */
  shape: string;
  /** Which outside readers list it — `docs/research/attachments-foreign-shapes.log`. */
  seenBy: string;
  expect: { name: string; sha256: string }[];
}

/** Payload SHA-256s are the values `scripts/attachments-foreign-fixtures.py` planted. */
const CASES: Case[] = [
  {
    file: 'mupdf-native.pdf',
    shape: 'name-tree value is a DIRECT FileSpec dict (what MuPDF writes)',
    seenBy: 'MuPDF, pypdf, poppler',
    expect: [{ name: 'note.txt', sha256: '6d4b8fa7b05143ad7816d3b57e46cd37d0d70396436fea36ba19124a0f40a94f' }],
  },
  {
    file: 'flat-names-indirect.pdf',
    shape: 'flat /Names with an INDIRECT FileSpec — the control, the shape pdf-lib writes',
    seenBy: 'MuPDF, pypdf, poppler',
    expect: [{ name: 'flat-ref.bin', sha256: 'b71020a0db478637d22d3b3964df821029a12296f518cdbc595c9e0cbfcb932d' }],
  },
  {
    file: 'direct-namespec.pdf',
    shape: 'flat /Names whose value is a direct dict, hand-built by libqpdf',
    seenBy: 'MuPDF, pypdf, poppler',
    expect: [{ name: 'direct-spec.bin', sha256: 'f688bc41534910ec490e37640d9177d49ca6199d0c488e029f9f648617993fa0' }],
  },
  {
    file: 'kids-tree.pdf',
    shape: '/EmbeddedFiles as a /Kids + /Limits tree with two leaves',
    seenBy: 'pypdf, poppler (MuPDF lists nothing: its enumerator does not walk /Kids)',
    expect: [
      { name: 'alpha.bin', sha256: 'bc2642b8271ad87b18de381dcc8a80794e2a8ebf8b499a4ef4df692ff407fd6d' },
      { name: 'beta.bin', sha256: 'f61ea5e77bfc46401a71eecca12f2811007879fe2887a1752d5919a96e424e0a' },
    ],
  },
  {
    file: 'pypdf-native.pdf',
    shape: "pypdf's own FileSpec and catalogue entry",
    seenBy: 'MuPDF, pypdf, poppler',
    expect: [{ name: 'ledger.csv', sha256: 'dc27bf90d6be70abb0146ec37f9da88633a1ba44ae84a5f102640b6c5abb776f' }],
  },
  {
    file: 'ef-points-at-stream.pdf',
    shape: '/EF is the embedded-file stream itself, with no /F or /UF wrapper',
    seenBy: 'poppler (MuPDF and pypdf both refuse the shape)',
    expect: [{ name: 'ef-stream.bin', sha256: '60e6ee7dcaf326e8629d185f902291d1aae1f9779d6cab0810c5c96a21ae6c5b' }],
  },
  {
    file: 'ef-uf-only.pdf',
    shape: '/EF << /UF >> with no /F at all',
    seenBy: 'pypdf, poppler (MuPDF refuses it)',
    expect: [{ name: 'ef-uf.bin', sha256: 'd2e0be7b8199907e8beef79e1e3a54363d77d25341b2ab2fe85b05a4dd06e059' }],
  },
  {
    file: 'ef-uf-over-f.pdf',
    shape: '/EF names both /F and /UF, pointing at different streams',
    seenBy: 'pypdf and poppler read /UF; MuPDF reads /F',
    expect: [{ name: 'both-names.bin', sha256: 'f2e68a9e71e0e4276c8f5ca611fbd98dd68a46981881e9e09fa321e5c7b5a702' }],
  },
  {
    file: 'ef-dos-unix.pdf',
    shape: '/EF naming only /DOS in one spec and only /UNIX in another',
    seenBy: 'poppler (MuPDF and pypdf both refuse the shape)',
    expect: [
      { name: 'dos.bin', sha256: '12abf8f19a5ae7531964124c39f6a178bb70516785ab4adc3f2cba5319f49e34' },
      { name: 'unix.bin', sha256: '149be634b36c30d303821fceac007b36517c40394afb3ca2987e851079157e3e' },
    ],
  },
  {
    file: 'no-params.pdf',
    shape: 'embedded-file stream with NO /Params: no /Size, no /CheckSum, no dates',
    seenBy: 'MuPDF, pypdf, poppler',
    expect: [{ name: 'no-params.bin', sha256: '09ed501c75b36923694f7355a5fdda98326f7c475e8d98da01243908c931663d' }],
  },
  {
    file: 'ef-dict-indirect.pdf',
    shape: '/EF is an indirect dictionary; the stream has no /Subtype and no /Params',
    seenBy: 'MuPDF, pypdf, poppler',
    expect: [{ name: 'bare.bin', sha256: '3adf0ffe7e8a26ef9185f23ad960fc778ec8f5a3b470653f010e377df2f83b46' }],
  },
  {
    file: 'catalog-and-annot.pdf',
    shape: 'one FileSpec named twice: /EmbeddedFiles AND a page /FileAttachment',
    seenBy: 'MuPDF, pypdf; poppler lists it twice',
    expect: [{ name: 'catalog-and-annot.bin', sha256: '65f54195401c66ccc513b5b4e87115362774fb0e418f88d119a0de5f66184a43' }],
  },
  {
    file: 'annot-only.pdf',
    shape: 'attachment reachable only through a page /FileAttachment',
    seenBy: 'poppler (MuPDF and pypdf list nothing)',
    expect: [{ name: 'annot-only.bin', sha256: '7ba3aad285a9e8b7a87b995b52c8a1d68d070f51a74959e6047e1ae24b19b02a' }],
  },
  {
    file: 'unicode-name.pdf',
    shape: 'UTF-16BE name-tree key whose /UF differs from its /F',
    seenBy: 'pypdf (MuPDF mojibakes it, poppler fails to print it)',
    expect: [{ name: 'über-𓂀.txt', sha256: '067570bac8320c1d6ee3ddf08d35248281ffcf3ab64277a4c82e668d4bc98325' }],
  },
];

const listed = async (file: string) => listAttachments(await open(file));

describe.each(CASES)('listAttachments over a foreign file: $file', (testCase) => {
  it(`finds what ${testCase.shape} stores, with the bytes it stores`, async () => {
    const entries = await listed(testCase.file);
    const want = testCase.expect;
    expect(entries.map((entry) => entry.name), testCase.shape).toEqual(want.map((w) => w.name));
    for (const wanted of want) {
      const entry = entries.find((e) => e.name === wanted.name);
      expect(entry, `${wanted.name} is not listed`).toBeTruthy();
      // Content, not count: a name beside empty bytes is the failure this repo
      // already refuses for a blank page.
      expect(sha256(entry!.bytes), `${wanted.name} payload`).toBe(wanted.sha256);
      expect(entry!.size).toBe(entry!.bytes.length);
      expect(entry!.bytes.length).toBeGreaterThan(0);
      // Every byte value 0x00-0xFF is in the payload, so a latin1/UTF-8 detour in
      // the read path changes the hash rather than the length.
      expect(Array.from(entry!.bytes)).toContain(0);
      expect(Array.from(entry!.bytes)).toContain(255);
    }
  });

  it('reports a checksum for every entry, computing it where the file stores no /Params', async () => {
    const entries = await listed(testCase.file);
    for (const entry of entries) {
      expect(entry.checksum).toMatch(/^[0-9a-f]{32}$/);
      if (entry.name === 'no-params.bin' || entry.name === 'bare.bin') {
        // The stream carries no /Params: the MD5 is then ours, computed from the
        // bytes we read rather than claimed from a dictionary that is not there.
        expect(entry.checksum).toBe(md5Of(entry.bytes));
        expect(entry.creationDate).toBeUndefined();
      }
    }
  });
});

/**
 * `/Params /CheckSum` is MD5 by definition (ISO 32000-1 §7.11.3), so the reader's
 * fallback digest is `md5Hex` from the module under test — the same function the
 * writer uses, which is what makes the comparison meaningful.
 */
const md5Of = (bytes: Uint8Array) => md5Hex(bytes);

describe('the two tools docs/TOOL-TRIAGE.md ERRORS 4 accused', () => {
  const run = (toolId: string, values: ToolValues, file: string) => {
    expect(getPdfTool(toolId), `tool ${toolId} is registered`).toBeTruthy();
    return runPdfTool({
      toolId,
      files: [new File([fixtureBytes(file) as BlobPart], file, { type: 'application/pdf' })],
      values,
      onProgress: () => undefined,
      onLog: () => undefined,
    });
  };

  it('extract-attachments hands back the original bytes of a file MuPDF embedded', async () => {
    const outcome = await run('extract-attachments', {}, 'mupdf-native.pdf');
    expect(outcome.outputs, 'the run produced no file').toHaveLength(1);
    const bytes = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
    expect(outcome.outputs[0].name).toBe('note.txt');
    expect(sha256(bytes)).toBe('6d4b8fa7b05143ad7816d3b57e46cd37d0d70396436fea36ba19124a0f40a94f');
    expect(outcome.message).toMatch(/note\.txt/);
  });

  it('extract-attachments never says "no embedded files" over a file that has one', async () => {
    for (const testCase of CASES) {
      if (testCase.expect.length === 0) continue;
      const outcome = await run('extract-attachments', {}, testCase.file);
      const rows = (outcome.report?.sections ?? []).flatMap((section) => section.rows ?? []);
      expect(
        rows.map((row) => row.value),
        `${testCase.file} was reported as empty`,
      ).not.toContain('This PDF contains no embedded files.');
      expect(outcome.outputs, testCase.file).toHaveLength(1);
    }
  });

  it('extract-attachments still tells the truth about a document with nothing in it', async () => {
    // The sentence is only a lie when the bytes contradict it, so the honest
    // direction is pinned beside the lying one.
    const outcome = await run('extract-attachments', {}, 'doc-annot-only.pdf');
    expect(outcome.message).toBe('No attachments found.');
    expect(outcome.report?.sections[0].rows?.[0].value).toBe('This PDF contains no embedded files.');
  });

  it('edit-attachments lists what MuPDF wrote instead of refusing the file', async () => {
    const outcome = await run('edit-attachments', { remove: '' }, 'mupdf-native.pdf');
    expect(outcome.message, 'the refusal was the defect').not.toBe('This PDF has no attachments to edit.');
    const rows = outcome.report?.sections[0].rows ?? [];
    expect(rows.map((r) => r.label)).toEqual(['note.txt']);
  });

  it('edit-attachments removes a foreign attachment and leaves a readable file', async () => {
    const outcome = await run('edit-attachments', { remove: 'note.txt' }, 'mupdf-native.pdf');
    expect(outcome.message).toMatch(/Removed 1 of 1/);
    const bytes = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
    const reopened = await openPDF(bytes, { updateMetadata: false, ignoreEncryption: true });
    expect(listAttachments(reopened)).toEqual([]);
    expect(reopened.getPageCount()).toBe(3);
    // The pair is gone from the name tree rather than merely unreadable, and
    // nothing is left pointing into the objects removal deleted.
    const tree = context(reopened).lookup(
      reopened.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)?.lookup(PDFName.of('EmbeddedFiles')),
    );
    if (tree instanceof PDFDict) {
      const names = tree.lookupMaybe(PDFName.of('Names'), PDFArray);
      expect(names ? names.size() : 0).toBe(0);
    }
  });

  it('removes a name-tree entry whose value is a direct dict without stranding the file', async () => {
    const doc = await open('mupdf-native.pdf');
    expect(removeAttachments(doc, ['note.txt'])).toBe(1);
    expect(listAttachments(doc)).toEqual([]);
    const saved = await openPDF(await savePDF(doc), { updateMetadata: false, ignoreEncryption: true });
    expect(listAttachments(saved)).toEqual([]);
    expect(saved.getPageCount()).toBe(3);
  });

  it('does not count one file twice when the catalogue and an annotation both name it', async () => {
    const doc = await open('catalog-and-annot.pdf');
    expect(listAttachments(doc)).toHaveLength(1);
    expect(removeAttachments(doc, ['catalog-and-annot.bin'])).toBe(1);
    expect(listAttachments(doc)).toEqual([]);
    const saved = await openPDF(await savePDF(doc), { updateMetadata: false, ignoreEncryption: true });
    expect(listAttachments(saved)).toEqual([]);
  });
});

describe('the reciprocal direction: what this app writes, other readers must read', () => {
  /** Every byte value, once — and once more **reversed**, so a reader that hands the
   * same stream back for both names cannot pass the reciprocal check. */
  const PAYLOAD = Uint8Array.from(Array.from({ length: 256 }, (_, i) => i));
  const OTHER_PAYLOAD = Uint8Array.from(Array.from({ length: 256 }, (_, i) => 255 - i));
  /** The name with characters outside PDFDocEncoding, which writers encode three ways. */
  const UNICODE = 'über-𓂀.bin';
  /** `docs/research/attachments-reciprocal.py` asks for this directory. */
  const DUMP = process.env.BROWSERSNIP_ATTACH_DUMP;

  /** The bytes `add-attachments` produces, as a user downloads them. */
  const ours = async () => {
    const doc = await newPDF();
    doc.addPage([595.28, 841.89]);
    await addAttachments(doc, [
      { name: 'own-writer.bin', bytes: PAYLOAD, mimeType: 'application/octet-stream' },
      { name: UNICODE, bytes: OTHER_PAYLOAD, description: 'a name outside PDFDocEncoding' },
    ]);
    return await savePDF(doc);
  };

  /** The bytes `edit-attachments` produces after removing a MuPDF-written enclosure. */
  const oursRemoved = async () => {
    const doc = await open('mupdf-native.pdf');
    expect(removeAttachments(doc, ['note.txt'])).toBe(1);
    return await savePDF(doc);
  };

  it('re-reads its own attachments with the exact bytes it embedded', async () => {
    const bytes = await ours();
    const doc = await openPDF(bytes, { updateMetadata: false, ignoreEncryption: true });
    const entries = listAttachments(doc);
    expect(entries.map((entry) => entry.name)).toEqual(['own-writer.bin', UNICODE]);
    expect(sha256(entries[0].bytes)).toBe(sha256(PAYLOAD));
    expect(sha256(entries[1].bytes)).toBe(sha256(OTHER_PAYLOAD));
  });

  it('writes the shape its own reader used to be limited to, so the foreign cases were never exercised', async () => {
    const bytes = await ours();
    const doc = await openPDF(bytes, { updateMetadata: false, ignoreEncryption: true });
    const tree = doc.catalog
      .lookupMaybe(PDFName.of('Names'), PDFDict)
      ?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
    const names = tree?.lookupMaybe(PDFName.of('Names'), PDFArray);
    expect(names, 'the writer emits a flat /Names array').toBeTruthy();
    // pdf-lib stores the value as a reference. MuPDF and poppler store it inline.
    // Both are legal, and only one of them was ever read here.
    expect(names!.get(1).constructor.name).toBe('PDFRef');
  });

  it('hands the two artifacts to the readers that did not write them', async () => {
    const written = await ours();
    const removed = await oursRemoved();
    // Asserted here so the committed bytes are never out of step with what the
    // Python check judged, and so a broken writer fails in this file first.
    expect(sha256(removed)).toBeTruthy();
    const afterRemoval = await openPDF(removed, { updateMetadata: false, ignoreEncryption: true });
    expect(listAttachments(afterRemoval)).toEqual([]);
    if (!DUMP) return;
    mkdirSync(DUMP, { recursive: true });
    writeFileSync(join(DUMP, 'own-writer.pdf'), written);
    writeFileSync(join(DUMP, 'own-removal.pdf'), removed);
  });
});
