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
  PDFArray,
  PDFBool,
  PDFCheckBox,
  PDFDict,
  PDFDropdown,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFStream,
  PDFString,
  PDFHexString,
  PDFTextField,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  rotateInPlace,
  rgb,
  scale,
  translate,
} from '@maxwbh/pdf-lib';
import type { PDFField, PDFWidgetAnnotation } from '@maxwbh/pdf-lib';
import { context } from './doc';
import { appearanceTurn, inlineFormXObject } from './content';
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
    // Both halves come from `choicesOf`: pdf-lib's own accessors are pair-blind, so a
    // group whose `/Opt` are pairs reported no options (the filler pane drew a text
    // box instead of the radios) and could not name the selected kid either.
    const choices = choicesOf(field);
    out.options = choices.map((choice) => choice.label);
    const selected = sampleText(field.acroField.dict.get(PDFName.of('V')));
    if (selected !== undefined && selected !== 'Off') {
      out.value = choices.find((choice) => choice.value === selected)?.label ?? selected;
      out.checked = true;
    } else {
      out.value = undefined;
      out.checked = false;
    }
  } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    const choices = choicesOf(field);
    out.options = choices.length > 0 ? choices.map((choice) => choice.label) : field.getOptions();
    const selected = field.getSelected().map((value) => (
      choices.find((choice) => choice.value === value)?.label ?? value
    ));
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

