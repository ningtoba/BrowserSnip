import { useState } from 'react';
import { useFFmpeg } from '@/hooks/useFFmpeg';
import { metadataCommand } from '@/lib/ffmpeg/commands';
import { useFileStore } from '@/stores/file-store';

export function MetadataTool() {
  const { process } = useFFmpeg();
  const file = useFileStore((s) => s.file);
  const [running, setRunning] = useState(false);

  const handleStrip = async () => {
    if (!file) return;
    setRunning(true);
    try {
      const args = metadataCommand('input.mp4', 'output.mp4');
      await process(args, file, 'output.mp4', {
        duration: 60,
        width: 1920,
        height: 1080,
        codec: 'h264',
        fileSize: file.size,
        fileName: file.name,
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mt-4 space-y-3">
      <button
        onClick={handleStrip}
        disabled={running}
        className="w-full rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-300 hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
      >
        {running ? 'Stripping...' : 'Strip Metadata'}
      </button>
      <p className="text-xs text-zinc-600">
        Removes all EXIF data, location tags, creation markers, and hidden
        metadata tracks. Uses stream copy for near-instant execution.
      </p>
    </div>
  );
}
