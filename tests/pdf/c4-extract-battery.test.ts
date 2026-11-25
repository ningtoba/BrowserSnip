/**
 * CHUNK c4 — `extract-attachments` battery (measurement probe, not a pin).
 *
 * Every native shape of BOTH writers — the 22 foreign fixtures (libqpdf / MuPDF /
 * pypdf) plus the enclosures this app's own writer produced in
 * `c4-add-names-battery.test.ts` — run through the shipped `runPdfTool` as the rail
 * drives it. Each produced download (single file or ZIP) and the card's own sentence are
 * written to `C4_EXTRACT_DIR` for `docs/research/attach-extract-check.py` to judge
 * against `MANIFEST.json`, never against a count.
 *
 * Also measured here, because they are the same bytes seen from the other side:
 * the round trip through **today's** `merge` (an attachment carried across a page copy
 * and then extracted), and the on-disk collision naming the archive has to dedupe.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import type { ToolValues } from '@/lib/pdf/tools/types';

beforeAll(() => {
  Object.defineProperty(GlobalWorkerOptions, 'workerSrc', { configurable: true, get: () => '', set: () => {} });
});

const OUT_DIR = process.env.C4_EXTRACT_DIR || '/tmp/lane-security/c4/extract';
const FIXTURES = resolve(process.cwd(), 'tests/fixtures/attachments');
const ADD_BATTERY = process.env.C4_BATTERY_DIR || '/tmp/lane-security/c4/battery';

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const file = (bytes: Uint8Array, name: string): File => new File([bytes as unknown as BlobPart], name, { type: 'application/pdf' });

interface Run {
  case: string;
  /** What the tool that produced this document said, when it is not the extract run. */
  prior?: string;
  input: string;
  /** The document the run read, on disk, so the judge re-reads the same bytes. */
  sourcePath: string;
  message: string;
  reports: { title?: string; rows?: { label: string; value: string }[] }[];
  outputs: { name: string; bytes: number; sha256: string; kind: string }[];
  error?: string;
}

interface ToolOutcome {
  kind: string;
  message?: string;
  warnings?: string[];
  reports?: { title?: string; rows?: { label: string; value: string }[] }[];
  outputs?: { blob: Blob; name?: string }[];
  pages?: number;
}

