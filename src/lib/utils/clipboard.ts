export async function copyVideoToClipboard(blob: Blob): Promise<boolean> {
  try {
    if (!navigator.clipboard?.write) return false;

    const type = blob.type || 'video/mp4';
    await navigator.clipboard.write([
      new ClipboardItem({ [type]: blob }),
    ]);
    return true;
  } catch {
    return false;
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
