#!/usr/bin/env node
/**
 * Table row-band probe: for every detected table, dump the physical rows that
 * fed it — their y extents, the grid column each run landed in, and the vertical
 * gap to the next row — so the `<br>` / wrapped-cell question can be answered
 * with geometry instead of a guess.
 *
 *   PDFJS_WORKER=file://… node /tmp/rowjoin/tables-probe.mjs out.jsonl <pdf...>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import { toExtractedItems } from '../../src/lib/pdf/core/render';
import { clusterRows, columnsFromRows, detectTables, gridRow } from '../../src/lib/pdf/core/tables';

GlobalWorkerOptions.workerSrc =
  process.env.PDFJS_WORKER ??
  new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;

const [out, ...files] = process.argv.slice(2);
const dumps: unknown[] = [];

for (const file of files) {
  try {
    const data = new Uint8Array(readFileSync(file));
    const doc = await getDocument({
      data,
      useWorkerFetch: false,
      isEvalSupported: false,
      disableFontFace: true,
      verbosity: 0,
    }).promise;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const items = toExtractedItems(await page.getTextContent(), p, viewport);
      const rows = clusterRows(items);
      const tables = detectTables(items);
      for (const table of tables) {
        const inside = rows.filter(
          (row) => (row.top + row.bottom) / 2 >= table.rect.y && (row.top + row.bottom) / 2 <= table.rect.y + table.rect.height,
        );
        if (inside.length === 0) continue;
        const columns = columnsFromRows(inside);
        const shapes = inside.map((row, i) => {
          const next = inside[i + 1];
          const cells = gridRow(row, columns);
          return {
            top: +row.top.toFixed(2),
            bottom: +row.bottom.toFixed(2),
            height: +(row.bottom - row.top).toFixed(2),
            gap: next ? +(next.top - row.bottom).toFixed(2) : null,
            filled: cells.map((cell, c) => (cell === '' ? null : c)),
            cells,
          };
        });
        dumps.push({
          file: file.replace(/^.*\//, ''),
          page: p,
          physicalRows: inside.length,
          gridRows: table.rows.length,
          columns: columns.length,
          rect: table.rect,
          shapes,
        });
      }
    }
    await doc.destroy();
  } catch (e) {
    console.log(`skip:${file}:${String(e).slice(0, 100)}`);
  }
}

writeFileSync(out, dumps.map((d) => JSON.stringify(d)).join('\n') + '\n');
console.log(`tables:${dumps.length} files:${files.length}`);
