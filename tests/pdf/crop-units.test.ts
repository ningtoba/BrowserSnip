/**
 * `pdf-crop` and its unit control: does the unit a margin is declared in move the box?
 *
 * Two questions, in the order they were asked.
 *
 * **1. Does the tool convert?** Measured, not read. `docs/TOOL-CAMPAIGN.md`'s routing
 * pass found the card offering "points, mm or inches" while the panel pins
 * `unit: 'pt'`, and `docs/research/inert-field-sweep.md` left the field as a backlog
 * item. The byte diff the sweep asked for is section 1: one physical region declared
 * four ways — 21.6/28.8/43.2/57.6 pt, the same edges as 7.62/10.16/15.24/20.32 mm,
 * 0.762/1.016/1.524/2.032 cm and 0.3/0.4/0.6/0.8 in — through the shipped `run`, and
 * the four `/MediaBox`/`/CropBox` arrays come back identical. So `run` converts for
 * real; the control was never a wrong conversion, it was a control nobody could reach.
 *
 * The fixture is deliberately hostile to the classic mistakes. The pages are
 * **non-square** and the box is **asymmetric on all four sides**, so a top/left
 * transposition cannot cancel itself out the way it does on a square sheet; the first
 * page's `/MediaBox` does not start at the origin, so a conversion that forgets the box
 * origin lands on a different number; one sheet carries `/Rotate 90`, because a margin
 * re-aimed by the preview instead of the stored box moves the file; and the document
 * also holds an A4 and a US Letter sheet, since 72 pt-per-inch against 25.4
 * mm-per-inch mixed up reads plausible on one of those two and wrong on the other.
 *
 * **2. Can a user reach it?** Section 2 drives the panel that the route actually
 * mounts. Before this file, `CropTool` converted the dragged rectangle to points,
 * pinned `unit: 'pt'` in its own `run` override and showed the four margins as
 * read-only numbers — so the card's "type exact margins in points, mm or inches"
 * named two things the page did not have. The panel now renders the definition's own
 * `unit` select, takes typed margins in that unit, and forwards both; the numbers it
 * predicts are the numbers an outside reader finds in the file (the paired
 * `docs/research/crop-units-read.py` read of the same bytes).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { PDFDocument, degrees } from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { openPDF } from '@/lib/pdf/core/doc';
import { PT_PER, type LengthUnit } from '@/lib/pdf/core/pages';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import CropTool from '@/components/tools/pdf/edit/CropTool';
import { getCropRect, setCropRect } from '@/components/tools/pdf/edit/CropMain';

/**
 * One region, declared four ways: `[unit, top, right, bottom, left]`.
 *
 * The four numbers are pairwise distinct and each is exact in every unit, so the
 * equality below cannot be bought by rounding: 21.6 pt is 7.62 mm is 0.762 cm is
 * 0.3 in, because an inch is 72 pt and 25.4 mm. A transposed pair (top against left)
 * is a different number on every edge.
 */
const REGION: [LengthUnit, number, number, number, number][] = [
  ['pt', 21.6, 28.8, 43.2, 57.6],
  ['mm', 7.62, 10.16, 15.24, 20.32],
  ['cm', 0.762, 1.016, 1.524, 2.032],
  ['in', 0.3, 0.4, 0.6, 0.8],
];

/** The same region in points, which is what the page box is written in. */
const REGION_PT = { top: 21.6, right: 28.8, bottom: 43.2, left: 57.6 };

/**
 * The sheets, in the frame `pdf-crop` writes: origin x, origin y, width, height,
 * `/Rotate`.
 *
 * Their `width + height` is 1470 / 1437.17 / 1404 / 1100 — close enough that a box
 * built from the wrong pair of edges lands on numbers a reader would not glance at
 * twice, and the per-edge expectation below is what notices. The last sheet is stored
 * portrait and displayed landscape: the tool's own note promises the margins are
 * applied to each page's own box, so `/Rotate` must not move them, and the same
 * equality has to hold in all four units on a turned page.
 */
const SHEETS: [number, number, number, number, number][] = [
  [18, 24, 500, 970, 0],
  [0, 0, 595.28, 841.89, 0],
  [0, 0, 612, 792, 0],
  [0, 0, 400, 700, 90],
];

