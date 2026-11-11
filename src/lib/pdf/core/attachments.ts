/**
 * Embedded files (attachments).
 *
 * `@maxwbh/pdf-lib` can *write* an attachment — `PDFDocument.attach(bytes,
 * name, options)` — but it has no reader and no remover, and `attach()` only
 * materialises its name-tree entries when the document is flushed (i.e. on
 * `save()`). So:
 *
 * * `addAttachments` calls `attach()` and then `doc.flush()` itself, which makes
 *   the entries visible to `listAttachments` without a save round-trip;
 * * `listAttachments` reads every place a PDF may name an embedded file: the
 *   catalog `/Names → /EmbeddedFiles` tree, each page's own
 *   `/Names → /EmbeddedFiles` tree, the PDF 2.0 catalog `/AF` array (which is
 *   what `attach()` also writes), and `/FileAttachment` annotations;
 * * `removeAttachments` splices those structures and deletes the objects nobody
 *   refers to any more.
 *
 * The fork's `FileEmbedder` writes `/Params /Size` and the dates but never
 * `/CheckSum`, so `addAttachments` stores the MD5 the spec asks for
 * (ISO 32000-1 §7.11.3) and `listAttachments` computes it when a foreign
 * document left it out.
 */
import { md } from 'node-forge';
import type { PDFDocument } from '@maxwbh/pdf-lib';
// `PDFString`, `PDFStream` and `AFRelationship` are not re-exported by ./doc.
import { AFRelationship, PDFStream, PDFString } from '@maxwbh/pdf-lib';
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRef,
  context,
} from './doc';
import {
  decodeTextString,
  formatPdfDate,
  parsePdfDate,
  streamBytes,
  toLocalBytes,
} from './metadata';
import { mimeForFile } from './images';

export interface AttachmentEntry {
  /** The key this file is filed under in the name tree (or its filename). */
  name: string;
  /** `/UF` when present, else `/F` — the file's real name. */
  filename?: string;
  mimeType?: string;
  description?: string;
  /** Size of the decoded payload in bytes. */
  size: number;
  /** `/Params /CreationDate` as a canonical PDF date string. */
  creationDate?: string;
  /** `/Params /ModDate` as a canonical PDF date string. */
  modificationDate?: string;
  /** Lower-case hex MD5 of `bytes` (from `/Params /CheckSum` when stored). */
  checksum?: string;
  bytes: Uint8Array;
}

export interface AttachmentInput {
  name: string;
  bytes: Uint8Array;
  mimeType?: string;
  description?: string;
}

/** Where a file specification is referenced from. */
interface FilespecSite {
  /** The key this file is filed under (or the spec's own name). */
  name: string;
  /**
   * The file specification dictionary itself. §7.9.6 lets a name-tree value be
   * an indirect reference **or** an inline dictionary, and both occur in files
   * this app is handed, so the dictionary — not a reference — is what is known.
   */
  spec: PDFDict;
  /** Its reference, when it has one. An inline spec is removed with its pair. */
  ref?: PDFRef;
  /** The name-tree `/Names` array holding the key/value pair, if any. */
  tree?: PDFArray;
  /** `/AF` array or `/FileAttachment` annotation dictionary, if that is the host. */
  host?: PDFDict | PDFArray;
}

/** The keys `/EF` may name, in the order a viewer should prefer them. */
const EF_KEYS = ['UF', 'F', 'DOS', 'UNIX', 'Mac'] as const;

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

