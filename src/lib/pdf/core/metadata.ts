/**
 * Document information dictionary, XMP metadata and PDF dates.
 *
 * pdf-lib understands six `/Info` strings plus two dates and writes every date
 * in UTC (`D:…Z`), which silently discards the author's timezone offset. The
 * metadata panel, the privacy scrubber and the "document properties" tools all
 * need the real dictionary, so this module reads and writes it directly and
 * keeps `D:YYYYMMDDHHmmSS±HH'mm'` strings faithful in both directions.
 *
 * Note that `PDFDocument.load(bytes, { updateMetadata: true })` — pdf-lib's
 * default, and the default of `openPDF` in `./doc` — rewrites `/Producer` and
 * `/ModDate` at *load* time. Round-trip a document with
 * `openPDF(bytes, { updateMetadata: false })` when those two values matter.
 */
import type { PDFDocument, PDFPage } from '@maxwbh/pdf-lib';
// `PDFString`, `PDFStream` and `decodePDFRawStream` are the pieces of the
// object model `./doc` does not re-export, so they come straight from the
// package.
import { PDFString, PDFStream, decodePDFRawStream } from '@maxwbh/pdf-lib';
import type { PDFContext, PDFObject } from '@maxwbh/pdf-lib';
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  context,
  pdfVersion,
} from './doc';
import { resourceScopes } from './content';
import { collectTreePairs, dictAt } from './tree';
import { PAGE_SIZES } from './pages';

export interface DocumentInfo {
  title?: string;
  author?: string;
  subject?: string;
  /** Verbatim `/Keywords` string — commas and semicolons are preserved. */
  keywords?: string;
  creator?: string;
  producer?: string;
  /** PDF date string (`D:YYYYMMDDHHmmSS+HH'mm'`). */
  creationDate?: string;
  /** PDF date string (`D:YYYYMMDDHHmmSS+HH'mm'`). */
  modDate?: string;
  /** Vendor keys pdf-lib does not model (`CPY`, `Vendor`, ISO `Pubid`…). */
  extra?: Record<string, string>;
  /** `/Trapped` — 'True' | 'False' | 'Unknown' in practice. */
  trapped?: string;
  /** Catalog `/Lang`, e.g. 'en-US'. Not part of `/Info`, surfaced here. */
  lang?: string;
}

/** Keys written as `/Info` strings and surfaced as named fields. */
const STRING_KEYS: [keyof DocumentInfo, string][] = [
  ['title', 'Title'],
  ['author', 'Author'],
  ['subject', 'Subject'],
  ['keywords', 'Keywords'],
  ['creator', 'Creator'],
  ['producer', 'Producer'],
];
const DATE_KEYS: [keyof DocumentInfo, string][] = [
  ['creationDate', 'CreationDate'],
  ['modDate', 'ModDate'],
];
const NAMED_KEYS = new Set<string>([
  ...STRING_KEYS.map(([, key]) => key),
  ...DATE_KEYS.map(([, key]) => key),
  'Trapped',
]);

// ---------------------------------------------------------------------------
// PDF dates
// ---------------------------------------------------------------------------

/**
 * A parsed PDF date plus the offset the string carried. `offsetMinutes` is
 * `undefined` when the producer omitted the timezone (the PDF spec allows it),
 * in which case the wall-clock fields were interpreted as local time.
 */
export interface PdfDateParts {
  date: Date;
  offsetMinutes?: number;
}

const PDF_DATE_RE =
  /^(?:D:\s*)?(\d{4})(\d\d)?(\d\d)?(?:\s*(\d\d)?(\d\d)?(\d\d)?)?(Z(?:\d\d'?\d\d'?)?|[+-]\d\d'?\d\d'?|[+-]\d\d)?\s*$/i;

function pad(value: number, width = 2): string {
  const sign = value < 0 ? '-' : '';
  return sign + String(Math.abs(value)).padStart(width, '0');
}

/**
 * Parse `D:YYYYMMDDHHmmSS±HH'mm'` (the `D:` prefix, the trailing fields and the
 * timezone are all optional per ISO 32000-1 §7.9.4). ISO 8601 and other
 * `Date`-parseable text are accepted so callers can feed form input straight
 * in. Returns `undefined` rather than an Invalid Date.
 */
export function parsePdfDateParts(value: string): PdfDateParts | undefined {
  const text = (value ?? '').trim();
  if (!text) return undefined;

  const match = PDF_DATE_RE.exec(text);
  if (match) {
    const [, year, month, day, hours, minutes, seconds, zone] = match;
    const offsetMinutes = parseZone(zone);
    const parts = [
      Number(year),
      Number(month ?? '01') - 1,
      Number(day ?? '01'),
      Number(hours ?? '00'),
      Number(minutes ?? '00'),
      Number(seconds ?? '00'),
    ];
    if (parts.some((n) => !Number.isFinite(n))) return undefined;
    const date =
      offsetMinutes === undefined
        ? new Date(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5])
        : new Date(Date.UTC(...(parts as [number, number, number, number, number, number])) - offsetMinutes * 60_000);
    if (Number.isNaN(date.getTime())) return undefined;
    return { date, offsetMinutes };
  }

  // Not a PDF date: allow ISO 8601 and locale text, but only when unambiguous
  // enough for `Date` to accept it (no `NaN`).
  const fallback = new Date(text);
  if (!Number.isNaN(fallback.getTime())) return { date: fallback };
  return undefined;
}

export function parsePdfDate(value: string): Date | undefined {
  return parsePdfDateParts(value)?.date;
}

function parseZone(zone: string | undefined): number | undefined {
  if (!zone) return undefined;
  // MuPDF writes a UTC date as `Z00'00'` — a `Z` with a zero offset spelled out
  // after it — and the old pattern accepted only the bare `Z`, so every date that
  // producer wrote fell through the parser.
  if (zone.startsWith('Z')) return 0;
  const digits = zone.replace(/[^0-9]/g, '');
  const hours = Number(digits.slice(0, 2) || '0');
  const minutes = Number(digits.slice(2, 4) || '0');
  const total = hours * 60 + minutes;
  return zone.startsWith('-') ? -total : total;
}

/**
 * Format a `Date` as `D:YYYYMMDDHHmmSS±HH'mm'` (UTC is written `Z`).
 * `offsetMinutes` defaults to the runtime's local offset for `date`, matching
 * what Acrobat, Word and LibreOffice stamp.
 */
export function formatPdfDate(
  date: Date,
  offsetMinutes: number | undefined = -date.getTimezoneOffset(),
): string {
  const offset = Number.isFinite(offsetMinutes) ? Math.round(offsetMinutes as number) : 0;
  const local = new Date(date.getTime() + offset * 60_000);
  const stamp =
    pad(local.getUTCFullYear(), 4) +
    pad(local.getUTCMonth() + 1) +
    pad(local.getUTCDate()) +
    pad(local.getUTCHours()) +
    pad(local.getUTCMinutes()) +
    pad(local.getUTCSeconds());
  if (offset === 0) return `D:${stamp}Z`;
  const sign = offset > 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  return `D:${stamp}${sign}${pad(Math.floor(absolute / 60))}'${pad(absolute % 60)}'`;
}

// ---------------------------------------------------------------------------
// Low-level object helpers (shared with ./attachments.ts)
// ---------------------------------------------------------------------------

/** The `/Info` dictionary, created on demand like pdf-lib does internally. */
export function infoDict(doc: PDFDocument, create = false): PDFDict | undefined {
  // A file with no `/Info` at all is an ordinary shape — MuPDF writes none — and the
  // typed `lookup` throws on the undefined reference, which took the whole
  // properties report (and `redact-pdf`) with it instead of reporting an absence.
  const entry = doc.context.trailerInfo.Info;
  const existing = entry === undefined ? undefined : context(doc).lookup(entry);
  if (existing instanceof PDFDict) return existing;
  if (!create) return undefined;
  const fresh = context(doc).obj({});
  doc.context.trailerInfo.Info = doc.context.register(fresh);
  return fresh;
}

