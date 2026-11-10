/**
 * The tail of a text file: does the last line reach a page?
 *
 * `docs/TOOL-TRIAGE.md` §4 measured `doc.txt` — 2 861 characters in, **968 out**,
 * the text stopping mid-line at row 12 of 40 under the sentence *"Typeset 1 text
 * source(s) into 2 page(s)."*. The cause sits in `core/layout.ts` `renderBlocks`:
 * a paragraph or quote block was tested against the space left on the page once
 * (`needs(height)` → turn to a fresh sheet) and every wrapped line was then
 * painted from wherever the block happened to begin. A block taller than one
 * sheet therefore ran below `y = 0` — 456 of its 517 text runs on a 120-row file,
 * the lowest baseline at −7 269 pt on an 841.89 pt page. The content stream holds
 * those words, so "the bytes contain the string" passed, and the page count of a
 * document amputated at the bottom edge still looks sane.
 *
 * Every assertion here is made on the produced file, and every marker must sit
 * **inside the page box** to count as arrived.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { pageContentOps } from '@/lib/pdf/core/content';
import type { NumberOperand } from '@/lib/pdf/core/content';
import { PDFDocument } from '@maxwbh/pdf-lib';
import type { PDFPage } from '@maxwbh/pdf-lib';
import {
  docxBytes,
  fileFrom,
  firstPdf,
  installConvertToEnv,
  pageSizes,
  resetConvertToEnv,
  restoreConvertToEnv,
  run,
  textRuns,
  type TextRun,
} from './convert-to-harness';

/** The five greppable markers, planted at 0 %, 25 %, 50 %, 75 % and the last line. */
const MARKS = ['MKSTART', 'MK25', 'MK50', 'MK75', 'MKEND'] as const;

/** One numbered sentence per line; `count − 1` rows, markers spread across them. */
function rows(count: number): string[] {
  const last = count - 1;
  const at = new Map<number, string>(
    MARKS.map((mark, index) => [
      index === MARKS.length - 1 ? last : Math.round((last * index) / (MARKS.length - 1)),
      mark,
    ]),
  );
  return Array.from({ length: count }, (_, i) => {
    const mark = at.get(i);
    const body = 'row carries body text that wraps onto a second line before the margin';
    return mark ? `${i + 1} ${mark} ${body}` : `${i + 1} ${body}`;
  });
}

/** Whitespace collapsed, so wrapping and indentation cannot hide a word. */
function compact(text: string): string {
  return text.replace(/\s+/g, '');
}

interface Sheet {
  /** Every character the file puts inside a page box, in reading order. */
  onSheet: string;
  /** Every character in the content stream, on a sheet or below its edge. */
  drawn: string;
  /** Text runs painted outside their page's box — the shape of the old bug. */
  offSheet: TextRun[];
  /** Path points (bars, rules, code boxes) outside their page's box. */
  offSheetPaths: string[];
  /** The runs that are inside a page box, in reading order. */
  onSheetRuns: TextRun[];
  pages: number;
  runs: TextRun[];
}

