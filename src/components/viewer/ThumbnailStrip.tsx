import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useFileStore } from '@/stores/file-store';
import * as renderer from '@/lib/renderer/core';
import { fadeUp, staggerParent } from '@/lib/motion';

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
            className="w-20 h-28 rounded-[10px] bg-white border border-cream-border animate-pulse shrink-0"
          />
        ))}
      </div>
    );
  }

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={staggerParent}
      className="flex gap-2 overflow-x-auto py-2 scrollbar-hide"
      role="listbox"
      aria-label="Page thumbnails"
    >
      {thumbnails.map((thumb, idx) => {
        const pageNum = idx + 1;
        const isSelected = selectedPages.includes(pageNum);

        return (
          <motion.button
            key={idx}
            variants={fadeUp}
            transition={{ delay: Math.min(idx, 8) * 0.03 }}
            whileHover={{ y: -2 }}
            whileTap={{ scale: 0.97 }}
            onClick={() => {
              if (multiSelect) {
                onSelectPage?.(pageNum);
              } else {
                onSelectPage?.(pageNum);
              }
            }}
            className={`relative shrink-0 overflow-hidden rounded-[10px] border transition-colors duration-150 ${
              isSelected
                ? 'border-accent/60 bg-accent/[0.06] shadow-glow'
                : 'border-cream-border bg-white hover:border-[#D5D5CD]'
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
            <span className="absolute bottom-0 left-0 right-0 bg-white/85 text-[9px] font-mono text-ink-soft text-center py-0.5 tabular-nums">
              {pageNum}
            </span>
          </motion.button>
        );
      })}
    </motion.div>
  );
}
