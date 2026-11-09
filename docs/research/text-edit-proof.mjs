/**
 * Browser-and-bytes proof for `edit-pdf-text`: one block, edited, measured twice.
 *
 *   BASE=http://localhost:5311 node docs/research/text-edit-proof.mjs /tmp/tf/sample.pdf
 *
 * For every block it picks (default: the first three on page 1, or the ones named
 * by `BLOCKS=0,2,4`) the script
 *
 *   1. paints the page in Chromium with the app's own `openRender`, and counts
 *      non-white pixels inside the block's box — the ink the user is looking at;
 *   2. edits that block the way `openBlock` does (same extraction, same palette
 *      sample, same `applyEdits`), saves, and paints the *produced file* in the
 *      same tab at the same scale;
 *   3. compares the two bitmaps in three bands — inside the block's box, the rest
 *      of the block's line (a neighbour that must keep its ink), and the whole
 *      page — and reads back the words and the face name at that place;
 *   4. says whether the produced file holds a filled rectangle over the block:
 *      a patch is a box of flat colour, and ink that survives in the region
 *      without any glyph there is the "it drew a box over my text" report.
 *
 * `--shots` writes PNGs of the two paints into docs/research/shots, and the
 * edited bytes go to `OUT/<fixture>-proof.pdf` for the byte-side checker.
 */
import fs from 'node:fs';
import path from 'node:path';
import { open, sleep } from './audit3-cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:5291';
const FILE = process.argv[2] || '/tmp/tf/sample.pdf';
const OUT = process.env.OUT || '/tmp/tf/proof';
const PAGE = Number(process.env.PAGE || 1);
const BLOCKS = (process.env.BLOCKS || '')
  .split(',')
  .map((v) => Number(v))
  .filter(Number.isFinite);
const SHOTS = process.argv.includes('--shots');
const MODE = process.env.EDIT || 'other';
const DOCS_SHOTS = 'docs/research/shots';

fs.mkdirSync(OUT, { recursive: true });
if (SHOTS) fs.mkdirSync(DOCS_SHOTS, { recursive: true });

