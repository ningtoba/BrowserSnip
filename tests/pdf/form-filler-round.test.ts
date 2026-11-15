/**
 * `form-filler` — a filled answer must be the answer, in the field and in the ink.
 *
 * Three behaviours are measured here, each one found on a live build first
 * (`docs/research/form-filler-round.mjs`, judged by
 * `docs/research/form-filler-round.py`):
 *
 * * A dropdown or list that **already held a value** was answered through
 *   `PDFDropdown.select(value, true)`. `merge: true` concatenates onto `/V`
 *   instead of replacing it and turns the choice on to MultiSelect, so typing
 *   "Beta" over "Alpha" left `/V [Alpha Beta]`, regenerated the appearance
 *   stream from the *first* of them, and flattened the old value as ink — the
 *   file showed the answer the user did not give. The field's own options and
 *   export values are checked below, and the appearance stream is decoded: a
 *   reader that ignores `/NeedAppearances` paints exactly these bytes.
 * * Flattening deleted every field but left `<</AcroForm <</Fields []>>>>` in the
 *   catalog — still a form to a reader, with nothing in it.
 * * The pane's tab-order list was filtered to fillable fields, so a push button
 *   or signature field counted in the header and had no row of its own: nothing
 *   on screen said the form had a "Push" button in it.
 *
 * Documents are built with the fork's own form API, saved and re-loaded from
 * bytes, so every expectation is read back out of a real file.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { PDFArray, PDFDict, PDFDocument, PDFRef, PDFName, PDFNumber, PDFRawStream, PDFStream, decodePDFRawStream } from '@maxwbh/pdf-lib';
import { PDFCheckBox } from '@maxwbh/pdf-lib';
import { createFormField, fillForm, flattenForm, listFormFields } from '@/lib/pdf/core/forms';
import { initialValuesFor, isFillable, listedFields, saveReport } from '@/components/tools/pdf/edit/FormFillMain';

const RECT = { x: 40, y: 700, width: 180, height: 20 };

async function formDoc(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 760]);
  return doc;
}

/** Save and re-open: the assertions run on the bytes that would be shipped. */
async function reload(doc: PDFDocument): Promise<PDFDocument> {
  const bytes = await doc.save({ useObjectStreams: false });
  return PDFDocument.load(bytes, { updateMetadata: false });
}

function fieldDict(doc: PDFDocument, name: string): PDFDict {
  return doc.getForm().getField(name).acroField.dict;
}

/** The widget's `/AP /N` operators, decompressed — what a viewer paints. */
function appearanceOps(doc: PDFDocument, field: PDFDict): string {
  const kids = field.lookupMaybe(PDFName.of('Kids'), PDFArray);
  const widget = kids ? (doc.context.lookup(kids.get(0), PDFDict) as PDFDict) : field;
  const ap = widget.lookupMaybe(PDFName.of('AP'), PDFDict);
  const stream = doc.context.lookupMaybe(ap?.get(PDFName.of('N')) ?? undefined, PDFStream) as PDFRawStream;
  expect(stream, 'the widget has no /AP /N stream').toBeInstanceOf(PDFRawStream);
  // The run is written as a hex string, so the operands are spelled back out.
  return new TextDecoder()
    .decode(decodePDFRawStream(stream).decode())
    .replace(/<([0-9A-Fa-f]{2,})>/g, (_, hex: string) =>
      new TextDecoder('latin1').decode(Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16))),
    );
}

/**
 * The page's operators with their text operands spelled out. The inlined widget
 * appearance writes its run as a hex string in a subset face, so `toContain`
 * over the raw stream would only ever find hex digits.
 */
function pageText(doc: PDFDocument, pageIndex = 0): string {
  return pageContent(doc, pageIndex).replace(/<([0-9A-Fa-f]{2,})>/g, (_, hex: string) => {
    const bytes = Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
    // The values are UTF-16BE when every other byte is a zero high byte.
    const utf16 = bytes.length % 2 === 0 && bytes.every((b, i) => i % 2 === 1 || b === 0);
    if (utf16) return String.fromCharCode(...Array.from({ length: bytes.length / 2 }, (_, i) => (bytes[i * 2] << 8) | bytes[i * 2 + 1]));
    return new TextDecoder('latin1').decode(bytes);
  });
}

