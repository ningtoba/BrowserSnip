/**
 * One layout for the annotation editor's type — the file's, not a preview's.
 *
 * A text box and a stamp label are laid out by `text-editor/draw.prepareTextObject`
 * with the faces the exported file will really carry, and **both** consumers read
 * that one result: the overlay paints the returned lines at the returned
 * coordinates, and `core/annotations.addAnnotation` writes the same lines into the
 * appearance stream. There is no CSS wrap anywhere in the path, so the line breaks
 * the user saw are the line breaks the file gets.
 *
 * The overlay runs before an export exists, so it measures against a scratch
 * document (`measureDocument` below). That is not a second metrics source: the
 * scratch face is embedded from the same bytes by the same resolver, and
 * `widthOfTextAtSize` is a property of the face, not of the document. The test for
 * that claim is in `tests/pdf/annotation-text-style.test.ts` — the same block laid
 * out through two documents must break in the same places.
 */
import type { PDFDocument, PDFFont } from '@/lib/pdf/core/doc';
import { fitStampSize, freeTextInset, type LaidOutLine, type StyledText } from '@/lib/pdf/core/annotations';
import { carriesPosture, type FaceStyle } from '@/lib/pdf/core/text-style';
import { prepareTextObject } from '../text-editor/draw';
import { resolveFace } from '../text-editor/faces';
import {
  DEFAULT_STYLE,
  clampStyle,
  paragraphsFromText,
  type EditorStyle,
  type TextObject,
} from '../text-editor/model';

/** A text box or a stamp label: the two marks this editor sets type into. */
export type TextMarkKind = 'freetext' | 'stamp';

let scratch: PDFDocument | null = null;

/**
 * A document that exists only to measure.
 *
 * Created once per tab, never saved. Faces are cached per document, so this holds
 * one embedded copy of each face the user has styled text with while the tab is
 * open — the same faces the export embeds again in the real document.
 */
export async function measureDocument(): Promise<PDFDocument> {
  if (scratch) return scratch;
  const { newPDF, withFontkit } = await import('@/lib/pdf/core/doc');
  scratch = await withFontkit(await newPDF());
  return scratch;
}

/**
 * The block style the layout engine reads.
 *
 * `justify` is only passed through when the surface's writer can stretch a line
 * across a measure — the text box can, a stamp label cannot — so a style that
 * travelled from another surface degrades to flush-left instead of pretending.
 */
export function layoutStyle(style: FaceStyle, allowJustify = true): EditorStyle {
  const align = style.align === 'justify' && !allowJustify ? 'left' : style.align;
  return {
    ...DEFAULT_STYLE,
    fontFamily: style.fontFamily,
    size: clampStyle('size', style.size),
    color: style.color,
    bold: style.bold,
    italic: style.italic,
    align,
    lineSpacing: clampStyle('lineSpacing', style.lineSpacing),
    // A mark's box is its own; paragraph spacing belongs to the block editor.
    spaceBefore: 0,
    spaceAfter: 0,
  };
}

/** The shape `prepareTextObject` wants for a mark of `width` points. */
function markTextObject(body: string, style: FaceStyle, width: number, kind: TextMarkKind): TextObject {
  return {
    id: `${kind}-layout`,
    page: 1,
    kind: 'text',
    box: { x: 0, y: 0, width: Math.max(width, 8), height: 8 },
    rotation: 0,
    flipH: false,
    flipV: false,
    z: 0,
    alt: '',
    state: 'draft',
    paragraphs: paragraphsFromText(body),
    style: layoutStyle(style, kind === 'freetext'),
    deletion: [],
    paperColor: style.color,
    sourceId: '',
    fromInvisibleLayer: false,
  };
}

