/**
 * Tools whose control surface is a bespoke React panel rather than a generated
 * form: they draw on the page, so they own both the sidebar and the main pane.
 *
 * These ids existed before the registry was introduced, and they are the ones a
 * returning visitor or a saved bookmark is most likely to use, so they stay
 * registered here. They are *not* a second implementation: each one has a `run`
 * on the same contract as every other tool, and the pane supplies the state a
 * field list cannot describe — placed marks, the dragged rectangle, the captured
 * frames — through `values`. So the guards (`core/guard`), the field clamping
 * (E15), the structural `warnings` and the per-file progress arrive through the
 * runner exactly as they do for the 100 generated tools, and the pane's only
 * private job is the interaction.
 *
 * A run with no pane state is the one case that must refuse rather than guess:
 * cropping by nothing, signing with nothing and scanning zero captures would all
 * hand back a file that is not what the user saw. Each refusal names the pane.
 *
 * Because the generated rail cannot fully describe them, the honesty also lives
 * in the definition: `promise` says what pressing the button gets you, and
 * `notes` say what the pane will *not* do.
 */
// `cropModel` is the crop pane's pure geometry module (no React), so the run and
// the rail agree on what "too little left to be a page" means.
import { MIN_KEPT_PT } from '@/components/tools/pdf/edit/cropModel';
import {
  ToolInputError,
  clampFields,
  clampNumber,
  openInputs,
  openPrimary,
  pagesField,
  pdfResult,
} from './helpers';
import { mediaBox, resolvePageSet, setMediaAndCrop, toPoints, type LengthUnit } from '../core/pages';
import {
  arrayValue,
  booleanValue,
  numberValue,
  objectValue,
  stringValue,
  type PdfToolDefinition,
  type ToolField,
  type ToolRunContext,
  type ToolValues,
} from './types';

/* ── field lists the run also reads ─────────────────────────────────────────
 *
 * These four tools have panes that can call `run` without the rail in front,
 * and `run` must not accept a value the rail would have refused (E15). So the
 * field list is a named constant the definition and the clamping share, instead
 * of a literal the run would have to describe a second time — and get wrong.
 */

/** Largest margin the rail will accept, in points (about 28 inches). */
const MAX_MARGIN_PT = 2000;

/**
 * The crop margins as the rail shows them.
 *
 * `unit: 'pt'` used to be printed beside a number the user could declare in
 * millimetres, and the help said “in points” two fields above a selector that
 * says otherwise — so the rail labelled 10 as `10 pt` while the crop took 28.3 pt
 * off the page. The bounds carry no unit for the same reason: `core/guard`’s
 * clamp sentence quotes them with the field's unit attached, and “at most 2000
 * pt” is not what a millimetre rail means.
 */
const CROP_SIDES = ['top', 'right', 'bottom', 'left'] as const;

const CROP_FIELDS: ToolField[] = [
  pagesField({ group: 'Pages' }),
  ...CROP_SIDES.map((side): ToolField => ({
    key: side,
    label: `${side.charAt(0).toUpperCase()}${side.slice(1)} margin`,
    type: 'number',
    default: 0,
    min: 0,
    max: MAX_MARGIN_PT,
    step: 1,
    half: true,
    group: 'Margins',
    help: 'Cut from that edge of the visible box, measured in the unit chosen below (points by default; 72 pt is one inch).',
  })),
  {
    key: 'unit',
    label: 'Margins are in',
    type: 'select',
    default: 'pt',
    group: 'Margins',
    help: 'A display unit only — the margins above are converted to the page’s own points when the crop is written.',
    options: [
      { value: 'pt', label: 'Points' },
      { value: 'mm', label: 'Millimetres' },
      { value: 'cm', label: 'Centimetres' },
      { value: 'in', label: 'Inches' },
    ],
  },
  {
    key: 'allPages',
    label: 'Every page',
    type: 'toggle',
    default: true,
    group: 'Pages',
    help: 'Off crops only the pages listed below, which is how a stray scan border is removed from one sheet.',
  },
];

