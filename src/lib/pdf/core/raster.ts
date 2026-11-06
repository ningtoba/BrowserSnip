/**
 * Canvas ↔ blob encoding.
 *
 * `canvas.toBlob` cannot produce BMP anywhere and only produces TIFF in a few
 * engines, so both are encoded from raw pixels here. Canvas also decodes GIF,
 * WebP, AVIF and BMP, but not HEIF or (reliably) TIFF — see `./images.ts`.
 */
import type { ImageFormat } from './images';

export function extensionForImage(format: string): string {
  return (
    { png: 'png', jpeg: 'jpg', jpg: 'jpg', webp: 'webp', bmp: 'bmp', tiff: 'tif' }[format] ??
    format
  );
}

export function mimeForImage(format: string): string {
  return format === 'jpeg' || format === 'jpg'
    ? 'image/jpeg'
    : format === 'tif'
      ? 'image/tiff'
      : `image/${format}`;
}

export function canvasContext2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get a 2D drawing context from this canvas.');
  return ctx;
}

/** Encode a canvas to the requested raster format. */
export async function canvasToBlob(
  canvas: HTMLCanvasElement,
  format: ImageFormat,
  quality = 0.92,
  options: { background?: string } = {},
): Promise<Blob> {
  if (format === 'bmp') return encodeBmp(canvas);
  if (format === 'tiff') return encodeTiff(canvas);
  const source = flattenIfNeeded(canvas, format, options.background);
  const blob = await new Promise<Blob | null>((resolve) =>
    source.toBlob(resolve, mimeForImage(format), quality),
  );
  if (!blob) {
    throw new Error(
      `This browser cannot export ${format.toUpperCase()} images — try PNG or JPEG instead.`,
    );
  }
  return blob;
}

function flattenIfNeeded(
  canvas: HTMLCanvasElement,
  format: ImageFormat,
  background?: string,
): HTMLCanvasElement {
  const needsFlatten = (format === 'jpeg' || format === 'bmp') && hasAlpha(canvas);
  const fill = background ?? (needsFlatten ? '#ffffff' : undefined);
  if (!fill) return canvas;
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = canvasContext2d(out);
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  return out;
}

/** Scan a sparse sample of pixels for alpha < 255. */
export function hasAlpha(canvas: HTMLCanvasElement, sample = 64): boolean {
  const ctx = canvasContext2d(canvas);
  const w = canvas.width;
  const h = canvas.height;
  const stepX = Math.max(1, Math.floor(w / sample));
  const stepY = Math.max(1, Math.floor(h / sample));
  for (let y = 0; y < h; y += stepY) {
    const row = ctx.getImageData(0, y, w, 1).data;
    for (let x = 0; x < w; x += stepX) {
      if (row[(x * 4) + 3] < 255) return true;
    }
  }
  return false;
}

/** 24-bit, bottom-up, row-padded BMP. */
export function encodeBmp(canvas: HTMLCanvasElement): Blob {
  const ctx = canvasContext2d(canvas);
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  const rowBytes = Math.ceil((width * 3) / 4) * 4;
  const pixelOffset = 54;
  const size = pixelOffset + rowBytes * height;
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint16(0, 0x424d); // 'BM'
  view.setUint32(2, size, true);
  view.setUint32(10, pixelOffset, true);
  view.setUint32(14, 40, true); // BITMAPINFOHEADER
  view.setInt32(18, width, true);
  view.setInt32(22, height, true); // positive = bottom-up
  view.setUint16(26, 1, true); // planes
  view.setUint16(28, 24, true); // bpp
  view.setUint32(34, rowBytes * height, true);
  view.setInt32(38, 2835, true); // 72 dpi
  view.setInt32(42, 2835, true);

  for (let y = 0; y < height; y++) {
    const rowStart = pixelOffset + (height - 1 - y) * rowBytes;
    const srcRow = y * width * 4;
    for (let x = 0; x < width; x++) {
      const src = srcRow + x * 4;
      const dst = rowStart + x * 3;
      bytes[dst] = data[src + 2];
      bytes[dst + 1] = data[src + 1];
      bytes[dst + 2] = data[src];
    }
  }
  return new Blob([bytes], { type: 'image/bmp' });
}

