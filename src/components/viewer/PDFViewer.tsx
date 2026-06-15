import { useEffect, useRef, useCallback } from 'react';
import { usePDFRenderer } from '@/hooks/usePDFRenderer';
import { useFileStore } from '@/stores/file-store';

interface PDFViewerProps {
  scale?: number;
  showControls?: boolean;
  fileOverride?: File | null;
}

export function PDFViewer({ scale = 1.5, showControls = true, fileOverride }: PDFViewerProps) {
  const storeFile = useFileStore((s) => s.file);
  const file = fileOverride !== undefined ? fileOverride : storeFile;
  const {
    doc,
    pageCount,
    currentPage,
    loading,
    error,
    canvasRef,
    loadDoc,
    goToPage,
    nextPage,
    prevPage,
  } = usePDFRenderer({ scale });

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (file) {
      file.arrayBuffer().then((buf) => loadDoc(buf));
    }
  }, [file, loadDoc]);

  // Keyboard navigation
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextPage();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') prevPage();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [nextPage, prevPage]);

  if (!file) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center opacity-40">
          <div className="mb-3 text-4xl">📄</div>
          <p className="text-xs font-medium text-ink-muted">
            Import a PDF to preview
          </p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="mb-3 animate-spin text-3xl">⏳</div>
          <p className="text-xs text-ink-muted">Loading PDF...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center max-w-md">
          <div className="mb-3 text-3xl">⚠️</div>
          <p className="text-xs font-semibold text-danger">Failed to load PDF</p>
          <p className="mt-1 text-[11px] text-ink-muted">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" ref={containerRef}>
      {/* Canvas */}
      <div className="flex-1 flex items-center justify-center overflow-auto p-4 min-h-0">
        <canvas
          ref={canvasRef}
          className="max-w-full max-h-full shadow-doodle-card rounded-doodle-md"
          style={{ display: doc ? 'block' : 'none' }}
        />
      </div>

      {/* Controls */}
      {showControls && doc && (
        <div className="flex items-center justify-center gap-3 py-2 px-4 border-t border-cream-border bg-cream-light/50 shrink-0">
          <button
            onClick={prevPage}
            disabled={currentPage <= 1}
            className="text-[11px] font-medium text-ink-soft hover:text-ink disabled:opacity-30 transition-colors px-2 py-1"
          >
            ← Prev
          </button>

          <span className="text-[11px] font-mono text-ink-muted tabular-nums min-w-[60px] text-center">
            {currentPage} / {pageCount}
          </span>

          <button
            onClick={nextPage}
            disabled={currentPage >= pageCount}
            className="text-[11px] font-medium text-ink-soft hover:text-ink disabled:opacity-30 transition-colors px-2 py-1"
          >
            Next →
          </button>

          <div className="w-px h-4 bg-cream-border mx-1" />

          <input
            type="number"
            min={1}
            max={pageCount}
            value={currentPage}
            onChange={(e) => {
              const v = parseInt(e.target.value);
              if (v >= 1 && v <= pageCount) goToPage(v);
            }}
            className="doodle-input w-16 text-center text-[11px] px-2 py-1"
            aria-label="Go to page"
          />
        </div>
      )}
    </div>
  );
}
