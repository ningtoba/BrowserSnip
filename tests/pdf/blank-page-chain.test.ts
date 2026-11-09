/**
 * A blank page is legal, and this app writes them itself.
 *
 * `docs/TOOL-TRIAGE.md` ERRORS/NO-OP item 1: seven tools refused **any** document
 * holding a page with no `/Contents`, including the file the app's own
 * `add-blank-page` had just produced. Measured at `6edad2d`, on the bytes this
 * file builds — every one of the seven threw the same sentence:
 *
 * | tool                   | what the run did before the fix                  |
 * | ---------------------- | ------------------------------------------------ |
 * | `rotate-custom`        | rejected — `Can't embed page with missing Contents` |
 * | `n-up`                 | rejected — same sentence                         |
 * | `booklet`              | rejected — same sentence                         |
 * | `combine-single-page`  | rejected — same sentence                         |
 * | `posterize`            | rejected — same sentence                         |
 * | `divide-pages`         | rejected — same sentence                         |
 * | `fix-page-size`        | rejected — same sentence                         |
 *
 * One cause, verified rather than assumed: all seven reach the page stamp in
 * `tools/organize.ts` (`stamp`, and `stampBehind` for the underlay path), which
 * asks the pdf-lib fork to embed the source page. `PDFPageEmbedder.embedIntoContext`
 * throws `MissingPageContentsEmbeddingError` when the page has no `/Contents`, and
 * `PDFDocument.embedPage` only queues the embedder — the throw surfaces at
 * `doc.save()`, which is why the `try`/`catch` around the call never caught it and
 * the failure arrived as a rejected run with no file. `empty-array` below shows the
 * fork is happy with an *empty* `/Contents`; only the absent key was refused, so the
 * defect is a parser convenience, not document damage: ISO 32000-1 §14.11.2 makes
 * `/Contents` optional and a page without one simply paints nothing.
 *
 * The tests here therefore assert the opposite of that table: the blank page is
 * carried through, at the right size, in the right place, drawing nothing.
 */
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFStream, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import type { PDFPage } from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool, type RunOutcome } from '@/lib/pdf/tools/runner';
import { pageContentStreams, parseContentStream, streamBytes } from '@/lib/pdf/core/content';
import { cropBox, ensurePageContents, pageContentsState } from '@/lib/pdf/core/pages';

/* ── the chain input: the product's own output ───────────────────────────── */

/** A sheet size no inked page has, so the blank is identifiable by its box. */
const BLANK_SIZE: [number, number] = [612, 1008];

/** The page index the blank lands on: `add-blank-page … after page 2`. */
const BLANK_AT = 2;

/** Every tool the triage item names, in the order the triage table lists them. */
const SEVEN = [
  'rotate-custom',
  'n-up',
  'booklet',
  'combine-single-page',
  'posterize',
  'divide-pages',
  'fix-page-size',
] as const;

type SevenTool = (typeof SEVEN)[number];

/** Field values that keep each tool's geometry small and checkable. */
const VALUES: Record<SevenTool, Record<string, unknown>> = {
  'rotate-custom': { angle: 90, fit: 'grow' },
  'n-up': { perSheet: 2, sheetSize: 'a4', landscape: true, gutter: 0, margin: 0 },
  booklet: { sheetSize: 'a4', landscape: true, gutter: 0, margin: 0 },
  'combine-single-page': { gap: 0, width: 'widest' },
  posterize: { columns: 2, rows: 2, bleed: 0 },
  'divide-pages': { axis: 'vertical', parts: 2 },
  'fix-page-size': { size: 'a4', orientation: 'portrait', fit: 'contain' },
};

/**
 * Four sheets of distinct width, each inked, so the output says which source page
 * landed in which cell (the `/BBox` of the drawn form carries the width).
 */
async function inkedFour(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 4; i++) {
    const page = doc.addPage([100 + i * 100, 200]);
    page.drawText(`sheet ${i + 1}`, { x: 8, y: 100, size: 12, font, color: rgb(0, 0, 0) });
  }
  return doc.save({ useObjectStreams: false });
}

const fileOf = (bytes: Uint8Array, name: string): File =>
  new File([new Uint8Array(bytes) as BlobPart], name, { type: 'application/pdf' });

