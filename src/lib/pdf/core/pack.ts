/**
 * Building PDFs from non-PDF inputs.
 *
 * Shared by image→PDF, rasterise, scan, poster and the OCR pipeline so page
 * geometry and image fit rules are decided in exactly one place.
 */
import type { PDFDocument, PDFImage, PDFPage } from '@maxwbh/pdf-lib';
import { degrees, newPDF, rgb, savePDF } from './doc';
import { PAGE_SIZES, pageSize as resolvePageSize } from './pages';
import { decodeImagePages, toEmbeddableImage } from './images';

export type FitMode = 'contain' | 'cover' | 'stretch';
export type PageSizeName = 'a4' | 'letter' | 'legal' | 'a3' | 'a5' | 'tabloid' | 'original' | 'fit' | string;

export interface PackOptions {
  /** Named size, `original` to match each image, or `fit` to hug the image. */
  pageSize?: PageSizeName;
  orientation?: 'portrait' | 'landscape' | 'auto';
  /** Margin in points on every edge. */
  margin?: number;
  fit?: FitMode;
  /** Page rotation in 90° steps, applied after layout. */
  rotate?: number;
  background?: string;
  /** Centre the image on the page (default) or align to the top-left. */
  align?: 'center' | 'top';
}

export interface PackedPdf {
  doc: PDFDocument;
  pages: number;
  bytes: () => Promise<Uint8Array>;
}

/** Turn a list of image blobs/bytes into a PDF, one or more images per page. */
export async function pdfFromImages(
  inputs: { data: Uint8Array | Blob | HTMLCanvasElement; name?: string; mime?: string }[],
  options: PackOptions = {},
): Promise<PackedPdf> {
  if (inputs.length === 0) throw new Error('Add at least one image.');
  const doc = await newPDF();
  const margin = options.margin ?? 0;
  const background = options.background ?? '#ffffff';

  for (const input of inputs) {
    const bytes = await toBytes(input.data);
    const pages = await decodeImagePages(bytes, { mime: input.mime });
    for (const image of pages) {
      const natural: [number, number] = [image.width, image.height];
      const embedded = await embedRaster(doc, image.canvas);
      await placeImage(doc, embedded, natural, {
        ...options,
        margin,
        background,
      });
    }
  }
  return {
    doc,
    pages: doc.getPageCount(),
    bytes: () => savePDF(doc),
  };
}

/** Normalise any image-ish input to bytes; a canvas is encoded as PNG. */
async function toBytes(data: Uint8Array | Blob | HTMLCanvasElement): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof HTMLCanvasElement) {
    const blob = await new Promise<Blob | null>((resolve) => data.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('This browser could not encode a canvas to PNG.');
    return new Uint8Array(await blob.arrayBuffer());
  }
  return new Uint8Array(await data.arrayBuffer());
}

/** Embed a canvas as either PNG or JPEG without the caller choosing. */
async function embedRaster(doc: PDFDocument, canvas: HTMLCanvasElement): Promise<PDFImage> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (blob) return doc.embedPng(new Uint8Array(await blob.arrayBuffer()));
  const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  if (!jpeg) throw new Error('This browser could not encode the image for embedding.');
  return doc.embedJpg(new Uint8Array(await jpeg.arrayBuffer()));
}

/**
 * Embed already-encoded image bytes, keeping their container when possible.
 * Re-wrapping a JPEG as PNG would inflate the file, so the caller's format is
 * preserved and only unsupported formats go through a canvas.
 */
export async function embedImageBytes(
  doc: PDFDocument,
  bytes: Uint8Array,
  options: { mime?: string; format?: 'png' | 'jpeg'; quality?: number } = {},
): Promise<PDFImage> {
  const direct = options.mime === 'image/png'
    ? await doc.embedPng(bytes).catch(() => null)
    : options.mime === 'image/jpeg'
      ? await doc.embedJpg(bytes).catch(() => null)
      : null;
  if (direct) return direct;
  return toEmbeddableImage(doc, bytes, {
    mime: options.mime,
    format: options.format ?? 'png',
    quality: options.quality,
  });
}

