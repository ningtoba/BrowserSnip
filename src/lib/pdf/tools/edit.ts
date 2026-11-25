/**
 * Edit PDF tools — page marks, stamps, navigation and content colour.
 *
 * Everything here draws real PDF content through `core/fonts`, which is what
 * fixes the long-standing crash where any Cyrillic, Greek or CJK watermark,
 * page number or Bates stamp threw `WinAnsi cannot encode …`.
 *
 * Two rules govern every mark drawn below, because these tools write into the
 * page itself:
 *
 * - Geometry is worked out in *displayed* coordinates and converted back to PDF
 *   user space (`frameOf`, `placeRun`, `toUserSpace`). A `/Rotate 90` page turns
 *   the rendered sheet 90° clockwise, so anchoring on the crop box directly put
 *   a "bottom centre" page number on the left edge and drew it sideways (E9).
 * - The frame comes from the page being drawn on, never from page 1, so a mixed
 *   size document measures each page on its own (E8).
 *
 * Anything a tool could not do exactly as asked — a clamped value, a skipped
 * page, a substituted typeface — is collected in a `notes` array and returned
 * as `result.warnings`, never buried in a success message.
 */
import type { PDFDocument, PDFPage, PDFFont } from '../core/doc';
import { PDFArray, PDFName, PDFRef, degrees, rgb, savePDF } from '../core/doc';
import { drawTextU, measureText, wrapText } from '../core/fonts';
import { mergeFaceStyle, standardFamilyFace, standardFacesSpell, type FaceStyle } from '../core/text-style';
import { faceColor, readTextStyle, rememberTextStyle, textStyleFields } from './textStyleFields';
import { pageContentOps } from '../core/content';
import { cropBox, displayedSize, resolvePages, type PageBox } from '../core/pages';
// The stamp list lives with the surface that renders it (`editor/tools.ts`), so the rail
// cannot carry a second copy that drifts; the module is plain data + the face table, no UI.
import { BUILT_IN_STAMPS, LEGACY_STAMP_SPELLINGS } from '@/components/tools/pdf/editor/tools';
import { addPageLabels, readPageLabels, readPageLabelRanges, writeOutline, readOutline, toRoman, toLetters, type OutlineNode } from '../core/bookmarks';
import { hasXfa, listFormFields, type CreateFieldSpec } from '../core/forms';
import { ocrSilentPageOf } from '../core/ocr';
import type { OcrPageResult, OcrSilentKind, OcrSilentPage } from '../core/ocr';
import { canvasToBlob } from '../core/render';
import { embedImageBytes } from '../core/pack';
import { newPDF } from '../core/doc';
import { clampNumber, openInputs, pagesField, pdfResult, reportResult, throwIfAborted, withRender, downloadStem, type OpenedInput } from './helpers';
import {
  booleanValue,
  numberValue,
  stringValue,
  stringValues,
  type FieldChoicesInput,
  type PdfToolDefinition,
  type ToolFieldOption,
  type ToolResult,
  type ToolRunContext,
} from './types';

type Anchor = 'top-left' | 'top-center' | 'top-right' | 'center-left' | 'center' | 'center-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';

/** A rectangle in the coordinates a viewer shows the page in. */
interface RunRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a stamped run's ink ended up, in displayed coordinates (see `stamp`). */
interface StampedBox {
  width: number;
  inkBottom: number;
  inkTop: number;
}

/**
 * The page as the reader sees it.
 *
 * `/Rotate` is *not* applied to the stored geometry, only to the rendering, so
 * on a `/Rotate 90` page the visible corners are nowhere near the page-space
 * ones and the visible width is the stored height. Marks are placed here and
 * converted back before they are drawn (E9).
 */
interface PageFrame {
  /** Crop box in unrotated PDF user space. */
  box: PageBox;
  /** `/Rotate` normalised to a multiple of 90. */
  rotation: 0 | 90 | 180 | 270;
  /** Visible width and height, after `/Rotate`. */
  width: number;
  height: number;
}

function frameOf(page: PDFPage): PageFrame {
  const box = cropBox(page);
  const angle = Math.round(page.getRotation().angle / 90) * 90;
  const rotation = (((angle % 360) + 360) % 360) as 0 | 90 | 180 | 270;
  const quarter = rotation === 90 || rotation === 270;
  return {
    box,
    rotation,
    width: quarter ? box.height : box.width,
    height: quarter ? box.width : box.height,
  };
}

/** A displayed-space point (origin: bottom-left of the visible page) in PDF user space. */
function toUserSpace(frame: PageFrame, x: number, y: number): { x: number; y: number } {
  const { box, rotation } = frame;
  if (rotation === 90) return { x: box.x + box.width - y, y: box.y + x };
  if (rotation === 180) return { x: box.x + box.width - x, y: box.y + box.height - y };
  if (rotation === 270) return { x: box.x + y, y: box.y + box.height - x };
  return { x: box.x + x, y: box.y + y };
}

/**
 * A displayed-space rectangle in PDF user space. Still axis-aligned, because
 * `/Rotate` is always a multiple of 90 — the sizes just swap on a quarter turn.
 */
