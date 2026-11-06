/**
 * The single byte formatter.
 *
 * `formatFileSize` (used by the components) and `describeSize` (used by the tool
 * layer, and accepting the raw types a run has to hand) both delegate here, so
 * one file cannot be "2.0 KB" in the result card and "2.00 KB" in the log line
 * underneath it.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal is enough to tell 1.4 MB from 1.5 MB; past three digits the
  // fraction is noise ("292.96 KB"), and bytes are whole numbers. This is the
  // rule the components already displayed, so unifying did not move the UI.
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}