/** A choice value or a display label, read out of whatever object holds it. */
function sampleText(object: unknown): string | undefined {
  if (object instanceof PDFString || object instanceof PDFHexString) return object.decodeText();
  if (object instanceof PDFName) return object.asString().replace(/^\//, '');
  return undefined;
}

/**
 * Every choice a field offers, with both halves of an `/Opt` pair kept.
 *
 * `/Opt` entries are either a single string (export = display) or the pair
 * `[export, display]` a producer writes when the words in the list are not the words
 * in the data (PDF 32000-1 §12.7.4.3). pdf-lib reads only one half at a time:
 * `PDFDropdown.getOptions()` answers with the **display** text and `select()` then
 * writes whatever it is handed straight into `/V`, so answering the offered
 * "New York" shipped `/V (New York)` where the export value is `(ny)` — measured on
 * the forms lane's `pairs2.pdf`, matrix item 1 — while `PDFRadioGroup.getOptions()`
 * calls `getExportValues()`, which drops pair entries entirely and leaves the group
 * with **no** options: the filler pane renders a raw text box instead of the radios
 * and every answer is refused as "could not be written".
 *
 * A radio is labelled by the group's `/Opt` but *answered* by each kid's own on-state
 * (`/V` and the kid `/AS` carry that name), so the pairs are zipped onto the kids in
 * kid order and the value stays the on-state.
 */
function choicesOf(field: PDFField): { value: string; label: string }[] {
  const opt = field.acroField.dict.lookupMaybe(PDFName.of('Opt'), PDFArray);
  const pairs = (opt?.asArray() ?? []).flatMap((entry) => {
    if (entry instanceof PDFArray) {
      const value = sampleText(entry.get(0));
      return value === undefined ? [] : [{ value, label: sampleText(entry.get(1)) ?? value }];
    }
    const value = sampleText(entry);
    return value === undefined ? [] : [{ value, label: value }];
  });
  if (field instanceof PDFRadioGroup) {
    return field.acroField.getOnValues().flatMap((on, index) => {
      const value = sampleText(on);
      return value === undefined
        ? []
        : [{ value, label: pairs[index]?.label ?? pairs[index]?.value ?? value }];
    });
  }
  return pairs;
}

/** The answer for a choice field, whether the caller knew the label or the value. */
function matchChoice(
  choices: { value: string; label: string }[],
  answer: string,
): { value: string; label: string } | undefined {
  const wanted = answer.trim();
  return choices.find((choice) => choice.label === wanted) ?? choices.find((choice) => choice.value === wanted);
}

/**
 * pdf-lib's "regenerate this field's appearance" flag is set by every `select()` and
 * `setText()` and cleared only by its own private `markAsClean`, and `PDFDocument.save`
 * re-runs the whole pass over whatever is still flagged — with Helvetica. One non-WinAnsi
 * answer therefore throws out of `save()` after the seam was finished: the raw library
 * sentence in the banner and no file at all (forms lane matrix item 2). The flag is set
 * and cleared here in the same call that owns the field's bytes, so the seam says so.
 */
function markAppearancesBuilt(field: PDFField): void {
  // `markAsClean` is `protected` on PDFField but present at runtime (every setter calls
  // it), and clearing the flag is the only way to stop `save()` re-running the pass.
  const cleanable = field as unknown as { markAsClean?: () => void };
  cleanable.markAsClean?.();
}

/** A choice field answered by label, whose `/V` still has to be pointed at the exports. */
interface ChoiceWrite {
  field: PDFField;
  values: string[];
  /** For a radio group: the kid on-state that carries the answer. */
  on?: string;
}

/**
 * Write the answer's own bytes, after pdf-lib's appearance pass has run.
 *
 * The order is the whole point: pdf-lib draws the appearance out of `/V` and re-derives
 * a radio's `/AS` from `getExportValues()`, which cannot see `/Opt` pairs — so `/V`
 * briefly holds the **label** (what the picker showed and what the page keeps showing),
 * and the export value / kid on-state is written only once that stream exists. A
 * multi-select field takes an array, as §12.7.4.2 requires; a single one takes the bare
 * string, which is what the producers of the corpus fixtures write.
 */
function writeExportValues(doc: PDFDocument, { field, values, on }: ChoiceWrite): void {
  const dict = field.acroField.dict;
  if (on !== undefined && field instanceof PDFRadioGroup) {
    dict.set(PDFName.of('V'), PDFName.of(on));
    const onStates = field.acroField.getOnValues();
    field.acroField.getWidgets().forEach((widget, index) => {
      const state = sampleText(onStates[index]);
      widget.dict.set(PDFName.of('AS'), PDFName.of(state === on ? on : 'Off'));
    });
    markAppearancesBuilt(field);
    return;
  }
  const multiselect = field instanceof PDFDropdown
    ? field.isMultiselect()
    : field instanceof PDFOptionList && field.isMultiselect();
  if (values.length > 1 || multiselect) {
    const list = PDFArray.withContext(context(doc));
    for (const value of values) list.push(PDFString.of(value));
    dict.set(PDFName.of('V'), list);
    return;
  }
  dict.set(PDFName.of('V'), PDFString.of(values[0] ?? ''));
  markAppearancesBuilt(field);
}

function applyValue(field: PDFField, value: string | boolean, pending: ChoiceWrite[]): boolean {
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
    const choices = choicesOf(field);
    const wanted = typeof value === 'boolean'
      ? (value ? choices[0] : undefined)
      : matchChoice(choices, value);
    if (wanted === undefined) {
      if (value === false || asText(value).trim() === '') {
        field.clear();
        return true;
      }
      return false;
    }
    // A radio's answer is the kid's on-state and that kid is painted by its own
    // `/AS` — its appearance is a per-state stream, not something generated from
    // `/V`. Written after the appearance pass (`writeExportValues`), because pdf-lib
    // derives both halves from `getExportValues()` and pair entries are invisible to
    // it: run over a pair group it rewrote the kid's `/AS /a` to `/Off`, so the
    // selection stopped being drawn for an answer nobody gave.
    pending.push({ field, values: [], on: wanted.value });
    return true;
  }
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    const requested = asText(value);
    const choices = choicesOf(field);
    // An option whose own words contain a comma (`["ab", "Alpha, Beta"]`) is one
    // answer, not two: split only when the whole string is not something the field
    // offers. Before this, selecting the offered "Alpha, Beta" was refused as
    // "could not be written" and `/V` stayed empty.
    const answers = matchChoice(choices, requested)
      ? [requested]
      : requested.split(',').map((option) => option.trim()).filter(Boolean);
    if (answers.length === 0) {
      field.clear();
      return true;
    }
    const matched = answers.map((answer) => matchChoice(choices, answer));
    if (matched.some((match) => match === undefined)) return false;
    // Select by **label** so the appearance pdf-lib draws carries the words the
    // picker showed; `/V` then has to be pointed back at the export values, which
    // `fillForm` does once those appearances exist (`writeExportValues`).
    const multiselect = field.isMultiselect();
    field.select(matched.length === 1 && !multiselect ? matched[0]!.label : matched.map((match) => match!.label));
    pending.push({ field, values: matched.map((match) => match!.value) });
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
  const pending: ChoiceWrite[] = [];
  let filled = 0;
  let needsViewerAppearance = false;

  for (const [name, value] of Object.entries(values)) {
    const field = form.getFieldMaybe(name);
    if (!field) {
      missing.push(name);
      continue;
    }
    if (!applyValue(field, value, pending)) {
      missing.push(name);
      continue;
    }
    filled++;
    if (typeof value === 'string' && !isWinAnsiSafe(value)) needsViewerAppearance = true;
  }

  if (opts.appearance ?? true) {
    try {
      // No explicit font: pdf-lib's default is Helvetica, which handles every
      // WinAnsi value; anything else is covered by `/NeedAppearances` below.
      form.updateFieldAppearances();
    } catch {
      needsViewerAppearance = true;
    }
    // Only now: the streams above were drawn from the labels, and `/V` has to end up
    // holding what the data model asked for.
    for (const write of pending) writeExportValues(doc, write);
    if (needsViewerAppearance) setNeedAppearances(doc, true);
  } else {
    setNeedAppearances(doc, true);
  }

  // Nothing may be left flagged for pdf-lib's own pass: `PDFDocument.save` re-runs it
  // over every dirty field with Helvetica, and one non-WinAnsi answer threw there —
  // raw library sentence in the banner, no file (forms lane matrix item 2, `Ada 中文
  // Łovélace`). Whatever this call could not draw is handed to the viewer instead.
  for (const field of form.getFields()) markAppearancesBuilt(field);

  return { filled, missing };
}

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

