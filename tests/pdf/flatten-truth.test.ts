/**
 * `flatten-pdf` — judged by ink and by interactivity, not by the absence of an error.
 *
 * Flattening is the operation a user reaches for to make a mark **permanent and no
 * longer editable**: burn a signature into the page, freeze a form so its answers
 * cannot be retyped, strip the comment layer before a document goes out. A tool that
 * reports success and changes nothing is therefore worse than one that fails loudly,
 * and that is what shipped: `drawAppearance` asked the object model for an
 * annotation's `/AP /N` as a `PDFDict`, an appearance is a **stream**, the fork's
 * `lookup` throws on a class mismatch, and the whole pass died on the first mark
 * while the card still printed a page count (`docs/TOOL-TRIAGE.md`, BLANK OR WRONG
 * OUTPUT 5; the run is `docs/research/flatten-before-fix.pdf`).
 *
 * Every assertion here reads the **after** state of the saved bytes, per annotation
 * kind, and never the run's own counters:
 *
 *   * the annotation object is gone from the page's `/Annots` — not hidden, not
 *     flagged, not left in place — and so is its `/Popup`;
 *   * the ink the mark carried is in that page's own content stream: the colour the
 *     mark was drawn in, the `cm` that puts it at its `/Rect`, and the painting
 *     operator. Content streams are inflated with `node:zlib` here rather than with
 *     this app's reader, so a bug in the bake cannot be hidden by the same helper
 *     that wrote it;
 *   * the form is not fillable: `AcroForm /Fields` empty, no `/Widget` left, no
 *     `/NeedAppearances` telling a viewer to draw values that are already page text;
 *   * a mark with no appearance, one no reader paints (`Invisible`, `Hidden`,
 *     `NoView`), and a link the user asked to keep, all stay live — and the card has
 *     to say so rather than claim them.
 *
 * `docs/research/flatten-readers.py` asks the same questions of the same pair
 * outside this app: MuPDF counts the annotations, and measures each mark's own box
 * twice — once as displayed, once with `annots=False` so only the page content is
 * painted. A flattened page measures the same either way; a page that merely still
 * carries its comments measures paper. `FLATTEN_DUMP=<name>.pdf npx vitest run
 * tests/pdf/flatten-truth.test.ts` rewrites the three PDFs, and the two committed
 * logs are that one fixture either side of the fix:
 *
 *   | mark (its own box, ink % with `annots=False`) | input | before the fix | after |
 *   | --- | --- | --- | --- |
 *   | text note, highlight, ink stroke (sheet 1) | 0.0 | 0.0 / 0.0 / 0.0 | 98.67 / 96.64 / 6.01 |
 *   | square (sheet 2) | 0.0 | 0.0 | 99.99 |
 *   | translucent square on the `/Rotate 90` sheet | 0.0 | 0.0 | 100.0 |
 *   | page ink, content only | 0.26 / 0.1 / 0.0 / 0.09 | 0.62 / 0.1 / 0.0 / 0.09 | **1.31 / 2.34 / 0.0 / 1.53** |
 *   | page ink, as displayed | 1.3 / 2.34 / 0.0 / 1.53 | 1.31 / 2.34 / 0.0 / 1.53 | 1.31 / 2.34 / 0.0 / 1.53 |
 *
 * The last two rows are the whole claim in four numbers: after the fix the page
 * painted from its own content measures exactly what the page measures as displayed
 * — the same picture, with nothing left to click — and annotations go `5 -> 0`,
 * widgets `3 -> 0`, `AcroForm /Fields` `3 -> 0`. Before the fix the marks were only
 * ever painted as annotations (content-only ink unchanged at 0.0 in every box) while
 * the form half of the same run really did work.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
  StandardFonts,
  degrees,
  rgb,
} from '@maxwbh/pdf-lib';
import type { PDFPage } from '@maxwbh/pdf-lib';
import { addAnnotation } from '@/lib/pdf/core/annotations';
import { createFormField } from '@/lib/pdf/core/forms';
import { honestSummary } from '@/components/tools/pdf/shared/ResultCard';
import { runPdfTool, type RunOutcome } from '@/lib/pdf/tools/runner';
import type { ToolValues } from '@/lib/pdf/tools/types';

/**
 * `openRender` re-assigns `GlobalWorkerOptions.workerSrc` on every call and Vite's
 * transform makes it an `http:` URL the Node ESM loader refuses, so the worker path
 * is held by a setter (the hook `security-bytes.test.ts` uses). Nothing here paints
 * a page, so jsdom's missing canvas is never asked for.
 */
beforeAll(() => {
  let workerPath = `file://${process.cwd()}/node_modules/pdfjs-dist/build/pdf.worker.mjs`;
  Object.defineProperty(GlobalWorkerOptions, 'workerSrc', {
    configurable: true,
    get: () => workerPath,
    set: (value: string) => {
      if (value.startsWith('file:') || value.startsWith('data:')) workerPath = value;
    },
  });
});

const latin1 = new TextDecoder('latin1');
const PAGE: [number, number] = [595, 842];

/** Where each fixture mark lives, so a test can name the box it has to land in. */
const NOTE = { x: 480, y: 730, width: 20, height: 20 };
const HIGHLIGHT = { x: 60, y: 752, width: 110, height: 16 };
const INK = { x: 120, y: 600, width: 220, height: 90 };
const SQUARE = { x: 60, y: 600, width: 140, height: 80 };
const LINK = { x: 60, y: 540, width: 180, height: 18 };
const WASH = { x: 60, y: 400, width: 120, height: 60 };

/**
 * Four pages: a note, a highlight and an ink stroke on the first (the same sheet
 * that holds the form's three fields), a square and a link on the second, a sheet
 * with **no `/Annots` key at all** third — what a blank page looks like in PDF, and
 * the shape that used to abort the whole pass — and a `/Rotate 90` sheet fourth
 * carrying one translucent square.
 */
