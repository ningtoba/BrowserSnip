/**
 * CHUNK c4 — `edit-attachments` battery (measurement probe, not a pin).
 *
 * Renames, deletions and the "look, do not touch" listing, driven through the shipped
 * runner over shapes from both writers: the foreign bank (flat `/Names` with an indirect
 * spec, a direct inline spec, a `/Kids` + `/Limits` tree, catalogue `/AF`, an unnamed
 * `/AF` entry, a page `/FileAttachment`, one file named twice, a UTF-16BE key, a path
 * name, a `/DOS`//`/UNIX` pair, a zero-byte payload) and this app's own writer's output
 * from the add battery.
 *
 * Every produced PDF goes to `C4_EDIT_DIR` with a JSON census of the card sentence, the
 * warnings and what this app's own reader sees; `docs/research/attach-edit-check.py`
 * judges the bytes with libqpdf/MuPDF/pypdf/poppler, including whether a deleted
 * attachment's OBJECT went with its pointer (the closure yardstick: no stream left in
 * the file holding the payload, nothing unreachable still counted) and whether the
 * untouched entries are byte-identical to the source.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { listAttachments } from '@/lib/pdf/core/attachments';
import { PDFDocument } from '@maxwbh/pdf-lib';
import type { ToolValues } from '@/lib/pdf/tools/types';

beforeAll(() => {
  Object.defineProperty(GlobalWorkerOptions, 'workerSrc', { configurable: true, get: () => '', set: () => {} });
});

const OUT_DIR = process.env.C4_EDIT_DIR || '/tmp/lane-security/c4/edit';
const FIXTURES = resolve(process.cwd(), 'tests/fixtures/attachments');
const ADD_BATTERY = process.env.C4_BATTERY_DIR || '/tmp/lane-security/c4/battery';

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

interface EditCase {
  case: string;
  /** Which document to open: a fixture name, or `own:<case>` for the add battery. */
  doc: string;
  remove?: string;
  rename?: string;
}