export interface MarkTextLayout {
  /** Lines in the appearance's own space: x from the left, baseline from the bottom. */
  lines: LaidOutLine[];
  /** The face the file will carry, embedded in the document `doc` is. */
  font: PDFFont;
  /** The family that answered, which is not always the one the style named. */
  familyUsed: string;
  /** Points; the size the lines are drawn at — a stamp may be smaller than asked. */
  size: number;
  /** True when a stamp label was shrunk to fit the box the user dragged. */
  shrank: boolean;
  /** Points the text needs, so a box that is too short can be reported. */
  contentHeight: number;
  /** What the answering family was not, in a sentence: a substitution or a refusal. */
  note?: string;
}

/**
 * Lay `body` out in `style` inside a mark `width` × `height` points.
 *
 * A text box fills its box from the top inset down, at the alignment and line
 * height the style carries. A stamp label is one line, centred in the box and
 * shrunk to fit if the size asked for will not go — the same `fitStampSize` answer
 * `core/annotations.stampOps` writes, so the box on screen and the box in the file
 * shrink together or not at all.
 */
export async function layoutMarkText(
  doc: PDFDocument,
  args: { kind: TextMarkKind; body: string; style: FaceStyle; width: number; height: number },
): Promise<MarkTextLayout> {
  const { kind, body, style, width, height } = args;
  const inset = (size: number) => round(freeTextInset(size));
  const blockStyle = layoutStyle(style, kind === 'freetext');
  const prepared = await prepareTextObject(
    doc,
    markTextObject(body, style, width - inset(style.size) * 2, kind),
  );
  // The face the layout measured with, looked up the same way `draw.ts` looked it
  // up — the per-document cache means this is the same embedded object, not a copy.
  const face = await resolveFace(doc, blockStyle, body);
  const font = face.font;
  const size = round(Math.max(style.size, 1));

  if (kind === 'stamp') {
    const label = body;
    const available = Math.max(width - 6, 1);
    const natural = font.widthOfTextAtSize(label, size);
    const fitted = natural > available ? shrinkToFit(font, label, size, available) : size;
    const drawn = fitStampSize(size, fitted);
    const textWidth = font.widthOfTextAtSize(label, drawn);
    const pad = inset(drawn);
    const align = style.align === 'right' ? 'right' : style.align === 'left' ? 'left' : 'center';
    const x =
      align === 'left'
        ? round(pad)
        : align === 'right'
          ? round(Math.max(width - pad - textWidth, pad))
          : round(Math.max((width - textWidth) / 2, 2));
    return {
      lines:
        label === ''
          ? []
          : [{ text: label, x, baseline: round(Math.max(height / 2 - drawn / 2, 2)), size: drawn }],
      font,
      familyUsed: face.familyUsed,
      size: drawn,
      shrank: drawn < size,
      contentHeight: drawn,
      note: face.note,
    };
  }

  const top = Math.max(height - inset(size), 0);
  const lines: LaidOutLine[] = [];
  for (const line of prepared.layout.lines) {
    const first = line.pieces[0];
    const runSize = first?.run.size ?? size;
    lines.push({
      text: line.text,
      x: round(inset(size) + (first?.x ?? 0)),
      baseline: round(top - line.baseline),
      size: round(runSize),
    });
  }
  return {
    lines,
    font,
    familyUsed: face.familyUsed,
    size,
    shrank: false,
    contentHeight: round(prepared.layout.height),
    note: face.note,
  };
}

/** The largest size at or below `from` at which `label` still fits `width`. */
function shrinkToFit(font: PDFFont, label: string, from: number, width: number): number {
  let size = Math.max(from, 1);
  while (size > 1 && font.widthOfTextAtSize(label, size) > width) {
    size -= Math.max(0.25, size * 0.05);
  }
  return round(Math.max(size, 1));
}

/** What `addAnnotation` needs on the spec for this mark. */
export function styledText(layout: MarkTextLayout, style: FaceStyle): StyledText {
  return { style: { ...style, size: layout.size }, font: layout.font, lines: layout.lines };
}