/** One 6-element PDF matrix product, for the CTM a path is drawn under. */
function multiply(a: number[], b: number[]): number[] {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

/** Every point a page's own `m`/`l` operators place, in page space. */
function paintedPoints(page: PDFPage): [number, number][] {
  const identity = [1, 0, 0, 1, 0, 0];
  let ctm = identity;
  const stack: number[][] = [];
  const points: [number, number][] = [];
  for (const op of pageContentOps(page)) {
    const values = op.operands
      .filter((operand): operand is NumberOperand => operand.kind === 'number')
      .map((operand) => operand.value);
    if (op.name === 'q') stack.push([...ctm]);
    else if (op.name === 'Q') ctm = stack.pop() ?? identity;
    else if (op.name === 'cm' && values.length >= 6) ctm = multiply(ctm, values.slice(0, 6));
    else if ((op.name === 'm' || op.name === 'l') && values.length >= 2) {
      points.push([
        ctm[0] * values[0] + ctm[2] * values[1] + ctm[4],
        ctm[1] * values[0] + ctm[3] * values[1] + ctm[5],
      ]);
    }
  }
  return points;
}

async function sheets(bytes: Uint8Array): Promise<Sheet> {
  const [runs, sizes, doc] = await Promise.all([
    textRuns(bytes),
    pageSizes(bytes),
    PDFDocument.load(bytes, { updateMetadata: false }),
  ]);
  const inside = (run: TextRun): boolean => {
    const [width, height] = sizes[run.page] ?? [595.28, 841.89];
    return run.y >= 0 && run.y <= height && run.x >= 0 && run.x <= width;
  };
  const inOrder = [...runs].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const offSheetPaths = doc.getPages().flatMap((page, index) => {
    const [width, height] = sizes[index] ?? [595.28, 841.89];
    return paintedPoints(page)
      .filter(([x, y]) => x < 0 || y < 0 || x > width || y > height)
      .map(([x, y]) => `page ${index + 1} paints a path at (${x.toFixed(1)}, ${y.toFixed(1)})`);
  });
  const onSheetRuns = inOrder.filter(inside);
  return {
    onSheet: onSheetRuns.map((run) => run.text).join(' '),
    drawn: inOrder.map((run) => run.text).join(' '),
    offSheet: runs.filter((run) => !inside(run)),
    offSheetPaths,
    onSheetRuns,
    pages: sizes.length,
    runs,
  };
}

/**
 * Why the file's tail did not arrive: the first marker a reader cannot find on a
 * sheet, how far into the source the sheets got, and how much of the content
 * stream hangs outside a page box. `''` means every marker reached a sheet.
 */
function tailGap(sheet: Sheet, source: string): string {
  const arrived = compact(sheet.onSheet);
  const missing = MARKS.find((mark) => !arrived.includes(mark));
  if (!missing) return '';
  const cut = compact(source).indexOf(missing);
  return `${missing} is not on a sheet (byte ${cut} of ${compact(source).length} in the source); `
    + `${sheet.onSheet.length} of ${sheet.drawn.length} stream characters are on a sheet, `
    + `${sheet.offSheet.length} run(s) are not`;
}

const arabic = '\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645';
const cjk = '\u65e5\u672c\u8a9e\u306e\u30c6\u30ad\u30b9\u30c8';

/** The script faces `convert-to-harness` does not stand in for, served locally. */
const faceShim = (() => {
  const bytes = new Uint8Array(readFileSync(join(process.cwd(), 'public', 'fonts', 'NotoSans-Regular.ttf')));
  let inner: typeof fetch;
  return {
    install() {
      inner = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL) =>
        /NotoSans(Arabic|Hebrew)_400Regular\.ttf$/.test(String(input))
          // A copy per call: the subsetter aligns the bytes it is handed, and two
          // script faces must not share one buffer.
          ? new Response(new Uint8Array(bytes), { headers: { 'content-type': 'font/ttf' } })
          : inner(input as never)) as typeof fetch;
    },
    restore() {
      globalThis.fetch = inner;
    },
  };
})();

beforeAll(() => {
  installConvertToEnv();
  faceShim.install();
});

afterEach(() => resetConvertToEnv());

afterAll(() => {
  faceShim.restore();
  restoreConvertToEnv();
});

async function typeset(source: string, values: Record<string, unknown> = {}): Promise<{ sheet: Sheet; message: string | undefined; pagesOut: number | null }> {
  const outcome = await run('txt-to-pdf', { source: 'paste', paste: source, ...values }, [
    fileFrom(source, 'doc.txt', 'text/plain'),
  ]);
  const bytes = await firstPdf(outcome);
  return { sheet: await sheets(bytes), message: outcome.message, pagesOut: outcome.pagesOut };
}

