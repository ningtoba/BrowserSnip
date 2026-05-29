import { useCallback, useRef } from 'react';
import { formatDisplayTime } from '@/lib/utils/time';

interface Props {
  duration: number;
  startTime: number;
  endTime: number;
  onStartChange: (t: number) => void;
  onEndChange: (t: number) => void;
}

export function TrimScrubber({
  duration,
  startTime,
  endTime,
  onStartChange,
  onEndChange,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);

  const getTimeFromPosition = useCallback(
    (clientX: number, _isStart: boolean): number => {
      const track = trackRef.current;
      if (!track) return 0;

      const rect = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return ratio * duration;
    },
    [duration]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent, handle: 'start' | 'end') => {
      e.preventDefault();
      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);

      const onMove = (ev: PointerEvent) => {
        const time = getTimeFromPosition(ev.clientX, handle === 'start');
        if (handle === 'start') {
          onStartChange(Math.min(time, endTime - 0.1));
        } else {
          onEndChange(Math.max(time, startTime + 0.1));
        }
      };

      const onUp = () => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
      };

      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
    },
    [getTimeFromPosition, startTime, endTime, onStartChange, onEndChange]
  );

  const startPct = (startTime / duration) * 100;
  const endPct = (endTime / duration) * 100;

  return (
    <div className="mt-4 space-y-2">
      <div className="flex justify-between text-[11px] text-ink-muted font-mono">
        <span>{formatDisplayTime(startTime)}</span>
        <span>{formatDisplayTime(endTime)}</span>
      </div>

      <div
        ref={trackRef}
        className="relative h-8 w-full cursor-pointer select-none rounded"
      >
        <div className="absolute top-1/2 h-1.5 w-full -translate-y-1/2 rounded-full bg-cream-border" />

        <div
          className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full"
          style={{
            left: `${startPct}%`,
            width: `${endPct - startPct}%`,
            background: 'linear-gradient(90deg, #6366f1, #818cf8)',
            boxShadow: '0 0 6px rgba(99, 102, 241, 0.4)',
          }}
        />

        <div
          onPointerDown={(e) => handlePointerDown(e, 'start')}
          className="absolute top-1/2 h-6 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-sm border-2 border-accent bg-cream shadow-lg hover:scale-125 hover:border-ink transition-all touch-none"
          style={{ left: `${startPct}%` }}
        />

        <div
          onPointerDown={(e) => handlePointerDown(e, 'end')}
          className="absolute top-1/2 h-6 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-sm border-2 border-accent bg-cream shadow-lg hover:scale-125 hover:border-ink transition-all touch-none"
          style={{ left: `${endPct}%` }}
        />
      </div>
    </div>
  );
}
