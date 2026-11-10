/**
 * The script a PDF runs by itself, and what it takes to remove it.
 *
 * JavaScript in a PDF is not a key on a list. It is an **action** — a dictionary
 * that says `/S /JavaScript` and keeps the code in `/JS` — and what runs it is the
 * *entry that points at the action*: `/OpenAction` in the catalogue (the document
 * opened), `/A` on an annotation or a form field (something clicked, a value
 * changed), `/AA` on any of those (the automatic-action map, one action per
 * trigger), the catalogue's own `/JavaScript`, and the `/JavaScript` name tree
 * (named scripts a form calls). The action may sit **inline inside** the
 * dictionary that points at it or behind a reference, and real files do both.
 *
 * The pass this replaces deleted `JS`, `JavaScript` and `AA` keys *on* the
 * dictionaries it enumerated. An inline `/OpenAction << /S /JavaScript /JS (…) >>`
 * has none of those keys on the catalogue — they are one level down — so the tool
 * counted no script, removed none, and printed "no script references were present"
 * about a file that runs code when it opens (`docs/TOOL-TRIAGE.md` CONTROL
 * INERT 3).
 *
 * One walk, {@link scriptEntries}, answers both halves: {@link inspectScript}
 * counts what it finds and {@link stripScript} removes exactly what it found, so
 * the number in the sentence and the work in the file cannot disagree. Two rules
 * keep that count honest:
 *
 * - **an entry is a reference, not a body.** One `/OpenAction` pointing at one
 *   action is one reference, whatever shape the pointer takes. The action
 *   dictionary it reaches is emptied by that entry and is not counted again when
 *   the walk arrives at it and finds a `/JS` key of its own — that double book-
 *   keeping is what produced "3 removed" beside "3 survived".
 * - **what cannot be reached is named, not counted as clean.** An XFA packet
 *   keeps its JavaScript inside its own XML, which nothing here parses, so
 *   {@link inspectScript} reports it and the card says the script stayed instead
 *   of implying it went.
 */
import type { PDFContext, PDFDocument, PDFObject } from '@maxwbh/pdf-lib';
import { PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef, PDFString } from '@maxwbh/pdf-lib';

/** One place that runs script, with the words the result card quotes for it. */
export interface ScriptEntry {
  /** Where it lives: `catalogue /OpenAction`, `page 2 /AA /O`, `form field “amount” /A`. */
  where: string;
  /** Take the entry out of the document. */
  remove: () => void;
}

/** What a document carries, in the shape the result card needs. */
export interface ScriptReport {
  /** Entries that run script. Zero means the switch had nothing to do. */
  present: number;
  /** Where they are, as {@link ScriptEntry.where}. */
  places: string[];
  /**
   * Script this module cannot reach, in one clause for the card, or `null`.
   */
  unreachable: string | null;
}

/** Keys whose value is an action, or an array of actions. */
const ACTION_KEYS = [PDFName.of('OpenAction'), PDFName.of('A')] as const;

/** The automatic-action map: one action (or array of them) per trigger name. */
const AUTO_ACTION_KEY = PDFName.of('AA');

/** Where the code itself lives inside an action dictionary. */
const SCRIPT_KEYS = [PDFName.of('JS'), PDFName.of('JavaScript')] as const;

/** The catalogue's own script list, and the name tree that holds named scripts. */
const NAMES_SCRIPT_KEY = PDFName.of('JavaScript');

/** The only key an emptied action can keep before it is dead weight. */
const ORPHAN_KEEPER = '/Type';

function bare(name: PDFName): string {
  return name.asString().slice(1);
}

/** The dictionary a value names, plus its object number when it has one. */
function asDict(context: PDFContext, value: PDFObject | undefined): { dict: PDFDict; ref: PDFRef | null } | null {
  if (value instanceof PDFRef) {
    const dict = context.lookupMaybe(value, PDFDict);
    return dict ? { dict, ref: value } : null;
  }
  return value instanceof PDFDict ? { dict: value, ref: null } : null;
}

/**
 * Is this dictionary a JavaScript action?
 *
 * `/S /JavaScript` is the answer the spec gives. A dictionary carrying `/JS` with
 * no `/S` at all is the answer some writers give, and a viewer runs it the same
 * way, so it counts too.
 */
function isJavaScriptAction(dict: PDFDict): boolean {
  const subtype = dict.get(PDFName.of('S'));
  if (subtype instanceof PDFName) return subtype.asString() === '/JavaScript';
  return subtype === undefined && dict.get(SCRIPT_KEYS[0]) !== undefined;
}

/**
 * The JavaScript actions behind one entry: a dictionary or a reference gives one,
 * an array gives as many as it holds, and a `/GoTo` or `/Launch` gives none.
 */
