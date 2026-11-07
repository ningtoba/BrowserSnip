/**
 * The produced file, shown before the user decides to download it.
 *
 * The result screen used to describe the output in numbers and never show it:
 * name, bytes, page counts, then a Download button. This draws the thing itself
 * — the first page of the PDF the run wrote, with a bounded strip of further
 * pages so a 40-part result can be inspected without opening a viewer.
 *
 * Three rules hold it together:
 *
 * 1. **A picture is a picture.** Every drawn preview carries one short line saying
 *    it was rasterised in this tab from the produced file, because a raster is
 *    not the document (no text layer, no vector, only the pages that were asked
 *    for). The download stays the only way to get the file.
 * 2. **Anything that is not a PDF gets an honest alternative, not an error frame.**
 *    An archive is listed, images are shown as thumbnails, and a format with
 *    nothing to draw (DOCX, CSV, TXT) says so in one line. The download is
 *    reachable in every branch, so a preview can never be why a file is stuck.
 * 3. **Bounded work.** Only a handful of pages is ever rasterised, the document
 *    handle is destroyed when the result is superseded, and every async write
 *    checks that its run still owns the screen before painting (E19).
 */
import { Fragment, useEffect, useState } from 'react';
import { openRender, type PdfSession } from '@/lib/pdf/core/render';
import { formatFileSize } from '@/lib/utils/download';
import { usePageThumbnail } from './PageThumbs';
import { FOCUS_RING } from './focusRing';

/** One produced file, as the result screen holds it. */
export interface OutputItem {
  name: string;
  blob: Blob;
  /** The caller's object URL, so an image gallery does not mint a second one. */
  url?: string;
}

/** What kind of thing the run wrote, from the name first and the MIME second. */
export type OutputKind = 'pdf' | 'archive' | 'images' | 'document' | 'spreadsheet' | 'text' | 'other';

/**
 * How much room the preview is allowed.
 *
 * `full` is poster + page strip; `brief` drops the strip; `off` keeps only the
 * one honest line. The result screen steps down when the download would be
 * pushed past the bottom of its own pane — the action outranks the picture.
 */
export type PreviewMode = 'full' | 'brief' | 'off';

/** Pages rasterised for the strip, however long the file is (E12). */
export const PREVIEW_PAGE_LIMIT = 12;
/** Archive rows and image tiles before the list says "and N more". */
export const PREVIEW_ROW_LIMIT = 8;
/** Longest edge of the big page raster: about twice what the frame shows. */
const POSTER_MAX_SIDE = 380;
/** Longest edge of a strip chip. */
const CHIP_MAX_SIDE = 48;
/** Height of the poster frame, per mode. It is fixed so a page landing moves
 *  nothing: the placeholder and the raster share the same box. */
const POSTER_HEIGHT: Record<Exclude<PreviewMode, 'off'>, number> = { full: 190, brief: 122 };

const KIND_BY_EXTENSION: Record<string, OutputKind> = {
  pdf: 'pdf',
  zip: 'archive',
  cbz: 'archive',
  epub: 'archive',
  docx: 'document',
  doc: 'document',
  odt: 'document',
  rtf: 'document',
  xlsx: 'spreadsheet',
  xls: 'spreadsheet',
  ods: 'spreadsheet',
  csv: 'text',
  tsv: 'text',
  txt: 'text',
  md: 'text',
  json: 'text',
  html: 'text',
  htm: 'text',
  xml: 'text',
  png: 'images',
  jpg: 'images',
  jpeg: 'images',
  webp: 'images',
  gif: 'images',
  bmp: 'images',
  tif: 'images',
  tiff: 'images',
  avif: 'images',
};

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/**
 * Which alternative a result needs.
 *
 * The extension wins over the MIME type: `helpers` derives the download name
 * from the tool's suffix, and a blob can arrive with an empty or copied type
 * while the name is the thing the user will type into an email.
 */
export function outputKind(name: string, mime = ''): OutputKind {
  const byName = KIND_BY_EXTENSION[extensionOf(name)];
  if (byName) return byName;
  const type = mime.toLowerCase();
  if (type.includes('pdf')) return 'pdf';
  if (type.includes('zip') || type.includes('compressed')) return 'archive';
  if (type.startsWith('image/')) return 'images';
  if (type.includes('word') || type.includes('opendocument.text')) return 'document';
  if (type.includes('sheet') || type.includes('excel') || type.includes('opendocument.spreadsheet')) {
    return 'spreadsheet';
  }
  if (type.startsWith('text/')) return 'text';
  return 'other';
}

/**
 * The pages to rasterise: the first ones, plus the last.
 *
 * The tail is what proves a merge or an append, and a strip of every page in a
 * 500-page result is 500 rasters nobody scrolls to (E12).
 */
