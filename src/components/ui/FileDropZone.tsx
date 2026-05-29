import { useCallback, useRef, useState, useEffect } from 'react';
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

    // Read headers only — no encoding, just stream detection
    await ffmpeg.exec(['-i', inputName, '-f', 'null', '-']);

    ffmpeg.off('log', handler);

    try { await ffmpeg.deleteFile(inputName); } catch { /* ok */ }

    const allLogs = logs.join('\n');
    if (allLogs.includes('av1') || allLogs.includes('av01')) {
      return 'AV1 video detected — video decoding is not supported by ffmpeg.wasm. Stream-copy tools (Trim, Mute, Metadata Strip, Extract Audio) will work. Re-encode tools (Resize, Crop, Volume, Speed, GIF, Compress) will fail.';
    }
    return null;
  } catch {
    // Probe failed — let the actual processing surface any issues
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
      <div className="rounded-lg border border-zinc-700 bg-zinc-800/50 p-3">
        <div className="flex items-center justify-between">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-zinc-200">{file.name}</p>
            <p className="text-xs text-zinc-500">
              {probing ? 'Probing codec...' : `${sizeMB} MB`}
            </p>
          </div>
          <button
            onClick={() => handleFile(null)}
            className="ml-2 shrink-0 text-xs text-zinc-500 hover:text-red-400 transition-colors"
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
      className={`cursor-pointer rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
        isDragging
          ? 'border-indigo-400 bg-indigo-500/10'
          : 'border-zinc-700 hover:border-zinc-500'
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        onChange={handleChange}
        className="hidden"
      />
      <p className="text-sm text-zinc-400">
        Drop a video file here or click to browse
      </p>
      <p className="mt-1 text-xs text-zinc-600">
        Max recommended size: 500 MB
      </p>
    </div>
  );
}
