/**
 * Writing edited blocks back into a PDF with the MIT client-side engine.
 *
 * The honest model (see the header of `TextEditor.tsx`): this is
 * **delete-and-rewrite**, not in-place glyph surgery. `core/content`'s
 * `removeTextInRects` really does drop the text-showing operators inside the
 * block's rectangles — the old words stop existing, stop being selectable and
 * stop being found by Ctrl-F — and the edited block is then drawn back with its
 * own operators at the same origin. Nothing is painted over the top to hide the
 * old text, which is what separates this from an overlay.
 *
 * Why raw operators instead of `core/fonts.drawTextU`: the format inspector
 * exposes character spacing, word spacing, horizontal scale (`Tz`), text outline
 * (`Tr` + `RG`/`w`), superscript/subscript (`Ts`) and rotated pages. Those are
 * text-state and text-matrix concerns that `drawTextU` cannot express. Face
 * selection is still `core/fonts` (`getFont`, via `faces.ts`) and measurement is
 * the same `font.widthOfTextAtSize` that `wrapText` uses, so what the user saw is
 * what the file gets.
 *
 * Glyph geometry comes from `model.layoutBlock` — the identical call that sizes
 * and lays out the on-screen editor box.
 */
import {
  TextRenderingMode,
  beginText,
  concatTransformationMatrix,
  drawObject,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setCharacterSqueeze,
  setCharacterSpacing,
  setFillingColor,
  setFontAndSize,
  setGraphicsState,
  setLineWidth,
  setStrokingColor,
  setTextMatrix,
  setTextRenderingMode,
  setTextRise,
  setWordSpacing,
  showText,
} from '@maxwbh/pdf-lib';
import type { PDFDocument, PDFImage, PDFPage } from '@/lib/pdf/core/doc';import { PDFName, rgb } from '@/lib/pdf/core/doc';
import { cropBox } from '@/lib/pdf/core/pages';
import type { QuadRect, TopLeftBox, PageFrame } from '@/lib/pdf/core/tables';
import { removeTextInRects, textRects, makeOp, operand } from '@/lib/pdf/core/content';
import type { RemovalReason, SourceFont } from '@/lib/pdf/core/content';
import { toEmbeddableImage } from '@/lib/pdf/core/images';
import { prepareTextForDirection } from '@/lib/pdf/core/fonts';
import { PDFHexString } from '@/lib/pdf/core/doc';
import { chooseFace, colorOf, faceCacheKey, type EditFace, type SubstitutionReason } from './faces';
import {
  advanceOf,
  applyMatrix,
  baseInline,
  imageMatrix,
  inlineFor,
  layoutBlock,
  pointInObject,
  textMatrixForRun,
  viewerBoxToUserSpace,
  viewerToUserMatrix,
  type EditObject,
  type ImageObject,
  type InlineStyle,
  type LayoutLine,
  type LayoutResult,
  type Measure,
  type PatchObject,
  type ResolvedInline,
  type TextObject,
} from './model';

/** Faces one block needs, keyed by `faces.faceCacheKey(style, runText)`. */
export type FaceMap = Map<string, EditFace>;

export interface PreparedObject {
  object: TextObject;
  layout: LayoutResult;
  faces: FaceMap;
  /**
   * Blocks written in a face other than the page's own, with the reason.
   * A subsubset that lacks a typed character is the common one, and the user is
   * told rather than left to notice.
   */
  substitutions: { from: string; to: string; reason: SubstitutionReason }[];
  /**
   * True when the edited text no longer fits the source block's line structure:
   * it is re-flowed, so it may sit lower or wider than the words it replaced.
   */
  reflowed: boolean;
}

export interface DeleteReport {
  /** Text-showing operators the engine removed. */
  removed: number;
  /** Glyph runs still inside the rectangles afterwards (should be 0). */
  leftover: number;
  /** Real image content sits behind the block; no operator edit clears pixels. */
  needsRasterFallback: boolean;
  /** The block's text was not in the page's own content stream at all. */
  nothingRemoved: boolean;
  /** Why anything fell short, named by the engine that measured it. */
  reasons: RemovalReason[];
  /** The face each block's runs were set in, keyed by the block's id. */
  faces: Record<string, SourceFont[]>;
  /** Per block, the rects of the words that survived — what a patch must cover. */
  leftoverRects: Record<string, QuadRect[]>;
}

