import { useEffect, useState } from 'react';
import { useFileStore } from '@/stores/file-store';
import * as renderer from '@/lib/renderer/core';

interface ThumbnailStripProps {
  onSelectPage?: (pageNum: number) => void;
  selectedPages?: number[];
  multiSelect?: boolean;
}

export function ThumbnailStrip({
  onSelectPage,
  selectedPages = [],
  multiSelect = false,
}: ThumbnailStripProps) {
  const file = useFileStore((s) => s.file);
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!file) {
      setThumbnails([]);
      return;
    }

    let cancelled = false;
    setLoading(true);

    (async () => {
      try {
        const buf = await file.arrayBuffer();
        const doc = await renderer.loadDocument(buf);
        const thumbs = await renderer.generateThumbnails(doc, 150);
        if (!cancelled) {
          setThumbnails(thumbs);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file]);

  if (!file) return null;

  if (loading) {
    return (
      <div className="flex gap-2 overflow-x-auto py-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="w-20 h-28 rounded bg-cream-light border border-cream-border animate-pulse shrink-0"
          />
        ))}
      </div>
    );
  }

  return (
    <div className="flex gap-2 overflow-x-auto py-2 scrollbar-hide" role="listbox" aria-label="Page thumbnails">
      {thumbnails.map((thumb, idx) => {
        const pageNum = idx + 1;
        const isSelected = selectedPages.includes(pageNum);

        return (
          <button
            key={idx}
            onClick={() => {
              if (multiSelect) {
                onSelectPage?.(pageNum);
              } else {
                onSelectPage?.(pageNum);
              }
            }}
            className={`relative shrink-0 rounded overflow-hidden border-2 transition-all duration-150 ${
              isSelected
                ? 'border-accent shadow-glow'
                : 'border-transparent hover:border-cream-border'
            }`}
            role="option"
            aria-selected={isSelected}
            aria-label={`Page ${pageNum}`}
          >
            <img
              src={thumb}
              alt={`Page ${pageNum}`}
              className="w-16 h-24 object-cover"
              loading="lazy"
            />
            <span className="absolute bottom-0 left-0 right-0 bg-cream/80 text-[9px] font-mono text-ink-muted text-center py-0.5">
              {pageNum}
            </span>
          </button>
        );
      })}
    </div>
  );
}
