/**
 * The PDF tool hook.
 *
 * Owns form state, the password gate, cancellation and the trip through
 * `runPdfTool` into the process store. Every schema-driven tool panel is a thin
 * wrapper around this, which is what replaced the per-tool `useState` block plus
 * the `document.getElementById('tool-process-btn')` click proxy.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import { runPdfTool, type RunOutcome } from '@/lib/pdf/tools/runner';
import { defaultValues, type PdfToolDefinition, type ToolValues } from '@/lib/pdf/tools/types';
import type { ToolId } from '@/types';

export interface UsePdfTool {
  tool: PdfToolDefinition | undefined;
  values: ToolValues;
  setValue: (key: string, value: unknown) => void;
  setValues: (values: ToolValues) => void;
  reset: () => void;
  password: string;
  setPassword: (value: string) => void;
  needsPassword: boolean;
  isRunning: boolean;
  run: (overrides?: ToolValues) => Promise<RunOutcome | null>;
  cancel: () => void;
  /** Present when the loaded PDF is encrypted and no password has worked yet. */
  locked: boolean;
}

export function usePdfTool(toolId: ToolId | string | undefined): UsePdfTool {
  const tool = useToolDefinition(toolId);
  const files = useFileStore((s) => s.files);
  const store = useProcessStore;

  const [values, setValues] = useState<ToolValues>(() => defaultValues(tool?.fields));
  const [password, setPassword] = useState('');
  const [locked, setLocked] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const controller = useRef<AbortController | null>(null);

  // Re-seed the form when the user navigates to a different tool.
  const seededFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!tool || seededFor.current === tool.id) return;
    seededFor.current = tool.id;
    setValues(defaultValues(tool.fields));
    setPassword('');
    setLocked(false);
  }, [tool]);

  const setValue = useCallback((key: string, value: unknown) => {
    setValues((current) => ({ ...current, [key]: value }));
  }, []);

  const needsPassword = useMemo(
    () => Boolean(tool?.fields?.some((field) => field.type === 'password')),
    [tool],
  );

  const run = useCallback(
    async (overrides?: ToolValues) => {
      if (!tool) return null;
      const activeFiles = files.filter(Boolean);
      if (activeFiles.length === 0) {
        store.getState().setError('Add a file first — nothing to work on yet.');
        return null;
      }
      controller.current?.abort();
      const local = new AbortController();
      controller.current = local;

      store.getState().startProcessing(tool.name, tool.outputSuffix);
      setIsRunning(true);
      setLocked(false);
      try {
        const outcome = await runPdfTool({
          toolId: tool.id,
          files: activeFiles,
          values: { ...values, ...overrides },
          password: password || undefined,
          onProgress: (fraction, message) =>
            store.getState().setPercent(Math.round(fraction * 100), message),
          onLog: (line) => store.getState().appendLog(line),
          signal: local.signal,
        });
        for (let index = 0; index < outcome.outputs.length; index++) {
          const output = outcome.outputs[index];
          const url = URL.createObjectURL(output.blob);
          if (index === 0) store.getState().setOutput(output.blob, url, output.name);
          else store.getState().addOutput(output.blob, url, output.name);
        }
        if (outcome.report) store.getState().setReport(outcome.report);
        if (outcome.outputs.length === 0 && !outcome.report) {
          store.getState().setPercent(100, outcome.message ?? 'Done.');
        }
        return outcome;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Processing failed.';
        if (/password/i.test(message)) setLocked(true);
        if (local.signal.aborted) store.getState().setError('Cancelled.');
        else store.getState().setError(message);
        return null;
      } finally {
        setIsRunning(false);
        if (controller.current === local) controller.current = null;
      }
    },
    [files, password, store, tool, values],
  );

  const cancel = useCallback(() => {
    controller.current?.abort();
    setIsRunning(false);
    store.getState().reset();
  }, [store]);

  const reset = useCallback(() => {
    setValues(defaultValues(tool?.fields));
  }, [tool]);

  return {
    tool,
    values,
    setValue,
    setValues,
    reset,
    password,
    setPassword,
    needsPassword,
    isRunning,
    run,
    cancel,
    locked,
  };
}

/**
 * Resolve a definition by id.
 *
 * The registry is imported lazily so that a tool module which fails to load
 * still leaves the rest of the app usable, and the error surfaces on the tool
 * page rather than at first paint.
 */
function useToolDefinition(toolId: ToolId | string | undefined): PdfToolDefinition | undefined {
  const [tool, setTool] = useState<PdfToolDefinition | undefined>(undefined);
  useEffect(() => {
    let active = true;
    if (!toolId) {
      setTool(undefined);
      return;
    }
    import('@/lib/pdf/tools/registry')
      .then(({ getPdfTool }) => {
        if (active) setTool(getPdfTool(toolId));
      })
      .catch(() => {
        if (active) setTool(undefined);
      });
    return () => {
      active = false;
    };
  }, [toolId]);
  return tool;
}
