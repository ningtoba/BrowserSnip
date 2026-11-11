/**
 * PDF document core.
 *
 * Wraps `@maxwbh/pdf-lib` — a maintained pdf-lib fork that adds AES/RC4
 * encryption on save, password-aware loading, file attachments and
 * incremental (append-only) saves. Incremental save is what lets us edit a
 * signed document without destroying the existing ByteRange signature, the
 * same strategy BentoPDF's text editor documents.
 *
 * Every operation in this app is local: bytes in, bytes out. Nothing here
 * ever touches the network except the explicit lazy engine loaders.
 */
import * as fontkitNamespace from '@pdf-lib/fontkit';
import {
  PDFDocument,
  PDFPage,
  PDFName,
  PDFDict,
  PDFHexString,
  PDFFlateStream,
  PDFRawStream,
  PDFRef,
  PDFArray,
  PDFContext,
  PDFNumber,
  PDFBool,
  PDFNull,
  PDFObject,
  PDFSecurity,
  PDFString,
  PDFStream,
  StandardFonts,
  rgb,
  cmyk,
  degrees,
  LineCapStyle,
  decodePDFRawStream,
} from '@maxwbh/pdf-lib';
import type {
  PDFFont,
  PDFImage,
  PDFEmbeddedPage,
  SaveOptions,
  EncryptOptions,
  PDFPermissions,
} from '@maxwbh/pdf-lib';
import { cropBox } from './pages';
import { decryptDocument, encryptDocument, resealDocument, retainedLock } from './crypto';
import type { CipherStrength, WritableStrength } from './crypto';
import {
  countOutlineNodes,
  readOutline,
  readPageLabelRanges,
  remapOutline,
  remapPageLabelRanges,
  writeOutline,
  writePageLabelRanges,
  type OutlineNode,
} from './bookmarks';
import { copyAttachments } from './attachments';

type FontkitInstance = Parameters<PDFDocument['registerFontkit']>[0];

// SAFETY: `@pdf-lib/fontkit` is a CommonJS module whose export *is* the fontkit
// instance pdf-lib expects (`{ create(buffer) }`). Depending on the bundler's
// interop mode it can arrive nested under `.default` instead; both shapes are
// the same runtime object, so narrowing to the registered instance is sound.
function resolveFontkit(): FontkitInstance {
  const ns = fontkitNamespace as { default?: FontkitInstance } & FontkitInstance;
  return ns.default ?? ns;
}

/** The fontkit instance registered on every document this module produces. */
export const fontkit: FontkitInstance = resolveFontkit();

export type Bytes = Uint8Array;

export interface OpenOptions {
  /** User or owner password. Required for encrypted documents. */
  password?: string;
  /**
   * Allow encrypted documents through without a password. Streams stay
   * encrypted, so page copying can yield blank output — prefer `password`.
   */
  ignoreEncryption?: boolean;
  /** Retain `/ID` and don't rewrite the modification date on save. */
  updateMetadata?: boolean;
}

/** Thrown when a document needs a password the caller did not supply. */
export class PasswordRequiredError extends Error {
  readonly name = 'PasswordRequiredError';
  constructor(message = 'This PDF is password protected.') {
    super(message);
  }
}