function binaryString(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

/** MD5 as lower-case hex — the digest PDF stores in `/CheckSum`. */
export function md5Hex(bytes: Uint8Array): string {
  const digest = md.md5.create();
  digest.update(binaryString(bytes));
  return digest.digest().toHex();
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(Math.ceil(hex.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Finding the file specifications a document references
// ---------------------------------------------------------------------------

/**
 * Follow one indirection without asking pdf-lib what class the object should be.
 *
 * The fork's `lookupMaybe` throws `UnexpectedObjectTypeError` on a class
 * mismatch rather than answering `undefined`, so asking for a `PDFDict` at a key
 * that holds a stream took the whole listing down with an engine sentence in the
 * user's face. A reader of foreign files asks what something *is* and moves on
 * when it is not what it hoped.
 */
function resolve(doc: PDFDocument, value: PDFObject | undefined): PDFObject | undefined {
  return value instanceof PDFRef ? context(doc).lookup(value) : value;
}

function asDict(value: unknown): PDFDict | undefined {
  return value instanceof PDFDict ? value : undefined;
}

/**
 * Is this object a dictionary worth reading as a file specification?
 *
 * `/Type /Filespec` is written by some producers and omitted by others, so the
 * entry keys stand in for it. The check is still worth making: a
 * `/FileAttachment` annotation's `/A` launch action is a dictionary too, and it
 * is not the file.
 */
function looksLikeFilespec(value: unknown): value is PDFDict {
  if (!(value instanceof PDFDict)) return false;
  const type = value.lookupMaybe(PDFName.of('Type'), PDFName);
  if (type !== undefined && type.decodeText() !== 'Filespec') return false;
  return (
    value.has(PDFName.of('EF')) ||
    value.has(PDFName.of('F')) ||
    value.has(PDFName.of('UF'))
  );
}

/** Walk a name tree (`/Names` pairs and/or `/Kids` subtrees). */
function collectNameTree(
  doc: PDFDocument,
  root: PDFDict | undefined,
  out: FilespecSite[],
  depth = 0,
): void {
  if (!root || depth > 32) return;
  const names = resolve(doc, root.get(PDFName.of('Names')));
  if (names instanceof PDFArray) {
    for (let i = 0; i + 1 < names.size(); i += 2) {
      const key = decodeTextString(resolve(doc, names.get(i)));
      const value = names.get(i + 1);
      const spec = resolve(doc, value);
      if (key !== undefined && looksLikeFilespec(spec)) {
        out.push({
          name: key,
          spec,
          ...(value instanceof PDFRef ? { ref: value } : {}),
          tree: names,
        });
      }
    }
  }
  const kids = resolve(doc, root.get(PDFName.of('Kids')));
  if (kids instanceof PDFArray) {
    for (let i = 0; i < kids.size(); i++) {
      collectNameTree(doc, asDict(resolve(doc, kids.get(i))), out, depth + 1);
    }
  }
}

/** The name a file specification carries: `/UF` — the Unicode name — then `/F`. */
function specName(doc: PDFDocument, spec: PDFDict): string | undefined {
  return (
    decodeTextString(resolve(doc, spec.get(PDFName.of('UF')))) ??
    decodeTextString(resolve(doc, spec.get(PDFName.of('F'))))
  );
}

/**
 * Every file specification the document references, tagged with where it is
 * referenced from so removal can undo exactly that.
 */
function filespecSites(doc: PDFDocument): FilespecSite[] {
  const sites: FilespecSite[] = [];

  const names = asDict(resolve(doc, doc.catalog.get(PDFName.of('Names'))));
  collectNameTree(
    doc,
    asDict(resolve(doc, names?.get(PDFName.of('EmbeddedFiles')))),
    sites,
  );

  for (const page of doc.getPages()) {
    const pageNames = asDict(resolve(doc, page.node.get(PDFName.of('Names'))));
    collectNameTree(
      doc,
      asDict(resolve(doc, pageNames?.get(PDFName.of('EmbeddedFiles')))),
      sites,
    );
  }

  // PDF 2.0 associated-files array: the entries are file specs with no key.
  const af = resolve(doc, doc.catalog.get(PDFName.of('AF')));
  if (af instanceof PDFArray) {
    for (let i = 0; i < af.size(); i++) {
      const value = af.get(i);
      const spec = resolve(doc, value);
      if (!looksLikeFilespec(spec)) continue;
      const name = specName(doc, spec);
      if (name) sites.push({ name, spec, ...(value instanceof PDFRef ? { ref: value } : {}), host: af });
    }
  }

  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annot = asDict(resolve(doc, annots.get(i)));
      if (!annot) continue;
      const subtype = resolve(doc, annot.get(PDFName.of('Subtype')));
      if (!(subtype instanceof PDFName) || subtype.decodeText() !== 'FileAttachment') {
        continue;
      }
      const value = annot.get(PDFName.of('FS')) ?? annot.get(PDFName.of('A'));
      const spec = resolve(doc, value);
      if (!looksLikeFilespec(spec)) continue;
      const name =
        specName(doc, spec) ?? decodeTextString(resolve(doc, annot.get(PDFName.of('Contents'))));
      if (name) sites.push({ name, spec, ...(value instanceof PDFRef ? { ref: value } : {}), host: annot });
    }
  }

  // One file declared in the catalogue and also named by an annotation is still
  // one attachment. An inline spec has no reference to deduplicate by, so its
  // object identity does.
  const inlineTags = new Map<PDFDict, string>();
  let inlineCount = 0;
  const seen = new Set<string>();
  return sites.filter((site) => {
    let tag = site.ref?.toString();
    if (tag === undefined) {
      tag = inlineTags.get(site.spec);
      if (tag === undefined) {
        tag = `inline:${(inlineCount += 1)}`;
        inlineTags.set(site.spec, tag);
      }
    }
    if (seen.has(tag)) return false;
    seen.add(tag);
    return true;
  });
}

/**
 * The `/EmbeddedFile` stream behind a file specification, if it has one.
 *
 * §7.11.3 allows `/EF` to **be** the stream or to be a dictionary naming `/UF`,
 * `/F`, `/DOS`, `/UNIX` or `/Mac` — each of those either a reference or (for the
 * dictionary form) inline. `/UF` is asked for first: it is the Unicode entry a
 * modern viewer prefers, and where `/F` and `/UF` name different streams it is
 * the one the file's real name belongs to.
 */
function embeddedFileStream(
  doc: PDFDocument,
  spec: PDFDict,
): { stream: PDFStream; ref?: PDFRef } | undefined {
  const raw = spec.get(PDFName.of('EF'));
  const ef = resolve(doc, raw);
  const candidates: (PDFObject | undefined)[] =
    ef instanceof PDFDict ? EF_KEYS.map((key) => ef.get(PDFName.of(key))) : [raw];
  for (const value of candidates) {
    if (value === undefined) continue;
    const stream = resolve(doc, value);
    if (stream instanceof PDFStream) {
      return { stream, ...(value instanceof PDFRef ? { ref: value } : {}) };
    }
  }
  return undefined;
}

function pdfDateString(value: unknown): string | undefined {
  const text = decodeTextString(value);
  if (text === undefined) return undefined;
  const date = parsePdfDate(text);
  return date ? formatPdfDate(date) : text;
}

function readEntry(doc: PDFDocument, site: FilespecSite): AttachmentEntry | undefined {
  const spec = site.spec;
  const located = embeddedFileStream(doc, spec);
  if (!located) return undefined;
  const bytes = streamBytes(located.stream);
  const dict = located.stream.dict;
  const params = dict.lookupMaybe(PDFName.of('Params'), PDFDict);
  const checksum = params?.lookup(PDFName.of('CheckSum'));
  const stored =
    checksum instanceof PDFHexString || checksum instanceof PDFString
      ? Array.from(checksum.asBytes(), (b) => b.toString(16).padStart(2, '0')).join('')
      : undefined;

  const entry: AttachmentEntry = {
    name: site.name,
    size: bytes.length,
    checksum: stored ?? md5Hex(bytes),
    bytes,
  };
  const filename = specName(doc, spec);
  if (filename !== undefined) entry.filename = filename;
  const subtype = dict.lookupMaybe(PDFName.of('Subtype'), PDFName);
  if (subtype) entry.mimeType = subtype.decodeText();
  else {
    const guessed = mimeForFile(filename ?? site.name);
    if (guessed) entry.mimeType = guessed;
  }
  const description = decodeTextString(spec.lookup(PDFName.of('Desc')));
  if (description !== undefined) entry.description = description;
  const created = pdfDateString(params?.lookup(PDFName.of('CreationDate')));
  if (created !== undefined) entry.creationDate = created;
  const modified = pdfDateString(params?.lookup(PDFName.of('ModDate')));
  if (modified !== undefined) entry.modificationDate = modified;
  return entry;
}

/** Every attachment in the document, in document order, payload included. */
export function listAttachments(doc: PDFDocument): AttachmentEntry[] {
  const entries: AttachmentEntry[] = [];
  for (const site of filespecSites(doc)) {
    const entry = readEntry(doc, site);
    if (entry) entries.push(entry);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** `/Params` with the fields readers expect, including the MD5 `/CheckSum`. */
function writeParams(
  doc: PDFDocument,
  streamRef: PDFRef,
  bytes: Uint8Array,
  dates: { creationDate?: Date; modificationDate?: Date },
): void {
  const ctx = context(doc);
  const stream = ctx.lookup(streamRef);
  if (!(stream instanceof PDFStream)) return;
  const params = stream.dict.lookupMaybe(PDFName.of('Params'), PDFDict) ?? ctx.obj({});
  params.set(PDFName.of('Size'), PDFNumber.of(bytes.length));
  params.set(PDFName.of('CheckSum'), PDFHexString.fromBytes(hexToBytes(md5Hex(bytes))));
  if (dates.creationDate) {
    params.set(PDFName.of('CreationDate'), PDFString.of(formatPdfDate(dates.creationDate)));
  }
  params.set(
    PDFName.of('ModDate'),
    PDFString.of(formatPdfDate(dates.modificationDate ?? new Date())),
  );
  stream.dict.set(PDFName.of('Params'), params);
}

/**
 * Attach files to the document.
 *
 * Name-tree keys must be unique (ISO 32000-1 §7.9.6), so an attachment already
 * stored under one of these names is replaced rather than duplicated — pdf-lib
 * would emit two identical keys, which Acrobat shows as one and pdf.js drops.
 *
 * @returns how many attachments the document carries afterwards.
 */
export async function addAttachments(
  doc: PDFDocument,
  files: AttachmentInput[],
): Promise<number> {
  const byName = new Map<string, AttachmentInput>();
  for (const file of files) {
    const name = (file.name ?? '').trim();
    if (!name) {
      throw new Error('Every attachment needs a file name, for example "notes.txt".');
    }
    byName.set(name, { ...file, name });
  }
  if (byName.size === 0) return listAttachments(doc).length;

  for (const file of byName.values()) {
    removeAttachments(doc, [file.name]);
    await doc.attach(toLocalBytes(file.bytes), file.name, {
      mimeType: file.mimeType ?? mimeForFile(file.name),
      description: file.description,
      afRelationship: AFRelationship.Unspecified,
    });
  }
  // pdf-lib defers the name-tree write to flush(); doing it here means the new
  // entries are visible to list/remove/replace without a save round-trip.
  await doc.flush();

  for (const file of byName.values()) {
    const site = filespecSites(doc).find((s) => s.name === file.name);
    const streamRef = site ? embeddedFileStream(doc, site.spec)?.ref : undefined;
    if (streamRef) writeParams(doc, streamRef, file.bytes, { creationDate: new Date() });
  }

  return listAttachments(doc).length;
}

/** What a page-copy carry did with the embedded files. */
export interface AttachmentCarry {
  /** Attachments that reached the new document. */
  carried: number;
  /** Entries left behind because that name had already been carried. */
  collided: number;
}

/**
 * Carry the embedded files of `sources` into `target`.
 *
 * A page copy moves page objects; the `/EmbeddedFiles` name tree hangs off the
 * **catalog**, and `/AF` off the document, so nothing follows the pages and an
 * attached source file vanished from every rebuild without a word. The payloads
 * are re-written rather than spliced across contexts: `listAttachments` decodes
 * the real bytes and `addAttachments` writes them back with the `/CheckSum`,
 * `/Size` and dates readers expect, so an entry whose stream a foreign producer
 * wrote in an unsupported filter still travels instead of being dropped.
 *
 * Name-tree keys must be unique (ISO 32000-1 §7.9.6), so the **first** file
 * carried under a name keeps it and the rest are counted in `collided` for the
 * caller to report — silently overwriting one attachment with another would be
 * the same bug wearing a different hat.
 */
export async function copyAttachments(
  target: PDFDocument,
  sources: PDFDocument[],
): Promise<AttachmentCarry> {
  const held = new Set(listAttachments(target).map((entry) => entry.name));
  const inputs: AttachmentInput[] = [];
  let collided = 0;
  for (const doc of sources) {
    for (const entry of listAttachments(doc)) {
      if (held.has(entry.name)) {
        collided += 1;
        continue;
      }
      held.add(entry.name);
      inputs.push({
        name: entry.name,
        bytes: entry.bytes,
        ...(entry.mimeType !== undefined ? { mimeType: entry.mimeType } : {}),
        ...(entry.description !== undefined ? { description: entry.description } : {}),
      });
    }
  }
  if (inputs.length === 0) return { carried: 0, collided };
  await addAttachments(target, inputs);
  return { carried: inputs.length, collided };
}

/**
 * Replace the payload of an existing attachment, keeping its name, description
 * and file specification.
 * @returns false when no attachment is stored under `name`.
 */
export async function replaceAttachment(
  doc: PDFDocument,
  name: string,
  bytes: Uint8Array,
): Promise<boolean> {
  const site = filespecSites(doc).find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (!site) return false;
  const spec = site.spec;

  const old = embeddedFileStream(doc, spec);
  const oldParams = old?.stream.dict.lookupMaybe(PDFName.of('Params'), PDFDict);
  const subtype = old?.stream.dict.lookupMaybe(PDFName.of('Subtype'), PDFName);
  const created = parsePdfDate(decodeTextString(oldParams?.lookup(PDFName.of('CreationDate'))) ?? '');

  const ctx = context(doc);
  const stream = ctx.flateStream(toLocalBytes(bytes), {
    Type: 'EmbeddedFile',
    Subtype: subtype ? subtype.decodeText() : mimeForFile(site.name),
  });
  const streamRef = ctx.register(stream);

  const ef = asDict(resolve(doc, spec.get(PDFName.of('EF')))) ?? ctx.obj({});
  ef.set(PDFName.of('F'), streamRef);
  ef.set(PDFName.of('UF'), streamRef);
  spec.set(PDFName.of('EF'), ef);

  writeParams(doc, streamRef, bytes, { creationDate: created, modificationDate: new Date() });
  if (old?.ref && old.ref.toString() !== streamRef.toString()) ctx.delete(old.ref);
  return true;
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

/** Is this `/Names` value, `/AF` member or annotation entry the spec at `site`? */
function isSiteEntry(doc: PDFDocument, value: PDFObject | undefined, site: FilespecSite): boolean {
  if (site.ref) return value instanceof PDFRef && value.toString() === site.ref.toString();
  // An inline spec has no reference to compare, so the object itself is the tag.
  return resolve(doc, value) === site.spec;
}

/**
 * Remove every `key value` pair in a name-tree `/Names` array that points at
 * this site. Indices are re-read on each pass because earlier removals shift
 * everything after them.
 */
function splicePair(doc: PDFDocument, array: PDFArray, site: FilespecSite): void {
  for (let i = 0; i + 1 < array.size(); ) {
    if (isSiteEntry(doc, array.get(i + 1), site)) {
      array.remove(i + 1);
      array.remove(i);
      continue;
    }
    i += 2;
  }
}

/**
 * Delete the file specifications that were just unlinked, and the streams that
 * nothing refers to any more. An inline spec is gone with the pair it lived in;
 * what is left of it to collect is the embedded-file stream behind `/EF`.
 */
function deleteFilespecObjects(doc: PDFDocument, sites: FilespecSite[]): void {
  const ctx = context(doc);
  const reachable: PDFRef[] = [];
  for (const site of sites) {
    const raw = site.spec.get(PDFName.of('EF'));
    if (raw instanceof PDFRef) reachable.push(raw);
    const ef = resolve(doc, raw);
    if (ef instanceof PDFDict) {
      if (raw instanceof PDFRef) reachable.push(raw); // the `/EF` dictionary itself
      for (const key of EF_KEYS) {
        const value = ef.get(PDFName.of(key));
        if (value instanceof PDFRef) reachable.push(value);
      }
    }
    if (site.ref) ctx.delete(site.ref);
  }
  for (const ref of reachable) {
    if (ctx.lookup(ref) === undefined) continue;
    if (!isOrphan(doc, ref)) continue;
    ctx.delete(ref);
  }
}

function isOrphan(doc: PDFDocument, ref: PDFRef): boolean {
  const tag = ref.toString();
  for (const [, object] of context(doc).enumerateIndirectObjects()) {
    if (object instanceof PDFDict) {
      for (const value of object.values()) {
        if (value instanceof PDFRef && value.toString() === tag) return false;
      }
    } else if (object instanceof PDFArray) {
      for (const value of object.asArray()) {
        if (value instanceof PDFRef && value.toString() === tag) return false;
      }
    }
  }
  return true;
}

/**
 * Remove attachments by name (case-insensitive; a name matches the name-tree
 * key or the file's own name).
 * @returns how many attachments were removed.
 */
export function removeAttachments(doc: PDFDocument, names: string[]): number {
  const wanted = new Set(names.map((name) => name.trim().toLowerCase()).filter(Boolean));
  if (wanted.size === 0) return 0;

  const sites = filespecSites(doc).filter((site) => {
    if (wanted.has(site.name.toLowerCase())) return true;
    const stored = specName(doc, site.spec)?.toLowerCase();
    return stored !== undefined && wanted.has(stored);
  });
  if (sites.length === 0) return 0;

  for (const site of sites) {
    if (site.tree) {
      splicePair(doc, site.tree, site);
      continue;
    }
    const host = site.host;
    if (host instanceof PDFArray) {
      for (let i = host.size() - 1; i >= 0; i--) {
        if (isSiteEntry(doc, host.get(i), site)) host.remove(i);
      }
    } else if (host instanceof PDFDict) {
      host.delete(PDFName.of('FS'));
      host.delete(PDFName.of('A'));
    }
  }

  // The `/AF` array is written alongside every name-tree entry; drop the
  // matching members so readers do not resurrect the removed file.
  const af = resolve(doc, doc.catalog.get(PDFName.of('AF')));
  if (af instanceof PDFArray) {
    for (let i = af.size() - 1; i >= 0; i--) {
      if (sites.some((site) => isSiteEntry(doc, af.get(i), site))) af.remove(i);
    }
  }

  deleteFilespecObjects(doc, sites);
  // `filespecSites` already de-duplicates by reference, so one file counts once
  // even when the name tree, `/AF` and an annotation all point at it.
  return sites.length;
}