const CASES: EditCase[] = [
  // ── list only ────────────────────────────────────────────────────────────
  { case: 'list-kids-tree', doc: 'kids-tree.pdf' },
  // ── rename: the shape of the name and everything stored with it ─────────
  { case: 'rename-kids-leaf', doc: 'kids-tree.pdf', rename: 'alpha.bin -> first.bin' },
  { case: 'rename-inline-spec', doc: 'mupdf-native.pdf', rename: 'note.txt -> catch.csv' },
  { case: 'rename-af-entry', doc: 'af-only.pdf', rename: 'af-only.bin -> carried.bin' },
  { case: 'rename-af-unnamed', doc: 'af-no-name.pdf', rename: 'attachment-1.bin -> named.bin' },
  { case: 'rename-annot-entry', doc: 'annot-only.pdf', rename: 'annot-only.bin -> from-annot.bin' },
  { case: 'rename-unicode-key', doc: 'unicode-name.pdf', rename: 'über-𓂀.txt -> renamed.txt' },
  { case: 'rename-path-name', doc: 'path-name.pdf', rename: 'reports/q3 summary.txt -> flat.txt' },
  { case: 'rename-onto-existing', doc: 'kids-tree.pdf', rename: 'alpha.bin -> beta.bin' },
  { case: 'rename-onto-own-name', doc: 'kids-tree.pdf', rename: 'alpha.bin -> alpha.bin' },
  { case: 'rename-into-parens', doc: 'mupdf-native.pdf', rename: 'note.txt -> report (draft.txt' },
  { case: 'rename-into-backslash', doc: 'mupdf-native.pdf', rename: 'note.txt -> a\\b.txt' },
  { case: 'rename-into-arabic', doc: 'mupdf-native.pdf', rename: 'note.txt -> تقرير سنة.txt' },
  { case: 'rename-empty-target', doc: 'mupdf-native.pdf', rename: 'note.txt ->   ' },
  { case: 'rename-two-lines', doc: 'kids-tree.pdf', rename: 'alpha.bin -> one.bin\nbeta.bin -> two.bin' },
  { case: 'rename-malformed', doc: 'kids-tree.pdf', rename: 'alpha.bin no arrow\nbeta.bin -> ok.bin' },
  { case: 'rename-missing-name', doc: 'kids-tree.pdf', rename: 'absent.bin -> gone.bin' },
  { case: 'rename-by-filename', doc: 'f-empty-uf-name.pdf', rename: 'uf-name.bin -> by-uf.bin' },
  { case: 'rename-zero-byte', doc: 'zero-byte.pdf', rename: 'empty.bin -> still-empty.bin' },
  { case: 'rename-dos-unix', doc: 'ef-dos-unix.pdf', rename: 'dos.bin -> renamed-dos.bin' },
  // ── delete: pointer AND object ───────────────────────────────────────────
  { case: 'delete-one-of-two', doc: 'kids-tree.pdf', remove: 'alpha.bin' },
  { case: 'delete-only-entry', doc: 'mupdf-native.pdf', remove: 'note.txt' },
  { case: 'delete-af-entry', doc: 'af-only.pdf', remove: 'af-only.bin' },
  { case: 'delete-af-unnamed', doc: 'af-no-name.pdf', remove: 'attachment-1.bin' },
  { case: 'delete-annot-entry', doc: 'annot-only.pdf', remove: 'annot-only.bin' },
  { case: 'delete-one-name-two-sites', doc: 'same-name-two-nodes.pdf', remove: 'dup.bin' },
  { case: 'delete-zero-byte', doc: 'zero-byte.pdf', remove: 'empty.bin' },
  { case: 'delete-unicode-key', doc: 'unicode-name.pdf', remove: 'über-𓂀.txt' },
  { case: 'delete-missing-name', doc: 'kids-tree.pdf', remove: 'not-there.bin' },
  { case: 'delete-by-comma', doc: 'kids-tree.pdf', remove: 'alpha.bin, beta.bin' },
  { case: 'delete-recase', doc: 'flat-names-indirect.pdf', remove: 'FLAT-REF.BIN' },
  // ── both requests in one run ─────────────────────────────────────────────
  { case: 'remove-and-rename', doc: 'kids-tree.pdf', remove: 'beta.bin', rename: 'alpha.bin -> kept.bin' },
  { case: 'remove-what-was-renamed', doc: 'kids-tree.pdf', remove: 'alpha.bin', rename: 'alpha.bin -> zeta.bin' },
  // ── this app's own writer's output ───────────────────────────────────────
  { case: 'own-rename-descriptor', doc: 'own:description-unicode', rename: 'noted.txt -> renamed.txt' },
  { case: 'own-rename-parens-name', doc: 'own:parens', rename: 'report (draft) (2).txt -> clean.txt' },
  { case: 'own-rename-cjk', doc: 'own:cjk', rename: '中文报告.pdf -> latin.pdf' },
  { case: 'own-delete-one-of-two', doc: 'own:case-collide-in-run', remove: 'Case.txt' },
  { case: 'own-delete-bystander-check', doc: 'own:two-files-one-note', remove: 'first.txt' },
];

interface Entry {
  name: string;
  filename?: string;
  size: number;
  sha256: string;
  description?: string;
  creationDate?: string;
  modificationDate?: string;
}

interface Run {
  case: string;
  doc: string;
  remove?: string;
  rename?: string;
  message: string;
  warnings: string[];
  error?: string;
  out?: string;
  before: Entry[];
  after: Entry[];
  pages?: number;
}

const read = (target: string): Uint8Array =>
  new Uint8Array(readFileSync(target.startsWith('own:')
    ? join(ADD_BATTERY, `${target.slice(4)}.pdf`)
    : join(FIXTURES, target)));

