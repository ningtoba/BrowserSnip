/**
 * The empty state: one centred title, one promise, one oversized button.
 *
 * A first visit to a tool page is judged by its shape, and the shape that works
 * (iLovePDF, and every tool people already trust) is a drop zone you can also
 * click, with nothing competing with it. So the intake owns no options, no
 * preview and no status chips: until a file exists, the only decision offered
 * is "which file".
 *
 * The drop target is the whole page, not the button: `useIntake` listens on
 * `window`, so a file released anywhere over the tab is accepted and a stray
 * drop never lets the browser navigate away to a `file://` preview.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FOCUS_RING } from './focusRing';

/** Formats the tool cannot read are dropped on the floor by the browser picker. */
export const PDF_ACCEPT = '.pdf,application/pdf';

export interface IntakeCopy {
  /** Button label: "Select PDF files". */
  pick: string;
  /** Line under the button: "or drop PDFs here". */
  drop: string;
  /** What the tool takes, for the sentence that names it. */
  noun: string;
  /** Plural form, for the overlay that covers the page mid-drag. */
  many: string;
}

const NOUNS = {
  pdf: { one: 'PDF file', many: 'PDF files', dropOne: 'a PDF', dropMany: 'PDFs' },
  image: { one: 'image', many: 'images', dropOne: 'an image', dropMany: 'images' },
  file: { one: 'file', many: 'files', dropOne: 'a file', dropMany: 'files' },
} as const;

/** The two lines the intake prints, named after the format the tool actually takes. */
export function intakeCopy(accept?: string, multiple = false): IntakeCopy {
  const list = (accept ?? PDF_ACCEPT).toLowerCase();
  const noun = /pdf/.test(list)
    ? NOUNS.pdf
    : /image|\.(jpg|jpeg|png|webp|gif|avif|tiff|tif|bmp|heic|heif|svg|psd)/.test(list)
      ? NOUNS.image
      : NOUNS.file;
  return {
    pick: `Select ${multiple ? noun.many : noun.one}`,
    drop: `or drop ${multiple ? noun.dropMany : noun.dropOne} here`,
    noun: multiple ? noun.many : noun.dropOne,
    many: noun.dropMany,
  };
}

/** Formats the button's noun does not name: an unlisted MIME is an alias the definition already spells out. */
const MIME_FORMATS: Record<string, string> = {
  'application/pdf': 'PDF',
  'application/epub+zip': '.epub',
  'application/json': '.json',
  'application/manifest+json': '.json',
  'application/rtf': '.rtf',
  'application/xml': '.xml',
  'application/zip': '.zip',
  'image/svg+xml': '.svg',
  'text/comma-separated-values': '.csv',
  'text/csv': '.csv',
  'text/html': '.html',
  'text/markdown': '.md',
  'text/plain': '.txt',
  'text/tab-separated-values': '.tsv',
  'text/xml': '.xml',
};

/** What a wildcard stands for, used only when the definition lists no extension. */
const MIME_FAMILIES: Record<string, string> = {
  '*/*': 'any file type',
  'application/*': 'any application file',
  'image/*': 'images',
  'text/*': 'text files',
};

/** Spellings that name the same thing twice in one list. */
const FORMAT_ALIASES: Record<string, string> = {
  '.htm': '.html',
  '.jpeg': '.jpg',
  '.mdown': '.md',
  '.pdf': 'PDF',
  '.text': '.txt',
  '.tif': '.tiff',
};

/**
 * Every format this intake will take, as a person would read it.
 *
 * `accept` is what the browser's picker greys out, so it is also the honest
 * answer to "what belongs here" — but it mixes extensions with MIME types and
 * repeats itself (`.pdf,application/pdf`). This is the de-duplicated, readable
 * form of it.
 */