function jsActions(context: PDFContext, value: PDFObject | undefined): {
  dicts: PDFDict[];
  refs: PDFRef[];
} {
  const target = value instanceof PDFRef ? context.lookup(value) : value;
  const dicts: PDFDict[] = [];
  const refs: PDFRef[] = [];
  const take = (candidate: PDFObject | undefined) => {
    const found = asDict(context, candidate);
    if (!found || !isJavaScriptAction(found.dict)) return;
    dicts.push(found.dict);
    if (found.ref) refs.push(found.ref);
  };
  if (target instanceof PDFArray) {
    for (let index = 0; index < target.size(); index++) take(target.get(index));
  } else {
    // The original value, not the dereferenced one: that is what keeps the object
    // number of a referenced action available for the orphan sweep below.
    take(value);
  }
  return { dicts, refs };
}

/**
 * Empty the actions an entry reached, and delete an indirect action outright
 * once nothing is left in it but its own `/Type`.
 *
 * Dropping the code without dropping the pointer is the half-measure this module
 * exists to avoid: `/OpenAction << /Type /Action >>` still tells a viewer to run
 * something that is no longer there.
 */
function emptyActions(context: PDFContext, actions: { dicts: PDFDict[]; refs: PDFRef[] }): void {
  for (const dict of actions.dicts) {
    for (const key of SCRIPT_KEYS) dict.delete(key);
    if (dict.lookupMaybe(PDFName.of('S'), PDFName)?.asString() === '/JavaScript') dict.delete(PDFName.of('S'));
  }
  for (const ref of [...new Set(actions.refs)]) {
    const dict = context.lookupMaybe(ref, PDFDict);
    if (!dict) continue;
    if (dict.entries().every(([key]) => key.asString() === ORPHAN_KEEPER)) context.delete(ref);
  }
}

/**
 * Every dictionary whose keys can run script, each named once, best label first.
 *
 * Pages, annotations and fields are walked by name rather than trusted to the
 * indirect sweep: a field written inline in its parent's `/Kids` array runs its
 * calculations just as hard as one with an object number, and a page's `/AA`
 * counted twice — once as the page, once as an indirect dictionary — would
 * report two references for one trigger.
 */
function scriptHosts(doc: PDFDocument): { dict: PDFDict; where: string }[] {
  const context = doc.context;
  const hosts: { dict: PDFDict; where: string }[] = [];
  const seen = new Set<PDFDict>();
  const add = (dict: PDFDict, where: string) => {
    if (seen.has(dict)) return;
    seen.add(dict);
    hosts.push({ dict, where });
  };

  add(doc.catalog, 'catalogue');
  doc.getPages().forEach((page, index) => add(page.node, `page ${index + 1}`));

  const acroForm = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (acroForm) add(acroForm, 'the form');
  const fields = acroForm?.lookupMaybe(PDFName.of('Fields'), PDFArray);
  const walkField = (value: PDFObject | undefined, label: string): void => {
    const found = asDict(context, value);
    if (!found || seen.has(found.dict)) return;
    const name = found.dict.lookupMaybe(PDFName.of('T'), PDFString);
    const titled = name ? `${label} “${name.decodeText()}”` : label;
    add(found.dict, titled);
    const kids = found.dict.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) for (let index = 0; index < kids.size(); index++) walkField(kids.get(index), titled);
  };
  if (fields) for (let index = 0; index < fields.size(); index++) walkField(fields.get(index), 'form field');

  doc.getPages().forEach((page, index) => {
    const annots = page.node.Annots();
    if (!annots) return;
    for (let slot = 0; slot < annots.size(); slot++) {
      const annot = asDict(context, annots.get(slot));
      if (annot) add(annot.dict, `the annotation on page ${index + 1}`);
    }
  });

  for (const [, object] of context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict) add(object, 'a dictionary in the file');
    else if (object instanceof PDFRawStream) add(object.dict, 'a stream in the file');
  }
  return hosts;
}

/** The catalogue's `/Names » /JavaScript` subtree, when the file has one. */
function namedScriptTree(doc: PDFDocument): { names: PDFDict; tree: PDFDict } | null {
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const tree = names?.lookupMaybe(NAMES_SCRIPT_KEY, PDFDict);
  return names && tree ? { names, tree } : null;
}

/**
 * Every entry in the document that runs JavaScript.
 *
 * An entry is counted where the script is *run from*, and the action dictionary it
 * reaches is recorded in `reached` so the leftovers pass cannot double-count it as
 * a second reference for having a `/JS` key of its own.
 */
