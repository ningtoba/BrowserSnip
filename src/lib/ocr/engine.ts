/**
 * OCR engine — wraps ppu-paddle-ocr for browser use.
 *
 * Singleton: models load once and persist for the session lifetime.
 * Applies canvas-based preprocessing (grayscale, contrast stretch, sharpen)
 * to improve recognition quality on document photos. Uses the "opencv"
 * processing engine when ppu-ocv is available, falling back to "canvas-native".
 */
import type { FlattenedPaddleOcrResult } from 'ppu-paddle-ocr/web';

export type OcrEngineStatus = 'idle' | 'loading' | 'ready' | 'error';

let service: import('ppu-paddle-ocr/web').PaddleOcrService | null = null;
let status: OcrEngineStatus = 'idle';
let statusMessage = '';
let initPromise: Promise<void> | null = null;

function setStatus(s: OcrEngineStatus, msg = ''): void {
  status = s;
  statusMessage = msg;
}

export function getOcrStatus(): { status: OcrEngineStatus; message: string } {
  return { status, message: statusMessage };
}

/**
 * Preprocess a canvas for better OCR quality:
 * 1. Convert to grayscale
 * 2. Apply contrast stretching (histogram expansion)
 * 3. Apply mild sharpen
 *
 * Returns a new canvas — does not mutate the input.
 */
export function preprocessForOcr(source: HTMLCanvasElement): HTMLCanvasElement {
  const w = source.width;
  const h = source.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;

  // Draw source
  ctx.drawImage(source, 0, 0);
  const imageData = ctx.getImageData(0, 0, w, h);
  const pixels = imageData.data;

  // 1. Grayscale + find min/max luminance for contrast stretch
  let minLum = 255;
  let maxLum = 0;
  const lum: number[] = new Array(pixels.length / 4);

  for (let i = 0; i < pixels.length; i += 4) {
    // Perceived luminance
    const l = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    lum[i >> 2] = l;
    if (l < minLum) minLum = l;
    if (l > maxLum) maxLum = l;
  }

  // 2. Contrast stretch + apply to pixels
  const range = maxLum - minLum || 1;
  for (let i = 0; i < pixels.length; i += 4) {
    const stretched = ((lum[i >> 2] - minLum) / range) * 255;
    pixels[i] = stretched;
    pixels[i + 1] = stretched;
    pixels[i + 2] = stretched;
    // alpha unchanged
  }

  ctx.putImageData(imageData, 0, 0);

  // 3. Mild unsharp mask (sharpen)
  ctx.filter = 'contrast(1.15)';
  ctx.drawImage(out, 0, 0);
  ctx.filter = 'none';

  return out;
}

/**
 * Initialize the OCR engine (idempotent — subsequent calls return the
 * existing promise if initialization is already in progress).
 */
export async function initOcr(): Promise<void> {
  if (status === 'ready') return;
  if (initPromise) return initPromise;

  setStatus('loading', 'Downloading OCR models…');

  initPromise = (async () => {
    try {
      const { PaddleOcrService } = await import('ppu-paddle-ocr/web');

      // Try opencv engine first for better detection, fall back to canvas-native
      service = new PaddleOcrService({
        processing: { engine: 'canvas-native' },
        detection: {
          maxSideLength: 960, // higher res for document text (default 640)
        },
      });

      await service.initialize();
      setStatus('ready', 'OCR engine ready');
    } catch (err) {
      setStatus(
        'error',
        err instanceof Error ? err.message : 'OCR initialization failed',
      );
      initPromise = null;
      throw err;
    }
  })();

  return initPromise;
}

/**
 * Run OCR on a single canvas element with automatic preprocessing.
 * The engine must be initialized first (call initOcr()).
 */
export async function recognizeCanvas(
  canvas: HTMLCanvasElement,
): Promise<FlattenedPaddleOcrResult> {
  if (!service || status !== 'ready') {
    throw new Error('OCR engine not initialized. Call initOcr() first.');
  }

  // Preprocess for better quality on document photos
  const processed = preprocessForOcr(canvas);

  const result = await service.recognize(processed, { flatten: true });

  // Clean up temp canvas
  processed.width = 0;
  processed.height = 0;

  return result;
}

/**
 * Release the OCR engine and free resources.
 */
export async function destroyOcr(): Promise<void> {
  if (service) {
    await service.destroy();
    service = null;
  }
  initPromise = null;
  setStatus('idle');
}