async function markedFixture(options: { fields?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const first = doc.addPage(PAGE);
  first.drawText('Invoice 42 total due on signature', { x: 60, y: 700, size: 16, font, color: rgb(0, 0, 0) });
  doc.addPage(PAGE).drawText('Second sheet', { x: 60, y: 700, size: 14, font, color: rgb(0, 0, 0) });
  doc.addPage(PAGE);
  const turned = doc.addPage(PAGE);
  turned.setRotation(degrees(90));
  turned.drawText('Turned sheet', { x: 60, y: 700, size: 14, font, color: rgb(0, 0, 0) });

  addAnnotation(doc, {
    kind: 'Text', page: 0, rect: NOTE, contents: 'A note about the total', flags: ['Print'],
  });
  addAnnotation(doc, {
    kind: 'Highlight', page: 0, rect: HIGHLIGHT,
    quadPoints: [HIGHLIGHT.x, HIGHLIGHT.y, HIGHLIGHT.x + HIGHLIGHT.width, HIGHLIGHT.y,
      HIGHLIGHT.x, HIGHLIGHT.y + HIGHLIGHT.height, HIGHLIGHT.x + HIGHLIGHT.width, HIGHLIGHT.y + HIGHLIGHT.height],
    contents: 'the words that matter',
  });
  addAnnotation(doc, {
    kind: 'Ink', page: 0, rect: INK, color: '#0a0a0a', borderWidth: 3,
    inkPath: [[[INK.x, INK.y + 40], [INK.x + 50, INK.y + 90], [INK.x + 110, INK.y + 15],
      [INK.x + 180, INK.y + 85], [INK.x + 220, INK.y + 30]]],
  });
  addAnnotation(doc, {
    kind: 'Square', page: 1, rect: SQUARE, color: '#aa0000', fillColor: '#ffeeee', borderWidth: 2,
  });
  addAnnotation(doc, {
    kind: 'Link', page: 1, rect: LINK, link: { type: 'uri', uri: 'https://www.browsersnip.com' },
  });
  // The translucent mark is on the turned sheet: a bake has to carry its `/CA` and
  // leave the sheet's own quarter turn alone.
  addAnnotation(doc, {
    kind: 'Square', page: 3, rect: WASH, color: '#0000aa', fillColor: '#0000aa', opacity: 0.4,
  });

  if (options.fields !== false) {
    createFormField(doc, 0, {
      type: 'text', name: 'answer', rect: { x: 60, y: 480, width: 220, height: 22 },
      value: 'Ada Lovelace', label: 'Answer',
    });
    createFormField(doc, 0, {
      type: 'checkbox', name: 'tick', rect: { x: 60, y: 440, width: 16, height: 16 },
      value: 'true', label: 'Agreed',
    });
    addSignatureWidget(doc, first);
  }
  return doc.save({ useObjectStreams: false });
}

/**
 * A signature widget as a producer writes one: a `/Sig` field in
 * `AcroForm /Fields`, a widget whose `/AP /N` is the drawn mark, and a `/V`
 * dictionary. No viewer will re-draw this appearance, so the flatten pass either
 * carries the strokes into the page or the signature is simply gone.
 */
function addSignatureWidget(doc: PDFDocument, page: PDFPage): void {
  const context = doc.context;
  const strokes = ['q', '0.05 0.05 0.3 RG', '3 w', '10 20 m', '40 55 l', '70 15 l', '95 50 l', 'S', 'Q'].join('\n');
  const appearance = context.register(context.flateStream(strokes, {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 60],
  } as never));
  const value = context.register(context.obj({ Type: 'Sig', FT: 'Sig', Name: 'Signature1' } as never));
  const widget = context.register(context.obj({
    Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('Signature1'),
    Rect: [60, 360, 160, 420], P: page.ref, V: value, AP: { N: appearance }, F: 4,
  } as never));
  const acro = doc.catalog.get(PDFName.of('AcroForm'));
  const acroDict = (acro instanceof PDFRef ? context.lookup(acro, PDFDict) : acro) as PDFDict;
  (context.lookup(acroDict.get(PDFName.of('Fields')), PDFArray) as PDFArray).push(widget);
  (page.node.Annots() as PDFArray).push(widget);
}

// ── reading the answer back out of the file ─────────────────────────────────

async function load(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
}

/** The kinds reachable from a page's `/Annots`, sorted — what a reader still lists. */
async function liveKinds(bytes: Uint8Array): Promise<string[]> {
  const doc = await load(bytes);
  const out: string[] = [];
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray)) continue;
    for (const entry of annots.asArray()) {
      const dict = entry instanceof PDFDict ? entry : doc.context.lookupMaybe(entry as PDFRef, PDFDict);
      if (!dict) continue;
      out.push(dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString().slice(1) ?? '');
    }
  }
  return out.sort();
}

/**
 * One page's own content, every stream inflated by `node:zlib`.
 *
 * Deliberately not `pageContentStreams`: the assertion is about the bake, and the
 * bake is written by this app's content module.
 */
async function pageContent(bytes: Uint8Array, pageIndex: number): Promise<string> {
  const doc = await load(bytes);
  const contents = doc.getPages()[pageIndex].node.Contents();
  const entries = contents instanceof PDFArray
    ? contents.asArray()
    : contents === undefined ? [] : [contents];
  return entries
    .map((entry) => {
      const stream = entry instanceof PDFStream
        ? entry
        : doc.context.lookupMaybe(entry as PDFRef, PDFStream);
      if (!stream) return '';
      const flate = stream.dict.lookupMaybe(PDFName.of('Filter'), PDFName)?.asString() === '/FlateDecode';
      const raw = stream.getContents();
      return latin1.decode(flate ? inflateSync(raw) : raw);
    })
    .join('\n');
}

/** `cm` placements the page holds, as `[a b c d e f]` number lists. */
function placements(content: string): number[][] {
  return [...content.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) cm/g)]
    .map((match) => match.slice(1, 7).map(Number));
}

/** Whether a box was painted at one place: a unit-scale `cm` onto that origin. */
function placedAt(content: string, x: number, y: number): boolean {
  return placements(content).some((m) => Math.abs(m[0] - 1) < 1e-4 && Math.abs(m[3] - 1) < 1e-4
    && Math.abs(m[4] - x) < 0.51 && Math.abs(m[5] - y) < 0.51);
}

/** pdf-lib writes a run as a hex string; both spellings of the words count. */
function showsWords(content: string, phrase: string): boolean {
  const hex = Buffer.from(phrase, 'latin1').toString('hex').toUpperCase();
  const lower = hex.toLowerCase();
  return content.includes(phrase) || content.includes(hex) || content.includes(lower);
}

/** The operator `core/annotations` paints a colour with, to its own rounding. */
function paintOf(hex: string): string {
  const value = (index: number) => {
    const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return String(Math.round(channel * 1000) / 1000);
  };
  return `${value(1)} ${value(3)} ${value(5)}`;
}

async function runFlatten(
  bytes: Uint8Array,
  values: ToolValues = { forms: true, annotations: true, keepLinks: true },
): Promise<RunOutcome> {
  const outcome = await runPdfTool({
    toolId: 'flatten-pdf',
    files: [new File([new Uint8Array(bytes) as BlobPart], 'annot.pdf', { type: 'application/pdf' })],
    values,
    onProgress: () => undefined,
    onLog: () => undefined,
  });
  expect(outcome, 'the run returned nothing').toBeTruthy();
  return outcome!;
}

async function bytesOf(outcome: RunOutcome): Promise<Uint8Array> {
  return new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
}

/**
 * `FLATTEN_DUMP=<name>.pdf npx vitest run tests/pdf/flatten-truth.test.ts` writes
 * the pair `docs/research/flatten-readers.py` measures — the fixture as it went in,
 * and the produced file under the name the campaign committed. Nothing else in the
 * suite touches the worktree.
 */
async function dumpPair(outcome: RunOutcome, source: Uint8Array): Promise<void> {
  if (!process.env.FLATTEN_DUMP) return;
  writeFileSync(join(process.cwd(), 'docs', 'research', 'flatten-input.pdf'), source);
  writeFileSync(join(process.cwd(), 'docs', 'research', process.env.FLATTEN_DUMP), await bytesOf(outcome));
}

