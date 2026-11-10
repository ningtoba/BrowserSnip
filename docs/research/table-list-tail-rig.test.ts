/**
 * The table / list / heading tail rig: does the last row, item and heading line
 * reach a page?
 *
 * `docs/research/text-tail-rig.test.ts` proved the same question for the
 * paragraph branch of `core/layout.ts` and left two branches measured but not
 * fixed: `renderList` (52 of 426 runs inside a page box) and `renderTable`
 * (16 characters of 7 365). This rig asks the same question of every branch that
 * paints downward from where a block began, on fixtures that can be counted:
 * markers at 0 / 25 / 50 / 75 and the final row, item or line.
 *
 * Nothing here asserts a number. `table-list-tail-measure.py` judges the produced
 * files with MuPDF, which is the reader the campaign measures with, and the app's
 * own decoder records how many runs the content stream holds versus how many sit
 * inside a page box:
 *
 *   npx vitest run --config docs/research/table-list-tail.vitest.config.ts
 *   python3 docs/research/table-list-tail-measure.py after-fix \
 *     | tee docs/research/table-list-tail-after.txt
 *   git checkout <the fix>^ -- src/lib/pdf/core/layout.ts      # the pre-fix build
 *   <the same two lines> | tee docs/research/table-list-tail-before.txt
 *
 * The committed `-before.txt` / `-after.txt` tables are that output, at the same
 * fixtures, one build apart.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  docxBytes,
  fileFrom,
  firstPdf,
  installConvertToEnv,
  pageSizes,
  restoreConvertToEnv,
  run,
  textRuns,
} from '../../tests/pdf/convert-to-harness';

const MARKS = ['MKSTART', 'MK25', 'MK50', 'MK75', 'MKEND'] as const;

const BODY = 'row carries body text that wraps onto a second line before the margin';

/** Marker at source position 0 / 25 / 50 / 75 %, the four that are not the tail. */
function headMarkAt(index: number, total: number): string {
  const last = total - 1;
  const slot = MARKS.slice(0, -1).findIndex((_, mark) => Math.round((last * mark) / (MARKS.length - 1)) === index);
  return slot === -1 ? '' : MARKS[slot]!;
}

/** The markers spread over `count` rows, the fifth sitting on the final row. */
function markAt(index: number, total: number): string {
  return index === total - 1 ? MARKS[4]! : headMarkAt(index, total);
}

/** `count` numbered rows, the five markers spread across them. */
function rows(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const mark = markAt(index, count);
    return mark ? `${index + 1} ${mark} ${BODY}` : `${index + 1} ${BODY}`;
  });
}

/**
 * One long cell: `sentences` wrapped lines of body text, a head marker at its start
 * and — on the final row — `MKEND` as the very last text in the document, so a cell
 * cannot pass by having its head painted and its tail lost.
 */
function cellText(index: number, total: number, sentences = 40): string {
  const parts = Array.from(
    { length: sentences },
    (_, s) => `cell ${index + 1} sentence ${s + 1} ${BODY}`,
  );
  const mark = headMarkAt(index, total);
  if (mark) parts[0] = `${mark} ${parts[0]}`;
  if (index === total - 1) parts[parts.length - 1] = `${parts[parts.length - 1]} MKEND`;
  return parts.join(' ');
}

const face = () => new Uint8Array(readFileSync(join(process.cwd(), 'public', 'fonts', 'NotoSans-Regular.ttf')));
let inner: typeof fetch;

beforeAll(() => {
  mkdirSync('/tmp/tablelist', { recursive: true });
  installConvertToEnv();
  inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    /NotoSans(Arabic|Hebrew)_400Regular\.ttf$/.test(String(input))
      ? new Response(face(), { headers: { 'content-type': 'font/ttf' } })
      : inner(input as never)) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = inner;
  restoreConvertToEnv();
});

async function emit(label: string, id: string, values: Record<string, unknown>, file: File, source: string) {
  let message = '';
  let bytes = new Uint8Array(0);
  try {
    const outcome = await run(id, values, [file]);
    bytes = await firstPdf(outcome);
    message = String(outcome.message);
  } catch (error) {
    message = `THROWS: ${(error as Error).message}`;
  }
  if (bytes.length > 0) {
    writeFileSync(`/tmp/tablelist/${label}.pdf`, bytes);
    const [runs_, sizes] = [await textRuns(bytes), await pageSizes(bytes)];
    const inside = runs_.filter((r) => {
      const [w, h] = sizes[r.page] ?? [595.28, 841.89];
      return r.y >= 0 && r.y <= h && r.x >= 0 && r.x <= w;
    });
    writeFileSync(`/tmp/tablelist/${label}.stream.txt`, `${runs_.length}\t${inside.length}`);
  }
  writeFileSync(`/tmp/tablelist/${label}.msg.txt`, message, 'utf8');
  writeFileSync(`/tmp/tablelist/${label}.src.txt`, source, 'utf8');
  console.log(`${label.padEnd(14)} ${message}`);
}