/** Unrotated page frame from the file itself, in PDF user space. */
export function frameOfPage(page: PDFPage): PageFrame {
  const box = cropBox(page);
  return {
    x0: box.x,
    y0: box.y,
    width: box.width,
    height: box.height,
    rotation: page.getRotation().angle,
  };
}

/**
 * Remove the original runs under `boxes` (viewer space). Call this for every
 * edited block *before* drawing anything, so a later block can never delete an
 * earlier block's fresh text, and so the leftover check cannot see the rewrite.
 */
export function deleteOriginalText(
  page: PDFPage,
  groups: { id: string; boxes: TopLeftBox[] }[],
  frame: PageFrame,
): DeleteReport {
  const rects: QuadRect[] = [];
  const owners: string[] = [];
  for (const group of groups) {
    for (const box of group.boxes) {
      rects.push(viewerBoxToUserSpace(box, frame));
      owners.push(group.id);
    }
  }
  if (rects.length === 0) {
    return {
      removed: 0,
      leftover: 0,
      needsRasterFallback: false,
      nothingRemoved: false,
      reasons: [],
      faces: {},
      leftoverRects: {},
    };
  }
  const result = removeTextInRects(page, rects, { owners });
  return {
    removed: result.removedGlyphRuns,
    leftover: result.leftover,
    needsRasterFallback: result.needsRasterFallback,
    nothingRemoved: result.removedGlyphRuns === 0,
    reasons: result.reasons,
    faces: result.faces,
    leftoverRects: result.leftoverRects,
  };
}

/**
 * Lay an edited block out with the faces it will really be written in, so the
 * line breaks the user saw are the line breaks the file gets.
 */
export async function prepareTextObject(
  doc: PDFDocument,
  object: TextObject,
  sources: SourceFont[] = [],
): Promise<PreparedObject> {
  const { faces, substitutions } = await resolveFaces(doc, object, sources);
  const layout = layoutBlock(object.paragraphs, object.style, {
    measure: measureWith(faces),
    width: Math.max(8, object.box.width),
  });
  return {
    object,
    layout,
    faces,
    substitutions,
    // The source block's line count is the shape the page had; more lines than
    // that means the text no longer fits it, which the report has to say.
    reflowed: object.deletion.length > 0 && layout.lines.length !== object.deletion.length,
  };
}

async function resolveFaces(
  doc: PDFDocument,
  object: TextObject,
  sources: SourceFont[],
): Promise<{ faces: FaceMap; substitutions: PreparedObject['substitutions'] }> {
  const faces: FaceMap = new Map();
  const substitutions: PreparedObject['substitutions'] = [];
  const seen = new Set<string>();
  // Two keys per face. The style+script key is what a run asks for; the
  // text-specific key exists because **whether a face can spell the text is a
  // property of the text**: a subsubset that covers the body sample may lack the
  // character the user typed, and measuring the block in a face it cannot write
  // would lay out words the file then drops.
  const want = async (style: InlineStyle, text: string) => {
    const key = faceCacheKey(style, text);
    const exact = `${key}@${text}`;
    if (faces.has(exact)) return;
    const shared = faces.get(key);
    if (shared && shared.missingFor(text).length === 0) {
      faces.set(exact, shared);
      return;
    }
    const choice = await chooseFace(doc, style, text, sources);
    faces.set(exact, choice.face);
    if (!shared || choice.face.fromSource) faces.set(key, choice.face);
    if (choice.substitution && !seen.has(exact)) {
      seen.add(exact);
      substitutions.push(choice.substitution);
    }
  };

  // A body-size sample first: every fallback path can then find *a* face.
  await want(object.style, 'Ag');
  for (const paragraph of object.paragraphs) {
    const style = { ...object.style, ...paragraph.style };
    if (paragraph.list !== 'none') {
      await want(baseInline(style), paragraph.list === 'bullet' ? '\u2022' : '1.');
    }
    for (const run of paragraph.runs) {
      if (run.text.trim().length === 0) continue;
      await want(inlineFor(run, style), run.text);
    }
  }
  return { faces, substitutions };
}

function measureWith(faces: FaceMap): Measure {
  return (text, run, sourceText) => {
    const face = faceOf(faces, run, sourceText);
    if (!face) return [...text].length * run.size * 0.5;
    return advanceOf(face.widthOfText(text, run.size), text, run);
  };
}