function toUserRect(frame: PageFrame, rect: RunRect): PageBox {
  const a = toUserSpace(frame, rect.x, rect.y);
  const b = toUserSpace(frame, rect.x + rect.width, rect.y + rect.height);
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

/** Which edges an anchor name refers to, once, instead of re-deriving them by string position. */
const ANCHOR_AXIS: Record<Anchor, { horizontal: 'left' | 'center' | 'right'; vertical: 'top' | 'center' | 'bottom' }> = {
  'top-left': { horizontal: 'left', vertical: 'top' },
  'top-center': { horizontal: 'center', vertical: 'top' },
  'top-right': { horizontal: 'right', vertical: 'top' },
  'center-left': { horizontal: 'left', vertical: 'center' },
  center: { horizontal: 'center', vertical: 'center' },
  'center-right': { horizontal: 'right', vertical: 'center' },
  'bottom-left': { horizontal: 'left', vertical: 'bottom' },
  'bottom-center': { horizontal: 'center', vertical: 'bottom' },
  'bottom-right': { horizontal: 'right', vertical: 'bottom' },
};

function anchorAxis(anchor: string): { horizontal: 'left' | 'center' | 'right'; vertical: 'top' | 'center' | 'bottom' } {
  return ANCHOR_AXIS[anchor as Anchor] ?? ANCHOR_AXIS.center;
}

/** The visible bounding box of a `width` × `height` run turned by `angle` degrees. */
function runBounds(width: number, height: number, angle: number) {
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corner = (x: number, y: number) => ({ x: x * cos - y * sin, y: x * sin + y * cos });
  const points = [corner(0, 0), corner(width, 0), corner(width, height), corner(0, height)];
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { minX, minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/**
 * Where a run starts in displayed coordinates so its visible box sits at
 * `anchor` with `margin` of clearance.
 *
 * The margin shrinks when the page is too small for it (E8: a business card is
 * measured as a business card), and a run wider than the page is centred rather
 * than pushed off the edge — the caller reports the overhang.
 */
function placeRun(frame: PageFrame, width: number, height: number, angle: number, anchor: string, margin: number) {
  const bounds = runBounds(width, height, angle);
  const axis = anchorAxis(anchor);
  const roomX = frame.width - bounds.width;
  const roomY = frame.height - bounds.height;
  const mx = Math.min(Math.max(margin, 0), Math.max(0, roomX) / 2);
  const my = Math.min(Math.max(margin, 0), Math.max(0, roomY) / 2);
  const leftEdge = { left: mx, right: roomX - mx, center: roomX / 2 }[axis.horizontal];
  const topEdge = { top: roomY - my, bottom: my, center: roomY / 2 }[axis.vertical];
  return {
    x: leftEdge - bounds.minX,
    y: topEdge - bounds.minY,
    bounds,
    overflow: roomX < -0.5 || roomY < -0.5,
  };
}

/**
 * Record an admission once.
 *
 * A 500-page run stamps the same page size five hundred times; the result card
 * needs the sentence once (E7).
 */
function note(notes: string[], message: string): void {
  if (!notes.includes(message)) notes.push(message);
}

/** Latin-only standard faces, keyed the way the `font` picker names them. */
/**
 * Position text inside the page as the reader sees it, honouring /Rotate (E9),
 * measuring that page alone (E8) and never drawing unsupported glyphs with a
 * WinAnsi face (E11). Returns the run width in points.
 */
async function stamp(
  doc: PDFDocument,
  page: PDFPage,
  text: string,
  options: {
    anchor: Anchor;
    /** The shared style model: family, weight, slant, size and colour. */
    style: FaceStyle;
    rotation?: number;
    opacity?: number;
    margin?: number;
    notes?: string[];
  },
): Promise<StampedBox> {
  const notes = options.notes ?? [];
  const style = options.style;
  const size = style.size;
  const frame = frameOf(page);
  const angle = options.rotation ?? 0;
  // The face is chosen the way every other writer chooses it: a standard-14 family
  // answers with its own named face at the asked posture (a real oblique, not a
  // slanted regular), and anything past that goes through `core/fonts`, which embeds
  // a subset and is reported. A posture the answering face cannot carry is said.
  const face = await railFace(doc, style, text, notes);
  const measured = face
    ? { width: face.widthOfTextAtSize(text, size), font: face }
    : await measureText(doc, { text, x: 0, y: 0, size, bold: style.bold, italic: style.italic });
  const width = measured.width;
  // The margin is measured to the *ink*, not to the em box. A descender hangs
  // below the baseline, so an em-box run placed at `margin: 0` hung 3.3 pt of an
  // 11 pt folio outside the crop box — measured on an upright sheet (bbox bottom
  // -3.29 pt, inked to the last pixel row) and on a /Rotate 90 one (bbox past the
  // crop's right edge at 423.29 of 420) — where the viewer clips it.
  //
  // The reach is the face's own declared lower bound — an AFM `/FontBBox` or the
  // outline font's bbox in font units — because the nominal AFM descender stops
  // 0.02 em above what a `g` actually draws and left its tip on the edge.
  // SAFETY: a face handed to `embedFont` by `core/fonts` is a fontkit object that
  // carries `embedder.font` with the program's own bbox; the public pdf-lib type
  // stops at `heightAtSize`, so the optional shape below is the only reach for it
  // and every step is optional-chained.
  const faceFont = (measured.font as unknown as {
    embedder?: { font?: { bbox?: { minY?: number }; FontBBox?: number[]; descent?: number; unitsPerEm?: number } };
  }).embedder?.font;
  const declared = Math.abs(faceFont?.bbox?.minY ?? faceFont?.FontBBox?.[1] ?? faceFont?.descent ?? 0)
    / (faceFont?.unitsPerEm ?? 1000);
  const ascent = measured.font.heightAtSize(size, { descender: false });
  const descent = Math.max(0, measured.font.heightAtSize(size) - ascent, Math.min(declared, 0.35) * size);
  const height = Math.max(ascent + descent, 1);
  const run = placeRun(frame, width, height, angle, options.anchor, options.margin ?? 24);
  if (run.overflow) {
    // Name it as an excerpt: the first 18 characters alone would fit the page, so
    // quoting them bare read as a run that *does* fit and does not.
    const shown = [...text].slice(0, 18).join('');
    const total = [...text].length;
    const quoted = total > [...shown].length ? `“${shown}” — the first ${[...shown].length} of ${total} characters —` : `“${shown}”`;
    note(notes, `${quoted} does not fit inside a ${Math.round(frame.width)}×${Math.round(frame.height)} pt page, so it runs past the edges.`);
  }
  const origin = toUserSpace(frame, run.x, run.y + descent);
  // Text is turned by the page's own /Rotate on top of the requested angle, so
  // what the user sees as "45°" reads as 45° in a viewer whatever /Rotate is.
  const pageAngle = angle + frame.rotation;
  if (face) {
    page.drawText(text, {
      x: origin.x,
      y: origin.y,
      size,
      font: face,
      color: faceColor(style.color),
      opacity: options.opacity,
      rotate: degrees(pageAngle),
    });
  } else {
    await drawTextU(page, {
      text,
      x: origin.x,
      y: origin.y,
      size,
      color: faceColor(style.color),
      bold: style.bold,
      italic: style.italic,
      opacity: options.opacity,
      rotation: pageAngle,
    });
  }
  // The ink box the run actually occupies, in the same displayed coordinates the
  // anchor was asked in, so a caller can put something a fixed distance from the
  // *ink* — a header rule 4 pt below the descenders, not below the em box.
  return { width, inkBottom: run.y, inkTop: run.y + height };
}

/**
 * The named face for a rail style, or `null` when the embedded path must answer.
 *
 * `null` is not a failure: it is the case where the family has no face for the run
 * (a Latin-only pick past WinAnsi, or a pick this tab has no bytes for), and
 * `drawTextU` then embeds one. The caller reports which happened, so a substituted
 * folio never looks like the family that was chosen.
 *
 * A standard-14 family answers from its **own named faces** at the asked posture —
 * `Helvetica-Bold`, `Times-Italic`, `Courier-BoldOblique` — which is the whole reason
 * italic is offered for those three and nowhere else: the app has no italic file for
 * the bundled Noto, and a slant the file cannot carry is a preview that lies.
 */
async function railFace(
  doc: PDFDocument,
  style: FaceStyle,
  text: string,
  notes: string[],
): Promise<PDFFont | null> {
  const face = standardFamilyFace(style.fontFamily, style.bold, style.italic);
  if (!face) return null;
  if (!standardFacesSpell(text)) {
    const sample = [...text].slice(0, 12).join('');
    note(notes, `“${style.fontFamily.replace(/^std:/, '')}” cannot render “${sample}” — it is a Latin-only face, so an embedded Unicode font was used instead${style.italic ? ', and the slant with it: the bundled faces hold no italic' : ''}.`);
    return null;
  }
  return doc.embedFont(face);
}

/**
 * The face a stamp label is drawn with, embedded if need be.
 *
 * `addAnnotations` is synchronous (contract §2), so a stamp whose family is not one
 * of the three named ones cannot have its face fetched by the annotation writer. The
 * tool embeds it here and the appearance stream writes exactly that. `null` means the
 * writer's own standard-14 answer is already the right one.
 */
async function stampLabelFace(
  doc: PDFDocument,
  style: FaceStyle,
  label: string,
  notes: string[],
): Promise<PDFFont | null> {
  const named = await railFace(doc, style, label, notes);
  if (named) return named;
  const { getFont } = await import('../core/fonts');
  return getFont(doc, {
    text: label,
    size: style.size,
    bold: style.bold,
    italic: style.italic,
    fontFamily: style.fontFamily || undefined,
  });
}

/** Numeric option bounds, mirroring what the rail declared for the same field (E15). */
interface NumberOption {
  key: string;
  label: string;
  fallback: number;
  min: number;
  max: number;
  integer?: boolean;
  unit?: string;
}

/**
 * Clamp one form value and admit it (E15: "clamped or rejected with a reason").
 *
 * `core/guard` clamps the same fields in the runner; this is the backstop for
 * values that arrive from a bespoke pane, the legacy `params` objects, or a
 * direct `run()` call, where nothing else has looked at them.
 */
/**
 * Clamp one option into range and record it (E15: "clamped or rejected with a
 * reason").
 *
 * `core/guard` clamps the same fields in the runner with the same sentence, so a
 * corrected value reads identically whichever layer caught it; this is the
 * backstop for values that arrive from a bespoke pane, the legacy `params`
 * objects, or a direct `run()` call, where nothing else has looked at them.
 */
function bounded(
  notes: string[],
  label: string,
  raw: number,
  option: { min: number; max: number; integer?: boolean; unit?: string },
): number {
  const value = clampNumber(raw, option.min, option.max, { integer: option.integer });
  if (value !== raw) {
    note(notes, `${label} must be ${boundsSentence(option)}: ${raw} became ${value}.`);
  }
  return value;
}

function boundsSentence(option: { min: number; max: number; unit?: string }): string {
  const unit = option.unit ? ` ${option.unit}` : '';
  const hasMin = Number.isFinite(option.min);
  const hasMax = Number.isFinite(option.max);
  if (hasMin && hasMax) {
    return option.min === option.max ? `${option.min}${unit}` : `between ${option.min} and ${option.max}${unit}`;
  }
  if (hasMin) return `at least ${option.min}${unit}`;
  if (hasMax) return `at most ${option.max}${unit}`;
  return 'a number';
}

function readNumber(context: ToolRunContext, notes: string[], option: NumberOption): number {
  const raw = numberValue(context.values, option.key, option.fallback);
  return bounded(notes, option.label, raw, option);
}

/** Attach the run's admissions to a result — `pdfResult` takes no warnings option. */
function admit(result: ToolResult, notes: string[]): ToolResult {
  if (notes.length > 0) result.warnings = notes;
  return result;
}

async function pdfOutput(doc: PDFDocument, notes: string[], message: string): Promise<ToolResult> {
  return admit(await pdfResult(doc, { message }), notes);
}

/**
 * Draw with `paint`'s operators placed *behind* the page's existing content.
 *
 * pdf-lib appends one content stream per draw call and `/Contents` is painted in
 * order, so the streams that appeared during `paint` are joined into one and put
 * in front of the streams that were already there. Without this, "Placement:
 * Behind content" was a zero-size no-op rectangle that still reported a
 * watermark (E13).
 */
async function drawBehind(page: PDFPage, paint: () => Promise<void> | void): Promise<void> {
  const { joinContentStreams, pageContentStreams, setContentStreams } = await import('../core/content');
  const before = new Set(pageContentStreams(page).map((stream) => stream.ref.toString()));
  await paint();
  const streams = pageContentStreams(page);
  const kept = streams.filter((stream) => before.has(stream.ref.toString()));
  const fresh = streams.filter((stream) => !before.has(stream.ref.toString()));
  if (fresh.length === 0) return;
  const mark = joinContentStreams(page, fresh.map((stream) => stream.ref), { textFirst: true });
  if (kept.length === 0) {
    setContentStreams(page, [mark]);
    return;
  }
  // pdf-lib wraps a loaded page's content in its own `q`/`Q` streams. They belong
  // with the content they wrap, so the group is folded into one stream and the
  // mark becomes the only stream in front of it.
  const first = kept[0].ref;
  joinContentStreams(page, kept.map((stream) => stream.ref), { into: first });
  setContentStreams(page, [mark, first]);
}

/**
 * How many of a page's leading content streams are background artifacts this app wrote.
 *
 * `prependBackground` puts its stream at the head of `/Contents`, and draw order is array
 * order, so a *second* run landed further back than the first one's wash: the colour the
 * user had just chosen was the colour nobody could see. Measured on the shipped build —
 * `#ff0000` on page 1, then that file again with `#0000ff` — the export carried
 * `/Contents [pass-2, pass-1, the page's own]`, its paper pixel read (214.3,0.3,0.4),
 * 78.2 % of the sheet the *first* red and 0.0 % of the blue the card named.
 */
function leadingBackgroundArtifacts(streams: { bytes: Uint8Array }[]): number {
  let count = 0;
  for (const stream of streams) {
    const head = Buffer.from(stream.bytes.slice(0, 96)).toString('latin1');
    if (!head.trimStart().startsWith('/Artifact') || !head.includes('/Type /Background')) break;
    count += 1;
  }
  return count;
}

/**
 * True when the page writes `/CropBox` as an empty array.
 *
 * An absent `/CropBox` means "the MediaBox is the crop"; an empty one is a
 * producer saying this page has no visible box, which no measurement of the
 * MediaBox can reveal.
 */
/**
 * How many of a page's text-show operators paint with neither fill nor stroke.
 *
 * `Tr 3` (invisible) and `Tr 7` (neither) are what an OCR text layer is made of, and a
 * recolour of them changes the colour in force and nothing else. Only runs the `from`
 * filter would actually take are counted, so the admission cannot out-number the total.
 */
function invisibleRunsOn(page: PDFPage, from: string): number {
  const renderModes = new Set(['3', '7']);
  const shows = new Set(['Tj', 'TJ', "'", '"']);
  let mode = '0';
  let count = 0;
  for (const op of pageContentOps(page)) {
    if (op.name === 'Tr') {
      // Operand shapes are a union, so read the number out of the serialised form.
      const found = JSON.stringify(op.operands).match(/"value":\s*(-?\d+(?:\.\d+)?)/u);
      if (found) mode = String(Number(found[1]));
    } else if (shows.has(op.name) && renderModes.has(mode)) {
      // With a colour filter in force, an invisible run the filter rejects is not in the
      // recolour count either, so it must not be admitted here.
      if (from === 'any') count += 1;
    }
  }
  return from === 'any' ? count : 0;
}

function declaredCropBoxIsEmpty(page: PDFPage): boolean {
  const raw = page.node.get(PDFName.of('CropBox'));
  const value = raw instanceof PDFRef ? page.doc.context.lookup(raw) : raw;
  return value instanceof PDFArray && value.size() === 0;
}

const ANCHOR_OPTIONS = [
  { value: 'top-left', label: 'Top left' },
  { value: 'top-center', label: 'Top centre' },
  { value: 'top-right', label: 'Top right' },
  { value: 'center-left', label: 'Middle left' },
  { value: 'center', label: 'Centre' },
  { value: 'center-right', label: 'Middle right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-center', label: 'Bottom centre' },
  { value: 'bottom-right', label: 'Bottom right' },
];

/** The six text slots a header/footer run can fill, in draw order. */
const HEADER_SLOTS = ['headerLeft', 'headerCenter', 'headerRight'] as const;
const FOOTER_SLOTS = ['footerLeft', 'footerCenter', 'footerRight'] as const;

/** Parse the fallback textual region format used when the surface is absent. */
function parseRegions(
  raw: unknown,
  doc: PDFDocument,
  notes: string[],
): { page: number; x: number; y: number; width: number; height: number }[] {
  const text = typeof raw === 'string' ? raw : '';
  const out: { page: number; x: number; y: number; width: number; height: number }[] = [];
  let unparseable = 0;
  let offDocument = 0;
  const accept = (region: { page: number; x: number; y: number; width: number; height: number }): void => {
    const frame = frameOf(doc.getPage(region.page));
    const x = Math.min(Math.max(region.x, frame.box.x), frame.box.x + Math.max(0, frame.box.width - 1));
    const y = Math.min(Math.max(region.y, frame.box.y), frame.box.y + Math.max(0, frame.box.height - 1));
    const width = Math.min(region.width, frame.box.x + frame.box.width - x);
    const height = Math.min(region.height, frame.box.y + frame.box.height - y);
    if (x !== region.x || y !== region.y || width !== region.width || height !== region.height) {
      note(notes, `A box on page ${region.page + 1} hung past the edge of the page, so it was trimmed to fit.`);
    }
    if (width > 0 && height > 0) out.push({ page: region.page, x, y, width, height });
    else note(notes, `A box on page ${region.page + 1} has no size once it is inside the page, so it was ignored.`);
  };
  if (Array.isArray(raw)) {
    for (const region of raw as { page: number; x: number; y: number; width: number; height: number }[]) {
      if (!Number.isInteger(region.page) || region.page < 0 || region.page >= doc.getPageCount()) {
        offDocument += 1;
        continue;
      }
      accept(region);
    }
  } else {
    for (const chunk of text.split(/[;\n]+/)) {
      if (!chunk.trim()) continue;
      // The field's help and its own refusal sentence both teach
      // "page:x,y,w,h"; the parser only read "1:x,y,w,h", so following the printed
      // instruction produced "could not be read — use page:x,y,w,h". Accept the
      // word the card teaches and keep the bare number working.
      const body = chunk.trim().replace(/^page\s*:\s*/i, '');
      const match = /^(\d+)\s*:\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)$/.exec(body);
      if (!match) {
        unparseable += 1;
        continue;
      }
      const page = Number(match[1]) - 1;
      if (page < 0 || page >= doc.getPageCount()) {
        offDocument += 1;
        continue;
      }
      accept({ page, x: Number(match[2]), y: Number(match[3]), width: Number(match[4]), height: Number(match[5]) });
    }
  }
  if (unparseable > 0) {
    note(notes, `${countLabel(unparseable, 'entry', 'entries')} could not be read — use page:x,y,w,h, separated by semicolons.`);
  }
  if (offDocument > 0) {
    // The verb follows the count: "2 boxes … and was ignored" read wrong on the card.
    note(notes, `${countLabel(offDocument, 'box', 'boxes')} named a page outside this ${doc.getPageCount()}-page document and ${offDocument === 1 ? 'was' : 'were'} ignored.`);
  }
  return out;
}

/** How many marks one page may receive from a tiled pattern (E7). */
const MAX_TILES = 400;

/**
 * The layer names the opened document carries, for the two toggle lists.
 *
 * The rail has no way to know them — `ToolField.options` is a static array — so the
 * field declares `choices` and the hook asks this once per loaded document. The
 * hint says which way the file holds the layer now, because both lists carry every
 * name and the tick alone would not tell a reader what the default view already says.
 */
async function layerChoices(input: FieldChoicesInput): Promise<ToolFieldOption[]> {
  const [{ listLayers }, { openPdfInput }] = await Promise.all([
    import('../core/layers'),
    import('../core/guard'),
  ]);
  const { doc } = await openPdfInput(input.bytes, input.name, { password: input.password });
  return listLayers(doc).map((layer) => ({
    value: layer.name,
    label: layer.name,
    hint: layer.on ? 'On in the file now — tick here to hide it.' : 'Hidden in the file now — tick here to show it.',
  }));
}

export const editTools: PdfToolDefinition[] = [
  {
    id: 'edit-pdf',
    name: 'PDF Editor',
    actionLabel: 'Save PDF',
    description: 'Annotate, highlight, redact and comment, or rewrite the words already on the page',
    icon: '✏️',
    category: 'edit',
    // `edit-pdf-text` is folded into this id, and the palette matches on keywords:
    // someone who remembers the old page types its name, and must get this tool.
    keywords: ['annotate', 'highlight', 'comment', 'draw', 'markup', 'pen', 'shapes', 'edit text', 'rewrite text', 'edit-pdf-text'],
    surface: 'custom',
    outputSuffix: '_edited.pdf',
    promise: 'Mark up the page, or retype the words already in it — one editor, one export, and it stays a standard PDF.',
    notes: [
      'Annotations are written as standard PDF annotations, so other readers show and edit them.',
      'Marks follow the page as you see it: on a rotated page a box you drew stays where you put it.',
      'The Edit text mode deletes the original glyph runs and redraws the block, so the old words are not left hiding underneath.',
      'Changing mode keeps the open document, every mark, every unfinished rewrite and the page you were on; each mode has its own undo, and it survives the trip.',
    ],
  },

  {
    /**
     * A folded route, not a second tool: `TOOL_ALIASES` sends this id to
     * `edit-pdf`, so it has no card, no palette row and no place in the count.
     * The definition stays because the bookmarks name it, because the text
     * editor's tests drive it by id, and because the pane lookup still answers it.
     */
    id: 'edit-pdf-text',
    name: 'Edit PDF Text',
    actionLabel: 'Save text',
    description: 'Click a paragraph and rewrite it in place, with reflow, fonts and styling',
    icon: '🖊️',
    category: 'edit',
    keywords: ['rewrite text', 'change wording', 'content editor', 'typo', 'in place'],
    surface: 'custom',
    outputSuffix: '_edited.pdf',
    promise: 'Rewrite a paragraph where it sits: the old glyphs are removed and the block is redrawn, not covered up.',
    notes: [
      'Editing deletes the original glyph runs and redraws the block, so the old text is not left hiding underneath.',
      'Blocks that PyMuPDF-grade surgery is needed for are reported instead of silently doubled.',
    ],
  },

  {
    id: 'page-numbers',
    name: 'Page Numbers',
    description: 'Number pages with position, format, range and style controls',
    icon: '🔢',
    category: 'edit',
    keywords: ['pagination', 'footer numbers', 'folio'],
    outputSuffix: '_numbered.pdf',
    actionLabel: 'Add numbers',
    promise: 'A folio drawn into the page itself, in the position and style you choose, on the pages you select.',
    fields: [
      { key: 'position', label: 'Position', type: 'select', default: 'bottom-center', options: ANCHOR_OPTIONS, group: 'Placement', help: 'Where on each page the folio is drawn, measured from the page as you see it.' },
      { key: 'margin', label: 'Margin', type: 'number', default: 24, min: 0, max: 200, step: 1, unit: 'pt', half: true, group: 'Placement', help: 'Measured from the visible edge of each page, including its rotation.' },
      pagesField({ group: 'Placement' }),
      { key: 'skip', label: 'Skip first N pages', type: 'number', default: 0, min: 0, max: 5000, step: 1, integer: true, half: true, group: 'Placement', help: 'Counted from the start of the selection, so cover pages stay blank. Clamped to the number of pages you selected.' },
      { key: 'step', label: 'Count every', type: 'number', default: 1, min: 1, max: 10, step: 1, integer: true, half: true, group: 'Placement', help: '2 numbers every second page from the first numbered one, useful for folded booklets.' },
      { key: 'startAt', label: 'First number', type: 'number', default: 1, min: 0, max: 100000, step: 1, integer: true, half: true, group: 'Format', help: 'The folio on the first numbered page. Start at 3 when the first two sheets are covers.' },
      { key: 'style', label: 'Number style', type: 'select', default: 'decimal', options: [
        { value: 'decimal', label: '1, 2, 3' },
        { value: 'roman-upper', label: 'I, II, III' },
        { value: 'roman-lower', label: 'i, ii, iii' },
        { value: 'letters', label: 'A, B, C' },
        { value: 'padded', label: '01, 02, 03' },
      ], group: 'Format', help: 'Roman and letter styles restart at the first number you set; padded keeps the width you would type by hand.' },
      { key: 'prefix', label: 'Prefix', type: 'text', default: 'Page ', half: true, group: 'Format', help: 'Written before the number, so "Page " turns 3 into "Page 3".' },
      { key: 'suffix', label: 'Suffix', type: 'text', default: ' of {total}', half: true, group: 'Format', help: 'Written after the number. {total} and {page} are replaced.' },
      ...textStyleFields({
        surface: 'page-numbers',
        group: 'Style',
        size: {
          default: 11,
          min: 5,
          max: 72,
          step: 0.5,
          help: 'The size of the drawn number, in points: 12 pt is ordinary body text.',
        },
        color: { default: '#1b1b18', help: 'Applied to the number and to any prefix or suffix around it.' },
      }),
    ],
    notes: [
      'Numbers are drawn into the page, not stored as metadata, so they print and appear in every viewer.',
      'Each page is measured on its own: a mixed-size or rotated document keeps its folios inside the visible edge.',
      'A prefix or suffix written in a non-Latin script needs one font fetched from the CDN — once per script, then your browser caches it. The document itself never leaves this tab.',
    ],
    async run(context) {
      const notes: string[] = [];
      const [input] = await openInputs(context);
      const all = resolvePages(stringValue(context.values, 'pages', 'all'), input.pageCount);
      const startAt = readNumber(context, notes, { key: 'startAt', label: 'First number', fallback: 1, min: 0, max: 100000, integer: true });
      const step = readNumber(context, notes, { key: 'step', label: 'Count every', fallback: 1, min: 1, max: 10, integer: true });
      const skip = bounded(notes, 'Skip first N pages', numberValue(context.values, 'skip', 0), { min: 0, max: all.length, integer: true });
      const style = stringValue(context.values, 'style', 'decimal');
      // Roman and letter folios have no zero. Measured on the shipped build,
      // `First number: 0` stamped "Page 0 of IV" next to "Page I", and the letter
      // run gave two pages the same folio "A". Those two styles floor at 1, in the
      // same admitted-clamp voice every other numeric field uses.
      let firstNumber = startAt;
      if (firstNumber < 1 && (style === 'roman-upper' || style === 'roman-lower')) {
        note(notes, `First number must be 1 or more for roman numerals, which have no zero: ${firstNumber} became 1.`);
        firstNumber = 1;
      } else if (firstNumber < 1 && style === 'letters') {
        note(notes, `First number must be 1 or more for letter folios, which start at A: ${firstNumber} became 1.`);
        firstNumber = 1;
      }
      const size = readNumber(context, notes, { key: 'fontSize', label: 'Font size', fallback: 11, min: 5, max: 72, unit: 'pt' });
      // The family, weight, slant and colour come from the shared model; the size is
      // read through the tool's own clamp so a `fontSize: 0` is still reported
      // before it reaches a writer.
      const textStyle = mergeFaceStyle(readTextStyle(context.values, 'page-numbers'), { size });
      rememberTextStyle('page-numbers', textStyle);
      const margin = readNumber(context, notes, { key: 'margin', label: 'Margin', fallback: 24, min: 0, max: 200, unit: 'pt' });
      const anchor = stringValue(context.values, 'position', 'bottom-center');
      const pages = input.doc.getPages();
      // Numbering restarts at the (style-floored) first number on the first page
      // that is actually numbered, and the step counts from there — previously the
      // step was measured from page 1, so "skip 2, every 2nd" began mid-count and
      // the `First number` the user typed never appeared.
      const targets: { page: number; number: number }[] = [];
      for (let i = skip; i < all.length; i += step) {
        targets.push({ page: all[i], number: firstNumber + targets.length });
      }
      if (targets.length === 0) {
        return admit(
          reportResult(
            [{
              title: 'Nothing was numbered',
              text: skip > 0
                ? `The selection holds ${countLabel(all.length, 'page')} and "skip first ${skip}" covers all of them, so no page was left to stamp.`
                : `The selection holds ${countLabel(all.length, 'page')}, which is not enough to number.`,
            }],
            { message: 'No page was numbered — the file is unchanged.' },
          ),
          notes,
        );
      }
      const total = targets[targets.length - 1].number;
      // Every `{total}`/`{page}` is replaced, not just the first: a suffix of
      // `X{total}/{total}` shipped a literal `{total}` into the page while the
      // result card said the numbers were filled in.
      const pad = Math.max(2, String(total).length);
      for (let i = 0; i < targets.length; i++) {
        const { page, number } = targets[i];
        const text = stringValue(context.values, 'prefix', 'Page ')
          + formatNumber(number, style, pad)
          + stringValue(context.values, 'suffix', ' of {total}')
            .split('{total}').join(formatNumber(total, style, pad))
            .split('{page}').join(formatNumber(number, style, pad));
        await stamp(input.doc, pages[page], text, {
          anchor: anchor as Anchor,
          style: textStyle,
          margin,
          notes,
        });
        context.progress((i + 1) / targets.length, `Numbered page ${page + 1}`);
      }
      return pdfOutput(
        input.doc,
        notes,
        `Numbered ${countLabel(targets.length, 'page')}, ${formatNumber(targets[0].number, style, pad)} to ${formatNumber(total, style, pad)}.`,
      );
    },
  },

  {
    id: 'watermark',
    name: 'Add Watermark',
    description: 'Stamp text or an image across pages with opacity, angle and tiling',
    icon: '💧',
    category: 'edit',
    keywords: ['draft', 'confidential', 'logo', 'stamp overlay'],
    outputSuffix: '_watermarked.pdf',
    actionLabel: 'Add watermark',
    promise: 'A text or image mark drawn into the page, over or behind the existing content, on the pages you select.',
    fields: [
      { key: 'type', label: 'Watermark', group: 'Mark', type: 'segmented', default: 'text', options: [
        { value: 'text', label: 'Text' }, { value: 'image', label: 'Image' },
      ],
        help: 'A text mark is drawn as text; an image mark is embedded and scaled. Both are painted into the page itself.',
      },
      { key: 'text', label: 'Text', type: 'text', default: 'DRAFT', when: (v) => v.type === 'text', group: 'Mark', help: 'Drawn into the page, not stored as a comment, so it prints and cannot be hidden by a reader.' },
      { key: 'image', label: 'Watermark image', type: 'file', accept: 'image/*', when: (v) => v.type === 'image', group: 'Mark', help: 'PNG, JPEG or WebP — converted in this tab, never uploaded.' },
      ...textStyleFields({
        surface: 'watermark',
        group: 'Mark',
        when: (values) => values.type === 'text',
        boldDefault: true,
        size: {
          default: 64,
          min: 6,
          max: 400,
          step: 1,
          help: 'Points, on a page scaled to its own size — a watermark sized for A4 lands differently on a Letter scan.',
        },
        color: { default: '#888888', help: 'Only used for a text mark; an image keeps its own colours.' },
      }),
      { key: 'scale', label: 'Image scale', type: 'slider', default: 0.35, min: 0.02, max: 2, step: 0.01, when: (v) => v.type === 'image', group: 'Mark', help: 'Fraction of each page\'s own width — measured per page, so mixed sizes stay proportional.' },
      { key: 'opacity', label: 'Opacity', type: 'slider', default: 0.25, min: 0.02, max: 1, step: 0.01, group: 'Look', help: 'Low enough that the words underneath stay readable, high enough that the mark survives a printer.' },
      { key: 'rotation', label: 'Angle', type: 'slider', default: 45, min: -180, max: 180, step: 1, unit: '°', group: 'Look', help: 'Measured as the page is displayed, so it is the same angle on a rotated page.' },
      { key: 'layer', label: 'Placement', type: 'segmented', default: 'over', options: [
        { value: 'over', label: 'Over content' }, { value: 'under', label: 'Behind content' },
      ], group: 'Look', help: 'Behind keeps the text on top of the mark; over hides whatever it covers.' },
      { key: 'position', label: 'Position', type: 'select', default: 'center', options: ANCHOR_OPTIONS, when: (v) => v.tile !== true, group: 'Repeat', help: 'Where the single mark sits when it is not tiled.' },
      { key: 'tile', label: 'Repeat as a pattern', type: 'toggle', default: false, group: 'Repeat', help: 'Repeats the mark across the whole page instead of placing one, which is what stops a crop removing the evidence.' },
      { key: 'tileGap', label: 'Pattern spacing', type: 'slider', default: 1.5, min: 0.2, max: 5, step: 0.1, when: (v) => v.tile === true, group: 'Repeat', help: 'As a multiple of the mark’s own size, so a bigger watermark spaces itself further out.' },
      pagesField({ group: 'Repeat' }),
    ],
    notes: [
      'Behind content puts the mark before the page\u2019s own drawing operators, so it sits underneath and the text stays readable on top.',
      'A mark wider than the page is centred and reported rather than clipped silently.',
    ],
    validate: (values) => {
      if (values.type === 'image') {
        const file = values['image'];
        const hasFile = Array.isArray(file) ? file.length > 0 : Boolean(file);
        return hasFile ? null : 'Choose the image to use as a watermark.';
      }
      return stringValue(values, 'text').trim() === ''
        ? 'Enter the watermark text, or switch to an image watermark.'
        : null;
    },
    async run(context) {
      const notes: string[] = [];
      const [input] = await openInputs(context);
      const type = stringValue(context.values, 'type', 'text');
      const pages = resolvePages(stringValue(context.values, 'pages', 'all'), input.pageCount);
      const opacity = readNumber(context, notes, { key: 'opacity', label: 'Opacity', fallback: 0.25, min: 0.02, max: 1 });
      const rotation = readNumber(context, notes, { key: 'rotation', label: 'Angle', fallback: 45, min: -180, max: 180, unit: '°' });
      const tile = booleanValue(context.values, 'tile');
      const gap = readNumber(context, notes, { key: 'tileGap', label: 'Pattern spacing', fallback: 1.5, min: 0.2, max: 5 });
      const anchor = stringValue(context.values, 'position', 'center') as Anchor;
      const behind = stringValue(context.values, 'layer', 'over') === 'under';
      const imageBytes = firstFileBytes(context.values, 'image');

      if (type === 'image' && !imageBytes) {
        throw new Error('Choose the image to use as a watermark.');
      }
      const embedded = type === 'image'
        ? await input.doc.embedPng(await toPng(input.doc, imageBytes!))
        : null;
      const text = stringValue(context.values, 'text', 'DRAFT');
      const size = readNumber(context, notes, { key: 'fontSize', label: 'Font size', fallback: 64, min: 6, max: 400, unit: 'pt' });
      // Family, weight, slant and colour come from the shared model; the size is read
      // through the tool's own clamp so a `fontSize: 0` is still reported before it
      // reaches a writer.
      const style = mergeFaceStyle(readTextStyle(context.values, 'watermark'), { size });
      rememberTextStyle('watermark', style);
      const scale = readNumber(context, notes, { key: 'scale', label: 'Image scale', fallback: 0.35, min: 0.02, max: 2 });
      // A tiled text mark needs the run's own advance and height: the pitch is a
      // multiple of the mark and the grid has to stop where a *whole* mark still fits.
      // This used to be measured only when tiling was off — one `!tile` — so the
      // column pitch fell to the 24 pt floor whatever the size or spacing was, and a
      // 217 pt word at 64 pt repeated every 24 pt. The face is cached, so it is one
      // measurement however many pages the run covers (E7).
      const mark = type === 'image' || !tile
        ? null
        : await measureText(input.doc, {
            text,
            x: 0,
            y: 0,
            size,
            bold: style.bold,
            italic: style.italic,
            fontFamily: style.fontFamily || undefined,
          });
      const markHeight = mark ? Math.max(mark.font.heightAtSize(size), 1) : 0;
      // The draw point is the baseline, so the ink hangs `descent` below the box the
      // footprint measures: both the fit and the draw point have to carry it, or a
      // descender is the part left outside the page.
      const markAscent = mark ? mark.font.heightAtSize(size, { descender: false }) : 0;
      const markDescent = mark ? Math.max(0, markHeight - markAscent) : 0;

      for (let i = 0; i < pages.length; i++) {
        const page = input.doc.getPage(pages[i]);
        const frame = frameOf(page);
        throwIfAborted(context.signal);
        const paint = async (): Promise<void> => {
          if (type === 'image' && embedded) {
            const width = frame.width * scale;
            const height = (embedded.height / Math.max(1, embedded.width)) * width;
            if (tile) {
              // The image is turned about the point it is drawn at, so the pattern is
              // laid out on the *turned* box and each mark is drawn from that box's
              // lower corner: without it a 45° pattern walked up and to the right of
              // its own grid and the last column and row hung off the page.
              const bounds = runBounds(width, height, rotation);
              for (const spot of tilePoints(frame, width * gap, height * gap, bounds, notes)) {
                const origin = toUserSpace(frame, spot.x - bounds.minX, spot.y - bounds.minY);
                page.drawImage(embedded, {
                  x: origin.x,
                  y: origin.y,
                  width,
                  height,
                  opacity,
                  rotate: degrees(rotation + frame.rotation),
                });
              }
            } else {
              const spot = placeRun(frame, width, height, rotation, anchor, 0);
              const origin = toUserSpace(frame, spot.x, spot.y);
              page.drawImage(embedded, {
                x: origin.x,
                y: origin.y,
                width,
                height,
                opacity,
                rotate: degrees(rotation + frame.rotation),
              });
            }
          } else if (tile && mark) {
            const bounds = runBounds(mark.width, markHeight, rotation);
            for (const spot of tilePoints(frame, mark.width * gap, markHeight * gap * 2, bounds, notes)) {
              await stampText(
                page,
                text,
                { x: spot.x - bounds.minX, y: spot.y - bounds.minY + markDescent },
                { style, opacity, rotation },
              );
            }
          } else {
            await stamp(input.doc, page, text, {
              anchor,
              style,
              opacity,
              rotation,
              margin: 0,
              notes,
            });
          }
        };
        if (behind) await drawBehind(page, paint);
        else await paint();
        context.progress((i + 1) / pages.length, `Watermarked page ${pages[i] + 1}`);
      }
      return pdfOutput(
        input.doc,
        notes,
        `Watermarked ${countLabel(pages.length, 'page')}${type === 'image' ? ' with your image' : ''}${behind ? ', behind the page content' : ''}.`,
      );
    },
  },

  {
    id: 'header-footer',
    name: 'Header & Footer',
    description: 'Add text to the top and bottom of every page with a style panel',
    icon: '📝',
    category: 'edit',
    keywords: ['running head', 'footer', 'document title bar'],
    outputSuffix: '_header_footer.pdf',
    actionLabel: 'Add header and footer',
    promise: 'Left, centre and right text at the top and bottom of each selected page, with page numbers and document fields.',
    fields: [
      { key: 'headerLeft', label: 'Header left', type: 'text', group: 'Header', help: 'Tokens such as {page} {total} {title} {author} {date} {file} are filled in per page.' },
      { key: 'headerCenter', label: 'Header centre', type: 'text', default: '{title}', group: 'Header', help: 'Left, centre and right share the same line, so the widest pair decides whether these collide.' },
      { key: 'headerRight', label: 'Header right', type: 'text', default: '{date}', group: 'Header', help: 'Left, centre and right share one line: together they must fit inside the page width.' },
      { key: 'footerLeft', label: 'Footer left', type: 'text', default: '{author}', group: 'Footer', help: 'The bottom-left slot. Anything that must appear on every page belongs here or in the centre.' },
      { key: 'footerCenter', label: 'Footer centre', type: 'text', group: 'Footer', help: 'The bottom-centre slot, which is where a folio usually goes.' },
      { key: 'footerRight', label: 'Footer right', type: 'text', default: 'Page {page} of {total}', group: 'Footer', help: 'The bottom-right slot, measured per page so a mixed-size document keeps it inside the edge.' },
      ...textStyleFields({
        surface: 'header-footer',
        group: 'Type',
        size: {
          default: 9,
          min: 5,
          max: 36,
          step: 0.5,
          help: 'In points. Header and footer text is usually smaller than the body it labels.',
        },
        color: { default: '#55554e', help: 'Applied to the text and to the rule together.' },
      }),
      { key: 'margin', label: 'Margin', type: 'number', default: 28, min: 4, max: 120, step: 1, unit: 'pt', half: true, group: 'Style', help: 'How far inside each page the text sits; its rule follows 4 pt behind. A page too short for both bands gets a smaller margin, and the new one is reported.' },
      {
        key: 'rule',
        label: 'Draw a hairline rule',
        type: 'toggle',
        default: true,
        group: 'Style',
        help: 'A hairline 4 pt below the header ink and 4 pt above the footer ink, drawn to the same side margins.',
      },
      pagesField({ group: 'Style' }),
    ],
    notes: [
      'Tokens: {page} {total} {title} {author} {subject} {date} {file}. They are filled in per page.',
      'Every page is measured on its own, so a mixed-size or rotated document keeps its rules inside the visible area.',
      'A page too short for the margin and a tall font gets a smaller margin, so the bands stay apart instead of printing over each other; the new margin is reported.',
    ],
    validate: (values) =>
      [...HEADER_SLOTS, ...FOOTER_SLOTS].every((key) => stringValue(values, key).trim() === '')
        ? 'Type something for the header or the footer — with all six boxes empty there is nothing to add.'
        : null,
    async run(context) {
      const notes: string[] = [];
      const [input] = await openInputs(context);
      const pages = resolvePages(stringValue(context.values, 'pages', 'all'), input.pageCount);
      const size = readNumber(context, notes, { key: 'fontSize', label: 'Font size', fallback: 9, min: 5, max: 36, unit: 'pt' });
      const style = mergeFaceStyle(readTextStyle(context.values, 'header-footer'), { size });
      rememberTextStyle('header-footer', style);
      const margin = readNumber(context, notes, { key: 'margin', label: 'Margin', fallback: 28, min: 4, max: 120, unit: 'pt' });
      const color = style.color;
      const rule = booleanValue(context.values, 'rule', true);
      const meta = {
        title: input.doc.getTitle() ?? input.name,
        author: input.doc.getAuthor() ?? '',
        subject: input.doc.getSubject() ?? '',
        date: new Date().toLocaleDateString(),
        total: String(input.pageCount),
        file: input.name,
      };
      const rows = [
        { label: 'header', keys: HEADER_SLOTS, anchors: ['top-left', 'top-center', 'top-right'] as Anchor[], above: true },
        { label: 'footer', keys: FOOTER_SLOTS, anchors: ['bottom-left', 'bottom-center', 'bottom-right'] as Anchor[], above: false },
      ];
      // A band's height is its tallest run's line height, and a header hangs its ink
      // *down* from the top margin while a footer hangs it *up* from the bottom one.
      // Measured on a 400×260 sheet at 36 pt with the 120 pt margin: `placeRun`
      // halved the margin for each band on its own (they get 108.5 pt of a 260 pt
      // page) and the two printed straight over each other — header ink 110.4–159.8
      // from the top, footer 108.5–151.5 — with nothing said. They now share one
      // margin calculated from both heights, and the rule hangs off the ink box.
      const bandGap = 4;
      for (let i = 0; i < pages.length; i++) {
        throwIfAborted(context.signal);
        const page = input.doc.getPage(pages[i]);
        const frame = frameOf(page);
        const values = { ...meta, page: String(pages[i] + 1) };
        const texts = rows.map((row) => row.keys.map((key) => expand(stringValue(context.values, key), values).trim()));
        const measured = await Promise.all(texts.map((slots) => Promise.all(slots.map((text) => (text
          ? measureText(input.doc, {
              text,
              x: 0,
              y: 0,
              size,
              bold: style.bold,
              italic: style.italic,
              fontFamily: style.fontFamily || undefined,
            })
          : null)))));
        const bandHeights = measured.map((slots) => Math.max(0, ...slots.map((m) => (m ? m.font.heightAtSize(size) : 0))));
        let bandMargin = margin;
        // Two hairline rules also live in the gap, 4 pt clear of each band: a
        // margin worked out without them put the header's rule through the
        // footer's ascenders on a 400×260 sheet (measured: rule at 127.4 and
        // 132.6 from the top, each inside the other band's ink box).
        const ruleReserve = rule ? 2 * 4 : 0;
        const needed = bandHeights[0]! + bandHeights[1]! + ruleReserve + bandGap + margin * 2;
        if (needed > frame.height) {
          // Clamped, and the new margin named: the alternative was two bands on the
          // same paper, which is what the unadmitted sentence let happen.
          bandMargin = Math.max(0, (frame.height - bandHeights[0]! - bandHeights[1]! - ruleReserve - bandGap) / 2);
          note(notes, `A ${Math.round(frame.height)} pt page cannot hold a ${Math.round(bandHeights[0]!)} pt header and a ${Math.round(bandHeights[1]!)} pt footer ${margin} pt from both edges, so the margin becomes ${Math.round(bandMargin)} pt.`);
        }
        for (let r = 0; r < rows.length; r++) {
          if (bandHeights[r]! > bandMargin + 0.5) {
            note(notes, `The ${rows[r]!.label} text is ${Math.round(bandHeights[r]!)} pt tall, taller than the ${Math.round(bandMargin)} pt margin, so it reaches that far into the page.`);
          }
        }
        for (let r = 0; r < rows.length; r++) {
          const row = rows[r]!;
          const widths = measured[r]!.map((m) => m?.width ?? 0);
          const used = widths.reduce((sum, width) => sum + width, 0);
          if (texts[r]!.filter(Boolean).length > 1 && used + bandMargin * 2 > frame.width) {
            note(notes, `The ${row.label} text is wider than a ${Math.round(frame.width)} pt page, so its left, centre and right parts overlap.`);
          }
          let inkBottom = Number.POSITIVE_INFINITY;
          let inkTop = Number.NEGATIVE_INFINITY;
          for (let s = 0; s < row.anchors.length; s++) {
            if (!texts[r]![s]) continue;
            const box = await stamp(input.doc, page, texts[r]![s]!, {
              anchor: row.anchors[s]!,
              style,
              margin: bandMargin,
              notes,
            });
            inkBottom = Math.min(inkBottom, box.inkBottom);
            inkTop = Math.max(inkTop, box.inkTop);
          }
          if (rule && Number.isFinite(inkBottom)) {
            // The rule is drawn where the reader sees it, then turned with the
            // page: on a /Rotate 90 sheet a page-space horizontal line runs off
            // the side of the paper.
            //
            // Four points clear of the *ink*, not of the em box: `margin + size +
            // 4` measured 44 pt from the top under a 36 pt header whose descenders
            // reach 47, so the hairline crossed every `g` and `y` at a margin of 4.
            const edge = row.above ? inkBottom - 4 : inkTop + 4;
            const y = Math.min(Math.max(edge, 0.5), frame.height - 0.5);
            const { strokeLine } = await import('../core/content');
            const start = toUserSpace(frame, bandMargin, y);
            const end = toUserSpace(frame, Math.max(bandMargin, frame.width - bandMargin), y);
            strokeLine(page, start, end, { thickness: 0.5, color });
          }
        }
        context.progress((i + 1) / pages.length, `Page ${pages[i] + 1}`);
      }
      return pdfOutput(input.doc, notes, `Added headers and footers to ${countLabel(pages.length, 'page')}.`);
    },
  },

  {
    id: 'bates-numbering',
    name: 'Bates Numbering',
    description: 'Add sequential legal Bates numbers across one or more files',
    icon: '⚖️',
    category: 'edit',
    keywords: ['legal', 'discovery', 'production', 'sequential numbering'],
    multiFile: true,
    outputSuffix: '_bates.pdf',
    actionLabel: 'Number the files',
    promise: 'A sequential, zero-padded production number stamped on every page of every file, continuing across files or restarting in each one.',
    notes: [
      'Bates numbering is permanent: the number is drawn into the page, and a second run over an already-stamped file prints the new number on top of the old one in the same place — only a digit that differs stays legible.',
      'One number is consumed per page across the whole batch, which is what a discovery production expects.',
    ],
    fields: [
      { key: 'format', label: 'Number format', type: 'text', default: '{prefix}-{n}', help: 'Tokens: {n} {page} {total} {prefix} {date} {time}. {page} and {total} share the numbering scope — the whole batch, or the file when restarting — so {n}/{total} reads 7/9 of a nine-page production, never 7/5.', group: 'Number' },
      { key: 'prefix', label: 'Prefix', type: 'text', default: 'DOC', half: true, group: 'Number', help: 'Substituted into {prefix} in the format above, so the pattern decides whether it appears.' },
      { key: 'digits', label: 'Number width', type: 'number', default: 6, min: 1, max: 12, step: 1, integer: true, half: true, group: 'Number', help: 'Shorter than the highest number you will reach and the sequence silently grows a column; longer pads every sheet.' },
      { key: 'start', label: 'Start at', type: 'number', default: 1, min: 0, max: 1000000, step: 1, integer: true, half: true, group: 'Number', help: 'Where the first page of the first file is numbered from — continue an existing production rather than restart it.' },
      { key: 'perFile', label: 'Restart numbering for each file', type: 'toggle', default: false, group: 'Number', help: 'Off runs one sequence across the whole batch, which is what a production set expects; on restarts at the start value inside every file.' },
      { key: 'position', label: 'Position', type: 'select', default: 'bottom-right', options: ANCHOR_OPTIONS, group: 'Marking', help: 'Where on each page the number is drawn. Discovery productions conventionally use bottom-right.' },
      ...textStyleFields({
        surface: 'bates-numbering',
        group: 'Marking',
        family: false,
        size: {
          default: 9,
          min: 5,
          max: 36,
          step: 0.5,
          help: 'Small enough not to cover anything, large enough to read off a photocopy.',
        },
        color: { default: '#000000', help: 'Black is the convention; anything else risks disappearing on a photocopier.' },
      }),
      { key: 'margin', label: 'Margin', type: 'number', default: 18, min: 0, max: 120, step: 1, unit: 'pt', half: true, group: 'Marking', help: 'Distance from the chosen corner of each page, measured per page.' },
    ],
    async run(context) {
      const notes: string[] = [];
      const inputs = await openInputs(context);
      const digits = readNumber(context, notes, { key: 'digits', label: 'Number width', fallback: 6, min: 1, max: 12, integer: true });
      const start = readNumber(context, notes, { key: 'start', label: 'Start at', fallback: 1, min: 0, max: 1000000, integer: true });
      const perFile = booleanValue(context.values, 'perFile');
      const format = stringValue(context.values, 'format', '{prefix}-{n}');
      const prefix = stringValue(context.values, 'prefix', 'DOC');
      // The size is read through the tool's own clamp so an out-of-range value is
      // still admitted before it reaches a writer.
      const batesSize = readNumber(context, notes, { key: 'fontSize', label: 'Font size', fallback: 9, min: 5, max: 36, unit: 'pt' });
      const batesStyle = mergeFaceStyle(readTextStyle(context.values, 'bates-numbering'), { size: batesSize });
      rememberTextStyle('bates-numbering', batesStyle);
      let counter = start;
      let stamped = 0;
      // The literal last number painted, so the admission cannot disagree with
      // the file: with "restart in every file" the batch total is not the last
      // number anything carries.
      let lastNumber = '';
      const total = inputs.reduce((sum, input) => sum + input.pageCount, 0);
      noteUnknownTokens(format, notes);
      const seen = new Set<string>();
      for (const input of inputs) {
        // E16: the same document added twice is two productions here, and the
        // output names collide, so say which copy is which.
        if (seen.has(input.name)) {
          note(notes, `Two documents are named "${input.name}"; both were stamped, and both downloads carry the same name.`);
        }
        seen.add(input.name);
        for (let index = 0; index < input.pageCount; index++) {
          throwIfAborted(context.signal);
          const number = String(counter).padStart(digits, '0');
          lastNumber = number;
          const text = expand(format, {
            n: number,
            // Both page tokens answer to the same scope as `{n}`: over one batch
            // sequence a per-file total wrote `005/5 … 009/5` — nine numbers over
            // a total of five — where `{page}` beside it was still the file's own
            // position, so the two disagreed. `stamped` is the pages already drawn
            // in this batch, so it is this page's position in the scope.
            page: String(perFile ? index + 1 : stamped + 1),
            total: String(perFile ? input.pageCount : total),
            prefix,
            date: new Date().toISOString().slice(0, 10),
            time: new Date().toTimeString().slice(0, 8),
          });
          await stamp(input.doc, input.doc.getPage(index), text, {
            anchor: stringValue(context.values, 'position', 'bottom-right') as Anchor,
            style: batesStyle,
            margin: readNumber(context, notes, { key: 'margin', label: 'Margin', fallback: 18, min: 0, max: 120, unit: 'pt' }),
            notes,
          });
          counter += 1;
          stamped += 1;
          context.progress(stamped / (total || 1), `Stamped page ${index + 1} of ${input.name}`);
        }
        if (perFile) counter = start;
      }
      if (stamped > 0 && stamped < 10) {
        note(notes, `The last number written was ${lastNumber}.`);
      }
      const files = [];
      const written: string[] = [];
      for (const input of inputs) {
        const bytes = await savePDF(input.doc);
        const name = `${downloadStem(input.name)}_bates.pdf`;
        files.push({
          blob: new Blob([bytes as BlobPart], { type: 'application/pdf' }),
          name,
        });
        written.push(`${name} ${countLabel(input.doc.getPageCount(), 'page')}`);
      }
      const result: ToolResult = {
        kind: 'files',
        files,
        // One output per input, in the same order, so the first document's page
        // count describes the file the card calls primary. That is what
        // `RunOutcome.pagesOut` means for a multi-file run (pinned by
        // `tests/pdf/pages-out.test.ts`), and it is why the sentence names every
        // file's own count: a row reading `9 → 4` beside "9 numbers" otherwise
        // looks like five pages went missing.
        pages: inputs[0].doc.getPageCount(),
        message: `Applied ${countLabel(stamped, 'Bates number')} across ${countLabel(inputs.length, 'file')}`
          + `${inputs.length > 1 ? ` (${written.join(', ')})` : ''}`
          + `${perFile ? ', restarting at each file' : ''}.`,
      };
      return admit(result, notes);
    },
  },

  {
    id: 'add-page-labels',
    name: 'Add Page Labels',
    description: 'Number pages as i, ii … 1, 2, 3 with prefixes and custom starts',
    icon: '🔠',
    category: 'edit',
    keywords: ['roman numerals', 'front matter', 'label ranges'],
    outputSuffix: '_labelled.pdf',
    actionLabel: 'Apply labels',
    promise: 'A /PageLabels dictionary, so the page number in the reader\u2019s toolbar reads i, ii, 1, 2 \u2014 nothing is drawn on the page.',
    fields: [
      {
        key: 'ranges',
        label: 'Label ranges',
        group: 'Labels',
        type: 'textarea',
        default: '1-3 roman 1\n4-99 decimal 1',
        help: 'One per line: start-end style [startNumber] [prefix]. Styles: decimal, roman, Roman, alpha, Alpha, none. A range runs until the next line starts.',
      },
    ],
    notes: [
      'PDF page labels are start-based: a line takes effect on its first page and lasts until the next line or the end of the document.',
      // Measured on the produced file: an existing store is deleted rather than
      // merged with, so a second range line never adds to what the document held.
      'The page labels the document already has are replaced, not merged into.',
      // `/St 0` is written as asked. There is no roman or letter zero, and the readers
      // disagree about what stands in for it (an empty label under both for roman;
      // `z` under MuPDF and `1` under pypdf for a lettered range), so the card previews
      // the 0 it stored rather than pretending to one reader's answer.
      'A start of 0 is kept as the first number of its range: a decimal reader shows 0, 1, 2. The roman and letter styles have no zero — a reader shows an empty label there (MuPDF shows `z` for a lettered range), while this card previews 0.',
      'Labels change what the reader shows, not what is printed on the sheet. Use Page Numbers to stamp visible folios.',
    ],
    async run(context) {
      const notes: string[] = [];
      const [input] = await openInputs(context);
      const parsed = parseLabelRanges(stringValue(context.values, 'ranges'), input.pageCount, notes);
      if (parsed.length === 0) {
        throw new Error(`No usable label range. ${notes[0] ?? 'Enter at least one line such as "1-3 roman 1".'}`);
      }
      // Sheets above the lowest range's start belong to no range at all. §12.4.2 then
      // leaves the reader to number by position, which pypdf answers with an empty
      // label and MuPDF 1.28.2 with an IndexError (`docs/research/page-labels-round.md`)
      // — while this tool's own report already claims `1`. Writing that position out as
      // a decimal range is the same numbering the format defaults to, said in the file.
      const lead: LabelRange[] = parsed[0].start > 0
        ? [{
          start: 0,
          end: parsed[0].start - 1,
          askedEnd: parsed[0].start,
          style: 'D',
          firstPageNumber: 1,
        }]
        : [];
      if (lead.length > 0) {
        // "Pages 1-1" reads like a range that was asked for; one sheet is a page.
        const leadCount = parsed[0].start;
        note(notes, leadCount === 1
          ? 'Page 1 comes before the first range, so it keeps its plain number 1.'
          : `Pages 1-${leadCount} come before the first range, so they keep the plain numbers 1-${leadCount}.`);
      }
      // Read before the write: `addPageLabels` deletes the store, so the count of what
      // was there is only available now, and the card is the one place it is said.
      const replaced = readPageLabelRanges(input.doc).length;
      addPageLabels(input.doc, [...lead, ...parsed]);
      const labels = readPageLabels(input.doc);
      const shown = Math.min(labels.length, 12);
      return pdfOutput(
        input.doc,
        notes,
        `Applied ${countLabel(parsed.length, 'label range')}. The first ${countLabel(shown, 'page')} now read: ${labels.slice(0, shown).map((l) => l.label).join(', ')}${labels.length > shown ? ', \u2026' : ''}.`
          + (replaced > 0 ? ` Replaced the ${countLabel(replaced, 'label range')} it already had.` : ''),
      );
    },
  },

  {
    id: 'bookmarks',
    name: 'Edit Bookmarks',
    description: 'View, replace, import and export the document outline',
    icon: '🔖',
    category: 'edit',
    keywords: ['outline', 'toc structure', 'navigate'],
    outputSuffix: '_bookmarks.pdf',
    surface: 'none',
    actionLabel: 'Save bookmarks',
    promise: 'The outline as text you can read, edit and paste back — leaving the box empty just shows you what is there.',
    fields: [
      {
        key: 'outline',
        label: 'Outline',
        group: 'Outline',
        type: 'textarea',
        default: '',
        rows: 12,
        help: 'One entry per line, indent with spaces or a tab for children: "Chapter 1" or "  Section 1.1", optionally "Title :: 4" for page 4. The last "::" on a line is the page, so a title may contain one.',
      },
      { key: 'replace', label: 'Replace the existing outline', type: 'toggle', default: true, group: 'Outline', help: 'Off keeps the outline that exists and appends below it; on replaces the whole outline with what is in the box.' },
    ],
    notes: [
      'Page numbers are 1-based positions in the document as it stands now, before the new outline is written.',
      // Measured against the produced bytes: appending keeps every existing entry,
      // its title, its depth and its target, but the outline model has no notion of
      // a collapsed group, so a `/Count -1` branch is rewritten open
      // (`docs/research/bookmarks-round.md`).
      'Appending keeps the bookmarks that are already there. A collapsed group among them comes back expanded.',
    ],
    async run(context) {
      const notes: string[] = [];
      const [input] = await openInputs(context);
      const raw = stringValue(context.values, 'outline');
      if (!raw.trim()) {
        const existing = readOutline(input.doc);
        if (existing.length === 0) {
          return reportResult([{ title: 'Bookmarks', text: 'This document has no outline. Add entries above and run again.' }], {
            message: 'No bookmarks found — nothing was changed.',
          });
        }
        const size = countOutline(existing);
        return reportResult([{ title: 'Current outline', text: outlineToText(existing) }], {
          // The two figures beside the total are counts of a *position*, not of a
          // noun: `countLabel` pluralises what it is given, so this used to print
          // "3 bookmarks (2 at the top levels)" and "5 without a pages" — measured
          // live on a nested outline with headings that carry no target.
          message: `${countLabel(size.total, 'bookmark')} (${existing.length} at the top level${size.targetless > 0 ? `, ${size.targetless} without a page` : ''}). Copy the text, edit it, and run again to replace them.`,
        });
      }
      const nodes = textToOutline(raw, input.pageCount, notes);
      if (countOutline(nodes).total === 0) {
        throw new Error(`No bookmark could be read from that text. ${notes[0] ?? 'Use one entry per line, "Title :: page".'}`.trim());
      }
      const replace = booleanValue(context.values, 'replace', true);
      const current = readOutline(input.doc);
      // Counted the same way in both modes: the whole tree, not just its top
      // level, so "after the 2 existing outline" cannot describe 2 of 9 entries.
      const before = countOutline(current).total;
      writeOutline(input.doc, replace ? nodes : [...current, ...nodes]);
      const written = countOutline(nodes);
      return pdfOutput(
        input.doc,
        notes,
        replace
          ? `Wrote ${countLabel(written.total, 'bookmark')} (${countLabel(nodes.length, 'top-level one', 'top-level ones')})${before > 0 ? `, replacing the ${countLabel(before, 'bookmark')} already in the document` : ''}.`
          // "after the 3 existing" had no noun and read "3 existings"; over a
          // document with no outline it said "the 0 existings outline".
          : `Added ${countLabel(written.total, 'bookmark')} after ${before > 0 ? `the ${countLabel(before, 'bookmark')} already in the document` : 'an empty outline'}.`,
      );
    },
  },

  {
    id: 'table-of-contents',
    name: 'Table of Contents',
    description: 'Generate a clickable contents page from the document outline',
    icon: '📚',
    category: 'edit',
    keywords: ['toc', 'index page', 'contents'],
    outputSuffix: '_toc.pdf',
    actionLabel: 'Insert contents',
    promise: 'A real contents page — drawn text with clickable links to the outline it reads.',
    fields: [
      { key: 'title', label: 'Heading', type: 'text', default: 'Contents', half: true, group: 'Contents page', help: 'Drawn as the heading above the list on the inserted page.' },
      { key: 'insertAt', label: 'Insert at page', type: 'number', default: 1, min: 1, max: 5000, step: 1, integer: true, half: true, group: 'Contents page', help: 'Clamped into this document, so a page past the end lands at the back.' },
      { key: 'leader', label: 'Leader', type: 'segmented', default: 'dots', options: [
        { value: 'dots', label: 'Dots' }, { value: 'none', label: 'None' },
      ], group: 'Contents page', help: 'Dots connect an entry to its page number when the two are far apart.' },
      { key: 'fontSize', label: 'Font size', type: 'number', default: 11, min: 7, max: 24, step: 0.5, unit: 'pt', half: true, group: 'Style', help: 'Applies to the entries; the heading is drawn a little larger than this.' },
      { key: 'showPageNumbers', label: 'Show page numbers', type: 'toggle', default: true, group: 'Style', help: 'Off lists the contents without page numbers, which is only useful for a short document.' },
    ],
    notes: [
      'The list comes from the document outline, so a PDF with no bookmarks has nothing to list.',
      'Entries are numbered against the finished document, including the contents pages just inserted.',
    ],
    async run(context) {
      const notes: string[] = [];
      const [input] = await openInputs(context);
      const outline = readOutline(input.doc);
      if (outline.length === 0) {
        throw new Error('This PDF has no bookmarks to build a table of contents from. Add them with Edit Bookmarks first.');
      }
      const size = countOutline(outline);
      if (size.targetless > 0) {
        // The verb has to follow the count: measured on the card, a five-entry
        // outline with two targetless headings read "2 entries has no page target,
        // so it is listed without a number."
        note(notes, `${countLabel(size.targetless, 'entry', 'entries')} ${size.targetless === 1
          ? 'has no page target, so it is listed'
          : 'have no page target, so they are listed'} without a number.`);
      }
      const insertAt = bounded(notes, 'Insert at page', numberValue(context.values, 'insertAt', 1), { min: 1, max: input.pageCount, integer: true });
      const fontSize = readNumber(context, notes, { key: 'fontSize', label: 'Font size', fallback: 11, min: 7, max: 24, unit: 'pt' });
      const { generateTocPage, tocRowsPerSheet } = await import('../core/bookmarks');
      const title = stringValue(context.values, 'title', 'Contents');
      // The seam lays the sheet out on the *template* page's own crop box, and a sheet
      // too short to hold a heading and one row even under the proportional band clamp
      // (measured: the 336 × 71.4 pt strip reached by inserting at page 8 of a mixed-size
      // file) used to draw every entry below the paper — 4 sheets, 0 rows on paper, ink
      // 190 px each — while the card counted them. The seam now keeps the heading on a
      // sheet of its own and draws each entry on a following sheet, never dropping one;
      // the card says which shape it produced, naming the dimensions and the remedy.
      const sheet = cropBox(input.doc.getPage(Math.min(insertAt - 1, Math.max(0, input.pageCount - 1))));
      const rowsPerSheet = tocRowsPerSheet(sheet.width, sheet.height, fontSize, title !== '');
      if (rowsPerSheet < 1) {
        note(notes, `The contents sheet comes out ${Math.round(sheet.width)} × ${Math.round(sheet.height)} pt from the page you insert at, which holds a heading and no entry at ${fontSize} pt, so the heading keeps a sheet to itself and each of the ${countLabel(size.total, 'entry', 'entries')} is drawn on the sheet after it. Insert at a taller page, or lower Font size, to get rows back onto one sheet.`);
      }
      const pages = await generateTocPage(input.doc, {
        nodes: outline,
        title,
        fontSize,
        leader: stringValue(context.values, 'leader', 'dots') === 'dots' ? 'dots' : 'none',
        // The toggle was wired to `rightAlignPageNumbers`, so switching page numbers
        // *off* still printed every folio and only moved the alignment (seam 9d09566
        // added the real `showPageNumbers`, which suppresses the folio and its leader
        // dots while leaving the /Link). Alignment stays the seam's own default.
        showPageNumbers: booleanValue(context.values, 'showPageNumbers', true),
        startPage: insertAt - 1,
      });
      return pdfOutput(
        input.doc,
        notes,
        `Inserted a ${countLabel(pages.length, 'page')} table of contents at page ${insertAt}, listing ${countLabel(size.total, 'entry', 'entries')} from the outline.`,
      );
    },
  },

  {
    id: 'add-stamps',
    name: 'Add Stamps',
    description: 'Place image or standard stamps on chosen pages',
    icon: '📌',
    category: 'edit',
    keywords: ['approved', 'signed seal', 'logo stamp', 'date stamp'],
    surface: 'surface',
    outputSuffix: '_stamped.pdf',
    actionLabel: 'Place stamps',
    promise: 'A standard or image stamp as a real PDF annotation, one per page you click or per page you list.',
    fields: [
      // The same list the surface's picker maps (editor `tools.ts`), so the two
      // surfaces cannot drift again (the legacy spellings below are accepted, labelled,
      // and fold onto the same name): this copy used to offer nine spellings of the
      // Table 265 names plus two names the table does not contain, while the surface
      // offered twelve the table does. See `BUILT_IN_STAMPS`.
      { key: 'stamp', label: 'Stamp', group: 'Stamp', type: 'select', default: 'Approved', options: [
        ...BUILT_IN_STAMPS,
        // Accepted, not chosen: a value saved before the lists were joined must still run.
        ...LEGACY_STAMP_SPELLINGS,
        { value: 'custom', label: 'Custom image…' },
      ], help: 'The standard names come from PDF\u2019s own stamp table, so other readers can draw their own picture of the mark. Rows marked \u201cno standard name\u201d are not in that table: they travel as the words drawn here.' },
      { key: 'image', label: 'Stamp image', type: 'file', accept: 'image/*', when: (v) => v.stamp === 'custom', group: 'Stamp', help: 'Used when the stamp above is set to Custom image. Kept as an annotation, so it can still be moved later.' },
      { key: 'position', label: 'Position', type: 'select', default: 'top-right', options: ANCHOR_OPTIONS, group: 'Mark', help: 'The corner of each page as it is displayed, so a rotated page stamps where you can see it.' },
      { key: 'width', label: 'Width', type: 'number', default: 140, min: 20, max: 600, step: 1, unit: 'pt', half: true, group: 'Mark', help: 'The stamp is scaled to this width and keeps its own proportion. On a rotated page it is measured against the page as displayed.' },
      { key: 'opacity', label: 'Opacity', type: 'slider', default: 1, min: 0.1, max: 1, step: 0.05, half: true, group: 'Mark', help: 'Below 1 the page shows through, which is what you want over a signature.' },
      ...textStyleFields({
        surface: 'add-stamps',
        group: 'Stamp',
        when: (values) => values.stamp !== 'custom',
        boldDefault: true,
        size: {
          default: 22,
          min: 6,
          max: 72,
          step: 1,
          half: true,
          help: 'The label is drawn this size and shrunk to fit the stamp box if it will not go — the same answer the preview shows.',
        },
        color: {
          default: '#dc2626',
          help: 'The stamp’s text colour, for the standard stamps. A custom image keeps its own colours.',
        },
      }),
      { key: 'regions', label: 'Placements', type: 'text', default: '', help: 'Filled in by clicking the page. Format page:x,y,w,h.', group: 'Placement' },
      pagesField({ default: '1', group: 'Placement' }),
    ],
    notes: [
      'Standard stamps are written as PDF Stamp annotations, so other readers show, move and delete them.',
      'A stamp placed on a rotated page sits in the corner you see and its label is drawn upright on that page, not turned with it.',
    ],
    async run(context) {
      const notes: string[] = [];
      const [input] = await openInputs(context);
      const { addAnnotations, stampLabel } = await import('../core/annotations');
      const name = stringValue(context.values, 'stamp', 'Approved');
      const custom = name === 'custom' ? firstFileBytes(context.values, 'image') : null;
      if (name === 'custom' && !custom) throw new Error('Choose the image to stamp.');
      const pages = resolvePages(stringValue(context.values, 'pages', '1'), input.pageCount);
      const width = readNumber(context, notes, { key: 'width', label: 'Stamp width', fallback: 140, min: 20, max: 600, unit: 'pt' });
      const embedded = custom ? await input.doc.embedPng(await toPng(input.doc, custom)) : null;
      // Keep the picture's own proportions: the appearance is stretched to the rect.
      const aspect = embedded ? embedded.height / Math.max(1, embedded.width) : 0.42;
      const explicit = parseRegions(context.values['regions'], input.doc, notes);
      const targets = explicit.length > 0
        ? explicit
        : pages.map((page) => ({ page, ...anchorRect(input.doc.getPage(page), stringValue(context.values, 'position', 'top-right') as Anchor, width, aspect, notes) }));
      if (targets.length === 0) {
        throw new Error(`No stamp could be placed. ${notes[0] ?? 'The page selection matched no page of this document.'}`);
      }
      if (targets.some((region) => frameOf(input.doc.getPage(region.page)).rotation !== 0)) {
        // Measured on the bytes and the bitmap: the appearance carries the counter
        // rotation (`cm 0 1 -1 0` on a quarter-turned sheet) and the stored rect is
        // the transposed box, so the mark renders 140 pt wide and reads across the
        // sheet as it is displayed. The sentence used to claim the opposite — "the
        // label follows the page orientation" — which contradicted both the standing
        // note on this card and the file itself.
        note(notes, 'Some stamps landed on rotated pages: they sit in the corner as you see it, and the label is turned back so it reads across that sheet rather than running down its edge.');
      }
      // The label is type, so it takes the shared style model. A family past the
      // three named ones has its face embedded here — `addAnnotations` is
      // synchronous, so it cannot fetch one itself — and the appearance stream writes
      // exactly that face rather than falling back to Helvetica quietly.
      const labelStyle = mergeFaceStyle(readTextStyle(context.values, 'add-stamps'), {
        size: readNumber(context, notes, { key: 'fontSize', label: 'Font size', fallback: 22, min: 6, max: 72, unit: 'pt' }),
      });
      rememberTextStyle('add-stamps', labelStyle);
      const labelFace = embedded ? null : await stampLabelFace(input.doc, labelStyle, name, notes);
      addAnnotations(
        input.doc,
        targets.map((region) => ({
          kind: 'Stamp' as const,
          page: region.page,
          rect: { x: region.x, y: region.y, width: region.width, height: region.height },
          stampName: embedded ? undefined : name,
          // The embedded picture, not the bytes: `embedPng` already dealt with an
          // alpha channel (which a stamp appearance cannot carry inline), and the
          // appearance draws the very image that was measured for the rect.
          stampXObject: embedded
            ? { ref: embedded.ref, width: embedded.width, height: embedded.height }
            : undefined,
          opacity: readNumber(context, notes, { key: 'opacity', label: 'Opacity', fallback: 1, min: 0.1, max: 1 }),
          color: labelStyle.color,
          // A labelled stamp is type set into a box, so it carries the model and the
          // face the model answered with.
          textStyle: embedded ? undefined : { style: labelStyle, ...(labelFace ? { font: labelFace } : {}) },
          // The words the mark draws, so a `/Contents` search finds "Not approved"
          // rather than `NotApproved` and a reader's tooltip says the same.
          contents: stampLabel(name),
        })),
      );
      return pdfOutput(
        input.doc,
        notes,
        `Placed ${countLabel(targets.length, 'stamp')} on ${countLabel(new Set(targets.map((region) => region.page)).size, 'page')}.`,
      );
    },
  },

  {
    id: 'background-color',
    name: 'Background Colour',
    description: 'Paint a colour wash behind the content of the pages you choose',
    icon: '🎨',
    category: 'edit',
    keywords: ['page colour', 'behind content', 'tint', 'reading tint'],
    outputSuffix: '_background.pdf',
    actionLabel: 'Paint background',
    promise: 'A flat colour laid under each selected page, tagged as a background artifact so text extraction ignores it; below full opacity it is a wash.',
    validate: (values) => (/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(values.color ?? '').trim())
      ? null
      : `Enter a colour as three or six hex digits in Colour, such as #f7f7f4.`),
    fields: [
      { key: 'color', label: 'Colour', type: 'color', default: '#f7f7f4', group: 'Paint', help: 'A flat fill behind the page content. Text stays selectable and extraction ignores the rectangle.' },
      { key: 'opacity', label: 'Opacity', type: 'slider', default: 1, min: 0.05, max: 1, step: 0.05, group: 'Paint', help: 'Below 1 the fill is a wash over the paper rather than a repaint: the page\u2019s own black and white still reads through it.' },
      pagesField({ group: 'Pages' }),
    ],
    notes: [
      'Flat colour only. For an image behind the page use Add Watermark with Placement: Behind content.',
      'Below 1 the fill is a wash the paper shows through; at 1 it repaints the bare paper it covers. It lands behind the page\u2019s own content, so a page that paints its own paper \u2014 a white background rectangle, a scanned sheet \u2014 keeps showing that paint.',
      'The rectangle covers each page\u2019s own crop box, so mixed sizes stay covered edge to edge.',
      'A page that declares an empty /CropBox is left unpainted and named: painting its media box would cover an area the file says is not there.',
    ],
    async run(context) {
      const notes: string[] = [];
      const [input] = await openInputs(context);
      const { prependBackground, pageContentStreams, setContentStreams } = await import('../core/content');
      const pages = resolvePages(stringValue(context.values, 'pages', 'all'), input.pageCount);
      const color = stringValue(context.values, 'color', '#f7f7f4');
      const opacity = readNumber(context, notes, { key: 'opacity', label: 'Opacity', fallback: 1, min: 0.05, max: 1 });
      let painted = 0;
      for (let i = 0; i < pages.length; i++) {
        throwIfAborted(context.signal);
        const page = input.doc.getPage(pages[i]);
        const box = cropBox(page);
        // A page may declare `/CropBox []` — an empty array is a box that exists
        // and covers nothing, and `cropBox` falls back to the MediaBox for it.
        // Painting there would cover a page whose producer said it has no visible
        // area, so the page is left alone and named.
        if (box.width <= 0 || box.height <= 0 || declaredCropBoxIsEmpty(page)) {
          note(notes, `Page ${pages[i] + 1} has an empty crop box, so it was left unpainted.`);
          continue;
        }
        // The wash a person chose last is the wash a reader paints: the artifact is
        // prepended, so a second run used to bury its own colour behind the first one's
        // (measured: red then blue → paper 78.2 % red, 0.0 % blue, card naming blue).
        // Insert the new stream after the background artifacts the page already leads
        // with, which keeps every wash under the page's own drawing operators.
        const leading = leadingBackgroundArtifacts(pageContentStreams(page));
        prependBackground(page, { x: box.x, y: box.y, width: box.width, height: box.height }, color, { opacity });
        if (leading > 0) {
          const [newest, ...rest] = pageContentStreams(page).map((stream) => stream.ref);
          setContentStreams(page, [...rest.slice(0, leading), newest, ...rest.slice(leading)]);
        }
        painted += 1;
        context.progress((i + 1) / pages.length, `Page ${pages[i] + 1}`);
      }
      const skipped = pages.length - painted;
      return pdfOutput(
        input.doc,
        notes,
        `Painted a ${color} background${opacity < 1 ? ` at ${Math.round(opacity * 100)} % opacity` : ''} behind ${countLabel(painted, 'page')}`
          + `${skipped > 0 ? `, not ${countLabel(skipped, 'page')} of the ${countLabel(pages.length, 'page')} selected` : ''}.`,
      );
    },
  },

  {
    id: 'text-color',
    name: 'Change Text Colour',
    description: 'Recolour the text that is already in the document',
    icon: '🖌️',
    category: 'edit',
    keywords: ['recolour', 'black text', 'colour swap'],
    outputSuffix: '_recoloured.pdf',
    actionLabel: 'Recolour text',
    promise: 'The colour in force at each run of existing text is rewritten in front of it — no page is rasterised, so the text stays selectable.',
    // The hex box is free text, and `parseHexColor` answered a bad one only after the
    // click, in a thrown sentence that named the field key ("for to."). The page picker
    // already refuses before the click, so the colour does too, in the printed words.
    validate: (values) => (/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(values.to ?? '').trim())
      ? null
      : `Enter a colour as three or six hex digits in New colour, such as #ff8800.`),
    fields: [
      { key: 'to', label: 'New colour', type: 'color', default: '#000000', group: 'Recolour', help: 'Every matching text run is repainted this colour, including runs in headers and footers. Text drawn inside an image is part of the picture and keeps its colour.' },
      { key: 'from', label: 'Replace which colour', group: 'Recolour', type: 'select', default: 'any', options: [
        { value: 'any', label: 'Any colour' },
        { value: '#000000', label: 'Black only' },
        { value: '#ff0000', label: 'Red only' },
        { value: '#0000ff', label: 'Blue only' },
      ], help: 'Matches the exact colour a run was painted with; a near-black from a scanner will not count as black.' },
      pagesField({ group: 'Pages' }),
    ],
    notes: [
      'Only text drawn in the page\u2019s own content streams is recoloured. Text inside an image is part of the picture, and text carried inside a Form XObject stays in that XObject \u2014 the run keeps the colour the XObject paints it with.',
      'A run whose colour comes from a pattern or an ICC colour space is recoloured too: the colour is stated in a device RGB space for that run alone, so the space the page set is back for the next one.',
      'Pages with no matching text are reported, not quietly skipped.',
    ],
    async run(context) {
      const notes: string[] = [];
      const [input] = await openInputs(context);
      const { recolourText } = await import('../core/content');
      const pages = resolvePages(stringValue(context.values, 'pages', 'all'), input.pageCount);
      const from = stringValue(context.values, 'from', 'any');
      const to = stringValue(context.values, 'to', '#000000');
      let changed = 0;
      // The count is of show operators, and a `Tr 3` or `Tr 7` run paints with neither
      // fill nor stroke: rewriting the colour in force is true of the bytes, and false of
      // anything a person can see. Measured on `blanks.pdf` sheet 4 (an OCR layer) the
      // card said "Recoloured 1 text run to #aa00aa." with the sheet's ink empty before
      // and after, so the invisible ones are now counted apart.
      let invisible = 0;
      const untouched: number[] = [];
      for (let i = 0; i < pages.length; i++) {
        throwIfAborted(context.signal);
        const before = changed;
        const page = input.doc.getPage(pages[i]);
        invisible += invisibleRunsOn(page, from);
        changed += recolourText(page, from, to);
        if (changed === before) untouched.push(pages[i] + 1);
        context.progress((i + 1) / pages.length, `Page ${pages[i] + 1}`);
      }
      if (changed === 0) {
        return admit(
          reportResult(
            [{
              title: 'Nothing was recoloured',
              text: from === 'any'
                ? pages.length === 1
                  ? 'This page draws no text of its own \u2014 a scanned sheet, text painted into an image, or text carried inside a Form XObject (what a flattened vector export leaves) all look like this.'
                  : `None of the ${countLabel(pages.length, 'page')} you selected draws text of its own \u2014 scanned pages, text painted into an image, or text carried inside a Form XObject (what a flattened vector export leaves) all look like this.`
                : `No text painted in ${from} was found on the ${countLabel(pages.length, 'page')} you selected. Try "Any colour", which changes every text run.`,
            }],
            { message: 'No text matched, so the file is unchanged.' },
          ),
          notes,
        );
      }
      // E13 in the partial case: a recolour that reached three of ten pages has
      // to say which seven it did not, or the user assumes the whole file changed.
      if (untouched.length > 0 && untouched.length < pages.length) {
        const list = untouched.slice(0, 8).join(', ') + (untouched.length > 8 ? ', …' : '');
        const where = untouched.length === 1 ? `page ${list}` : `pages ${list}`;
        note(notes, `No text on ${where} was painted in ${from === 'any' ? 'a colour of its own' : from}, so ${untouched.length === 1 ? 'it was' : 'they were'} left as ${untouched.length === 1 ? 'it is' : 'they are'}.`);
      }
      return pdfOutput(
        input.doc,
        notes,
        `Recoloured ${countLabel(changed, 'text run')} to ${to}`
          + `${invisible > 0 && invisible <= changed
            ? `, ${invisible} of ${changed === 1 ? 'it' : 'them'} in an invisible render mode,`
              + ' so the page looks unchanged where only those ran'
            : ''}.`,
      );
    },
  },

  {
    id: 'invert-colors',
    name: 'Invert Colours',
    description: 'Produce a dark-mode version of the document',
    icon: '🌗',
    category: 'edit',
    keywords: ['dark mode', 'negative', 'night reading'],
    outputSuffix: '_inverted.pdf',
    actionLabel: 'Invert',
    promise: 'A dark-mode copy of the pages you choose, each one a photograph of the inverted original.',
    fields: [
      { key: 'dpi', label: 'Resolution', type: 'slider', default: 200, min: 96, max: 400, step: 1, unit: 'dpi', group: 'Output', help: 'Each page is photographed at this resolution. The picture grows with the square of it — 96 to 400 dpi multiplies the pixels 17 times — while the JPEG inside the file grows less, about 7 times on a flat-colour sheet.' },
      pagesField({ group: 'Pages' }),
    ],
    notes: [
      'The output is images, so text stops being selectable and the file usually grows. The title, author, subject and keywords are carried over; links and annotations are not.',
      'Only the selected pages are in the result: a narrower selection produces a shorter document, not the same document with some pages untouched.',
      'Each page is re-rendered at its displayed size, including its /Rotate and its /CropBox, so mixed, rotated and cropped documents keep their shape.',
    ],
    async run(context) {
      const notes: string[] = [];
      const [input] = await openInputs(context);
      return rerasterise(context, notes, input, {
        pages: stringValue(context.values, 'pages', 'all'),
        dpi: readNumber(context, notes, { key: 'dpi', label: 'Resolution', fallback: 200, min: 96, max: 400, integer: true, unit: 'dpi' }),
        filter: { invert: true },
      }, 'Inverted');
    },
  },

  {
    id: 'adjust-colors',
    name: 'Adjust Colours',
    description: 'Tune brightness, contrast, saturation and hue',
    icon: '🎛️',
    category: 'edit',
    keywords: ['brightness', 'contrast', 'saturation', 'sharpen', 'scan cleanup'],
    outputSuffix: '_adjusted.pdf',
    actionLabel: 'Adjust colors',
    promise: 'The pages you select, re-rendered with your colour settings burned into the pixels — including a true black-and-white cutoff.',
    fields: [
      { key: 'brightness', label: 'Brightness', type: 'slider', default: 1, min: 0.2, max: 2, step: 0.02, group: 'Colour', help: 'Above 1 lightens the whole page image; 2 blows out a scan’s background.' },
      { key: 'contrast', label: 'Contrast', type: 'slider', default: 1, min: 0.2, max: 3, step: 0.02, group: 'Colour', help: 'Above 1 pushes lights lighter and darks darker. Past 2 a grey scan loses its mid-tones.' },
      { key: 'saturation', label: 'Saturation', type: 'slider', default: 1, min: 0, max: 3, step: 0.02, group: 'Colour', help: 'How strong the colours are. 0 is already greyscale, so the switch below is the extreme case.' },
      { key: 'hue', label: 'Hue rotate', type: 'slider', default: 0, min: -180, max: 180, step: 1, unit: '°', group: 'Colour', help: 'Rotates every colour round the wheel by this angle. 180 turns a blue seal orange.' },
      { key: 'grayscale', label: 'Greyscale', type: 'toggle', default: false, group: 'Colour', help: 'Removes colour entirely and overrides the saturation slider.' },
      // The cutoff is the *last* pass: the colour settings above have already been
      // burned into the pixels by the time it runs, so brightness, contrast,
      // saturation and hue all move where the cut falls. That order is the useful one
      // — a cutoff applied first and then brightened would stop being black and white —
      // but it was unspoken, and the label alone read as if the page were cut from the
      // original. Measured on the colour fixture: brightness 1.6 lifts the 89-luma grey
      // over a 0.5 cut, so the grey square comes back white where it came back black
      // without it, and the page is still two tones (0 mid tones in both runs).
      { key: 'threshold', label: 'Make black and white', type: 'slider', default: 0, min: 0, max: 1, step: 0.02, help: '0 keeps colour. The cut falls after the colour settings above, so brightness, contrast, saturation and hue all move where it lands — a real pixel cutoff, not a contrast boost.', group: 'Output' },
      { key: 'dpi', label: 'Resolution', type: 'slider', default: 200, min: 96, max: 400, step: 1, unit: 'dpi', group: 'Output', help: 'The page is rendered at this resolution and re-embedded as an image, so higher means sharper and much bigger.' },
      pagesField(),
    ],
    notes: [
      'The output is images: text stops being selectable, and pages you did not select are not carried over.',
      'Each page is re-rendered at its displayed size, including its /Rotate and its /CropBox, so mixed, rotated and cropped documents keep their shape.',
      'The title, author, subject and keywords are carried over; links and annotations are not — they are part of the picture now, so a link stops being clickable and a form field stops being fillable.',
    ],
    async run(context) {
      const notes: string[] = [];
      const [input] = await openInputs(context);
      const threshold = readNumber(context, notes, { key: 'threshold', label: 'Black-and-white cutoff', fallback: 0, min: 0, max: 1 });
      return rerasterise(context, notes, input, {
        pages: stringValue(context.values, 'pages', 'all'),
        dpi: readNumber(context, notes, { key: 'dpi', label: 'Resolution', fallback: 200, min: 96, max: 400, integer: true, unit: 'dpi' }),
        threshold: threshold > 0 ? Math.round(threshold * 255) : undefined,
        filter: {
          brightness: readNumber(context, notes, { key: 'brightness', label: 'Brightness', fallback: 1, min: 0.2, max: 2 }),
          contrast: readNumber(context, notes, { key: 'contrast', label: 'Contrast', fallback: 1, min: 0.2, max: 3 }),
          // "Greyscale" wins over saturation; keeping both would
          // fight, and the slider would quietly lose.
          saturation: booleanValue(context.values, 'grayscale') ? 1 : readNumber(context, notes, { key: 'saturation', label: 'Saturation', fallback: 1, min: 0, max: 3 }),
          hue: readNumber(context, notes, { key: 'hue', label: 'Hue rotate', fallback: 0, min: -180, max: 180, unit: '°' }),
          grayscale: booleanValue(context.values, 'grayscale'),
        },
      }, threshold > 0 ? 'Adjusted and binarised' : 'Adjusted');
    },
  },

  {
    id: 'scanner-effect',
    name: 'Scanner Effect',
    description: 'Make a PDF look like a clean greyscale scan',
    icon: '📄',
    category: 'edit',
    // "binarise" was the one keyword the pass cannot answer: it is a greyscale look, not
    // a cutoff — measured at default 220 dpi, the text sheet keeps 2 213 mid tones and
    // the colour sheet 54 180 (against 64 288 in a plain rasterisation of the same
    // sheet), and there is no cutoff field on this card to set. `adjust-colors` has one.
    keywords: ['scan look', 'whitening', 'black and white look', 'photocopy'],
    outputSuffix: '_scanned.pdf',
    actionLabel: 'Apply scan effect',
    promise: 'The pages you choose, whitened and sharpened into a clean greyscale scan — a real pixel pass, not just a colour filter.',
    fields: [
      { key: 'whitening', label: 'Whiten the background', type: 'toggle', default: true, group: 'Look', help: 'Pushes the paper background to white, which is what makes a grey photocopy look clean.' },
      { key: 'sharpen', label: 'Sharpen edges', type: 'toggle', default: true, group: 'Look', help: 'Crisps the edges of the glyphs. There is no amount to set: the pass runs after whitening, so it has no grey paper left to ring with a halo.' },
      { key: 'grayscale', label: 'Greyscale', type: 'toggle', default: true, group: 'Look', help: 'Drops the colour, which is what a real document scan looks like and prints cheaper.' },
      { key: 'contrast', label: 'Contrast', type: 'slider', default: 1.35, min: 1, max: 3, step: 0.05, group: 'Look', help: 'How hard the pass separates ink from paper.' },
      { key: 'dpi', label: 'Resolution', type: 'slider', default: 220, min: 96, max: 400, step: 1, unit: 'dpi', group: 'Output', help: '300 is the point at which a printed page reads cleanly on screen; above it the effect gets slower and the file gets much bigger.' },
      pagesField(),
    ],
    notes: [
      'Whitening and sharpening are applied per pixel, so they are the slowest of the colour tools — a 500-page document is a lot of canvases.',
      'The output is images; selectable text is lost, and only the selected pages are written into it.',
      // Measured, because the name suggests otherwise: a sheet photographed at 3.00°
      // comes back at 3.00° — the passes are grade, not geometry, and the copy that is
      // going to say "clean scan" has to say which half it does not do.
      'It grades the page; it does not straighten it. A sheet tilted by 3° comes back tilted by 3°, so run Deskew PDF first if the tilt matters.',
      // The same sentence its two sibling cards carry, for the same measured reason:
      // the note is painted into the picture (469 → 514 non-white px at its own place)
      // and its `/Annots` entry is gone, so the card must not leave it unspoken.
      'Links and annotations are not carried over: they end up part of the picture, so a note stops opening and a link stops being clickable.',
    ],
    async run(context) {
      const notes: string[] = [];
      const [input] = await openInputs(context);
      return rerasterise(context, notes, input, {
        pages: stringValue(context.values, 'pages', 'all'),
        dpi: readNumber(context, notes, { key: 'dpi', label: 'Resolution', fallback: 220, min: 96, max: 400, integer: true, unit: 'dpi' }),
        filter: {
          contrast: readNumber(context, notes, { key: 'contrast', label: 'Contrast', fallback: 1.35, min: 1, max: 3 }),
          grayscale: booleanValue(context.values, 'grayscale', true),
        },
        whitening: booleanValue(context.values, 'whitening', true),
        sharpen: booleanValue(context.values, 'sharpen', true),
      }, 'Applied the scanner effect to');
    },
  },

  {
    id: 'ocr-pdf',
    name: 'OCR PDF',
    description: 'Recognise text in scanned pages and add a searchable, selectable layer',
    icon: '🔡',
    category: 'edit',
    keywords: ['recognise', 'searchable pdf', 'text layer', 'abbyy alternative'],
    outputSuffix: '_ocr.pdf',
    actionLabel: 'Recognise text',
    promise: 'A hidden text layer over the scan, so pages become selectable and searchable without changing how they look.',
    fields: [
      { key: 'language', label: 'Language', group: 'Recognition', type: 'select', default: 'en', options: [
        { value: 'en', label: 'English' }, { value: 'de', label: 'German' },
        { value: 'es', label: 'Spanish' }, { value: 'fr', label: 'French' },
        { value: 'it', label: 'Italian' }, { value: 'pt', label: 'Portuguese' },
        { value: 'ru', label: 'Russian' }, { value: 'zh', label: 'Chinese' },
        { value: 'ja', label: 'Japanese' }, { value: 'ko', label: 'Korean' },
      ], help: 'Recorded with the run. This build ships one English–Latin reader, so the choice does not change what is recognised — a page in another script comes back garbled whatever you pick here.' },
      { key: 'mode', label: 'Output', group: 'Output', type: 'segmented', default: 'searchable', options: [
        { value: 'searchable', label: 'Invisible text layer (keeps the scan)' },
        { value: 'replace', label: 'Replace the page with text' },
        { value: 'report', label: 'Just show me the text' },
      ], help: 'Invisible text keeps the scan looking exactly as it did. Replace throws the picture away and gives you a smaller, plainer page. Report shows the text without touching the file.' },
      { key: 'dpi', label: 'Resolution', type: 'slider', default: 300, min: 150, max: 600, step: 10, integer: true, unit: 'dpi', group: 'Output', help: 'What the page is photographed at before recognition. Under 300 loses small print; over 400 costs memory and rarely gains anything.' },
      { key: 'skipSearchable', label: 'Skip pages that already have text', type: 'toggle', default: true, group: 'Recognition', help: 'On leaves a page that already has text exactly as it is, which is what a mixed scan-and-export document wants.' },
      pagesField({ group: 'Pages' }),
    ],
    notes: [
      'The OCR model is downloaded once and cached; the pages themselves are recognised on this device.',
      'Pages that already carry a text layer are left alone unless you ask for a fresh read, so a mixed document keeps what it has.',
      'Language is a label on the run, not a switch: only the English–Latin dictionary is bundled, so every choice reads the page with the same model.',
    ],
    async run(context) {
      const notes: string[] = [];
      const [input] = await openInputs(context);
      const { ocrDocument, addSearchableTextLayer, OcrEngineUnavailable } = await import('../core/ocr');
      const session = await withRender(input, context).then((result) => result.session);
      const dpi = readNumber(context, notes, { key: 'dpi', label: 'Resolution', fallback: 300, min: 150, max: 600, integer: true, unit: 'dpi' });
      let results;
      try {
        results = await ocrDocument(session, {
          pages: stringValue(context.values, 'pages', 'all'),
          dpi,
          lang: stringValue(context.values, 'language', 'en'),
          signal: context.signal,
          // The rail has offered this switch since the tool was written; until now
          // nothing read it, so "skip pages that already have text" always applied.
          force: !booleanValue(context.values, 'skipSearchable', true),
          onProgress: (done, total) => context.progress(done / total * 0.8, `Recognised page ${done} of ${total}`),
          onStatus: (status) => context.log(status),
        });
      } catch (error) {
        if (context.signal.aborted) throw error;
        // E20, and the distinction this tool exists to get right: an engine that
        // never arrived is not a document with nothing in it. Both branches name
        // what failed, say that the file was **not read**, and say what would fix
        // it. An engine is a capability that degrades with a warning, never into
        // a silent success, and here there is nothing to degrade to.
        if (error instanceof OcrEngineUnavailable) {
          throw new Error(error.phase === 'load'
            ? `The recogniser could not run in this tab, so nothing in "${input.name}" was read: ${error.detail} The OCR model is downloaded once and cached — check the connection (or let this page reach the CDN), then run this again.`
            : `The recogniser could not run past page ${error.page ?? '?'} of "${input.name}", so the file was not read: ${error.detail} Run it again; a lower "Resolution" hands it a smaller picture of each page.`);
        }
        // Anything else is a document or renderer failure. Wrapping it in "the
        // recogniser could not run" would be the same lie wearing another hat.
        throw new Error(`OCR could not run on "${input.name}": ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        const mode = stringValue(context.values, 'mode', 'searchable');
        const skipped = results.filter((page) => page.alreadySearchable);
        if (skipped.length > 0) {
          note(notes, `${countLabel(skipped.length, 'page')} already had a text layer and ${skipped.length === 1 ? 'was left as it was' : 'were left as they were'}.${booleanValue(context.values, 'skipSearchable', true) ? ' Turn off "skip pages that already have text" to read them again.' : ''}`);
        }
        // E10: "no text" is three different findings — never read, blank sheet,
        // sheet with ink that is not letters — and the ink measured off the
        // painted bitmap is what tells them apart. One sentence must not stand
        // in for another.
        const quiet = ocrQuietPages(results);
        for (const line of ocrQuietSummary(quiet)) note(notes, line);
        if (results.length === 0) {
          return admit(
            reportResult([{ title: 'Nothing to read', text: 'The page selection matched no page of this document.' }], { message: 'Nothing was read: no page was selected.' }),
            notes,
          );
        }
        if (mode === 'report') {
          const characters = results.reduce((sum, page) => sum + page.text.trim().length, 0);
          const outcome = reportResult(
            results.map((page) => ({ title: `Page ${page.page}`, text: page.text.trim() || ocrQuietPageLine(page) })),
            { message: characters > 0
              ? `Read ${characters.toLocaleString()} characters across ${countLabel(results.length, 'page')}.`
              : `Read nothing: ${ocrQuietSummary(quiet).join(' ') || `not one of the ${countLabel(results.length, 'page')} carries readable text.`}` },
          );
          if (characters === 0) {
            note(notes, 'No page has a text layer. Run this tool with "Invisible text layer" or "Replace the page with text" to make the document searchable.');
          }
          return admit(outcome, notes);
        }
        if (mode === 'searchable') {
          const added = await addSearchableTextLayer(input.doc, results, { invisible: true });
          if (added.pages === 0) {
            // The refusal has to be readable on its own: the report card shows
            // these blocks, not the run's `warnings`, so the line names how many
            // pages the recogniser actually read as well as what it found there.
            const examined = results.length - skipped.length;
            return admit(
              reportResult(
                [
                  {
                    title: 'No layer was added',
                    text: `No text was recognised on the ${countLabel(examined, 'page')} the recogniser read${skipped.length > 0 ? `, and ${countLabel(skipped.length, 'page')} already had ${skipped.length === 1 ? 'its own text layer and was left alone' : 'their own text layers and were left alone'}` : ''}, so the document was not changed.`,
                  },
                  ...quiet.blocks,
                ],
                // A page that was skipped was never analysed, so "nothing was
                // recognised" would be a claim about a read that did not happen.
                { message: examined === 0
                  ? 'Nothing was read — every page you picked already has a text layer, so the file is unchanged.'
                  : 'No text was recognised — the file is unchanged.' },
              ),
              notes,
            );
          }
          if (added.skipped > 0) {
            note(notes, `${countLabel(added.skipped, 'page')} had no recognised words to place and ${added.skipped === 1 ? 'was left as it was' : 'were left as they were'}.`);
          }
          return pdfOutput(
            input.doc,
            notes,
            `Added ${countLabel(added.words, 'recognised word')} to ${countLabel(added.pages, 'page')} as an invisible layer — the scan looks unchanged but the text is now selectable and searchable.`,
          );
        }
        if (quiet.read > 0 && quiet.pages.length === quiet.read) {
          // "Replace the page with text" over sheets that produced no text would
          // ship blank pages under a line about rebuilt documents.
          return admit(
            reportResult(
              [
                { title: 'Nothing was written', text: `The ${countLabel(quiet.read, 'page')} the recogniser read produced no text, so a rebuilt file would hold sheets of paper beside whatever you wanted kept. Nothing was changed.` },
                ...quiet.blocks,
              ],
              { message: 'Nothing was written — the file is unchanged.' },
            ),
            notes,
          );
        }
        const rebuilt = await textOnlyPdf(input.doc, results);
        if (results.length < input.pageCount) {
          // The rebuilt file is a new document: whatever was not recognised is
          // simply not in it, which the user must hear before they download it.
          note(notes, `The result is a new ${countLabel(results.length, 'page')} document, so the ${countLabel(input.pageCount - results.length, 'other page')} of "${input.name}" ${input.pageCount - results.length === 1 ? 'is' : 'are'} not in the download.`);
        }
        return pdfOutput(
          rebuilt,
          notes,
          `Rebuilt ${countLabel(results.length, 'page')} as selectable text. The original page images were replaced, so any layout, image or handwriting in them is gone.`,
        );
      } finally {
        await session.destroy();
      }
    },
  },

  {
    id: 'form-filler',
    name: 'PDF Form Filler',
    description: 'Fill AcroForm and XFA forms directly in the browser',
    icon: '🗒️',
    category: 'edit',
    keywords: ['fill form', 'acroform', 'xfa', 'tax form'],
    surface: 'custom',
    outputSuffix: '_filled.pdf',
    actionLabel: 'Fill the form',
    promise: 'Your answers written into the form\u2019s own fields, optionally flattened into page content on save.',
    fields: [{ key: 'flatten', label: 'Flatten when saving', group: 'Save', type: 'toggle', default: false ,
    help: 'On writes the answers into the page and removes the fields, so nobody can retype them. Off leaves the form fillable.',}],
    notes: [
      'Values are written into the form fields themselves, so the file stays fillable unless you flatten it.',
      'XFA-only forms cannot be rendered in a browser; the tool says so instead of filling an invisible copy.',
    ],
    async run(context) {
      const notes: string[] = [];
      const [input] = await openInputs(context);
      const { fillForm } = await import('../core/forms');
      // Look for the packet before touching the form: pdf-lib's `getForm()` —
      // reached by `listFormFields` — deletes `/XFA` the first time it runs, so
      // every XFA sentence below read as false when checked afterwards.
      const xfaForm = hasXfa(input.doc);
      const fields = listFormFields(input.doc);
      if (fields.length === 0) {
        throw new Error(xfaForm
          ? 'This form’s fields live only in its XFA stream, which nothing here can render. Use Create PDF Form to add real AcroForm fields.'
          : 'This PDF has no fillable form fields. Try Create PDF Form to add some.');
      }
      if (xfaForm) {
        note(notes, 'This document also carries an XFA form. Its packet does not survive the save — the result is the AcroForm mirror with your values in it, so every viewer reads the same answers.');
      }
      const values = context.values['fieldValues'];
      const record = values && typeof values === 'object' && !Array.isArray(values)
        ? values as Record<string, string | boolean>
        : {};
      const result = fillForm(input.doc, record);
      let baked = '';
      if (booleanValue(context.values, 'flatten')) {
        // `core/forms` owns the field-aware baker: the generic annotation
        // flattener chokes on the appearance streams pdf-lib writes for a widget
        // (`Expected instance of PDFDict, but got instance of PDFContentStream`),
        // which turned "flatten when saving" into a crash on our own forms.
        const { flattenForm } = await import('../core/forms');
        const outcome = await flattenForm(input.doc);
        if (outcome.flattened === 0) {
          note(notes, 'Nothing could be baked into the page, so the fields were left interactive.');
        } else {
          baked = ` ${countLabel(outcome.flattened, 'field')} became page content.`;
        }
        if (outcome.needsRender) {
          note(notes, 'Some answers had no appearance this browser could draw, so they may be missing from the flattened page.');
        }
      }
      if (result.filled === 0) {
        note(notes, `No value reached any of the ${countLabel(fields.length, 'field')} in this form, so it was saved unchanged.`);
      }
      return pdfOutput(
        input.doc,
        notes,
        result.missing.length > 0
          ? `Filled ${countLabel(result.filled, 'field')}; no value given for ${result.missing.slice(0, 4).join(', ')}${result.missing.length > 4 ? ', …' : ''}.${baked}`
          : `Filled ${countLabel(result.filled, 'field')}.${baked}`,
      );
    },
  },

  {
    id: 'form-creator',
    name: 'Create PDF Form',
    description: 'Add fillable text, checkbox, dropdown, list and radio-group fields by dragging',
    icon: '🧾',
    category: 'edit',
    keywords: ['make form', 'fillable', 'design form', 'widgets'],
    surface: 'custom',
    outputSuffix: '_form.pdf',
    actionLabel: 'Create the form',
    promise: 'The fields you dropped, turned into real AcroForm widgets that any viewer can type into.',
    notes: [
      'A field dropped on a page that no longer exists is moved to the nearest page and the run says how many moved.',
    ],
    fields: [{ key: 'fieldSpecs', label: 'Fields', group: 'Design', type: 'text', default: '', help: 'Holds the fields you dropped in the designer, in tab order. The designer writes it; typing here does nothing.' }],
    async run(context) {
      const notes: string[] = [];
      const [input] = await openInputs(context);
      const specs = context.values['fieldSpecs'];
      if (!Array.isArray(specs) || specs.length === 0) {
        throw new Error('Drag at least one field onto the page first.');
      }
      const { createFormField, listFormFields } = await import('../core/forms');
      // Field names are the form's addresses: two widgets called the same thing
      // is what pdf-lib refuses outright, and the pane lets the name be typed.
      const taken = new Set(listFormFields(input.doc).map((field) => field.name));
      let created = 0;
      let offPage = 0;
      const unwritable: string[] = [];
      for (const spec of specs as (CreateFieldSpec & { page: number })[]) {
        // E15: a field left on a page that no longer exists is clamped to the
        // nearest one, and the run says how many moved. A spec that names no page
        // at all is on page 1 and has not been moved anywhere.
        const asked = Number(spec.page);
        const page = bounded(
          notes,
          'Field page',
          Number.isFinite(asked) ? Math.trunc(asked) : 0,
          { min: 0, max: input.pageCount - 1, integer: true },
        );
        if (Number.isFinite(asked) && Math.trunc(asked) !== page) offPage += 1;
        const named = String(spec.name ?? '').trim();
        // A radio group is one widget per option. With none, `createFormField`
        // makes a field nobody can see or type into, so it is refused out loud
        // instead of being counted as "created".
        if (spec.type === 'radio' && (spec.options?.length ?? 0) === 0) {
          unwritable.push(`the radio group${named ? ` "${named}"` : ''} has no options, so nothing could be placed for it`);
          continue;
        }
        if (!named) {
          unwritable.push(`a ${spec.type} field with no name`);
          continue;
        }
        let name = named;
        if (taken.has(name)) {
          let suffix = 2;
          while (taken.has(`${named}_${suffix}`)) suffix += 1;
          name = `${named}_${suffix}`;
          note(notes, `A field was already named "${named}", so this one is stored as "${name}" and both stay reachable.`);
        }
        taken.add(name);
        const { page: _dropped, ...field } = spec;
        try {
          if (createFormField(input.doc, page, { ...field, name }) >= 0) created += 1;
          else note(notes, `The "${spec.type}" field "${name}" could not be created on page ${page + 1}.`);
        } catch (error) {
          note(notes, `The "${spec.type}" field "${name}" could not be created: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (offPage > 0) {
        note(notes, `${countLabel(offPage, 'field')} was dropped on a page outside this document and moved to the nearest page.`);
      }
      if (created === 0) {
        // Nothing was placed, so there is no file to hand back — but the reason is
        // a report the user can act on, not a crash.
        return admit(
          reportResult(
            [{
              title: 'No field could be placed',
              text: unwritable.length > 0
                ? `${countLabel(unwritable.length, 'field')} was refused: ${unwritable.join('; ')}.`
                : `${countLabel(specs.length, 'field')} was asked for and none of them could be placed. Check the page and name each field was given.`,
            }],
            { message: `None of the ${countLabel(specs.length, 'field')} could be placed${unwritable[0] ? `: ${unwritable[0]}` : ''}.`, }
          ),
          notes,
        );
      }
      if (unwritable.length > 0) {
        note(notes, `${countLabel(unwritable.length, 'field')} was not added: ${unwritable.join('; ')}.`);
      }
      return pdfOutput(
        input.doc,
        notes,
        `Added ${countLabel(created, 'fillable field')} of ${countLabel(specs.length, 'field')} requested. Viewers can now type into this document.`,
      );
    },
  },

  {
    id: 'pdf-layers',
    name: 'PDF OCG Layers',
    description: 'List, toggle, add or delete optional-content groups',
    icon: '🧬',
    category: 'edit',
    keywords: ['ocg', 'optional content', 'layers panel', 'cad export'],
    surface: 'none',
    outputSuffix: '_layers.pdf',
    actionLabel: 'Change layers',
    promise: 'The optional-content groups of a CAD or GIS export, switched on or off in the default view.',
    fields: [
      { key: 'hide', label: 'Hide these layers', type: 'multiselect', default: [], options: [], choices: layerChoices, group: 'Default view', help: 'Switched off in the default view. The content stays in the file and any reader can turn it back on.' },
      { key: 'show', label: 'Show these layers', type: 'multiselect', default: [], options: [], choices: layerChoices, group: 'Default view', help: 'Switched on in the default view, overriding what the file was saved with.' },
      { key: 'add', label: 'Add a layer named', type: 'text', placeholder: 'Revision B', group: 'Manage', help: 'Creates an empty optional-content group, ready for content to be assigned to it elsewhere.' },
      { key: 'remove', label: 'Delete layers named', type: 'textarea', group: 'Manage', help: 'Deletes the group from the layers panel. Content that belonged to it stays on the page and falls back to always visible in most readers.' },
    ],
    validate: (values) => {
      const asked = stringValues(values, 'hide').length
        + stringValues(values, 'show').length
        + (stringValue(values, 'add').trim() ? 1 : 0)
        + (stringValues(values, 'remove').flatMap((entry) => entry.split(/[\n,]+/)).filter((name) => name.trim() !== '').length);
      return asked === 0
        ? 'Tick a layer to hide or show it, or name one to add or delete — with none of those chosen nothing would change.'
        : null;
    },
    notes: [
      'Only the default viewing configuration is edited; named configurations keep their own state, as in other viewers.',
      'Hiding a layer turns it off in the layers panel; it does not delete the content.',
      'A layer you add is empty — this tool creates the group, and the marked content that would put drawing in it is written by the producer, not here.',
      'To take hidden ink out of the file instead, use Sanitize PDF with "Remove hidden layer content": that deletes the operators, and cannot be undone in the output.',
    ],
    async run(context) {
      const notes: string[] = [];
      const [input] = await openInputs(context);
      const { listLayers, setLayerVisibility, addLayer, deleteLayer } = await import('../core/layers');
      const layers = listLayers(input.doc);
      if (layers.length === 0 && !stringValue(context.values, 'add')) {
        return reportResult([{ title: 'Layers', text: 'This document has no optional-content groups (OCGs). CAD and GIS exports usually do; add one above to create the structure.' }], {
          message: 'No layers found — nothing was changed.',
        });
      }
      const missing: string[] = [];
      const hidden = stringValues(context.values, 'hide');
      const shown = stringValues(context.values, 'show');
      const both = hidden.filter((name) => shown.some((other) => other.toLowerCase() === name.toLowerCase()));
      if (both.length > 0) {
        // The lists are applied in order, so a name in both is switched off and
        // the user needs to know which instruction the file ended up obeying.
        note(notes, `${both.map((name) => `"${name}"`).join(', ')} was listed in both hide and show, so it is hidden — the show instruction did nothing.`);
      }
      for (const name of hidden) {
        if (!setLayerVisibility(input.doc, name, false)) missing.push(name);
      }
      for (const name of shown) {
        // A name in both lists is hidden and stays hidden: running the show here
        // would leave the file disagreeing with the sentence above.
        if (both.some((other) => other.toLowerCase() === name.toLowerCase())) continue;
        if (!setLayerVisibility(input.doc, name, true)) missing.push(name);
      }
      let added = '';
      const wanted = stringValue(context.values, 'add').trim();
      if (wanted) {
        if (layers.some((layer) => layer.name.toLowerCase() === wanted.toLowerCase())) {
          note(notes, `A layer named "${wanted}" already exists, so it was kept and no duplicate was added.`);
          setLayerVisibility(input.doc, wanted, true);
        } else {
          addLayer(input.doc, wanted);
          added = wanted;
        }
      }
      const deletions = stringValues(context.values, 'remove')
        .flatMap((entry) => entry.split(/[\n,]+/))
        .map((name) => name.trim())
        .filter(Boolean);
      let deleted = 0;
      for (const name of deletions) {
        if (deleteLayer(input.doc, name)) deleted += 1;
        else missing.push(name);
      }
      if (missing.length > 0) {
        note(notes, `No layer is named ${missing.map((name) => `"${name}"`).join(', ')} in this document, so those instructions did nothing.`);
      }
      const remaining = listLayers(input.doc);
      const visible = remaining.filter((layer) => layer.on !== false).map((layer) => layer.name);
      return pdfOutput(
        input.doc,
        notes,
        `${added ? `Added "${added}" and ` : ''}${deleted > 0 ? `deleted ${countLabel(deleted, 'layer')} and ` : ''}the document now has ${countLabel(remaining.length, 'layer')}: ${remaining.map((layer) => layer.name).join(', ') || 'none'}${visible.length > 0 ? `, of which ${visible.map((name) => `"${name}"`).join(', ')} ${visible.length === 1 ? 'shows' : 'show'} by default` : ''}.`,
      );
    },
  },

  {
    id: 'remove-annotations',
    name: 'Remove Annotations',
    description: 'Strip comments, highlights, ink and links from the whole document',
    icon: '🧽',
    category: 'edit',
    keywords: ['clean markup', 'drop comments', 'flatten away'],
    outputSuffix: '_clean.pdf',
    actionLabel: 'Remove annotations',
    promise: 'Comments, highlights, ink and links deleted from the pages you select — as a report when there is nothing to delete.',
    notes: [
      'Removal is permanent: the annotation objects are deleted, not hidden.',
      'Annotations inherited from a shared parent node are removed for every page beneath it.',
      'A form field is its own widget annotation, so fields on the selected pages go too: the field, its widget and the answer written into it are deleted, and `/AcroForm` stops naming them.',
    ],
    fields: [
      pagesField({ group: 'Pages' }),
    ],
    async run(context) {
      const notes: string[] = [];
      const [input] = await openInputs(context);
      const { removeAnnotations } = await import('../core/annotations');
      const { listAnnotations } = await import('../core/annotations');
      const pages = resolvePages(stringValue(context.values, 'pages', 'all'), input.pageCount);
      const scope = new Set(pages);
      const before = listAnnotations(input.doc);
      const removed = removeAnnotations(input.doc, { pages });
      // Dicts, not appearances. A mark carried on a shared parent `/Annots` is one
      // object drawn on every page beneath it; removing it empties all of those
      // arrays at once. Counting the pre-run appearances would report that one
      // inherited note as "2 annotations", and counting them again afterwards
      // would claim the copy on the page you did not select is "still there" when
      // the shared object — and with it the drawing — is gone.
      const after = listAnnotations(input.doc);
      const remaining = new Set(after.map((mark) => mark.ref.toString()));
      const goneByRef = new Map<string, (typeof before)[number]>();
      for (const mark of before) {
        if (!remaining.has(mark.ref.toString())) goneByRef.set(mark.ref.toString(), mark);
      }
      const outsideByRef = new Map<string, (typeof after)[number]>();
      for (const mark of after) {
        if (!scope.has(mark.page) && !outsideByRef.has(mark.ref.toString())) {
          outsideByRef.set(mark.ref.toString(), mark);
        }
      }
      const outsideMarks = [...outsideByRef.values()].filter((mark) => mark.kind !== 'Popup').length;
      const outsidePopups = outsideByRef.size - outsideMarks;
      const outsideLabel = countLabel(outsideMarks, 'annotation')
        + (outsidePopups > 0 ? ` and ${countLabel(outsidePopups, 'note pop-up', 'note pop-ups')}` : '');
      if (removed === 0) {
        // E13: an unchanged file is not a result. Say what is actually there.
        return admit(
          reportResult(
            [{
              title: 'Nothing to remove',
              text: outsideByRef.size > 0
                ? `What this document carries sits outside the ${countLabel(pages.length, 'page')} you selected: ${outsideLabel}. Widen the Pages range and run again.`
                : 'This document has no annotations at all — nothing was removed, and the download would be byte-for-byte the file you started with.',
            }],
            { message: 'There were no annotations to remove.' },
          ),
          notes,
        );
      }
      if (outsideByRef.size > 0) {
        note(notes, `${outsideLabel} on the pages you did not select ${outsideByRef.size === 1 ? 'is' : 'are'} still there.`);
      }
      // Two numbers the written file has to back up. A note's `/Popup` is an entry
      // in `/Annots` but not a mark a reader lists as a comment, so it is counted
      // and named apart; and the page count is every page that lost an appearance
      // — the inherited shape takes its one dict off several sheets at once.
      const gone = [...goneByRef.values()];
      const popups = gone.filter((mark) => mark.kind === 'Popup').length;
      const marks = gone.length - popups;
      // A widget is the field's own dictionary, so the field went with it — a
      // consequence of "remove annotations" a form owner has to be told about.
      const fields = gone.filter((mark) => mark.kind === 'Widget').length;
      if (fields > 0) {
        note(notes, `${countLabel(fields, 'form field')} went with ${fields === 1 ? 'its widget' : 'their widgets'}: those pages no longer carry a fillable field, and the answers written into ${fields === 1 ? 'it' : 'them'} went too.`);
      }
      const changed = new Set(before.filter((mark) => !remaining.has(mark.ref.toString())).map((mark) => mark.page)).size;
      return pdfOutput(
        input.doc,
        notes,
        `Removed ${countLabel(marks, 'annotation')}`
        + `${popups > 0 ? ` and ${countLabel(popups, 'note pop-up', 'note pop-ups')}` : ''}`
        + ` from ${countLabel(Math.max(changed, 1), 'page')}.`,
      );
    },
  },

  // The `redact` entry that used to close this list is retired. `8bb1c49` folded the
  // id into `redact-pdf` (see `TOOL_ALIASES` in `registry.ts`), `cafea60` made the
  // canonical pane reachable again, and from that moment nothing in the app ran this
  // definition: the route folds before it picks a surface, so `/tool/redact` mounts
  // `redact-pdf`'s canvas and panel, and the `regions` text field that carried this
  // tool's typed `page:x,y,w,h` grammar belonged to a rail that never mounts beside a
  // pane. The id still answers its URL; the second definition of one job does not.
  // `tests/pdf/edge-edit.test.ts` runs the job on `redact-pdf`, and
  // `tests/pdf/field-reach.test.ts` pins that the folded route reaches it.
];

// ── helpers ─────────────────────────────────────────────────────────────────

// ── helpers ────────────────────────────────────────────────────────────────

/** "1 page" / "4 pages" — the phrasing every count in this module reports. */
function countLabel(count: number, noun: string, plural?: string): string {
  const value = Math.trunc(count);
  return value === 1 ? `1 ${noun}` : `${value} ${plural ?? `${noun}s`}`;
}

/** What a raster colour tool asks for; see `rerasterise`. */
interface RasterJob {
  pages: string;
  dpi: number;
  /** CSS filter components, composed by `core/measure`'s `cssFilterString`. */
  filter?: { brightness?: number; contrast?: number; saturation?: number; hue?: number; invert?: boolean; grayscale?: boolean };
  /** Bilevel cutoff in 0..255, or undefined to keep anti-aliased grey. */
  threshold?: number;
  /** Scanner-mode pixel passes; each is a real per-pixel operation. */
  whitening?: boolean;
  sharpen?: boolean;
}

/**
 * Re-render the selected pages as images and rebuild the document.
 *
 * Every output page is sized from *its own* source page after that page's
 * `/Rotate` (E8/E9), one page is in flight at a time so memory stays bounded
 * (E7), cancellation is honoured between pages (E19), and the pixel controls the
 * rails expose — threshold, whitening, sharpen — are actually applied. The
 * previous version packed one PDF point per pixel, then resized the page to the
 * source size, so each output showed the bottom-left corner of its own scan at
 * roughly 7× zoom and the three toggles changed nothing but the label.
 */
async function rerasterise(
  context: ToolRunContext,
  notes: string[],
  input: OpenedInput,
  job: RasterJob,
  verb: string,
): Promise<ToolResult> {
  const selected = resolvePages(job.pages, input.pageCount);
  const { session } = await withRender(input, context);
  try {
    const { cssFilterString, thresholdPixels, whitenPixels, sharpenPixels } = await import('../core/measure');
    const doc = await newPDF();
    // The output is a new document, so its `/Info` is empty unless it is carried. A
    // dark-mode copy that drops the title is not a copy of the document, and the rail
    // does not say metadata goes: same field list as `helpers.ts` `rebuildDocument`,
    // because two notions of "the document's own metadata" is how one of them drifts.
    for (const [value, set] of [
      [input.doc.getTitle(), doc.setTitle],
      [input.doc.getAuthor(), doc.setAuthor],
      [input.doc.getSubject(), doc.setSubject],
      [input.doc.getCreator(), doc.setCreator],
      [input.doc.getProducer(), doc.setProducer],
    ] as const) {
      if (value) set.call(doc, value);
    }
    const keywords = input.doc.getKeywords();
    if (keywords) doc.setKeywords(keywords.split(',').map((word) => word.trim()).filter(Boolean));
    const filter = cssFilterString({
      brightness: job.filter?.brightness,
      contrast: job.filter?.contrast,
      saturation: job.filter?.saturation,
      hue: job.filter?.hue,
      invert: job.filter?.invert,
      grayscale: job.filter?.grayscale,
    });
    for (let i = 0; i < selected.length; i++) {
      throwIfAborted(context.signal);
      const index = selected[i];
      const size = displayedSize(input.doc.getPage(index));
      const render = await session.renderPage(index + 1, job.dpi / 72, {
        filter: filter || undefined,
        background: '#ffffff',
      });
      try {
        // `renderPage` settles when the task is *scheduled*; the pixels land on
        // `finished`. Reading the canvas before that shipped a page of paper — the
        // `pdf-to-cbz` / `rasterize-pdf` / `pdf-to-image` class, this copy reaching
        // `invert-colors`, `adjust-colors` and `scanner-effect` through one helper.
        await render.finished;
        if (job.whitening || job.sharpen || job.threshold !== undefined) {
          const data = render.ctx.getImageData(0, 0, render.width, render.height);
          if (job.whitening) whitenPixels(data.data, 0.45);
          if (job.threshold !== undefined) thresholdPixels(data.data, job.threshold);
          if (job.sharpen) sharpenPixels(data.data, render.width, render.height, 0.7);
          render.ctx.putImageData(data, 0, 0);
        }
        const blob = await canvasToBlob(render.canvas, 'jpeg', 0.9, { background: '#ffffff' });
        // `mime` as well as `format`: without it `embedImageBytes` re-decodes the
        // raster through a canvas, which never finishes in a tab without one.
        const image = await embedImageBytes(doc, new Uint8Array(await blob.arrayBuffer()), { mime: 'image/jpeg', format: 'jpeg' });
        const page = doc.addPage([size.width, size.height]);
        page.drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });
      } finally {
        render.cancel();
      }
      context.progress((i + 1) / selected.length, `Re-rendered page ${index + 1}`);
    }
    if (selected.length < input.pageCount) {
      const left = input.pageCount - selected.length;
      note(notes, `These tools rebuild the document from the pages they render, so ${countLabel(left, 'page')} outside your selection ${left === 1 ? 'is' : 'are'} not in the output.`);
    }
    const outcome: ToolResult = {
      kind: 'pdf',
      bytes: await savePDF(doc),
      pages: doc.getPageCount(),
      message: `${verb} ${countLabel(selected.length, 'page')} at ${job.dpi} dpi. Any text is now part of the image, so it is no longer selectable or searchable.`,
    };
    return admit(outcome, notes);
  } finally {
    await session.destroy();
  }
}

