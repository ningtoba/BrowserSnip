/**
 * The redact pane paints the sheet it was handed — and only once the sheet exists.
 *
 * `RedactMain` shows a loading placeholder until the document is open, and the
 * canvas lives in the loaded branch. Its file-load effect used to size and render
 * that canvas from inside the effect itself: at that moment `loading` is still
 * `true`, so the ref points at nothing, and the first sheet was painted only when
 * the page-change effect happened to run afterwards. Measured twice on the wave
 * build as a preview area holding an unsized 300×150 canvas
 * (`/tmp/seam2b/redact-turn-word.png`: no page at all, the toolbar reading
 * `0 MARKS · 0 REGIONS · DRAG ACROSS WORDS`, `Apply 0 Redactions` disabled), with
 * nothing left to repaint it — the page-change effect bails out on the same null
 * ref and its own dependencies had not changed. Redacting a `/Rotate 90` sheet is
 * where it shows: the drag is measured against a sheet that is not there, and the
 * only way back is a page turn.
 *
 * The paint now belongs to the effect that also runs on the `loading → loaded`
 * transition, so it sizes and renders the canvas it is actually mounted in. The
 * assertions are the whole claim: the canvas carries the sheet's own dimensions and
 * pdf.js was asked to paint into it — for a portrait sheet and for a turned one,
 * because the marks are fractions of the *displayed* page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useFileStore } from '@/stores/file-store';

/**
 * The sheet pdf.js reports, and every paint it was asked for. `getTextContent`
 * answers in a **later task**, the way a worker replies from another thread: a
 * double that resolves in line cannot see the ordering this file pins.
 */
const fake = vi.hoisted(() => ({
  width: 595,
  height: 842,
  painted: [] as { viewport: { width: number; height: number } }[],
}));

vi.mock('pdfjs-dist', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pdfjs-dist')>();
  return {
    ...actual,
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getViewport: ({ scale }: { scale: number }) => ({
            width: fake.width * scale,
            height: fake.height * scale,
            transform: [scale, 0, 0, scale, 0, 0],
          }),
          getTextContent: () => {
            const { promise, resolve } = Promise.withResolvers<{ items: unknown[] }>();
            setTimeout(() => resolve({ items: [] }), 0);
            return promise;
          },
          render: (params: { viewport: { width: number; height: number } }) => {
            fake.painted.push(params);
            return { promise: Promise.resolve({ cancel: () => undefined }) };
          },
        }),
      }),
    }),
  };
});

async function mountSheet(width: number, height: number) {
  fake.width = width;
  fake.height = height;
  const { RedactMain } = await import('@/components/tools/pdf/security/RedactMain');
  const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'sheet.pdf', { type: 'application/pdf' });
  act(() => useFileStore.setState({ file, files: [file] }));
  return render(<RedactMain />);
}

afterEach(() => {
  cleanup();
  fake.painted.length = 0;
  act(() => useFileStore.setState({ file: null, files: [] }));
});

describe('the redact pane paints the sheet it loaded', () => {
  it('sizes the canvas to the page and renders it once the file is open', async () => {
    const { container } = await mountSheet(595, 842);
    await waitFor(() => expect(fake.painted.length, 'pdf.js was never asked to paint').toBeGreaterThan(0),
      { timeout: 5000 });
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    expect(canvas, 'the pane never mounted a canvas').toBeTruthy();
    // The portrait sheet at scale 1: 595 × 842, not the browser default 300 × 150.
    expect(canvas.width, 'the canvas kept its default box').toBe(595);
    expect(canvas.height).toBe(842);
  }, 15000);

  it('sizes it to the displayed sheet on a turned page, which is what marks are fractions of', async () => {
    // pdf.js reports a /Rotate 90 sheet turned (842 × 595). The overlay the drag is
    // measured against has to follow it: a mark kept as a fraction of the unrotated
    // box lands in the wrong band while the bar still paints where the pointer was.
    const { container } = await mountSheet(842, 595);
    await waitFor(() => expect(fake.painted.length, 'the turned sheet never painted').toBeGreaterThan(0),
      { timeout: 5000 });
    const canvas = container.querySelector('canvas') as HTMLCanvasElement;
    expect(canvas.width, 'the turned sheet sized the canvas unturned').toBe(842);
    expect(canvas.height).toBe(595);
    expect(fake.painted[0]!.viewport.width).toBe(842);
  }, 15000);
});
