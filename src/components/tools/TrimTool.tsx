import { useState, useEffect, useCallback, useRef } from 'react';
import type { TrimParams } from '@/types';
import { useFFmpeg } from '@/hooks/useFFmpeg';
import { trimCommand } from '@/lib/ffmpeg/commands';
import { useFileStore } from '@/stores/file-store';
import { TrimScrubber } from '@/components/player/TrimScrubber';
import { formatDisplayTime } from '@/lib/utils/time';

function formatInput(seconds: number): string {
  return seconds.toFixed(3);
}

export function TrimTool() {
  const { process } = useFFmpeg();
  const file = useFileStore((s) => s.file);
  const storeParams = useFileStore((s) => s.params);
  const setStoreParams = useFileStore((s) => s.setParams);

  const [duration, setDuration] = useState(60);
  const [params, setParams] = useState<TrimParams>(() => {
    const p = storeParams as unknown as TrimParams;
    if (p.startTime !== undefined && p.endTime !== undefined) return p;
    return { startTime: 0, endTime: 60 };
  });
  const [running, setRunning] = useState(false);

  useEffect(() => {
    setStoreParams(params as unknown as Record<string, unknown>);
  }, [params, setStoreParams]);

  const [startText, setStartText] = useState(formatInput(params.startTime));
  const [endText, setEndText] = useState(formatInput(params.endTime));
  const startFocusedRef = useRef(false);
  const endFocusedRef = useRef(false);

  useEffect(() => {
    if (!startFocusedRef.current) setStartText(formatInput(params.startTime));
  }, [params.startTime]);

  useEffect(() => {
    if (!endFocusedRef.current) setEndText(formatInput(params.endTime));
  }, [params.endTime]);

  useEffect(() => {
    if (!file) return;
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const dur = video.duration;
      setDuration(dur);
      setParams({ startTime: 0, endTime: dur });
      setStartText(formatInput(0));
      setEndText(formatInput(dur));
      URL.revokeObjectURL(video.src);
    };
    video.src = URL.createObjectURL(file);
  }, [file]);

  const clamp = (v: number, min: number, max: number) =>
    Math.max(min, Math.min(max, v));

  const commitStart = useCallback(() => {
    const raw = parseFloat(startText);
    const t = Number.isFinite(raw)
      ? clamp(raw, 0, params.endTime - 0.001)
      : params.startTime;
    setParams((p) => ({ ...p, startTime: t }));
    setStartText(formatInput(t));
  }, [startText, params.endTime, params.startTime]);

  const commitEnd = useCallback(() => {
    const raw = parseFloat(endText);
    const t = Number.isFinite(raw)
      ? clamp(raw, params.startTime + 0.001, duration)
      : params.endTime;
    setParams((p) => ({ ...p, endTime: t }));
    setEndText(formatInput(t));
  }, [endText, params.startTime, duration, params.endTime]);

  const handleProcess = async () => {
    if (!file) return;
    setRunning(true);
    try {
      const args = trimCommand('input.mp4', 'output.mp4', params);
      await process(args, file, 'output.mp4', {
        duration,
        width: 1920,
        height: 1080,
        codec: 'h264',
        fileSize: file.size,
        fileName: file.name,
      }, 'Trimmed video', 'trimmed');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mt-4 space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-extrabold text-ink-soft">
            Start Time (seconds)
          </label>
          <input
            type="text"
            inputMode="decimal"
            value={startText}
            onChange={(e) => setStartText(e.target.value)}
            onFocus={() => { startFocusedRef.current = true; }}
            onBlur={() => { startFocusedRef.current = false; commitStart(); }}
            onKeyDown={(e) => { if (e.key === 'Enter') commitStart(); }}
            className="doodle-input"
          />
          <p className="font-mono text-xs text-ink-muted">
            {formatDisplayTime(params.startTime)}
          </p>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-extrabold text-ink-soft">
            End Time (seconds)
          </label>
          <input
            type="text"
            inputMode="decimal"
            value={endText}
            onChange={(e) => setEndText(e.target.value)}
            onFocus={() => { endFocusedRef.current = true; }}
            onBlur={() => { endFocusedRef.current = false; commitEnd(); }}
            onKeyDown={(e) => { if (e.key === 'Enter') commitEnd(); }}
            className="doodle-input"
          />
          <p className="font-mono text-xs text-ink-muted">
            {formatDisplayTime(params.endTime)}
          </p>
        </div>
      </div>

      <div className="flex justify-between rounded-doodle border-2 border-cream-border bg-cream-light px-3 py-2">
        <span className="text-xs font-bold text-ink-soft">Selected Duration</span>
        <span className="font-mono text-xs font-extrabold text-accent">
          {(params.endTime - params.startTime).toFixed(3)}s
        </span>
      </div>

      <TrimScrubber
        duration={duration}
        startTime={params.startTime}
        endTime={params.endTime}
        onStartChange={(t) => {
          setParams((p) => ({ ...p, startTime: t }));
          setStartText(formatInput(t));
        }}
        onEndChange={(t) => {
          setParams((p) => ({ ...p, endTime: t }));
          setEndText(formatInput(t));
        }}
      />

      <p className="text-xs leading-relaxed text-ink-muted">
        Uses <span className="font-bold text-ink-soft">stream copy</span> — copies the
        original video data directly without decoding or re-encoding. Near-instant,
        preserves the exact quality and bitrate of your source.
      </p>

      <button
        onClick={handleProcess}
        disabled={running}
        className="doodle-btn"
      >
        {running ? 'Cutting...' : 'Trim Video'}
      </button>
    </div>
  );
}
