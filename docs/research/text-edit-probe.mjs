/**
 * Phase 1 rig for `edit-pdf-text`: measure deletion and font fidelity with the
 * app's own modules, in a real Chromium tab, over the fixture corpus.
 *
 *   BASE=http://localhost:5311 python3 docs/research/text-edit-fixture.py /tmp/tf
 *   BASE=http://localhost:5311 node docs/research/text-edit-probe.mjs /tmp/tf /tmp/tf/out
 *
 * For every fixture it
 *
 *   1. extracts the page's blocks the way the editor does (`openRender` →
 *      `clusterParagraphs` → `deletionBoxes`), sampling the palette off a real
 *      pdf.js paint so the block carries the page's own colours;
 *   2. deletes each block **on its own** (`deleteOriginalText`) and records the
 *      outcome — clean / partial / nothing removed — plus the structural facts
 *      that explain it, from the engine's own content walk;
 *   3. runs the **whole** pipeline once per file (`applyEdits` + `savePDF`) with
 *      every block retyped, and writes the result next to an unmodified save of
 *      the source, so `text-edit-measure.py` can compare pixels, remaining text
 *      and the face each edited span was really written in.
 *
 * Nothing here asserts. It prints, and the checker is the Python side.
 */
import fs from 'node:fs';
import path from 'node:path';
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:5291';
const IN = process.argv[2] || '/tmp/tf';
const OUT = process.argv[3] || '/tmp/tf/out';
/** Blocks per page to delete on its own; 0 means every block. */
const PER_PAGE = Number(process.env.PER_PAGE || 0);
/** Retype mode: 'same' keeps the words (pure deletion test), 'other' changes them. */
const MODE = process.env.MODE || 'other';

fs.mkdirSync(OUT, { recursive: true });

