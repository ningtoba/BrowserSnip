/**
 * Page-copy fidelity.
 *
 * `collectPages` is the shared page-copy primitive under every organize tool
 * that rebuilds a document instead of editing it in place. This file measures
 * what a copy carries and what it drops, by reading the produced bytes.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { newPDF, openPDF, savePDF, context, PDFName, StandardFonts, rgb } from '@/lib/pdf/core/doc';
import { readOutline, writeOutline, type OutlineNode } from '@/lib/pdf/core/bookmarks';
import { addAttachments, listAttachments } from '@/lib/pdf/core/attachments';
import { addAnnotations, listAnnotations } from '@/lib/pdf/core/annotations';
import { createFormField, listFormFields } from '@/lib/pdf/core/forms';

/**
 * The render seam, doubled.
 *
 * jsdom cannot start the pdf.js worker, so `remove-blank-pages` would abort
 * before it reaches the copy. Blank-ness is decided here from the page's real
 * content stream — an inked sheet paints, the fixture's empty sheet does not —
 * which keeps this a test of what the copy carries. The detection rules
 * themselves belong to `tests/pdf/edge-organize.test.ts`.
 */
vi.mock('@/lib/pdf/core/render', async () => ({
  openRender: async (bytes: Uint8Array) => {
    const { openPDF } = await import('@/lib/pdf/core/doc');
    const doc = await openPDF(bytes, { ignoreEncryption: true });
    return {
      numPages: doc.getPageCount(),
      metadata: async () => ({ info: {}, outlines: 0 }),
      page: async (index: number) => ({ page: doc.getPages()[index - 1] }),
      destroy: async () => {},
      dispose: async () => {},
    };
  },
}));

vi.mock('@/lib/pdf/core/blank', async () => {
  const { pageContentStreams } = await import('@/lib/pdf/core/content');
  return {
    findBlankPages: async (_session: unknown, doc: import('@maxwbh/pdf-lib').PDFDocument) => {
      const profiles = doc.getPages().map((page, index) => {
        const content = pageContentStreams(page)
          .map((stream) => Buffer.from(stream.bytes).toString('latin1'))
          .join('');
        const paints = /\bTj\b|\bTJ\b|\bDo\b|\bre\b|\bf\b|\bS\b/.test(content);
        return {
          page: index + 1,
          textItems: paints ? 1 : 0,
          invisibleTextItems: 0,
          paintOps: paints ? 1 : 0,
          images: 0,
          annotationRects: 0,
          inkArea: paints ? 1 : 0,
          blankByContent: !paints,
          blankByAppearance: !paints,
        };
      });
      return {
        profiles,
        blank: profiles.filter((profile) => profile.blankByContent).map((profile) => profile.page),
      };
    },
  };
});

const utf8 = (text: string) => new Uint8Array([...text].map((c) => c.charCodeAt(0)));

function pdfFile(bytes: Uint8Array, name: string): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}

/** Build the fixture: 4 pages, 2 bookmarks (one nested), 1 attachment, marks, fields. */
async function fixture(): Promise<Uint8Array> {
  const doc = await newPDF();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 4; i++) {
    const page = doc.addPage([595.28, 841.89]);
    if (i === 2) {
      // A sheet that paints nothing but owns a content stream, so the tools that
      // embed pages can still do their work on it.
      page.node.set(PDFName.of('Contents'), context(doc).register(context(doc).stream('q\nQ\n', {})));
      continue;
    }
    page.drawText(`Copy fixture page ${i + 1}`, { x: 60, y: 700, size: 20, font, color: rgb(0, 0, 0) });
  }
  writeOutline(doc, [
    { title: 'Chapter One', page: 0, children: [{ title: 'Section 1.1', page: 1 }] },
    { title: 'Chapter Two', page: 3 },
  ]);
  await addAttachments(doc, [
    { name: 'source.csv', bytes: utf8('a,b\n1,2\n'), mimeType: 'text/csv', description: 'Raw data' },
  ]);
  addAnnotations(doc, [
    { kind: 'Highlight', page: 0, rect: { x: 60, y: 690, width: 220, height: 16 }, quadPoints: [60, 690, 280, 690, 60, 706, 280, 706] },
    { kind: 'Text', page: 1, rect: { x: 500, y: 780, width: 20, height: 20 }, contents: 'a note' },
    { kind: 'Link', page: 1, rect: { x: 60, y: 640, width: 120, height: 16 }, link: { type: 'goTo', page: 2 } },
  ]);
  createFormField(doc, 1, { type: 'text', name: 'applicant', rect: { x: 60, y: 560, width: 200, height: 20 }, value: 'Ada Lovelace' });
  createFormField(doc, 3, { type: 'checkbox', name: 'agree', rect: { x: 60, y: 560, width: 14, height: 14 } });
  return savePDF(doc, { useObjectStreams: false });
}

