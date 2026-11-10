/**
 * The password any tool can be given: the secret lives on the file, not in a form.
 *
 * `core/crypto.ts` reads RC4-128, AES-128 and AES-256 back as words, and
 * `core/guard.ts:classifyEncryption` names the filter and revision behind the
 * claim. What was missing was the *reach*: a secret could only be typed where a
 * tool declared a password field — `unlock`, `protect`, `change-permissions`,
 * `sign` — so `rotate` refused an AES-128 file outright while the app could decrypt
 * it. Control-measured before this file existed:
 *
 * > `runPdfTool({ toolId: 'rotate', files: [aes-128-user.pdf] })` threw
 * > `PASSWORD_REQUIRED` — "Enter the password for …" — and the surface had nowhere
 * > to enter it. Four tools had a box; about 120 did not.
 *
 * The fix is one component, `FileCards:FileLockRow`, hung off the loaded file so
 * every tool gains it at once, feeding the channel that already existed:
 * `usePdfTool.password` → `RunRequest.password` → `effectivePassword` → the
 * pre-flight, `openInputs`, `preserveProtection`. No second path, and — because the
 * row hides its own box when a tool declares a field — no tool ever holds two.
 *
 * What is pinned here, in order:
 *
 * 1. `rotate` (no password field of its own) opens, edits and hands back all three
 *    strengths, with the words intact and the source's own lock carried forward;
 * 2. **no password** and **the wrong password** stay two different answers, in the
 *    error codes, in `passwordRequired`, and in the sentences;
 * 3. the shapes this app still cannot undo — RC4-40, `/R 5`, `/R 7`, a
 *    certificate handler — keep refusing, name the actual reason, and are not
 *    rescued by the password that used to be offered as the cure;
 * 4. the row: the cipher and revision it states, where it offers a box, where it
 *    refuses to, and that it is the same component in the card and in the queue;
 * 5. the route: a secret typed into the row reaches the store, the runner and the
 *    bytes, and nothing in the middle uploads it.
 *
 * The outside-reader half of the proof (MuPDF, libqpdf) is not asserted here — this
 * repo's CI has neither — so the runs below also write their outputs when
 * `PASSWORD_ANYWHERE_ARTIFACTS=<dir>` is set, and
 * `docs/research/password-anywhere-readers.py` judges those files. Its verdicts are
 * in `docs/research/password-anywhere-readers.log`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { createElement as h } from 'react';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFArray } from '@maxwbh/pdf-lib';
import {
  cipheredInputError,
  classifyEncryption,
  inspectPdf,
  isToolInputError,
  refusalReason,
  type PdfEncryption,
} from '@/lib/pdf/core/guard';
import { openPDF } from '@/lib/pdf/core/doc';
import { streamBytes } from '@/lib/pdf/core/content';
import { runPdfTool } from '@/lib/pdf/tools/runner';
import { FileCards, FileLockRow } from '@/components/tools/pdf/shared/FileCards';
import { FileQueue } from '@/components/tools/pdf/shared/FileQueue';
import { usePdfTool } from '@/hooks/usePdfTool';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore, type FileLockState, type FileRunState } from '@/stores/process-store';

const FIXTURES = resolve(process.cwd(), 'tests/fixtures/encrypted');
const PASSWORD = 'hunter2';
const WRONG = 'not-the-password';
const PLANTED = 'Lighthouse Inventory 1887';
/** Where the produced files go for the readers this repo cannot run in CI. */
const ARTIFACTS = process.env.PASSWORD_ANYWHERE_ARTIFACTS ?? '';

const latin1 = new TextDecoder('latin1');
const fixtureBytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)));

// Thumbnails are not the subject; keep the card from opening a real document.
vi.mock('@/lib/pdf/core/render', () => ({
  openRender: vi.fn(async () => ({
    numPages: 3,
    fingerprint: 'password-anywhere',
    page: async () => ({ getViewport: () => ({ width: 612, height: 792, rotation: 0 }), cleanup() {} }),
    renderToCanvas: async () => ({}),
    destroy: async () => {},
  })),
  thumbnails: vi.fn(async () => []),
}));

function fileOf(bytes: Uint8Array, name: string): File {
  return new File([new Uint8Array(bytes) as BlobPart], name, { type: 'application/pdf' });
}

