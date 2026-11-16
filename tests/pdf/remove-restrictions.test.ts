/**
 * `remove-restrictions`, on files somebody else locked.
 *
 * The row this file retires (`docs/TOOL-TRIAGE.md`, ERRORS 2) measured a build
 * from before the read path existed: every password-protected file answered
 * *"is password protected. Enter the password for X and run again."* with no blob,
 * and the tool declared no field to type the answer into. Both halves have since
 * closed — `core/crypto.ts` undoes RC4-128, AES-128 and AES-256 (`/R 6`) on load,
 * and the file's own card carries one password box for every tool that declares no
 * field of its own. A ledger row is a hypothesis about an old build, so this is the
 * pin against the one change that would quietly re-break it: `classifyEncryption`
 * answering `supported: false` for a strength it used to allow.
 *
 * One strength per case, from both outside producers, as a **user-password** file
 * and as an **owner-only** one. Fixtures are the files in
 * `tests/fixtures/encrypted/` — written by libqpdf and MuPDF over one base document
 * whose three sheets each carry the same planted sentence — because a document this
 * app locked is evidence about a gate only, and its own reader always agrees with it.
 *
 * What the copy owes, read off the copy:
 *
 *   * **fully open, not "restricted but readable"** — the `/Encrypt` entry itself is
 *     gone (no trailer reference, no inlined dictionary, and with them `/CFM`,
 *     `/StmF`, `/StrF` and `/P`), so there is no password left to type and no owner
 *     key left to honour. Removing restrictions here means removing the dictionary;
 *     `change-permissions` is the sibling that rewrites `/P` and keeps the
 *     dictionary, and its test below pins the difference rather than blurring it.
 *   * **it opens** — `PDFDocument.load` with no options, and pdf.js with no
 *     password: both see three pages. pdf.js implements these ciphers itself, so it
 *     is a reader, not this app's writer reading its own output.
 *   * **the content is intact** — each sheet still yields the planted sentence and
 *     its own sheet word. A page count that survives while the words go missing is
 *     the failure this campaign chases.
 *   * **the card says that and nothing stronger** — no cipher named (the copy
 *     carries none), no secret quoted, nothing admitted as lost.
 *
 * The outside half of the evidence — MuPDF, libqpdf and pypdf over these same
 * produced files — is `docs/research/remove-restrictions-readers.py`, with its log
 * kept beside it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef } from '@maxwbh/pdf-lib';
import { ToolInputError, inspectPdf, isToolInputError } from '@/lib/pdf/core/guard';
import { openRender } from '@/lib/pdf/core/render';
import { runPdfTool, takesPasswordInput } from '@/lib/pdf/tools/runner';
import { getPdfTool } from '@/lib/pdf/tools/registry';
import type { ToolValues } from '@/lib/pdf/tools/types';

const FIXTURES = resolve(process.cwd(), 'tests/fixtures/encrypted');
/** The secret every `*-user` fixture carries; the `*-owner` pair has an empty one. */
const PASSWORD = 'hunter2';
const PLANTED = 'Lighthouse Inventory 1887';
const SHEETS = ['ALPHA', 'BRAVO', 'CHARLIE'];
const PAGES = 3;
/** `/P` on every locked fixture: copy and accessibility allowed, the rest refused. */
const SOURCE_PERMISSIONS = -3376;

beforeAll(() => {
  // The same shim the other security files carry: pdf.js hands Node an `http://`
  // worker URL it refuses, and `openRender` re-assigns `workerSrc` on each call.
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
const fixtureBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)));
const fileOf = (bytes: Uint8Array, name: string): File =>
  new File([new Uint8Array(bytes) as BlobPart], name, { type: 'application/pdf' });

/** One outside-locked fixture, with what its own dictionary claims. */
interface Locked {
  name: string;
  producer: 'libqpdf' | 'MuPDF';
  strength: 'RC4-128' | 'AES-128' | 'AES-256';
  revision: 3 | 4 | 6;
  /** The user secret. Empty means an owner-only file: openable by anybody. */
  secret: string;
}

