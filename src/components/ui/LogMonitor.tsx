import { useEffect, useRef } from 'react';
import { useProcessStore } from '@/stores/process-store';

export function LogMonitor() {
  const logs = useProcessStore((s) => s.logs);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length]);

  return (
    <div className="h-full overflow-y-auto bg-zinc-950 p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-500">FFmpeg Log</span>
        <span className="font-mono text-xs text-zinc-600">
          {logs.length} lines
        </span>
      </div>
      <div className="font-mono text-xs leading-relaxed">
        {logs.length === 0 && (
          <p className="text-zinc-700">Waiting for FFmpeg output...</p>
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
