/**
 * AcroForm read, fill, flatten and create.
 *
 * Built on `PDFDocument.getForm()` — the fork's real API is `getFields`,
 * `getFieldMaybe`, `PDFTextField.setText`, `PDFCheckBox.check`, `PDFOptionList`,
 * `PDFDropdown`, `PDFRadioGroup` (there is no `PDFRadioButton`), `flatten` and
 * `updateFieldAppearances`. Two gaps are filled in here:
 *
 * * there is no `enableAppearances()` on `PDFForm`/`PDFAcroForm`, so
 *   `/NeedAppearances` is written straight onto `form.acroForm.dict`;
 * * `flatten()` aborts the whole document when a single field has no usable
 *   appearance stream (signature fields in particular). This module bakes the
 *   appearances it can, field by field, and reports `needsRender: true` so the
 *   caller can fall back to a rasterised page.
 *
 * Everything is synchronous except `flattenForm`, which may embed a Unicode
 * face so that non-Latin field values survive into the flattened page.
 */
import type { PDFDocument, PDFPage, PDFFont } from '@maxwbh/pdf-lib';
import {
  PDFBool,
  PDFCheckBox,
  PDFDict,
  PDFDropdown,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFString,
  PDFHexString,
  PDFTextField,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  rotateInPlace,
  rgb,
  translate,
} from '@maxwbh/pdf-lib';
import type { PDFField, PDFWidgetAnnotation } from '@maxwbh/pdf-lib';
import { context } from './doc';
import { isWinAnsiSafe } from './fonts';
import type { PdfSession } from './render';

/** Mirrors `QuadRect` in `./annotations.ts` (owned by another module). */
export interface QuadRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FormFieldInfo {
  name: string;
  type: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'list' | 'button' | 'signature';
  /** 0-based index of the page carrying the field's first widget. */
  page: number;
  rect: QuadRect;
  value?: string;
  options?: string[];
  checked?: boolean;
  readOnly: boolean;
  required: boolean;
  multiline: boolean;
  maxLen?: number;
  /**
   * `/TU`, the alternate name readers show as a tooltip / label. Most real
   * forms never write one, so this falls back to the `/T` tree name and is only
   * absent on a field that carries neither (E13).
   */
  alternateName?: string;
}

export interface CreateFieldSpec {
  type: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'list';
  rect: QuadRect;
  name: string;
  /** Written to `/TU` (tooltip), not drawn next to the field. */
  label?: string;
  options?: string[];
  value?: string;
  fontSize?: number;
  multiline?: boolean;
  required?: boolean;
  readOnly?: boolean;
  maxLength?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function acroFormDict(doc: PDFDocument): PDFDict | undefined {
  const acro = doc.catalog.get(PDFName.of('AcroForm'));
  const resolved = acro instanceof PDFRef ? context(doc).lookup(acro) : acro;
  return resolved instanceof PDFDict ? resolved : undefined;
}

/**
 * `/NeedAppearances` tells viewers to draw the field values themselves. The
 * fork exposes no setter for it, so it is written on the AcroForm dictionary.
 */
function setNeedAppearances(doc: PDFDocument, enable: boolean): void {
  const acro = acroFormDict(doc);
  if (!acro) return;
  if (enable) acro.set(PDFName.of('NeedAppearances'), PDFBool.True);
  else acro.delete(PDFName.of('NeedAppearances'));
}

function typeOf(field: PDFField): FormFieldInfo['type'] {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'list';
  // `PDFButton` covers PushButton, `PDFSignature` covers Sig.
  return field.constructor.name === 'PDFSignature' ? 'signature' : 'button';
}

function pageIndexOf(doc: PDFDocument): (ref: PDFRef | undefined) => number {
  const pages = doc.getPages();
  const index = new Map<string, number>();
  pages.forEach((page, i) => {
    index.set(page.ref.toString(), i);
  });
  return (ref) => (ref ? index.get(ref.toString()) ?? -1 : -1);
}

/** The page a widget sits on: `/P` first, then the page `/Annots` arrays. */
function widgetPage(doc: PDFDocument, widget: PDFWidgetAnnotation): PDFPage | undefined {
  const pages = doc.getPages();
  const declared = widget.P();
  const ctx = context(doc);
  if (declared) {
    const page = pages.find((candidate) => candidate.ref.toString() === declared.toString());
    if (page) return page;
  }
  const ref = ctx.getObjectRef(widget.dict);
  if (!ref) return undefined;
  for (const page of pages) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const value = annots.get(i);
      if (value instanceof PDFRef && value.toString() === ref.toString()) return page;
    }
  }
  return undefined;
}