const LOCKED: Locked[] = [
  { name: 'rc4-128-user.pdf', producer: 'libqpdf', strength: 'RC4-128', revision: 3, secret: PASSWORD },
  { name: 'rc4-128-owner.pdf', producer: 'libqpdf', strength: 'RC4-128', revision: 3, secret: '' },
  { name: 'mu-rc4-128-user.pdf', producer: 'MuPDF', strength: 'RC4-128', revision: 3, secret: PASSWORD },
  { name: 'aes-128-user.pdf', producer: 'libqpdf', strength: 'AES-128', revision: 4, secret: PASSWORD },
  { name: 'mu-aes-128-user.pdf', producer: 'MuPDF', strength: 'AES-128', revision: 4, secret: PASSWORD },
  { name: 'aes-256-user.pdf', producer: 'libqpdf', strength: 'AES-256', revision: 6, secret: PASSWORD },
  { name: 'aes-256-owner.pdf', producer: 'libqpdf', strength: 'AES-256', revision: 6, secret: '' },
  { name: 'mu-aes-256-user.pdf', producer: 'MuPDF', strength: 'AES-256', revision: 6, secret: PASSWORD },
  { name: 'mu-aes-256-owner.pdf', producer: 'MuPDF', strength: 'AES-256', revision: 6, secret: '' },
];

/** The fixture that carries a strength *and* a typed secret, one per strength. */
const lockedWith = (strength: Locked['strength']): Locked =>
  LOCKED.find((entry) => entry.strength === strength && entry.secret !== '') as Locked;

/** One run through the shipped runner, which is the seam where the guard lives. */
async function run(toolId: string, values: ToolValues, fixture: Pick<Locked, 'name' | 'secret'>, password?: string) {
  expect(getPdfTool(toolId), `tool "${toolId}" is not registered`).toBeTruthy();
  const secret = password ?? (fixture.secret || undefined);
  return runPdfTool({
    toolId,
    files: [fileOf(fixtureBytes(fixture.name), fixture.name)],
    values,
    password: secret,
    onProgress: () => undefined,
    onLog: () => undefined,
  });
}

/** The bytes a user would download, plus the name they would download them as. */
async function produced(outcome: Awaited<ReturnType<typeof run>>) {
  expect(outcome.outputs, 'the tool produced no file').toHaveLength(1);
  return {
    bytes: new Uint8Array(await outcome.outputs[0].blob.arrayBuffer()),
    name: outcome.outputs[0].name,
  };
}

/** What pdf.js — a reader that implements these ciphers itself — makes of a file. */
async function readerView(bytes: Uint8Array, password?: string) {
  const session = await openRender(bytes, password ? { password } : {});
  try {
    const pages: string[] = [];
    for (let index = 1; index <= session.numPages; index++) {
      pages.push((await session.textItems(index)).map((item) => item.str).join(' '));
    }
    return { count: session.numPages, pages };
  } finally {
    await session.destroy();
  }
}

/** An inspector for the bytes, `null` when they carry no dictionary to inspect. */
const inspector = async (bytes: Uint8Array) => {
  const view = await inspectPdf(bytes, 'copy.pdf');
  return view.encrypted ? view : null;
};

/* ── 1. the refusal the row measured is gone ─────────────────────────────── */

