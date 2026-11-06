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
  name: string;
  ref: PDFRef;
  /** The name-tree `/Names` array holding the key/value pair, if any. */
  tree?: PDFArray;
  /** Index of the key inside `tree` (the value follows it). */
  keyIndex?: number;
  /** `/AF` array or `/FileAttachment` annotation dictionary, if that is the host. */
  host?: PDFDict | PDFArray;
}

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

function isRefTo(dict: PDFDict, key: string): PDFRef | undefined {
  const value = dict.get(PDFName.of(key));
  return value instanceof PDFRef ? value : undefined;
}

/** Walk a name tree (`/Names` pairs and/or `/Kids` subtrees). */
function collectNameTree(
  root: PDFDict | undefined,
  out: FilespecSite[],
  depth = 0,
): void {
  if (!root || depth > 32) return;
  const names = root.lookupMaybe(PDFName.of('Names'), PDFArray);
  if (names) {
    for (let i = 0; i + 1 < names.size(); i += 2) {
      const key = decodeTextString(names.get(i));
      const value = names.get(i + 1);
      if (key !== undefined && value instanceof PDFRef) {
        out.push({ name: key, ref: value, tree: names, keyIndex: i });
      }
    }
  }
  const kids = root.lookupMaybe(PDFName.of('Kids'), PDFArray);
  if (kids) {
    for (let i = 0; i < kids.size(); i++) {
      collectNameTree(kids.lookupMaybe(i, PDFDict), out, depth + 1);
    }
  }
}

function specName(doc: PDFDocument, ref: PDFRef): string | undefined {
  const dict = context(doc).lookupMaybe(ref, PDFDict);
  if (!(dict instanceof PDFDict)) return undefined;
  return (
    decodeTextString(dict.lookup(PDFName.of('UF'))) ??
    decodeTextString(dict.lookup(PDFName.of('F')))
  );
}

/**
 * Every file specification the document references, tagged with where it is
 * referenced from so removal can undo exactly that.
 */
function filespecSites(doc: PDFDocument): FilespecSite[] {
  const sites: FilespecSite[] = [];

  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  collectNameTree(names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict), sites);

  for (const page of doc.getPages()) {
    const pageNames = page.node.lookupMaybe(PDFName.of('Names'), PDFDict);
    collectNameTree(pageNames?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict), sites);
  }

  // PDF 2.0 associated-files array: the entries are file specs with no key.
  const af = doc.catalog.lookupMaybe(PDFName.of('AF'), PDFArray);
  if (af) {
    for (let i = 0; i < af.size(); i++) {
      const value = af.get(i);
      if (!(value instanceof PDFRef)) continue;
      const name = specName(doc, value);
      if (name) sites.push({ name, ref: value, host: af });
    }
  }

  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookupMaybe(i, PDFDict);
      if (!annot) continue;
      if (
        annot.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() !== 'FileAttachment'
      ) {
        continue;
      }
      const ref = isRefTo(annot, 'FS') ?? isRefTo(annot, 'A');
      if (!ref) continue;
      const name =
        specName(doc, ref) ?? decodeTextString(annot.lookup(PDFName.of('Contents')));
      if (name) sites.push({ name, ref, host: annot });
    }
  }

  const seen = new Set<string>();
  return sites.filter((site) => {
    const tag = site.ref.toString();
    if (seen.has(tag)) return false;
    seen.add(tag);
    return true;
  });
}

/** The `/EmbeddedFile` stream behind a file specification, if it has one. */
function embeddedFileStream(
  doc: PDFDocument,
  spec: PDFDict,
): { stream: PDFStream; ref: PDFRef } | undefined {
  const ef = spec.lookupMaybe(PDFName.of('EF'), PDFDict);
  const candidates: (PDFRef | undefined)[] = ef
    ? [isRefTo(ef, 'UF'), isRefTo(ef, 'F'), isRefTo(ef, 'DOS')]
    : [];
  const directRef = spec.get(PDFName.of('EF'));
  if (!ef && directRef instanceof PDFRef) candidates.push(directRef);
  for (const ref of candidates) {
    if (!ref) continue;
    const stream = context(doc).lookup(ref);
    if (stream instanceof PDFStream) return { stream, ref };
  }
  return undefined;
}

function pdfDateString(value: unknown): string | undefined {
  const text = decodeTextString(value);
  if (text === undefined) return undefined;
  const date = parsePdfDate(text);
  return date ? formatPdfDate(date) : text;
}

