/**
 * ZIP / CBZ containers.
 *
 * Used by `pdfs-to-zip`, `extract-images`, `extract-attachments` and
 * `pdf-to-cbz`. JSZip is already a dependency and runs entirely in the tab.
 */
import JSZip from 'jszip';
import { extensionForMime } from './images';

/** Data shapes JSZip accepts for a file entry. */
type ZipData = Blob | Uint8Array | ArrayBuffer | string;

export interface ZipEntry {
  name: string;
  data: ZipData;
  /** Stored uncompressed — better for images that a deflater cannot help. */
  store?: boolean;
  comment?: string;
  modified?: Date;
}

export interface ZipOptions {
  compression?: 'STORE' | 'DEFLATE';
  level?: number;
  comment?: string;
  onProgress?: (entry: string, done: number, total: number) => void;
}

/** Build a zip, de-duplicating names so nothing silently overwrites. */
export async function createZip(
  entries: ZipEntry[],
  options: ZipOptions = {},
): Promise<Blob> {
  if (entries.length === 0) throw new Error('There was nothing to put in the archive.');
  const zip = new JSZip();
  const used = new Set<string>();
  const compression = options.compression ?? 'DEFLATE';
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const name = uniqueName(used, sanitiseEntryName(entry.name));
    const file = zip.file(name, entry.data, {
      compression: entry.store ? 'STORE' : compression,
      compressionOptions: { level: (options.level ?? 6) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 },
      comment: entry.comment,
      date: entry.modified ?? new Date(),
    });
    void file;
    options.onProgress?.(name, i + 1, entries.length);
    // Yield so a 900-image archive keeps the UI alive.
    if (i % 25 === 24) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/zip',
    compression,
    compressionOptions: { level: (options.level ?? 6) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 },
    comment: options.comment,
  });
}

/** A `.cbz` is a `.zip` with a different extension and comic pages inside. */
export async function createCbz(
  pages: { name: string; data: Blob | Uint8Array }[],
  options: ZipOptions = {},
): Promise<Blob> {
  return createZip(
    pages.map((page) => ({ ...page, store: true })),
    { comment: 'Comic Book Zlib — made by BrowserSnip', ...options },
  );
}

export interface UnzippedFile {
  name: string;
  bytes: Uint8Array;
  size: number;
  mime: string;
}

export interface UnzipOptions {
  /** Keep only entries whose lower-cased name contains one of these. */
  filterExtensions?: string[];
  /** Guard against zip bombs: abort past this decompressed total. */
  maxTotalBytes?: number;
  onProgress?: (entry: string, done: number, total: number) => void;
}

const DEFAULT_MAX = 1024 * 1024 * 1024;

export async function readZip(
  input: ArrayBuffer | Uint8Array | Blob,
  options: UnzipOptions = {},
): Promise<UnzippedFile[]> {
  const zip = await JSZip.loadAsync(input);
  const wanted = options.filterExtensions?.map((ext) => ext.toLowerCase().replace(/^\./, ''));
  const maxTotal = options.maxTotalBytes ?? DEFAULT_MAX;
  const files: UnzippedFile[] = [];
  let total = 0;

interface JSZipInternalData {
  /** JSZip exposes the local-header uncompressed size only on `_data`. */
  _data?: { uncompSize?: number };
}

const candidates = Object.values(zip.files).filter((entry) => {
  if (entry.dir) return false;
  const lower = entry.name.toLowerCase();
  if (lower.startsWith('__macosx/') || lower.includes('/.ds_store')) return false;
  if (!wanted) return true;
  return wanted.some((ext) => lower.endsWith(`.${ext}`));
});

  for (let i = 0; i < candidates.length; i++) {
    const entry = candidates[i];
    const declared = (entry as typeof entry & JSZipInternalData)._data?.uncompSize;
    if (typeof declared === 'number' && total + declared > maxTotal) {
      throw new Error(
        `This archive expands to more than ${Math.round(maxTotal / 1024 / 1024)} MB, so it was not read entirely.`,
      );
    }
    const bytes = await entry.async('uint8array');
    total += bytes.length;
    if (total > maxTotal) {
      throw new Error(
        `This archive expands to more than ${Math.round(maxTotal / 1024 / 1024)} MB, so it was not read entirely.`,
      );
    }
    files.push({
      name: entry.name,
      bytes,
      size: bytes.length,
      mime: mimeFromEntryName(entry.name),
    });
    options.onProgress?.(entry.name, i + 1, candidates.length);
  }
  return files;
}

function mimeFromEntryName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const table: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    jfif: 'image/jpeg',
    wmf: 'image/x-wmf',
    pdf: 'application/pdf',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    xml: 'application/xml',
  };
  return table[ext] ?? 'application/octet-stream';
}

export function zipNameFor(base: string, index: number, mime: string, pad = 3): string {
  const ext = extensionForMime(mime);
  return `${base}-${String(index).padStart(pad, '0')}.${ext}`;
}

/** Windows and macOS refuse some characters in archive entry names. */
export function sanitiseEntryName(name: string): string {
  const cleaned = name
    .replace(/[/\\]+/g, '-')
    .replace(/[<>:"|?*\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 180) : 'file';
}

function uniqueName(used: Set<string>, name: string): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let counter = 2;
  let candidate = `${stem}-${counter}${ext}`;
  while (used.has(candidate)) {
    counter += 1;
    candidate = `${stem}-${counter}${ext}`;
  }
  used.add(candidate);
  return candidate;
}

export async function zipBlobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}
