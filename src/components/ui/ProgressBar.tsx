import { useProcessStore } from '@/stores/process-store';

export function ProgressBar() {
  const progress = useProcessStore((s) => s.progress);
  const current = useProcessStore((s) => s.currentProgress);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-indigo-300">Processing...</span>
        <span className="font-mono text-zinc-500">{progress.toFixed(0)}%</span>
      </div>

      <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
        <div
          className="h-full rounded-full bg-indigo-500 transition-all duration-300 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>

      {current && (
        <div className="flex gap-4 font-mono text-xs text-zinc-600">
          <span>time={current.time}</span>
          {current.frame > 0 && <span>frame={current.frame}</span>}
          {current.fps > 0 && <span>fps={current.fps}</span>}
        </div>
      )}
    </div>
  );
}
