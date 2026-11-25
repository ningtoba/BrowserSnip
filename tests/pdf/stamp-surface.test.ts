/**
 * `add-stamps`: the two surfaces are the same tool, so they offer the same stamps and
 * write the same dictionary.
 *
 * The tool has a bespoke pane (`/tool/add-stamps` picks the stamp in the inspector and
 * clicks a placement per page) *and* a rail field list. Until this round the pane mapped
 * `BUILT_IN_STAMPS` (12 Table 265 names) while the rail carried its own hand-copied list
 * of nine spaced-uppercase spellings plus two names that are not in Table 265 at all —
 * so the lists disagreed in **both** directions: `Experimental`, `Expired`, `Final`,
 * `NotForPublicRelease` and `Void` could not be reached from the rail, while `EXPRESS`
 * and `PRELIMINARY RESULTS` were offered there under a help line promising that "other
 * readers recognise it", which is false for a name the spec does not carry.
 *
 * The second half is what a reader can *find*. The rail route wrote
 * `contents: stampLabel(name)`, so a reader searching for the words "Not approved" hit
 * the mark; the surface route wrote no `/Contents` at all (measured on the exported
 * dictionary: `Contents=None` from the pane, `Contents="Not approved"` from the rail for
 * the same stamp), so the identical mark was invisible to search and to a tooltip on one
 * path and not the other. Both are asserted here on produced bytes, and the drawn words
 * of the appearance stream are required to equal `/Contents` — what you see is what a
 * reader finds.
 */
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, decodePDFRawStream } from '@maxwbh/pdf-lib';
import { addAnnotation, stampLabel, stampNameOf } from '@/lib/pdf/core/annotations';
import { annotationToSpec, buildAnnotation } from '@/components/tools/pdf/editor/specs';
import { BUILT_IN_STAMPS, LEGACY_STAMP_SPELLINGS, defaultStyleFor } from '@/components/tools/pdf/editor/tools';
import { editTools } from '@/lib/pdf/tools/edit';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import type { ToolValues } from '@/lib/pdf/tools/types';

const pdfFile = (bytes: Uint8Array, name: string) =>
  new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });

async function blankSheet(width = 420, height = 595): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([width, height]);
  page.drawText('PAGE 1 BODY', { x: 30, y: 300, size: 12 });
  return doc.save({ useObjectStreams: false });
}

/** The rail's own field definition, as the shipped card declares it. */
function railStampField() {
  const tool = editTools.find((candidate) => candidate.id === 'add-stamps');
  expect(tool, 'add-stamps is not in the registry').toBeTruthy();
  const field = tool!.fields.find((candidate) => candidate.key === 'stamp');
  expect(field, 'the card offers no Stamp field').toBeTruthy();
  return field!;
}

async function railExport(stamp: string): Promise<PDFDocument> {
  const outcome = (await runPdfTool({
    toolId: 'add-stamps',
    files: [pdfFile(await blankSheet(), 'sheet.pdf')],
    values: { stamp, position: 'top-right', width: 140, opacity: 1, regions: '', pages: '1' } as ToolValues,
    onProgress: () => {},
    onLog: () => {},
  })) as unknown as { outputs: { blob: Blob }[] };
  expect(outcome.outputs.length).toBeGreaterThan(0);
  return PDFDocument.load(new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()));
}

/** The surface route: a click-drag on the pane, converted and written exactly as export does. */
async function surfaceExport(stampName: string): Promise<PDFDocument> {
  const placed = buildAnnotation({
    tool: 'stamp',
    page: 0,
    style: { ...defaultStyleFor('stamp'), stampName },
    geom: { zoom: 1, cssWidth: 420, cssHeight: 595, rotation: 0 },
    drag: { x: 70, y: 70, width: 140, height: 44 },
  });
  expect(placed, 'the surface built no stamp for ' + stampName).toBeTruthy();
  const spec = annotationToSpec(placed!);
  const doc = await PDFDocument.load(await blankSheet());
  addAnnotation(doc, spec);
  return PDFDocument.load(await doc.save({ useObjectStreams: false }));
}

function annotDict(doc: PDFDocument): PDFDict {
  const annots = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
  expect(annots, 'the page carries no /Annots').toBeTruthy();
  return doc.context.lookup(annots!.asArray()[0]) as PDFDict;
}

function appearanceWords(doc: PDFDocument): string {
  const dict = annotDict(doc);
  const stream = doc.context.lookup(
    dict.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N')),
  ) as unknown as { getContentsString?: () => string };
  const decoded = new TextDecoder().decode(decodePDFRawStream(stream as never).decode());
  const literal = decoded.match(/\((.*?)\)\s*Tj/);
  const hex = decoded.match(/<([0-9A-Fa-f]+)>\s*Tj/);
  expect(literal || hex, `no text drawn in the appearance: ${decoded.slice(0, 160)}`).toBeTruthy();
  return literal ? literal[1] : (hex?.[1] ?? '').replace(/../g, (pair) => String.fromCharCode(parseInt(pair, 16)));
}