/** The `/ExtGState` entries a page's resources hold, as `name → alpha` pairs. */
async function pageAlphas(bytes: Uint8Array, pageIndex: number): Promise<number[]> {
  const doc = await load(bytes);
  const resources = doc.getPages()[pageIndex].node.Resources();
  const dict = resources instanceof PDFRef ? doc.context.lookupMaybe(resources, PDFDict) : resources;
  const states = dict ? doc.context.lookupMaybe(dict.get(PDFName.of('ExtGState')), PDFDict) : undefined;
  if (!states) return [];
  return states.entries().flatMap(([, value]) => {
    const state = value instanceof PDFDict ? value : doc.context.lookupMaybe(value as PDFRef, PDFDict);
    if (!state) return [];
    return ['CA', 'ca']
      .map((key) => state.lookupMaybe(PDFName.of(key), PDFNumber)?.asNumber())
      .filter((alpha): alpha is number => alpha !== undefined);
  });
}

/** The `/ExtGState` entries a page's resources hold, as `name → alpha` pairs. */
async function pageStates(bytes: Uint8Array, pageIndex: number): Promise<Map<string, number>> {
  const doc = await load(bytes);
  const resources = doc.getPages()[pageIndex].node.Resources();
  const dict = resources instanceof PDFRef ? doc.context.lookupMaybe(resources, PDFDict) : resources;
  const states = dict ? doc.context.lookupMaybe(dict.get(PDFName.of('ExtGState')), PDFDict) : undefined;
  const out = new Map<string, number>();
  for (const [name, value] of states?.entries() ?? []) {
    const state = value instanceof PDFDict ? value : doc.context.lookupMaybe(value as PDFRef, PDFDict);
    const alpha = state?.lookupMaybe(PDFName.of('ca'), PDFNumber)?.asNumber();
    if (alpha !== undefined) out.set(String(name).slice(1), alpha);
  }
  return out;
}

/**
 * The alpha in force at each painting operator, replayed off the graphics stack.
 *
 * `q`/`Q` and `gs` are the whole question: an `/ExtGState` that is *set* but popped
 * before the fill leaves the mark opaque, and every resource-level check still sees
 * the entry. Operands are collected in `operands` and consumed by the next operator.
 */
