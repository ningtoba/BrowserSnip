import { useState } from 'react';
import { useProcessStore } from '@/stores/process-store';
import { useFileStore } from '@/stores/file-store';
import { downloadBlob, copyVideoToClipboard } from '@/lib/utils/clipboard';

export function OutputActions() {
  const outputBlob = useProcessStore((s) => s.outputBlob);
  const outputUrl = useProcessStore((s) => s.outputUrl);
  const fileName = useFileStore((s) => s.file?.name ?? 'output');
  const [copied, setCopied] = useState(false);

  const handleDownload = () => {
    if (!outputBlob) return;
    const ext = outputBlob.type.includes('gif')
      ? 'gif'
      : outputBlob.type.includes('mpeg')
        ? 'mp3'
        : 'mp4';
    const base = fileName.replace(/\.[^/.]+$/, '');
    downloadBlob(outputBlob, `${base}_processed.${ext}`);
  };

  const handleCopy = async () => {
    if (!outputBlob) return;
    const success = await copyVideoToClipboard(outputBlob);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (!outputBlob || !outputUrl) return null;

  const sizeMB = (outputBlob.size / 1_000_000).toFixed(1);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span>Output ready</span>
        <span className="font-mono">{sizeMB} MB</span>
      </div>

      <div className="flex gap-2">
        <button
          onClick={handleDownload}
          className="flex-1 rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-4 py-2.5 text-sm font-medium text-indigo-300 hover:bg-indigo-500/20 transition-colors"
        >
          Download File
        </button>

        <button
          onClick={handleCopy}
          className="rounded-lg border border-zinc-700 bg-zinc-800/50 px-4 py-2.5 text-sm font-medium text-zinc-300 hover:bg-zinc-800 transition-colors"
        >
          {copied ? 'Copied!' : 'Copy to Clipboard'}
        </button>
      </div>

      {/* Preview video */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        src={outputUrl}
        controls
        className="w-full rounded-lg border border-zinc-800"
      />
    </div>
  );
}