function faceOf(faces: FaceMap, style: InlineStyle, sourceText: string): EditFace | undefined {
  const key = faceCacheKey(style, sourceText);
  const forThisText = faces.get(`${key}@${sourceText}`);
  if (forThisText) return forThisText;
  const exact = faces.get(key);
  if (exact) return exact;
  // Same family and posture, different script classification: prefer any face
  // already embedded for that style before falling back to the sample face.
  const prefix = `${style.fontFamily || 'auto'}|${style.bold ? 'b' : ''}${style.italic ? 'i' : ''}#`;
  for (const [key, font] of faces) {
    if (key.startsWith(prefix)) return font;
  }
  return faces.values().next().value;
}

/** Resource bookkeeping shared by every write on one page. */
export interface PageWriters {
  fontKeys: Map<string, PDFName>;
  opacityKey: (alpha: number) => PDFName | undefined;
}

export function pageWriters(page: PDFPage): PageWriters {
  const fontKeys = new Map<string, PDFName>();
  const opacityKeys = new Map<string, PDFName>();
  return {
    fontKeys,
    opacityKey(alpha: number) {
      if (!(alpha < 1)) return undefined;
      const key = alpha.toFixed(3);
      let name = opacityKeys.get(key);
      if (!name) {
        name = page.node.newExtGState('GS', page.doc.context.obj({ ca: alpha, CA: alpha }));
        opacityKeys.set(key, name);
      }
      return name;
    },
  };
}

/** Draw one prepared block. Text is selectable and searchable in the output. */
export function writeTextObject(
  page: PDFPage,
  frame: PageFrame,
  prepared: PreparedObject,
  writers: PageWriters,
): void {
  const { object, layout, faces } = prepared;
  for (const line of layout.lines) {
    if (line.marker) {
      const markerParagraph = line.pieces[0]?.source.paragraph ?? 0;
      const style = baseInline({ ...object.style, ...paragraphStyle(object, markerParagraph) });
      const face = faceOf(faces, style, line.marker);
      if (face) {
        writeRun(page, frame, object, {
          text: line.marker,
          anchorX: line.indent,
          width: 0,
          line,
          face,
          style,
          rise: 0,
          writers,
        });
      }
    }
    for (const piece of line.pieces) {
      const run = object.paragraphs[piece.source.paragraph]?.runs[piece.source.run];
      if (!run) continue;
      const style = inlineFor(run, { ...object.style, ...paragraphStyle(object, piece.source.paragraph) });
      const face = faceOf(faces, style, run.text);
      if (!face) continue;
      writeRun(page, frame, object, {
        text: piece.text,
        anchorX: piece.x,
        width: piece.width,
        line,
        face,
        style,
        rise: style.rise,
        writers,
      });
      const size = style.size;
      if (style.underline) drawRule(page, frame, object, piece, line, size * 0.12, size, style);
      if (style.strike) drawRule(page, frame, object, piece, line, -size * 0.28, size, style);
    }
  }
}

function paragraphStyle(object: TextObject, index: number) {
  return object.paragraphs[index]?.style ?? {};
}

interface RunWrite {
  text: string;
  /** Block-relative x of the baseline start, points. */
  anchorX: number;
  width: number;
  line: LayoutLine;
  face: EditFace;
  style: ResolvedInline;
  rise: number;
  writers: PageWriters;
}

function writeRun(page: PDFPage, frame: PageFrame, object: TextObject, run: RunWrite): void {
  if (run.text.length === 0) return;
  const { style, line, face } = run;
  const anchor = { x: object.box.x + run.anchorX, y: object.box.y + line.baseline };
  const tm = textMatrixForRun(anchor, object.rotation, frame, object.box);
  const outline = style.outlineWidth;
  const gs = run.writers.opacityKey(object.style.opacity);
  // RTL runs are stored visually reversed, exactly like `core/fonts`, so a
  // Hebrew or Arabic block reads the same on screen and in the file.
  const text = prepareTextForDirection(run.text, style.direction);
  const fontKey = ensureFontKey(page, face, run.writers.fontKeys);
  const codes = face.codes(text);
  if (!codes) return; // the face cannot spell it: nothing was promised otherwise

  if (face.source) {
    // The document's own font: write its codes directly, so the glyphs a viewer
    // paints are the ones the producer embedded.
    page.pushOperators(
      pushGraphicsState(),
      ...(gs ? [setGraphicsState(gs)] : []),
      setFillingColor(colorOf(style.color)),
      ...(outline > 0 ? [setStrokingColor(colorOf(style.outlineColor)), setLineWidth(outline)] : []),
      beginText(),
      ...showWithSourceFont(fontKey, style, line, run.rise, outline, codes, tm),
      endText(),
      popGraphicsState(),
    );
    return;
  }

  page.pushOperators(
    pushGraphicsState(),
    ...(gs ? [setGraphicsState(gs)] : []),
    setFillingColor(colorOf(style.color)),
    ...(outline > 0 ? [setStrokingColor(colorOf(style.outlineColor)), setLineWidth(outline)] : []),
    beginText(),
    setFontAndSize(fontKey, num(style.size)),
    setTextMatrix(tm[0], tm[1], tm[2], tm[3], tm[4], tm[5]),
    setCharacterSqueeze(num(style.horizontalScale)),
    setCharacterSpacing(num(style.charSpacing)),
    setWordSpacing(num(style.wordSpacing + line.extraWordSpacing)),
    setTextRise(num(run.rise)),
    setTextRenderingMode(outline > 0 ? TextRenderingMode.FillAndOutline : TextRenderingMode.Fill),
    showText(face.pdf!.encodeText(text)),
    endText(),
    popGraphicsState(),
  );
}

