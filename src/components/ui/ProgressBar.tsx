import { useProcessStore } from '@/stores/process-store';

export function ProgressBar() {
  const progress = useProcessStore((s) => s.progress);
  const current = useProcessStore((s) => s.currentProgress);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-semibold text-accent">Processing...</span>
        <span className="font-mono text-ink-soft font-medium">{progress.toFixed(0)}%</span>
      </div>

      <div className="h-2 overflow-hidden rounded-full bg-cream-border">
        <div
          className="h-full rounded-full transition-all duration-300 ease-out"
          style={{
            width: `${progress}%`,
            background: 'linear-gradient(90deg, #6366f1, #818cf8)',
            boxShadow: '0 0 8px rgba(99, 102, 241, 0.4)',
          }}
        />
      </div>

      {current && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-ink-muted">
          <span>time={current.time}</span>
          {current.frame > 0 && <span>frame={current.frame}</span>}
          {current.fps > 0 && <span>fps={current.fps}</span>}
        </div>
      )}
    </div>
  );
}