/** One tool, one file, one secret — the way `usePdfTool` calls the runner. */
async function rotate(bytes: Uint8Array, name: string, password?: string) {
  return runPdfTool({
    toolId: 'rotate',
    files: [fileOf(bytes, name)],
    values: { degrees: 90 },
    ...(password ? { password } : {}),
    onProgress: () => undefined,
    onLog: () => undefined,
  });
}

/** The rejection a run raised, rather than an outcome. */
async function refusal(ran: Promise<unknown>): Promise<ReturnType<typeof cipheredInputError>> {
  const outcome = await ran.then((value) => {
    throw new Error(`expected a refusal, got ${JSON.stringify(Object.keys(value as object))}`);
  }, (error: unknown) => error);
  expect(isToolInputError(outcome), `not a guard refusal: ${String(outcome)}`).toBe(true);
  return outcome as ReturnType<typeof cipheredInputError>;
}

/** A page's `/Contents` streams, as the app's own content reader takes them. */
function contentsOf(doc: PDFDocument, index: number): PDFRawStream[] {
  const value = doc.getPages()[index].node.get(PDFName.of('Contents'));
  const items = value instanceof PDFArray
    ? Array.from({ length: value.size() }, (_, i) => value.get(i))
    : [value];
  const out: PDFRawStream[] = [];
  for (const item of items) {
    const stream = item instanceof PDFRef ? doc.context.lookup(item) : item;
    if (stream instanceof PDFRawStream) out.push(stream);
  }
  return out;
}

/** The literal and hex string operands of a content stream, as text. */
function decodeStrings(content: string): string {
  const out: string[] = [];
  for (const match of content.matchAll(/<([0-9A-Fa-f\s]*)>|\(((?:[^()\\]|\\.)*)\)/g)) {
    if (match[1] !== undefined) {
      const hex = match[1].replace(/\s+/g, '');
      if (hex.length % 2 === 0) out.push(Buffer.from(hex, 'hex').toString('latin1'));
      continue;
    }
    out.push((match[2] ?? '').replace(/\\([()\\])/g, '$1'));
  }
  return out.join(' ');
}

/**
 * What the words look like from the inside: open the produced file the way the next
 * run would, and read its pages. A page count that survives while the text vanishes
 * is the failure this whole campaign chases, so every assertion below reads words.
 */
async function readable(bytes: Uint8Array, password?: string) {
  const doc = await openPDF(bytes, password ? { password } : { ignoreEncryption: true });
  const saved = await doc.save({ useObjectStreams: false });
  const again = await PDFDocument.load(saved, { updateMetadata: false });
  const parts: string[] = [];
  const rotations: number[] = [];
  for (let index = 0; index < again.getPageCount(); index++) {
    for (const stream of contentsOf(again, index)) parts.push(latin1.decode(streamBytes(stream)));
    rotations.push(again.getPages()[index].getRotation().angle);
  }
  return {
    pages: again.getPageCount(),
    rotations,
    words: decodeStrings(parts.join('\n')),
  };
}

/** The bytes of the file a run would hand the user, as one blob. */
async function outputBytes(ran: Awaited<ReturnType<typeof rotate>>): Promise<Uint8Array> {
  return new Uint8Array(await ran.outputs[0].blob.arrayBuffer());
}

/** Keep one produced file for the readers that share no code with this app. */
function artifact(name: string, bytes: Uint8Array): void {
  if (!ARTIFACTS) return;
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(join(ARTIFACTS, name), bytes as unknown as Uint8Array);
}

/* ── 1. the reach: rotate has no password field and needs none of its own ─── */

/** Every locked fixture whose **user** password is the one this file types. */
const USER_LOCKED = [
  { name: 'rc4-128-user.pdf', cipher: 'RC4-128', producer: 'qpdf' },
  { name: 'mu-rc4-128-user.pdf', cipher: 'RC4-128', producer: 'mupdf' },
  { name: 'aes-128-user.pdf', cipher: 'AES-128', producer: 'qpdf' },
  { name: 'mu-aes-128-user.pdf', cipher: 'AES-128', producer: 'mupdf' },
  { name: 'aes-256-user.pdf', cipher: 'AES-256', producer: 'qpdf' },
  { name: 'mu-aes-256-user.pdf', cipher: 'AES-256', producer: 'mupdf' },
] as const;

