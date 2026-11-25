/**
 * CHUNK c4 — `add-attachments` NAME-SHAPE BATTERY (measurement probe, not a pin).
 *
 * Drives the shipped tool through `runPdfTool` once per name shape and writes every
 * produced PDF plus a JSON census to `/tmp/lane-security/c4/battery`, so readers
 * that share no code with the writer can judge the bytes
 * (`docs/research/attach-names-check.py`). Temporary instrument for the audit —
 * the pinned regression tests are `tests/pdf/add-attachments-round.test.ts`.
 *
 * Shapes come from the format (ISO 32000-1 §7.11.3: `/F` is a PDFDocEncoding-ish
 * ASCII name, `/UF` is the Unicode one, `/Desc` a text string) and from what a
 * browser can hand the field: `File.name` is a basename, so a slash can only reach
 * the writer through the harness, while a backslash, a `(`, an astral code point,
 * a newline and an empty string are all things a picker or a drop can produce.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { PDFDocument } from '@maxwbh/pdf-lib';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { addAttachments, listAttachments, md5Hex } from '@/lib/pdf/core/attachments';
import type { ToolValues } from '@/lib/pdf/tools/types';

const FIXTURES = resolve(process.cwd(), 'tests/fixtures/attachments');

beforeAll(() => {
  Object.defineProperty(GlobalWorkerOptions, 'workerSrc', { configurable: true, get: () => '', set: () => {} });
});

const OUT_DIR = process.env.C4_BATTERY_DIR || '/tmp/lane-security/c4/battery';

/** Distinct bytes per case so an extraction is proved by its SHA-256, not its length. */
const payload = (seed: number, length = 137): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (seed * 31 + i * 7 + (i >> 3)) & 0xff);

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

interface Shape {
  case: string;
  /** The enclosure names this run hands the tool. */
  names?: string[];
  /** One-name shorthand. */
  name?: string;
  note?: string;
  mime?: string;
  bytes?: Uint8Array;
  /** Pre-existing enclosures in the document the run attaches into. */
  stored?: string[];
  /** Attach into a committed foreign fixture instead of the generated one. */
  docFile?: string;
  /** Payloads per name, when a case needs them to differ. */
  payloads?: number[];
}

