/**
 * `form-creator`'s boxes: the one it draws is the one it writes.
 *
 * The pane keeps each draft's rectangle in PDF user space and derives the screen
 * box from it with `rectToOverlay`, which wants the PDF → screen direction. It was
 * handed `view.toPdf` — the opposite direction — so the conversion ran backwards:
 * a box dragged at (100,100) 160×40 on a 420×595 sheet at the pane's opening 130 %
 * was redrawn at (59,196) 95×24, shrunk by the zoom factor again and measured from
 * the wrong end of the page. The file stayed right while the gesture lasted — the
 * pointer writes the box directly — and went wrong the instant the gesture ended:
 * dragging or nudging a placed field rewrote its `/Rect` from the corrupted box, so
 * a field moved 30.8 pt right and 46.2 pt up landed at a different place, 41 %
 * narrower and 41 % shorter, in the shipped file (measured: `/Rect`
 * `[63.1, 511.5, 210.0, 535.4]` → `[68.1, 187.1, 155.0, 201.2]`).
 *
 * Two more things were wrong at the edges of the same surface: a drag begun in the
 * grey beside the sheet (or off the window) reached no pointer handler and produced
 * nothing at all, and the pane's report never reached the screen — setting the output
 * unmounts the pane, so the count of fields written was thrown away with it and the
 * result card showed a file name. Both are pinned here too.
 *
 * The viewport is a double, because the pixels pdf.js paints are pinned elsewhere;
 * what is under test is which direction the pane asks its own viewport for, and
 * what the writer is then handed.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';

const SHEET: [number, number] = [420, 595];
/** The zoom the pane opens at, so a scale of 1 cannot hide a direction error. */
const SCALE = 1.3;
const PAD = 12;
/** Where the sheet is drawn in the frame: `PAD` in from the frame's own corner. */
const SHEET_RECT = {
  x: 40 + PAD,
  y: 20 + PAD,
  left: 40 + PAD,
  top: 20 + PAD,
  width: SHEET[0] * SCALE,
  height: SHEET[1] * SCALE,
  right: 40 + PAD + SHEET[0] * SCALE,
  bottom: 20 + PAD + SHEET[1] * SCALE,
  toJSON: () => ({}),
} as DOMRect;

vi.mock('@/lib/pdf/core/render', () => ({
  openRender: vi.fn(async () => {
    const width = SHEET[0] * SCALE;
    const height = SHEET[1] * SCALE;
    /** pdf.js's own two conversions for an unrotated page: exact inverses. */
    const viewport = {
      width,
      height,
      scale: SCALE,
      rotation: 0,
      convertToPdfPoint: (x: number, y: number) => [x / SCALE, (height - y) / SCALE],
      convertToViewportPoint: (x: number, y: number) => [x * SCALE, height - y * SCALE],
    };
    return {
      numPages: 1,
      fingerprint: 'form-creator-pane',
      page: async () => ({ rotate: 0, getViewport: () => viewport, cleanup() {} }),
      renderPage: async () => {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return { canvas, width, height, finished: Promise.resolve(), cancel() {} };
      },
      destroy: async () => {},
    };
  }),
}));

beforeAll(() => {
  URL.createObjectURL = () => 'blob:probe';
  URL.revokeObjectURL = () => {};
  const real = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function box(this: Element) {
    const element = this as HTMLElement;
    const cls = typeof element.className === 'string' ? element.className : '';
    // The sheet, and the two wrappers that sit exactly on it.
    if (element.tagName === 'CANVAS' || cls.includes('inset-0') || cls.includes('w-fit')) {
      return SHEET_RECT;
    }
    // The scrolling frame around the sheet, which the outside-start case presses on.
    if (cls.includes('overflow-auto')) {
      return { ...SHEET_RECT, x: 40, y: 20, left: 40, top: 20, right: SHEET_RECT.right + 40, bottom: SHEET_RECT.bottom + 40 } as DOMRect;
    }
    return real.call(this);
  };
});

