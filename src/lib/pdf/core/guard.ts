/**
 * The shared input guard layer.
 *
 * Before this module every tool answered "what is this file?" by itself, so the
 * same five edge cases produced five different messages — an empty file reached
 * a pdf-lib stack trace, a renamed JPEG said "failed", a locked document said
 * "could not open" without ever asking for a password, and `dpi: 0` quietly
 * produced a broken PDF.
 *
 * Two entry points cover the whole app:
 *
 * - `inspectPdf(bytes, name)` *never throws*. It reads the header and trailer,
 *   then tries a parse, and reports what it found (pages, encryption,
 *   permissions, whether the file only parsed in lenient mode). This is what a
 *   file queue or a result card renders. The page count comes from the parse, so
 *   `inspectPdf(bytes, name, { cheap: true })` has none — see `InspectOptions`.
 * - `openPdfInput(bytes, name, { password })` is the gate. It raises a
 *   `ToolInputError` with a stable code, the offending file name in the message,
 *   and `passwordRequired` set when the UI should re-prompt instead of showing a
 *   red banner.
 * - `preflightPdf(source, password, { rejectCiphered })` is the runner's pass
 *   before any tool allocates work, and the one place that asks what a lock *is*
 *   — a gate this app can re-issue, or a cipher it cannot undo.
 *
 * The numeric/page-range/field helpers live here too so that one definition of
 * "valid input" serves both the rail (inline validation, E15) and the runner
 * (clamping before a tool starts work).
 */
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef } from '@maxwbh/pdf-lib';
import { formatBytes } from '@/lib/utils/format';
import { looksEncrypted } from './doc';
import {
  assessAccess,
  decryptDocument,
  readObstacle,
  supportsCipher,
  type UnsupportedReason,
} from './crypto';
import { tryResolvePages } from './pages';
import type { ToolField, ToolValues } from '../tools/types';

/** Every reason the guard can refuse an input. Stable: the UI switches on these. */
export const TOOL_INPUT_ERROR_CODES = [
  'EMPTY_FILE',
  'NOT_A_PDF',
  'CORRUPT',
  'PASSWORD_REQUIRED',
  'BAD_PASSWORD',
  'UNSUPPORTED',
  'NEEDS_ENGINE',
  'OUT_OF_RANGE',
  'NO_PAGES',
] as const;

export type ToolInputErrorCode = (typeof TOOL_INPUT_ERROR_CODES)[number];

export interface ToolInputErrorOptions {
  /** File the failure names, so a queue can highlight the right row. */
  fileName?: string;
  /** What to do about it, shown under the message. */
  hint?: string;
  /** The underlying parse error, kept for the log pane. */
  detail?: unknown;
}

/**
 * A user-facing refusal. `message` always names the file when there is one, and
 * `passwordRequired` lets the UI distinguish "ask again" from "something broke".
 */
export class ToolInputError extends Error {
  override readonly name = 'ToolInputError';
  readonly code: ToolInputErrorCode;
  readonly fileName?: string;
  readonly hint?: string;
  readonly detail?: unknown;
  /** True for `PASSWORD_REQUIRED` and `BAD_PASSWORD`. */
  readonly passwordRequired: boolean;

  constructor(code: ToolInputErrorCode, message: string, options: ToolInputErrorOptions = {}) {
    super(message);
    this.code = code;
    this.fileName = options.fileName;
    this.hint = options.hint;
    this.detail = options.detail;
    this.passwordRequired = code === 'PASSWORD_REQUIRED' || code === 'BAD_PASSWORD';
  }
}

export function isToolInputError(error: unknown): error is ToolInputError {
  return error instanceof ToolInputError;
}

/**
 * Does this failure mean "the document is locked"?
 *
 * Also recognises `PasswordRequiredError` from `core/doc` and the older
 * prose-matching path, so a tool that still throws a plain Error re-prompts
 * rather than showing a stack trace.
 */
export function isPasswordRequired(error: unknown): boolean {
  if (error instanceof ToolInputError) return error.passwordRequired;
  if (error instanceof Error && error.name === 'PasswordRequiredError') return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /password|encrypt/i.test(message) && !/not encrypted/i.test(message);
}

/** Flatten any thrown value into the shape the process store logs. */
export function describeToolError(
  error: unknown,
): { code: ToolInputErrorCode; message: string; fileName?: string; hint?: string; passwordRequired: boolean } {
  if (error instanceof ToolInputError) {
    return {
      code: error.code,
      message: error.message,
      fileName: error.fileName,
      hint: error.hint,
      passwordRequired: error.passwordRequired,
    };
  }
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error.');
  const password = isPasswordRequired(error);
  return {
    code: password ? 'PASSWORD_REQUIRED' : 'CORRUPT',
    message,
    passwordRequired: password,
  };
}

const PDF_MAGIC = '%PDF-';
/** How far in to look for the header: some producers write junk before `%PDF-`. */
const HEADER_WINDOW = 1024;
/** Trailer dictionaries live at the very end of the file. */
const TRAILER_WINDOW = 4096;

function latin1(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes);
}

function head(bytes: Uint8Array, length = HEADER_WINDOW): string {
  return latin1(bytes.subarray(0, Math.min(bytes.length, length)));
}

function tail(bytes: Uint8Array, length = TRAILER_WINDOW): string {
  return latin1(bytes.subarray(Math.max(0, bytes.length - length)));
}

/** Cheap content check: a `%PDF-` marker near the start, whatever the name says. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  return head(bytes).includes(PDF_MAGIC);
}

/** Version claimed by the header (`1.4` for `%PDF-1.4`), or `null`. */
export function headerVersion(bytes: Uint8Array): string | null {
  return head(bytes).match(/%PDF-(\d\.\d)/)?.[1] ?? null;
}

/** `%%EOF` within the last 4 KB. False means the file was cut off while saving. */
export function hasEofMarker(bytes: Uint8Array): boolean {
  return tail(bytes).includes('%%EOF');
}

function extensionOf(name: string): string | null {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  if (dot < 0 || dot === base.length - 1) return null;
  const ext = base.slice(dot + 1);
  return ext.length <= 5 ? ext : null;
}

/**
 * Permission flags from the encryption dictionary's `/P` bitfield (ISO 32000
 * Table 22). Values above bit 12 are always set, so the mask is the only safe
 * test — `P` is commonly a negative number.
 */
export interface PdfPermissions {
  /** Raw `/P` value, for round-tripping and the details pane. */
  raw: number;
  printing: boolean;
  printingHighQuality: boolean;
  modifying: boolean;
  copying: boolean;
  annotating: boolean;
  fillingForms: boolean;
  contentAccessibility: boolean;
  documentAssembly: boolean;
}

export function decodePermissions(p: number): PdfPermissions {
  const flags = p | 0;
  const bit = (mask: number) => (flags & mask) !== 0;
  return {
    raw: p,
    printing: bit(4),
    printingHighQuality: bit(2048),
    modifying: bit(8),
    copying: bit(16),
    annotating: bit(32),
    fillingForms: bit(256),
    contentAccessibility: bit(512),
    documentAssembly: bit(1024),
  };
}

