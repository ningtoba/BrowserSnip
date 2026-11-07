/**
 * Shape drift across the generated tools (worker PARITY).
 *
 * The tool page was reshaped into a task flow — intake, then cards with a
 * collapsed options bar and one pinned verb, then the result screen. That shape
 * is shared by ~110 schema-driven tools, so a defect in it is never local: one
 * tool with a promise that only restates its title, or a giant button reading
 * "Convert", makes the whole catalogue look unfinished next to a site that names
 * every action. These rules are asserted across the registry as data, because
 * that is the only way the drift is visible at all — clicking 124 pages by hand
 * is not a check anybody will repeat.
 *
 * The four drifts the brief names, and what each one costs a first visit:
 *   1. a promise line that is missing or repeats the header → the intake says
 *      nothing about what the button produces;
 *   2. zero fields and nothing else to read → the page is a title and a button,
 *      so the notes and the search words have to carry the rest;
 *   3. more fields than the collapsing bar can show → the summary truncates and
 *      the control that decides the output is off-screen;
 *   4. a CTA verb that is missing or generic → "Convert" on fourteen different
 *      buttons teaches nobody what any of them does.
 *
 * Copy rules already pinned by `ux-definitions.test.ts` (sentence case, one
 * spelling per concept, numeric bounds) are not repeated here; this file only
 * covers the shape of the new page.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDF_TOOLS, hasCustomMainView, searchTools } from '@/lib/pdf/tools/registry';
import { describeOptions, promiseFor, quietSummary, verbFor } from '@/components/tools/pdf/shared/toolForm';
import { defaultValues, type PdfToolDefinition, type ToolField, type ToolValues } from '@/lib/pdf/tools/types';

/** Words that name a button but not an action. "Run" told the user nothing. */
const GENERIC_VERBS = new Set([
  'run', 'process', 'apply', 'go', 'ok', 'submit', 'start', 'execute',
  'convert', 'create', 'export', 'save', 'generate',
]);

/** Field types whose value changes what the output *is*, rather than how it looks. */
const DECIDING_TYPES = new Set([
  'select', 'segmented', 'number', 'slider', 'pages', 'text', 'textarea',
  'password', 'file', 'dimensions', 'signature-style',
]);

/**
 * The ids `ToolWorkspace` routes to a hand-written panel, read out of its source.
 *
 * Not copied by hand: that file is being edited in parallel, and a list kept in
 * two places is a list that quietly goes stale. If the map is renamed the parse
 * throws, which is the loud version of the same fact.
 */
function panelIdsFromSource(): string[] {
  const source = readFileSync(resolve(process.cwd(), 'src/components/layout/ToolWorkspace.tsx'), 'utf8');
  const start = source.indexOf('const PDF_PANELS');
  const block = source.slice(start, source.indexOf('function lazyPanel'));
  if (!block.includes('lazyPanel(')) throw new Error('ToolWorkspace no longer has a PDF_PANELS map to audit');
  return [...block.matchAll(/^\s{2}'?([a-z0-9]+(?:-[a-z0-9]+)*)'?:\s*lazyPanel/gm)].map((match) => match[1]);
}

const PANEL_IDS = panelIdsFromSource();

/** True when the page hands this tool to a bespoke panel or editor. */
function isBespoke(tool: PdfToolDefinition): boolean {
  return Boolean(tool.mainComponent) || hasCustomMainView(tool.id) || PANEL_IDS.includes(tool.id);
}

/**
 * The controls the bar shows before the user touches anything.
 *
 * `when` hides a field until another one is set, so a panel that declares fifteen
 * options may only ever show five. Counting declared fields would fine the wrong
 * tool.
 */
function visibleFields(tool: PdfToolDefinition) {
  const values = defaultValues(tool.fields);
  return (tool.fields ?? []).filter((field) => !field.when || field.when(values));
}

const generated = PDF_TOOLS.filter((tool) => !isBespoke(tool));

/**
 * Can this control ever be handed to the runner empty?
 *
 * Mirrors the two functions that decide it: `defaultValues` seeds every field
 * with `field.default ?? null`, and `core/guard`'s `isEmpty` calls `null`, a
 * blank string and `[]` empty. So a control that carries a real default — a mode
 * picker, a toggle, a numeric bound — cannot hold a run up, and is not a
 * question a gate could be hiding behind.
 */
