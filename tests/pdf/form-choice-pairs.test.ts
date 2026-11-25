/**
 * Choice fields that label one thing and answer another, and the save that used to die
 * on a non-Latin answer.
 *
 * A `/Opt` entry may be the pair `[export, display]` — the words in the list are not
 * the words in the data — and that is exactly what producers write for a country, a
 * tier, or a checkbox-style code. pdf-lib reads one half at a time: a dropdown answers
 * with the **display** text and writes whatever it is handed into `/V`, while a radio
 * group derives its options from `getExportValues()`, which drops pair entries, so the
 * group looks empty. Measured by the forms lane on `pairs2.pdf` (15-case matrix, items
 * 1-2 and the `commas` case, :5291): answering the offered "New York" shipped
 * `/V (New York)` instead of `(ny)`; a pair-labelled radio group rendered as a raw text
 * box, every answer refused as "could not be written", and its untouched kid `/AS /a`
 * came back `/Off` — the selection the user never touched stopped being drawn; an option
 * whose own words contain a comma could not be selected at all; and any non-WinAnsi text
 * answer made the *non-flatten* save throw inside `doc.save()` — raw
 * `WinAnsi cannot encode "Ł" (0x0141)` in the banner and no file.
 *
 * Every assertion here is on the produced bytes.
 */
import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { PDFArray, PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from '@maxwbh/pdf-lib';
import { fillForm, listFormFields } from '@/lib/pdf/core/forms';

const PAGE: [number, number] = [595, 842];

interface Fixture {
  doc: PDFDocument;
  pairs: (rows: [string, string][]) => PDFArray;
}

async function choiceFixture(): Promise<Fixture> {
  const doc = await PDFDocument.create();
  await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage(PAGE);
  const form = doc.getForm();
  const pairs = (rows: [string, string][]): PDFArray => {
    const outer = PDFArray.withContext(doc.context);
    for (const [value, label] of rows) {
      const pair = PDFArray.withContext(doc.context);
      pair.push(PDFString.of(value));
      pair.push(PDFString.of(label));
      outer.push(pair);
    }
    return outer;
  };

  const region = form.createDropdown('region');
  region.addToPage(page, { x: 60, y: 700, width: 160, height: 20 });
  region.acroField.dict.set(PDFName.of('Opt'), pairs([
    ['ny', 'New York'], ['ca', 'California'], ['ab', 'Alpha, Beta'],
  ]));
  // Prefilled by the producer, in export form: the answer the pane reads back is the
  // label, and re-sending that label must not count as a refusal.
  region.acroField.dict.set(PDFName.of('V'), PDFString.of('ca'));

  const tier = form.createRadioGroup('tier');
  tier.addOptionToPage('a', page, { x: 60, y: 640, width: 16, height: 16 });
  tier.addOptionToPage('b', page, { x: 90, y: 640, width: 16, height: 16 });
  tier.select('a');
  // last, the way a producer leaves it: adding an option rewrites `/Opt`, and the fork's
  // own radio accessors cannot read the pairs back (that is one of the defects pinned here)
  tier.acroField.dict.set(PDFName.of('Opt'), pairs([['a', 'Bronze'], ['b', 'Silver']]));

  const name = form.createTextField('name');
  name.addToPage(page, { x: 60, y: 580, width: 200, height: 20 });
  name.setText('Ada Lovelace');

  return { doc, pairs };
}

async function saved(doc: PDFDocument): Promise<string> {
  return Buffer.from(await doc.save({ useObjectStreams: false })).toString('latin1');
}

/**
 * The deflated bodies of a saved file, inflated: what a page paints. The dictionaries
 * stay in `saved()`'s bytes — this is for the words inside an appearance stream, and it
 * deliberately does not return a re-parseable file.
 */
function painted(raw: string): string {
  return [...raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)].map((match) => {
    try {
      return inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1');
    } catch {
      return match[1];
    }
  }).join('\n');
}

/** A saved file, re-opened. */
async function load(raw: string): Promise<PDFDocument> {
  return PDFDocument.load(new Uint8Array(Buffer.from(raw, 'latin1')), { updateMetadata: false });
}