function alphasAtPaint(content: string, states: Map<string, number>): { op: string; alpha: number }[] {
  const stack: number[] = [];
  let current = 1;
  let operands: string[] = [];
  const out: { op: string; alpha: number }[] = [];
  for (const token of content.split(/\s+/).filter(Boolean)) {
    if (token === 'q') { stack.push(current); operands = []; continue; }
    if (token === 'Q') { current = stack.pop() ?? 1; operands = []; continue; }
    if (token === 'gs') {
      const name = operands[operands.length - 1]?.replace(/^\//, '');
      current = states.get(name ?? '') ?? current;
      operands = [];
      continue;
    }
    if (['f', 'f*', 'F', 'B', 'B*', 'S', 's'].includes(token)) {
      out.push({ op: token, alpha: current });
      operands = [];
      continue;
    }
    operands.push(token);
  }
  return out;
}

/** The page's `/Annots` array, created when the page has none yet. */
function annotSlot(page: PDFPage): PDFArray {
  const context = page.doc.context;
  let annots = page.node.Annots();
  if (!(annots instanceof PDFArray)) {
    annots = PDFArray.withContext(context);
    page.node.set(PDFName.of('Annots'), annots);
  }
  return annots;
}

// ── the four kinds this app paints ─────────────────────────────────────────

describe('flatten-pdf puts each mark in the page and takes it out of the comment list', () => {
  it('bakes a text note: the icon is page content, the annotation is gone', async () => {
    const source = await markedFixture({ fields: false });
    expect(await liveKinds(source)).toContain('Text');
    const outcome = await runFlatten(source);
    const bytes = await bytesOf(outcome);
    expect(await liveKinds(bytes)).not.toContain('Text');
    const content = await pageContent(bytes, 0);
    // The note's own colours, painted at the note's own box: the icon's fill is
    // `1 1 0.4 rg` (this app's note yellow) and the sheet is placed at `/Rect`.
    expect(content).toContain(`${paintOf('#ffff66')} rg`);
    expect(placedAt(content, NOTE.x, NOTE.y), 'the note was not painted where it sat').toBe(true);
    // Its text is a comment, not a drawing: baking must not type it onto the page.
    expect(showsWords(content, 'A note about the total')).toBe(false);
    expect(outcome.message).toMatch(/5 annotation\(s\) drawn into the content of 3 page\(s\)/);
  });

  it('bakes a highlight with the blend state it was drawn in', async () => {
    const bytes = await bytesOf(await runFlatten(await markedFixture({ fields: false })));
    expect(await liveKinds(bytes)).not.toContain('Highlight');
    const content = await pageContent(bytes, 0);
    // Yellow fill, the Multiply graphics state, and the quad's own box.
    expect(content).toMatch(/1 1 0 rg/);
    expect(content).toMatch(/\/GS\d*[-\w]* gs/);
    expect(placedAt(content, HIGHLIGHT.x, HIGHLIGHT.y), 'the band missed its quad').toBe(true);
  });

it('opens the wash\u2019s transparency around the paint, not after it', async () => {
    const bytes = await bytesOf(await runFlatten(await markedFixture({ fields: false })));
    const paint = alphasAtPaint(await pageContent(bytes, 3), await pageStates(bytes, 3));
    expect(paint.length, 'the wash painted nothing at all').toBeGreaterThan(0);
    // Every operator of the wash has to run at 40 %. `pageAlphas` (above) only
    // proves the `/ExtGState` was *written*; this is the half that was missing —
    // the state used to be set and popped in a stream the page keeps *before* the
    // appearance stream, so the fill ran opaque while the resource sat there.
    for (const entry of paint) expect(entry.alpha, `${entry.op} ran at ${entry.alpha}, not 0.4`).toBeCloseTo(0.4, 4);
  });

  it('does not call a clickable link a live comment when links were meant to be baked', async () => {
    const doc = await PDFDocument.create();
    doc.addPage(PAGE);
    const index = addAnnotation(doc, {
      kind: 'Link', page: 0, rect: LINK, link: { type: 'uri', uri: 'https://www.browsersnip.com' },
    });
    // A link a producer stored without an appearance: nothing to copy, and the one
    // thing it carries — the target — is what the toggle asked to lose. It used to
    // be counted twice and named wrongly: once as "1 annotation(s) … left as live
    // comments" and again as a link, over a page whose only entry was the link.
    const annots = doc.getPages()[0].node.Annots() as PDFArray;
    (doc.context.lookup(annots.get(index) as PDFRef, PDFDict) as PDFDict).delete(PDFName.of('AP'));
    const outcome = await runFlatten(await doc.save({ useObjectStreams: false }), {
      forms: false, annotations: true, keepLinks: false,
    });
    const all = [outcome.message ?? '', ...outcome.warnings].join(' ');
    expect(await liveKinds(await bytesOf(outcome))).not.toContain('Link');
    expect(all, 'the link was named as a comment as well as a link').toMatch(/1 link\(s\) had no appearance to bake/);
    expect(all, 'a comment that is not there was reported live').not.toMatch(/comment\(s\)/);
    expect(all, 'the same object was counted as a mark left live too').not.toMatch(/1 annotation\(s\) had no appearance/);
  });

  it('does not count a popup as a mark that failed to bake when links are off', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage(PAGE);
    const index = addAnnotation(doc, { kind: 'Text', page: 0, rect: NOTE, contents: 'open me' });
    const context = doc.context;
    const annots = page.node.Annots() as PDFArray;
    const noteRef = annots.get(index) as PDFRef;
    const popup = context.register(context.obj({
      Type: 'Annot', Subtype: 'Popup', Parent: noteRef, Rect: [320, 600, 420, 660],
    } as never));
    annots.push(popup);
    (context.lookup(noteRef, PDFDict) as PDFDict).set(PDFName.of('Popup'), popup);
    // Turned off, links stop being skipped up front — and the popup was swept with
    // them: it never has an appearance, so it read as "1 annotation had no
    // appearance to draw" on a run whose only real mark did bake. Its parent's fate
    // decides instead, and the popup leaves with the note.
    const outcome = await runFlatten(await doc.save({ useObjectStreams: false }), {
      forms: false, annotations: true, keepLinks: false,
    });
    const kinds = await liveKinds(await bytesOf(outcome));
    expect(kinds).not.toContain('Popup');
    expect(outcome.warnings.join(' '), 'the popup was reported as a mark that could not be drawn')
      .not.toMatch(/had no appearance/);
    expect(outcome.message).toMatch(/^1 annotation\(s\) drawn into the content of 1 page\(s\)/);
  });

  it('bakes an ink stroke inside the box it was drawn on', async () => {
    const bytes = await bytesOf(await runFlatten(await markedFixture({ fields: false })));
    expect(await liveKinds(bytes)).not.toContain('Ink');
    const content = await pageContent(bytes, 0);
    // The stroke's own pen: near-black, 3 pt, round caps, and a polyline.
    expect(content).toMatch(/0\.039 0\.039 0\.039 RG/);
    expect(content).toMatch(/3 w/);
    expect(content).toMatch(/\d+(?:\.\d+)? \d+(?:\.\d+)? m[\s\S]+?l[\s\S]+?l[\s\S]+?S/);
    expect(placedAt(content, INK.x, INK.y), 'the stroke missed its box').toBe(true);
  });

  it('bakes a square on its own sheet, and a translucent one on a turned sheet', async () => {
    const source = await markedFixture({ fields: false });
    const bytes = await bytesOf(await runFlatten(source));
    expect(await liveKinds(bytes)).not.toContain('Square');
    const second = await pageContent(bytes, 1);
    expect(second).toContain(`${paintOf('#aa0000')} RG`);
    expect(second).toContain(`${paintOf('#ffeeee')} rg`);
    expect(placedAt(second, SQUARE.x, SQUARE.y)).toBe(true);

    const third = await pageContent(bytes, 3);
    expect(third).toContain(`${paintOf('#0000aa')} rg`);
    expect(placedAt(third, WASH.x, WASH.y), 'the turned sheet lost its mark').toBe(true);
    // `/CA` belongs to the annotation, so the bake has to say it in the page: a
    // 40 % wash that came back solid is a different picture than the one the user
    // saw and flattened.
    expect(await pageAlphas(bytes, 3), 'the translucent mark was baked opaque').toContain(0.4);
    // And the sheet keeps the quarter turn it arrived with.
    expect((await load(bytes)).getPages()[3].getRotation().angle).toBe(90);
  });

  it('keeps a link clickable by default and removes it only when asked', async () => {
    const source = await markedFixture({ fields: false });
    const kept = await bytesOf(await runFlatten(source, { forms: false, annotations: true, keepLinks: true }));
    expect(await liveKinds(kept)).toContain('Link');
    const baked = await bytesOf(await runFlatten(source, { forms: false, annotations: true, keepLinks: false }));
    expect(await liveKinds(baked)).not.toContain('Link');
    // The dashes this app stores in the link's appearance are what a print-ready
    // copy gains and the target is what it loses. Measured bytes, not a guess:
    // the box is painted at the link's own `/Rect` with the `[5 3]` dash.
    const dashes = await pageContent(baked, 1);
    expect(dashes).toMatch(/\[\s*5\s+3\s*\]\s*0\s+d/);
    expect(dashes).toMatch(/0 0 180 18 re/);
    expect(placedAt(dashes, LINK.x, LINK.y)).toBe(true);
    // A reader paints link annotations itself, so the *input* page holds no link
    // ink of its own: this is the one kind where the bake adds what the viewer
    // had been drawing, which is why the copy says "a link drawn by the reader
    // rather than stored in the file leaves no mark behind".
    expect(await pageContent(source, 1)).not.toMatch(/\]\s*0\s+d/);
  });

  it('bakes a signature-like appearance and stops the field being fillable', async () => {
    const source = await markedFixture();
    const before = await load(source);
    const beforeAcro = before.context.lookupMaybe(before.catalog.get(PDFName.of('AcroForm')), PDFDict);
    expect((before.context.lookup(beforeAcro!.get(PDFName.of('Fields')), PDFArray) as PDFArray).size()).toBe(3);

    const outcome = await runFlatten(source);
    const bytes = await bytesOf(outcome);
    const doc = await load(bytes);
    const acro = doc.context.lookupMaybe(doc.catalog.get(PDFName.of('AcroForm')), PDFDict);
    const fields = acro ? doc.context.lookupMaybe(acro.get(PDFName.of('Fields')), PDFArray) : undefined;
    expect(fields?.size() ?? 0, 'AcroForm still lists fields').toBe(0);
    expect(await liveKinds(bytes)).not.toContain('Widget');
    // `flattenForm` now deletes the empty `/AcroForm` with the last field, so the
    // dictionary may be absent altogether; either way no viewer is told to draw.
    expect(acro?.has(PDFName.of('NeedAppearances')) ?? false, 'a viewer is still told to draw the values').toBe(false);
    // The signature's own strokes, at the box it was signed in, with no annotation
    // left for a reader to point at.
    const content = await pageContent(bytes, 0);
    expect(content).toContain('0.05 0.05 0.3 RG');
    expect(placedAt(content, 60, 360), 'the signature missed its box').toBe(true);
    // And the typed answer is page text now, not a value in a field.
    expect(showsWords(content, 'Ada Lovelace'), 'the answer did not reach the page').toBe(true);
    expect(outcome.message).toMatch(/3 form field\(s\) removed from the form/);
    expect(outcome.warnings).toEqual([]);
  });

  it('leaves a mark no reader paints as an annotation instead of inventing ink', async () => {
    const doc = await PDFDocument.create();
    doc.addPage(PAGE);
    addAnnotation(doc, {
      kind: 'Square', page: 0, rect: SQUARE, flags: ['Print', 'Hidden'], color: '#000000',
    });
    const source = await doc.save({ useObjectStreams: false });
    const outcome = await runFlatten(source);
    const bytes = await bytesOf(outcome);
    expect(await liveKinds(bytes), 'a hidden mark was deleted rather than admitted to').toContain('Square');
    expect(await pageContent(bytes, 0)).not.toMatch(/\b(re|f)\b/);
    expect(outcome.message).toMatch(/^0 annotation\(s\) drawn into the content of 0 page\(s\)/);
    expect(outcome.warnings.join(' ')).toMatch(/Invisible, Hidden or NoView/);
  });

  it('carries the popup of a baked note out with it', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage(PAGE);
    const index = addAnnotation(doc, {
      kind: 'Text', page: 0, rect: NOTE, contents: 'open me',
    });
    const context = doc.context;
    const annots = page.node.Annots() as PDFArray;
    const noteRef = annots.get(index) as PDFRef;
    const popup = context.register(context.obj({
      Type: 'Annot', Subtype: 'Popup', Parent: noteRef, Rect: [320, 600, 420, 660], F: 4,
    } as never));
    annots.push(popup);
    (context.lookup(noteRef, PDFDict) as PDFDict).set(PDFName.of('Popup'), popup);
    const bytes = await bytesOf(await runFlatten(await doc.save({ useObjectStreams: false })));
    const kinds = await liveKinds(bytes);
    expect(kinds).not.toContain('Text');
    expect(kinds, 'an orphan popup is still a comment to every reader').not.toContain('Popup');
  });

  it('invents no AcroForm on a document that has no fields', async () => {
    const doc = await PDFDocument.create();
    doc.addPage(PAGE);
    addAnnotation(doc, {
      kind: 'Ink', page: 0, rect: INK, inkPath: [[[INK.x, INK.y + 40], [INK.x + 110, INK.y + 15], [INK.x + 220, INK.y + 30]]],
    });
    const source = await doc.save({ useObjectStreams: false });
    expect((await load(source)).catalog.has(PDFName.of('AcroForm'))).toBe(false);
    const bytes = await bytesOf(await runFlatten(source, { forms: false, annotations: true, keepLinks: true }));
    expect((await load(bytes)).catalog.has(PDFName.of('AcroForm')), 'a comment bake added form furniture').toBe(false);
    expect(await liveKinds(bytes)).toEqual([]);
  });

  it('does not stop at a page with no /Annots, which is what a blank sheet is', async () => {
    const doc = await PDFDocument.create();
    doc.addPage(PAGE);
    doc.addPage(PAGE);
    addAnnotation(doc, { kind: 'Square', page: 1, rect: SQUARE, color: '#000000' });
    const outcome = await runFlatten(await doc.save({ useObjectStreams: false }));
    const bytes = await bytesOf(outcome);
    expect(await liveKinds(bytes), 'the pass died on the annotation-free sheet before it').toEqual([]);
    expect(outcome.message).toMatch(/1 annotation\(s\) drawn into the content of 1 page\(s\)/);
  });
});