/**
 * The text-state operators for a run written in the page's own font.
 *
 * Same state as the pdf-lib path — `Tz`/`Tc`/`Tw`/`Ts`/`Tr` and the text matrix —
 * with the string written as the codes that font's encoding defines instead of
 * whatever pdf-lib's embedder would allocate.
 */
function showWithSourceFont(
  fontKey: PDFName,
  style: ResolvedInline,
  line: LayoutLine,
  rise: number,
  outline: number,
  codes: Uint8Array,
  tm: number[],
) {
  const hex = [...codes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    setFontAndSize(fontKey, num(style.size)),
    setTextMatrix(tm[0], tm[1], tm[2], tm[3], tm[4], tm[5]),
    setCharacterSqueeze(num(style.horizontalScale)),
    setCharacterSpacing(num(style.charSpacing)),
    setWordSpacing(num(style.wordSpacing + line.extraWordSpacing)),
    setTextRise(num(rise)),
    setTextRenderingMode(outline > 0 ? TextRenderingMode.FillAndOutline : TextRenderingMode.Fill),
    showText(PDFHexString.of(hex)),
  ];
}

function drawRule(
  page: PDFPage,
  frame: PageFrame,
  object: TextObject,
  piece: { x: number; width: number },
  line: LayoutLine,
  offset: number,
  size: number,
  style: ResolvedInline,
): void {
  if (!(piece.width > 0)) return;
  const start = pointInObject(object.box, object.rotation, frame, {
    x: object.box.x + piece.x,
    y: object.box.y + line.baseline + offset,
  });
  const end = pointInObject(object.box, object.rotation, frame, {
    x: object.box.x + piece.x + piece.width,
    y: object.box.y + line.baseline + offset,
  });
  page.drawLine({
    start,
    end,
    thickness: Math.max(0.2, size * 0.06),
    color: colorOf(style.color),
    opacity: object.style.opacity,
  });
}

/**
 * One `/Font` resource entry per page per face, not one per drawn run.
 *
 * A source face is registered under its own `/BaseFont` when the page reaches it
 * through a Form XObject's resources; a page that already names it simply keeps
 * the entry pdf-lib (or the producer) made, because `newFontDictionary` reuses a
 * key that already points at the same object.
 */
function ensureFontKey(page: PDFPage, face: EditFace, cache: Map<string, PDFName>): PDFName {
  const source = face.source;
  const ref = source ? (source.ref ?? page.doc.context.register(source.dict)) : face.pdf!.ref;
  const key = ref.toString();
  const known = cache.get(key);
  if (known) return known;
  const tag = (source ? source.baseFont : face.pdf!.name).replace(/^[^A-Za-z0-9]+/, '').slice(0, 24) || 'F';
  const created = page.node.newFontDictionary(tag, ref);
  cache.set(key, created);
  return created;
}

