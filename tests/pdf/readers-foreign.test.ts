/**
 * Page labels and outlines, read from files this repo did not write.
 *
 * `docs/research/foreign-structure-audit.md` counted which structure readers had ever
 * met a foreign file in a CI test, and left two rows unfixed with a measured verdict:
 * `readPageLabels` reads `/Nums` off the root only, so a `/Kids` **number tree** comes
 * back `["1","2","3"]` for a file MuPDF labels `i-1, I, c`; `readOutline` resolves a
 * named destination only when the array sits inline in a flat `/Names`, so a value
 * behind a reference, or inside a `/Kids` tree, gives `page: null`. This file is the
 * per-shape reproduction of both, in the shape the attachments pass used
 * (`docs/research/attachments-foreign-repro.md`): foreign fixtures, outside readers
 * beside ours, one row per shape, negative controls pinned.
 *
 * **Read before believing any claim here.** Every input in `tests/fixtures/readers/`
 * was written by MuPDF 1.28.2 (PyMuPDF), libqpdf 12.3.2 (pikepdf 10.9.1) or pypdf
 * 6.14.2 — never by pdf-lib — by `scripts/readers-foreign-fixtures.py`, which is
 * byte-reproducible (`--check`: 34 fixtures identical across two runs in separate
 * processes) and whose `census.json` holds the outside readers' answer for every file.
 * `census.json` is asserted against, below, so the outside column in this file cannot
 * drift from the bytes the generator recorded. MuPDF and pypdf are the only two readers
 * on this box that implement page labels and outlines at all: `qpdf` and `mutool` are
 * **not installed**, and poppler 26.10.0's `pdfinfo` prints neither, so poppler is used
 * as a parse-witness (every fixture must open) rather than as a third opinion.
 *
 * Where the two outside readers disagree, the row says so instead of picking a winner:
 * pypdf stops every `/Kids` label range at its first page, MuPDF does not walk a
 * two-level tree at all, and on an item carrying both `/Dest` and `/A` MuPDF honours
 * `/Dest` while pypdf honours `/A`.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRef, PDFString } from '@maxwbh/pdf-lib';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { context, openPDF, type PDFDocument } from '@/lib/pdf/core/doc';
import { pageContentStreams } from '@/lib/pdf/core/content';
import { readOutline, readPageLabels, type OutlineNode } from '@/lib/pdf/core/bookmarks';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import type { ToolValues } from '@/lib/pdf/tools/types';

const FIXTURES = resolve(process.cwd(), 'tests/fixtures/readers');

/**
 * `redact-pdf` reads the words under a mark back out of the saved file with pdf.js
 * before it will scrub them from the bookmarks, and pdf.js points its worker at
 * `import.meta.url` — an http URL Node's ESM loader refuses under jsdom. Same pin
 * `tests/pdf/security-bytes.test.ts` uses; without it the redaction round trip below
 * answers "No PDF reader could be started" and never reaches the outline.
 */
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

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const pageText = (doc: PDFDocument): string =>
  doc.getPages().map((page) => {
    const streams = pageContentStreams(page);
    const total = streams.reduce((sum, stream) => sum + stream.bytes.length, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const stream of streams) {
      joined.set(stream.bytes, offset);
      offset += stream.bytes.length;
    }
    // MuPDF writes every string in these fixtures as a hex string, so the text has
    // to be unfolded out of `<…>` before it can be compared with a title.
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(joined);
    return raw.replace(/<([0-9a-fA-F\s]+)>/g, (whole, hex: string) => {
      const clean = hex.replace(/\s+/g, '');
      const bytes = new Uint8Array(Math.ceil(clean.length / 2));
      for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    });
  }).join('\n');

const fixtureBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(FIXTURES, name)));

const open = (name: string) =>
  openPDF(fixtureBytes(name), { updateMetadata: false, ignoreEncryption: true });

/** Follow one indirection, and ask what the object is rather than hoping. */
const deref = (doc: PDFDocument, value: unknown): unknown =>
  value instanceof PDFRef ? context(doc).lookup(value) : value;

interface ManifestEntry {
  sha256: string;
  shape: string;
  producer: string;
}

interface Census {
  shape: string;
  producer: string;
  outside: Record<string, unknown>;
  outside_after_freeze: {
    pages: number;
    mupdf_page_labels: string[];
    pypdf_labels: string[];
    toc: [number, string, number][];
    pypdf_outline: { title?: string; page?: number | string | null }[];
    pypdf_named_dests: string[];
    poppler_opens: boolean;
  };
}

const MANIFEST = JSON.parse(
  readFileSync(resolve(FIXTURES, 'MANIFEST.json'), 'utf8'),
) as Record<string, ManifestEntry>;

const CENSUS = JSON.parse(
  readFileSync(resolve(FIXTURES, 'census.json'), 'utf8'),
) as Record<string, Census>;

// ---------------------------------------------------------------------------
// What each shape is, and what the readers that did not write it say
// ---------------------------------------------------------------------------

interface LabelCase {
  file: string;
  shape: string;
  /** What `readPageLabels` must answer, one string per page. */
  expect: string[];
  /** Why that is the expectation, when it needs more than "both readers agree". */
  basis: string;
}

