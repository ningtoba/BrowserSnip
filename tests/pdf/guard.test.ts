/**
 * The shared input guard layer (`core/guard`, `tools/helpers`, `tools/runner`).
 *
 * These are the matrix rows the guard owns — E1 empty file, E2 renamed
 * non-PDF, E3 corrupt/truncated, E4 locked without a password, E5 locked with
 * one, E6 single-page ranges, E15 out-of-range values, E16 duplicate inputs —
 * asserted against synthetic bytes so no fixture file can drift. Every fixture
 * is built here with pdf-lib: a truncated document is literally a real one with
 * its tail chopped off, which is what a half-downloaded file looks like.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import {
  ToolInputError,
  TOOL_INPUT_ERROR_CODES,
  clampFields,
  clampNumber,
  decodePermissions,
  describeSize,
  describeToolError,
  expandPageRanges,
  fieldBounds,
  inspectPdf,
  isPasswordRequired,
  isToolInputError,
  looksLikePdf,
  openPdfInput,
  pageRangeProblem,
  parsePageRanges,
  preflightPdf,
  validateFields,
} from '@/lib/pdf/core/guard';
import {
  assertPdf,
  openInputs,
  rebuildDocument,
  saved,
  splitDuplicates,
  type OpenedInput,
} from '@/lib/pdf/tools/helpers';
import { openPDF, PasswordRequiredError, saveEncrypted } from '@/lib/pdf/core/doc';
import { saveGateOnly } from './gate-harness';
import type { ToolField, ToolFile, ToolRunContext, ToolValues } from '@/lib/pdf/tools/types';
import { PDF_TOOLS } from '@/lib/pdf/tools/registry';
import { inspectFiles, runPdfTool } from '@/lib/pdf/tools/runner';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function asFile(input: Uint8Array, name: string): File {
  return new File([new Uint8Array(input)], name, { type: 'application/pdf' });
}

function toolFile(input: Uint8Array, name: string): ToolFile {
  return {
    name,
    size: input.length,
    type: 'application/pdf',
    bytes: async () => input,
    blob: () => new Blob([new Uint8Array(input) as BlobPart], { type: 'application/pdf' }),
  };
}

/** A minimal `ToolRunContext`; the guard only needs inputs, progress and log. */
function context(
  inputs: ToolFile[],
  overrides: Partial<ToolRunContext> = {},
): { context: ToolRunContext; logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    context: {
      inputs,
      values: {},
      progress: () => {},
      log: (line) => logs.push(line),
      signal: new AbortController().signal,
      ...overrides,
    },
  };
}