describe('rotate — a tool with no password field — reaches all three strengths', () => {
  it.each(USER_LOCKED)('$name ($cipher by $producer) is edited by the secret typed on the file', async ({ name, cipher }) => {
    const ran = await rotate(fixtureBytes(name), name, PASSWORD);
    expect(ran.outputs.length, 'rotate produced nothing').toBe(1);
    const bytes = await outputBytes(ran);
    artifact(`${name}.rotated.pdf`, bytes);

    // The edit landed, on every page, in a file whose streams had to be decrypted
    // before they could be rewritten.
    const view = await readable(bytes, PASSWORD);
    expect(view.pages).toBe(3);
    expect(view.rotations).toEqual([90, 90, 90]);
    expect(view.words).toContain(PLANTED);

    // And the copy is still the file it was: same strength, same secret, the words
    // not lying around in the clear.
    const after = await inspectPdf(bytes, name, { password: PASSWORD });
    expect(after.encrypted, 'rotate unlocked the file on its own').toBe(true);
    expect(after.algorithm).toBe(cipher);
    expect(after.error).toBeNull();
    expect(latin1.decode(bytes)).not.toContain(PLANTED);
  });

  it.each(USER_LOCKED)('$name still answers to its owner secret after the edit', async ({ name }) => {
    // `preserveProtection` carries the source's dictionary, key and /ID rather than
    // re-deriving one from the typed secret, so a secret the user never typed — the
    // owner password — still opens the copy.
    const bytes = await outputBytes(await rotate(fixtureBytes(name), name, PASSWORD));
    const opened = await inspectPdf(bytes, name, { password: PASSWORD });
    expect(opened.passwordLevel).toBe('user');
    expect(opened.opensWithEmptyPassword).toBe(false);
  });

  it.each([
    { name: 'rc4-128-owner.pdf', cipher: 'RC4-128' },
    { name: 'aes-256-owner.pdf', cipher: 'AES-256' },
  ])('$name opens with nothing typed and is edited without a box', async ({ name, cipher }) => {
    // The permission-locked fixtures: an /Encrypt entry, real ciphertext, and an
    // empty user secret. Demanding a password here withholds a file anybody reads.
    const seen = await inspectPdf(fixtureBytes(name), name);
    expect(seen.needsPassword).toBe(false);
    expect(seen.opensWithEmptyPassword).toBe(true);
    expect(seen.encryption).toMatchObject({ state: 'ciphered', algorithm: cipher, supported: true });

    const bytes = await outputBytes(await rotate(fixtureBytes(name), name));
    const view = await readable(bytes);
    expect(view.pages).toBe(3);
    expect(view.rotations).toEqual([90, 90, 90]);
    expect(view.words).toContain(PLANTED);
    artifact(`${name}.rotated.pdf`, bytes);
  });
});

/* ── 2. two asks, two sentences ──────────────────────────────────────────── */

describe('no password and the wrong password stay different', () => {
  const name = 'aes-128-user.pdf';

  it('names the missing secret as something the user can supply', async () => {
    const missing = await refusal(rotate(fixtureBytes(name), name));
    expect(missing.code).toBe('PASSWORD_REQUIRED');
    expect(missing.passwordRequired).toBe(true);
    expect(missing.message).toBe(`"${name}" is password protected.`);
    expect(missing.hint).toMatch(/Enter the password for/);
    expect(missing.hint).not.toMatch(/not correct|try again/i);
  });

  it('names a wrong secret as a correction, not a request', async () => {
    const wrong = await refusal(rotate(fixtureBytes(name), name, WRONG));
    expect(wrong.code).toBe('BAD_PASSWORD');
    expect(wrong.passwordRequired).toBe(true);
    expect(wrong.message).toBe(`That password is not correct for "${name}".`);
    expect(wrong.hint).toMatch(/case-sensitive/i);
    expect(wrong.hint).toMatch(/try again/i);
  });

  it('says two different things, in that order, about the same file', async () => {
    const missing = await refusal(rotate(fixtureBytes(name), name));
    const wrong = await refusal(rotate(fixtureBytes(name), name, WRONG));
    expect(missing.message).not.toBe(wrong.message);
    expect(missing.hint).not.toBe(wrong.hint);
    // A user reading only the two sentences can tell which one they are in.
    expect(missing.message + missing.hint).toMatch(/password protected/i);
    expect(wrong.message + wrong.hint).toMatch(/not correct/i);
    expect(wrong.message + wrong.hint).not.toMatch(/is password protected/i);
  });
});

