/**
 * Page-copy fidelity.
 *
 * `collectPages` / `carryPageFurniture` in `core/doc.ts` is the shared page-copy
 * primitive under every organize tool that rebuilds a document instead of editing
 * it in place. This file measures the produced **bytes** of each of those tools —
 * the outline read back out of the file, the `/EmbeddedFiles` tree, the annotation
 * and field lists — never the report line, because a confident sentence about a
 * file that does not contain it is exactly how this bug shipped.
 *
 * ## The surface, measured before the fix
 *
 * One fixture: 4 pages, 3 bookmarks (`Chapter One` p1 with a nested `Section 1.1`
 * p2, and `Chapter Two` p4), 1 attachment `source.csv`, 3 marks + 2 widget
 * annotations, 2 form fields. Baseline reads `pages 4, bookmarks 3, attachments 1,
 * annotations 5, fields 2`.
 *
 * | tool (args)                       | path       | bookmarks | attach | annots | fields | said anything |
 * | --------------------------------- | ---------- | --------- | ------ | ------ | ------ | ------------- |
 * | merge (bookmarks off, 2 files)    | copy       | 0 / 3     | 0 / 1  | 10/5   | 0 / 2  | outline only  |
 * | split (ranges 1-3)                | copy       | 0 / 3     | 0 / 1  | 4 /5   | 0 / 2  | pages only    |
 * | extract-pages (2-3, merged)       | copy       | 0 / 3     | 0 / 1  | 3 /5   | 0 / 2  | **silent**    |
 * | extract-pages (2-3, per page)     | copy       | 0 / 3     | 0 / 1  | 3 /5   | 0 / 2  | **silent**    |
 * | remove-pages (4)                  | copy       | 0 / 3     | 0 / 1  | 4 /5   | 0 / 2  | **silent**    |
 * | organize (4,1,2,3)                | copy       | 0 / 3     | 0 / 1  | 5 /5   | 0 / 2  | bookmarks, and a **false** claim that 5 annotations were lost |
 * | reverse-pages                     | copy       | 0 / 3     | 0 / 1  | 5 /5   | 0 / 2  | bookmarks only |
 * | duplex-collate                    | copy       | 0 / 3     | 0 / 1  | 5 /5   | 0 / 2  | **silent**    |
 * | add-blank-page (after 1)          | copy       | 0 / 3     | 0 / 1  | 5 /5   | 0 / 2  | **silent**    |
 * | alternate-merge (2 files)         | copy       | 0 / 3     | 0 / 1  | 10/5   | 0 / 2  | **silent**    |
 * | remove-blank-pages                | copy       | 0 / 3     | 0 / 1  | 5 /5   | 0 / 2  | **silent**    |
 * | combine-single-page               | redraw     | 0 / 3     | 0 / 1  | 0 /5   | 0 / 2  | annots + bookmarks |
 * | n-up, booklet, posterize,         | redraw     | 0 / 3     | 0 / 1  | 0 /5   | 0 / 2  | annots + bookmarks |
 * | divide-pages, fix-page-size,      |            |           |        |        |        | (attachments and fields silent) |
 * | rotate-custom                     | redraw     | 0 / 3     | 0 / 1  | 0 /5   | 0 / 2  | as above      |
 * | rotate (90°)                      | in place   | 3 / 3     | 1 / 1  | 5 /5   | 2 / 2  | nothing to say |
 * | overlay-pdf                       | in place   | 3 / 3     | 1 / 1  | 5 /5   | 2 / 2  | nothing to say |
 *
 * So the drop was wider than the two known cases: **every** rebuilding tool lost
 * the outline and the embedded file, the redraw tools lost them too and said
 * nothing about either, the form-field list went in all eighteen runs without one
 * of them mentioning it, and the reordering tool over-claimed a loss (`copyPages`
 * does carry a page's annotations — 5 of 5 travelled even while 0 of 3 bookmarks
 * did).
 *
 * ## After the fix
 *
 * The copy re-points the bookmarks whose pages travelled and carries the embedded
 * files; a bookmark aimed at a page that is not in the output is dropped and
 * counted out loud. `rotate` and `overlay-pdf` stay in place on an unencrypted
 * file, so they lose nothing. The redraw tools still cannot take page furniture
 * with them — now they say so, with counts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PDFDocument } from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool, type RunOutcome } from '@/lib/pdf/tools/runner';
import {
  context,
  newPDF,
  openPDF,
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFRef,
  PDFString,
  savePDF,
  StandardFonts,
  rgb,
} from '@/lib/pdf/core/doc';
import { countOutlineNodes, readOutline, writeOutline } from '@/lib/pdf/core/bookmarks';
import { addAttachments, listAttachments, md5Hex } from '@/lib/pdf/core/attachments';
import { addAnnotations, listAnnotations } from '@/lib/pdf/core/annotations';
import { createFormField, listFormFields } from '@/lib/pdf/core/forms';

/**
 * The render seam, doubled.
 *
 * jsdom cannot start the pdf.js worker, so `remove-blank-pages` would abort long
 * before it reached the copy. Blank-ness is decided from the page's real content
 * stream — an inked sheet paints, the fixture's empty sheet does not — which
 * keeps this a test of what the copy carries. The detection rules themselves
 * belong to `tests/pdf/edge-organize.test.ts`.
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
    };
  },
}));

vi.mock('@/lib/pdf/core/blank', async () => {
  const { pageContentStreams } = await import('@/lib/pdf/core/content');
  return {
    findBlankPages: async (_session: unknown, doc: PDFDocument) => {
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

/** SAFETY: a fresh `Uint8Array` copy is a valid `BlobPart`. */
const fileOf = (bytes: Uint8Array, name: string): File =>
  new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });

