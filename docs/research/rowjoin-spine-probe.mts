#!/usr/bin/env node
/**
 * Spine probe for the run join: run the REAL extraction spine (pdf.js → core/render
 * mapping → core/tables clusterRows → core/convert rowText) over the staged
 * fixtures in plain node, and dump per-row item geometry + the joined string.
 *
 *   PDFJS_WORKER=file://$PWD/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs \
 *     /tmp/rowjoin/probe.mjs /tmp/rowjoin/pre.jsonl <pdf...>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import { toExtractedItems } from '../../src/lib/pdf/core/render';
import { clusterRows } from '../../src/lib/pdf/core/tables';
import { rowText, blocksFromItems, blocksWithTables } from '../../src/lib/pdf/core/convert';

// Bundled by esbuild (the command is in the header of docs/research/rowjoin-gaps.py),
// which rewrites `pdfjs-dist` to the legacy build; the worker sits beside it in
// node_modules, and the bundle does not live in the repo, so it is passed in.
GlobalWorkerOptions.workerSrc =
  process.env.PDFJS_WORKER ??
  new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;

const [out, ...files] = process.argv.slice(2);
const rows: unknown[] = [];

for (const file of files) {
  const data = new Uint8Array(readFileSync(file));
  try {
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
    const content = await page.getTextContent();
    const items = toExtractedItems(content, p, viewport);
    for (const row of clusterRows(items)) {
      rows.push({
        file: file.replace(/^.*\//, ''),
        page: p,
        rotate: page.rotate,
        dir: row.items[0]?.dir ?? 'ltr',
        spine: rowText(row),
        items: row.items.map((i) => ({
          s: i.str,
          x: +i.x.toFixed(3),
          y: +i.y.toFixed(3),
          w: +i.w.toFixed(3),
          h: +i.h.toFixed(3),
          fs: +i.fontSize.toFixed(3),
          ux: +i.ux.toFixed(3),
          uy: +i.uy.toFixed(3),
          f: i.fontName,
        })),
      });
    }
    // What the table path prints: pdf-to-csv / extract-tables / pdf-to-excel cells.
    for (const b of blocksWithTables(items)) {
      if (b.type === 'table' && b.rows) {
        rows.push({ file: file.replace(/^.*\//, ''), page: p, table: b.rows, rect: b.rect });
      }
    }
    // Whole-page block text, i.e. what pdf-to-text / a chunk actually prints.
    rows.push({
      file: file.replace(/^.*\//, ''),
      page: p,
      blocks: blocksFromItems(items).map((b) => b.text),
    });
  }
  await doc.destroy();
  } catch (e) {
    console.log(`skip:${file}:${String(e).slice(0, 120)}`);
  }
}

writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`rows:${rows.length} files:${files.length}`);