export function isPasswordError(err: unknown): boolean {
  if (err instanceof PasswordRequiredError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /encrypt|password/i.test(msg) && !/not encrypted/i.test(msg);
}

/**
 * Cheap structural check for an `/Encrypt` trailer entry without parsing.
 *
 * The key has to be recognised whatever follows it, because producers differ:
 * qpdf writes `/Encrypt 12 0 R`, MuPDF inlines the whole dictionary —
 * `/Encrypt<</Filter/Standard/R 3/V 2 …>>` — and a scan that only looked for the
 * reference spelling called every MuPDF-locked file unencrypted, which is how a
 * ciphered document reached an editing tool with nothing asked of it. The
 * delimiter must not be a word character, or `/EncryptMetadata` answers yes on a
 * file whose only crime is having permissions.
 */
export function looksEncrypted(bytes: Uint8Array): boolean {
  const tail = bytes.subarray(Math.max(0, bytes.length - 4096));
  const text = new TextDecoder('latin1').decode(tail);
  return /\/Encrypt(?![A-Za-z0-9_])/.test(text);
}

/**
 * Open a PDF. Unlike the previous `pdf-lib` call sites in this repo, a wrong
 * password is reported as a `PasswordRequiredError` so the UI can re-prompt
 * instead of showing a generic red banner.
 *
 * A file whose crypt filter names a real cipher is decrypted here first, so every
 * tool in the catalogue is handed plaintext rather than ciphertext — see
 * `decryptCipheredPDF` and `core/crypto.ts`.
 */
export async function openPDF(
  src: ArrayBuffer | Uint8Array | Bytes,
  options: OpenOptions = {},
): Promise<PDFDocument> {
  const bytes = toBytes(src);
  const { password, ignoreEncryption = false } = options;

  const decrypted = await decryptCipheredPDF(bytes, options);
  if (decrypted) return decrypted;

  if (password) {
    try {
      return await PDFDocument.load(bytes, { password, ignoreEncryption: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/encrypt/i.test(msg)) {
        throw new PasswordRequiredError(
          'That password is not correct for this PDF.',
        );
      }
      throw err;
    }
  }

  if (!ignoreEncryption && looksEncrypted(bytes)) {
    // pdf-lib refuses encrypted documents without ignoreEncryption; surface a
    // typed error the UI understands rather than an opaque parse failure.
    throw new PasswordRequiredError();
  }

  return PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: options.updateMetadata ?? true,
  });
}

/** What `PDFDocument.load` stamps into `/Info`; the decrypt pass repeats it. */
const LOADED_PRODUCER = 'pdf-lib (https://github.com/Hopding/pdf-lib)';

/**
 * Undo a real cipher, when `core/crypto` can, and hand back a plaintext document.
 *
 * `null` means "this is not the path for this file", and every caller's existing
 * behaviour then applies untouched: no `/Encrypt` entry at all; a gate whose
 * effective crypt filter is `/None` (what this app's own `protect` writes, whose
 * streams were never ciphered); a cipher this app refuses by name, such as a
 * public-key handler, a file whose objects live in object streams, or AES-256 under
 * a handler revision other than 6; a lock whose secret did not open it; and a file
 * too damaged to parse, whose error the ordinary path reports. Keeping the
 * exception list on the returning-null side
 * is what limits this to the case that was actually broken — a file with
 * ciphertext behind its dictionary, and the password to open it.
 */
async function decryptCipheredPDF(
  bytes: Bytes,
  options: OpenOptions,
): Promise<PDFDocument | null> {
  if (!looksEncrypted(bytes)) return null;
  let doc: PDFDocument;
  try {
    // The structure is readable whatever the cipher: `pdf-lib` only checks a
    // password when asked to, and checking one is not the same as undoing it.
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return null;
  }
  const outcome = await decryptDocument(doc, options.password);
  if (outcome.kind !== 'decrypted') return null;
  // Stamped *after* the strings are readable: loading with `updateMetadata` would
  // write a plaintext ModDate into a still-ciphered document, and the pass would
  // then decrypt its own stamp into mojibake.
  if (options.updateMetadata !== false) {
    const now = new Date();
    doc.setProducer(LOADED_PRODUCER);
    doc.setModificationDate(now);
    if (!doc.getCreator()) doc.setCreator(LOADED_PRODUCER);
    if (!doc.getCreationDate()) doc.setCreationDate(now);
  }
  return doc;
}

export async function newPDF(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  return doc;
}

/** Register fontkit on a document that came from `openPDF`. Idempotent. */
export function withFontkit(doc: PDFDocument): PDFDocument {
  try {
    doc.registerFontkit(fontkit);
  } catch {
    /* already registered, or the fork rejects a duplicate */
  }
  return doc;
}