/**
 * What a locked file actually does to its contents — the question an `/Encrypt`
 * entry cannot answer on its own.
 *
 * A PDF can be locked two ways that look identical from the trailer:
 *
 * - `gate-only` — the dictionary carries a password and the `/P` flags, and its
 *   **effective crypt filter is `/None`**, "the data are not encrypted"
 *   (ISO 32000-1 §7.6.3.2, §7.4.4: `/StmF` and `/StrF` both default to it, and an
 *   empty `/CF` selects nothing else). Every stream is plaintext, so this app can
 *   read the page, copy it and write it back. This is the shape `protect` wrote
 *   until `core/crypto.ts:encryptDocument` landed, and files in the wild still
 *   carry it; the `encrypted-inputs` rig confirms the round trip keeps its words.
 * - `ciphered` — `/StmF` or `/StrF` resolves to `RC4`, `AESV2` or `AESV3` (or
 *   `/V` is 1-3, where RC4 is implied and there is no filter to opt out of). The
 *   bytes are ciphertext. `core/doc.ts:openPDF` asks `core/crypto` to undo RC4-128
 *   and AES-128 and refuses the rest by name; rewriting a refused one copies
 *   ciphertext that the writer then labels plaintext, and every reader that
 *   believes the label draws blank paper.
 *
 * Refusing both would be its own regression, so the guard asks which of these two
 * a file is — see `cipheredInputError`.
 */
export type EncryptionState = 'none' | 'gate-only' | 'ciphered';

/** The whole of what the encryption dictionary claims. Safe to render and to name. */
export interface PdfEncryption {
  state: EncryptionState;
  /**
   * `AES-256`, `AES-128`, `RC4-128`, `RC4-40`, `unknown` when a cipher is claimed
   * but this reader cannot name it, `no cipher` for a gate-only lock, `null` when
   * there is no dictionary at all.
   */
  algorithm: string | null;
  /** `/StmF` as the file spells it (`StdCF`), or `null` when the `/None` default applies. */
  streamFilter: string | null;
  /** `/StrF` likewise — the filter over strings rather than streams. */
  stringFilter: string | null;
  /** `/CFM` of the effective stream filter (`AESV2`, `V2`, …), or `null`. */
  method: string | null;
  /** `/V`, the handler *version*. */
  version: number | null;
  /** `/R`, the handler *revision*. */
  revision: number | null;
  /**
   * Whether a rewriting tool may run on this file at all: `true` when there is no
   * cipher to undo — no dictionary, or the `/None` filter this app's own `protect`
   * writes — and when `core/crypto` can read the streams that are ciphered.
   * `false` means the dictionary selects a cipher this app cannot undo, and
   * `refusal` names it. Rewriting a `false` file copies ciphertext and labels it
   * plaintext, which is the 18-of-18 blank-paper bug this field exists to stop.
   */
  supported: boolean;
  /** Why the cipher is refused, when it is: named, never just "encrypted". */
  refusal: UnsupportedReason | null;
}

/** No dictionary: nothing is encrypted and nothing needs saying about a cipher. */
const NO_ENCRYPTION: PdfEncryption = {
  state: 'none',
  algorithm: null,
  streamFilter: null,
  stringFilter: null,
  method: null,
  version: null,
  revision: null,
  supported: true,
  refusal: null,
};

/** The predefined filters, which are named in `/StmF` but never appear in `/CF`. */
const PLAINTEXT_FILTERS = new Set(['None', 'Identity']);

/** An `/Encrypt` entry with no readable dictionary behind it: a lock, unnameable. */
const UNREADABLE_ENCRYPTION: PdfEncryption = {
  ...NO_ENCRYPTION,
  state: 'ciphered',
  algorithm: 'unknown',
  supported: false,
  refusal: 'missing-parameters',
};

/**
 * The cipher a crypt filter applies to a name that filter is, or `null` when the
 * name is one of the predefined plaintext filters (including an absent `/StmF`,
 * whose default is `/None`).
 *
 * A named filter that the dictionary does not define is reported as `unknown`
 * rather than as nothing: a cipher this reader cannot resolve is still a cipher.
 */
function filterMethod(dict: PDFDict, name: string | null): string | null {
  if (name === null || PLAINTEXT_FILTERS.has(name)) return null;
  const filters = dict.lookupMaybe(PDFName.of('CF'), PDFDict);
  const declared = filters?.get(PDFName.of(name));
  const filter = declared instanceof PDFRef ? dict.context.lookupMaybe(declared, PDFDict) : declared;
  if (!(filter instanceof PDFDict)) return 'unknown';
  // `/CFM` defaults to `/None` inside a filter dictionary (ISO 32000-1 Table 30).
  return filter.lookupMaybe(PDFName.of('CFM'), PDFName)?.decodeText() ?? 'None';
}

/** Name the cipher behind a `/CFM` method, at the key length the dictionary gives. */
function cipherName(dict: PDFDict, method: string): string {
  if (method === 'AESV3') return 'AES-256';
  if (method === 'AESV2') return 'AES-128';
  if (method === 'V2' || method === 'RC4') {
    return (dict.lookupMaybe(PDFName.of('Length'), PDFNumber)?.asNumber() ?? 40) > 40 ? 'RC4-128' : 'RC4-40';
  }
  return 'unknown';
}

/**
 * Classify one encryption dictionary.
 *
 * Deliberately reads the *effective* filters rather than listing everything in
 * `/CF`: a dictionary can define an AES filter it never selects, and the strongest
 * name in the file is not the cipher the bytes carry.
 */