export function intakeFormats(accept?: string): string[] {
  const labels: string[] = [];
  const families: string[] = [];
  const add = (label: string) => {
    if (label && !labels.includes(label)) labels.push(label);
  };
  for (const token of (accept ?? PDF_ACCEPT).split(',')) {
    const item = token.trim().toLowerCase();
    if (!item) continue;
    if (item.startsWith('.')) add(FORMAT_ALIASES[item] ?? item);
    else if (item.endsWith('/*') || item === '*/*') {
      const family = MIME_FAMILIES[item];
      if (family && !families.includes(family)) families.push(family);
    } else if (MIME_FORMATS[item]) add(MIME_FORMATS[item]);
  }
  if (labels.length > 0) return labels;
  if (families.length > 0) return families;
  return ['PDF'];
}

/** How many formats the line can name before it counts the rest. */
const FOOT_NOTE_FORMATS = 4;
/** Characters the footnote has to live in — one line under the button, not a paragraph. */
const FOOT_NOTE_BUDGET = 112;

/**
 * The one line that tells you what to pick before the picker opens.
 *
 * An intake with no options to show — which is every tool before a file exists,
 * by design — otherwise says only its title, its promise and its button. A tool
 * taking `.docx`, `.odt` and `.rtf` hid that behind a generic "Select file", and
 * a tool with no fields at all had nothing else on the page. So the footnote
 * names the formats in three parts: what it takes, how many files it takes, and
 * the definition's own first note while there is room for it.
 */
export function intakeFootNote(accept?: string, multiple = false, notes: string[] = []): string {
  const formats = intakeFormats(accept);
  if (formats.length === 0) return '';
  const overflow = formats.length - FOOT_NOTE_FORMATS;
  const list = `${formats.slice(0, FOOT_NOTE_FORMATS).join(', ')}${overflow > 0 ? ` +${overflow} more` : ''}`;
  const head = `Accepts ${list} · ${multiple ? 'any number of files' : 'one file at a time'}`;
  const note = notes.find((line) => line.trim() !== '')?.trim() ?? '';
  const room = FOOT_NOTE_BUDGET - head.length - 3;
  if (note.length < 24 || room < 24) return head;
  return `${head} · ${clipTo(note, room)}`;
}

/** Cut a sentence at the last whole word that fits, so the line never breaks mid-word. */
function clipTo(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const window = text.slice(0, budget);
  const cut = Math.max(window.lastIndexOf(' '), window.lastIndexOf(','), window.lastIndexOf(';'));
  return `${cut > 24 ? window.slice(0, cut).replace(/[,;]$/, '') : window.trimEnd()}…`;
}

export interface IntakeControls {
  /** A file drag is over the tab right now. */
  dragging: boolean;
  /** Opens the OS picker. */
  open: () => void;
  /** Spread onto a hidden `<input type="file">` the surface renders once. */
  inputProps: {
    ref: React.RefObject<HTMLInputElement>;
    type: 'file';
    accept: string;
    multiple: boolean;
    className: string;
    tabIndex: number;
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  };
}

export interface UseIntakeOptions {
  accept?: string;
  multiple?: boolean;
  /**
   * False when another surface already owns the page-wide drop target.
   *
   * Two listeners on one window would handle one drop twice.
   */
  enabled?: boolean;
  /** Everything the drag or the picker produced, in the order it came. */
  onFiles: (files: File[]) => void;
}

const filesOf = (transfer: DataTransfer | null): File[] =>
  transfer ? Array.from(transfer.files ?? []) : [];

/** Does this drag carry files, or is it an in-app reorder? */
function carriesFiles(event: DragEvent): boolean {
  const transfer = event.dataTransfer;
  if (!transfer) return false;
  const types = Array.from(transfer.types ?? []);
  // During a drag the browser hides the file list, so the type is the only
  // answer; a synthetic event may carry `files` and no `types` at all.
  if (types.length > 0) return types.includes('Files');
  return filesOf(transfer).length > 0;
}