export function previewPages(total: number, limit = PREVIEW_PAGE_LIMIT): number[] {
  const n = Math.max(1, Math.floor(total) || 1);
  if (n <= limit) return Array.from({ length: n }, (_, index) => index + 1);
  return [...Array.from({ length: limit - 1 }, (_, index) => index + 1), n];
}

/** The one line under a drawn page. */
export function previewCaption(input: {
  page: number;
  total: number;
  name: string;
  files: number;
}): string {
  const of = input.total > 1 ? ` ${input.page} of ${input.total}` : '';
  const more = input.files > 1 ? ` (${input.files} files)` : '';
  return `Page${of} of ${input.name}${more}, drawn in this tab — a picture of the file, not the file itself.`;
}

/** What the bounded strip leaves out, in the same words the user can check. */
export function previewOmission(pages: number[], total: number): string | null {
  if (total <= pages.length) return null;
  return `Pages 1–${pages.length - 1} and ${total} are drawn here; the file holds all ${total}.`;
}

/** The line for a result that cannot be drawn, said per kind. */
export function noPreviewCopy(kind: OutputKind, name: string): string {
  const ext = extensionOf(name);
  switch (kind) {
    case 'archive':
      return `The files inside ${name} are listed above — the download is the archive itself.`;
    case 'images':
      return `The images above are the files you are about to download, shown as they are.`;
    case 'document':
      return `A ${ext || 'document'} file has no pages to draw here — download it and open it in Word, Google Docs or any word processor.`;
    case 'spreadsheet':
      return `A ${ext || 'spreadsheet'} file has no pages to draw here — download it and open it in Excel, Google Sheets or any spreadsheet app.`;
    case 'text':
      return `A ${ext || 'text'} file is data, not a page — download it and open it in any text or spreadsheet app.`;
    case 'pdf':
      return `The viewer here could not draw ${name}, so nothing is pictured — the download is still the file.`;
    default:
      return `There is nothing to draw for ${name} in this tab — the download below is the file.`;
  }
}

/** Why a PDF preview did not appear, in user words rather than pdf.js's. */
function previewFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/password/i.test(message)) {
    return 'The file this run wrote is password protected, so it cannot be drawn here — the download still opens with the password.';
  }
  return 'The viewer here could not open what this run wrote.';
}

/** What `JSZip` reports per entry: a name, and a size that is only on its internals. */
interface ArchiveEntry {
  name: string;
  size: number | null;
}

interface ZipSizeSource {
  dir?: boolean;
  /** JSZip keeps the central-directory sizes off its public type. */
  _data?: { uncompressedSize?: number };
}

async function listArchive(blob: Blob): Promise<ArchiveEntry[]> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(blob);
  const entries: ArchiveEntry[] = [];
  for (const [path, raw] of Object.entries(zip.files)) {
    const entry = raw as ZipSizeSource;
    if (entry.dir) continue;
    const size = entry._data?.uncompressedSize;
    entries.push({ name: path, size: typeof size === 'number' ? size : null });
  }
  return entries;
}

export interface OutputPreviewProps {
  /** Everything the run produced, in download order. */
  items: OutputItem[];
  /** How much room this has; see [`PreviewMode`]. */
  mode?: PreviewMode;
  className?: string;
}

type PreviewState =
  | { step: 'idle' }
  | { step: 'drawing' }
  | { step: 'pdf'; session: PdfSession; total: number; pages: number[] }
  | { step: 'archive'; entries: ArchiveEntry[] }
  | { step: 'none'; reason: string };

/**
 * The preview itself: a drawn page, an archive listing, an image gallery, or one
 * line explaining why there is nothing to see.
 */
