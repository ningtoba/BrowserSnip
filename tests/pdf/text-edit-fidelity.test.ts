/**
 * Fidelity of the in-place text editor: does an edit **delete** the old words,
 * keep the page's **own font**, and tell the truth about anything it could not
 * do — measured off the produced bytes, never off the absence of an error.
 *
 * Two user reports started this file, and the first draft of its diagnosis was
 * wrong in a way only measurement caught (docs/TOOL-CAMPAIGN.md, `edit-pdf-text`):
 *
 *   "editing a text literally draws boxes on top of current text" — the cover
 *   patch in `draw.ts` was not the culprit. A block whose words the engine could
 *   not delete was **skipped**: the file kept the old words and the on-screen
 *   paper-coloured box sat over them, which is what the user saw. So the fix is
 *   to make the deletion work, and this file proves the words leave the file.
 *
 *   "the font is changed" — true: `faces.ts` resolved bundled Noto Sans for
 *   every run while the document's own font object was sitting right there in
 *   the file being edited. Now it is reused when it can spell the new text, and
 *   when it cannot (a subsubset without the typed characters, a Type3 face, a
 *   weight the face does not carry) the block is substituted **and reported**.
 *
 * The causes below are the ones the fixture corpus really contains; each is
 * pinned by a test that fails without its fix, and the corpus numbers (734
 * blocks across eight producers) are in the ledger row.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  StandardFonts,
} from '@maxwbh/pdf-lib';
import type { PDFPage } from '@maxwbh/pdf-lib';
import { openPDF } from '@/lib/pdf/core/doc';
import {
  pageTextFaces,
  parseContentStream,
  removeTextInRects,
  textInRects,
  textRects,
} from '@/lib/pdf/core/content';
import { clearFontCache } from '@/lib/pdf/core/fonts';
import { applyEdits, exportReport, frameOfPage, deleteOriginalText } from '@/components/tools/pdf/text-editor/draw';
import { chooseFace } from '@/components/tools/pdf/text-editor/faces';
import {
  DEFAULT_STYLE,
  deletionBoxes,
  paragraphsFromText,
  viewerBoxToUserSpace,
  viewerToUserMatrix,
  applyMatrix,
  type ExtractedParagraph,
  type TextObject,
} from '@/components/tools/pdf/text-editor/model';
import type { TopLeftBox } from '@/lib/pdf/core/tables';

const A4: [number, number] = [595.28, 841.89];

/** Real TrueType bytes, for a fixture whose font claims to embed a program. */
const NOTO = new Uint8Array(
  readFileSync(join(process.cwd(), 'public', 'fonts', 'NotoSans-Regular.ttf')),
);

/* ── the font fetch, so nothing in this file reaches the network ───────────── */

const realFetch = globalThis.fetch;

