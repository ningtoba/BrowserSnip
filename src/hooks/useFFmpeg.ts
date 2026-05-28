import { useRef, useCallback } from 'react';
import { getFFmpeg, terminateFFmpeg } from '@/lib/ffmpeg/core';
import { parseLogLine, calculateProgress } from '@/lib/ffmpeg/log-parser';
import { useProcessStore } from '@/stores/process-store';
import type { VideoMetadata } from '@/types';

export function useFFmpeg() {
  const logBufferRef = useRef<string[]>([]);
  const timerRef = useRef<number>(0);

  const process = useCallback(
    async (
      commandArgs: string[],
      inputFile: File,
      outputFileName: string,
      metadata: VideoMetadata,
      extraSetup?: (ffmpeg: Awaited<ReturnType<typeof getFFmpeg>>) => Promise<void>
    ): Promise<Blob | null> => {
      const store = useProcessStore.getState();
      store.startProcessing();
      logBufferRef.current = [];

      try {
        const ffmpeg = await getFFmpeg();

        ffmpeg.on('log', ({ message }) => {
          logBufferRef.current.push(message);

          const parsed = parseLogLine(message);
          if (parsed?.time) {
            const [h, m, s] = parsed.time.split(':');
            const secs = parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
            const pct = calculateProgress(secs, metadata.duration);

            useProcessStore.getState().updateProgress(
              {
                percent: pct,
                time: parsed.time,
                frame: parsed.frame ?? 0,
                fps: parsed.fps ?? 0,
                eta: '',
              },
              pct
            );
          }
          // Throttle log updates to ~200ms
          if (logBufferRef.current.length % 10 === 0) {
            useProcessStore.getState().appendLog(message);
          }
        });

        const inputName = 'input_' + inputFile.name;
        await ffmpeg.writeFile(inputName, await fetchFile(inputFile));

        if (extraSetup) {
          await extraSetup(ffmpeg);
        }

        await ffmpeg.exec(commandArgs);

        const data = await ffmpeg.readFile(outputFileName);
        const mimeType = outputFileName.endsWith('.gif')
          ? 'image/gif'
          : outputFileName.endsWith('.mp3')
            ? 'audio/mpeg'
            : 'video/mp4';

        const blob = new Blob([data], { type: mimeType });
        const url = URL.createObjectURL(blob);

        useProcessStore.getState().setOutput(blob, url);

        // Clean up
        await ffmpeg.deleteFile(inputName);
        await ffmpeg.deleteFile(outputFileName);

        return blob;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Processing failed';
        useProcessStore.getState().setError(message);
        return null;
      }
    },
    []
  );

  const terminate = useCallback(async () => {
    await terminateFFmpeg();
  }, []);

  return { process, terminate };
}

function fetchFile(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}
