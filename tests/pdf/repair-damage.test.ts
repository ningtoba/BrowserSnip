/**
 * The `repair` damage corpus, pinned.
 *
 * `docs/TOOL-TRIAGE.md` §2 measured this tool taking a file that MuPDF, qpdf and
 * poppler each still open as 4 pages and handing back **1 page at 0.00 % ink**
 * under the sentence *"Repaired repaired-target.pdf: 1 page(s) readable."* A
 * smaller, silently empty output described as a success is worse than a refusal:
 * the user has no reason to open the result, and the ledger's own numbers for that
 * run were 1 sheet, 0 ink, 0 characters, 1 658 bytes.
 *
 * The rules under test, from that row and the campaign's standing rules:
 *
 *   1. repair never reports more recovered than the input declared without naming
 *      what was lost;
 *   2. it never returns fewer sheets than it could have preserved — the bytes are
 *      re-read through a rebuilt index before the tool gives up, and the strategy
 *      that keeps the most content wins;
 *   3. when the page tree survives and the content streams do not, the report says
 *      the content is gone. A blank sheet **fails** here; it is not a value that
 *      merely differs from the expectation.
 *
 * Every produced file is read back with **pdf.js** — the engine this app renders
 * with, and a different implementation from the pdf-lib fork that wrote the bytes,
 * because this app's own writer cannot grade its own repair. "Blank" is the display
 * list pdf.js hands the renderer: no `showText`/`fill`/`stroke`/`paintImageXObject`
 * means nothing can appear on the sheet. The pixel half of the same claim, plus
 * qpdf, poppler, pypdf and Ghostscript, is
 * `docs/research/repair-damage-readers.py`; the expectations below are its numbers.
 *
 * Red without the fix, 6 of these tests: the two cases whose index is unreadable
 * (`triage-report`, `plain-content-tailcut`) and `truncated-tail` come back as a
 * refusal, `objstm-wrong-offsets` refuses while quoting `this.catalog.Pages is not a
 * function`, and `ledger-32-input`'s shape — the harvest pasting ciphertext into a
 * page — is the 1-blank-sheet success in rules 1 and 3.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as pdfjs from 'pdfjs-dist';
import { GlobalWorkerOptions, OPS } from 'pdfjs-dist';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { buildDamageCorpus, DAMAGE_CASES, SHEET_WORDS, type DamageCase } from './repair-damage-corpus';

/**
 * The Ghostscript fallback is a CDN fetch. Nothing here should need it: with the
 * local reader fixed, every case is answered in the tab, and a case that still asks
 * for the engine reports that instead of quietly passing on a downloaded wasm blob.
 */
const engine = vi.hoisted(() => ({ calls: 0 }));

vi.mock('@/lib/pdf/core/engine-ops', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/core/engine-ops')>();
  return {
    ...real,
    engineReady: () => false,
    rebuildWithGhostscript: async () => {
      engine.calls += 1;
      throw new Error('test double: Ghostscript is not fetched in this rig');
    },
  };
});

/** Operators that put something on the paper, by pdf.js's own semantic names. */
const PAINT_IDS = new Set([
  'stroke', 'closeStroke', 'fill', 'eoFill', 'fillStroke', 'eoFillStroke',
  'closeFillStroke', 'closeEOFillStroke', 'shadingFill', 'paintXObject',
  'paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject',
  'paintImageXObjectRepeat', 'paintSolidColorImageMask',
  'showText', 'showSpacedText', 'nextLineShowText', 'nextLineSetSpacingShowText',
].map((name) => (OPS as unknown as Record<string, number>)[name]));

beforeAll(() => {
  // `core/render` assigns a `new URL(…)` worker source on import, which a bare
  // Node/vitest run cannot resolve; the setter keeps the on-disk worker, so the
  // readings below are pdf.js's real parser and not a stub.
  let workerPath = `file://${process.cwd()}/node_modules/pdfjs-dist/build/pdf.worker.mjs`;
  Object.defineProperty(GlobalWorkerOptions, 'workerSrc', {
    configurable: true,
    get: () => workerPath,
    set: (value: string) => {
      if (value.startsWith('file:') || value.startsWith('data:')) workerPath = value;
    },
  });
}, 120_000);