/** The comparison knobs, clamped by the run as well as by the rail. */
const COMPARE_FIELDS: ToolField[] = [
  {
    key: 'sensitivity',
    label: 'Sensitivity',
    type: 'slider',
    default: 30,
    min: 5,
    max: 150,
    step: 1,
    group: 'Marking',
    help: 'How far a pixel has to change before it is marked. Raise it when antialiasing makes every page look different.',
  },
  {
    key: 'highlightColor',
    label: 'Highlight colour',
    type: 'color',
    default: '#ff0000',
    group: 'Marking',
    help: 'Drawn over the changed area, so choose a colour that still lets the text underneath be read.',
  },
];

/**
 * Bound a pane's values with the rail's own rule, collecting the corrections
 * for the result card (E15).
 */
function clampToFields(
  fields: readonly ToolField[],
  values: ToolValues,
  warnings: string[],
): ToolValues {
  const clamped = clampFields(fields, values);
  for (const change of clamped.changes) warnings.push(change.message);
  return clamped.values;
}

export const legacyTools: PdfToolDefinition[] = [
  {
    id: 'sign',
    name: 'Sign PDF',
    description: 'Draw, type or upload a signature and place it on any page',
    icon: '✍️',
    category: 'security',
    keywords: ['signature', 'initials', 'draw', 'sign document'],
    surface: 'custom',
    outputSuffix: '_signed.pdf',
    actionLabel: 'Place signature',
    promise: 'Your mark, placed where you drop it, drawn into the page in this tab.',
    notes: [
      'This places a visual signature: the picture or typed name is drawn onto the page. It is not a cryptographic signature — a later edit leaves no trace. "Digital sign PDF" adds a PKCS#7 signature that does.',
      'Nothing is uploaded; the document never leaves this tab.',
    ],
    async run(context: ToolRunContext) {
      const input = await openPrimary(context);
      const marks = objectValue<PaneSignatureMark[]>(context.values, 'marks') ?? [];
      if (marks.length === 0) throw paneOnlyError('Sign PDF', 'a signature placed on the page');
      const { drawSignatureMarks } = await import('@/lib/pdf-engine/commands');
      const outcome = await drawSignatureMarks(input.doc, marks, {
        progress: context.progress,
        signal: context.signal,
      });
      if (outcome.placed === 0) {
        throw new ToolInputError(
          'OUT_OF_RANGE',
          'None of the placed signatures could be written — every one sat on a page this document does not have, or had nothing inside it.',
          { fileName: input.name, hint: 'Place a signature on a page you can see in the preview.' },
        );
      }
      const pages = new Set(marks.map((mark) => mark.page)).size;
      const result = await pdfResult(input.doc, {
        message: `Wrote ${count(outcome.placed, 'signature')} onto ${count(pages, 'page')} of "${input.name}".`,
      });
      return { ...result, warnings: outcome.notes };
    },
  },
  {
    id: 'pdf-crop',
    name: 'Crop PDF',
    description: 'Drag a crop rectangle or type exact margins in points, mm or inches',
    icon: '✂️',
    category: 'edit',
    keywords: ['trim margins', 'cut edges', 'bounds', 'mediabox'],
    surface: 'custom',
    outputSuffix: '_cropped.pdf',
    actionLabel: 'Crop',
    promise: 'The page shows only the rectangle you keep, on every page you select.',
    notes: [
      'Cropping sets the page’s visible box. Ink outside it is hidden, not deleted: the file barely shrinks, and text you cropped away can still be extracted. Use redaction to remove content for good.',
      'Margins are applied per page in the page’s own units, so mixed page sizes each keep their own geometry.',
    ],
    fields: CROP_FIELDS,
    async run(context: ToolRunContext) {
      const input = await openPrimary(context);
      const warnings: string[] = [];
      // E15 again: the rail bounds the margins, a pane may not. Clamped through
      // the same `core/guard` call the rail uses so the sentence matches.
      const values = clampToFields(CROP_FIELDS, context.values, warnings);
      const unit = stringValue(values, 'unit', 'pt') as LengthUnit;
      // What the user typed, and what the page box will actually lose: the two
      // are only the same number when the unit is points.
      const asked = CROP_SIDES.map((side) => numberValue(values, side, 0));
      const margins = asked.map((value) => marginPoints(value, unit));
      const [top, right, bottom, left] = margins;
      if (top + right + bottom + left <= 0) throw paneOnlyError('Crop PDF', 'a crop rectangle');
      const targets = resolveTargets(context, input.pageCount);
      const tooSmall: number[] = [];
      let cropped = 0;
      for (const index of targets) {
        const page = input.doc.getPage(index);
        const box = mediaBox(page);
        const width = box.width - left - right;
        const height = box.height - top - bottom;
        // A page this panel never measured can still be too small for these
        // margins: report it instead of writing a zero-area page (E8, E13).
        if (width < MIN_KEPT_PT || height < MIN_KEPT_PT) {
          tooSmall.push(index + 1);
          continue;
        }
        setMediaAndCrop(page, { x: box.x + left, y: box.y + bottom, width, height });
        cropped += 1;
      }
      if (cropped === 0) {
        throw new ToolInputError(
          'OUT_OF_RANGE',
          `These margins leave nothing to keep on ${count(targets.length, 'page')} of "${input.name}".`,
          { fileName: input.name, hint: 'Drag the rectangle smaller, or crop fewer pages.' },
        );
      }
      if (tooSmall.length > 0) {
        warnings.push(`${count(tooSmall.length, 'page')} (${formatPageList(tooSmall)}) was smaller than the crop leaves room for and kept its own size.`);
      }
      const result = await pdfResult(input.doc, {
        message: `Cropped ${count(cropped, 'page')} to the kept rectangle; ${describeMargins(margins, asked, unit)}`,
      });
      return { ...result, warnings };
    },
  },
  {
    id: 'scan-to-pdf',
    name: 'Scan to PDF',
    description: 'Capture pages with your camera and build one clean PDF from them',
    icon: '📸',
    category: 'organize',
    // The pane fills the page from the camera or from photos picked off disk, so
    // a PDF must never be demanded of it — the shared gate would answer
    // "that is not a PDF" to the very files this tool takes (E2).
    inputKind: 'image',
    accept: '.jpg,.jpeg,.png,.webp,.heic,.heif,image/*',
    keywords: ['camera', 'document scanner', 'edge detection', 'perspective'],
    surface: 'custom',
    outputSuffix: '_scan.pdf',
    actionLabel: 'Generate PDF',
    promise: 'One PDF from the pages you capture, each page a picture of the paper.',
    notes: [
      'Camera access is requested only when you start a scan; frames never leave the tab.',
      'Captures are photographs: each page is an image with no text layer, so the result cannot be searched or selected until you run OCR on it.',
      'This pane does not find the edges of the paper or correct perspective. It straightens tones (greyscale plus contrast) when enhancement is on; crop the page or re-shoot if the document fills too little of the frame.',
    ],
    fields: [
      {
        key: 'pageSize',
        label: 'Page size',
        type: 'select',
        default: 'a4',
        group: 'Page',
        help: 'Fit to image keeps the paper’s own proportions and gives you a page with no border to trim.',
        options: [
          { value: 'a4', label: 'A4' },
          { value: 'letter', label: 'US Letter' },
          { value: 'fit', label: 'Fit to image' },
          { value: 'original', label: 'Original size' },
        ],
      },
      {
        key: 'orientation',
        label: 'Orientation',
        type: 'select',
        default: 'portrait',
        group: 'Page',
        help: 'Only used when the sheet above is a fixed size.',
        when: (values) => values['pageSize'] !== 'fit' && values['pageSize'] !== 'original',
        options: [
          { value: 'portrait', label: 'Portrait' },
          { value: 'landscape', label: 'Landscape' },
        ],
      },
      { key: 'margin', label: 'Margin', type: 'slider', default: 10, min: 0, max: 40, step: 1, unit: 'pt', group: 'Page', help: 'White border kept around the captured page so a printer with no borderless mode does not cut the text.' },
      {
        key: 'fit',
        label: 'Fit',
        type: 'select',
        default: 'contain',
        group: 'Page',
        help: 'Fill crops part of the paper away; stretch distorts it. Fit inside is the one that never loses what you scanned.',
        options: [
          { value: 'contain', label: 'Fit inside the page' },
          { value: 'cover', label: 'Fill the page (crop)' },
          { value: 'stretch', label: 'Stretch' },
        ],
      },
    ],
    async run(context: ToolRunContext) {
      if (context.inputs.length === 0) throw paneOnlyError('Scan to PDF', 'a captured page');
      const images = await Promise.all(
        context.inputs.map(async (file) => ({
          name: file.name,
          mime: file.type || 'image/jpeg',
          bytes: await file.bytes(),
        })),
      );
      const { scanImagesToPdf } = await import('@/lib/pdf-engine/commands');
      const packed = await scanImagesToPdf(
        images,
        {
          pageSize: stringValue(context.values, 'pageSize', 'a4'),
          orientation: stringValue(context.values, 'orientation', 'portrait') as 'portrait' | 'landscape',
          margin: numberValue(context.values, 'margin', 10),
          fit: stringValue(context.values, 'fit', 'contain') as 'contain' | 'cover' | 'stretch',
        },
        { progress: context.progress, signal: context.signal },
      );
      if (packed.pages === 0) {
        throw new ToolInputError(
          'UNSUPPORTED',
          `None of the ${count(images.length, 'capture')} could be decoded by this browser.`,
          { hint: `The first said: ${packed.skipped[0]?.reason ?? 'no reason given'}. Re-shoot or convert the photo, then add it again.` },
        );
      }
      const warnings = packed.skipped.map(
        (skip) => `"${skip.name}" was not written to the PDF: ${skip.reason}.`,
      );
      if (packed.pages < images.length) {
        warnings.push(`${count(images.length - packed.pages, 'captured page')} became ${count(packed.pages, 'page')} in the file.`);
      }
      return {
        kind: 'pdf' as const,
        bytes: packed.bytes,
        // The packer counts its own pages as it lays them out; undecodable
        // captures are excluded there, so this is the output's real length.
        pages: packed.pages,
        message: `Built a ${count(packed.pages, 'page')} PDF from ${count(images.length, 'capture')}; each page is a photograph, so it is not searchable until you run OCR.`,
        warnings,
      };
    },
  },
  {
    id: 'compare',
    // `compare-pdfs` (security.ts) exports a difference report and holds the plain
    // name; this entry is the pane that shows both files at once, and two catalogue
    // rows called "Compare PDFs" is a choice nobody can read.
    name: 'Compare Side by Side',
    description: 'View two PDFs side by side and highlight every difference',
    icon: '🔍',
    category: 'security',
    keywords: ['diff', 'changes', 'versions', 'redline'],
    multiFile: true,
    minFiles: 2,
    maxFiles: 2,
    surface: 'custom',
    outputSuffix: '_comparison.pdf',
    actionLabel: 'Compare',
    promise: 'Both files rendered side by side, with the pixels that differ marked up.',
    notes: [
      'Differences are found by rendering each page and comparing pixels at your sensitivity setting, not by reading text: a reflowed paragraph counts as a change and a swapped-in synonym may not.',
      'Only the pages both files have are compared. If one document is shorter, the extra pages are reported and left out of the result.',
      'Both PDFs are opened in this tab; nothing is uploaded.',
    ],
    fields: COMPARE_FIELDS,
    async run(context: ToolRunContext) {
      const [first, second] = await openInputs(context);
      const warnings: string[] = [];
      // E15, the same rule the rail applies: a pane (or a test) can hand `run`
      // a sensitivity of 9000, which marks every pixel on every page as changed
      // and still returns a file that looks like a verdict.
      const values = clampToFields(COMPARE_FIELDS, context.values, warnings);
      const sensitivity = numberValue(values, 'sensitivity', 30);
      const highlightColor = compareColor(values, warnings);
      const { comparePDFs } = await import('@/lib/pdf-engine/commands');
      const outcome = await comparePDFs(first.bytes, second.bytes, {
        sensitivity,
        highlightColor,
      }, { progress: context.progress, signal: context.signal });
      if (outcome.compared === 0) {
        throw new ToolInputError(
          'UNSUPPORTED',
          'Neither document has a page, so there is nothing to compare.',
        );
      }
      if (outcome.onlyInFirst > 0 || outcome.onlyInSecond > 0) {
        warnings.push(
          `Only the first ${count(outcome.compared, 'page')} were compared: "${first.name}" has ${count(outcome.onlyInFirst, 'extra page')} the other does not, and "${second.name}" has ${count(outcome.onlyInSecond, 'extra page')}.`,
        );
      }
      return {
        kind: 'pdf' as const,
        bytes: outcome.bytes,
        // One output page is written per compared page, so `compared` is the
        // produced document's length — not the length of either input.
        pages: outcome.compared,
        message: `Compared ${count(outcome.compared, 'page')} of "${first.name}" against "${second.name}" and painted the differences onto the copy.`,
        warnings,
      };
    },
  },
];