export function OutputPreview({ items, mode = 'full', className = '' }: OutputPreviewProps) {
  const primary = items[0] ?? null;
  const blob = primary ? primary.blob : null;
  const name = primary?.name ?? 'output';
  const kind = primary ? outputKind(primary.name, primary.blob.type) : 'other';
  const openable = mode !== 'off' && (kind === 'pdf' || kind === 'archive') ? kind : null;

  const [state, setState] = useState<PreviewState>({ step: 'idle' });
  const [page, setPage] = useState(1);

  /**
   * Open the *output* bytes, keyed on the blob identity.
   *
   * A new run publishes new blobs, so the effect tears the previous document
   * down before the new one arrives and its `alive` flag drops anything still in
   * flight — a late page from a superseded run can never paint over this one.
   */
  useEffect(() => {
    if (!blob || openable === null) return;
    const abort = new AbortController();
    let alive = true;
    let session: PdfSession | null = null;
    setState({ step: 'drawing' });
    setPage(1);

    void (async () => {
      try {
        if (openable === 'archive') {
          const entries = await listArchive(blob);
          if (!alive || abort.signal.aborted) return;
          setState({ step: 'archive', entries });
          return;
        }
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (!alive || abort.signal.aborted) return;
        const opened = await openRender(bytes, { signal: abort.signal, intent: 'display' });
        if (!alive) {
          // The result was replaced while pdf.js was reading it.
          void opened.destroy();
          return;
        }
        session = opened;
        setState({ step: 'pdf', session: opened, total: opened.numPages, pages: previewPages(opened.numPages) });
      } catch (error) {
        if (!alive || abort.signal.aborted) return;
        setState({ step: 'none', reason: previewFailure(error) });
      }
    })();

    return () => {
      alive = false;
      abort.abort();
      const owned = session;
      if (owned) void owned.destroy();
    };
  }, [blob, openable]);

  if (!primary) return null;

  if (mode === 'off') {
    return (
      <Line
        marker="off"
        text={`The preview is folded away so the download stays on your screen — ${name} is unchanged by that.`}
        className={className}
      />
    );
  }

  // Images are already the pixels; their object URLs come from the store.
  if (kind === 'images') {
    return <ImageGrid items={items} className={className} />;
  }

  if (kind !== 'pdf' && kind !== 'archive') {
    return <Line marker="none" text={noPreviewCopy(kind, name)} className={className} />;
  }

  if (state.step === 'archive') {
    return <ArchiveList name={name} entries={state.entries} className={className} />;
  }

  if (state.step === 'pdf' && kind === 'pdf') {
    const total = state.total;
    const shown = Math.min(page, total);
    const height = POSTER_HEIGHT[mode];
    return (
      <section
        aria-label="Output preview"
        data-preview="pdf"
        data-preview-pages={total}
        className={`rounded-doodle-md border border-cream-border bg-cream-light p-2.5 ${className}`}
      >
        <Poster session={state.session} page={shown} height={height} />
        {total > 1 && mode === 'full' && (
          <div
            role="group"
            aria-label="Pages in the output"
            className="mt-2 flex items-stretch gap-1.5 overflow-x-auto pb-1"
          >
            {state.pages.map((candidate, index) => (
              <Fragment key={candidate}>
                {index === state.pages.length - 1 && total > state.pages.length && (
                  <span aria-hidden className="self-center px-0.5 font-mono text-[11px] text-ink-muted">
                    …
                  </span>
                )}
                <PageChip
                  session={state.session}
                  page={candidate}
                  current={candidate === shown}
                  onPick={() => setPage(candidate)}
                />
              </Fragment>
            ))}
          </div>
        )}
        <p
          data-preview-caption="true"
          aria-live="polite"
          className="mt-1.5 min-h-[26px] text-[10px] leading-relaxed text-ink-muted"
        >
          {previewCaption({ page: shown, total, name, files: items.length })}
          {previewOmission(state.pages, total) && (
            <span className="block">{previewOmission(state.pages, total)}</span>
          )}
        </p>
      </section>
    );
  }

  if (state.step === 'none') {
    return <Line marker="none" text={noPreviewCopy(kind, name)} detail={state.reason} className={className} />;
  }

  // Asking pdf.js for the document: the frame is already sized, so this paints
  // over the same box the page will and nothing moves when it lands.
  return (
    <section
      aria-label="Output preview"
      data-preview="drawing"
      className={`rounded-doodle-md border border-cream-border bg-cream-light p-2.5 ${className}`}
    >
      <div
        style={{ height: POSTER_HEIGHT[mode] }}
        className="flex items-center justify-center rounded-doodle border border-dashed border-cream-border bg-cream-soft"
      >
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">
          {kind === 'archive' ? 'Reading the archive…' : 'Drawing page 1…'}
        </span>
      </div>
    </section>
  );
}

/** A frame with a line in it: the shape every non-drawn result collapses to. */
function Line({
  marker,
  text,
  detail,
  className = '',
}: {
  marker: string;
  text: string;
  detail?: string;
  className?: string;
}) {
  return (
    <section
      aria-label="Output preview"
      data-preview={marker}
      className={`rounded-doodle-md border border-cream-border bg-cream-soft/60 px-3 py-2 ${className}`}
    >
      <p className="text-[10px] leading-relaxed text-ink-muted">
        {text}
        {detail && <span className="block">{detail}</span>}
      </p>
    </section>
  );
}

/** The big page. Its height is fixed per mode so a landing raster moves nothing. */
function Poster({ session, page, height }: { session: PdfSession; page: number; height: number }) {
  const { url, unavailable } = usePageThumbnail(session, page, POSTER_MAX_SIDE);
  return (
    <div
      data-preview-poster={url ? 'image' : unavailable ? 'unavailable' : 'drawing'}
      style={{ height }}
      className="flex items-center justify-center overflow-hidden rounded-doodle border border-cream-border bg-cream-soft p-1.5"
    >
      {url ? (
        <img
          src={url}
          alt={`Page ${page}`}
          className="max-h-full w-auto max-w-full rounded border border-cream-border bg-white object-contain shadow-doodle"
        />
      ) : (
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">
          {unavailable ? 'This browser cannot draw the page' : 'Drawing…'}
        </span>
      )}
    </div>
  );
}