/**
 * Page-wide file intake: one hidden input, one drop target the size of the tab.
 *
 * Listeners live on `window` so the affordance matches the promise ("drop it
 * anywhere"), and `dragenter`/`dragleave` are counted rather than trusted
 * individually — every child element the cursor crosses fires a leave, which is
 * what made earlier versions of this flash.
 */
export function useIntake({
  accept = PDF_ACCEPT,
  multiple = false,
  enabled = true,
  onFiles,
}: UseIntakeOptions): IntakeControls {
  const input = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  // The handler changes identity every render (it closes over the tool and the
  // store); the window listener must not be torn down and rebuilt with it.
  const sink = useRef(onFiles);
  sink.current = onFiles;

  useEffect(() => {
    if (!enabled) return;
    const enter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth.current += 1;
      setDragging(true);
    };
    const leave = () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const over = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const drop = (event: DragEvent) => {
      const picked = filesOf(event.dataTransfer);
      if (picked.length > 0) event.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (picked.length > 0) sink.current(picked);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [enabled]);

  const open = useCallback(() => input.current?.click(), []);

  const onChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (picked.length > 0) sink.current(picked);
  }, []);

  return useMemo(
    () => ({
      dragging,
      open,
      inputProps: {
        ref: input,
        type: 'file' as const,
        accept,
        multiple,
        className: 'hidden',
        tabIndex: -1,
        onChange,
      },
    }),
    [accept, dragging, multiple, onChange, open],
  );
}

export interface FileIntakeProps {
  title: string;
  promise: string;
  copy: IntakeCopy;
  controls: IntakeControls;
  /** The tool's own emoji, shown only as decoration. */
  icon?: string;
  /** Anything that must sit under the drop zone — a format note, nothing more. */
  footNote?: string;
}

/**
 * The centred intake block. One `<h1>`, one grey line, one oversized button that
 * is also the drop zone, and one sentence naming the alternative to clicking it.
 *
 * This is the only place a generated tool page prints its one-line promise: the
 * page header stopped saying it, so the sentence exists once, next to the action
 * it describes.
 */
/**
 * The intake block, anchored high.
 *
 * Centring it in the page left a dead band between the title and the button on
 * every tall window, which reads as a page that has not loaded yet. The block
 * starts a quarter of the viewport down — the height the header and the breadcrumb
 * already cost on a laptop — and the region scrolls instead of colliding with the
 * controls under it when the window is short.
 */
export function FileIntake({ title, promise, copy, controls, footNote }: FileIntakeProps) {
  return (
    <div
      data-intake="true"
      data-dragging={controls.dragging || undefined}
      className="flex min-h-0 flex-1 justify-center overflow-y-auto px-4 py-8 sm:px-6"
    >
      <div data-intake-block className="mt-[14vh] w-full max-w-[640px] text-center">
        <h1 className="font-display text-[26px] font-semibold leading-tight tracking-[-0.02em] text-ink sm:text-[34px]">
          {title}
        </h1>
        <p className="mx-auto mt-2 max-w-[52ch] text-[13px] leading-relaxed text-ink-muted">{promise}</p>

        <button
          type="button"
          onClick={controls.open}
          data-drop-target="true"
          aria-describedby="intake-drop-line"
          className={`doodle-btn mx-auto mt-8 flex min-h-[88px] w-full max-w-[400px] items-center justify-center gap-2 rounded-doodle-lg px-6 text-[17px] font-semibold transition-transform hover:-translate-y-0.5 sm:text-[19px] ${
            controls.dragging ? 'ring-2 ring-accent/40' : ''
          } ${FOCUS_RING}`}
        >
          <span aria-hidden className="text-[20px]">
            ⬆
          </span>
          {copy.pick}
        </button>
        <p id="intake-drop-line" className="mt-3 text-[12px] text-ink-muted">
          {copy.drop}
        </p>
        {footNote && <p className="mt-1 text-[11px] text-ink-muted/80">{footNote}</p>}
      </div>
    </div>
  );
}
