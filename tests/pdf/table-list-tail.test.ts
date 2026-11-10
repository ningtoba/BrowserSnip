/**
 * The tail of a table, a list and a heading: does the last row, item and line
 * reach a page?
 *
 * `tests/pdf/text-tail.test.ts` proved the paragraph branch of `core/layout.ts`
 * painted a tall block downward from wherever it began and never turned the
 * sheet, then left three siblings pinned as OPEN with their numbers: `renderList`
 * put 52 of 426 runs inside a page box, `renderTable` kept 16 characters of
 * 7 365, and a Markdown source holding one tab produced no file at all. This file
 * closes those rows, adds the two more the same sweep found — the heading branch
 * (25 of 723) and an image caption (56 of 424) — and covers every converter that
 * reaches the two renderers.
 *
 * The cause was the same shape, and one number corrects the framing: a table with
 * many *ordinary* rows already paginated (`csv-rows`: 870 of 870 runs in a box
 * before this change). What lost the tail was one row, item or heading taller than
 * a sheet — a long note in a CSV, a JSON value, a paragraph inside a table cell —
 * where the old code turned to a fresh sheet and then painted the whole row from
 * its top edge, so everything past `y = 0` was in the content stream and on no
 * page, under a sentence like "Tabulated 1 file(s) into 11 page(s)." that named
 * sheets it had not printed on.
 *
 * `renderTable` had a second defect, visible only as geometry: a row's wrapped
 * lines were all drawn at one baseline (the loop decremented a local `y` that
 * `drawLine` never read), so a 12-column table stacked 73 lines of text on the
 * same row of pixels. It is pinned below because a fix that paginates without
 * separating the lines would still be unreadable.
 *
 * Every assertion is made on the produced file, and every marker must sit
 * **inside the page box** to count as arrived. Before/after counts for the same
 * fixtures, judged by MuPDF, are in `docs/research/table-list-tail-{before,after}.txt`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import {
  csvToBlocks,
  htmlToBlocks,
  jsonToBlocks,
  markdownToBlocks,
  newDocumentForLayout,
  textToBlocks,
  wrapInlines,
  xmlToBlocks,
  type Block,
} from '@/lib/pdf/core/layout';
import { measureText } from '@/lib/pdf/core/fonts';
import { pageContentOps } from '@/lib/pdf/core/content';
import type { NumberOperand } from '@/lib/pdf/core/content';
import { PDFDocument, type PDFPage } from '@maxwbh/pdf-lib';
import {
  docxBytes,
  fileFrom,
  firstPdf,
  installConvertToEnv,
  pageSizes,
  PNG_1PX,
  restoreConvertToEnv,
  run,
  textRuns,
  type TextRun,
} from './convert-to-harness';

/** The five greppable markers, planted at 0 %, 25 %, 50 %, 75 % and the last text. */
const MARKS = ['MKSTART', 'MK25', 'MK50', 'MK75', 'MKEND'] as const;

const BODY = 'row carries body text that wraps onto a second line before the margin';

/** Marker at source position 0 / 25 / 50 / 75 %, the four that are not the tail. */
function headMark(index: number, total: number): string {
  const last = total - 1;
  const slot = MARKS.slice(0, -1).findIndex((_, mark) => Math.round((last * mark) / (MARKS.length - 1)) === index);
  return slot === -1 ? '' : MARKS[slot]!;
}

/** `count` numbered rows, the five markers spread across them. */
function rows(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const mark = index === count - 1 ? MARKS[4]! : headMark(index, count);
    return mark ? `${index + 1} ${mark} ${BODY}` : `${index + 1} ${BODY}`;
  });
}

/**
 * One long cell: `sentences` wrapped lines of body text — more than a sheet holds
 * at any column width the sizer chooses — with a head marker at its start and, on
 * the final row, `MKEND` as the very last text in the document.
 */
function cellText(index: number, total: number, sentences = 40): string {
  const parts = Array.from({ length: sentences }, (_, s) => `cell ${index + 1} sentence ${s + 1} ${BODY}`);
  const mark = headMark(index, total);
  if (mark) parts[0] = `${mark} ${parts[0]}`;
  if (index === total - 1) parts[parts.length - 1] = `${parts[parts.length - 1]} MKEND`;
  return parts.join(' ');
}

