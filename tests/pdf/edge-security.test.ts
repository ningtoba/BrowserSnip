/**
 * Security-tool edge cases (matrix rows E1, E2, E4, E5, E6, E13, E20).
 *
 * Every claim these tools make is checked against the bytes they wrote, not
 * against what the form asked for:
 *
 * * `protect` → the saved file must actually carry the selected cipher and the
 *   `/P` bits, must still prompt (or deliberately not prompt), and must say so
 *   when the engine left the page content readable.
 * * `unlock` → the output must open with **no** password at all. The original
 *   bug was re-saving a decrypted document, which kept the trailer's `/Encrypt`
 *   entry, so "unlocked" files still prompted. A plain `PDFDocument.load` with
 *   no options is the reader's point of view here and throws if protection
 *   survived.
 * * `redact-pdf` → the removed words must be gone from every stream in the
 *   file, including nested Form XObjects, so a black box cannot hide text that
 *   is still selectable.
 * * `validate-signature-pdf` → valid, tampered and unsigned are three different
 *   answers, and unsigned must not be a stack trace.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
  rgb,
} from '@maxwbh/pdf-lib';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import { securityTools } from '@/lib/pdf/tools/security';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { inspectPdf, validateFields } from '@/lib/pdf/core/guard';
import { openPDF, saveEncrypted } from '@/lib/pdf/core/doc';
import { pageContentStreams, streamBytes } from '@/lib/pdf/core/content';
import { createSelfSignedCertificate, readSignatures } from '@/lib/pdf/core/signature';
import type { PdfToolDefinition, ToolValues } from '@/lib/pdf/tools/types';

const latin1 = new TextDecoder('latin1');

/**
 * The sub-dictionary under `key` in `parent`, created and attached when absent.
 *
 * A page fresh from `addPage` carries an **empty** `/Resources`, so asking it for
 * `/Font` or `/XObject` answers `undefined`; writing the entry is the only way
 * the fixture's `Tf` / `Do` names mean anything to a viewer.
 */
function subDict(parent: PDFDict, key: string): PDFDict {
  const name = PDFName.of(key);
  const found = parent.lookupMaybe(name, PDFDict);
  if (found) return found;
  const created = parent.context.obj({}) as PDFDict;
  parent.set(name, created);
  return created;
}

/**
 * A page with three kinds of text, so redaction has to reach all of them: one run
 * drawn straight into the page content, one in a Form XObject, and one inside a
 * *nested* Form XObject (a form invoked by a form, as producers emit shared
 * headers). Strings are written as literals so the assertions can look for the
 * words themselves.
 */
async function redactionFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  const resources = page.node.Resources();
  expect(resources, 'the fixture page has no /Resources dict').toBeInstanceOf(PDFDict);
  subDict(resources as PDFDict, 'Font').set(PDFName.of('F9'), font.ref);
  page.node.addContentStream(
    doc.context.register(doc.context.flateStream('BT /F9 18 Tf 60 600 Td (Zephyr Bravo Content) Tj ET\n', {})),
  );

  const inner = doc.context.flateStream('BT /F9 18 Tf 60 300 Td (Yankee Charlie Text) Tj ET\n', {});
  inner.dict.set(PDFName.of('Type'), PDFName.of('XObject'));
  inner.dict.set(PDFName.of('Subtype'), PDFName.of('Form'));
  inner.dict.set(PDFName.of('BBox'), doc.context.obj([0, 0, 595, 842] as number[]));
  inner.dict.set(PDFName.of('Resources'), doc.context.obj({ Font: { F9: font.ref } }));
  const innerRef = doc.context.register(inner);

  // The outer form shifts the inner one so the nested text lands at y ≈ 100,
  // which is where the redaction rect below points.
  const outer = doc.context.flateStream('q 1 0 0 1 0 -200 cm /In Do Q\n', {});
  outer.dict.set(PDFName.of('Type'), PDFName.of('XObject'));
  outer.dict.set(PDFName.of('Subtype'), PDFName.of('Form'));
  outer.dict.set(PDFName.of('BBox'), doc.context.obj([0, 0, 595, 842] as number[]));
  outer.dict.set(PDFName.of('Resources'), doc.context.obj({ XObject: { In: innerRef } }));
  const outerRef = doc.context.register(outer);

  const xobjects = subDict(resources as PDFDict, 'XObject');
  xobjects.set(PDFName.of('Out'), outerRef);
  page.node.addContentStream(
    doc.context.register(doc.context.flateStream('q /Out Do Q\n', {})),
  );
  return doc.save({ useObjectStreams: false });
}

async function plainFixture(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index++) {
    const page = doc.addPage([595, 842]);
    page.drawText(`Ordinary page ${index + 1}`, { x: 60, y: 700, size: 18, font, color: rgb(0, 0, 0) });
  }
  return doc.save({ useObjectStreams: false });
}

