/**
 * `linearize-pdf` must produce a linearized file, or say plainly that it did not.
 *
 * The tool had been crediting a capability its engine does not have. CoherentPDF
 * removed linearization from the writer at v1.8 — the CLI shells out to an
 * external `cpdflin` binary — so `toMemory(pdf, true, …)` throws
 * `ERROR: toFileMemory: Pdf.PDFError("Linearization not supported since v1.8.
 * Use an external linearizer.")` on every file, and the tool fell through to its
 * local rebuild for every input. The measured output carried no `/Linearized`
 * dictionary at all, one cross-reference section and no hint stream
 * (`docs/research/linearize-round-before.pdf`), while the notes promised a
 * conforming result from that engine.
 *
 * Two things are pinned here, because the fix has two halves:
 *
 *   1. the file is linearized, by the facts a reader acts on — the parameter
 *      dictionary inside the first 1024 bytes and its `/L` equal to the file
 *      length, which is the check qpdf uses before it trusts any hint;
 *   2. the sentence matches the file, including the case the old wording got
 *      wrong: an engine that *ran and refused* was reported as "could not be
 *      reached", which sends the user to look at their connection.
 *
 * The engine is doubled at the module edge, so the real tool, the real runner
 * and the real `isLinearized` all run; only the binary is a stand-in. What the
 * published qpdf build does to real bytes is measured in the round's browser
 * probe, not here (qpdf's WASM build is pthread-based and Node has no `Worker`).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EngineUnavailable } from '@/lib/pdf/engines/provider';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { isLinearized } from '@/lib/pdf/tools/optimize';

/* ── the engine double ────────────────────────────────────────────────────── */

const engine = vi.hoisted(() => ({
  /** Bytes qpdf "writes", or the error it throws. */
  reply: null as Uint8Array | null,
  failure: null as Error | null,
  /** The checker's verdict; the seam only credits a file when it says this. */
  check: 'no linearization errors',
  calls: [] as string[][],
}));

vi.mock('@/lib/pdf/core/engine-ops', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/pdf/core/engine-ops')>();
  return {
    ...real,
    engineReady: () => true,
    linearizeWithQpdf: async (_bytes: Uint8Array) => {
      if (engine.failure) throw engine.failure;
      if (!engine.reply) throw new Error('test double: no qpdf output configured');
      // Mirror the seam: the file is only accepted when the checker clears it.
      engine.calls.push(['--check-linearization']);
      if (engine.check !== 'no linearization errors') {
        throw new Error(`qpdf reported the output as not linearized: ${engine.check}`);
      }
      return engine.reply as Uint8Array;
    },
  };
});

beforeEach(() => {
  engine.reply = null;
  engine.failure = null;
  engine.check = 'no linearization errors';
  engine.calls.length = 0;
});

/* ── fixtures ─────────────────────────────────────────────────────────────── */

async function textPdf(pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index++) {
    const page = doc.addPage([420, 595]);
    page.drawText(`page ${index + 1}`, { x: 40, y: 520, size: 18, font, color: rgb(0, 0, 0) });
  }
  return new Uint8Array(await doc.save());
}

function fileOf(bytes: Uint8Array, name = 'doc.pdf'): File {
  return new File([bytes as BlobPart], name, { type: 'application/pdf' });
}

/**
 * A file laid out the way a linearized PDF is: the parameter dictionary first,
 * inside the first 1024 bytes, with `/L` holding the length of the whole file.
 *
 * The first-page objects follow it and the second group comes last, which is
 * the order Annex F.3.2 asks for, so this is a fair stand-in for what qpdf
 * writes. `overrides` bends one entry so the probe can be shown to fail.
 */
