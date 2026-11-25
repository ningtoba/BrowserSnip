/**
 * `form-filler` — what the pane may claim, and what a save is allowed to write.
 *
 * All three groups were measured on the live pane (dev :5291, CDP 9831, chunk 8):
 *
 * * pdf-lib's `getForm()` deletes `/XFA` the first time it runs, and both read
 *   paths called `listFormFields` **before** `hasXfa`. Measured: an XFA-only
 *   file was refused as having "no fillable form fields" (never naming XFA), a
 *   mirror form filled without the notice, and the note swore "a viewer that
 *   renders XFA may still show the old text" while the saved bytes had no XFA
 *   packet at all. The checks are ordered now, and the sentences say what the
 *   bytes do.
 * * The save payload carried every field, changed or not. One typed answer on a
 *   ten-field form produced the card "Filled 8 fields." while two fields had
 *   actually changed, and prefilled choices whose current value is an export
 *   code (or a typed-over entry) answered "could not be written" about values
 *   the file already holds. Only changed, writable answers are payload now.
 * * The Unicode strip said "1 value need a Unicode font. Viewers will draw
 *   them correctly" to a save that (pre-seam) does not even produce a file.
 */
import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName, PDFString } from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { runPdfTool, type RunOutcome } from '@/lib/pdf/tools/runner';
import { fillPayload, saveReport, unicodeBanner } from '@/components/tools/pdf/edit/FormFillMain';
import type { FormFieldInfo } from '@/lib/pdf/core/forms';

const RECT = { x: 40, y: 700, width: 180, height: 20 };

function field(over: Partial<FormFieldInfo>): FormFieldInfo {
  return {
    name: 'x',
    type: 'text',
    page: 0,
    rect: RECT,
    readOnly: false,
    required: false,
    multiline: false,
    ...over,
  };
}

describe('the save payload carries only answers that changed', () => {
  const dropdown = field({ name: 'country', type: 'dropdown', options: ['Alpha', 'Beta'], value: 'Alpha' });
  const readonly = field({ name: 'locked', readOnly: true, value: 'sealed value' });
  const radio = field({ name: 'tier', type: 'radio', options: ['Gold', 'Silver'] });
  const box = field({ name: 'agree', type: 'checkbox' });
  const fields = [dropdown, readonly, radio, box, field({ name: 'name' })];

  it('drops an unchanged prefilled choice instead of rewriting and refusing it', () => {
    const payload = fillPayload(
      { country: 'Alpha', locked: 'sealed value', tier: '', agree: false, name: 'Ada' },
      fields,
      { country: 'Alpha', locked: 'sealed value', agree: false, name: '' },
    );
    // Only the typed name is an answer. The dropdown holds "Alpha" in the file;
    // sending it asked `fillForm` to write (and mis-report) a value it already had.
    expect(payload).toEqual({ name: 'Ada' });
  });

  it('keeps an edit, keeps a deliberate clear, and drops a reverted edit', () => {
    const original = { country: 'Alpha', name: 'Ada' };
    expect(
      fillPayload({ country: 'Beta', name: '' }, fields, original),
    ).toEqual({ country: 'Beta', name: '' });
    // Reverted to the file's own value: nothing to write, nothing to report.
    expect(
      fillPayload({ country: 'Alpha', name: 'Ada' }, fields, original),
    ).toEqual({});
  });

  it('never rewrites a read-only field, and never sends an empty radio', () => {
    const payload = fillPayload(
      { locked: 'typed over a read-only field', country: '', tier: '', agree: true },
      fields,
      { locked: 'sealed value', country: 'Alpha', agree: false },
    );
    expect(payload.locked).toBeUndefined();
    expect(payload.tier).toBeUndefined();
    expect(payload.agree).toBe(true);
  });
});

describe('the card counts the answers, not the writes', () => {
  it('says nothing changed when nothing changed', () => {
    const report = saveReport({ filled: 0, missing: [] }, [], true);
    expect(report).toMatch(/No answer changed/u);
    expect(report).not.toMatch(/Filled 0/u);
  });

  it('keeps the honest count and the named refusals for a real fill', () => {
    expect(saveReport({ filled: 2, missing: [] }, []).trim()).toBe('Filled 2 fields.');
    const report = saveReport({ filled: 2, missing: ['region', 'tchoice'] }, ['email']);
    expect(report).toContain('Filled 2 fields; 2 could not be written (region, tchoice).');
    expect(report).toContain('1 required field still empty (email).');
  });
});

describe('the Unicode strip speaks grammar and measured truth', () => {
  it('agrees with a single value', () => {
    const line = unicodeBanner(1);
    expect(line).toContain('1 value needs a font');
    expect(line).not.toMatch(/\b1 values\b|\bvalue need\b/u);
  });

  it('routes to flattening and stops promising viewership', () => {
    const line = unicodeBanner(3);
    expect(line).toContain('3 values need a font');
    expect(line).toContain('Fill and flatten');
    // Measured: the old promise's first half ("Viewers will draw them
    // correctly") was said of a save that produced no file at all.
    expect(line).not.toMatch(/Viewers will draw them correctly/iu);
  });
});

async function runFiller(bytes: Uint8Array, values: Record<string, unknown>): Promise<RunOutcome> {
  const tool = getPdfTool('form-filler');
  expect(tool, 'form-filler is registered').toBeTruthy();
  const file = new File([new Uint8Array(bytes) as BlobPart], 'form.pdf', { type: 'application/pdf' });
  return runPdfTool({
    toolId: 'form-filler',
    files: [file],
    values,
    onProgress: () => undefined,
    onLog: () => undefined,
  });
}

/**
 * Inject `/XFA` into an already-saved PDF **on a document whose form was never
 * touched**: `getForm()` — and any save reached after it — deletes the packet,
 * so this fixture could not be sealed the obvious way.
 */
async function sealIntoSavedPdf(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const acro = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
  acro.set(PDFName.of('XFA'), PDFString.of(''));
  return doc.save({ useObjectStreams: false });
}

describe('XFA is seen before pdf-lib throws the packet away', () => {
  it('names the XFA stream for a packet-only form instead of "no fillable fields"', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 700]);
    doc.getForm(); // an AcroForm with no fields at all
    const bytes = await sealIntoSavedPdf(await doc.save({ useObjectStreams: false }));
    await expect(runFiller(bytes, { fieldValues: { a: 'x' } })).rejects.toThrow(/live only in its XFA stream/u);
  });

  it('tells the mirror-form user the packet does not survive, and the bytes agree', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 700]);
    const form = doc.getForm();
    form.createTextField('note').addToPage(page, { ...RECT });
    const bytes = await sealIntoSavedPdf(await doc.save({ useObjectStreams: false }));

    const outcome = await runFiller(bytes, { fieldValues: { note: 'mirror answer' } });
    const warnings = outcome.warnings.join(' ');
    expect(warnings).toContain('packet does not survive the save');
    // The sentence is only honest while the packet is really gone from the file.
    const produced = new TextDecoder('latin1').decode(await outcome.outputs[0].blob.arrayBuffer());
    expect(produced).not.toContain('/XFA');
    // And the value did reach the mirror.
    const back = await PDFDocument.load(await outcome.outputs[0].blob.arrayBuffer());
    expect(back.getForm().getTextField('note').getText()).toBe('mirror answer');
  });
});
