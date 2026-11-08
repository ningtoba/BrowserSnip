/**
 * Optional content groups (OCGs) — the "layers" panel of a PDF.
 *
 * Layers are used by CAD, GIS and illustration exports: a single page can carry
 * several toggleable groups. pdf-lib has no layer API, so the `/OCProperties`
 * dictionary in the catalog is read and written here.
 */
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNull, PDFObject, PDFRef, PDFStream, PDFString } from './doc';
import type { PDFDocument } from './doc';
import {
  pageContentStreams,
  parseContentStream,
  serialiseContentStream,
  streamBytes,
  type ContentOp,
  type ContentOperand,
  type DictOperand,
} from './content';

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
  // The layers panel and `removeHiddenLayerContent` have to agree on what
  // "hidden" means, so both read the same effective state: `/BaseState`,
  // `/REON` and PDF's own rule that a group no list mentions is on. A default
  // configuration strict enough to refuse falls back to "nothing is off", which
  // is what a reader shows for a file it cannot interpret either.
  const listed = new Set(dicts.map(({ ref }) => ref.toString()));
  const view = defaultConfiguration(doc, properties, listed);
  const offNames = view.ok ? view.value.state.off : new Set<RefKey>();

  return dicts.map(({ ref, dict }) => {
    const name = layerName(doc, dict.get(PDFName.of('Name'))) ?? `Layer ${ref.objectNumber}`;
    const usage = resolveDict(doc, dict.get(PDFName.of('Usage')));
    const intent = readNameArray(dict.get(PDFName.of('Intent')));
    return {
      name,
      xref: ref.objectNumber,
      on: !offNames.has(ref.toString()),
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

// ── deleting the ink of layers the default view switches off ───────────────

/** `7 0 R` — the identity of an indirect object inside one document. */
type RefKey = string;

/** A group definition, plus the reference every guard names it with. */
interface GroupEntry {
  ref: PDFRef;
  key: RefKey;
  dict: PDFDict;
  name: string;
}

/**
 * The state one optional content configuration declares.
 *
 * A layer neither list mentions is on — PDF's own default — unless the
 * configuration sets `/BaseState /OFF`, which inverts it; `/REON` switches a
 * layer back on when the document opens. `off` is what a reader therefore
 * shows *not*, and it is the only thing this module deletes ink for.
 */
interface ConfigState {
  on: Set<RefKey>;
  off: Set<RefKey>;
  reon: Set<RefKey>;
}

/** A configuration a reader can switch to besides the default one. */
interface NamedConfig {
  name: string;
  state: ConfigState;
}

/** Reading a dictionary either yields an answer or admits it cannot. */
type Read<T> = { ok: true; value: T } | { ok: false; problem: string };

/**
 * What one `BDC` property list says about the visibility of what it guards.
 *
 * `condition` is an OCMD: the content belongs to a rule over several layers, so
 * no single layer's default state decides it and the ink stays. `unresolved` is
 * optional content that cannot be tied to one group in `/OCGs`.
 */
type SpanGuard =
  | { kind: 'group'; key: RefKey }
  /** An OCMD: the layers its rule names, so they stay defined. */
  | { kind: 'condition'; keys: RefKey[] }
  | { kind: 'unresolved' }
  | { kind: 'none' };

/** One layer whose hidden ink was deleted. */
export interface HiddenLayerGroup {
  name: string;
  xref: number;
  /** `BDC … EMC` spans taken out of the content. */
  spans: number;
  /** Form XObjects the layer guarded, deleted with the calls that drew them. */
  forms: number;
  /** Operators deleted, the span markers included. */
  operators: number;
  /** Whether the group definition went with its content. */
  definitionRemoved: boolean;
}

/** A layer the default view switches off whose content was deliberately kept. */
export interface KeptHiddenLayer {
  name: string;
  xref: number;
  /** Why it stayed, in the words the report prints. */
  reason: string;
}

/** What {@link removeHiddenLayerContent} did, and what it refused to do. */
export interface HiddenLayerCleanup {
  /**
   * A clause naming the `/OCProperties` shape that could not be resolved. When
   * it is set nothing was changed at all: guessing is the failure mode here.
   */
  refused: string | null;
  removed: HiddenLayerGroup[];
  kept: KeptHiddenLayer[];
  /** Spans and operators, summed over the layers that lost their ink. */
  spans: number;
  operators: number;
  /** Form XObjects deleted outright. */
  forms: number;
  /** Bytes of decoded page and form content that left the file. */
  contentBytes: number;
  /** Marked content guarded by an OCMD rather than by one layer. */
  conditional: number;
  /** Optional-content references that could not be tied to one layer. */
  unresolved: number;
  /** Content this parser could not read; its ink was not touched. */
  unreadable: number;
  /** Pages that are themselves optional: dropping them would drop a page. */
  hiddenPages: number;
  /** Layers whose `/OCProperties` entry is gone as well as their drawing. */
  definitions: number;
}

/** One thing that draws: a page's `/Contents`, or a form XObject's stream. */
interface ContentScope {
  resources: PDFDict | null;
  streams: { ref: PDFRef; bytes: Uint8Array }[];
  /** False when the scope was skipped, or a stream of it could not be read. */
  editable: boolean;
}

/** A form XObject in the file: the object, its dictionary and its bytes. */
interface FormEntry {
  ref: PDFRef;
  dict: PDFDict;
  resources: PDFDict | null;
  bytes: Uint8Array | null;
}

/** What came out of one scope's content, and what it still draws. */
interface ScopeEdit {
  spans: number;
  operators: number;
  bytes: number;
  conditional: number;
  unresolved: number;
  /** Guarded forms this scope still calls, so their objects must stay. */
  stillDrawn: RefKey[];
  /** What each layer lost, keyed as `removable` is. */
  perGroup: Map<RefKey, { spans: number; operators: number; bytes: number }>;
}

/**
 * Delete the drawing operators of the layers the default view switches off.
 *
 * The rule, and why it is narrow: content goes only where its `/OC` reference
 * resolves to exactly one group that the default configuration switches off. A
 * layer that another configuration, `/REON`, a non-`/View` `/Intent` or a
 * `/Usage /View` / `/Export` entry leaves visible keeps its ink — deleting the
 * operators changes what the document *can* show, not merely what it shows, and
 * a reader with a different optional-content configuration would have drawn
 * them. Content guarded by an OCMD is a rule over several layers rather than one
 * layer's state, so it stays too; a file whose `/OCProperties` cannot be
 * resolved is reported as untouched instead of being guessed at.
 *
 * This is the half of the job {@link deleteLayer} cannot do: deleting a group
 * definition leaves its drawing operators in the page, where they fall back to
 * visible. Here the operators go first, and the definition follows only when
 * nothing that was read still refers to the group.
 */
export function removeHiddenLayerContent(doc: PDFDocument): HiddenLayerCleanup {
  const result: HiddenLayerCleanup = {
    refused: null,
    removed: [],
    kept: [],
    spans: 0,
    operators: 0,
    forms: 0,
    contentBytes: 0,
    conditional: 0,
    unresolved: 0,
    unreadable: 0,
    hiddenPages: 0,
    definitions: 0,
  };
  const properties = ocProperties(doc);
  if (!properties) return result;

  const groups = groupEntries(doc, properties);
  const listed = new Set(groups.map((group) => group.key));
  const view = defaultConfiguration(doc, properties, listed);
  if (!view.ok) {
    result.refused = view.problem;
    return result;
  }
  const others = otherConfigurations(doc, properties, listed);
  if (!others.ok) {
    result.refused = others.problem;
    return result;
  }

  const byKey = new Map(groups.map((group) => [group.key, group]));
  const byObject = new Map(groups.map((group) => [group.dict, group]));
  const removable = new Map<RefKey, HiddenLayerGroup>();
  for (const group of groups) {
    if (!view.value.state.off.has(group.key)) continue;
    const reason = keepHiddenContentReason(doc, group, view.value.state, others.value);
    if (reason) result.kept.push({ name: group.name, xref: group.ref.objectNumber, reason });
    else {
      removable.set(group.key, {
        name: group.name,
        xref: group.ref.objectNumber,
        spans: 0,
        forms: 0,
        operators: 0,
        definitionRemoved: false,
      });
    }
  }
  result.removed = [...removable.values()];
  if (removable.size === 0) return result;

  const scopes = collectScopes(doc, byKey, byObject, removable, result);
  // Forms a removable layer guards: they never run, so neither may their ink.
  const guardedForms = new Map<RefKey, { form: FormEntry; group: RefKey }>();
  // Content that survived, and so still needs its group defined.
  const stillUsed = new Set<RefKey>();
  const stillDrawn = new Set<RefKey>();
  for (const entry of scopes.forms.values()) {
    const guard = pdfGuard(doc, entry.dict.get(PDFName.of('OC')), entry.resources, byKey, byObject, 0);
    if (guard.kind === 'group' && removable.has(guard.key)) {
      guardedForms.set(entry.ref.toString(), { form: entry, group: guard.key });
    } else if (guard.kind === 'condition') {
      result.conditional += 1;
      for (const key of guard.keys) stillUsed.add(key);
    } else if (guard.kind === 'unresolved') result.unresolved += 1;
  }
  for (const scope of scopes.list) {
    if (!scope.editable) {
      // Nothing inside was read, so nothing inside can be relied on: every
      // guarded form its resources can name has to stay in the file.
      for (const [key, entry] of guardedForms) {
        if (scope.resources && drawsXObject(doc, scope.resources, entry.form.ref)) stillDrawn.add(key);
      }
      continue;
    }
    const edit = editScope(doc, scope, removable, guardedForms, byKey, byObject, stillUsed, result);
    result.spans += edit.spans;
    result.operators += edit.operators;
    result.contentBytes += edit.bytes;
    result.conditional += edit.conditional;
    result.unresolved += edit.unresolved;
    for (const key of edit.stillDrawn) stillDrawn.add(key);
    for (const [key, lost] of edit.perGroup) {
      const record = removable.get(key);
      if (!record) continue;
      record.spans += lost.spans;
      record.operators += lost.operators;
    }
  }

  // A guarded form nothing draws any more: its bytes go with it.
  for (const [key, entry] of guardedForms) {
    const record = removable.get(entry.group);
    if (record) record.forms += 1;
    if (stillDrawn.has(key)) continue;
    if (entry.form.bytes) result.contentBytes += entry.form.bytes.byteLength;
    doc.context.delete(entry.form.ref);
    for (const scope of scopes.list) purgeXObject(doc, scope.resources, entry.form.ref);
    result.forms += 1;
  }

  // A layer's definition goes only when nothing that was read still names it:
  // an orphan `/OC` reference (an annotation, a page, an OCMD) would make the
  // content that stayed visible again in the very readers this tool keeps.
  const blocked = structuralReferences(doc, properties, new Set(removable.keys()));
  const purgeable = new Set<RefKey>();
  for (const [key, record] of removable) {
    // Uncertainty of any kind keeps the definition: an unreadable stream, an
    // optional page, a guard that names this group, or a reference from an
    // annotation or field. The ink is still gone; only the panel entry stays.
    if (
      result.unreadable > 0 ||
      result.hiddenPages > 0 ||
      result.unresolved > 0 ||
      stillUsed.has(key) ||
      (blocked.get(key) ?? 0) > 0
    ) continue;
    purgeable.add(key);
    record.definitionRemoved = true;
    result.definitions += 1;
  }
  purgePropertyLists(doc, scopes.list, purgeable);
  for (const key of purgeable) {
    const group = byKey.get(key);
    if (!group) continue;
    removeRefsFrom(doc, properties, group.ref.toString(), new Set<RefKey>(), 0);
    doc.context.delete(group.ref);
  }
  return result;
}

/** Every group in `/OCProperties /OCGs`, in the order the panel shows them. */
function groupEntries(doc: PDFDocument, properties: PDFDict): GroupEntry[] {
  return ocgDicts(doc, properties).dicts.map(({ ref, dict }) => ({
    ref,
    key: ref.toString(),
    dict,
    name: layerName(doc, dict.get(PDFName.of('Name'))) ?? `Layer ${ref.objectNumber}`,
  }));
}

/**
 * The default configuration, read strictly.
 *
 * `/D` is required and every producer writes it; a file without it does not say
 * what it shows on open, which is the one question a deletion answers. A list
 * that is not a list, or an entry that is not a group, is reported the same way
 * rather than skipped: the cost of guessing here is invisible ink.
 */
function defaultConfiguration(
  doc: PDFDocument,
  properties: PDFDict,
  universe: Set<RefKey>,
): Read<{ config: PDFDict; state: ConfigState }> {
  const config = resolveDict(doc, properties.get(PDFName.of('D')));
  if (!config) return { ok: false, problem: 'the file has no default viewing configuration (/OCProperties /D)' };
  const state = configurationState(doc, config, universe);
  if (!state.ok) return { ok: false, problem: `the default viewing configuration ${state.problem}` };
  return { ok: true, value: { config, state: state.value } };
}

/** The named configurations a reader can switch to, from `/OCProperties /Configs`. */
function otherConfigurations(doc: PDFDocument, properties: PDFDict, universe: Set<RefKey>): Read<NamedConfig[]> {
  const found: NamedConfig[] = [];
  const raw = deref(doc, properties.get(PDFName.of('Configs')));
  if (raw === undefined) return { ok: true, value: found };
  if (!(raw instanceof PDFArray)) return { ok: false, problem: 'the file writes /Configs as something other than a list' };
  for (const item of raw.asArray()) {
    const config = resolveDict(doc, item);
    if (!config) return { ok: false, problem: 'one of its named configurations is not a configuration dictionary' };
    const name = layerName(doc, config.get(PDFName.of('Name'))) ?? `configuration ${found.length + 1}`;
    const state = configurationState(doc, config, universe);
    if (!state.ok) return { ok: false, problem: `the named configuration "${name}" ${state.problem}` };
    found.push({ name, state: state.value });
  }
  return { ok: true, value: found };
}

/** One configuration's `ON` / `OFF` / `REON` lists, expanded to what a reader shows. */
function configurationState(doc: PDFDocument, config: PDFDict, universe: Set<RefKey>): Read<ConfigState> {
  const listed = new Map<string, Set<RefKey>>();
  for (const key of ['ON', 'OFF', 'REON']) {
    const list = stateList(doc, config, key, universe);
    if (!list.ok) return list;
    listed.set(key, list.value);
  }
  const on = listed.get('ON')!;
  const off = listed.get('OFF')!;
  const reon = listed.get('REON')!;
  if (String(deref(doc, config.get(PDFName.of('BaseState')))) === '/OFF') {
    for (const key of universe) if (!on.has(key)) off.add(key);
  } else {
    for (const key of universe) if (!on.has(key) && !off.has(key)) on.add(key);
  }
  // `/REON` is the file's own promise that the layer is visible once opened.
  for (const key of reon) {
    on.add(key);
    off.delete(key);
  }
  return { ok: true, value: { on, off, reon } };
}

/** The groups one configuration list names, refusing anything it cannot read. */
function stateList(doc: PDFDocument, config: PDFDict, key: string, universe: Set<RefKey>): Read<Set<RefKey>> {
  const refs = new Set<RefKey>();
  const raw = deref(doc, config.get(PDFName.of(key)));
  if (raw === undefined) return { ok: true, value: refs };
  if (!(raw instanceof PDFArray)) return { ok: false, problem: `writes /${key} as something other than a list` };
  const stack = [...raw.asArray()];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item === PDFNull) continue;
    if (item instanceof PDFArray) {
      stack.push(...item.asArray());
      continue;
    }
    const found = stateEntry(doc, item);
    if (!found) return { ok: false, problem: `names something in /${key} that is not a layer (${item})` };
    if (universe.has(found)) refs.add(found);
  }
  return { ok: true, value: refs };
}

/** The group one `ON` / `OFF` entry stands for, or `null` when it is not one. */
function stateEntry(doc: PDFDocument, item: PDFObject): RefKey | null {
  if (item instanceof PDFRef) return resolveDict(doc, item) ? item.toString() : null;
  if (item instanceof PDFDict) {
    const ref = item.get(PDFName.of('OCG'));
    return ref instanceof PDFRef ? ref.toString() : null;
  }
  return null;
}

/**
 * Why a layer the default view switches off keeps its ink, or `null` to delete.
 *
 * The bar is deliberately high, because the output file cannot undo the deletion:
 * any statement that a view, a print run or another configuration shows this
 * layer is enough to leave the content in place.
 */
function keepHiddenContentReason(doc: PDFDocument, group: GroupEntry, view: ConfigState, others: NamedConfig[]): string | null {
  if (view.on.has(group.key) && view.off.has(group.key)) {
    return 'the default configuration lists it both on and off';
  }
  if (view.reon.has(group.key)) return 'the file switches it back on when the document opens (/REON)';
  for (const other of others) {
    if (other.state.on.has(group.key)) return `the named view "${other.name}" switches it back on`;
  }
  const intent = readNameArray(group.dict.get(PDFName.of('Intent'))).filter((name) => name !== 'View');
  if (intent.length > 0) {
    return `it is declared for the ${intent.map((name) => `/${name}`).join(' and ')} use, where readers show it`;
  }
  const usage = resolveDict(doc, group.dict.get(PDFName.of('Usage')));
  if (!usage) return null;
  for (const key of ['View', 'Export']) {
    const value = usage.get(PDFName.of(key));
    if (value === undefined) continue;
    const stated = resolveDict(doc, value);
    if (!stated) return `its /Usage /${key} entry is not a dictionary this reader can interpret`;
    const state = String(deref(doc, stated.get(PDFName.of(key === 'View' ? 'ViewState' : 'ExportState'))));
    if (state !== '/OFF') return `its /Usage /${key} entry does not say the layer is off`;
  }
  return null;
}

/**
 * Every page and form content stream in the document, with its resources.
 *
 * Forms are followed through `/Resources /XObject` from the pages down, because
 * a CAD export puts whole layers inside them; each one is visited once, however
 * many callers it has. A page whose own `/OC` names a layer is *not* entered:
 * dropping its content would leave a blank page where a hidden one is now.
 */
function collectScopes(
  doc: PDFDocument,
  byKey: Map<RefKey, GroupEntry>,
  byObject: Map<PDFDict, GroupEntry>,
  removable: Map<RefKey, HiddenLayerGroup>,
  result: HiddenLayerCleanup,
): { list: ContentScope[]; forms: Map<RefKey, FormEntry> } {
  const list: ContentScope[] = [];
  const forms = new Map<RefKey, FormEntry>();
  const pending: { ref: PDFRef; fallback: PDFDict | null }[] = [];

  doc.getPages().forEach((page) => {
    // `PDFPageLeaf` extends `PDFDict`, so `/OC` is readable with no cast; only
    // `Resources` needs a fallback for a page that has none of its own.
    const node = page.node;
    const scope: ContentScope = {
      resources: node.Resources() ?? null,
      streams: [],
      editable: true,
    };
    const own = pdfGuard(doc, node.get(PDFName.of('OC')), scope.resources, byKey, byObject, 0);
    if (own.kind === 'group' && removable.has(own.key)) {
      // The whole page is one layer's content: emptying it would leave a blank
      // page where a hidden one is now, so it is not entered at all.
      scope.editable = false;
      result.hiddenPages += 1;
    }
    try {
      scope.streams = pageContentStreams(page);
    } catch {
      scope.editable = false;
      result.unreadable += 1;
    }
    list.push(scope);
    for (const entry of formRefs(doc, scope.resources)) pending.push({ ref: entry, fallback: scope.resources });
  });

  while (pending.length > 0) {
    const next = pending.shift()!;
    const key = next.ref.toString();
    if (forms.has(key)) continue;
    const stream = doc.context.lookup(next.ref);
    if (!(stream instanceof PDFStream)) continue;
    let bytes: Uint8Array | null = null;
    let readable = true;
    try {
      bytes = streamBytes(stream);
    } catch {
      readable = false;
      result.unreadable += 1;
    }
    // A form without its own resources draws with the caller's, as PDF allows.
    const resources = resolveDict(doc, stream.dict.get(PDFName.of('Resources'))) ?? next.fallback;
    forms.set(key, { ref: next.ref, dict: stream.dict, resources, bytes });
    list.push({
      resources,
      streams: bytes ? [{ ref: next.ref, bytes }] : [],
      editable: readable,
    });
    for (const entry of formRefs(doc, resources)) pending.push({ ref: entry, fallback: resources });
  }
  return { list, forms };
}

/** The indirect form XObjects one resource dictionary lists. */
function formRefs(doc: PDFDocument, resources: PDFDict | null): PDFRef[] {
  const xobjects = resources ? resolveDict(doc, resources.get(PDFName.of('XObject'))) : null;
  if (!xobjects) return [];
  const found: PDFRef[] = [];
  for (const [, value] of xobjects.entries()) {
    if (!(value instanceof PDFRef)) continue;
    const stream = doc.context.lookup(value);
    if (stream instanceof PDFStream && String(deref(doc, stream.dict.get(PDFName.of('Subtype')))) === '/Form') found.push(value);
  }
  return found;
}

/**
 * Delete the hidden marked content of one scope and write the stream back.
 *
 * A stream is only rewritten when the operators that survive still parse to
 * themselves afterwards: the bytes that stay on the page have to be the bytes
 * that were there, with the hidden spans cut out and nothing else touched.
 */
function editScope(
  doc: PDFDocument,
  scope: ContentScope,
  removable: Map<RefKey, HiddenLayerGroup>,
  guardedForms: Map<RefKey, { form: FormEntry; group: RefKey }>,
  byKey: Map<RefKey, GroupEntry>,
  byObject: Map<PDFDict, GroupEntry>,
  stillUsed: Set<RefKey>,
  result: HiddenLayerCleanup,
): ScopeEdit {
  const edit: ScopeEdit = {
    spans: 0,
    operators: 0,
    bytes: 0,
    conditional: 0,
    unresolved: 0,
    stillDrawn: [],
    perGroup: new Map(),
  };
  /** One more deleted operator, credited to the layer whose span it was. */
  const tally = (key: RefKey) => {
    const entry = edit.perGroup.get(key) ?? { spans: 0, operators: 0, bytes: 0 };
    edit.perGroup.set(key, entry);
    return entry;
  };
  const lost = (key: RefKey | null, isSpan = false) => {
    if (key === null) return;
    const entry = tally(key);
    entry.operators += 1;
    if (isSpan) entry.spans += 1;
  };

  for (const stream of scope.streams) {
    let ops: ContentOp[];
    try {
      ops = parseContentStream(stream.bytes);
    } catch {
      scope.editable = false;
      result.unreadable += 1;
      continue;
    }
    const kept: ContentOp[] = [];
    const stack: { hidden: boolean; key: RefKey | null }[] = [];
    let dropped = 0;
    let bytes = 0;
    for (const op of ops) {
      if (op.name === 'BDC' || op.name === 'BMC') {
        const guard = op.name === 'BDC' ? spanGuard(doc, op, scope.resources, byKey, byObject) : ({ kind: 'none' } as SpanGuard);
        if (guard.kind === 'condition') {
          edit.conditional += 1;
          for (const key of guard.keys) stillUsed.add(key);
        }
        if (guard.kind === 'unresolved') edit.unresolved += 1;
        const hidden = guard.kind === 'group' && removable.has(guard.key);
        if (guard.kind === 'group' && !hidden) stillUsed.add(guard.key);
        stack.push({ hidden, key: guard.kind === 'group' ? guard.key : null });
        if (hidden) {
          edit.spans += 1;
          dropped += 1;
          bytes += opBytes(op);
          lost(guard.key, true);
        } else {
          // A span that stays because its guard is another layer's, a condition,
          // or unreadable still names whatever its operands point at, and those
          // groups cannot have their definitions removed.
          operandRefKeys(op, stillUsed);
          kept.push(op);
        }
        continue;
      }
      if (op.name === 'EMC') {
        const frame = stack.pop();
        if (frame?.hidden) {
          dropped += 1;
          bytes += opBytes(op);
          lost(frame.key);
          continue;
        }
        kept.push(op);
        continue;
      }
      const inside = stack.find((frame) => frame.hidden);
      if (inside) {
        dropped += 1;
        bytes += opBytes(op);
        lost(inside.key);
        continue;
      }
      if (op.name === 'Do') {
        const drawn = drawnForm(doc, scope.resources, op);
        if (drawn && guardedForms.has(drawn)) {
          dropped += 1;
          bytes += opBytes(op);
          lost(guardedForms.get(drawn)?.group ?? null);
          continue;
        }
        if (drawn) edit.stillDrawn.push(drawn);
      }
      kept.push(op);
    }
    if (dropped === 0) continue;
    if (stack.length > 0) {
      // A `BDC` whose `EMC` never came: the span's end is a guess, so the
      // stream is left exactly as it was.
      scope.editable = false;
      continue;
    }
    const written = serialiseContentStream(kept);
    let same = false;
    try {
      same = equalBytes(serialiseContentStream(parseContentStream(written)), written);
    } catch {
      same = false;
    }
    if (!same) {
      scope.editable = false;
      continue;
    }
    replaceStreamContents(doc, stream.ref, written);
    edit.operators += dropped;
    edit.bytes += bytes;
  }
  return edit;
}

/** Bytes one operator occupied in the stream it was parsed from. */
function opBytes(op: ContentOp): number {
  if (op.start >= 0 && op.end > op.start) return op.end - op.start + 1;
  return serialiseContentStream([op]).byteLength;
}

/** Every indirect object one operator's operands name, nested ones included. */
function operandRefKeys(op: ContentOp, into: Set<RefKey>): void {
  for (const item of op.operands) collectOperandRefs(item, into);
}

function collectOperandRefs(item: ContentOperand, into: Set<RefKey>): void {
  if (item.kind === 'ref') into.add(PDFRef.of(item.objectNumber, item.generation).toString());
  else if (item.kind === 'array') item.items.forEach((nested) => collectOperandRefs(nested, into));
  else if (item.kind === 'dict') {
    for (const entry of item.entries) if (entry.value) collectOperandRefs(entry.value, into);
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The layer, condition or nothing one `BDC` guards its content with.
 *
 * Both spellings of the property list are read — `/Tag properties BDC` is the
 * spec's order and producers also write the list first — and `properties` may be
 * an inline dictionary, an indirect reference, or a name into the resources'
 * `/Properties`, which is what Acrobat and most CAD writers emit.
 */
function spanGuard(
  doc: PDFDocument,
  op: ContentOp,
  resources: PDFDict | null,
  byKey: Map<RefKey, GroupEntry>,
  byObject: Map<PDFDict, GroupEntry>,
): SpanGuard {
  let found: SpanGuard = { kind: 'none' };
  op.operands.forEach((item, index) => {
    // PDF writes `/Tag properties BDC`: with two operands the leading name is
    // the tag, and only what follows it is the property list.
    if (index === 0 && item.kind === 'name' && op.operands.length > 1) return;
    const guard = operandGuard(doc, item, resources, byKey, byObject, 0);
    if (guard.kind === 'none') return;
    if (found.kind === 'none') found = guard;
    else {
      const same = found.kind === 'group' && guard.kind === 'group' && found.key === guard.key;
      found = same ? found : { kind: 'unresolved' };
    }
  });
  return found;
}

function operandGuard(
  doc: PDFDocument,
  item: ContentOperand,
  resources: PDFDict | null,
  byKey: Map<RefKey, GroupEntry>,
  byObject: Map<PDFDict, GroupEntry>,
  depth: number,
): SpanGuard {
  if (depth > 4) return { kind: 'unresolved' };
  if (item.kind === 'name') {
    const properties = resources ? resolveDict(doc, resources.get(PDFName.of('Properties'))) : null;
    const target = properties?.get(PDFName.of(item.value));
    // A name `/Properties` does not answer is a property list this reader cannot
    // resolve — not "not optional content", which would let the layer's
    // definition be deleted while its content stays behind.
    if (target === undefined) return properties ? { kind: 'none' } : { kind: 'unresolved' };
    return pdfGuard(doc, target, resources, byKey, byObject, depth + 1);
  }
  if (item.kind === 'ref') {
    return pdfGuard(doc, PDFRef.of(item.objectNumber, item.generation), resources, byKey, byObject, depth + 1);
  }
  if (item.kind === 'dict') {
    const type = dictEntry(item, 'Type');
    const name = type?.kind === 'name' ? type.value : '';
    if (name === 'OCMD' || dictEntry(item, 'OCGs') || dictEntry(item, 'VE')) {
      return { kind: 'condition', keys: membershipOperandKeys(dictEntry(item, 'OCGs')) };
    }
    const oc = dictEntry(item, 'OC');
    if (oc) return operandGuard(doc, oc, resources, byKey, byObject, depth + 1);
    // A group written out inside the stream has no reference to match `/OCGs` by.
    return name === 'OCG' ? { kind: 'unresolved' } : { kind: 'none' };
  }
  return { kind: 'none' };
}

function dictEntry(dict: DictOperand, key: string): ContentOperand | undefined {
  const found = dict.entries.find((entry) => entry.key.value === key);
  // A source that wrote `/Key` with no value before `>>` is not a property list.
  return found?.value ?? undefined;
}

/** The guard one PDF object (a `/Properties` target, a form's `/OC`) describes. */
function pdfGuard(
  doc: PDFDocument,
  value: PDFObject | undefined,
  resources: PDFDict | null,
  byKey: Map<RefKey, GroupEntry>,
  byObject: Map<PDFDict, GroupEntry>,
  depth: number,
): SpanGuard {
  if (value === undefined || depth > 4) return value === undefined ? { kind: 'none' } : { kind: 'unresolved' };
  if (value instanceof PDFName) {
    const properties = resources ? resolveDict(doc, resources.get(PDFName.of('Properties'))) : null;
    const named = properties?.get(value);
    if (named === undefined) return { kind: 'none' };
    return pdfGuard(doc, named, resources, byKey, byObject, depth + 1);
  }
  if (value instanceof PDFRef) {
    const dict = resolveDict(doc, value);
    if (!dict) return { kind: 'unresolved' };
    if (byKey.has(value.toString())) return { kind: 'group', key: value.toString() };
    if (isMembershipDict(doc, dict)) return { kind: 'condition', keys: membershipKeys(doc, dict) };
    if (isGroupDict(doc, dict)) return { kind: 'unresolved' };
    return pdfGuard(doc, dict.get(PDFName.of('OC')), resources, byKey, byObject, depth + 1);
  }
  if (value instanceof PDFDict) {
    if (isMembershipDict(doc, value)) return { kind: 'condition', keys: membershipKeys(doc, value) };
    const known = byObject.get(value);
    if (known) return { kind: 'group', key: known.key };
    if (isGroupDict(doc, value)) return { kind: 'unresolved' };
    return pdfGuard(doc, value.get(PDFName.of('OC')), resources, byKey, byObject, depth + 1);
  }
  return { kind: 'unresolved' };
}

/** An optional content group: `/Type /OCG`, or the shape of one without a type. */
function isGroupDict(doc: PDFDocument, dict: PDFDict): boolean {
  const type = String(deref(doc, dict.get(PDFName.of('Type'))));
  if (type === '/OCG') return true;
  if (type !== 'undefined') return false;
  return dict.get(PDFName.of('Name')) !== undefined && !isMembershipDict(doc, dict);
}

/** The groups an OCMD's rule names, so their definitions stay in place. */
function membershipKeys(doc: PDFDocument, dict: PDFDict): RefKey[] {
  const listed = deref(doc, dict.get(PDFName.of('OCGs')));
  const items = listed instanceof PDFArray ? listed.asArray() : listed !== undefined ? [listed] : [];
  const keys: RefKey[] = [];
  for (const item of items) if (item instanceof PDFRef) keys.push(item.toString());
  return keys;
}

/** The same, for an OCMD written inline inside a content stream. */
function membershipOperandKeys(entry: ContentOperand | undefined): RefKey[] {
  if (!entry) return [];
  const refs = entry.kind === 'ref' ? [entry] : entry.kind === 'array' ? entry.items.filter((item) => item.kind === 'ref') : [];
  return refs.map((item) => PDFRef.of((item as { objectNumber: number; generation: number }).objectNumber, (item as { objectNumber: number; generation: number }).generation).toString());
}

/** An OCMD: visibility as a rule over several groups. */
function isMembershipDict(doc: PDFDocument, dict: PDFDict): boolean {
  if (String(deref(doc, dict.get(PDFName.of('Type')))) === '/OCMD') return true;
  return dict.get(PDFName.of('OCGs')) !== undefined || dict.get(PDFName.of('VE')) !== undefined;
}

/** The form XObject a `Do` draws, or `null` when the call is not readable. */
function drawnForm(doc: PDFDocument, resources: PDFDict | null, op: ContentOp): RefKey | null {
  const only = op.operands.length === 1 ? op.operands[0] : null;
  const name = only && only.kind === 'name' ? only.value : null;
  if (!name || !resources) return null;
  const xobjects = resolveDict(doc, resources.get(PDFName.of('XObject')));
  const target = xobjects?.get(PDFName.of(name));
  return target instanceof PDFRef ? target.toString() : null;
}

/** Whether this scope's resources can name that object at all. */
function drawsXObject(doc: PDFDocument, resources: PDFDict, ref: PDFRef): boolean {
  const xobjects = resolveDict(doc, resources.get(PDFName.of('XObject')));
  if (!xobjects) return false;
  const needle = ref.toString();
  return xobjects.entries().some(([, value]) => value instanceof PDFRef && value.toString() === needle);
}

/** Forget the resource names that pointed at a deleted form. */
function purgeXObject(doc: PDFDocument, resources: PDFDict | null, ref: PDFRef): void {
  const xobjects = resources ? resolveDict(doc, resources.get(PDFName.of('XObject'))) : null;
  if (!xobjects) return;
  const needle = ref.toString();
  for (const [key, value] of [...xobjects.entries()]) {
    if (value instanceof PDFRef && value.toString() === needle) xobjects.delete(key);
  }
}

/**
 * Drop `/Properties` entries whose layer no longer has content to guard.
 *
 * The names are how `/OC /P0 BDC` reaches a group, so an entry left behind after
 * its marked content is gone is a dangling reference to a deleted object.
 */
function purgePropertyLists(doc: PDFDocument, scopes: ContentScope[], purgeable: Set<RefKey>): void {
  if (purgeable.size === 0) return;
  for (const scope of scopes) {
    const properties = scope.resources ? resolveDict(doc, scope.resources.get(PDFName.of('Properties'))) : null;
    if (!properties) continue;
    for (const [key, value] of [...properties.entries()]) {
      if (value instanceof PDFRef && purgeable.has(value.toString())) properties.delete(key);
    }
  }
}

/**
 * How many times each group is still named outside `/OCProperties`.
 *
 * Content stream *bytes* are not scanned — the caller knows what survived in the
 * streams it read — but every dictionary and array in the file is, which is what
 * catches an annotation, a page, a field or an OCMD still pointing at a layer
 * whose ink was deleted. The optional-content bookkeeping itself is excluded:
 * those are exactly the lists `removeRefsFrom` cleans up.
 */
function structuralReferences(doc: PDFDocument, properties: PDFDict, keys: Set<RefKey>): Map<RefKey, number> {
  const counts = new Map<RefKey, number>();
  if (keys.size === 0) return counts;
  const bookkeeping = new Set<PDFObject>();
  bookkeeping.add(properties);
  const defaultConfig = resolveDict(doc, properties.get(PDFName.of('D')));
  if (defaultConfig) bookkeeping.add(defaultConfig);
  const configs = deref(doc, properties.get(PDFName.of('Configs')));
  if (configs instanceof PDFArray) {
    for (const item of configs.asArray()) {
      const dict = resolveDict(doc, item);
      if (dict) bookkeeping.add(dict);
    }
  }
  const visited = new Set<RefKey>();
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    countRefs(doc, object instanceof PDFStream ? object.dict : object, keys, counts, visited, bookkeeping);
  }
  return counts;
}

function countRefs(
  doc: PDFDocument,
  value: unknown,
  keys: Set<RefKey>,
  counts: Map<RefKey, number>,
  visited: Set<RefKey>,
  bookkeeping: Set<PDFObject>,
): void {
  if (value instanceof PDFRef) {
    const key = value.toString();
    if (keys.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
    if (visited.has(key)) return;
    visited.add(key);
    countRefs(doc, doc.context.lookup(value), keys, counts, visited, bookkeeping);
    return;
  }
  if (bookkeeping.has(value as PDFObject)) return;
  if (value instanceof PDFArray) {
    for (const item of value.asArray()) countRefs(doc, item, keys, counts, visited, bookkeeping);
    return;
  }
  if (value instanceof PDFDict) {
    for (const [key, item] of value.entries()) {
      // `/Properties` holds the marked-content names `purgePropertyLists` prunes
      // once their content is gone, so it is not a reason to keep a group.
      if (key.toString() === '/Properties' && isResourceDict(value)) continue;
      countRefs(doc, item, keys, counts, visited, bookkeeping);
    }
  }
}

/** A dictionary that names the resources of a page or a form. */
function isResourceDict(dict: PDFDict): boolean {
  return (
    dict.get(PDFName.of('XObject')) !== undefined ||
    dict.get(PDFName.of('Font')) !== undefined ||
    dict.get(PDFName.of('ExtGState')) !== undefined ||
    dict.get(PDFName.of('ProcSet')) !== undefined
  );
}

/**
 * Remove one reference from every list inside `/OCProperties`.
 *
 * `/Order` nodes, `/RBGroups` and the named configurations all hold references
 * too; leaving the group in any of them is a dangling entry a validator reports.
 */
function removeRefsFrom(
  doc: PDFDocument,
  value: unknown,
  needle: RefKey,
  visited: Set<RefKey>,
  depth: number,
): void {
  if (depth > 8) return;
  if (value instanceof PDFArray) {
    const items = value.asArray();
    for (let index = items.length - 1; index >= 0; index--) {
      if (items[index] instanceof PDFRef && items[index].toString() === needle) removeAt(value, index);
    }
    for (const item of value.asArray()) removeRefsFrom(doc, item, needle, visited, depth + 1);
    return;
  }
  if (value instanceof PDFDict) {
    for (const [, item] of value.entries()) {
      if (item instanceof PDFRef) {
        const key = item.toString();
        if (visited.has(key)) continue;
        visited.add(key);
        removeRefsFrom(doc, doc.context.lookup(item), needle, visited, depth + 1);
      } else removeRefsFrom(doc, item, needle, visited, depth + 1);
    }
  }
}

/**
 * Write new bytes over an existing stream object, keeping its dictionary.
 *
 * A form's `/BBox`, `/Matrix` and `/Resources` describe how its content is
 * placed; rebuilding the object without them would move or blank the page.
 */
function replaceStreamContents(doc: PDFDocument, ref: PDFRef, bytes: Uint8Array): void {
  const current = doc.context.lookup(ref);
  if (!(current instanceof PDFStream)) return;
  const created = doc.context.flateStream(bytes);
  for (const [key, value] of current.dict.entries()) {
    const name = key.toString();
    // The old filters describe the old bytes; `/Length` is recomputed on save.
    if (name === '/Filter' || name === '/DecodeParms' || name === '/Length' || name === '/F') continue;
    created.dict.set(key, value);
  }
  doc.context.assign(ref, created);
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

function readNameArray(value: unknown): string[] {
  const text = String(value ?? '');
  return [...text.matchAll(/\/([A-Za-z0-9_]+)/g)].map((match) => match[1]);
}

function readFirstKey(dict: PDFDict): string | undefined {
  const keys = dict.entries();
  const first = keys[0];
  return first ? String(first[0]).replace(/^\//, '') : undefined;
}
