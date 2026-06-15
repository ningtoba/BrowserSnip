import { useState, useEffect, useCallback, useRef } from 'react';
import { useFileStore } from '@/stores/file-store';
import * as renderer from '@/lib/renderer/core';

interface OrganizeMainProps {
  onOrderChange?: (order: number[]) => void;
}

export function OrganizeMain({ onOrderChange }: OrganizeMainProps) {
  const file = useFileStore((s) => s.file);
  const params = useFileStore((s) => s.params);
  const setParams = useFileStore((s) => s.setParams);

  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [pageCount, setPageCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const originalOrderRef = useRef<number[]>([]);
  const draggedPageRef = useRef<number | null>(null);
  const lastInsertRef = useRef<number | null>(null);
  // Keep a ref to pageOrder so drag handlers always read the latest value
  const pageOrderRef = useRef<number[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  const pageOrder: number[] =
    (params.pageOrder as number[]) ??
    (pageCount > 0 ? Array.from({ length: pageCount }, (_, i) => i) : []);

  // Keep ref in sync
  pageOrderRef.current = pageOrder;

  const updateOrder = useCallback(
    (next: number[]) => {
      setParams({ ...params, pageOrder: next });
      onOrderChange?.(next);
    },
    [params, setParams, onOrderChange],
  );

  // Load PDF and generate thumbnails
  useEffect(() => {
    if (!file) {
      setThumbnails([]);
      setPageCount(0);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const buf = await file.arrayBuffer();
        const doc = await renderer.loadDocument(buf);
        if (cancelled) return;

        const count = doc.numPages;
        setPageCount(count);

        const existing = params.pageOrder as number[] | undefined;
        if (!existing || existing.length !== count) {
          updateOrder(Array.from({ length: count }, (_, i) => i));
        }

        const thumbs = await renderer.generateThumbnails(doc, 150);
        if (cancelled) return;

        setThumbnails(thumbs);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load PDF');
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Drag & Drop — live reorder (app-icon style) ──

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      const el = e.currentTarget as HTMLElement;
      const pageIdx = parseInt(el.dataset.pageIdx || '', 10);
      if (isNaN(pageIdx)) return;

      const currentOrder = pageOrderRef.current;
      const visualIdx = currentOrder.indexOf(pageIdx);

      // Snapshot for cancel/restore
      originalOrderRef.current = [...currentOrder];
      draggedPageRef.current = pageIdx;
      lastInsertRef.current = null;

      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(pageIdx));

      // Create a visible drag image (the grid element will be dimmed)
      const rect = el.getBoundingClientRect();
      const clone = el.cloneNode(true) as HTMLElement;
      clone.style.position = 'fixed';
      clone.style.top = '-9999px';
      clone.style.left = '-9999px';
      clone.style.width = `${rect.width}px`;
      clone.style.opacity = '0.85';
      clone.style.transform = 'scale(1.05) rotate(2deg)';
      clone.style.zIndex = '9999';
      clone.style.pointerEvents = 'none';
      clone.style.boxShadow = '0 8px 30px rgba(0,0,0,0.3)';
      document.body.appendChild(clone);
      e.dataTransfer.setDragImage(clone, rect.width / 2, rect.height / 2);
      requestAnimationFrame(() => document.body.removeChild(clone));

      setDragIndex(visualIdx);
    },
    [],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const draggedPage = draggedPageRef.current;
    if (draggedPage === null) return;

    const el = e.currentTarget as HTMLElement;
    const hoveredPageIdx = parseInt(el.dataset.pageIdx || '', 10);
    if (isNaN(hoveredPageIdx)) return;

    const currentOrder = pageOrderRef.current;
    const hoveredVisualIdx = currentOrder.indexOf(hoveredPageIdx);
    const draggedVisualIdx = currentOrder.indexOf(draggedPage);
    if (hoveredVisualIdx === -1 || draggedVisualIdx === -1) return;

    // Determine insertion side from cursor position
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    let target = x > rect.width * 0.5 ? hoveredVisualIdx + 1 : hoveredVisualIdx;

    // Adjust target for removal of the dragged item
    if (draggedVisualIdx < target) target--;

    // Skip no-ops and duplicate firings
    if (target === draggedVisualIdx || target === lastInsertRef.current) return;
    lastInsertRef.current = target;

    // Live reorder: move the dragged page to the new position
    const next = [...currentOrder];
    next.splice(draggedVisualIdx, 1);
    next.splice(target, 0, draggedPage);
    updateOrder(next);
    setDragIndex(target);
  }, [updateOrder]);

  const handleDragLeave = useCallback(() => {
    // No-op: keep the live reorder state
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragIndex(null);
    draggedPageRef.current = null;
    lastInsertRef.current = null;
  }, []);

  const handleDragEnd = useCallback(() => {
    if (draggedPageRef.current !== null) {
      updateOrder(originalOrderRef.current);
    }
    setDragIndex(null);
    draggedPageRef.current = null;
    lastInsertRef.current = null;
  }, [updateOrder]);

  // Prevent default on the grid container so drops always work
  const handleContainerDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleContainerDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    handleDragEnd();
  }, [handleDragEnd]);

  // ── Keyboard reorder (accessibility) ──

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, visualIdx: number) => {
      if (e.key === 'ArrowLeft' && visualIdx > 0) {
        e.preventDefault();
        const next = [...pageOrder];
        [next[visualIdx - 1], next[visualIdx]] = [next[visualIdx], next[visualIdx - 1]];
        updateOrder(next);
      } else if (e.key === 'ArrowRight' && visualIdx < pageOrder.length - 1) {
        e.preventDefault();
        const next = [...pageOrder];
        [next[visualIdx], next[visualIdx + 1]] = [next[visualIdx + 1], next[visualIdx]];
        updateOrder(next);
      }
    },
    [pageOrder, updateOrder],
  );

  // ── Render ──

  if (!file) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center opacity-40">
          <div className="mb-4 text-5xl">📑</div>
          <p className="text-sm font-medium text-ink-muted">
            Import a PDF to organize its pages
          </p>
          <p className="mt-1.5 text-xs text-ink-muted/70">
            Drag & drop a file or use the upload area on the left
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
          <p className="text-xs text-ink-muted">Loading page thumbnails...</p>
          <div className="mt-3 flex gap-1.5 justify-center flex-wrap">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="w-24 h-32 rounded bg-cream-light border border-cream-border animate-pulse"
              />
            ))}
          </div>
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

  const isDefaultOrder = pageOrder.every((p, i) => p === i);
  const isDragging = dragIndex !== null;

  return (
    <div
      className="flex flex-col h-full"
      ref={containerRef}
      onDragOver={handleContainerDragOver}
      onDrop={handleContainerDrop}
    >
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-cream-border bg-cream-light/50 shrink-0">
        <div className="flex items-center gap-3">
          <p className="text-xs font-semibold text-ink">
            {pageCount} page{pageCount !== 1 ? 's' : ''}
          </p>
          {!isDefaultOrder && !isDragging && (
            <span className="text-[10px] text-accent font-medium">Custom order</span>
          )}
          {isDragging && (
            <span className="text-[10px] text-accent font-medium animate-pulse">
              Reordering…
            </span>
          )}
        </div>
        <p className="text-[10px] text-ink-muted hidden sm:block">
          Drag thumbnails to reorder · Arrow keys to move
        </p>
      </div>

      {/* Thumbnail grid */}
      <div className="flex-1 overflow-y-auto p-4">
        <div
          className="grid gap-3 justify-center"
          style={{
            gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
          }}
        >
          {pageOrder.map((pageIdx, visualIdx) => {
            const isBeingDragged = isDragging && pageIdx === draggedPageRef.current;

            return (
              <div
                key={`page-${pageIdx}`}
                data-page-idx={pageIdx}
                draggable
                tabIndex={0}
                role="listitem"
                aria-label={`Page ${pageIdx + 1}, position ${visualIdx + 1}`}
                aria-roledescription="draggable page thumbnail"
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onDragEnd={handleDragEnd}
                onKeyDown={(e) => handleKeyDown(e, visualIdx)}
                className={`
                  relative rounded-doodle-md overflow-hidden
                  transition-all duration-200 ease-out
                  cursor-grab active:cursor-grabbing
                  focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none
                  ${isBeingDragged
                    ? 'opacity-20 scale-90 shadow-2xl z-10'
                    : 'opacity-100 border-2 border-transparent hover:border-cream-border hover:shadow-doodle-card'
                  }
                `}
              >
                <img
                  src={thumbnails[pageIdx]}
                  alt={`Page ${pageIdx + 1}`}
                  className="w-full h-auto block select-none pointer-events-none"
                  draggable={false}
                />

                {/* Original page number (bottom-left) */}
                <span className="absolute bottom-0 left-0 bg-cream/90 text-[10px] font-mono text-ink-muted px-1.5 py-0.5 rounded-tr select-none pointer-events-none">
                  p{pageIdx + 1}
                </span>

                {/* Position badge (top-right) */}
                <span
                  className={`
                    absolute top-1 right-1 w-5 h-5 rounded-full
                    flex items-center justify-center
                    text-[10px] font-bold text-white select-none pointer-events-none
                    transition-colors
                    ${isBeingDragged
                      ? 'bg-accent'
                      : isDefaultOrder
                      ? 'bg-ink-muted/50'
                      : 'bg-accent'
                    }
                  `}
                >
                  {visualIdx + 1}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