/** Decode a PDF text string object (literal or hex, UTF-16BE or DocEncoding). */
export function decodeTextString(value: unknown): string | undefined {
  if (value instanceof PDFString || value instanceof PDFHexString) {
    return value.decodeText();
  }
  if (typeof value === 'string') return value;
  return undefined;
}

/**
 * `/Info` values are strings, but `/Trapped` — and plenty of broken producers
 * — use a name object, whose text is wanted just as badly.
 */
function decodeInfoValue(value: unknown): string | undefined {
  const text = decodeTextString(value);
  if (text !== undefined) return text;
  if (value instanceof PDFName) return value.decodeText();
  return undefined;
}

/** Decoded bytes of a stream object, whatever filter it was stored under. */
export function streamBytes(stream: PDFStream): Uint8Array {
  if (stream instanceof PDFRawStream) {
    try {
      return decodePDFRawStream(stream).decode();
    } catch {
      // Unknown filter (DCT, JPX, a broken /DecodeParms): the stored bytes are
      // still the file's bytes, just not usable as text.
      return stream.getContents();
    }
  }
  return stream.getContents();
}

/**
 * Re-wrap bytes in this module's realm before handing them to pdf-lib.
 *
 * pdf-lib checks its inputs with `instanceof Uint8Array`, and in a jsdom test
 * environment `TextEncoder` (and `Blob#arrayBuffer`) return arrays from another
 * realm, which pdf-lib then treats as a string and feeds to `charCodeAt`. A
 * copy is free in the browser case (the check passes, nothing is copied).
 */
export function toLocalBytes(bytes: Uint8Array): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes;
  // Typed structurally because TypeScript has narrowed `bytes` to `never` here:
  // a foreign-realm array is still indexable, it is simply not *this* realm's
  // `Uint8Array`.
  const source: { length: number; [index: number]: number } = bytes;
  const out = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i++) out[i] = source[i];
  return out;
}

// ---------------------------------------------------------------------------
// /Info read + write
// ---------------------------------------------------------------------------

/** Read every `/Info` entry, the catalog `/Lang`, and normalise the dates. */
export function readInfo(doc: PDFDocument): DocumentInfo {
  const info: DocumentInfo = {};
  const dict = infoDict(doc);
  if (dict) {
    const extra: Record<string, string> = {};
    for (const [key, value] of dict.entries()) {
      const name = key.decodeText();
      const text = decodeInfoValue(value);
      if (text === undefined) continue;
      const dateField = DATE_KEYS.find(([, pdfKey]) => pdfKey === name);
      if (dateField) {
        const parts = parsePdfDateParts(text);
        (info as Record<string, string>)[dateField[0] as string] = parts
          ? formatPdfDate(parts.date, parts.offsetMinutes)
          : text;
        continue;
      }
      if (name === 'Trapped') {
        info.trapped = text;
        continue;
      }
      const stringField = STRING_KEYS.find(([, pdfKey]) => pdfKey === name);
      if (stringField) {
        (info as Record<string, string>)[stringField[0] as string] = text;
      } else {
        extra[name] = text;
      }
    }
    if (Object.keys(extra).length > 0) info.extra = extra;
  }

  const lang = decodeTextString(doc.catalog.lookup(PDFName.of('Lang')));
  if (lang !== undefined) info.lang = lang;
  return info;
}

/**
 * Write the supplied fields into `/Info` (and `lang` into catalog `/Lang`).
 *
 * Missing properties are left untouched; an empty string deletes the key, so a
 * form can clear a value without wiping the rest. `opts.freshDates` stamps
 * both dates with the current time, overriding any strings in `info`.
 */
export function writeInfo(
  doc: PDFDocument,
  info: DocumentInfo,
  opts: { freshDates?: boolean } = {},
): void {
  const dict = infoDict(doc, true);
  if (!dict) return;

  for (const [field, pdfKey] of STRING_KEYS) {
    const value = info[field] as string | undefined;
    if (value === undefined) continue;
    if (value === '') {
      dict.delete(PDFName.of(pdfKey));
      continue;
    }
    // UTF-16BE hex: `/Title` and friends must survive emoji and CJK, which the
    // standard `PDFString.of` would mangle.
    dict.set(PDFName.of(pdfKey), PDFHexString.fromText(value));
  }

  // pdf-lib only shows the title instead of the filename when the viewer
  // preference is set, so route that one key through its setter.
  if (info.title) doc.setTitle(info.title, { showInWindowTitleBar: true });

  if (info.trapped !== undefined) {
    if (info.trapped === '') dict.delete(PDFName.of('Trapped'));
    // `/Trapped` is a name object, not a string (ISO 32000-1 §14.3.3).
    else dict.set(PDFName.of('Trapped'), PDFName.of(info.trapped));
  }

  const now = new Date();
  for (const [field, pdfKey] of DATE_KEYS) {
    if (opts.freshDates) {
      dict.set(PDFName.of(pdfKey), PDFString.of(formatPdfDate(now)));
      continue;
    }
    const value = info[field] as string | undefined;
    if (value === undefined) continue;
    if (value === '') {
      dict.delete(PDFName.of(pdfKey));
      continue;
    }
    const parts = parsePdfDateParts(value);
    if (!parts) {
      throw new Error(
        `"${value}" is not a date. Use a PDF date such as D:20240131235959+00'00' or an ISO date like 2024-01-31T23:59:59Z.`,
      );
    }
    dict.set(
      PDFName.of(pdfKey),
      PDFString.of(formatPdfDate(parts.date, parts.offsetMinutes)),
    );
  }

  if (info.extra) {
    for (const [key, value] of Object.entries(info.extra)) {
      if (!isPdfNameToken(key)) {
        throw new Error(`"${key}" cannot be used as a PDF metadata key name.`);
      }
      if (NAMED_KEYS.has(key)) continue; // explicit fields win over `extra`
      if (value === '') dict.delete(PDFName.of(key));
      else dict.set(PDFName.of(key), PDFHexString.fromText(value));
    }
  }

  if (info.lang !== undefined) {
    if (info.lang === '') doc.catalog.delete(PDFName.of('Lang'));
    else doc.catalog.set(PDFName.of('Lang'), PDFString.of(info.lang));
  }
}

function isPdfNameToken(key: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._+\-]*$/.test(key);
}

/**
 * Remove the whole `/Info` dictionary: every entry, then the trailer key.
 *
 * Emptying the entries alone left an `/Info << >>` behind, which is still a
 * document properties panel in a reader and a `present, 0 key(s)` row in this
 * app's own report — a file a reviewer opened after the privacy tool still said
 * it had a properties dictionary. The catalog `/Lang` stays: it names the
 * language of the text and the properties panel edits it (`docLanguage`), so it
 * is not one of `/Info`'s entries and must not be counted as one.
 *
 * @returns how many `/Info` values were deleted.
 */
export function stripInfo(doc: PDFDocument): number {
  const ctx = context(doc);
  const entry = doc.context.trailerInfo.Info;
  let removed = 0;
  const dict = infoDict(doc);
  if (dict) {
    for (const key of dict.keys()) {
      if (dict.delete(key)) removed++;
    }
  }
  doc.context.trailerInfo.Info = undefined;
  // A dictionary written inline in the trailer disappears with the key; the
  // indirect one every producer writes would survive as an orphan object, and
  // its strings with it.
  if (entry instanceof PDFRef) ctx.delete(entry);
  return removed;
}

// ---------------------------------------------------------------------------
// XMP
// ---------------------------------------------------------------------------

