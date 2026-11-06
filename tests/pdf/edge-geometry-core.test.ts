/**
 * Core geometry, version-header and compression-honesty tests
 * (C3: `src/lib/pdf/core/doc.ts`, `src/lib/pdf/core/compress.ts`).
 *
 * The discipline matches `tools-e2e.test.ts` / `edge-organize.test.ts`: real PDF
 * bytes are built here, the primitive runs over them, and the **saved file** is
 * re-opened and measured. Nothing is mocked, so a primitive that reports success
 * while putting content in the wrong rectangle fails.
 *
 * What is under test, and the matrix rows behind it:
 *
 * - `drawPageInto` (B1 request item 1, E8, E9) — it used to embed the raw page
 *   and scale it by `getWidth()/getHeight()`: pre-rotation MediaBox numbers, no
 *   `/Rotate`, no box origin, and one size assumed for every sheet. The
 *   assertions read the composed `/Matrix ∘ CTM` chain out of the output, which
 *   is the only place the truth lives: a stamp that ignores `/Rotate` fits a
 *   200 × 100 `/Rotate 90` sheet into a 100 × 200 cell as a 100 × 50 band.
 * - `setPdfVersion` / `applyPdfVersion` (B2 request item 1) — a tool that writes
 *   PDF 1.5 structures has to be able to raise the header it invalidates.
 * - `CompressReport.rebuildBytes` (B2 request item 2, E14) — when the rebuild
 *   loses to the input, `compressPDF` returns the input; the report still has to
 *   say what the attempt cost, or the tool cannot state the delta.
 */
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, StandardFonts, degrees, rgb } from '@maxwbh/pdf-lib';
import {
  applyPdfVersion,
  drawPageInto,
  newPDF,
  openPDF,
  pageRotation,
  pdfVersion,
  saveIncremental,
  savePDF,
  setPdfVersion,
  snapshot,
  type Bytes,
} from '@/lib/pdf/core/doc';
import { compressPDF } from '@/lib/pdf/core/compress';
import { pageContentStreams } from '@/lib/pdf/core/content';
import { formatBytes } from '@/lib/utils/format';

/* ── fixtures ─────────────────────────────────────────────────────────────── */

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SheetSpec {
  /** `/MediaBox` size, in the page's own pre-rotation space. */
  width: number;
  height: number;
  /** `/Rotate`, clockwise — what a viewer shows, not what the stream holds. */
  rotate?: number;
  /** A non-zero `/MediaBox` origin, as a scanned sheet straight off a flatbed has. */
  origin?: [number, number];
  /** `/CropBox`, which is what the user actually sees of the sheet. */
  crop?: Box;
}

/**
 * Sheets carrying a black strip down their **own** left edge. A stamp that
 * ignores `/Rotate` or the box origin leaves that strip where the fixture never
 * drew it, which is what the mapping assertions below catch.
 */
async function sheets(specs: SheetSpec[]): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const [ox = 0, oy = 0] = spec.origin ?? [];
    const page = doc.addPage([ox + spec.width, oy + spec.height]);
    page.setMediaBox(ox, oy, spec.width, spec.height);
    if (spec.crop) page.setCropBox(spec.crop.x, spec.crop.y, spec.crop.width, spec.crop.height);
    if (spec.rotate) page.setRotation(degrees(spec.rotate));
    page.drawRectangle({ x: ox, y: oy, width: Math.min(20, spec.width), height: spec.height, color: rgb(0, 0, 0) });
    page.drawText(`sheet ${i + 1}`, {
      x: ox + 24,
      y: oy + spec.height - 24,
      size: 12,
      font: await doc.embedFont(StandardFonts.Helvetica),
      color: rgb(0, 0, 0),
    });
  }
  return doc;
}

/**
 * Draw each sheet onto its own letter page through the real primitive, then save
 * and re-open, so every assertion reads bytes rather than the bookkeeping of the
 * code under test.
 */
async function stampSheets(
  specs: SheetSpec[],
  cells: Box[] | Box,
  options: { scale?: number; rotate?: number; opacity?: number } = {},
): Promise<PDFDocument> {
  const source = await sheets(specs);
  const target = await newPDF();
  for (let i = 0; i < specs.length; i++) {
    const page = target.addPage([612, 792]);
    const box = Array.isArray(cells) ? cells[i] : cells;
    await drawPageInto(target, page, source.getPage(i), box, options);
  }
  return openPDF(await savePDF(target, { compress: false }));
}

