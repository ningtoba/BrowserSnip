/**
 * `form-creator`: the fields a person dropped must exist, be typed, and be fillable
 * by a program this app has never met.
 *
 * Driving the deployed pane found a hard break: pick a type from the chips, click the
 * page, name the field, repeat four times, press "Save form" — the pane printed the
 * library's own sentence, *"No /DA (default appearance) entry found for field:
 * applicant.name"*, and produced no file. The cause is `core/forms.ts` asking pdf-lib
 * for a font size before any default appearance exists: `PDFAcroField.setFontSize`
 * rewrites the last `Tf` in `/DA` and throws when the string is missing, so every
 * field carrying a size — which the designer always sets, its inspector shows one —
 * made the save fail. Nothing reached this before because no test created a field
 * with a size, and the triage could not get past the disabled button.
 *
 * The other half of the card is "real AcroForm widgets that any viewer can type into",
 * which is what the outside measurement in `docs/research/form-creator-readers.log`
 * asks MuPDF, pypdf and poppler: 4 widgets on the page, `/Tx` `/Btn` `/Ch` with the
 * combo bit, options Finland/France/Germany, then a fill round trip that comes back as
 * `Ada Lovelace`, `Yes` and `France`. This file pins the byte-level part of the same
 * claims so a regression cannot hide in either direction.
 */
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from '@maxwbh/pdf-lib';
import { decodeTextString } from '@/lib/pdf/core/metadata';
import { newPDF, openPDF, savePDF } from '@/lib/pdf/core/doc';
import { createFormField, listFormFields, type CreateFieldSpec } from '@/lib/pdf/core/forms';

const reload = (bytes: Uint8Array) =>
  openPDF(bytes, { updateMetadata: false, ignoreEncryption: true });

async function twoPages() {
  const doc = await newPDF();
  doc.addPage([595, 842]);
  doc.addPage([500, 700]);
  return doc;
}

const spec = (over: Partial<CreateFieldSpec> & { name: string; type: CreateFieldSpec['type'] }): CreateFieldSpec => ({
  rect: { x: 60, y: 700, width: 200, height: 18 },
  fontSize: 14,
  ...over,
} as CreateFieldSpec);

/** The saved file, reopened, with its field dictionaries indexed by full name. */
async function loadFields(bytes: Uint8Array) {
  const doc = await reload(bytes);
  return { doc, dicts: fieldDicts(doc) };
}

function fieldDicts(doc: PDFDocument): Map<string, PDFDict> {
  const form = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  expect(form, 'the saved file has no /AcroForm').toBeTruthy();
  const out = new Map<string, PDFDict>();
  const walk = (entry: unknown, parent: string) => {
    const dict = doc.context.lookup(entry as never) as PDFDict;
    const own = decodeTextString(dict.get(PDFName.of('T'))) ?? '';
    const name = parent ? `${parent}.${own}` : own;
    if (own) out.set(name, dict);
    for (const kid of (dict.lookupMaybe(PDFName.of('Kids'), PDFArray)?.asArray() ?? [])) walk(kid, name);
  };
  for (const field of (form!.lookup(PDFName.of('Fields'), PDFArray)).asArray()) walk(field, '');
  return out;
}