beforeEach(async () => {
  const { PDFDocument } = await import('@maxwbh/pdf-lib');
  const doc = await PDFDocument.create();
  doc.addPage(SHEET);
  const bytes = await doc.save();
  const file = new File([bytes as unknown as BlobPart], 'sheet.pdf', { type: 'application/pdf' });
  act(() => {
    useFileStore.setState({ file, files: [file], metadata: null });
    useProcessStore.setState({ warnings: [], outputBlob: null, outputUrl: null, logs: [], error: null });
  });
});

afterEach(() => {
  cleanup();
  useFileStore.setState({ file: null, files: [], metadata: null });
  vi.clearAllMocks();
});

/** Mount the pane on the loaded sheet and wait for the designer chips. */
async function ready(): Promise<void> {
  const { FormCreatorMain } = await import('@/components/tools/pdf/edit/FormCreatorMain');
  render(<FormCreatorMain />);
  await screen.findByRole('group', { name: 'Field type to place' });
  await waitFor(() => expect(document.querySelector('canvas')).toBeTruthy());
}

/** The overlay the pointer gestures land on. */
function overlay(): HTMLElement {
  const sheet = document.querySelector('canvas')!.parentElement!.parentElement!;
  const node = sheet.querySelector('.absolute.inset-0');
  expect(node, 'no design overlay over the sheet').toBeTruthy();
  return node as HTMLElement;
}

const at = (x: number, y: number) => ({ clientX: SHEET_RECT.left + x, clientY: SHEET_RECT.top + y, pointerId: 1 });

/** Drag on the sheet from one point to another, the way a pointer reports it. */
function drag(target: HTMLElement, from: [number, number], to: [number, number]): void {
  fireEvent.pointerDown(target, at(...from));
  fireEvent.pointerMove(overlay(), at(...to));
  fireEvent.pointerUp(overlay(), at(...to));
}

/** The stored rectangle of the only draft, read off the pane's own inspector. */
function draftRect(): { x: number; y: number; width: number; height: number } {
  const line = (document.body.textContent || '').match(/(\d+) × (\d+) pt at x (\d+), y (\d+)/);
  expect(line, 'the inspector prints no rectangle').toBeTruthy();
  const [, width, height, x, y] = line!;
  return { x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
}

/** The on-screen box the pane gave the only draft, off its own inline style. */
function draftBox(): { left: number; top: number; width: number; height: number } {
  const node = document.querySelector('[role=button][aria-label*="field "]') as HTMLElement;
  expect(node, 'no field was drawn on the sheet').toBeTruthy();
  const { left, top, width, height } = node.style;
  return { left: parseFloat(left), top: parseFloat(top), width: parseFloat(width), height: parseFloat(height) };
}

async function save(): Promise<{ rects: number[][]; names: string[] }> {
  fireEvent.click(screen.getByRole('button', { name: 'Save form' }));
  await waitFor(() => expect(useProcessStore.getState().outputBlob).toBeTruthy());
  const { openPDF } = await import('@/lib/pdf/core/doc');
  const doc = await openPDF(new Uint8Array(await useProcessStore.getState().outputBlob!.arrayBuffer()), {
    updateMetadata: false,
  });
  const rects = doc.getForm().getFields().map((field) => [...Object.values(field.acroField.getWidgets()[0].getRectangle())]);
  const names = doc.getForm().getFields().map((field) => field.getName());
  return { rects, names };
}

describe('a field dragged onto the sheet', () => {
  it('stays where it was dragged instead of sliding down the page and shrinking', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /Text/ }));
    drag(overlay(), [100, 100], [260, 140]);

    // 160 × 40 screen px of a 420 × 595 sheet at 1.3 → 123.1 × 30.8 pt with its
    // top-left 76.9 pt in from the left and 77 pt down from the top.
    const box = draftBox();
    expect(Math.round(box.left)).toBe(100);
    expect(Math.round(box.top)).toBe(100);
    expect(Math.round(box.width)).toBe(160);
    expect(Math.round(box.height)).toBe(40);

    const rect = draftRect();
    expect(rect).toEqual({ x: 77, y: 487, width: 123, height: 31 });
    const { rects, names } = await save();
    expect(names).toEqual(['Text1']);
    // The file's `/Rect` is the PDF-space bottom-left corner of the same box.
    expect(rects[0].map((value: number) => Math.round(value))).toEqual([77, 487, 123, 31]);
  });

  it('keeps that rectangle through a move, so a nudged field does not land elsewhere', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /Text/ }));
    drag(overlay(), [100, 100], [260, 140]);
    const before = draftRect();

    fireEvent.click(screen.getByRole('button', { name: /Select/ }));
    // Grab the middle of the box and move it 40 px right, 60 px down.
    const node = document.querySelector('[role=button][aria-label*="field "]') as HTMLElement;
    fireEvent.pointerDown(node, at(180, 120));
    fireEvent.pointerMove(overlay(), at(220, 180));
    fireEvent.pointerUp(overlay(), at(220, 180));

    const after = draftRect();
    // 40 / 1.3 = 30.8 pt right; 60 / 1.3 = 46.2 pt up in PDF space; same size.
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    expect(after.x - before.x).toBeCloseTo(30.8, 0);
    expect(after.y - before.y).toBeCloseTo(-46.2, 0);
    const { rects } = await save();
    expect(rects[0].map((value: number) => Math.round(value))).toEqual([108, 441, 123, 31]);
  });
});