/** A document with everything a page-tree rebuild is known to leave behind. */
async function loadedFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const form = doc.getForm();
  form.createTextField('applicant.name');
  form.createCheckBox('agree');
  const { addAnnotation } = await import('@/lib/pdf/core/annotations');
  // `contents` is the field the writer knows; a `text` key here was dropped on
  // the floor, so the "comment" this fixture claims to carry had no body.
  addAnnotation(doc, { kind: 'Text', page: 0, rect: { x: 100, y: 500, width: 24, height: 24 }, contents: 'review me' });
  const { writeOutline } = await import('@/lib/pdf/core/bookmarks');
  writeOutline(doc, [{ title: 'Chapter one', page: 0 }]);
  const { addAttachments } = await import('@/lib/pdf/core/attachments');
  await addAttachments(doc, [{ name: 'source.csv', bytes: new TextEncoder().encode('a,b\n1,2\n'), mimeType: 'text/csv' }]);
  page.drawText('Loaded fixture', { x: 60, y: 700, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
  return doc.save({ useObjectStreams: false });
}

/**
 * The decoded text of every `/Subtype /Form` stream in the file.
 *
 * Narrower than `readableText`: if a phrase is here, it lived inside a form
 * XObject, which is where a cover-only "redaction" leaves it selectable.
 */
async function formStreamText(bytes: Uint8Array): Promise<string> {
  const doc = await openPDF(bytes, { ignoreEncryption: true });
  const parts: string[] = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    if (String(object.dict.get(PDFName.of('Subtype'))) !== '/Form') continue;
    try {
      parts.push(latin1.decode(streamBytes(object)));
    } catch {
      /* undecodable form; the raw-file search in readableText still covers it */
    }
  }
  return parts.join('\n');
}

function pdfFile(bytes: Uint8Array, name: string): File {
  return new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
}

interface RunOutcome {
  outputs: { blob: Blob; name: string }[];
  message?: string;
  warnings: string[];
  report?: { sections: { title: string; rows?: { label: string; value: string }[] }[]; message?: string };
}

async function run(
  id: string,
  values: ToolValues = {},
  files?: File[],
  password?: string,
): Promise<RunOutcome> {
  const tool = getPdfTool(id) as PdfToolDefinition | undefined;
  expect(tool, `tool "${id}" is not registered`).toBeTruthy();
  const inputs = files ?? [pdfFile(await plainFixture(), 'fixture.pdf')];
  const outcome = await runPdfTool({ toolId: id, files: inputs, values, password, onProgress: () => {}, onLog: () => {} });
  return outcome as unknown as RunOutcome;
}

async function bytesOf(outcome: RunOutcome, index = 0): Promise<Uint8Array> {
  expect(outcome.outputs.length, 'tool produced no output').toBeGreaterThan(index);
  return new Uint8Array(await outcome.outputs[index].blob.arrayBuffer());
}

/**
 * Everything a viewer could read back: the raw file plus the decoded bytes of
 * every stream object, so text parked inside a Form XObject is in the search
 * space even though it never appears in the page's own content stream.
 */
async function readableText(bytes: Uint8Array): Promise<string> {
  const doc = await openPDF(bytes, { ignoreEncryption: true });
  const parts: string[] = [latin1.decode(bytes)];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    // Every stream in the file: text parked in a Form XObject never shows up in
    // the page's own `/Contents`, which is exactly where a fake redaction hides.
    if (!(object instanceof PDFRawStream)) continue;
    try {
      parts.push(latin1.decode(streamBytes(object)));
    } catch {
      /* not a stream we can decode — the raw file above already covers it */
    }
  }
  for (const page of doc.getPages()) {
    for (const stream of pageContentStreams(page)) parts.push(latin1.decode(stream.bytes));
  }
  return parts.join('\n');
}

const PROTECTION_DEFAULTS: ToolValues = {
  mode: 'user',
  userPassword: 'hunter2',
  ownerPassword: '',
  version: '4',
  allowPrinting: true,
  printLevel: 'high',
  allowModifying: true,
  allowCopying: true,
  allowAnnotating: true,
  allowFillingForms: true,
  allowAccessibility: true,
  allowAssembling: false,
};

const CIPHERS = [
  { version: '5', label: 'AES-256' },
  { version: '4', label: 'AES-128' },
  { version: '2', label: 'RC4-128' },
  { version: '1', label: 'RC4-40' },
];

let certificate: { certificatePem: string; privateKeyPem: string };
const encoder = new TextEncoder();

beforeAll(async () => {
  // One RSA key pair for the whole file: generating it is the slow part.
  certificate = await createSelfSignedCertificate('BrowserSnip Edge Tester');
  // `core/render` points pdf.js at its worker with `import.meta.url`, which in
  // Vite's dev server is an `http://` URL Node's ESM loader refuses — and it
  // assigns that URL on every `openRender`, so writing the property once is not
  // enough. A setter that keeps the on-disk path lets the text comparison in
  // `compare-pdfs` run here; page *rendering* still needs a canvas, which jsdom
  // does not provide.
  let workerPath = `file://${process.cwd()}/node_modules/pdfjs-dist/build/pdf.worker.mjs`;
  Object.defineProperty(GlobalWorkerOptions, 'workerSrc', {
    configurable: true,
    get: () => workerPath,
    set: (value: string) => {
      if (value.startsWith('file:') || value.startsWith('data:')) workerPath = value;
    },
  });
}, 120_000);

