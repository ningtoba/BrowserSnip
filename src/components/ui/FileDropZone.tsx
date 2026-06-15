import { useCallback, useRef, useState } from 'react';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import { getFFmpeg, terminateFFmpeg } from '@/lib/ffmpeg/core';

interface FileDropZoneProps {
  accept?: string;
  multiple?: boolean;
  label?: string;
  hint?: string;
}

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

export function FileDropZone({
  accept = 'video/*',
  multiple = false,
  label = 'Drop a video file or click to browse',
  hint = 'Max recommended: 500 MB',
}: FileDropZoneProps) {
  const { file, files, setFile, addFile, setFiles, setCodecWarning, setProbing, probing } = useFileStore();
  const resetProcess = useProcessStore((s) => s.reset);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const isVideoAccept = accept.includes('video');

  const openFilePicker = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleFiles = useCallback(
    (newFiles: FileList | null, append = false) => {
      if (!newFiles || newFiles.length === 0) return;
      resetProcess();

      const fileList = Array.from(newFiles);

      if (multiple && append) {
        const store = useFileStore.getState();
        for (const f of fileList) {
          store.addFile(f);
        }
      } else if (multiple) {
        setFiles(fileList);
      } else {
        setFile(fileList[0]);

        // Run codec probe for video files
        if (isVideoAccept && fileList[0]) {
          setCodecWarning(null);
          setProbing(true);
          probeCodec(fileList[0]).then((warning) => {
            if (warning) setCodecWarning(warning);
            setProbing(false);
          });
        }
      }
    },
    [multiple, setFile, setFiles, resetProcess, isVideoAccept, setCodecWarning, setProbing],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const hasFiles = useFileStore.getState().files.length > 0;
      handleFiles(e.dataTransfer.files, hasFiles);
    },
    [handleFiles],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!e.target.files || e.target.files.length === 0) return;
      const hasFiles = useFileStore.getState().files.length > 0;
      handleFiles(e.target.files, hasFiles);
      e.target.value = '';
    },
    [handleFiles],
  );

  const handleRemove = useCallback(
    (index?: number) => {
      if (multiple && index !== undefined) {
        useFileStore.getState().removeFile(index);
      } else {
        setFile(null);
        if (isVideoAccept) {
          setCodecWarning(null);
        }
      }
    },
    [multiple, setFile, isVideoAccept, setCodecWarning],
  );

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={handleChange}
        className="hidden"
      />

      {files.length > 0 ? (
        <div className="space-y-2">
          {files.map((f, i) => {
            const sizeMB = (f.size / 1_000_000).toFixed(1);
            return (
              <div
                key={`${f.name}-${i}-${f.size}`}
                className="rounded-doodle-md border border-cream-border bg-cream-light/60 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] font-semibold text-ink">{f.name}</p>
                    <p className="text-[11px] text-ink-muted">
                      {probing ? 'Probing codec...' : `${sizeMB} MB`}
                    </p>
                  </div>
                  <button
                    onClick={() => handleRemove(i)}
                    className="shrink-0 text-[11px] font-medium text-ink-muted hover:text-danger transition-colors px-1"
                    aria-label={`Remove ${f.name}`}
                  >
                    Remove
                  </button>
                </div>
              </div>
            );
          })}

          {multiple && (
            <button
              onClick={openFilePicker}
              className="w-full cursor-pointer rounded-doodle-md border border-dashed border-cream-border p-3 text-center hover:border-ink-muted/40 hover:bg-cream-light/40 transition-colors"
            >
              <p className="text-[11px] text-ink-muted">+ Add more files</p>
            </button>
          )}
        </div>
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={openFilePicker}
          className={`cursor-pointer rounded-doodle-md border border-dashed p-6 sm:p-8 text-center transition-all duration-200 ${
            isDragging
              ? 'border-accent bg-accent/5 scale-[1.01]'
              : 'border-cream-border hover:border-ink-muted/40 hover:bg-cream-light/40'
          }`}
        >
          <div className="mb-2 text-2xl opacity-40">📁</div>
          <p className="text-xs font-medium text-ink-soft">{label}</p>
          <p className="mt-1 text-[11px] text-ink-muted">{hint}</p>
        </div>
      )}
    </>
  );
}
