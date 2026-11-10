/**
 * The `txt-to-pdf` tail rig: does the last line of a text file reach a page?
 *
 * `docs/TOOL-TRIAGE.md` §4 measured 968 of 2 861 characters arriving, mid-line,
 * under a sentence that read "Typeset 1 text source(s) into 2 page(s)". This rig
 * re-measures that shape with a source that can be counted — 120 numbered rows
 * carrying `MKSTART`/`MK25`/`MK50`/`MK75`/`MKEND` at 0 %, 25 %, 50 %, 75 % and the
 * final line — through the text route and every sibling that shares
 * `core/layout.ts`, and writes one PDF per case plus its source and the count of
 * text runs the file holds versus the count inside a page box.
 *
 * Nothing here asserts a number. `text-tail-measure.py` judges the produced files
 * with MuPDF, which is the reader the campaign measures with:
 *
 *   npx vitest run --config docs/research/text-tail.vitest.config.ts \
 *     > /tmp/txttail-app.log
 *   python3 docs/research/text-tail-measure.py after-fix | tee docs/research/text-tail-after.txt
 *   git checkout <the fix>^ -- src/lib/pdf/core/layout.ts      # the pre-fix build
 *   <the same two lines> | tee docs/research/text-tail-before.txt
 *
 * The committed `-before.txt` / `-after.txt` tables are that output, at the same
 * fixtures, one build apart.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPdfTool } from '@/lib/pdf/tools/registry';
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

const face = () => new Uint8Array(readFileSync(join(process.cwd(), 'public', 'fonts', 'NotoSans-Regular.ttf')));
let inner: typeof fetch;

beforeAll(() => {
  mkdirSync('/tmp/txttail', { recursive: true });
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
  let bytes: Uint8Array;
  try {
    const outcome = await run(id, values, [file]);
    bytes = await firstPdf(outcome);
    message = String(outcome.message);
  } catch (error) {
    message = `THROWS: ${(error as Error).message}`;
    bytes = new Uint8Array(0);
  }
  if (bytes.length > 0) {
    writeFileSync(`/tmp/txttail/${label}.pdf`, bytes);
    const [runs, sizes] = [await textRuns(bytes), await pageSizes(bytes)];
    const inside = runs.filter((r) => {
      const [w, h] = sizes[r.page] ?? [595.28, 841.89];
      return r.y >= 0 && r.y <= h && r.x >= 0 && r.x <= w;
    });
    writeFileSync(`/tmp/txttail/${label}.stream.txt`, `${runs.length}\t${inside.length}`);
  }
  writeFileSync(`/tmp/txttail/${label}.msg.txt`, message, 'utf8');
  writeFileSync(`/tmp/txttail/${label}.src.txt`, source, 'utf8');
  console.log(`${label.padEnd(14)} ${message}`);
}

describe('marker table', () => {
  it('writes the fixtures on both builds', { timeout: 240_000 }, async () => {
    const lines = rows(120);
    const flat = lines.join('\n');
    const txt = (text: string) => fileFrom(text, 'doc.txt', 'text/plain');
    await emit('txt-flat', 'txt-to-pdf', {}, txt(flat), flat);
    await emit('txt-spaced', 'txt-to-pdf', {}, txt(lines.join('\n\n')), lines.join('\n\n'));
    await emit('txt-crlf', 'txt-to-pdf', {}, txt(lines.join('\r\n')), lines.join('\r\n'));
    await emit('txt-notrail', 'txt-to-pdf', {}, txt(lines.join('\n\n')), lines.join('\n\n'));
    const partial = `${lines.slice(0, -1).join('\n\n')}\n\n${lines[119]!.slice(0, 24)}MKEND`;
    await emit('txt-partial', 'txt-to-pdf', {}, txt(partial), partial);
    await emit('txt-tabs', 'txt-to-pdf', {}, txt(lines.map((l) => `\t${l.replace(' body', '\t\tbody')}`).join('\n')), lines.map((l) => `\t${l.replace(' body', '\t\tbody')}`).join('\n'));
    await emit('txt-mono', 'txt-to-pdf', { monospace: true }, txt(flat), flat);
    await emit('txt-huge', 'txt-to-pdf', {}, txt(rows(4000).join('\n')), rows(4000).join('\n'));
    await emit('md-flat', 'markdown-to-pdf', {}, fileFrom(flat, 'a.md', 'text/markdown'), flat);
    await emit('html-flat', 'html-to-pdf', {}, fileFrom(`<p>${flat}</p>`, 'a.html', 'text/html'), flat);
    await emit('xml-tall', 'xml-to-pdf', {}, fileFrom(`<root><doc>${flat}</doc></root>`, 'a.xml', 'application/xml'), flat);
    await emit('word-flat', 'word-to-pdf', {}, fileFrom(await docxBytes(`<w:p><w:r><w:t>${flat}</w:t></w:r></w:p>`), 'a.docx'), flat);
    const csvSource = `text\n${lines.map((l) => `"${l}"`).join('\n')}`;
    await emit('csv', 'csv-to-pdf', {}, fileFrom(csvSource, 'a.csv', 'text/csv'), csvSource);
    const jsonSource = JSON.stringify(lines);
    await emit('json', 'json-to-pdf', {}, fileFrom(jsonSource, 'a.json', 'application/json'), jsonSource);
    const jsonTall = JSON.stringify({ note: flat });
    await emit('json-cell', 'json-to-pdf', {}, fileFrom(jsonTall, 'a.json', 'application/json'), jsonTall);
    const xmlSource = `<root>${lines.map((l) => `<item>${l}</item>`).join('')}</root>`;
    await emit('xml', 'xml-to-pdf', {}, fileFrom(xmlSource, 'a.xml', 'application/xml'), xmlSource);
    const wordSource = lines.map((l) => `<w:p><w:r><w:t>${l}</w:t></w:r></w:p>`).join('');
    await emit('word', 'word-to-pdf', {}, fileFrom(await docxBytes(wordSource), 'a.docx'), wordSource);
    const mdList = `- ${lines.join(' ')}`;
    await emit('md-item', 'markdown-to-pdf', {}, fileFrom(mdList, 'a.md', 'text/markdown'), mdList);
    await emit('txt-unicode', 'txt-to-pdf', {}, txt([
      '1 MKSTART caf\u00e9 na\u00efve \u2014 \u03a9\u03bc\u03ad\u03b3\u03b1',
      '2 \u65e5\u672c\u8a9e\u306e\u30c6\u30ad\u30b9\u30c8 \ud55c\uad6d\uc5b4 row',
      `3 \u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645 ${MARKS[2]}`,
      ...rows(120).slice(3),
    ].join('\n\n')), `${MARKS[0]} ${MARKS[2]} ${MARKS[4]}`);
    console.log('txt notes:', JSON.stringify(getPdfTool('txt-to-pdf')?.notes));
  });
});
