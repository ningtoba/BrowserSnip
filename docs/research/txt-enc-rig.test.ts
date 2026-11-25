/**
 * The `txt-to-pdf` encoding-and-shape rig.
 *
 * `text-tail-rig.test.ts` answers "does the last line arrive?". This rig answers
 * the neighbouring questions the tail fixture cannot reach, all of them about
 * bytes rather than length:
 *
 *   * what a BOM does (UTF-8 / UTF-16LE / UTF-16BE, and UTF-16 with no BOM),
 *   * what a legacy single-byte file does (Windows-1252 `café`, “smart quotes”),
 *   * whether the three line-ending conventions each start a new line,
 *   * whether a tab-indented monospace table lands its columns in a row,
 *   * whether a word longer than the column, or longer than the sheet, survives,
 *   * which faces a CJK source fetches over the network — and what a Latin source
 *     fetches, which must be nothing remote,
 *   * what the refusals say for an empty file, a whitespace file, a BOM-only file,
 *     a PNG named `.txt`, and a high-byte binary with no NULs to sniff.
 *
 * Nothing here asserts a number. `txt-enc-measure.py` judges the produced files
 * with MuPDF — the characters a reader extracts, the x-coordinate of each word —
 * while this file records the sentence the tool printed and every URL the run
 * asked for:
 *
 *   npx vitest run --config docs/research/txt-enc.vitest.config.ts
 *   python3 docs/research/txt-enc-measure.py /tmp/txtenc before-fix \
 *     | tee docs/research/txt-enc-before.txt
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FONTS,
  fileFrom,
  firstPdf,
  installConvertToEnv,
  pageSizes,
  restoreConvertToEnv,
  run,
  textRuns,
} from '../../tests/pdf/convert-to-harness';
import { clearFontCache, setFaceFetchNotice } from '@/lib/pdf/core/fonts';

const DIR = '/tmp/txtenc';
/** A real 1x1 PNG, handed to the text tool under a `.txt` name. */
const PNG_BYTES = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
);

const utf16le = (text: string) => Uint8Array.from(Buffer.from(text, 'utf16le'));
const utf16be = (text: string) => Uint8Array.from(Buffer.from(text, 'utf16le').swap16());
const withBom = (prefix: number[], body: Uint8Array) => Uint8Array.from([...prefix, ...body]);
/** Windows-1252: the bytes a legacy editor writes for é and the curly quotes. */
const CP1252: Record<string, number> = {
  '\u20ac': 0x80, '\u2018': 0x91, '\u2019': 0x92, '\u201c': 0x93, '\u201d': 0x94, '\u2013': 0x96, '\u2014': 0x97,
};
const cp1252 = (text: string) =>
  Uint8Array.from(
    [...text].map((ch) => {
      const code = ch.codePointAt(0)!;
      if (CP1252[ch] !== undefined) return CP1252[ch]!;
      if (code <= 0xff) return code;
      throw new Error(`not a Windows-1252 character: ${ch}`);
    }),
  );

const MARKED = 'MKSTART caf\u00e9 na\u00efve row \u00b5 \u03a9 MKEND';
const LONG_WORD = 'supercalifragilistic'.repeat(150); // 3 300 characters, no space
const LONG_SENTENCE = 'the quick brown fox jumps over the lazy dog '.repeat(110);
/** A tab-indented monospace table: the second column must start at one x. */
const TAB_TABLE = 'ID\tNAME\tQTY\n1\tapple\t3\n22\tbanana\t4\n333\tcherry\t5';
/** The same table with the alignment spelled in spaces — the control. */
const SPACE_TABLE = 'ID    NAME    QTY\n1     apple   3\n22    banana  4\n333   cherry  5';

const txt = (bytes: Uint8Array | string, name = 'doc.txt') => fileFrom(bytes, name, 'text/plain');