export function classifyEncryption(dict: PDFDict): PdfEncryption {
  // One question, answered by the module that would have to undo the cipher: this
  // guard may only claim a strength that `core/crypto` reads back as words.
  const support = supportsCipher(dict);
  const version = dict.lookupMaybe(PDFName.of('V'), PDFNumber)?.asNumber() ?? null;
  const revision = dict.lookupMaybe(PDFName.of('R'), PDFNumber)?.asNumber() ?? null;
  const streamFilter = dict.lookupMaybe(PDFName.of('StmF'), PDFName)?.decodeText() ?? null;
  const stringFilter = dict.lookupMaybe(PDFName.of('StrF'), PDFName)?.decodeText() ?? null;
  const base = { streamFilter, stringFilter, version, revision };

  // `/V` is required and defaults to 1; a dictionary without one still claims a
  // handler, and "we cannot read the streams" is the honest verdict.
  if (version === null) {
    return {
      ...NO_ENCRYPTION,
      ...base,
      state: 'ciphered',
      algorithm: 'unknown',
      method: null,
      supported: support.supported,
      refusal: support.supported ? null : support.reason,
    };
  }

  if (version >= 4) {
    const streamMethod = filterMethod(dict, streamFilter);
    const stringMethod = filterMethod(dict, stringFilter);
    const methods = [streamMethod, stringMethod].filter((method): method is string => method !== null && method !== 'None');
    // Nothing selected: the `/None` filter is in force, whatever `/V` and `/R`
    // say. This is the shape of this app's own gate, and it round-trips.
    if (methods.length === 0) {
      return { ...NO_ENCRYPTION, ...base, state: 'gate-only', algorithm: 'no cipher' };
    }
    const algorithm = methods.map((method) => cipherName(dict, method)).find((name) => name !== 'unknown') ?? 'unknown';
    return {
      ...NO_ENCRYPTION,
      ...base,
      state: 'ciphered',
      algorithm,
      method: streamMethod ?? stringMethod,
      supported: support.supported,
      refusal: support.supported ? null : support.reason,
    };
  }

  // `/V 1`-`/V 3` predate crypt filters: the streams are RC4 at the key length in
  // `/Length`, with no way for a file to say otherwise. `/V 3` is the revision
  // AES-128 *handlers* use without filters, so its cipher is not nameable here.
  const length = dict.lookupMaybe(PDFName.of('Length'), PDFNumber)?.asNumber() ?? 40;
  const algorithm = version === 2 || (version === 1 && length > 40) ? 'RC4-128' : version === 1 ? 'RC4-40' : 'unknown';
  return {
    ...NO_ENCRYPTION,
    ...base,
    state: 'ciphered',
    algorithm,
    method: algorithm === 'unknown' ? null : 'RC4',
    supported: support.supported,
    refusal: support.supported ? null : support.reason,
  };
}

/**
 * Short, truthful name for a ciphered file's lock: `AES-128 (crypt filter /StdCF,
 * revision 4)`, or `RC4-128 (revision 3)` for a handler too old to name a filter.
 */
export function describeEncryption(encryption: PdfEncryption): string {
  const cipher = encryption.algorithm === 'unknown' ? 'a cipher this app cannot name' : encryption.algorithm ?? 'a cipher';
  const parts = [encryption.streamFilter ? `crypt filter /${encryption.streamFilter}` : null];
  if (encryption.revision !== null) parts.push(`revision ${encryption.revision}`);
  const detail = parts.filter(Boolean).join(', ');
  return detail ? `${cipher} (${detail})` : cipher;
}

function encryptDict(doc: PDFDocument): PDFDict | undefined {
  const entry = doc.context.trailerInfo.Encrypt;
  // The trailer may inline the dictionary or point at it; never assume which.
  if (entry instanceof PDFDict) return entry;
  if (entry instanceof PDFRef) return doc.context.lookupMaybe(entry, PDFDict);
  return undefined;
}

/** What `inspectPdf` learned about one file. Always safe to render. */
export interface PdfInspection {
  name: string;
  /** Bytes supplied, so a queue can show `describeSize(size)` without re-reading. */
  size: number;
  /** Header present. `false` means the file is not a PDF whatever its name says. */
  isPdf: boolean;
  /**
   * Pages readable without a password.
   *
   * A parse produced this number or nothing did: `0` means "not readable", and
   * a cheap inspection always reports `0` because it never parses. Neither is a
   * claim that the document is empty — `declaredPages` says what the page tree
   * itself claims (E3).
   */
  pages: number;
  /** `/Count` claimed by the page tree, when it differs from `pages` (E3). */
  declaredPages: number | null;
  encrypted: boolean;
  /** Encryption scheme, e.g. `AES-256`, when the document is protected. */
  algorithm: string | null;
  /**
   * What the lock *does*: `none`, `gate-only` (a password and `/P` flags over
   * plaintext streams) or `ciphered` (ciphertext this app cannot undo). `null`
   * only in `cheap` mode, where there is no parsed dictionary to read — an entry
   * in the trailer cannot tell a gate from a cipher, so a caller that needs to
   * know pays for the parse (see `preflightPdf`).
   */
  encryption: PdfEncryption | null;
  /** The **user** password is set and none was supplied. Owner-only protection
   * never sets this: see `opensWithEmptyPassword`. */
  needsPassword: boolean;
  /** A password was supplied and it opened the document (E5). */
  passwordAccepted: boolean;
  /**
   * Which of the two secrets a PDF can carry opened it, once a real cipher was
   * undone: the **user** secret gates opening, the **owner** secret gates
   * permissions and grants a reader as well, and `empty` means the file carries a
   * permissions-only lock and nobody had to type anything. `null` when nothing
   * opened it, or when the lock is a gate this app reads without the cipher table.
   */
  passwordLevel: 'user' | 'owner' | 'empty' | null;
  /**
   * The file opens on the empty password: it is restricted, not locked. Anyone
   * can read it, and the `/P` flags only ask a reader to behave — which is what
   * `unlock`, `change-permissions` and `remove-restrictions` exist for (E4/E5).
   */
  opensWithEmptyPassword: boolean;
  permissions: PdfPermissions | null;
  /** Header version, e.g. `1.7`. */
  version: string | null;
  /** No `%%EOF` — the file was truncated while saving. */
  truncated: boolean;
  /** Only the lenient parser accepted it, so something in it is broken (E3). */
  recovered: boolean;
  /** Why the guard would refuse this input, or `null` when it is usable. */
  error: ToolInputErrorCode | null;
  /** User-facing sentence, naming the file. Never a stack trace. */
  message: string;
  hint?: string;
  /** The parser's own complaint, one line, for the log pane. */
  detail?: string;
}

export interface InspectOptions {
  /** Candidate password, verified against the encryption dictionary (E5). */
  password?: string;
  /**
   * Skip the parse and report header/trailer facts only: whether the bytes are a
   * PDF, its header version, whether the `%%EOF` marker is there, whether an
   * `/Encrypt` entry is present.
   *
   * **A page count is not one of those facts.** Cheap mode returns no page count
   * at all — `pages` stays `0`, and `0` here means "not read", never "an empty
   * document"; `declaredPages` stays `null`. Counting pages needs the very parse
   * this option exists to skip, and this app's own saves hide the page tree in a
   * compressed object stream, so a string scan could not find it either. Ask the
   * document instead: `doc.getPageCount()` while the document is in hand.
   *
   * Used by the runner's pre-flight so a 500-page document is not read twice (E7).
   */
  cheap?: boolean;
}

/** Out-param so the gate can reuse the document an inspection already parsed. */
interface ParsedSink {
  doc: PDFDocument | null;
}

/**
 * The `/Count` the root page tree claims, or `null` when it cannot be read.
 *
 * A truncated file often keeps a correct `/Count` while the traversal finds
 * fewer leaves, so comparing the two is how E3 reports *which* pages broke
 * rather than shrugging.
 */
function declaredPageCount(doc: PDFDocument): number | null {
  try {
    const count = doc.catalog.Pages().get(PDFName.of('Count'));
    return count instanceof PDFNumber ? Math.trunc(count.asNumber()) : null;
  } catch {
    return null;
  }
}

