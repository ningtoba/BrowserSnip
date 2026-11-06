/**
 * Edge cases for the organize category (B1: `src/lib/pdf/tools/organize.ts`).
 *
 * Same discipline as `tools-e2e.test.ts`: real PDF bytes are built here with
 * pdf-lib, the tool is driven through `runPdfTool` (the exact path the rail
 * uses — guard, field clamping, validation, the warnings bridge), and the
 * **returned bytes** are re-opened and measured. Nothing about the PDF work is
 * mocked, so a tool that reports a confident sentence over a broken file fails
 * here, which is the whole complaint the refinement pass started from.
 *
 * Matrix rows covered: E1/E2 (the gate names the file), E5 (an unlocked output
 * must not still be encrypted), E6 (page 9 of a 3-page file names the real
 * count), E8 (mixed page sizes), E9 (rotated pages keep their orientation),
 * E12 (a sheet that hits the PDF height limit says so), E13 (nothing to do is
 * not a success), E15 (numbers are bounded, and a correction is announced),
 * E16 (a repeat is handled, not merged twice by accident), E17 (sane download
 * names), E18 (the rail blocks before the click), E19 (a cancelled run leaves
 * nothing behind), E20 (a rebuild that needs an optional engine says so).
 *
 * `remove-blank-pages` and `pdf-to-cbz` render through pdf.js, which cannot spin
 * a worker inside this jsdom suite (`Setting up fake worker failed`), so they are
 * covered by the rail-contract block below rather than by a byte test.
 */
import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  StandardFonts,
  degrees,
  rgb,
} from '@maxwbh/pdf-lib';
import { organizeTools } from '@/lib/pdf/tools/organize';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool, type RunOutcome } from '@/lib/pdf/tools/runner';
import { pageContentStreams } from '@/lib/pdf/core/content';

/* ── fixtures ─────────────────────────────────────────────────────────────── */

interface SheetSpec {
  width: number;
  height: number;
  /** `/Rotate`, clockwise, as a viewer displays it. */
  rotate?: number;
  /** Paint nothing, for the blank-page tests. */
  empty?: boolean;
}

/**
 * Sheets carrying a black strip down their **left edge in page space** plus a
 * line of text. A stamp that ignores `/Rotate` puts that strip where the fixture
 * never drew it, which is what the geometry assertions below measure.
 */
async function sheets(specs: SheetSpec[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const page = doc.addPage([spec.width, spec.height]);
    if (spec.rotate) page.setRotation(degrees(spec.rotate));
    if (spec.empty) continue;
    page.drawRectangle({ x: 0, y: 0, width: 50, height: spec.height, color: rgb(0, 0, 0) });
    page.drawText(`sheet ${i + 1}`, { x: 60, y: spec.height - 24, size: 12, font, color: rgb(0, 0, 0) });
  }
  return doc.save({ useObjectStreams: false });
}

const grid = (
  count: number,
  extra: { width?: number; height?: number; rotate?: number; empty?: boolean } = {},
): SheetSpec[] => Array.from({ length: count }, () => ({ width: 200, height: 100, ...extra }));

/** SAFETY: a fresh `Uint8Array` copy is a valid `BlobPart`. */
const fileOf = (bytes: Uint8Array, name: string): File =>
  new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });

async function run(
  toolId: string,
  values: Record<string, unknown> = {},
  files: File[] = [],
  password?: string,
): Promise<RunOutcome> {
  const tool = getPdfTool(toolId);
  expect(tool, `tool "${toolId}" is not registered`).toBeTruthy();
  const chosen = files.length > 0 ? files : [fileOf(await sheets(grid(4)), 'fixture.pdf')];
  return runPdfTool({
    toolId,
    files: chosen,
    values,
    password,
    onProgress: () => {},
    onLog: () => {},
  });
}

async function bytesOf(outcome: RunOutcome, index = 0): Promise<Uint8Array> {
  expect(outcome.outputs.length, 'expected an output').toBeGreaterThan(index);
  return new Uint8Array(await outcome.outputs[index].blob.arrayBuffer());
}

const open = (bytes: Uint8Array): Promise<PDFDocument> => PDFDocument.load(bytes);

/** Raw file text, for trailer-level claims such as `/Encrypt`. */
const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');

const warn = (outcome: RunOutcome): string => outcome.warnings.join(' ');

