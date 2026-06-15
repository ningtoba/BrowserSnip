/**
 * Download and clipboard utilities for processed PDF output.
 */
import type { ToolId } from '@/types';

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadMultipleBlobs(blobs: Blob[], baseName: string): void {
  for (let i = 0; i < blobs.length; i++) {
    const suffix = blobs.length > 1 ? `_page_${i + 1}` : '';
    const ext = baseName.includes('.') ? '' : '.pdf';
    const fileName = baseName.replace(/\.[^.]+$/, '') + suffix + ext;
    // Use setTimeout to allow multiple downloads (browsers may block rapid successive downloads)
    setTimeout(() => downloadBlob(blobs[i], fileName), i * 200);
  }
}

export function getOutputFileName(
  originalName: string,
  toolId: ToolId,
  suffix?: string,
): string {
  const baseName = originalName.replace(/\.[^.]+$/, '') || 'document';
  const actualSuffix = suffix ?? getToolSuffix(toolId);
  return `${baseName}${actualSuffix}`;
}

function getToolSuffix(toolId: ToolId): string {
  switch (toolId) {
    case 'merge':
      return '_merged.pdf';
    case 'split':
      return '_split';
    case 'remove-pages':
      return '_trimmed.pdf';
    case 'extract-pages':
      return '_extracted.pdf';
    case 'organize':
      return '_organized.pdf';
    case 'rotate':
      return '_rotated.pdf';
    case 'pdf-compress':
      return '_compressed.pdf';
    case 'repair':
      return '_repaired.pdf';
    case 'image-to-pdf':
      return '_from_images.pdf';
    case 'html-to-pdf':
      return '_from_html.pdf';
    case 'pdf-to-image':
      return '';
    case 'pdf-to-word':
      return '_extracted.docx';
    case 'pdf-to-excel':
      return '_extracted.xlsx';
    case 'pdf-to-pdfa':
      return '_pdfa.pdf';
    case 'page-numbers':
      return '_numbered.pdf';
    case 'watermark':
      return '_watermarked.pdf';
    case 'pdf-crop':
      return '_cropped.pdf';
    case 'protect':
      return '_protected.pdf';
    case 'unlock':
      return '_unlocked.pdf';
    case 'sign':
      return '_signed.pdf';
    case 'redact':
      return '_redacted.pdf';
    case 'compare':
      return '_comparison.pdf';
    case 'scan-to-pdf':
      return '_scan.pdf';
    default:
      return '_processed.pdf';
  }
}

export async function copyToClipboard(blob: Blob): Promise<boolean> {
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        [blob.type]: blob,
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatCompressionRatio(original: number, compressed: number): string {
  if (original <= 0 || compressed <= 0) return 'N/A';
  const ratio = ((original - compressed) / original) * 100;
  return `${ratio.toFixed(1)}% smaller`;
}