function readEntry(
  doc: PDFDocument,
  site: FilespecSite,
  spec: PDFDict,
): AttachmentEntry | undefined {
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
  const filename =
    decodeTextString(spec.lookup(PDFName.of('UF'))) ??
    decodeTextString(spec.lookup(PDFName.of('F')));
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
    const spec = context(doc).lookupMaybe(site.ref, PDFDict);
    if (!(spec instanceof PDFDict)) continue;
    const entry = readEntry(doc, site, spec);
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
    const spec = site ? context(doc).lookupMaybe(site.ref, PDFDict) : undefined;
    const streamRef = spec instanceof PDFDict ? embeddedFileStream(doc, spec)?.ref : undefined;
    if (streamRef) writeParams(doc, streamRef, file.bytes, { creationDate: new Date() });
  }

  return listAttachments(doc).length;
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
  const spec = context(doc).lookupMaybe(site.ref, PDFDict);
  if (!(spec instanceof PDFDict)) return false;

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

  const ef = spec.lookupMaybe(PDFName.of('EF'), PDFDict) ?? ctx.obj({});
  ef.set(PDFName.of('F'), streamRef);
  ef.set(PDFName.of('UF'), streamRef);
  spec.set(PDFName.of('EF'), ef);

  writeParams(doc, streamRef, bytes, { creationDate: created, modificationDate: new Date() });
  if (old && old.ref.toString() !== streamRef.toString()) ctx.delete(old.ref);
  return true;
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

/** Delete `ref` and its embedded-file stream when nothing else refers to them. */
/**
 * Remove every `key value` pair in a name-tree `/Names` array that points at
 * this site. Indices are re-read on each pass because earlier removals shift
 * everything after them.
 */
function splicePair(array: PDFArray, site: FilespecSite): void {
  const wanted = site.ref.toString();
  for (let i = 0; i + 1 < array.size(); ) {
    const key = decodeTextString(array.get(i));
    const value = array.get(i + 1);
    const matches =
      value instanceof PDFRef &&
      value.toString() === wanted &&
      (key === undefined || key === site.name);
    if (matches) {
      array.remove(i + 1);
      array.remove(i);
      continue;
    }
    i += 2;
  }
}

function deleteFilespecObjects(doc: PDFDocument, refs: PDFRef[]): void {
  const ctx = context(doc);
  const streams: PDFRef[] = [];
  for (const ref of refs) {
    const spec = ctx.lookupMaybe(ref, PDFDict);
    if (spec instanceof PDFDict) {
      const ef = spec.lookupMaybe(PDFName.of('EF'), PDFDict);
      const keys = ef ? [ef] : [];
      for (const dict of keys) {
        for (const value of dict.values()) {
          if (value instanceof PDFRef) streams.push(value);
        }
      }
      const direct = spec.get(PDFName.of('EF'));
      if (direct instanceof PDFRef) streams.push(direct);
    }
    ctx.delete(ref);
  }
  for (const ref of streams) {
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
    const stored = specName(doc, site.ref)?.toLowerCase();
    return stored !== undefined && wanted.has(stored);
  });
  if (sites.length === 0) return 0;

  const removedRefs: PDFRef[] = [];
  for (const site of sites) {
    removedRefs.push(site.ref);
    if (site.tree) {
      splicePair(site.tree, site);
      continue;
    }
    const host = site.host;
    if (host instanceof PDFArray) {
      for (let i = host.size() - 1; i >= 0; i--) {
        const value = host.get(i);
        if (value instanceof PDFRef && value.toString() === site.ref.toString()) host.remove(i);
      }
    } else if (host instanceof PDFDict) {
      host.delete(PDFName.of('FS'));
      host.delete(PDFName.of('A'));
    }
  }

  // The `/AF` array is written alongside every name-tree entry; drop the
  // matching members so readers do not resurrect the removed file.
  const af = doc.catalog.lookupMaybe(PDFName.of('AF'), PDFArray);
  if (af) {
    const tags = new Set(removedRefs.map((ref) => ref.toString()));
    for (let i = af.size() - 1; i >= 0; i--) {
      const value = af.get(i);
      if (value instanceof PDFRef && tags.has(value.toString())) af.remove(i);
    }
  }

  deleteFilespecObjects(doc, removedRefs);
  // `filespecSites` already de-duplicates by reference, so one file counts once
  // even when the name tree, `/AF` and an annotation all point at it.
  return sites.length;
}