function PageChip({
  session,
  page,
  current,
  onPick,
}: {
  session: PdfSession;
  page: number;
  current: boolean;
  onPick: () => void;
}) {
  const { url, unavailable } = usePageThumbnail(session, page, CHIP_MAX_SIDE);
  return (
    <button
      type="button"
      onClick={onPick}
      aria-label={`Page ${page}`}
      aria-pressed={current}
      title={url ? `Show page ${page}` : unavailable ? `Page ${page} — no image in this browser` : `Page ${page} — drawing`}
      data-chip={url ? 'image' : unavailable ? 'unavailable' : 'drawing'}
      className={`relative h-[56px] w-[44px] shrink-0 overflow-hidden rounded border bg-cream-soft transition-colors ${
        current ? 'border-accent ring-1 ring-accent/40' : 'border-cream-border hover:border-ink-muted'
      } ${FOCUS_RING}`}
    >
      {url ? (
        <img src={url} alt="" className="h-full w-full object-contain" />
      ) : (
        <span className="flex h-full w-full items-center justify-center font-mono text-[10px] text-ink-muted tabular-nums">
          {page}
        </span>
      )}
      <span
        className={`absolute bottom-0 right-0 px-1 text-[8px] font-semibold tabular-nums ${
          current ? 'bg-accent text-white' : 'bg-cream-light/85 text-ink-muted'
        }`}
      >
        {page}
      </span>
    </button>
  );
}

function ArchiveList({
  name,
  entries,
  className = '',
}: {
  name: string;
  entries: ArchiveEntry[];
  className?: string;
}) {
  const rows = entries.slice(0, PREVIEW_ROW_LIMIT);
  const rest = entries.length - rows.length;
  return (
    <section
      aria-label="Output preview"
      data-preview="archive"
      data-preview-pages={entries.length}
      className={`rounded-doodle-md border border-cream-border bg-cream-light p-2.5 ${className}`}
    >
      <p className="font-mono text-[9px] uppercase tracking-[0.08em] text-ink-muted">
        {`${name} · ${entries.length} ${entries.length === 1 ? 'file' : 'files'} inside`}
      </p>
      {entries.length === 0 ? (
        <p className="mt-1 text-[10px] text-ink-muted">The archive is empty.</p>
      ) : (
        <ul className="mt-1 divide-y divide-cream-border">
          {rows.map((entry) => (
            <li key={entry.name} className="flex items-baseline justify-between gap-2 py-1">
              <span className="min-w-0 break-all text-[10px] text-ink" title={entry.name}>
                {entry.name}
              </span>
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-ink-muted">
                {entry.size == null ? '—' : formatFileSize(entry.size)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p data-preview-caption="true" className="mt-1 text-[10px] leading-relaxed text-ink-muted">
        {noPreviewCopy('archive', name)}
        {rest > 0 && <span className="block">{`${rows.length} of ${entries.length} files listed.`}</span>}
      </p>
    </section>
  );
}

function ImageGrid({ items, className = '' }: { items: OutputItem[]; className?: string }) {
  const tiles = items.slice(0, PREVIEW_ROW_LIMIT);
  const rest = items.length - tiles.length;
  return (
    <section
      aria-label="Output preview"
      data-preview="images"
      data-preview-pages={items.length}
      className={`rounded-doodle-md border border-cream-border bg-cream-light p-2.5 ${className}`}
    >
      <ul className="grid grid-cols-4 gap-1.5">
        {tiles.map((item, index) => (
          <li
            key={`${item.name}-${index}`}
            className="flex aspect-[3/4] items-center justify-center overflow-hidden rounded border border-cream-border bg-cream-soft"
          >
            {item.url ? (
              <img src={item.url} alt={item.name} className="h-full w-full object-contain" />
            ) : (
              <span className="font-mono text-[10px] text-ink-muted">{index + 1}</span>
            )}
          </li>
        ))}
      </ul>
      <p data-preview-caption="true" className="mt-1.5 text-[10px] leading-relaxed text-ink-muted">
        {`${items.length} ${items.length === 1 ? 'image' : 'images'} — ${noPreviewCopy('images', items.length === 1 ? tiles[0].name : 'the download')}`}
        {rest > 0 && <span className="block">{`${tiles.length} of ${items.length} shown.`}</span>}
      </p>
    </section>
  );
}