function canBeLeftEmpty(field: ToolField): boolean {
  const value = field.default ?? null;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return value === null;
}

/** Whether this field demands a value in `state`, restating `guard.demandsValue`. */
function demandsValue(field: ToolField, state: ToolValues): boolean {
  if (field.optional === true || field.required === false) return false;
  if (typeof field.required === 'function') {
    try {
      return field.required(state) === true;
    } catch {
      // A predicate that throws on a half-filled panel demands nothing, which is
      // what `guard` decided so an unknown state cannot block a run.
      return false;
    }
  }
  return field.required === true;
}

/**
 * The panel states worth probing for a buried gate.
 *
 * The state the rail opens with, plus that state with each option-bearing
 * control moved to each of its options — one control at a time, because that is
 * how a `when` or `required` predicate is written against a mode picker. The
 * cartesian product of a twelve-field panel is not worth enumerating, and a
 * disagreement that only shows when two controls move together is out of scope
 * here; it is reachable by widening this loop, not by changing the rule.
 */
function probeStates(tool: PdfToolDefinition): ToolValues[] {
  const base = defaultValues(tool.fields);
  const states: ToolValues[] = [base];
  for (const field of tool.fields ?? []) {
    for (const option of field.options ?? []) states.push({ ...base, [field.key]: option.value });
  }
  return states;
}

/** Every way these tools bury a required control, as sentences. */
function buriedGates(tools: PdfToolDefinition[]): string[] {
  const problems: string[] = [];
  for (const tool of tools) {
    const states = probeStates(tool);
    let leftOpen = false;
    for (const field of tool.fields ?? []) {
      const gates = field.required === true || typeof field.required === 'function';
      if (!gates) {
        if (canBeLeftEmpty(field)) leftOpen = true;
      } else if (leftOpen) {
        problems.push(`${tool.id}: "${field.key}" is required but declared after controls that can be left empty`);
      }
      // One clause for both shapes of the defect: hidden in a state where an
      // empty value still blocks. `required: true` beside a `when` always trips
      // it — required in every state, absent from the panel in some. A predicate
      // that restates the `when` never does, which is the mode-dependent case
      // that is coherent: the control stops being a requirement in the same
      // breath it disappears.
      const buried = field.when
        ? states.some((state) => {
            try {
              return !field.when!(state) && demandsValue(field, state);
            } catch {
              return false;
            }
          })
        : false;
      if (buried) problems.push(`${tool.id}: "${field.key}" can be hidden by when() while it still blocks the run`);
    }
  }
  return problems;
}

describe('the intake promise', () => {
  it('is written on the definition, never inherited from a category fallback', () => {
    // `promiseFor` has a per-category sentence behind it. A tool that leans on
    // that shares its intake line with every sibling, which is the drift this
    // file exists to catch, so the definition must carry its own.
    const inherited = PDF_TOOLS.filter((tool) => !tool.promise?.trim()).map((tool) => tool.id);
    expect(inherited).toEqual([]);
  });

  it('says something different for every tool', () => {
    const seen = new Map<string, string[]>();
    for (const tool of PDF_TOOLS) {
      const key = (tool.promise ?? '').trim().toLowerCase();
      seen.set(key, [...(seen.get(key) ?? []), tool.id]);
    }
    const shared = [...seen]
      .filter((entry) => (entry[1] as string[]).length > 1)
      .map(([text, ids]) => `${(ids as string[]).join(', ')}: ${text}`);
    expect(shared).toEqual([]);
  });

  it('does not repeat the header it sits under', () => {
    const fold = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
    const echo: string[] = [];
    for (const tool of PDF_TOOLS) {
      const promise = (tool.promise ?? '').trim();
      const stem = tool.name.replace(/\s*pdf\s*$/i, '');
      if (fold(promise) === fold(tool.name)) echo.push(`${tool.id}: "${promise}" repeats the title`);
      if (stem.length > 2 && fold(promise).startsWith(fold(stem))) echo.push(`${tool.id}: "${promise}" opens with the title`);
      if (fold(promise) === fold(tool.description)) echo.push(`${tool.id}: "${promise}" repeats the description`);
    }
    expect(echo).toEqual([]);
  });

  it('fits the single line under the title', () => {
    const tooLong = PDF_TOOLS.map((tool) => ({ id: tool.id, length: (tool.promise ?? '').trim().length }))
      .filter((row) => row.length > 150)
      .map((row) => `${row.id} is ${row.length} characters`);
    expect(tooLong).toEqual([]);
  });

  it('is a sentence that states an outcome', () => {
    const thin = PDF_TOOLS.filter((tool) => {
      const promise = (tool.promise ?? '').trim();
      return promise.split(/\s+/).length < 8 || !/[.!?]$/.test(promise);
    }).map((tool) => tool.id);
    expect(thin).toEqual([]);
  });

  it('is the exact line the page prints', () => {
    // The intake renders `promiseFor(tool)`. A helper that rewrote or trimmed the
    // definition would make every rule above pass on paper and drift on screen.
    const off = PDF_TOOLS.filter((tool) => promiseFor(tool) !== (tool.promise ?? '').trim()).map((tool) => tool.id);
    expect(off).toEqual([]);
  });
});