const PAYLOAD = utf8('id,name\n1,Ada Lovelace\n');

/**
 * The fixture the finding describes: two bookmarks (one nested), one embedded
 * file — plus the neighbours of the bug, a highlight, a note, a link and two
 * fillable fields, so a copy that carries some furniture and not others cannot
 * hide behind a partial check.
 */
async function fixture(): Promise<Uint8Array> {
  const doc = await newPDF();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 4; i++) {
    const page = doc.addPage([595.28, 841.89]);
    if (i === 2) {
      // Paints nothing, but owns a content stream so the page-embedding tools
      // have something to work with.
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
    { name: 'source.csv', bytes: PAYLOAD, mimeType: 'text/csv', description: 'Raw data' },
  ]);
  addAnnotations(doc, [
    {
      kind: 'Highlight',
      page: 0,
      rect: { x: 60, y: 690, width: 220, height: 16 },
      quadPoints: [60, 690, 280, 690, 60, 706, 280, 706],
    },
    { kind: 'Text', page: 1, rect: { x: 500, y: 780, width: 20, height: 20 }, contents: 'a note' },
    { kind: 'Link', page: 1, rect: { x: 60, y: 640, width: 120, height: 16 }, link: { type: 'goTo', page: 2 } },
  ]);
  createFormField(doc, 1, {
    type: 'text',
    name: 'applicant',
    rect: { x: 60, y: 560, width: 200, height: 20 },
    value: 'Ada Lovelace',
  });
  createFormField(doc, 3, { type: 'checkbox', name: 'agree', rect: { x: 60, y: 560, width: 14, height: 14 } });
  return savePDF(doc, { useObjectStreams: false });
}

/** The whole fixture census, read out of the bytes. */
interface Census {
  pages: number;
  /** `title → 0-based destination page`, nested nodes included. */
  bookmarks: Map<string, number | null>;
  bookmarkCount: number;
  attachments: { name: string; bytes: Uint8Array; mimeType?: string; description?: string }[];
  annotations: number;
  fields: number;
  /** `/Outlines` really is in the saved catalog. */
  outlinesKey: boolean;
  /** `/Names → /EmbeddedFiles` really is in the saved catalog. */
  embeddedFilesKey: boolean;
}

/** A dictionary whether it is inline or behind a reference. */
function dict(doc: PDFDocument, value: unknown): PDFDict | undefined {
  const resolved = value instanceof PDFRef ? context(doc).lookup(value) : value;
  return resolved instanceof PDFDict ? resolved : undefined;
}