/** The same document, five ways: one table whose last row is taller than a sheet. */
const TALL_ROWS = 5;
const tallCsv = () => `id,label,note\n${Array.from({ length: TALL_ROWS }, (_, i) =>
  `${i + 1},row ${i + 1},"${cellText(i, TALL_ROWS)}"`).join('\n')}`;
const tallJson = () => JSON.stringify({ note: rows(120).join(' ') });
const tallMarkdownTable = () => `| id | note |\n| --- | --- |\n${Array.from(
  { length: TALL_ROWS },
  (_, i) => `| row ${i + 1} | ${cellText(i, TALL_ROWS)} |`,
).join('\n')}`;
const tallHtmlTable = () => `<table><thead><tr><th>id</th><th>note</th></tr></thead><tbody>${Array.from(
  { length: TALL_ROWS },
  (_, i) => `<tr><td>row ${i + 1}</td><td>${cellText(i, TALL_ROWS)}</td></tr>`,
).join('')}</tbody></table>`;
const tallWordTable = () =>
  docxBytes(`<w:tbl><w:tr><w:tc><w:p><w:r><w:t>id</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>note</w:t></w:r></w:p></w:tc></w:tr>${Array.from(
    { length: TALL_ROWS },
    (_, i) =>
      `<w:tr><w:tc><w:p><w:r><w:t>row ${i + 1}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>${cellText(i, TALL_ROWS)}</w:t></w:r></w:p></w:tc></w:tr>`,
  ).join('')}</w:tbl>`);

/** One list item per source position, and one item that is taller than a sheet. */
const oneMarkdownItem = () => `- ${rows(120).join(' ')} MKEND`;
const manyMarkdownItems = () => rows(120).map((line) => `- ${line}`).join('\n');
const oneHtmlList = () => `<ul>${Array.from({ length: TALL_ROWS }, (_, i) => `<li>${cellText(i, TALL_ROWS)}</li>`).join('')}</ul>`;
const oneJsonList = () => JSON.stringify([...rows(120), rows(120).join(' ')]);
const oneHeading = () => `# ${rows(120).join(' ')} MKEND`;