describe('a page with no options still has to say something', () => {
  it('gives every tool words to be found by', () => {
    // The palette and the dashboard search are the only navigation now that the
    // sidebar is gone, and both match on `keywords`: two of them and a tool is
    // only reachable by someone who already knows its name.
    const thin = PDF_TOOLS.filter((tool) => (tool.keywords ?? []).length < 3)
      .map((tool) => `${tool.id} (${tool.keywords?.length ?? 0} keywords)`);
    expect(thin).toEqual([]);
  });

  it('leaves a note for the bar when there are no fields to open', () => {
    // With no fields the options disclosure disappears, so the notes panel is the
    // only thing the loaded page can say beyond the promise.
    const silent = generated
      .filter((tool) => (tool.fields ?? []).length === 0 && !tool.unavailable)
      .filter((tool) => (tool.notes ?? []).length === 0)
      .map((tool) => tool.id);
    expect(silent).toEqual([]);
  });

  it('explains a tool it cannot run instead of offering a dead button', () => {
    const mute = generated.filter((tool) => !tool.run && !tool.unavailable).map((tool) => tool.id);
    expect(mute).toEqual([]);
  });

  it('does not ask for a file a tool cannot read', () => {
    // The intake button names the format, so `accept` is the sentence's subject:
    // a mismatch is the page lying about what to drop.
    const off: string[] = [];
    for (const tool of generated) {
      const accept = (tool.accept ?? '').toLowerCase();
      const takesPdf = accept === '' || accept.includes('pdf');
      if (tool.inputKind === 'image' && !/image|\.jpg|\.png/.test(accept)) off.push(`${tool.id}: image input with accept "${tool.accept}"`);
      if (tool.inputKind === 'pdf' && !takesPdf) off.push(`${tool.id}: pdf input with accept "${tool.accept}"`);
    }
    expect(off).toEqual([]);
  });
});