/** A hand-written file small enough that pdf-lib's rebuild is bigger than it. */
function minimalPdf(version = '1.4'): Bytes {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R >>',
    '<< /Length 27 >>\nstream\nBT /F1 12 Tf 10 50 Td (hi) ET\nendstream',
  ];
  const encode = (text: string) => new TextEncoder().encode(text);
  let body = `%PDF-${version}\n`;
  const offsets: number[] = [];
  objects.forEach((text, i) => {
    offsets.push(encode(body).byteLength);
    body += `${i + 1} 0 obj\n${text}\nendobj\n`;
  });
  const start = encode(body).byteLength;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return encode(body);
}

const headerOf = (bytes: Bytes): string => new TextDecoder('latin1').decode(bytes.subarray(0, 8));

const latin1Of = (doc: PDFDocument, index: number): string =>
  pageContentStreams(doc.getPages()[index])
    .map((stream) => Buffer.from(stream.bytes).toString('latin1'))
    .join('\n');

/* ── reading where a page landed ──────────────────────────────────────────── */

const IDENTITY = [1, 0, 0, 1, 0, 0];

const multiply = (a: number[], b: number[]): number[] => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

/**
 * One `/Do` of an embedded page, with everything a viewer composes to place it:
 * the region that was clipped (`/BBox`), the shift applied to it (`/Matrix`), and
 * the page transform in force at the `/Do`.
 */
interface Stamp {
  name: string;
  bbox: number[];
  matrix: number[];
  ctm: number[];
}

function numbersIn(doc: PDFDocument, value: unknown): number[] {
  const array = value instanceof PDFRef ? doc.context.lookup(value) : value;
  if (!(array instanceof PDFArray)) return [];
  return Array.from({ length: array.size() }, (_, i) => Number(array.get(i).toString()));
}

function dictIn(doc: PDFDocument, value: unknown): PDFDict | null {
  const object = value instanceof PDFRef ? doc.context.lookup(value) : value;
  return object instanceof PDFDict ? object : null;
}

/** The form XObjects a page draws, in draw order, with the transform in force. */
function stampsOf(doc: PDFDocument, index: number): Stamp[] {
  const page = doc.getPages()[index];
  const resources = dictIn(doc, page.node.Resources());
  const forms = dictIn(doc, resources?.get(PDFName.of('XObject')));
  if (!forms) return [];
  const byName = new Map<string, PDFDict>();
  for (const [name, value] of forms.entries()) {
    const object = value instanceof PDFRef ? doc.context.lookup(value) : value;
    const dict = object instanceof PDFRawStream ? object.dict : object;
    if (dict instanceof PDFDict) byName.set(name.toString(), dict);
  }

  const stack: number[][] = [];
  let current = IDENTITY;
  let operands: string[] = [];
  const out: Stamp[] = [];
  for (const token of latin1Of(doc, index).split(/[\s\n]+/)) {
    if (token === '') continue;
    if (token !== 'cm' && token !== 'q' && token !== 'Q' && token !== 'Do') {
      operands.push(token);
      continue;
    }
    if (token === 'q') stack.push(current);
    else if (token === 'Q') current = stack.pop() ?? IDENTITY;
    else if (token === 'cm' && operands.length >= 6) {
      current = multiply(current, operands.slice(-6).map(Number));
      operands = [];
    } else if (token === 'Do') {
      const name = operands[operands.length - 1] ?? '';
      operands = [];
      const form = byName.get(name);
      if (!form) continue;
      out.push({
        name,
        bbox: numbersIn(doc, form.get(PDFName.of('BBox'))),
        matrix: numbersIn(doc, form.get(PDFName.of('Matrix'))),
        ctm: current,
      });
    } else {
      operands = [];
    }
  }
  return out;
}

const onlyStamp = (doc: PDFDocument, index = 0): Stamp => {
  const [stamp] = stampsOf(doc, index);
  expect(stamp, 'the source page was not drawn at all').toBeDefined();
  return stamp!;
};

/** Where a point in the **source page's own** space lands on the target sheet. */
function mapPoint(stamp: Stamp, x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = stamp.matrix;
  const mx = a * x + c * y + e;
  const my = b * x + d * y + f;
  const [g, h, i, j, k, l] = stamp.ctm;
  return [g * mx + i * my + k, h * mx + j * my + l];
}