/** Embed and place one image object, honouring rotate and flip. */
export async function writeImageObject(
  doc: PDFDocument,
  page: PDFPage,
  frame: PageFrame,
  object: ImageObject,
  cache: Map<string, PDFImage>,
): Promise<void> {
  const cacheKey = `${object.id}:${object.bytes.byteLength}`;
  let image = cache.get(cacheKey);
  if (!image) {
    image = await toEmbeddableImage(doc, object.bytes, { mime: object.mime });
    cache.set(cacheKey, image);
  }
  const key = page.node.newXObject('Image', image.ref);
  const matrix = imageMatrix(
    object.box,
    { degrees: object.rotation, flipH: object.flipH, flipV: object.flipV },
    frame,
  );
  page.pushOperators(
    pushGraphicsState(),
    setFillingColor(rgb(1, 1, 1)),
    concatTransformationMatrix(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]),
    drawObject(key),
    popGraphicsState(),
  );
}

/**
 * Paint a cover patch over page content (see `model.PatchObject`): the producer's
 * pixels stay in the file, hidden behind a rectangle in the page's own colour.
 */
export function writePatchObject(page: PDFPage, frame: PageFrame, object: PatchObject): void {
  const rect = viewerBoxToUserSpace(object.box, frame);
  page.drawRectangle({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    color: colorOf(object.color),
  });
}

/** Why a block did not get the plain in-place rewrite it asked for. */
export interface CoverReport {
  id: string;
  /** Glyph-sized boxes painted over the words that could not be deleted. */
  boxes: TopLeftBox[];
  /** The colour they were painted in, sampled from the page behind the block. */
  color: string;
}

export interface ApplyOutcome {
  written: number;
  /** Blocks the built-in engine could not clean at all; the optional engine can. */
  failed: { id: string; reason: string }[];
  /** Blocks whose text survived deletion partially under the new text. */
  partial: { id: string; leftover: number }[];
  /** Blocks that sit on image content the engine cannot repaint. */
  raster: string[];
  /**
   * Blocks whose surviving words were **covered**, patch-sized to those words.
   * Different from `partial`, which only counts: a covered block has the patch
   * in the file, and the report has to say the words are hidden, not removed.
   */
  covered: CoverReport[];
  /** Blocks written in a face other than the page's own, naming both and why. */
  substituted: { id: string; from: string; to: string; reason: string }[];
  /** Blocks whose new text no longer fits the source line structure. */
  reflowed: string[];
  /**
   * Every piece the writer laid down, in the page's own displayed points: text,
   * the x and baseline it was written at, its size, and the face that paints it.
   * This is the writer's claim about the output — a checker compares it against
   * what the file really renders instead of re-deriving the layout and hoping.
   */
  placed: PlacedPiece[];
}

export interface PlacedPiece {
  id: string;
  page: number;
  text: string;
  /** Left edge of the piece, viewer space (rotated page, origin top-left), points. */
  x: number;
  /** Baseline, viewer space, points. */
  baseline: number;
  size: number;
  face: string;
  /** True when `face` is the font the page already used for this block. */
  fromSource: boolean;
}

/**
 * Write every edited object into an open document.
 *
 * Pass 1 deletes the original runs of every text block on the page; pass 2 draws
 * the edits in paint order. A block whose words could not be deleted is *not*
 * rewritten — that would be the doubled text this editor promises to avoid — and
 * is reported so the UI can point at the optional PyMuPDF path.
 */
