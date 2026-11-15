/**
 * The `bookmarks` round rig: what the shipped tool does with an outline typed
 * into its textarea, dumped so outside readers can judge the bytes.
 *
 * This file asserts no number. It runs the tool per case, writes every produced
 * file plus a JSON of the exact text typed and the exact words the app printed,
 * and leaves the verdict to `docs/research/bookmarks-round-readers.py` — pypdf
 * and MuPDF, neither of which shares code with this app.
 *
 *   node docs/research/triage-spec.mjs --dir /tmp/triage      # label + fixture
 *   BOOKMARKS_DIR=/tmp/bm npx vitest run \
 *     --config docs/research/bookmarks-round.vitest.config.ts
 *   python3 docs/research/bookmarks-round-readers.py /tmp/bm | tee /tmp/bm/before.log
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, it } from 'vitest';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import type { PdfToolDefinition, ToolValues } from '@/lib/pdf/tools/types';

const DIR = process.env.BOOKMARKS_DIR ?? '';
const OUT_DIR = DIR ? path.join(DIR, 'out') : '';
const FIXTURE = process.env.BOOKMARKS_FIXTURE ?? '/tmp/triage/in/bookmarked.pdf';

interface Case {
  /** File name stem for the dump, and the case's identity in the log. */
  id: string;
  /** The text a user types, verbatim — tabs and newlines included. */
  outline: string;
  /** `replace` toggle; omitted means the field default (on). */
  replace?: boolean;
  /** Fixture to run against; defaults to the bookmarked one. */
  fixture?: string;
}

/**
 * The cases, each answering one question the round asks.
 *
 * `expect` is what the typist meant the file to say: title (verbatim), depth
 * (1 = top level) and 1-based page, or `null` for a heading with no target.
 * The reader script compares the produced tree to this and to the `/Dest` each
 * entry actually holds, so an entry that lands on the wrong page is a failure
 * even when the title reads right.
 */
const CASES: (Case & { expect?: unknown; note?: string })[] = [
  {
    id: 'nesting',
    note: 'typed grammar: two spaces, one tab and four spaces all mean one level deeper',
    outline: 'Chapter One\n  Section One.A\nChapter Two\n\tTab Child\n    Four-Space Grandchild :: 3',
    expect: [
      { title: 'Chapter One', depth: 1, page: null },
      { title: 'Section One.A', depth: 2, page: null },
      { title: 'Chapter Two', depth: 1, page: null },
      { title: 'Tab Child', depth: 2, page: null },
      { title: 'Four-Space Grandchild', depth: 3, page: 3 },
    ],
  },
  {
    id: 'specials',
    note: 'parentheses, a backslash, a colon pair and non-ASCII in the title',
    outline: 'Report (final) :: 1\nBack\\slash :: 2\nA :: B :: 3\nCafé ☕ :: 4\nРусский :: 1',
    expect: [
      { title: 'Report (final)', depth: 1, page: 1 },
      { title: 'Back\\slash', depth: 1, page: 2 },
      { title: 'A :: B', depth: 1, page: 3 },
      { title: 'Café ☕', depth: 1, page: 4 },
      { title: 'Русский', depth: 1, page: 1 },
    ],
  },
  {
    id: 'append',
    note: 'replace off, over a document that already holds three entries',
    outline: 'Appended :: 2',
    replace: false,
    expect: [
      { title: 'Chapter One', depth: 1, page: 1 },
      { title: 'Section One.A', depth: 2, page: 2 },
      { title: 'Chapter Two', depth: 1, page: 4 },
      { title: 'Appended', depth: 1, page: 2 },
    ],
  },
  {
    id: 'edges',
    note: 'a page past the last, an empty title, and a bare heading with no target',
    outline: 'Past the end :: 9\n\nOnly a heading\n :: 2\n:: 3\nLast :: 4',
    expect: [
      { title: 'Past the end', depth: 1, page: null },
      { title: 'Only a heading', depth: 1, page: null },
      { title: 'Last', depth: 1, page: 4 },
    ],
  },
  {
    id: 'forty',
    note: '40 entries, ten of them nested, against the 4-page fixture',
    outline: Array.from({ length: 40 }, (_, i) => (i % 10 === 0 ? `Group ${i + 1}` : `${'  '}Item ${i + 1} :: ${(i % 4) + 1}`)).join('\n'),
    expect: Array.from({ length: 40 }, (_, i) => (i % 10 === 0
      ? { title: `Group ${i + 1}`, depth: 1, page: null }
      : { title: `Item ${i + 1}`, depth: 2, page: (i % 4) + 1 })),
  },
  {
    id: 'append-empty',
    note: 'replace off over a document with no outline at all',
    fixture: '/tmp/triage/colour.pdf',
    outline: 'Fresh :: 1',
    replace: false,
    expect: [{ title: 'Fresh', depth: 1, page: 1 }],
  },
  {
    id: 'fraction',
    note: 'a fractional page number',
    outline: 'Half :: 2.5\nZero :: 0\nNegative :: -1\nEmpty-after ::',
    expect: [
      // 2.5 rounds to page 3, and the card says so; the separator on a line with
      // nothing after it is the page suffix, not part of the title.
      { title: 'Half', depth: 1, page: 3 },
      { title: 'Zero', depth: 1, page: null },
      { title: 'Negative', depth: 1, page: null },
      { title: 'Empty-after', depth: 1, page: null },
    ],
  },
  {
    id: 'colour',
    note: 'control: the same tree on the unbookmarked 4-sheet fixture, and its append over nothing',
    fixture: '/tmp/triage/colour.pdf',
    outline: 'One :: 1\n  Two :: 2',
    expect: [
      { title: 'One', depth: 1, page: 1 },
      { title: 'Two', depth: 2, page: 2 },
    ],
  },
];

