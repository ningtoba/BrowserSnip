/**
 * `redact-pdf` — a redaction must say what it did to the letters and to the pixels.
 *
 * Measured live on the chunk-2 build (`docs/research/redact-round.mjs` at :5294 over
 * `docs/research/redact-c3-build.py`'s MuPDF-written fixture, judged by
 * `docs/research/redact-c3-measure.py`):
 *
 *  1. A drag across the word `BRAVO` painted a 46 pt bar over a word MuPDF measures
 *     56.1 pt, deleted `RAVO` **plus the first letter of the unmarked neighbour**,
 *     and the card still read “Redacted 1 text run(s) … none of the 1 word(s) that
 *     were under the marks still extracts.” The saved page extracts `ALPHA one B` and
 *     `HARLIE`: a letter of the secret is still in the file inside the black bar, and
 *     a word that was never marked lost a letter. The whole-word survivor comparison
 *     the read-back used could not see either half — `BRAVO` stopped extracting the
 *     moment its last four letters left, and `CHARLIE` was never a candidate because
 *     it was not marked. Both halves are now read off the produced bytes: what still
 *     lies under the bars (`residue`), and what vanished outside them (`collateral`).
 *     The geometry that causes the damage lives in `core/redact.ts` / `core/tables.ts`
 *     and is reported as a blocker, not papered over here.
 *  2. A mark over a bitmap is painted over — the page keeps its image object and no
 *     rasterising happens. The pane promised “this page will be re-rendered”, which
 *     nothing in the redaction path does, so a scanned word was implied to be gone
 *     when it only sits under a fill.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { inflateSync } from 'node:zlib';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFStream, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import { runPdfTool, type RunOutcome } from '@/lib/pdf/tools/runner';
import type { ToolValues } from '@/lib/pdf/tools/types';
import { AREA_MARK_NOTICE } from '@/components/tools/pdf/security/RedactMain';

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
const BASELINE = 700;
const SIZE = 16;
const LINE = 'ALPHA one BRAVO CHARLIE';

/** A 2×2 opaque PNG, so the fixture owns a real image object. */
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGP4zwABUBoAFfoB/5sOvsoAAAAASUVORK5CYII=', 'base64');

async function lineFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(PAGE);
  page.drawText(LINE, { x: 60, y: BASELINE, size: SIZE, font, color: rgb(0, 0, 0) });
  return doc.save({ useObjectStreams: false });
}

/** One sheet: a bitmap block above, a line of vector text below it. */
async function scannedFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(PAGE);
  const png = await doc.embedPng(new Uint8Array(TINY_PNG));
  page.drawImage(png, { x: 60, y: 500, width: 300, height: 120 });
  page.drawText('VECTOR PAPER BELOW', { x: 60, y: 300, size: SIZE, font, color: rgb(0, 0, 0) });
  return doc.save({ useObjectStreams: false });
}

/** The advance widths of the line, so a band can stop mid-word on purpose. */
async function metrics() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const at = (text: string) => font.widthOfTextAtSize(text, SIZE);
  return {
    lead: at('ALPHA one '),
    bravo: at('BRAVO'),
    space: at(' '),
    charlieC: at('C'),
    charlie: at('CHARLIE'),
  };
}

/** A band in the pane's space: displayed points, origin top-left, on page 0. */
function band(x: number, width: number, yTop = PAGE[1] - (BASELINE + SIZE), height = SIZE) {
  return { page: 0, x, y: yTop, width, height };
}

async function run(values: ToolValues, bytes?: Uint8Array): Promise<RunOutcome> {
  const source = bytes ?? await lineFixture();
  const outcome = await runPdfTool({
    toolId: 'redact-pdf',
    files: [new File([new Uint8Array(source) as BlobPart], 'line.pdf', { type: 'application/pdf' })],
    values: { fill: '#000000', alsoMetadata: false, ...values },
    onProgress: () => undefined,
    onLog: () => undefined,
  });
  expect(outcome, 'the run returned nothing').toBeTruthy();
  return outcome!;
}

function decoded(stream: PDFStream): string {
  const raw = stream.getContents();
  try {
    return latin1.decode(inflateSync(raw));
  } catch {
    return latin1.decode(raw);
  }
}

/** Every page stream, inflated: what a text extractor can actually reach. */
async function streams(outcome: RunOutcome): Promise<string> {
  const doc = await loadOf(outcome);
  return doc
    .getPages()
    .map((page) => {
      const contents = page.node.Contents();
      const entries = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
      return entries.map((entry) => {
        const stream = entry instanceof PDFStream ? entry : doc.context.lookupMaybe(entry as never, PDFStream);
        return stream ? decoded(stream) : '';
      }).join('\n');
    })
    .join('\n');
}

