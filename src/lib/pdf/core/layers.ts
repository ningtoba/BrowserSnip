/**
 * Optional content groups (OCGs) — the "layers" panel of a PDF.
 *
 * Layers are used by CAD, GIS and illustration exports: a single page can carry
 * several toggleable groups. pdf-lib has no layer API, so the `/OCProperties`
 * dictionary in the catalog is read and written here.
 */
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFObject, PDFRef, PDFString } from './doc';
import type { PDFDocument } from './doc';

export interface PdfLayer {
  /** Decoded for display: never a `#xx` escape, a BOM or a U+FFFD sentinel. */
  name: string;
  xref: number;
  /** Whether the layer is visible in the default view configuration. */
  on: boolean;
  intent?: string;
  usage?: string;
  /** Parent group, when the OCG is nested. */
  parentXref?: number;
}

function ocProperties(doc: PDFDocument, create = false): PDFDict | null {
  const existing = resolveDict(doc, doc.catalog.get(PDFName.of('OCProperties')));
  if (existing) return existing;
  if (!create) return null;

  const context = doc.context;
  const defaultConfig = context.obj({
    OCGs: context.obj([]),
    State: context.obj([]),
    Intent: context.obj([PDFName.of('View')]),
  }) as PDFDict;
  const properties = context.obj({
    OCGs: context.obj([]),
    D: defaultConfig,
  }) as PDFDict;
  const ref = context.register(properties);
  doc.catalog.set(PDFName.of('OCProperties'), ref);
  return properties;
}

function arrayAt(doc: PDFDocument, dict: PDFDict, key: string): PDFArray | null {
  // `/OCGs`, `/D` and the `ON`/`OFF`/`Order` lists are all commonly indirect.
  const value = deref(doc, dict.get(PDFName.of(key)));
  return value instanceof PDFArray ? value : null;
}

function ocgDicts(doc: PDFDocument, properties: PDFDict): { array: PDFArray | null; dicts: { ref: PDFRef; dict: PDFDict }[] } {
  const array = arrayAt(doc, properties, 'OCGs');
  const refs = array ? array.asArray().filter((item): item is PDFRef => item instanceof PDFRef) : [];
  const dicts: { ref: PDFRef; dict: PDFDict }[] = [];
  for (const ref of refs) {
    // An entry that is not an OCG (a dangling reference, an array member some
    // producer wrote by mistake) is skipped rather than thrown on.
    const dict = resolveDict(doc, ref);
    if (dict) dicts.push({ ref, dict });
  }
  return { array, dicts };
}

/**
 * Read every OCG and whether the default configuration shows it.
 *
 * Names come back as the text the author typed, decoded from whichever of the
 * three spellings the file used; see `layerName`.
 */
export function listLayers(doc: PDFDocument): PdfLayer[] {
  const properties = ocProperties(doc);
  if (!properties) return [];
  const { dicts } = ocgDicts(doc, properties);
  const defaultConfig = resolveDict(doc, properties.get(PDFName.of('D')));
  const onNames = new Set<string>();
  const offNames = new Set<string>();
  if (defaultConfig) {
    collectStates(doc, defaultConfig.get(PDFName.of('ON')), onNames);
    collectStates(doc, defaultConfig.get(PDFName.of('OFF')), offNames);
  }
  const order = defaultConfig ? defaultConfig.get(PDFName.of('Order')) : undefined;
  void order;

  return dicts.map(({ ref, dict }) => {
    const name = layerName(doc, dict.get(PDFName.of('Name'))) ?? `Layer ${ref.objectNumber}`;
    const usage = resolveDict(doc, dict.get(PDFName.of('Usage')));
    const intent = readNameArray(dict.get(PDFName.of('Intent')));
    return {
      name,
      xref: ref.objectNumber,
      // PDF's default is "on" unless the configuration says otherwise.
      on: offNames.has(ref.toString()) ? false : onNames.size === 0 ? true : onNames.has(ref.toString()),
      intent: intent[0],
      usage: usage ? readFirstKey(usage) : undefined,
      parentXref: parentOf(doc, dict),
    };
  });
}