/** The box one `REGION` crop leaves of one `SHEET`, computed from the inches, not from the tool. */
function expectedBox([ox, oy, width, height]: [number, number, number, number, number]): number[] {
  const { top, right, bottom, left } = REGION_PT;
  const at = (value: number) => Math.round(value * 100) / 100;
  return [ox + left, oy + bottom, ox + width - right, oy + height - top].map(at);
}

/**
 * A four-sheet document: an offset non-square page, A4, US Letter, and a turned one.
 *
 * Mixed sizes are also the case the tool's own note promises — "margins are applied
 * per page in the page's own units" — so the per-sheet expectation above is checked
 * sheet by sheet rather than once.
 */
async function sheets(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const [x, y, width, height, rotation] of SHEETS) {
    const page = doc.addPage([width, height]);
    page.setMediaBox(x, y, width, height);
    page.setCropBox(x, y, width, height);
    if (rotation) page.setRotation(degrees(rotation));
  }
  return doc.save({ useObjectStreams: false });
}

function file(bytes: Uint8Array, name = 'sheets.pdf'): File {
  return new File([new Uint8Array(bytes) as BlobPart], name, { type: 'application/pdf' });
}

/** Both page boxes of every page, as the file holds them, at the file's own precision. */
async function boxesOf(bytes: Uint8Array): Promise<number[][][]> {
  const doc = await openPDF(bytes);
  // pdf-lib writes a page box with two decimals, so a comparison at full double
  // precision would be a comparison of `595.28 - 28.8` against `566.48` — a rounding
  // difference of one part in ten million, not a finding. Everything below is judged
  // at the precision the bytes actually carry.
  const at = (value: number) => Math.round(value * 100) / 100;
  return doc.getPages().map((page) => {
    const media = page.getMediaBox();
    const crop = page.getCropBox();
    return [
      [media.x, media.y, media.x + media.width, media.y + media.height].map(at),
      [crop.x, crop.y, crop.x + crop.width, crop.y + crop.height].map(at),
    ];
  });
}

/** One run of the shipped tool, with the rail's defaults behind the typed values. */
async function crop(
  source: Uint8Array,
  values: Record<string, unknown>,
): Promise<{ bytes: Uint8Array; message: string }> {
  const outcome = await runPdfTool({
    toolId: 'pdf-crop',
    files: [file(source)],
    values,
    onProgress: () => undefined,
    onLog: () => undefined,
  });
  expect(outcome, 'the crop produced no outcome').toBeTruthy();
  const blob = outcome!.outputs[0]?.blob;
  expect(blob, outcome!.message ?? 'the crop produced no file').toBeTruthy();
  return { bytes: new Uint8Array(await blob!.arrayBuffer()), message: outcome!.message ?? '' };
}

function resetStores(): void {
  cleanup();
  useProcessStore.getState().reset();
  useProcessStore.setState({ activeTool: null, sessions: {}, notice: null });
  useFileStore.setState({ file: null, files: [], metadata: null, activeTool: null, sessions: {} });
}

/** The panel's per-edge box, by the edge it names. */
function marginInput(edge: string): HTMLInputElement {
  const field = document.querySelector(`[data-crop-margin="${edge}"]`) as HTMLInputElement | null;
  expect(field, `the crop panel offers no ${edge} margin field`).toBeTruthy();
  return field!;
}

const unitSelect = (): HTMLSelectElement =>
  document.querySelector('#tool-field-unit') as HTMLSelectElement;

beforeAll(() => {
  URL.createObjectURL = () => 'blob:crop-units';
  URL.revokeObjectURL = () => undefined;
});

afterEach(resetStores);

// ══ 1. the tool converts: one region, four spellings, one box ══════════════