// Evaluated in the tab: the only place the app's own TS modules can be imported.
async function install() {
  const [render, doc, model, draw, content] = await Promise.all([
    import('/src/lib/pdf/core/render.ts'),
    import('/src/lib/pdf/core/doc.ts'),
    import('/src/components/tools/pdf/text-editor/model.ts'),
    import('/src/components/tools/pdf/text-editor/draw.ts'),
    import('/src/lib/pdf/core/content.ts'),
  ]);
  const mods = { render, doc, model, draw, content };
  const fromB64 = (b64) => {
    const raw = atob(b64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  };
  const toB64 = (bytes) => {
    let out = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(out);
  };

  /** The page's blocks, viewer-space boxes included, with a painted canvas to sample. */
  async function blocksOf(mods, bytes) {
    const session = await mods.render.openRender(bytes);
    const pages = [];
    for (let n = 1; n <= session.numPages; n++) {
      const items = await session.textItems(n);
      const paragraphs = mods.model.clusterParagraphs(items);
      const proxy = await session.page(n);
      const box = proxy.view;
      const width = box[2] - box[0];
      const height = box[3] - box[1];
      const canvas = document.createElement('canvas');
      await session.renderToCanvas(n, canvas, 1);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const read = (target) => {
        const x = Math.max(0, Math.floor(target.x));
        const y = Math.max(0, Math.floor(target.y));
        const w = Math.max(1, Math.min(canvas.width - x, Math.ceil(target.width)));
        const h = Math.max(1, Math.min(canvas.height - y, Math.ceil(target.height)));
        const data = ctx.getImageData(x, y, w, h).data;
        return mods.model.samplePalette(data, w, h, { x: 0, y: 0, width: w, height: h }, 1);
      };
      pages.push({
        page: n,
        width,
        height,
        canvasInk: countInk(ctx.getImageData(0, 0, canvas.width, canvas.height).data),
        canvasSize: [canvas.width, canvas.height],
        paragraphs: paragraphs.map((paragraph) => ({ paragraph, palette: read(paragraph.box) })),
      });
    }
    await session.destroy();
    return pages;
  }

  function countInk(data) {
    let painted = 0;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 8) {
        painted += 1;
        if (data[i] < 245 || data[i + 1] < 245 || data[i + 2] < 245) dark += 1;
      }
    }
    return { painted, dark };
  }

  /** Text still inside a set of viewer-space boxes, read out of the file's own bytes. */
  function survivingText(mods, page, boxes) {
    const frame = mods.draw.frameOfPage(page);
    const rects = boxes.map((box) => mods.model.viewerBoxToUserSpace(box, frame));
    return mods.content
      .textRects(page)
      .filter((entry) => entry.text.trim().length > 0 && rects.some((r) => overlaps(r, entry.rect)))
      .map((entry) => ({ text: entry.text, rect: entry.rect }));
  }

  function overlaps(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + b.height;
  }

  /**
   * The page's text **outside** the deletion boxes, as one string. Read before
   * and after a deletion, the difference is the collateral damage: an operator
   * dropped whole because one of its glyphs was inside the block.
   */
  function outsideText(mods, page, boxes) {
    const frame = mods.draw.frameOfPage(page);
    const rects = boxes.map((box) => mods.model.viewerBoxToUserSpace(box, frame));
    return mods.content
      .textRects(page)
      .filter((entry) => entry.text.trim().length > 0 && !rects.some((r) => overlaps(r, entry.rect)))
      .map((entry) => entry.text)
      .join('');
  }

  /** Up to 60 characters around the first difference, to name what vanished. */
  function firstLost(before, after) {
    if (before === after) return '';
    let i = 0;
    while (i < before.length && before[i] === after[i]) i += 1;
    return before.slice(Math.max(0, i - 8), i + 52);
  }

  window.__measure = async (b64, options) => {
    const bytes = fromB64(b64);
    const pages = await blocksOf(mods, bytes);
    const perBlock = [];
    for (const entry of pages) {
      const chosen = options.perPage > 0 ? entry.paragraphs.slice(0, options.perPage) : entry.paragraphs;
      for (const { paragraph } of chosen) {
        const fresh = await mods.doc.openPDF(bytes.slice(0));
        const page = fresh.getPage(entry.page - 1);
        const frame = mods.draw.frameOfPage(page);
        const boxes = mods.model.deletionBoxes(paragraph);
        const beforeText = survivingText(mods, page, boxes);
        const outsideBefore = outsideText(mods, page, boxes);
        const report = mods.draw.deleteOriginalText(page, boxes, frame);
        const afterText = survivingText(mods, page, boxes);
        const outsideAfter = outsideText(mods, page, boxes);
        perBlock.push({
          page: entry.page,
          text: paragraph.text.slice(0, 60),
          chars: paragraph.text.length,
          lines: paragraph.lines.length,
          box: paragraph.box,
          deletion: boxes,
          ops: beforeText.length,
          invisible: Boolean(paragraph.invisible),
          fontSize: paragraph.size,
          fonts: [...new Set(paragraph.lines.flatMap((line) => line.items.map((item) => item.fontName)).filter(Boolean))],
          removed: report.removed,
          leftover: report.leftover,
          nothingRemoved: report.nothingRemoved,
          needsRaster: report.needsRasterFallback,
          // Collateral damage: words outside the block's own boxes that the
          // deletion took anyway — a whole `TJ` dropped for one touched glyph.
          lostOutside: outsideBefore.length - outsideAfter.length,
          lostOutsideSample: firstLost(outsideBefore, outsideAfter),
          replacement: options.mode === 'same' ? paragraph.text : retype(paragraph.text),
          survived: afterText.map((t) => t.text.slice(0, 24)),
        });
      }
    }

    // The whole pipeline: retype every block, write, and hand the bytes back.
    const doc = await mods.doc.openPDF(bytes.slice(0));
    const objects = [];
    let z = 0;
    for (const entry of pages) {
      for (const { paragraph, palette } of entry.paragraphs) {
        const style = mods.model.styleFromExtraction(paragraph, {
          color: palette.color,
          pageWidth: entry.width,
        });
        const text = options.mode === 'same' ? paragraph.text : retype(paragraph.text);
        objects.push({
          id: `probe-${objects.length}`,
          page: entry.page,
          kind: 'text',
          box: { ...paragraph.box },
          rotation: 0,
          flipH: false,
          flipV: false,
          z: z++,
          alt: '',
          state: 'queued',
          paragraphs: mods.model.paragraphsFromText(text),
          style,
          deletion: mods.model.deletionBoxes(paragraph),
          paperColor: palette.background,
          sourceId: paragraph.id,
          fromInvisibleLayer: Boolean(paragraph.invisible),
        });
      }
    }
    const outcome = await mods.draw.applyEdits(doc, objects);
    const saved = await mods.doc.savePDF(doc);
    return {
      pages: pages.map((entry) => ({
        page: entry.page,
        size: [entry.width, entry.height],
        blocks: entry.paragraphs.length,
        canvasInk: entry.canvasInk,
        canvasSize: entry.canvasSize,
      })),
      perBlock,
      outcome,
      bytes: toB64(saved),
    };
  };

  function retype(text) {
    // A different string, same length order, with characters the source face may
    // not own: Q, Z, # and an em dash exercise encoding and subsetting.
    return `#${text.replace(/[aeiou]/g, 'Q').slice(0, 46)}—Zz 42`;
  }
  return 'installed';
}