const textOf = (doc: PDFDocument, key: string): string | undefined => {
  const value = annotDict(doc).get(PDFName.of(key));
  if (!value) return undefined;
  const raw = (value as unknown as { decodeText?: () => string; toString?: () => string });
  if (key === 'S') return String(value).replace(/^\//, '');
  return typeof raw.decodeText === 'function' ? raw.decodeText() : String(value);
};

describe('the two surfaces offer one stamp list', () => {
  it('the rail offers exactly what the pane offers, plus the custom image', () => {
    const options = railStampField().options ?? [];
    const railStamps = options.filter(
      (option) => option.value !== 'custom' && !/saved spelling/.test(option.label),
    );
    // Pane → rail, in order and in wording.
    expect(railStamps.map((option) => [option.value, option.label]))
      .toEqual(BUILT_IN_STAMPS.map((stamp) => [stamp.value, stamp.label]));
    // Rail → pane: nothing is offered there that the pane cannot place.
    expect(new Set(railStamps.map((option) => option.value)))
      .toEqual(new Set(BUILT_IN_STAMPS.map((stamp) => stamp.value)));
    expect(options.some((option) => option.value === 'custom')).toBe(true);
  });

  it('the default is a name from the list, so the select cannot open on a value it lacks', () => {
    const field = railStampField();
    expect(BUILT_IN_STAMPS.map((stamp) => stamp.value)).toContain(field.default);
  });

  it('every standard name resolves to itself, and only the two admitted extras do not', () => {
    // The card admits its own non-standard rows by label; nothing else may be unnamed.
    const extras = BUILT_IN_STAMPS.filter((stamp) => /no standard name/.test(stamp.label));
    expect(extras.map((stamp) => stamp.value)).toEqual(['EXPRESS', 'PRELIMINARY RESULTS']);
    const standard = BUILT_IN_STAMPS.filter((stamp) => !/no standard name/.test(stamp.label));
    expect(standard).toHaveLength(15);
    for (const stamp of standard) {
      expect(stampNameOf(stamp.value), `${stamp.value} is not a Table 265 name`).toBe(stamp.value);
    }
    expect(railStampField().help).toMatch(/not in that table/);
  });

  it('an admitted extra keeps the name it was given, so the file is not quietly rewritten', async () => {
    const doc = await railExport('EXPRESS');
    expect(String(annotDict(doc).get(PDFName.of('S')))).toBe('/EXPRESS');
    expect(textOf(doc, 'Contents')).toBe('EXPRESS');
  });

  it('the legacy spellings stay offered (labelled) and fold onto the same name', () => {
    const options = railStampField().options ?? [];
    const legacy = options.filter((option) => /saved spelling/.test(option.label));
    expect(legacy.map((option) => option.value)).toEqual(LEGACY_STAMP_SPELLINGS.map((row) => row.value));
    for (const row of LEGACY_STAMP_SPELLINGS) {
      expect(stampNameOf(row.value)).toBe(stampNameOf(stampNameOf(row.value)));
      expect(BUILT_IN_STAMPS.map((stamp) => stamp.value)).toContain(stampNameOf(row.value));
    }
  });

  it('the old spaced spellings the rail used to carry still resolve, so saved values survive', () => {
    expect(stampNameOf('NOT APPROVED')).toBe('NotApproved');
    expect(stampNameOf('AS IS')).toBe('AsIs');
    expect(stampLabel('NOT APPROVED')).toBe('Not approved');
  });
});

describe('a stamp export carries the words a reader searches, from either surface', () => {
  it('the rail writes /S, the label as /Contents, and the same words in the appearance', async () => {
    const doc = await railExport('NotApproved');
    const dict = annotDict(doc);
    expect(String(dict.get(PDFName.of('S')))).toBe('/NotApproved');
    expect(String(dict.get(PDFName.of('Subtype')))).toBe('/Stamp');
    expect(textOf(doc, 'Contents')).toBe('Not approved');
    expect(appearanceWords(doc)).toBe(textOf(doc, 'Contents'));
  });

  it('the surface route writes the same dictionary for the same stamp', async () => {
    const rail = annotDict(await railExport('NotApproved'));
    const surface = annotDict(await surfaceExport('NotApproved'));
    expect(String(surface.get(PDFName.of('S')))).toBe('/NotApproved');
    // The equality the round asks for: the reader-facing keys agree, so a document
    // stamped by clicking and one stamped from the rail behave alike in a reader.
    for (const key of ['Subtype', 'Contents', 'FT', 'CA'] as const) {
      expect(String(surface.get(PDFName.of(key))), `/${key} differs between the two surfaces`)
        .toBe(String(rail.get(PDFName.of(key))));
    }
    expect(textOf(await surfaceExport('Confidential'), 'Contents')).toBe('Confidential');
    // A mark whose words differ from its token is the whole point of /Contents.
    expect(textOf(await surfaceExport('NotForPublicRelease'), 'Contents')).toBe('Not for public release');
  });

  it('a custom image stamp still carries no fake words', async () => {
    // The surface's image branch has no label, so nothing must be invented for it.
    const placed = buildAnnotation({
      tool: 'stamp',
      page: 0,
      style: { ...defaultStyleFor('stamp'), stampName: 'Approved' },
      geom: { zoom: 1, cssWidth: 420, cssHeight: 595, rotation: 0 },
      drag: { x: 70, y: 70, width: 140, height: 44 },
      raster: { bytes: new Uint8Array([0]), url: 'blob:x', width: 40, height: 20 },
    });
    const spec = annotationToSpec(placed!);
    expect(spec.stampName, 'an image stamp should not carry a standard name').toBeFalsy();
    expect(spec.contents, 'an image stamp should not invent searchable words').toBeFalsy();
  });
});