/**
 * The appearance state this widget should show right now.
 *
 * `/AS` is the entry a viewer paints (PDF 32000-1 §12.5.5: it names the key of the
 * `/AP /N` state table), so it is asked first. `/V` says what the *field* means, and
 * producers do not agree on its type: MuPDF writes a radio's `/V` as the **string**
 * `(Yes)` while its state table is keyed by the **name** `/Yes` — matching the raw
 * value against the table then misses, falls through to `/Off`, and bakes the empty
 * circle over a ticked field (measured on the lane's mix.pdf sheet 2: 181 px of
 * vanished tick, 16 pt box, against a MuPDF bake that changes 0 px). A string value
 * is therefore coerced to a name before the table is asked, and `/Off` is reached
 * only when neither `/AS` nor the value names a state.
 */
function appearanceStates(field: PDFField, widget: PDFWidgetAnnotation): PDFName[] {
  const name = (value: unknown): PDFName | undefined => {
    if (value instanceof PDFName) return value;
    if (value instanceof PDFString || value instanceof PDFHexString) {
      const text = value.decodeText();
      return text ? PDFName.of(text) : undefined;
    }
    return undefined;
  };
  return [
    name(widget.dict.get(PDFName.of('AS'))),
    name(field.acroField.dict.get(PDFName.of('V'))),
  ].filter((entry): entry is PDFName => entry !== undefined);
}

/**
 * Resolve the appearance stream a widget should show right now.
 *
 * A checkbox or radio keeps one `/AP /N` **table** of states, so the state has to be
 * picked before the stream can be drawn — see `appearanceStates`. A direct (inline)
 * stream in that table is registered first: everything downstream asks for the
 * appearance by reference, which is also how `core/flatten` resolves a mark's table.
 */
