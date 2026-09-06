import { motion } from 'framer-motion';
import { useProcessStore } from '@/stores/process-store';
import { springSoft } from '@/lib/motion';

export function ProgressBar() {
  const progress = useProcessStore((s) => s.progress);
  const current = useProcessStore((s) => s.currentProgress);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 font-semibold text-accent">
          <motion.span
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full bg-accent"
            animate={{ opacity: [1, 0.35, 1], scale: [1, 0.85, 1] }}
            transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
          />
          Processing...
        </span>
        <span className="font-mono text-ink-soft font-medium tabular-nums">{progress.toFixed(0)}%</span>
      </div>

      <div className="h-2 overflow-hidden rounded-full bg-cream-border">
        <motion.div
          className="h-full rounded-full bg-accent"
          initial={false}
          animate={{ width: `${progress}%` }}
          transition={springSoft}
        />
      </div>

      {current && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-ink-muted tabular-nums">
          <span>time={current.time}</span>
          {current.frame > 0 && <span>frame={current.frame}</span>}
          {current.fps > 0 && <span>fps={current.fps}</span>}
        </div>
      )}
    </div>
  );
}
