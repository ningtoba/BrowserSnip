import { useProcessStore } from '@/stores/process-store';

export function ProgressBar() {
  const progress = useProcessStore((s) => s.progress);
  const current = useProcessStore((s) => s.currentProgress);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm">
        <span className="font-extrabold text-accent">Processing...</span>
        <span className="font-mono text-ink-soft font-bold">{progress.toFixed(0)}%</span>
      </div>

      <div className="h-3 overflow-hidden rounded-full border-2 border-cream-border bg-cream-light">
        <div
          className="h-full rounded-full bg-accent transition-all duration-300 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>

      {current && (
        <div className="flex gap-4 font-mono text-xs text-ink-muted">
          <span>time={current.time}</span>
          {current.frame > 0 && <span>frame={current.frame}</span>}
          {current.fps > 0 && <span>fps={current.fps}</span>}
        </div>
      )}
    </div>
  );
}