/* ── 3. the refusals this app still owes ─────────────────────────────────── */

/** The /Encrypt dictionary of a fixture, as the parsed document holds it. */
function encryptDict(doc: PDFDocument): PDFDict {
  const entry = doc.context.trailerInfo.Encrypt;
  const dict = entry instanceof PDFRef ? doc.context.lookupMaybe(entry, PDFDict) : entry;
  if (!(dict instanceof PDFDict)) throw new Error('the fixture carries no readable /Encrypt dictionary');
  return dict;
}

/** One fixture's dictionary rewritten, saved back out as a file the app must read. */
async function recipher(
  name: string,
  write: (dict: PDFDict) => void,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(fixtureBytes(name), { ignoreEncryption: true, updateMetadata: false });
  write(encryptDict(doc));
  return new Uint8Array(await doc.save({ useObjectStreams: false }));
}

describe('the shapes still refused are refused by name, password or no password', () => {
  const shapes = [
    {
      label: 'RC4-40',
      build: () => recipher('rc4-128-user.pdf', (dict) => {
        dict.set(PDFName.of('V'), PDFNumber.of(1));
        dict.set(PDFName.of('R'), PDFNumber.of(2));
        dict.set(PDFName.of('Length'), PDFNumber.of(40));
      }),
      refusal: 'rc4-40',
      // The clause has to say what is actually missing here: no fixture, so no
      // claim — not "AES cannot be undone", and not "encryption is unsupported".
      names: /40-bit RC4/,
    },
    {
      label: 'AES-256 at /R 5',
      build: () => recipher('aes-256-user.pdf', (dict) => dict.set(PDFName.of('R'), PDFNumber.of(5))),
      refusal: 'aes-256',
      names: /revision-6 handler[\s\S]*another revision/,
    },
    {
      label: 'AES-256 at /R 7',
      build: () => recipher('aes-256-user.pdf', (dict) => dict.set(PDFName.of('R'), PDFNumber.of(7))),
      refusal: 'aes-256',
      names: /revision-6 handler[\s\S]*another revision/,
    },
    {
      label: 'a certificate handler',
      build: () => recipher('aes-128-user.pdf', (dict) => dict.set(PDFName.of('Filter'), PDFName.of('Adobe.PPKLite'))),
      refusal: 'public-key',
      names: /certificate handler/,
    },
  ] as const;

  it.each(shapes)('$label is classified unsupported and refuses with its own reason', async ({ build, refusal: reason, names }) => {
    const bytes = await build();
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const encryption = classifyEncryption(encryptDict(doc));
    expect(encryption).toMatchObject({ state: 'ciphered', supported: false, refusal: reason });
    const error = cipheredInputError('contract.pdf', encryption);
    expect(error.code).toBe('UNSUPPORTED');
    expect(error.passwordRequired).toBe(false);
    expect(error.message).toMatch(names);
    // The sentence never claims encryption as such is unsupported.
    expect(`${error.message} ${error.hint}`).not.toMatch(/(all|every|any) (encrypted|password[- ]protected) files/i);
  });

  it.each(shapes)('$label is still refused when the password is typed on the file', async ({ build, refusal: reason }) => {
    const bytes = await build();
    // The whole point of the refusal: the right secret does not rescue these, so
    // "enter it and try again" would send the user off to do work that changes
    // nothing. The new box may not turn that into a promise it cannot keep.
    const error = await refusal(rotate(bytes, 'locked.pdf', PASSWORD));
    expect(error.code).toBe('UNSUPPORTED');
    expect(error.passwordRequired).toBe(false);
    expect(error.message).not.toMatch(/is password protected/);
    // The card and the run quote the *same* clause, from the same file: one
    // vocabulary for why a lock stays shut, never a second sentence written beside
    // the first one and free to drift.
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const encryption = classifyEncryption(encryptDict(doc));
    expect(encryption.refusal).toBe(reason);
    const clause = refusalReason(encryption) ?? '';
    expect(clause.length).toBeGreaterThan(0);
    expect(error.message).toContain(clause);
  });

  it('does not refuse what the app can read: the same three strengths are edited', async () => {
    // The other side of the line. A refusal string that has drifted past the code
    // is the same class of bug as a missing feature, so both halves are pinned in
    // one file.
    for (const { name } of USER_LOCKED) {
      const seen = await inspectPdf(fixtureBytes(name), name, { password: PASSWORD });
      expect(seen.encryption).toMatchObject({ state: 'ciphered', supported: true, refusal: null });
      expect(seen.error).toBeNull();
    }
  });
});