export interface XmpSummary {
  title?: string;
  description?: string;
  creator?: string;
  keywords?: string[];
  /** `pdf:PDFVersion` — the version the producer declared, not the header. */
  pdfVersion?: string;
  /** `pdfaid:part`, e.g. 2 for PDF/A-2. */
  pdfaPart?: number;
  /** `pdfaid:conformance`, e.g. 'B'. */
  pdfaConformance?: string;
  /**
   * Whether the packet is well-formed XML. A packet that is not still carries its
   * values as text — plenty of producers write `<rdf:RDF>` without declaring the
   * `rdf` prefix — so a `false` here means "read as text", not "empty".
   */
  readable: boolean;
  /** The complete packet, or `null` when the document carries no XMP. */
  raw: string | null;
}

/**
 * The catalog `/Metadata` stream and the reference that holds it.
 *
 * Producers write it both ways — as an indirect object (the common case, and the
 * only one `writeXmp` produces) and inlined straight into the catalog. Reading
 * only the `PDFRef` form made an inlined packet invisible to the properties
 * panel *and* to `stripXmp`, so "Remove metadata" reported an untouched XMP
 * stream that was sitting in the file.
 */
function metadataStream(doc: PDFDocument): { stream: PDFStream; ref: PDFRef | undefined } | undefined {
  const value = doc.catalog.get(PDFName.of('Metadata'));
  const resolved = value instanceof PDFRef ? context(doc).lookup(value) : value;
  if (!(resolved instanceof PDFStream)) return undefined;
  return { stream: resolved, ref: value instanceof PDFRef ? value : undefined };
}

/** The XMP packet text, or `undefined` when the document has no `/Metadata`. */
export function readXmpText(doc: PDFDocument): string | undefined {
  const found = metadataStream(doc);
  if (!found) return undefined;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(streamBytes(found.stream));
  return text.replace(/^\uFEFF/, '');
}

/** Parse the XMP packet into the fields the properties panel shows. */
export function readXmp(doc: PDFDocument): XmpSummary | null {
  const raw = readXmpText(doc);
  if (raw === undefined) return null;

  const summary: XmpSummary = { raw, readable: false };
  const xml = parseXml(raw);
  if (!xml) return summary;
  summary.readable = true;

  const title = firstRdfLi(xml, 'dc:title');
  if (title) summary.title = title;
  const description = firstRdfLi(xml, 'dc:description');
  if (description) summary.description = description;
  const creator = firstRdfLi(xml, 'dc:creator');
  if (creator) summary.creator = creator;
  const keywords = rdfLiValues(xml, 'dc:subject');
  if (keywords.length > 0) summary.keywords = keywords;

  const version = xmpValue(xml, 'pdf:PDFVersion');
  if (version) summary.pdfVersion = version;
  const part = xmpValue(xml, 'pdfaid:part');
  if (part !== undefined && Number.isFinite(Number(part))) {
    summary.pdfaPart = Number(part);
  }
  const conformance = xmpValue(xml, 'pdfaid:conformance');
  if (conformance) summary.pdfaConformance = conformance.trim();

  return summary;
}

/** Write (replace) the XMP packet and point catalog `/Metadata` at it. */
export function writeXmp(doc: PDFDocument, xmp: string): void {
  const ctx = context(doc);
  const old = metadataStream(doc)?.ref;
  const bytes = toLocalBytes(new TextEncoder().encode(xmp));
  // XMP packets are stored uncompressed: Acrobat, pdfium and pdf.js all read
  // `/Metadata` before they have a filter list, and a compressed packet is a
  // known source of "no XMP found" reports.
  const stream = ctx.stream(bytes, {
    Type: 'Metadata',
    Subtype: 'XML',
    // Namespace URI required by XMP spec §4.1.1 "Packet Initialization".
    'http://ns.adobe.com/xap/1.0/': PDFName.of('xmpmeta'),
  });
  const dict = stream.dict;
  dict.delete(PDFName.of('http://ns.adobe.com/xap/1.0/'));
  const ref = ctx.register(stream);
  doc.catalog.set(PDFName.of('Metadata'), ref);
  if (old && old.toString() !== ref.toString()) ctx.delete(old);
}

/** The XMP properties the properties editor owns, keyed by qualified name. */
const XMP_NS: Record<string, string> = {
  dc: 'http://purl.org/dc/elements/1.1/',
  pdf: 'http://ns.adobe.com/pdf/1.3/',
  xmp: 'http://ns.adobe.com/xap/1.0/',
  rdf: 'http://www.w3.org/1999-02-22-rdf-syntax-ns#',
};

/** Values to write into the packet; `''`/`[]` removes the property. */
export interface XmpPatch {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: readonly string[];
  producer?: string;
  creatorTool?: string;
  lang?: string;
}

function qualified(doc: Document, name: string): Element {
  const prefix = name.slice(0, name.indexOf(':'));
  return doc.createElementNS(XMP_NS[prefix], name);
}

/** `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">…</rdf:li></rdf:Alt></dc:title>`. */
function altElement(doc: Document, name: string, value: string): Element {
  const element = qualified(doc, name);
  const alt = qualified(doc, 'rdf:Alt');
  const item = qualified(doc, 'rdf:li');
  item.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:lang', 'x-default');
  item.textContent = value;
  alt.appendChild(item);
  element.appendChild(alt);
  return element;
}

function seqElement(doc: Document, name: string, values: readonly string[]): Element {
  const element = qualified(doc, name);
  const seq = qualified(doc, 'rdf:Seq');
  for (const value of values) {
    const item = qualified(doc, 'rdf:li');
    item.textContent = value;
    seq.appendChild(item);
  }
  element.appendChild(seq);
  return element;
}

/** The `rdf:Description` the editable properties live on, created if absent. */
function descriptionFor(doc: Document): Element | undefined {
  const root = doc.getElementsByTagName('rdf:RDF')[0] ?? doc.documentElement;
  if (!root) return undefined;
  const descriptions = [...doc.getElementsByTagName('rdf:Description')];
  const existing = descriptions.find(
    (element) => element.getAttribute('xmlns:dc') === XMP_NS.dc,
  );
  if (existing) return existing;
  const created = qualified(doc, 'rdf:Description');
  created.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:rdf', XMP_NS.rdf);
  for (const [prefix, uri] of Object.entries(XMP_NS)) {
    if (prefix === 'rdf') continue;
    created.setAttributeNS('http://www.w3.org/2000/xmlns/', `xmlns:${prefix}`, uri);
  }
  created.setAttribute('rdf:about', '');
  root.appendChild(created);
  return created;
}

/**
 * Replace one property on a description, or drop it when the value is empty.
 *
 * The packet is *patched*, not rebuilt: an editor that rewrote the whole packet
 * from the six fields it shows measured away `pdf:PDFVersion`, `xmp:CreateDate`,
 * `xmp:MetadataDate`, `dc:rights` and `dc:language` on a file that carried them,
 * which is metadata lost by the tool whose job is metadata.
 */
function patchProperty(doc: Document, description: Element, name: string, value: string | readonly string[] | undefined): void {
  for (const old of [...description.getElementsByTagName(name)]) description.removeChild(old);
  const empty = value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
  if (empty) return;
  if (name === 'dc:title' || name === 'dc:description' || name === 'dc:rights') {
    description.appendChild(altElement(doc, name, value as string));
  } else if (name === 'dc:creator' || name === 'dc:subject' || name === 'dc:language') {
    description.appendChild(seqElement(doc, name, Array.isArray(value) ? value : [value as string]));
  } else {
    const element = qualified(doc, name);
    element.textContent = value as string;
    description.appendChild(element);
  }
}