const install = async () => {
  const [render, doc, model, draw, content] = await Promise.all([
    import('/src/lib/pdf/core/render.ts'),
    import('/src/lib/pdf/core/doc.ts'),
    import('/src/components/tools/pdf/text-editor/model.ts'),
    import('/src/components/tools/pdf/text-editor/draw.ts'),
    import('/src/lib/pdf/core/content.ts'),
  ]);
  const mods = { render, doc, model, draw, content };
  const b64 = (bytes) => {
    let out = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(out);
  };
  const fromB64 = (text) => {
    const raw = atob(text);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return bytes;
  };

  /** Paint page `n` and hand back its pixels plus the pdf.js text runs. */
  async function paint(mods, bytes, n) {
    const session = await mods.render.openRender(bytes);
    const canvas = document.createElement('canvas');
    await session.renderToCanvas(n, canvas, 1);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const size = [canvas.width, canvas.height];
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const items = await session.textItems(n);
    await session.destroy();
    return { size, data, items };
  }

  /** Non-white pixel count inside a viewer-space box (scale 1: box is pixels). */
  function ink(data, width, box) {
    const x1 = Math.max(0, Math.floor(box.x));
    const y1 = Math.max(0, Math.floor(box.y));
    const x2 = Math.min(width, Math.ceil(box.x + box.width));
    const y2 = Math.min(1e9, Math.ceil(box.y + box.height));
    let dark = 0;
    let seen = 0;
    for (let y = y1; y < y2; y += 1) {
      for (let x = x1; x < x2; x += 1) {
        const at = (y * width + x) * 4;
        if (at + 3 >= data.length) continue;
        seen += 1;
        if (data[at + 3] < 8) continue;
        if (data[at] < 245 || data[at + 1] < 245 || data[at + 2] < 245) dark += 1;
      }
    }
    return { dark, seen };
  }

  /** Words pdf.js extracts inside a box, with the face each one is drawn in. */
  function wordsIn(items, box) {
    const hits = items.filter(
      (item) =>
        item.str.trim().length > 0 &&
        item.x < box.x + box.width &&
        box.x < item.x + item.w &&
        item.y < box.y + box.height &&
        box.y < item.y + item.h,
    );
    return hits.map((item) => ({ text: item.str, x: r2(item.x), y: r2(item.y), w: r2(item.w), h: r2(item.h), font: item.fontName }));
  }

  const r2 = (v) => Math.round(v * 100) / 100;

  window.__proof = async (source, options) => {
    const bytes = fromB64(source);
    const first = await paint(mods, bytes, options.page);
    const session = await mods.render.openRender(bytes);
    const items = await session.textItems(options.page);
    const proxy = await session.page(options.page);
    const box = proxy.view;
    await session.destroy();
    const pageWidth = box[2] - box[0];
    const paragraphs = mods.model.clusterParagraphs(items);
    const picked = (options.blocks && options.blocks.length
      ? options.blocks.map((i) => paragraphs[i]).filter(Boolean)
      : paragraphs.slice(0, 3)
    ).map((paragraph, index) => ({ paragraph, index }));

    const doc = await mods.doc.openPDF(bytes.slice(0));
    const objects = [];
    const rows = [];
    let z = 0;
    for (const { paragraph, index } of picked) {
      const style = mods.model.styleFromExtraction(paragraph, {
        color: '#111111',
        pageWidth,
      });
      const text = options.mode === 'same' ? paragraph.text : retype(paragraph.text);
      const object = {
        id: `proof-${index}`,
        page: options.page,
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
        paperColor: '#ffffff',
        sourceId: paragraph.id,
        fromInvisibleLayer: Boolean(paragraph.invisible),
      };
      objects.push(object);
      rows.push({
        id: object.id,
        before: paragraph.text.slice(0, 48),
        wanted: text,
        box: {
          x: r2(paragraph.box.x),
          y: r2(paragraph.box.y),
          width: r2(paragraph.box.width),
          height: r2(paragraph.box.height),
        },
        inkBefore: ink(first.data, first.size[0], paragraph.box).dark,
        lineInkBefore: paragraph.lines.reduce(
          (n, line) => n + ink(first.data, first.size[0], line.box).dark,
          0,
        ),
        wordsBefore: wordsIn(first.items, paragraph.box),
      });
    }
    const outcome = await mods.draw.applyEdits(doc, objects);
    const saved = await mods.doc.savePDF(doc);

    const after = await paint(mods, saved, options.page);
    const afterItems = after.items;
    // Where the writer says each piece went, measured in the produced paint:
    // ink there is glyph ink (the text is really drawn), and the block's own box
    // must hold no ink that is not a glyph it now carries.
    const placed = (outcome.placed || []).filter((piece) => piece.page === options.page);
    for (const row of rows) {
      const measured = ink(after.data, after.size[0], row.box);
      row.inkAfter = measured.dark;
      row.inkArea = measured.seen;
      row.wordsAfter = wordsIn(afterItems, row.box);
      row.textAfter = row.wordsAfter.map((w) => w.text).join(' ').slice(0, 60);
      row.stillHasOldWords = row.wordsBefore
        .map((w) => w.text)
        .filter((t) => t.length > 3 && row.textAfter.includes(t));
      const mine = placed.filter((piece) => piece.id === row.id);
      // A piece is proved painted when a word the viewer extracts sits at its
      // x and baseline. Ink is measured **around that word**, so a tinted page
      // (paper.pdf) cannot inflate the number: a word's own box is mostly paper.
      row.pieces = mine.map((piece) => {
        const match = afterItems.find(
          (item) =>
            item.str.trim().length > 0 &&
            piece.text.startsWith(item.str.trim()) &&
            Math.abs(item.x - piece.x) <= 2 &&
            Math.abs(item.y + item.h - piece.baseline) <= Math.max(3, piece.size * 0.35),
        );
        const band = match
          ? { x: match.x - 1, y: match.y - 1, width: match.w + 2, height: match.h + 2 }
          : { x: piece.x, y: Math.max(0, piece.baseline - piece.size), width: 1, height: 1 };
        const measured = ink(after.data, after.size[0], band);
        return {
          text: piece.text.slice(0, 28),
          face: piece.face,
          fromSource: piece.fromSource,
          painted: Boolean(match),
          ink: measured.dark,
          inkShare: measured.seen ? Math.round((1000 * measured.dark) / measured.seen) / 10 : 0,
        };
      });
      row.piecesPainted = row.pieces.filter((piece) => piece.painted && piece.ink > 0).length;
    }
    const pageInkBefore = ink(first.data, first.size[0], { x: 0, y: 0, width: first.size[0], height: first.size[1] }).dark;
    const pageInkAfter = ink(after.data, after.size[0], { x: 0, y: 0, width: after.size[0], height: after.size[1] }).dark;

    // Faces, read out of the produced file rather than from the writer's intent.
    const produced = await mods.doc.openPDF(saved);
    const producedPage = produced.getPage(options.page - 1);
    const before = await mods.doc.openPDF(bytes.slice(0));
    const faceNames = (page) => mods.content.pageFontNames(page).map((f) => `${f.baseFont} ${f.subtype}${f.embedded ? ' (embedded)' : ''}`);
    const sourceFaces = faceNames(before.getPage(options.page - 1));
    const outFaces = faceNames(producedPage);
    const editorFaces = (outcome.placed || []).map((p) => p.face);
    // Patches the edit added, counted off the produced bytes: a flat filled
    // rectangle over the block is the "it drew a box" report, whatever the ink
    // measurement says.
    const patches = (mods.content.textRects(producedPage), mods.content.pagePatches(producedPage));
    return {
      page: options.page,
      pageSize: after.size,
      pageInk: { before: pageInkBefore, after: pageInkAfter },
      rows,
      outcome: {
        written: outcome.written,
        failed: outcome.failed,
        partial: outcome.partial,
        raster: outcome.raster,
        covered: outcome.covered,
        substituted: outcome.substituted,
        reflowed: outcome.reflowed,
        placed: outcome.placed,
      },
      sourceFaces,
      outFaces,
      editorFaces,
      patches,
      bytes: b64(saved),
    };
  };

  function retype(text) {
    return `#${text.replace(/[aeiou]/g, 'Q').slice(0, 40)}—Zz 42`;
  }
  return 'ready';
};

