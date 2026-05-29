import { useEffect, useRef } from 'react';
import { useProcessStore } from '@/stores/process-store';

export function LogMonitor() {
  const logs = useProcessStore((s) => s.logs);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length]);

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-ink-soft">FFmpeg Log</span>
        <span className="font-mono text-[11px] text-ink-muted">
          {logs.length} lines
        </span>
      </div>
      <div className="font-mono text-[11px] leading-relaxed">
        {logs.length === 0 && (
          <p className="text-ink-muted italic">Waiting for FFmpeg output...</p>
        )}
        {logs.slice(-100).map((line, i) => (
          <div key={i} className="log-line">
            {line}
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