/** A whole packet carrying `patch`, for a document that has none to patch. */
export function buildXmpPacket(patch: XmpPatch, keep?: XmpSummary | null): string {
  const xml = typeof DOMParser === 'undefined' ? null : new DOMParser()
    .parseFromString('<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>'
      + '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999-02-22-rdf-syntax-ns#">'
      + '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>', 'application/xml');
  if (xml) {
    const description = descriptionFor(xml);
    if (description) {
      patchProperty(xml, description, 'dc:title', patch.title);
      patchProperty(xml, description, 'dc:creator', patch.author);
      patchProperty(xml, description, 'dc:description', patch.subject);
      patchProperty(xml, description, 'dc:subject', patch.keywords);
      patchProperty(xml, description, 'dc:language', patch.lang);
      patchProperty(xml, description, 'pdf:Producer', patch.producer);
      patchProperty(xml, description, 'xmp:CreatorTool', patch.creatorTool);
      return new XMLSerializer().serializeToString(xml);
    }
  }
  return '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>'
    + `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="${XMP_NS.rdf}">`
    + `<rdf:Description rdf:about="" xmlns:dc="${XMP_NS.dc}" xmlns:pdf="${XMP_NS.pdf}" xmlns:xmp="${XMP_NS.xmp}">`
    + (patch.title ? `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXmlText(patch.title)}</rdf:li></rdf:Alt></dc:title>` : '')
    + (patch.author ? `<dc:creator><rdf:Seq><rdf:li>${escapeXmlText(patch.author)}</rdf:li></rdf:Seq></dc:creator>` : '')
    + (patch.subject ? `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${escapeXmlText(patch.subject)}</rdf:li></rdf:Alt></dc:description>` : '')
    + (patch.keywords?.length ? `<dc:subject><rdf:Seq>${patch.keywords.map((word) => `<rdf:li>${escapeXmlText(word)}</rdf:li>`).join('')}</rdf:Seq></dc:subject>` : '')
    + (patch.producer ? `<pdf:Producer>${escapeXmlText(patch.producer)}</pdf:Producer>` : '')
    + (patch.creatorTool ? `<xmp:CreatorTool>${escapeXmlText(patch.creatorTool)}</xmp:CreatorTool>` : '')
    + `</rdf:Description>`
    // A packet that declared PDF/A conformance keeps it: editing the properties
    // must not silently un-archive a filed document, and that identity exists
    // only in the XMP.
    + (keep?.pdfaPart !== undefined
      ? `<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">`
        + `<pdfaid:part>${keep.pdfaPart}</pdfaid:part>`
        + (keep.pdfaConformance ? `<pdfaid:conformance>${escapeXmlText(keep.pdfaConformance)}</pdfaid:conformance>` : '')
        + `</rdf:Description>`
      : '')
    + `</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
}

/**
 * Make the packet say what `/Info` says, and leave the rest of it alone.
 *
 * `'patched'` and `'rewritten'` both mean the packet now agrees with the
 * properties; a packet that is not XML this can parse (an undeclared `rdf:`
 * prefix is common) is replaced whole, because patching it would need the
 * parser that just refused it.
 */
export function syncXmp(doc: PDFDocument, patch: XmpPatch): 'patched' | 'rewritten' | 'absent' {
  const raw = readXmpText(doc);
  if (raw === undefined) {
    const any = Object.values(patch).some((value) => (Array.isArray(value) ? value.length > 0 : !!value));
    if (!any) return 'absent';
    writeXmp(doc, buildXmpPacket(patch));
    return 'rewritten';
  }
  const xml = parseXml(raw);
  const description = xml ? descriptionFor(xml) : undefined;
  if (!xml || !description) {
    writeXmp(doc, buildXmpPacket(patch, readXmp(doc)));
    return 'rewritten';
  }
  patchProperty(xml, description, 'dc:title', patch.title);
  patchProperty(xml, description, 'dc:creator', patch.author);
  patchProperty(xml, description, 'dc:description', patch.subject);
  patchProperty(xml, description, 'dc:subject', patch.keywords);
  patchProperty(xml, description, 'dc:language', patch.lang);
  patchProperty(xml, description, 'pdf:Producer', patch.producer);
  patchProperty(xml, description, 'xmp:CreatorTool', patch.creatorTool);
  writeXmp(doc, new XMLSerializer().serializeToString(xml));
  return 'patched';
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Remove `/Metadata`.
 * @returns true when the document carried XMP and it is now gone.
 */
export function stripXmp(doc: PDFDocument): boolean {
  const found = metadataStream(doc);
  if (!found) return false;
  doc.catalog.delete(PDFName.of('Metadata'));
  // An inlined packet disappears with the catalog key; only an indirect one
  // needs the object itself deleted, or it would survive as an orphan stream.
  if (found.ref) context(doc).delete(found.ref);
  return true;
}

/**
 * Delete `terms` from every place outside the page content that can repeat them:
 * the `/Info` strings and the XMP packet.
 *
 * A redaction that blacks out a name but leaves it in `/Title` and `dc:title`
 * has not removed it — a search in any reader still finds it. Values that end up
 * blank lose the key rather than keeping an empty string, and the XMP packet is
 * re-written from the surviving text so its own `/Info` twin cannot disagree.
 *
 * @returns which properties changed, and whether the packet was rewritten.
 */
export function scrubMetadataText(
  doc: PDFDocument,
  terms: readonly string[],
): { properties: string[]; xmp: boolean } {
  const wanted = [...new Set(terms.map((term) => term.trim()).filter((term) => term.length > 0))];
  const result: { properties: string[]; xmp: boolean } = { properties: [], xmp: false };
  if (wanted.length === 0) return result;
  // Whole words only. A redaction candidate is a word a reader lifted off the
  // page — "on" or "1" among them — and deleting it as a substring would take
  // the middle out of "Pearson" and leave a file that looks scrubbed and reads
  // as nonsense.
  const pattern = new RegExp(`\\b(?:${wanted.map(escapeRegExp).join('|')})\\b`, 'gi');
  // Deleting a word from a list must not leave the punctuation behind: removing
  // both keywords from "Alice, Bravo" leaves ",", which `readInfo` then reports
  // as a property that still holds text.
  const collapse = (value: string): string =>
    value
      .replace(pattern, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*,(?=\s*[,;]|$)/g, '')
      .replace(/^\s*[,;]+\s*/, '')
      .trim();

  const info = readInfo(doc);
  const patch: DocumentInfo = {};
  for (const [field, label] of [
    ['title', 'Title'], ['author', 'Author'], ['subject', 'Subject'],
    ['keywords', 'Keywords'], ['creator', 'Creator'], ['producer', 'Producer'],
  ] as const) {
    const current = info[field];
    if (!current) continue;
    const kept = collapse(current);
    if (kept === current) continue;
    (patch as Record<string, string>)[field] = kept;
    result.properties.push(label);
  }
  const extra = info.extra ?? {};
  for (const [key, value] of Object.entries(extra)) {
    const kept = collapse(value);
    if (kept === value) continue;
    patch.extra = { ...(patch.extra ?? {}), [key]: kept };
    result.properties.push(key);
  }
  if (Object.keys(patch).length > 0) {
    // Dates are never the redacted word, and `freshDates` would stamp them.
    writeInfo(doc, patch);
  }

  const packet = readXmpText(doc);
  if (packet !== undefined) {
    const kept = packet.replace(pattern, '').replace(/[ \t]{2,}/g, ' ');
    if (kept !== packet) {
      writeXmp(doc, kept);
      result.xmp = true;
    }
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseXml(text: string): Document | null {
  if (typeof DOMParser === 'undefined') return null;
  try {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) return null;
    return doc;
  } catch {
    return null;
  }
}

function elementText(xml: Document, qualifiedName: string): string | undefined {
  const nodes = xml.getElementsByTagName(qualifiedName);
  for (let i = 0; i < nodes.length; i++) {
    const text = nodes[i].textContent?.trim();
    if (text) return text;
  }
  return undefined;
}

/** `dc:title` & friends store their value in the nested `rdf:li`. */
function firstRdfLi(xml: Document, container: string): string | undefined {
  const lists = xml.getElementsByTagName(container);
  for (let i = 0; i < lists.length; i++) {
    const items = lists[i].getElementsByTagName('rdf:li');
    for (let j = 0; j < items.length; j++) {
      const text = items[j].textContent?.trim();
      if (text) return text;
    }
    const own = lists[i].textContent?.trim();
    if (own) return own;
  }
  return undefined;
}

function rdfLiValues(xml: Document, container: string): string[] {
  const out: string[] = [];
  const lists = xml.getElementsByTagName(container);
  for (let i = 0; i < lists.length; i++) {
    const items = lists[i].getElementsByTagName('rdf:li');
    if (items.length === 0) {
      const own = lists[i].textContent?.trim();
      if (own) out.push(...own.split(/[,;]/).map((s) => s.trim()).filter(Boolean));
      continue;
    }
    for (let j = 0; j < items.length; j++) {
      const text = items[j].textContent?.trim();
      if (text) out.push(text);
    }
  }
  return out;
}

/** Read an XMP property written either as an element or as an attribute. */
function xmpValue(xml: Document, qualifiedName: string): string | undefined {
  const asElement = elementText(xml, qualifiedName);
  if (asElement) return asElement;
  const nodes = xml.getElementsByTagName('*');
  for (let i = 0; i < nodes.length; i++) {
    const attribute = nodes[i].getAttribute(qualifiedName);
    if (attribute) return attribute;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Human-readable report
// ---------------------------------------------------------------------------

export interface MetadataRow {
  label: string;
  value: string;
}

export interface MetadataSection {
  title: string;
  rows: MetadataRow[];
}

/** Byte counts the properties panel can show without a formatter of its own. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}

function storedBytes(page: PDFPage): number {
  const contents = page.node.Contents();
  if (!contents) return 0;
  if (contents instanceof PDFArray) {
    let total = 0;
    for (let i = 0; i < contents.size(); i++) {
      const stream = contents.lookup(i);
      if (stream instanceof PDFStream) total += stream.getContentsSize();
    }
    return total;
  }
  return contents instanceof PDFStream ? contents.getContentsSize() : 0;
}

function matchPageName(width: number, height: number): string {
  for (const [name, [w, h]] of Object.entries(PAGE_SIZES)) {
    if (near(width, w) && near(height, h)) return displayPageName(name);
    if (near(width, h) && near(height, w)) return `${displayPageName(name)} (landscape)`;
  }
  return 'custom size';
}

/** `a4` → `A4`, `business-card` → `Business Card` for the properties pane. */
function displayPageName(name: string): string {
  return name
    .split('-')
    .map((word) =>
      /^[a-z]{1,4}$/.test(word) && ['a3', 'a4', 'a5'].includes(word)
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1;
}

/**
 * One `/Info` value, as the file holds it: an absent key says it is absent, an
 * empty one says it is empty, and a value is shown verbatim (a key with a
 * newline in it must not read like a key with a space in it).
 */
function propertyRow(rows: MetadataRow[], label: string, dict: PDFDict | undefined, key: string): void {
  if (!dict || !dict.has(PDFName.of(key))) {
    rows.push({ label, value: `not set — the file has no /${key}` });
    return;
  }
  const raw = dict.get(PDFName.of(key));
  const text = decodeInfoValue(raw);
  if (text === undefined) {
    rows.push({ label, value: `present, but not a text object (${raw?.toString() ?? 'null'})` });
    return;
  }
  if (text === '') {
    rows.push({ label, value: `present, empty — /${key} is an empty string` });
    return;
  }
  rows.push({ label, value: text });
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/** `D:20260102010101Z00'00'` → `2 January 2026 at 01:01:01 UTC`. */
function humanDate(parts: PdfDateParts): string {
  const offset = parts.offsetMinutes;
  const wall = new Date(parts.date.getTime() + (offset ?? 0) * 60_000);
  const clock = `${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}`;
  const zone = offset === undefined
    ? 'local time, no offset recorded'
    : offset === 0
      ? 'UTC'
      : `${offset > 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return `${wall.getUTCDate()} ${MONTH_NAMES[wall.getUTCMonth()]} ${wall.getUTCFullYear()} at ${clock} ${zone}`;
}

/**
 * A date property, rendered for a human **and** with the stored string in reach.
 *
 * A producer's `D:` string is the only faithful record of the value, and parse it
 * the strict way or not, it is never dropped: a date this cannot read keeps its
 * raw text instead of leaving a blank row.
 */
function dateRow(rows: MetadataRow[], label: string, dict: PDFDict | undefined, key: string): void {
  if (!dict || !dict.has(PDFName.of(key))) {
    rows.push({ label, value: `not set — the file has no /${key}` });
    return;
  }
  const raw = decodeInfoValue(dict.get(PDFName.of(key)));
  if (raw === undefined) {
    rows.push({ label, value: 'present, but not a text object' });
    return;
  }
  if (raw === '') {
    rows.push({ label, value: `present, empty — /${key} is an empty string` });
    return;
  }
  const parts = parsePdfDateParts(raw);
  rows.push({
    label,
    value: parts
      ? `${humanDate(parts)} · stored as ${raw}`
      : `not a date this can read: ${raw} — shown exactly as the file stores it`,
  });
}

/** The `/Info` section: every named property, then every vendor key. */
function infoRows(doc: PDFDocument): MetadataRow[] {
  const dict = infoDict(doc);
  const rows: MetadataRow[] = [{
    label: 'Info dictionary',
    value: dict
      ? `present, ${[...dict.keys()].length} key(s)`
      : 'absent — the file carries no /Info dictionary, so the properties below are unset',
  }];
  for (const key of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer']) {
    propertyRow(rows, key, dict, key);
  }
  dateRow(rows, 'Creation date', dict, 'CreationDate');
  dateRow(rows, 'Modification date', dict, 'ModDate');
  propertyRow(rows, 'Trapped', dict, 'Trapped');
  const lang = decodeTextString(doc.catalog.lookup(PDFName.of('Lang')));
  rows.push({
    label: 'Language',
    value: lang === undefined
      ? 'not set — the catalogue carries no /Lang'
      : lang === ''
        ? 'present, empty — /Lang is an empty string'
        : lang,
  });
  if (dict) {
    for (const key of dict.keys()) {
      const name = key.decodeText();
      if (NAMED_KEYS.has(name)) continue;
      propertyRow(rows, name, dict, name);
    }
  }
  return rows;
}

const ACTION_VERBS: Record<string, string> = {
  JavaScript: 'runs JavaScript',
  GoTo: 'jumps to a destination in this file',
  GoToR: 'jumps into another file',
  GoToE: 'jumps into an embedded file',
  Launch: 'launches an application',
  URI: 'opens a URI',
  SubmitForm: 'submits a form',
  Named: 'runs a named action',
  Rendition: 'plays a rendition',
};

/** Where a destination array points, by page number when it names one. */
function destinationSays(doc: PDFDocument, array: PDFArray): string {
  const first = array.get(0);
  if (first instanceof PDFNumber) return `page ${first.asNumber() + 1}`;
  const index = first instanceof PDFRef
    ? doc.getPages().findIndex((page) => page.ref === first)
    : -1;
  return index >= 0 ? `page ${index + 1}` : 'a destination this cannot resolve to a page';
}

/** What one `/OpenAction` entry does, in the card's words. */
function actionSays(doc: PDFDocument, value: unknown): string | null {
  const ctx = context(doc);
  const target = value instanceof PDFRef ? ctx.lookup(value) : value;
  if (target instanceof PDFArray) return `jumps to ${destinationSays(doc, target)}`;
  if (!(target instanceof PDFDict)) return null;
  const subtype = nameText(target.get(PDFName.of('S')));
  if (subtype === undefined) return null;
  const verb: string = ACTION_VERBS[subtype] ?? `runs a /${subtype} action`;
  if (subtype === 'GoTo') {
    const destination = target.get(PDFName.of('D'));
    const array = destination instanceof PDFRef ? ctx.lookup(destination) : destination;
    if (array instanceof PDFArray) return `jumps to ${destinationSays(doc, array)}`;
  }
  if (subtype !== 'JavaScript') return verb;
  const scriptValue = target.get(PDFName.of('JS'));
  const script = scriptValue instanceof PDFStream
    ? new TextDecoder('utf-8', { fatal: false }).decode(streamBytes(scriptValue))
    : decodeTextString(scriptValue instanceof PDFRef ? ctx.lookup(scriptValue) : scriptValue);
  if (!script) return 'runs JavaScript whose /JS could not be decoded';
  // Long scripts are elided, but the row says how long the script is, so the cut
  // is visible rather than a shorter script than the file holds.
  return script.length > 200
    ? `runs JavaScript on open: ${script.slice(0, 200)}… (${script.length} characters)`
    : `runs JavaScript on open: ${script}`;
}

/** Whether opening the file acts, and what the action does. */
function openActionSays(doc: PDFDocument): string {
  const value = doc.catalog.lookup(PDFName.of('OpenAction'));
  if (value === undefined) return 'none — the document does nothing when it is opened';
  const entries = value instanceof PDFArray
    ? [...Array<unknown>(value.size())].map((_, index) => value.get(index))
    : [value];
  const said = entries.map((entry) => actionSays(doc, entry)).filter((text): text is string => text !== null);
  return said.length > 0 ? `yes — ${said.join(' and ')}` : 'declared, but not as an action this can describe';
}

function keysOf(dict: PDFDict): string {
  return [...dict.keys()].map((key) => key.decodeText()).join(', ') || 'no keys';
}

/** `/PieceInfo` — application-private data, in the catalogue and on any page. */
function pieceInfoSays(doc: PDFDocument): string {
  const places: string[] = [];
  const catalog = doc.catalog.lookupMaybe(PDFName.of('PieceInfo'), PDFDict);
  if (catalog) places.push(`catalogue (keys: ${keysOf(catalog)})`);
  doc.getPages().forEach((page, index) => {
    const dict = page.node.lookupMaybe(PDFName.of('PieceInfo'), PDFDict);
    if (dict) places.push(`page ${index + 1} (keys: ${keysOf(dict)})`);
  });
  return places.length === 0
    ? 'none — no /PieceInfo in the catalogue or on any page'
    : `declared ${places.join('; ')} — private data an application keeps for itself`;
}

/** Is the file laid out for progressive loading? */
function linearizedSays(bytes: Uint8Array): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const match = /\/Linearized\s+([\d.]+)/.exec(head);
  return match
    ? `yes — the file declares a linearisation dictionary (/Linearized ${match[1]})`
    : 'no — the file is not laid out for progressive loading';
}

