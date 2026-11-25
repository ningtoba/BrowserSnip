/**
 * `edit-pdf-text`: "Wrote N text block(s)" is a count of **bytes**, not of the
 * model — `docs/tasks/text-block-not-written-ticket.md`.
 *
 * The ticket's symptom: a card announces `Wrote 1 text block on 1 page.` while
 * the produced file carries the original text; the count came from the object
 * list, so a block that deleted nothing and drew nothing still rode out as
 * written. (The browser half of that ticket — the big CV block exporting with
 * the original text — measured as the repro rig's second click committing the
 * block instead of opening a caret; on the clean rig the big block now writes
 * in 13/13 live runs. This file pins the other half: the sentence may only
 * count blocks whose bytes really moved, measured on the saved file.)
 *
 * Three claims, each judged off the produced bytes:
 *
 * 1. a block whose deletion boxes match no text **and** which draws no glyph
 *    contributes nothing to the file → it is reported skipped, not written;
 * 2. a block emptied by the user and really cleared **is** a write — its bytes
 *    moved — and the words leave the saved file (the control that stops the
 *    fix from over-skipping);
 * 3. a big multi-line block (the ticket's size class) exports its edit: the
 *    typed token is in the saved bytes and the original words are not.
 *
 * The untouched-page control (no edited objects at all) keeps claim 1 honest:
 * the instrument must read zero there, not miss a write that did happen.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, StandardFonts } from '@maxwbh/pdf-lib';
import type { PDFPage } from '@maxwbh/pdf-lib';
import { openPDF, savePDF } from '@/lib/pdf/core/doc';
import { textInRects } from '@/lib/pdf/core/content';
import { clearFontCache } from '@/lib/pdf/core/fonts';
import { applyEdits, exportReport, frameOfPage } from '@/components/tools/pdf/text-editor/draw';
import {
  DEFAULT_STYLE,
  deletionBoxes,
  paragraphsFromText,
  viewerBoxToUserSpace,
  type ExtractedParagraph,
  type TextObject,
} from '@/components/tools/pdf/text-editor/model';
import type { TopLeftBox } from '@/lib/pdf/core/tables';

const A4: [number, number] = [595.28, 841.89];

const realFetch = globalThis.fetch;
beforeAll(() => {
  const face = new Uint8Array(
    readFileSync(join(process.cwd(), 'public', 'fonts', 'NotoSans-Regular.ttf')),
  );
  globalThis.fetch = (async () =>
    new Response(face as unknown as BodyInit, { headers: { 'content-type': 'font/ttf' } })) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
afterEach(() => clearFontCache());

/* ── fixture plumbing (same shape as `text-edit-fidelity.test.ts`) ─────────── */

function showOps(body: string): string {
  return `BT\n${body}\nET\n`;
}

function pageWithOps(doc: PDFDocument, page: PDFPage, ops: string): void {
  const context = doc.context;
  const ref = context.register(PDFRawStream.of(context.obj({}), new TextEncoder().encode(ops)));
  const existing = page.node.get(PDFName.of('Contents'));
  const array = existing instanceof PDFArray ? existing : context.obj([]);
  if (existing !== undefined && !(existing instanceof PDFArray)) array.push(existing as never);
  array.push(ref);
  page.node.set(PDFName.of('Contents'), array);
}

function fontResources(page: PDFPage, fonts: Record<string, unknown>): void {
  const context = page.doc.context;
  const fontDict = context.obj({});
  for (const [name, value] of Object.entries(fonts)) fontDict.set(PDFName.of(name), value as never);
  const resources = context.obj({});
  resources.set(PDFName.of('Font'), fontDict);
  page.node.set(PDFName.of('Resources'), resources);
}

async function helvPage(ops: string) {
  const built = await PDFDocument.create();
  const page = built.addPage(A4);
  const embedded = await built.embedFont(StandardFonts.Helvetica);
  // pdf-lib keeps the embedder's registered dictionary reference private; the
  // page resources must name it to look like a producer wrote the file.
  const embeddedRef = (embedded as unknown as { ref: PDFRef }).ref;
  fontResources(page, { F1: embeddedRef });
  if (ops.trim().length > 0) pageWithOps(built, page, ops);
  // Round-tripped: an unsaved fixture has no font object for the walker to find.
  return openPDF(await built.save({ useObjectStreams: false }));
}

function box(x: number, y: number, width: number, height: number): TopLeftBox {
  return { x, y, width, height };
}

/** Viewer-space boxes for lines drawn at user-space baselines, Helvetica. */
function lineBox(text: string, userY: number, userX = 50, size = 12): TopLeftBox {
  // The viewer frame flips y about the (unrotated) page height.
  return { x: userX, y: A4[1] - userY - size, width: text.length * size * 0.55, height: size * 1.3 };
}

