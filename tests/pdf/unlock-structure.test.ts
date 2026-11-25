/**
 * `unlock` keeps the document, not just the pages.
 *
 * The round measured this tool on three ciphers (RC4-128 `/V 2 /R 3`, AES-128
 * `/V 4 /R 4`, AES-256 `/V 5 /R 6`) in a real Chromium tab, one run per cipher,
 * and judged the downloads with qpdf, MuPDF, poppler, pypdf and Ghostscript: no
 * `/Encrypt` survived, every reader opened the copy with nothing typed, and the
 * ink, the text, the boxes and the rotations equalled the decrypted source sheet
 * for sheet (61153 / 50610 / 0 / 142563 ink pixels, 1779 + 56 characters). The
 * wrong password and the missing one are refused in words by the tool, and an
 * unencrypted file comes back byte-identical with the reason said out loud.
 *
 * What was *not* pinned is the claim the copy rests on. The corpus fixture the
 * triage row hands out is four sheets of ink with no `/Annots`, no `/AcroForm`,
 * no outline, no `/PageLabels` and no enclosure — so the card's "the page tree,
 * the form fields, the comments, the bookmarks and any embedded files all stay
 * where they were" had nothing in it to be true about, and the lossy page-tree
 * rebuild sits right beside the good path (`stripProtectionFrom` falls back to it
 * the moment a saved copy still reports itself encrypted). This file is that pin.
 *
 * `structure-aes-256-user.pdf` is a locked document carrying every object a
 * rebuild drops, and `structure-census.json` beside it is the same census taken
 * off its plaintext twin (`structure-plain.pdf`) — the two were asserted equal by
 * the generator, so a string only has to be read once, through a reader that
 * undoes the cipher. The copy is then read straight off its own bytes, and has to
 * equal that record object for object and word for word.
 *
 * The second pin is the card's own sentence. It said a file needing the password
 * to be read "cannot lose it here" — true of the build before `core/crypto.ts`
 * undecrypted on load, false of this one, where that is what the tool does.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from '@maxwbh/pdf-lib';
import { openRender } from '@/lib/pdf/core/render';
import { readOutline, writeOutline } from '@/lib/pdf/core/bookmarks';
import { saveEncrypted } from '@/lib/pdf/core/doc';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { getPdfTool } from '@/lib/pdf/tools/registry';

const FIXTURES = resolve(process.cwd(), 'tests/fixtures/encrypted');
const LOCKED = 'structure-aes-256-user.pdf';
const PASSWORD = 'hunter2';

/** What the source held, taken off its plaintext twin by the fixture script. */
interface Census {
  pages: number;
  /** `/AcroForm /Fields` — the entries that make a form a form. */
  fields: number;
  annotations: number;
  subtypes: string[];
  field_values: string[];
  uris: string[];
  outline_titles: string[];
  label_prefix: string;
  attachment_names: string[];
  title: string;
  author: string;
  text_strings: string[];
}

const SOURCE: Census = JSON.parse(readFileSync(join(FIXTURES, 'structure-census.json'), 'utf8')) as Census;

beforeAll(() => {
  // pdf.js hands Node an `http://` worker URL it refuses.
  let workerPath = `file://${process.cwd()}/node_modules/pdfjs-dist/build/pdf.worker.mjs`;
  Object.defineProperty(GlobalWorkerOptions, 'workerSrc', {
    configurable: true,
    get: () => workerPath,
    set: (value: string) => {
      if (value.startsWith('file:') || value.startsWith('data:')) workerPath = value;
    },
  });
}, 120_000);

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');

async function unlock() {
  const bytes = new Uint8Array(readFileSync(join(FIXTURES, LOCKED)));
  const outcome = await runPdfTool({
    toolId: 'unlock',
    files: [new File([bytes as BlobPart], LOCKED, { type: 'application/pdf' })],
    values: { password: PASSWORD },
    onProgress: () => undefined,
    onLog: () => undefined,
  });
  expect(outcome.outputs, 'the tool produced no file').toHaveLength(1);
  return {
    bytes: new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()),
    message: outcome.message,
    warnings: outcome.warnings,
  };
}