async function loadOf(outcome: RunOutcome): Promise<PDFDocument> {
  const bytes = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
  return PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
}

/** A word as pdf-lib writes a run: one hex string, so a deleted letter breaks it. */
function hexOf(text: string): string {
  return Buffer.from(text, 'latin1').toString('hex').toUpperCase();
}

describe('a redaction reports what it did to the letters, not just the words', () => {
  it('names a letter it left standing and a neighbour it ate', async () => {
    const m = await metrics();
    // A band exactly BRAVO’s own advance, at BRAVO’s own origin.
    const outcome = await run({ regions: [band(60 + m.lead, m.bravo)] });
    const text = await streams(outcome);
    const all = [outcome.message ?? '', ...outcome.warnings].join(' ');

    // The bytes: the deletion window is one glyph late. `B` (hex 42) is still in the
    // content — inside the black bar, selectable, copyable — and the `C` (hex 43) of
    // the *unmarked* neighbour is the letter that went instead. `I` (hex 49) occurs
    // only in CHARLIE, so its presence proves the neighbour was eaten, not erased.
    expect(text, 'the first letter of the secret was not deleted').toContain('<42>');
    expect(text, 'the neighbour’s first letter survived').not.toContain('<43>');
    expect(text, 'the neighbour vanished entirely').toContain('<49>');
    expect(text).not.toContain(hexOf('BRAVO'));

    // The report has to say both halves, and must not claim a clean delete.
    expect(all).toMatch(/still sit under the marked areas/i);
    expect(all).toMatch(/outside the marked areas lost text as well/i);
    expect(all).toMatch(/CHARLIE/);
    expect(outcome.message, 'the card still claims nothing under the marks survives')
      .not.toMatch(/none of the \d+ word\(s\) that were under the marks still extracts/);
  });

  it('claims a clean deletion only when the bytes are clean', async () => {
    const m = await metrics();
    // The same band, widened past the neighbour’s first letter: nothing of the line
    // is left, so neither new warning may fire and the success sentence may.
    const outcome = await run({
      regions: [band(60 + m.lead - 6, m.bravo + m.space + m.charlie + 12)],
    });
    const text = await streams(outcome);
    const all = [outcome.message ?? '', ...outcome.warnings].join(' ');
    for (const glyph of ['<42>', '<43>', '<52>', '<4f>', '<49>']) {
      expect(text, `the letter ${glyph} is still in the page`).not.toContain(glyph);
    }
    expect(all).not.toMatch(/outside the marked areas lost text/i);
    expect(all).not.toMatch(/still sit under the marked areas/i);
    expect(outcome.message).toMatch(/none of the \d+ word\(s\) that were under the marks still extracts/);
  });

  it('says an image was painted over, and leaves the image in the file', async () => {
    const source = await scannedFixture();
    const outcome = await run({ regions: [band(60, 300, PAGE[1] - 620, 120)] }, source);
    const all = [outcome.message ?? '', ...outcome.warnings].join(' ');
    const doc = await loadOf(outcome);
    const images: PDFDict[] = [];
    for (const [, object] of doc.context.enumerateIndirectObjects()) {
      if (object instanceof PDFStream
        && object.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() === '/Image') images.push(object.dict);
    }
    // Painted over, not re-rendered: the bitmap is still an image object of the page,
    // and the fill is the only thing added to the content.
    expect(images, 'the page lost its image — something did re-render').toHaveLength(1);
    const text = await streams(outcome);
    expect(text, 'no fill was painted over the marked band').toMatch(/60 500 300 120 re\s*\n?f/);
    expect(text, 'the vector paper was deleted as well').toContain(hexOf('VECTOR PAPER BELOW'));
    expect(all).toMatch(/fell inside an image/i);
    expect(all).toMatch(/painted over rather than cut out/i);
    expect(outcome.message).toMatch(/none of them held text/);
    // The pane’s promise over the same mark, word for word what the bytes do.
    expect(AREA_MARK_NOTICE).toMatch(/painted over/i);
    expect(AREA_MARK_NOTICE, 'the pane still promises a re-render the engine never does')
      .not.toMatch(/re-render/i);
    expect(AREA_MARK_NOTICE).toMatch(/stays in the file as pixels/i);
  });
});