/* ── measuring what a tool actually drew ─────────────────────────────────── */

interface Stamp {
  name: string;
  /** The form's `/BBox`: which region of the source page was taken. */
  bbox: number[];
  /** The form's `/Matrix`, then the content-stream CTM at the `Do`. */
  matrix: number[];
  ctm: number[];
}

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
 * The form XObjects a page draws, in draw order, with the transform in force.
 *
 * Read from the saved file rather than from the tool's own bookkeeping, so the
 * assertion is about the PDF: which region was clipped (`/BBox`) and where it
 * landed (the composed `/Matrix` and `cm` chain).
 */
function stampsOf(doc: PDFDocument, index: number): Stamp[] {
  const page = doc.getPages()[index];
  const resources = page.node.Resources();
  const dict = resources instanceof PDFRef ? doc.context.lookup(resources, PDFDict) : resources;
  const rawForms = dict instanceof PDFDict ? dict.get(PDFName.of('XObject')) : undefined;
  const forms = rawForms instanceof PDFRef ? doc.context.lookup(rawForms, PDFDict) : rawForms;
  if (!(forms instanceof PDFDict)) return [];
  const numbers = (value: unknown): number[] => {
    const array = value instanceof PDFRef ? doc.context.lookup(value, PDFArray) : value;
    if (!(array instanceof PDFArray)) return [];
    return Array.from({ length: array.size() }, (_, i) => Number(array.get(i).toString()));
  };
  const byName = new Map<string, PDFDict>();
  for (const [name, value] of forms.entries()) {
    // A form XObject is a stream: its dictionary is what carries /BBox.
    const object = value instanceof PDFRef ? doc.context.lookup(value) : value;
    const dict = object instanceof PDFRawStream ? object.dict : object;
    if (dict instanceof PDFDict) byName.set(name.toString(), dict);
  }

  const content = pageContentStreams(page)
    .map((stream) => Buffer.from(stream.bytes).toString('latin1'))
    .join('\n');
  const stack: number[][] = [];
  let current = IDENTITY;
  let operands: string[] = [];
  const out: Stamp[] = [];
  for (const token of content.split(/[\s\n]+/)) {
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
      out.push({ name, bbox: numbers(form.get(PDFName.of('BBox'))), matrix: numbers(form.get(PDFName.of('Matrix'))), ctm: current });
    } else {
      operands = [];
    }
  }
  return out;
}

/** Where a rectangle in the *source page's own* space lands on the target. */
function mappedBox(
  stamp: Stamp,
  rect: [number, number, number, number],
): { x: number; y: number; width: number; height: number } {
  const [x, y, width, height] = rect;
  const points = [[x, y], [x + width, y], [x, y + height], [x + width, y + height]].map(([px, py]) => {
    const mx = stamp.matrix[0] * px + stamp.matrix[2] * py + stamp.matrix[4];
    const my = stamp.matrix[1] * px + stamp.matrix[3] * py + stamp.matrix[5];
    return [
      stamp.ctm[0] * mx + stamp.ctm[2] * my + stamp.ctm[4],
      stamp.ctm[1] * mx + stamp.ctm[3] * my + stamp.ctm[5],
    ];
  });
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

async function zipEntries(blob: Blob): Promise<string[]> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()));
  return Object.keys(zip.files);
}

async function encrypt(bytes: Uint8Array, password = 'hunter2'): Promise<Uint8Array> {
  const doc = await open(bytes);
  return doc.save({
    encrypt: { userPassword: password, ownerPassword: 'owner', version: 4, permissions: {} as never },
  });
}

/* ── the rail contract: E15, E18, E20 before the click ───────────────────── */

