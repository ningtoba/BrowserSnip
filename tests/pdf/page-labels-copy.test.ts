/**
 * The page numbering across the page copy — one row per copy shape.
 *
 * `core/doc.ts:carryPageFurniture` is the primitive every tool that rebuilds a
 * document comes through. It carried the bookmarks and the embedded files and had
 * never carried `/PageLabels`, so a file MuPDF numbers `i, ii, I, II, c, xA` came
 * back with **no label store at all**: the document still opened, still had the
 * right page count, and every page number a user cites from it silently changed
 * meaning — a citation to "page c" becomes a citation to page 3. That is the defect
 * this file pins, in the shape `page-copy-fidelity.test.ts` used to pin the bookmark
 * and attachment loss: the produced bytes, read back per sheet.
 *
 * ## Why it is not a carry-across
 *
 * A label range is a statement about **source page indices**: `/Start` says where it
 * begins, `/St` says the number printed there, and §12.4.2 runs it to the next range
 * or the end of the file. Copying pages moves the sheets, so both numbers have to
 * move — and the naive version of that is wrong in exactly the way that looks right.
 * `remapPageLabelRanges` opens a range again whenever the source index and the
 * destination index stop stepping together, which is the one condition under which
 * "the next sheet takes the next number" is still true.
 *
 * ## Reading this file
 *
 * Every input is in `tests/fixtures/readers/` and was written outside this repo by
 * `scripts/readers-foreign-fixtures.py`; each one is hashed against `MANIFEST.json`
 * below, so a row cannot drift because somebody re-ran the generator. The
 * **before** column is measured from the input with the same reader the output is
 * measured with, never copied from a ledger.
 *
 * `docs/research/page-labels-copy-round-trip.py` then asks MuPDF 1.28.2 and pypdf
 * 6.14.2 the same question of the fixture and of the file these tools produced —
 * `BROWSERSNIP_LABEL_DUMP=/tmp/labels python3 docs/research/page-labels-copy-round-trip.py`
 * — and the table it prints is kept in `docs/research/page-labels-copy-table.md`.
 * Those are the readers that did not write the fixture; the assertions here are the
 * same answers held locally so CI sees them without Python.
 *
 * ## The copy cases, per sheet
 *
 * | # | id | copy | input, per sheet | output, per sheet |
 * | - | -- | ---- | ---------------- | ----------------- |
 * | 1 | `copy-full` | extract-pages `all` · `labels-kids-mixed.pdf` | `i, ii, I, II, c, xA` | `i, ii, I, II, c, xA` — four ranges, `/Start` 0, 2, 4, 5 unchanged |
 * | 2 | `copy-subset` | extract-pages `4-6` | `i, ii, I, II, c, xA` | `II, c, xA` — the first surviving range starts at **0** with `/St 2`, not at 4 |
 * | 3 | `copy-reorder-duplicate` | organize `4,1,2,2,6` | `i, ii, I, II, c, xA` | `II, i, ii, ii, xA` — one source range splits over non-adjacent sheets, and a duplicated sheet repeats its label instead of taking the next number |
 * | 4 | `copy-range-discarded` | extract-pages `1-2,6` | `i, ii, I, II, c, xA` | `i, ii, xA` — the two ranges in the middle leave the file rather than claiming a sheet they no longer cover |
 * | 5 | `copy-unlabelled` | extract-pages `all` · `labels-absent.pdf` | *(no store)* `1, 2, 3, 4` | `1, 2, 3, 4`, **no `/PageLabels` written** |
 * | 6 | `copy-subset-prefix` | extract-pages `2-4` · `labels-kids-prefix.pdf` | `§I, §II, A-21, A-22` | `§II, A-21, A-22` — prefix and mid-range offset move together |
 * | 7 | `copy-prefix-only` | extract-pages `1-2` · `labels-nums-prefix-only.pdf` | `Cover , Cover , of i, of ii` | `Cover , Cover ` — no number invented for a range with no `/S` |
 * | 8 | `copy-unknown-style` | extract-pages `all` · `labels-nums-unknown-style.pdf` | `/S /G`: this app `2, 3, 4, 5`, MuPDF no label at all | `2, 3, 4, 5` and the bytes still name `/G` |
 * | 9 | `merge-two-labelled` | merge `labels-kids-mixed.pdf` + `labels-nums-r.pdf` | `i…xA` · `i…iv` | `i, ii, I, II, c, xA, i, ii, iii, iv` — shifted and concatenated, as the bookmarks already are |
 * | 10 | `merge-labelled-with-plain` | merge `labels-kids-mixed.pdf` + `labels-absent.pdf` | `i…xA` · `1…4` | `i, ii, I, II, c, xA, 7, 8, 9, 10` — the plain file reads its position, not the previous file's roman numerals running on |
 * | 11 | `copy-blank-between` | add-blank-page after 1 · `labels-kids-mixed.pdf` | `i, ii, I, II, c, xA` | `i, 2, ii, I, II, c, xA` — a sheet the document never had owns no label, and the run it broke in two opens again on the next sheet |
 * | 12 | `writer-after-copy` | add-page-labels `1-2 roman 1` on row 2's output | `II, c, xA` | `i, ii, iii` — the numbering the copy carried is **replaced**, which is what that tool sells |
 *
 * Rows 1-5 are the five the fix was scoped by. Rows 6-12 are the shapes that separate
 * a remap from a copy-paste, and the two places a copy could quietly invent bytes.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PDFDocument } from '@maxwbh/pdf-lib';
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRef, PDFString, openPDF } from '@/lib/pdf/core/doc';
import {
  readPageLabelRanges,
  readPageLabels,
  type PageLabelRange,
} from '@/lib/pdf/core/bookmarks';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool, type RunOutcome } from '@/lib/pdf/tools/runner';
import type { ToolValues } from '@/lib/pdf/tools/types';

const FIXTURES = resolve(process.cwd(), 'tests/fixtures/readers');
const MANIFEST = JSON.parse(
  readFileSync(resolve(FIXTURES, 'MANIFEST.json'), 'utf8'),
) as Record<string, { sha256: string; shape: string; producer: string }>;

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fixtureBytes = (name: string) => new Uint8Array(readFileSync(resolve(FIXTURES, name)));

/**
 * Produced files, kept so a row can feed on another row's output (`writer-after-copy`
 * numbers the document `copy-subset` built) and written out for the outside readers
 * when `BROWSERSNIP_LABEL_DUMP` names a directory.
 */