async function textOnlyPdf(source: PDFDocument, results: { page: number; text: string }[]): Promise<PDFDocument> {
  void source;
  const doc = await newPDF();
  for (const result of results) {
    const lines = await wrapText(doc, result.text, { size: 10, maxWidth: 480 });
    const pageHeight = Math.max(300, lines.length * 14 + 80);
    const page = doc.addPage([595.28, pageHeight]);
    let y = pageHeight - 48;
    for (const line of lines) {
      await drawTextU(page, { text: line.line, x: 48, y, size: 10, color: rgb(0, 0, 0) });
      y -= 14;
    }
  }
  return doc;
}

/**
 * Why a page the recogniser read produced no text. The three kinds are three
 * different claims — a sheet with nothing on it, a sheet whose ink is not
 * letters, and a page this run never looked at — so they must not share one
 * sentence, and none of them is the same as "the engine did not run".
 *
 * The percentages come from `core/ocr`'s measurement of the **painted** bitmap,
 * never from the word list: an empty word list is also what an absent reader
 * produces.
 */
// The rule itself lives in `core/ocr` beside the measurement it reads, because
// `digitize-document` needs the same three-way split and a second copy of it
// would drift.
type OcrQuietKind = OcrSilentKind;
type OcrQuietPage = OcrSilentPage;