/**
 * Baseline little-endian TIFF: one strip, no compression, RGB. Enough for
 * multi-page output to be opened by Preview, IrfanView and LibreOffice.
 */
export function encodeTiff(canvas: HTMLCanvasElement): Blob {
  const ctx = canvasContext2d(canvas);
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  const stripBytes = width * 3 * height;
  const headerSize = 8;
  const resolutionSize = 16; // two SHORT-style RATIONALs stored out of line
  const bitsSize = 6; // BitsPerSample: three SHORTs, too wide for the value field
  const ifdOffset = headerSize + stripBytes;
  const entryCount = 13;
  const ifdSize = 2 + entryCount * 12 + 4 + resolutionSize + bitsSize;
  const buffer = new ArrayBuffer(ifdOffset + ifdSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint16(0, 0x4949, true); // II
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);

  let p = ifdOffset;
  view.setUint16(p, entryCount, true);
  p += 2;
  const entry = (tag: number, type: number, count: number, value: number) => {
    view.setUint16(p, tag, true);
    view.setUint16(p + 2, type, true);
    view.setUint32(p + 4, count, true);
    if (type === 3 && count === 1) {
      view.setUint16(p + 8, value, true);
      view.setUint16(p + 10, 0, true);
    } else {
      view.setUint32(p + 8, value, true);
    }
    p += 12;
  };
  // The two RATIONAL values sit in the tail of the block reserved above, after
  // every entry and the 4-byte next-IFD pointer. Deriving the offset from the
  // entry count rather than from `p` matters: `p` is still at the *start* of the
  // table here, so the old `p + 4` wrote the resolution pair on top of the
  // ImageWidth entry and every page this app exported was unreadable to a strict
  // TIFF decoder (UTIF lost the width, so the image decoded as nothing).
  const resolutionOffset = ifdOffset + 2 + entryCount * 12 + 4;
  const bitsOffset = resolutionOffset + resolutionSize;
  entry(0x00fe, 3, 1, 0); // NewSubfileType
  entry(0x0100, 3, 1, width); // ImageWidth
  entry(0x0101, 3, 1, height); // ImageLength
  entry(0x0102, 3, 3, bitsOffset); // BitsPerSample, one SHORT per sample
  entry(0x0103, 3, 1, 1); // Compression = 1 (none)
  entry(0x0106, 3, 1, 2); // PhotometricInterpretation = RGB
  entry(0x0111, 4, 1, headerSize); // StripOffsets
  entry(0x0115, 3, 1, 3); // SamplesPerPixel
  entry(0x0116, 3, 1, width * 3); // RowsPerStrip
  entry(0x0117, 4, 1, stripBytes); // StripByteCounts
  entry(0x011a, 5, 1, resolutionOffset); // XResolution (RATIONAL)
  entry(0x011b, 5, 1, resolutionOffset + 8); // YResolution
  entry(0x0128, 3, 1, 2); // ResolutionUnit = inch
  view.setUint32(p, 0, true); // next IFD = none

  // The two RATIONAL values live after the IFD in the same block we reserved.
  const rat = resolutionOffset;
  view.setUint32(rat, 72, true);
  view.setUint32(rat + 4, 1, true);
  view.setUint32(rat + 8, 72, true);
  view.setUint32(rat + 12, 1, true);

  // One BitsPerSample per sample. Declaring `count: 1, value: 8` next to
  // `SamplesPerPixel: 3` makes a strict reader compute 8 bits per *pixel* and
  // read every row at a third of its true width — UTIF did exactly that, so the
  // exported page came back black.
  view.setUint16(bitsOffset, 8, true);
  view.setUint16(bitsOffset + 2, 8, true);
  view.setUint16(bitsOffset + 4, 8, true);

  for (let i = 0, src = 0; i < stripBytes; i += 3, src += 4) {
    bytes[headerSize + i] = data[src];
    bytes[headerSize + i + 1] = data[src + 1];
    bytes[headerSize + i + 2] = data[src + 2];
  }
  return new Blob([bytes], { type: 'image/tiff' });
}

