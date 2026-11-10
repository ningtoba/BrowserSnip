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
    expect(acro?.has(PDFName.of('NeedAppearances')), 'a viewer is still told to draw the values').toBe(false);
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