interface OcrQuiet {
  pages: OcrQuietPage[];
  /** Pages the recogniser actually rendered and read, silent or not. */
  read: number;
  /** One block per silent page, for the report the rail shows. */
  blocks: { title: string; text: string }[];
}

function ocrQuietPages(results: OcrPageResult[]): OcrQuiet {
  const pages: OcrQuietPage[] = [];
  let read = 0;
  for (const result of results) {
    // A page left alone is not a silent page; its own note already says so.
    if (result.alreadySearchable) continue;
    read += 1;
    if (result.text.trim() !== '') continue;
    const entry = ocrQuietPageOf(result);
    if (entry) pages.push(entry);
  }
  return {
    pages,
    read,
    blocks: pages.map((entry) => ({ title: `Page ${entry.page}`, text: ocrQuietSentence(entry) })),
  };
}

/** Classify one silent page from the reading the recogniser left behind. */
const ocrQuietPageOf = ocrSilentPageOf;

function ocrQuietSentence(entry: OcrQuietPage): string {
  if (entry.kind === 'blank') {
    return `blank — the rendered sheet measures ${entry.percent?.toFixed(2)} % ink, so there was nothing on it to read.`;
  }
  if (entry.kind === 'unreadable') {
    return `no letters found, and it is not a blank sheet: ${entry.percent?.toFixed(2)} % of the rendered page is ink. A picture, handwriting, or a scan too faint to resolve — try a higher Resolution.`;
  }
  return 'not analysed by this run, so nothing is claimed about it.';
}