export async function applyEdits(doc: PDFDocument, objects: EditObject[]): Promise<ApplyOutcome> {
  const byPage = new Map<number, EditObject[]>();
  for (const object of objects) {
    const list = byPage.get(object.page) ?? [];
    list.push(object);
    byPage.set(object.page, list);
  }

  const outcome: ApplyOutcome = {
    written: 0,
    failed: [],
    partial: [],
    raster: [],
    covered: [],
    substituted: [],
    reflowed: [],
    placed: [],
  };
  const images = new Map<string, PDFImage>();
  const reasonText = (reason: RemovalReason) => REMOVAL_REASON_TEXT[reason] ?? reason;

  for (const [page1, pageObjectsRaw] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    const index = page1 - 1;
    if (index < 0 || index >= doc.getPageCount()) continue;
    const page = doc.getPage(index);
    const frame = frameOfPage(page);
    const writers = pageWriters(page);
    // Paint order is the model's `z`, so "bring to front" means what it says.
    const pageObjects = [...pageObjectsRaw].sort((a, b) => a.z - b.z);

    const textObjects = pageObjects.filter((object): object is TextObject => object.kind === 'text');
    const withSource = textObjects.filter((object) => object.deletion.length > 0);
    const faces = new Map<string, SourceFont[]>();
    const leftovers = new Map<string, QuadRect[]>();
    if (withSource.length > 0) {
      const report = deleteOriginalText(
        page,
        withSource.map((object) => ({ id: object.id, boxes: object.deletion })),
        frame,
      );
      for (const [id, list] of Object.entries(report.faces)) faces.set(id, list);
      for (const [id, list] of Object.entries(report.leftoverRects)) leftovers.set(id, list);
      if (report.nothingRemoved) {
        for (const object of withSource) {
          outcome.failed.push({
            id: object.id,
            reason:
              `The built-in engine could not delete these words (${report.reasons.map(reasonText).join(', ') || 'no text was found in the page content at this spot'}). ` +
              'Export skips the block unless the optional PyMuPDF engine is loaded, so its original words stay.',
          });
        }
      } else {
        if (report.needsRasterFallback) outcome.raster.push(...withSource.map((object) => object.id));
        for (const object of withSource) {
          const boxes = leftovers.get(object.id) ?? [];
          if (boxes.length === 0) continue;
          outcome.partial.push({ id: object.id, leftover: boxes.length });
          outcome.covered.push({ id: object.id, boxes: boxes.map((rect) => userRectToBox(rect, frame)), color: object.paperColor });
        }
      }
    }

    const skipped = new Set(outcome.failed.map((entry) => entry.id));
    for (const object of pageObjects) {
      if (object.kind === 'shape') {
        writePatchObject(page, frame, object);
        outcome.written += 1;
        continue;
      }
      if (object.kind === 'image') {
        await writeImageObject(doc, page, frame, object, images);
        outcome.written += 1;
        continue;
      }
      if (skipped.has(object.id)) continue;
      const prepared = await prepareTextObject(doc, object, faces.get(object.id) ?? []);
      // Words the deletion could not reach are hidden behind a patch the size of
      // those words, in the colour sampled from behind them, before the new text
      // goes down. The report then says "covered", which is what the bytes are.
      for (const cover of outcome.covered) {
        if (cover.id !== object.id) continue;
        for (const box of cover.boxes) {
          const rect = viewerBoxToUserSpace(box, frame);
          page.drawRectangle({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, color: colorOf(cover.color) });
        }
      }
      writeTextObject(page, frame, prepared, writers);
      for (const line of prepared.layout.lines) {
        for (const piece of line.pieces) {
          if (piece.text.trim().length === 0) continue;
          const style = inlineFor(
            object.paragraphs[piece.source.paragraph]?.runs[piece.source.run] ?? { text: piece.text },
            { ...object.style, ...(object.paragraphs[piece.source.paragraph]?.style ?? {}) },
          );
          const face = faceOf(prepared.faces, style, object.paragraphs[piece.source.paragraph]?.runs[piece.source.run]?.text ?? piece.text);
          outcome.placed.push({
            id: object.id,
            page: object.page,
            text: piece.text,
            x: object.box.x + piece.x,
            baseline: object.box.y + line.baseline,
            size: style.size,
            face: face?.label ?? '',
            fromSource: Boolean(face?.fromSource),
          });
        }
      }
      for (const entry of prepared.substitutions) {
        outcome.substituted.push({
          id: object.id,
          from: entry.from || 'the page’s own face',
          to: entry.to,
          reason: substitutionText(entry.reason),
        });
      }
      if (prepared.reflowed) outcome.reflowed.push(object.id);
      outcome.written += 1;
    }
  }

  return outcome;
}

/** A named cause, in the words the result screen shows. */const REMOVAL_REASON_TEXT: Record<RemovalReason, string> = {
  'type3-font': 'words drawn by a Type3 (bitmap-drawn) font',
  'unmeasured-widths': 'a font with no widths, so the positions are estimated',
  'image-behind': 'an image behind the text',
  'form-reused': 'a form XObject this page draws more than once',
  'form-too-deep': 'a form nested deeper than the engine reads',
  'nothing-at-rect': 'no text was found in the page content at that spot',
  'form-not-copied': 'a form XObject shared with another page, which the engine will not rewrite in place',
};

function substitutionText(reason: SubstitutionReason): string {
  switch (reason.kind) {
    case 'missing':
      return `the embedded subset has no glyphs for: ${reason.characters}`;
    case 'bold':
      return 'the page’s own face has no bold weight';
    case 'italic':
      return 'the page’s own face has no italic weight';
    case 'type3':
      return 'the page’s face is a Type3 font, which cannot be re-encoded';
  }
}