/** Where a `[x, y, width, height]` rectangle in source space lands. */
function mapBox(stamp: Stamp, rect: [number, number, number, number]): Box {
  const [x, y, width, height] = rect;
  const points = [
    mapPoint(stamp, x, y),
    mapPoint(stamp, x + width, y),
    mapPoint(stamp, x, y + height),
    mapPoint(stamp, x + width, y + height),
  ];
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

function expectBox(actual: Box, expected: Box, label = 'the drawn page'): void {
  expect(actual.x, `${label} x`).toBeCloseTo(expected.x, 4);
  expect(actual.y, `${label} y`).toBeCloseTo(expected.y, 4);
  expect(actual.width, `${label} width`).toBeCloseTo(expected.width, 4);
  expect(actual.height, `${label} height`).toBeCloseTo(expected.height, 4);
}

/* ── drawPageInto: /Rotate (E9) ───────────────────────────────────────────── */

describe('drawPageInto honours the source /Rotate (E9)', () => {
  it('fills a cell sized for the page as displayed, not as stored', async () => {
    // 200 × 100 stored, `/Rotate 90`, so it displays as 100 × 200. The old
    // primitive fitted the 200 × 100 it saw into the cell: a 100 × 50 band,
    // sideways, floating in the middle of the sheet.
    const cell = { x: 50, y: 10, width: 100, height: 200 };
    const doc = await stampSheets([{ width: 200, height: 100, rotate: 90 }], cell);
    expectBox(mapBox(onlyStamp(doc), [0, 0, 200, 100]), cell);
  });

  it('turns clockwise, the way /Rotate and a viewer do', async () => {
    const doc = await stampSheets([{ width: 200, height: 100, rotate: 90 }], {
      x: 50,
      y: 10,
      width: 100,
      height: 200,
    });
    const stamp = onlyStamp(doc);
    // A clockwise quarter turn lifts the sheet's bottom-left corner to the top of
    // the cell and drops its top-right corner to the bottom.
    expect(mapPoint(stamp, 0, 0)).toEqual([expect.closeTo(50, 4), expect.closeTo(210, 4)]);
    expect(mapPoint(stamp, 200, 100)).toEqual([expect.closeTo(150, 4), expect.closeTo(10, 4)]);
  });

  it('adds the requested turn to the page’s own, rather than replacing it', async () => {
    // `/Rotate 90` plus a requested 90° must land exactly where `/Rotate 180`
    // and no request does. Both are 100 × 200 cells, so the half-turned 200 × 100
    // sheet fits at 100 × 50 either way — only a composed turn can agree.
    const cell = { x: 50, y: 10, width: 100, height: 200 };
    const composed = onlyStamp(await stampSheets([{ width: 200, height: 100, rotate: 90 }], cell, { rotate: 90 }));
    const stored = onlyStamp(await stampSheets([{ width: 200, height: 100, rotate: 180 }], cell));
    expect(composed.ctm).toEqual(stored.ctm);
    expect(composed.bbox).toEqual(stored.bbox);
    expectBox(mapBox(composed, [0, 0, 200, 100]), { x: 50, y: 85, width: 100, height: 50 });
  });

  it('straightens a rotated page back to its stored orientation', async () => {
    // `rotate: -90` cancels `/Rotate 90` — the straighten affordance the organize
    // pane exposes as `r0` — so the sheet is laid out as stored.
    const doc = await stampSheets([{ width: 200, height: 100, rotate: 90 }], {
      x: 0,
      y: 0,
      width: 100,
      height: 200,
    }, { rotate: -90 });
    expectBox(mapBox(onlyStamp(doc), [0, 0, 200, 100]), { x: 0, y: 75, width: 100, height: 50 });
  });

  it('fits an unrotated page the way it always did', async () => {
    const doc = await stampSheets([{ width: 200, height: 100 }], { x: 0, y: 0, width: 400, height: 200 });
    const stamp = onlyStamp(doc);
    expect(stamp.ctm.map((n) => Math.round(n * 1000) / 1000)).toEqual([2, 0, 0, 2, 0, 0]);
    expectBox(mapBox(stamp, [0, 0, 200, 100]), { x: 0, y: 0, width: 400, height: 200 });
  });

  it('keeps `scale` a multiplier on the fit rather than an absolute', async () => {
    const doc = await stampSheets([{ width: 200, height: 100 }], { x: 0, y: 0, width: 400, height: 200 }, { scale: 0.5 });
    expectBox(mapBox(onlyStamp(doc), [0, 0, 200, 100]), { x: 100, y: 50, width: 200, height: 100 });
  });

  it('passes opacity through to the graphics state', async () => {
    const doc = await stampSheets([{ width: 200, height: 100 }], { x: 0, y: 0, width: 200, height: 100 }, { opacity: 0.4 });
    const content = latin1Of(doc, 0);
    // The fork names the state `/GS-<id>`, not the upstream `/GS1`.
    const key = /\/(GS\S+) gs/.exec(content)?.[1];
    expect(key, 'no graphics state was written').toBeTruthy();
    const resources = dictIn(doc, doc.getPages()[0]!.node.Resources());
    const states = dictIn(doc, resources?.get(PDFName.of('ExtGState')));
    const gs = dictIn(doc, states?.get(PDFName.of(key!)));
    expect(Number(gs?.get(PDFName.of('ca'))?.toString())).toBeCloseTo(0.4, 6);
  });
});

/* ── drawPageInto: box origin, crop, mixed sizes (E8) ─────────────────────── */

describe('drawPageInto keeps the visible box correct', () => {
  it('captures an offset /MediaBox instead of cropping its left and bottom', async () => {
    // A flatbed scan: the sheet is 200 × 100 but the box starts at (36, 36).
    // Embedding it raw clipped `[0 0 200 100]`, so everything past x = 200 and
    // y = 100 — 18 % of the sheet — fell off the page.
    const doc = await stampSheets([{ width: 200, height: 100, origin: [36, 36] }], {
      x: 0,
      y: 0,
      width: 400,
      height: 200,
    });
    const stamp = onlyStamp(doc);
    expect(stamp.bbox).toEqual([36, 36, 236, 136]);
    expect(stamp.matrix).toEqual([1, 0, 0, 1, -36, -36]);
    expectBox(mapBox(stamp, [36, 36, 200, 100]), { x: 0, y: 0, width: 400, height: 200 });
    expect(mapPoint(stamp, 236, 136)).toEqual([expect.closeTo(400, 4), expect.closeTo(200, 4)]);
  });

  it('crops to /CropBox, which is what the user sees', async () => {
    const doc = await stampSheets(
      [{ width: 300, height: 200, crop: { x: 40, y: 20, width: 100, height: 100 } }],
      { x: 10, y: 10, width: 100, height: 100 },
    );
    const stamp = onlyStamp(doc);
    expect(stamp.bbox).toEqual([40, 20, 140, 120]);
    expectBox(mapBox(stamp, [40, 20, 100, 100]), { x: 10, y: 10, width: 100, height: 100 });
  });

  it('rotates an offset box about its own centre', async () => {
    // Both defects at once: a sheet that does not start at the origin and is
    // displayed turned. The cell is sized for the 120 × 220 it shows as.
    const cell = { x: 30, y: 40, width: 120, height: 220 };
    const doc = await stampSheets([{ width: 220, height: 120, rotate: 90, origin: [12, 8] }], cell);
    expectBox(mapBox(onlyStamp(doc), [12, 8, 220, 120]), cell);
  });

  it('measures every page on its own terms (E8)', async () => {
    // Three sheets, three cells sized for each sheet **as it displays**. Sizing
    // every cell by the first sheet — which is what reading `page.getWidth()`
    // once did — cannot leave all three filling their own cell.
    const specs: SheetSpec[] = [
      { width: 200, height: 100 },
      { width: 100, height: 250 },
      { width: 300, height: 150, rotate: 270 },
    ];
    const cells: Box[] = [
      { x: 0, y: 600, width: 200, height: 100 },
      { x: 0, y: 300, width: 100, height: 250 },
      { x: 250, y: 300, width: 150, height: 300 },
    ];
    const doc = await stampSheets(specs, cells);
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      const stamp = onlyStamp(doc, i);
      expectBox(mapBox(stamp, [0, 0, spec.width, spec.height]), cells[i], `sheet ${i + 1}`);
    }
  });

  it('draws nothing when the cell has no area, and writes no NaN', async () => {
    const doc = await stampSheets([{ width: 200, height: 100 }], { x: 0, y: 0, width: 100, height: 0 });
    expect(stampsOf(doc, 0)).toEqual([]);
    expect(latin1Of(doc, 0)).not.toMatch(/NaN|Infinity/);
    expect((await openPDF(await savePDF(doc))).getPageCount()).toBe(1);
  });
});

