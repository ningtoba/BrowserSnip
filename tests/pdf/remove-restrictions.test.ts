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
      `Restrictions cleared — ${PAGES} page(s) verified readable with no /Encrypt entry and no password needed, `
      + 'carrying 1 bookmark(s).',
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

/* ── 3. the siblings, on the same fixtures ───────────────────────────────── */

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
});