/* ── helpers ──────────────────────────────────────────────────────────────── */

/** A mark the sign pane placed; `x`/`y` are fractions of the target page. */
interface PaneSignatureMark {
  type: 'text' | 'image';
  text: string;
  image?: Uint8Array | null;
  mime?: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  fontFamily?: string;
}

/**
 * The four bespoke panes all have the same empty state: the work lives in the
 * pane, and the Run button was pressed before anything was put in it. Saying
 * "nothing to do" without naming where the input comes from is how a user
 * concludes the tool is broken.
 */
function paneOnlyError(tool: string, expected: string): ToolInputError {
  return new ToolInputError(
    'OUT_OF_RANGE',
    `${tool} needs ${expected} from its own editor pane, and there is none yet.`,
    { hint: 'Set it on the page preview first, then run again.' },
  );
}

/**
 * Which pages to crop.
 *
 * The pane resolves its own page numbers (it knows the rectangle came from the
 * page it drew) and passes them as a 1-based list; a rail-driven run passes a
 * spec string. `core/pages` is the only parser for either.
 */
function resolveTargets(context: ToolRunContext, total: number): number[] {
  const list = arrayValue(context.values, 'pages');
  if (list.length > 0) return resolvePageSet(list, total);
  if (booleanValue(context.values, 'allPages', true)) return resolvePageSet('all', total);
  return resolvePageSet(stringValue(context.values, 'pages', 'all'), total);
}