interface Case {
  label: string;
  file: File;
  values?: Record<string, unknown>;
  /** A string the finished sheets must carry, checked by MuPDF. */
  expect?: string;
  offline?: boolean;
  /** Serve the real `jetbrains-mono` face, so a monospace claim is measured in a monospace face. */
  realMono?: boolean;
}

const cases: Case[] = [
  { label: 'utf8-bom', file: txt(withBom([0xef, 0xbb, 0xbf], new TextEncoder().encode(`${MARKED}\nsecond line\n`))), expect: MARKED },
  { label: 'utf16le-bom', file: txt(withBom([0xff, 0xfe], utf16le(`${MARKED}\nsecond line\n`))), expect: MARKED },
  { label: 'utf16be-bom', file: txt(withBom([0xfe, 0xff], utf16be(`${MARKED}\nsecond line\n`))), expect: MARKED },
  { label: 'utf16le-nobom', file: txt(utf16le(`${MARKED}\nsecond line\n`)), expect: MARKED },
  { label: 'latin1', file: txt(cp1252('Caf\u00e9 r\u00e9sum\u00e9 na\u00efve \u201cMKSTART\u201d \u2014 MKEND')), expect: 'Caf\u00e9 r\u00e9sum\u00e9 na\u00efve \u201cMKSTART\u201d \u2014 MKEND' },
  { label: 'latin1-rows', file: txt(cp1252('Caf\u00e9 au lait\r\nR\u00e9sum\u00e9 na\u00efve\r\nMKEND \u2014 fin\r\n')), expect: 'Caf\u00e9 au lait' },
  { label: 'mixed-endings', file: txt('MKSTART one\r\ntwo\nthree\rMKEND four\n'), expect: 'MKEND' },
  { label: 'cr-only', file: txt('MKSTART one\rsecond\rthird\rMKEND\r'), expect: 'MKEND' },
  { label: 'form-feed', file: txt('MKSTART one\ftwo\u000bthree\u0085four\u2028five MKEND\n'), expect: 'MKEND' },
  { label: 'literal-replacement', file: txt('MKSTART caf\u00e9 \ufffd already broken MKEND\n'), expect: 'MKEND' },
  { label: 'long-word', file: txt(`${LONG_WORD} MKEND\n`), expect: 'MKEND' },
  { label: 'long-word-mono', file: txt(`${LONG_WORD} MKEND\n`), values: { monospace: true }, expect: 'MKEND', realMono: true },
  { label: 'long-wrapped', file: txt(`MKSTART ${LONG_SENTENCE} MKEND\n`), expect: 'MKEND' },
  { label: 'tabs-mono', file: txt(TAB_TABLE), values: { monospace: true, paragraphs: false }, expect: 'cherry', realMono: true },
  { label: 'spaces-mono', file: txt(SPACE_TABLE), values: { monospace: true, paragraphs: false }, expect: 'cherry', realMono: true },
  { label: 'tabs-prop', file: txt(TAB_TABLE), values: { paragraphs: false }, expect: 'cherry' },
  { label: 'cjk', file: txt(`MKSTART \u65e5\u672c\u8a9e\u306e\u30c6\u30ad\u30b9\u30c8 caf\u00e9 MKEND`), expect: 'MKEND' },
  { label: 'cjk-mixed', file: txt(`MKSTART \u65e5\u672c\u8a9e\u306e\u30c6\u30ad\u30b9\u30c8 \u4f60\u597d \ud55c\uad6d\uc5b4 caf\u00e9 MKEND`), expect: 'MKEND' },
  { label: 'cjk-offline', file: txt(`MKSTART \u65e5\u672c\u8a9e\u306e\u30c6\u30ad\u30b9\u30c8 caf\u00e9 MKEND`), expect: 'MKEND', offline: true },
  { label: 'latin-only', file: txt(`${MARKED}\nno script faces here\n`), expect: 'MKEND' },
  { label: 'empty', file: txt(new Uint8Array(0)) },
  { label: 'whitespace', file: txt('   \n\t\n \n') },
  { label: 'bom-only', file: txt(withBom([0xef, 0xbb, 0xbf], new Uint8Array(0))) },
  { label: 'png-named-txt', file: fileFrom(PNG_BYTES, 'doc.txt', 'text/plain') },
  { label: 'binary-nonul', file: txt(Uint8Array.from(Array.from({ length: 3000 }, (_, i) => 0x81 + (i % 127)))) },
];