beforeAll(() => {
  const face = (file: string): Uint8Array =>
    new Uint8Array(readFileSync(join(process.cwd(), 'public', 'fonts', file)));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const match = /NotoSans-(Regular|Bold)\.ttf$/.exec(url);
    const bytes = face(match ? `NotoSans-${match[1]}.ttf` : 'NotoSans-Regular.ttf');
    return new Response(bytes as unknown as BodyInit, { headers: { 'content-type': 'font/ttf' } });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

afterEach(() => clearFontCache());

/* ── fixtures: pages written the way real producers write ──────────────────── */

/** Latin-1 string of `bytes`: `PDFContext.flateStream` takes text, not bytes. */
function latin1(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/** One `BT … ET` block in a named font, at a baseline, as raw operators. */
function showOps(body: string): string {
  return `BT\n${body}\nET\n`;
}

/**
 * Append `ops` to the page's content as its own stream, written as bytes.
 *
 * The fixtures need to spell operators a producer would write — a `TJ` array
 * whose numbers move the pen, a `Do` of a form — which pdf-lib's own drawing
 * API has no way to emit. Raw bytes through the same `/Contents` array is what
 * a real file looks like, so the engine is tested against content rather than
 * against a simulation of content.
 */
function pageWithOps(doc: PDFDocument, page: PDFPage, ops: string): void {
  const context = doc.context;
  const ref = context.register(PDFRawStream.of(context.obj({}), new TextEncoder().encode(ops)));
  const existing = page.node.get(PDFName.of('Contents'));
  const array = existing instanceof PDFArray ? existing : context.obj([]);
  if (existing !== undefined && !(existing instanceof PDFArray)) array.push(existing as never);
  array.push(ref);
  page.node.set(PDFName.of('Contents'), array);
}

/** Put `/F1` (and any extra faces) in a page's own resources. */
function fontResources(page: PDFPage, fonts: Record<string, unknown>): void {
  const context = page.doc.context;
  const fontDict = context.obj({});
  for (const [name, value] of Object.entries(fonts)) fontDict.set(PDFName.of(name), value as never);
  const resources = context.obj({});
  resources.set(PDFName.of('Font'), fontDict);
  page.node.set(PDFName.of('Resources'), resources);
}

/**
 * A fixture document, page by page.
 *
 * Each page spec is written as operators so a test can put text where a producer
 * would: one `Tj` per line, a `TJ` array that carries two columns, or a form
 * XObject that holds the whole page.
 */
interface PageSpec {
  /** Operator text for the page's own content stream. */
  ops: string;
  /** Font resource name → `/BaseFont` to build a standard-14 face for. */
  fonts?: Record<string, StandardFonts>;
  /** Extra raw font dictionaries by resource name (for a subsubset fixture). */
  rawFonts?: Record<string, (context: PDFPage['doc']['context']) => PDFDict>;
  /** Extra `/FontFile2` bytes for the raw faces, keyed by resource name. */
  rawFontFiles?: Record<string, Uint8Array>;
  rotation?: number;
}

async function fixtureDoc(pages: PageSpec[]) {
  const built = await PDFDocument.create();
  const doc = await build(built, pages);
  // Round-tripped through bytes: `doc.embedFont` only registers its dictionary at
  // save, and a fixture that edits an unsaved document has no font object to
  // find — which is exactly the thing these tests are about.
  return openPDF(await doc.save({ useObjectStreams: false }));
}

async function build(doc: PDFDocument, pages: PageSpec[]) {
  for (const spec of pages) {
    const page = doc.addPage([A4[0], A4[1]]);
    if (spec.rotation) page.setRotation({ angle: spec.rotation, axis: 'y' } as never);
    const fonts: Record<string, unknown> = {};
    for (const [name, face] of Object.entries(spec.fonts ?? {})) {
      const embedded = await doc.embedFont(face);
      // pdf-lib keeps the embedder private; the font dictionary it registers is
      // what the page's resources must name.
      const ref = (embedded as unknown as { ref: PDFRef }).ref;
      fonts[name] = ref;
    }
    for (const [name, make] of Object.entries(spec.rawFonts ?? {})) {
      fonts[name] = doc.context.register(make(doc.context));
    }
    fontResources(page, fonts);
    if (spec.ops.trim().length > 0) pageWithOps(doc, page, spec.ops);
  }
  return doc;
}


/**
 * A `/Type1` font dictionary that is a **subsubset**: only the listed codes have
 * a width, the rest are 0 — how a producer says "this file has no such glyph".
 *
 * `options.fontFile` is the bytes of a real font program. Reuse needs proof that
 * the program has the glyph: a code with a width is not proof on its own, so the
 * embedded file is read — and a program that cannot be read at all means the
 * face is not reused, rather than guessed at.
 */
function subsetFont(
  context: PDFPage['doc']['context'],
  base: string,
  codes: number[],
  options: { fontFile?: Uint8Array } = {},
): PDFDict {
  const dict = context.obj({});
  const first = 32;
  const last = 255;
  const widths = context.obj([]);
  for (let code = first; code <= last; code += 1) widths.push(PDFNumber.of(codes.includes(code) ? 600 : 0));
  const descriptor = context.obj({});
  descriptor.set(PDFName.of('Type'), PDFName.of('FontDescriptor'));
  descriptor.set(PDFName.of('FontName'), PDFName.of(base));
  descriptor.set(PDFName.of('Flags'), PDFNumber.of(32));
  descriptor.set(PDFName.of('FontBBox'), context.obj([-100, -100, 900, 900]));
  descriptor.set(PDFName.of('Ascent'), PDFNumber.of(720));
  descriptor.set(PDFName.of('Descent'), PDFNumber.of(-210));
  descriptor.set(PDFName.of('ItalicAngle'), PDFNumber.of(0));
  descriptor.set(PDFName.of('StemV'), PDFNumber.of(88));
  const file = options.fontFile;
  if (file) {
    const stream = context.flateStream(latin1(file), {});
    descriptor.set(PDFName.of('FontFile2'), stream);
    stream.dict.set(PDFName.of('Length1'), PDFNumber.of(file.length));
  }
  const descriptorRef = context.register(descriptor);
  dict.set(PDFName.of('Type'), PDFName.of('Font'));
  dict.set(PDFName.of('Subtype'), PDFName.of('Type1'));
  dict.set(PDFName.of('BaseFont'), PDFName.of(base));
  dict.set(PDFName.of('FirstChar'), PDFNumber.of(first));
  dict.set(PDFName.of('LastChar'), PDFNumber.of(last));
  dict.set(PDFName.of('Widths'), widths);
  dict.set(PDFName.of('Encoding'), PDFName.of('WinAnsiEncoding'));
  dict.set(PDFName.of('FontDescriptor'), descriptorRef);
  return dict;
}

/** Wrap `ops` in a Form XObject and draw it on `page` — Word, Distiller, dvips. */
async function wrapInForm(
  doc: PDFDocument,
  page: PDFPage,
  name: string,
  ops: string,
  options: { matrix?: number[]; nested?: boolean } = {},
): Promise<void> {
  const context = doc.context;
  const formDict = context.obj({});
  const inner = PDFRawStream.of(formDict, new TextEncoder().encode(ops));
  formDict.set(PDFName.of('Type'), PDFName.of('XObject'));
  formDict.set(PDFName.of('Subtype'), PDFName.of('Form'));
  formDict.set(PDFName.of('BBox'), context.obj([0, 0, A4[0], A4[1]]));
  if (options.matrix) formDict.set(PDFName.of('Matrix'), context.obj(options.matrix));
  // The form carries the page's own fonts: a walker that resolves names against
  // the page instead of the form's resources is a bug waiting for this file.
  formDict.set(PDFName.of('Resources'), page.node.get(PDFName.of('Resources')) ?? context.obj({}));
  const innerRef = context.register(inner);
  let targetRef = innerRef;
  if (options.nested) {
    const outerDict = context.obj({});
    const outer = PDFRawStream.of(outerDict, new TextEncoder().encode(`q /In Do Q\n`));
    outerDict.set(PDFName.of('Type'), PDFName.of('XObject'));
    outerDict.set(PDFName.of('Subtype'), PDFName.of('Form'));
    outerDict.set(PDFName.of('BBox'), context.obj([0, 0, A4[0], A4[1]]));
    const outerResources = context.obj({});
    const outerXObjects = context.obj({});
    outerXObjects.set(PDFName.of('In'), innerRef);
    outerResources.set(PDFName.of('XObject'), outerXObjects);
    outerDict.set(PDFName.of('Resources'), outerResources);
    targetRef = context.register(outer);
  }
  const resources = (context.lookup(page.node.get(PDFName.of('Resources'))) as PDFDict) ?? context.obj({});
  const xobjects = (context.lookup(resources.get(PDFName.of('XObject'))) as PDFDict) ?? context.obj({});
  xobjects.set(PDFName.of(name), targetRef);
  if (!resources.has(PDFName.of('XObject'))) resources.set(PDFName.of('XObject'), xobjects);
  if (!page.node.has(PDFName.of('Resources'))) page.node.set(PDFName.of('Resources'), resources);
  pageWithOps(doc, page, `q 1 0 0 1 0 0 cm /${name} Do Q\n`);
}

/* ── geometry helpers shared by the tests ──────────────────────────────────── */

function box(x: number, y: number, width: number, height: number): TopLeftBox {
  return { x, y, width, height };
}

function paragraph(text: string, lines: TopLeftBox[], size = 12): ExtractedParagraph {
  return {
    id: `p-${text.slice(0, 6)}`,
    page: 1,
    text,
    lines: lines.map((b, index) => ({
      text,
      box: b,
      size,
      start: 0,
      end: text.length,
      items: [],
    })),
    box: lines.reduce((acc, b) => ({
      x: Math.min(acc.x, b.x),
      y: Math.min(acc.y, b.y),
      width: Math.max(acc.x + acc.width, b.x + b.width) - Math.min(acc.x, b.x),
      height: Math.max(acc.y + acc.height, b.y + b.height) - Math.min(acc.y, b.y),
    }), lines[0]),
    size,
    invisible: false,
    direction: 'ltr',
  };
}

/** Viewer-space box → user-space rect, the mapping the editor deletes in. */
function userRect(page: PDFPage, target: TopLeftBox) {
  return viewerBoxToUserSpace(target, frameOfPage(page));
}

function pageBox(page: PDFPage, target: TopLeftBox) {
  const m = viewerToUserMatrix(frameOfPage(page));
  const corners = [
    applyMatrix(m, { x: target.x, y: target.y }),
    applyMatrix(m, { x: target.x + target.width, y: target.y }),
    applyMatrix(m, { x: target.x, y: target.y + target.height }),
    applyMatrix(m, { x: target.x + target.width, y: target.y + target.height }),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

/* ══════════════════════════════════════════════════════════════════════════
 * CAUSE 1 — the numbers in a `TJ` array move the pen
 * ════════════════════════════════════════════════════════════════════════ */

describe('a TJ array is measured where it is painted', () => {
  /**
   * The Distiller shape: one operator, two columns, the gap spelled as a kern
   * number. `[(left) -3600 (right)] TJ` at 12 pt moves the pen 43.2 pt before
   * `right`, so the two strings sit half a page apart — and a box aimed at the
   * right one has to know that.
   */
  it('puts the second string of a kerned array where the number says', async () => {
    const doc = await fixtureDoc([
      {
        fonts: { F1: StandardFonts.Helvetica },
        ops: showOps('/F1 12 Tf\n50 700 Td\n[(left) -3600 (right)] TJ\n'),
      },
    ]);
    const runs = textInRects(doc.getPages()[0], [{ x: 0, y: 0, width: A4[0], height: A4[1] }]);
    const byText = new Map(runs.map((run) => [run.text, run.rect]));
    const left = byText.get('left');
    const right = byText.get('right');
    expect(left).toBeDefined();
    expect(right).toBeDefined();
    // 3600/1000 × 12 pt = 43.2 pt of pen move, on top of `left`'s own advance.
    expect(right!.x).toBeGreaterThan(left!.x + left!.width + 30);
  });

  it('deletes one column of a kerned run without touching the other', async () => {
    const doc = await fixtureDoc([
      {
        fonts: { F1: StandardFonts.Helvetica },
        ops: showOps('/F1 12 Tf\n50 700 Td\n[(leftcol) -3600 (rightcol)] TJ\n'),
      },
    ]);
    const page = doc.getPages()[0];
    const runs = textInRects(page, [{ x: 0, y: 0, width: A4[0], height: A4[1] }]);
    const right = runs.find((run) => run.text === 'rightcol')!;
    const outcome = removeTextInRects(page, [right.rect]);
    expect(outcome.removedGlyphRuns).toBe(1);
    expect(outcome.leftover).toBe(0);
    // The neighbour keeps its characters *and* its place: `pen` is what the
    // rebuilt array's numbers have to restore.
    const after = textInRects(page, [{ x: 0, y: 0, width: A4[0], height: A4[1] }]);
    expect(after.map((run) => run.text).join('')).toBe('leftcol');
    const survivor = textRects(page).find((run) => run.text === 'leftcol')!;
    const before = runs.find((run) => run.text === 'leftcol')!;
    expect(Math.abs(survivor.rect.x - before.rect.x)).toBeLessThan(0.5);
    expect(Math.abs(survivor.rect.width - before.rect.width)).toBeLessThan(0.5);
  });

  it('keeps the text after a kerned run on the same line where it was', async () => {
    // A trailing number moves the pen for the next run; dropping it would slide
    // that run back over the words the edit deleted.
    const doc = await fixtureDoc([
      {
        fonts: { F1: StandardFonts.Helvetica },
        ops: showOps('/F1 12 Tf\n50 700 Td\n[(gone) -2400 ] TJ\n/T1 12 Tf\n'),
      },
    ]);
    const page = doc.getPages()[0];
    const before = textRects(page)[0];
    const outcome = removeTextInRects(page, [before.rect]);
    expect(outcome.leftover).toBe(0);
    expect(textRects(page)).toHaveLength(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * CAUSE 2 — text drawn inside a Form XObject
 * ════════════════════════════════════════════════════════════════════════ */

describe('text inside a Form XObject is real text the engine can reach', () => {
  const BODY = showOps('/F1 12 Tf\n50 700 Td\n(Report title) Tj\n');

  it('is seen by the page walk at all', async () => {
    const doc = await fixtureDoc([{ fonts: { F1: StandardFonts.Helvetica }, ops: '' }]);
    const page = doc.getPages()[0];
    await wrapInForm(doc, page, 'Fx0', BODY);
    const found = textInRects(page, [{ x: 0, y: 0, width: A4[0], height: A4[1] }]);
    expect(found.map((run) => run.text)).toContain('Report title');
  });

  it('is deleted, and the file stops carrying the words', async () => {
    const doc = await fixtureDoc([{ fonts: { F1: StandardFonts.Helvetica }, ops: '' }]);
    const page = doc.getPages()[0];
    await wrapInForm(doc, page, 'Fx0', BODY);
    const target = textInRects(page, [{ x: 0, y: 0, width: A4[0], height: A4[1] }])[0];
    const outcome = removeTextInRects(page, [target.rect]);
    expect(outcome.removedGlyphRuns).toBeGreaterThan(0);
    expect(outcome.leftover).toBe(0);
    expect(outcome.reasons).not.toContain('nothing-at-rect');
    const saved = await doc.save({ useObjectStreams: false });
    const again = await openPDF(saved);
    expect(
      textInRects(again.getPages()[0], [{ x: 0, y: 0, width: A4[0], height: A4[1] }]).map((r) => r.text).join(''),
    ).toBe('');
  });

  it('is placed by the form’s own Matrix, not by the page origin', async () => {
    const doc = await fixtureDoc([{ fonts: { F1: StandardFonts.Helvetica }, ops: '' }]);
    const page = doc.getPages()[0];
    await wrapInForm(doc, page, 'Fx0', BODY, { matrix: [1, 0, 0, 1, 120, 0] });
    const shifted = textInRects(page, [{ x: 0, y: 0, width: A4[0], height: A4[1] }])[0];
    const plain = await fixtureDoc([{ fonts: { F1: StandardFonts.Helvetica }, ops: '' }]);
    await wrapInForm(plain, plain.getPages()[0], 'Fx0', BODY);
    const unshifted = textInRects(plain.getPages()[0], [{ x: 0, y: 0, width: A4[0], height: A4[1] }])[0];
    expect(Math.abs(shifted.rect.x - (unshifted.rect.x + 120))).toBeLessThan(0.5);
  });

  it('is reachable through a nested form', async () => {
    const doc = await fixtureDoc([{ fonts: { F1: StandardFonts.Helvetica }, ops: '' }]);
    const page = doc.getPages()[0];
    await wrapInForm(doc, page, 'Fx0', BODY, { nested: true });
    expect(textInRects(page, [{ x: 0, y: 0, width: A4[0], height: A4[1] }]).map((r) => r.text)).toContain('Report title');
    const outcome = removeTextInRects(page, [userRect(page, box(40, 120, 200, 30))]);
    expect(outcome.removedGlyphRuns).toBeGreaterThan(0);
  });

  it('copies a form another page shares instead of editing that page too', async () => {
    const doc = await fixtureDoc([
      { fonts: { F1: StandardFonts.Helvetica }, ops: '' },
      { fonts: { F1: StandardFonts.Helvetica }, ops: '' },
    ]);
    const [first, second] = doc.getPages();
    await wrapInForm(doc, first, 'Fx0', BODY);
    // The same XObject, reached from page 2 as well: rewriting it in place would
    // silently delete page 2's title.
    const sharedRef = (() => {
      const resources = doc.context.lookup(first.node.get(PDFName.of('Resources'))) as PDFDict;
      const xobjects = doc.context.lookup(resources.get(PDFName.of('XObject'))) as PDFDict;
      return xobjects.get(PDFName.of('Fx0'));
    })();
    const secondResources = (doc.context.lookup(second.node.get(PDFName.of('Resources'))) as PDFDict) ?? doc.context.obj({});
    const secondXObjects = (doc.context.lookup(secondResources.get(PDFName.of('XObject'))) as PDFDict) ?? doc.context.obj({});
    secondXObjects.set(PDFName.of('Fx0'), sharedRef as never);
    secondResources.set(PDFName.of('XObject'), secondXObjects);
    second.node.set(PDFName.of('Resources'), secondResources);
    pageWithOps(doc, second, `q 1 0 0 1 0 0 cm /Fx0 Do Q\n`);

    expect(textRects(second).map((r) => r.text)).toContain('Report title');
    const outcome = removeTextInRects(first, [userRect(first, box(40, 120, 200, 30))]);
    expect(outcome.formsRewritten).toBe(1);
    expect(textRects(first).map((r) => r.text).join('')).not.toContain('Report title');
    expect(textRects(second).map((r) => r.text)).toContain('Report title');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * CAUSE 3 — glyph boxes are attributed by baseline, not by an em box
 * ════════════════════════════════════════════════════════════════════════ */

describe('a deletion box takes the line it names, not the one above it', () => {
  it('leaves the heading over a body line alone', async () => {
    const doc = await fixtureDoc([
      {
        fonts: { F1: StandardFonts.Helvetica, F2: StandardFonts.HelveticaBold },
        // Two text objects, because `Td` moves the pen **relative** to the line
        // matrix: an absolute second baseline needs a `Tm` or a fresh `BT`.
        ops: `${showOps('/F2 24 Tf\n50 760 Td\n(Heading) Tj\n')}${showOps('/F1 10 Tf\n50 736 Td\n(body text here) Tj\n')}`,
      },
    ]);
    const page = doc.getPages()[0];
    const body = textInRects(page, [pageBox(page, box(45, 89, 300, 17))]);
    expect(body.map((run) => run.text).join(' ')).toContain('body text here');
    const outcome = removeTextInRects(page, body.map((run) => run.rect));
    const left = textRects(page).map((run) => run.text).join(' ');
    expect(left).toContain('Heading');
    expect(left).not.toContain('body');
    expect(outcome.leftover).toBe(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * CAUSE 4 — the document's own font is kept, or the swap is reported
 * ════════════════════════════════════════════════════════════════════════ */

describe('font retention', () => {
  it('offers the face the page really used', async () => {
    const doc = await fixtureDoc([
      {
        fonts: { F1: StandardFonts.Courier },
        ops: showOps('/F1 12 Tf\n50 700 Td\n(monospace words) Tj\n'),
      },
    ]);
    const faces = pageTextFaces(doc.getPages()[0]);
    expect(faces.map((face) => face.baseFont)).toContain('Courier');
  });

  it('writes the replacement in that face, and says it did', async () => {
    const doc = await fixtureDoc([
      {
        fonts: { F1: StandardFonts.Courier },
        ops: showOps('/F1 12 Tf\n50 700 Td\n(plain words here) Tj\n'),
      },
    ]);
    const page = doc.getPages()[0];
    const target = box(45, 128, 120, 14);
    const object = editedObject('b1', [target], 'plain words here', 'fixed words here');
    const outcome = await applyEdits(doc, [object]);
    expect(outcome.failed).toEqual([]);
    expect(outcome.substituted).toEqual([]);
    expect(outcome.placed.every((piece) => piece.fromSource)).toBe(true);
    expect(outcome.placed.map((piece) => piece.face)).toContain('Courier');
    const saved = await doc.save({ useObjectStreams: false });
    const again = await openPDF(saved);
    const names = (again.getPages()[0].node.Resources() as PDFDict)
      .lookupMaybe(PDFName.of('Font'), PDFDict)!
      .entries()
      .map(([, ref]) => (again.context.lookup(ref) as PDFDict).lookupMaybe(PDFName.of('BaseFont'), PDFName)?.asString());
    // The rewrite is drawn through the page's own Courier, and no Noto face
    // slipped into the file to do it.
    expect(names.filter((n) => n === '/Courier').length).toBeGreaterThan(0);
    expect(names.some((n) => /Noto/i.test(n ?? ''))).toBe(false);
  });

  it('refuses a subsubset that lacks the typed characters, and names them', async () => {
    const doc = await fixtureDoc([
      {
        ops: showOps('/F1 12 Tf\n50 700 Td\n(aaaa bbbb) Tj\n'),
        rawFonts: {
          // A producer that subsetted to `a`, `b` and space, with a real font
          // program behind it: every other code has width 0 *and* no glyph, which
          // is the file's own evidence that it cannot draw the new text.
          F1: (context) => subsetFont(context, 'AAAAAA+Narrow', [0x20, 0x61, 0x62], { fontFile: NOTO }),
        },
      },
    ]);
    const page = doc.getPages()[0];
    const faces = pageTextFaces(page);
    expect(faces).toHaveLength(1);
    expect(faces[0].missingFor('fixed words')).toEqual(expect.arrayContaining(['f', 'i', 'x']));
    const choice = await chooseFace(doc, { ...DEFAULT_STYLE, size: 12 }, 'fixed words', faces);
    expect(choice.face.fromSource).toBe(false);
    expect(choice.substitution?.reason.kind).toBe('missing');
    expect((choice.substitution?.reason as { characters: string }).characters).toContain('f');
  });

  it('refuses a face whose embedded file cannot be read, rather than guessing', async () => {
    const doc = await fixtureDoc([
      {
        ops: showOps('/F1 12 Tf\n50 700 Td\n(aaaa bbbb) Tj\n'),
        rawFonts: {
          // Widths for every code — the width test alone would say "it can draw
          // anything" — over a program the reader cannot interpret. Coverage is
          // unprovable there, and unprovable means it is not reused: painting
          // .notdef and calling it the document's font is the report this row is
          // here to stop.
          F1: (context) =>
            subsetFont(context, 'BBBBBB+Narrow', Array.from({ length: 224 }, (_, i) => i + 32), {
              fontFile: new TextEncoder().encode('not a font at all'),
            }),
        },
      },
    ]);
    const faces = pageTextFaces(doc.getPages()[0]);
    // The width table would have allowed it; the unreadable file is why not.
    expect(faces[0].widthOf(0x7a)).toBe(600);
    expect(faces[0].missingFor('zzz')).toEqual(['z', 'z', 'z']);
  });

  it('will not fake a weight the face does not carry', async () => {
    const doc = await fixtureDoc([
      {
        fonts: { F1: StandardFonts.Helvetica },
        ops: showOps('/F1 12 Tf\n50 700 Td\n(plain words here) Tj\n'),
      },
    ]);
    const faces = pageTextFaces(doc.getPages()[0]);
    const choice = await chooseFace(doc, { ...DEFAULT_STYLE, size: 12, bold: true }, 'plain words here', faces);
    expect(choice.face.fromSource).toBe(false);
    expect(choice.substitution?.reason).toEqual({ kind: 'bold' });
  });

  it('honours a family the user picked over the page’s own face', async () => {
    const doc = await fixtureDoc([
      {
        fonts: { F1: StandardFonts.Courier },
        ops: showOps('/F1 12 Tf\n50 700 Td\n(plain words here) Tj\n'),
      },
    ]);
    const faces = pageTextFaces(doc.getPages()[0]);
    const choice = await chooseFace(
      doc,
      { ...DEFAULT_STYLE, size: 12, fontFamily: 'std:times' },
      'plain words here',
      faces,
    );
    expect(choice.face.fromSource).toBe(false);
    expect(choice.face.label).toContain('times');
    // No substitution is reported: this is what the user asked for, not a swap.
    expect(choice.substitution).toBeUndefined();
  });

  it('measures a block in the face it will really be written in', async () => {
    // The subsubset cannot spell the new text, so the block goes to Noto; the
    // layout the user saw and the bytes the file gets have to agree on widths.
    const doc = await fixtureDoc([
      {
        ops: showOps('/F1 12 Tf\n50 700 Td\n(aaaa bbbb) Tj\n'),
        rawFonts: {
          F1: (context) => subsetFont(context, 'CCCCCC+Narrow', [0x20, 0x61, 0x62], { fontFile: NOTO }),
        },
      },
    ]);
    const target = box(45, 128, 90, 14);
    const object = editedObject('b2', [target], 'aaaa bbbb', 'wide replacement text that will not fit');
    const outcome = await applyEdits(doc, [object]);
    expect(outcome.substituted.length).toBeGreaterThan(0);
    expect(outcome.reflowed).toContain(object.id);
    const report = exportReport(outcome, [object], {});
    expect(report.warnings.join(' ')).toMatch(/no longer fit/i);
    expect(report.warnings.join(' ')).toMatch(/could not be kept/i);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * The report, and the patch that is left when deletion cannot happen
 * ════════════════════════════════════════════════════════════════════════ */

describe('honest results', () => {
  it('covers only the surviving glyphs, never the whole block box', async () => {
    const doc = await fixtureDoc([
      {
        fonts: { F1: StandardFonts.Helvetica },
        ops: showOps('/F1 12 Tf\n50 700 Td\n[(gone away) -3600 (kept here)] TJ\n'),
      },
    ]);
    const page = doc.getPages()[0];
    const report = deleteOriginalText(page, [{ id: 'x', boxes: [box(45, 128, 400, 14)] }], frameOfPage(page));
    // Everything inside the box went, so nothing needs covering: a patch over
    // air is the failure mode this row was handed over with.
    expect(report.leftoverRects['x'] ?? []).toEqual([]);
    expect(report.removed).toBeGreaterThan(0);
  });

  it('names the cause when a block’s words cannot be deleted at all', async () => {
    const doc = await fixtureDoc([
      {
        fonts: { F1: StandardFonts.Helvetica },
        ops: showOps('/F1 12 Tf\n50 700 Td\n(somewhere else) Tj\n'),
      },
    ]);
    const page = doc.getPages()[0];
    const report = deleteOriginalText(page, [{ id: 'x', boxes: [box(400, 400, 60, 12)] }], frameOfPage(page));
    expect(report.nothingRemoved).toBe(true);
    expect(report.reasons).toContain('nothing-at-rect');
    const object = editedObject('x', [box(400, 400, 60, 12)], 'somewhere else', 'replacement');
    const outcome = await applyEdits(doc, [object]);
    expect(outcome.failed.map((entry) => entry.id)).toContain('x');
    const lines = exportReport(outcome, [object], {}).warnings.join(' ');
    expect(lines).toMatch(/no text was found in the page content/i);
    expect(lines).toMatch(/original words stay/i);
  });

  it('reports the image behind a block as an image, not as how the text was spelled', async () => {
    const doc = await fixtureDoc([
      {
        fonts: { F1: StandardFonts.Helvetica },
        ops: showOps('/F1 12 Tf\n50 700 Td\n[(kerned) -200 (words) -200 (here)] TJ\n'),
      },
    ]);
    const page = doc.getPages()[0];
    const target = userRect(page, box(45, 128, 200, 14));
    const outcome = removeTextInRects(page, [target]);
    // Kerned text used to be read as "needs a raster fallback" on its own — the
    // claim was invented. Without an image on the page there is nothing to sit on.
    expect(outcome.needsRasterFallback).toBe(false);
    expect(outcome.reasons).not.toContain('image-behind');
  });

  it('says covered is covered, in the result the user reads', () => {
    const object = editedObject('b9', [box(40, 100, 120, 14)], 'words', 'new words');
    const report = exportReport(
      {
        written: 1,
        failed: [],
        partial: [{ id: 'b9', leftover: 2 }],
        raster: [],
        covered: [{ id: 'b9', boxes: [box(50, 102, 30, 11), box(84, 102, 26, 11)], color: '#f2efe6' }],
        substituted: [],
        reflowed: [],
        placed: [],
      },
      [object],
      {},
    );
    const lines = report.warnings.join(' ');
    expect(lines).toMatch(/2 words could not be deleted/i);
    expect(lines).toMatch(/hidden, not removed/i);
  });
});

/* ── the editor's own object, as `openBlock` builds it ─────────────────────── */

function editedObject(id: string, deletion: TopLeftBox[], original: string, replacement: string): TextObject {
  const source = paragraph(original, deletion);
  const boxes = deletionBoxes(source);
  return {
    id,
    page: 1,
    kind: 'text',
    box: boxes[0],
    rotation: 0,
    flipH: false,
    flipV: false,
    z: 0,
    alt: '',
    state: 'queued',
    paragraphs: paragraphsFromText(replacement),
    style: { ...DEFAULT_STYLE, size: 12, color: '#000000' },
    deletion: boxes,
    paperColor: '#ffffff',
    sourceId: source.id,
    fromInvisibleLayer: false,
  };
}