describe('removing restrictions from a locked file', () => {
  it('hands back a file at every strength, where the row measured a refusal', async () => {
    // One line per strength: the bug this row describes is a refusal, and a guard
    // that re-breaks exactly one cipher should redden exactly one line.
    for (const strength of ['RC4-128', 'AES-128', 'AES-256'] as const) {
      const fixture = lockedWith(strength);
      const outcome = await run('remove-restrictions', {}, fixture).catch((caught: unknown) => caught);
      expect(
        isToolInputError(outcome),
        `${strength}: ${fixture.name} was refused with "${(outcome as Error).message}"`,
      ).toBe(false);
      expect((outcome as Awaited<ReturnType<typeof run>>).outputs.length, `${strength}: no file came back`).toBe(1);
    }
  }, 600_000);

  it.each(LOCKED)('drops the whole dictionary from $name, not just its password', async (fixture) => {
    const outcome = await run('remove-restrictions', {}, fixture);
    const { bytes, name: download } = await produced(outcome);
    const raw = latin1(bytes);
    // Both spellings of the trailer entry, and every key that only exists inside
    // the dictionary it points at. `/P` is the one a reader honours, so its absence
    // is what makes "every restriction lifted" true rather than hopeful.
    expect(raw).not.toMatch(/\/Encrypt[\s<\d]/);
    expect(raw).not.toMatch(/\/CFM/);
    expect(raw).not.toMatch(/\/StmF|\/StrF/);
    expect(raw).not.toMatch(/\/P\s+-?\d+/);

    const after = await inspectPdf(bytes, fixture.name);
    expect(after.encrypted, `${fixture.name} is still reported as encrypted`).toBe(false);
    expect(after.encryption).toMatchObject({ state: 'none', algorithm: null, supported: true, refusal: null });
    expect(after.permissions, 'a copy with no dictionary has no /P to decode').toBeNull();
    expect(after.needsPassword).toBe(false);
    expect(after.error).toBeNull();
    // The secret the user typed is in neither thing they receive.
    expect(raw).not.toContain(PASSWORD);
    expect(download).not.toContain(PASSWORD);
  }, 600_000);

  it.each(LOCKED)('leaves $name open to a reader handed nothing', async (fixture) => {
    const outcome = await run('remove-restrictions', {}, fixture);
    const { bytes } = await produced(outcome);
    // A bare `PDFDocument.load` throws on any `/Encrypt` entry, so getting through
    // it is the dictionary being gone rather than the prompt being skipped.
    await expect(PDFDocument.load(bytes)).resolves.toBeTruthy();
    const seen = await readerView(bytes);
    expect(seen.count, 'the copy lost a sheet').toBe(PAGES);
    seen.pages.forEach((page, index) => {
      expect(page, `sheet ${index + 1} lost the planted sentence`).toContain(PLANTED);
      expect(page, `sheet ${index + 1} lost its own word`).toContain(SHEETS[index]);
    });
  }, 600_000);

  it.each(LOCKED)('says of $name exactly what the bytes did', async (fixture) => {
    const before = await inspectPdf(fixtureBytes(fixture.name), fixture.name, fixture.secret ? { password: fixture.secret } : {});
    expect(before.encrypted, `${fixture.name} is not the locked file this case needs`).toBe(true);
    expect(before.algorithm, `${fixture.name} is not the strength named here`).toBe(fixture.strength);
    expect(before.encryption?.revision, `${fixture.name} is not the revision named here`).toBe(fixture.revision);

    const outcome = await run('remove-restrictions', {}, fixture);
    const { bytes } = await produced(outcome);
    expect(outcome.pagesOut).toBe(PAGES);
    // The bookmark figure is the app's own top-level census: the fixture's outline
    // is one heading with one child, so the card says 1 where MuPDF's flattened
    // `get_toc()` says 2. Under-claiming about what survived, in the same direction
    // on the input, and pinned here so a change to either number is a decision.
    expect(outcome.message).toBe(
      `Restrictions cleared — the source refused printing, editing, comments and form filling, `
      + `filling existing forms and rotating and inserting pages; ${PAGES} page(s) verified readable with no /Encrypt `
      + 'entry and no password needed, carrying 1 bookmark(s).',
    );
    // Nothing stronger than "the dictionary is gone": no cipher named, because the
    // copy carries none; no password promised, because none is left to promise.
    expect(outcome.message).not.toMatch(/AES-|RC4-|crypt filter|revision \d/i);
    expect(outcome.message).not.toMatch(/still needs|with the password|opens with its/i);
    expect(outcome.message).not.toContain(PASSWORD);
    // The counts come off the saved copy, so each one is a claim; the warnings are
    // where a loss this run caused has to be admitted, and here there is none.
    expect(outcome.warnings, outcome.warnings.join(' / ')).toEqual([]);
    expect((await readerView(bytes)).count).toBe(before.pages);
  }, 600_000);
});