/** One honest note per kind of silence. */
function ocrQuietSummary(quiet: OcrQuiet): string[] {
  const lines: string[] = [];
  const named = (kind: OcrQuietKind) =>
    quiet.pages
      .filter((entry) => entry.kind === kind)
      .map((entry) => (entry.percent === null ? `page ${entry.page}` : `page ${entry.page} at ${entry.percent.toFixed(2)} %`))
      .join(', ');
  const blank = quiet.pages.filter((entry) => entry.kind === 'blank');
  if (blank.length > 0) {
    lines.push(`${countLabel(blank.length, 'page')} yielded no text at all because there is nothing on ${blank.length === 1 ? 'it' : 'them'}: ${named('blank')} of the rendered sheet is ink.`);
  }
  const faint = quiet.pages.filter((entry) => entry.kind === 'unreadable');
  if (faint.length > 0) {
    lines.push(`${countLabel(faint.length, 'page')} yielded no text at all, though ${faint.length === 1 ? 'it carries' : 'they carry'} ink — ${named('unreadable')} of the rendered ${faint.length === 1 ? 'sheet is' : 'sheets are'} not paper. A picture, handwriting or a faint scan is what that measures; try a higher Resolution, or scan again at 300 dpi or better.`);
  }
  const never = quiet.pages.filter((entry) => entry.kind === 'unexamined');
  if (never.length > 0) {
    lines.push(`${countLabel(never.length, 'page')} ${never.length === 1 ? 'was' : 'were'} never analysed by this run (${named('unexamined')}), so nothing is claimed about ${never.length === 1 ? 'it' : 'them'}.`);
  }
  return lines;
}