describe('a drag begun beside the sheet', () => {
  it('starts a field at the paper edge instead of producing nothing', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /Text/ }));
    const frame = document.querySelector('.overflow-auto') as HTMLElement;
    expect(frame, 'no frame around the sheet').toBeTruthy();

    // Press 30 px below the sheet — grey, no handler of its own — and drag up into
    // the paper. Before the frame took the gesture, this produced no draft at all.
    fireEvent.pointerDown(frame, { clientX: SHEET_RECT.left + 100, clientY: SHEET_RECT.bottom + 30, pointerId: 1 });
    fireEvent.pointerMove(overlay(), at(220, SHEET_RECT.height - 40));
    fireEvent.pointerUp(overlay(), at(220, SHEET_RECT.height - 40));

    const box = draftBox();
    // Clamped onto the paper, rounded at the half point.
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.left + box.width).toBeLessThanOrEqual(SHEET_RECT.width + 1);
    expect(box.top + box.height).toBeLessThanOrEqual(SHEET_RECT.height + 1);
    const rect = draftRect();
    // And the rectangle that reaches the file is on the sheet, not off its edge.
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.y + rect.height).toBeLessThanOrEqual(SHEET[1]);
    const { rects } = await save();
    expect(rects).toHaveLength(1);
  });

  it('is a control: a press on the sheet itself behaves the same way', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /Text/ }));
    drag(overlay(), [100, 100], [260, 140]);
    expect(draftBox().width).toBeGreaterThan(100);
  });
});

describe('what the card says afterwards', () => {
  it('counts the fields it wrote, because the pane is gone by the time it would', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /Text/ }));
    drag(overlay(), [100, 100], [260, 140]);
    fireEvent.click(screen.getByRole('button', { name: /Checkbox/ }));
    fireEvent.pointerDown(overlay(), at(100, 200));
    fireEvent.pointerUp(overlay(), at(100, 200));
    await save();
    expect(useProcessStore.getState().warnings).toContain('Added 2 fillable fields. Tab order follows the field list.');
  });

  it('counts two fields as two and adds no line for a run that refused nothing', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /Text/ }));
    drag(overlay(), [100, 100], [260, 140]);
    fireEvent.click(screen.getByRole('button', { name: /Checkbox/ }));
    fireEvent.pointerDown(overlay(), at(100, 300));
    fireEvent.pointerUp(overlay(), at(100, 300));
    const { names } = await save();
    expect(names).toEqual(['Text1', 'Check1']);
    const warnings = useProcessStore.getState().warnings;
    // The count is the run's own, and a clean run adds nothing to it.
    expect(warnings[0]).toBe('Added 2 fillable fields. Tab order follows the field list.');
    expect(warnings).toHaveLength(1);
  });
});
