/**
 * ImageToPdfMain — shows uploaded image previews in a thumbnail grid.
 * Shared by Image-to-PDF and Digitize Document tools.
 */
import { useState, useMemo, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { scaleIn } from '@/lib/motion';
import { useFileStore } from '@/stores/file-store';

export function ImageToPdfMain() {
  const files = useFileStore((s) => s.files);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const prevUrlsRef = useRef<string[]>([]);

  // Create object URLs, cleaning up previous ones
  const imageUrls = useMemo(() => {
    // Revoke previous URLs
    for (const url of prevUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
    const urls = files.map((f) => URL.createObjectURL(f));
    prevUrlsRef.current = urls;
    return urls;
  }, [files]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const url of prevUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
    };
  }, []);

  // Reset selected index if it goes out of bounds
  useEffect(() => {
    if (selectedIdx >= files.length && files.length > 0) {
      setSelectedIdx(0);
    }
  }, [files.length, selectedIdx]);

  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <motion.div
          initial="hidden"
          animate="visible"
          variants={scaleIn}
          className="text-center opacity-40"
        >
          <div className="mb-4 text-5xl">🖼️</div>
          <p className="text-sm font-medium text-ink-muted">
            Import images to get started
          </p>
          <p className="mt-1.5 text-xs text-ink-muted/70">
            Supports JPG, PNG, WEBP, GIF, AVIF, TIFF
          </p>
        </motion.div>
      </div>
    );
  }

  const safeIdx = Math.min(selectedIdx, files.length - 1);
  const selected = files[safeIdx];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Selected image preview */}
      <div className="flex-1 min-h-0 flex items-center justify-center bg-cream-soft p-4">
        {selected && (
          <img
            src={imageUrls[safeIdx]}
            alt={selected.name}
            className="max-h-full max-w-full rounded-lg object-contain shadow-doodle-card"
            onError={(e) => {
              // Show fallback if image fails to load
              const el = e.currentTarget;
              el.style.display = 'none';
              const parent = el.parentElement;
              if (parent && !parent.querySelector('.preview-error')) {
                const fallback = document.createElement('div');
                fallback.className = 'preview-error text-center opacity-40';
                fallback.innerHTML = `<div class="text-3xl mb-1">🖼️</div><p class="text-[11px] text-ink-muted">Preview unavailable</p>`;
                parent.appendChild(fallback);
              }
            }}
          />
        )}
      </div>

      {/* Thumbnail strip */}
      {files.length > 1 && (
        <div className="shrink-0 flex gap-2 overflow-x-auto border-t border-cream-border bg-cream-light/70 p-3 scrollbar-hide">
          {files.map((f, i) => (
            <motion.button
              key={`${f.name}-${i}-${f.size}`}
              onClick={() => setSelectedIdx(i)}
              whileHover={{ y: -2 }}
              whileTap={{ scale: 0.97 }}
              transition={{ duration: 0.2 }}
              className={`shrink-0 overflow-hidden rounded-md border-2 transition-all ${
                i === safeIdx
                  ? 'border-accent bg-accent/[0.06] ring-1 ring-accent/30 shadow-glow'
                  : 'border-cream-border bg-white hover:border-[#D5D5CD]'
              }`}
            >
              <img
                src={imageUrls[i]}
                alt={f.name}
                className="h-16 w-16 object-cover"
                onError={(e) => {
                  // Hide broken thumbnail
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                }}
              />
            </motion.button>
          ))}
        </div>
      )}
    </div>
  );
}