// ── the card has to agree with the file ────────────────────────────────────

describe('the result says what the bytes do', () => {
  it('counts exactly the marks the file gave up', async () => {
    const source = await markedFixture();
    const before = await liveKinds(source);
    const outcome = await runFlatten(source);
    const bytes = await bytesOf(outcome);
    const after = await liveKinds(bytes);
    const claimed = Number(/(\d+) annotation\(s\) drawn/.exec(outcome.message ?? '')?.[1]);
    await dumpPair(outcome, source);
    // Only the comment kinds are the annotation pass's: widgets are reported as
    // fields, and a link the user asked to keep is neither.
    const gone = before.filter((kind) => kind !== 'Widget' && kind !== 'Link').length
      - after.filter((kind) => kind !== 'Widget' && kind !== 'Link').length;
    expect(claimed, `the card counted ${claimed}, the file lost ${gone}`).toBe(gone);
    expect(gone).toBeGreaterThan(0);
    expect(after, 'a comment survived while the card says nothing is left live')
      .toEqual(after.filter((kind) => kind === 'Link'));
    expect(outcome.warnings).toEqual([]);
  });

  it('says there was nothing to flatten only when there was nothing to flatten', async () => {
    const empty = await PDFDocument.create();
    empty.addPage(PAGE);
    const plain = await empty.save({ useObjectStreams: false });
    const outcome = await runFlatten(plain);
    expect(outcome.warnings.join(' ')).toMatch(/nothing of the selected kind to flatten/i);
    expect(outcome.message).toMatch(/^0 annotation\(s\) drawn into the content of 0 page\(s\)/);

    // The same sentence must not appear beside live marks it could not draw: that
    // contradiction was half of the triage entry.
    const hidden = await PDFDocument.create();
    hidden.addPage(PAGE);
    addAnnotation(hidden, { kind: 'Square', page: 0, rect: SQUARE, flags: ['Hidden'] });
    const admitted = await runFlatten(await hidden.save({ useObjectStreams: false }));
    expect(admitted.warnings.join(' ')).not.toMatch(/nothing of the selected kind to flatten/i);
    expect(admitted.warnings.join(' ')).toMatch(/still live|left as annotations/i);
  });

  it('keeps a library sentence out of the user\u2019s warning', async () => {
    const outcome = await runFlatten(await markedFixture());
    const all = [outcome.message ?? '', ...outcome.warnings].join(' ');
    expect(all).not.toMatch(/Expected instance of|PDFDict|PDFRawStream|undefined|\[object Object\]/);
  });

  it('holds the sheets, the text and the page count it did not touch', async () => {
    const outcome = await runFlatten(await markedFixture());
    const bytes = await bytesOf(outcome);
    expect((await load(bytes)).getPageCount()).toBe(4);
    expect(outcome.pagesOut).toBe(4);
    expect(showsWords(await pageContent(bytes, 0), 'Invoice 42 total due on signature')).toBe(true);
    expect(showsWords(await pageContent(bytes, 1), 'Second sheet')).toBe(true);
    expect(showsWords(await pageContent(bytes, 3), 'Turned sheet')).toBe(true);
    // The blank sheet stays blank: no bake reaches a page that had no mark.
    expect(await pageContent(bytes, 2)).toBe('');
  });

  it('reports a form it was not asked to bake as still interactive', async () => {
    const outcome = await runFlatten(await markedFixture(), {
      forms: false, annotations: true, keepLinks: true,
    });
    const bytes = await bytesOf(outcome);
    expect(await liveKinds(bytes)).toContain('Widget');
    expect(outcome.warnings.join(' ')).toMatch(/left interactive, as asked/i);
    // The annotation pass must not eat a widget out from under the form pass: a
    // field whose box was drawn into the page is neither interactive nor flattened.
    expect((await liveKinds(bytes)).filter((kind) => kind === 'Widget')).toHaveLength(3);
  });
});

// ── what the chunk-2 live re-drive found ─────────────────────────────────────
//
// `docs/research/flatten-round.mjs` drove this tool on a real tab at :5294 over
// fixtures written by MuPDF (`docs/research/flatten-c2-build.py`) and
// `docs/research/flatten-c2-measure.py` / `flatten-c2-visual.py` judged the
// downloads against the untouched source, with MuPDF's own `Document.bake()` as
// the outside bar. Two of the findings were this tool's to fix; both are pinned
// below against the shared surface that ate one of them.

