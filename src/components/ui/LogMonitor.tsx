import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { useProcessStore } from '@/stores/process-store';
import { easeOut } from '@/lib/motion';

export function LogMonitor() {
  const logs = useProcessStore((s) => s.logs);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length]);

  // Window the tail, but key each line by its GLOBAL index so only newly
  // appended lines mount (and slide in) — older lines stay put.
  const tail = logs.slice(-100);
  const startIndex = logs.length - tail.length;

  return (
    <div className="h-full overflow-y-auto bg-cream-soft p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-ink-soft">FFmpeg Log</span>
        <span className="font-mono text-[11px] text-ink-muted tabular-nums">
          {logs.length} lines
        </span>
      </div>
      <div className="rounded-doodle-md border border-cream-border bg-white p-3 font-mono text-[11px] leading-relaxed text-ink-soft">
        {logs.length === 0 && (
          <p className="text-ink-muted italic">Waiting for FFmpeg output...</p>
        )}
        {tail.map((line, i) => (
          <motion.div
            key={startIndex + i}
            className="log-line"
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ ...easeOut, duration: 0.22 }}
          >
            {line}
          </motion.div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