interface Reading {
  pages: number;
  /** Sheets whose extracted text holds at least one planted word. */
  withWords: number;
  /** Sheets whose display list holds no painting operator. */
  blank: number;
  firstLines: string[];
}

/** Read one file with pdf.js. Throws with the reader's own words when it refuses. */
async function read(bytes: Uint8Array, what: string): Promise<Reading> {
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(bytes.slice()),
      isEvalSupported: false,
      disableAutoFetch: true,
    }).promise;
  } catch (error) {
    throw new Error(`${what}: pdf.js will not open it (${String((error as Error).message).slice(0, 60)})`);
  }
  let withWords = 0;
  let blank = 0;
  const firstLines: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const [content, operators] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
    const text = content.items.map((item) => String('str' in item ? item.str : '')).join(' ');
    if (SHEET_WORDS.some((word) => text.includes(word))) withWords += 1;
    if (!(operators.fnArray as number[]).some((id) => PAINT_IDS.has(id))) blank += 1;
    firstLines.push(text.trim().slice(0, 38) || '(nothing)');
    page.cleanup();
  }
  const pages = doc.numPages;
  await doc.destroy();
  return { pages, withWords, blank, firstLines };
}

async function readOrNull(bytes: Uint8Array): Promise<Reading | null> {
  try {
    return await read(bytes, 'input');
  } catch {
    return null;
  }
}

function pdfFile(bytes: Uint8Array, name: string): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}

interface Run {
  ok: boolean;
  message: string;
  warnings: string;
  pagesOut: number | null;
  bytes: Uint8Array;
}

/** The shipped runner over one damaged file, refusal included. */
async function repair(bytes: Uint8Array, name: string): Promise<Run> {
  engine.calls = 0;
  try {
    const outcome = await runPdfTool({ toolId: 'repair', files: [pdfFile(bytes, name)], values: {} });
    return {
      ok: true,
      message: outcome.message ?? '',
      warnings: outcome.warnings.join(' '),
      pagesOut: outcome.pagesOut,
      bytes: new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      warnings: '',
      pagesOut: null,
      bytes: new Uint8Array(0),
    };
  }
}

const corpus = await buildDamageCorpus();
const byName = new Map<string, { bytes: Uint8Array; case: DamageCase }>(
  corpus.cases.map((item) => [item.case.id, item]),
);

describe('the damage corpus, one case at a time', () => {
  it('carries every case the module declares', () => {
    expect(byName.size).toBe(DAMAGE_CASES.length);
  });

  for (const item of corpus.cases) {
    const spec = item.case.expect;

    it(`${item.case.id}: keeps what the file holds and names what it gave up`, async () => {
      const run = await repair(item.bytes, `${item.case.id}.pdf`);
      expect(run.message, `${item.case.id}: no refusal quoting the engine`).not.toMatch(
        /is not a function|undefined|Cannot read|of null/,
      );
      if (!spec.mustProduce) {
        expect(`${run.message} ${run.warnings}`, 'a refusal must say what it gave up')
          .toMatch(/could not be repaired|too damaged/i);
        return;
      }
      expect(run.ok, run.message).toBe(true);

      const out = await read(run.bytes, item.case.id);
      // Rule 2: the count a reader gets, exactly. A blank sheet is not a pass.
      expect(out.pages, `${item.case.id}: sheets`).toBe(spec.repairedPages);
      expect(out.withWords, `${item.case.id}: planted words · ${JSON.stringify(out.firstLines)}`)
        .toBe(spec.repairedSheetsWithWords);
      expect(out.blank, `${item.case.id}: sheets that draw nothing · ${JSON.stringify(out.firstLines)}`)
        .toBe(spec.repairedBlankSheets);
      expect(run.pagesOut, `${item.case.id}: pagesOut vs pdf.js`).toBe(out.pages);

      // Rule 1: the sentence states the number the bytes hold.
      const claimed = Number(/: (?:(\d+) of \d+|(\d+)) page\(s\)/.exec(run.message)?.slice(1).find(Boolean) ?? -1);
      expect(claimed, `${item.case.id}: the sentence's count vs the file`).toBe(out.pages);

      // Rule 3, and rule 1 again: nothing may be given up silently.
      if (out.blank > 0) {
        expect(`${run.message} ${run.warnings}`, `${item.case.id}: blank sheets must be named`)
          .toMatch(/blank/);
        expect(run.message, `${item.case.id}: paper is not "readable"`).not.toMatch(/readable/);
      }
      if (out.pages < spec.inputPages) {
        expect(`${run.message} ${run.warnings}`, `${item.case.id}: lost pages must be named`)
          .toMatch(/of \d+ page\(s\)|could not be recovered/);
      }
      // What our own renderer reads out of the damaged input is a floor the output
      // may not fall under — the same comparison MuPDF makes in the harness.
      const before = await readOrNull(item.bytes);
      if (before) {
        expect(out.pages, `${item.case.id}: fewer sheets than pdf.js still reads in the input`)
          .toBeGreaterThanOrEqual(before.pages);
      }
      expect(engine.calls, `${item.case.id}: answered in the tab, not by Ghostscript`).toBe(0);
    });
  }
});