interface Census {
  pages: number;
  bookmarks: number;
  attachments: number;
  annotations: number;
  fields: number;
}

function countNodes(nodes: OutlineNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children ?? []), 0);
}

async function census(bytes: Uint8Array): Promise<Census> {
  const doc = await openPDF(bytes, { ignoreEncryption: true });
  return {
    pages: doc.getPageCount(),
    bookmarks: countNodes(readOutline(doc)),
    attachments: listAttachments(doc).length,
    annotations: listAnnotations(doc).length,
    fields: listFormFields(doc).length,
  };
}

let source: Uint8Array;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  source = await fixture();
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const face = (file: string): Uint8Array =>
    new Uint8Array(readFileSync(join(process.cwd(), 'public', 'fonts', file)));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const match = /NotoSans-(Regular|Bold)\.ttf$/.exec(url);
    if (!match) return new Response('not found', { status: 404 });
    return new Response(face(`NotoSans-${match[1]}.ttf`), { headers: { 'content-type': 'font/ttf' } });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});


const CASES: { id: string; values: Record<string, unknown>; files?: () => File[] }[] = [
  { id: 'merge', values: { bookmarks: false }, files: () => [pdfFile(source, 'a.pdf'), pdfFile(source, 'b.pdf')] },
  { id: 'split', values: { mode: 'ranges', ranges: '1-3' } },
  { id: 'extract-pages', values: { pages: '2-3', mergeIntoOne: true } },
  { id: 'extract-pages', values: { pages: '2-3', mergeIntoOne: false }, },
  { id: 'remove-pages', values: { pages: '4' } },
  { id: 'organize', values: { pageOrder: '4,1,2,3' } },
  { id: 'rotate', values: { degrees: 90 } },
  { id: 'reverse-pages', values: {} },
  { id: 'duplex-collate', values: {} },
  { id: 'add-blank-page', values: { position: 'after', anchor: 1, count: 1 } },
  { id: 'alternate-merge', values: {}, files: () => [pdfFile(source, 'a.pdf'), pdfFile(source, 'b.pdf')] },
  { id: 'remove-blank-pages', values: {} },
  { id: 'combine-single-page', values: {} },
  { id: 'n-up', values: { perPage: 2 } },
  { id: 'rotate-custom', values: { degrees: 45 } },
  { id: 'fix-page-size', values: { size: 'a4' } },
  { id: 'booklet', values: {} },
  { id: 'posterize', values: {} },
  { id: 'divide-pages', values: {} },
  { id: 'overlay-pdf', values: {}, files: () => [pdfFile(source, 'a.pdf'), pdfFile(source, 'b.pdf')] },
];

async function runCase(id: string, values: Record<string, unknown>, files: File[]) {
  const outcome = await runPdfTool({ toolId: id, files, values, onProgress: () => {}, onLog: () => {} });
  const pdfs = outcome.outputs.filter((o) => o.name.endsWith('.pdf'));
  const bytes = pdfs.length ? new Uint8Array(await pdfs[0].blob.arrayBuffer()) : new Uint8Array();
  return { outcome, bytes };
}

describe('probe', () => {
  it('table', async () => {
    const base = await census(source);
    const rows: string[][] = [];
    rows.push(`BASELINE pages=${base.pages} bookmarks=${base.bookmarks} attachments=${base.attachments} annots=${base.annotations} fields=${base.fields}`);
    for (const c of CASES) {
      const tool = getPdfTool(c.id);
      if (!tool?.run) {
        rows.push(`${c.id} — no run`);
        continue;
      }
      try {
        const { outcome, bytes } = await runCase(c.id, c.values, c.files ? c.files() : [pdfFile(source, 'in.pdf')]);
        const got = bytes.length ? await census(bytes) : { pages: 0, bookmarks: 0, attachments: 0, annotations: 0, fields: 0 };
        rows.push(
          [
            c.id + ' ' + JSON.stringify(c.values),
            `pages ${got.pages}`,
            `bm ${got.bookmarks}/${base.bookmarks}`,
            `att ${got.attachments}/${base.attachments}`,
            `an ${got.annotations}/${base.annotations}`,
            `fd ${got.fields}/${base.fields}`,
            `warn ${outcome.warnings.length}`,
            outcome.warnings.join(' | ').slice(0, 160),
          ].join('  ::  '),
        );
      } catch (err) {
        rows.push(`${c.id} ${JSON.stringify(c.values)}  ::  THREW ${(err as Error).message.slice(0, 120)}`);
      }
    }
    console.log(rows.join('\n'));
    expect(true).toBe(true);
  }, 120000);
});
