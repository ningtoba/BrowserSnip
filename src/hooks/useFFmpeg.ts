import { useCallback, useRef } from 'react';
import { getFFmpeg, terminateFFmpeg } from '@/lib/ffmpeg/core';
import { parseLogLine, calculateProgress } from '@/lib/ffmpeg/log-parser';
import { useProcessStore } from '@/stores/process-store';
import type { VideoMetadata } from '@/types';

export function useFFmpeg() {
  const logBufferRef = useRef<string[]>([]);
  const lastProcessedTimeRef = useRef(0);
  const logCallbackRef = useRef<((event: { message: string }) => void) | null>(null);

  const process = useCallback(
    async (
      commandArgs: string[],
      inputFile: File,
      outputFileName: string,
      metadata: VideoMetadata,
      label: string,
      suffix: string,
      extraSetup?: (ffmpeg: Awaited<ReturnType<typeof getFFmpeg>>) => Promise<void>
    ): Promise<Blob | null> => {
      const store = useProcessStore.getState();
      store.startProcessing(label, suffix);
      logBufferRef.current = [];
      lastProcessedTimeRef.current = 0;

      try {
        const ffmpeg = await getFFmpeg();

        // Remove previous log callback to prevent listener stacking
        if (logCallbackRef.current) {
          ffmpeg.off('log', logCallbackRef.current);
        }

        logCallbackRef.current = ({ message }: { message: string }) => {
          logBufferRef.current.push(message);

          const parsed = parseLogLine(message);
          if (parsed?.time) {
            const [h, m, s] = parsed.time.split(':');
            const secs = parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s);
            const pct = calculateProgress(secs, metadata.duration);

            const now = Date.now();
            if (now - lastProcessedTimeRef.current >= 100) {
              lastProcessedTimeRef.current = now;
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
          }

          if (logBufferRef.current.length % 10 === 0) {
            useProcessStore.getState().appendLog(message);
          }
        };

        ffmpeg.on('log', logCallbackRef.current);

        // Write input — use a fixed name matching what command builders expect
        const inputName = 'input.mp4';
        const inputData = new Uint8Array(await inputFile.arrayBuffer());
        await ffmpeg.writeFile(inputName, inputData);

        if (extraSetup) {
          await extraSetup(ffmpeg);
        }

        // ffmpeg.wasm already prepends -nostdin -y by default.
        // Timeout after 5 min — prevents infinite hangs from WASM OOM.
        await ffmpeg.exec(commandArgs, 300_000);

        const data = await ffmpeg.readFile(outputFileName);
        const mimeType = outputFileName.endsWith('.gif')
          ? 'image/gif'
          : outputFileName.endsWith('.mp3')
            ? 'audio/mpeg'
            : 'video/mp4';

        const blob = new Blob([data], { type: mimeType });
        const url = URL.createObjectURL(blob);

        useProcessStore.getState().setOutput(blob, url);

        // Best-effort MEMFS cleanup
        try {
          await ffmpeg.deleteFile(inputName);
          await ffmpeg.deleteFile(outputFileName);
        } catch {
          // MEMFS will be cleared on terminate
        }

        return blob;
      } catch (err) {
        console.error('[BrowserSnip] Processing error:', err);
        await terminateFFmpeg();

        const allLogs = logBufferRef.current.join('\n');
        let message: string;

        if (allLogs.includes('av1') || allLogs.includes('av01')) {
          message = 'AV1 video decoding is not supported by ffmpeg.wasm. Stream-copy operations (Trim, Mute, Metadata Strip, Extract Audio) work fine. Re-encode operations (Resize, Crop, Volume, Speed, GIF, Compress) require video decoding and will fail with AV1 files. Use an H.264 video instead.';
        } else if (allLogs.includes('Invalid data found when processing input')) {
          message = 'The video file may be corrupted or use an unsupported codec.';
        } else if (err instanceof Error) {
          message = err.message;
        } else if (typeof err === 'string') {
          message = err;
        } else {
          message = 'Processing failed — check the browser console for details';
        }

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