function pageContent(doc: PDFDocument, pageIndex = 0): string {
  // `lookupMaybe` throws on a class mismatch in this fork, and `/Contents` is
  // legitimately either one stream or an array of them, so the shape is read raw.
  const raw = doc.getPage(pageIndex).node.get(PDFName.of('Contents'));
  const resolved = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
  const streams: PDFRawStream[] =
    resolved instanceof PDFArray
      ? Array.from({ length: resolved.size() }, (_, i) => doc.context.lookup(resolved.get(i), PDFStream) as PDFRawStream)
      : resolved instanceof PDFStream
        ? [resolved as PDFRawStream]
        : [];
  return streams.map((stream) => new TextDecoder().decode(decodePDFRawStream(stream).decode())).join('\n');
}

describe('a dropdown that already holds a value is replaced, not appended to', () => {
  async function dropdownDoc(): Promise<PDFDocument> {
    const doc = await formDoc();
    createFormField(doc, 0, { type: 'dropdown', name: 'country', rect: RECT, options: ['Alpha', 'Beta'] });
    fillForm(doc, { country: 'Alpha' });
    return doc;
  }

  it('leaves one /V — the new answer — and one selection', async () => {
    const before = await reload(await dropdownDoc());
    expect(before.getForm().getDropdown('country').getSelected()).toEqual(['Alpha']);

    fillForm(before, { country: 'Beta' });
    const after = await reload(before);
    const field = after.getForm().getDropdown('country');

    expect(field.getSelected()).toEqual(['Beta']);
    // The choice flag, not just the value: `merge` also set MultiSelect (bit 22,
    // 2097152) on a control that offers one answer.
    expect(field.isMultiselect()).toBe(false);
  });

  it('draws the new answer into the appearance stream, not the old one', async () => {
    const doc = await reload(await dropdownDoc());
    fillForm(doc, { country: 'Beta' });
    // Re-read: an in-memory appearance is a `PDFContentStream`, only the saved
    // file carries the stream a viewer would paint.
    const shipped = await reload(doc);
    const ops = appearanceOps(shipped, fieldDict(shipped, 'country'));

    // The stream writes the answer as a literal string, e.g. `(Beta) Tj`.
    expect(ops).toContain('Beta');
    expect(ops).not.toContain('Alpha');
  });

  it('flattens the answer the user gave, not the one already in the file', async () => {
    const doc = await reload(await dropdownDoc());
    fillForm(doc, { country: 'Beta' });
    await flattenForm(doc);

    const content = pageText(doc);
    expect(content).toContain('Beta');
    expect(content).not.toContain('Alpha');
  });

  it('replaces a list selection too', async () => {
    const doc = await formDoc();
    createFormField(doc, 0, { type: 'list', name: 'languages', rect: RECT, options: ['PDF', 'Cairo'] });
    fillForm(doc, { languages: 'PDF' });
    const opened = await reload(doc);

    fillForm(opened, { languages: 'Cairo' });
    expect(opened.getForm().getOptionList('languages').getSelected()).toEqual(['Cairo']);
  });
});

describe('a flattened form is not a form', () => {
  it('leaves no /AcroForm and no /Annots once every field was baked', async () => {
    const doc = await formDoc();
    createFormField(doc, 0, { type: 'text', name: 'name', rect: RECT });
    createFormField(doc, 0, { type: 'checkbox', name: 'agree', rect: RECT });
    fillForm(doc, { name: 'Zephyr Bravo', agree: true });

    const outcome = await flattenForm(doc);
    expect(outcome.flattened).toBe(2);

    const after = await reload(doc);
    expect(after.catalog.has(PDFName.of('AcroForm'))).toBe(false);
    expect(after.getPage(0).node.has(PDFName.of('Annots'))).toBe(false);
    expect(pageText(after)).toContain('Zephyr Bravo');
  });

  it('keeps /AcroForm while a field the baker could not draw is still in it', async () => {
    const doc = await formDoc();
    createFormField(doc, 0, { type: 'text', name: 'name', rect: RECT });
    createFormField(doc, 0, { type: 'checkbox', name: 'agree', rect: RECT });
    // A widget that is on no page is the shape `flattenForm` refuses to guess
    // at: it is reported, not baked, and its field stays.
    const page = doc.getPage(0);
    const widget = doc.getForm().getTextField('name').acroField.getWidgets()[0];
    const ref = doc.context.getObjectRef(widget.dict);
    const annots = page.node.Annots();
    expect(annots, 'the fixture page has no /Annots').toBeTruthy();
    for (let i = (annots as PDFArray).size() - 1; i >= 0; i -= 1) {
      if ((annots as PDFArray).get(i).toString() === ref?.toString()) (annots as PDFArray).remove(i);
    }
    widget.dict.delete(PDFName.of('P'));
    fillForm(doc, { agree: true });

    const outcome = await flattenForm(doc);
    expect(outcome.flattened).toBe(1);
    expect(outcome.needsRender).toBe(true);

    const after = await reload(doc);
    expect(after.catalog.has(PDFName.of('AcroForm'))).toBe(true);
    expect(after.getForm().getFields().map((field) => field.getName())).toEqual(['name']);
  });
});