/**
 * The highlight colour, in the `#rrggbb` spelling the comparison paints with.
 *
 * E15 again, for a value the browser's colour picker can leave empty while the
 * user is still typing it: an unparseable colour used to reach the pixel diff as
 * black, so the result said "painted the differences" in a colour nobody chose.
 * The default is used and the substitution is announced.
 */
function compareColor(values: ToolValues, warnings: string[]): string {
  const hex = stringValue(values, 'highlightColor', '#ff0000').trim();
  if (/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return hex.startsWith('#') ? hex : `#${hex}`;
  warnings.push(`"${hex}" is not a colour the comparison can paint with, so the default #ff0000 was used.`);
  return '#ff0000';
}

/** The margins in the page’s own points, whatever unit was typed. */
function marginPoints(value: number, unit: LengthUnit): number {
  return Math.round(toPoints(clampNumber(value, 0, MAX_MARGIN_PT), unit) * 10) / 10;
}

/**
 * What the page boxes lost, in the unit the file is written in.
 *
 * `setMediaAndCrop` stores points, so printing the typed numbers with `mm` after
 * them claimed a 10 mm margin had taken 10 points off the page — the one figure
 * a person checks before trusting a crop. Both spellings appear now: the points
 * that went, and what the user entered to get there.
 */
function describeMargins(margins: number[], asked: number[], unit: LengthUnit): string {
  const points = `${margins[0]}/${margins[1]}/${margins[2]}/${margins[3]} pt (top/right/bottom/left)`;
  const typed = unit === 'pt' ? '' : ` — the ${asked.join('/')} ${unit} you entered, converted`;
  return `${points}${typed} were taken off each kept page.`;
}

function formatPageList(pages: number[]): string {
  if (pages.length <= 6) return pages.join(', ');
  return `${pages.slice(0, 6).join(', ')}, …`;
}

function count(value: number, noun: string, plural?: string): string {
  return value === 1 ? `1 ${noun}` : `${value} ${plural ?? `${noun}s`}`;
}