async function sample(pages = 3): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Guard fixture ${i + 1}`, { x: 40, y: 700, size: 18, font, color: rgb(0, 0, 0) });
  }
  return doc.save({ useObjectStreams: false });
}

/** A real document with its tail removed, as a half-saved download looks. */
function truncate(source: Uint8Array, fraction = 0.6): Uint8Array {
  return new Uint8Array(source.subarray(0, Math.floor(source.length * fraction)));
}

/**
 * Byte offset of every page object (`/Type /Page`, not the `/Pages` tree).
 *
 * Cutting the file just before the last one is a *structural* truncation: it
 * always loses exactly one page, where a percentage cut lands wherever the
 * producer happened to put an object and turns "recoverable" into "unparseable"
 * at the drop of a byte.
 */
function pageObjectOffsets(source: Uint8Array): number[] {
  const text = new TextDecoder('latin1').decode(source);
  const offsets: number[] = [];
  const re = /\n\d+ 0 obj\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (/\/Type\s*\/Page(?![s])/.test(text.slice(re.lastIndex, re.lastIndex + 200))) {
      offsets.push(match.index);
    }
  }
  return offsets;
}

/** Every page but the last, with the final page object chopped off. */
function missingLastPage(source: Uint8Array): Uint8Array {
  const offsets = pageObjectOffsets(source);
  expect(offsets.length, 'fixture should contain page objects').toBeGreaterThan(1);
  return new Uint8Array(source.subarray(0, offsets[offsets.length - 1]));
}

async function locked(pages = 1, password = 'hunter2'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([300, 200]);
  return saveEncrypted(doc, { userPassword: password, ownerPassword: password });
}

const field = (over: Partial<ToolField> & { key: string; label: string; type: ToolField['type'] }): ToolField => over;

describe('ToolInputError', () => {
  it('publishes a stable code per refusal the guard can make', () => {
    expect([...TOOL_INPUT_ERROR_CODES].sort()).toEqual([
      'BAD_PASSWORD',
      'CORRUPT',
      'EMPTY_FILE',
      'NEEDS_ENGINE',
      'NOT_A_PDF',
      'NO_PAGES',
      'OUT_OF_RANGE',
      'PASSWORD_REQUIRED',
      'UNSUPPORTED',
    ]);
  });

  it('carries the code, the file name and the hint', () => {
    const error = new ToolInputError('OUT_OF_RANGE', 'Resolution must be between 96 and 400 dpi.', {
      fileName: 'scan.pdf',
      hint: 'Enter 300.',
    });
    expect(isToolInputError(error)).toBe(true);
    expect(error.name).toBe('ToolInputError');
    expect(error.code).toBe('OUT_OF_RANGE');
    expect(error.fileName).toBe('scan.pdf');
    expect(error.hint).toBe('Enter 300.');
    expect(error.passwordRequired).toBe(false);
  });

  it('flags both password codes', () => {
    expect(new ToolInputError('PASSWORD_REQUIRED', 'locked').passwordRequired).toBe(true);
    expect(new ToolInputError('BAD_PASSWORD', 'wrong').passwordRequired).toBe(true);
    expect(new ToolInputError('CORRUPT', 'broken').passwordRequired).toBe(false);
  });

  it('recognises a locked document whatever threw', () => {
    expect(isPasswordRequired(new ToolInputError('BAD_PASSWORD', 'nope'))).toBe(true);
    expect(isPasswordRequired(new PasswordRequiredError())).toBe(true);
    expect(isPasswordRequired(new Error('PDF is encrypted'))).toBe(true);
    expect(isPasswordRequired(new Error('document is not encrypted'))).toBe(false);
    expect(isPasswordRequired(new Error('boom'))).toBe(false);
    expect(isPasswordRequired(undefined)).toBe(false);
  });

  it('flattens any thrown value into something the store can log', () => {
    const typed = describeToolError(new ToolInputError('EMPTY_FILE', '"a.pdf" is empty', { fileName: 'a.pdf' }));
    expect(typed).toEqual({
      code: 'EMPTY_FILE',
      message: '"a.pdf" is empty',
      fileName: 'a.pdf',
      hint: undefined,
      passwordRequired: false,
    });
    const legacy = describeToolError(new Error('Nope.'));
    expect(legacy.code).toBe('CORRUPT');
    expect(legacy.message).toBe('Nope.');
    expect(describeToolError(new Error('Needs a password.')).passwordRequired).toBe(true);
  });
});

describe('inspectPdf never throws', () => {
  it('reports a healthy document', async () => {
    const source = await sample();
    const seen = await inspectPdf(source, 'clean.pdf');
    expect(seen).toMatchObject({
      name: 'clean.pdf',
      isPdf: true,
      pages: 3,
      declaredPages: 3,
      encrypted: false,
      needsPassword: false,
      truncated: false,
      recovered: false,
      error: null,
    });
    expect(seen.size).toBe(source.length);
    expect(seen.version).toBe('1.7');
    expect(seen.message).toContain('3 pages');
  });

  it('survives every kind of garbage', async () => {
    const four = await sample(4);
    const garbage: [string, Uint8Array][] = [
      ['empty.pdf', new Uint8Array(0)],
      ['zeros.pdf', new Uint8Array(32)],
      ['notes.pdf', bytes('just a note, not a document')],
      ['junk.pdf', bytes('%PDF-1.7\nno objects here\n')],
      ['cut.pdf', truncate(four)],
      ['shred.pdf', truncate(four, 0.1)],
      ['tail.pdf', missingLastPage(four)],
      ['big.pdf', new Uint8Array(Array.from({ length: 9000 }, (_, i) => (i * 7) % 251))],
    ];
    for (const [name, input] of garbage) {
      const seen = await inspectPdf(input, name);
      expect(seen.name, name).toBe(name);
      expect(typeof seen.message, name).toBe('string');
      expect(seen.message, name).toContain(name);
    }
  });

  it('looks at the bytes rather than the extension', () => {
    const source = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    expect(looksLikePdf(source)).toBe(true);
    expect(looksLikePdf(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
    expect(looksLikePdf(new Uint8Array(0))).toBe(false);
  });

  it('answers header-and-trailer questions without a parse', async () => {
    const cheap = await inspectPdf(await locked(), 'locked.pdf', { cheap: true });
    expect(cheap.pages).toBe(0);
    expect(cheap.encrypted).toBe(true);
    expect(cheap.error).toBe('PASSWORD_REQUIRED');
    expect(cheap.isPdf).toBe(true);
  });
});

describe('E1 — a 0-byte file', () => {
  it('is refused by name before anything is parsed', async () => {
    const seen = await inspectPdf(new Uint8Array(0), 'download (1).pdf');
    expect(seen.error).toBe('EMPTY_FILE');
    expect(seen.isPdf).toBe(false);
    expect(seen.message).toBe('"download (1).pdf" is empty (0 bytes) — there is nothing to read.');

    expect(() => assertPdf('empty.pdf', new Uint8Array(0))).toThrowError(ToolInputError);
    try {
      assertPdf('empty.pdf', new Uint8Array(0));
    } catch (error) {
      expect(isToolInputError(error) && error.code).toBe('EMPTY_FILE');
    }

    // The pre-flight is handed the runner's `ToolFile` shape (`toToolFile` builds
    // it from a `File`), not a DOM `File`: this environment's `File` has no
    // `blob()` method, so passing one straight in only survived because a 0-byte
    // input is refused before a single byte is read.
    const refusal = await preflightPdf(toolFile(new Uint8Array(0), 'empty.pdf'));
    expect(refusal?.code).toBe('EMPTY_FILE');
    expect(refusal?.fileName).toBe('empty.pdf');

    const harness = context([toolFile(new Uint8Array(0), 'empty.pdf')]);
    await expect(openInputs(harness.context)).rejects.toThrow(/"empty\.pdf" is empty/);
    await expect(openInputs(harness.context)).rejects.toMatchObject({ code: 'EMPTY_FILE' });
  });

  it('reads the edges of a file too big to settle by size alone (E7)', async () => {
    // The empty case above short-circuits before anything is sliced, so this is
    // the only path that proves the pre-flight can open a real file at all.
    expect(await preflightPdf(toolFile(await sample(), 'clean.pdf'))).toBeNull();

    const mislabelled = await preflightPdf(toolFile(bytes('a text file with a .pdf name'), 'report.pdf'));
    expect(mislabelled?.code).toBe('NOT_A_PDF');
    expect(mislabelled?.fileName).toBe('report.pdf');

    const gate = await preflightPdf(toolFile(await locked(), 'locked.pdf'));
    expect(gate?.code).toBe('PASSWORD_REQUIRED');
  });

  it('rejects an empty input list, which is E18 before the click', async () => {
    const harness = context([]);
    await expect(openInputs(harness.context)).rejects.toMatchObject({ code: 'EMPTY_FILE' });
  });
});

describe('E2 — a file that is not a PDF', () => {
  it('says what is wrong and names the format', async () => {
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const seen = await inspectPdf(jpg, 'holiday.JPG');
    expect(seen.error).toBe('NOT_A_PDF');
    expect(seen.message).toMatch(/is not a PDF/);
    expect(seen.message).toMatch(/JPG/);
    expect(seen.hint).toMatch(/export it as a PDF/);
  });

  it('reaches openInputs and the runner with the same sentence', async () => {
    const harness = context([toolFile(bytes('a text file with a .pdf name'), 'report.docx')]);
    await expect(openInputs(harness.context)).rejects.toMatchObject({
      code: 'NOT_A_PDF',
      fileName: 'report.docx',
    });

    await expect(
      runPdfTool({
        toolId: 'rotate',
        files: [new File([bytes('a text file, renamed')], 'notes.pdf', { type: 'application/pdf' })],
        values: { degrees: 90, pages: 'all' },
      }),
    ).rejects.toThrow(/is not a PDF/);
  });
});

describe('E3 — corrupt and truncated input', () => {
  it('recovers a truncated document and reports which pages broke', async () => {
    const seen = await inspectPdf(missingLastPage(await sample(4)), 'cut.pdf');
    expect(seen.truncated).toBe(true);
    expect(seen.error).toBeNull();
    expect(seen.recovered).toBe(true);
    expect(seen.declaredPages).toBe(4);
    expect(seen.pages).toBe(3);
    expect(seen.message).toBe('"cut.pdf" is damaged but recoverable: read 3 of 4 pages.');
    expect(seen.hint).toMatch(/after the break/);
  });

  it('logs the recovery so success is never silent', async () => {
    const harness = context([toolFile(missingLastPage(await sample(4)), 'cut.pdf')]);
    const opened: OpenedInput[] = await openInputs(harness.context);
    expect(opened).toHaveLength(1);
    expect(opened[0].pageCount).toBe(3);
    expect(opened[0].inspection?.recovered).toBe(true);
    expect(harness.logs.join('\n')).toMatch(/Recovered "cut\.pdf".*read 3 of 4 pages/s);
  });

  it('refuses a file whose header is the only PDF thing about it', async () => {
    const shred = truncate(await sample(4), 0.15);
    const seen = await inspectPdf(shred, 'shred.pdf');
    expect(seen.error).toBe('CORRUPT');
    expect(seen.message).toMatch(/"shred\.pdf" is damaged: its PDF structure could not be parsed\./);
    expect(seen.hint).toMatch(/end-of-file marker/);
    expect(seen.detail).toBeTruthy();
    await expect(openPdfInput(shred, 'shred.pdf')).rejects.toMatchObject({
      code: 'CORRUPT',
      fileName: 'shred.pdf',
    });

    const headerOnly = await inspectPdf(bytes('%PDF-1.7\nno objects here\n'), 'broken.pdf');
    expect(headerOnly.error).toBe('CORRUPT');
  });

  it('calls a PDF with no pages unusable instead of exporting nothing', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    doc.removePage(0);
    const seen = await inspectPdf(await doc.save({ addDefaultPage: false }), 'pageless.pdf');
    expect(seen.error).toBe('NO_PAGES');
    expect(seen.message).toMatch(/has no pages/);
  });
});

describe('E4 and E5 — encrypted documents', () => {
  it('asks for a password instead of hanging or failing opaquely', async () => {
    const source = await locked(2);
    const seen = await inspectPdf(source, 'contract.pdf');
    expect(seen.encrypted).toBe(true);
    // What the engine writes, read off the file: `/V 4 /R 4` with the crypt filter
    // /StdCF selected, i.e. a cipher and not merely a prompt.
    expect(seen.algorithm).toBe('AES-128');
    expect(seen.needsPassword).toBe(true);
    expect(seen.passwordAccepted).toBe(false);
    expect(seen.pages).toBe(2);
    expect(seen.error).toBe('PASSWORD_REQUIRED');

    const harness = context([toolFile(source, 'contract.pdf')]);
    const failure = await openInputs(harness.context).catch((error: unknown) => error);
    expect(isToolInputError(failure) && failure.code).toBe('PASSWORD_REQUIRED');
    expect(isPasswordRequired(failure)).toBe(true);
    expect((failure as ToolInputError).message).toMatch(/"contract\.pdf" is password protected/);
    expect((failure as ToolInputError).hint).toMatch(/password/i);
  });

  it('rejects a wrong password with its own code', async () => {
    const seen = await inspectPdf(await locked(), 'contract.pdf', { password: 'wrong' });
    expect(seen.error).toBe('BAD_PASSWORD');
    expect(seen.passwordAccepted).toBe(false);
    expect(seen.needsPassword).toBe(true);
    expect(seen.message).toMatch(/password is not correct for "contract\.pdf"/);
  });

  it('opens with the right password and produces an unencrypted output', async () => {
    const source = await locked(2);
    const opened = await openPdfInput(source, 'contract.pdf', { password: 'hunter2' });
    expect(opened.inspection.passwordAccepted).toBe(true);
    expect(opened.inspection.error).toBeNull();
    expect(opened.doc.getPageCount()).toBe(2);

    // Two shapes, two answers, and both are the file's rather than the code's.
    // A ciphered document reaches the tool already decrypted, so a plain save of
    // it is an open file; a `/None` gate is never decrypted, the vendor keeps its
    // trailer entry across a save, and only a rebuild drops it. That difference is
    // why `unlock` rebuilds instead of re-saving (E5).
    const lazy = await inspectPdf(await saved(opened.doc), 'lazy.pdf');
    expect(lazy.encrypted, 'the decrypt pass dropped /Encrypt, so the plain save is open').toBe(false);
    const gatedDoc = await openPDF(await saveGateOnly(await PDFDocument.create(), { userPassword: 'hunter2' }), { password: 'hunter2' });
    const gatedLazy = await inspectPdf(await saved(gatedDoc), 'gate.pdf');
    expect(gatedLazy.encrypted, 'a gate survives a plain save, so an unlock has to rebuild').toBe(true);
    const rebuilt = await inspectPdf(await saved(await rebuildDocument(opened.doc)), 'unlocked.pdf');
    expect(rebuilt.encrypted).toBe(false);
    expect(rebuilt.error).toBeNull();
    expect(rebuilt.pages).toBe(2);
  });

  it('reads the permission flags without a password', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]);
    const source = await saveEncrypted(doc, {
      userPassword: 'pw',
      ownerPassword: 'pw',
      permissions: { printing: true, copying: false, modifying: true },
    });
    const seen = await inspectPdf(source, 'restricted.pdf');
    expect(seen.algorithm).toBe('AES-128');
    expect(seen.permissions).toMatchObject({
      printing: true,
      modifying: true,
      copying: false,
      fillingForms: false,
    });
  });

  it('decodes the /P bitfield the specification defines', () => {
    const all = decodePermissions(-4);
    expect([
      all.printing,
      all.printingHighQuality,
      all.modifying,
      all.copying,
      all.annotating,
      all.fillingForms,
      all.contentAccessibility,
      all.documentAssembly,
    ]).toEqual([true, true, true, true, true, true, true, true]);
    expect(decodePermissions(0).printing).toBe(false);
    expect(decodePermissions(4).printing).toBe(true);
    expect(decodePermissions(16).copying).toBe(true);
    expect(decodePermissions(-1).raw).toBe(-1);
  });
});

describe('E6 — page ranges against a real page count', () => {
  it('parses the tolerant grammar, 1-based', () => {
    expect(parsePageRanges('1-3,5,7-')).toEqual([
      { from: 1, to: 3 },
      { from: 5, to: 5 },
      { from: 7, to: Infinity },
    ]);
    expect(parsePageRanges(' 2 , 4-4 ; ')).toEqual([{ from: 2, to: 2 }, { from: 4, to: 4 }]);
    expect(parsePageRanges('')).toEqual([{ from: 1, to: Infinity }]);
    expect(parsePageRanges('all', { total: 4 })).toEqual([{ from: 1, to: 4 }]);
    expect(parsePageRanges(null)).toEqual([{ from: 1, to: Infinity }]);
    expect(expandPageRanges(parsePageRanges('3,1-2'), 5)).toEqual([3, 1, 2]);
    expect(expandPageRanges(parsePageRanges('4-'), 5)).toEqual([4, 5]);
  });

  it('rejects the mistakes that silently change a document', () => {
    expect(() => parsePageRanges('0')).toThrowError(ToolInputError);
    expect(() => parsePageRanges('0')).toThrow(/page 0; pages are numbered from 1/);
    expect(() => parsePageRanges('5-3')).toThrow(/runs backwards/);
    expect(() => parsePageRanges('two')).toThrow(/is not a page number/);
    expect(() => parsePageRanges(' , ')).toThrow(/did not name any page/);
    // An open end is only meaningful once the page count is known.
    expect(parsePageRanges('3-')).toEqual([{ from: 3, to: Infinity }]);
    for (const bad of ['0', '5-3', 'two', '1-40']) {
      const error = (() => {
        try {
          parsePageRanges(bad, { total: 10 });
          return null;
        } catch (caught) {
          return caught;
        }
      })();
      expect(isToolInputError(error) && error.code, bad).toBe('OUT_OF_RANGE');
    }
  });

  it('accepts page 1 and refuses page 2 of a single-page document', async () => {
    const source = await sample(1);
    const seen = await inspectPdf(source, 'one.pdf');
    expect(seen.pages).toBe(1);
    expect(pageRangeProblem('1', seen.pages)).toBeNull();
    expect(pageRangeProblem('2', seen.pages)).toMatch(/page 2, but this document has 1 page/);
    expect(pageRangeProblem('all', seen.pages)).toBeNull();
    expect(pageRangeProblem('odd', seen.pages)).toBeNull();
    expect(pageRangeProblem('even', seen.pages)).toMatch(/no even pages/);
    expect(pageRangeProblem('', seen.pages)).toBeNull();
    expect(expandPageRanges(parsePageRanges('1', { total: 1 }), 1)).toEqual([1]);
    expect(expandPageRanges(parsePageRanges('1-3', { total: 3 }), 3)).toEqual([1, 2, 3]);
    expect(() => expandPageRanges([{ from: 4, to: 6 }], 3)).toThrow(/outside this document \(1-3\)/);
  });
});

describe('E15 — numeric fields', () => {
  it('clamps into bounds and treats nonsense as the minimum', () => {
    expect(clampNumber(1200, 96, 400)).toBe(400);
    expect(clampNumber(-5, 96, 400)).toBe(96);
    expect(clampNumber(200, 96, 400)).toBe(200);
    expect(clampNumber(NaN, 96, 400)).toBe(96);
    expect(clampNumber(Infinity, 96, 400)).toBe(400);
    expect(clampNumber(300, 400, 96)).toBe(300);
    expect(clampNumber(4.6, 0, 10, { integer: true })).toBe(5);
  });

  it('reads bounds off a ToolField without re-typing them', () => {
    expect(fieldBounds(field({ key: 'dpi', label: 'Resolution', type: 'slider', min: 96, max: 400, unit: 'dpi' })))
      .toEqual({ min: 96, max: 400, integer: false, step: undefined, unit: 'dpi' });
    expect(fieldBounds(field({ key: 'a', label: 'A', type: 'number', min: 10, max: 2 })))
      .toMatchObject({ min: 2, max: 10 });
    expect(fieldBounds(field({ key: 't', label: 'Text', type: 'text', min: 1 }))).toBeNull();
  });

  it('reports the reason, and the value that would fix it', () => {
    const fields = [
      field({ key: 'dpi', label: 'Resolution', type: 'number', min: 96, max: 400, unit: 'dpi' }),
      field({ key: 'quality', label: 'Quality', type: 'slider', min: 0.05, max: 1 }),
      field({ key: 'copies', label: 'Copies', type: 'number', min: 1, max: 9, integer: true }),
      field({ key: 'name', label: 'File stamp', type: 'text', required: true }),
      field({ key: 'note', label: 'Note', type: 'text', required: true, optional: true }),
      field({ key: 'mode', label: 'Mode', type: 'select', options: [{ value: 'a', label: 'A' }] }),
      field({ key: 'hidden', label: 'Hidden', type: 'number', min: 5, max: 6, when: () => false }),
    ];
    const issues = validateFields(fields, {
      dpi: 2000,
      quality: 'fine',
      copies: 2.5,
      name: '   ',
      note: '',
      mode: 'zzz',
      hidden: 100,
    });
    expect(issues.map((issue) => issue.code)).toEqual([
      'OUT_OF_RANGE',
      'NOT_A_NUMBER',
      'NOT_INTEGER',
      'REQUIRED',
      'BAD_PATTERN',
    ]);
    expect(issues[0].message).toBe('Resolution must be between 96 and 400 dpi (got 2000).');
    expect(issues[0].suggestion).toBe(400);
    expect(issues[1].message).toBe('Quality must be a number.');
    expect(issues[2].suggestion).toBe(3);
    expect(issues[3].key).toBe('name');
    expect(issues[4].message).toMatch(/one of a/);
  });

  it('checks a pattern and leaves optional blanks alone', () => {
    const fields = [
      field({ key: 'psw', label: 'Password', type: 'password', pattern: '^(?=.*[0-9]).{8,}$' }),
      field({ key: 'why', label: 'Reason', type: 'text' }),
    ];
    expect(validateFields(fields, { psw: 'short', why: '' })).toEqual([
      { key: 'psw', label: 'Password', code: 'BAD_PATTERN', message: 'Password does not match the expected format.' },
    ]);
    expect(validateFields(fields, { psw: 'longenough1', why: 'x' })).toEqual([]);
    expect(validateFields(undefined, {})).toEqual([]);
  });

  it('ignores fields hidden by a when predicate instead of inventing values', () => {
    const fields = [
      field({ key: 'kind', label: 'Kind', type: 'segmented', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }),
      field({ key: 'extra', label: 'Extra', type: 'number', min: 1, max: 4, when: (v) => v.kind === 'b' }),
    ];
    expect(validateFields(fields, { kind: 'a', extra: null })).toEqual([]);
    expect(validateFields(fields, { kind: 'b', extra: 9 }).map((i) => i.code)).toEqual(['OUT_OF_RANGE']);
  });

  it('fixes out-of-range numbers instead of failing the run, and says so', () => {
    const fields = [
      field({ key: 'dpi', label: 'Resolution', type: 'slider', min: 96, max: 400, unit: 'dpi' }),
      field({ key: 'margin', label: 'Margin', type: 'number', min: 0, max: 72, unit: 'pt' }),
      field({ key: 'count', label: 'Copies', type: 'number', min: 1, max: 9, integer: true }),
      field({ key: 'blank', label: 'Blank', type: 'number', min: 1, max: 9 }),
    ];
    const values: ToolValues = { dpi: 0, margin: -8, count: '3.4', blank: null };
    const result = clampFields(fields, values);
    expect(result.values).toEqual({ dpi: 96, margin: 0, count: 3, blank: null });
    expect(values).toEqual({ dpi: 0, margin: -8, count: '3.4', blank: null });
    expect(result.changes.map((change) => change.message)).toEqual([
      'Resolution must be between 96 and 400 dpi: 0 became 96.',
      'Margin must be between 0 and 72 pt: -8 became 0.',
      'Copies must be between 1 and 9: 3.4 became 3.',
    ]);
    expect(result.changes[0]).toMatchObject({ key: 'dpi', label: 'Resolution', from: 0, to: 96 });
  });

  it('sizes are readable wherever bytes are shown', () => {
    expect(describeSize(0)).toBe('0 B');
    expect(describeSize(-12)).toBe('0 B');
    expect(describeSize(912)).toBe('912 B');
    expect(describeSize(1024)).toBe('1.0 KB');
    expect(describeSize(1536)).toBe('1.5 KB');
    expect(describeSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(describeSize(new Uint8Array(2048))).toBe('2.0 KB');
    expect(describeSize(new Blob([new Uint8Array(300000)]))).toBe('293 KB');
  });
});

describe('E16 — duplicate inputs', () => {
  it('treats a repeat as the same name and the same bytes', () => {
    const queue = [
      { name: 'a.pdf', data: bytes('one') },
      { name: 'a.pdf', data: bytes('one') },
      { name: 'a.pdf', data: bytes('two') },
      { name: 'b.pdf', data: bytes('one') },
    ];
    const { kept, dropped } = splitDuplicates(
      queue,
      (item) => item.data,
      (item) => item.name,
    );
    expect(kept).toEqual([queue[0], queue[2], queue[3]]);
    expect(dropped).toEqual([queue[1]]);
  });

  it('opens each document once when a tool asks for uniqueness', async () => {
    const source = await sample(2);
    const other = await sample(1);
    const harness = context([toolFile(source, 'a.pdf'), toolFile(source, 'a.pdf'), toolFile(other, 'a.pdf')]);
    const opened = await openInputs(harness.context, { duplicates: 'skip' });
    expect(opened).toHaveLength(2);
    expect(opened.map((input) => input.pageCount)).toEqual([2, 1]);
    expect(harness.logs.join('\n')).toMatch(/Ignored the second copy of "a\.pdf"/);
  });

  it('keeps every copy by default, because the list is the plan', async () => {
    const source = await sample(2);
    const file = toolFile(source, 'a.pdf');
    const harness = context([file, file, toolFile(await sample(1), 'b.pdf')]);
    const opened = await openInputs(harness.context);
    expect(opened.map((input) => input.pageCount)).toEqual([2, 2, 1]);
    expect(harness.logs.join('\n')).not.toMatch(/Ignored/);
  });

  it('keeps every entry when a tool counts them', async () => {
    const source = await sample(1);
    const file = toolFile(source, 'a.pdf');
    const harness = context([file, file]);
    const opened = await openInputs(harness.context, { duplicates: 'keep' });
    expect(opened).toHaveLength(2);
    expect(harness.logs).toEqual([]);
  });

  it('is refused up-front by a single-document tool', async () => {
    const source = await sample(1);
    const file = asFile(source, 'twice.pdf');
    await expect(
      runPdfTool({ toolId: 'rotate', files: [file, file], values: { degrees: 90, pages: 'all' } }),
    ).rejects.toMatchObject({ code: 'OUT_OF_RANGE', fileName: 'twice.pdf' });
  });

  it('merges a repeated file as many times as it was listed', async () => {
    const source = await sample(2);
    const file = asFile(source, 'a.pdf');
    const logs: string[] = [];
    const outcome = await runPdfTool({
      toolId: 'merge',
      files: [file, file],
      values: { bookmarks: false },
      onLog: (line) => logs.push(line),
    });
    // Merging report.pdf with itself is a real request, so the output has both
    // copies rather than a silently halved document (E16).
    expect(logs.join('\n')).not.toMatch(/Ignored the second copy/);
    const seen = await inspectPdf(new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()), 'merged.pdf');
    expect(seen.pages).toBe(4);
  });
});

describe('the runner gate', () => {
  it('names a locked document before the tool starts, and asks for a password', async () => {
    const source = await locked(2);
    const failure = await runPdfTool({
      toolId: 'rotate',
      files: [asFile(source, 'locked.pdf')],
      values: { degrees: 90, pages: 'all' },
    }).catch((error: unknown) => error);
    expect(isPasswordRequired(failure)).toBe(true);
    expect((failure as ToolInputError).code).toBe('PASSWORD_REQUIRED');
    expect((failure as ToolInputError).message).toMatch(/"locked\.pdf" is password protected/);
  });

  it('runs a locked document once the password arrives', async () => {
    const source = await locked(2);
    const outcome = await runPdfTool({
      toolId: 'rotate',
      files: [asFile(source, 'locked.pdf')],
      values: { degrees: 180, pages: 'all' },
      password: 'hunter2',
    });
    const reopened = await inspectPdf(new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()), 'rotated.pdf', {
      password: 'hunter2',
    });
    expect(reopened.passwordAccepted).toBe(true);
    expect(reopened.pages).toBe(2);
    expect(reopened.truncated).toBe(false);
  });

  it('clamps an absurd number instead of producing a broken file', async () => {
    const source = await sample(1);
    const logs: string[] = [];
    const outcome = await runPdfTool({
      toolId: 'add-blank-page',
      files: [asFile(source, 'one.pdf')],
      values: { position: 'end', count: 9000, size: 'same' },
      onLog: (line) => logs.push(line),
    });
    // The label is copy and the clamp is behaviour, so assert the latter — and
    // assert the unit too, because a bare "between 1 and 200" on a field counted
    // in pages is the E15 ambiguity this message exists to remove.
    expect(logs.join('\n')).toMatch(/must be between 1 and 200 pages: 9000 became 200\./);
    const seen = await inspectPdf(new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()), 'blanks.pdf');
    expect(seen.pages).toBe(201);
  });

  it('explains a tool that cannot run offline with a code', async () => {
    const blocked = PDF_TOOLS.find((tool) => tool.unavailable);
    expect(blocked, 'the catalogue is expected to list offline gaps').toBeTruthy();
    const failure = await runPdfTool({ toolId: blocked!.id, files: [], values: {} }).catch((error: unknown) => error);
    expect(isToolInputError(failure) && failure.code).toBe('UNSUPPORTED');
  });

  it('inspects a queue without running anything', async () => {
    const source = await sample(2);
    const inspections = await inspectFiles([
      asFile(source, 'good.pdf'),
      asFile(new Uint8Array(0), 'empty.pdf'),
      asFile(bytes('plain text'), 'notes.pdf'),
    ]);
    expect(inspections.map((seen) => seen.error)).toEqual([null, 'EMPTY_FILE', 'NOT_A_PDF']);
    expect(inspections[0].pages).toBe(2);
    expect(inspections.map((seen) => describeSize(seen.size))).toEqual([describeSize(source.length), '0 B', describeSize(10)]);
  });
});