describe('protect and unlock round trip (E4, E5)', () => {
  it.each(CIPHERS)('writes $label and reads it back as $label', async ({ version, label }) => {
    const protectedRun = await run('protect', { ...PROTECTION_DEFAULTS, version });
    const bytes = await bytesOf(protectedRun);

    // The file declares the cipher that was asked for, and it declares it in a
    // way the shared guard — the code the file queue uses — agrees with.
    const gate = await inspectPdf(bytes, 'out.pdf');
    expect(gate.encrypted, `${label}: /Encrypt missing`).toBe(true);
    expect(gate.algorithm).toBe(label);
    // E4: no password means "ask", never a hang and never a silent success.
    expect(gate.error).toBe('PASSWORD_REQUIRED');
    expect(gate.needsPassword).toBe(true);
    // E5: the right password gets in, and the tool says so out loud.
    const opened = await inspectPdf(bytes, 'out.pdf', { password: 'hunter2' });
    expect(opened.error).toBeNull();
    expect(opened.passwordAccepted).toBe(true);
    expect(protectedRun.message).toContain(label);
  }, 120_000);

  it.each(CIPHERS)('unlocks a $label file into one that opens with no password', async ({ version, label }) => {
    const locked = await bytesOf(await run('protect', { ...PROTECTION_DEFAULTS, version }));
    // E4 again, from the other side: the wrong password has to be refused for
    // this cipher, not accepted or left hanging.
    let wrong: { code?: string; message?: string } | null = null;
    try {
      await run('unlock', { password: 'nope-not-it' }, [pdfFile(locked, 'locked.pdf')]);
    } catch (error) {
      wrong = error as { code?: string; message?: string };
    }
    expect(wrong, `${label}: a wrong password was not refused`).not.toBeNull();
    expect(wrong!.code, `${label}: wrong password must re-prompt, not crash`).toBe('BAD_PASSWORD');
    expect(wrong!.message).toMatch(/not correct/i);

    const unlocked = await run('unlock', { password: 'hunter2' }, [pdfFile(locked, 'locked.pdf')]);
    const bytes = await bytesOf(unlocked);

    // The old bug: re-saving a document that had been opened with a password
    // kept the trailer's `/Encrypt`, so this is the assertion that matters —
    // a bare load, no password, no ignoreEncryption.
    const reader = await PDFDocument.load(bytes);
    expect(reader.getPageCount()).toBe(2);
    expect(reader.isEncrypted).toBe(false);
    expect(latin1.decode(bytes.subarray(bytes.length - 4096))).not.toMatch(/\/Encrypt[\s\d]/);
    const gate = await inspectPdf(bytes, 'unlocked.pdf');
    expect(gate.encrypted).toBe(false);
    expect(gate.error).toBeNull();
    expect(unlocked.message).toMatch(/opens without a password/i);
    expect(unlocked.warnings).toEqual([]);
  }, 120_000);

  it('refuses to protect with no password at all (E18)', () => {
    const tool = getPdfTool('protect')!;
    const values = { ...PROTECTION_DEFAULTS, userPassword: '', ownerPassword: '' };
    // The two single-field rules live on the fields now — a tool-level
    // `validate` sentence has no box to point at — so `validateFields` is the
    // seam the run itself refuses through.
    const issues = validateFields(tool.fields, { ...values, mode: 'user' });
    expect(issues.find((issue) => issue.key === 'userPassword')?.message)
      .toMatch(/password readers must type/i);
    // A permissions-only run needs the owner password, not the open one.
    expect(validateFields(tool.fields, { ...values, mode: 'owner' }).map((issue) => issue.key))
      .toContain('ownerPassword');
    expect(validateFields(tool.fields, { ...values, mode: 'both' }).map((issue) => issue.key))
      .toEqual(['userPassword']);
    // …and one password for both jobs is refused, because it undoes the point.
    expect(tool.validate!({ ...values, mode: 'both', userPassword: 'same', ownerPassword: 'same' }, { fileCount: 1 }))
      .toMatch(/different owner password/i);
    expect(tool.validate!({ ...values, mode: 'both', userPassword: 'same', ownerPassword: 'other' }, { fileCount: 1 })).toBeNull();
  });

  it('asks for the password again when it is wrong, and says it is wrong', async () => {
    const locked = await bytesOf(await run('protect', PROTECTION_DEFAULTS));
    let failure: unknown = null;
    try {
      await run('unlock', { password: 'not-the-password' }, [pdfFile(locked, 'locked.pdf')]);
    } catch (error) {
      failure = error;
    }
    const described = failure as { code?: string; message?: string; passwordRequired?: boolean };
    expect(described.code, 'a wrong password must be a typed refusal, not a crash').toBe('BAD_PASSWORD');
    expect(described.passwordRequired, 'the UI must re-prompt rather than show a stack trace').toBe(true);
    expect(described.message).toMatch(/not correct/i);
    expect(described.message).toMatch(/locked\.pdf/);
  }, 120_000);

  it('names the cipher and the recorded permissions rather than the requested ones', async () => {
    const outcome = await run('protect', {
      ...PROTECTION_DEFAULTS,
      allowPrinting: false,
      allowCopying: false,
      allowModifying: false,
      allowAnnotating: false,
      allowFillingForms: false,
      allowAccessibility: false,
    });
    const bytes = await bytesOf(outcome);
    const recorded = (await inspectPdf(bytes, 'out.pdf')).permissions;
    expect(recorded).not.toBeNull();
    // Never overstate: the sentence has to agree with the bits in the file.
    expect(recorded!.printing).toBe(false);
    expect(recorded!.copying).toBe(false);
    expect(outcome.message).toContain('printing blocked');
    expect(outcome.message).toContain('copying blocked');
    expect(outcome.message).not.toContain('printing allowed');
  }, 120_000);

  it('admits when the engine recorded protection without rewriting the page content', async () => {
    const source = await redactionFixture();
    const outcome = await run('protect', PROTECTION_DEFAULTS, [pdfFile(source, 'report.pdf')]);
    const bytes = await bytesOf(outcome);
    // The claim under test is the warning itself: the words are still in the
    // saved file, so a tool that ignores `/Encrypt` can still read them.
    expect(await readableText(bytes)).toContain('Zephyr Bravo Content');
    expect(outcome.warnings.join(' ')).toMatch(/not rewritten as ciphertext|ignores \/Encrypt/i);
  }, 120_000);

  it('keeps a restrictions-only file opening on the empty password', async () => {
    const outcome = await run('protect', { ...PROTECTION_DEFAULTS, mode: 'owner', userPassword: '', ownerPassword: 'owner-only' });
    const bytes = await bytesOf(outcome);
    // No open password was asked for, so the file must open without one…
    await expect(PDFDocument.load(bytes, { password: '' })).resolves.toBeTruthy();
    // …while still recording the restrictions.
    const gate = await inspectPdf(bytes, 'out.pdf');
    expect(gate.encrypted).toBe(true);
    expect(outcome.message).toMatch(/restrictions only/i);
    expect(outcome.warnings.join(' ')).not.toMatch(/does not open on the empty password/i);
  }, 120_000);

  it('refuses an empty file and a renamed JPEG before doing any work (E1, E2)', async () => {
    const empty = new File([], 'empty.pdf', { type: 'application/pdf' });
    await expect(run('protect', PROTECTION_DEFAULTS, [empty])).rejects.toThrow(/empty\.pdf.*empty \(0 bytes\)/is);

    const jpeg = new File(
      [new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0xd9])],
      'holiday.jpg',
      { type: 'image/jpeg' },
    );
    let failure: { code?: string; message?: string } = {};
    try {
      await run('unlock', { password: 'x' }, [jpeg]);
    } catch (error) {
      failure = error as { code?: string; message?: string };
    }
    expect(failure.code).toBe('NOT_A_PDF');
    expect(failure.message).toMatch(/holiday\.jpg/);
    expect(failure.message).toMatch(/not a PDF/i);
  });

  it('does not claim a password was removed from a file that never had one', async () => {
    const source = await plainFixture();
    const outcome = await run('unlock', { password: '' }, [pdfFile(source, 'open.pdf')]);
    expect(outcome.message).toMatch(/not password protected/i);
    expect(outcome.message).not.toMatch(/removed protection/i);
    expect(outcome.warnings.join(' ')).toMatch(/no \/Encrypt entry/i);
    // The bytes are handed straight back: rebuilding would only lose things.
    expect(await bytesOf(outcome)).toEqual(source);
  });

  it('warns when dropping the protection also drops form fields, comments, bookmarks and attachments', async () => {
    const source = await loadedFixture();
    const locked = await saveEncrypted(await PDFDocument.load(source), {
      userPassword: 'gate',
      ownerPassword: 'gate',
      version: 4,
    });
    const outcome = await run('unlock', { password: 'gate' }, [pdfFile(locked, 'form.pdf')]);
    const warnings = outcome.warnings.join(' ');
    expect(warnings).toMatch(/form field/i);
    expect(warnings).toMatch(/annotation|comment/i);
    expect(warnings).toMatch(/bookmark/i);
    expect(warnings).toMatch(/embedded file/i);
    // And the file it does return is genuinely unlocked.
    await expect(PDFDocument.load(await bytesOf(outcome))).resolves.toBeTruthy();
  }, 120_000);
});