/**
 * What one parse learned about a file's lock, and whether it could be opened.
 *
 * `encryption` is read from the dictionary **before** a decrypt pass runs, because
 * the pass answers a question about the file the user handed over, not about the
 * document left in memory: `core/crypto` drops the `/Encrypt` entry it has undone,
 * so a classification taken afterwards would describe plaintext that still carries
 * somebody else's claim.
 */
interface LoadOutcome {
  doc: PDFDocument | null;
  /** The source dictionary's own verdict, obstacles included. */
  encryption: PdfEncryption;
  /**
   * `/P` decoded from the source dictionary, on the same rule as `encryption`: a
   * file this app wrote is now AES-128, so the document handed back has been
   * decrypted and no longer carries the entry the flags were read from.
   */
  permissions: PdfPermissions | null;
  encrypted: boolean;
  passwordAccepted: boolean;
  /** Which secret opened a ciphered document, from the dictionary's own check. */
  passwordLevel: 'user' | 'owner' | 'empty' | null;
  /** The user password is empty, so the file opens for anyone: `/P` only restricts. */
  opensWithEmptyPassword: boolean;
  refused: ToolInputErrorCode | null;
  detail?: unknown;
}

/**
 * `/P` decoded from an encryption dictionary, or `null` when there is none.
 *
 * Always read from the dictionary **as the file carries it**, never from the
 * document a tool holds: undoing a cipher drops the `/Encrypt` entry, and the
 * permissions a report quotes belong to the file the user was given.
 */
function permissionsOf(dict: PDFDict | undefined): PdfPermissions | null {
  const raw = dict?.lookupMaybe(PDFName.of('P'), PDFNumber)?.asNumber();
  return typeof raw === 'number' ? decodePermissions(raw) : null;
}

/**
 * Parse with the same recovery order every tool gets: a lenient
 * `ignoreEncryption` load reads the structure of a protected file, then the
 * *user* password decides whether one is actually needed.
 */
async function load(bytes: Uint8Array, password?: string): Promise<LoadOutcome> {
  let lenient: PDFDocument | null = null;
  try {
    lenient = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A bad password can also surface as a parse failure in the crypto layer.
    const crypto = /encrypt|password|pad|decrypt/i.test(message);
    return {
      doc: null,
      encryption: UNREADABLE_ENCRYPTION,
      permissions: null,
      encrypted: looksEncrypted(bytes),
      passwordAccepted: false,
      passwordLevel: null,
      opensWithEmptyPassword: false,
      refused: crypto && password ? 'BAD_PASSWORD' : crypto ? 'PASSWORD_REQUIRED' : 'CORRUPT',
      detail: err,
    };
  }
  const encrypted = lenient.isEncrypted;
  const dict = encryptDict(lenient);
  // Classified here, before anything is undone, and with the two things only a
  // parsed document can show (`core/crypto:readObstacle`) folded in. An
  // `/Encrypt` entry the parser could not resolve to a dictionary still claims a
  // handler, so it counts as ciphered — the refusal an unreadable lock earns is
  // "cannot decrypt", never a copy of bytes nobody has read.
  const encryption = !encrypted
    ? NO_ENCRYPTION
    : dict
      ? obstacles(classifyEncryption(dict), lenient)
      : UNREADABLE_ENCRYPTION;
  const permissions = permissionsOf(dict);
  if (!encrypted) {
    return { doc: lenient, encryption, permissions, encrypted: false, passwordAccepted: false, passwordLevel: null, opensWithEmptyPassword: false, refused: null };
  }
  // A file whose crypt filter names a real cipher is answered by the module that
  // can undo it, not by a probe load: `core/crypto` checks `/U` at the revision
  // the file actually uses, keeps the two secrets apart, and hands back plaintext.
  const ciphered = await cipheredOutcome(lenient, encryption, password, permissions);
  if (ciphered) return ciphered;
  // An `/Encrypt` entry is not a lock. Two different passwords protect a PDF: the
  // **user** password gates opening, the owner password only gates permission
  // changes. A permissions-only file hashes the empty user password, so anyone
  // can read it and demanding a password blocks the tools whose job is the
  // restrictions (E4/E5). Loading with `''` is the reader's point of view: the
  // crypto layer checks the empty password before any other, so a supplied
  // password opens such a file too, and nothing here has to guess.
  try {
    const open = await PDFDocument.load(bytes, { password: '', updateMetadata: false });
    return {
      doc: open,
      encryption,
      permissions,
      encrypted: true,
      passwordAccepted: Boolean(password),
      passwordLevel: password ? null : 'empty',
      opensWithEmptyPassword: true,
      refused: null,
    };
  } catch {
    /* the user password is real — fall through to it */
  }
  if (!password) {
    return { doc: lenient, encryption, permissions, encrypted: true, passwordAccepted: false, passwordLevel: null, opensWithEmptyPassword: false, refused: 'PASSWORD_REQUIRED' };
  }
  try {
    const opened = await PDFDocument.load(bytes, { password, updateMetadata: false });
    return { doc: opened, encryption, permissions, encrypted: true, passwordAccepted: true, passwordLevel: 'user', opensWithEmptyPassword: false, refused: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const crypto = /encrypt|password/i.test(message);
    return {
      doc: lenient,
      encryption,
      permissions,
      encrypted: true,
      passwordAccepted: false,
      passwordLevel: null,
      opensWithEmptyPassword: false,
      refused: crypto ? 'BAD_PASSWORD' : 'CORRUPT',
      detail: err,
    };
  }
}

/**
 * What a ciphered document is, and what this app can do with it, in one answer.
 *
 * `null` means the lock is not a cipher this module reads — either a gate whose
 * effective filter is `/None`, whose streams were never ciphered and whose probes
 * below decide exactly as they always did, or a cipher named and refused (see
 * `cipheredInputError`). Otherwise the verdict comes from the dictionary's own
 * `/U` check, which is the only place that can tell a user secret from an owner
 * secret, and the document handed back has already been decrypted.
 */
async function cipheredOutcome(
  lenient: PDFDocument,
  encryption: PdfEncryption,
  password: string | undefined,
  permissions: PdfPermissions | null,
): Promise<LoadOutcome | null> {
  const verdict = await assessAccess(lenient, password);
  if (verdict.kind === 'gate-only' || verdict.kind === 'unsupported') return null;
  if (verdict.kind === 'needs-password') {
    return {
      doc: lenient,
      encryption,
      permissions,
      encrypted: true,
      passwordAccepted: false,
      passwordLevel: null,
      opensWithEmptyPassword: false,
      refused: 'PASSWORD_REQUIRED',
    };
  }
  if (verdict.kind === 'bad-password') {
    return {
      doc: lenient,
      encryption,
      permissions,
      encrypted: true,
      passwordAccepted: false,
      passwordLevel: null,
      opensWithEmptyPassword: false,
      refused: 'BAD_PASSWORD',
    };
  }
  // Whether the file opens for nobody at all: its **user** secret is the empty
  // string. That is a property of the dictionary, not of the secret the caller
  // happened to type — typing an owner password into a permissions-only file opens
  // it as the owner, and it still opens on a double-click.
  const opensEmpty = (await assessAccess(lenient)).kind === 'opens';
  const outcome = await decryptDocument(lenient, password);
  if (outcome.kind !== 'decrypted') {
    return {
      doc: lenient,
      encryption,
      permissions,
      encrypted: true,
      passwordAccepted: false,
      passwordLevel: null,
      opensWithEmptyPassword: false,
      refused: 'CORRUPT',
    };
  }
  return {
    doc: lenient,
    encryption,
    permissions,
    encrypted: true,
    passwordAccepted: outcome.suppliedMatched,
    passwordLevel: outcome.openedAs,
    opensWithEmptyPassword: opensEmpty,
    refused: null,
  };
}

function quote(name: string): string {
  return `"${name}"`;
}

/** E1 — a file with no bytes. One sentence, shared by the inspection and the gate. */
export function emptyFileError(name: string): ToolInputError {
  return new ToolInputError('EMPTY_FILE', `${quote(name)} is empty (0 bytes) — there is nothing to read.`, {
    fileName: name,
    hint: 'Re-export the file, or remove it from the list.',
  });
}

/** E2 — the name says PDF, the bytes say otherwise. */
export function notAPdfError(name: string): ToolInputError {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1) : extensionOf(name);
  const renamed = ext && ext.length <= 5
    ? ` Renaming a ${ext.toUpperCase()} file to .pdf does not convert it.`
    : '';
  return new ToolInputError(
    'NOT_A_PDF',
    `${quote(name)} is not a PDF: its contents do not start with %PDF-1.x.${renamed}`,
    { fileName: name, hint: 'Open it in its real format first, or export it as a PDF.' },
  );
}

