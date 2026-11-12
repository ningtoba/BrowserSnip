/**
 * `pdf-layers`: does the default view you asked for reach the file, per layer?
 *
 * Two findings, one of them about the UI.
 *
 * **The toggles have nothing to toggle.** Driven on the deployed site
 * (`docs/research/layers-deployed.log`, from `node docs/research/verify-layers-run.mjs`)
 * the rail renders both multiselects empty for a document that has two optional-content
 * groups: `{"label":"Hide these layers","options":[],"boxes":[]}`. `ToolField.options`
 * is a static list and nothing feeds these two from the opened document, so the card's
 * verb "toggle" is unreachable — a person can add and delete a group by name and cannot
 * switch one off at all. Making the lists live needs a document-driven options path in
 * the shared rail (`FieldControls`/`usePdfTool`), which is not this tool's file, so it is
 * written up rather than done here. The byte measurements below run the tool with the
 * values the rail *would* have sent, through the same runner.
 *
 * **The state itself survives.** `tests/fixtures/foreign/layers.pdf` is a real
 * MuPDF-authored pair of groups, `DrawnLayer` on and `HiddenLayer` off; the cases
 * below flip each one and read `/OCProperties` back out of the saved bytes, checking
 * that the entries are references to the groups in `/OCGs` (a viewer that cannot match
 * them shows everything) and that the sentence the tool prints names the layers the
 * file now holds. The last case writes `/tmp/eight/layers-tool.pdf` for
 * `python3 docs/research/verify-layers-read.py`, which renders before and after with
 * MuPDF and poppler and counts the ink that disappeared.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from '@maxwbh/pdf-lib';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { decodeTextString } from '@/lib/pdf/core/metadata';
import { listLayers, setLayerVisibility } from '@/lib/pdf/core/layers';

/** Two /OCGs referenced from page content, one on and one off, written by MuPDF. */
const FIXTURE = 'tests/fixtures/foreign/layers.pdf';

const source = () => new Uint8Array(readFileSync(FIXTURE));

/**
 * Hand a produced file to the outside readers (`verify-layers-read.py`).
 *
 * The path is part of the reproduce line in this file's header, so it is created on
 * demand rather than assumed: a CI runner has no `/tmp/eight`, and a test that only
 * passes on the machine that wrote it is not a pin.
 */
function emit(path: string, produced: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(produced));
}

async function run(values: Record<string, unknown>) {
  const outcome = (await runPdfTool({
    toolId: 'pdf-layers',
    files: [new File([source()], 'layers.pdf', { type: 'application/pdf' })],
    values,
    onProgress: () => {},
    onLog: () => {},
  })) as unknown as { outputs: { blob: Blob }[]; message?: string; warnings: string[] };
  expect(outcome.outputs.length, 'pdf-layers produced no file').toBeGreaterThan(0);
  return { bytes: new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()), message: outcome.message ?? '', warnings: outcome.warnings ?? [] };
}

/** `/OCProperties` as saved: group names, which are on, and whether they are refs. */
async function view(produced: Uint8Array) {
  const doc = await PDFDocument.load(produced);
  const props = doc.catalog.lookupMaybe(PDFName.of('OCProperties'), PDFDict);
  expect(props, 'the output has no /OCProperties at all').toBeTruthy();
  const entries = (props as PDFDict).lookup(PDFName.of('OCGs'), PDFArray).asArray();
  const ocgs = entries.map((entry) => ({
    ref: entry instanceof PDFRef ? entry.toString() : null,
    dict: doc.context.lookup(entry) as PDFDict,
  }));
  const nameOf = (dict: PDFDict) => decodeTextString(dict.get(PDFName.of('Name'))) ?? '';
  const def = (props as PDFDict).lookup(PDFName.of('D'), PDFDict) as PDFDict;
  const members = (key: string) => {
    const array = def.lookupMaybe(PDFName.of(key), PDFArray);
    if (!array) return [];
    return array.asArray().map((member) => {
      if (!(member instanceof PDFRef)) return `inline:${nameOf(doc.context.lookup(member) as PDFDict)}`;
      const hit = ocgs.find((entry) => entry.ref === member.toString());
      return hit ? nameOf(hit.dict) : `dangling:${member.toString()}`;
    });
  };
  return {
    names: ocgs.map((entry) => nameOf(entry.dict)),
    listedByReference: ocgs.every((entry) => entry.ref !== null),
    on: members('ON'),
    off: members('OFF'),
    order: members('Order'),
    baseState: decodeTextString(def.get(PDFName.of('BaseState'))) ?? '(absent)',
  };
}