function xmpPacketSays(doc: PDFDocument): string {
  const found = metadataStream(doc);
  return found
    ? `present, ${formatBytes(streamBytes(found.stream).length)} at catalogue /Metadata`
    : 'absent — the catalogue has no /Metadata stream';
}

/** The key fields a packet carries, by plain text, for one this cannot parse. */
const XMP_TEXT_FIELDS: [string, string][] = [
  ['Title', 'dc:title'],
  ['Creator', 'dc:creator'],
  ['Description', 'dc:description'],
  ['Keywords', 'dc:subject'],
  ['Producer', 'pdf:Producer'],
  ['Creator tool', 'xmp:CreatorTool'],
];

function fallbackXmpFields(raw: string): MetadataRow[] {
  const rows: MetadataRow[] = [];
  for (const [label, tag] of XMP_TEXT_FIELDS) {
    const found: string[] = [];
    for (const match of raw.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi'))) {
      const text = match[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) found.push(text);
    }
    if (found.length > 0) rows.push({ label, value: found.join(', ') });
  }
  if (rows.length === 0) rows.push({ label: 'Fields', value: 'no dc:/pdf: key field is visible in the packet as text either' });
  return rows;
}

function xmpFieldRow(rows: MetadataRow[], label: string, value: string | undefined): void {
  rows.push({ label, value: value && value !== '' ? value : 'not in the packet' });
}

