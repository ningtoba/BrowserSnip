import { useState, useCallback } from 'react';
import { useFFmpeg } from '@/hooks/useFFmpeg';
import { buildConcatArgs } from '@/lib/ffmpeg/commands';
import { useFileStore } from '@/stores/file-store';

export function StitchTool() {
  const { process } = useFFmpeg();
  const { files, addFile, removeFile, reorderFiles, clearCurrent } = useFileStore();
  const [running, setRunning] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const droppedFiles = Array.from(e.dataTransfer.files).filter((f) =>
        f.type.startsWith('video/')
      );
      droppedFiles.forEach((f) => addFile(f));
    },
    [addFile]
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = Array.from(e.target.files ?? []);
      selected.forEach((f) => addFile(f));
      e.target.value = '';
    },
    [addFile]
  );

  const handleDragStart = (idx: number) => setDragIdx(idx);
  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    if (dragIdx !== null && dragIdx !== idx) {
      reorderFiles(dragIdx, idx);
      setDragIdx(idx);
    }
  };
  const handleDragEnd = () => setDragIdx(null);

  const handleProcess = async () => {
    if (files.length < 2) return;
    setRunning(true);
    try {
      // Use the first file as the "primary" for the process hook
      const primaryFile = files[0];
      const inputNames = files.map((_, i) => `input_${i}.mp4`);
      const { args, listName, listContent } = buildConcatArgs(inputNames, 'output.mp4');

      await process(
        args,
        primaryFile,
        'output.mp4',
        {
          duration: 60,
          width: 1920,
          height: 1080,
          codec: 'h264',
          fileSize: files.reduce((sum, f) => sum + f.size, 0),
          fileName: 'merged.mp4',
        },
        'Merged video',
        'merged',
        async (ffmpeg) => {
          // Write all files and the concat list
          for (let i = 0; i < files.length; i++) {
            const buf = await files[i].arrayBuffer();
            await ffmpeg.writeFile(inputNames[i], new Uint8Array(buf));
          }
          await ffmpeg.writeFile(listName, listContent);
        }
      );
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mt-4 space-y-4">
      <div
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        className="cursor-pointer rounded-lg border-2 border-dashed border-zinc-700 p-6 text-center hover:border-zinc-500 transition-colors"
      >
        <input
          type="file"
          accept="video/*"
          multiple
          onChange={handleFileChange}
          className="hidden"
          id="stitch-file-input"
        />
        <label htmlFor="stitch-file-input" className="cursor-pointer">
          <p className="text-sm text-zinc-400">
            Drop video files here or click to browse
          </p>
          <p className="mt-1 text-xs text-zinc-600">
            Select 2 or more videos to merge
          </p>
        </label>
      </div>

      {files.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400">
              File Queue ({files.length})
            </span>
            <button
              onClick={clearCurrent}
              className="text-xs text-zinc-600 hover:text-red-400 transition-colors"
            >
              Clear all
            </button>
          </div>

          <div className="space-y-1">
            {files.map((f, i) => (
              <div
                key={`${f.name}-${i}`}
                draggable
                onDragStart={() => handleDragStart(i)}
                onDragOver={(e) => handleDragOver(e, i)}
                onDragEnd={handleDragEnd}
                className={`flex items-center justify-between rounded-md border bg-zinc-800/50 px-3 py-2 cursor-grab active:cursor-grabbing transition-colors ${
                  dragIdx === i ? 'border-indigo-500/40' : 'border-zinc-700'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs text-zinc-600 font-mono shrink-0">
                    {i + 1}
                  </span>
                  <span className="truncate text-xs text-zinc-300">{f.name}</span>
                </div>
                <button
                  onClick={() => removeFile(i)}
                  className="ml-2 shrink-0 text-xs text-zinc-600 hover:text-red-400 transition-colors"
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <button
        onClick={handleProcess}
        disabled={running || files.length < 2}
        className="w-full rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-4 py-2.5 text-sm font-medium text-indigo-300 hover:bg-indigo-500/20 transition-colors disabled:opacity-50"
      >
        {running ? 'Merging...' : `Merge ${files.length} Videos`}
      </button>
    </div>
  );
}