/**
 * The same census, taken off the copy's own objects.
 *
 * Read by parsing rather than by searching the bytes: the copy is saved with
 * object streams, so `/Subtype /Widget` and `/V (…)` are inside a compressed
 * `/ObjStm` and a text match over the file finds none of them.
 */
async function textOf(bytes: Uint8Array, password?: string): Promise<string[]> {
  const session = await openRender(bytes, password ? { password } : {});
  try {
    const pages: string[] = [];
    for (let index = 1; index <= session.numPages; index++) {
      pages.push((await session.textItems(index)).map((item) => item.str).join(' ').trim());
    }
    return pages;
  } finally {
    await session.destroy();
  }
}

/** `/AcroForm /Fields` size, resolving both the form and the array. */
function formFieldCount(doc: PDFDocument): number {
  const acroForm = doc.catalog.get(PDFName.of('AcroForm'));
  const resolved = acroForm instanceof PDFRef ? doc.context.lookup(acroForm) : acroForm;
  if (!(resolved instanceof PDFDict)) return 0;
  const fields = resolved.get(PDFName.of('Fields'));
  const array = fields instanceof PDFRef ? doc.context.lookup(fields) : fields;
  return array instanceof PDFArray ? array.size() : 0;
}

async function censusOfCopy(bytes: Uint8Array): Promise<Census> {
  const doc = await PDFDocument.load(bytes);
  const text = await textOf(bytes);

  const name = (dict: PDFDict, key: string): string | undefined => {
    const value = dict.get(PDFName.of(key));
    return value instanceof PDFName ? value.decodeText() : undefined;
  };
  /** A string-or-name value, whichever the writer chose: the copy this tool
   *  saves writes every string as a hex string, and a checkbox `/V` is a name. */
  const string = (dict: PDFDict, key: string): string | undefined => {
    const value = dict.get(PDFName.of(key));
    const resolved = value instanceof PDFRef ? doc.context.lookup(value) : value;
    if (resolved instanceof PDFString || resolved instanceof PDFHexString) return resolved.decodeText();
    if (resolved instanceof PDFName) return resolved.decodeText();
    return undefined;
  };
  const dicts = doc.context.enumerateIndirectObjects()
    .map(([, object]) => object)
    .filter((object): object is PDFDict => object instanceof PDFDict);

  // Every `/Annots` entry of every page, resolved: the widget and popup objects
  // are not all typed `/Annot` in a file an outside writer produced.
  const annots = doc.getPages().flatMap((page) => {
    const entry = page.node.get(PDFName.of('Annots'));
    const resolved = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
    if (!(resolved instanceof PDFArray)) return [];
    return resolved.asArray()
      .map((item) => doc.context.lookup(item))
      .filter((item): item is PDFDict => item instanceof PDFDict);
  });
  const outline = dicts.filter((dict) => dict.get(PDFName.of('Title')) !== undefined
    && (dict.get(PDFName.of('Parent')) !== undefined || dict.get(PDFName.of('First')) !== undefined));
  const info = doc.context.trailerInfo.Info;
  const infoDict = info ? doc.context.lookup(info) : undefined;
  const labels = doc.catalog.get(PDFName.of('PageLabels'));
  const labelDict = labels instanceof PDFRef ? doc.context.lookup(labels) : labels;
  const nums = labelDict instanceof PDFDict ? doc.context.lookup(labelDict.get(PDFName.of('Nums'))) : undefined;
  const labelEntry = nums instanceof PDFArray ? doc.context.lookup(nums.get(1)) : undefined;
  const names = doc.catalog.get(PDFName.of('Names'));
  const namesDict = names instanceof PDFRef ? doc.context.lookup(names) : names;
  const embedded = namesDict instanceof PDFDict ? doc.context.lookup(namesDict.get(PDFName.of('EmbeddedFiles'))) : undefined;
  const embeddedNames = embedded instanceof PDFDict ? doc.context.lookup(embedded.get(PDFName.of('Names'))) : undefined;

  return {
    pages: doc.getPageCount(),
    fields: formFieldCount(doc),
    annotations: annots.length,
    subtypes: annots.map((dict) => name(dict, 'Subtype') ?? '').sort(),
    field_values: annots
      .map((dict) => string(dict, 'V'))
      .filter((value): value is string => value !== undefined),
    uris: annots
      .map((dict) => {
        const action = dict.get(PDFName.of('A'));
        const resolved = action instanceof PDFRef ? doc.context.lookup(action) : action;
        return resolved instanceof PDFDict ? string(resolved, 'URI') : undefined;
      })
      .filter((value): value is string => value !== undefined),
    outline_titles: outline
      .map((dict) => string(dict, 'Title') ?? '')
      .filter((title) => /Chapter|Intro/.test(title)),
    label_prefix: labelEntry instanceof PDFDict ? string(labelEntry, 'P') ?? '' : '',
    // A name tree's `/Names` array alternates key and value; the keys are the
    // file names, and they are hex strings once this writer has saved them.
    attachment_names: embeddedNames instanceof PDFArray
      ? embeddedNames.asArray()
        .map((entry: import('@maxwbh/pdf-lib').PDFObject) => {
          const resolved = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
          return resolved instanceof PDFString || resolved instanceof PDFHexString
            ? resolved.decodeText() : '';
        })
        .filter((entry, index) => index % 2 === 0)
      : [],
    title: infoDict instanceof PDFDict ? string(infoDict, 'Title') ?? '' : '',
    author: infoDict instanceof PDFDict ? string(infoDict, 'Author') ?? '' : '',
    text_strings: text,
  };
}