/**
 * The XMP section: the declared packet, its size, and its key fields — not a wall
 * of XML. A packet that is not well-formed XML is reported as that and read as
 * text, because the fields are still in it and a silent empty section reads like
 * a packet with no properties.
 */
function xmpRows(doc: PDFDocument): MetadataRow[] {
  const xmp = readXmp(doc);
  if (!xmp) return [{ label: 'Packet', value: 'absent — the catalogue has no /Metadata stream' }];
  const rows: MetadataRow[] = [{
    label: 'Packet',
    value: `present, ${formatBytes(new TextEncoder().encode(xmp.raw ?? '').length)} at catalogue /Metadata`,
  }];
  if (!xmp.readable) {
    rows.push({
      label: 'Well-formed',
      value: 'not XML this could parse — the fields below were read as text out of the packet',
    });
    rows.push(...fallbackXmpFields(xmp.raw ?? ''));
    return rows;
  }
  xmpFieldRow(rows, 'Title', xmp.title);
  xmpFieldRow(rows, 'Creator', xmp.creator);
  xmpFieldRow(rows, 'Description', xmp.description);
  xmpFieldRow(rows, 'Keywords', xmp.keywords?.join(', '));
  xmpFieldRow(rows, 'Declared PDF version', xmp.pdfVersion);
  if (xmp.pdfaPart !== undefined) {
    rows.push({ label: 'PDF/A', value: `${xmp.pdfaPart}${xmp.pdfaConformance ? `-${xmp.pdfaConformance}` : ''}` });
  }
  return rows;
}

/**
 * Everything a human would want in a "Document properties" pane: file facts,
 * `/Info`, XMP, and one row per page with its size and content-stream weight.
 * `bytes` is the saved file the document came from — pass the same bytes you
 * opened when you want the on-disk size, or an empty array for a live-only
 * report.
 */