describe('organize rail contract', () => {
  it('covers the whole category', () => {
    expect(organizeTools.map((tool) => tool.id)).toHaveLength(21);
  });

  it('says what each tool produces and what its button does', () => {
    for (const tool of organizeTools) {
      const promise = tool.promise ?? '';
      expect(promise.split(/\s+/).length, `${tool.id} has a thin promise`).toBeGreaterThanOrEqual(6);
      expect(
        /pdf|file|pages|sheet|archive|images|copy|booklet|tiles|zip/i.test(promise),
        `${tool.id} promise does not name the output`,
      ).toBe(true);
      expect(tool.actionLabel, `${tool.id} has no actionLabel`).toBeTruthy();
      expect(tool.actionLabel, `${tool.id} still says Run`).not.toBe('Run');
      expect(tool.actionLabel!.length, `${tool.id} verb is a sentence`).toBeLessThanOrEqual(16);
      expect(tool.run ?? tool.mainComponent ?? tool.unavailable, `${tool.id} cannot do anything`).toBeTruthy();
    }
  });

  it('bounds every numeric field and files every field under a heading (E15, E18)', () => {
    const unbounded: string[] = [];
    const ungrouped: string[] = [];
    const notWhole: string[] = [];
    const wholeNumbers = ['chunkSize', 'anchor', 'count', 'offset', 'columns', 'rows', 'parts', 'dpi'];
    for (const tool of organizeTools) {
      for (const field of tool.fields ?? []) {
        if (!field.group) ungrouped.push(`${tool.id}.${field.key}`);
        if (field.type !== 'number' && field.type !== 'slider') continue;
        if (field.min === undefined || field.max === undefined || field.step === undefined) {
          unbounded.push(`${tool.id}.${field.key}`);
        } else if (field.min > field.max) {
          unbounded.push(`${tool.id}.${field.key} inverted`);
        }
        if (wholeNumbers.includes(field.key) && field.integer !== true) notWhole.push(`${tool.id}.${field.key}`);
      }
    }
    expect(unbounded).toEqual([]);
    expect(ungrouped).toEqual([]);
    expect(notWhole).toEqual([]);
  });

  it('warns in the honesty panel when the rebuild needs an engine it does not have (E20)', () => {
    for (const id of ['n-up', 'booklet', 'posterize', 'divide-pages', 'combine-single-page', 'fix-page-size', 'overlay-pdf', 'rotate-custom']) {
      const tool = getPdfTool(id)!;
      const notes = (tool.notes ?? []).join(' ');
      expect(/link|bookmark|annotation/i.test(notes), `${id} hides what it loses`).toBe(true);
      expect(/engine|CoherentPDF|PyMuPDF|Ghostscript/i.test(notes), `${id} does not name the optional engine`).toBe(true);
    }
  });
});

/* ── E6, E13, E15, E18: page lists and numbers ───────────────────────────── */

describe('page selections name the real document', () => {
  it('accepts page 1 and rejects page 2 of a one-page file (E6)', async () => {
    const one = fileOf(await sheets(grid(1)), 'one.pdf');
    const outcome = await run('rotate', { degrees: 90, pages: '1' }, [one]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPages()[0].getRotation().angle).toBe(90);

    await expect(run('rotate', { degrees: 90, pages: '2' }, [one])).rejects.toThrow(
      /refers to page 2, but this document has 1 page/i,
    );
    await expect(run('extract-pages', { pages: '9' }, [one])).rejects.toThrow(/has 1 page/i);
  });

  it('quotes the page count of the file actually dropped (E6)', async () => {
    const six = fileOf(await sheets(grid(6)), 'six.pdf');
    await expect(run('extract-pages', { pages: '9' }, [six])).rejects.toThrow(/has 6 pages/i);
  });

  it('rejects an inverted range and page zero with a reason (E15)', async () => {
    await expect(run('extract-pages', { pages: '4-2' })).rejects.toThrow(/runs backwards/i);
    await expect(run('extract-pages', { pages: '0' })).rejects.toThrow(/numbered from 1/i);
  });

  it('rejects an empty selection and says what to do (E13, E18)', async () => {
    await expect(run('extract-pages', { pages: '  ' })).rejects.toThrow(/choose which pages to extract/i);
    await expect(run('remove-pages', { pages: '' })).rejects.toThrow(/choose the pages to delete/i);
    await expect(run('rotate', { degrees: 90, pages: '' })).rejects.toThrow(/no pages chosen/i);
    await expect(run('split', { mode: 'ranges', ranges: '' })).rejects.toThrow(/enter at least one page range/i);
  });

  it('refuses a plan that would delete every page (E13)', async () => {
    await expect(run('remove-pages', { pages: '1-4' })).rejects.toThrow(
      /removing all 4 pages|leaving an empty pdf/i,
    );
  });

  it('applies a page listed twice once only (E16)', async () => {
    const outcome = await run('rotate', { degrees: 90, pages: '2,2' });
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPages().map((page) => page.getRotation().angle)).toEqual([0, 90, 0, 0]);
  });

  it('clamps an out-of-range number and announces the correction (E15)', async () => {
    const outcome = await run('split', { mode: 'chunks', chunkSize: 0 });
    expect(warn(outcome)).toMatch(/pages per file must be between 1 and 500: 0 became 1/i);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(1);
  });

  it('does not pretend a chunk bigger than the document is several files (E13)', async () => {
    const outcome = await run('split', { mode: 'chunks', chunkSize: 500 });
    expect(outcome.outputs).toHaveLength(1);
    expect(warn(outcome)).toMatch(/at least the document/i);
  });

  it('says which pages its ranges leave out of the download (E13)', async () => {
    const outcome = await run('split', { mode: 'ranges', ranges: '1-2' });
    expect(warn(outcome)).toMatch(/cover 2 pages of the document.s 4 pages/i);
  });

  it('clamps a page-number field to the document it was typed against (E6)', async () => {
    const outcome = await run('add-blank-page', { position: 'after', anchor: 99, count: 1, size: 'same' });
    expect(warn(outcome)).toMatch(/must be a page between 1 and 4: 99 became 4/i);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(5);
  });
});