/** Whitespace collapsed, so wrapping and column order cannot hide a word. */
function compact(text: string): string {
  return text.replace(/\s+/g, '');
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

interface Sheet {
  /** Every character the file puts inside a page box, in reading order. */
  onSheet: string;
  /** Every character in the content stream, on a sheet or below its edge. */
  drawn: string;
  /** Text runs painted outside their page's box — the shape of this bug. */
  offSheet: TextRun[];
  /** Path points (bars, rules, code boxes) outside their page's box. */
  offSheetPaths: string[];
  /** Runs grouped by the baseline they were drawn on, for the stacking check. */
  baselines: Map<string, number>;
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
  const baselines = new Map<string, number>();
  for (const run of inOrder.filter(inside)) {
    const key = `${run.page}:${run.y.toFixed(1)}`;
    baselines.set(key, (baselines.get(key) ?? 0) + 1);
  }
  const onSheetRuns = inOrder.filter(inside);
  return {
    onSheet: onSheetRuns.map((run) => run.text).join(' '),
    drawn: inOrder.map((run) => run.text).join(' '),
    offSheet: runs.filter((run) => !inside(run)),
    offSheetPaths,
    baselines,
    pages: sizes.length,
    runs,
  };
}

/**
 * Why the tail did not arrive: the first marker a reader cannot find on a sheet,
 * how far into the source it sat, and how much of the content stream hangs outside
 * a page box. `''` means every marker reached a sheet.
 */
function tailGap(sheet: Sheet, source: string): string {
  const arrived = compact(sheet.onSheet);
  const missing = MARKS.find((mark) => !arrived.includes(mark));
  if (!missing) return '';
  const cut = compact(source).indexOf(missing);
  return `${missing} is not on a sheet (byte ${cut} of ${compact(source).length} in the source); `
    + `${compact(sheet.onSheet).length} of ${compact(sheet.drawn).length} stream characters are on a sheet, `
    + `${sheet.offSheet.length} of ${sheet.runs.length} runs are not`;
}

beforeAll(() => installConvertToEnv());
afterAll(() => restoreConvertToEnv());

async function typeset(
  id: string,
  values: Record<string, unknown> = {},
  file: File = fileFrom('x', 'a.txt', 'text/plain'),
): Promise<{ sheet: Sheet; message: string | undefined; pagesOut: number | null }> {
  const outcome = await run(id, values, [file]);
  const bytes = await firstPdf(outcome);
  return { sheet: await sheets(bytes), message: outcome.message, pagesOut: outcome.pagesOut };
}

/**
 * The bullet or number `renderList` draws beside an item’s first line.
 *
 * It is the only run placed at `margin + 2`; every line of item text starts at the
 * indent (70 at the default margin), and the glyph itself decodes to an invisible
 * WinAnsi C1 byte, so position is what identifies it.
 */
function listMarkers(sheet: Sheet, margin = 56): TextRun[] {
  return sheet.runs.filter((run) => Math.abs(run.x - (margin + 2)) < 0.5 && run.text.length === 1);
}

describe('renderTable: a row taller than a sheet continues on the next one', () => {
  it('lands every marker inside a page box, MKEND last of all', async () => {
    const source = tallCsv();
    const { sheet } = await typeset('csv-to-pdf', {}, fileFrom(source, 'a.csv', 'text/csv'));
    expect(tailGap(sheet, source)).toBe('');
    expect(sheet.offSheet).toEqual([]);
    expect(sheet.offSheetPaths).toEqual([]);
    // The row spans sheets, so the document is longer than the pages the old
    // build counted without printing on.
    expect(sheet.pages).toBeGreaterThan(TALL_ROWS);
  });

  it('splits a row between wrapped lines, not between glyphs', async () => {
    // The chosen behaviour for a row taller than a page: continue it, one band of
    // cell text per line, header repeated. Clipping instead would have to be said
    // in the tool, and the cell is the user's data.
    const source = JSON.stringify({ note: 'x '.repeat(6000) + 'MKEND' });
    const { sheet } = await typeset('json-to-pdf', {}, fileFrom(source, 'a.json', 'application/json'));
    expect(compact(sheet.onSheet)).toContain('MKEND');
    expect(sheet.offSheet).toEqual([]);
    expect(sheet.pages).toBeGreaterThan(3);
  });

  it('draws one line of every cell per baseline, so columns stay readable', async () => {
    // 12 columns → at most 12 runs may share a baseline. Before the fix a wide CSV
    // stacked 73 of them on one y, because the row's own line loop never moved it.
    const columns = 12;
    const head = Array.from({ length: columns }, (_, c) => `col ${c + 1}`);
    const body = Array.from({ length: 30 }, (_, r) =>
      head.map((_, c) =>
        `"r${r + 1}c${c + 1} ${c === 0 ? headMark(r, 30) : ''} ${BODY}${r === 29 && c === columns - 1 ? ' MKEND' : ''}"`.trim(),
      ).join(','));
    const source = `${head.join(',')}\n${body.join('\n')}`;
    const { sheet } = await typeset('csv-to-pdf', {}, fileFrom(source, 'a.csv', 'text/csv'));
    const stacked = [...sheet.baselines.entries()].sort((a, b) => b[1] - a[1]);
    expect(stacked[0]![1], 'lines sharing one baseline').toBeLessThanOrEqual(columns);
    expect(tailGap(sheet, source)).toBe('');
    expect(sheet.offSheet).toEqual([]);
  });

  it('repeats the header on every sheet the table spills onto, and once per sheet', async () => {
    const { sheet } = await typeset('csv-to-pdf', {}, fileFrom(tallCsv(), 'a.csv', 'text/csv'));
    const headers = sheet.runs.filter((run) => run.text === 'note');
    expect(headers.length, 'one header row per sheet, no more').toBe(sheet.pages);
    expect(new Set(headers.map((run) => run.page)).size).toBe(sheet.pages);
  });

  it('prints nothing twice across a break', async () => {
    const source = tallCsv();
    const { sheet } = await typeset('csv-to-pdf', {}, fileFrom(source, 'a.csv', 'text/csv'));
    const arrived = compact(sheet.onSheet);
    for (const mark of MARKS) {
      // Each marker sits once in this source, so twice on a sheet means a row
      // painted on both sides of the break.
      expect(countOccurrences(arrived, mark), mark).toBe(1);
    }
    expect(arrived).toContain('cell5sentence40');
    expect(countOccurrences(arrived, 'cell5sentence40')).toBe(1);
  });

  it('is no worse on a table of ordinary rows than it was', async () => {
    // The shape that already worked: many rows, each short. Count, order and page
    // numbers must be untouched by a change to the tall-row path.
    const lines = rows(120);
    const cells = lines.map((_, i) => `item${String(i + 1).padStart(3, '0')}`);
    const source = `id,label,note\n${lines.map((l, i) => `${i + 1},"${l}",${cells[i]}`).join('\n')}`;
    const { sheet, pagesOut, message } = await typeset('csv-to-pdf', {}, fileFrom(source, 'a.csv', 'text/csv'));
    expect(tailGap(sheet, source)).toBe('');
    expect(sheet.offSheet).toEqual([]);
    expect(sheet.offSheetPaths).toEqual([]);
    expect(sheet.pages).toBe(pagesOut);
    expect(message).toContain(`${sheet.pages} page(s)`);
    const arrived = compact(sheet.onSheet);
    // One of each row's own cell, and one header per sheet: nothing lost, nothing
    // printed twice.
    for (const cell of cells) expect(countOccurrences(arrived, cell), cell).toBe(1);
    expect(countOccurrences(arrived, 'idlabelnote')).toBe(sheet.pages);
  });

  it('keeps the page count it prints equal to the sheets it wrote', async () => {
    for (const [label, source] of [
      ['many rows', `id,label\n${lines2(200)}`],
      ['one tall row', tallCsv()],
    ] as [string, string][]) {
      const { sheet, pagesOut, message } = await typeset('csv-to-pdf', {}, fileFrom(source, 'a.csv', 'text/csv'));
      expect(pagesOut, label).toBe(sheet.pages);
      expect(message, label).toMatch(new RegExp(`into ${sheet.pages} page\\(s\\)`));
      expect(sheet.offSheet, label).toEqual([]);
    }
  });
});

/** 200 plain `n,label n` CSV body lines. */
function lines2(count: number): string {
  return Array.from({ length: count }, (_, i) => `${i + 1},item ${i + 1}`).join('\n');
}

describe('renderList: an item taller than a sheet continues on the next one', () => {
  it('lands every marker of one item that is taller than a page', async () => {
    const source = oneMarkdownItem();
    const { sheet } = await typeset('markdown-to-pdf', {}, fileFrom(source, 'a.md', 'text/markdown'));
    expect(tailGap(sheet, source)).toBe('');
    expect(sheet.offSheet).toEqual([]);
    expect(sheet.pages).toBeGreaterThan(2);
  });

  it('draws an item’s bullet once, on the sheet the item starts on', async () => {
    const { sheet } = await typeset('html-to-pdf', {}, fileFrom(oneHtmlList(), 'a.html', 'text/html'));
    const markers = listMarkers(sheet);
    expect(markers.length).toBe(TALL_ROWS);
    expect(new Set(markers.map((run) => run.page)).size).toBe(TALL_ROWS);
    expect(sheet.offSheet).toEqual([]);
  });

  it('is no worse on a list of ordinary items than it was', async () => {
    const source = manyMarkdownItems();
    const { sheet } = await typeset('markdown-to-pdf', {}, fileFrom(source, 'a.md', 'text/markdown'));
    expect(tailGap(sheet, source)).toBe('');
    expect(sheet.offSheet).toEqual([]);
    expect(sheet.offSheetPaths).toEqual([]);
    const arrived = compact(sheet.onSheet);
    for (const line of rows(120)) expect(arrived).toContain(compact(line));
    // Each item is short enough to move whole, so nothing continues and nothing
    // is printed twice: one bullet per item, as before.
    expect(listMarkers(sheet).length).toBe(120);
  });

  it('keeps a JSON array’s items in order across the break', async () => {
    const source = oneJsonList();
    const { sheet } = await typeset('json-to-pdf', {}, fileFrom(source, 'a.json', 'application/json'));
    expect(tailGap(sheet, source)).toBe('');
    expect(sheet.offSheet).toEqual([]);
    // The JSON report prints every array element twice — once as the bullet, once
    // as `[n]: value` — so both copies have to survive, and neither doubled.
    expect(countOccurrences(compact(sheet.onSheet), 'MKEND'))
      .toBe(countOccurrences(compact(source), 'MKEND') * 2);
  });
});

describe('the sweep: the two other branches with the same shape', () => {
  it('carries a heading taller than a sheet onto the next one', async () => {
    const source = oneHeading();
    const { sheet } = await typeset('markdown-to-pdf', {}, fileFrom(source, 'a.md', 'text/markdown'));
    expect(tailGap(sheet, source)).toBe('');
    expect(sheet.offSheet).toEqual([]);
    expect(sheet.pages).toBeGreaterThan(2);
  });

  it('carries a picture caption longer than the room the picture left', async () => {
    const dataUrl = `data:image/png;base64,${Buffer.from(PNG_1PX).toString('base64')}`;
    const source = `![${rows(120).join(' ')} MKEND](${dataUrl})`;
    const { sheet } = await typeset('markdown-to-pdf', {}, fileFrom(source, 'a.md', 'text/markdown'));
    expect(tailGap(sheet, source)).toBe('');
    expect(sheet.offSheet).toEqual([]);
  });

  it('leaves the branches that already turn alone', async () => {
    // The code block already turned per line, and so does a rule: neither may
    // regress because a sibling was being fixed.
    const fenced = "```text\n" + rows(200).join('\n') + '\n```\n\nMKEND';
    const { sheet } = await typeset('markdown-to-pdf', {}, fileFrom(fenced, 'a.md', 'text/markdown'));
    expect(sheet.offSheet).toEqual([]);
    expect(sheet.offSheetPaths).toEqual([]);
    expect(compact(sheet.onSheet)).toContain('MKEND');
    expect(compact(sheet.onSheet)).toContain('1MKSTARTrowcarriesbodytext');
  });
});

describe('every converter that reaches the two renderers', () => {
  const cases: [string, () => Promise<File> | File, string][] = [
    ['csv-to-pdf', () => fileFrom(tallCsv(), 'a.csv', 'text/csv'), tallCsv()],
    ['json-to-pdf', () => fileFrom(tallJson(), 'a.json', 'application/json'), tallJson()],
    ['markdown-to-pdf', () => fileFrom(tallMarkdownTable(), 'a.md', 'text/markdown'), tallMarkdownTable()],
    ['html-to-pdf', () => fileFrom(tallHtmlTable(), 'a.html', 'text/html'), tallHtmlTable()],
    ['word-to-pdf', async () => fileFrom(await tallWordTable(), 'a.docx'), ''],
    ['markdown-to-pdf', () => fileFrom(oneMarkdownItem(), 'a.md', 'text/markdown'), oneMarkdownItem()],
    ['html-to-pdf', () => fileFrom(oneHtmlList(), 'a.html', 'text/html'), oneHtmlList()],
    ['json-to-pdf', () => fileFrom(oneJsonList(), 'a.json', 'application/json'), oneJsonList()],
    ['xml-to-pdf', () => fileFrom(`<root><doc>${rows(120).join('\n')}</doc></root>`, 'a.xml', 'application/xml'), rows(120).join('\n')],
    ['word-to-pdf', async () => fileFrom(await docxBytes(rows(120).map((l) => `<w:p><w:r><w:t>${l}</w:t></w:r></w:p>`).join('')), 'a.docx'), ''],
  ];

  for (const [index, [id, makeFile, source]] of cases.entries()) {
    it(`${id} keeps every marker of a ${index < 5 ? 'table' : 'list or tree'} row inside a page box`, async () => {
      const outcome = await run(id, {}, [await makeFile()]);
      const sheet = await sheets(await firstPdf(outcome));
      const text = compact(sheet.onSheet);
      const missing = MARKS.filter((mark) => !text.includes(mark));
      expect(missing, `${id}: ${tailGap(sheet, source)}`).toEqual([]);
      expect(sheet.offSheet, id).toEqual([]);
      expect(sheet.offSheetPaths, id).toEqual([]);
      expect(sheet.pages, id).toBeGreaterThan(2);
      expect(outcome.pagesOut, id).toBe(sheet.pages);
    });
  }

  it('reaches those renderers through the parsers this file names, not by guess', async () => {
    const kinds = (blocks: Block[]): string[] => [...new Set(blocks.map((block) => block.kind))].sort();
    expect(kinds(await csvToBlocks('a,b\n1,2'))).toEqual(['table']);
    expect(kinds(jsonToBlocks({ note: 'x' }))).toEqual(['table']);
    expect(kinds(jsonToBlocks(['x', 'y']))).toEqual(['list', 'paragraph']);
    expect(kinds(await markdownToBlocks('| a | b |\n| --- | --- |\n| 1 | 2 |'))).toEqual(['table']);
    expect(kinds(await markdownToBlocks('- one\n- two'))).toEqual(['list']);
    expect(kinds(await htmlToBlocks('<table><tr><td>1</td></tr></table>'))).toEqual(['table']);
    expect(kinds(await htmlToBlocks('<ul><li>one</li></ul>'))).toEqual(['list']);
    // XML is in this sweep because its tree is tall, not because it makes a table:
    // the parser only ever emits a heading and paragraphs, which are the branches
    // `text-tail.test.ts` fixed and this file re-checks above.
    expect(kinds(xmlToBlocks('<root><item>x</item></root>'))).toEqual(['heading', 'paragraph']);
    expect(kinds(textToBlocks('one\n\ntwo'))).toEqual(['paragraph']);
  });

  it('says in the tool what the bytes now do', () => {
    const claim = /taller than one sheet[\s\S]*continued on the next sheet/i;
    for (const id of ['txt-to-pdf', 'markdown-to-pdf', 'html-to-pdf', 'csv-to-pdf', 'json-to-pdf', 'xml-to-pdf', 'word-to-pdf']) {
      const notes = getPdfTool(id)?.notes ?? [];
      expect(notes.some((note) => claim.test(note)), `${id} notes the continuation`).toBe(true);
    }
    // The CSV route promises a header on every page; that promise is now tested
    // above rather than only printed.
    expect(getPdfTool('csv-to-pdf')?.promise).toMatch(/header repeated on each page/);
  });
});

describe('the Markdown tab that was still outstanding', () => {
  it('produces a file for a source holding one tab, in prose, a list and a table', async () => {
    const sources = [
      'alpha\tbeta MKEND',
      '- MKSTART one\ttwo\n- MKEND three\tfour',
      '| a | b |\n| --- | --- |\n| x\ty | MKEND |',
    ];
    for (const source of sources) {
      const outcome = await run('markdown-to-pdf', { source: 'paste', paste: source });
      const sheet = await sheets(await firstPdf(outcome));
      expect(sheet.offSheet, source).toEqual([]);
      expect(compact(sheet.onSheet), source).toContain('MKEND');
    }
  });

  it('keeps an indented block a block, the way four spaces do', async () => {
    // CommonMark's tab stop is four columns, which is the expansion applied; a tab
    // that meant a nested list or a fenced block must not become prose.
    const source = '- one\n\t- MKEND nested\n';
    const outcome = await run('markdown-to-pdf', { source: 'paste', paste: source });
    const sheet = await sheets(await firstPdf(outcome));
    expect(compact(sheet.onSheet)).toContain('MKENDnested');
  });
});

/**
 * Measured on this build and left for its owner: a different shape from the one
 * this file fixes, found while making the fixtures tall enough to reach the page
 * edge. `wrapInlines` adds the width of every candidate prefix to the running
 * total instead of the width of the word just appended, so a line breaks at about
 * a sixth of the column it was given. Nothing is lost — every character still
 * lands inside a page box — but the sheet is mostly blank and the page count, and
 * with it every honest “N page(s)” sentence, is several times what the text needs.
 * Passing of these means someone fixed it: retire the row and re-measure the
 * fixture tables in `docs/research/`, whose counts were taken through this wrapper.
 */
describe('OPEN: the wrapper spends a sixth of the column it is given', () => {
  it('breaks a line at ~22 characters of a 469-point column', async () => {
    const doc = await newDocumentForLayout();
    const column = 469;
    const one = await measureText(doc, { text: BODY, x: 0, y: 0, size: 11 });
    const capacity = Math.floor((column / one.width) * BODY.length);
    const lines = await wrapInlines(doc, [{ text: `${BODY} ${BODY} ${BODY} ${BODY}` }], {
      size: 11,
      maxWidth: column,
    });
    const widest = Math.max(...lines.map((line) => line.map((run) => run.text).join('').trim().length));
    expect(one.width).toBeGreaterThan(300);
    expect(widest, 'characters the wrapper puts on a line').toBeLessThan(capacity / 3);
  });

  it('inflates the page count of the tail fixtures by the same ratio', async () => {
    // 120 short paragraphs of prose take 12 sheets; at the width the metrics
    // allow, each row is one line and the file is a third of that. The number is
    // recorded rather than asserted as a target, so a fix shows up as a change.
    const { sheet } = await typeset('txt-to-pdf', {}, fileFrom(rows(120).join('\n\n'), 'doc.txt', 'text/plain'));
    expect(sheet.pages).toBeGreaterThan(9);
    expect(sheet.offSheet).toEqual([]);
  });
});