/* ── 2. what still refuses, and which seam does it ───────────────────────── */

describe('the refusals that remain are the guard naming a cipher, not the tool', () => {
  it('asks for the password of a user-password file, in the box on its own card', async () => {
    // Nothing typed on a file whose *user* secret is not empty is a question about
    // that file, not a refusal of it — and the answer has somewhere to go, which is
    // the half of the triage row the file-row password box retired.
    expect(takesPasswordInput(getPdfTool('remove-restrictions')), 'the tool declares a box of its own').toBe(false);
    const error = await run('remove-restrictions', {}, lockedWith('AES-256'), '').then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(isToolInputError(error)).toBe(true);
    const refusal = error as ToolInputError;
    expect(refusal.code).toBe('PASSWORD_REQUIRED');
    expect(refusal.passwordRequired).toBe(true);
    expect(refusal.message).toContain('aes-256-user.pdf');
    expect(refusal.hint).toMatch(/Enter the password for "aes-256-user.pdf"/);
    expect(refusal.message).not.toContain(PASSWORD);
  }, 300_000);

  it('refuses a revision it cannot derive, by name, from the pre-flight', async () => {
    // `/R 6` is the AES-256 handler this app reads; `/R 5` is the same cipher under
    // a handler it does not. The refusal is `core/guard.ts`'s, before the tool runs,
    // and it blames the cipher rather than the password the user did type.
    const doc = await PDFDocument.load(fixtureBytes('aes-256-user.pdf'), { ignoreEncryption: true, updateMetadata: false });
    const entry = doc.context.trailerInfo.Encrypt;
    const dict = entry instanceof PDFRef ? doc.context.lookupMaybe(entry, PDFDict) : entry;
    expect(dict, 'the fixture carries no /Encrypt dictionary').toBeInstanceOf(PDFDict);
    (dict as PDFDict).set(PDFName.of('R'), PDFNumber.of(5));
    const bytes = new Uint8Array(await doc.save({ useObjectStreams: false }));

    const error = await runPdfTool({
      toolId: 'remove-restrictions',
      files: [fileOf(bytes, 'aes-256-r5.pdf')],
      values: {},
      password: PASSWORD,
      onProgress: () => undefined,
      onLog: () => undefined,
    }).then(() => null, (caught: unknown) => caught);
    expect(isToolInputError(error), 'the mutated file was accepted, so the guard is not what refuses').toBe(true);
    const refusal = error as ToolInputError;
    expect(refusal.code).toBe('UNSUPPORTED');
    expect(refusal.passwordRequired).toBe(false);
    expect(refusal.message).toContain('AES-256 (crypt filter /StdCF, revision 5)');
    expect(refusal.message).toMatch(/stored as ciphertext/);
  }, 300_000);

  it('returns a file with no dictionary unchanged, and says nothing was removed', async () => {
    const outcome = await run('remove-restrictions', {}, { name: 'plain.pdf', secret: '' });
    expect(outcome.message).toMatch(/has no encryption dictionary, so nothing was restricting it/);
    expect(outcome.warnings.join(' ')).toMatch(/no \/Encrypt entry/);
    const { bytes } = await produced(outcome);
    expect(bytes).toEqual(fixtureBytes('plain.pdf'));
  }, 300_000);
});

/* ── 3. what was restricted, said apart from what was decrypted ───────────── */