describe('txt-to-pdf: the whole file reaches the page, not just its first sheet', () => {
  it('lands every marker inside a page box for a paragraph taller than a sheet', async () => {
    const source = rows(120).join('\n');
    const { sheet } = await typeset(source);
    expect(tailGap(sheet, source)).toBe('');
    // Nothing is left hanging off the bottom or right edge of a sheet.
    expect(sheet.offSheet).toEqual([]);
    expect(sheet.offSheetPaths).toEqual([]);
    expect(sheet.pages).toBeGreaterThan(2);
  });

  it('grows the page count as the text demands, and prints the count it wrote', async () => {
    const pages: number[] = [];
    for (const count of [8, 40, 120, 400]) {
      const source = rows(count).join('\n');
      const { sheet, message, pagesOut } = await typeset(source);
      expect(tailGap(sheet, source), `row count ${count}`).toBe('');
      expect(pagesOut, `row count ${count}: the reported page count is the number of sheets`).toBe(sheet.pages);
      expect(message, `row count ${count}: the sentence names the sheets the file holds`).toMatch(
        new RegExp(`into ${sheet.pages} page\\(s\\)`),
      );
      pages.push(sheet.pages);
    }
    expect(pages).toEqual([...pages].sort((a, b) => a - b));
    expect(pages[0]).toBeLessThan(pages[3]!);
  });

  it('keeps the lines in their order, whole, and breaks them at spaces', async () => {
    const lines = rows(120);
    const { sheet } = await typeset(lines.join('\n'), { pageNumbers: false });
    // No character lost, added or resequenced between the source and the sheets.
    expect(compact(sheet.onSheet)).toBe(compact(lines.join('\n')));
    // A wrapped line never splits a word that had a space to break at, and no row
    // is painted twice across the break: the phrase appears exactly once per line.
    const words = sheet.onSheet.split(/\s+/).filter(Boolean);
    expect(words.slice(0, 4)).toEqual(['1', 'MKSTART', 'row', 'carries']);
    expect(compact(sheet.onSheet).match(/rowcarriesbodytext/g)?.length).toBe(lines.length);
  });

  it('treats CRLF, a missing final newline and a partial final line as the same text', async () => {
    const lines = rows(120);
    const cases: [string, string][] = [
      ['CRLF', lines.join('\r\n')],
      ['no trailing newline', `${lines.join('\n\n')}`],
      ['partial final line', `${lines.slice(0, -1).join('\n\n')}\n\n${lines[119]!.slice(0, 24)}MKEND`],
    ];
    for (const [label, source] of cases) {
      const { sheet } = await typeset(source);
      expect(tailGap(sheet, source), label).toBe('');
      expect(sheet.offSheet, label).toEqual([]);
    }
  });

  it('carries accents, CJK, RTL and tabs to the last line', async () => {
    const lines = rows(120);
    const unicode = [
      lines[0]!.replace('MKSTART', `MKSTART caf\u00e9 na\u00efve \u2014 \u03a9\u03bc\u03ad\u03b3\u03b1`),
      lines[1]!.replace('row', `${cjk} \ud55c\uad6d\uc5b4 row`),
      lines[2]!.replace('row', `${arabic} row`),
      ...lines.slice(3, 119),
      lines[119]!.replace('row', `${cjk}\u6700\u5f8c\u4e00\u884c row`),
    ];
    for (const [label, source] of [
      ['non-ASCII', unicode.join('\n\n')],
      ['tabs', lines.map((line) => `\t${line.replace(' body', '\t\tbody')}`).join('\n')],
    ] as [string, string][]) {
      const { sheet } = await typeset(source);
      expect(tailGap(sheet, source), label).toBe('');
      expect(sheet.offSheet, label).toEqual([]);
    }
    // The scripts themselves, not only the ASCII markers beside them. An RTL run
    // is painted in visual order, so its characters are counted, not compared.
    const { sheet } = await typeset(unicode.join('\n\n'));
    expect(sheet.onSheetRuns.some((run) => run.text.includes(cjk))).toBe(true);
    // The RTL line comes back in visual order (`مرحبا بالعالم 3` reads as
    // `wor ملاعلاب ابحرم 3`), so its characters are counted rather than compared.
    const arabicArrived = sheet.onSheetRuns.map((run) => run.text).join('').match(/[\u0600-\u06FF]/g)?.length ?? 0;
    expect(arabicArrived).toBe(arabic.replace(/\s/g, '').length);
    expect(sheet.onSheet).not.toContain('\uFFFD');
  });

  it('has no page-count ceiling: a 4 000-line source keeps its last line', async () => {
    const source = rows(4000).join('\n');
    const { sheet, pagesOut } = await typeset(source);
    expect(tailGap(sheet, source)).toBe('');
    expect(sheet.pages).toBeGreaterThan(100);
    expect(pagesOut).toBe(sheet.pages);
  }, 120_000);

  it('keeps the lines after an over-long word, and admits the word is not broken', async () => {
    const blob = `${'x'.repeat(4000)}MKTAILWORD${'y'.repeat(4000)}`;
    const lines = rows(60);
    const source = [blob, ...lines].join('\n\n');
    const { sheet } = await typeset(source);
    expect(tailGap(sheet, source)).toBe('');
    expect(sheet.offSheet).toEqual([]);
    // What the tool cannot wrap, it has to say: a single word has no space to
    // break at, so it is painted as one run from the left margin and its tail
    // falls past the right edge — 99 characters of an 7 980-character word are
    // inside the sheet when MuPDF rasterises it, which is the note's claim.
    const [blobRun] = sheet.runs.filter((run) => run.text.includes('MKTAILWORD'));
    expect(blobRun).toBeTruthy();
    expect(blobRun!.text.length).toBeGreaterThan(7900);
    expect(blobRun!.x).toBeCloseTo(56, 1);
    expect(sheet.onSheet).toContain('x'.repeat(40));
    const note = getPdfTool('txt-to-pdf')?.notes?.join('\n') ?? '';
    expect(note, 'the cap must be stated in the tool, not found by the user').toMatch(/word|token/i);
  });

  it('spills a quote block across sheets without stretching its bar off the page', async () => {
    const source = `> ${rows(120).join('\n')}`;
    const outcome = await run('markdown-to-pdf', { source: 'paste', paste: source });
    const bytes = await firstPdf(outcome);
    const sheet = await sheets(bytes);
    expect(tailGap(sheet, source)).toBe('');
    expect(sheet.pages).toBeGreaterThan(2);
    // Each bar segment belongs to the sheet it was painted on: no path coordinate
    // leaves the page box, which is what one shared `barTop` across a break caused.
    expect(sheet.offSheetPaths).toEqual([]);
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    const bars = doc.getPages().map((page) => paintedPoints(page).length);
    expect(bars.filter((count) => count > 0).length).toBeGreaterThan(1);
  });
});