describe('pdf-crop writes the same box whatever unit the margins were declared in', () => {
  /** The four produced files, keyed by unit, for the outside reader. */
  const produced = new Map<string, { bytes: Uint8Array; boxes: number[][][]; message: string }>();

  it('agrees sheet by sheet, and the agreement is not vacuous', async () => {
    const source = await sheets();
    for (const [unit, top, right, bottom, left] of REGION) {
      const run = await crop(source, { unit, top, right, bottom, left, pages: 'all' });
      produced.set(unit, { ...run, boxes: await boxesOf(run.bytes) });
      writeFileSync(resolve(process.cwd(), `docs/research/crop-units-${unit}.pdf`), run.bytes);
    }
    const units = REGION.map(([unit]) => unit);
    expect(units.map((unit) => produced.get(unit)!.boxes)).toEqual(
      units.map(() => SHEETS.map((sheet) => [expectedBox(sheet), expectedBox(sheet)])),
    );

    // The trap this whole check exists for: the same *digits*, a different unit, are
    // a different region. If reading the unit as points made no difference, the
    // equality above would be a tautology about a field nobody reads. The control is
    // judged with a tolerance rather than `not.toEqual` on raw arrays, so it cannot
    // pass on floating-point noise: the two crops have to differ by whole points.
    const mm = REGION.find(([unit]) => unit === 'mm')!;
    const misread = await crop(source, { unit: 'pt', top: mm[1], right: mm[2], bottom: mm[3], left: mm[4], pages: 'all' });
    const misreadBoxes = await boxesOf(misread.bytes);
    const asMm = produced.get('mm')!.boxes;
    expect(
      Math.abs(misreadBoxes[0]![0]![0]! - asMm[0]![0]![0]!),
      'reading the millimetres as points moved the box by no more than the file’s own rounding',
    ).toBeGreaterThan(1);
    // 7.62 pt off the top, not the 21.6 pt 7.62 mm is worth.
    expect(misread.message).toContain('7.6/10.2/15.2/20.3 pt');
    expect(produced.get('mm')!.message).toContain('21.6/28.8/43.2/57.6 pt');
    expect(produced.get('mm')!.message).toContain('the 7.62/10.16/15.24/20.32 mm you entered, converted');
    expect(produced.get('pt')!.message).not.toMatch(/converted/);
  }, 180_000);

  it('keeps the aspect of the mistake in mind: a height is never a width', async () => {
    // The four numbers are pairwise distinct on purpose. Re-aiming them (top→left)
    // or transposing the page's own extent leaves the *area* plausible and the box
    // wrong, which is why the assertion is per edge rather than per sheet.
    expect(new Set(Object.values(REGION_PT)).size).toBe(4);
    const source = await sheets();
    const straight = await crop(source, {
      unit: 'pt',
      top: REGION_PT.top,
      right: REGION_PT.right,
      bottom: REGION_PT.bottom,
      left: REGION_PT.left,
      pages: 'all',
    });
    const swapped = await crop(source, {
      unit: 'pt',
      top: REGION_PT.left,
      right: REGION_PT.bottom,
      bottom: REGION_PT.right,
      left: REGION_PT.top,
      pages: 'all',
    });
    const straightBoxes = await boxesOf(straight.bytes);
    expect(straightBoxes).toEqual(SHEETS.map((sheet) => [expectedBox(sheet), expectedBox(sheet)]));
    // The swapped run is a whole 36 pt apart on the first corner it is asked about:
    // 57.6 pt off the stored left in place of the 21.6 pt the top was worth.
    const swappedBoxes = await boxesOf(swapped.bytes);
    expect(Math.abs(swappedBoxes[0]![0]![0]! - straightBoxes[0]![0]![0]!)).toBeGreaterThan(30);
    expect(swappedBoxes).not.toEqual(straightBoxes);
  }, 180_000);

  it('declares the unit as a control, since the card names it', () => {
    const tool = getPdfTool('pdf-crop');
    const field = (tool?.fields ?? []).find((entry) => entry.key === 'unit');
    expect(field?.type).toBe('select');
    expect((field?.options ?? []).map((option) => option.value)).toEqual(['pt', 'mm', 'cm', 'in']);
    // Every option the select offers must be a unit the conversion knows.
    for (const option of field?.options ?? []) {
      expect(PT_PER, `${option.value} is not a convertible unit`).toHaveProperty(String(option.value));
    }
  });
});

// ══ 2. the panel offers it ═════════════════════════════════════════════════