/* ── E8, E9: rotation and per-page geometry ──────────────────────────────── */

describe('geometry is respected, not flattened', () => {
  it('keeps a page’s own rotation while reordering (E9)', async () => {
    const source = fileOf(
      await sheets([
        { width: 200, height: 100 },
        { width: 200, height: 100, rotate: 90 },
      ]),
      'two.pdf',
    );
    const outcome = await run('organize', { pageOrder: '2, 1' }, [source]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPages().map((page) => page.getRotation().angle)).toEqual([90, 0]);
  });

  it('lets a plan straighten a rotated page with r0, and expands a range (E9)', async () => {
    const source = fileOf(
      await sheets([
        { width: 200, height: 100, rotate: 90 },
        { width: 200, height: 100, rotate: 90 },
      ]),
      'two.pdf',
    );
    const outcome = await run('organize', { pageOrder: '1-2r0' }, [source]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPages().map((page) => page.getRotation().angle)).toEqual([0, 0]);
  });

  it('names the real page count when a plan reaches too far (E6)', async () => {
    const source = fileOf(await sheets(grid(3)), 'three.pdf');
    await expect(run('organize', { pageOrder: '9' }, [source])).rejects.toThrow(
      /refers to page 9, but this document has 3 pages/i,
    );
    await expect(run('organize', { pageOrder: '3-1' }, [source])).rejects.toThrow(/runs backwards/i);
    const snapped = await run('organize', { pageOrder: '3r45' }, [source]);
    expect(warn(snapped)).toMatch(/r45 is not a quarter turn.*90° instead/i);
  });

  it('adds the turn to the page’s own rotation instead of overwriting it (E9)', async () => {
    const source = fileOf(await sheets([{ width: 200, height: 100, rotate: 270 }]), 'one.pdf');
    const outcome = await run('rotate', { degrees: 90, pages: 'all' }, [source]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPages()[0].getRotation().angle).toBe(0);
    expect(warn(outcome)).toMatch(/now upright/i);
  });

  it('stamps rotated pages upright into an N-up sheet (E9)', async () => {
    // 200 × 100 with /Rotate 90 displays as a portrait sheet. A stamp that
    // ignores /Rotate puts a sideways landscape box in the cell.
    const source = fileOf(await sheets(grid(2, { rotate: 90 })), 'two.pdf');
    const outcome = await run('n-up', { perSheet: 2, sheetSize: 'a4', landscape: false, gutter: 0, margin: 0 }, [source]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(1);
    const sheet = doc.getPage(0);
    const drawn = stampsOf(doc, 0).map((stamp) => mappedBox(stamp, [0, 0, 200, 100]));
    expect(drawn).toHaveLength(2);
    for (const box of drawn) {
      expect(box.height, 'a rotated page must occupy a portrait cell').toBeGreaterThan(box.width);
      expect(box.x).toBeGreaterThanOrEqual(-0.5);
      expect(box.y).toBeGreaterThanOrEqual(-0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(sheet.getWidth() + 0.5);
      expect(box.y + box.height).toBeLessThanOrEqual(sheet.getHeight() + 0.5);
    }
  });

  it('cuts a rotated page along the line the viewer sees (E9)', async () => {
    const source = fileOf(await sheets([{ width: 200, height: 100, rotate: 90 }]), 'one.pdf');
    const outcome = await run('divide-pages', { axis: 'vertical', parts: 2 }, [source]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(2);
    // Displayed as 100 × 200, a vertical cut halves X — which in the page's own
    // space is a split of Y: two 200 × 50 strips, on two portrait sheets.
    expect(doc.getPages().map((_, index) => stampsOf(doc, index)[0].bbox)).toEqual([
      [0, 0, 200, 50],
      [0, 50, 200, 100],
    ]);
    expect(doc.getPages().map((page) => page.getSize())).toEqual([
      { width: 50, height: 200 },
      { width: 50, height: 200 },
    ]);
  });

  it('bakes the page’s own rotation into a custom-angle turn (E9)', async () => {
    const source = fileOf(await sheets([{ width: 200, height: 100, rotate: 90 }]), 'one.pdf');
    const outcome = await run('rotate-custom', { angle: 0, fit: 'grow', pages: 'all' }, [source]);
    const doc = await open(await bytesOf(outcome));
    const page = doc.getPage(0);
    expect(page.getRotation().angle).toBe(0);
    expect(page.getSize()).toEqual({ width: 100, height: 200 });
    const box = mappedBox(stampsOf(doc, 0)[0], [0, 0, 200, 100]);
    expect(box.height).toBeGreaterThan(box.width);
    expect(box.width).toBeCloseTo(page.getWidth(), 0);
  });

  it('keeps a custom-angle turn as vector content rather than a picture (E12)', async () => {
    const source = fileOf(await sheets(grid(1)), 'one.pdf');
    const outcome = await run('rotate-custom', { angle: 12.5, fit: 'grow', pages: 'all' }, [source]);
    const bytes = await bytesOf(outcome);
    const doc = await open(bytes);
    expect(text(bytes)).toMatch(/\/Subtype\s*\/Form/);
    expect(text(bytes)).not.toMatch(/\/Subtype\s*\/Image/);
    const box = mappedBox(stampsOf(doc, 0)[0], [0, 0, 200, 100]);
    expect(doc.getPage(0).getWidth()).toBeCloseTo(box.width, 0);
    expect(doc.getPage(0).getHeight()).toBeCloseTo(box.height, 0);
  });

  it('reports when keeping the page size crops the turn (E13)', async () => {
    const source = fileOf(await sheets(grid(1)), 'one.pdf');
    const outcome = await run('rotate-custom', { angle: 45, fit: 'keep', pages: 'all' }, [source]);
    expect(warn(outcome)).toMatch(/cut the corners off 1 page/i);
  });

  it('sizes a blank sheet to the page it lands beside (E8)', async () => {
    const source = fileOf(
      await sheets([
        { width: 200, height: 100 },
        { width: 400, height: 300 },
        { width: 400, height: 300 },
        { width: 400, height: 300 },
      ]),
      'mixed.pdf',
    );
    const outcome = await run('add-blank-page', { position: 'end', count: 1, size: 'same' }, [source]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPage(doc.getPageCount() - 1).getSize()).toEqual({ width: 400, height: 300 });
    expect(warn(outcome)).toMatch(/mixes page sizes.*page 4 beside them/i);
  });

  it('keeps each page’s own size when merging, and says so (E8)', async () => {
    const small = fileOf(await sheets([{ width: 200, height: 100 }]), 'a.pdf');
    const large = fileOf(await sheets([{ width: 400, height: 300 }]), 'b.pdf');
    const outcome = await run('merge', {}, [small, large]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPages().map((page) => page.getSize())).toEqual([
      { width: 200, height: 100 },
      { width: 400, height: 300 },
    ]);
    expect(warn(outcome)).toMatch(/2 different page sizes/i);
  });

  it('standardises a mixed document without losing any page (E8)', async () => {
    const source = fileOf(
      await sheets([
        { width: 200, height: 100 },
        { width: 400, height: 300 },
        { width: 200, height: 100, rotate: 90 },
      ]),
      'mixed.pdf',
    );
    const outcome = await run('fix-page-size', { size: 'a4', orientation: 'portrait', fit: 'contain' }, [source]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(3);
    for (const page of doc.getPages()) {
      expect(Math.round(page.getWidth())).toBe(595);
      expect(Math.round(page.getHeight())).toBe(842);
    }
    // The rotated page must still be drawn rotated-correct: its content box is
    // taller than wide before fitting, and it must sit inside the sheet.
    const box = mappedBox(stampsOf(doc, 2)[0], [0, 0, 200, 100]);
    expect(box.y).toBeGreaterThanOrEqual(-0.5);
    expect(box.y + box.height).toBeLessThanOrEqual(842 + 0.5);
  });

  it('says when filling the page runs content off the edge (E13)', async () => {
    const outcome = await run('fix-page-size', { size: 'a4', orientation: 'portrait', fit: 'cover' });
    expect(warn(outcome)).toMatch(/fill the page.*up to \d+% of the sheet/i);
  });
});

/* ── E1, E2, E5, E16, E17: inputs handled honestly ───────────────────────── */

describe('inputs are handled honestly', () => {
  it('names the file when it is empty or not a PDF (E1, E2)', async () => {
    const junk = new File([new Uint8Array(Array.from({ length: 64 }, (_, i) => 65 + (i % 26)))], 'notes.txt', {
      type: 'text/plain',
    });
    await expect(
      runPdfTool({ toolId: 'rotate', files: [junk], values: { degrees: 90, pages: 'all' } }),
    ).rejects.toThrow(/notes\.txt.*not a PDF/i);
    await expect(
      runPdfTool({
        toolId: 'pdfs-to-zip',
        files: [new File([new Uint8Array(0)], 'blank.pdf', { type: 'application/pdf' })],
        values: {},
      }),
    ).rejects.toThrow(/blank\.pdf.*(empty|0 bytes)/i);
  });

  it('unlocks a protected document and does not hand it back still encrypted (E5)', async () => {
    const locked = fileOf(await encrypt(await sheets(grid(4))), 'locked.pdf');
    expect(text(await bytesFrom(locked))).toMatch(/\/Encrypt/);

    const outcome = await run('rotate', { degrees: 90, pages: 'all' }, [locked], 'hunter2');
    const bytes = await bytesOf(outcome);
    // Rotating a protected contract must not quietly un-protect it: the password
    // is re-applied and the run says so. (The runner skips this for tools whose
    // own job is removing protection — see `stripsProtection`.)
    expect(text(bytes)).toMatch(/\/Encrypt/);
    const doc = await PDFDocument.load(bytes, { password: 'hunter2' });
    expect(doc.getPages()[0].getRotation().angle).toBe(90);
    expect(warn(outcome)).toMatch(/re-applied/i);
  });

  it('says when a file was added twice instead of merging it silently (E16)', async () => {
    const source = fileOf(await sheets(grid(4)), 'a.pdf');
    const outcome = await run('merge', {}, [source, source]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(8);
    expect(warn(outcome)).toMatch(/"a\.pdf" appears twice in the queue/i);
  });

  it('keeps a sane download name for a spaced, unicode filename (E17)', async () => {
    const source = fileOf(await sheets(grid(4)), '发票 2024 draft.pdf');
    const outcome = await run('split', { mode: 'ranges', ranges: '1-2,1-2' }, [source]);
    expect(outcome.outputs.map((output) => output.name)).toEqual([
      '发票 2024 draft_pages-1-2.pdf',
      '发票 2024 draft_pages-1-2-2.pdf',
    ]);
    for (const output of outcome.outputs) {
      expect(output.name).not.toMatch(/[\\:*?"<>]/);
      const doc = await open(new Uint8Array(await output.blob.arrayBuffer()));
      expect(doc.getPageCount()).toBe(2);
    }
  });

  it('does not overwrite an archive entry when two files share a name (E16, E17)', async () => {
    const a = fileOf(await sheets([{ width: 200, height: 100 }]), 'same.pdf');
    const b = fileOf(await sheets([{ width: 300, height: 100 }]), 'same.pdf');
    const outcome = await run('pdfs-to-zip', {}, [a, b]);
    const entries = await zipEntries(outcome.outputs[0].blob);
    expect(entries.filter((entry) => entry.startsWith('same'))).toEqual(['same.pdf', 'same-2.pdf']);
    expect(warn(outcome)).toMatch(/share the name/i);
  });

  it('says that a protected file is still protected inside the archive (E5)', async () => {
    const openFile = fileOf(await sheets(grid(1)), 'open.pdf');
    const locked = fileOf(await encrypt(await sheets(grid(1))), 'locked.pdf');
    const outcome = await run('pdfs-to-zip', { includeReport: true }, [locked, openFile], 'hunter2');
    expect(warn(outcome)).toMatch(/"locked\.pdf" is still password protected inside the archive/i);
  });
});

async function bytesFrom(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

/* ── E13: nothing to do, and plans that would produce nothing ────────────── */

describe('empty results are reported, not downloaded', () => {
  it('produces no empty even-pages file for a one-page document (E13)', async () => {
    const source = fileOf(await sheets(grid(1)), 'one.pdf');
    const outcome = await run('split', { mode: 'oddEven', oddEven: 'both' }, [source]);
    expect(outcome.outputs).toHaveLength(1);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(1);
    expect(warn(outcome)).toMatch(/no even pages/i);
  });

  it('does not mention a missing side the user did not ask for (E13)', async () => {
    const source = fileOf(await sheets(grid(1)), 'one.pdf');
    const outcome = await run('split', { mode: 'oddEven', oddEven: 'odd' }, [source]);
    expect(outcome.outputs).toHaveLength(1);
    expect(warn(outcome)).not.toMatch(/no even pages/i);
  });

  it('names a poster grid that only copies the page (E13)', async () => {
    const outcome = await run('posterize', { columns: 1, rows: 1, bleed: 0, pages: 'all' });
    expect(warn(outcome)).toMatch(/copies each page rather than splitting/i);
  });

  it('says when a one-page document cannot be reversed or collated (E13)', async () => {
    const source = fileOf(await sheets(grid(1)), 'one.pdf');
    expect(warn(await run('reverse-pages', {}, [source]))).toMatch(/reversing changes nothing/i);
    expect(warn(await run('duplex-collate', {}, [source]))).toMatch(/cannot be collated/i);
  });

  it('reports the pages a collation plan drops (E13)', async () => {
    const source = fileOf(await sheets(grid(6)), 'six.pdf');
    const outcome = await run('duplex-collate', { backReversed: true, offset: 1 }, [source]);
    expect(warn(outcome)).toMatch(/leaves 1 page out \(4\)/i);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(5);
  });

  it('bounds the back-side offset to what the scan can hold (E15)', async () => {
    const source = fileOf(await sheets(grid(6)), 'six.pdf');
    const outcome = await run('duplex-collate', { offset: 5 }, [source]);
    expect(warn(outcome)).toMatch(/back-side page offset must be between 0 and 3: 5 became 3/i);
  });

  it('tells you when the stamp ran out of pages (E6)', async () => {
    const base = fileOf(await sheets(grid(4)), 'base.pdf');
    const stamp = fileOf(await sheets([{ width: 300, height: 100 }]), 'stamp.pdf');
    const outcome = await run('overlay-pdf', { mode: 'overlay', mapping: 'same', opacity: 1, scale: 1 }, [base, stamp]);
    expect(warn(outcome)).toMatch(/the last 3 pages reused stamp page 1/i);
  });

  it('accepts a plan of only blank sheets rather than saving an empty PDF (E13)', async () => {
    const source = fileOf(await sheets(grid(1)), 'one.pdf');
    const outcome = await run('organize', { pageOrder: 'blank, blank' }, [source]);
    const doc = await open(await bytesOf(outcome));
    expect(doc.getPageCount()).toBe(2);
    expect(warn(outcome)).toMatch(/only the 2 blank sheets you asked for/i);
  });
});

/* ── the compromises the brief asks to be reported ────────────────────────── */

describe('compromises reach the result card', () => {
  it('really draws an underlay behind the page (E13 honesty)', async () => {
    const base = fileOf(await sheets([{ width: 200, height: 100 }]), 'base.pdf');
    const stamp = fileOf(await sheets([{ width: 300, height: 100 }]), 'stamp.pdf');
    const behind = await run('overlay-pdf', { mode: 'underlay', mapping: 'first', opacity: 1, scale: 1 }, [base, stamp]);
    const inFront = await run('overlay-pdf', { mode: 'overlay', mapping: 'first', opacity: 1, scale: 1 }, [base, stamp]);

    // Underlay: the stamp first, then the page's own content re-laid on top.
    const behindStamps = stampsOf(await open(await bytesOf(behind)), 0).map((s) => s.bbox.join(' '));
    expect(behindStamps).toEqual(['0 0 300 100', '0 0 200 100']);
    // Overlay: the base page keeps its own content and only gains the stamp.
    const frontStamps = stampsOf(await open(await bytesOf(inFront)), 0).map((s) => s.bbox.join(' '));
    expect(frontStamps).toEqual(['0 0 300 100']);
    // And the underlaid page is still the original page object: same rotation.
    const doc = await open(await bytesOf(behind));
    expect(doc.getPageCount()).toBe(1);
  });

  it('admits that a rebuild leaves bookmarks behind (E20)', async () => {
    const merged = await run('merge', {}, [
      fileOf(await sheets(grid(2)), 'a.pdf'),
      fileOf(await sheets(grid(2)), 'b.pdf'),
    ]);
    const bytes = await bytesOf(merged);
    const outlineRef = (await open(bytes)).catalog.get(PDFName.of('Outlines'));
    expect(outlineRef, 'merge should have written per-file bookmarks').toBeTruthy();

    const again = await run('merge', {}, [fileOf(bytes, 'merged.pdf'), fileOf(await sheets(grid(1)), 'c.pdf')]);
    expect(warn(again)).toMatch(/already had bookmarks/i);

    const nup = await run('n-up', { perSheet: 2, sheetSize: 'a4', landscape: false }, [fileOf(bytes, 'merged.pdf')]);
    expect(warn(nup)).toMatch(/bookmarks are not in the output/i);
    expect(warn(nup)).toMatch(/CoherentPDF/i);
  });

  it('fills a booklet to whole sheets instead of dropping the odd pages (E13)', async () => {
    const source = fileOf(
      await sheets(Array.from({ length: 6 }, (_, i) => ({ width: 150 + i * 10, height: 100 }))),
      'six.pdf',
    );
    const outcome = await run('booklet', { sheetSize: 'a4', landscape: true, blankFill: false }, [source]);
    const doc = await open(await bytesOf(outcome));
    // 6 pages → 8 cells → 2 physical sheets, printed on both sides: four PDF
    // pages of two cells each, and none of the 6 source pages may go missing.
    expect(doc.getPageCount()).toBe(4);
    const seen = doc.getPages().flatMap((_, index) => stampsOf(doc, index).map((stamp) => stamp.bbox.join(' ')));
    expect(new Set(seen).size).toBe(6);
    expect(outcome.message).toMatch(/with 2 pages added/i);
    expect(warn(outcome)).toMatch(/whole sheets.*blank pages were switched off/i);
  });

  it('says when the PDF height limit cuts or splits the scroll (E12)', async () => {
    const tall = fileOf(await sheets(grid(3, { height: 6000 })), 'tall.pdf');
    const split = await run('combine-single-page', { gap: 0, width: 'widest', splitOverflow: true }, [tall]);
    expect(warn(split)).toMatch(/scroll is 2 sheets long because of the 14 400 pt page limit/i);
    const doc = await open(await bytesOf(split));
    expect(doc.getPageCount()).toBe(2);
    for (const page of doc.getPages()) expect(page.getHeight()).toBeLessThanOrEqual(14400);

    const single = await run('combine-single-page', { gap: 0, width: 'widest', splitOverflow: false }, [tall]);
    expect(warn(single)).toMatch(/18000 pt tall, past the 14 400 pt limit/i);
  });

  it('leaves nothing behind when the run is cancelled (E19)', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runPdfTool({
        toolId: 'merge',
        files: [fileOf(await sheets(grid(2)), 'a.pdf'), fileOf(await sheets(grid(2)), 'b.pdf')],
        values: {},
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancelled/i);
  });

  it('counts what it did, in the sentence the result card shows', async () => {
    const outcome = await run('extract-pages', { pages: '2-3', mergeIntoOne: true });
    expect(outcome.message).toBe('Extracted 2 pages of 4 pages.');
    const deleted = await run('remove-pages', { pages: '2' });
    expect(deleted.message).toBe('Removed 1 page, kept 3 pages.');
    const rotated = await run('rotate', { degrees: 180, pages: '1,4' });
    expect(rotated.message).toBe('Rotated 2 pages by 180°, left 2 pages alone.');
  });
});