/**
 * The refusal a content-rewriting tool gives a file whose streams are ciphertext.
 *
 * This app *reads* a locked document: pdf.js implements the ciphers, so the
 * preview and the page count are right. What it cannot do is edit one — the
 * engine holds each page stream exactly as the file stores it, nothing decrypts
 * it, and the writer then labels the copy with the filter the source claims.
 * Measured over 18 runs by an outside-locked fixture: the right page count, the
 * password still working, and blank paper (`docs/research/encrypted-inputs-findings.md`).
 * Saying no is the honest half of that; the decrypt pass on load is its own task.
 *
 * The sentence names the cipher the dictionary actually selects, and never claims
 * that every encrypted file is refused: a password gate whose crypt filter is
 * `/None` — what this app's own `protect` writes — keeps working, because its
 * streams are plaintext.
 */
/**
 * The two things the dictionary cannot say about its own file.
 *
 * `@maxwbh/pdf-lib` expands object streams while it parses, before any decryptor
 * is consulted, so in a ciphered file every object inside one — page tree,
 * outlines, form fields — is absent from the document this app would rewrite. And
 * a file whose producer *claimed* a cipher without running one (the fork's own
 * `save({ encrypt })`) would be decrypted into garbage by a module that believed
 * the claim. Both are visible only from the parsed result, and `core/crypto`
 * answers them, so the guard's classification and the decrypt pass cannot disagree.
 */
function obstacles(encryption: PdfEncryption, doc: PDFDocument | null): PdfEncryption {
  if (encryption.state !== 'ciphered' || !encryption.supported || !doc) return encryption;
  const obstacle = readObstacle(doc);
  return obstacle ? { ...encryption, supported: false, refusal: obstacle } : encryption;
}

/** What a refusal is actually about, in the sentence's own words. */
const REFUSAL_CLAUSE: Record<UnsupportedReason, string> = {
  'aes-256': 'this app undoes AES-256 written by the revision-6 handler, and this file selects that cipher under another revision',
  'perms-mismatch': 'its /Perms check value does not decrypt to its own marker under the key its /U verifies, so the dictionary and the key disagree',
  'rc4-40': 'this app reads RC4 at 128 bits and above, and has no fixture for 40-bit RC4 to claim it',
  'public-key': 'it is locked by a certificate handler rather than a password this app can check',
  'unsupported-filter': 'the crypt filter it selects is one this app does not implement',
  'missing-parameters': 'its encryption dictionary is missing a value the key derivation needs',
  'no-aes-primitives': 'this browser offers no AES-CBC, so the cipher cannot be undone here',
  'object-streams': 'its objects live in compressed object streams, which this engine cannot re-read once ciphered',
  'plaintext-claim': 'the dictionary claims a cipher its producer never ran, and its page streams are already readable',
  // A gate is never refused — the filter it selects is `/None`, "the data are not
  // encrypted" — so this clause exists only to keep the list beside the type.
  'no-cipher': 'there is no cipher in force to undo',
};

/**
 * The refusal a content-rewriting tool gives a file whose streams are ciphertext
 * this app cannot undo.
 *
 * This app *reads* a locked document: pdf.js implements the ciphers, so the
 * preview, the page count and the extracted words are right, and every cipher
 * `core/crypto` undoes is edited normally now. What is refused here is the rest:
 * the engine would copy each page stream exactly as the file stores it and the
 * writer would label the copy with whatever filter the source claimed.
 * Measured over 18 runs by an outside-locked file: the right page count, the
 * password still working, and blank paper
 * (`docs/research/encrypted-inputs-findings.md` §3).
 *
 * The sentence names the cipher the dictionary actually selects *and* why this
 * one is refused, and never claims that encryption as such is unsupported — a
 * password gate whose crypt filter is `/None`, which is what this app's own
 * `protect` writes, keeps being edited normally because its streams are plaintext.
 */
export function cipheredInputError(name: string, encryption: PdfEncryption): ToolInputError {
  const why = encryption.refusal ? REFUSAL_CLAUSE[encryption.refusal] : 'this app cannot undo it';
  return new ToolInputError(
    'UNSUPPORTED',
    `${quote(name)} is encrypted with ${describeEncryption(encryption)}: its pages are stored as ciphertext, and ${why}.`,
    {
      fileName: name,
      hint: 'Decrypt the file in the program that locked it, then run it again. Its password alone does not help here: the right one lets this app open and preview the file, but the editing path would copy the page streams without decrypting them, and the copy opens as blank pages. Files locked with RC4-128, AES-128 or AES-256 (revision 6) are decrypted and edited normally now, and a file whose effective filter is /None — a password gate with no cipher, the shape this app’s own Protect wrote until it ran one — always was.',
    },
  );
}

/**
 * Report on a file without ever throwing, including on garbage input.
 */
export async function inspectPdf(
  bytes: Uint8Array,
  name: string,
  options: InspectOptions = {},
): Promise<PdfInspection> {
  return probePdf(bytes, name, options, { doc: null });
}

