import { useMemo } from 'react';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';

export function VideoPreview() {
  const file = useFileStore((s) => s.file);
  const outputUrl = useProcessStore((s) => s.outputUrl);
  const isProcessing = useProcessStore((s) => s.isProcessing);

  const inputUrl = useMemo(
    () => (file ? URL.createObjectURL(file) : null),
    [file]
  );

  const src = outputUrl || inputUrl;

  if (!src) return null;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="overflow-hidden rounded-lg border border-zinc-800 bg-black">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          src={src}
          controls
          className={`w-full ${isProcessing ? 'opacity-50' : ''}`}
        >
          Your browser does not support the video element.
        </video>
      </div>
      {outputUrl && (
        <p className="mt-2 text-center text-xs text-emerald-500">
          Processed output preview
        </p>
      )}
    </div>
  );
}
