import { useCallback } from 'react';
import { terminate } from '@/lib/pdf-engine/core';
import * as commands from '@/lib/pdf-engine/commands';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import type { ToolId } from '@/types';

interface ProcessOptions {
  toolId: ToolId;
  params: Record<string, unknown>;
  onComplete?: (blobs: Blob[]) => void;
}

export function usePDFEngine() {
  const process = useCallback(
    async (options: ProcessOptions): Promise<Blob[] | null> => {
      // Read files directly from the store at execution time, NOT from closure.
      const { files, file } = useFileStore.getState();
      const store = useProcessStore.getState();

      const noFileTools = new Set(['scan-to-pdf', 'html-to-pdf']);

      if (!file && files.length === 0 && !noFileTools.has(options.toolId)) {
        store.setError('No files loaded. Please add PDF files first.');
        return null;
      }

      store.startProcessing(`Processing ${files.length} file(s)`, '.pdf');

      try {
        const buffers: ArrayBuffer[] = await Promise.all(
          files.map((f) => f.arrayBuffer()),
        );

        if (buffers.length === 0 && !noFileTools.has(options.toolId)) {
          store.setError('No file data could be read.');
          return null;
        }

        const results = await executeToolCommand(
          options.toolId,
          options.params,
          buffers,
        );

        // pdf-to-word / pdf-to-excel set their own output blob directly
        // (.docx / .xlsx) — skip the default application/pdf wrapping
        const docOutputTools = new Set(['pdf-to-word', 'pdf-to-excel']);
        if (docOutputTools.has(options.toolId)) {
          if (results.length === 0) {
            store.setError('No output generated');
            return null;
          }
          // Output already set by the tool case — just mark as complete
          return [];
        }

        if (!results || results.length === 0) {
          store.setError('No output generated');
          return null;
        }

        const blobs: Blob[] = [];

        for (let i = 0; i < results.length; i++) {
          const bytes = results[i];
          const blob = new Blob([bytes], { type: 'application/pdf' });
          const url = URL.createObjectURL(blob);
          blobs.push(blob);

          if (i === 0) {
            store.setOutput(blob, url);
          } else {
            store.addOutput(blob, url);
          }
        }

        options.onComplete?.(blobs);
        return blobs;
      } catch (err) {
        console.error('[BrowserSnip PDF] Processing error:', err);
        const message = err instanceof Error ? err.message : 'Processing failed';
        store.setError(message);
        return null;
      }
    },
    [],
  );

  const terminateEngine = useCallback(async () => {
    terminate();
  }, []);

  return { process, terminate: terminateEngine };
}

