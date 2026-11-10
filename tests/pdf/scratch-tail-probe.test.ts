/**
 * Temporary diagnostic probe for the `txt-to-pdf` truncation
 * (docs/TOOL-TRIAGE.md §4). Prints a marker table, writes the produced PDFs to
 * /tmp/txttail for an outside reader, and asserts nothing.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import {
  docxBytes,
  fileFrom,
  firstPdf,
  installConvertToEnv,
  pageSizes,
  restoreConvertToEnv,
  run,
  textRuns,
} from './convert-to-harness';

beforeAll(() => installConvertToEnv());
afterAll(() => restoreConvertToEnv());

const COUNT = 120;
const MARKS: [number, string][] = [
  [0, 'MKSTART'],
  [Math.round(COUNT * 0.25), 'MK25'],
  [Math.round(COUNT * 0.5), 'MK50'],
  [Math.round(COUNT * 0.75), 'MK75'],
  [COUNT - 1, 'MKEND'],
];

/** Numbered sentences whose text a reader can grep for, one marker per position. */
function lines(): string[] {
  const mark = new Map(MARKS);
  return Array.from({ length: COUNT }, (_, i) => {
    const tag = mark.get(i);
    const words = `row ${i + 1} of the manuscript carries body text that wraps`;
    return tag ? `${i + 1} ${tag} ${words}` : `${i + 1} ${words}`;
  });
}

const L = lines();
const FLAT = L.join('\n'); // one tall block
const SPACED = L.join('\n\n'); // one block per line

async function measure(label: string, id: string, values: Record<string, unknown>, files: File[]) {
  const outcome = await run(id, values, files);
  const bytes = await firstPdf(outcome);
  const runs = await textRuns(bytes);
  const sizes = await pageSizes(bytes);
  writeFileSync(`/tmp/txttail/${label}.pdf`, bytes);
  const source = L.join(' ');
  const drawn = runs.map((r) => r.text).join('');
  // A run is on the sheet when its baseline sits inside the page box.
  const onSheet = runs.filter((r) => {
    const [, height] = sizes[r.page] ?? [595.28, 841.89];
    return r.y >= 0 && r.y <= height;
  });
  const onSheetText = onSheet.map((r) => r.text).join('');
  const firstMissing = MARKS.map(([, m]) => m).find((m) => !onSheetText.includes(m)) ?? '—';
  console.log(
    `${label.padEnd(28)} pages ${String(sizes.length).padStart(2)} | ` +
    `chars on page ${String(onSheetText.length).padStart(5)} of ${String(drawn.length).padStart(5)} drawn ` +
    `(${source.length} in source) | last row on sheet ${String(Math.max(0, ...onSheet.map((r) => Number(/row (\d+) of/.exec(r.text)?.[1] ?? 0)))).padStart(3)} ` +
    `| first missing ${firstMissing} | msg ${JSON.stringify(outcome.message)}`,
  );
  const off = runs.filter((r) => {
    const [, height] = sizes[r.page] ?? [595.28, 841.89];
    return r.y < 0 || r.y > height;
  });
  if (off.length > 0) {
    const lowest = Math.min(...off.map((r) => r.y));
    console.log(`  ${' '} └ ${off.length} run(s) off the sheet, lowest baseline y=${lowest.toFixed(1)} (${off[0]?.text.slice(0, 40)})`);
  }
}

describe('probe', () => {
  it('runs every text route over a tall block and over many short blocks', async () => {
    const txt = (name: string, text: string) => fileFrom(text, name, 'text/plain');
    await measure('txt-flat', 'txt-to-pdf', {}, [txt('a.txt', FLAT)]);
    await measure('txt-spaced', 'txt-to-pdf', {}, [txt('a.txt', SPACED)]);
    await measure('txt-flat-mono', 'txt-to-pdf', { monospace: true }, [txt('a.txt', FLAT)]);
    await measure('txt-flat-nopara', 'txt-to-pdf', { paragraphs: false }, [txt('a.txt', FLAT)]);

    await measure('md-flat', 'markdown-to-pdf', {}, [fileFrom(FLAT, 'a.md', 'text/markdown')]);
    await measure('md-spaced', 'markdown-to-pdf', {}, [fileFrom(SPACED, 'a.md', 'text/markdown')]);

    await measure('html-one-p', 'html-to-pdf', {}, [fileFrom(`<html><body><p>${FLAT}</p></body></html>`, 'a.html', 'text/html')]);
    await measure('html-many-p', 'html-to-pdf', {}, [fileFrom(`<html><body>${L.map((l) => `<p>${l}</p>`).join('')}</body></html>`, 'a.html', 'text/html')]);

    await measure('csv', 'csv-to-pdf', {}, [fileFrom(`text\n${L.map((l) => `"${l.replace(/"/g, '""')}"`).join('\n')}`, 'a.csv', 'text/csv')]);
    await measure('xml', 'xml-to-pdf', {}, [fileFrom(`<root>${L.map((l) => `<item>${l}</item>`).join('')}</root>`, 'a.xml', 'application/xml')]);
    await measure('xml-one-text', 'xml-to-pdf', {}, [fileFrom(`<root><doc>${FLAT}</doc></root>`, 'a.xml', 'application/xml')]);
    await measure('json-list', 'json-to-pdf', {}, [fileFrom(JSON.stringify(L), 'a.json', 'application/json')]);

    await measure('word', 'word-to-pdf', {}, [
      fileFrom(await docxBytes(L.map((l) => `<w:p><w:r><w:t>${l}</w:t></w:r></w:p>`).join('')), 'a.docx'),
    ]);
    await measure('word-one-p', 'word-to-pdf', {}, [
      fileFrom(await docxBytes(`<w:p><w:r><w:t>${FLAT}</w:t></w:r></w:p>`), 'a.docx'),
    ]);
  });
});
