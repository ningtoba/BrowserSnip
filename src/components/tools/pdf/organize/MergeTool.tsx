import { useState, useCallback } from 'react';
import { useFileStore } from '@/stores/file-store';
import { usePDFEngine } from '@/hooks/usePDFEngine';

export function MergeTool() {
  const files = useFileStore((s) => s.files);
  const reorderFiles = useFileStore((s) => s.reorderFiles);
  const { process } = usePDFEngine();
  const [order, setOrder] = useState<number[]>([]);

  const handleProcess = useCallback(() => {
    process({
      toolId: 'merge',
      params: { fileOrder: order },
    });
  }, [process, order]);

  if (files.length < 2) {
    return (
      <div className="doodle-section">
        <p className="text-xs font-semibold text-ink mb-1">Merge PDF</p>
        <p className="text-[11px] text-ink-muted">
          Add at least 2 PDF files to merge them into a single document.
        </p>
      </div>
    );
  }

  return (
    <div className="doodle-section space-y-3">
      <p className="text-xs font-semibold text-ink">
        Merge {files.length} PDFs
      </p>

      <div className="space-y-1.5">
        {files.map((f, i) => (
          <div
            key={`${f.name}-${i}`}
            className="flex items-center gap-2 p-2 rounded bg-cream border border-cream-border"
          >
            <span className="text-[10px] font-mono text-ink-muted w-5 text-center">
              {i + 1}
            </span>
            <span className="text-[11px] text-ink truncate flex-1">{f.name}</span>
            <div className="flex gap-1">
              <button
                onClick={() => reorderFiles(i, i - 1)}
                disabled={i === 0}
                className="text-[10px] text-ink-muted hover:text-ink disabled:opacity-20 px-1"
              >
                ↑
              </button>
              <button
                onClick={() => reorderFiles(i, i + 1)}
                disabled={i === files.length - 1}
                className="text-[10px] text-ink-muted hover:text-ink disabled:opacity-20 px-1"
              >
                ↓
              </button>
            </div>
          </div>
        ))}
      </div>

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn">
        Merge {files.length} Files
      </button>
    </div>
  );
}