describe('the receipt reaches the screen, and a link with no ink still loses its target', () => {
  /**
   * A file with one drawable square and one note stripped of its appearance: the
   * run has something to report as still live, and the bytes come out bigger.
   */
  async function oneLiveOneBaked(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage(PAGE);
    addAnnotation(doc, { kind: 'Square', page: 0, rect: SQUARE, color: '#00aa00', borderWidth: 2 });
    const index = addAnnotation(doc, { kind: 'Text', page: 0, rect: NOTE, contents: 'no appearance here' });
    const annots = page.node.Annots() as PDFArray;
    (doc.context.lookup(annots.get(index) as PDFRef, PDFDict) as PDFDict).delete(PDFName.of('AP'));
    return doc.save({ useObjectStreams: false });
  }

  it('words the summary so the card prints it when the file grew', async () => {
    const outcome = await runFlatten(await oneLiveOneBaked());
    expect(outcome.message).toMatch(/1 comment\(s\) still live/);
    // The shared card drops any summary that reads as a size promise once the
    // download is bigger (`honestSummary`, `SHRINK_CLAIM` in shared/ResultCard).
    // The sentence used to end "…in the saved file"; `saved` is on that word list,
    // so a measured run that baked one mark and left one live printed the warnings
    // and no count at all — the receipt the promise promises.
    expect(
      honestSummary(outcome.message, true),
      `the card swallows "${outcome.message}" because it reads as a saving claim`,
    ).toBe(outcome.message);
  });

  it('drops a link that has no appearance when the toggle asks for no targets', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage(PAGE);
    addAnnotation(doc, { kind: 'Square', page: 0, rect: SQUARE, color: '#00aa00', borderWidth: 2 });
    const index = addAnnotation(doc, {
      kind: 'Link', page: 0, rect: LINK, link: { type: 'uri', uri: 'https://www.browsersnip.com' },
    });
    const annots = page.node.Annots() as PDFArray;
    (doc.context.lookup(annots.get(index) as PDFRef, PDFDict) as PDFDict).delete(PDFName.of('AP'));
    const source = await doc.save({ useObjectStreams: false });

    const outcome = await runFlatten(source, { forms: false, annotations: true, keepLinks: false });
    const bytes = await bytesOf(outcome);
    const after = await load(bytes);
    // Measured before the fix: the file kept both hot rectangles alive with their
    // `/A` actions while the card said so — and the field's own sentence promised
    // the target was gone. A link with no appearance has no ink to invent, so the
    // only thing it carries is the target, and that is what the toggle is for.
    expect(await liveKinds(bytes)).not.toContain('Link');
    expect(after.getPages()[0].node.get(PDFName.of('Annots')), 'an empty /Annots is still a key').toBeUndefined();
    expect((await pageContent(bytes, 0)).length).toBeGreaterThan(0);
    const all = [outcome.message ?? '', ...outcome.warnings].join(' ');
    expect(all).toMatch(/1 link\(s\) had no appearance to bake/);
    expect(all, 'the dropped link was also counted as a mark left live').not.toMatch(/1 annotation\(s\) had no appearance/);
    expect(all, 'a link is not a comment').not.toMatch(/1 comment\(s\) still live/);
    expect(outcome.message).toMatch(/nothing of the selected kind is left live/);

    // Control: the same file with the toggle left on keeps its clickable area, and
    // a run over a page with only that link still says the square was baked.
    const kept = await runFlatten(source, { forms: false, annotations: true, keepLinks: true });
    expect(await liveKinds(await bytesOf(kept))).toContain('Link');
  });

  it('says what a link-only run gave up when the comments were left alone', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage(PAGE);
    addAnnotation(doc, { kind: 'Text', page: 0, rect: NOTE, contents: 'a comment that stays' });
    const index = addAnnotation(doc, {
      kind: 'Link', page: 0, rect: LINK, link: { type: 'uri', uri: 'https://www.browsersnip.com' },
    });
    const annots = page.node.Annots() as PDFArray;
    (doc.context.lookup(annots.get(index) as PDFRef, PDFDict) as PDFDict).delete(PDFName.of('AP'));
    const outcome = await runFlatten(await doc.save({ useObjectStreams: false }), {
      forms: false, annotations: false, keepLinks: false,
    });
    const bytes = await bytesOf(outcome);
    expect(await liveKinds(bytes)).toEqual(['Text']);
    const all = outcome.warnings.join(' ');
    expect(all).toMatch(/annotation flattening was off/i);
    expect(all, 'a link with no stored appearance was claimed as baked ink').toMatch(/the links gave up their targets/);
    expect(all).not.toMatch(/only the links were baked/);
    expect(outcome.message).toMatch(/^0 form field\(s\) removed from the form/);
  });

  it('names an unpaintable link as dropped, not as a mark left off the page', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage(PAGE);
    addAnnotation(doc, { kind: 'Square', page: 0, rect: SQUARE, color: '#00aa00', borderWidth: 2 });
    const index = addAnnotation(doc, {
      kind: 'Link', page: 0, rect: LINK, flags: ['Hidden'],
      link: { type: 'uri', uri: 'https://www.browsersnip.com' },
    });
    const annots = page.node.Annots() as PDFArray;
    (doc.context.lookup(annots.get(index) as PDFRef, PDFDict) as PDFDict).delete(PDFName.of('AP'));
    const outcome = await runFlatten(await doc.save({ useObjectStreams: false }), {
      forms: false, annotations: true, keepLinks: false,
    });
    expect(await liveKinds(await bytesOf(outcome))).not.toContain('Link');
    expect(outcome.warnings.join(' '), 'a hidden link was counted among the marks kept off the page')
      .not.toMatch(/Invisible, Hidden or NoView/);
    expect(outcome.warnings.join(' ')).toMatch(/1 link\(s\) had no appearance to bake/);
  });
});