async function placeImage(
  doc: PDFDocument,
  image: PDFImage,
  natural: [number, number],
  options: PackOptions & { margin: number; background: string },
): Promise<PDFPage> {
  const mode = options.pageSize ?? 'fit';
  const rotate = options.rotate ?? 0;
  const swap = Math.abs(rotate % 180) === 90;
  let width: number;
  let height: number;

  if (mode === 'original' || mode === 'fit') {
    // One PDF point per image pixel keeps scans readable at 72 dpi and
    // matches what every scanner application produces.
    width = natural[0] + options.margin * 2;
    height = natural[1] + options.margin * 2;
  } else if (mode === 'square') {
    // A square sheet long enough for the artwork's own long edge, so the
    // picture keeps its ratio inside it instead of being cropped or stretched.
    const side = Math.max(natural[0], natural[1]) + options.margin * 2;
    width = side;
    height = side;
  } else {
    const landscape = options.orientation === 'landscape'
      || (options.orientation !== 'portrait' && natural[0] > natural[1]);
    [width, height] = resolvePageSize(mode, landscape);
    if (mode === 'a4' || mode === 'letter') {
      // Guard against a typo'd size name reaching the page constructor.
      if (!Number.isFinite(width) || !Number.isFinite(height)) {
        [width, height] = PAGE_SIZES.a4;
      }
    }
  }

  const page = doc.addPage([width, height]);
  if (options.background && options.background !== 'transparent') {
    page.drawRectangle({
      x: 0,
      y: 0,
      width,
      height,
      color: hexToRgb(options.background),
    });
  }

  const usableWidth = Math.max(1, width - options.margin * 2);
  const usableHeight = Math.max(1, height - options.margin * 2);
  const scale = fitScale(natural[0], natural[1], usableWidth, usableHeight, options.fit ?? 'contain');
  // “Stretch” promises a picture that fills the sheet by distorting it, which is
  // two different scales. A single number here made it identical to “Fit inside
  // the page”, so the control changed nothing except the file's own description.
  const stretched = (options.fit ?? 'contain') === 'stretch';
  const drawWidth = stretched ? usableWidth : natural[0] * scale;
  const drawHeight = stretched ? usableHeight : natural[1] * scale;
  const x = options.align === 'top'
    ? options.margin
    : options.margin + (usableWidth - drawWidth) / 2;
  const y = options.align === 'top'
    ? height - options.margin - drawHeight
    : options.margin + (usableHeight - drawHeight) / 2;

  page.drawImage(image, { x, y, width: drawWidth, height: drawHeight });
  if (rotate) page.setRotation(degrees(rotate));
  void swap;
  return page;
}

/**
 * The uniform scale that places a source box inside (or over) a target box.
 *
 * `stretch` returns the contain scale because one number cannot express it; the
 * caller that draws the box overrides both axes for that mode.
 */
export function fitScale(
  sourceWidth: number,
  sourceHeight: number,
  boxWidth: number,
  boxHeight: number,
  fit: FitMode,
): number {
  if (sourceWidth <= 0 || sourceHeight <= 0) return 1;
  const sx = boxWidth / sourceWidth;
  const sy = boxHeight / sourceHeight;
  if (fit === 'stretch') return Math.min(sx, sy);
  if (fit === 'cover') return Math.max(sx, sy);
  return Math.min(sx, sy);
}

function hexToRgb(hex: string) {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  return rgb(Number.isFinite(r) ? r : 1, Number.isFinite(g) ? g : 1, Number.isFinite(b) ? b : 1);
}

/** Wrap arbitrary binary payloads so a tool can hand back a single blob. */
export async function blobOfPdf(doc: PDFDocument): Promise<Blob> {
  const bytes = await savePDF(doc);
  return new Blob([bytes], { type: 'application/pdf' });
}