async function run(toolId: string, bytes: Uint8Array, values: Record<string, unknown> = {}): Promise<RunOutcome> {
  const tool = getPdfTool(toolId);
  expect(tool, `tool "${toolId}" is not registered`).toBeTruthy();
  return runPdfTool({
    toolId,
    files: [fileOf(bytes, 'colour.pdf')],
    values,
    onProgress: () => undefined,
    onLog: () => undefined,
  });
}

async function bytesOf(outcome: RunOutcome, index = 0): Promise<Uint8Array> {
  expect(outcome.outputs.length, `no output file for a run of ${index + 1}`).toBeGreaterThan(index);
  return new Uint8Array(await outcome.outputs[index].blob.arrayBuffer());
}

const open = (bytes: Uint8Array): Promise<PDFDocument> => PDFDocument.load(bytes);

/** The raw file text, for claims about what the bytes do or do not hold. */
const latin = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');

/**
 * The document under test: what `add-blank-page` writes, fed straight back in.
 *
 * Not a hand-made stand-in — the triage item's complaint is that the product
 * cannot read its own output, so the input is produced by running the product.
 */
async function withOwnBlank(): Promise<Uint8Array> {
  chain ??= run('add-blank-page', await inkedFour(), {
    position: 'after',
    anchor: BLANK_AT,
    count: 1,
    size: 'legal',
  }).then((outcome) => bytesOf(outcome));
  return chain;
}

/** The same five-page file for every test: one product run, shared. */
let chain: Promise<Uint8Array> | null = null;

/* ── reading what a page holds ───────────────────────────────────────────── */

/** Operators that put marks on paper; a page drawing nothing has none of them. */
const PAINTS = new Set(['Tj', 'TJ', "'", '"', 'f', 'f*', 'B', 'B*', 'b', 'b*', 'S', 's']);

function paintsIn(bytes: Uint8Array): number {
  return parseContentStream(bytes).filter((op) => PAINTS.has(op.name)).length;
}

/** How many paint operators a page's own streams run. */
function inkOf(page: PDFPage): number {
  return pageContentStreams(page).reduce((total, stream) => total + paintsIn(stream.bytes), 0);
}

/**
 * Everything a page could put on paper: its own operators plus the operators of
 * every form XObject it draws.
 *
 * These tools impose pages as forms, so a page whose own stream is just
 * `q … /Form1 Do Q` is not a blank page — the ink is one level down.
 */
function reachableInk(doc: PDFDocument, index: number): number {
  return inkOf(doc.getPages()[index]) + formsOf(doc, index).reduce((total, form) => total + Math.max(form.ink, 0), 0);
}

interface Form {
  /** The name the page draws it under, in draw order. */
  name: string;
  /** The form's `/BBox`, which identifies the source page by its size. */
  bbox: number[];
  /** Paint operators inside the form. `0` means the cell holds a blank page. */
  ink: number;
}

/**
 * The form XObjects a page draws, in draw order, read out of the saved file.
 *
 * The cell a blank page occupies has to exist in the bytes with the right box and
 * no ink; that is only checkable by resolving the `Do` names against `/XObject`.
 */
function formsOf(doc: PDFDocument, index: number): Form[] {
  const page = doc.getPages()[index];
  const resources = page.node.Resources();
  const dict = resources instanceof PDFRef ? doc.context.lookup(resources, PDFDict) : resources;
  const rawForms = dict instanceof PDFDict ? dict.get(PDFName.of('XObject')) : undefined;
  const forms = rawForms instanceof PDFRef ? doc.context.lookup(rawForms, PDFDict) : rawForms;
  if (!(forms instanceof PDFDict)) return [];
  const order: string[] = [];
  for (const stream of pageContentStreams(page)) {
    for (const op of parseContentStream(stream.bytes)) {
      if (op.name !== 'Do') continue;
      const first = op.operands[0];
      if (first?.kind === 'name') order.push(first.value);
    }
  }
  return order.map((name) => {
    const object = doc.context.lookup(forms.get(PDFName.of(name))!);
    if (!(object instanceof PDFStream)) return { name, bbox: [], ink: -1 };
    const box = object.dict.get(PDFName.of('BBox'));
    const numbers = box instanceof PDFArray
      ? Array.from({ length: box.size() }, (_, i) => Number(box.get(i).toString()))
      : [];
    return { name, bbox: numbers, ink: paintsIn(streamBytes(object)) };
  });
}

/* ── the defect, pinned where it lives ───────────────────────────────────── */