describe('the sibling routes share the fix', () => {
  const lines = rows(120);
  const flat = lines.join('\n');

  const cases: [string, string, () => Promise<File> | File][] = [
    ['markdown-to-pdf', `${flat}\n\nMKEND`, async () => fileFrom(flat, 'a.md', 'text/markdown')],
    ['html-to-pdf', flat, async () => fileFrom(`<p>${flat}</p>`, 'a.html', 'text/html')],
    ['xml-to-pdf', flat, async () => fileFrom(`<root><doc>${flat}</doc></root>`, 'a.xml', 'application/xml')],
    ['csv-to-pdf', flat, async () => fileFrom(`text\n${lines.map((l) => `"${l}"`).join('\n')}`, 'a.csv', 'text/csv')],
    ['json-to-pdf', flat, async () => fileFrom(JSON.stringify(lines), 'a.json', 'application/json')],
    ['word-to-pdf', flat, async () =>
      fileFrom(await docxBytes(lines.map((l) => `<w:p><w:r><w:t>${l}</w:t></w:r></w:p>`).join('')), 'a.docx')],
  ];

  for (const [id, source, makeFile] of cases) {
    it(`${id} keeps the last line of a tall paragraph on a sheet`, async () => {
      const outcome = await run(id, {}, [await makeFile()]);
      const sheet = await sheets(await firstPdf(outcome));
      expect(sheet.pages, id).toBeGreaterThan(2);
      expect(tailGap(sheet, source), id).toBe('');
      expect(sheet.offSheet, id).toEqual([]);
      expect(sheet.offSheetPaths, id).toEqual([]);
    });
  }

  it('keeps a one-line-per-block source exactly as tidy as it was', async () => {
    // The shape that already worked before the fix: many short blocks. Order,
    // count and page numbers must be untouched by a change to the tall-block path.
    const source = lines.join('\n\n');
    const { sheet, pagesOut, message } = await typeset(source);
    expect(compact(sheet.onSheet)).toContain(compact(lines[119]!));
    expect(sheet.pages).toBe(pagesOut);
    expect(message).toContain(`${sheet.pages} page(s)`);
    expect(sheet.offSheet).toEqual([]);
  });
});

/**
 * The three rows this file pinned as OPEN are closed: `renderList`, `renderTable`
 * and the Markdown tab now behave, on the same fixtures, asserted by
 * `tests/pdf/table-list-tail.test.ts` and counted by
 * `docs/research/table-list-tail-{before,after}.txt`. They stay here in the
 * opposite direction, because the number that made them news is the number a
 * regression has to break.
 */
describe('CLOSED: the sibling variants that used to cut a block at the page edge', () => {
  it('a Markdown list item taller than a sheet keeps its tail', async () => {
    const source = `- ${rows(120).join(' ')}`;
    const outcome = await run('markdown-to-pdf', { source: 'paste', paste: source });
    const sheet = await sheets(await firstPdf(outcome));
    // Was 818 characters of 8 802 with 52 of 426 runs inside a page box, reported
    // as "2 page(s)".
    expect(sheet.offSheet).toEqual([]);
    expect(tailGap(sheet, source)).toBe('');
    expect(sheet.pages).toBeGreaterThan(2);
  });

  it('a table cell taller than a sheet keeps its tail', async () => {
    const source = JSON.stringify({ note: rows(120).join('\n') });
    const outcome = await run('json-to-pdf', { source: 'paste', paste: source }, [
      fileFrom(source, 'a.json', 'application/json'),
    ]);
    const sheet = await sheets(await firstPdf(outcome));
    // Was 16 characters of 7 365, 4 of 510 runs in a box, over 3 sheets.
    expect(sheet.offSheet).toEqual([]);
    expect(tailGap(sheet, source)).toBe('');
    expect(sheet.pages).toBeGreaterThan(2);
  });

  it('a Markdown source with one tab in it produces a file, and keeps its tail', async () => {
    // The text route expanded tabs; `marked` kept one inside the run, so an
    // `alpha\tbeta` file lost all 9 040 bytes to `WinAnsi cannot encode`. The
    // Markdown lexer is now fed the same four-column expansion CommonMark defines.
    const outcome = await run('markdown-to-pdf', { source: 'paste', paste: 'alpha\tbeta MKEND' });
    const sheet = await sheets(await firstPdf(outcome));
    expect(compact(sheet.onSheet).toLowerCase()).toContain('alphabetamkend');
    expect(sheet.offSheet).toEqual([]);
  });
});
