import { useCallback } from 'react';
import { useFileStore } from '@/stores/file-store';
import { usePDFEngine } from '@/hooks/usePDFEngine';

export function OrganizeTool() {
  const file = useFileStore((s) => s.file);
  const params = useFileStore((s) => s.params);
  const setParams = useFileStore((s) => s.setParams);
  const { process } = usePDFEngine();

  const pageOrder = (params.pageOrder as number[]) ?? [];
  const pageCount = pageOrder.length;
  const isDefaultOrder = pageOrder.every((p: number, i: number) => p === i);

  const handleProcess = useCallback(() => {
    if (pageOrder.length === 0) return;
    process({ toolId: 'organize', params: { pageOrder } });
  }, [process, pageOrder]);

  const handleReset = useCallback(() => {
    setParams({ ...params, pageOrder: Array.from({ length: pageCount }, (_, i) => i) });
  }, [params, setParams, pageCount]);

  if (!file) {
    return (
      <div className="doodle-section">
        <p className="text-xs font-semibold text-ink mb-1">Organize Pages</p>
        <p className="text-[11px] text-ink-muted">
          Import a PDF to reorder, rotate, or delete pages.
        </p>
      </div>
    );
  }

  return (
    <div className="doodle-section space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-ink">
          Organize {pageCount} Page{pageCount !== 1 ? 's' : ''}
        </p>
        {!isDefaultOrder && (
          <button
            onClick={handleReset}
            className="text-[10px] font-medium text-ink-muted hover:text-ink transition-colors"
          >
            Reset order
          </button>
        )}
      </div>

      <p className="text-[10px] text-ink-muted leading-relaxed">
        Drag page thumbnails in the main area to reorder them.
        {!isDefaultOrder && (
          <span className="block mt-1 text-accent font-medium">
            Custom order active — {pageCount} pages will be rearranged.
          </span>
        )}
      </p>

      <button onClick={handleProcess} id="tool-process-btn" className="doodle-btn w-full">
        Reorder Pages
      </button>
    </div>
  );
}