function linearizedFile(options: { length?: number; prefixPad?: number; dict?: boolean } = {}): Uint8Array {
  const pad = ' '.repeat(options.prefixPad ?? 0);
  const dict =
    options.dict === false
      ? ''
      : '<< /Linearized 1 /L 0000000 /O 11 /E 900 /N 2 /T 800 /H [ 300 120 ] >>';
  // Objects in the linearized order: parameter dictionary, catalog, first-page
  // objects, then the second group and the first-page cross-reference section.
  const objects = [
    dict,
    '<< /Type /Catalog /Pages 10 0 R >>',
    '<< /Type /Pages /Kids [ 11 0 R ] /Count 1 >>',
    '<< /Type /Page /Parent 10 0 R /MediaBox [0 0 420 595] >>',
  ];
  let body = `%PDF-1.7\n%\xE2\xE3\xCF\xD3\n${pad}`;
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${8 + index} 0 obj\n${object}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(body, 'latin1');
  body += 'xref\n8 4\n';
  body += offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size 12 /Root 9 0 R /Prev 0 >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  // `/L` is the whole file, this dictionary included, to the byte.
  const length = options.length ?? Buffer.byteLength(body, 'latin1');
  const filled = body.replace('/L 0000000', `/L ${String(length).padStart(7, '0')}`);
  return new Uint8Array(Buffer.from(filled, 'latin1'));
}

/**
 * A file carrying one *unfiltered* stream of 4 KB, which is what the fallback's
 * "newly compressed stream(s)" count is about. The corpus fixtures are all
 * already Flate-encoded, so a run over them correctly reports zero and the
 * count is otherwise unpinned.
 */
async function withRawStream(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([420, 595]);
  const payload = new Uint8Array(4096).fill(120);
  const dict = doc.context.obj({ Type: 'EmbeddedThing' });
  dict.set(PDFName.of('Length'), doc.context.obj(payload.length));
  doc.context.register(PDFRawStream.of(dict, payload));
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

/* ── 1. the probe ─────────────────────────────────────────────────────────── */

describe('isLinearized asks the two questions a reader asks', () => {
  it('accepts a dictionary in the first 1024 bytes whose /L is the file length', () => {
    expect(isLinearized(linearizedFile())).toBe(true);
  });

  it('refuses a /L that disagrees with the file length', () => {
    // A reader compares /L with the size it was served and ignores every hint
    // when they disagree — qpdf calls such a file "not linearized".
    const bytes = linearizedFile();
    const shorter = linearizedFile({ length: bytes.length - 1 });
    expect(isLinearized(shorter)).toBe(false);
    const longer = linearizedFile({ length: bytes.length + 1 });
    expect(isLinearized(longer)).toBe(false);
  });

  it('refuses a dictionary pushed past the first 1024 bytes', () => {
    // The old probe searched 64 KB for the name, so a dictionary a page into the
    // file read as linearized. ISO 32000-1 F.3.3 puts it inside 1024 bytes.
    const bytes = linearizedFile({ prefixPad: 1200 });
    expect(Buffer.from(bytes).toString('latin1').indexOf('/Linearized')).toBeGreaterThan(1024);
    expect(isLinearized(bytes)).toBe(false);
  });

  it('refuses a file with no dictionary at all', () => {
    expect(isLinearized(linearizedFile({ dict: false }))).toBe(false);
    expect(isLinearized(new Uint8Array(Buffer.from('%PDF-1.7\nnothing here\n', 'latin1')))).toBe(false);
  });

  it('is applied by the tool, not kept beside it', async () => {
    // The probe is only worth its rules if the run reads it: a file whose /L is
    // wrong must reach the card as "not linearized".
    engine.reply = linearizedFile({ length: 5 });
    const outcome = await runPdfTool({
      toolId: 'linearize-pdf',
      files: [fileOf(await textPdf(1))],
      values: {},
    });
    expect(isLinearized(new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()))).toBe(false);
    expect(outcome.message).toMatch(/but not linearized/i);
  });
});

/* ── 2. the sentence ──────────────────────────────────────────────────────── */

