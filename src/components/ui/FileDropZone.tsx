import { useCallback, useRef, useState } from 'react';
import { useFileStore } from '@/stores/file-store';

export function FileDropZone() {
  const { file, setFile } = useFileStore();
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const f = e.dataTransfer.files[0];
      if (f && f.type.startsWith('video/')) {
        setFile(f);
      }
    },
    [setFile]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) setFile(f);
    },
    [setFile]
  );

  if (file) {
    const sizeMB = (file.size / 1_000_000).toFixed(1);
    return (
      <div className="rounded-lg border border-zinc-700 bg-zinc-800/50 p-3">
        <div className="flex items-center justify-between">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-zinc-200">{file.name}</p>
            <p className="text-xs text-zinc-500">{sizeMB} MB</p>
          </div>
          <button
            onClick={() => setFile(null)}
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