describe('change-permissions and remove-restrictions (E5, E13)', () => {
  it('records exactly the flags it was given, on a file that opens freely', async () => {
    const outcome = await run('change-permissions', {
      action: 'set',
      ownerPassword: 'owner',
      version: '4',
      allowPrinting: false,
      allowModifying: true,
      allowCopying: false,
      allowAnnotating: true,
      allowFillingForms: false,
      allowAssembling: false,
    });
    const bytes = await bytesOf(outcome);
    const gate = await inspectPdf(bytes, 'out.pdf');
    expect(gate.encrypted).toBe(true);
    expect(gate.algorithm).toBe('AES-128');
    const recorded = gate.permissions!;
    expect(recorded.printing).toBe(false);
    expect(recorded.copying).toBe(false);
    expect(recorded.modifying).toBe(true);
    expect(recorded.annotating).toBe(true);
    expect(recorded.fillingForms).toBe(false);
    expect(recorded.documentAssembly).toBe(false);
    // No open password, so a reader opens it and merely obeys the flags.
    await expect(PDFDocument.load(bytes, { password: '' })).resolves.toBeTruthy();
    expect(outcome.message).toMatch(/opens without a password/i);
    expect(outcome.warnings.join(' ')).not.toMatch(/not what was asked for/i);
  }, 120_000);

  it('clears restrictions for real, and says so when there were none', async () => {
    const locked = await bytesOf(await run('protect', PROTECTION_DEFAULTS));
    const cleared = await run('change-permissions', { action: 'clear', ownerPassword: 'hunter2' }, [pdfFile(locked, 'locked.pdf')]);
    const bytes = await bytesOf(cleared);
    const reader = await PDFDocument.load(bytes);
    expect(reader.isEncrypted).toBe(false);
    expect(reader.getPageCount()).toBe(2);

    const nothing = await run('change-permissions', { action: 'clear', ownerPassword: '' }, [pdfFile(await plainFixture(), 'free.pdf')]);
    expect(nothing.message).toMatch(/no encryption dictionary|returned unchanged/i);
    expect(nothing.warnings.join(' ')).toMatch(/nothing to clear/i);
  }, 120_000);

  it('removes restrictions without pretending there was something to remove', async () => {
    const locked = await bytesOf(await run('protect', { ...PROTECTION_DEFAULTS, mode: 'owner', userPassword: '', ownerPassword: 'owner' }));
    const outcome = await run('remove-restrictions', {}, [pdfFile(locked, 'restricted.pdf')], 'owner');
    const bytes = await bytesOf(outcome);
    const reader = await PDFDocument.load(bytes);
    expect(reader.isEncrypted).toBe(false);
    expect(outcome.message).toMatch(/no \/Encrypt entry and no password/i);

    const plain = await run('remove-restrictions', {}, [pdfFile(await plainFixture(), 'plain.pdf')]);
    expect(plain.message).toMatch(/nothing was restricting it/i);
    expect(plain.warnings.join(' ')).toMatch(/no \/Encrypt entry/i);
  }, 120_000);

  it('reports the restrictions a file really carries in View Metadata', async () => {
    const locked = await bytesOf(await run('protect', { ...PROTECTION_DEFAULTS, version: '5', allowCopying: false, allowAssembling: false }));
    const outcome = await run('view-metadata', {}, [pdfFile(locked, 'locked.pdf')], 'hunter2');
    const protection = outcome.report?.sections.find((section) => section.title === 'Protection');
    expect(protection, 'the report must have a Protection section').toBeTruthy();
    const rows = new Map(protection!.rows!.map((row) => [row.label, row.value]));
    expect(rows.get('Encrypted')).toBe('yes');
    expect(rows.get('Cipher')).toBe('AES-256');
    expect(rows.get('Restrictions recorded')).toMatch(/copying blocked/);
    expect(rows.get('Restrictions recorded')).toMatch(/page assembly blocked/);
    expect(outputIsHonest(rows.get('Enforced by') ?? '')).toBe(true);
    expect(outcome.warnings.join(' ')).toMatch(/AES-256/);
  }, 120_000);
});