const SHAPES: Shape[] = [
  { case: 'ascii', name: 'note.txt' },
  { case: 'latin1', name: 'notes-éè.txt' },
  { case: 'astral', name: 'über-𓂀.txt' },
  { case: 'cjk', name: '中文报告.pdf' },
  { case: 'rtl', name: 'تقرير سنة.txt' },
  { case: 'combining', name: 'café-accent.txt' },
  { case: 'parens', name: 'report (draft) (2).txt' },
  { case: 'unbalanced-open', name: 'report (draft.txt' },
  { case: 'unbalanced-close', name: 'report draft).txt' },
  { case: 'backslash', name: 'back\\slash.txt' },
  { case: 'mixed-escape', name: 'a\\(b).txt' },
  { case: 'angle-brackets', name: '<emit>.txt' },
  { case: 'square-braces', name: '[x]{y}.txt' },
  { case: 'hash-percent', name: '100%#sure.txt' },
  { case: 'double-quote', name: 'say"hi".txt' },
  { case: 'semicolon', name: 'a;b,c=d.txt' },
  { case: 'leading-dot', name: '.hidden' },
  { case: 'trailing-dot-space', name: 'spaced . ' },
  { case: 'padded', name: ' note.txt ' },
  { case: 'path-slash', name: 'reports/q3 summary.txt' },
  { case: 'dos-name', name: 'CON.txt' },
  { case: 'long-name', name: `${'very-long-name-'.repeat(12)}end.txt` },
  { case: 'newline-name', name: 'line\nbreak.txt' },
  { case: 'no-extension', name: 'README' },
  { case: 'zero-byte-payload', name: 'empty.bin', bytes: new Uint8Array(0) },
  { case: 'empty-name', name: '' },
  { case: 'space-only-name', name: '   ' },
  { case: 'dot-name', name: '.' },
  { case: 'dotdot-name', name: '..' },
  { case: 'same-name-two-in-run', names: ['dup.txt', 'dup.txt'], payloads: [101, 202] },
  { case: 'case-collide-in-run', names: ['Case.txt', 'case.txt'], payloads: [11, 22] },
  { case: 'replace-stored', name: 'notes.txt', stored: ['notes.txt', 'other.txt'] },
  { case: 'replace-stored-recase', name: 'NOTES.txt', stored: ['notes.txt', 'other.txt'] },
  { case: 'description-unicode', name: 'noted.txt', note: 'Enclosure: éè 中文 (see §2) \\ back' },
  { case: 'mime-declared', name: 'picture.dat', mime: 'image/png' },
  { case: 'no-mime-no-ext', name: 'mystery', mime: '' },
  // A browser reports `File.type === ''` for anything it does not recognise, so the
  // extension guess is the only thing that can fill `/Subtype` here.
  { case: 'empty-mime-known-ext', name: 'notes.txt', mime: '' },
  // Characters whose UTF-16 code unit's low byte is `(` 0x28, `)` 0x29 or `\` 0x5c —
  // Arabic `ة` is U+0629, CJK `Ḩ`-range and Hangul names hit these constantly.
  { case: 'lowbyte-rparen', name: 'سنة٩.txt', mime: '' },
  { case: 'lowbyte-lparen', name: '报告Ḩ.txt', mime: '' },
  { case: 'lowbyte-backslash', name: '报告.txt', mime: '' },
  { case: 'tilde-caret', name: 'a^b~c.txt', mime: '' },
  { case: 'del-and-tab', name: 'ab\tc.txt', mime: '' },
  { case: 'two-files-one-note', names: ['first.txt', 'second.txt'], note: 'Board pack' },
  { case: 'big-compressible', name: 'zeros.bin', bytes: new Uint8Array(1 << 20) },
  { case: 'big-random', name: 'random.bin', bytes: Uint8Array.from({ length: 1 << 20 }, (_, i) => (i * 2654435761 >>> 13) & 0xff) },

  // Replace-vs-keep inside the shapes other writers produce: the name being replaced
  // lives in a `/Kids` leaf, in a catalogue `/AF` array, behind a page annotation, in
  // an inline (direct) FileSpec, twice under one name, and under a UTF-16BE key.
  { case: 'into-kids-tree-replace', docFile: 'kids-tree.pdf', name: 'alpha.bin' },
  { case: 'into-kids-tree-add', docFile: 'kids-tree.pdf', name: 'brand-new.bin' },
  { case: 'into-af-only-replace', docFile: 'af-only.pdf', name: 'af-only.bin' },
  { case: 'into-af-no-name', docFile: 'af-no-name.pdf', name: 'attachment-1.bin' },
  { case: 'into-annot-only-replace', docFile: 'annot-only.pdf', name: 'annot-only.bin' },
  { case: 'into-mupdf-inline-replace', docFile: 'mupdf-native.pdf', name: 'note.txt' },
  { case: 'into-same-name-two-nodes', docFile: 'same-name-two-nodes.pdf', name: 'dup.bin' },
  { case: 'into-catalog-and-annot', docFile: 'catalog-and-annot.pdf', name: 'catalog-and-annot.bin' },
  { case: 'into-unicode-key', docFile: 'unicode-name.pdf', name: 'über-𓂀.txt' },
  { case: 'into-zero-byte-replace', docFile: 'zero-byte.pdf', name: 'empty.bin', bytes: payload(900, 12) },
  { case: 'into-path-name', docFile: 'path-name.pdf', name: 'reports/q3 summary.txt' },
  { case: 'into-dos-unix', docFile: 'ef-dos-unix.pdf', name: 'dos.bin' },
];

interface CaseResult {
  case: string;
  requested: string[];
  note?: string;
  stored: string[];
  message: string;
  warnings: string[];
  error?: string;
  out?: string;
  outBytes?: number;
  sourceBytes: number;
  pages?: number;
  /** The bytes the run handed the writer, by the name the writer keys on. */
  expected: { name: string; size: number; sha256: string; md5: string[] }[];
  /** What the app's own reader says the saved file carries. */
  carried: {
    name: string;
    filename?: string;
    mime?: string;
    size: number;
    description?: string;
    creationDate?: string;
    modificationDate?: string;
    checksum?: string;
    sha256: string;
  }[];
}