let inner: typeof fetch;
let fetched: string[];
let announced: string[];
/** Set for the cases that must be typeset in a true monospace face. */
let realMono = false;

const remoteHost = (url: string) => {
  try {
    const { host } = new URL(url);
    return host && !/^localhost|^127\./.test(host) ? host : '';
  } catch {
    return '';
  }
};

beforeAll(() => {
  mkdirSync(DIR, { recursive: true });
  installConvertToEnv();
  // The harness stub serves the faces from `public/`; this wrapper records every
  // URL the run asked for, so the network half is measured, not assumed.
  inner = globalThis.fetch;
  fetched = [];
  announced = [];
  setFaceFetchNotice((line) => announced.push(line));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetched.push(url);
    if (realMono && /jetbrains-mono-400/.test(url)) {
      // The harness stands in for this face with Noto Sans, which is proportional:
      // a column-alignment measurement needs the real one.
      return new Response(readFileSync(join(process.cwd(), 'public', 'fonts', 'jetbrains-mono-400.ttf')), {
        headers: { 'content-type': 'font/ttf' },
      });
    }
    return inner(url as never);
  }) as typeof fetch;
});

afterAll(() => {
  setFaceFetchNotice(null);
  globalThis.fetch = inner;
  FONTS.cdnReachable = true;
  restoreConvertToEnv();
});

describe('encoding and shape', () => {
  it('writes one PDF per case with what the run did', { timeout: 300_000 }, async () => {
    for (const testCase of cases) {
      clearFontCache();
      fetched = [];
      announced = [];
      realMono = Boolean(testCase.realMono);
      FONTS.cdnReachable = !testCase.offline;
      let message = '';
      let bytes = new Uint8Array(0);
      let warnings: string[] = [];
      try {
        const outcome = await run('txt-to-pdf', testCase.values ?? {}, [testCase.file]);
        bytes = await firstPdf(outcome);
        message = String(outcome.message);
        warnings = outcome.warnings ?? [];
      } catch (error) {
        message = `REFUSED: ${(error as Error).message}`;
      }
      const record: Record<string, unknown> = {
        label: testCase.label,
        name: testCase.file.name,
        srcBytes: testCase.file.size,
        message,
        warnings,
        remoteHosts: [...new Set(fetched.map(remoteHost).filter(Boolean))],
        fetchUrls: fetched,
        announced,
      };
      if (bytes.length > 0) {
        writeFileSync(`${DIR}/${testCase.label}.pdf`, bytes);
        const [runs, sizes] = [await textRuns(bytes), await pageSizes(bytes)];
        const outside = runs.filter((run) => {
          const [w, h] = sizes[run.page] ?? [595.28, 841.89];
          return run.x < 0 || run.y < 0 || run.x > w || run.y > h;
        });
        record.sheets = sizes.length;
        record.streamRuns = runs.length;
        record.runsOutsideBox = outside.length;
      }
      if (testCase.expect) writeFileSync(`${DIR}/${testCase.label}.expect.txt`, testCase.expect, 'utf8');
      writeFileSync(`${DIR}/${testCase.label}.json`, JSON.stringify(record, null, 2), 'utf8');
      writeFileSync(`${DIR}/${testCase.label}.msg.txt`, message, 'utf8');
      // eslint-disable-next-line no-console -- the rig reports on stdout
      console.log(
        `${testCase.label.padEnd(15)} ${bytes.length ? `${String(record.sheets ?? '?').padStart(3)} sheets ` : 'no file  '}` +
          `${String(record.remoteHosts ?? '').padEnd(22)} ${message.slice(0, 100)}`,
      );
    }
  });
});