describe('the predicate that refused blank pages', () => {
  it('the app writes a page with no /Contents at all', async () => {
    const bytes = await withOwnBlank();
    const doc = await open(bytes);
    expect(doc.getPageCount(), 'the blank was inserted, so the file gained a page').toBe(5);
    const pages = doc.getPages();
    expect(pageContentsState(pages[BLANK_AT]), 'add-blank-page writes a page with no content stream').toBe('absent');
    // Byte level, with the object streams unpacked: four page dictionaries name a
    // `/Contents`, the fifth does not. Nothing about the file is a parse error.
    const flat = await (await open(bytes)).save({ useObjectStreams: false });
    expect(
      (latin(flat).match(/\/Contents/g) ?? []).length,
      'the saved bytes carry one fewer /Contents than there are pages',
    ).toBe(doc.getPageCount() - 1);
    // The four inked sheets keep their streams: the blank is the only page that
    // lost one, so the count below is about that page and not about the file.
    expect(pages.filter((page) => pageContentsState(page) === 'absent').length).toBe(1);
  });

  it('the fork refuses to embed exactly that page, and only that page', async () => {
    const doc = await open(await withOwnBlank());
    const blank = doc.getPages()[BLANK_AT];
    const target = await PDFDocument.create();
    await target.embedPage(blank);
    // Queued, not thrown: the failure arrives at save, which is why the tool
    // wrapper's own `try`/`catch` around `embedPage` never saw it.
    await expect(target.save()).rejects.toThrow(/Can't embed page with missing Contents/);
  });

  it('an empty /Contents array was always fine, so absence is the only damage claimed', async () => {
    const doc = await open(await withOwnBlank());
    const blank = doc.getPage(BLANK_AT);
    // The shape the fork accepts: `/Contents []`. Written directly, without the
    // fix, to show the refusal was about the key's absence and not about emptiness.
    (blank.node as unknown as { set(k: PDFName, v: unknown): void }).set(
      PDFName.of('Contents'),
      PDFArray.withContext(doc.context),
    );
    const target = await PDFDocument.create();
    await target.embedPage(blank);
    await expect(target.save()).resolves.toBeInstanceOf(Uint8Array);
  });
});

/* ── all seven, on the app's own blank ───────────────────────────────────── */

describe('the seven tools take a blank page', () => {
  it.each(SEVEN)('%s produces a file instead of refusing it', async (toolId) => {
    const outcome = await run(toolId, await withOwnBlank(), VALUES[toolId]);
    const bytes = await bytesOf(outcome);
    expect(bytes.length, `${toolId} produced an empty file`).toBeGreaterThan(0);
    expect(latin(bytes).startsWith('%PDF-'), `${toolId} did not write a PDF`).toBe(true);
    expect(outcome.pagesOut ?? (await open(bytes)).getPageCount()).toBeGreaterThan(0);
  });

  it.each(SEVEN)('%s keeps every page, blank one included', async (toolId) => {
    const doc = await open(await bytesOf(await run(toolId, await withOwnBlank(), VALUES[toolId])));
    const counts: Record<SevenTool, number> = {
      // One page per source page.
      'rotate-custom': 5,
      'fix-page-size': 5,
      // Two to a sheet, five pages, so the last sheet holds one.
      'n-up': 3,
      // Saddle-stitch sheets of four: 5 padded to 8, two printed sides per sheet.
      booklet: 4,
      // One continuous scroll, well under the 14 400 pt edge limit here.
      'combine-single-page': 1,
      // Four tiles per page.
      posterize: 20,
      // Two halves per page.
      'divide-pages': 10,
    };
    expect(doc.getPageCount(), `${toolId} changed the page count`).toBe(counts[toolId]);
  });
});

/* ── no content is fine, unreadable content is not ───────────────────────── */

/** A page whose `/Contents` exists but cannot be read, in the way the file claims. */
async function undecodable(): Promise<Uint8Array> {
  const doc = await open(await inkedFour());
  const page = doc.getPage(1);
  const garbage = doc.context.stream(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), {
    Filter: 'FlateDecode',
  });
  (page.node as unknown as { set(k: PDFName, v: unknown): void }).set(
    PDFName.of('Contents'),
    doc.context.register(garbage),
  );
  return doc.save({ useObjectStreams: false });
}