beforeAll(() => {
  let workerPath = `file://${process.cwd()}/node_modules/pdfjs-dist/build/pdf.worker.mjs`;
  Object.defineProperty(GlobalWorkerOptions, 'workerSrc', {
    configurable: true,
    get: () => workerPath,
    set: (value: string) => {
      if (value.startsWith('file:') || value.startsWith('data:')) workerPath = value;
    },
  });
  if (OUT_DIR) mkdirSync(OUT_DIR, { recursive: true });
});

function pdfFile(bytes: Uint8Array, name: string): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}

describe('bookmarks round', () => {
  it('dumps every case, the typed text and the printed words', async () => {
    const rows: unknown[] = [];
    for (const run of CASES) {
      const fixture = run.fixture ?? FIXTURE;
      const tool = getPdfTool('bookmarks') as PdfToolDefinition;
      const values: ToolValues = { outline: run.outline, replace: run.replace ?? true };
      const name = `${run.id}_${path.basename(fixture)}`;
      const row: Record<string, unknown> = { case: run.id, fixture, typed: run.outline, values, note: run.note };
      try {
        const outcome = await runPdfTool({
          toolId: 'bookmarks',
          files: [pdfFile(readFileSync(fixture), path.basename(fixture))],
          values,
          onProgress: () => {},
          onLog: () => {},
        });
        row.message = outcome.message;
        row.warnings = outcome.warnings;
        row.report = outcome.report;
        row.pagesOut = outcome.pagesOut;
        row.outputs = outcome.outputs.map((output) => output.name);
        row.files = [];
        for (const [index, output] of outcome.outputs.entries()) {
          const bytes = new Uint8Array(await output.blob.arrayBuffer());
          if (OUT_DIR) {
            const file = `${name}.${index}.pdf`;
            writeFileSync(path.join(OUT_DIR, file), bytes);
            (row.files as string[]).push(file);
          }
        }
        row.ok = true;
      } catch (error) {
        row.ok = false;
        row.error = (error as Error).message;
      }
      row.expect = run.expect;
      row.tool = { help: tool.fields.map((f) => [f.key, f.help]), notes: tool.notes };
      rows.push(row);
    }
    if (DIR) writeFileSync(path.join(DIR, 'cases.json'), `${JSON.stringify(rows, null, 1)}\n`);
  }, 300_000);
});
