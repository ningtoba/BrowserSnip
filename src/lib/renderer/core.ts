/**
 * PDF.js renderer — wraps pdfjs-dist for page rendering and text extraction.
 * Designed to work in both main thread and Web Workers.
 */
import * as pdfjsLib from 'pdfjs-dist';

// Set the worker source
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url,
).toString();

let currentDoc: pdfjsLib.PDFDocumentProxy | null = null;

export async function loadDocument(
  src: ArrayBuffer | string,
  password?: string,
): Promise<pdfjsLib.PDFDocumentProxy> {
  if (currentDoc) {
    await currentDoc.destroy();
    currentDoc = null;
  }

  const loadingTask = pdfjsLib.getDocument({
    data: src instanceof ArrayBuffer ? src : undefined,
    url: typeof src === 'string' ? src : undefined,
    password,
    disableAutoFetch: false,
    disableStream: false,
  });

  currentDoc = await loadingTask.promise;
  return currentDoc;
}

export function getDocument(): pdfjsLib.PDFDocumentProxy | null {
  return currentDoc;
}

export async function renderPageToCanvas(
  doc: pdfjsLib.PDFDocumentProxy,
  pageNum: number,
  canvas: HTMLCanvasElement | OffscreenCanvas,
  scale: number = 1.5,
): Promise<void> {
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale });

  canvas.width = viewport.width;
  canvas.height = viewport.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  await page.render({
    canvasContext: ctx as any,
    viewport,
  }).promise;
}

export async function renderPageToImageData(
  doc: pdfjsLib.PDFDocumentProxy,
  pageNum: number,
  scale: number = 1.5,
  format: 'png' | 'jpeg' | 'webp' = 'png',
  quality: number = 0.9,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  await page.render({
    canvasContext: ctx,
    viewport,
  }).promise;

  const mimeType = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
  const dataUrl = canvas.toDataURL(mimeType, quality);

  return { dataUrl, width: viewport.width, height: viewport.height };
}

export async function renderPageToBlob(
  doc: pdfjsLib.PDFDocumentProxy,
  pageNum: number,
  scale: number = 1.5,
  format: 'png' | 'jpeg' | 'webp' = 'png',
  quality: number = 0.9,
): Promise<Blob> {
  const { dataUrl } = await renderPageToImageData(doc, pageNum, scale, format, quality);
  const response = await fetch(dataUrl);
  return response.blob();
}

export async function generateThumbnail(
  doc: pdfjsLib.PDFDocumentProxy,
  pageNum: number,
  maxSize: number = 200,
): Promise<string> {
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1 });
  const scale = maxSize / Math.max(viewport.width, viewport.height);

  const canvas = document.createElement('canvas');
  const scaledViewport = page.getViewport({ scale });
  canvas.width = scaledViewport.width;
  canvas.height = scaledViewport.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  await page.render({
    canvasContext: ctx,
    viewport: scaledViewport,
  }).promise;

  return canvas.toDataURL('image/jpeg', 0.7);
}

export async function generateThumbnails(
  doc: pdfjsLib.PDFDocumentProxy,
  maxSize: number = 200,
  onProgress?: (current: number, total: number) => void,
): Promise<string[]> {
  const thumbnails: string[] = [];
  const total = doc.numPages;

  for (let i = 1; i <= total; i++) {
    const thumb = await generateThumbnail(doc, i, maxSize);
    thumbnails.push(thumb);
    onProgress?.(i, total);
  }

  return thumbnails;
}

export async function extractText(
  doc: pdfjsLib.PDFDocumentProxy,
  pageNum: number,
): Promise<string> {
  const page = await doc.getPage(pageNum);
  const content = await page.getTextContent();
  return content.items
    .map((item: any) => item.str)
    .join(' ');
}

export async function extractAllText(
  doc: pdfjsLib.PDFDocumentProxy,
): Promise<Array<{ page: number; text: string }>> {
  const results: Array<{ page: number; text: string }> = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const text = await extractText(doc, i);
    results.push({ page: i, text });
  }

  return results;
}

export async function getPageCount(doc: pdfjsLib.PDFDocumentProxy): Promise<number> {
  return doc.numPages;
}

export async function getPageSize(
  doc: pdfjsLib.PDFDocumentProxy,
  pageNum: number,
): Promise<{ width: number; height: number }> {
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1 });
  return { width: viewport.width, height: viewport.height };
}

export async function getMetadata(
  doc: pdfjsLib.PDFDocumentProxy,
): Promise<Record<string, unknown>> {
  const metadata = await doc.getMetadata();
  return metadata.info as Record<string, unknown>;
}

export function terminate(): void {
  if (currentDoc) {
    currentDoc.destroy();
    currentDoc = null;
  }
}