function parentOf(doc: PDFDocument, dict: PDFDict): number | undefined {
  const parent = dict.get(PDFName.of('Parent'));
  if (parent instanceof PDFRef) return parent.objectNumber;
  const resolved = resolveDict(doc, parent);
  const ref = resolved?.get(PDFName.of('Parent'));
  return ref instanceof PDFRef ? ref.objectNumber : undefined;
}

/**
 * Toggle a layer's visibility in the default view configuration.
 *
 * Only `D` (the default) is edited; named configurations keep their own state,
 * which matches how viewers present the layers panel.
 */
export function setLayerVisibility(doc: PDFDocument, name: string, on: boolean): boolean {
  const properties = ocProperties(doc);
  if (!properties) return false;
  const target = findLayer(doc, name);
  if (!target) return false;
  const defaultConfig = resolveDict(doc, properties.get(PDFName.of('D')));
  if (!defaultConfig) return false;
  const context = doc.context;
  const { dicts } = ocgDicts(doc, properties);
  const ref = dicts.find((entry) => entry.ref.objectNumber === target.xref)?.ref;
  if (!ref) return false;

  const onArray = ensureArray(doc, defaultConfig, 'ON');
  const offArray = ensureArray(doc, defaultConfig, 'OFF');
  const alreadyOn = indexOfRef(onArray, ref) !== -1;
  const alreadyOff = indexOfRef(offArray, ref) !== -1;
  // A viewer treats "not listed" as the OCG's own /ON default (true), so
  // switching on an unlisted layer is already on — record it explicitly so the
  // state survives being switched off and on again.
  if (on) {
    if (!alreadyOn) onArray.push(ref);
    if (alreadyOff) removeAt(offArray, indexOfRef(offArray, ref));
  } else {
    if (!alreadyOff) offArray.push(ref);
    if (alreadyOn) removeAt(onArray, indexOfRef(onArray, ref));
  }
  void context;
  return true;
}

/** Create a new OCG and make it visible. */
export function addLayer(doc: PDFDocument, name: string, options: { intent?: string; on?: boolean } = {}): number {
  const properties = ocProperties(doc, true);
  if (!properties) throw new Error('This document could not be given a layers dictionary.');
  const context = doc.context;
  const dict = context.obj({
    Type: 'OCG',
    // `/Name` is a text string. `context.obj(name)` would build a PDF name
    // instead, which escapes the space in "Revision B" to `Revision#20B` — the
    // panel then shows a different name from the one the user typed, and no
    // later instruction naming "Revision B" matches it.
    Name: PDFHexString.fromText(name),
    ...(options.intent ? { Intent: context.obj([PDFName.of(options.intent)]) } : {}),
  }) as PDFDict;
  const ref = context.register(dict);
  const array = ensureArray(doc, properties, 'OCGs');
  array.push(ref);
  const defaultConfig = resolveDict(doc, properties.get(PDFName.of('D')));
  if (defaultConfig) {
    const order = ensureArray(doc, defaultConfig, 'Order');
    order.push(ref);
    if (options.on === false) ensureArray(doc, defaultConfig, 'OFF').push(ref);
    else ensureArray(doc, defaultConfig, 'ON').push(ref);
  }
  return ref.objectNumber;
}

/** Delete an OCG and remove it from every configuration list. */
export function deleteLayer(doc: PDFDocument, name: string): boolean {
  const properties = ocProperties(doc);
  if (!properties) return false;
  const target = findLayer(doc, name);
  if (!target) return false;
  const { array, dicts } = ocgDicts(doc, properties);
  const entry = dicts.find((candidate) => candidate.ref.objectNumber === target.xref);
  if (!entry || !array) return false;
  const index = indexOfRef(array, entry.ref);
  if (index !== -1) removeAt(array, index);
  doc.context.delete(entry.ref);

  const defaultConfig = resolveDict(doc, properties.get(PDFName.of('D')));
  if (defaultConfig) {
    for (const key of ['ON', 'OFF', 'Order']) {
      const list = arrayAt(doc, defaultConfig, key);
      if (!list) continue;
      const at = indexOfRef(list, entry.ref);
      if (at !== -1) removeAt(list, at);
    }
  }
  return true;
}