const INSTALL = `(${install.toString()})()`;

const b64 = (file) => fs.readFileSync(file).toString('base64');

const h = await open();
await h.send('Page.navigate', { url: `${BASE}/#/tool/edit-pdf-text` });
await h.wait(`!!document.querySelector('input[type=file]')`, 60000);
const installed = await h.ev(INSTALL);
if (installed !== 'installed') {
  console.error('module install failed:', installed);
  process.exit(1);
}

const fixtures = fs
  .readdirSync(IN)
  .filter((name) => name.endsWith('.pdf'))
  .sort();
const summary = [];
for (const name of fixtures) {
  const data = b64(path.join(IN, name));
  const expression = `window.__measure(${JSON.stringify(data)}, {perPage: ${PER_PAGE}, mode: ${JSON.stringify(MODE)}})`;
  const result = await h.ev(expression);
  if (typeof result === 'string') {
    console.error(`${name}: probe failed: ${result}`);
    continue;
  }
  const stem = name.replace(/\.pdf$/, '');
  fs.writeFileSync(path.join(OUT, `${stem}-after.pdf`), Buffer.from(result.bytes, 'base64'));
  const source = fs.readFileSync(path.join(IN, name));
  fs.writeFileSync(path.join(OUT, `${stem}-before.pdf`), source);
  fs.writeFileSync(path.join(OUT, `${stem}.json`), JSON.stringify(result, null, 2));
  const blocks = result.perBlock.length;
  const clean = result.perBlock.filter((b) => !b.nothingRemoved && b.leftover === 0).length;
  const partial = result.perBlock.filter((b) => !b.nothingRemoved && b.leftover > 0).length;
  const none = result.perBlock.filter((b) => b.nothingRemoved).length;
  summary.push({
    file: name,
    blocks,
    clean,
    partial,
    nothingRemoved: none,
    skippedByApplyEdits: result.outcome.failed.length,
    partialInApply: result.outcome.partial.length,
    rasterInApply: result.outcome.raster.length,
    written: result.outcome.written,
    kb: Math.round(source.length / 1024),
    afterKb: Math.round((result.bytes.length * 3) / 4 / 1024),
  });
  console.log(`${name}: ${blocks} blocks · clean ${clean} · partial ${partial} · nothing removed ${none}`);
  await sleep(50);
}
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log('\n## per-file summary');
console.table(summary);
await h.send('Browser.close').catch(() => undefined);
h.chrome.kill();
process.exit(0);
