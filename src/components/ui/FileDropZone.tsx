import { useCallback, useRef, useState } from 'react';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import { getFFmpeg, terminateFFmpeg } from '@/lib/ffmpeg/core';

async function probeCodec(file: File): Promise<string | null> {
  try {
    const ffmpeg = await getFFmpeg();
    const logs: string[] = [];

    const handler = ({ message }: { message: string }) => {
      logs.push(message);
    };
    ffmpeg.on('log', handler);

    const inputName = 'probe_input';
    await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));

    await ffmpeg.exec(['-i', inputName, '-f', 'null', '-']);

    ffmpeg.off('log', handler);

    try { await ffmpeg.deleteFile(inputName); } catch { /* ok */ }

    const allLogs = logs.join('\n');
    if (allLogs.includes('av1') || allLogs.includes('av01')) {
      return 'AV1 video detected — video decoding is not supported by ffmpeg.wasm. Stream-copy tools (Trim, Mute, Metadata Strip, Extract Audio) will work. Re-encode tools (Resize, Crop, Volume, Speed, GIF, Compress) will fail.';
    }
    return null;
  } catch {
    return null;
  } finally {
    await terminateFFmpeg();
  }
}

export function FileDropZone() {
  const { file, setFile, setCodecWarning, setProbing, probing } = useFileStore();
  const resetProcess = useProcessStore((s) => s.reset);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    (f: File | null) => {
      resetProcess();
      setFile(f);
      setCodecWarning(null);

      if (f) {
        setProbing(true);
        probeCodec(f).then((warning) => {
          if (warning) setCodecWarning(warning);
          setProbing(false);
        });
      }
    },
    [setFile, resetProcess, setCodecWarning]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const f = e.dataTransfer.files[0];
      if (f && f.type.startsWith('video/')) {
        handleFile(f);
      }
    },
    [handleFile]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) handleFile(f);
    },
    [handleFile]
  );

  if (file) {
    const sizeMB = (file.size / 1_000_000).toFixed(1);
    return (
      <div className="rounded-doodle-md border border-cream-border bg-cream-light/60 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] font-semibold text-ink">{file.name}</p>
            <p className="text-[11px] text-ink-muted">
              {probing ? 'Probing codec...' : `${sizeMB} MB`}
            </p>
          </div>
          <button
            onClick={() => handleFile(null)}
            className="shrink-0 text-[11px] font-medium text-ink-muted hover:text-danger transition-colors px-1"
          >
            Remove
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      className={`cursor-pointer rounded-doodle-md border border-dashed p-6 sm:p-8 text-center transition-all duration-200 ${
        isDragging
          ? 'border-accent bg-accent/5 scale-[1.01]'
          : 'border-cream-border hover:border-ink-muted/40 hover:bg-cream-light/40'
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        onChange={handleChange}
        className="hidden"
      />
      <div className="mb-2 text-2xl opacity-40">📁</div>
      <p className="text-xs font-medium text-ink-soft">
        Drop a video file or click to browse
      </p>
      <p className="mt-1 text-[11px] text-ink-muted">
        Max recommended: 500 MB
      </p>
    </div>
  );
}
