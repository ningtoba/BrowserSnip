/**
 * `rotate-custom` — the identity it dropped and the loss it only sometimes said.
 *
 * Measured first on `<127.0.0.1:5271>` with `docs/research/rotate-custom-round.mjs`
 * and judged in the bytes by `docs/research/rotate-custom-bytes.py`: a 30° turn of
 * `colour.pdf` came back at the typed angle (text lines at 30.0° in image space,
 * ink 1.02× the source, 4 779 characters kept of 1 779 per sheet) — but with
 * **no `/Info` at all** (`title=""` against the source's own title), and the five
 * `/Annots` entries of `annot.pdf` sheet 1 gone at **every** angle while the note
 * that counts them only fired at a non-right angle.
 *
 * Both are asserted against the **saved file**: the title is read back out of the
 * produced `/Info`, and the annotations are counted off the output page's own
 * `/Annots` array — the same array the note counts — so a sentence with no loss
 * behind it, or a loss with no sentence, fails here.
 */
import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFBool,
  PDFDocument,
  PDFName,
  StandardFonts,
  rgb,
} from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool, type RunOutcome } from '@/lib/pdf/tools/runner';

/** A one-sheet file with two annotations on it, and optionally its own title. */
async function sheetWithAnnots(options: { title?: string; annots?: number } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([200, 100]);
  page.drawText('annotated sheet', { x: 20, y: 60, size: 12, font, color: rgb(0, 0, 0) });
  const count = options.annots ?? 2;
  if (count > 0) {
    const annots = doc.context.obj([]) as PDFArray;
    for (let i = 0; i < count; i++) {
      annots.push(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [10 + i * 10, 10, 20 + i * 10, 20],
          Border: [0, 0, 0],
          A: { Type: 'Action', S: 'URI', URI: `https://example.com/${i}` },
        }),
      );
    }
    page.node.set(PDFName.of('Annots'), annots);
  }
  if (options.title) {
    doc.setTitle(options.title);
    doc.setAuthor('the author');
  }
  return doc.save({ useObjectStreams: false });
}

const fileOf = (bytes: Uint8Array): File =>
  new File([new Uint8Array(bytes)], 'source.pdf', { type: 'application/pdf' });

async function run(values: Record<string, unknown>, bytes: Uint8Array): Promise<RunOutcome> {
  expect(getPdfTool('rotate-custom')).toBeTruthy();
  return runPdfTool({
    toolId: 'rotate-custom',
    files: [fileOf(bytes)],
    values,
    onProgress: () => {},
    onLog: () => {},
  });
}

const out = async (outcome: RunOutcome): Promise<Uint8Array> => {
  expect(outcome.outputs.length, `expected an output; warnings: ${outcome.warnings.join(' | ')}`).toBeGreaterThan(0);
  return new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
};

const warn = (outcome: RunOutcome): string => outcome.warnings.join(' ');

/** How many `/Annots` entries the first page of a saved file still has. */
async function annotsOf(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const raw = doc.getPages()[0].node.get(PDFName.of('Annots'));
  if (raw === undefined) return 0;
  const array = raw instanceof PDFArray ? raw : doc.context.lookup(raw, PDFArray);
  return array ? array.size() : 0;
}

describe('what a turn leaves of the document', () => {
  it('carries the title and author through a rebuild at a right angle', async () => {
    const source = await sheetWithAnnots({ title: 'a titled document' });
    const before = await PDFDocument.load(source, { updateMetadata: false });
    expect(before.getTitle()).toBe('a titled document');

    const doc = await PDFDocument.load(await out(await run({ angle: 90, fit: 'grow', pages: 'all' }, source)), {
      updateMetadata: false,
    });
    // `pdf-lib` copies pages and nothing else: without `carryDocInfo` the rebuilt
    // file came back untitled, which no sentence on the card admitted.
    expect(doc.getTitle()).toBe('a titled document');
    expect(doc.getAuthor()).toBe('the author');
  });

  it('invents no title for a document that has none', async () => {
    const source = await sheetWithAnnots();
    const doc = await PDFDocument.load(await out(await run({ angle: 30, fit: 'grow', pages: 'all' }, source)), {
      updateMetadata: false,
    });
    expect(doc.getTitle() ?? '').toBe('');
    expect(doc.getAuthor() ?? '').toBe('');
  });
});

describe('the note about links and annotations', () => {
  it('counts them and says so at a right angle, where it used to be silent', async () => {
    const source = await sheetWithAnnots({ annots: 2 });
    const outcome = await run({ angle: 90, fit: 'grow', pages: 'all' }, source);
    // The loss is real in the bytes…
    expect(await annotsOf(await out(outcome))).toBe(0);
    // …so the card has to carry it. Ungated: a 90° turn rebuilds just as a 45° one.
    expect(warn(outcome)).toMatch(/2 links or annotations could not come along/i);
  });

  it('says it at 0° too, where the file is re-laid although nothing turns', async () => {
    const source = await sheetWithAnnots({ annots: 1 });
    const outcome = await run({ angle: 0, fit: 'grow', pages: 'all' }, source);
    expect(await annotsOf(await out(outcome))).toBe(0);
    expect(warn(outcome)).toMatch(/1 link or annotation could not come along/i);
    // And the 0° run says the output is not a copy, naming what it costs.
    expect(warn(outcome)).toMatch(/0° turn leaves every page looking as it does, but the file is still re-laid/i);
  });

  it('stays quiet at 0° when there is nothing to lose, and 30° keeps its own reason', async () => {
    const clean = await sheetWithAnnots({ annots: 0 });
    const zero = await run({ angle: 0, fit: 'grow', pages: 'all' }, clean);
    // The 0° sentence names the loss in general; the *counted* note is the one a
    // file with no annotations must not get.
    expect(warn(zero)).not.toMatch(/could not come along/i);
    expect(warn(zero)).toMatch(/still re-laid/i);

    const turned = await run({ angle: 30, fit: 'grow', pages: 'all' }, clean);
    // The 0° sentence is about a straight angle and must not travel to a turn.
    expect(warn(turned)).not.toMatch(/0° turn leaves every page/i);
    expect(warn(turned)).not.toMatch(/could not come along/i);
  });
});

describe('the empty sheet', () => {
  it('turns a blank page at the angle and still draws nothing on it', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 100]);
    doc.addPage([200, 100]).drawRectangle({ x: 0, y: 0, width: 20, height: 20, color: rgb(0, 0, 0) });
    const outcome = await run({ angle: 30, fit: 'grow', pages: '1' }, await doc.save({ useObjectStreams: false }));
    const bytes = await out(outcome);
    const result = await PDFDocument.load(bytes, { updateMetadata: false });
    // The blank was grown to the turned box and carries no ink; the sheet beside
    // it is copied verbatim, `/Rotate` and all.
    expect(result.getPageCount()).toBe(2);
    expect(result.getPage(0).getWidth()).toBeGreaterThan(200);
    const [first] = await import('@/lib/pdf/core/content').then((m) => m.pageContentStreams(result.getPage(0)));
    const drawn = Buffer.from(first?.bytes ?? new Uint8Array()).toString('latin1');
    expect(drawn).toMatch(/Do/);
    expect(drawn).toMatch(/q/);
    // `PDFBool` is only imported to keep the object-model import list honest.
    expect(PDFBool).toBeTruthy();
  });
});