async function executeToolCommand(
  toolId: ToolId,
  params: Record<string, unknown>,
  buffers: ArrayBuffer[],
): Promise<ArrayBuffer[] | Uint8Array[]> {
  const primaryBuffer = buffers[0];

  switch (toolId) {
    // ── Organize ──
    case 'merge': {
      if (buffers.length < 2) {
        throw new Error('Need at least 2 PDF files to merge');
      }
      const doc = await commands.mergePDFs(buffers);
      return [await doc.save()];
    }

    case 'split': {
      const mode = params.mode as string;
      if (mode === 'ranges') {
        return commands.splitByRanges(primaryBuffer, params.ranges as string);
      } else if (mode === 'odd-even') {
        const { odd, even } = await commands.splitOddEven(primaryBuffer);
        return [odd, even];
      } else {
        return commands.splitEveryPage(primaryBuffer);
      }
    }

    case 'remove-pages': {
      const result = await commands.removePages(
        primaryBuffer,
        params.pages as number[],
      );
      return [result];
    }

    case 'extract-pages': {
      return commands.extractPages(
        primaryBuffer,
        params.pages as number[],
        params.mergeIntoOne as boolean,
      );
    }

    case 'organize': {
      const result = await commands.reorderPages(
        primaryBuffer,
        params.pageOrder as number[],
      );
      return [result];
    }

    case 'rotate': {
      const result = await commands.rotatePages(
        primaryBuffer,
        (params.pages as number[]) ?? [],
        (params.degrees as 90 | 180 | 270) ?? 90,
        (params.applyToAll as boolean) ?? true,
      );
      return [result];
    }

    // ── Optimize ──
    case 'pdf-compress': {
      const result = await commands.compressPDF(primaryBuffer, {
        imageQuality: (params.imageQuality as number) ?? 0.7,
        imageMaxDPI: (params.imageMaxDPI as number) ?? 150,
      });
      return [result];
    }

    case 'repair': {
      const result = await commands.repairPDF(primaryBuffer);
      return [result];
    }

    case 'html-to-pdf': {
      const html = (params.html as string) ?? '';
      if (!html.trim()) {
        throw new Error('Please enter HTML content to convert.');
      }
      const result = await commands.htmlToPdf(html, params as unknown as Record<string, unknown>);
      return [result];
    }

    case 'digitize-document': {
      const result = await commands.digitizeDocument(buffers, {
        pageSize: (params.pageSize as 'a4' | 'letter' | 'original') ?? 'a4',
        orientation: (params.orientation as 'portrait' | 'landscape') ?? 'portrait',
        margin: (params.margin as number) ?? 20,
      });
      return [result];
    }

    // ── Convert from PDF ──
    case 'pdf-to-word': {
      const blob = await commands.pdfToDocx(primaryBuffer);
      const url = URL.createObjectURL(blob);
      useProcessStore.getState().setOutput(blob, url);
      return [new Uint8Array(await blob.arrayBuffer())];
    }

    case 'pdf-to-excel': {
      const blob = await commands.pdfToXlsx(primaryBuffer);
      const url = URL.createObjectURL(blob);
      useProcessStore.getState().setOutput(blob, url);
      return [new Uint8Array(await blob.arrayBuffer())];
    }

    case 'pdf-to-pdfa': {
      const result = await commands.pdfToPdfA(primaryBuffer);
      return [result];
    }

    // ── Convert to PDF ──
    case 'scan-to-pdf': {
      if (buffers.length === 0) {
        throw new Error('No images captured. Please scan at least one page.');
      }
      const result = await commands.imagesToPdf(buffers, {
        pageSize: (params.pageSize as 'a4' | 'letter' | 'original' | 'fit') ?? 'a4',
        orientation: (params.orientation as 'portrait' | 'landscape') ?? 'portrait',
        margin: (params.margin as number) ?? 10,
        fitMode: (params.fitMode as 'contain' | 'cover' | 'stretch') ?? 'contain',
      });
      return [result];
    }

    case 'image-to-pdf': {
      const result = await commands.imagesToPdf(buffers, {
        pageSize: (params.pageSize as 'a4' | 'letter' | 'original' | 'fit') ?? 'a4',
        orientation: (params.orientation as 'portrait' | 'landscape') ?? 'portrait',
        margin: (params.margin as number) ?? 20,
        fitMode: (params.fitMode as 'contain' | 'cover' | 'stretch') ?? 'contain',
      });
      return [result];
    }

    // ── Edit ──
    case 'watermark': {
      const result = await commands.addWatermark(primaryBuffer, {
        type: (params.type as 'text' | 'image') ?? 'text',
        text: (params.text as string) ?? '',
        imageData: params.imageData as ArrayBuffer | null,
        opacity: (params.opacity as number) ?? 0.3,
        rotation: (params.rotation as number) ?? 0,
        fontSize: (params.fontSize as number) ?? 48,
        position: (params.position as string) ?? 'center',
        color: parseColor(params.color as string ?? '#000000'),
        pages: (params.pages as string) ?? 'all',
        bold: (params.bold as boolean) ?? true,
        imageScale: (params.imageScale as number) ?? 0.3,
        tileSpacing: (params.tileSpacing as number) ?? 1.5,
      });
      return [result];
    }

    case 'page-numbers': {
      const result = await commands.addPageNumbers(primaryBuffer, {
        fontSize: (params.fontSize as number) ?? 12,
        position: (params.position as string) ?? 'bottom-center',
        startAt: (params.startAt as number) ?? 1,
        prefix: (params.prefix as string) ?? '',
        suffix: (params.suffix as string) ?? '',
        pages: (params.pages as string) ?? 'all',
      });
      return [result];
    }

    case 'pdf-crop': {
      const result = await commands.cropPages(primaryBuffer, {
        pages: (params.pages as number[]) ?? [],
        top: (params.top as number) ?? 0,
        right: (params.right as number) ?? 0,
        bottom: (params.bottom as number) ?? 0,
        left: (params.left as number) ?? 0,
        allPages: (params.allPages as boolean) ?? false,
        unit: (params.unit as string) ?? 'px',
      });
      return [result];
    }

    // ── Security ──
    case 'protect': {
      const result = await commands.encryptPDF(primaryBuffer, {
        userPassword: (params.userPassword as string) ?? '',
        ownerPassword: (params.ownerPassword as string) ?? '',
        permissions: {
          printing: (params.allowPrinting as boolean) ?? true,
          copying: (params.allowCopying as boolean) ?? true,
          modifying: (params.allowModifying as boolean) ?? true,
          annotating: (params.allowAnnotating as boolean) ?? true,
          fillingForms: (params.allowFillingForms as boolean) ?? true,
          contentAccessibility: (params.allowAccessibility as boolean) ?? true,
          assembling: (params.allowAssembling as boolean) ?? true,
        },
      });
      return [result];
    }

    case 'unlock': {
      const result = await commands.decryptPDF(
        primaryBuffer,
        params.password as string,
      );
      return [result];
    }

    case 'sign': {
      const sigs = (params.signatures as any[]) ?? [{
        type: (params.type as string) ?? 'text',
        imageData: params.imageData as ArrayBuffer | null,
        text: (params.text as string) ?? '',
        page: (params.page as number) ?? 1,
        x: (params.x as number) ?? 100,
        y: (params.y as number) ?? 100,
        width: (params.width as number) ?? 100,
        height: (params.height as number) ?? 50,
        color: (params.color as string) ?? '#000000',
        fontFamily: (params.fontFamily as string) ?? 'Helvetica',
      }];
      const result = await commands.addVisualSignatures(primaryBuffer, sigs);
      return [result];
    }

    case 'redact': {
      const result = await commands.redactPDF(
        primaryBuffer,
        (params.redactions as any[]) ?? [],
        parseColor(params.redactionColor as string ?? '#000000'),
      );
      return [result];
    }

    case 'compare': {
      if (buffers.length < 2) throw new Error('Need 2 PDF files to compare');
      const result = await commands.comparePDFs(buffers[0], buffers[1], {
        highlightColor: (params.highlightColor as string) ?? '#ff0000',
        sensitivity: (params.sensitivity as number) ?? 30,
      });
      return [result];
    }

    default:
      throw new Error(`Tool "${toolId}" not implemented`);
  }
}

function parseColor(hex: string): { r: number; g: number; b: number } {
  const match = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (!match) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(match[1], 16),
    g: parseInt(match[2], 16),
    b: parseInt(match[3], 16),
  };
}