async function extractOf(inputPath: string, label: string, name: string): Promise<Run> {
  const bytes = new Uint8Array(readFileSync(inputPath));
  const base: Run = { case: label, input: name, sourcePath: inputPath, message: '', reports: [], outputs: [] };
  let outcome: ToolOutcome;
  try {
    outcome = (await runPdfTool({
      toolId: 'extract-attachments', files: [file(bytes, name)], values: {} as ToolValues, onProgress: () => {}, onLog: () => {},
    })) as unknown as ToolOutcome;
  } catch (error) {
    return { ...base, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
  const outputs: Run['outputs'] = [];
  for (const output of outcome.outputs ?? []) {
    const body = new Uint8Array(await output.blob.arrayBuffer());
    const out = join(OUT_DIR, `${label}--${output.name ?? 'blob'}`);
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(out, body);
    outputs.push({ name: output.name ?? 'blob', bytes: body.length, sha256: sha(body), kind: output.blob.type });
  }
  return {
    ...base,
    message: outcome.message ?? '',
    reports: outcome.reports ?? [],
    outputs,
  };
}

describe('extract-attachments over every shape (c4 measurement)', () => {
  beforeAll(() => mkdirSync(OUT_DIR, { recursive: true }));

  it('extracts from the foreign bank, from this writer, and after a merge', async () => {
    const runs: Run[] = [];

    // 1. Every committed foreign fixture.
    const manifest = JSON.parse(readFileSync(join(FIXTURES, 'MANIFEST.json'), 'utf8')) as Record<string, unknown>;
    for (const name of Object.keys(manifest).filter((entry) => entry.endsWith('.pdf'))) {
      runs.push(await extractOf(join(FIXTURES, name), `fixture-${name.replace(/\.pdf$/, '')}`, name));
    }

    // 2. What this app's own writer produced in the add battery (the reciprocal side).
    const addCensus = JSON.parse(readFileSync(join(ADD_BATTERY, 'battery.json'), 'utf8')) as { case: string; out?: string }[];
    for (const row of addCensus) {
      if (!row.out) continue;
      try {
        runs.push(await extractOf(row.out, `own-${row.case}`, `${row.case}_attached.pdf`));
      } catch {
        /* a shape whose file the add battery refused to write */
      }
    }

    // 3. Round trip through TODAY's merge: two documents that each carry enclosures.
    const mergeInputs = [
      file(new Uint8Array(readFileSync(join(FIXTURES, 'mupdf-native.pdf'))), 'mupdf-native.pdf'),
      file(new Uint8Array(readFileSync(join(FIXTURES, 'kids-tree.pdf'))), 'kids-tree.pdf'),
      file(new Uint8Array(readFileSync(join(ADD_BATTERY, 'path-slash.pdf'))), 'path-slash_attached.pdf'),
      file(new Uint8Array(readFileSync(join(ADD_BATTERY, 'zero-byte-payload.pdf'))), 'zero-byte_attached.pdf'),
    ];
    const merged = (await runPdfTool({
      toolId: 'merge', files: mergeInputs, values: {} as ToolValues, onProgress: () => {}, onLog: () => {},
    })) as unknown as ToolOutcome;
    const mergedBytes = new Uint8Array(await (merged.outputs?.[0]?.blob ?? new Blob()).arrayBuffer());
    const mergedPath = join(OUT_DIR, 'merged-input.pdf');
    writeFileSync(mergedPath, mergedBytes);
    const mergedMessage = `${merged.message ?? ''} :: ${(merged.warnings ?? []).join(' ; ')}`;
    const afterMerge = await extractOf(mergedPath, 'after-merge', 'combined_merged.pdf');
    runs.push({ ...afterMerge, prior: mergedMessage });

    // 4. A merge of two documents that carry the SAME name (the collision the plan names).
    const collide = (await runPdfTool({
      toolId: 'merge',
      files: [
        file(new Uint8Array(readFileSync(join(FIXTURES, 'same-name-two-nodes.pdf'))), 'a.pdf'),
        file(new Uint8Array(readFileSync(join(ADD_BATTERY, 'same-name-two-in-run.pdf'))), 'b.pdf'),
      ],
      values: {} as ToolValues, onProgress: () => {}, onLog: () => {},
    })) as unknown as ToolOutcome;
    const collideBytes = new Uint8Array(await (collide.outputs?.[0]?.blob ?? new Blob()).arrayBuffer());
    const collidePath = join(OUT_DIR, 'collide-input.pdf');
    writeFileSync(collidePath, collideBytes);
    copyFileSync(collidePath, join(OUT_DIR, 'collide-merge.pdf'));
    const collideRun = await extractOf(collidePath, 'after-merge-dup-name', 'dupe_merged.pdf');
    runs.push({ ...collideRun, prior: `${collide.message ?? ''} :: ${(collide.warnings ?? []).join(' ; ')} :: ${JSON.stringify(collide.reports ?? [])}` });

    // 5. The regression guard the other way: `sanitize-pdf` with every switch ON but
    // `attachments` OFF must leave the embedded files byte-identical (it became a payload
    // deleter this round, so the bystander case has to stay intact).
    const sanitize = (await runPdfTool({
      toolId: 'sanitize-pdf',
      files: [file(new Uint8Array(readFileSync(join(FIXTURES, 'kids-tree.pdf'))), 'kids-tree.pdf')],
      // The switches this tool really has (`optimize.ts` `sanitize-pdf`): everything on,
      // `attachments` explicitly OFF — the regression guard for the new payload deleter.
      values: { javascript: true, attachments: false, metadata: true, info: true, annotations: false, hiddenLayers: false } as ToolValues,
      onProgress: () => {}, onLog: () => {},
    })) as unknown as ToolOutcome;
    const sanitized = new Uint8Array(await (sanitize.outputs?.[0]?.blob ?? new Blob()).arrayBuffer());
    const sanitizedPath = join(OUT_DIR, 'sanitize-off-input.pdf');
    writeFileSync(sanitizedPath, sanitized);
    const sanitizedRun = await extractOf(sanitizedPath, 'after-sanitize-attachments-off', 'kids_clean.pdf');
    runs.push({ ...sanitizedRun, prior: `${sanitize.message ?? ''} :: ${(sanitize.warnings ?? []).join(' ; ')}` });

    writeFileSync(join(OUT_DIR, 'extract.json'), `${JSON.stringify(runs, null, 1)}\n`);
    expect(runs.length).toBeGreaterThan(40);
  }, 900_000);
});