function scriptEntries(doc: PDFDocument): ScriptEntry[] {
  const context = doc.context;
  const found: ScriptEntry[] = [];
  const reached = new Set<PDFDict>();
  const hosts = scriptHosts(doc);
  /** `${host index}#${key}` for every entry already counted on a dictionary. */
  const index = new Map<PDFDict, number>(hosts.map((host, at) => [host.dict, at]));
  const covered = new Set<string>();
  const take = (host: PDFDict, key: PDFName, entry: ScriptEntry) => {
    covered.add(`${index.get(host)}#${bare(key)}`);
    found.push(entry);
  };

  for (const { dict: host, where } of hosts) {
    for (const key of ACTION_KEYS) {
      const value = host.get(key);
      if (value === undefined) continue;
      const actions = jsActions(context, value);
      if (actions.dicts.length === 0) continue;
      for (const dict of actions.dicts) reached.add(dict);
      take(host, key, {
        where: `${where} /${bare(key)}`,
        remove: () => {
          host.delete(key);
          emptyActions(context, actions);
        },
      });
    }

    const map = asDict(context, host.get(AUTO_ACTION_KEY));
    if (!map) continue;
    for (const [trigger, value] of map.dict.entries()) {
      const actions = jsActions(context, value);
      if (actions.dicts.length === 0) continue;
      for (const dict of actions.dicts) reached.add(dict);
      take(host, AUTO_ACTION_KEY, {
        where: `${where} /AA /${bare(trigger)}`,
        remove: () => {
          map.dict.delete(trigger);
          // An `/AA` with no triggers left is dead weight where it hangs.
          if (map.dict.entries().length === 0) host.delete(AUTO_ACTION_KEY);
          emptyActions(context, actions);
        },
      });
    }
  }

  // The catalogue's own `/JavaScript` — one script, or a list of them — runs at
  // open time exactly like an `/OpenAction`, so it is its own reference.
  const catalogList = doc.catalog.get(NAMES_SCRIPT_KEY);
  if (catalogList !== undefined) {
    const actions = jsActions(context, catalogList);
    for (const dict of actions.dicts) reached.add(dict);
    take(doc.catalog, NAMES_SCRIPT_KEY, {
      where: 'catalogue /JavaScript',
      remove: () => {
        doc.catalog.delete(NAMES_SCRIPT_KEY);
        emptyActions(context, actions);
      },
    });
  }

  // Named scripts, which a form calls out of the name tree. The subtree is the
  // entry; every action it points at is emptied with it.
  const tree = namedScriptTree(doc);
  if (tree) {
    const pairs = tree.tree.lookupMaybe(PDFName.of('Names'), PDFArray);
    const dicts = new Set<PDFDict>();
    const refs: PDFRef[] = [];
    for (let index = 1; pairs && index < pairs.size(); index += 2) {
      const action = asDict(context, pairs.get(index));
      if (!action || !isJavaScriptAction(action.dict)) continue;
      dicts.add(action.dict);
      if (action.ref) refs.push(action.ref);
    }
    for (const dict of dicts) reached.add(dict);
    if (dicts.size > 0) {
      found.push({
        where: 'the JavaScript name tree',
        remove: () => {
          tree.names.delete(NAMES_SCRIPT_KEY);
          emptyActions(context, { dicts: [...dicts], refs });
        },
      });
    }
  }

  // Leftovers: a `/JS` or `/JavaScript` key on a dictionary no entry above
  // reaches — a hand-written action, or script the file points at with a key no
  // viewer honours. Counting them keeps the total from under-reporting the file,
  // and the same walk that counts them removes them.
  for (const { dict: host, where } of hosts) {
    if (reached.has(host)) continue;
    for (const key of SCRIPT_KEYS) {
      if (host.get(key) === undefined) continue;
      if (covered.has(`${index.get(host)}#${bare(key)}`)) continue;
      take(host, key, {
        where: `${where} /${bare(key)}`,
        remove: () => {
          host.delete(key);
          emptyActions(context, { dicts: [host], refs: [] });
        },
      });
    }
  }
  return found;
}

/** What the file carries: how many entries run script, where, and what stays out of reach. */
export function inspectScript(doc: PDFDocument): ScriptReport {
  const entries = scriptEntries(doc);
  const acroForm = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  return {
    present: entries.length,
    places: entries.map((entry) => entry.where),
    unreachable: acroForm?.get(PDFName.of('XFA')) === undefined
      ? null
      : 'the script inside its XFA form packet, which lives in that packet’s own XML',
  };
}

/**
 * Take every script action out of the document.
 *
 * Returns the places it went, so the caller can report the references the file
 * actually lost rather than the intention to remove something.
 */
export function stripScript(doc: PDFDocument): { removed: number; where: string[] } {
  const entries = scriptEntries(doc);
  for (const entry of entries) entry.remove();
  return { removed: entries.length, where: entries.map((entry) => entry.where) };
}