describe('the pane names the fields it cannot type into', () => {
  it('counts a push button in the field model the list renders', async () => {
    const doc = await formDoc();
    createFormField(doc, 0, { type: 'text', name: 'name', rect: RECT });
    const button = doc.getForm().createButton('action.button');
    button.addToPage('Push', doc.getPage(0), RECT);

    const fields = listFormFields(await reload(doc));
    const listed = listedFields(fields, '');

    // The list used to render `fields.filter(isFillable)`, so this row vanished
    // while the header still counted it.
    expect(listed.map((field) => [field.name, isFillable(field)])).toEqual([
      ['name', true],
      ['action.button', false],
    ]);
    expect(initialValuesFor(fields)).toHaveProperty('name', '');
    expect(initialValuesFor(fields)).not.toHaveProperty('action.button');
    // The filter box still narrows the same list, sign button included.
    expect(listedFields(fields, 'action').map((field) => field.name)).toEqual(['action.button']);
    expect(listedFields(fields, 'button').map((field) => field.name)).toEqual(['action.button']);
  });
});

describe('the save report is the only thing left on screen once the file exists', () => {
  it('counts the answers that reached the file', () => {
    expect(saveReport({ filled: 9, missing: [] }, [])).toBe('Filled 9 fields.');
    expect(saveReport({ filled: 1, missing: [] }, [])).toBe('Filled 1 field.');
    expect(saveReport({ filled: 0, missing: [] }, [])).toBe('Filled 0 fields.');
  });

  it('names what did not reach it, and the required field still empty', () => {
    expect(saveReport({ filled: 7, missing: ['country'] }, ['Email address'])).toBe(
      'Filled 7 fields; 1 could not be written (country). 1 required field still empty (Email address).',
    );
  });

  it('truncates a long list rather than pasting the whole form', () => {
    expect(saveReport({ filled: 0, missing: ['a', 'b', 'c', 'd', 'e'] }, [])).toContain(
      '5 could not be written (a, b, c, d, …)',
    );
  });
});

describe('a checked box stays checked', () => {
  it('keeps /AS in step with /V through two flips', async () => {
    const doc = await formDoc();
    createFormField(doc, 0, { type: 'checkbox', name: 'agree', rect: RECT });
    const opened = await reload(doc);
    const box = (): PDFCheckBox => opened.getForm().getCheckBox('agree');

    fillForm(opened, { agree: true });
    expect(box().isChecked()).toBe(true);
    fillForm(opened, { agree: false });
    expect(box().isChecked()).toBe(false);

    const after = await reload(opened);
    const widget = after.getForm().getCheckBox('agree').acroField.getWidgets()[0];
    expect(widget.dict.lookup(PDFName.of('AS'), PDFName).asString()).toBe('/Off');
    // Control: the on-state name is still the one the appearance dictionary uses.
    const ap = widget.dict.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFDict);
    expect(ap.has(PDFName.of('Off'))).toBe(true);
  });
});

describe('a maxlen field reports its limit with the value it keeps', () => {
  it('leaves /V as short as the /MaxLen says when the caller obeys it', async () => {
    const doc = await formDoc();
    createFormField(doc, 0, { type: 'text', name: 'zip', rect: RECT, maxLength: 5 });
    fillForm(doc, { zip: '12345' });
    const after = await reload(doc);
    const field = after.getForm().getTextField('zip');

    expect(field.getText()).toBe('12345');
    expect(field.getMaxLength()).toBe(5);
    expect(fieldDict(after, 'zip').lookup(PDFName.of('MaxLen'), PDFNumber).asNumber()).toBe(5);
  });
});

void createElement;
