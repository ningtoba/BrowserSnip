const AUDIO_BITRATE_KBPS = 128;

export function calculateBitrate(
  targetSizeMB: number,
  durationSeconds: number
): number {
  if (durationSeconds <= 0) return 1000;

  const targetBits = targetSizeMB * 1024 * 8;
  const videoBitrate = targetBits / durationSeconds - AUDIO_BITRATE_KBPS;

  return Math.max(Math.round(videoBitrate), 100);
}