async function probePdf(
  bytes: Uint8Array,
  name: string,
  options: InspectOptions,
  opened: ParsedSink,
): Promise<PdfInspection> {
  const size = bytes.length;
  const isPdf = looksLikePdf(bytes);
  const truncated = size > 0 && !hasEofMarker(bytes);
  const version = headerVersion(bytes);
  const base: PdfInspection = {
    name,
    size,
    isPdf,
    pages: 0,
    declaredPages: null,
    encrypted: false,
    algorithm: null,
    encryption: null,
    needsPassword: false,
    passwordAccepted: false,
    passwordLevel: null,
    opensWithEmptyPassword: false,
    permissions: null,
    version,
    truncated,
    recovered: false,
    error: null,
    message: '',
  };

  if (size === 0) {
    const refusal = emptyFileError(name);
    return { ...base, error: refusal.code, message: refusal.message, hint: refusal.hint };
  }
  if (!isPdf) {
    const refusal = notAPdfError(name);
    return { ...base, error: refusal.code, message: refusal.message, hint: refusal.hint };
  }
  if (options.cheap) {
    const encrypted = looksEncrypted(bytes);
    // Without a parse the user-password hash is unreadable, so "encrypted" is
    // all a cheap check can claim; `preflightPdf` re-asks before refusing. The
    // `pages: 0` in `base` rides along unfilled: nothing was counted on this
    // branch, so no caller may read it as "the document has no pages".
    const locked = encrypted && !options.password;
    return {
      ...base,
      encrypted,
      needsPassword: locked,
      error: locked ? 'PASSWORD_REQUIRED' : null,
      message: locked ? `${quote(name)} is password protected.` : `${quote(name)} looks like a PDF.`,
      hint: locked ? 'Enter its password and run again.' : undefined,
    };
  }

  const outcome = await load(bytes, options.password);
  opened.doc = outcome.doc;
  const encrypted = outcome.encrypted || (outcome.doc?.isEncrypted ?? false);
  // Classify the lock only when one was found. An `/Encrypt` entry the parser
  // could not resolve to a dictionary still claims a handler, so it counts as
  // ciphered — the refusal an unreadable lock earns is "cannot decrypt", never a
  // copy of bytes nobody has read.
  const encryption = outcome.encryption;
  const declaredPages = outcome.doc ? declaredPageCount(outcome.doc) : null;
  const pages = outcome.doc ? safePageCount(outcome.doc) : 0;
  const recovered =
    outcome.doc !== null && (truncated || (declaredPages !== null && declaredPages !== pages));

  const info: PdfInspection = {
    ...base,
    pages,
    declaredPages,
    encrypted,
    algorithm: encryption.algorithm,
    encryption,
    needsPassword: outcome.refused === 'PASSWORD_REQUIRED',
    passwordAccepted: outcome.passwordAccepted,
    passwordLevel: outcome.passwordLevel,
    opensWithEmptyPassword: outcome.opensWithEmptyPassword,
    permissions: outcome.permissions,
    truncated,
    recovered,
  };

  if (outcome.refused === 'PASSWORD_REQUIRED') {
    return {
      ...info,
      error: 'PASSWORD_REQUIRED',
      message: `${quote(name)} is password protected.`,
      hint: `Enter the password for ${quote(name)} and run again.`,
    };
  }
  if (outcome.refused === 'BAD_PASSWORD') {
    return {
      ...info,
      needsPassword: true,
      error: 'BAD_PASSWORD',
      message: `That password is not correct for ${quote(name)}.`,
      hint: 'Check the password (it is case-sensitive) and try again.',
    };
  }
  if (!outcome.doc) {
    return {
      ...info,
      error: 'CORRUPT',
      message: `${quote(name)} is damaged: its PDF structure could not be parsed.`,
      hint: truncated
        ? 'The file has no end-of-file marker, so it was probably cut off while saving.'
        : 'Try a repair tool, or re-export the original.',
      detail: detailOf(outcome.detail),
    };
  }
  if (pages === 0) {
    return {
      ...info,
      error: 'NO_PAGES',
      message: `${quote(name)} has no pages.`,
      hint: 'Nothing to convert, and a repair will not add pages.',
    };
  }
  if (recovered) {
    return {
      ...info,
      message: `${quote(name)} is damaged but recoverable: read ${pages} of ${declaredPages ?? 'its'} pages.`,
      hint: 'Pages after the break may be missing from the output.',
    };
  }
  if (info.opensWithEmptyPassword) {
    return {
      ...info,
      message: `${quote(name)}: ${pages} page${pages === 1 ? '' : 's'}. Restricted, not locked — it opens without a password.`,
    };
  }
  return { ...info, message: `${quote(name)}: ${pages} page${pages === 1 ? '' : 's'}.` };
}

function safePageCount(doc: PDFDocument): number {
  try {
    return doc.getPageCount();
  } catch {
    return 0;
  }
}

function detailOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const oneLine = message.split('\n')[0].trim();
  return oneLine ? oneLine : 'the structure could not be parsed';
}

/**
 * The gate. Throws `ToolInputError` for anything a tool cannot honour and hands
 * back a parsed document plus the inspection that justified it — one parse, not
 * two, because a locked or damaged file is decided from the same load.
 *
 * `options.cheap` is ignored: a tool needs the document itself.
 */
export async function openPdfInput(
  bytes: Uint8Array,
  name: string,
  options: Omit<InspectOptions, 'cheap'> = {},
): Promise<{ doc: PDFDocument; inspection: PdfInspection }> {
  const opened: ParsedSink = { doc: null };
  const inspection = await probePdf(bytes, name, { ...options, cheap: false }, opened);
  if (inspection.error || !opened.doc) {
    throw new ToolInputError(inspection.error ?? 'CORRUPT', inspection.message, {
      fileName: name,
      hint: inspection.hint,
    });
  }
  return { doc: opened.doc, inspection };
}

/** How `preflightPdf` is asked what to guard against. */
export interface PreflightOptions {
  /**
   * Refuse an input whose content this app cannot decrypt — `ciphered`, in the
   * classification's vocabulary.
   *
   * The runner sets this for every tool that hands back a PDF rebuilt from the
   * source's own objects, because that is the copy that turns ciphertext into
   * blank paper. It stays off for tools whose result is text, a picture, an
   * archive or a report on screen: those read through pdf.js, which does undo
   * these ciphers, and refusing them would withhold something that works today.
   */
  rejectCiphered?: boolean;
}

/**
 * Header-and-trailer only, over a `File`-shaped source: reads at most the first
 * 1 KB and last 4 KB so a large document is not copied into memory just to be
 * rejected (E7). Returns the refusal, or `null` when the run may proceed.
 */
