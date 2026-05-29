import { useProcessStore } from '@/stores/process-store';
import { useFileStore } from '@/stores/file-store';
import { downloadBlob } from '@/lib/utils/download';

export function OutputActions() {
  const outputBlob = useProcessStore((s) => s.outputBlob);
  const outputUrl = useProcessStore((s) => s.outputUrl);
  const label = useProcessStore((s) => s.label);
  const suffix = useProcessStore((s) => s.suffix);
  const fileName = useFileStore((s) => s.file?.name ?? 'output');

  const handleDownload = () => {
    if (!outputBlob) return;
    const ext = outputBlob.type.includes('gif')
      ? 'gif'
      : outputBlob.type.includes('mpeg')
        ? 'mp3'
        : 'mp4';
    const base = fileName.replace(/\.[^/.]+$/, '');
    downloadBlob(outputBlob, `${base}_${suffix}.${ext}`);
  };

  if (!outputBlob || !outputUrl) return null;

  const sizeMB = (outputBlob.size / 1_000_000).toFixed(1);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-emerald-400">{label}</span>
        <span className="font-mono text-zinc-500">{sizeMB} MB</span>
      </div>

      <button
        onClick={handleDownload}
        className="w-full rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-4 py-2.5 text-sm font-medium text-indigo-300 hover:bg-indigo-500/20 transition-colors"
      >
        Download File
      </button>

      {outputBlob.type.includes('gif') ? (
        <img
          src={outputUrl}
          alt="Processed GIF"
          className="w-full rounded-lg border border-zinc-800"
        />
      ) : outputBlob.type.includes('mpeg') ? null : (
        /* eslint-disable-next-line jsx-a11y/media-has-caption */
        <video
          src={outputUrl}
          controls
          className="w-full rounded-lg border border-zinc-800"
        />
      )}
    </div>
  );
}