describe('the line the fix draws', () => {
  it('a page with no /Contents is blank, not damaged', async () => {
    const pages = (await open(await withOwnBlank())).getPages();
    expect(pageContentsState(pages[BLANK_AT])).toBe('absent');
    expect(pageContentsState(pages[0])).toBe('draws');
  });

  it('a page whose content stream cannot be decoded is still damage', async () => {
    const pages = (await open(await undecodable())).getPages();
    // The key is there and points at a stream the filter cannot run, so nothing
    // about it reads as "blank": it is handed to the same decoder that refuses it
    // (see the run below, and the tool-level test that follows).
    expect(pageContentsState(pages[1])).toBe('draws');
    expect(() => pageContentStreams(pages[1]), 'the app reader still refuses it').toThrow(
      /could not be decompressed/,
    );
  });

  it('the repair writes the entry for a blank page and for nothing else', async () => {
    const doc = await open(await withOwnBlank());
    const pages = doc.getPages();
    // An empty `/Contents` array: the shape the embedder already accepts, so the
    // repair must leave it alone rather than writing a second entry.
    const already = pages[0];
    expect(ensurePageContents(already), 'an inked page is not rewritten').toBe(false);
    const spare = doc.addPage([200, 200]);
    (spare.node as unknown as { set(k: PDFName, v: unknown): void }).set(
      PDFName.of('Contents'),
      PDFArray.withContext(doc.context),
    );
    expect(pageContentsState(spare)).toBe('draws');
    expect(ensurePageContents(spare), 'an empty content array stays an empty content array').toBe(false);
    // The blank gains the same shape, and is then embeddable.
    expect(ensurePageContents(pages[BLANK_AT]), 'the blank page is the one that needed it').toBe(true);
    expect(pageContentsState(pages[BLANK_AT])).toBe('draws');
    const target = await PDFDocument.create();
    await target.embedPage(pages[BLANK_AT]);
    await expect(target.save()).resolves.toBeInstanceOf(Uint8Array);
    // And damage is still not repaired into silence.
    const broken = await open(await undecodable());
    expect(
      ensurePageContents(broken.getPage(1)),
      'a stream that exists but will not inflate is not given a fresh empty entry',
    ).toBe(false);
  });

  it.each(SEVEN)('%s still reports an undecodable content stream instead of blanking it', async (toolId) => {
    await expect(run(toolId, await undecodable(), VALUES[toolId])).rejects.toThrow(/flate|decompress|decode|compression/i);
  });

  it('a dangling /Contents reference is reported too, not read as blank', async () => {
    const doc = await open(await inkedFour());
    (doc.getPage(1).node as unknown as { set(k: PDFName, v: unknown): void }).set(
      PDFName.of('Contents'),
      PDFRef.of(9999, 0),
    );
    const broken = await doc.save({ useObjectStreams: false });
    expect(pageContentsState((await open(broken)).getPage(1))).toBe('unreadable');
    await expect(run('n-up', broken, VALUES['n-up'])).rejects.toThrow(/Contents|read|damage/i);
  });

  it('a /Contents of the wrong type is reported too', async () => {
    const doc = await open(await inkedFour());
    (doc.getPage(1).node as unknown as { set(k: PDFName, v: unknown): void }).set(
      PDFName.of('Contents'),
      PDFNumber.of(12),
    );
    const broken = await doc.save({ useObjectStreams: false });
    expect(pageContentsState((await open(broken)).getPage(1))).toBe('unreadable');
    await expect(run('n-up', broken, VALUES['n-up'])).rejects.toThrow();
  });
});

/* ── the chain, in the bytes ─────────────────────────────────────────────── */

