/**
 * `renderPage`'s `annotations` option, pinned at the pdf.js call boundary.
 *
 * A pane that draws its own control over every widget must not have pdf.js paint
 * the widget's stored appearance underneath it: the form-filling pane showed a
 * dropdown's old "Alpha" through the "Beta" typed beside it, and the flatten
 * result agreed with the ghost rather than the answer.
 *
 * jsdom has no PDF engine, so `pdfjs-dist` is doubled here and the one fact under
 * test is the argument that reaches `page.render`. A synchronous double is enough
 * because nothing here is about the paint landing — that race is pinned in
 * `colour-tools-ink.test.ts`.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ renders: [] as Record<string, unknown>[] }));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 1,
      fingerprints: ['annotations-fixture'],
      getPage: async () => ({
        rotate: 0,
        getViewport: ({ scale }: { scale: number }) => ({ width: 200 * scale, height: 300 * scale, scale }),
        getTextContent: async () => ({ items: [] }),
        cleanup: () => {},
        render: (params: Record<string, unknown>) => {
          seen.renders.push(params);
          return { promise: Promise.resolve(), cancel: () => {}, onContinue: () => {} };
        },
      }),
      getMetadata: async () => ({ info: {} }),
      getFieldObjects: async () => null,
      getOutline: async () => null,
      destroy: async () => {},
    }),
  }),
}));

beforeEach(() => {
  seen.renders = [];
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ fillRect: vi.fn(), save: vi.fn(), restore: vi.fn() })) as never;
});

import { openRender } from '@/lib/pdf/core/render';
import { paintOverlayPage } from '@/components/tools/pdf/edit/FormFillMain';

describe('renderPage annotation paint', () => {
  it('paints annotations unless the caller says otherwise', async () => {
    const session = await openRender(new Uint8Array([1]));
    await session.renderPage(1, 1);
    expect(seen.renders).toHaveLength(1);
    expect(seen.renders[0].annotationMode).toBeUndefined();
  });

  it('passes annotationMode 0 when `annotations: false`', async () => {
    const session = await openRender(new Uint8Array([1]));
    await session.renderPage(1, 1, { annotations: false });
    expect(seen.renders).toHaveLength(1);
    // pdf.js's AnnotationMode.DISABLE.
    expect(seen.renders[0].annotationMode).toBe(0);
  });

  it('still paints annotations when the option is explicitly true', async () => {
    const session = await openRender(new Uint8Array([1]));
    await session.renderPage(1, 1, { annotations: true });
    expect(seen.renders[0].annotationMode).toBeUndefined();
  });
});

describe('the form-filling pane uses it', () => {
  it('asks for the page without annotation ink, at the scale it was given', async () => {
    const calls: { page: number; scale: number; opts?: { annotations?: boolean } }[] = [];
    const session = {
      renderPage: async (page: number, scale: number, opts?: { annotations?: boolean }) => {
        calls.push({ page, scale, opts });
        return {} as never;
      },
    };
    await paintOverlayPage(session, 3, 1.4);
    expect(calls).toEqual([{ page: 3, scale: 1.4, opts: { annotations: false } }]);
  });
});