describe('unlock over a locked document that carries structure', () => {
  it('leaves the page tree, fields, comments, bookmarks, labels, enclosure and /Info where they were', async () => {
    const { bytes } = await unlock();
    // The copy really is open, so nothing below is a reader being handed the
    // source's password; and a bare load proves the dictionary is gone.
    expect(latin1(bytes)).not.toMatch(/\/Encrypt[\s<\d]/);
    const reopened = await PDFDocument.load(bytes);
    expect(reopened.getPageCount(), 'the copy lost a sheet').toBe(SOURCE.pages);

    // The control: a record that held nothing would match an empty copy.
    expect(SOURCE.annotations, 'the fixture lost its annotations').toBe(6);
    expect(SOURCE.field_values, 'the fixture lost its field values').toEqual(['Ada Lovelace', 'Yes']);
    expect(SOURCE.uris.length, 'the fixture lost its link').toBe(1);
    expect(SOURCE.fields, 'the fixture lost its form').toBe(2);

    const copy = await censusOfCopy(bytes);
    expect(copy.fields, '/AcroForm /Fields did not survive').toBe(SOURCE.fields);
    expect(copy.annotations, 'annotations did not survive the removal').toBe(SOURCE.annotations);
    expect(copy.subtypes, 'an annotation changed kind or went missing').toEqual([...SOURCE.subtypes].sort());
    expect(copy.field_values, 'a form field lost its value').toEqual(SOURCE.field_values);
    expect(copy.uris, 'the link lost its destination').toEqual(SOURCE.uris);
    expect(copy.outline_titles, 'the bookmarks did not survive').toEqual(SOURCE.outline_titles);
    expect(copy.label_prefix, 'the page labels did not survive').toBe(SOURCE.label_prefix);
    expect(copy.attachment_names, 'the enclosure did not survive').toEqual(SOURCE.attachment_names);
    expect(copy.title, '/Info title did not survive').toBe(SOURCE.title);
    expect(copy.author, '/Info author did not survive').toBe(SOURCE.author);

    // The words, page for page — the half a surviving page count says nothing
    // about. Both sides through pdf.js, so this is one reader's reading of the
    // source and of the copy, and the planted sentence on both sheets.
    const sourceText = await textOf(new Uint8Array(readFileSync(join(FIXTURES, LOCKED))), PASSWORD);
    copy.text_strings.forEach((page, index) => {
      expect(page, `sheet ${index + 1} reads differently`).toBe(sourceText[index]);
      expect(page, `sheet ${index + 1} lost the planted sentence`).toContain('Lighthouse Inventory 1887');
      expect(page, `sheet ${index + 1} lost its sheet name`).toContain('Structure sheet');
    });
  }, 300_000);

  it('says what it kept, and admits nothing as lost', async () => {
    const { message, warnings } = await unlock();
    expect(message).toMatch(/opens without a password now/);
    expect(message).toMatch(/2 page\(s\)/);
    expect(message).toMatch(/2 form field\(s\)/);
    // The file holds two outline entries — `Intro` is `Chapter Bravo`'s child,
    // and a bookmark panel opens showing both. A count that reads only the top
    // tier said "1 bookmark(s)" while the fixture's own census recorded two,
    // and the same number is what the loss check compares: children dropping
    // went unreported. Counted off the saved copy, this sentence is the bytes.
    expect(message).toMatch(/2 bookmark\(s\)/);
    expect(message).toMatch(/1 embedded file\(s\)/);
    // Nothing was rebuilt, so nothing may be reported as left behind.
    expect(warnings.filter((warning) => /did not carry over|missing from the copy/.test(warning))).toEqual([]);
    expect(warnings.filter((warning) => /read differently/.test(warning))).toEqual([]);
  }, 300_000);

  it('names a nested outline by its entries, not its top tier', async () => {
    // A fresh document with four outline entries in two tiers, sealed by this
    // app's own writer and unlocked through the shipped tool — the fixture
    // above is one child on one parent; this says the count walks the whole
    // tree rather than agreeing with one file's shape.
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.addPage();
    doc.setTitle('Four bookmarks, two of them children');
    writeOutline(doc, [
      { title: 'Sheet one', page: 0, children: [{ title: 'One.a', page: 0 }, { title: 'One.b', page: 1 }] },
      { title: 'Sheet two', page: 1 },
    ]);
    const sealed = await saveEncrypted(doc, {
      userPassword: PASSWORD,
      ownerPassword: 'owner-of-the-test',
      permissions: {
        printing: true, printingHighQuality: true, modifying: true, copying: true,
        annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: false,
      },
      cipher: 'AES-128',
    });
    // The control: the sealed file really carries four entries in two tiers —
    // a flat writer bug would make this test match an empty copy.
    const pre = await PDFDocument.load(sealed, { ignoreEncryption: true });
    const sealedBytes = new Uint8Array(sealed);
    expect(readOutline(pre).length, 'the seal flattened the tiers').toBe(2);
    expect(readOutline(pre).reduce((n, node) => n + 1 + (node.children?.length ?? 0), 0), 'the seal dropped a child').toBe(4);

    const outcome = await runPdfTool({
      toolId: 'unlock',
      files: [new File([sealedBytes as BlobPart], 'nested-outline.pdf', { type: 'application/pdf' })],
      values: { password: PASSWORD },
      onProgress: () => undefined,
      onLog: () => undefined,
    });
    expect(outcome.outputs, 'the tool produced no file').toHaveLength(1);
    expect(outcome.message, 'the card still reads only the top tier').toMatch(/4 bookmark\(s\)/);
    const copy = await PDFDocument.load(new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()));
    const copyNodes = readOutline(copy);
    expect(copyNodes.reduce((n, node) => n + 1 + (node.children?.length ?? 0), 0), 'the copy lost an entry').toBe(4);
    expect(copyNodes.map((node) => node.title), 'the top tier changed').toEqual(['Sheet one', 'Sheet two']);
    expect(copyNodes[0]?.children?.map((node) => node.title), 'the children changed').toEqual(['One.a', 'One.b']);
  }, 300_000);

  it('states on the card what the cases were measured doing', () => {
    const notes = (getPdfTool('unlock')?.notes ?? []).join(' ');
    // The claim this round falsified: a user-password file unlocks *here*, with
    // its password, and the streams behind the dictionary are decrypted for it.
    expect(notes).not.toMatch(/cannot lose it here/);
    expect(notes).toMatch(/asks for a password before it will be read is unlocked here by typing it/);
    expect(notes).toMatch(/either the user or the owner password works/);
    // The one the field help and the measurement both stand behind.
    expect(notes).toMatch(/restricted-but-openable one needs no password/);
  });
});