export async function preflightPdf(
  source: { name: string; size: number; blob: () => Blob },
  password?: string,
  options: PreflightOptions = {},
): Promise<ToolInputError | null> {
  const edges = await readEdges(source);
  let inspection = await inspectPdf(edges, source.name, { password, cheap: true });
  // The cheap pass can only see the `/Encrypt` **entry**. It cannot read the
  // dictionary, so it cannot tell a lock from a gate (E5), and cannot tell a real
  // crypt filter from the default `/None`. Either question is worth one parse, and
  // paying for it here is what keeps a genuinely unusable file from being named
  // halfway through a 500-page run (E4, E7).
  if (inspection.encrypted && (options.rejectCiphered || inspection.error)) {
    inspection = await inspectPdf(
      new Uint8Array(await source.blob().arrayBuffer()),
      source.name,
      { password },
    );
  }
  // Judged before the password verdict, deliberately: when the cipher is one this
  // app cannot undo, typing the right password does not unblock the run — so
  // "enter it and try again" would send the user off to do work that changes
  // nothing, and the file would still come back with empty pages.
  if (options.rejectCiphered && inspection.encryption?.state === 'ciphered' && !inspection.encryption.supported) {
    return cipheredInputError(source.name, inspection.encryption);
  }
  if (!inspection.error) return null;
  return new ToolInputError(inspection.error, inspection.message, {
    fileName: source.name,
    hint: inspection.hint,
  });
}

/**
 * Concatenate the two regions a cheap check needs. For files smaller than the
 * windows this is simply the whole file.
 */
async function readEdges(source: { name: string; size: number; blob: () => Blob }): Promise<Uint8Array> {
  if (source.size === 0) return new Uint8Array(0);
  const blob = source.blob();
  const size = Math.max(source.size, blob.size);
  if (size <= HEADER_WINDOW + TRAILER_WINDOW) {
    return new Uint8Array(await blob.arrayBuffer());
  }
  const headPart = new Uint8Array(await blob.slice(0, HEADER_WINDOW).arrayBuffer());
  const tailPart = new Uint8Array(await blob.slice(size - TRAILER_WINDOW, size).arrayBuffer());
  const joined = new Uint8Array(headPart.length + tailPart.length);
  joined.set(headPart, 0);
  joined.set(tailPart, headPart.length);
  return joined;
}

/* ------------------------------------------------------------------ numbers */

/**
 * Clamp into `[min, max]`, order-agnostically. A value that is not a finite
 * number lands on the nearer bound — `NaN` (an empty number input) on `min`,
 * `Infinity` on `max` — so nonsense never reaches pdf-lib as a page size.
 */
export function clampNumber(
  value: number,
  min: number,
  max: number,
  options: { integer?: boolean } = {},
): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (!Number.isFinite(value)) {
    const bound = value === Infinity ? hi : lo;
    return options.integer ? Math.round(bound) : bound;
  }
  const bounded = Math.min(hi, Math.max(lo, value));
  return options.integer ? Math.round(bounded) : bounded;
}

/** `1536` → `1.50 KB`, `912` → `912 B`. Used for every size the UI reports. */
export function describeSize(input: number | Uint8Array | ArrayBuffer | Blob): string {
  return formatBytes(
    typeof input === 'number'
      ? input
      : input instanceof Blob
        ? input.size
        : input.byteLength,
  );
}

/* -------------------------------------------------------------------- pages */

/** One inclusive 1-based page range. `to` is `Infinity` for the `7-` form. */
export interface PageRange {
  from: number;
  to: number;
}

export interface ParsePageRangesOptions {
  /** Page count of the target document, for E6 (`1-2` is valid only if it has 2). */
  total?: number;
}

/**
 * Parse the text of a "which pages" field into 1-based ranges.
 *
 * Tolerant of spacing, trailing commas, open ends (`7-`) and the `all`/`*`
 * keywords; strict about the things that silently change a document: `0`,
 * inverted ranges (`5-3`), and pages outside the file are rejected with a
 * reason. `core/pages.resolvePages` deliberately accepts more because it runs
 * after the user has committed; this runs before, and says why it refused.
 *
 * @throws {ToolInputError} with code `OUT_OF_RANGE`.
 */
export function parsePageRanges(
  input: string | null | undefined,
  options: ParsePageRangesOptions = {},
): PageRange[] {
  const total = options.total;
  const text = (input ?? '').trim().toLowerCase();
  if (text === '' || text === 'all' || text === '*') {
    return [{ from: 1, to: total ?? Infinity }];
  }
  if (text === 'odd' || text === 'even') {
    throw outOfRange(`"${text}" needs a page count; list the pages instead (1,3,5-7).`);
  }
  const ranges: PageRange[] = [];
  for (const raw of text.split(/[,;]+/)) {
    const token = raw.replace(/\s+/g, '');
    if (token === '') continue;
    ranges.push(parseToken(token, total));
  }
  if (ranges.length === 0) {
    throw outOfRange(`"${(input ?? '').trim()}" did not name any page.`);
  }
  return ranges;
}

function outOfRange(message: string): ToolInputError {
  return new ToolInputError('OUT_OF_RANGE', message, {
    hint: 'Use page numbers like 1, 3-5 or 7- (open-ended).',
  });
}

function parseToken(token: string, total?: number): PageRange {
  const bounds = token.match(/^(\d+)?(?:-|--|–|to|\.\.)(\d+)?$/);
  if (bounds) {
    const from = bounds[1] === undefined ? 1 : Number(bounds[1]);
    const to = bounds[2] === undefined ? Infinity : Number(bounds[2]);
    checkPage(from, token, total);
    if (Number.isFinite(to)) {
      checkPage(to, token, total);
      if (to < from) {
        throw outOfRange(
          `"${token}" runs backwards — page ${from} comes after page ${to}. Write ${to}-${from}.`,
        );
      }
    }
    return { from, to };
  }
  const single = Number(token);
  if (!/^\d+$/.test(token) || !Number.isInteger(single)) {
    throw outOfRange(`"${token}" is not a page number or a range like 3-5.`);
  }
  checkPage(single, token, total);
  return { from: single, to: single };
}

function checkPage(page: number, token: string, total?: number): void {
  if (page === 0) {
    throw outOfRange(`"${token}" refers to page 0; pages are numbered from 1.`);
  }
  if (total !== undefined && page > total) {
    throw outOfRange(
      `"${token}" refers to page ${page}, but this document has ${total} page${total === 1 ? '' : 's'}.`,
    );
  }
}

/** Expand parsed ranges into 1-based page numbers, in the order typed. */
export function expandPageRanges(
  ranges: readonly PageRange[],
  total: number,
): number[] {
  const out: number[] = [];
  for (const range of ranges) {
    const from = Math.max(1, range.from);
    if (from > total) {
      throw outOfRange(
        `Page ${range.from} is outside this document (1-${total}).`,
      );
    }
    const to = Math.min(total, Number.isFinite(range.to) ? range.to : total);
    for (let page = from; page <= to; page++) out.push(page);
  }
  return out;
}

/**
 * Why a page selection is unusable for a `total`-page document, or `null`.
 * The rail calls this to block the primary action (E6/E15) without a try/catch
 * in the render path.
 */