describe('the crop panel lets a margin be declared in the unit the card names', () => {
  /** A single 500 × 900 sheet: non-square, so top and left cannot trade places. */
  async function oneSheet(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.addPage([500, 900]);
    return doc.save({ useObjectStreams: false });
  }

  async function mountPanel(bytes: Uint8Array): Promise<void> {
    act(() => setCropRect({ top: 0, right: 0, bottom: 0, left: 0 }));
    render(createElement(CropTool));
    act(() => {
      useFileStore.setState({ file: file(bytes), files: [file(bytes)] });
    });
    // The panel measures the document before it can turn a typed margin into a
    // fraction of it, so the geometry line is the signal that the fields are live.
    await waitFor(() => {
      expect(document.querySelector('[data-crop-doc-pages="1"]')).toBeTruthy();
    });
  }

  it('renders the definition’s own unit select and states what the file will hold', async () => {
    await mountPanel(await oneSheet());
    const select = unitSelect();
    expect(select, 'the panel offers no unit control').toBeTruthy();
    // The select is the field, not a copy of it: same label, same options.
    expect(document.body.textContent).toMatch(/Margins are in/);
    expect([...select.options].map((option) => option.value)).toEqual(['pt', 'mm', 'cm', 'in']);
    expect(select.value).toBe('pt');

    act(() => fireEvent.change(marginInput('top'), { target: { value: '20' } }));
    act(() => fireEvent.change(marginInput('right'), { target: { value: '10' } }));
    act(() => fireEvent.change(marginInput('bottom'), { target: { value: '30' } }));
    act(() => fireEvent.change(marginInput('left'), { target: { value: '40' } }));

    expect(marginInput('top').value).toBe('20');
    // The numbers that go into the file, spelled the way the file spells them.
    const written = document.querySelector('[data-crop-written-pt]');
    expect(written?.textContent).toMatch(/20\/10\/30\/40/);

    // Switching the display unit re-states the same crop; it does not move it.
    act(() => fireEvent.change(select, { target: { value: 'mm' } }));
    expect(unitSelect().value).toBe('mm');
    const asMm = expect(
      (['top', 'right', 'bottom', 'left'] as const).map((edge) => Number(marginInput(edge).value)),
    );
    asMm.toEqual([20 / PT_PER.mm, 10 / PT_PER.mm, 30 / PT_PER.mm, 40 / PT_PER.mm].map((v) => Number(v.toFixed(4))));
    expect(document.querySelector('[data-crop-written-pt]')?.textContent).toMatch(/20\/10\/30\/40/);
    expect(getCropRect().top).toBeCloseTo(20 / 900, 6);
  }, 180_000);

  it('sends the margins in the chosen unit, and the box is the millimetres asked for', async () => {
    const source = await oneSheet();
    await mountPanel(source);
    act(() => fireEvent.change(unitSelect(), { target: { value: 'mm' } }));
    // 5 / 10 / 15 / 20 mm = 14.2 / 28.3 / 42.5 / 56.7 pt of a 500 × 900 sheet.
    const typed: [string, string][] = [['top', '5'], ['right', '10'], ['bottom', '15'], ['left', '20']];
    for (const [edge, value] of typed) {
      act(() => fireEvent.change(marginInput(edge), { target: { value } }));
    }
    expect(document.querySelector('[data-crop-written-pt]')?.textContent).toMatch(/14\.2\/28\.3\/42\.5\/56\.7/);

    const button = document.getElementById('tool-process-btn') as HTMLButtonElement;
    expect(button.disabled, 'the panel disabled its own crop').toBe(false);
    await act(async () => {
      fireEvent.click(button);
      await new Promise((done) => setTimeout(done, 3000));
    });
    const store = useProcessStore.getState();
    expect(store.outputBlob, store.error ?? 'the run produced no file').toBeTruthy();
    const bytes = new Uint8Array(await store.outputBlob!.arrayBuffer());
    writeFileSync(resolve(process.cwd(), 'docs/research/crop-units-panel.pdf'), bytes);
    expect(store.statusMessage).toContain('the 5/10/15/20 mm you entered, converted');

    const [[media]] = await boxesOf(bytes);
    // x from the left margin, y from the bottom margin: the two are not swappable.
    expect(media![0]).toBeCloseTo(56.7, 1);
    expect(media![1]).toBeCloseTo(42.5, 1);
    expect(media![2]).toBeCloseTo(500 - 28.3, 1);
    expect(media![3]).toBeCloseTo(900 - 14.2, 1);
  }, 180_000);
});
