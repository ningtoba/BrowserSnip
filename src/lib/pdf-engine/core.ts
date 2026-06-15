import { PDFDocument, PDFPage, rgb, StandardFonts, PDFFont, degrees } from 'pdf-lib';
import type { PDFMetadata } from '@/types';

let pdfDoc: PDFDocument | null = null;
let isInitialized = false;

export async function getPDFDoc(): Promise<PDFDocument | null> {
  return pdfDoc;
}

export async function loadPDF(
  bytes: ArrayBuffer,
  password?: string,
): Promise<{ doc: PDFDocument; metadata: PDFMetadata }> {
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: !password,
    ...(password ? { password } : {}),
  });

  pdfDoc = doc;
  isInitialized = true;

  const metadata: PDFMetadata = {
    pageCount: doc.getPageCount(),
    fileSize: bytes.byteLength,
    fileName: '',
    isEncrypted: false,
    hasForms: doc.getForm().getFields().length > 0,
    hasAnnotations: false,
    pdfVersion: '1.7',
    title: doc.getTitle() ?? undefined,
    author: doc.getAuthor() ?? undefined,
  };

  return { doc, metadata };
}

export async function createPDF(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  pdfDoc = doc;
  isInitialized = true;
  return doc;
}

export async function savePDF(doc?: PDFDocument): Promise<Uint8Array> {
  const target = doc ?? pdfDoc;
  if (!target) throw new Error('No PDF document loaded');
  return target.save();
}

export async function savePDFWithEncryption(
  doc: PDFDocument,
  _options: {
    userPassword?: string;
    ownerPassword?: string;
    permissions?: {
      printing?: boolean;
      copying?: boolean;
      modifying?: boolean;
      annotating?: boolean;
      fillingForms?: boolean;
      contentAccessibility?: boolean;
      assembling?: boolean;
    };
  },
): Promise<Uint8Array> {
  // Base pdf-lib does not support encryption on save.
  // Use @maxwbh/pdf-lib for native PDF encryption, or
  // use encryptPDF from commands.ts which uses Web Crypto API.
  return doc.save();
}

export function terminate(): void {
  pdfDoc = null;
  isInitialized = false;
}

export function getPageCount(doc?: PDFDocument): number {
  return (doc ?? pdfDoc)?.getPageCount() ?? 0;
}

export function getPages(doc?: PDFDocument): PDFPage[] {
  const target = doc ?? pdfDoc;
  if (!target) return [];
  return target.getPages();
}

export function getPageSize(page: PDFPage): { width: number; height: number } {
  const { width, height } = page.getSize();
  return { width, height };
}

export async function embedFont(
  doc: PDFDocument,
  fontName: StandardFonts,
): Promise<PDFFont> {
  return doc.embedFont(fontName);
}

export async function embedImage(
  doc: PDFDocument,
  imageBytes: ArrayBuffer | Uint8Array,
  type: 'jpg' | 'png',
): Promise<{ width: number; height: number }> {
  let image;
  if (type === 'jpg') {
    image = await doc.embedJpg(imageBytes);
  } else {
    image = await doc.embedPng(imageBytes);
  }
  return { width: image.width, height: image.height };
}

export { PDFDocument, PDFPage, rgb, StandardFonts, degrees };
export type { PDFFont };