export function pageRangeProblem(input: unknown, total: number): string | null {
  const text = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (text === 'odd' || text === 'even') {
    const pages = tryResolvePages(text, total);
    return pages && pages.length > 0
      ? null
      : `This document has no ${text} pages (1-${total}).`;
  }
  try {
    expandPageRanges(parsePageRanges(text, { total }), total);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/* -------------------------------------------------------------------- fields */

/** Bounds a field declares, normalised so `min > max` typos cannot invert. */
export interface FieldBounds {
  min: number;
  max: number;
  integer: boolean;
  step?: number;
  unit?: string;
}

/** Numeric bounds of a field, or `null` when it is not a number field. */
export function fieldBounds(field: ToolField): FieldBounds | null {
  if (field.type !== 'number' && field.type !== 'slider') return null;
  const min = field.min ?? -Infinity;
  const max = field.max ?? Infinity;
  return {
    min: Math.min(min, max),
    max: Math.max(min, max),
    integer: field.integer === true,
    step: field.step,
    unit: field.unit,
  };
}

function rangeSentence(field: ToolField): string {
  const bounds = fieldBounds(field);
  if (!bounds) return '';
  const unit = bounds.unit ? ` ${bounds.unit}` : '';
  const hasMin = Number.isFinite(bounds.min);
  const hasMax = Number.isFinite(bounds.max);
  if (hasMin && hasMax) return bounds.min === bounds.max ? `${bounds.min}${unit}` : `between ${bounds.min} and ${bounds.max}${unit}`;
  if (hasMin) return `at least ${bounds.min}${unit}`;
  if (hasMax) return `at most ${bounds.max}${unit}`;
  return '';
}

/** A field the user must fix before the tool can run. */
export interface FieldIssue {
  key: string;
  label: string;
  code: 'REQUIRED' | 'NOT_A_NUMBER' | 'OUT_OF_RANGE' | 'NOT_INTEGER' | 'BAD_PATTERN' | 'BAD_PAGE_RANGE';
  message: string;
  /** Value that would satisfy the rule, when one exists (E15). */
  suggestion?: number;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** Fields hidden by a `when` predicate are neither validated nor clamped. */
function isVisible(field: ToolField, values: ToolValues): boolean {
  try {
    return field.when ? field.when(values) : true;
  } catch {
    // A predicate that throws on half-filled state stays visible rather than
    // silently dropping the field's validation.
    return true;
  }
}

/**
 * Is this empty field a problem? A predicate decides per state, and a predicate
 * that throws does not: unlike `isVisible`, which errs towards validating, this
 * one errs towards *not* blocking a run whose requirement is unknown — a field
 * the form cannot reason about must not refuse to let the user proceed.
 */
function demandsValue(field: ToolField, values: ToolValues): boolean {
  if (typeof field.required === 'function') {
    try {
      return field.required(values) === true;
    } catch {
      return false;
    }
  }
  return field.required === true;
}

/**
 * Every visible field that is wrong, in declaration order. Used by the rail for
 * inline messages and by the runner as a last line of defence (E15/E18).
 */
export function validateFields(
  fields: readonly ToolField[] | undefined,
  values: ToolValues,
): FieldIssue[] {
  const issues: FieldIssue[] = [];
  for (const field of fields ?? []) {
    if (!isVisible(field, values)) continue;
    const value = values[field.key];
    const optional = field.optional === true || field.required === false;
    if (isEmpty(value)) {
      if (!optional && demandsValue(field, values)) {
        issues.push({
          key: field.key,
          label: field.label,
          code: 'REQUIRED',
          message: field.missing ?? `${field.label} is required.`,
        });
      }
      continue;
    }
    const bounds = fieldBounds(field);
    if (bounds) {
      const numeric = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(numeric)) {
        issues.push({
          key: field.key,
          label: field.label,
          code: 'NOT_A_NUMBER',
          message: `${field.label} must be a number.`,
        });
        continue;
      }
      const rounded = bounds.integer ? Math.round(numeric) : numeric;
      if (numeric < bounds.min || numeric > bounds.max) {
        issues.push({
          key: field.key,
          label: field.label,
          code: 'OUT_OF_RANGE',
          message: `${field.label} must be ${rangeSentence(field)} (got ${numeric}).`,
          suggestion: clampNumber(numeric, bounds.min, bounds.max, { integer: bounds.integer }),
        });
        continue;
      }
      if (bounds.integer && !Number.isInteger(numeric)) {
        issues.push({
          key: field.key,
          label: field.label,
          code: 'NOT_INTEGER',
          message: `${field.label} must be a whole number (got ${numeric}).`,
          suggestion: rounded,
        });
        continue;
      }
    }
    if (field.pattern && typeof value === 'string') {
      const pattern = new RegExp(field.pattern);
      if (!pattern.test(value)) {
        issues.push({
          key: field.key,
          label: field.label,
          code: 'BAD_PATTERN',
          message: `${field.label} does not match the expected format.`,
        });
      }
    }
    if (field.type === 'pages') {
      const total = typeof values.pageTotal === 'number' ? values.pageTotal : undefined;
      const problem = total === undefined ? null : pageRangeProblem(value, total);
      if (problem) {
        issues.push({
          key: field.key,
          label: field.label,
          code: 'BAD_PAGE_RANGE',
          message: problem,
        });
      }
    }
    if (field.options?.length && (field.type === 'select' || field.type === 'segmented')) {
      const allowed = field.options.map((option) => option.value);
      if (!allowed.includes(value as string | number | boolean)) {
        issues.push({
          key: field.key,
          label: field.label,
          code: 'BAD_PATTERN',
          message: `${field.label} must be one of ${allowed.join(', ')}.`,
        });
      }
    }
  }
  return issues;
}

/** One value the runner changed on the user's behalf. */
export interface FieldClamp {
  key: string;
  label: string;
  from: number;
  to: number;
  message: string;
}

export interface ClampFieldsResult {
  values: ToolValues;
  changes: FieldClamp[];
}

/**
 * Fix every out-of-range number instead of failing the run, and report what
 * changed so the tool can say so out loud (E15: "clamped or rejected with a
 * reason" — this is the clamped half, and the reason is in `message`).
 */
export function clampFields(
  fields: readonly ToolField[] | undefined,
  values: ToolValues,
): ClampFieldsResult {
  const next: ToolValues = { ...values };
  const changes: FieldClamp[] = [];
  for (const field of fields ?? []) {
    if (!isVisible(field, values)) continue;
    const bounds = fieldBounds(field);
    if (!bounds) continue;
    const raw = values[field.key];
    const numeric = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(numeric)) continue;
    const fixed = clampNumber(numeric, bounds.min, bounds.max, { integer: bounds.integer });
    if (fixed === numeric) continue;
    next[field.key] = fixed;
    changes.push({
      key: field.key,
      label: field.label,
      from: numeric,
      to: fixed,
      message: `${field.label} must be ${rangeSentence(field)}: ${numeric} became ${fixed}.`,
    });
  }
  return { values: next, changes };
}