describe('the collapsing options bar', () => {
  it('keeps any one column short enough to read', () => {
    const deep: string[] = [];
    for (const tool of generated) {
      const byGroup = new Map<string, number>();
      for (const field of visibleFields(tool)) {
        const key = field.group ?? 'general';
        byGroup.set(key, (byGroup.get(key) ?? 0) + 1);
      }
      for (const entry of byGroup) {
        if (entry[1] > 6) deep.push(`${tool.id}: "${entry[0]}" shows ${entry[1]} controls`);
      }
    }
    expect(deep).toEqual([]);
  });

  it('splits a long option list over more than two columns', () => {
    const flat = generated
      .filter((tool) => visibleFields(tool).length > 10)
      .filter((tool) => new Set(visibleFields(tool).map((field) => field.group ?? 'general')).size < 3)
      .map((tool) => `${tool.id} (${visibleFields(tool).length} visible fields)`);
    expect(flat).toEqual([]);
  });

  it('leads with the control that decides the output', () => {
    // The collapsed summary joins `label: value` in declaration order and is cut
    // off by `truncate`, and the panel opens on the first group. A tool that
    // declares its colour first therefore buries its real question at the end of
    // a line nobody can read in full.
    const buried: string[] = [];
    for (const tool of generated) {
      const fields = visibleFields(tool);
      if (fields.length <= 6) continue;
      const first = fields[0];
      const cosmetic = first.type === 'color' || (first.type === 'toggle' && first.default === false);
      if (cosmetic || !DECIDING_TYPES.has(first.type)) {
        buried.push(`${tool.id}: leads with ${first.type} "${first.label}" (${fields.length} visible fields)`);
      }
    }
    expect(buried).toEqual([]);
  });

  it('buries no gate: a required control is not hidden while it blocks, and not behind an open question', () => {
    expect(buriedGates(generated)).toEqual([]);
  });

  it('the buried-gate rule is armed: it passes a predicate that agrees with `when` and fails one that does not', () => {
    // A rule that stops matching anything looks exactly like a clean catalogue,
    // so it is checked against the shapes it exists to catch.
    const tool = (fields: ToolField[]): PdfToolDefinition =>
      ({ id: 'probe', fields } as unknown as PdfToolDefinition);
    const mode: ToolField = {
      key: 'mode', label: 'Mode', type: 'segmented', default: 'both',
      options: [{ value: 'user', label: 'User' }, { value: 'owner', label: 'Owner' }],
    };
    const hiddenInOwner = (v: ToolValues) => v.mode !== 'owner';

    // Statically required, conditionally hidden: the gate with nothing behind it.
    expect(buriedGates([tool([mode, { key: 'word', label: 'Word', type: 'password', when: hiddenInOwner, required: true }])]))
      .toEqual(['probe: "word" can be hidden by when() while it still blocks the run']);
    // The same rule declared as a predicate that restates the visibility.
    expect(buriedGates([tool([mode, { key: 'word', label: 'Word', type: 'password', when: hiddenInOwner, required: hiddenInOwner }])]))
      .toEqual([]);
    // And a predicate that demands the value in exactly the state that hides it.
    expect(buriedGates([tool([mode, { key: 'word', label: 'Word', type: 'password', when: hiddenInOwner, required: (v: ToolValues) => v.mode === 'owner' }])]))
      .toEqual(['probe: "word" can be hidden by when() while it still blocks the run']);
    // Ordering: a gate after a blank-able control is buried, after a defaulted
    // one it is not — the mode picker above cannot hold a run up by itself.
    expect(buriedGates([tool([mode, { key: 'word', label: 'Word', type: 'password', required: true }])])).toEqual([]);
    expect(buriedGates([tool([{ ...mode, default: undefined }, { key: 'word', label: 'Word', type: 'password', required: true }])]))
      .toEqual(['probe: "word" is required but declared after controls that can be left empty']);
  });

  /**
   * Tools whose collapsed summary is longer than the bar can show.
   *
   * `describeOptions` used to print every field, changed or not, so a 12-control
   * panel summarised to 250 characters and the `truncate` class cut it mid-word —
   * with the control that decides the output on the wrong side of the cut. The
   * bar now echoes only what the user moved, caps at three entries and counts the
   * rest, so this list is empty and the assertion below runs at full strength:
   * a tool that puts an id in here has re-opened the defect, not inherited it.
   */
  const LONG_SUMMARIES: string[] = [];

  it('collapses to a summary the bar can actually show', () => {
    const loud = generated
      .map((tool) => ({ id: tool.id, length: describeOptions(tool.fields ?? [], defaultValues(tool.fields)).length }))
      .filter((row) => row.length > 170 && !LONG_SUMMARIES.includes(row.id))
      .map((row) => `${row.id} summarizes to ${row.length} characters`);
    expect(loud).toEqual([]);
  });

  it('stays inside the bar whatever the user sets', () => {
    // The other half of the ratchet. The line is capped by how much it echoes,
    // not by how short the defaults happen to be, so the worst case is a panel
    // with every visible field moved — and that still has to fit.
    const loud: string[] = [];
    for (const tool of generated) {
      const fields = visibleFields(tool);
      if (fields.length === 0) continue;
      const values = Object.fromEntries(fields.map((field) => [field.key, 'a moved value']));
      const summary = describeOptions(fields, values, { whenQuiet: quietSummary(tool) });
      const segments = summary.split(' · ');
      if (segments.length > 4) loud.push(`${tool.id}: ${segments.length} things on one line`);
      if (summary.length > 170) loud.push(`${tool.id} summarizes to ${summary.length} characters`);
    }
    expect(loud).toEqual([]);
  });

  it('says what the run will do instead of reciting the defaults', () => {
    // Nothing moved is the state every page opens in, and the one the collapsed
    // bar used to fill with values nobody chose. It must not name a single
    // field's label there — the quiet line is about the outcome.
    const reciting: string[] = [];
    for (const tool of generated) {
      const fields = visibleFields(tool);
      if (fields.length < 2) continue;
      const values = defaultValues(tool.fields);
      const summary = describeOptions(fields, values, { whenQuiet: quietSummary(tool) });
      const named = fields.filter((field) => field.type !== 'password' && summary.includes(field.label));
      if (named.length === fields.length) reciting.push(`${tool.id}: "${summary}" recites all ${named.length}`);
    }
    expect(reciting).toEqual([]);
  });
});