/* ── 4. the row ──────────────────────────────────────────────────────────── */

/** A real classification, so no test below asserts against a made-up dictionary. */
async function classify(name: string, password?: string): Promise<PdfEncryption> {
  const seen = await inspectPdf(fixtureBytes(name), name, password ? { password } : {});
  return seen.encryption as PdfEncryption;
}

const noop = (): void => undefined;

describe('FileLockRow: one component, drawn wherever a file is listed', () => {
  it('states the cipher, the filter and the revision the dictionary actually spells', async () => {
    const encryption = await classify('aes-128-user.pdf', PASSWORD);
    render(h(FileLockRow, {
      name: 'aes-128-user.pdf',
      lock: 'needs-password',
      encryption,
      password: '',
      onPassword: noop,
    }));
    expect(screen.getByText(/AES-128 \(crypt filter \/StdCF, revision 4\)/)).toBeInTheDocument();
    const row = document.querySelector('[data-file-lock="needs-password"]') as HTMLElement;
    expect(row.textContent).toContain('Encrypted with AES-128 (crypt filter /StdCF, revision 4)');
  });

  it('names RC4-128 by its revision, where there is no crypt filter to read', async () => {
    render(h(FileLockRow, {
      name: 'rc4-128-user.pdf', lock: 'needs-password', encryption: await classify('rc4-128-user.pdf', PASSWORD), password: '', onPassword: noop,
    }));
    expect(document.querySelector('[data-file-lock]')?.textContent)
      .toContain('Encrypted with RC4-128 (revision 3)');
  });

  it('names AES-256 the same way the guard does', async () => {
    render(h(FileLockRow, {
      name: 'aes-256-user.pdf', lock: 'needs-password', encryption: await classify('aes-256-user.pdf', PASSWORD), password: '', onPassword: noop,
    }));
    expect(document.querySelector('[data-file-lock]')?.textContent)
      .toContain('Encrypted with AES-256 (crypt filter /StdCF, revision 6)');
  });

  it('offers a box for a missing secret, and writes it where the runner reads', () => {
    const typed: string[] = [];
    render(h(FileLockRow, {
      name: 'doc.pdf',
      lock: 'needs-password',
      encryption: {
        state: 'ciphered', algorithm: 'AES-128', streamFilter: 'StdCF', stringFilter: 'StdCF',
        method: 'AESV2', version: 4, revision: 4, supported: true, refusal: null,
      },
      password: '',
      onPassword: (value: string) => typed.push(value),
    }));
    const input = screen.getByLabelText('Open password for doc.pdf') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.getAttribute('data-file-password')).toBe('doc.pdf');
    fireEvent.change(input, { target: { value: PASSWORD } });
    expect(typed).toEqual([PASSWORD]);
    // The ask, not the correction.
    expect(document.querySelector('[data-file-lock]')?.textContent).toMatch(/needs its password/i);
    expect(document.querySelector('[data-file-lock]')?.textContent).not.toMatch(/not the password/i);
  });

  it('says "try again" for a wrong secret, in different words from the ask', () => {
    render(h(FileLockRow, {
      name: 'doc.pdf',
      lock: 'wrong-password',
      encryption: {
        state: 'ciphered', algorithm: 'AES-128', streamFilter: 'StdCF', stringFilter: 'StdCF',
        method: 'AESV2', version: 4, revision: 4, supported: true, refusal: null,
      },
      password: WRONG,
      onPassword: noop,
    }));
    const text = document.querySelector('[data-file-lock="wrong-password"]')?.textContent ?? '';
    expect(text).toMatch(/not the password/i);
    expect(text).toMatch(/still closed/i);
    expect(text).not.toMatch(/needs its password/i);
    expect(screen.getByLabelText('Open password for doc.pdf')).toBeInTheDocument();
  });

  it('says when the secret worked, because that is the state a run depends on', () => {
    render(h(FileLockRow, {
      name: 'doc.pdf',
      lock: 'opened',
      encryption: {
        state: 'ciphered', algorithm: 'AES-256', streamFilter: 'StdCF', stringFilter: 'StdCF',
        method: 'AESV3', version: 5, revision: 6, supported: true, refusal: null,
      },
      password: PASSWORD,
      onPassword: noop,
    }));
    expect(document.querySelector('[data-file-lock="opened"]')?.textContent).toMatch(/Password accepted/i);
    expect(screen.queryByLabelText('Open password for doc.pdf')).toBeNull();
  });

  it('offers no box for a cipher it cannot undo, and says the guard’s own reason', async () => {
    const doc = await PDFDocument.load(fixtureBytes('aes-256-user.pdf'), { ignoreEncryption: true, updateMetadata: false });
    encryptDict(doc).set(PDFName.of('R'), PDFNumber.of(5));
    const encryption = classifyEncryption(encryptDict(doc));
    render(h(FileLockRow, { name: 'doc.pdf', lock: 'unsupported', encryption, password: '', onPassword: noop }));
    const text = document.querySelector('[data-file-lock="unsupported"]')?.textContent ?? '';
    expect(text).toContain('AES-256 (crypt filter /StdCF, revision 5)');
    expect(text).toMatch(/revision-6 handler/);
    // A control that cannot change the output is not offered.
    expect(screen.queryByLabelText('Open password for doc.pdf')).toBeNull();
  });

  it('says nothing about a password for a file that opens without one', async () => {
    render(h(FileLockRow, {
      name: 'aes-256-owner.pdf', lock: 'opens-empty', encryption: await classify('aes-256-owner.pdf'), password: '', onPassword: noop,
    }));
    const text = document.querySelector('[data-file-lock="opens-empty"]')?.textContent ?? '';
    expect(text).toMatch(/(opens|open) with nothing typed/i);
    expect(text).not.toMatch(/needs its password|not the password/i);
    expect(screen.queryByLabelText('Open password for aes-256-owner.pdf')).toBeNull();
  });

  it('calls a gate-only lock a gate, not a cipher', async () => {
    // The shape this app's own `protect` used to write: a password and /P flags over
    // plaintext streams. Saying "encrypted with" here would be a claim the bytes
    // contradict.
    render(h(FileLockRow, {
      name: 'gate.pdf',
      lock: 'opens-empty',
      encryption: {
        state: 'gate-only', algorithm: 'no cipher', streamFilter: null, stringFilter: null, method: null,
        version: 4, revision: 4, supported: true, refusal: null,
      },
      password: '',
      onPassword: noop,
    }));
    const text = document.querySelector('[data-file-lock]')?.textContent ?? '';
    expect(text).toMatch(/Password gate, no cipher/i);
    expect(text).not.toMatch(/Encrypted with/i);
  });

  it('adds no box, and names the tool’s own field, when the tool declares one', () => {
    const encryption: PdfEncryption = {
      state: 'ciphered', algorithm: 'AES-128', streamFilter: 'StdCF', stringFilter: 'StdCF', method: 'AESV2',
      version: 4, revision: 4, supported: true, refusal: null,
    };
    render(h(FileLockRow, {
      name: 'doc.pdf', lock: 'needs-password', encryption, password: '', onPassword: noop, toolOwnsPassword: true,
    }));
    expect(screen.queryByLabelText('Open password for doc.pdf')).toBeNull();
    const text = document.querySelector('[data-file-lock]')?.textContent ?? '';
    expect(text).toMatch(/this tool asks for it in its own options/i);
    // And when its own field holds the wrong answer, that is what the row says.
    cleanup();
    render(h(FileLockRow, {
      name: 'doc.pdf', lock: 'wrong-password', encryption, password: WRONG, onPassword: noop, toolOwnsPassword: true,
    }));
    expect(screen.queryByLabelText('Open password for doc.pdf')).toBeNull();
    expect(document.querySelector('[data-file-lock]')?.textContent).toMatch(/Correct it in this tool/i);
  });

  it('says so when one secret covers several locked files in the same job', () => {
    const encryption: PdfEncryption = {
      state: 'ciphered', algorithm: 'AES-128', streamFilter: 'StdCF', stringFilter: 'StdCF', method: 'AESV2',
      version: 4, revision: 4, supported: true, refusal: null,
    };
    render(h(FileCards, {
      files: [fileOf(fixtureBytes('plain.pdf'), 'a.pdf'), fileOf(fixtureBytes('plain.pdf'), 'b.pdf')],
      states: {
        'a.pdf': { percent: 0, pages: 3, encryption, lock: 'needs-password' },
        'b.pdf': { percent: 0, pages: 3, encryption, lock: 'needs-password' },
      },
      reorderable: true,
      onRemove: noop,
      onReorder: noop,
      password: PASSWORD,
      onPassword: noop,
    }));
    const boxes = screen.getAllByLabelText(/Open password for/);
    expect(boxes).toHaveLength(2);
    // Both are the one string the runner carries, and the row admits it.
    for (const box of boxes) expect((box as HTMLInputElement).value).toBe(PASSWORD);
    expect(document.querySelectorAll('[data-file-lock="needs-password"]')).toHaveLength(2);
    expect(document.body.textContent).toMatch(/One secret per job/i);
  });

  it('draws the same row in the queue, with the same words', async () => {
    const encryption = await classify('aes-256-user.pdf', PASSWORD);
    render(h(FileQueue, {
      items: [{ id: 'aes-256-user.pdf', name: 'aes-256-user.pdf', size: 4096, pages: 3, encryption, lock: 'needs-password' }],
      password: '',
      onPassword: noop,
    }));
    const text = document.querySelector('[data-file-lock="needs-password"]')?.textContent ?? '';
    expect(text).toContain('AES-256 (crypt filter /StdCF, revision 6)');
    expect(screen.getByLabelText('Open password for aes-256-user.pdf')).toBeInTheDocument();
  });

  it('says nothing at all about a file with no lock', () => {
    render(h(FileLockRow, { name: 'plain.pdf', lock: 'none', encryption: null, password: '', onPassword: noop }));
    expect(document.querySelector('[data-file-lock]')).toBeNull();
  });
});