/** A three-page-ish base carrying the enclosures the case names. */
async function sourcePdf(stored: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  for (const name of stored) await doc.attach(payload(7), name);
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

async function runCase(shape: Shape): Promise<CaseResult> {
  const stored = shape.stored ?? [];
  const source = shape.docFile ? new Uint8Array(readFileSync(resolve(FIXTURES, shape.docFile))) : await sourcePdf(stored);
  const input = new File([source as unknown as BlobPart], 'claim.pdf', { type: 'application/pdf' });
  const names = shape.names ?? [shape.name ?? ''];
  const many = names.map((name, index) => ({
    name,
    bytes: shape.bytes ?? payload(40 + shape.case.length + 13 * (shape.payloads?.[index] ?? 0) + index),
    mime: shape.mime ?? 'application/octet-stream',
  }));
  const base: CaseResult = {
    case: shape.case,
    requested: names,
    ...(shape.note === undefined ? {} : { note: shape.note }),
    stored,
    message: '',
    warnings: [],
    sourceBytes: source.length,
    expected: many.map((file) => ({
      name: file.name, size: file.bytes.length, sha256: sha(file.bytes), md5: [md5Hex(file.bytes)],
    })),
    carried: [],
  };
  const values: ToolValues = {
    files: many.map((file) => ({ name: file.name, mimeType: file.mime, bytes: file.bytes, size: file.bytes.length })),
    ...(shape.note === undefined ? {} : { description: shape.note }),
  };
  let outcome;
  try {
    outcome = (await runPdfTool({
      toolId: 'add-attachments', files: [input], values, onProgress: () => {}, onLog: () => {},
    })) as unknown as { outputs: { blob: Blob }[]; message: string; warnings: string[]; pages: number };
  } catch (error) {
    return { ...base, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
  const bytes = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
  const file = `${OUT_DIR}/${shape.case}.pdf`;
  writeFileSync(file, bytes);
  // The document the run began from, so the judge can compare page count and ink.
  writeFileSync(`${OUT_DIR}/${shape.case}-src.pdf`, source);
  const reread = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  return {
    ...base,
    message: outcome.message,
    warnings: outcome.warnings,
    pages: outcome.pages,
    out: file,
    outBytes: bytes.length,
    carried: listAttachments(reread).map((entry) => ({
      name: entry.name,
      ...(entry.filename === undefined ? {} : { filename: entry.filename }),
      ...(entry.mimeType === undefined ? {} : { mime: entry.mimeType }),
      size: entry.size,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      ...(entry.creationDate === undefined ? {} : { creationDate: entry.creationDate }),
      ...(entry.modificationDate === undefined ? {} : { modificationDate: entry.modificationDate }),
      ...(entry.checksum === undefined ? {} : { checksum: entry.checksum }),
      sha256: sha(entry.bytes),
    })),
  };
}

describe('add-attachments name-shape battery (c4 measurement)', () => {
  beforeAll(() => mkdirSync(OUT_DIR, { recursive: true }));

  it('writes the census for every shape', async () => {
    const results: CaseResult[] = [];
    for (const shape of SHAPES) results.push(await runCase(shape));
    writeFileSync(`${OUT_DIR}/battery.json`, `${JSON.stringify(results, null, 1)}\n`);
    expect(results).toHaveLength(SHAPES.length);
  }, 900_000);

  // The same writer with `useObjectStreams: false`, so the serialized `/F` literal is
  // readable in the raw bytes: proof of *how* a paren or an Arabic low byte breaks the
  // file, not just that a reader reports an error.
  it('writes the raw serialization for the breaking shapes', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    await addAttachments(doc, [
      { name: 'plain.txt', bytes: payload(1), mimeType: 'text/plain' },
      { name: 'report (draft.txt', bytes: payload(2), mimeType: 'text/plain' },
      { name: 'über-𓂀.txt', bytes: payload(3), mimeType: 'text/plain' },
      { name: 'تقرير سنة.txt', bytes: payload(4), mimeType: 'text/plain' },
      { name: 'back\\slash.txt', bytes: payload(5), mimeType: 'text/plain' },
    ]);
    const bytes = new Uint8Array(await doc.save({ useObjectStreams: false }));
    writeFileSync(`${OUT_DIR}/raw.pdf`, bytes);
    const text = Buffer.from(bytes).toString('latin1');
    const lines = text.split('\n').filter((line) => /\/(F|UF|Type Filespec)\b/.test(line) || line.includes('Filespec'));
    writeFileSync(`${OUT_DIR}/raw-filespec-lines.txt`, `${lines.join('\n')}\n`);
    expect(lines.length).toBeGreaterThan(0);
  }, 300_000);
});
