import { useMemo } from 'react';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';

export function VideoPreview() {
  const file = useFileStore((s) => s.file);
  const isProcessing = useProcessStore((s) => s.isProcessing);

  const inputUrl = useMemo(
    () => (file ? URL.createObjectURL(file) : null),
    [file]
  );

  if (!inputUrl) return null;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="sketch-border overflow-hidden bg-ink">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          src={inputUrl}
          controls
          className={`w-full ${isProcessing ? 'opacity-50' : ''}`}
        >
          Your browser does not support the video element.
        </video>
      </div>
      <p className="mt-2 text-center text-xs font-bold text-ink-muted">
        Original source
      </p>
    </div>
  );
}