export interface SavePdfOptions extends SaveOptions {
  /** Force the `/ID` + ModDate refresh. Defaults to pdf-lib behaviour. */
  compress?: boolean;
}

export async function savePDF(
  doc: PDFDocument,
  options: SavePdfOptions = {},
): Promise<Bytes> {
  const { compress, ...rest } = options;
  return doc.save({ useObjectStreams: compress ?? true, ...rest });
}

export interface PasswordOptions {
  userPassword?: string;
  ownerPassword?: string;
  permissions?: PDFPermissions;
  /**
   * The strength to write. Absent means AES-128, which is the strength this app
   * has measured against five outside readers; `AES-256` is offered because
   * `core/crypto` now writes it *and* reads it back, and is checked against pypdf
   * and MuPDF by `docs/research/aes256-write-readers.py`.
   */
  cipher?: WritableStrength;
}

/**
 * The `/P` integer for the permission switches a caller holds (Table 25).
 *
 * Bits 1-2 are always 0 and bits 7-8 and 13-32 always 1, so an all-on set is
 * `-4` rather than `-1`; the six actions a reader can be refused are the rest.
 * These same four bytes feed the file key, `/U` and `/Perms`, which is why an
 * unset box changes the key and a protected file cannot be re-keyed by editing
 * the dictionary — the check `/Perms` exists to make.
 */
export function permissionsToFlags(permissions: PDFPermissions | undefined): number {
  const flags: [keyof PDFPermissions, number][] = [
    ['printing', 0x0004],
    ['modifying', 0x0008],
    ['copying', 0x0010],
    ['annotating', 0x0020],
    ['fillingForms', 0x0100],
    ['contentAccessibility', 0x0200],
    ['documentAssembly', 0x0400],
    ['printingHighQuality', 0x0800],
  ];
  let value = 0xfffff0c0;
  for (const [key, mask] of flags) {
    if (permissions?.[key]) value |= mask;
  }
  return value | 0;
}

/**
 * The password gate, the `/P` flags **and the cipher**: AES-128 or AES-256.
 *
 * `@maxwbh/pdf-lib`'s own `save({ encrypt })` registers an `/Encrypt` dictionary
 * and a document `/ID`, and its `PDFSecurity` computes `/O` and `/U` to spec —
 * but nothing ever calls `PDFSecurity.encryptStream` or `encryptString`, so every
 * stream left the tab as plaintext behind a dictionary that said otherwise. That
 * is why this file used to write the crypt filter `/None` out loud: the honest
 * shape for an engine that ran no cipher.
 *
 * The cipher exists now, in `core/crypto.ts:encryptDocument`, at the two strengths
 * this module has written *and* read back against an implementation that is not
 * this app's: `/V 4 /R 4` with `/CF /StdCF /CFM /AESV2 /Length 16`, and `/V 5 /R 6`
 * with `/CF /StdCF /CFM /AESV3 /Length 32`, either one selected by `/StmF` and
 * `/StrF`, with every stream and string ciphered on the way out. RC4-128 is read
 * but never written: this app has no outside measurement of its own RC4 output,
 * and writing a strength nobody has confirmed would turn a protected download into
 * blank paper the moment the user re-opened it here.
 *
 * The dictionary is assembled there rather than by `save({ encrypt })` for the
 * same reason the `/None` gate was: `setupEncryption` writes a cipher claim it
 * does not run.
 */