function appearanceRefFor(
  doc: PDFDocument,
  field: PDFField,
  widget: PDFWidgetAnnotation,
): PDFRef | undefined {
  let refOrDict: unknown = widget.getNormalAppearance();
  if (
    refOrDict instanceof PDFDict &&
    (field instanceof PDFCheckBox || field instanceof PDFRadioGroup)
  ) {
    const table = refOrDict;
    const entries = table.entries();
    const candidate = appearanceStates(field, widget)
      .map((state) => table.get(state))
      .find((entry) => entry !== undefined)
      ?? (entries.length === 1 ? entries[0][1] : undefined)
      ?? table.get(PDFName.of('Off'));
    if (candidate instanceof PDFRef) refOrDict = candidate;
    else if (candidate instanceof PDFStream) refOrDict = doc.context.register(candidate);
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
        const appearance = appearanceRefFor(doc, field, widget);
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
          rotation: appearanceTurn(widget.dict),
        });
      }
      if (widgets.length > 0 && incomplete) {
        needsRender = true;
        continue;
      }

      for (const { page, appearance, rect, rotation } of planned) {
        // The words have to end up in the page's own content: that is what makes a
        // flattened answer still findable by search, copy and redaction in this
        // app and in every other reader. A form this module cannot copy (no box,
        // an unparsable stream) is still drawn, as a scaled XObject.
        const baked = inlineFormXObject(page, appearance, { rect, rotation });
        if (baked) continue;
        const key = page.node.newXObject('FlatWidget', appearance);
        page.pushOperators(
          pushGraphicsState(),
          translate(rect.x, rect.y),
          ...rotateInPlace({
            width: rect.width,
            height: rect.height,
            rotation,
          }),
          // A form XObject is drawn onto the unit square; without this the whole
          // appearance lands on the page as a one-point speck.
          scale(rect.width, rect.height),
          drawObject(key),
          popGraphicsState(),
        );
      }
      form.removeField(field);
      for (const { page, widgetRef } of planned) {
        page.node.removeAnnot(widgetRef);
        // `removeAnnot` leaves an empty `/Annots []` behind; a page with no
        // annotations at all should not carry the key.
        const remaining = page.node.Annots();
        if (remaining && remaining.size() === 0) page.node.delete(PDFName.of('Annots'));
      }
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
  // A flattened page is not a form. Deleting every field leaves an empty
  // `/AcroForm` behind, which still makes a reader open the document in form
  // mode, still lists a form in its panel and still offers to tab through
  // fields that are now ink — so the dictionary goes with the last field.
  if (form.getFields().length === 0) doc.catalog.delete(PDFName.of('AcroForm'));
  return { flattened, needsRender };
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

/**
 * Where the widget goes, and how it is drawn.
 *
 * pdf-lib grows the widget `/Rect` by the whole border width, centred on the
 * box the caller asked for (`x - w/2 … x + width + w/2`), because a border is
 * drawn on the middle of the path. The designer drops a field at an exact
 * rectangle, so the border is folded back in: the widget ends up on the rect the
 * user drew, with its border straddling that edge rather than standing outside
 * it.
 */
const WIDGET_BORDER = 0.5;

function appearanceOptions(spec: CreateFieldSpec) {
  return {
    x: spec.rect.x + WIDGET_BORDER / 2,
    y: spec.rect.y + WIDGET_BORDER / 2,
    width: Math.max(1, spec.rect.width - WIDGET_BORDER),
    height: Math.max(1, spec.rect.height - WIDGET_BORDER),
    textColor: rgb(0, 0, 0),
    borderColor: rgb(0.4, 0.4, 0.4),
    borderWidth: WIDGET_BORDER,
  };
}

/**
 * Add one interactive field (with its widget) to `page`.
 *
 * @returns the 0-based index of the new field in `doc.getForm().getFields()`,
 * or `-1` when nothing was created.
 */
/**
 * Give a freshly created field the `/DA` its own size editor demands.
 *
 * pdf-lib changes a field's text size by rewriting the last `Tf` in `/DA`, and a field
 * created a moment ago has no `/DA` at all — so `setFontSize` threw "No /DA (default
 * appearance) entry found for field: X" and the form designer could not save a form it
 * had just laid out: the pane printed the library's sentence and produced no file.
 * Seeding the string the caller asked for is enough, because saving rebuilds the
 * appearances with the embedded face and replaces it (`PDFForm.updateFieldAppearances`).
 */
function seedDefaultAppearance(field: PDFField, size: number): void {
  if (!field.acroField.getDefaultAppearance()) {
    field.acroField.setDefaultAppearance(`/Helvetica ${size} Tf 0 g`);
  }
}

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
      if (spec.fontSize) {
        seedDefaultAppearance(field, spec.fontSize);
        field.setFontSize(spec.fontSize);
      }
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
      if (spec.fontSize) {
        seedDefaultAppearance(field, spec.fontSize);
        field.setFontSize(spec.fontSize);
      }
      field.addToPage(target, options);
      created = field;
      break;
    }
    case 'list': {
      const field = form.createOptionList(spec.name);
      if (spec.options?.length) field.setOptions(spec.options);
      if (spec.value) field.select(spec.value);
      if (spec.fontSize) {
        seedDefaultAppearance(field, spec.fontSize);
        field.setFontSize(spec.fontSize);
      }
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