/**
 * Combine single-page TIFFs produced by `encodeTiff` into one multi-page
 * file. Each input has the layout `[8-byte header][strip data][IFD]`, so the
 * merge keeps every page's pixel data and rewrites two fields per IFD: the
 * strip offset (rebased onto the merged stream) and the next-IFD pointer.
 */
export async function concatTiffs(blobs: Blob[]): Promise<Blob> {
  if (blobs.length === 0) throw new Error('No TIFF pages to combine.');
  if (blobs.length === 1) return blobs[0];

  const pages = await Promise.all(
    blobs.map(async (blob) => {
      const buffer = await blob.arrayBuffer();
      const view = new DataView(buffer);
      const little = view.getUint16(0, true) === 0x4949;
      if (little !== (view.getUint16(0, true) === 0x4949)) {
        throw new Error('Cannot mix big-endian and little-endian TIFF pages.');
      }
      return { buffer, view, little, ifdOffset: view.getUint32(4, little) };
    }),
  );

  const headerSize = 8;
  const layouts = pages.map((page) => {
    const ifd = page.ifdOffset;
    const entryCount = page.view.getUint16(ifd, page.little);
    // The IFD table *and* the out-of-line tail that follows it (the resolution
    // RATIONALs and BitsPerSample) run to the end of the page. Copying only the
    // 2 + n*12 + 4 table left those offsets pointing into the previous page's
    // pixel data in the merged file.
    const ifdSize = page.buffer.byteLength - ifd;
    return {
      page,
      dataStart: headerSize,
      dataEnd: ifd,
      ifd,
      ifdSize,
      entryCount,
      nextPointerOffset: ifd + 2 + entryCount * 12,
    };
  });

  const totalData = layouts.reduce((n, l) => n + (l.dataEnd - l.dataStart), 0);
  const totalIfd = layouts.reduce((n, l) => n + l.ifdSize, 0);
  const merged = new Uint8Array(headerSize + totalData + totalIfd);
  const view = new DataView(merged.buffer);
  const little = pages[0].little;

  view.setUint16(0, little ? 0x4949 : 0x4d4d, true);
  view.setUint16(2, 42, true);

  let dataCursor = headerSize;
  let ifdCursor = headerSize + totalData;
  const ifdPositions: number[] = [];
  const dataPositions: number[] = [];

  for (const layout of layouts) {
    dataPositions.push(dataCursor);
    ifdPositions.push(ifdCursor);
    merged.set(
      new Uint8Array(layout.page.buffer, layout.dataStart, layout.dataEnd - layout.dataStart),
      dataCursor,
    );
    merged.set(
      new Uint8Array(layout.page.buffer, layout.ifd, layout.ifdSize),
      ifdCursor,
    );
    dataCursor += layout.dataEnd - layout.dataStart;
    ifdCursor += layout.ifdSize;
  }

  view.setUint32(4, ifdPositions[0], little);

  layouts.forEach((layout, index) => {
    const base = ifdPositions[index];
    const entryCount = view.getUint16(base, little);
    const shift = base - layout.ifd;
    for (let i = 0; i < entryCount; i++) {
      const entry = base + 2 + i * 12;
      const tag = view.getUint16(entry, little);
      // StripOffsets (0x0111) is written as a LONG value by `encodeTiff`.
      if (tag === 0x0111) {
        view.setUint32(entry + 8, dataPositions[index], little);
        continue;
      }
      // Anything that does not fit in the 4-byte value field is an offset into
      // this page's tail, so it moves with the IFD it belongs to.
      const type = view.getUint16(entry + 2, little);
      const count = view.getUint32(entry + 4, little);
      const inline = type === 3 && count === 1;
      const value = view.getUint32(entry + 8, little);
      if (!inline && value >= layout.ifd && value < layout.page.buffer.byteLength) {
        view.setUint32(entry + 8, value + shift, little);
      }
    }
    const next = base + 2 + entryCount * 12;
    view.setUint32(next, index + 1 < ifdPositions.length ? ifdPositions[index + 1] : 0, little);
  });

  return new Blob([merged], { type: 'image/tiff' });
}