describe('linearize-pdf says which kind of file it produced', () => {
  it('credits qpdf, counts the pages as unread, and calls the file linearized', async () => {
    // The stand-in is a one-page file, so the source is one page too: the run
    // checks the page count of what comes back and would otherwise (correctly)
    // discard it.
    engine.reply = linearizedFile();
    const outcome = await runPdfTool({
      toolId: 'linearize-pdf',
      files: [fileOf(await textPdf(1))],
      values: {},
    });
    const bytes = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());

    expect(outcome.outputs[0].producedBy).toEqual({ via: 'engine', engine: 'qpdf' });
    expect(isLinearized(bytes)).toBe(true);
    expect(outcome.message).toMatch(/Linearized with qpdf/);
    expect(outcome.message).toMatch(/checker found no errors/);
    expect(outcome.warnings).toEqual([]);
    // qpdf hands back bytes, not a document: "not counted", never a guess.
    expect(outcome.pagesOut).toBeNull();
  });

  it('refuses to call the file linearized when the checker does not clear it', async () => {
    // The engine ran and returned bytes; only the checker's verdict makes it a
    // linearized file. Here the file it returns is plainly not one.
    engine.reply = await textPdf(1);
    const outcome = await runPdfTool({
      toolId: 'linearize-pdf',
      files: [fileOf(await textPdf(1))],
      values: {},
    });
    expect(outcome.outputs[0].producedBy).toEqual({ via: 'engine', engine: 'qpdf' });
    expect(outcome.message).toMatch(/but not linearized/i);
    expect(outcome.warnings.join(' ')).toMatch(/dictionary is missing/i);
  });

  it('says the engine ran and refused, not that it could not be reached', async () => {
    // The measured failure of the old build: CoherentPDF was reached, ran and
    // threw "Linearization not supported since v1.8", and the card said it
    // "could not be reached" — pointing the user at their connection.
    engine.failure = new Error(
      'Linearization not supported since v1.8. Use an external linearizer.',
    );
    const outcome = await runPdfTool({
      toolId: 'linearize-pdf',
      files: [fileOf(await textPdf(1))],
      values: {},
    });
    const warnings = outcome.warnings.join(' ');
    expect(warnings).toMatch(/ran but refused this file/i);
    expect(warnings).toMatch(/Linearization not supported since v1\.8/);
    expect(warnings).not.toMatch(/could not be reached/i);
    expect(outcome.outputs[0].producedBy).toEqual({ via: 'fallback', engine: 'qpdf' });
    expect(outcome.message).toMatch(/not a conforming linearized PDF/i);
  });

  it('still says "could not be reached" for a loader that never arrived', async () => {
    engine.failure = new EngineUnavailable('qpdf', 'Failed to load qpdf from https://cdn.invalid/: 404');
    const outcome = await runPdfTool({
      toolId: 'linearize-pdf',
      files: [fileOf(await textPdf(1))],
      values: {},
    });
    expect(outcome.warnings.join(' ')).toMatch(/could not be reached/i);
    expect(outcome.warnings.join(' ')).not.toMatch(/ran but refused/i);
  });

  it('counts the streams the fallback actually compressed, and only those', async () => {
    // With the engine gone, the rebuild is what runs; its count must follow the
    // bytes. An unfiltered stream is compressed and counted…
    engine.failure = new EngineUnavailable('qpdf', 'Failed to fetch');
    const raw = await withRawStream();
    const outcome = await runPdfTool({ toolId: 'linearize-pdf', files: [fileOf(raw)], values: {} });
    const produced = new Uint8Array(await outcome.outputs[0].blob.arrayBuffer());
    const counted = /and (\d+) newly compressed stream/.exec(outcome.message ?? '');
    expect(counted).not.toBeNull();
    expect(Number(counted?.[1] ?? 0)).toBeGreaterThan(0);
    expect(Buffer.from(produced).toString('latin1')).toMatch(/FlateDecode/);
    // …and a file that was already Flate-encoded adds none.
    const flattened = await runPdfTool({
      toolId: 'linearize-pdf',
      files: [fileOf(await textPdf(1))],
      values: {},
    });
    expect(flattened.message).toMatch(/and 0 newly compressed stream/);
  });

  it('declares qpdf, and its notes name the check rather than a promise', () => {
    const tool = getPdfTool('linearize-pdf');
    expect(tool?.engines).toEqual(['qpdf']);
    const notes = (tool?.notes ?? []).join(' ');
    expect(notes).toMatch(/qpdf/);
    expect(notes).toMatch(/cpdflin/);
    expect(notes).toMatch(/check-linearization/);
    // The claim that was false: CoherentPDF does not linearize in a browser.
    expect(notes).toMatch(/CoherentPDF cannot/);
  });
});