const LABEL_CASES: LabelCase[] = [
  {
    file: 'labels-absent.pdf',
    shape: 'no /PageLabels at all — the negative control',
    expect: ['1', '2', '3', '4'],
    basis: 'pypdf expands an unlabelled document to arabic; MuPDF answers "" for "no label", which is the same fact seen from the other side. This reader reports the number a viewer shows.',
  },
  {
    file: 'labels-nums-d.pdf',
    shape: 'flat /Nums, /S /D with /St 1 — a genuinely arabic file',
    expect: ['1', '2', '3', '4'],
    basis: 'the negative control the fix must not move: an arabic-labelled file still reads as arabic.',
  },
  {
    file: 'labels-nums-r.pdf',
    shape: 'flat /Nums, /S /r (lowercase roman)',
    expect: ['i', 'ii', 'iii', 'iv'],
    basis: 'MuPDF and pypdf agree.',
  },
  {
    file: 'labels-nums-R-st4.pdf',
    shape: 'flat /Nums, /S /R with /St 4 (uppercase roman, offset start)',
    expect: ['IV', 'V', 'VI', 'VII'],
    basis: 'MuPDF and pypdf agree.',
  },
  {
    file: 'labels-nums-a.pdf',
    shape: 'flat /Nums, /S /a (lowercase alphabetic)',
    expect: ['a', 'b', 'c', 'd'],
    basis: 'MuPDF and pypdf agree.',
  },
  {
    file: 'labels-nums-A-st2.pdf',
    shape: 'flat /Nums, /S /A with /St 2 (uppercase alphabetic, offset start)',
    expect: ['B', 'C', 'D', 'E'],
    basis: 'MuPDF and pypdf agree.',
  },
  {
    file: 'labels-nums-prefix.pdf',
    shape: 'flat /Nums with /P prefixes on a decimal and a roman range',
    expect: ['i-1', 'i-2', '§i', '§ii'],
    basis: 'pypdf agrees; MuPDF escapes the § prefix byte as <A7> when it prints it.',
  },
  {
    file: 'labels-nums-prefix-only.pdf',
    shape: 'a range with /P and no /S — a prefix-only label',
    expect: ['Cover ', 'Cover ', 'of i', 'of ii'],
    basis: 'MuPDF and pypdf both drop the number when there is no /S. This app writes that shape itself: `add-page-labels` with style `none` emits /P and no /S.',
  },
  {
    file: 'labels-nums-empty-dict.pdf',
    shape: 'a range whose dictionary is empty — no /S, no /P, no /St',
    expect: ['', '', '', ''],
    basis: 'both outside readers answer with no number and no prefix. The `none` style this app writes, given without a prefix, is exactly this dictionary.',
  },
  {
    file: 'labels-nums-unknown-style.pdf',
    shape: 'a range whose /S names a style the format does not define (/G)',
    expect: ['2', '3', '4', '5'],
    basis: 'no two readers agree on a style the format does not define: MuPDF shows no label, pypdf counts from 1 and ignores /St, this app counts from /St in decimal. Pinned as it behaves, not as one of the three prefers.',
  },
  {
    file: 'labels-nums-mixed.pdf',
    shape: 'flat /Nums, a mixed sequence across three sections (/r, /D, /A + /P)',
    expect: ['i', 'ii', '1', '2', 'Ex A', 'Ex B'],
    basis: 'MuPDF and pypdf agree — the control for the same ranges behind a /Kids tree.',
  },
  {
    file: 'labels-nums-inline-dicts.pdf',
    shape: 'flat /Nums whose range dictionaries are inline, not referenced',
    expect: ['i', 'ii', '1', '2', 'Ex A', 'Ex B'],
    basis: 'the shape this app and MuPDF write; MuPDF and pypdf agree.',
  },
  {
    file: 'labels-native-mupdf.pdf',
    shape: "the ranges MuPDF's own set_page_labels writes",
    expect: ['i', 'ii', 'x-7', 'x-8'],
    basis: 'MuPDF and pypdf agree on the file MuPDF wrote.',
  },
  {
    file: 'labels-kids-mixed.pdf',
    shape: '/Kids + /Limits number tree, one style per section',
    expect: ['i', 'ii', 'I', 'II', 'c', 'xA'],
    basis: 'MuPDF expands the same four ranges to these six labels; pypdf loses the carry on pages 3 (answers "4"), so the flat sibling above — where all three agree — is what pins the range semantics.',
  },
  {
    file: 'labels-kids-prefix.pdf',
    shape: 'a /Kids tree carrying /P prefixes and /St offsets',
    expect: ['§I', '§II', 'A-21', 'A-22'],
    basis: 'MuPDF gives the same four labels (its § prints as <A7>); pypdf stops the roman range after one page.',
  },
  {
    file: 'labels-kids-deep.pdf',
    shape: 'a /Kids tree whose leaves sit under a second /Kids level',
    expect: ['i', 'ii', '1', '2', 'Ex A', 'Ex B'],
    basis: '§7.9.7 allows a number tree of any depth, and these are the same three ranges `labels-nums-mixed.pdf` carries flat — where MuPDF and pypdf both agree. Neither outside reader gets the nested copy right (MuPDF finds no labels at all, pypdf only the first page of each range), which is why the flat sibling is the reference for this row.',
  },
];