/* ── pageRotation ─────────────────────────────────────────────────────────── */

describe('pageRotation', () => {
  it('reads the page’s own /Rotate as a clockwise turn', async () => {
    const doc = await sheets([
      { width: 100, height: 100 },
      { width: 100, height: 100, rotate: 90 },
      { width: 100, height: 100, rotate: 180 },
      { width: 100, height: 100, rotate: 270 },
    ]);
    expect(doc.getPages().map(pageRotation)).toEqual([0, 90, 180, 270]);
  });

  it('normalises a value a writer left out of range', async () => {
    const doc = await sheets([{ width: 100, height: 100 }]);
    const page = doc.getPages()[0];
    // `/Rotate` is modulo 360, and writers in the wild do emit `450` and `-90`.
    page.setRotation(degrees(450));
    expect(page.getRotation().angle).toBe(450);
    expect(pageRotation(page)).toBe(90);
  });
});

/* ── setPdfVersion / applyPdfVersion (B2 item 1) ──────────────────────────── */

describe('raising the PDF version header (B2 item 1)', () => {
  it('reports the header a file was loaded with', async () => {
    expect(pdfVersion(await openPDF(minimalPdf('1.4')))).toBe('1.4');
  });

  it('raises what the document declares, and returns the new value', async () => {
    const doc = await openPDF(minimalPdf('1.4'));
    expect(setPdfVersion(doc, '1.5')).toBe('1.5');
    expect(pdfVersion(doc)).toBe('1.5');
  });

  it('never lowers a version that is already newer', async () => {
    const doc = await openPDF(minimalPdf('1.7'));
    expect(setPdfVersion(doc, '1.4')).toBe('1.7');
    expect(pdfVersion(doc)).toBe('1.7');
  });

  it('raises the header of an append-only revision, which copies the original bytes', async () => {
    const doc = await openPDF(minimalPdf('1.4'));
    setPdfVersion(doc, '1.5');
    await snapshot(doc);
    doc.addPage([10, 10]);
    // `saveIncremental` prepends the source file verbatim, so the header the
    // reader sees is still the one that was read in — not the one just set.
    // This is the gap `applyPdfVersion` closes, and the reason both exist.
    const appended = await saveIncremental(doc);
    expect(headerOf(appended)).toBe('%PDF-1.4');
    expect(headerOf(applyPdfVersion(appended, '1.5'))).toBe('%PDF-1.5');
  });

  it('leaves a byte stream alone when the request would be a downgrade', async () => {
    const bytes = minimalPdf('1.7');
    expect(headerOf(applyPdfVersion(bytes, '1.4'))).toBe('%PDF-1.7');
    expect(headerOf(applyPdfVersion(bytes, '1.7'))).toBe('%PDF-1.7');
  });

  it('rewrites the version digits without moving any other byte', async () => {
    const bytes = minimalPdf('1.4');
    const before = Buffer.from(bytes).toString('latin1');
    const raised = applyPdfVersion(bytes, '1.5');
    const after = Buffer.from(raised).toString('latin1');
    expect(raised.byteLength).toBe(bytes.byteLength);
    expect(after.slice(0, 8)).toBe('%PDF-1.5');
    expect(after.slice(8)).toBe(before.slice(8));
    // The claim is now consistent: a reader gets the same document, and reports
    // the version the file says it is.
    const doc = await openPDF(raised);
    expect(doc.getPageCount()).toBe(1);
    expect(pdfVersion(doc)).toBe('1.5');
  });
});