async function census(bytes: Uint8Array): Promise<Census> {
  const doc = await openPDF(bytes, { ignoreEncryption: true });
  const bookmarks = new Map<string, number | null>();
  const walk = (nodes: ReturnType<typeof readOutline>) => {
    for (const node of nodes) {
      bookmarks.set(node.title, node.page);
      walk(node.children ?? []);
    }
  };
  walk(readOutline(doc));
  // Read the structures the finding is about straight off the catalog of the
  // saved file, not through a convenience reader: `/Outlines`, and the
  // `/EmbeddedFiles` name tree with its keys.
  const catalog = doc.catalog;
  const names = dict(doc, catalog.get(PDFName.of('Names')));
  const tree = dict(doc, names?.get(PDFName.of('EmbeddedFiles')));
  const keys: string[] = [];
  const collect = (node: PDFDict | undefined): void => {
    if (!node) return;
    // A name tree is `/Names [key value …]` pairs, `/Kids` subtrees, or both.
    const pairs = node.get(PDFName.of('Names'));
    if (pairs instanceof PDFArray) {
      for (let i = 0; i + 1 < pairs.size(); i += 2) keys.push(text(pairs.get(i)) ?? String(pairs.get(i)));
    }
    const kids = node.get(PDFName.of('Kids'));
    if (kids instanceof PDFArray) {
      for (let i = 0; i < kids.size(); i += 1) collect(dict(doc, kids.get(i)));
    }
  };
  collect(tree);
  return {
    pages: doc.getPageCount(),
    bookmarks,
    bookmarkCount: countOutlineNodes(readOutline(doc)),
    attachments: listAttachments(doc).map((entry) => ({
      name: entry.name,
      bytes: entry.bytes,
      mimeType: entry.mimeType,
      description: entry.description,
    })),
    annotations: listAnnotations(doc).length,
    fields: listFormFields(doc).length,
    outlinesKey: dict(doc, catalog.get(PDFName.of('Outlines'))) !== undefined,
    embeddedFilesKey: keys.some((key) => key.includes('source.csv')),
  };
}

/** The text a PDF string object carries, direct or behind a reference. */
function text(value: unknown): string | undefined {
  const resolved = value instanceof PDFRef ? undefined : value;
  return resolved instanceof PDFString || resolved instanceof PDFHexString
    ? resolved.decodeText()
    : undefined;
}

/** The bookmark titles a copy is expected to have kept, whatever their page. */
function kept(bookmarks: Map<string, number | null>, titles: string[]): boolean {
  return titles.every((title) => bookmarks.has(title));
}

let source: Uint8Array;
let baseline: Census;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  source = await fixture();
  baseline = await census(source);
  // `core/fonts` lazily fetches the bundled Unicode faces by URL, and jsdom has
  // no static server to answer for them.
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const face = (name: string): Uint8Array =>
    new Uint8Array(readFileSync(join(process.cwd(), 'public', 'fonts', name)));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const match = /NotoSans-(Regular|Bold)\.ttf$/.exec(String(input));
    if (!match) return new Response('not found', { status: 404 });
    return new Response(face(`NotoSans-${match[1]}.ttf`), { headers: { 'content-type': 'font/ttf' } });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

async function run(
  id: string,
  values: Record<string, unknown> = {},
  files: File[] = [fileOf(source, 'fixture.pdf')],
): Promise<RunOutcome> {
  const tool = getPdfTool(id);
  expect(tool, `tool "${id}" is not registered`).toBeTruthy();
  const outcome = await runPdfTool({ toolId: id, files, values, onProgress: () => {}, onLog: () => {} });
  expect(outcome, `${id} produced no outcome`).toBeTruthy();
  return outcome!;
}

async function pdfBytes(outcome: RunOutcome, index = 0): Promise<Uint8Array> {
  const pdfs = outcome.outputs.filter((output) => output.name.endsWith('.pdf'));
  expect(pdfs.length, `${outcome.message} produced no PDF`).toBeGreaterThan(index);
  return new Uint8Array(await pdfs[index].blob.arrayBuffer());
}

const warned = (outcome: RunOutcome, pattern: RegExp): boolean =>
  outcome.warnings.some((line) => pattern.test(line));

describe('the fixture, and the seam it is measured through', () => {
  it('carries everything a copy can lose', async () => {
    expect(baseline.pages).toBe(4);
    expect(baseline.bookmarkCount).toBe(3);
    expect([...baseline.bookmarks.keys()].sort()).toEqual(['Chapter One', 'Chapter Two', 'Section 1.1']);
    expect(baseline.bookmarks.get('Chapter One')).toBe(0);
    expect(baseline.bookmarks.get('Section 1.1')).toBe(1);
    expect(baseline.bookmarks.get('Chapter Two')).toBe(3);
    expect(baseline.attachments).toHaveLength(1);
    expect(Array.from(baseline.attachments[0].bytes)).toEqual(Array.from(PAYLOAD));
    expect(baseline.annotations).toBe(5); // 3 marks + 2 widget annotations
    expect(baseline.fields).toBe(2);
    // The names really are in the file, not just in the reader's view of it.
    expect(baseline.embeddedFilesKey).toBe(true);
    expect(baseline.outlinesKey).toBe(true);
  });
});