/** Restrictions are a request, not encryption; the report has to say that. */
function outputIsHonest(enforcedBy: string): boolean {
  return /honour|reader/i.test(enforcedBy) && /not a guarantee|polite|request/i.test(enforcedBy);
}

describe('redact-pdf destroys the text it covers (E6, E13)', () => {
  it('deletes the glyphs from page content and from nested form XObjects', async () => {
    const source = await redactionFixture();
    const before = await readableText(source);
    expect(before).toContain('Zephyr Bravo Content');
    expect(before).toContain('Yankee Charlie Text');
    // The premise of the test, pinned: the second string is reachable only by
    // reading a Form XObject, and only through a second, nested one.
    expect(await formStreamText(source)).toContain('Yankee Charlie Text');

    const outcome = await run('redact-pdf', {
      fill: '#000000',
      alsoMetadata: false,
      regions: [
        { page: 0, x: 40, y: 580, width: 320, height: 30 },
        { page: 0, x: 40, y: 80, width: 320, height: 40 },
      ],
    }, [pdfFile(source, 'contract.pdf')]);

    const after = await readableText(await bytesOf(outcome));
    // Not covered: gone. A black rectangle that hides selectable text is the
    // failure mode this tool exists to avoid.
    expect(after).not.toContain('Zephyr Bravo Content');
    expect(after).not.toContain('Yankee Charlie Text');
    expect(await formStreamText(await bytesOf(outcome))).not.toContain('Yankee Charlie Text');
    expect(outcome.message).toMatch(/deleting the glyphs themselves/i);
    // The fill was still painted, so the page looks redacted.
    expect(after).toMatch(/re\s+f/);
  }, 120_000);

  it('leaves text outside the marked areas alone', async () => {
    const source = await redactionFixture();
    const outcome = await run('redact-pdf', {
      fill: '#000000',
      alsoMetadata: false,
      regions: [{ page: 0, x: 40, y: 580, width: 320, height: 30 }],
    }, [pdfFile(source, 'contract.pdf')]);
    const after = await readableText(await bytesOf(outcome));
    expect(after).not.toContain('Zephyr Bravo Content');
    expect(after).toContain('Yankee Charlie Text');
  }, 120_000);

  it('says when nothing was actually removed instead of reporting a redaction', async () => {
    const source = await redactionFixture();
    const outcome = await run('redact-pdf', {
      fill: '#000000',
      alsoMetadata: false,
      regions: [{ page: 0, x: 40, y: 200, width: 320, height: 20 }],
    }, [pdfFile(source, 'contract.pdf')]);
    expect(outcome.message).toMatch(/none of them held text|nothing was deleted/i);
    expect(outcome.message).not.toMatch(/deleting the glyphs/i);
  }, 120_000);

  it('skips zero-area marks and names how many (E13)', async () => {
    const source = await redactionFixture();
    const outcome = await run('redact-pdf', {
      fill: '#000000',
      alsoMetadata: false,
      regions: [
        { page: 0, x: 40, y: 580, width: 320, height: 30 },
        { page: 0, x: 100, y: 400, width: 0, height: 0 },
      ],
    }, [pdfFile(source, 'contract.pdf')]);
    expect(outcome.warnings.join(' ')).toMatch(/1 marked area|no width or height/i);
  }, 120_000);

  it('rejects a mark on a page the document does not have (E6)', async () => {
    const source = await redactionFixture();
    await expect(
      run('redact-pdf', { fill: '#000000', regions: [{ page: 4, x: 10, y: 10, width: 40, height: 20 }] }, [pdfFile(source, 'one-page.pdf')]),
    ).rejects.toThrow(/this document has 1 page/i);
  }, 120_000);

  it('refuses to run with no marks at all (E18)', async () => {
    const source = await redactionFixture();
    await expect(run('redact-pdf', { fill: '#000000' }, [pdfFile(source, 'contract.pdf')]))
      .rejects.toThrow(/at least one redaction rectangle/i);
  }, 120_000);

  it('admits that text held outside the page content is out of reach (E20)', async () => {
    const doc = await PDFDocument.load(await redactionFixture());
    doc.setTitle('Zephyr Bravo Content');
    doc.setKeywords(['Zephyr', 'Bravo']);
    const { writeOutline } = await import('@/lib/pdf/core/bookmarks');
    writeOutline(doc, [{ title: 'Yankee Charlie Text', page: 0 }]);
    const source = await doc.save({ useObjectStreams: false });
    const outcome = await run('redact-pdf', {
      fill: '#000000',
      alsoMetadata: true,
      regions: [{ page: 0, x: 40, y: 580, width: 320, height: 30 }],
    }, [pdfFile(source, 'contract.pdf')]);
    const warnings = outcome.warnings.join(' ');
    expect(warnings).toMatch(/document propert/i);
    expect(warnings).toMatch(/bookmark/i);
    expect(warnings).toMatch(/Remove Metadata/i);
  }, 120_000);
});