/** Rename an existing OCG. */
export function renameLayer(doc: PDFDocument, from: string, to: string): boolean {
  const properties = ocProperties(doc);
  if (!properties) return false;
  const target = findLayer(doc, from);
  if (!target) return false;
  const { dicts } = ocgDicts(doc, properties);
  const entry = dicts.find((candidate) => candidate.ref.objectNumber === target.xref);
  if (!entry) return false;
  entry.dict.set(PDFName.of('Name'), PDFHexString.fromText(to));
  return true;
}

// ── small dictionary helpers ────────────────────────────────────────────────

/** The OCG a user means by `name`, matched case-insensitively on the decoded name. */
function findLayer(doc: PDFDocument, name: string): PdfLayer | undefined {
  const wanted = name.trim().toLowerCase();
  return listLayers(doc).find((layer) => layer.name.toLowerCase() === wanted);
}

/** Resolve an indirect object without naming a class for it — that would throw. */
function deref(doc: PDFDocument, value: unknown): PDFObject | undefined {
  if (value instanceof PDFRef) return doc.context.lookup(value);
  return value instanceof PDFObject ? value : undefined;
}

function resolveDict(doc: PDFDocument, value: unknown): PDFDict | null {
  const target = deref(doc, value);
  return target instanceof PDFDict ? target : null;
}

/**
 * Read an OCG `/Name` as the text the author meant.
 *
 * The spec asks for a text string — PDFDocEncoding, or UTF-16BE with a byte
 * order mark — and `decodeText` handles both. Files written before this module
 * stored text strings (and some producers) hold a PDF name instead, where a
 * space survives as `#20`, so that is unescaped too. `undefined` means "no
 * readable name was recorded", which callers show as the object number rather
 * than as garbage.
 */
function layerName(doc: PDFDocument, value: unknown): string | undefined {
  const target = deref(doc, value);
  if (target instanceof PDFString || target instanceof PDFHexString) {
    return displayText(target.decodeText());
  }
  if (target instanceof PDFName) {
    // `toString()` is the escaped form (`/Revision#20B`); the leading `/` is the
    // name delimiter, not part of the layer's name.
    return displayText(unescapeName(target.toString().slice(1)));
  }
  return undefined;
}

/** `#xx` → the byte it stands for, as a PDF name does for every odd character. */
function unescapeName(text: string): string {
  return text.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * A name for the UI: no byte-order mark, and never the U+FFFD sentinel that
 * decoding a byte the PDF encoding cannot name produces.
 */
function displayText(text: string): string | undefined {
  const clean = text.replace(/\uFEFF/g, '').replace(/\uFFFD/g, '').trim();
  return clean === '' ? undefined : clean;
}

function ensureArray(doc: PDFDocument, dict: PDFDict, key: string): PDFArray {
  const existing = arrayAt(doc, dict, key);
  if (existing) return existing;
  const created = doc.context.obj([]) as PDFArray;
  dict.set(PDFName.of(key), created);
  return created;
}

function indexOfRef(array: PDFArray, ref: PDFRef): number {
  const needle = ref.toString();
  return array.asArray().findIndex((item) => String(item) === needle);
}

function removeAt(array: PDFArray, index: number): void {
  const items = array.asArray();
  const kept = items.filter((_, position) => position !== index);
  // `PDFArray` has no splice, so rebuild it in place.
  for (let position = items.length - 1; position >= 0; position--) {
    array.remove(position);
  }
  for (const item of kept) array.push(item);
}

function collectStates(doc: PDFDocument, value: unknown, into: Set<string>): void {
  const raw = deref(doc, value);
  const array = raw instanceof PDFArray ? raw : null;
  if (!array) return;
  for (const item of array.asArray()) {
    if (item instanceof PDFRef) into.add(item.toString());
    else {
      const dict = resolveDict(doc, item);
      const ref = dict?.get(PDFName.of('OCG'));
      if (ref instanceof PDFRef) into.add(ref.toString());
    }
  }
}

function readNameArray(value: unknown): string[] {
  const text = String(value ?? '');
  return [...text.matchAll(/\/([A-Za-z0-9_]+)/g)].map((match) => match[1]);
}

function readFirstKey(dict: PDFDict): string | undefined {
  const keys = dict.entries();
  const first = keys[0];
  return first ? String(first[0]).replace(/^\//, '') : undefined;
}