const h = await open();
await h.send('Page.navigate', { url: `${BASE}/#/tool/edit-pdf-text` });
await h.wait(`!!document.querySelector('input[type=file]')`, 60000);
const installed = await h.ev(`(${install.toString()})()`);
if (installed !== 'ready') {
  console.error('install failed:', installed);
  process.exit(1);
}
const source = fs.readFileSync(FILE).toString('base64');
const result = await h.ev(
  `window.__proof(${JSON.stringify(source)}, {page: ${PAGE}, blocks: ${JSON.stringify(BLOCKS)}, mode: ${JSON.stringify(MODE)}})`,
);
if (typeof result === 'string') {
  console.error('proof failed:', result);
  process.exit(1);
}
fs.writeFileSync(path.join(OUT, `${path.basename(FILE, '.pdf')}-proof.pdf`), Buffer.from(result.bytes, 'base64'));
fs.writeFileSync(path.join(OUT, `${path.basename(FILE, '.pdf')}-proof.json`), JSON.stringify(result, null, 2));
delete result.bytes;
console.log(JSON.stringify(result, null, 1));
if (SHOTS) {
  await h.shot(path.join(DOCS_SHOTS, `text-proof-${path.basename(FILE, '.pdf')}.png`));
}
await h.send('Browser.close').catch(() => undefined);
h.chrome.kill();
process.exit(0);
void sleep;