export function metadataReport(
  doc: PDFDocument,
  bytes: Uint8Array,
): MetadataSection[] {
  const sections: MetadataSection[] = [];
  const ctx = context(doc);
  let streams = 0;
  let objects = 0;
  for (const [, object] of ctx.enumerateIndirectObjects()) {
    objects++;
    if (object instanceof PDFRawStream) streams++;
  }

  const file: MetadataRow[] = [
    { label: 'PDF version', value: pdfVersion(doc) },
    { label: 'Pages', value: String(doc.getPageCount()) },
    { label: 'File size', value: formatBytes(bytes.length) },
    { label: 'Indirect objects', value: String(objects) },
    { label: 'Streams', value: String(streams) },
    { label: 'Encrypted', value: doc.isEncrypted ? 'yes' : 'no' },
  ];
  const outline = doc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
  file.push({
    label: 'Bookmarks',
    value: outline ? String(outline.lookupMaybe(PDFName.of('Count'), PDFNumber)?.asNumber() ?? 0) : '0',
  });
  const attachments = attachmentCount(doc);
  if (attachments !== undefined) file.push({ label: 'Attachments', value: String(attachments) });
  // Four structures a reader acts on and a reviewer asks about by name, none of
  // which the panel used to mention: a linearised file, something that runs on
  // open, a vendor `/PieceInfo`, and whether the file declares an XMP packet at
  // all (the XMP section only appeared when there was one, so "no packet" and
  // "no XMP section" were the same screen).
  file.push({ label: 'Linearized', value: linearizedSays(bytes) });
  file.push({ label: 'Open action', value: openActionSays(doc) });
  file.push({ label: 'Piece info', value: pieceInfoSays(doc) });
  file.push({ label: 'XMP packet', value: xmpPacketSays(doc) });
  sections.push({ title: 'File', rows: file });

  sections.push({ title: 'Document information', rows: infoRows(doc) });

  sections.push({ title: 'XMP metadata', rows: xmpRows(doc) });

  const pageRows: MetadataRow[] = doc.getPages().map((page, index) => {
    const width = page.getWidth();
    const height = page.getHeight();
    const rotation = page.getRotation().angle;
    return {
      label: `Page ${index + 1}`,
      value:
        `${round(width)} × ${round(height)} pt · ${matchPageName(width, height)}` +
        ` · ${formatBytes(storedBytes(page))} of content` +
        (rotation ? ` · rotated ${rotation}°` : ''),
    };
  });
  sections.push({
    title: 'Pages',
    rows: pageRows.length > 0 ? pageRows : [{ label: 'Empty', value: 'no pages' }],
  });

  const fonts = listFonts(doc);
  sections.push({
    title: 'Fonts',
    rows: fonts.length > 0
      ? fonts.map((font) => ({
          label: font.name,
          value: [
            font.type,
            font.embedded ? 'embedded' : 'not embedded — substituted on screen',
            // "full font" is a statement about a file that is not in this
            // document, so it is only made about an embedded one.
            ...(font.embedded ? [font.subset ? `subset ${font.subset}` : 'full font'] : []),
            font.encoding,
          ].filter(Boolean).join(' · '),
        }))
      : [{ label: 'None', value: 'no fonts in this PDF: the pages hold no drawn text' }],
  });

  const images = listImages(doc);
  const imageRows: MetadataRow[] = images.slice(0, REPORT_LIMIT).map((image) => ({
    label: `${image.width} × ${image.height} px`,
    value: [
      image.filter ?? 'raw samples',
      `${image.bitsPerComponent}-bit`,
      image.colorSpace,
      formatBytes(image.bytes),
      image.pages.length > 1 ? `on ${image.pages.length} pages` : 'on 1 page',
    ].filter(Boolean).join(' · '),
  }));
  if (images.length > REPORT_LIMIT) {
    imageRows.push({
      label: 'More',
      value: `${images.length - REPORT_LIMIT} further image(s) not listed`,
    });
  }
  sections.push({
    title: 'Images',
    rows: imageRows.length > 0 ? imageRows : [{ label: 'None', value: 'no raster images are embedded' }],
  });

  return sections;
}

/** How many rows the resource inventories list before summarising (E7). */
const REPORT_LIMIT = 20;

/** A font face a page draws with, as the file declares it. */
export interface FontInventory {
  /** `/BaseFont`, with the `ABCDEF+` subset prefix kept in `name` and split out. */
  name: string;
  /** `TrueType`, `Type0`, `Type1`, `CIDFontType2` … */
  type: string;
  /** True when a `/FontFile`, `/FontFile2` or `/FontFile3` backs the face. */
  embedded: boolean;
  /** The `ABCDEF+` tag of an embedded subset, when the producer wrote one. */
  subset?: string;
  /** Encoding summary — `Identity-H`, `WinAnsiEncoding`, a CID `Ordering`. */
  encoding?: string;
}

/** A raster image a page places, measured from its own dictionary. */
export interface ImageInventory {
  width: number;
  height: number;
  bitsPerComponent: number;
  /** `/Filter` name (`DCTDecode`, `FlateDecode`, …) or `null` for raw samples. */
  filter: string | null;
  colorSpace: string;
  /** Stored bytes — what the image costs in this file, not its pixel weight. */
  bytes: number;
  /** 1-based pages that place this image. */
  pages: number[];
}

/** Read a dictionary entry that may be a reference, narrowing by hand. */
function resolve(context: PDFContext, value: unknown): PDFObject | undefined {
  if (value === undefined || value === null) return undefined;
  return value instanceof PDFRef ? context.lookup(value) : (value as PDFObject);
}

/**
 * Bytes this object actually costs the file: the encoded payload, not the
 * inflated one a viewer draws from it.
 */
function storedLength(stream: PDFStream): number {
  try {
    return stream.getContents().length;
  } catch {
    return 0;
  }
}

function nameText(value: unknown): string | undefined {
  return value instanceof PDFName ? value.decodeText() : undefined;
}

/**
 * Every font face the pages reference, once each.
 *
 * `/Encoding` is a name on a simple font and a dictionary on a CID font, so it
 * is resolved and narrowed rather than looked up with a class — `lookupMaybe`
 * throws on that mismatch. Shared resource dictionaries mean one face appears on
 * many pages; it is reported once, under the name the file carries. Faces declared
 * only inside a Form XObject are reported too, because the page draws with them:
 * `resources-xobject.pdf` is a file MuPDF counts three faces for and this walk once
 * answered with one.
 */