/** The parenthetical a report-mode page gets when it holds no text. */
function ocrQuietPageLine(result: OcrPageResult): string {
  const entry = ocrQuietPageOf(result);
  if (entry) return `(${ocrQuietSentence(entry)})`;
  return result.alreadySearchable
    ? '(its own text layer was left as it was)'
    : '(no readable text found)';
}

async function toPng(doc: PDFDocument, bytes: Uint8Array): Promise<Uint8Array> {
  const { sniffImageMime, decodeImage, encodeImageBytes } = await import('../core/images');
  const mime = sniffImageMime(bytes) ?? 'image/png';
  if (mime === 'image/png') return bytes;
  const decoded = await decodeImage(bytes, { mime });
  const encoded = await encodeImageBytes(decoded.canvas, { format: 'png' });
  void doc;
  return encoded.bytes;
}

function firstFileBytes(values: Record<string, unknown>, key: string): Uint8Array | null {
  const value = values[key];
  const entry = Array.isArray(value) ? value[0] : value;
  if (entry && typeof entry === 'object' && 'bytes' in entry) {
    return (entry as { bytes: Uint8Array }).bytes;
  }
  return null;
}

/**
 * The page-space rectangle of a mark anchored in the displayed view (E8/E9).
 *
 * Stamps are annotations, and an annotation `/Rect` lives in unrotated user
 * space, so a `top-right` stamp on a `/Rotate 90` page has to be moved into the
 * page-space corner the reader sees as top right.
 */
