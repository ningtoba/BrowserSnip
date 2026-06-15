import { useState, useEffect, useCallback, useRef } from 'react';
import * as renderer from '@/lib/renderer/core';
import type { PDFDocumentProxy } from 'pdfjs-dist';

interface UsePDFRendererOptions {
  scale?: number;
  maxThumbSize?: number;
}

export function usePDFRenderer(options: UsePDFRendererOptions = {}) {
  const { scale = 1.5, maxThumbSize = 200 } = options;

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsRender, setNeedsRender] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const loadDoc = useCallback(async (src: ArrayBuffer | string, password?: string) => {
    setLoading(true);
    setError(null);
    setDoc(null);
    setPageCount(0);
    setCurrentPage(1);
    setThumbnails([]);
    try {
      const document = await renderer.loadDocument(src, password);
      setDoc(document);
      setPageCount(document.numPages);
      setCurrentPage(1);

      // Generate thumbnails
      const thumbs = await renderer.generateThumbnails(document, maxThumbSize);
      setThumbnails(thumbs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load PDF';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [maxThumbSize]);

  const renderPage = useCallback(async (pageNum: number, canvas?: HTMLCanvasElement) => {
    const target = canvas ?? canvasRef.current;
    if (!doc || !target) return;
    await renderer.renderPageToCanvas(doc, pageNum, target, scale);
  }, [doc, scale]);

  const goToPage = useCallback((page: number) => {
    if (page >= 1 && page <= pageCount) {
      setCurrentPage(page);
      // Bump render counter so the effect fires even if currentPage hasn't changed yet visually
      setNeedsRender((n) => n + 1);
    }
  }, [pageCount]);

  const nextPage = useCallback(() => {
    if (currentPage < pageCount) {
      setCurrentPage((p) => p + 1);
      setNeedsRender((n) => n + 1);
    }
  }, [currentPage, pageCount]);

  const prevPage = useCallback(() => {
    if (currentPage > 1) {
      setCurrentPage((p) => p - 1);
      setNeedsRender((n) => n + 1);
    }
  }, [currentPage]);

  const extractText = useCallback(async (pageNum: number): Promise<string> => {
    if (!doc) return '';
    return renderer.extractText(doc, pageNum);
  }, [doc]);

  const extractAllText = useCallback(async () => {
    if (!doc) return [];
    return renderer.extractAllText(doc);
  }, [doc]);

  const exportPageAsImage = useCallback(async (
    pageNum: number,
    format: 'png' | 'jpeg' | 'webp' = 'png',
    quality: number = 0.9,
  ) => {
    if (!doc) return null;
    return renderer.renderPageToBlob(doc, pageNum, scale, format, quality);
  }, [doc, scale]);

  // Render when page changes or when explicitly bumped
  useEffect(() => {
    if (doc && canvasRef.current) {
      renderPage(currentPage);
    }
  }, [doc, currentPage, needsRender, renderPage]);

  // After loading finishes and canvas mounts, trigger initial render
  useEffect(() => {
    if (!loading && doc && canvasRef.current) {
      renderPage(currentPage);
    }
  }, [loading, doc, currentPage, renderPage]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      renderer.terminate();
    };
  }, []);

  return {
    doc,
    pageCount,
    currentPage,
    thumbnails,
    loading,
    error,
    canvasRef,
    loadDoc,
    renderPage,
    goToPage,
    nextPage,
    prevPage,
    extractText,
    extractAllText,
    exportPageAsImage,
  };
}