/**
 * What a style claims that this family cannot keep for this text, in a sentence.
 *
 * The control set normally refuses the posture before it can be set; this is the
 * back-stop for a style that arrived from elsewhere — a mark drawn under another
 * family, a value restored from storage — so the export can say the run is written
 * upright rather than let the user find out from the file.
 */
export function postureNotice(style: FaceStyle, text: string): string | null {
  if (!style.italic) return null;
  if (carriesPosture(style.fontFamily, 'italic', text)) return null;
  return 'This family has no italic face this app can embed, so the text is written upright.';
}

const round = (value: number): number => Math.round(value * 100) / 100;

/* ------------------------------------------------------------------ *
 * The two callers: the overlay's preview, and the export              *
 * ------------------------------------------------------------------ *
   Both go through `layoutMarkText`, so the lines on the page are computed the same
   way as the lines in the file. What differs is only the document the faces are
   embedded in — a scratch one for the preview, the copy being exported for the
   file — and an embedded face's widths are a property of its bytes, not of its
   document. */

import type { AnnotationSpec } from '@/lib/pdf/core/annotations';

/** One mark's laid-out text, as the overlay needs it. */
export interface MarkPreview {
  lines: LaidOutLine[];
  size: number;
  /** True when a stamp label was shrunk to fit its box. */
  shrank: boolean;
  /** What the answering family was not, or a posture that could not be kept. */
  note?: string;
}

/** The body a styled mark writes: a box's words, or a stamp's label. */
function markBody(spec: AnnotationSpec): { kind: TextMarkKind; body: string } | null {
  if (spec.kind === 'FreeText') return { kind: 'freetext', body: spec.freeText?.text ?? '' };
  if (spec.kind === 'Stamp' && spec.stampName && !spec.stampImage && !spec.stampXObject) {
    return { kind: 'stamp', body: spec.stampName };
  }
  return null;
}

/**
 * Lay out every styled spec in `specs` against `doc` and attach the result.
 *
 * Returns one line per mark whose face or size came out different from what the
 * style asked for, in the words the answering face used — the export shows these
 * rather than letting the user find the difference in the file.
 */
export async function prepareSpecTexts(doc: PDFDocument, specs: AnnotationSpec[]): Promise<string[]> {
  const notices: string[] = [];
  for (const spec of specs) {
    const style = spec.textStyle?.style;
    const body = markBody(spec);
    if (!style || !body || body.body.length === 0) continue;
    const layout = await layoutMarkText(doc, {
      ...body,
      style,
      width: spec.rect.width,
      height: spec.rect.height,
    });
    spec.textStyle = styledText(layout, style);
    if (layout.note) notices.push(layout.note);
    if (layout.shrank) {
      notices.push(
        `The ${body.kind === 'stamp' ? 'stamp label' : 'text'} was drawn at ${layout.size} pt to fit the box, not the ${style.size} pt asked for.`,
      );
    }
  }
  return notices;
}

/**
 * The same layout for the overlay, against the measuring document.
 *
 * Keyed by whatever the caller addresses a mark by, so the editor can hand the
 * overlay a `Record<id, MarkPreview>` and repaint it as the style or the words
 * change.
 */
export async function previewMarkTexts<T extends { id: string }>(
  marks: T[],
  bodyOf: (
    mark: T,
  ) => { kind: TextMarkKind; body: string; style: FaceStyle; width: number; height: number } | null,
): Promise<Record<string, MarkPreview>> {
  const out: Record<string, MarkPreview> = {};
  if (marks.length === 0) return out;
  const doc = await measureDocument();
  await Promise.all(
    marks.map(async (mark) => {
      const args = bodyOf(mark);
      if (!args || args.body.length === 0) return;
      try {
        const layout = await layoutMarkText(doc, args);
        out[mark.id] = { lines: layout.lines, size: layout.size, shrank: layout.shrank, note: layout.note };
      } catch {
        // A face that will not download leaves the mark unpreviewed rather than
        // breaking the page: the export will name the failure where it matters.
      }
    }),
  );
  return out;
}