describe('the bake is judged against the readers that painted the input', () => {
  /**
   * Two sheets turned 180 and 270, each with a mark in the same displayed corner.
   * `docs/research/flatten-c2-measure.py` measured the produced bytes at 150 dpi
   * against MuPDF's rendering of the same page, annots on: 0 of 2.17 M pixels
   * moved on every quarter turn, which is what these two placements pin in bytes.
   */
  it('lands a mark in its own box on a half- and a three-quarter-turned sheet', async () => {
    const doc = await PDFDocument.create();
    const half = doc.addPage(PAGE);
    half.setRotation(degrees(180));
    const back = doc.addPage(PAGE);
    back.setRotation(degrees(270));
    addAnnotation(doc, { kind: 'Square', page: 0, rect: SQUARE, color: '#00aa00', fillColor: '#eeffee', borderWidth: 2 });
    addAnnotation(doc, { kind: 'Ink', page: 1, rect: INK, color: '#0000aa', borderWidth: 3,
      inkPath: [[[INK.x, INK.y + 40], [INK.x + 60, INK.y + 90], [INK.x + 140, INK.y + 20]]] });
    const bytes = await bytesOf(await runFlatten(await doc.save({ useObjectStreams: false })));
    expect(await liveKinds(bytes)).toEqual([]);
    expect(placedAt(await pageContent(bytes, 0), SQUARE.x, SQUARE.y), 'the 180 sheet lost its box').toBe(true);
    expect(placedAt(await pageContent(bytes, 1), INK.x, INK.y), 'the 270 sheet lost its stroke').toBe(true);
    expect((await load(bytes)).getPages().map((p) => p.getRotation().angle), 'a turn was ironed out')
      .toEqual([180, 270]);
  });

  /**
   * An appearance that is a form XObject drawing a nested form XObject, over a
   * page that owns a DIFFERENT object under the same resource name. Adoption that
   * forgets to rename paints the page's own box inside the mark instead of the
   * mark's own ink — `docs/research/flatten-c2-measure.py` sees it as magenta where
   * cyan belongs; this sees it in the bytes.
   */
  it('carries a nested appearance in with its own resources', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage(PAGE);
    const context = doc.context;
    const font = context.register(context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' } as never));
    const pageOwnInner = context.register(context.flateStream('1 0 1 rg 0 0 100 40 re f\n', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 40],
    } as never));
    // Whatever name the page ends up holding its own box under, that name is the
    // one the appearance also uses for `/Inner` — the collision the bake has to
    // resolve by renaming the arriving object, not the page's.
    const ownName = page.node.newXObject('Inner', pageOwnInner).asString().slice(1);
    const nested = context.register(context.flateStream('BT /F1 9 Tf 2 4 Td (INNER-FORM-TEXT) Tj ET\n', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 40], Resources: { Font: { F1: font } },
    } as never));
    const outer = context.register(context.flateStream('q 1 0 0 1 4 8 cm /Inner Do Q\n', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 40],
      Resources: { Font: { F1: font }, XObject: { Inner: nested } },
    } as never));
    const mark = context.register(context.obj({
      Type: 'Annot', Subtype: 'Square', Rect: [60, 600, 160, 640], Border: [0, 0, 1], AP: { N: outer },
    } as never));
    annotSlot(page).push(mark);

    const bytes = await bytesOf(await runFlatten(await doc.save({ useObjectStreams: false })));
    const after = await load(bytes);
    expect(await liveKinds(bytes)).toEqual([]);
    const content = await pageContent(bytes, 0);
    /** The decoded body of one `/XObject` of the page, by resource name. */
    const drawnBy = (name: string): string => {
      const sheet = after.getPages()[0].node.Resources();
      const resources = sheet instanceof PDFRef ? after.context.lookupMaybe(sheet, PDFDict) : sheet;
      const box = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      const ref = box?.get(PDFName.of(name));
      const stream = ref instanceof PDFRef
        ? after.context.lookupMaybe(ref, PDFStream)
        : ref instanceof PDFStream ? ref : undefined;
      if (!stream) return '';
      const raw = stream.getContents();
      const flate = stream.dict.lookupMaybe(PDFName.of('Filter'), PDFName)?.asString() === '/FlateDecode';
      return latin1.decode(flate ? inflateSync(raw) : raw);
    };
    const adopted = [...content.matchAll(/\/([\w-]+) Do/g)].map((match) => match[1]);
    expect(adopted.length, 'the nested form never reached the page').toBeGreaterThan(0);
    expect(drawnBy(ownName), 'the page’s own box was displaced by the appearance’s').toContain('1 0 1 rg');
    const travelled = adopted.filter((name) => name !== ownName);
    expect(travelled.length, 'the appearance brought no object of its own').toBeGreaterThan(0);
    expect(adopted.map(drawnBy).join(''), 'the appearance’s own inner form did not travel with it')
      .toContain('INNER-FORM-TEXT');
    expect(drawnBy(ownName), 'the page’s box now draws the appearance’s words').not.toContain('INNER-FORM-TEXT');
  });
});