/* ── CompressReport.rebuildBytes (B2 item 2, E14) ─────────────────────────── */

describe('compressPDF reports the size the rebuild would have had (E14)', () => {
  it('keeps the would-have-been number when the original is returned', async () => {
    const { bytes, report } = await compressPDF({ bytes: minimalPdf() }, { preset: 'lossless' });
    expect(report.rebuildBytes).toBeGreaterThan(report.before);
    expect(bytes.byteLength).toBe(report.before);
    expect(report.after).toBe(report.before);
    // The honesty sentence the tool can now print: both numbers.
    expect(report.notes.join(' ')).toContain(formatBytes(report.rebuildBytes));
    expect(report.notes.join(' ')).toContain(formatBytes(report.before));
    expect(report.notes.join(' ')).toMatch(/larger|saved nothing/);
  });

  it('equals the output when the rebuild wins', async () => {
    const source = await sheets([{ width: 400, height: 300 }]);
    const bytes = await savePDF(source, { compress: false });
    const { bytes: out, report } = await compressPDF({ bytes }, { preset: 'balanced' });
    expect(report.rebuildBytes).toBe(out.byteLength);
    expect(report.after).toBe(out.byteLength);
    expect(report.rebuildBytes).toBeLessThan(report.before);
  });

  it('keeps the number through the target-size ladder', async () => {
    const { bytes, report } = await compressPDF({ bytes: minimalPdf() }, { targetBytes: 1 });
    // Nothing in the ladder beat this file, so the original ships and the report
    // still says what the last attempt cost.
    expect(report.after).toBe(report.before);
    expect(bytes.byteLength).toBe(report.before);
    expect(report.rebuildBytes).toBeGreaterThan(report.after);
  });
});