describe('the layer view the tool edits is the one the file carries', () => {
  it('reads the groups a real export left behind, and which is off', async () => {
    const layers = listLayers(await PDFDocument.load(source()));
    expect(layers.map((layer) => [layer.name, layer.on]).sort())
      .toEqual([['DrawnLayer', true], ['HiddenLayer', false]]);
  });

  it('switches a visible layer off in the default view, by reference', async () => {
    const { bytes, message, warnings } = await run({ hide: ['DrawnLayer'], show: [], add: '', remove: '' });
    const state = await view(bytes);
    expect(state.names.sort()).toEqual(['DrawnLayer', 'HiddenLayer']);
    // The file arrived with `HiddenLayer` off and nothing was asked of it, so both
    // groups are off in the default view afterwards and none is listed twice.
    expect(state.off.sort()).toEqual(['DrawnLayer', 'HiddenLayer']);
    expect(state.on).toEqual([]);
    expect(state.order.sort()).toEqual(['DrawnLayer', 'HiddenLayer']);
    expect(state.listedByReference, '/OCProperties must name the groups by reference').toBe(true);
    expect(message).toMatch(/DrawnLayer/);
    expect(message + warnings.join(' ')).toMatch(/hidden|off|default view/i);
    emit('/tmp/eight/layers-tool-hide.pdf', bytes);
  });

  it('overrides what the file was saved with when asked to show a hidden group', async () => {
    const { bytes } = await run({ hide: [], show: ['HiddenLayer'], add: '', remove: '' });
    const state = await view(bytes);
    expect(state.on.sort()).toEqual(['DrawnLayer', 'HiddenLayer']);
    expect(state.off).toEqual([]);
  });

  it('keeps both halves of the flip apart when both are asked for', async () => {
    const { bytes, warnings } = await run({ hide: ['DrawnLayer'], show: ['HiddenLayer'], add: '', remove: '' });
    const state = await view(bytes);
    expect(state.off).toEqual(['DrawnLayer']);
    expect(state.on).toEqual(['HiddenLayer']);
    expect(warnings.join(' ') + state.baseState).toBeTruthy();
  });

  it('adds a group that a reader can resolve, and deletes one it can no longer find', async () => {
    const added = await run({ hide: [], show: [], add: 'Revision C', remove: '' });
    const afterAdd = await view(added.bytes);
    expect(afterAdd.names).toContain('Revision C');
    expect(afterAdd.listedByReference, 'a newly added group must be an indirect object').toBe(true);
    expect(added.message).toMatch(/Revision C/);

    const removed = await run({ hide: [], show: [], add: '', remove: 'HiddenLayer' });
    const afterRemove = await view(removed.bytes);
    expect(afterRemove.names).toEqual(['DrawnLayer']);
    // The sentence counts what went and names what the file still holds; a name it
    // no longer carries cannot be checked by a reader, so it must not be listed.
    expect(removed.message).toMatch(/deleted 1 layer/i);
    expect(removed.message).toMatch(/DrawnLayer/);
    expect(removed.message).not.toMatch(/has .*HiddenLayer/);
    emit('/tmp/eight/layers-tool.pdf', added.bytes);
  });

  it('says which named layer the document does not have', async () => {
    const outcome = await run({ hide: ['Not a layer'], show: [], add: '', remove: 'Neither' });
    const state = await view(outcome.bytes);
    // Nothing matched, so the file's own state is untouched: `HiddenLayer` off.
    expect(state.off).toEqual(['HiddenLayer']);
    expect(state.on).toEqual(['DrawnLayer']);
    const text = `${outcome.message} ${outcome.warnings.join(' ')}`;
    expect(text).toMatch(/Not a layer|Neither/);
    expect(text).toMatch(/no layer|not found|does not have|no such|nothing to/i);
  });

  it('toggling through the core API and through the tool agree', async () => {
    const doc = await PDFDocument.load(source());
    const before = listLayers(doc).map((layer) => [layer.name, layer.on]);
    expect(before.sort()).toEqual([['DrawnLayer', true], ['HiddenLayer', false]]);
    expect(setLayerVisibility(doc, 'DrawnLayer', false)).toBe(true);
    expect(setLayerVisibility(doc, 'HiddenLayer', true)).toBe(true);
    const direct = listLayers(doc).map((layer) => [layer.name, layer.on]).sort();
    expect(direct).toEqual([['DrawnLayer', false], ['HiddenLayer', true]]);

    // The same view, reached through the tool with the values the rail would send:
    // `on`/`off` here are lists of names, so a layer is "off" exactly when it is
    // listed in `/D /OFF` and not in `/D /ON`.
    const viaTool = await view((await run({ hide: ['DrawnLayer'], show: ['HiddenLayer'], add: '', remove: '' })).bytes);
    expect([
      ['DrawnLayer', !viaTool.off.includes('DrawnLayer')],
      ['HiddenLayer', viaTool.on.includes('HiddenLayer')],
    ].sort()).toEqual(direct);
    emit('/tmp/eight/layers-tool-toggle.pdf', await doc.save({ useObjectStreams: false }));
  });
});