describe('signature tools distinguish valid, tampered and unsigned', () => {
  const signValues = () => ({
    certificate: [{ name: 'cert.pem', mimeType: 'application/x-pem-file', bytes: encoder.encode(certificate.certificatePem), size: certificate.certificatePem.length }],
    privateKey: [{ name: 'key.pem', mimeType: 'application/x-pem-file', bytes: encoder.encode(certificate.privateKeyPem), size: certificate.privateKeyPem.length }],
    passphrase: '',
    visible: false,
    fieldName: 'Sig1',
  });

  it('says plainly that an unsigned document is unsigned — without throwing', async () => {
    // A document with an empty AcroForm is the common case, and the reader used
    // to die on it instead of answering.
    const noFields = await plainFixture();
    const outcome = await run('validate-signature-pdf', {}, [pdfFile(noFields, 'unsigned.pdf')]);
    expect(outcome.report?.message).toMatch(/no digital signature found/i);
    expect(outcome.report?.sections[0].rows?.[0].value).toMatch(/nobody has signed it/i);
  }, 120_000);

  it('reports a signature field with no value as unreadable, never as signed', async () => {
    // The fork has no `createSignatureField`, so the field is written the way a
    // form designer leaves it: a `/Sig` widget in `AcroForm /Fields`, no `/V`.
    const doc = await PDFDocument.load(await plainFixture(1));
    const field = doc.context.register(doc.context.obj({
      Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: 'Signature1', Rect: [0, 0, 100, 50],
    }));
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [field] }));
    const bytes = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });

    const outcome = await run('validate-signature-pdf', {}, [pdfFile(bytes, 'draft.pdf')]);
    expect(outcome.report?.message).toMatch(/1 could not be read at all/i);
    expect(outcome.report?.message).not.toMatch(/All 1 signature\(s\) verify/i);
    const rows = new Map(outcome.report?.sections[0].rows?.map((row) => [row.label, row.value]));
    expect(rows.get('Byte range intact')).toMatch(/^Not checked/);
  }, 120_000);

  it('signs, reads the signature back, and calls it intact', async () => {
    const signed = await run('digital-sign-pdf', signValues(), [pdfFile(await plainFixture(), 'contract.pdf')]);
    const bytes = await bytesOf(signed);
    expect(signed.message).toMatch(/Signed as BrowserSnip Edge Tester/);
    expect(signed.message).toMatch(/verifies against it/);
    expect(signed.warnings.join(' ')).not.toMatch(/could not be read back|does not verify/i);

    const outcome = await run('validate-signature-pdf', {}, [pdfFile(bytes, 'contract_signed.pdf')]);
    expect(outcome.report?.message).toMatch(/All 1 signature\(s\) verify/i);
    const rows = new Map(outcome.report?.sections[0].rows?.map((row) => [row.label, row.value]));
    expect(rows.get('Byte range intact')).toMatch(/^Yes/);
    expect(rows.get('Signer')).toBe('BrowserSnip Edge Tester');
    expect(rows.get('Revocation')).toMatch(/not checked offline/i);
    // Integrity is not identity: the caveat has to be on the record.
    expect(outcome.warnings.join(' ')).toMatch(/not confirm the signer is trusted|does not confirm/i);
  }, 180_000);

  it('calls a byte edited after signing a broken signature', async () => {
    const bytes = await bytesOf(await run('digital-sign-pdf', signValues(), [pdfFile(await plainFixture(), 'contract.pdf')]));
    const [signature] = await readSignatures(bytes);
    const [offsetA, lengthA] = signature.byteRange!;
    const tampered = new Uint8Array(bytes);
    const index = offsetA + Math.floor(lengthA / 2);
    tampered[index] = tampered[index] === 0xff ? 0x00 : tampered[index] + 1;

    const outcome = await run('validate-signature-pdf', {}, [pdfFile(tampered, 'tampered.pdf')]);
    expect(outcome.report?.message).toMatch(/0 of 1 signature\(s\) verify; 1 were broken/i);
    const rows = new Map(outcome.report?.sections[0].rows?.map((row) => [row.label, row.value]));
    expect(rows.get('Byte range intact')).toMatch(/^No — the file was modified after signing/);
  }, 180_000);

  it('detects a document that was re-saved by this app after signing', async () => {
    const bytes = await bytesOf(await run('digital-sign-pdf', signValues(), [pdfFile(await plainFixture(), 'contract.pdf')]));
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    doc.addPage([595, 842]);
    const edited = await doc.save({ useObjectStreams: false });
    const outcome = await run('validate-signature-pdf', {}, [pdfFile(edited, 'edited.pdf')]);
    expect(outcome.report?.message).toMatch(/broken by an edit after signing/i);
  }, 180_000);

  it('rejects a visible signature on a page the document does not have (E6)', async () => {
    await expect(
      run('digital-sign-pdf', { ...signValues(), visible: true, page: 9 }, [pdfFile(await plainFixture(1), 'one.pdf')]),
    ).rejects.toThrow(/between 1 and 1|this document has 1 page/i);
  }, 180_000);

  it('refuses to timestamp a file that was never signed (E13)', async () => {
    await expect(run('timestamp-pdf', { tsa: 'http://ts.invalid/tsa' }, [pdfFile(await plainFixture(), 'unsigned.pdf')]))
      .rejects.toThrow(/no digital signature to timestamp[\s\S]*Run Digital Signature/i);
  }, 120_000);

  it('says which step failed when a signature cannot be timestamped (E20)', async () => {
    const bytes = await bytesOf(await run('digital-sign-pdf', signValues(), [pdfFile(await plainFixture(), 'contract.pdf')]));
    const calls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    try {
      let message = '';
      try {
        await run('timestamp-pdf', { tsa: 'http://timestamp.example.gov/rfc3161' }, [pdfFile(bytes, 'signed.pdf')]);
      } catch (error) {
        message = (error as Error).message;
      }
      // Either the authority was contacted and refused, or the signature could
      // not be read well enough to ask it. What must not happen is a confident
      // "Timestamped at …" for a file that gained no timestamp.
      expect(message).toMatch(/could not be reached|could not be read by the timestamp step/i);
      expect(message).not.toMatch(/Timestamped at/i);
      if (calls.length === 0) {
        expect(message).toMatch(/nothing was changed|untimed signature/i);
      } else {
        expect(calls[0]).toBe('http://timestamp.example.gov/rfc3161');
        expect(message).toMatch(/only step in BrowserSnip that needs the network/i);
      }
    } finally {
      globalThis.fetch = real;
    }
    // The signature itself is still intact after the failed attempt.
    const verified = await run('validate-signature-pdf', {}, [pdfFile(bytes, 'signed.pdf')]);
    expect(verified.report?.message).toMatch(/verify/i);
  }, 180_000);
});