const entriesOf = (doc: PDFDocument): Entry[] =>
  listAttachments(doc).map((entry) => ({
    name: entry.name,
    ...(entry.filename === undefined ? {} : { filename: entry.filename }),
    size: entry.size,
    sha256: sha(entry.bytes),
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.creationDate === undefined ? {} : { creationDate: entry.creationDate }),
    ...(entry.modificationDate === undefined ? {} : { modificationDate: entry.modificationDate }),
  }));

async function runCase(item: EditCase): Promise<Run> {
  const bytes = read(item.doc);
  const opened = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const base: Run = {
    case: item.case,
    doc: item.doc,
    ...(item.remove === undefined ? {} : { remove: item.remove }),
    ...(item.rename === undefined ? {} : { rename: item.rename }),
    message: '',
    warnings: [],
    before: entriesOf(opened),
    after: [],
  };
  const values: ToolValues = {
    ...(item.remove === undefined ? {} : { remove: item.remove }),
    ...(item.rename === undefined ? {} : { rename: item.rename }),
  };
  let outcome;
  try {
    outcome = (await runPdfTool({
      toolId: 'edit-attachments',
      files: [new File([bytes as unknown as BlobPart], 'doc.pdf', { type: 'application/pdf' })],
      values, onProgress: () => {}, onLog: () => {},
    })) as unknown as { kind: string; outputs?: { blob: Blob; name?: string }[]; bytes?: Uint8Array; message?: string; warnings?: string[]; pages?: number; reports?: unknown[] };
  } catch (error) {
    return { ...base, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
  const produced = outcome.outputs?.[0]
    ? new Uint8Array(await outcome.outputs[0].blob.arrayBuffer())
    : outcome.bytes
      ? new Uint8Array(outcome.bytes)
      : null;
  if (!produced) {
    return { ...base, message: outcome.message ?? '', warnings: outcome.warnings ?? [] };
  }
  const out = join(OUT_DIR, `${item.case}.pdf`);
  writeFileSync(out, produced);
  // The untouched source of THIS run, so the judge compares against the bytes the run
  // started from rather than a fixture that may have moved.
  mkdirSync(join(OUT_DIR, 'sources'), { recursive: true });
  writeFileSync(join(OUT_DIR, 'sources', `${item.case}-in.pdf`), bytes);
  const again = await PDFDocument.load(produced, { ignoreEncryption: true, updateMetadata: false });
  return {
    ...base,
    message: outcome.message ?? '',
    warnings: outcome.warnings ?? [],
    pages: outcome.pages,
    out,
    after: entriesOf(again),
  };
}

describe('edit-attachments battery (c4 measurement)', () => {
  beforeAll(() => mkdirSync(OUT_DIR, { recursive: true }));

  it('writes the census for every edit case', async () => {
    const runs: Run[] = [];
    for (const item of CASES) runs.push(await runCase(item));
    writeFileSync(join(OUT_DIR, 'edit.json'), `${JSON.stringify(runs, null, 1)}\n`);
    expect(runs).toHaveLength(CASES.length);
  }, 900_000);

  it('records a merge that carries a name used twice, for the round-trip check', async () => {
    const merged = (await runPdfTool({
      toolId: 'merge',
      files: [
        new File([read('same-name-two-nodes.pdf') as unknown as BlobPart], 'a.pdf', { type: 'application/pdf' }),
        new File([read('own:same-name-two-in-run') as unknown as BlobPart], 'b.pdf', { type: 'application/pdf' }),
      ],
      values: {} as ToolValues, onProgress: () => {}, onLog: () => {},
    })) as unknown as { outputs: { blob: Blob }[]; message: string; warnings: string[] };
    const bytes = new Uint8Array(await merged.outputs[0].blob.arrayBuffer());
    writeFileSync(join(OUT_DIR, 'merge-collide.pdf'), bytes);
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    writeFileSync(
      join(OUT_DIR, 'merge-collide.json'),
      `${JSON.stringify({ message: merged.message, warnings: merged.warnings, entries: entriesOf(doc) }, null, 1)}\n`,
    );
    expect(bytes.length).toBeGreaterThan(0);
  }, 600_000);
});
