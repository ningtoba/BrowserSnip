import type { FFmpegProgress } from '@/types';

const TIME_RE = /time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/;
const FRAME_RE = /frame=\s*(\d+)/;
const FPS_RE = /fps=\s*(\d+)/;

export function parseLogLine(line: string): Partial<FFmpegProgress> | null {
  const timeMatch = line.match(TIME_RE);
  if (!timeMatch) return null;

  const hours = parseInt(timeMatch[1], 10);
  const minutes = parseInt(timeMatch[2], 10);
  const seconds = parseInt(timeMatch[3], 10);
  const centiseconds = parseInt(timeMatch[4], 10);

  const totalSeconds =
    hours * 3600 + minutes * 60 + seconds + centiseconds / 100;

  const result: Partial<FFmpegProgress> = {
    time: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`,
  };

  const frameMatch = line.match(FRAME_RE);
  if (frameMatch) result.frame = parseInt(frameMatch[1], 10);

  const fpsMatch = line.match(FPS_RE);
  if (fpsMatch) result.fps = parseFloat(fpsMatch[1]);

  return result;
}

export function calculateProgress(
  currentTimeSeconds: number,
  durationSeconds: number
): number {
  if (durationSeconds <= 0) return 0;
  const pct = (currentTimeSeconds / durationSeconds) * 100;
  return Math.min(Math.max(pct, 0), 100);
}