function anchorRect(
  page: PDFPage,
  anchor: Anchor,
  width: number,
  aspect: number,
  notes: string[],
): PageBox {
  const frame = frameOf(page);
  const wanted = bounded(notes, 'Stamp width', width, { min: 20, max: 600, unit: 'pt' });
  const boxWidth = Math.min(wanted, Math.max(24, frame.width - 24));
  if (boxWidth !== wanted) {
    note(notes, `A ${Math.round(wanted)} pt stamp does not fit a ${Math.round(frame.width)} pt wide page; it was drawn ${Math.round(boxWidth)} pt wide.`);
  }
  const height = boxWidth * aspect;
  const run = placeRun(frame, boxWidth, height, 0, anchor, 18);
  return toUserRect(frame, { x: run.x, y: run.y, width: boxWidth, height });
}

/**
 * A displayed-space grid of tile origins, capped so a tight spacing on a big
 * sheet cannot ask for thousands of draws per page (E7/E15).
 *
 * `bounds` is the mark's own *turned* footprint, given as the offsets a rotated
 * run occupies around its draw point. The grid stops where a whole mark still
 * fits inside the visible page and every origin is shifted by the footprint's own
 * lower corner, so the last column and row are not cut by the crop box (measured
 * before: ink to 0.002 and 1.000 of the width, 1 083 ink px in the last two pixel
 * columns and rows of a 420×595 sheet). The leftover is split evenly so the
 * pattern is anchored rather than pinned to the corner, and a mark bigger than
 * the page is reported instead of overhanging in silence.
 */
