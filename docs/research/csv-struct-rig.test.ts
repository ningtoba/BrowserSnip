/**
 * The `csv-to-pdf` RFC4180-and-grid rig.
 *
 * `tests/pdf/table-list-tail.test.ts` measures the tail (rows reaching a page) and
 * `convert-to-bytes.test.ts` pins quoting, BOM, padding, the 12-column fit and the
 * repeated header. This rig asks what those leave untouched, because a CSV is
 * usually machine-written and its edges are not the friendly ones:
 *
 *   * RFC4180 quoting — doubled quotes, a quoted field holding CRLF, a quoted field
 *     holding the delimiter, `""`, an unterminated quote, a quote in mid-field,
 *     leading spaces around fields;
 *   * column-count drift — a row wider than the header, rows narrower and wider in
 *     the same file, and whether the >12-column warning counts the grid it drew;
 *   * the four delimiter settings against files that lie about themselves;
 *   * the characters a cell may legally hold that the writer has no code for —
 *     a tab inside a quoted field, a form feed, a NUL-free binary payload;
 *   * `headerRow` off, whose help promises bold *and* repetition;
 *   * width: 20 columns, one 200-character word in a cell, and what "scaled down"
 *     costs the type size the card promises.
 *
 * `csv-struct-measure.py` judges the files with MuPDF, per sheet: how many baselines
 * and how many columns each row holds, which cells are bold, the type size the grid
 * ended up at, and the sentence plus warnings the run printed.
 *
 *   npx vitest run --config docs/research/csv-struct.vitest.config.ts
 *   python3 docs/research/csv-struct-measure.py /tmp/csvstruct before-fix \
 *     | tee docs/research/csv-struct-before.txt
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  fileFrom,
  firstPdf,
  installConvertToEnv,
  pageSizes,
  restoreConvertToEnv,
  run,
  textRuns,
} from '../../tests/pdf/convert-to-harness';

const DIR = '/tmp/csvstruct';

interface Case {
  label: string;
  csv: string;
  values?: Record<string, unknown>;
  name?: string;
}

const WIDE_HEADER = Array.from({ length: 20 }, (_, i) => `col${i + 1}`).join(',');
const WIDE_ROW = Array.from({ length: 20 }, (_, i) => `v${i + 1}`).join(',');
const LONG_WORD = 'supercalifragilistic'.repeat(10);

const cases: Case[] = [
  { label: 'rfc-doubled-quotes', csv: 'name,note\n"He said ""hi""",ok MKEND\n' },
  { label: 'rfc-crlf-in-field', csv: 'name,note\r\n"line one\r\nline two",ok MKEND\r\n' },
  { label: 'rfc-lf-in-field', csv: 'name,note\n"line one\nline two\nline three",ok MKEND\n' },
  { label: 'rfc-delimiter-in-field', csv: 'name,note\n"Widget, large; tab","a,b;c" MKEND\n' },
  { label: 'rfc-empty-quoted', csv: 'name,qty,note\n"",3,"" MKEND\n' },
  { label: 'rfc-unterminated', csv: 'name,note\n"Widget, large, still open MKEND\nsecond,row\n' },
  { label: 'rfc-mid-quote', csv: 'name,note\na"b,c"d MKEND\n' },
  { label: 'rfc-spaces', csv: 'name, note\n  Widget  ,  3  MKEND\n' },
  { label: 'drift-wide-row', csv: 'name,qty\nWidget,3,extra,more MKEND\n' },
  { label: 'drift-mixed', csv: 'a,b,c,d\n1,2,3,4\n5,6\n7,8,9,10,11,12 MKEND\n' },
  { label: 'drift-13-cols', csv: `${Array.from({ length: 13 }, (_, i) => `c${i + 1}`).join(',')}\n${Array.from({ length: 13 }, (_, i) => `${i + 1}v`).join(',')} MKEND\n` },
  { label: 'drift-20-cols', csv: `${WIDE_HEADER}\n${WIDE_ROW} MKEND\n` },
  { label: 'cell-long-word', csv: `name,qty\n${LONG_WORD},3 MKEND\n` },
  { label: 'tab-in-quoted', csv: 'name,note\n"col1\tcol2",ok MKEND\n' },
  { label: 'tab-delimited', csv: 'name\tqty\tprice\nWidget\t3\t9.99 MKEND\n', values: { delimiter: '\t' } },
  { label: 'formfeed-in-quoted', csv: 'name,note\n"page one\fform feed",ok MKEND\n' },
  { label: 'bom-semicolon-detect', csv: '\uFEFFname;qty;price\nWidget;3;9.99 MKEND\n', values: { delimiter: 'auto' } },
  { label: 'utf16le-bom-csv', csv: '\uFEFFname,qty\nWidget,3 MKEND\n', name: 'utf16.csv' },
  { label: 'header-off', csv: 'name,qty,price\n' + Array.from({ length: 40 }, (_, i) => `row${i + 1},${i},${i}.50`).join('\n') + '\nMKEND\n', values: { headerRow: false, pageSize: 'a5', fontSize: 12 } },
  { label: 'header-on-long', csv: 'name,qty,price\n' + Array.from({ length: 40 }, (_, i) => `row${i + 1},${i},${i}.50`).join('\n') + '\nMKEND\n', values: { pageSize: 'a5', fontSize: 12 } },
  { label: 'two-files', csv: 'a,b\n1,2 MKEND\n', values: {} },
  { label: 'csv-then-blank-lines', csv: '\n\nname,qty\n\n\nWidget,3 MKEND\n\n\n' },
  { label: 'one-column', csv: 'name\nWidget\nGizmo MKEND\n' },
  { label: 'semicolon-with-commas', csv: 'name,full;qty\nWidget, the Great;3 MKEND\n', values: { delimiter: ';' } },
];

let inner: typeof fetch;
let fetched: string[];

beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  installConvertToEnv();
  inner = globalThis.fetch;
  fetched = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith('data:')) fetched.push(url);
    return inner(input as never);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = inner;
  restoreConvertToEnv();
});

describe('csv grid and quoting', () => {
  it('writes one PDF per fixture with what the run said', { timeout: 300_000 }, async () => {
    for (const testCase of cases) {
      fetched = [];
      let message = '';
      let warnings: string[] = [];
      let bytes = new Uint8Array(0);
      const file = testCase.name === 'utf16.csv'
        ? fileFrom(new Uint8Array([0xff, 0xfe, ...Buffer.from(testCase.csv, 'utf16le')]), 'utf16.csv', 'text/csv')
        : fileFrom(testCase.csv, testCase.name ?? 'data.csv', 'text/csv');
      try {
        const outcome = await run('csv-to-pdf', testCase.values ?? {}, [file]);
        bytes = await firstPdf(outcome);
        message = String(outcome.message);
        warnings = outcome.warnings ?? [];
      } catch (error) {
        message = `REFUSED: ${(error as Error).message}`;
      }
      const record: Record<string, unknown> = {
        label: testCase.label,
        values: testCase.values ?? {},
        message,
        warnings,
        fetched: [...fetched],
        srcBytes: file.size,
      };
      if (bytes.length > 0) {
        writeFileSync(`${DIR}/${testCase.label}.pdf`, bytes);
        const runs = await textRuns(bytes);
        const sizes = await pageSizes(bytes);
        record.sheets = sizes.length;
        record.streamRuns = runs.length;
        record.runsOutsideBox = runs.filter((run) => {
          const [w, h] = sizes[run.page] ?? [595.28, 841.89];
          return run.x < 0 || run.y < 0 || run.x > w || run.y > h;
        }).length;
      }
      writeFileSync(`${DIR}/${testCase.label}.src.md`, testCase.csv, 'utf8');
      writeFileSync(`${DIR}/${testCase.label}.json`, JSON.stringify(record, null, 2), 'utf8');
    }
    // The batch case: two files in one run, counted honestly.
    const batch = await run('csv-to-pdf', {}, [
      fileFrom('a,b\n1,2 MKEND\n', 'one.csv', 'text/csv'),
      fileFrom('c,d,e\n3,4,5 MKEND\n', 'two.csv', 'text/csv'),
    ]);
    const batchBytes = await firstPdf(batch);
    writeFileSync(`${DIR}/batch-two-files.pdf`, batchBytes);
    const runs = await textRuns(batchBytes);
    const sizes = await pageSizes(batchBytes);
    writeFileSync(`${DIR}/batch-two-files.json`, JSON.stringify({
      label: 'batch-two-files',
      message: String(batch.message),
      warnings: batch.warnings ?? [],
      sheets: sizes.length,
      streamRuns: runs.length,
      fetched: [],
      srcBytes: 16,
    }, null, 2));
  });
});
