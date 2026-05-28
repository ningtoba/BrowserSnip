export const PRESETS: Record<string, { width: number; height: number }> = {
  '1080p': { width: 1920, height: 1080 },
  '720p': { width: 1280, height: 720 },
  '480p': { width: 854, height: 480 },
  '360p': { width: 640, height: 360 },
};

export function calculateHeight(
  width: number,
  originalWidth: number,
  originalHeight: number
): number {
  if (originalWidth <= 0) return width;
  return Math.round(width * (originalHeight / originalWidth));
}

export function calculateWidth(
  height: number,
  originalWidth: number,
  originalHeight: number
): number {
  if (originalHeight <= 0) return height;
  return Math.round(height * (originalWidth / originalHeight));
}