/**
 * Decode PDF text into something worth putting in front of a person: a stray
 * byte-order mark and the U+FFFD "this byte has no name" sentinel are dropped,
 * and a label that had nothing left in it reports as absent.
 */
function displayText(text: string): string | undefined {
  const clean = text.replace(/\uFEFF/g, '').replace(/\uFFFD/g, '').trim();
  return clean === '' ? undefined : clean;
}

/**
 * Read a text entry (`/TU`, `/T`) without naming a class for it.
 *
 * `dict.lookup(key, PDFString, PDFHexString)` throws both when the key is
 * absent *and* when it holds another type, and real forms do both constantly;
 * the value is read raw — indirect references resolved — and narrowed here.
 */
function textOf(doc: PDFDocument, dict: PDFDict, key: string): string | undefined {
  const raw = dict.get(PDFName.of(key));
  const value = raw instanceof PDFRef ? context(doc).lookup(raw) : raw;
  if (value instanceof PDFString || value instanceof PDFHexString) {
    return displayText(value.decodeText());
  }
  return undefined;
}

/**
 * The `/T` tree name (every parent joined with `.`): the key `fillForm` and
 * every viewer addresses a field by. A field with no `/T` at all is legal PDF
 * and reports as the empty string; a `/T` that is not a text string breaks
 * pdf-lib's own accessor, which must not cost the caller the whole list.
 */
function treeName(doc: PDFDocument, field: PDFField): string {
  try {
    return field.getName();
  } catch {
    return textOf(doc, field.acroField.dict, 'T') ?? '';
  }
}

/** The label to show for a field: `/TU`, else the `/T` tree name (E13). */
function alternateName(doc: PDFDocument, field: PDFField, name: string): string | undefined {
  return textOf(doc, field.acroField.dict, 'TU') ?? displayText(name);
}