/** One flattened entry per bookmark: title, destination page (0-based) or null. */
interface FlatNode {
  title: string;
  page: number | null;
  depth: number;
}

const flat = (nodes: OutlineNode[], depth = 0): FlatNode[] =>
  nodes.flatMap((node) => [
    { title: node.title, page: node.page, depth },
    ...flat(node.children ?? [], depth + 1),
  ]);

interface OutlineCase {
  file: string;
  shape: string;
  expect: FlatNode[];
  basis: string;
}

const NESTED = (pages: [number, number, number]): FlatNode[] => [
  { title: 'Chapter One', page: pages[0], depth: 0 },
  { title: 'Section One.A', page: pages[1], depth: 1 },
  { title: 'Chapter Two', page: pages[2], depth: 0 },
];

const OUTLINE_CASES: OutlineCase[] = [
  {
    file: 'outlines-native-mupdf.pdf',
    shape: "MuPDF's own /Outlines: /A /GoTo with the /D array inline, two levels, /XYZ",
    expect: NESTED([0, 1, 2]),
    basis: 'MuPDF and pypdf both resolve all three.',
  },
  {
    file: 'outlines-native-pypdf.pdf',
    shape: "pypdf's own outline: /A /GoTo with an inline /D array, nested through /First",
    expect: NESTED([0, 1, 2]),
    basis: 'MuPDF and pypdf both resolve all three.',
  },
  {
    file: 'outlines-native-pikepdf.pdf',
    shape: "libqpdf's own outline: /Dest as an inline array, nesting through /First",
    expect: NESTED([0, 1, 2]),
    basis: 'MuPDF and pypdf both resolve all three.',
  },
  {
    file: 'outlines-flat-chain.pdf',
    shape: 'a flat /First → /Next chain of two items with inline /Dest arrays — the control',
    expect: [
      { title: 'Chapter One', page: 0, depth: 0 },
      { title: 'Chapter Two', page: 1, depth: 0 },
    ],
    basis: 'MuPDF and pypdf agree; nothing here is nested, which is what makes the nested rows a separate shape.',
  },
  {
    file: 'outlines-dests-inline.pdf',
    shape: '/Dests flat /Names with the destination array inline, item /Dest a string',
    expect: NESTED([0, 1, 2]),
    basis: 'pypdf resolves all three; MuPDF reports 0 for every entry, which is how it marks a destination it did not resolve.',
  },
  {
    file: 'outlines-dests-ref.pdf',
    shape: '/Dests flat /Names with each destination behind a reference — the reported failure',
    expect: NESTED([0, 1, 2]),
    basis: 'pypdf resolves all three; the only difference from the row above is that the value is a reference.',
  },
  {
    file: 'outlines-dests-kids-ref.pdf',
    shape: '/Dests as a /Kids + /Limits tree with referenced destinations',
    expect: NESTED([0, 1, 2]),
    basis: 'pypdf walks the tree and resolves all three.',
  },
  {
    file: 'outlines-names-dests-kids-ref.pdf',
    shape: 'the PDF 1.4 location: /Names → /Dests as a /Kids tree with referenced destinations',
    expect: NESTED([0, 1, 2]),
    basis: 'MuPDF and pypdf both resolve all three. §12.3.2.3 puts named destinations in the name dictionary from PDF 1.4 onwards; `/Dests` on the catalogue is the 1.1 spelling.',
  },
  {
    file: 'outlines-names-dests-dict.pdf',
    shape: '/Names → /Dests whose value is a destination DICTIONARY behind a reference',
    expect: NESTED([0, 1, 2]),
    basis: 'MuPDF and pypdf both resolve all three. This is what pypdf 6.14.2 `add_named_destination` writes, and §12.3.2.2 allows an array or a dictionary.',
  },
  {
    file: 'outlines-dest-name.pdf',
    shape: 'item /Dest written as a NAME object naming /Dests, values behind references',
    expect: NESTED([0, 1, 2]),
    basis: 'neither outside reader resolves a name key here (MuPDF reports 0, pypdf None), so the expectation comes from the same file read with the key as a string — `outlines-dests-ref.pdf`, which pypdf resolves to 0,1,2 — and from §12.3.2 allowing a name or a byte string.',
  },
  {
    file: 'outlines-action-name.pdf',
    shape: 'item /A /GoTo whose /D is a NAME into a referenced /Dests value',
    expect: NESTED([0, 1, 2]),
    basis: 'as the row above: the destination store is identical to `outlines-dests-ref.pdf`, only the key that names it differs.',
  },
  {
    file: 'outlines-action-string.pdf',
    shape: 'item /A /GoTo whose /D is a STRING into the /Names → /Dests tree',
    expect: NESTED([0, 1, 2]),
    basis: 'MuPDF and pypdf both resolve all three.',
  },
  {
    file: 'outlines-action-array.pdf',
    shape: 'item /A /GoTo with the /D destination array inline (no name tree)',
    expect: NESTED([0, 1, 2]),
    basis: 'MuPDF and pypdf agree.',
  },
  {
    file: 'outlines-dest-and-action.pdf',
    shape: 'an item carrying /Dest **and** /A on the same entry',
    expect: NESTED([0, 0, 0]),
    basis: 'the two outside readers split: MuPDF honours /Dest (every entry → page 1), pypdf honours /A (0,1,2). This app already follows /Dest, the same answer MuPDF gives, and the row pins that it keeps doing so.',
  },
  {
    file: 'outlines-redactable.pdf',
    shape: "the referenced-/Dests failure, titles matching the page's own words, with a /Info dictionary",
    expect: [
      { title: 'Lighthouse One', page: 0, depth: 0 },
      { title: 'Inventory Two', page: 1, depth: 1 },
      { title: 'Sheet Three', page: 2, depth: 0 },
    ],
    basis: 'pypdf resolves all three; MuPDF reports 0 (unresolved). This is the file the redaction round trip runs on, and the only fixture that carries a /Info dictionary — which `redact-pdf` needs to get as far as the bookmarks.',
  },
  {
    file: 'outlines-targetless.pdf',
    shape: 'items with no destination at all: a heading, a /URI action, an /SE-only entry',
    expect: [
      { title: 'Chapter One', page: null, depth: 0 },
      { title: 'Section One.A', page: null, depth: 1 },
      { title: 'Chapter Two', page: null, depth: 0 },
    ],
    basis: 'the negative control: MuPDF answers -1 and pypdf None for every entry, so `page: null` is the honest answer here and not the defect.',
  },
  {
    file: 'outlines-empty.pdf',
    shape: '/Outlines present with /Count 0 and no /First — empty, not null-everywhere',
    expect: [],
    basis: 'both outside readers report no entries.',
  },
  {
    file: 'outlines-absent.pdf',
    shape: 'no /Outlines at all — empty, not null-everywhere',
    expect: [],
    basis: 'both outside readers report no entries.',
  },
];