describe('the bake clips, paints the state /AS names, and turns only what readers turn', () => {
  /**
   * A mark whose appearance paints past its own box.
   *
   * `turn.pdf` sheet 1 (two squares over a 100×30 appearance whose 14 pt ascenders
   * stand above the box) measured **1690 px changed** and 1826 px of ink that neither
   * the annotated source nor the plain paper paints, against MuPDF's own bake of the
   * same file: **0 px**. The inline arm copied the operators with no clip, while the
   * arm that draws the XObject gets the clip for free from the viewer — the two arms
   * of one bake disagreed about the same appearance.
   */
  async function escapingMark(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage(PAGE);
    const context = doc.context;
    // 0–40 is the box; the red band runs 30→60, so 20 pt of it lies outside.
    const appearance = context.register(context.flateStream(
      '0 0 1 rg 0 0 100 40 re f\n1 0 0 rg 0 30 100 30 re f\n',
      { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 40] } as never,
    ));
    const mark = context.register(context.obj({
      Type: 'Annot', Subtype: 'Square', Rect: [60, 600, 160, 640], Border: [0, 0, 1], AP: { N: appearance },
    } as never));
    annotSlot(page).push(mark);
    return doc.save({ useObjectStreams: false });
  }

  it('clips the inlined operators to the appearance’s /BBox', async () => {
    const bytes = await bytesOf(await runFlatten(await escapingMark()));
    const content = await pageContent(bytes, 0);
    // The clip is written in form space — the only space in which `/BBox` means
    // anything — after the `cm` that fits the box and before the copied operators.
    expect(content, 'the copied appearance carried no clip to its /BBox')
      .toMatch(/1 0 0 1 60 600 cm\s+0 0 100 40 re\s+W\s+n/);
    // Control: the clip cuts the escape, never the mark. The band inside the box is
    // still painted, and the escaping one is still copied for the viewer to clip.
    expect(content).toMatch(/0 0 1 rg\s+0 0 100 40 re\s+f/);
    expect(content).toMatch(/1 0 0 rg\s+0 30 100 30 re\s+f/);
    expect(await liveKinds(bytes), 'the mark stayed live as well as baked').toEqual([]);
  });

  /**
   * A radio the way MuPDF writes one: the field's `/V` is the **string** `(Yes)`
   * while the widget's state table is keyed by **names**.
   */
  async function radioFixture(as: 'Yes' | 'Off'): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage(PAGE);
    const context = doc.context;
    const on = context.register(context.flateStream('0 0 1 rg 2 2 12 12 re f\n',
      { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 16, 16] } as never));
    const off = context.register(context.flateStream('0 0 1 rg 2 2 12 4 re f\n',
      { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 16, 16] } as never));
    const form = doc.getForm();
    const kids = PDFArray.withContext(context);
    const field = context.register(context.obj({
      FT: 'Btn', T: `pick.${as}`, Ff: 32768, V: PDFString.of('Yes'), Kids: kids,
    } as never));
    kids.push(context.register(context.obj({
      Type: 'Annot', Subtype: 'Widget', FT: 'Btn', Parent: field, Ff: 32768,
      Rect: [60, 600, 76, 616], AS: PDFName.of(as), P: page.ref,
      AP: context.obj({ N: context.obj({ Yes: on, Off: off }) } as never) as never,
    } as never)));
    for (const kid of kids.asArray()) annotSlot(page).push(kid);
    (context.lookup(form.acroForm.dict.get(PDFName.of('Fields')), PDFArray) as PDFArray).push(field);
    return doc.save({ useObjectStreams: false });
  }

  it('paints the state /AS names, not the one /V spells', async () => {
    // Measured on `mix.pdf` sheet 2: the ticked radio came back as an empty circle —
    // 181 px gone across the whole 16 pt box, against a MuPDF bake that changes 0 px.
    // The old match ran the raw `/V` (a string) against a table of names, missed, and
    // fell through to `/Off`.
    const ticked = await bytesOf(await runFlatten(await radioFixture('Yes')));
    const content = await pageContent(ticked, 0);
    expect(content, 'the ticked radio baked its empty circle').toMatch(/0 0 1 rg\s+2 2 12 12 re\s+f/);
    expect(content, 'both states were painted').not.toMatch(/0 0 1 rg\s+2 2 12 4 re\s+f/);
    // Control: the same field with `/AS /Off` bakes the off state, so the fix follows
    // the declared state instead of always taking the entry the value spells.
    const cleared = await pageContent(await bytesOf(await runFlatten(await radioFixture('Off'))), 0);
    expect(cleared).toMatch(/0 0 1 rg\s+2 2 12 4 re\s+f/);
    expect(cleared, 'the off state baked the tick').not.toMatch(/0 0 1 rg\s+2 2 12 12 re\s+f/);
    expect(await liveKinds(ticked), 'the widget survived its own bake').toEqual([]);
  });

  /**
   * A 120×24 widget declaring a quarter turn, on a flat sheet or a `/Rotate 90` one.
   * `key` picks which of the two spellings declares it — `Rot` (PDF 1.3–1.7) or
   * `Rotate` (PDF 2.0) — because the two do not mean the same thing to a reader.
   */
  function declaringWidget(
    pageRotation: 0 | 90,
    key: 'Rot' | 'Rotate',
  ): Promise<Uint8Array> {
    return declaringMark(pageRotation, key, {
      rect: [300, 600, 420, 624], bbox: [0, 0, 120, 24], word: 'WIDGET-ROT-90', widget: true,
    });
  }

  /** The same declaration on a `Square`: the mark bake, asked the same question. */
  async function declaringMark(
    pageRotation: 0 | 90,
    key: 'Rot' | 'Rotate',
    shape: { rect: [number, number, number, number]; bbox: [number, number, number, number]; word: string; widget?: boolean },
  ): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage(PAGE);
    if (pageRotation) page.setRotation(degrees(pageRotation));
    const context = doc.context;
    const appearance = context.register(context.flateStream(
      `BT /F1 12 Tf 2 6 Td (${shape.word}) Tj ET\n`,
      { Type: 'XObject', Subtype: 'Form', BBox: shape.bbox } as never));
    const mark = context.register(context.obj({
      Type: 'Annot',
      ...(shape.widget
        ? { Subtype: 'Widget', FT: 'Tx', T: `turn.${key}${pageRotation}`, V: shape.word }
        : { Subtype: 'Square', Border: [0, 0, 1] }),
      Rect: shape.rect, [key]: 90, F: 4, P: page.ref, AP: { N: appearance },
    } as never));
    annotSlot(page).push(mark);
    if (shape.widget) {
      const fields = context.lookup(doc.getForm().acroForm.dict.get(PDFName.of('Fields')), PDFArray) as PDFArray;
      fields.push(mark);
    }
    return doc.save({ useObjectStreams: false });
  }

  it('takes no turn for /Rot, the spelling no reader reads', async () => {
    // The raw `/Rot` was applied to the bake's own copy, and `turn.pdf` sheet 2
    // (`/Rotate 90`, widget `/Rot 90`) came out as `0 1 -1 0 420 600 cm` where MuPDF's
    // bake of the same file writes `1 0 0 1 300 600 cm` — 3045 px of that run's
    // 3845 px, the answer facing the other way. The fix is not the page's turn: MuPDF
    // turns an appearance by `/Rot` on a **flat** sheet exactly as little — see
    // `docs/research/flatten-rot-rule.py`, whose bake of a `/Rot 90` mark in a 30×100
    // box is `0.3 0 0 3.33333 60 700 cm`, the words squeezed into the box rather than
    // stood up — and pdf.js never reads the key at all (`setRotation` asks
    // `mk.get("R") || dict.get("Rotate")`). So `/Rot` carries no turn for this bake on
    // either sheet.
    for (const pageRotation of [0, 90] as const) {
      const content = await pageContent(
        await bytesOf(await runFlatten(await declaringWidget(pageRotation, 'Rot'))), 0);
      expect(placements(content), `the /Rot turned the widget on a /Rotate ${pageRotation} sheet`)
        .toContainEqual([1, 0, 0, 1, 300, 600]);
      expect(content).toMatch(/1 0 0 1 300 600 cm\s+0 0 120 24 re\s+W\s+n/);
      expect(content, 'the answer never reached the page').toContain('(WIDGET-ROT-90) Tj');
      expect(await liveKinds(await bytesOf(await runFlatten(await declaringWidget(pageRotation, 'Rot')))),
        'the widget survived its own bake').toEqual([]);
    }
  });

  it('turns by /Rotate, the spelling the pane turns by', async () => {
    // Control for the case above: the entry PDF 2.0 and pdf.js do use still turns, and
    // it turns inside the box — never together with the page's own `/Rotate`, which
    // every viewer applies to the copied content as well.
    const content = await pageContent(
      await bytesOf(await runFlatten(await declaringWidget(0, 'Rotate'))), 0);
    expect(placements(content), 'the /Rotate turn was dropped with /Rot')
      .toContainEqual([0, 1, -1, 0, 420, 600]);
  });

  it('bakes a mark by the same rule it bakes a widget by', async () => {
    // `turn.pdf` sheet 2 also carries a `Square` declaring `/Rot 90` on the `/Rotate 90`
    // sheet, and sheet 1 the same declaration on an unturned sheet in a 30×100 box.
    // MuPDF's bake places both without any turn; the two arms of this bake have to
    // agree with it, and with each other, because they copy one appearance.
    const turned = await declaringMark(90, 'Rot', {
      rect: [60, 700, 160, 730], bbox: [0, 0, 100, 30], word: 'MARK-ROT-90',
    });
    const turnedBytes = await bytesOf(await runFlatten(turned));
    const turnedContent = await pageContent(turnedBytes, 0);
    expect(placements(turnedContent), 'the turned sheet stood the mark up')
      .toContainEqual([1, 0, 0, 1, 60, 700]);
    expect(await liveKinds(turnedBytes), 'the mark stayed live as well as baked').toEqual([]);
    // A tall box and a wide appearance: the fit alone squeezes the words into it, to
    // the same numbers MuPDF writes — `/Rot` adds no turn to that either.
    const flat = await pageContent(await bytesOf(await runFlatten(await declaringMark(0, 'Rot', {
      rect: [200, 700, 230, 800], bbox: [0, 0, 100, 30], word: 'MARK-ROT-90',
    }))), 0);
    expect(placements(flat), 'the mark was turned instead of squeezed')
      .toContainEqual([0.3, 0, 0, 3.33333, 200, 700]);
  });
});