export function listFonts(doc: PDFDocument): FontInventory[] {
  const ctx = context(doc);
  const found = new Map<string, FontInventory>();
  // Every `/Resources` the pages can name, forms included, in page order.
  for (const { resources } of doc.getPages().flatMap((page) => resourceScopes(doc, page))) {
    const fonts = resolve(ctx, resources.get(PDFName.of('Font')));
    if (!(fonts instanceof PDFDict)) continue;
    for (const [, entry] of fonts.entries()) {
      const font = resolve(ctx, entry);
      if (!(font instanceof PDFDict)) continue;
      const type = nameText(resolve(ctx, font.get(PDFName.of('Subtype')))) ?? 'unknown';
      let descriptor: PDFDict | undefined;
      let encodingName = nameText(resolve(ctx, font.get(PDFName.of('Encoding'))));
      const descendants = resolve(ctx, font.get(PDFName.of('DescendantFonts')));
      const descendant =
        descendants instanceof PDFArray
          ? resolve(ctx, descendants.get(0))
          : (descendants instanceof PDFDict ? descendants : undefined);
      const cid = descendant instanceof PDFDict ? descendant : undefined;
      if (cid) {
        const registry = nameText(resolve(ctx, cid.get(PDFName.of('Registry'))));
        const ordering = nameText(resolve(ctx, cid.get(PDFName.of('Ordering'))))
          ?? nameText(resolve(ctx, cid.get(PDFName.of('ROS'))));
        if (registry || ordering) {
          encodingName = [registry, ordering].filter(Boolean).join('-');
        }
      }
      const rawDescriptor = resolve(ctx, (cid ?? font).get(PDFName.of('FontDescriptor')));
      if (rawDescriptor instanceof PDFArray) {
        const first = resolve(ctx, rawDescriptor.get(0));
        if (first instanceof PDFDict) descriptor = first;
      } else if (rawDescriptor instanceof PDFDict) {
        descriptor = rawDescriptor;
      }
      const base = nameText(resolve(ctx, (cid ?? font).get(PDFName.of('BaseFont')))) ?? 'unnamed';
      const subset = /^([A-Z]{6})\+/.exec(base)?.[1];
      const key = `${base}|${type}|${descriptor ? 'e' : 'x'}`;
      if (found.has(key)) continue;
      found.set(key, {
        name: base,
        type,
        embedded:
          descriptor !== undefined
          && ['FontFile', 'FontFile2', 'FontFile3'].some((name) => descriptor!.has(PDFName.of(name))),
        subset,
        encoding: encodingName ?? (cid ? 'CID (unspecified encoding)' : undefined),
      });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every raster image the pages place, deduplicated by object so one logo used
 * on 300 pages is reported once with its page count (E7).
 *
 * The walk covers every `/Resources` a page can name, including the ones inside its
 * Form XObjects: artwork wrapped in a form is the normal shape of a Word or
 * LibreOffice export, and a page-level-only walk reported "no raster images are
 * embedded" on the `view-metadata` card over a file MuPDF draws two from.
 */
export function listImages(doc: PDFDocument): ImageInventory[] {
  const ctx = context(doc);
  const found = new Map<string, ImageInventory>();
  // Page order matters here — each image carries the sheets that place it — so the
  // scopes are flattened with the page index they were reached from.
  const scopes = doc.getPages()
    .flatMap((page, index) => resourceScopes(doc, page).map((scope) => ({ ...scope, index })));
  for (const { resources, index } of scopes) {
    const xobjects = resolve(ctx, resources.get(PDFName.of('XObject')));
    if (!(xobjects instanceof PDFDict)) continue;
    for (const [, entry] of xobjects.entries()) {
      const stream = resolve(ctx, entry);
      if (!(stream instanceof PDFStream)) continue;
      if (nameText(resolve(ctx, stream.dict.get(PDFName.of('Subtype')))) !== 'Image') continue;
      const number = (name: string): number => {
        const value = resolve(ctx, stream.dict.get(PDFName.of(name)));
        return value instanceof PDFNumber ? value.asNumber() : 0;
      };
      const filterValue = resolve(ctx, stream.dict.get(PDFName.of('Filter')));
      const filter = filterValue instanceof PDFName
        ? filterValue.decodeText()
        : (filterValue instanceof PDFArray ? nameText(resolve(ctx, filterValue.get(0))) ?? null : null);
      const colorSpaceValue = resolve(ctx, stream.dict.get(PDFName.of('ColorSpace')));
      const colorSpace = colorSpaceValue instanceof PDFName
        ? colorSpaceValue.decodeText()
        : (colorSpaceValue instanceof PDFArray
          ? nameText(resolve(ctx, colorSpaceValue.get(0))) ?? 'separated/ICCBased'
          : 'unknown');
      const key = entry instanceof PDFRef ? entry.toString() : `${number('Width')}x${number('Height')}:${storedLength(stream)}`;
      const existing = found.get(key);
      if (existing) {
        // One sheet may name the same stream twice — under two keys, or through two
        // forms — and "on 2 pages" about a single sheet is a claim the bytes deny.
        if (!existing.pages.includes(index + 1)) existing.pages.push(index + 1);
        continue;
      }
      found.set(key, {
        width: number('Width'),
        height: number('Height'),
        bitsPerComponent: number('BitsPerComponent') || 1,
        filter,
        colorSpace,
        bytes: storedLength(stream),
        pages: [index + 1],
      });
    }
  }
  return [...found.values()].sort((a, b) => b.bytes - a.bytes);
}

function round(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

/**
 * Number of embedded-file name-tree entries, without decoding any stream.
 *
 * The count is of entries, and an entry can sit in any node of the tree: a producer
 * with several files writes `/Kids` + `/Limits`, and reading only the root's own
 * `/Names` array printed "Attachments: 0" on the same card that lists those files —
 * the third instance of the stop-at-the-root the shared descent now covers.
 */
function attachmentCount(doc: PDFDocument): number | undefined {
  const names = dictAt(doc, doc.catalog, 'Names');
  const tree = dictAt(doc, names, 'EmbeddedFiles');
  if (!tree) return undefined;
  return collectTreePairs(doc, tree).length;
}

/* ── the sRGB profile a PDF/A output intent points at ─────────────────────── */

/** Tag data plus its signature, ready to be laid out into an ICC profile. */
interface IccTag {
  signature: string;
  data: Uint8Array;
}

function fourCc(value: string): number {
  let out = 0;
  for (let i = 0; i < 4; i++) out = (out << 8) | (value.charCodeAt(i) & 0xff);
  return out >>> 0;
}

function tagText(value: string): Uint8Array {
  const bytes = new Uint8Array(8 + value.length + 1);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, fourCc('text'));
  const encoder = new TextEncoder();
  bytes.set(encoder.encode(value).subarray(0, value.length), 8);
  bytes[8 + value.length] = 0;
  return bytes;
}

function tagDescription(value: string): Uint8Array {
  const text = `${value}\u0000`;
  const bytes = new Uint8Array(12 + text.length + 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, fourCc('desc'));
  view.setUint32(8, text.length);
  for (let i = 0; i < text.length; i++) bytes[12 + i] = text.charCodeAt(i) & 0xff;
  view.setUint32(12 + text.length, 0, false);
  view.setUint32(16 + text.length, 0, false);
  return bytes;
}

/** An s15Fixed16 number: 16 bits of integer range, 16 of fraction. */
function fixed16(value: number): number {
  return Math.round(value * 65536) | 0;
}

function tagXyz(x: number, y: number, z: number): Uint8Array {
  const bytes = new Uint8Array(4 + 4 + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, fourCc('XYZ '));
  view.setUint32(8, fixed16(x));
  view.setUint32(12, fixed16(y));
  view.setUint32(16, fixed16(z));
  return bytes;
}

/** A parametric tone curve of the simplest kind: `Y = X^gamma`. */
function tagCurve(gamma: number): Uint8Array {
  const bytes = new Uint8Array(4 + 4 + 2 + 2 + 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, fourCc('para'));
  view.setUint16(8, 0);
  view.setUint16(10, 0);
  view.setInt32(12, fixed16(gamma));
  return bytes;
}

/**
 * A minimal but structurally valid sRGB profile for a PDF/A output intent.
 *
 * The only colour profile this app has: 476 bytes written by the code below, not
 * an asset, so neither path of `pdf-to-pdfa` pays a download for it. The version
 * `tools/optimize.ts` used to hand out was 3144 zero bytes with a header claiming
 * 52 tags — parseable as a blob, meaningless as a colour profile.
 *
 * It is shared because both PDF/A paths need the same bytes: the local writer
 * embeds it as `/DestOutputProfile` directly, and the Ghostscript path puts it in
 * the engine's sandbox for its `PDFA_def.ps`-style prefix to read (see
 * `core/engine-ops.ts`). Two profiles in one file would disagree about `/N`.
 */
export function srgbIccProfile(): Uint8Array {
  const tags: IccTag[] = [
    { signature: 'desc', data: tagDescription('sRGB IEC61966-2.1 (BrowserSnip minimal)') },
    { signature: 'wtpt', data: tagXyz(0.9505, 1.0, 1.089) },
    { signature: 'rXYZ', data: tagXyz(0.4361, 0.2225, 0.0139) },
    { signature: 'gXYZ', data: tagXyz(0.385, 0.7169, 0.1057) },
    { signature: 'bXYZ', data: tagXyz(0.1431, 0.0606, 0.7141) },
    { signature: 'rTRC', data: tagCurve(2.2) },
    { signature: 'gTRC', data: tagCurve(2.2) },
    { signature: 'bTRC', data: tagCurve(2.2) },
    { signature: 'cprt', data: tagText('No copyright, generated by BrowserSnip.') },
  ];
  const headerSize = 128;
  const tableSize = 4 + tags.length * 12;
  let offset = headerSize + tableSize;
  const placed = tags.map((tag) => {
    const at = offset;
    offset += tag.data.byteLength;
    return { ...tag, at };
  });

  const bytes = new Uint8Array(offset);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.byteLength);
  view.setUint32(4, fourCc('none'));
  view.setUint32(8, 0x0210_0000);
  view.setUint32(12, fourCc('mntr'));
  view.setUint32(16, fourCc('RGB '));
  view.setUint32(20, fourCc('XYZ '));
  view.setUint16(24, 2024);
  view.setUint16(26, 1);
  view.setUint16(28, 1);
  view.setUint32(36, fourCc('acsp'));
  view.setUint32(64, 0);
  view.setInt32(68, fixed16(0.9642));
  view.setInt32(72, fixed16(1));
  view.setInt32(76, fixed16(0.8249));
  view.setUint32(88, fourCc('BrSn'));
  view.setUint32(128, tags.length);
  placed.forEach((tag, index) => {
    const entry = 132 + index * 12;
    view.setUint32(entry, fourCc(tag.signature));
    view.setUint32(entry + 4, tag.at);
    view.setUint32(entry + 8, tag.data.byteLength);
    bytes.set(tag.data, tag.at);
  });
  return bytes;
}