/** User-space rect → viewer-space box: the inverse of the deletion mapping. */
function userRectToBox(rect: QuadRect, frame: PageFrame): TopLeftBox {
  const back = viewerToUserMatrix(frame);
  const corners = [
    applyMatrix(back, { x: rect.x, y: rect.y }),
    applyMatrix(back, { x: rect.x + rect.width, y: rect.y }),
    applyMatrix(back, { x: rect.x, y: rect.y + rect.height }),
    applyMatrix(back, { x: rect.x + rect.width, y: rect.y + rect.height }),
  ];
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

function num(value: number): number {
  const scaled = Math.round(value * 1e4) / 1e4;
  return Object.is(scaled, -0) ? 0 : scaled;
}

/**
 * What an export actually did, in sentences.
 *
 * The brief's rule is that a result reports numbers the user can check and never
 * says "done" when something was skipped. This surface has no `result.warnings`
 * channel, so every degraded block the built-in engine reported becomes one line
 * here, naming its page, and the UI must print all of them — not just the
 * headline — because "Saved" over a skipped block is a plausible-looking lie.
 */
export interface ExportReport {
  headline: string;
  warnings: string[];
}

export function exportReport(
  outcome: ApplyOutcome,
  objects: EditObject[],
  options: { signed?: boolean; repaired?: string[]; engineError?: string } = {},
): ExportReport {
  const repaired = new Set(options.repaired ?? []);
  const blocked = outcome.failed.filter((entry) => !repaired.has(entry.id));
  const skipped = new Set(blocked.map((entry) => entry.id));
  const written = objects.filter((object) => !skipped.has(object.id));
  const pageOf = (id: string) => objects.find((object) => object.id === id)?.page;
  const blocks = written.filter((object) => object.kind === 'text').length;
  const placed = written.length - blocks;
  const pages = new Set(written.map((object) => object.page)).size;
  const parts = [`${blocks} text block${blocks === 1 ? '' : 's'}`, placed > 0 ? `${placed} placed object${placed === 1 ? '' : 's'}` : '']
    .filter(Boolean)
    .join(' and ');
  const headline =
    written.length === 0
      ? 'Nothing was written — every block was skipped.'
      : `Wrote ${parts}${pages > 0 ? ` on ${pages} page${pages === 1 ? '' : 's'}` : ''}${
          blocked.length > 0 ? `, skipped ${blocked.length}` : ''
        }.`;

  const warnings: string[] = [];
  if (options.engineError) {
    warnings.push(
      `The optional engine could not run (${options.engineError}), so the blocks it was meant to clean were left as they are. The rest of the edits are in this file.`,
    );
  }
  if (options.signed) {
    warnings.push(
      'Saved as an appended incremental revision: the signed bytes were not rewritten, so the existing signature still verifies. Viewers show the new revision with these edits.',
    );
  }
  if (repaired.size > 0) {
    warnings.push(
      `${repaired.size} block${repaired.size === 1 ? '' : 's'} cleaned by the optional PyMuPDF engine rather than the built-in one; that text is set in Helvetica, not the page’s own face.`,
    );
  }
  for (const entry of blocked) {
    warnings.push(`Page ${pageOf(entry.id) ?? '?'}: skipped, so its original words are still there. ${entry.reason}`);
  }
  for (const entry of outcome.covered) {
    warnings.push(
      `Page ${pageOf(entry.id) ?? '?'}: ${entry.boxes.length} word${entry.boxes.length === 1 ? '' : 's'} could not be deleted and were covered with a patch the colour sampled from behind them — hidden, not removed.`,
    );
  }
  for (const entry of outcome.substituted) {
    warnings.push(
      `Page ${pageOf(entry.id) ?? '?'}: ${entry.from} could not be kept (${entry.reason}), so this text is set in ${entry.to}.`,
    );
  }
  if (outcome.reflowed.length > 0) {
    warnings.push(
      `${outcome.reflowed.length} block${outcome.reflowed.length === 1 ? '' : 's'} no longer fit${outcome.reflowed.length === 1 ? 's' : ''} the lines they came from and were re-flowed — check where the text lands.`,
    );
  }
  if (outcome.raster.length > 0) {
    warnings.push(
      `${outcome.raster.length} block${outcome.raster.length === 1 ? '' : 's'} sit${outcome.raster.length === 1 ? 's' : ''} on an image the engine cannot repaint — check them in a viewer.`,
    );
  }
  return { headline, warnings };
}