export async function saveEncrypted(
  doc: PDFDocument,
  opts: PasswordOptions,
): Promise<Bytes> {
  const user = opts.userPassword ?? '';
  const owner =
    opts.ownerPassword && opts.ownerPassword.length > 0
      ? opts.ownerPassword
      : user || randomOwnerPassword();

  if (!opts.userPassword && !opts.ownerPassword) {
    throw new Error('Enter an owner or a user password to protect this PDF.');
  }

  // Whatever the writer would create *while* it writes has to exist before the
  // cipher runs: field appearances are generated inside `save()`, page content
  // and embedded assets are flushed there, and an object born after the walk
  // would be serialized in the clear behind a dictionary that says ciphertext.
  // Saving once and discarding the bytes is how that is guaranteed without
  // reaching into the vendor's private form cache; the second save is the file.
  await sealWriterCreatures(doc);

  // `/V`+`/R`, the crypt filter, `/O`, `/U`, the revision-6 `/OE` and `/UE`,
  // `/Perms` and the document `/ID` they are derived from are written there, along
  // with every ciphered stream and string; `save()` alone never touches them.
  //
  // `/EncryptMetadata` is decided here rather than left to the writer's default:
  // the title, author and XMP packet are part of what an open password is hiding,
  // and every outside fixture this app's reader was measured against either writes
  // `true` or omits the key (which means `true`). A file that left the metadata in
  // the clear would be a different promise, so it is not this app's default.
  await encryptDocument(doc, {
    userPassword: user,
    ownerPassword: owner,
    permissions: permissionsToFlags(opts.permissions),
    strength: opts.cipher ?? 'AES-128',
    encryptMetadata: true,
  });

  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

/**
 * Put a source file's own protection back on the copy an edit produced.
 *
 * `protect` and `change-permissions` know the secret they were given; a routine
 * edit does not — it holds a document whose cipher `openPDF` already undid, and
 * the lock it undid. Re-deriving a lock from scratch there would replace the
 * owner password with a new one, so renaming a title would quietly take away the
 * secret that lifts a file's restrictions (measured: MuPDF answers 0 and qpdf
 * `PasswordError` to the original owner password afterwards). Carrying the
 * source's dictionary, file key and `/ID[0]` forward keeps every secret the user
 * already holds working, and keeps the strength the source was written at — an
 * RC4-128 file comes back RC4-128, a gate comes back a gate.
 *
 * `null` means there is no lock to carry: the source has none, its cipher is one
 * this app refuses, or the secret on offer did not open it. The caller then says
 * what the copy lost rather than pretending it kept it.
 */
export async function resealLikeSource(
  doc: PDFDocument,
  source: Bytes,
  password?: string,
): Promise<{ bytes: Bytes; strength: CipherStrength | null } | null> {
  const lock = await retainedLock(source, password);
  if (!lock) return null;
  await sealWriterCreatures(doc);
  await resealDocument(doc, lock);
  return {
    bytes: await doc.save({ useObjectStreams: false, updateFieldAppearances: false }),
    strength: lock.cipher?.strength ?? null,
  };
}

/**
 * Serialize a document once and throw the bytes away.
 *
 * The rule both sealed saves need: everything `save()` would create while it
 * writes — field appearances, pending page content, embedded assets — has to
 * exist *before* a cipher pass walks the objects, or it lands in the clear
 * behind a dictionary that says ciphertext. Both saves pass
 * `useObjectStreams: false`, which is not a size preference either: the vendor
 * inflates object streams while it *parses*, before any decryptor is consulted,
 * so a ciphered file that packs its dictionaries into one is a file this app
 * writes and cannot read back — the shape
 * `core/crypto.ts:objectStreamsUnreadable` refuses on sight.
 */
async function sealWriterCreatures(doc: PDFDocument): Promise<void> {
  await doc.save({ useObjectStreams: false });
}

function randomOwnerPassword(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Snapshot + `saveIncremental` pair for append-only revisions. */
export async function saveIncremental(
  doc: PDFDocument,
  encrypt?: EncryptOptions,
): Promise<Bytes> {
  // takeSnapshot must be called before the edits for a true append; when the
  // caller did not snapshot early we fall back to a full save, which is still
  // correct, just not byte-append-only.
  try {
    const bytes = await doc.saveIncremental({});
    if (bytes && bytes.length > 0) return bytes;
  } catch {
    /* fall through */
  }
  return doc.save(encrypt ? { encrypt } : {});
}

export async function snapshot(doc: PDFDocument): Promise<void> {
  try {
    await doc.takeSnapshot();
  } catch {
    /* the fork tolerates a missing snapshot and full-saves instead */
  }
}

/** Clone a document by round-tripping its bytes — cheap isolation between tools. */
export async function clonePDF(
  doc: PDFDocument,
  options: SavePdfOptions = {},
): Promise<PDFDocument> {
  const bytes = await savePDF(doc, options);
  return openPDF(bytes, { ignoreEncryption: true });
}

/**
 * Import pages from one or more documents into a fresh document, preserving
 * the requested order and mapping source indices to destination pages.
 *
 * This is **the** page-copy primitive: every tool that rebuilds a document from
 * copied pages comes through here or through `carryPageFurniture` directly. A
 * copy moves page objects, and page objects are not where the bookmarks, the page
 * numbering or the embedded files live — see `carryPageFurniture` for what travels
 * and what the caller has to admit it lost.
 */
export async function collectPages(
  sources: { doc: PDFDocument; pages: number[] }[],
): Promise<{
  doc: PDFDocument;
  ranges: { start: number; count: number }[];
  fidelity: CopyFidelity;
}> {
  const target = await newPDF();
  const ranges: { start: number; count: number }[] = [];
  const copies: PageCopyMap[] = [];
  for (const { doc, pages } of sources) {
    if (pages.length === 0) continue;
    const start = target.getPageCount();
    const copied = await target.copyPages(doc, pages);
    copied.forEach((p) => target.addPage(p));
    ranges.push({ start, count: pages.length });
    // Destination order, duplicates included: a page used twice is two sheets here,
    // and the numbering of the second one is not "the next page's".
    const placed: PagePlacement[] = pages.map((page, offset) => ({
      source: page,
      dest: start + offset,
    }));
    copies.push({ doc, placed });
  }
  const fidelity = await carryPageFurniture(target, copies);
  return { doc: target, ranges, fidelity };
}

/** One sheet a page copy placed: where it came from, and where it landed. */
export interface PagePlacement {
  /** Page index in the document the sheet was copied **from**. */
  source: number;
  /** Page index of that sheet in the document the copy is building. */
  dest: number;
}

/** A source document and where its pages landed in a copy. */
export interface PageCopyMap {
  doc: PDFDocument;
  /**
   * Every sheet the copy placed, in destination order. A source page copied twice
   * appears twice, which is what the page numbering has to know: two sheets came
   * from one page, so they carry the same label rather than consecutive ones.
   *
   * For the bookmarks, where one destination can only be one place, the derived
   * first-copy view is used instead — see `remapOutline`.
   */
  placed: PagePlacement[];
}

/**
 * The bookmark view of a copy: source page → the sheet it landed on.
 *
 * Where a page was copied twice the **first** copy wins, because a bookmark names a
 * place in the reading order and a reader follows it to the first sheet, and pages
 * that stayed home are absent.
 */
export function firstCopyOf(placed: PagePlacement[]): Map<number, number> {
  const mapping = new Map<number, number>();
  for (const { source, dest } of placed) {
    if (!mapping.has(source)) mapping.set(source, dest);
  }
  return mapping;
}

/** What a page copy did with the parts of a document that are not pages. */
export interface CopyFidelity {
  /** Bookmarks re-pointed at the copied pages and written to the output. */
  bookmarks: number;
  /** Bookmarks dropped because their destination page is not in the output. */
  bookmarksDropped: number;
  /** Embedded files that travelled with the pages. */
  attachments: number;
  /** Embedded files left behind because that name had already been carried. */
  attachmentsCollided: number;
  /**
   * Page-numbering ranges written to the output, addressed in **destination** pages.
   *
   * Counted in ranges, not pages: a range runs until the next one starts, so one
   * entry can number the whole file.
   */
  labels: number;
  /** Ranges the copy left with no sheet to number, so they are gone. */
  labelsDropped: number;
}

/**
 * Carry the outline, the embedded files and the page numbering of the copied
 * documents into the new one, and report what could not come.
 *
 * All three live above the page tree — `/Outlines`, `/Names → /EmbeddedFiles` and
 * `/PageLabels` on the catalog, `/AF` on the document — so `copyPages` leaves them
 * with the file they came from. Measured on an unencrypted fixture, that cost every
 * rebuilding tool its whole table of contents and every attached source file,
 * silently, and the numbering with them: a book MuPDF numbers `i, ii, I, II, c, xA`
 * came back with **no label store at all**, so it opens, it has the right page count,
 * and every page number a user cites from it silently changes meaning.
 *
 * A bookmark whose destination page was **not** copied is dropped rather than snapped
 * to the nearest surviving page; `remapOutline` carries the reasoning and the count,
 * which the tool owes the user as a warning. A label range whose pages were all
 * dropped disappears for the same reason (`remapPageLabelRanges`), and a document
 * that never had a numbering is not given one.
 */
export async function carryPageFurniture(
  target: PDFDocument,
  copies: PageCopyMap[],
  options: { outlines?: boolean; attachments?: boolean } = {},
): Promise<CopyFidelity> {
  const wantOutlines = options.outlines !== false;
  const nodes: OutlineNode[] = [];
  let bookmarksDropped = 0;
  if (wantOutlines) {
    for (const { doc, placed } of copies) {
      const remapped = remapOutline(readOutline(doc), firstCopyOf(placed));
      nodes.push(...remapped.nodes);
      bookmarksDropped += remapped.dropped;
    }
  }
  // `writeOutline` replaces whatever is there, so the whole tree goes in one go:
  // writing it per source would keep only the last document's bookmarks.
  if (nodes.length > 0) writeOutline(target, nodes);
  const files =
    options.attachments === false
      ? { carried: 0, collided: 0 }
      : await copyAttachments(
          target,
          copies.map((copy) => copy.doc),
        );
  // Same rule as the bookmarks: one pass over every source, because the writer
  // replaces the store and a per-source call would keep only the last file's
  // numbering. Ranges come back addressed in destination pages already, which is
  // what lets a merge concatenate them without either file overwriting the other.
  const labels = remapPageLabelRanges(
    copies.map((copy) => ({
      ranges: readPageLabelRanges(copy.doc),
      placed: copy.placed,
    })),
    target.getPageCount(),
  );
  if (labels.ranges.length > 0) writePageLabelRanges(target, labels.ranges);
  return {
    bookmarks: countOutlineNodes(nodes),
    bookmarksDropped,
    attachments: files.carried,
    attachmentsCollided: files.collided,
    labels: labels.ranges.length,
    labelsDropped: labels.dropped,
  };
}

/**
 * Draw a source page onto a target page as a form XObject. This is the
 * primitive behind N-up, booklet, overlay, posterize, rotate-by-arbitrary-
 * angle and fix-page-size: it scales and repositions real vector content
 * instead of rasterising it.
 *
 * The source is measured **per page**, from its own visible box (E8): a
 * document whose second sheet is a different size is not squeezed into the
 * first sheet's rectangle. Two things the page content stream does not carry
 * are re-applied here, because `embedPage` copies the raw stream (B1 item 1):
 *
 * - `/Rotate` is a display instruction, so an embedded page comes out sideways
 *   unless the turn is composed into the draw matrix (E9). `options.rotate` is
 *   an **extra clockwise** turn on top of the page's own `/Rotate` — clockwise
 *   is what `/Rotate`, the UI and a viewer all mean — and the two are added
 *   before being negated for pdf-lib, whose content matrix turns
 *   counter-clockwise.
 * - the box origin is honoured by clipping to the visible box **in the page's
 *   own coordinates**, which is what shifts an offset `/MediaBox` (e.g. a
 *   scanned sheet at `[36 36 612 792]`) back onto the cell instead of cropping
 *   its left and bottom edges away.
 *
 * The turn is composed around the centre of that box: the rotated bounding
 * rectangle is what gets scaled into `box`, so a quarter-turned sheet fills a
 * cell sized for it as displayed rather than overflowing its neighbour.
 *
 * `box` names a place on the **visible sheet**, not in raw user space, for the same
 * reason the source is measured from its own `cropBox`: a page whose `/MediaBox` is
 * `[36 36 612 792]` has its bottom-left corner at (36, 36), so a cell aimed at that
 * sheet's own (0, 0) used to be drawn 36 pt off the corner — legal geometry, and no
 * ink where the user asked for it.
 */
export async function drawPageInto(
  target: PDFDocument,
  page: PDFPage,
  source: PDFPage,
  box: { x: number; y: number; width: number; height: number },
  options: { scale?: number; rotate?: number; opacity?: number } = {},
): Promise<PDFEmbeddedPage> {
  const region = cropBox(source);
  const embedded = await target.embedPage(source, {
    left: region.x,
    bottom: region.y,
    right: region.x + region.width,
    top: region.y + region.height,
  });

  const clockwise = normalise360(pageRotation(source) + (options.rotate ?? 0));
  const radians = (-clockwise * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  // The embedder shifts the region's bottom-left to the origin, so the four
  // corners of the visible box are what the draw matrix turns.
  const corners = [
    [0, 0],
    [region.width, 0],
    [0, region.height],
    [region.width, region.height],
  ].map(([x, y]) => [snap(x * cos - y * sin), snap(x * sin + y * cos)] as const);
  const minX = Math.min(...corners.map((c) => c[0]));
  const maxX = Math.max(...corners.map((c) => c[0]));
  const minY = Math.min(...corners.map((c) => c[1]));
  const maxY = Math.max(...corners.map((c) => c[1]));
  const drawnWidth = maxX - minX;
  const drawnHeight = maxY - minY;
  if (drawnWidth <= 0 || drawnHeight <= 0 || box.width <= 0 || box.height <= 0) {
    // Nothing this cell can hold: a zero-area source box or target box would
    // only write `0 0 0 0 … cm`, which no viewer draws.
    return embedded;
  }

  const scale = (options.scale ?? 1) * Math.min(box.width / drawnWidth, box.height / drawnHeight);
  // The cell is relative to the sheet being filled, whose corner is not always the
  // origin of the coordinates `drawPage` writes into.
  const sheet = cropBox(page);
  page.drawPage(embedded, {
    x: sheet.x + box.x + (box.width - drawnWidth * scale) / 2 - minX * scale,
    y: sheet.y + box.y + (box.height - drawnHeight * scale) / 2 - minY * scale,
    xScale: scale,
    yScale: scale,
    rotate: degrees(-clockwise),
    opacity: options.opacity,
  });
  return embedded;
}

/** A page's own `/Rotate` as a clockwise angle in 0–359 (0 when absent). */
export function pageRotation(page: PDFPage): number {
  return normalise360(page.getRotation().angle);
}

/** `450 → 90`, `-90 → 270`; readers take `/Rotate` modulo 360 and writers do emit both. */
function normalise360(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

/** Clear the `6.1e-17` a quarter turn leaves behind. */
function snap(value: number): number {
  return Math.abs(value) < 1e-9 ? 0 : value;
}

/** Low-level access used by the annotation / metadata / content modules. */
export {
  PDFDocument,
  PDFPage,
  PDFName,
  PDFDict,
  PDFHexString,
  PDFFlateStream,
  PDFRawStream,
  PDFRef,
  PDFArray,
  PDFContext,
  PDFNumber,
  PDFBool,
  PDFNull,
  PDFObject,
  PDFSecurity,
  PDFString,
  PDFStream,
  StandardFonts,
  rgb,
  cmyk,
  degrees,
  LineCapStyle,
  decodePDFRawStream,
};
export type { PDFFont, PDFImage, PDFEmbeddedPage, EncryptOptions, PDFPermissions };

export function toBytes(src: ArrayBuffer | Uint8Array | Bytes): Uint8Array {
  if (src instanceof Uint8Array) return src;
  return new Uint8Array(src);
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export async function blobToBytes(blob: Blob): Promise<Bytes> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** Document catalog helpers shared by several tools. */
export function catalog(doc: PDFDocument) {
  return doc.catalog;
}

export function context(doc: PDFDocument): PDFContext {
  return doc.context;
}

/** Read the PDF version header the fork exposes on the context. */
export function pdfVersion(doc: PDFDocument): string {
  const header = pdfHeaderOf(doc);
  const text = typeof header === 'string' ? header : String(header ?? '');
  const m = text.match(/PDF-(\d\.\d)/);
  return m ? m[1] : '1.7';
}

/** Versions a `%PDF-M.m` line can carry; the ones tools ever need to ask for. */
export type PdfVersion = '1.4' | '1.5' | '1.6' | '1.7' | '2.0';

/**
 * The `PDFHeader` the fork keeps on the context. `major`/`minor` are `private`
 * in the class, which is a compile-time-only label: at runtime they are plain
 * writable own properties, and the class itself is not exported.
 */
type PdfHeader = { major: string; minor: string; toString(): string };

function pdfHeaderOf(doc: PDFDocument): PdfHeader | string | undefined {
  // SAFETY: `PDFHeader` is not exported by the fork, so the only honest shape
  // for the field is the two digits it stores plus `toString()`.
  return (doc.context as unknown as { header?: PdfHeader | string }).header;
}

/** `1.5 < 1.7` — the numeric comparison a version string cannot get by with. */
function comparePdfVersions(a: string, b: string): number {
  const [am = 0, an = 0] = a.split('.').map(Number);
  const [bm = 0, bn = 0] = b.split('.').map(Number);
  return am !== bm ? am - bm : an - bn;
}

/**
 * Raise the PDF version a document declares (B2 item 1): a tool that writes
 * object streams into a file that still says `1.4` has to say `1.5` first,
 * instead of only warning about the mismatch.
 *
 * It raises and never lowers — downgrading a file that already uses newer
 * structures would make it read worse, not better — and returns the version
 * the document declares afterwards, which is what a caller should report.
 *
 * Two surfaces carry the claim and this only reaches one of them: the fork's
 * full-save writers hard-code `%PDF-1.7`, while `saveIncremental` copies the
 * original bytes verbatim. Use `applyPdfVersion` on the saved bytes when the
 * emitted header itself has to change.
 */
export function setPdfVersion(doc: PDFDocument, version: PdfVersion): string {
  const header = pdfHeaderOf(doc);
  if (!header || typeof header === 'string') return pdfVersion(doc);
  const current = pdfVersion(doc);
  if (comparePdfVersions(version, current) <= 0) return current;
  const [major, minor] = version.split('.');
  header.major = major ?? '1';
  header.minor = minor ?? '7';
  return version;
}

/**
 * Rewrite the `%PDF-M.m` line of already-saved bytes, raising it to `version`.
 *
 * Every version string is the same width and the patch is done in place, so it
 * cannot move a byte an xref offset points at — which is the whole reason it is
 * safe to apply to a finished file rather than re-saving it.
 */
export function applyPdfVersion(bytes: Bytes, version: PdfVersion): Bytes {
  const text = new TextDecoder('latin1').decode(bytes.subarray(0, 9));
  const match = /^%PDF-(\d\.\d)/.exec(text);
  if (!match || comparePdfVersions(version, match[1]) <= 0) return bytes;
  const major = version.charCodeAt(0);
  const minor = version.charCodeAt(2);
  bytes[5] = major;
  bytes[7] = minor;
  return bytes;
}
