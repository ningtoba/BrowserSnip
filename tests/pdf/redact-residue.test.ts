/**
 * `redact-pdf` — a redaction must say what it did to the letters and to the pixels.
 *
 * Measured live on the chunk-2 build (`docs/research/redact-round.mjs` at :5294 over
 * `docs/research/redact-c3-build.py`'s MuPDF-written fixture, judged by
 * `docs/research/redact-c3-measure.py`), and re-measured on the wave-2B build at
 * :5298 with the same pair:
 *
 *  1. A drag across the word `BRAVO` painted a bar over a word MuPDF measures
 *     56.0 pt (148.048 → 204.064), deleted `RAVO`, the space and the **first two
 *     letters of the unmarked neighbour**, and the card still read “Redacted 1
 *     text run(s) … none of the 1 word(s) that were under the marks still
 *     extracts.” The saved page extracted `ALPHA one B` and `ARLIE`: a letter of
 *     the secret still in the file inside the black bar, and a word that was never
 *     marked missing two letters. The cause was in `core/redact.ts`: a base-14
 *     reference — how MuPDF, LibreOffice and this app's own writer all store
 *     Helvetica — carries no `/Widths`, and the glyph window was laid out on the
 *     0.5 em estimate, so every centre sat further from the drawn letter the deeper
 *     in the line it was (the re-written run also displaced by 7 × 0.5 em = 3.5 em of advance
 *     instead of the 4.556 em it actually removed). The module now measures the face with the standard-14
 *     AFM tables `core/content.ts` already builds, which makes the window exact: the
 *     whole of `BRAVO` goes, `CHARLIE` keeps every letter, and the displacement is
 *     `-3501` — 3.501 em, BRAVO's advance to the unit.
 *     The `residue` / `collateral` halves stay on the page for the shapes that are
 *     genuinely lossy: a font no reader knows (`unnamedFontFixture`) still has only
 *     the estimate to go on, and there the card still names the letter it left
 *     standing. Pinning both keeps the clean sentence honest rather than absolute.
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

/**
 * The same line under a face no reader knows.
 *
 * `/Widths`-less text is not one shape but two: a base-14 reference, whose
 * metrics live in the AFM tables every reader (and now this module) carries, and a
 * name that means nothing to anybody, where the only number available is the 0.5 em
 * guess. The first measures exactly; the second still cuts the window one glyph
 * late, and the card has to keep saying so — so the lossy half is pinned here.
 */
async function unnamedFontFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await lineFixture(), { updateMetadata: false, ignoreEncryption: true });
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict
      && object.lookupMaybe(PDFName.of('Subtype'), PDFName)?.asString() === '/Type1') {
      object.set(PDFName.of('BaseFont'), PDFName.of('NotATypeface'));
      object.delete(PDFName.of('Widths'));
    }
  }
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
  it('deletes exactly the word the band covers, to the glyph', async () => {
    const m = await metrics();
    // A band exactly BRAVO’s own advance, at BRAVO’s own origin.
    const outcome = await run({ regions: [band(60 + m.lead, m.bravo)] });
    const text = await streams(outcome);
    const all = [outcome.message ?? '', ...outcome.warnings].join(' ');

    // The bytes: every letter of the marked word is gone, and no other letter is.
    // `B` (hex 42) was the survivor that sat inside the black bar; `C` (43) and `I`
    // (49) belong to the unmarked neighbour, which used to lose its first two
    // letters to a window laid out on estimated advances.
    expect(text, 'the first letter of the secret survived').not.toContain('<42>');
    expect(text, 'the neighbour’s first letter was taken').toContain('<43>');
    expect(text, 'the neighbour was eaten after all').toContain('<49>');
    expect(text).not.toContain(hexOf('BRAVO'));
    // The neighbour spells its word, in order: the deleted gap is one displacement,
    // not a hole in `CHARLIE`. (The rewritten run is one hex cell per glyph, so the
    // contiguous spelling never appears and cannot be the check.)
    expect(text, 'the neighbour stopped spelling CHARLIE')
      .toMatch(/<43>\s*<48>\s*<41>\s*<52>\s*<4c>\s*<49>\s*<45>/);
    // The gap the deleted glyphs occupied is displaced by their real advance —
    // 3.501 em, BRAVO’s width in the face’s own units — so the line does not move.
    expect(text, 'the survivors were displaced by an estimate, not the advance')
      .toContain('<20> -3501 <20>');

    // And the card may now claim what it claims: the whole word is unreadable,
    // nothing else was touched, and neither new warning fires.
    expect(all).not.toMatch(/still sit under the marked areas/i);
    expect(all).not.toMatch(/outside the marked areas lost text/i);
    expect(outcome.message, 'the clean delete was not reported as one')
      .toMatch(/none of the \d+ word\(s\) that were under the marks still extracts/);
  });

  it('still names the letter it left standing when no metrics measure the line', async () => {
    const m = await metrics();
    // The same band over the same word, drawn with a face nothing knows: the only
    // advance available is the 0.5 em guess, so the window lands one glyph late and
    // both halves of the damage are real. This is the shape the residue and
    // collateral sentences exist for — they may not be quietly retired with the fix.
    const outcome = await run({ regions: [band(60 + m.lead, m.bravo)] }, await unnamedFontFixture());
    const text = await streams(outcome);
    const all = [outcome.message ?? '', ...outcome.warnings].join(' ');
    expect(text, 'the estimate no longer misses the first letter').toContain('<42>');
    expect(text, 'the estimate no longer eats the neighbour').not.toContain('<43>');
    expect(all).toMatch(/still sit under the marked areas/i);
    expect(all).toMatch(/outside the marked areas lost text as well/i);
    expect(outcome.message, 'a lossy delete claimed a clean one')
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
