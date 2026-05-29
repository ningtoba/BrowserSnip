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
    <div className="animate-doodle-pop space-y-4">
      <div className="flex items-center justify-between text-sm">
        <span className="font-extrabold text-success flex items-center gap-1.5">
          <span>✓</span> {label}
        </span>
        <span className="font-mono font-bold text-ink-muted">{sizeMB} MB</span>
      </div>

      <button
        onClick={handleDownload}
        className="doodle-btn"
      >
        Download File
      </button>

      {outputBlob.type.includes('gif') ? (
        <img
          src={outputUrl}
          alt="Processed GIF"
          className="w-full sketch-border"
        />
      ) : outputBlob.type.includes('mpeg') ? null : (
        /* eslint-disable-next-line jsx-a11y/media-has-caption */
        <video
          src={outputUrl}
          controls
          className="w-full sketch-border"
        />
      )}
    </div>
  );
}