describe('the pinned verb', () => {
  it('is declared by the tool, not guessed by the shell', () => {
    // `verbFor` keeps a table of patterns and a table of ids as a fallback. Both
    // belong to the shell; a definition that relies on them can be relabelled by
    // a regex edit three files away.
    const guessed = PDF_TOOLS.filter((tool) => verbFor(tool) !== (tool.actionLabel ?? '').trim()).map((tool) => tool.id);
    expect(guessed).toEqual([]);
  });

  it('never reads as a generic action', () => {
    const generic = PDF_TOOLS.filter((tool) => GENERIC_VERBS.has(verbFor(tool).trim().toLowerCase()))
      .map((tool) => `${tool.id}: "${verbFor(tool)}"`);
    expect(generic).toEqual([]);
  });

  it('is short enough for a button', () => {
    const long = PDF_TOOLS.filter((tool) => verbFor(tool).trim().split(/\s+/).length > 4)
      .map((tool) => `${tool.id}: "${verbFor(tool)}"`);
    expect(long).toEqual([]);
  });

  it('names what it produces when a shelf of tools share it', () => {
    // "Convert" on fourteen buttons tells you nothing about which of the fourteen
    // you are on; "Convert to PDF" does. A verb may be shared by siblings, but only
    // if it still states the output.
    const seen = new Map<string, string[]>();
    for (const tool of PDF_TOOLS) {
      const verb = verbFor(tool);
      seen.set(verb, [...(seen.get(verb) ?? []), tool.id]);
    }
    const crowded = [...seen]
      .filter((entry) => (entry[1] as string[]).length > 3 && !/pdf/i.test(entry[0]))
      .map(([verb, ids]) => `"${verb}" on ${(ids as string[]).length} tools: ${(ids as string[]).join(', ')}`);
    expect(crowded).toEqual([]);
  });
});

describe('discovery by job words', () => {
  /** What a visitor types, and the tool they mean. */
  const JOBS: [string, string][] = [
    ['merge pdf', 'merge'],
    ['combine pdf', 'merge'],
    ['split', 'split'],
    ['compress', 'pdf-compress'],
    ['rotate', 'rotate'],
    ['delete pages', 'remove-pages'],
    ['reorder pages', 'organize'],
    ['sign', 'sign'],
    ['password', 'protect'],
    ['remove password', 'unlock'],
    ['redact', 'redact'],
    ['watermark', 'watermark'],
    ['page numbers', 'page-numbers'],
    ['word to pdf', 'word-to-pdf'],
    ['pdf to word', 'pdf-to-word'],
    ['pdf to jpg', 'pdf-to-jpg'],
    ['image to pdf', 'image-to-pdf'],
    ['ocr', 'ocr-pdf'],
    ['extract images', 'extract-images'],
    ['repair', 'repair'],
    ['flatten', 'flatten-pdf'],
    ['metadata', 'edit-metadata'],
    ['bookmarks', 'bookmarks'],
    ['compare', 'compare'],
    ['csv', 'csv-to-pdf'],
  ];

  it.each(JOBS)('finds "%s"', (query: string, expected: string) => {
    expect(searchTools(query).map((tool: PdfToolDefinition) => tool.id)).toContain(expected);
  });

  it('answers something for every job word in the table', () => {
    const dead = JOBS.filter(([query]: [string, string]) => searchTools(query).length === 0).map(([query]: [string, string]) => query);
    expect(dead).toEqual([]);
  });
});