describe('a designed field reaches the file as a typed, fillable widget', () => {
  it('saves a sized text field instead of dying on a missing /DA', async () => {
    const doc = await twoPages();
    // This call is the regression: `setFontSize` on a field with no default
    // appearance threw MissingDAEntryError, and the pane could not save at all.
    const index = createFormField(doc, 0, spec({ type: 'text', name: 'applicant.name', value: 'Ada Lovelace', maxLength: 40 }));
    expect(index).toBe(0);
    const bytes = await savePDF(doc);
    const fields = listFormFields(await reload(bytes));
    expect(fields.map((field) => field.name)).toEqual(['applicant.name']);
    expect(fields[0].type).toBe('text');
    expect(fields[0].value).toBe('Ada Lovelace');
    expect(fields[0].maxLen).toBe(40);
    expect(fields[0].page).toBe(0);

    const { dicts } = await loadFields(bytes);
    const field = dicts.get('applicant.name')!;
    const da = field.get(PDFName.of('DA'));
    const appearance = da instanceof PDFString ? da.decodeText() : String(da ?? '');
    expect(appearance, 'no /DA, so no viewer can draw what is typed').toMatch(/Tf/);
    expect(appearance).toMatch(/\b14\b/);
  });

  it('carries the field hierarchy the pane named', async () => {
    const doc = await twoPages();
    createFormField(doc, 0, spec({ type: 'text', name: 'applicant.name' }));
    createFormField(doc, 0, spec({ type: 'checkbox', name: 'agree.terms' }));
    const { doc: opened, dicts } = await loadFields(await savePDF(doc));
    expect([...dicts.keys()].sort()).toEqual(['agree', 'agree.terms', 'applicant', 'applicant.name']);
    const checkbox = dicts.get('agree.terms')!;
    expect(String(checkbox.get(PDFName.of('FT')))).toBe('/Btn');
    // A tick box is a button with an on-state; without it no reader can check it.
    const kids = checkbox.lookup(PDFName.of('Kids'), PDFArray)!.asArray();
    const widget = opened.context.lookup(kids[0]) as PDFDict;
    const ap = widget.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N'));
    expect(ap, 'the checkbox has no /AP /N, so it paints nothing').toBeTruthy();
  });

  it('types the choice fields apart: combo versus list, radio with one kid per option', async () => {
    const doc = await twoPages();
    createFormField(doc, 0, spec({ type: 'dropdown', name: 'country', options: ['Finland', 'France', 'Germany'] }));
    createFormField(doc, 0, spec({ type: 'list', name: 'colours', options: ['red', 'blue'] }));
    createFormField(doc, 1, spec({ type: 'radio', name: 'size', options: ['S', 'M', 'L'], rect: { x: 40, y: 400, width: 30, height: 60 } }));
    const bytes = await savePDF(doc);
    const { dicts } = await loadFields(bytes);

    const combo = dicts.get('country')!;
    expect(String(combo.get(PDFName.of('FT')))).toBe('/Ch');
    expect(Number(String(combo.get(PDFName.of('Ff'))))).toBe(131072);
    expect((combo.lookup(PDFName.of('Opt'), PDFArray) as PDFArray).asArray().length).toBe(3);

    const list = dicts.get('colours')!;
    expect(String(list.get(PDFName.of('FT')))).toBe('/Ch');
    expect(Number(String(list.get(PDFName.of('Ff'))))).not.toBe(131072);

    const radio = dicts.get('size')!;
    expect(String(radio.get(PDFName.of('FT')))).toBe('/Btn');
    expect((radio.lookup(PDFName.of('Kids'), PDFArray) as PDFArray).size()).toBe(3);

    const fields = listFormFields(await reload(bytes));
    expect(fields.map((field) => [field.name, field.type]).sort()).toEqual([
      ['colours', 'list'], ['country', 'dropdown'], ['size', 'radio'],
    ]);
    expect(fields.find((field) => field.name === 'colours')!.options).toEqual(['red', 'blue']);
    // The radio group was aimed at page 2, which is 500x700 — not page 1's geometry.
    expect(fields.find((field) => field.name === 'size')!.page).toBe(1);
  });

  it('refuses a name that is blank and a page that is not there, in words', async () => {
    const doc = await twoPages();
    expect(() => createFormField(doc, 0, spec({ type: 'text', name: '   ' })))
      .toThrow(/Give the form field a name/i);
    expect(() => createFormField(doc, 7, spec({ type: 'text', name: 'beyond' })))
      .toThrow(/There is no page 8 to add "beyond"/);
  });
});