function tilePoints(
  frame: PageFrame,
  stepX: number,
  stepY: number,
  bounds: { minX: number; minY: number; width: number; height: number },
  notes: string[],
): { x: number; y: number }[] {
  const dx = Math.max(24, stepX);
  const dy = Math.max(24, stepY);
  const planned = Math.ceil(frame.width / dx) * Math.ceil(frame.height / dy);
  if (planned > MAX_TILES) {
    note(notes, `This spacing would repeat the watermark ${planned} times per page; it is limited to ${MAX_TILES} repeats.`);
  }
  if (bounds.width > frame.width + 0.5 || bounds.height > frame.height + 0.5) {
    note(notes, `A single mark is ${Math.round(bounds.width)}×${Math.round(bounds.height)} pt on a ${Math.round(frame.width)}×${Math.round(frame.height)} pt page, so the pattern still runs past the edges.`);
  }
  const limitX = Math.max(0, frame.width - bounds.width);
  const limitY = Math.max(0, frame.height - bounds.height);
  const out: { x: number; y: number }[] = [];
  for (let y = (limitY % dy) / 2; y <= limitY && out.length < MAX_TILES; y += dy) {
    for (let x = (limitX % dx) / 2; x <= limitX && out.length < MAX_TILES; x += dx) out.push({ x, y });
  }
  return out;
}

/** Draw one text run at a point in *displayed* coordinates (E9). */
async function stampText(
  page: PDFPage,
  text: string,
  at: { x: number; y: number },
  options: { style: FaceStyle; opacity: number; rotation: number },
): Promise<void> {
  const frame = frameOf(page);
  const origin = toUserSpace(frame, at.x, at.y);
  await drawTextU(page, {
    text,
    x: origin.x,
    y: origin.y,
    size: options.style.size,
    color: faceColor(options.style.color),
    bold: options.style.bold,
    italic: options.style.italic,
    // The family the model names, so a tiled watermark in the bundled face is the
    // same face a single watermark gets — not whichever one WinAnsi happened to allow.
    fontFamily: options.style.fontFamily || undefined,
    opacity: options.opacity,
    rotation: options.rotation + frame.rotation,
  });
}

function expand(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
}

function formatNumber(value: number, style: string, width = 1): string {
  // `toRoman`/`toLetters` are core's — the same functions that render a page
  // label's preview, so a stamped folio and `/PageLabels` cannot drift into two
  // spellings of one number. Both are reached here only with a positive integer:
  // decimal and padded never call them, and the roman/letter clamp above floors
  // the first number at 1.
  if (style === 'roman-upper') return toRoman(value);
  if (style === 'roman-lower') return toRoman(value).toLowerCase();
  if (style === 'letters') return toLetters(value);
  // The picker shows "01, 02, 03", so the padding is the width this run needs —
  // never fewer than two digits. A hard-coded three drew "Page 001 of 004" on a
  // four-sheet file.
  if (style === 'padded') return String(value).padStart(width, '0');
  return String(value);
}

/** The tokens `format` expands; anything else is printed standing and admitted. */
const BATES_TOKENS = ['n', 'page', 'total', 'prefix', 'date', 'time'];

/**
 * Admit every token of `format` this tool does not know, once each.
 *
 * `expand` leaves an unknown token in the output verbatim, which is the right
 * behaviour — the operator sees the typo on the sheet — but on its own it is
 * silent: whole productions have gone out carrying `{foo}` with nothing on the
 * card to say the pattern was half read.
 */
function noteUnknownTokens(format: string, notes: string[]): void {
  for (const match of format.matchAll(/\{(\w+)\}/g)) {
    if (!BATES_TOKENS.includes(match[1]!)) {
      note(notes, `“{${match[1]}}” is not a token, so it is printed as it stands on every stamp.`);
    }
  }
}

const LABEL_STYLE_NAMES: Record<string, 'D' | 'R' | 'r' | 'A' | 'a' | ''> = {
  decimal: 'D',
  D: 'D',
  roman: 'r',
  r: 'r',
  Roman: 'R',
  R: 'R',
  romancaps: 'R',
  alpha: 'a',
  a: 'a',
  Alpha: 'A',
  A: 'A',
  alphacaps: 'A',
  letters: 'a',
  none: '',
};

interface LabelRange {
  start: number;
  end: number;
  /** The end page the user typed, before the document's length trimmed it. */
  askedEnd: number;
  style: 'D' | 'R' | 'r' | 'A' | 'a' | '';
  prefix?: string;
  firstPageNumber?: number;
}

/**
 * The largest page number a `/St` entry survives being.
 *
 * Measured on the bytes `1-8 decimal 9999999999999999999999` produces: pikepdf/qpdf
 * hands back a catalogue with **no `/PageLabels` at all**, MuPDF reads the range as
 * `1864712049423024128` (the digits wrapped through 64 bits) and pypdf keeps the
 * 23-digit number, while this app's own preview collapses every sheet onto `1e+22`
 * because a JavaScript number cannot count past 2^53 by ones. A start beyond a
 * signed 32-bit int is therefore not a page number any reader agrees on, and the
 * one place it can still be refused is here.
 */
const MAX_LABEL_START = 2147483647;

function parseLabelRanges(
  raw: string,
  total: number,
  notes: string[],
): LabelRange[] {
  const out: LabelRange[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s*-\s*(\d+)\s+(\w+)(?:\s+(\d+))?(?:\s+(\S+))?\s*$/.exec(line);
    if (!match) {
      note(notes, `"${line.trim()}" was not read — use "start-end style", for example "1-3 roman 1".`);
      continue;
    }
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (to < from) {
      note(notes, `"${line.trim()}" runs backwards: page ${from} comes after page ${to}.`);
      continue;
    }
    // Page 0 is the one number this grammar spells legally and the range writer
    // cannot place: `start = from - 1` goes negative and core's validation throws,
    // so a whole run used to stop on core's sentence — "Page-label ranges need a
    // whole, non-negative start page" — which names no line, describes a 0 as
    // negative, and took every legal line in the box down with it.
    if (from < 1) {
      note(notes, `"${line.trim()}" starts at page ${from}, but the first page of this document is page 1.`);
      continue;
    }
    if (from > total) {
      note(notes, `"${line.trim()}" starts at page ${from}, but this document has ${countLabel(total, 'page')}.`);
      continue;
    }
    const first = match[4] ? Number(match[4]) : undefined;
    if (first !== undefined && (!Number.isSafeInteger(first) || first > MAX_LABEL_START)) {
      note(notes, `"${line.trim()}" starts at ${match[4]}, but a page label holds at most ${MAX_LABEL_START} — larger numbers are wrapped or dropped by readers — so it was not read.`);
      continue;
    }
    // The spelling the user typed decides upper-case from lower-case: the help
    // lists `roman` and `Roman` as different styles, so folding the case made
    // "Roman" produce i, ii, iii.
    const style = LABEL_STYLE_NAMES[match[3]] ?? LABEL_STYLE_NAMES[match[3].toLowerCase()];
    if (style === undefined) {
      note(notes, `"${match[3]}" is not a label style, so "${line.trim()}" was read as decimal. Use decimal, roman, Roman, alpha, Alpha or none.`);
    }
    const start = from - 1;
    if (out.some((range) => range.start === start)) {
      note(notes, `Two ranges start at page ${from}; the first one wins, so "${line.trim()}" was ignored.`);
      continue;
    }
    out.push({
      start,
      end: Math.min(to, total) - 1,
      // What the user asked for, kept apart from what the document can hold:
      // a range typed `1-3` on a 2-page file has to say so out loud.
      askedEnd: to,
      style: style ?? 'D',
      firstPageNumber: first,
      prefix: match[5],
    });
  }
  out.sort((a, b) => a.start - b.start);
  // A label is start-based in PDF, so the end page a user typed is only ever
  // honoured by whatever comes after the range — the next line, or the last sheet.
  // The reason has to name the thing that actually ended it: both sentences below
  // used to be chosen by one arithmetic test, which printed "PDF labels last until
  // the next range starts" for a *last* line no later range ever cut short
  // (`1-3 roman 1` + `4-99 decimal 1` on 8 sheets) and "this document has 8 pages"
  // for a range the next line stopped four sheets early (`1-2 roman 1` + `5-8 …`).
  for (let i = 0; i < out.length; i++) {
    const next = i + 1 < out.length ? out[i + 1] : undefined;
    const reached = (next ? next.start : total) - 1;
    if (reached === out[i].askedEnd - 1) continue;
    const short = reached + 1 < out[i].askedEnd;
    const reason = short
      ? (next ? `the next range starts at page ${next.start + 1}` : `this document has ${countLabel(total, 'page')}`)
      : (next
        ? `PDF labels last until the next range starts, at page ${next.start + 1}`
        : `nothing starts after it, so it lasts to the end of the document, page ${total}`);
    note(notes, `The labels from page ${out[i].start + 1} run to page ${reached + 1}, not page ${out[i].askedEnd}: ${reason}.`);
  }
  return out;
}

function outlineToText(nodes: OutlineNode[], depth = 0): string {
  return nodes
    .map((node) => `${'  '.repeat(depth)}${node.title}${node.page !== null ? ` :: ${node.page + 1}` : ''}\n${node.children ? outlineToText(node.children, depth + 1) : ''}`)
    .join('');
}

/** Bookmark tree size, for an honest "what did I just write" message. */
function countOutline(nodes: OutlineNode[]): { total: number; targetless: number } {
  let total = 0;
  let targetless = 0;
  for (const node of nodes) {
    total += 1;
    if (node.page === null) targetless += 1;
    if (node.children) {
      const inner = countOutline(node.children);
      total += inner.total;
      targetless += inner.targetless;
    }
  }
  return { total, targetless };
}

/**
 * Split a typed line into its title and its optional page suffix.
 *
 * The separator is the **last** `::`, and only when what follows it is a page
 * number or nothing: splitting on the first one made a title containing `::`
 * lose everything from there — `A :: B :: 3` was written as `A`, page 3 gone,
 * with only a note that `B` was not a page. A line whose tail is not a number is
 * all title, and `mistake` carries the tail when it looks like an attempted one
 * so the caller can say so without nagging about `Notes :: Revised`.
 */
function splitPageSuffix(line: string): { title: string; page?: number; mistake?: string } {
  const at = line.lastIndexOf('::');
  if (at < 0) return { title: line };
  const tail = line.slice(at + 2).trim();
  const title = line.slice(0, at);
  if (tail !== '' && !/^-?\d+(?:\.\d+)?$/.test(tail)) {
    return { title: line, mistake: /\d/.test(tail) ? tail : undefined };
  }
  return { title, page: tail === '' ? undefined : Number(tail) };
}

function textToOutline(raw: string, total: number, notes: string[]): OutlineNode[] {
  const root: OutlineNode[] = [];
  const stack: { depth: number; node: OutlineNode }[] = [];
  let offDocument = 0;
  let blank = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const depth = /^\s*/.exec(line)?.[0].replace(/\t/g, '  ').length ?? 0;
    const { title, page: asked, mistake } = splitPageSuffix(line);
    if (!title.trim()) {
      blank += 1;
      continue;
    }
    if (mistake !== undefined) {
      note(notes, `"${mistake}" is not a page number, so "${title.trim()}" is written as a title with no link.`);
    }
    // A destination must be a whole page: `writeOutline` throws on 2.5, and the
    // sentence it threw ("points at page 2.5, but this document has 4 pages")
    // named the wrong thing. Round it here and say which number was used.
    if (asked !== undefined && !Number.isInteger(asked)) {
      note(notes, `"${asked}" is not a whole page number, so page ${Math.round(asked)} was used.`);
    }
    const page = asked === undefined ? NaN : Math.round(asked) - 1;
    if (Number.isFinite(page) && (page < 0 || page >= total)) offDocument += 1;
    const node: OutlineNode = {
      title: title.trim(),
      page: Number.isFinite(page) && page >= 0 && page < total ? page : null,
      children: [],
    };
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack[stack.length - 1]?.node;
    if (parent) (parent.children ??= []).push(node);
    else root.push(node);
    stack.push({ depth, node });
  }
  if (offDocument > 0) {
    note(notes, `${countLabel(offDocument, 'entry', 'entries')} named a page outside this ${total}-page document, so it opens nothing when clicked.`);
  }
  if (blank > 0) {
    note(notes, `${countLabel(blank, 'line', 'lines')} had no title and ${blank === 1 ? 'was' : 'were'} skipped.`);
  }
  return root;
}