/** The text a `/V` or `/AS` entry carries, whether it was written as a name or a string. */
function answerOf(entry: unknown): string {
  if (entry instanceof PDFArray) return entry.asArray().map(answerOf).join(' ');
  if (entry instanceof PDFName) return entry.asString().replace(/^\//, '');
  if (entry instanceof PDFString || entry instanceof PDFHexString) return entry.decodeText();
  return '';
}

/** `/V` of a field, read out of the saved file by a second parse. */
async function valueIn(raw: string, field: string): Promise<string> {
  const doc = await load(raw);
  return answerOf(doc.getForm().getFieldMaybe(field)?.acroField.dict.get(PDFName.of('V')));
}

/** Every kid `/AS` in the saved file, in widget order, for one field. */
async function statesIn(raw: string, field: string): Promise<string[]> {
  const doc = await load(raw);
  const entry = doc.getForm().getFieldMaybe(field);
  if (!entry) return [];
  return entry.acroField.getWidgets().map((widget) => answerOf(widget.dict.get(PDFName.of('AS'))));
}

describe('a pair-labelled choice answers with its export value and draws its label', () => {
  it('writes /V=(ny) for the answer "New York", while the appearance still reads New York', async () => {
    const { doc } = await choiceFixture();
    const outcome = fillForm(doc, { region: 'New York' });
    const raw = await saved(doc);
    expect(outcome.missing, `the field refused its own label: ${JSON.stringify(outcome)}`).toEqual([]);
    expect(await valueIn(raw, 'region'), 'the label was shipped as the answer').toBe('ny');
    // The appearance is drawn while `/V` still holds the label, so the export code never
    // reaches the page: a reader paints the words the picker showed, not `ny`.
    expect(painted(raw), 'the export code was painted instead of the label').not.toContain('(ny)');
  });

  it('accepts an answer that is already an export value, and one whose words hold a comma', async () => {
    const { doc } = await choiceFixture();
    fillForm(doc, { region: 'ca' });
    expect(await valueIn(await saved(doc), 'region'), 'the export value itself was refused').toBe('ca');

    const second = await choiceFixture();
    const comma = fillForm(second.doc, { region: 'Alpha, Beta' });
    const raw = await saved(second.doc);
    expect(comma.missing, 'a comma inside the option split it in two').toEqual([]);
    expect(await valueIn(raw, 'region')).toBe('ab');
  });

  it('selects the kid a label names, and leaves the kid nobody answered alone', async () => {
    const { doc } = await choiceFixture();
    const outcome = fillForm(doc, { tier: 'Silver' });
    const raw = await saved(doc);
    expect(outcome.missing, JSON.stringify(outcome)).toEqual([]);
    expect(listFormFields(await load(raw)).find((field) => field.name === 'tier')?.value,
      'the answer did not read back as its label').toBe('Silver');
    // Which name the kid's on-state carries is the producer's choice ('b' for a hand
    // written pair group, '1' for one pdf-lib laid out itself); the property the page
    // depends on is that exactly one kid answers with the group's own /V, and that kid is
    // the one the label named — the second in this fixture.
    const answered = await statesIn(raw, 'tier');
    const selected = await valueIn(raw, 'tier');
    expect(answered.filter((state) => state !== 'Off'), 'no kid, or both kids, hold the selection').toEqual([selected]);
    expect(answered.indexOf(selected), 'the wrong kid was switched on').toBe(1);

    // The lane's `pairs2-untouched` case: the pane re-sends the prefilled answer for a
    // field the user never touched. Its kid must keep drawing the selection — before
    // this fix pdf-lib's appearance pass rewrote `/AS /a` to `/Off` in the bytes while
    // `/V /a` survived, so the tick the user never touched vanished from the page.
    const untouched = await choiceFixture();
    fillForm(untouched.doc, { tier: 'Bronze', name: 'kept' });
    const bytes = await saved(untouched.doc);
    const kept = await statesIn(bytes, 'tier');
    const group = await valueIn(bytes, 'tier');
    expect(kept.filter((state) => state !== 'Off'), 'the untouched selection stopped being drawn').toEqual([group]);
    expect(kept.indexOf(group), 'the untouched answer moved to the other kid').toBe(0);
  });

  it('reports the labels to the pane, so a pair group is a radio group and not a text box', async () => {
    const { doc } = await choiceFixture();
    const fields = listFormFields(doc);
    const tier = fields.find((field) => field.name === 'tier');
    expect(tier?.options, 'the pair group offered nothing, so the pane drew a text box').toEqual(['Bronze', 'Silver']);
    expect(tier?.value, 'the prefilled kid was not read back as its label').toBe('Bronze');
    const region = fields.find((field) => field.name === 'region');
    expect(region?.options).toEqual(['New York', 'California', 'Alpha, Beta']);
    expect(region?.value, 'a prefilled export value was shown raw').toBe('California');
  });
});

describe('a non-WinAnsi answer saves a file instead of throwing out of doc.save()', () => {
  it('produces bytes with the value, and hands the drawing to the viewer', async () => {
    const { doc } = await choiceFixture();
    const outcome = fillForm(doc, { name: 'Ada 中文 Łovélace', region: 'New York' });
    expect(outcome.missing, JSON.stringify(outcome)).toEqual([]);
    const raw = await saved(doc);
    expect(raw, '/NeedAppearances is what tells a viewer to draw the value').toMatch(/\/NeedAppearances true/);
    expect(await valueIn(raw, 'region'), 'the choice half regressed').toBe('ny');
    // And the file re-opens: the deferred pass must not be able to throw a second time,
    // and both answers survive the round trip through a reader.
    const again = await PDFDocument.load(new Uint8Array(Buffer.from(raw, 'latin1')), { updateMetadata: false });
    expect(listFormFields(again).find((field) => field.name === 'name')?.value, 'the non-Latin answer was lost')
      .toContain('Ada');
    expect(await saved(again), 're-saving the produced file threw').toContain('/NeedAppearances');
  });
});