describe('the sentence names the restriction the source carried, not a blanket removal', () => {
  // The tool lifts restrictions by dropping the dictionary, so its output is fully
  // open whatever the source refused — page count, `/P -4` and "no /Encrypt" are
  // identical on both files below. Before this pin the card said
  // "Restrictions cleared" over a dictionary that refused nothing at all, in exactly
  // the words it used for one that denied printing and editing: the file on the
  // screen could not be told from the output. A restriction-only file whose `/P` is
  // `-4` is the case the round brief asks about — it must not claim a restriction
  // that was not there while its rewrite is still right.
  // Nothing typed: a restriction-only file opens on the empty user secret, and
  // "the run asked for no password" is part of what is being pinned.
  const restrictionOnly = (name: string) => ({ name, secret: '' });

  it('names printing and editing when the dictionary refuses them', async () => {
    const outcome = await run('remove-restrictions', {}, restrictionOnly('restrict-none-aes-128.pdf'));
    expect(outcome.message).toContain(
      'the source refused printing, editing, comments and form filling, filling existing forms '
      + 'and rotating and inserting pages',
    );
    expect(outcome.message).not.toMatch(/refused nothing/);
    expect(outcome.message).toMatch(/no \/Encrypt entry and no password needed/);
  }, 600_000);

  it('says nothing was refused when the dictionary refuses nothing, and names what it did remove', async () => {
    const outcome = await run('remove-restrictions', {}, restrictionOnly('restrict-open-aes-128.pdf'));
    expect(outcome.message).toMatch(/the source refused nothing \(every permission was already allowed\)/);
    expect(outcome.message).toMatch(/what this run removed is its encryption and owner key/);
    expect(outcome.message).not.toMatch(/refused printing/);
    // Still a real change, so still a real file: the bytes are open and the words are
    // on the sheets. The claim that nothing was restricted must not cost the removal.
    const { bytes } = await produced(outcome);
    expect(latin1(bytes)).not.toMatch(/\/Encrypt[\s<\d]/);
    expect(latin1(bytes)).not.toMatch(/\/P\s+-?\d+/);
    expect(await inspector(bytes)).toBeNull();
    expect((await readerView(bytes)).pages.join(' ')).toContain(PLANTED);
  }, 600_000);

  it('writes the same fully-open copy in both cases, so only the sentence differs', async () => {
    // The control: if the two copies could be told apart, the source's `/P` would not
    // be the thing the sentence is about.
    const refused = await produced(await run('remove-restrictions', {}, restrictionOnly('restrict-none-aes-128.pdf')));
    const open = await produced(await run('remove-restrictions', {}, restrictionOnly('restrict-open-aes-128.pdf')));
    for (const bytes of [refused.bytes, open.bytes]) {
      const after = await inspectPdf(bytes, 'copy.pdf');
      expect(after.encrypted).toBe(false);
      expect(after.permissions).toBeNull();
      expect(after.needsPassword).toBe(false);
    }
  }, 600_000);

  it('keeps the document properties readable when the source declared /EncryptMetadata false', async () => {
    // Measured before this pin: the copy came back with `/Title` and `/Author`
    // still ciphertext — mojibake in the properties of a file whose pages were
    // perfectly restored — because the decrypt pass read "/EncryptMetadata false"
    // as "/Info is in the clear too". libqpdf ciphers `/Info` under that flag, and
    // MuPDF, pypdf and qpdf all undo it, so the app's copy was the odd one out.
    const fixture = restrictionOnly('restrict-none-aes-128-clearmeta.pdf');
    const outcome = await run('remove-restrictions', {}, fixture);
    const { bytes } = await produced(outcome);
    // The strings the fixture was written with, read back off the produced bytes.
    const doc = await PDFDocument.load(bytes);
    expect(doc.getTitle(), 'the /Title in the copy is still ciphertext').toBe('Lighthouse Inventory 1887');
    expect(doc.getAuthor(), 'the /Author in the copy is still ciphertext').toBe('unlock structure rig');
    // And the page words still came through, so the properties are not a lone win.
    expect((await readerView(bytes)).pages.join(' ')).toContain('Structure sheet 1');
  }, 600_000);

  it('still returns a file with no dictionary unchanged, so the two controls stay apart', async () => {
    // The other side of "refused nothing": no dictionary at all is a different case,
    // and it is answered by a message, not by a rewrite.
    const outcome = await run('remove-restrictions', {}, { name: 'plain.pdf', secret: '' });
    expect(outcome.message).toMatch(/has no encryption dictionary, so nothing was restricting it/);
    expect(outcome.message).not.toMatch(/the source refused/);
  }, 300_000);
});