describe('page-copy tools — the outline and the embedded file survive', () => {
  it('merge (per-file bookmarks off) carries both sources’ bookmarks and one attachment', async () => {
    const outcome = await run('merge', { bookmarks: false }, [
      fileOf(source, 'a.pdf'),
      fileOf(source, 'b.pdf'),
    ]);
    const got = await census(await pdfBytes(outcome));
    expect(got.pages).toBe(8);
    // Three from each file, re-pointed at where that file's pages landed.
    expect(got.bookmarkCount).toBe(6);
    expect(got.outlinesKey).toBe(true);
    // Same name in both inputs: the first is kept and the collision is admitted.
    expect(got.embeddedFilesKey).toBe(true);
    expect(got.attachments.map((entry) => entry.name)).toEqual(['source.csv']);
    expect(Array.from(got.attachments[0].bytes)).toEqual(Array.from(PAYLOAD));
    expect(warned(outcome, /shared a name with one already carried/i)).toBe(true);
  });

  it('merge (per-file bookmarks on) keeps its own tree and still carries the attachment', async () => {
    const outcome = await run('merge', { bookmarks: true }, [
      fileOf(source, 'a.pdf'),
      fileOf(source, 'b.pdf'),
    ]);
    const got = await census(await pdfBytes(outcome));
    expect([...got.bookmarks.keys()].sort()).toEqual(['a.pdf', 'b.pdf']);
    expect(got.bookmarks.get('a.pdf')).toBe(0);
    expect(got.bookmarks.get('b.pdf')).toBe(4);
    expect(got.embeddedFilesKey).toBe(true);
    expect(Array.from(got.attachments[0].bytes)).toEqual(Array.from(PAYLOAD));
    expect(warned(outcome, /own tree was left behind/i)).toBe(true);
  });

  it('split keeps the bookmarks each range can actually reach and says what fell out', async () => {
    const outcome = await run('split', { mode: 'ranges', ranges: '1-3' });
    const got = await census(await pdfBytes(outcome));
    expect(got.pages).toBe(3);
    expect(kept(got.bookmarks, ['Chapter One', 'Section 1.1'])).toBe(true);
    expect(got.bookmarks.has('Chapter Two')).toBe(false);
    // Nothing points at a page the file does not have.
    expect([...got.bookmarks.values()].every((page) => page === null || page < got.pages)).toBe(true);
    expect(got.bookmarkCount).toBe(2);
    // Page 4 went into no file at all, so its bookmark is a loss the run owns.
    let acrossFiles = 0;
    for (let i = 0; i < outcome.outputs.length; i += 1) {
      acrossFiles += (await census(await pdfBytes(outcome, i))).bookmarkCount;
    }
    expect(acrossFiles).toBe(2);
    expect(got.embeddedFilesKey).toBe(true);
    expect(Array.from(got.attachments[0].bytes)).toEqual(Array.from(PAYLOAD));
    expect(warned(outcome, /1 of this document's 3 bookmarks pointed at a page that is not in this output/i)).toBe(true);
  });

  it('extract-pages into one file re-points the surviving bookmarks and counts the lost ones', async () => {
    const outcome = await run('extract-pages', { pages: '2-3', mergeIntoOne: true });
    const got = await census(await pdfBytes(outcome));
    expect(got.pages).toBe(2);
    expect(got.bookmarks.get('Section 1.1')).toBe(0);
    expect(kept(got.bookmarks, ['Section 1.1'])).toBe(true);
    expect(got.bookmarks.has('Chapter Two')).toBe(false);
    expect(got.embeddedFilesKey).toBe(true);
    expect(Array.from(got.attachments[0].bytes)).toEqual(Array.from(PAYLOAD));
    expect(warned(outcome, /2 of this document's 3 bookmarks pointed at pages that are not in this output/i)).toBe(true);
  });

  it('extract-pages one file per page puts each bookmark in the file that has its page', async () => {
    const outcome = await run('extract-pages', { pages: '1,2,4', mergeIntoOne: false });
    let carried = 0;
    for (let i = 0; i < outcome.outputs.length; i += 1) {
      const one = await census(await pdfBytes(outcome, i));
      expect([...one.bookmarks.values()].every((page) => page === null || page < one.pages)).toBe(true);
      // Every produced sheet owns exactly the bookmark that points at it.
      expect(one.bookmarkCount).toBe(1);
      expect(one.attachments).toHaveLength(1);
      carried += one.bookmarkCount;
    }
    expect(carried).toBe(baseline.bookmarkCount);
    // All three bookmarked pages were extracted, so nothing was lost from the job.
    expect(warned(outcome, /pointed at pages that are not in this output/i)).toBe(false);
  });

  it('extract-pages one file per page counts the bookmarks the job did not cover', async () => {
    const outcome = await run('extract-pages', { pages: '1,2', mergeIntoOne: false });
    let carried = 0;
    for (let i = 0; i < outcome.outputs.length; i += 1) {
      carried += (await census(await pdfBytes(outcome, i))).bookmarkCount;
    }
    expect(carried).toBe(2);
    expect(warned(outcome, /1 of this document's 3 bookmarks pointed at a page that is not in this output/i)).toBe(true);
  });

  it('remove-pages keeps the outline of the pages that stayed', async () => {
    const outcome = await run('remove-pages', { pages: '4' });
    const got = await census(await pdfBytes(outcome));
    expect(got.pages).toBe(3);
    expect(kept(got.bookmarks, ['Chapter One', 'Section 1.1'])).toBe(true);
    expect(got.bookmarks.has('Chapter Two')).toBe(false);
    expect(got.embeddedFilesKey).toBe(true);
    expect(Array.from(got.attachments[0].bytes)).toEqual(Array.from(PAYLOAD));
    expect(warned(outcome, /1 of this document's 3 bookmarks/i)).toBe(true);
  });

  it('organize re-points the bookmarks at the order the plan made', async () => {
    const outcome = await run('organize', { pageOrder: '4,1,2,3' });
    const got = await census(await pdfBytes(outcome));
    expect(got.pages).toBe(4);
    expect(got.bookmarks.get('Chapter One')).toBe(1);
    expect(got.bookmarks.get('Section 1.1')).toBe(2);
    expect(got.bookmarks.get('Chapter Two')).toBe(0);
    expect(got.embeddedFilesKey).toBe(true);
    expect(Array.from(got.attachments[0].bytes)).toEqual(Array.from(PAYLOAD));
    // The annotations always travelled; the rebuild used to claim they had not.
    expect(got.annotations).toBe(baseline.annotations);
    expect(warned(outcome, /links or annotations could not come along/i)).toBe(false);
  });

  it('organize drops a bookmark whose page the plan left out, and says so', async () => {
    const outcome = await run('organize', { pageOrder: '1,2' });
    const got = await census(await pdfBytes(outcome));
    expect(kept(got.bookmarks, ['Chapter One', 'Section 1.1'])).toBe(true);
    expect(got.bookmarks.has('Chapter Two')).toBe(false);
    expect(warned(outcome, /pointed at a page that is not in this output/i)).toBe(true);
  });

  it('reverse-pages re-points the whole outline instead of abandoning it', async () => {
    const outcome = await run('reverse-pages');
    const got = await census(await pdfBytes(outcome));
    expect(got.bookmarks.get('Chapter One')).toBe(3);
    expect(got.bookmarks.get('Section 1.1')).toBe(2);
    expect(got.bookmarks.get('Chapter Two')).toBe(0);
    expect(got.embeddedFilesKey).toBe(true);
    expect(Array.from(got.attachments[0].bytes)).toEqual(Array.from(PAYLOAD));
    expect(warned(outcome, /are not carried into the reversed file/i)).toBe(false);
  });

  it('duplex-collate keeps the outline in the collated order', async () => {
    const outcome = await run('duplex-collate');
    const got = await census(await pdfBytes(outcome));
    expect(got.pages).toBe(4);
    expect(got.bookmarkCount).toBe(3);
    for (const [title, page] of got.bookmarks) {
      expect(page, title).not.toBeNull();
      expect(page! < got.pages, title).toBe(true);
    }
    expect(got.embeddedFilesKey).toBe(true);
    expect(Array.from(got.attachments[0].bytes)).toEqual(Array.from(PAYLOAD));
  });

  it('add-blank-page moves the bookmarks past the sheets it inserted', async () => {
    const outcome = await run('add-blank-page', { position: 'after', anchor: 1, count: 1 });
    const got = await census(await pdfBytes(outcome));
    expect(got.pages).toBe(5);
    expect(got.bookmarks.get('Chapter One')).toBe(0);
    expect(got.bookmarks.get('Section 1.1')).toBe(2);
    expect(got.bookmarks.get('Chapter Two')).toBe(4);
    expect(got.embeddedFilesKey).toBe(true);
    expect(Array.from(got.attachments[0].bytes)).toEqual(Array.from(PAYLOAD));
  });

  it('alternate-merge carries every source’s bookmarks and one of the shared-name files', async () => {
    const outcome = await run('alternate-merge', { pattern: '1-1' }, [
      fileOf(source, 'a.pdf'),
      fileOf(source, 'b.pdf'),
    ]);
    const got = await census(await pdfBytes(outcome));
    expect(got.pages).toBe(8);
    expect(got.bookmarkCount).toBe(6);
    expect(got.embeddedFilesKey).toBe(true);
    expect(got.attachments).toHaveLength(1);
    expect(Array.from(got.attachments[0].bytes)).toEqual(Array.from(PAYLOAD));
    expect(warned(outcome, /shared a name with one already carried/i)).toBe(true);
  });

  it('remove-blank-pages keeps the outline of the sheets it kept', async () => {
    const outcome = await run('remove-blank-pages', { keepAnnotated: false });
    const got = await census(await pdfBytes(outcome));
    expect(got.pages).toBe(3);
    expect(got.bookmarkCount).toBe(3);
    expect(got.bookmarks.get('Chapter Two')).toBe(2);
    expect(got.embeddedFilesKey).toBe(true);
    expect(Array.from(got.attachments[0].bytes)).toEqual(Array.from(PAYLOAD));
  });

  it('rotate on an unencrypted file loses nothing and says nothing', async () => {
    const outcome = await run('rotate', { degrees: 90 });
    const got = await census(await pdfBytes(outcome));
    expect(got.bookmarkCount).toBe(3);
    expect(got.attachments).toHaveLength(1);
    expect(got.annotations).toBe(baseline.annotations);
    expect(got.fields).toBe(baseline.fields);
    expect(outcome.warnings).toHaveLength(0);
  });
});

describe('what a page copy still cannot carry is said out loud', () => {
  it('the form-field list is admitted by every tool that rebuilds', async () => {
    for (const [id, values] of [
      ['remove-pages', { pages: '4' }],
      ['extract-pages', { pages: '2-3', mergeIntoOne: true }],
      ['organize', { pageOrder: '4,1,2,3' }],
      ['reverse-pages', {}],
      ['duplex-collate', {}],
      ['add-blank-page', { position: 'after', anchor: 1, count: 1 }],
    ] as [string, Record<string, unknown>][]) {
      const outcome = await run(id, values);
      const got = await census(await pdfBytes(outcome));
      expect(got.fields, `${id} should still report no editable fields`).toBe(0);
      expect(warned(outcome, /2 form fields|form field/i), `${id}: ${outcome.warnings.join(' | ')}`).toBe(true);
    }
  });

  it('the redraw tools say what they lost, with counts', async () => {
    for (const [id, values] of [
      ['combine-single-page', {}],
      ['n-up', { perPage: 2 }],
      ['booklet', {}],
      ['posterize', {}],
      ['divide-pages', {}],
      ['fix-page-size', { size: 'a4' }],
      ['rotate-custom', { degrees: 45 }],
    ] as [string, Record<string, unknown>][]) {
      const outcome = await run(id, values);
      const got = await census(await pdfBytes(outcome));
      expect(got.bookmarkCount, id).toBe(0);
      expect(got.attachments, id).toHaveLength(0);
      expect(warned(outcome, /bookmarks are not in the output/i), `${id}: ${outcome.warnings.join(' | ')}`).toBe(true);
      expect(warned(outcome, /1 attached file .* not in the output|attached file/i), `${id}: ${outcome.warnings.join(' | ')}`).toBe(true);
      expect(warned(outcome, /form field/i), `${id}: ${outcome.warnings.join(' | ')}`).toBe(true);
    }
  });
});

describe('the carried bytes are the bytes that went in', () => {
  it('the attachment keeps its payload, checksum and type through a rebuild', async () => {
    const outcome = await run('remove-pages', { pages: '4' });
    const doc = await openPDF(await pdfBytes(outcome), { ignoreEncryption: true });
    const [entry] = listAttachments(doc);
    expect(entry.name).toBe('source.csv');
    expect(entry.mimeType).toBe('text/csv');
    expect(entry.description).toBe('Raw data');
    expect(Array.from(entry.bytes)).toEqual(Array.from(PAYLOAD));
    expect(entry.checksum).toBe(md5Hex(PAYLOAD));
  });
});