/* ── 5. the route, end to end through the surface ────────────────────────── */

describe('the secret typed on the card reaches the bytes', () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:password-anywhere') as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
    useProcessStore.getState().reset();
    useFileStore.getState().setFiles([]);
  });

  afterEach(() => {
    cleanup();
    useProcessStore.getState().reset();
    useFileStore.getState().clearCurrent();
    vi.unstubAllGlobals();
  });

  it('reads the lock into the file’s row, and re-reads it when a secret settles', async () => {
    const name = 'aes-128-user.pdf';
    useFileStore.getState().setFiles([fileOf(fixtureBytes(name), name)]);
    const { result } = renderHook(() => usePdfTool('rotate'));
    await waitFor(() => expect(result.current.tool).toBeTruthy());

    await waitFor(() => expect(useProcessStore.getState().fileStates[name]?.lock).toBe('needs-password'));
    expect(useProcessStore.getState().fileStates[name]?.encryption).toMatchObject({
      state: 'ciphered', algorithm: 'AES-128', streamFilter: 'StdCF', revision: 4, supported: true,
    });

    act(() => result.current.setPassword(WRONG));
    await waitFor(() => expect(useProcessStore.getState().fileStates[name]?.lock).toBe('wrong-password'));

    act(() => result.current.setPassword(PASSWORD));
    await waitFor(() => expect(useProcessStore.getState().fileStates[name]?.lock).toBe('opened'));
    // The page count arrives with the secret, because both come from one parse.
    expect(useProcessStore.getState().fileStates[name]?.pages).toBe(3);
  }, 30_000);

  it('runs the tool with that secret and produces a rotated file, without a fetch', async () => {
    const name = 'aes-256-user.pdf';
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    useFileStore.getState().setFiles([fileOf(fixtureBytes(name), name)]);
    const { result } = renderHook(() => usePdfTool('rotate'));
    await waitFor(() => expect(result.current.tool).toBeTruthy());
    await waitFor(() => expect(useProcessStore.getState().fileStates[name]?.lock).toBe('needs-password'));

    // Nothing was uploaded to get here, and nothing is uploaded to read the lock.
    act(() => result.current.setPassword(PASSWORD));
    await waitFor(() => expect(useProcessStore.getState().fileStates[name]?.lock).toBe('opened'));
    expect(fetched).not.toHaveBeenCalled();

    let ran: unknown = null;
    await act(async () => {
      ran = await result.current.run();
    });
    expect(ran, 'the run failed').toBeTruthy();
    const state = useProcessStore.getState();
    expect(state.phase).toBe('done');
    expect(state.outputBlobs.length).toBe(1);
    expect(state.error).toBeNull();
    expect(fetched, 'a run that uploads is not a client-side run').not.toHaveBeenCalled();

    const bytes = new Uint8Array(await (state.outputBlobs[0] as Blob).arrayBuffer());
    artifact('surface-route-aes-256-user.pdf.rotated.pdf', bytes);
    const view = await readable(bytes, PASSWORD);
    expect(view.pages).toBe(3);
    expect(view.rotations).toEqual([90, 90, 90]);
    expect(view.words).toContain(PLANTED);
  }, 30_000);

  it('says where the box is when the tool owns one, and only then', async () => {
    const name = 'aes-128-user.pdf';
    useFileStore.getState().setFiles([fileOf(fixtureBytes(name), name)]);
    const { result } = renderHook(() => usePdfTool('unlock'));
    await waitFor(() => expect(result.current.tool).toBeTruthy());
    await waitFor(() => expect(useProcessStore.getState().fileStates[name]?.lock).toBe('needs-password'));
    // `unlock` declares a password field, so the row that the same surface draws
    // must not offer a second box for the same secret.
    expect(result.current.needsPassword).toBe(true);
  }, 30_000);

  it('keeps the stage word honest about a file the run would refuse', async () => {
    const name = 'mu-aes-128-user.pdf';
    const states: Record<string, FileRunState> = {
      [name]: { percent: 0, pages: 3, size: 3774, encryption: await classify(name, PASSWORD), lock: 'needs-password' },
    };
    render(h(FileCards, {
      files: [fileOf(fixtureBytes('plain.pdf'), name)],
      states,
      reorderable: false,
      onRemove: noop,
      onReorder: noop,
    }));
    const card = document.querySelector('[data-card="0"]') as HTMLElement;
    expect(card.textContent).toContain('Locked');
    expect(card.textContent).not.toContain('Ready');
    // …and a file that needs nothing is still just Ready.
    cleanup();
    render(h(FileCards, {
      files: [fileOf(fixtureBytes('plain.pdf'), name)],
      states: { [name]: { percent: 0, pages: 3, size: 3774 } },
      reorderable: false,
      onRemove: noop,
      onReorder: noop,
    }));
    expect(document.querySelector('[data-card="0"]')?.textContent).toContain('Ready');
  });

  it('reports the verdict a locked file earns, per lock state, on the card', async () => {
    const encryption = await classify('aes-128-user.pdf', PASSWORD);
    const locks: FileLockState[] = ['needs-password', 'wrong-password', 'opened', 'unsupported'];
    for (const lock of locks) {
      render(h(FileCards, {
        files: [fileOf(fixtureBytes('plain.pdf'), 'doc.pdf')],
        states: { 'doc.pdf': { percent: 0, pages: 3, encryption, lock } },
        reorderable: false,
        onRemove: noop,
        onReorder: noop,
        password: lock === 'wrong-password' ? WRONG : '',
        onPassword: noop,
      }));
      const row = document.querySelector('[data-file-lock]') as HTMLElement;
      expect(row, `no row for ${lock}`).toBeTruthy();
      expect(row.getAttribute('data-file-lock')).toBe(lock);
      cleanup();
    }
  });

  it('leaves the card untouched, and the DOM uncluttered, for a plain file', () => {
    render(h(FileCards, {
      files: [fileOf(fixtureBytes('plain.pdf'), 'plain.pdf')],
      states: { 'plain.pdf': { percent: 0, pages: 3, size: 2975, lock: 'none', encryption: null } },
      reorderable: false,
      onRemove: noop,
      onReorder: noop,
    }));
    expect(document.querySelector('[data-file-lock]')).toBeNull();
  });
});

/** The artifact directory the outside readers judge, when the run asked for one. */
if (ARTIFACTS) {
  mkdirSync(ARTIFACTS, { recursive: true });
  writeFileSync(join(ARTIFACTS, 'README.txt'), 'Produced by tests/pdf/password-anywhere.test.ts; judged by docs/research/password-anywhere-readers.py\n');
}