/* ── 4. the siblings, on the same fixtures ───────────────────────────────── */

describe('the sibling entries still do what their names say', () => {
  it('unlock removes the password as completely as restrictions are removed', async () => {
    for (const strength of ['RC4-128', 'AES-128', 'AES-256'] as const) {
      const fixture = lockedWith(strength);
      // Typed through the tool's own field, which is where `unlock` asks.
      const outcome = await run('unlock', { password: fixture.secret }, fixture);
      const { bytes } = await produced(outcome);
      expect(latin1(bytes), `${strength}: unlock left an /Encrypt entry`).not.toMatch(/\/Encrypt[\s<\d]/);
      const seen = await readerView(bytes);
      expect(seen.count, `${strength}: unlock lost a sheet`).toBe(PAGES);
      expect(seen.pages.join(' '), `${strength}: unlock lost the words`).toContain(PLANTED);
      expect(outcome.message).toMatch(/opens without a password now/);
      expect(outcome.message).not.toContain(PASSWORD);
    }
  }, 900_000);

  it('change-permissions rewrites /P and keeps the dictionary it rewrote', async () => {
    // The contrast the tool's name rests on: the restrictions change, the password
    // does not go with them. A card here that said "unlocked" would be the same
    // failure the triage row suspected, so the surviving dictionary is the pin.
    const fixture = lockedWith('AES-256');
    const outcome = await run('change-permissions', {
      action: 'set',
      ownerPassword: PASSWORD,
      allowPrinting: true,
      printLevel: 'high',
      allowCopying: false,
    }, fixture);
    const { bytes } = await produced(outcome);
    const raw = latin1(bytes);
    expect(raw).toMatch(/\/Encrypt\s+\d+\s+\d+\s+R|\/Encrypt</);
    const recorded = /\/P\s+(-?\d+)/.exec(raw);
    expect(recorded, 'the copy carries no /P to compare').not.toBeNull();
    expect(Number(recorded?.[1]), '/P came back the value the source carried').not.toBe(SOURCE_PERMISSIONS);

    const after = await inspectPdf(bytes, fixture.name);
    expect(after.encrypted, 'the dictionary the tool just wrote is not in the file').toBe(true);
    expect(after.permissions).toMatchObject({ printing: true, printingHighQuality: true, copying: false });
    // And the secret it set is the one that lifts them: the copy has an empty **user**
    // password, so the owner secret is answered as an owner secret. Measured here
    // because MuPDF measures it in `docs/research/remove-restrictions-readers.log`
    // (`auth=4 permissions=-4` for `hunter2`, `auth=2` with the flags in force for
    // nothing), and the card's warning claims exactly that.
    const withOwner = await inspectPdf(bytes, fixture.name, { password: PASSWORD });
    expect(withOwner.passwordAccepted, 'the owner password this run set does not open the copy').toBe(true);
    expect(withOwner.passwordLevel, 'the copy takes the typed secret as a user password').toBe('owner');
    // The words surviving the re-seal is the half no `/P` comparison can show.
    const seen = await readerView(bytes);
    expect(seen.count).toBe(PAGES);
    expect(seen.pages.join(' ')).toContain(PLANTED);
    expect(outcome.message).toMatch(/as recorded in the file/i);
    expect(outcome.warnings.join(' ')).toMatch(/replaced any protection/);
  }, 600_000);

  it('change-permissions clear is the one sibling that also removes the password', async () => {
    const outcome = await run('change-permissions', { action: 'clear', ownerPassword: PASSWORD }, lockedWith('AES-128'));
    const { bytes } = await produced(outcome);
    expect(latin1(bytes)).not.toMatch(/\/Encrypt[\s<\d]/);
    expect(outcome.message).toMatch(/All restrictions and the password were removed/);
    expect((await readerView(bytes)).pages.join(' ')).toContain(PLANTED);
  }, 600_000);

  /* ── the strength, which this entry used to drop in silence ─────────────── */

  it('writes the strength the file arrived at, and says which one it wrote', async () => {
    // Measured before the fix (round 053): an AES-256 `/CFM /AESV3` file came back
    // `/CFM /AESV2` — a downgrade nobody asked for, on the one edit that is not
    // about strength — and the card named no cipher at all while the entry's own
    // note promised it repeated the strength read off the saved file. A permission
    // change is not a reason to weaken a file.
    const fixture = lockedWith('AES-256');
    const outcome = await run('change-permissions', {
      action: 'set', ownerPassword: PASSWORD, allowPrinting: true, printLevel: 'high', allowCopying: false,
    }, fixture);
    const { bytes } = await produced(outcome);
    const raw = latin1(bytes);
    expect(raw, 'the revision-6 cipher is gone').toMatch(/\/CFM \/AESV3/);
    expect(raw, 'the copy was downgraded to AES-128').not.toMatch(/\/CFM \/AESV2/);
    expect(raw).toMatch(/\/V 5/);
    const after = await inspectPdf(bytes, fixture.name);
    expect(after.algorithm, 'the saved dictionary is not the strength the source carried').toBe('AES-256');
    // The card names it, from the file rather than from the form.
    expect(outcome.message).toMatch(/ciphered in AES-256 \(crypt filter \/StdCF, revision 6\)/);
    expect(outcome.warnings.join(' ')).toMatch(/at the strength the file arrived at/);
    // And a revision-6 re-seal still carries the words: a strength kept over blank
    // pages would be the `encrypted-inputs` defect wearing the right dictionary.
    expect((await readerView(bytes)).pages.join(' ')).toContain(PLANTED);
  }, 600_000);

  it('falls back to AES-128 for a strength it reads but never writes, and names the change', async () => {
    // RC4-128 is readable here and unwritable, so "keep" cannot be honoured. The
    // copy must still be ciphered and the card must not claim the source's strength.
    const fixture = lockedWith('RC4-128');
    const outcome = await run('change-permissions', {
      action: 'set', ownerPassword: PASSWORD, allowCopying: false,
    }, fixture);
    const { bytes } = await produced(outcome);
    expect(latin1(bytes)).toMatch(/\/CFM \/AESV2/);
    expect(outcome.message).toMatch(/ciphered in AES-128 \(crypt filter \/StdCF, revision 4\)/);
    expect(outcome.message).not.toMatch(/RC4-128 \(/);
    expect(outcome.warnings.join(' ')).toMatch(/written at AES-128 where the file arrived at RC4-128/);
    expect((await readerView(bytes)).pages.join(' ')).toContain(PLANTED);
  }, 600_000);

  it('still lets the control override the kept strength, and says so', async () => {
    // The control is the whole point of "keep" being a value rather than a rule:
    // asking for AES-128 on an AES-256 file has to reach the bytes.
    const outcome = await run('change-permissions', {
      action: 'set', cipher: 'AES-128', ownerPassword: PASSWORD, allowCopying: false,
    }, lockedWith('AES-256'));
    const { bytes } = await produced(outcome);
    expect(latin1(bytes)).toMatch(/\/CFM \/AESV2/);
    expect(outcome.message).toMatch(/ciphered in AES-128/);
    expect(outcome.warnings.join(' ')).toMatch(/written at AES-128 where the file arrived at AES-256/);
    expect((await readerView(bytes)).pages.join(' ')).toContain(PLANTED);
  }, 600_000);
});