function fieldDescription(field: PDFField): Pick<FormFieldInfo, 'value' | 'options' | 'checked'> {
  const out: Pick<FormFieldInfo, 'value' | 'options' | 'checked'> = {};
  if (field instanceof PDFTextField) {
    const text = field.getText();
    if (text !== undefined) out.value = text;
  } else if (field instanceof PDFCheckBox) {
    out.checked = field.isChecked();
    out.value = out.checked ? 'On' : 'Off';
  } else if (field instanceof PDFRadioGroup) {
    const selected = field.getSelected();
    out.options = field.getOptions();
    if (selected !== undefined) out.value = selected;
    out.checked = selected !== undefined;
  } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    out.options = field.getOptions();
    const selected = field.getSelected();
    if (selected.length > 0) out.value = selected.join(', ');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * One entry per field (radio groups and multi-widget fields report the geometry
 * of their first widget). Fields with no widget anywhere are reported with
 * `page: -1` and a zero rect, which is legal PDF and worth showing in an
 * editor because the name still occupies the form.
 */
export function listFormFields(doc: PDFDocument): FormFieldInfo[] {
  if (!acroFormDict(doc)) return [];
  const form = doc.getForm();
  const indexOf = pageIndexOf(doc);
  const fields: FormFieldInfo[] = [];

  for (const field of form.getFields()) {
    const widgets = field.acroField.getWidgets();
    const widget = widgets[0];
    let page = -1;
    let rect: QuadRect = { x: 0, y: 0, width: 0, height: 0 };
    if (widget) {
      const host = widgetPage(doc, widget);
      page = host ? indexOf(host.ref) : -1;
      rect = widget.getRectangle();
    }
    const info: FormFieldInfo = {
      name: treeName(doc, field),
      type: typeOf(field),
      page,
      rect,
      readOnly: field.isReadOnly(),
      required: field.isRequired(),
      multiline: field instanceof PDFTextField ? field.isMultiline() : false,
    };
    const description = fieldDescription(field);
    if (description.value !== undefined) info.value = description.value;
    if (description.options !== undefined) info.options = description.options;
    if (description.checked !== undefined) info.checked = description.checked;
    if (field instanceof PDFTextField) {
      const maxLength = field.getMaxLength();
      if (maxLength !== undefined) info.maxLen = maxLength;
    }
    const label = alternateName(doc, field, info.name);
    if (label !== undefined) info.alternateName = label;
    fields.push(info);
  }
  return fields;
}

export function hasXfa(doc: PDFDocument): boolean {
  return acroFormDict(doc)?.has(PDFName.of('XFA')) ?? false;
}

// ---------------------------------------------------------------------------
// Filling
// ---------------------------------------------------------------------------

function booleanToText(value: boolean): string {
  return value ? 'Yes' : 'No';
}

function asText(value: string | boolean): string {
  return typeof value === 'boolean' ? booleanToText(value) : value;
}

function checkboxIsOn(value: string | boolean): boolean {
  if (typeof value === 'boolean') return value;
  return !['', '0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
}

function applyValue(field: PDFField, value: string | boolean): boolean {
  if (field instanceof PDFTextField) {
    field.setText(asText(value));
    return true;
  }
  if (field instanceof PDFCheckBox) {
    if (checkboxIsOn(value)) field.check();
    else field.uncheck();
    return true;
  }
  if (field instanceof PDFRadioGroup) {
    const options = field.getOptions();
    let wanted: string | undefined;
    if (typeof value === 'boolean') wanted = value ? options[0] : undefined;
    else wanted = value;
    if (wanted === undefined) {
      field.clear();
      return true;
    }
    if (!options.includes(wanted)) return false;
    field.select(wanted);
    return true;
  }
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    const requested = asText(value);
    const wanted = requested
      .split(',')
      .map((option) => option.trim())
      .filter(Boolean);
    const available = field.getOptions();
    if (wanted.length === 0) {
      field.clear();
      return true;
    }
    if (!wanted.every((option) => available.includes(option))) return false;
    field.select(wanted, true);
    return true;
  }
  // Push buttons and signature fields hold no settable value.
  return false;
}

/**
 * Set field values by name.
 *
 * `missing` lists every key of `values` that could not be applied — no field of
 * that name, or a value the field rejects (an option a dropdown does not
 * offer). Appearance streams are refreshed with pdf-lib's standard font unless
 * `opts.appearance` is `false`; when a value cannot be encoded by that font the
 * field is still filled and `/NeedAppearances` is set so the viewer draws the
 * text with its own fonts.
 */
export function fillForm(
  doc: PDFDocument,
  values: Record<string, string | boolean>,
  opts: { appearance?: boolean } = {},
): { filled: number; missing: string[] } {
  if (!acroFormDict(doc)) {
    return {
      filled: 0,
      missing: Object.keys(values),
    };
  }
  const form = doc.getForm();
  const missing: string[] = [];
  let filled = 0;
  let needsViewerAppearance = false;

  for (const [name, value] of Object.entries(values)) {
    const field = form.getFieldMaybe(name);
    if (!field) {
      missing.push(name);
      continue;
    }
    if (!applyValue(field, value)) {
      missing.push(name);
      continue;
    }
    filled++;
    if (typeof value === 'string' && !isWinAnsiSafe(value)) needsViewerAppearance = true;  }

  if (opts.appearance ?? true) {
    try {
      // No explicit font: pdf-lib's default is Helvetica, which handles every
      // WinAnsi value; anything else is covered by `/NeedAppearances` below.
      form.updateFieldAppearances();
    } catch {
      needsViewerAppearance = true;
    }
    if (needsViewerAppearance) setNeedAppearances(doc, true);
  } else {
    setNeedAppearances(doc, true);
  }

  return { filled, missing };
}

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

/** Resolve the appearance stream a widget should show right now. */
function appearanceRefFor(
  field: PDFField,
  widget: PDFWidgetAnnotation,
): PDFRef | undefined {
  let refOrDict: unknown = widget.getNormalAppearance();
  if (
    refOrDict instanceof PDFDict &&
    (field instanceof PDFCheckBox || field instanceof PDFRadioGroup)
  ) {
    const value = field.acroField.getValue();
    const candidate = refOrDict.get(value) ?? refOrDict.get(PDFName.of('Off'));
    if (candidate instanceof PDFRef) refOrDict = candidate;
  } else if (refOrDict instanceof PDFDict) {
    const nested = refOrDict.get(PDFName.of('N'));
    if (nested instanceof PDFRef) refOrDict = nested;
  }
  return refOrDict instanceof PDFRef ? refOrDict : undefined;
}

/**
 * Bake the interactive fields into static page content.
 *
 * `session` is optional and only changes the *report*: with a pdf.js session the
 * caller can rasterise whatever this function could not bake, so `needsRender`
 * is actionable. Without one, the same pdf-lib appearance baking happens and
 * `needsRender` simply means "some fields survived, or lost their text".
 */
export async function flattenForm(
  doc: PDFDocument,
  session?: PdfSession,
): Promise<{ flattened: number; needsRender: boolean }> {
  if (!acroFormDict(doc)) return { flattened: 0, needsRender: false };
  const form = doc.getForm();
  const fields = form.getFields();
  if (fields.length === 0) return { flattened: 0, needsRender: false };

  // Acrobat re-derives the visual form from XFA and ignores the baked content,
  // so the packet has to go for flattening to stick.
  if (form.hasXFA()) form.deleteXFA();

  await refreshAppearances(doc, form);

  let flattened = 0;
  let needsRender = false;

  for (const field of fields) {
    const widgets = field.acroField.getWidgets();
    try {
      // Only bake a field when *every* widget can be drawn: a partially baked
      // field that then fails to be removed would show its text twice.
      const planned: {
        page: PDFPage;
        widgetRef: PDFRef;
        appearance: PDFRef;
        rect: { x: number; y: number; width: number; height: number };
        rotation: 0 | 90 | 180 | 270;
      }[] = [];
      let incomplete = false;
      for (const widget of widgets) {
        const page = widgetPage(doc, widget);
        const appearance = appearanceRefFor(field, widget);
        const widgetRef = context(doc).getObjectRef(widget.dict);
        if (!page || !appearance || !widgetRef) {
          incomplete = true;
          break;
        }
        planned.push({
          page,
          widgetRef,
          appearance,
          rect: widget.getRectangle(),
          rotation: widgetRotation(widget),
        });
      }
      if (widgets.length > 0 && incomplete) {
        needsRender = true;
        continue;
      }

      for (const { page, appearance, rect, rotation } of planned) {
        const key = page.node.newXObject('FlatWidget', appearance);
        page.pushOperators(
          pushGraphicsState(),
          translate(rect.x, rect.y),
          ...rotateInPlace({
            width: rect.width,
            height: rect.height,
            rotation,
          }),
          drawObject(key),
          popGraphicsState(),
        );
      }
      form.removeField(field);
      for (const { page, widgetRef } of planned) page.node.removeAnnot(widgetRef);
      flattened++;
    } catch {
      needsRender = true;
    }
  }

  // A signature field has no appearance until it is signed; those are reported
  // rather than guessed at, and a render session is what lets the caller bake
  // them from the rasterised page.
  if (session && session.numPages < doc.getPageCount()) needsRender = true;
  setNeedAppearances(doc, false);
  return { flattened, needsRender };
}

/** The widget's own `/Rot`, snapped to a quarter turn like `rotateInPlace` wants. */
function widgetRotation(widget: PDFWidgetAnnotation): 0 | 90 | 180 | 270 {
  const raw = widget.dict.lookupMaybe(PDFName.of('Rot'), PDFNumber);
  const angle = raw?.asNumber() ?? 0;
  const normalised = ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
  return normalised as 0 | 90 | 180 | 270;
}

/**
 * Regenerate appearance streams, preferring a face that can encode the values.
 * Falls back to `/NeedAppearances` when font embedding is unavailable (no
 * network for a script font, for instance) so the text is never lost — just
 * drawn by the viewer instead of baked in.
 */
async function refreshAppearances(
  doc: PDFDocument,
  form: ReturnType<PDFDocument['getForm']>,
): Promise<void> {
  const text = form
    .getFields()
    .map((field) => fieldDescription(field).value ?? '')
    .filter(Boolean)
    .join('\n');
  let font: PDFFont | undefined;
  try {
    const { getFont } = await import('./fonts');
    font = await getFont(doc, { text: text || ' ', size: 12 });
  } catch {
    font = undefined;
  }
  try {
    form.updateFieldAppearances(font);
  } catch {
    try {
      form.updateFieldAppearances();
    } catch {
      setNeedAppearances(doc, true);
    }
  }
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

function appearanceOptions(spec: CreateFieldSpec) {
  return {
    x: spec.rect.x,
    y: spec.rect.y,
    width: spec.rect.width,
    height: spec.rect.height,
    textColor: rgb(0, 0, 0),
    borderColor: rgb(0.4, 0.4, 0.4),
    borderWidth: 0.5,
  };
}

/**
 * Add one interactive field (with its widget) to `page`.
 *
 * @returns the 0-based index of the new field in `doc.getForm().getFields()`,
 * or `-1` when nothing was created.
 */
export function createFormField(
  doc: PDFDocument,
  page: number,
  spec: CreateFieldSpec,
): number {
  const pages = doc.getPages();
  if (!Number.isInteger(page) || page < 0 || page >= pages.length) {
    throw new Error(
      `There is no page ${page + 1} to add "${spec.name}" to — this document has ${pages.length} page${pages.length === 1 ? '' : 's'}.`,
    );
  }
  if (!spec.name?.trim()) {
    throw new Error('Give the form field a name before adding it to the page.');
  }
  const target = pages[page];
  const form = doc.getForm();
  const options = appearanceOptions(spec);
  let created: PDFField | undefined;

  switch (spec.type) {
    case 'text': {
      const field = form.createTextField(spec.name);
      if (spec.value) field.setText(spec.value);
      if (spec.multiline) field.enableMultiline();
      if (spec.maxLength && spec.maxLength > 0) field.setMaxLength(spec.maxLength);
      if (spec.fontSize) field.setFontSize(spec.fontSize);
      field.addToPage(target, options);
      created = field;
      break;
    }
    case 'checkbox': {
      const field = form.createCheckBox(spec.name);
      if (spec.value && !['', 'false', '0', 'off', 'no'].includes(spec.value.toLowerCase())) {
        field.check();
      }
      field.addToPage(target, options);
      created = field;
      break;
    }
    case 'radio': {
      const field = form.createRadioGroup(spec.name);
      const choices = spec.options ?? [];
      if (choices.length > 0) {
        // A radio group is one widget per option, so the rect is divided
        // vertically — that is how the option rows line up in every reader.
        const step = choices.length > 1 ? spec.rect.height / choices.length : spec.rect.height;
        choices.forEach((option, index) => {
          field.addOptionToPage(option, target, {
            ...options,
            y: spec.rect.y + spec.rect.height - step * (index + 1),
            height: step,
          });
        });
        if (spec.value && choices.includes(spec.value)) field.select(spec.value);
      }
      created = field;
      break;
    }
    case 'dropdown': {
      const field = form.createDropdown(spec.name);
      if (spec.options?.length) field.setOptions(spec.options);
      if (spec.value) field.select(spec.value);
      if (spec.fontSize) field.setFontSize(spec.fontSize);
      field.addToPage(target, options);
      created = field;
      break;
    }
    case 'list': {
      const field = form.createOptionList(spec.name);
      if (spec.options?.length) field.setOptions(spec.options);
      if (spec.value) field.select(spec.value);
      if (spec.fontSize) field.setFontSize(spec.fontSize);
      field.addToPage(target, options);
      created = field;
      break;
    }
  }

  if (!created) return -1;
  if (spec.required) created.enableRequired();
  if (spec.readOnly) created.enableReadOnly();
  if (spec.label) {
    // `/TU` is the alternate/tooltip name; viewers show it instead of the raw
    // field name.
    created.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText(spec.label));
    if (!isWinAnsiSafe(spec.label)) setNeedAppearances(doc, true);
  }
  if (spec.value && !isWinAnsiSafe(spec.value)) setNeedAppearances(doc, true);

  const index = form.getFields().findIndex((field) => field.getName() === spec.name);
  return index;
}