/**
 * The three shapes the campaign keeps meeting, asserted by name so a future change
 * cannot trade them back for a tidier code path.
 */
describe('the shapes the report must never confuse', () => {
  it('an index that lies over a whole document: 4 sheets in, 4 sheets out, all drawn', async () => {
    const damaged = byName.get('lying-xref')!;
    const run = await repair(damaged.bytes, 'lying-xref.pdf');
    const out = await read(run.bytes, 'lying-xref');
    // MuPDF, qpdf, poppler, pypdf and pdf.js all read 4 sheets from the input.
    expect(out.pages).toBe(4);
    expect(out.withWords).toBe(4);
    expect(out.blank).toBe(0);
    expect(run.message).toContain('4 page(s) readable');
    expect(run.message).not.toMatch(/blank|could not be recovered/);
  });

  it('the ledger shape: pages listed but not present are named, not counted', async () => {
    const damaged = byName.get('truncated-tail')!;
    const run = await repair(damaged.bytes, 'truncated-tail.pdf');
    const out = await read(run.bytes, 'truncated-tail');
    // 45 % of the tail is gone: two page objects survive, one of them with its
    // operators. Before the fix this file was refused outright.
    expect(out.pages).toBe(2);
    expect(out.withWords).toBe(1);
    expect(out.blank).toBe(1);
    expect(run.message).toMatch(/2 of 4 page\(s\) recovered/);
    expect(run.message).toMatch(/1 is blank/);
    expect(run.message).not.toMatch(/readable/);
    expect(run.warnings).toMatch(/2 page\(s\) could not be recovered/);
    expect(run.warnings).toMatch(/is blank: its content stream holds no drawing operator/);
  });

  it('no page tree at all: the harvest decodes, and says the size and order are a guess', async () => {
    const damaged = byName.get('objstm-wrong-offsets')!;
    const run = await repair(damaged.bytes, 'objstm-wrong-offsets.pdf');
    const out = await read(run.bytes, 'objstm-wrong-offsets');
    // MuPDF reads 0 pages and qpdf refuses this file; poppler reads 4. The sheets
    // come back carrying their words because the payloads are decoded — the first
    // cut at this pasted `/FlateDecode` ciphertext into a page that claimed
    // plaintext, which is how a "repaired" file arrived at 0.00 % ink.
    expect(out.pages).toBe(4);
    expect(out.withWords).toBe(4);
    expect(run.warnings).toMatch(/No page tree survived/);
    expect(run.message).not.toMatch(/is not a function|Cannot read/);
  });

  it('a sound file is still just re-written, with no loss to report', async () => {
    const base = corpus.bases[0];
    const run = await repair(base.bytes, 'base.pdf');
    const out = await read(run.bytes, 'base');
    expect(out.pages).toBe(4);
    expect(out.withWords).toBe(4);
    expect(out.blank).toBe(0);
    expect(run.message).toContain('4 page(s) readable');
    expect(run.warnings).toContain('without losing pages (4 in, 4 out)');
    expect(run.warnings).not.toMatch(/blank|could not be recovered/);
  });
});