const produced = new Map<string, Uint8Array>();

const keep = (id: string, bytes: Uint8Array, testCase?: CopyCase): void => {
  produced.set(id, bytes);
  const dir = process.env.BROWSERSNIP_LABEL_DUMP;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.pdf`), bytes);
  // The row itself travels with the file, so `docs/research/page-labels-copy-round-trip.py`
  // can ask two readers that did not write the fixture the same question the test
  // just asked, and compare their answers against the column asserted here.
  if (testCase) {
    writeFileSync(
      join(dir, `${id}.json`),
      `${JSON.stringify({
        id: testCase.id,
        tool: testCase.tool,
        values: testCase.values,
        inputs: testCase.inputs,
        before: testCase.before,
        after: testCase.after,
        why: testCase.why,
      }, null, 1)}\n`,
    );
  }
};

/** One copy run: the tool, its values, the files it was given, and the answers. */
interface CopyCase {
  id: string;
  tool: string;
  values: ToolValues;
  /** Fixture names, or an earlier case's id for a run that continues its output. */
  inputs: string[];
  /** The numbering each input sheet carried, read out of the input. */
  before: string[];
  /** What the produced file has to say on each of its sheets. */
  after: string[];
  /** The ranges the output must hold, addressed in destination pages. */
  ranges?: { start: number; style: string; prefix?: string; firstPageNumber?: number }[];
  /** Assert the output carries no label store at all. */
  storeAbsent?: boolean;
  why: string;
}

const CASES: CopyCase[] = [
  {
    id: 'copy-full',
    tool: 'extract-pages',
    values: { pages: 'all', mergeIntoOne: true },
    inputs: ['labels-kids-mixed.pdf'],
    before: ['i', 'ii', 'I', 'II', 'c', 'xA'],
    after: ['i', 'ii', 'I', 'II', 'c', 'xA'],
    ranges: [
      { start: 0, style: 'r' },
      { start: 2, style: 'R' },
      { start: 4, style: 'a', firstPageNumber: 3 },
      { start: 5, style: 'A', prefix: 'x' },
    ],
    why: 'a full copy in order leaves every range where it was — the case a carry-across also gets right, which is what makes it the control rather than the fix',
  },
  {
    id: 'copy-subset',
    tool: 'extract-pages',
    values: { pages: '4-6', mergeIntoOne: true },
    inputs: ['labels-kids-mixed.pdf'],
    before: ['i', 'ii', 'I', 'II', 'c', 'xA'],
    after: ['II', 'c', 'xA'],
    ranges: [
      { start: 0, style: 'R', firstPageNumber: 2 },
      { start: 1, style: 'a', firstPageNumber: 3 },
      { start: 2, style: 'A', prefix: 'x' },
    ],
    why: 'the first surviving range’s `/Start` becomes 0 — the destination index of that page — and its `/St` becomes 2, the number the sheet actually carried. Left at 4 and 1, the first two sheets name no range at all and read `1, 2`.',
  },
  {
    id: 'copy-reorder-duplicate',
    tool: 'organize',
    values: { pageOrder: '4,1,2,2,6' },
    inputs: ['labels-kids-mixed.pdf'],
    before: ['i', 'ii', 'I', 'II', 'c', 'xA'],
    after: ['II', 'i', 'ii', 'ii', 'xA'],
    ranges: [
      { start: 0, style: 'R', firstPageNumber: 2 },
      { start: 1, style: 'r' },
      { start: 3, style: 'r', firstPageNumber: 2 },
      { start: 4, style: 'A', prefix: 'x' },
    ],
    why: 'one source range splits over non-adjacent sheets, and a page copied twice repeats its own label rather than taking the next number — §12.4.2 increments per sheet, which only matches the source while both indices step by one',
  },
  {
    id: 'copy-range-discarded',
    tool: 'extract-pages',
    values: { pages: '1-2,6', mergeIntoOne: true },
    inputs: ['labels-kids-mixed.pdf'],
    before: ['i', 'ii', 'I', 'II', 'c', 'xA'],
    after: ['i', 'ii', 'xA'],
    ranges: [
      { start: 0, style: 'r' },
      { start: 2, style: 'A', prefix: 'x' },
    ],
    why: 'the ranges on pages 3-4 and 5 numbered nothing that survived, so both leave the file. Shifted or clamped instead, the third sheet would read `I` or `c` — a number it never had.',
  },
  {
    id: 'copy-unlabelled',
    tool: 'extract-pages',
    values: { pages: 'all', mergeIntoOne: true },
    inputs: ['labels-absent.pdf'],
    before: ['1', '2', '3', '4'],
    after: ['1', '2', '3', '4'],
    storeAbsent: true,
    why: 'the negative control: a document with no `/PageLabels` comes back with no `/PageLabels`. Every reader numbers it by position, so a copy that reported the numbering "preserved" here would have had to invent a dictionary first.',
  },
  {
    id: 'copy-subset-prefix',
    tool: 'extract-pages',
    values: { pages: '2-4', mergeIntoOne: true },
    inputs: ['labels-kids-prefix.pdf'],
    before: ['§I', '§II', 'A-21', 'A-22'],
    after: ['§II', 'A-21', 'A-22'],
    ranges: [
      { start: 0, style: 'R', prefix: '§', firstPageNumber: 2 },
      { start: 1, style: 'D', prefix: 'A-', firstPageNumber: 21 },
    ],
    why: 'a `/P` prefix and a mid-range offset have to survive the move together: `/St 21` at a `/Start` of 0 prints A-21 on the wrong sheet, and `/Start 2` with `/St 1` prints nothing on any of them.',
  },
  {
    id: 'copy-prefix-only',
    tool: 'extract-pages',
    values: { pages: '1-2', mergeIntoOne: true },
    inputs: ['labels-nums-prefix-only.pdf'],
    before: ['Cover ', 'Cover ', 'of i', 'of ii'],
    after: ['Cover ', 'Cover '],
    ranges: [{ start: 0, style: '', prefix: 'Cover ' }],
    why: '§12.4.2 Table 160 makes `/S` optional and both outside readers then show the prefix alone, which is also the shape `add-page-labels` writes for its `none` style. A copy that gave these sheets a number would be adding content the file does not hold.',
  },
  {
    id: 'copy-unknown-style',
    tool: 'extract-pages',
    values: { pages: 'all', mergeIntoOne: true },
    inputs: ['labels-nums-unknown-style.pdf'],
    before: ['2', '3', '4', '5'],
    after: ['2', '3', '4', '5'],
    ranges: [{ start: 0, style: 'G', firstPageNumber: 2 }],
    why: 'the range is `/S /G` with `/St 2` — a style the format does not define, which MuPDF, pypdf and this app answer three ways. A copy is not choosing between them: it writes the name it was given. `addPageLabels`, which is a user typing a style, still refuses one it cannot format.',
  },
  {
    id: 'merge-two-labelled',
    tool: 'merge',
    values: { bookmarks: false },
    inputs: ['labels-kids-mixed.pdf', 'labels-nums-r.pdf'],
    before: ['i', 'ii', 'I', 'II', 'c', 'xA', 'i', 'ii', 'iii', 'iv'],
    after: ['i', 'ii', 'I', 'II', 'c', 'xA', 'i', 'ii', 'iii', 'iv'],
    ranges: [
      { start: 0, style: 'r' },
      { start: 2, style: 'R' },
      { start: 4, style: 'a', firstPageNumber: 3 },
      { start: 5, style: 'A', prefix: 'x' },
      { start: 6, style: 'r' },
    ],
    why: 'each file’s ranges are shifted to where its own sheets landed and concatenated, exactly as the bookmarks already are: the second file restarts its numbering instead of continuing the first’s, and neither overwrites the other.',
  },
  {
    id: 'merge-labelled-with-plain',
    tool: 'merge',
    values: { bookmarks: false },
    inputs: ['labels-kids-mixed.pdf', 'labels-absent.pdf'],
    before: ['i', 'ii', 'I', 'II', 'c', 'xA', '1', '2', '3', '4'],
    after: ['i', 'ii', 'I', 'II', 'c', 'xA', '7', '8', '9', '10'],
    why: 'a range runs to the end of the document unless another one starts, so the plain file’s sheets would otherwise continue `vii, viii, ix, x` in the middle of somebody else’s front matter. Writing their position out loud is what keeps them reading what a file with no numbering reads.',
  },
  {
    id: 'copy-blank-between',
    tool: 'add-blank-page',
    values: { position: 'after', anchor: 1, count: 1, size: 'same' },
    inputs: ['labels-kids-mixed.pdf'],
    before: ['i', 'ii', 'I', 'II', 'c', 'xA'],
    after: ['i', '2', 'ii', 'I', 'II', 'c', 'xA'],
    why: 'the inserted sheet comes from no page of the source, so it has no label of its own; the run it split opens again on the next sheet with the number that sheet carried (`/St 2`, still `ii`).',
  },
  {
    id: 'writer-after-copy',
    tool: 'add-page-labels',
    values: { ranges: '1-2 roman 1' },
    inputs: ['copy-subset'],
    before: ['II', 'c', 'xA'],
    after: ['i', 'ii', 'iii'],
    why: 'the answer to “do the label writers fight this”: no. `add-page-labels` replaces the dictionary — which is what its promise says it does, and its note already says a line runs to the next line or the end of the document — and it now replaces a numbering the copy carried instead of one it wrote itself.',
  },
];

// ---------------------------------------------------------------------------
// Running a case
// ---------------------------------------------------------------------------

const openBytes = (bytes: Uint8Array) =>
  openPDF(bytes, { updateMetadata: false, ignoreEncryption: true });

const labelsOf = (doc: PDFDocument) => readPageLabels(doc).map((entry) => entry.label);

/**
 * The label store as the file holds it — `{}` when there is no `/PageLabels`,
 * `nums`/`kids` counting the pairs and subtrees actually written.
 */
const storeOf = (doc: PDFDocument): Record<string, number> => {
  const raw = doc.catalog.get(PDFName.of('PageLabels'));
  const tree = raw instanceof PDFDict ? raw : doc.catalog.lookupMaybe(PDFName.of('PageLabels'), PDFDict);
  if (!(tree instanceof PDFDict)) return {};
  const size = (key: string) => {
    const value = tree.get(PDFName.of(key));
    const array = value instanceof PDFArray ? value : doc.context.lookupMaybe(value, PDFArray);
    return array?.size() ?? 0;
  };
  const store: Record<string, number> = {};
  if (tree.has(PDFName.of('Nums'))) store.nums = size('Nums');
  if (tree.has(PDFName.of('Kids'))) store.kids = size('Kids');
  return store;
};

/** The `/P` objects the produced file actually holds, in range order. */
const storedPrefixObjects = (doc: PDFDocument): (PDFString | PDFHexString)[] => {
  const tree = doc.catalog.lookupMaybe(PDFName.of('PageLabels'), PDFDict);
  const nums = tree?.lookupMaybe(PDFName.of('Nums'), PDFArray);
  const found: (PDFString | PDFHexString)[] = [];
  if (!(nums instanceof PDFArray)) return found;
  for (let index = 1; index < nums.size(); index += 2) {
    const range = nums.get(index);
    const stored = range instanceof PDFRef ? doc.context.lookup(range) : range;
    if (!(stored instanceof PDFDict)) continue;
    const prefix = stored.get(PDFName.of('P'));
    if (prefix instanceof PDFString || prefix instanceof PDFHexString) found.push(prefix);
  }
  return found;
};

/** The ranges as the produced file stores them, with the defaults left out. */
const shaped = (ranges: PageLabelRange[]) =>
  ranges.map((range) => ({
    start: range.start,
    style: range.style,
    ...(range.prefix ? { prefix: range.prefix } : {}),
    ...(range.firstPageNumber !== undefined && range.firstPageNumber !== 1
      ? { firstPageNumber: range.firstPageNumber }
      : {}),
  }));

const inputBytes = async (name: string): Promise<Uint8Array> => {
  if (name.endsWith('.pdf')) return fixtureBytes(name);
  const carried = produced.get(name);
  expect(carried, `${name} is an earlier case, which has to have run first`).toBeTruthy();
  return carried!;
};

/** Runs one case end to end through the shipped tool, and returns its output. */
const runCase = async (testCase: CopyCase): Promise<RunOutcome> => {
  expect(getPdfTool(testCase.tool), `tool ${testCase.tool} is registered`).toBeTruthy();
  const files = [];
  for (const name of testCase.inputs) {
    const bytes = await inputBytes(name);
    files.push(new File([bytes as BlobPart], `${name}.pdf`, { type: 'application/pdf' }));
  }
  return runPdfTool({
    toolId: testCase.tool,
    files,
    values: testCase.values,
    onProgress: () => undefined,
    onLog: () => undefined,
  });
};

/** The single PDF a case produced, parsed back with the shipped loader. */
const outputOf = async (outcome: RunOutcome, id: string, testCase?: CopyCase) => {
  const pdfs = outcome.outputs.filter((output) => output.name.endsWith('.pdf'));
  expect(pdfs, `${id} produced a PDF`).toHaveLength(1);
  const bytes = new Uint8Array(await pdfs[0].blob.arrayBuffer());
  keep(id, bytes, testCase);
  return openBytes(bytes);
};

// ---------------------------------------------------------------------------
// The inputs are the bytes the generator recorded, and they say what this
// file claims they said
// ---------------------------------------------------------------------------

describe('the foreign fixtures this table copies from', () => {
  it('are the files scripts/readers-foreign-fixtures.py wrote', () => {
    const names = [...new Set(CASES.flatMap((testCase) => testCase.inputs))]
      .filter((name) => name.endsWith('.pdf'));
    expect(names.length, 'the table copies from several foreign fixtures').toBeGreaterThanOrEqual(6);
    for (const name of names) {
      expect(MANIFEST[name], `${name} is in MANIFEST.json`).toBeTruthy();
      expect(sha256(fixtureBytes(name)), `${name} changed since its census`).toBe(
        MANIFEST[name].sha256,
      );
    }
  });

  it('carries no label store on the row that says it carries none', async () => {
    const doc = await openBytes(fixtureBytes('labels-absent.pdf'));
    expect(storeOf(doc)).toEqual({});
    expect(doc.catalog.get(PDFName.of('PageLabels'))).toBeUndefined();
  });

  it('reads, per sheet, the before column this file asserts', async () => {
    // Measured rather than quoted from `docs/research/readers-foreign-repro.md`,
    // because that ledger has been stale three times today.
    for (const testCase of CASES) {
      const each = [];
      for (const name of testCase.inputs) {
        if (!name.endsWith('.pdf')) continue;
        each.push(labelsOf(await openBytes(fixtureBytes(name))));
      }
      if (each.length === 0) continue;
      expect(each.flat(), testCase.id).toEqual(testCase.before);
    }
  });
});

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

describe('the page numbering across a page copy', () => {
  for (const testCase of CASES) {
    it(`${testCase.id}: ${testCase.why}`, async () => {
      const outcome = await runCase(testCase);
      const doc = await outputOf(outcome, testCase.id, testCase);
      expect(doc.getPageCount(), `${testCase.id} page count`).toBe(testCase.after.length);
      // The assertion is the numbering per sheet, not the presence of the key.
      expect(labelsOf(doc), `${testCase.id} labels per sheet`).toEqual(testCase.after);
      if (testCase.storeAbsent) {
        expect(storeOf(doc), `${testCase.id} invented a label store`).toEqual({});
        return;
      }
      expect(storeOf(doc).nums ?? storeOf(doc).kids, `${testCase.id} store`).toBeGreaterThan(0);
      if (testCase.ranges) {
        expect(shaped(readPageLabelRanges(doc)), `${testCase.id} ranges`).toEqual(
          testCase.ranges,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// What the writer writes, rather than what it says it wrote
// ---------------------------------------------------------------------------

describe('the bytes behind the table', () => {
  it('writes one flat /Nums tree, in page order, from a /Kids input', async () => {
    // The input is a two-leaf `/Kids` number tree with every range behind a
    // reference; the output is the flat shape this app writes everywhere, which is
    // the other half of §7.9.7 and the one every reader here accepts. The ranges
    // being in page order is what makes "the first starts at 0" a fact about the
    // file rather than about a reader's sort.
    const testCase = CASES.find((item) => item.id === 'copy-subset')!;
    const input = await openBytes(fixtureBytes(testCase.inputs[0]));
    expect(storeOf(input)).toEqual({ kids: 2 });
    const doc = await outputOf(await runCase(testCase), 'copy-subset', testCase);
    expect(storeOf(doc)).toEqual({ nums: 6 });
    const starts = readPageLabelRanges(doc).map((range) => range.start);
    expect(starts).toEqual([0, 1, 2]);
  });

  it('keeps a style name it does not recognise instead of rewriting it', async () => {
    const testCase = CASES.find((item) => item.id === 'copy-unknown-style')!;
    const doc = await outputOf(await runCase(testCase), 'copy-unknown-style', testCase);
    const tree = doc.catalog.lookupMaybe(PDFName.of('PageLabels'), PDFDict);
    const nums = tree?.lookupMaybe(PDFName.of('Nums'), PDFArray);
    const range = nums?.get(1) as PDFDict;
    expect(range.get(PDFName.of('S'))).toBe(PDFName.of('G'));
    expect(labelsOf(doc)).toEqual(testCase.after);
  });

  it('writes no label store for a file that has none, in every rebuilding tool', async () => {
    for (const [tool, values] of [
      ['extract-pages', { pages: '1-3', mergeIntoOne: true }],
      ['organize', { pageOrder: '3,1,2' }],
      ['reverse-pages', {}],
      ['split', { mode: 'ranges', ranges: '1-2' }],
      ['add-blank-page', { position: 'start', count: 1, size: 'same' }],
      ['remove-pages', { pages: '4' }],
    ] as [string, ToolValues][]) {
      const outcome = await runPdfTool({
        toolId: tool,
        files: [new File([fixtureBytes('labels-absent.pdf') as BlobPart], 'labels-absent.pdf', { type: 'application/pdf' })],
        values,
        onProgress: () => undefined,
        onLog: () => undefined,
      });
      for (const output of outcome.outputs.filter((item) => item.name.endsWith('.pdf'))) {
        const doc = await openBytes(new Uint8Array(await output.blob.arrayBuffer()));
        expect(
          doc.catalog.get(PDFName.of('PageLabels')),
          `${tool} invented /PageLabels on ${output.name}`,
        ).toBeUndefined();
        expect(labelsOf(doc), `${tool} ${output.name}`).toEqual(
          // With no store of its own the file reads its position, sheet by sheet.
          Array.from({ length: doc.getPageCount() }, (_, index) => String(index + 1)),
        );
      }
    }
  });

  it('keeps a prefix in the encoding that survives being read back', async () => {
    // MuPDF's page-label reader copies `/P`'s bytes straight into the label without
    // looking for the UTF-16BE BOM, so a prefix written as `<FEFF0078>` reads back
    // `<FEFF0078>x` there while pypdf says `x` — measured both ways in
    // `docs/research/page-labels-copy-table.md`. §7.9.2.2 allows either text-string
    // encoding, so the writer uses the one every reader here spells back, and keeps
    // the BOM form for what PDFDocEncoding cannot spell.
    const carried = CASES.find((item) => item.id === 'copy-subset-prefix')!;
    const doc = await outputOf(await runCase(carried), carried.id, carried);
    const prefixes = storedPrefixObjects(doc);
    expect(prefixes.map((entry) => entry.decodeText()), 'the prefixes the copy wrote')
      .toEqual(['§', 'A-']);
    for (const prefix of prefixes) {
      expect(prefix instanceof PDFString, 'a prefix PDFDocEncoding can spell stays single-byte')
        .toBe(true);
    }

    // And one it cannot: an Egyptian-hieroglyph prefix has to go in the BOM form,
    // which is the only spelling that holds it — and it still reads back as itself.
    const outcome = await runPdfTool({
      toolId: 'add-page-labels',
      files: [new File([fixtureBytes('labels-nums-r.pdf') as BlobPart], 'labels-nums-r.pdf', { type: 'application/pdf' })],
      values: { ranges: '1-2 roman 1 𓂀' },
      onProgress: () => undefined,
      onLog: () => undefined,
    });
    const wide = await openBytes(new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()));
    const widePrefixes = storedPrefixObjects(wide);
    expect(widePrefixes).toHaveLength(1);
    expect(widePrefixes[0] instanceof PDFHexString, '𓂀 is not in PDFDocEncoding').toBe(true);
    expect(labelsOf(wide).slice(0, 2)).toEqual(['𓂀i', '𓂀ii']);
  });

  it('numbers each file of a split from the pages that went into it', async () => {
    // `split` runs the copy once per output file, so every one of them has to
    // address its ranges from its own first sheet.
    const outcome = await runPdfTool({
      toolId: 'split',
      files: [new File([fixtureBytes('labels-kids-mixed.pdf') as BlobPart], 'labels-kids-mixed.pdf', { type: 'application/pdf' })],
      values: { mode: 'ranges', ranges: '1-2;3-4;5-6' },
      onProgress: () => undefined,
      onLog: () => undefined,
    });
    const perFile = [];
    for (const output of outcome.outputs.filter((item) => item.name.endsWith('.pdf'))) {
      const doc = await openBytes(new Uint8Array(await output.blob.arrayBuffer()));
      expect(storeOf(doc), output.name).not.toEqual({});
      perFile.push(labelsOf(doc));
    }
    expect(perFile).toEqual([['i', 'ii'], ['I', 'II'], ['c', 'xA']]);
  });
});