describe('marker table', () => {
  it('writes the fixtures on both builds', { timeout: 480_000 }, async () => {
    const lines = rows(120);
    const flat = lines.join(' ');

    // ── renderTable: many ordinary rows, one row per sheet-fraction ──────────
    const csvRows = `id,label,note\n${lines.map((l, i) => `${i + 1},"${l}",note ${i + 1}`).join('\n')}`;
    await emit('csv-rows', 'csv-to-pdf', {}, fileFrom(csvRows, 'a.csv', 'text/csv'), csvRows);

    // ── renderTable: five rows, each holding a cell taller than the sheet ────
    const csvTall = `id,label,note\n${Array.from({ length: 5 }, (_, i) =>
      `${i + 1},row ${i + 1},"${cellText(i, 5)}"`).join('\n')}`;
    await emit('csv-tallcell', 'csv-to-pdf', {}, fileFrom(csvTall, 'a.csv', 'text/csv'), csvTall);

    // ── renderTable: a wide sheet, where every cell wraps to many lines ──────
    const wide = Array.from({ length: 12 }, (_, c) => `col ${c + 1}`);
    const wideRows = Array.from({ length: 40 }, (_, r) =>
      wide.map((_, c) =>
        `r${r + 1}c${c + 1} ${c === 0 ? headMarkAt(r, 40) : ''} ${BODY.slice(0, 24)}${r === 39 && c === 11 ? ' MKEND' : ''}`.trim()));
    await emit('csv-wide', 'csv-to-pdf', {},
      fileFrom(`${wide.join(',')}\n${wideRows.map((row) => row.map((cell) => `"${cell}"`).join(',')).join('\n')}`, 'a.csv', 'text/csv'),
      wideRows.flat().join(' '));

    // ── renderTable through the other converters that reach it ───────────────
    const jsonCell = JSON.stringify({ note: flat });
    await emit('json-cell', 'json-to-pdf', {}, fileFrom(jsonCell, 'a.json', 'application/json'), jsonCell);

    const mdTable = `| id | note |\n| --- | --- |\n${Array.from({ length: 5 }, (_, i) =>
      `| row ${i + 1} | ${cellText(i, 5)} |`).join('\n')}`;
    await emit('md-table', 'markdown-to-pdf', {}, fileFrom(mdTable, 'a.md', 'text/markdown'), mdTable);

    const htmlTable = `<table><thead><tr><th>id</th><th>note</th></tr></thead><tbody>${Array.from(
      { length: 5 },
      (_, i) => `<tr><td>row ${i + 1}</td><td>${cellText(i, 5)}</td></tr>`,
    ).join('')}</tbody></table>`;
    await emit('html-table', 'html-to-pdf', {}, fileFrom(htmlTable, 'a.html', 'text/html'), htmlTable);

    const wordTable = `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>id</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>note</w:t></w:r></w:p></w:tc></w:tr>${Array.from(
      { length: 5 },
      (_, i) =>
        `<w:tr><w:tc><w:p><w:r><w:t>row ${i + 1}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>${cellText(i, 5)}</w:t></w:r></w:p></w:tc></w:tr>`,
    ).join('')}</w:tbl>`;
    await emit('word-table', 'word-to-pdf', {}, fileFrom(await docxBytes(wordTable), 'a.docx'), wordTable);

    // ── renderList: one item taller than a sheet, and the ordinary many-item case
    const mdItem = `- ${flat} MKEND`;
    await emit('md-item', 'markdown-to-pdf', {}, fileFrom(mdItem, 'a.md', 'text/markdown'), mdItem);

    const mdItems = lines.map((l) => `- ${l}`).join('\n');
    await emit('md-items', 'markdown-to-pdf', {}, fileFrom(mdItems, 'a.md', 'text/markdown'), mdItems);

    const htmlList = `<ul>${Array.from({ length: 5 }, (_, i) => `<li>${cellText(i, 5)}</li>`).join('')}</ul>`;
    await emit('html-list', 'html-to-pdf', {}, fileFrom(htmlList, 'a.html', 'text/html'), htmlList);

    const htmlItems = `<ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul>`;
    await emit('html-items', 'html-to-pdf', {}, fileFrom(htmlItems, 'a.html', 'text/html'), htmlItems);

    const jsonItems = JSON.stringify([...lines, flat]);
    await emit('json-item', 'json-to-pdf', {}, fileFrom(jsonItems, 'a.json', 'application/json'), jsonItems);

    // ── the heading branch: the same shape, one step further down the list ───
    const mdHeading = `# ${flat} MKEND`;
    await emit('md-heading', 'markdown-to-pdf', {}, fileFrom(mdHeading, 'a.md', 'text/markdown'), mdHeading);

    // ── the Markdown tab, which the prose branch already expanded ────────────
    const mdTab = `MKSTART alpha\tbeta\n\n- MK50 gamma\tdelta\n\nMKEND zeta\teta`;
    await emit('md-tab', 'markdown-to-pdf', {}, fileFrom(mdTab, 'a.md', 'text/markdown'), mdTab);

    // ── the paragraph path, unchanged by this pass, kept as a control ────────
    const xmlTree = `<root>${lines.map((l) => `<item>${l}</item>`).join('')}</root>`;
    await emit('xml-tree', 'xml-to-pdf', {}, fileFrom(xmlTree, 'a.xml', 'application/xml'), xmlTree);

    // ── a tab in each route, which the prose branch already expands ──────────
    await emit('xml-tab', 'xml-to-pdf', {},
      fileFrom('<root><item>MKSTART a\tb</item><item>MKEND c\td</item></root>', 'a.xml', 'application/xml'),
      'MKSTART a\tb MKEND c\td');
    await emit('csv-tab', 'csv-to-pdf', {},
      fileFrom('id,label\n1,"MKSTART a\tb"\n2,"MKEND c\td"', 'a.csv', 'text/csv'),
      'MKSTART a\tb MKEND c\td');
    await emit('html-tab', 'html-to-pdf', {},
      fileFrom('<p>MKSTART a\tb</p><ul><li>MKEND c\td</li></ul>', 'a.html', 'text/html'),
      'MKSTART a\tb MKEND c\td');
  });
});