describe('the blank survives the chain, in the right place', () => {
  it('n-up gives the blank its own cell and does not shift the pages after it', async () => {
    const doc = await open(await bytesOf(await run('n-up', await withOwnBlank(), VALUES['n-up'])));
    expect(doc.getPageCount()).toBe(3);
    // Five pages, two per sheet: sheet 2 holds the blank (source 3) then source 4.
    const second = formsOf(doc, 1);
    expect(second.map((form) => Math.round(form.bbox[2])), 'both cells of sheet 2 are filled').toHaveLength(2);
    expect(Math.round(second[0].bbox[2])).toBe(Math.round(BLANK_SIZE[0]));
    expect(second[0].ink, 'the blank occupies its cell but draws nothing').toBe(0);
    expect(second[1].ink, 'the page after the blank is still the page after the blank').toBeGreaterThan(0);
    expect(Math.round(second[1].bbox[2])).toBe(300);
    // And the last sheet holds source page 5, at 400 pt wide: nothing moved up.
    const third = formsOf(doc, 2);
    expect(third).toHaveLength(1);
    expect(Math.round(third[0].bbox[2])).toBe(400);
    expect(third[0].ink).toBeGreaterThan(0);
  });

  it('rotate-custom turns the blank sheet and draws nothing on it', async () => {
    const doc = await open(await bytesOf(await run('rotate-custom', await withOwnBlank(), VALUES['rotate-custom'])));
    const pages = doc.getPages();
    expect(pages).toHaveLength(5);
    const blank = pages[BLANK_AT];
    // A 612 × 1008 sheet turned a quarter: the box swaps, the ink does not appear.
    expect([Math.round(cropBox(blank).width), Math.round(cropBox(blank).height)]).toEqual([1008, 612]);
    expect(reachableInk(doc, BLANK_AT), 'nothing was drawn on the blank sheet').toBe(0);
    for (const form of formsOf(doc, BLANK_AT)) expect(form.ink).toBe(0);
    expect(reachableInk(doc, BLANK_AT + 1), 'the sheet after it kept its content').toBeGreaterThan(0);
  });

  it('fix-page-size puts the blank on the target sheet, still blank', async () => {
    const doc = await open(await bytesOf(await run('fix-page-size', await withOwnBlank(), VALUES['fix-page-size'])));
    const pages = doc.getPages();
    expect(pages).toHaveLength(5);
    expect([Math.round(pages[BLANK_AT].getWidth()), Math.round(pages[BLANK_AT].getHeight())]).toEqual([595, 842]);
    expect(reachableInk(doc, BLANK_AT)).toBe(0);
    expect(reachableInk(doc, 0)).toBeGreaterThan(0);
  });

  it('divide-pages cuts the blank into blank pieces, in order', async () => {
    const doc = await open(await bytesOf(await run('divide-pages', await withOwnBlank(), VALUES['divide-pages'])));
    expect(doc.getPageCount()).toBe(10);
    // Two halves per source page, so the blank owns output pages 5 and 6.
    const pieces = [4, 5];
    for (const index of pieces) {
      expect(reachableInk(doc, index), `piece ${index + 1} of the blank page drew something`).toBe(0);
    }
    for (const index of [0, 1, 2, 3, 6, 7, 8, 9]) {
      expect(reachableInk(doc, index), `piece ${index + 1} of an inked page is empty`).toBeGreaterThan(0);
    }
  });

  it('posterize tiles the blank page into blank tiles', async () => {
    const doc = await open(await bytesOf(await run('posterize', await withOwnBlank(), VALUES.posterize)));
    expect(doc.getPageCount()).toBe(20);
    // Tiles are laid out per source page, four each: the blank is source page 3,
    // so its tiles are output pages 9-12.
    for (let index = 8; index < 12; index++) {
      expect(reachableInk(doc, index), `tile ${index - 7} of the blank page drew something`).toBe(0);
    }
    expect(reachableInk(doc, 12), 'the tiles after the blank ones stayed inked').toBeGreaterThan(0);
  });

  it('combine-single-page keeps the blank sheet height in the scroll', async () => {
    const outcome = await run('combine-single-page', await withOwnBlank(), VALUES['combine-single-page']);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(1);
    const sheet = doc.getPage(0);
    // Every page is scaled to the widest (the blank's 612 pt), so the scroll is the
    // sum of the scaled heights: 1224 + 612 + 1008 + 408 + 306 = 3558.
    expect(Math.round(sheet.getHeight()), 'the blank page contributed nothing to the scroll height')
      .toBeGreaterThanOrEqual(3550);
    const forms = formsOf(doc, 0);
    expect(forms).toHaveLength(5);
    const silent = forms.filter((form) => form.ink === 0);
    expect(silent, 'the blank is one of the five stitched pieces').toHaveLength(1);
    expect(Math.round(silent[0].bbox[2])).toBe(Math.round(BLANK_SIZE[0]));
  });

  it('booklet imposes the blank page and still fills every sheet', async () => {
    const doc = await open(await bytesOf(await run('booklet', await withOwnBlank(), VALUES.booklet)));
    expect(doc.getPageCount()).toBe(4);
    const all = doc.getPages().flatMap((_, index) => formsOf(doc, index));
    expect(all).toHaveLength(5);
    const blank = all.filter((form) => form.ink === 0);
    expect(blank, 'the blank page is imposed exactly once').toHaveLength(1);
    expect(Math.round(blank[0].bbox[2])).toBe(Math.round(BLANK_SIZE[0]));
  });
});