describe('the rest of the category keeps its promises', () => {
  it('flatten-pdf counts annotations and form fields separately (E13)', async () => {
    const doc = await PDFDocument.load(await loadedFixture());
    const source = await doc.save({ useObjectStreams: false });
    const outcome = await run('flatten-pdf', { forms: true, annotations: false, keepLinks: true, dpi: 200 }, [pdfFile(source, 'form.pdf')]);
    const message = outcome.message ?? '';
    expect(message).not.toMatch(/\[object Object\]/);
    expect(message).toMatch(/2 form field\(s\)/);
    expect(outcome.warnings.join(' ')).toMatch(/annotation flattening was off/i);
    const bytes = await bytesOf(outcome);
    const flattened = await PDFDocument.load(bytes);
    expect(flattened.getPageCount()).toBe(1);
    expect(flattened.getForm().getFields()).toHaveLength(0);
  }, 120_000);

  it('remove-metadata does not claim settings that were never there (E13)', async () => {
    const doc = await PDFDocument.load(await plainFixture());
    doc.setProducer('Some Producer');
    const source = await doc.save({ useObjectStreams: false });
    const outcome = await run('remove-metadata', { info: true, xmp: true, attachments: true, readerSettings: true }, [pdfFile(source, 'clean.pdf')]);
    expect(outcome.message).toMatch(/Removed \d propert/);
    expect(outcome.message).not.toMatch(/reader settings/i);

    const already = await run('remove-metadata', { info: true, xmp: true, attachments: true, readerSettings: true }, [pdfFile(await bytesOf(outcome), 'clean_stripped.pdf')]);
    expect(already.message).toMatch(/Nothing was removed/i);
    expect(already.warnings.join(' ')).toMatch(/the output is the same document/i);
  }, 120_000);

  it('edit-attachments names the attachments it could not find (E13)', async () => {
    const doc = await PDFDocument.load(await loadedFixture());
    const source = await doc.save({ useObjectStreams: false });
    const outcome = await run('edit-attachments', { remove: 'source.csv, ghost.pdf' }, [pdfFile(source, 'with-files.pdf')]);
    expect(outcome.message).toMatch(/Removed 1 of 2 requested/);
    expect(outcome.warnings.join(' ')).toMatch(/"ghost\.pdf" is not embedded/i);

    const none = await run('edit-attachments', { remove: 'nobody-here.pdf' }, [pdfFile(source, 'with-files.pdf')]);
    expect(none.warnings.join(' ')).toMatch(/None of the names you listed matched/i);
  }, 120_000);

  it('extract-attachments reports an empty document instead of an empty download (E13)', async () => {
    const outcome = await run('extract-attachments', {}, [pdfFile(await plainFixture(), 'plain.pdf')]);
    expect(outcome.report?.message).toMatch(/No attachments found/i);
    expect(outcome.report?.sections[0].rows?.[0].value).toMatch(/contains no embedded files/i);
    expect(outcome.outputs.length).toBe(0);
  }, 120_000);

  it('edit-attachments says so when there is nothing to edit (E13)', async () => {
    await expect(run('edit-attachments', { remove: 'anything.pdf' }, [pdfFile(await plainFixture(), 'plain.pdf')]))
      .rejects.toThrow(/no attachments to edit/i);
  }, 120_000);

  it('compare-pdfs refuses anything but exactly two documents (E18)', async () => {
    const tool = getPdfTool('compare-pdfs')!;
    expect(tool.validate!({ mode: 'text' }, { fileCount: 1 })).toMatch(/exactly two/i);
    expect(tool.validate!({ mode: 'text' }, { fileCount: 2 })).toBeNull();
  });

  it('compare-pdfs says "no differences" only after reading both files (E13)', async () => {
    const same = await redactionFixture();
    const outcome = await run(
      'compare-pdfs',
      { mode: 'text', dpi: 96, sensitivity: 24 },
      [pdfFile(same, 'a.pdf'), pdfFile(same, 'b.pdf')],
    );
    expect(outcome.report?.message).toMatch(/No differences found across 1 page/i);
    expect(outcome.report?.sections[0].rows?.[0].value).toMatch(/identical text/i);

    // A second document whose text really differs must not read as a match.
    const other = await plainFixture(1);
    const second = await run(
      'compare-pdfs',
      { mode: 'text', dpi: 96, sensitivity: 24 },
      [pdfFile(same, 'a.pdf'), pdfFile(other, 'b.pdf')],
    );
    expect(second.report?.message).toMatch(/1 of 1 page\(s\) differ/i);
    expect(second.report?.sections[0].rows?.[0].value).toMatch(/text differs/i);
  }, 120_000);

  it('keeps the category offline: no optional engine, one named network step (E20)', () => {
    // Every security tool runs in this tab. If one ever needs PyMuPDF or
    // Ghostscript it must say so, and the rule is cheap to hold here.
    const engineBound = securityTools.filter((tool) => (tool.engines ?? []).length > 0);
    expect(engineBound.map((tool) => tool.id)).toEqual([]);
        expect(securityTools.every((tool) => Boolean(tool.run) || Boolean(tool.unavailable))).toBe(true);

    // The one step that leaves the device is named as such, in the field the
    // user types the address into. Revocation being out of reach offline is
    // asserted as its own report row in the valid-signature test above.
    const tsa = getPdfTool('timestamp-pdf')!.fields?.find((field) => field.key === 'tsa');
    expect(tsa?.help).toMatch(/network/i);
  });
});