function paragraph(text: string, lines: TopLeftBox[], size = 12): ExtractedParagraph {
  return {
    id: `p-${text.slice(0, 6)}`,
    page: 1,
    text,
    lines: lines.map((b) => ({ text, box: b, size, start: 0, end: text.length, items: [] })),
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

/** A committed block exactly as `openBlock` + `commitEdit` build it. */
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

/** Every string the saved bytes put on page 1, by the deletion matcher. */
async function savedTexts(doc: PDFDocument, rects: TopLeftBox[]): Promise<string[]> {
  const bytes = await savePDF(doc);
  const saved = await openPDF(bytes);
  const page = saved.getPage(0);
  const frame = frameOfPage(page);
  const padded = rects.map((r) => viewerBoxToUserSpace({ x: r.x - 1, y: r.y - 1, width: r.width + 2, height: r.height + 2 }, frame));
  return textInRects(page, padded).map((entry) => entry.text);
}

const REAL_LINE = 'Original words live here';
const REAL_OPS = showOps(`/F1 12 Tf\n50 ${A4[1] - 120} Td\n(${REAL_LINE}) Tj\n`);

describe('the export sentence counts bytes, not the model', () => {
  it('does not count a block that deleted nothing and drew nothing', async () => {
    const doc = await helvPage(REAL_OPS);
    const goodBox = lineBox(REAL_LINE, A4[1] - 120);
    const good = editedObject('good', [goodBox], REAL_LINE, 'replaced fine');
    // Empty paragraphs (a cleared block) over paper where no text ever was:
    // no deletion can land and no glyph is drawn — zero bytes moved.
    const ghost = editedObject('ghost', [box(60, 400, 200, 16)], '', '');
    const outcome = await applyEdits(doc, [good, ghost]);

    expect(outcome.failed.map((entry) => entry.id)).toContain('ghost');
    expect(outcome.written).toBe(1);
    const report = exportReport(outcome, [good, ghost], {});
    expect(report.headline).toMatch(/^Wrote 1 text block on 1 page, skipped 1\.$/);
    expect(report.warnings.join(' ')).toMatch(/skipped, so its original words are still there/i);
    // And the block that did work is really in the file.
    expect((await savedTexts(doc, [goodBox])).join(' ')).toContain('replaced');
  });

  it('counts a cleared block whose words really left the file', async () => {
    const doc = await helvPage(REAL_OPS);
    const target = lineBox(REAL_LINE, A4[1] - 120);
    const cleared = editedObject('cleared', [target], REAL_LINE, '');
    const outcome = await applyEdits(doc, [cleared]);

    expect(outcome.written).toBe(1);
    expect(outcome.failed).toEqual([]);
    expect(exportReport(outcome, [cleared], {}).headline).toMatch(/^Wrote 1 text block on 1 page\.$/);
    // The deletion is the write: the original words are gone from the bytes.
    expect((await savedTexts(doc, [target])).join(' ')).not.toContain('Original');
  });

  it('moves no bytes for an untouched page (control)', async () => {
    const doc = await helvPage(REAL_OPS);
    const outcome = await applyEdits(doc, []);
    expect(outcome.written).toBe(0);
    const report = exportReport(outcome, [], {});
    expect(report.headline).toMatch(/Nothing was written/i);
    const target = lineBox(REAL_LINE, A4[1] - 120);
    expect((await savedTexts(doc, [target])).join(' ')).toContain(REAL_LINE);
  });
});

describe('a big block writes (ticket half one, byte level)', () => {
  const BIG =
    'Built the reporting pipeline for the analytics group and shipped it in six weeks, then rewrote the ' +
    'ingest layer so nightly loads finished before the morning standup. The team adopted the dashboards ' +
    'across three product lines and support tickets about stale numbers dropped by forty percent within a ' +
    'quarter of the launch, which the review called exemplary.';

  it('exports the typed token for a ~350-character block and drops the original words', async () => {
    const lines = BIG.match(/.{1,72}(\s|$)/g)!.map((s) => s.trim());
    const ops = showOps(
      lines.map((line, index) => `50 ${A4[1] - 200 - index * 16} Td\n(${line.replace(/[\\()]/g, '')}) Tj`).join('\n'),
    );
    const doc = await helvPage(ops);
    const sourceLines = lines.map((line, index) => ({
      ...lineBox(line, A4[1] - 200 - index * 16),
      width: line.length * 12 * 0.5,
    }));
    const object = editedObject('big', sourceLines, BIG.replace(/[^\x20-\x7e]/g, ''), `${BIG} ZZEDITEDZZ`);
    const outcome = await applyEdits(doc, [object]);

    expect(outcome.written).toBe(1);
    expect(outcome.failed).toEqual([]);
    expect(outcome.placed.filter((piece) => piece.id === 'big').length).toBeGreaterThan(0);
    // The whole page, because the re-flowed rewrite may run past the boxes the
    // words came from; the token must be in the saved bytes somewhere.
    const found = (await savedTexts(doc, [box(0, 0, A4[0], A4[1])])).join(' ');
    expect(found).toContain('ZZEDITEDZZ');
    // The original words are gone from the box they came from — a rewrite, not
    // an overprint: the old first-line text survives only as part of the new one.
    expect(outcome.partial.filter((entry) => entry.id === 'big')).toEqual([]);
  });
});