// ---------------------------------------------------------------------------
// The fixtures are the bytes the generator recorded
// ---------------------------------------------------------------------------

describe('the committed reader fixtures are the bytes the generator recorded', () => {
  it('covers every fixture, and only fixtures the generator wrote', () => {
    const onDisk = readdirSync(FIXTURES).filter((name) => name.endsWith('.pdf')).sort();
    expect(Object.keys(MANIFEST).sort()).toEqual(onDisk);
    expect(onDisk).toHaveLength(34);
  });

  for (const [name, entry] of Object.entries(MANIFEST)) {
    it(`${name} still hashes to its recorded digest`, () => {
      expect(sha256(fixtureBytes(name)), 'regenerate with scripts/readers-foreign-fixtures.py').toBe(
        entry.sha256,
      );
      expect(entry.shape, name).not.toBe('');
      expect(entry.producer, name).toMatch(/MuPDF|pikepdf|pypdf/);
    });
  }

  it('is censused by the outside readers for every fixture it asserts on', () => {
    const asserted = [...LABEL_CASES, ...OUTLINE_CASES].map((testCase) => testCase.file);
    for (const file of asserted) {
      expect(CENSUS[file], `${file} is in census.json`).toBeTruthy();
      expect(CENSUS[file].shape, file).toBe(MANIFEST[file].shape);
      // Poppler is not an authority on these two structures; it is the witness that
      // the file is a PDF at all, so every row has to have survived it.
      expect(CENSUS[file].outside_after_freeze.poppler_opens, `${file} opens in poppler`).toBe(true);
    }
    expect(asserted.sort()).toEqual(Object.keys(MANIFEST).sort());
  });

  it('records the outside readers\' answer this file compares against', () => {
    for (const testCase of LABEL_CASES) {
      const frozen = CENSUS[testCase.file].outside_after_freeze;
      expect(frozen.mupdf_page_labels, testCase.file).not.toHaveLength(0);
      expect(frozen.pypdf_labels, testCase.file).not.toHaveLength(0);
      expect(frozen.pages, testCase.file).toBe(testCase.expect.length);
    }
    for (const testCase of OUTLINE_CASES) {
      const frozen = CENSUS[testCase.file].outside_after_freeze;
      expect(frozen.pypdf_outline.map((e) => e.title), testCase.file).toEqual(
        testCase.expect.map((e) => e.title),
      );
      expect(frozen.toc.map((e) => e[1]), testCase.file).toEqual(
        testCase.expect.map((e) => e.title),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// readPageLabels, per shape
// ---------------------------------------------------------------------------

const labelsOf = async (file: string) => {
  const doc = await open(file);
  return readPageLabels(doc).map((entry) => entry.label);
};

describe.each(LABEL_CASES)('readPageLabels over a foreign file: $file', (testCase) => {
  it(`reads ${testCase.shape} as the outside readers do`, async () => {
    expect(await labelsOf(testCase.file)).toEqual(testCase.expect);
  });

  it('answers one label per page, whatever the tree looked like', async () => {
    const doc = await open(testCase.file);
    const labels = readPageLabels(doc);
    expect(labels.map((entry) => entry.page)).toEqual(labels.map((_, index) => index));
    expect(labels).toHaveLength(doc.getPageCount());
  });
});

// ---------------------------------------------------------------------------
// readOutline, per shape
// ---------------------------------------------------------------------------

/**
 * Does each outline item still **name a place** in the file's own bytes?
 *
 * `readOutline` is the thing being fixed, so a round trip cannot be judged by asking
 * it again: an entry the reader lost and the writer rewrote as a heading reads back as
 * `page: null` either way. This walks the item dictionaries directly and reports whether
 * `/Dest`, `/Destination` or `/A` survived, which is the difference between a bookmark
 * a reader can follow and a caption.
 */
function itemsNamingATarget(doc: PDFDocument): { title: string; target: boolean }[] {
  const found: { title: string; target: boolean }[] = [];
  const root = doc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
  const walk = (first: unknown) => {
    const seen = new Set<PDFDict>();
    let node = deref(doc, first);
    while (node instanceof PDFDict && !seen.has(node)) {
      seen.add(node);
      const raw = node.get(PDFName.of('Title'));
      const title = raw instanceof PDFString || raw instanceof PDFHexString ? raw.decodeText() : '';
      const target = ['Dest', 'Destination', 'A'].some((key) => node instanceof PDFDict && node.has(PDFName.of(key)));
      found.push({ title, target });
      walk(node.get(PDFName.of('First')));
      node = deref(doc, node.get(PDFName.of('Next')));
    }
  };
  if (root) walk(root.get(PDFName.of('First')));
  return found;
}

const pageLabelStore = (doc: PDFDocument): { nums: number; kids: number } => {
  const tree = doc.catalog.lookupMaybe(PDFName.of('PageLabels'), PDFDict);
  const size = (value: unknown) => (deref(doc, value) instanceof PDFArray
    ? (deref(doc, value) as PDFArray).size()
    : 0);
  return tree
    ? { nums: size(tree.get(PDFName.of('Nums'))), kids: size(tree.get(PDFName.of('Kids'))) }
    : { nums: 0, kids: 0 };
};

/** The decoded content of every page, hashed — the words a round trip must not move. */
const contentHashes = (doc: PDFDocument): string[] =>
  doc.getPages().map((page) => {
    const streams = pageContentStreams(page);
    const total = streams.reduce((sum, stream) => sum + stream.bytes.length, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const stream of streams) {
      joined.set(stream.bytes, offset);
      offset += stream.bytes.length;
    }
    return sha256(joined);
  });

describe.each(OUTLINE_CASES)('readOutline over a foreign file: $file', (testCase) => {
  it(`reads ${testCase.shape} as the outside readers do`, async () => {
    const doc = await open(testCase.file);
    expect(flat(readOutline(doc))).toEqual(testCase.expect);
  });

  it('does not invent a destination the file does not carry', async () => {
    const doc = await open(testCase.file);
    const resolved = flat(readOutline(doc)).filter((entry) => entry.page !== null);
    const outside = CENSUS[testCase.file].outside_after_freeze.pypdf_outline
      .filter((entry) => typeof entry.page === 'number');
    // Every page this reader names has to be a page the document has, and it may
    // name at least as many as pypdf does — the two `/Dest` written as a name rows
    // are the ones pypdf itself refuses, where this reader resolves the same store.
    expect(resolved.length, testCase.file).toBeGreaterThanOrEqual(outside.length);
    for (const entry of resolved) {
      expect(entry.page!, `${testCase.file} / ${entry.title}`).toBeGreaterThanOrEqual(0);
      expect(entry.page!, `${testCase.file} / ${entry.title}`).toBeLessThan(doc.getPageCount());
    }
  });
});

describe('the outline details the fixtures carry as well', () => {
  it('keeps the nesting a producer wrote, at every /Dests spelling', async () => {
    for (const file of ['outlines-dests-ref.pdf', 'outlines-names-dests-kids-ref.pdf',
      'outlines-names-dests-dict.pdf', 'outlines-action-string.pdf']) {
      const nodes = readOutline(await open(file));
      expect(nodes.map((node) => node.title), file).toEqual(['Chapter One', 'Chapter Two']);
      expect(nodes[0].children?.map((node) => node.title), file).toEqual(['Section One.A']);
      expect(nodes[0].children?.[0].page, file).toBe(1);
    }
  });

  it('carries a /XYZ destination through, the way MuPDF writes one', async () => {
    const nodes = readOutline(await open('outlines-native-mupdf.pdf'));
    expect(nodes[0].destination).toEqual({ kind: 'xyz', x: 72, y: 806, zoom: 0 });
  });

  it('reads the targetless entries as headings, not as pages it never saw', async () => {
    const nodes = readOutline(await open('outlines-targetless.pdf'));
    expect(nodes.every((node) => node.page === null)).toBe(true);
    expect(nodes[0].children).toHaveLength(1);
    const items = itemsNamingATarget(await open('outlines-targetless.pdf'));
    // The /URI entry names a target (an action); the heading and the /SE-only entry
    // name nothing, which is why `page: null` is the right answer for them.
    expect(items.map((item) => item.target)).toEqual([true, false, false]);
  });
});

// ---------------------------------------------------------------------------
// Round trips: does a misread damage the file, or only report it wrongly?
// ---------------------------------------------------------------------------

const fileFrom = (name: string) =>
  new File([fixtureBytes(name) as BlobPart], name, { type: 'application/pdf' });

const run = async (toolId: string, values: ToolValues, ...files: string[]) => {
  const outcome = await runTool(toolId, values, files);
  expect(outcome.outputs, `${toolId} produced no file`).toHaveLength(1);
  const bytes = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
  return {
    outcome,
    bytes,
    doc: await openPDF(bytes, { updateMetadata: false, ignoreEncryption: true }),
  };
};

/** The same run, for a tool whose answer is a report rather than a downloaded file. */
const runTool = async (toolId: string, values: ToolValues, files: string[]) => {
  expect(getPdfTool(toolId), `tool ${toolId} is registered`).toBeTruthy();
  return runPdfTool({
    toolId,
    files: files.map(fileFrom),
    values,
    onProgress: () => undefined,
    onLog: () => undefined,
  });
};

describe('the round trip on page labels', () => {
  it('a tool that edits in place leaves the label tree and the words alone', async () => {
    const name = 'labels-kids-mixed.pdf';
    const before = await open(name);
    const beforeHashes = contentHashes(before);
    const turned = await run('rotate', { degrees: 90, pages: 'all' }, name);
    // The bytes: the /Kids store is still there, and no page was rewritten.
    expect(pageLabelStore(turned.doc).kids, 'the label tree survived the turn').toBeGreaterThan(0);
    expect(contentHashes(turned.doc)).toEqual(beforeHashes);
    // And what the app *says* the file says — the row the sweep measured.
    expect(readPageLabels(turned.doc).map((entry) => entry.label)).toEqual(
      CENSUS[name].outside_after_freeze.mupdf_page_labels
        .map((label, index) => (label === '' ? String(index + 1) : label))
        .map((label) => label.replace('<A7>', '§')),
    );
  });

  it('drawing folios leaves the label tree exactly as it was', async () => {
    // The other half of "does a misread reach a writer": `page-numbers` stamps a
    // visible folio, and the question is whether it consults `/PageLabels` to pick
    // the number. It does not — it counts sheets — so the roman numbering a viewer
    // shows in the toolbar survives the run byte for byte.
    const name = 'labels-kids-mixed.pdf';
    const before = await open(name);
    const store = pageLabelStore(before);
    const ran = await run('page-numbers', { position: 'bottom-center' }, name);
    expect(pageLabelStore(ran.doc)).toEqual(store);
    expect(contentHashes(ran.doc).length).toBe(6);
    // And the folios drawn are 1..6 whatever the labels read as.
    expect(readPageLabels(ran.doc).map((entry) => entry.label)).toEqual(
      readPageLabels(before).map((entry) => entry.label),
    );
  });

  it('a page copy drops /PageLabels altogether — recorded, not fixed here', async () => {
    // `core/doc.ts:carryPageFurniture` carries the outline and the embedded files
    // across a copy and has never carried the label tree, so the output of every
    // rebuilding tool is a document whose numbering falls back to arabic in the
    // viewer. That is the damage the sweep asked about, and it is the copy's, not
    // the reader's: nothing here reads `/PageLabels` wrongly *into* a writer.
    const name = 'labels-kids-mixed.pdf';
    const copy = await run('extract-pages', { pages: '1-3' }, name);
    expect(copy.doc.getPageCount()).toBe(3);
    expect(pageLabelStore(copy.doc)).toEqual({ nums: 0, kids: 0 });
    expect(readPageLabels(copy.doc).map((entry) => entry.label)).toEqual(['1', '2', '3']);
  });

  it('add-page-labels reports what the file it wrote actually holds', async () => {
    // Green before and after the fix: this tool reads back what it just wrote, so
    // the misread never reached it. It replaces the labels, which is what it says
    // it does, and the message quotes the numbering the file now carries.
    const ran = await run('add-page-labels', { ranges: '1-2 roman 1\n3-6 decimal 1' },
      'labels-kids-mixed.pdf');
    expect(readPageLabels(ran.doc).map((entry) => entry.label))
      .toEqual(['i', 'ii', '1', '2', '3', '4']);
    expect(ran.outcome.message).toContain('i, ii, 1, 2, 3, 4');
    expect(pageLabelStore(ran.doc)).toEqual({ nums: 4, kids: 0 });
  });

  it('leaves an arabic-labelled file arabic through a turn', async () => {
    const ran = await run('rotate', { degrees: 180, pages: 'all' }, 'labels-nums-d.pdf');
    expect(readPageLabels(ran.doc).map((entry) => entry.label)).toEqual(['1', '2', '3', '4']);
  });
});

describe('the round trip on outlines', () => {
  it('appending bookmarks keeps the destinations that were already there', async () => {
    // `bookmarks` with "replace" off reads the existing outline into the same model
    // it then writes. A destination this reader cannot resolve therefore does not
    // merely read wrong — the rewrite drops it, and the file comes back with dead
    // captions where it had working bookmarks.
    const name = 'outlines-dests-ref.pdf';
    const ran = await run('bookmarks', { outline: 'Appendix :: 4', replace: false }, name);
    expect(flat(readOutline(ran.doc))).toEqual([
      ...NESTED([0, 1, 2]),
      { title: 'Appendix', page: 3, depth: 0 },
    ]);
    const items = itemsNamingATarget(ran.doc);
    expect(items).toHaveLength(4);
    expect(items.every((item) => item.target), 'every bookmark still names a page')
      .toBe(true);
    expect(ran.outcome.message).not.toMatch(/without a page/);
  });

  it('a page copy carries the bookmarks with their targets, not as captions', async () => {
    // The copy path is where "bookmarks dropped wholesale" was found and fixed; a
    // destination the reader cannot resolve survives as a heading, so the run still
    // reports carrying three bookmarks while the output holds three inert ones.
    const name = 'outlines-names-dests-kids-ref.pdf';
    const ran = await run('extract-pages', { pages: '1-3' }, name);
    expect(flat(readOutline(ran.doc))).toEqual(NESTED([0, 1, 2]));
    const items = itemsNamingATarget(ran.doc);
    expect(items).toHaveLength(3);
    expect(items.every((item) => item.target), 'the copied bookmarks still name pages')
      .toBe(true);
    expect(ran.outcome.warnings.join(' ')).not.toMatch(/dropped|left behind/);
  });

  it('a table of contents numbers the entries it can resolve', async () => {
    const name = 'outlines-dests-ref.pdf';
    const ran = await run('table-of-contents', {}, name);
    expect(ran.outcome.warnings.join(' ')).not.toMatch(/no page target/);
    expect(ran.outcome.message).not.toMatch(/no page target/);
    // The contents page links to each entry, so the number of links on the inserted
    // sheet is the byte-level answer to "did it know where each chapter is".
    const links = ran.doc.getPages().flatMap((page) => {
      const annots = deref(ran.doc, page.node.get(PDFName.of('Annots')));
      if (!(annots instanceof PDFArray)) return [];
      const found: PDFDict[] = [];
      for (let i = 0; i < annots.size(); i++) {
        const entry = deref(ran.doc, annots.get(i));
        if (entry instanceof PDFDict && entry.get(PDFName.of('Subtype')) === PDFName.of('Link')) {
          found.push(entry);
        }
      }
      return found;
    });
    expect(links).toHaveLength(3);
  });

  it('redacting a word out of a bookmark title leaves the bookmark pointing somewhere', async () => {
    const name = 'outlines-redactable.pdf';
    const ran = await run('redact-pdf', {
      fill: '#000000',
      alsoMetadata: true,
      regions: [{ page: 0, x: 50, y: 680, width: 320, height: 60 }],
    }, name);
    expect(ran.outcome.warnings.join(' ')).not.toMatch(/No PDF reader could be started/);
    const titles = flat(readOutline(ran.doc)).map((entry) => entry.title);
    expect(titles, titles.join(', ')).toEqual(['One', 'Two', 'Three']);
    expect(flat(readOutline(ran.doc)).map((entry) => entry.page)).toEqual([0, 1, 2]);
    const items = itemsNamingATarget(ran.doc);
    expect(items).toHaveLength(3);
    expect(items.every((item) => item.target), 'the scrub kept every destination')
      .toBe(true);
  });

  it('shows the outline of a foreign file as it is, not as three blanks', async () => {
    // The view-only half of `bookmarks`: the sentence the rail shows counts the
    // entries without a page, which is the number a user reads as "this file's
    // bookmarks are broken". That answer is a report, so no file comes back.
    const outcome = await runTool('bookmarks', { outline: '', replace: true },
      ['outlines-dests-ref.pdf']);
    expect(outcome.outputs).toHaveLength(0);
    expect(outcome.message).toMatch(/3 bookmarks/);
    expect(outcome.message).not.toMatch(/without a page/);
  });

  it('redacting a file with no /Info dictionary never reaches the bookmarks at all', async () => {
    // Recorded, not fixed here. Every fixture except `outlines-redactable.pdf` is a
    // MuPDF file with no document-information dictionary, which is legal and common,
    // and `core/metadata.ts:infoDict` asks pdf-lib for a typed object at a key that
    // is simply absent — the class the attachments row closed for `/EF`. The
    // redaction therefore refuses the file with an engine sentence before it reads a
    // single bookmark, so this round trip can only be measured on the one fixture
    // that carries `/Info`.
    await expect(run('redact-pdf', {
      fill: '#000000',
      alsoMetadata: true,
      regions: [{ page: 0, x: 50, y: 680, width: 320, height: 60 }],
    }, 'outlines-dests-ref.pdf')).rejects.toThrow(/Expected instance of PDFDict/);
  });

  it('reads the outline, not the page: no title it reports is anywhere in the content', async () => {
    // The failure this rules out: a reader that recovered a bookmark's title from the
    // text on the sheet it points at would pass every row above for the wrong reason.
    // These fixtures' pages say "Lighthouse Inventory 1887 page N" and "Sheet ALPHA
    // body copy"; nothing says "Chapter One".
    const doc = await open('outlines-dests-ref.pdf');
    const words = pageText(doc);
    expect(words).toContain('Lighthouse Inventory 1887 page 1');
    for (const title of ['Chapter One', 'Section One.A', 'Chapter Two']) {
      expect(words, `"${title}" is not on any page of the fixture`).not.toContain(title);
    }
    expect(flat(readOutline(doc)).map((entry) => entry.title))
      .toEqual(['Chapter One', 'Section One.A', 'Chapter Two']);
  });

  it('reads an outline-free file as empty after a copy, not as null entries', async () => {
    const ran = await run('rotate', { degrees: 90, pages: 'all' }, 'outlines-absent.pdf');
    expect(readOutline(ran.doc)).toEqual([]);
    expect(itemsNamingATarget(ran.doc)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The table for docs/research, and the produced files for the outside census
// ---------------------------------------------------------------------------

describe('records what each shape produces, for the reproduction table', () => {
  it('writes the app columns and the round-tripped files out', async () => {
    const table = process.env.BROWSERSNIP_READERS_TABLE;
    const dump = process.env.BROWSERSNIP_READERS_DUMP;
    if (!table && !dump) return;
    if (dump) mkdirSync(dump, { recursive: true });
    const rows = {
      labels: [] as Record<string, unknown>[],
      outlines: [] as Record<string, unknown>[],
      roundTrips: [] as Record<string, unknown>[],
    };
    for (const testCase of LABEL_CASES) {
      rows.labels.push({
        file: testCase.file,
        shape: testCase.shape,
        basis: testCase.basis,
        ours: await labelsOf(testCase.file),
        mupdf: CENSUS[testCase.file].outside_after_freeze.mupdf_page_labels,
        pypdf: CENSUS[testCase.file].outside_after_freeze.pypdf_labels,
      });
    }
    for (const testCase of OUTLINE_CASES) {
      const doc = await open(testCase.file);
      rows.outlines.push({
        file: testCase.file,
        shape: testCase.shape,
        basis: testCase.basis,
        ours: flat(readOutline(doc)),
        pypdf: CENSUS[testCase.file].outside_after_freeze.pypdf_outline,
        mupdf: CENSUS[testCase.file].outside_after_freeze.toc,
      });
    }
    const trips: {
      id: string;
      tool: string;
      values: ToolValues;
      inputs: string[];
    }[] = [
      { id: 'rotate-labels', tool: 'rotate', values: { degrees: 90, pages: 'all' },
        inputs: ['labels-kids-mixed.pdf'] },
      { id: 'rotate-nums', tool: 'rotate', values: { degrees: 90, pages: 'all' },
        inputs: ['labels-nums-r.pdf'] },
      { id: 'folios', tool: 'page-numbers', values: { position: 'bottom-center' },
        inputs: ['labels-kids-mixed.pdf'] },
      { id: 'folios-nums', tool: 'page-numbers', values: { position: 'bottom-center' },
        inputs: ['labels-nums-r.pdf'] },
      { id: 'header-footer', tool: 'header-footer', values: { header: 'Running head' },
        inputs: ['labels-kids-mixed.pdf'] },
      { id: 'copy-labels', tool: 'extract-pages', values: { pages: '1-3' },
        inputs: ['labels-kids-mixed.pdf'] },
      { id: 'copy-labels-nums', tool: 'extract-pages', values: { pages: '1-4' },
        inputs: ['labels-nums-r.pdf'] },
      { id: 'merge-labels', tool: 'merge', values: {},
        inputs: ['labels-kids-mixed.pdf', 'labels-nums-r.pdf'] },
      { id: 'replace-labels', tool: 'add-page-labels',
        values: { ranges: '1-2 roman 1\n3-6 decimal 1' }, inputs: ['labels-kids-mixed.pdf'] },
      { id: 'keep-labels', tool: 'add-page-labels', values: { ranges: '1-4 none 1 Cover' },
        inputs: ['labels-nums-r.pdf'] },
      { id: 'append-bookmarks', tool: 'bookmarks', values: { outline: 'Appendix :: 4', replace: false },
        inputs: ['outlines-dests-ref.pdf'] },
      { id: 'copy-outline', tool: 'extract-pages', values: { pages: '1-3' },
        inputs: ['outlines-names-dests-kids-ref.pdf'] },
      { id: 'toc', tool: 'table-of-contents', values: {}, inputs: ['outlines-dests-ref.pdf'] },
      { id: 'redact-titles', tool: 'redact-pdf', values: {
        fill: '#000000',
        alsoMetadata: true,
        regions: [{ page: 0, x: 50, y: 680, width: 320, height: 60 }],
      }, inputs: ['outlines-redactable.pdf'] },
    ];
    for (const trip of trips) {
      const ran = await run(trip.tool, trip.values, ...trip.inputs);
      const produced = join(dump ?? '/tmp', `${trip.id}__${trip.inputs[0]}`);
      if (dump) writeFileSync(produced, ran.bytes);
      rows.roundTrips.push({
        id: trip.id,
        tool: trip.tool,
        input: trip.inputs.join(' + '),
        sha256In: trip.inputs.map((name) => sha256(fixtureBytes(name))).join(','),
        sha256Out: sha256(ran.bytes),
        oursLabels: readPageLabels(ran.doc).map((entry) => entry.label),
        oursOutline: flat(readOutline(ran.doc)),
        itemsNamingATarget: itemsNamingATarget(ran.doc),
        pageLabelStore: pageLabelStore(ran.doc),
        message: ran.outcome.message ?? '',
        warnings: ran.outcome.warnings,
      });
    }
    if (table) writeFileSync(table, `${JSON.stringify(rows, null, 1)}\n`);
    expect(rows.labels).toHaveLength(LABEL_CASES.length);
    expect(rows.outlines).toHaveLength(OUTLINE_CASES.length);
    expect(rows.roundTrips).toHaveLength(trips.length);
  });
});
