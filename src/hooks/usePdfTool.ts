/**
 * The PDF tool hook.
 *
 * Owns form state, input validation, the password gate, cancellation and the
 * trip through `runPdfTool` into the process store. Every schema-driven tool
 * panel is a thin wrapper around this, which is what replaced the per-tool
 * `useState` block plus the `document.getElementById('tool-process-btn')`
 * click proxy.
 *
 * The validation half exists so the rail can answer "why is the button off?"
 * before the click: values are clamped into their declared range with a
 * written reason, and anything still unusable is reported as a blocker.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore, type ToolPhase } from '@/stores/process-store';
import { fileProblem, runPdfTool, type RunOutcome } from '@/lib/pdf/tools/runner';
import { enginePurpose, engineReady } from '@/lib/pdf/core/engine-ops';
import { isPasswordRequired, isToolInputError } from '@/lib/pdf/core/guard';
import {
  defaultValues,
  type PdfToolDefinition,
  type ToolField,
  type ToolValues,
} from '@/lib/pdf/tools/types';
import {
  checkFields,
  groupFields,
  promiseFor,
  verbFor,
  type FieldGroup,
  type PanelTool,
} from '@/components/tools/pdf/shared/toolForm';
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
  /** Lifecycle of the current tool, mirrored into the process store. */
  phase: ToolPhase;
  /** Page count of the loaded document when it is known (E6/E7). */
  pageCount: number | null;
  /** Fields whose value was clamped, and why (E15). */
  notices: Record<string, string>;
  /** Fields that still block the primary action, with the reason. */
  issues: Record<string, string>;
  /** Everything standing between the user and the primary action. */
  blockers: string[];
  /**
   * Things worth saying that must not gate the button. A repeat of the same file
   * in a multi-document tool is a plan ("merge this with itself"), so the rail
   * confirms the intent instead of refusing it.
   */
  advisories: string[];
  /** False until the inputs are usable — the button binds to this (E18). */
  canRun: boolean;
  /** Values with clamps applied; what a run is actually given. */
  checked: ToolValues;
  /** Primary-action verb: "Merge", "Compress", never a bare "Run". */
  verb: string;
  /** One line about what pressing the button produces. */
  promise: string;
  /** Fields bucketed under their `group` heading, in declaration order. */
  groups: FieldGroup[];
}

export interface UsePdfToolOptions {
  /** Known page count of the loaded PDF; enables range validation. */
  pageCount?: number | null;
}

/** Log lines that describe a compromise rather than a step. */

export function usePdfTool(
  toolId: ToolId | string | undefined,
  options: UsePdfToolOptions = {},
): UsePdfTool {
  const tool = useToolDefinition(toolId);
  const files = useFileStore((s) => s.files);
  const phase = useProcessStore((s) => s.phase);
  const store = useProcessStore;
  const pageCount = options.pageCount ?? null;

  const [values, setValues] = useState<ToolValues>(() => defaultValues(tool?.fields));
  const [password, setPassword] = useState('');
  const [locked, setLocked] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const ranSignature = useRef<string | null>(null);

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

  const { values: checked, issues, notices } = useMemo(
    () => checkFields(tool?.fields, values, { pageCount }),
    [pageCount, tool, values],
  );

  /** Why the primary action cannot fire, in the order the user can act on. */
  const blockers = useMemo(() => {
    const out: string[] = [];
    if (!tool) return ['This tool is still loading.'];
    if (tool.unavailable) return [tool.unavailable];
    if (!tool.run && !tool.mainComponent) {
      out.push('This tool has no runnable action yet.');
    }
    if (files.length === 0) {
      out.push(
        tool.accept && !/pdf/.test(tool.accept)
          ? `Add a ${tool.accept.split(',')[0]} first.`
          : 'Add a PDF first.',
      );
    } else {
      // One place decides file arity (nothing loaded / one at a time / min / max
      // / E16 duplicate) and it is the runner that ships the answer. Mirroring
      // these four rules here is how a rail and a run disagree about "ready".
      const problem = fileProblem(tool, files);
      if (problem) out.push(problem.message);
    }
    const missing = (tool.engines ?? []).filter((id) => !engineReady(id));
    if (missing.length > 0) {
      out.push(
        `Needs the optional ${missing.join(' and ')} module. ${missing.map((id) => enginePurpose(id)).join(' ')}`,
      );
    }
    for (const field of tool.fields ?? []) {
      const issue = issues[field.key];
      if (issue) out.push(issue);
    }
    const custom = tool.validate?.(checked, { fileCount: files.length });
    if (custom) out.push(custom);
    return out;
  }, [checked, files, issues, tool]);

  const advisories = useMemo(() => {
    const out: string[] = [];
    if (!tool?.multiFile || files.length < 2) return out;
    const seen = new Map<string, { name: string; count: number }>();
    for (const candidate of files) {
      const key = `${candidate.name}:${candidate.size}`;
      const hit = seen.get(key);
      if (hit) hit.count += 1;
      else seen.set(key, { name: candidate.name, count: 1 });
    }
    for (const entry of seen.values()) {
      if (entry.count > 1) {
        out.push(`"${entry.name}" is in the list ${entry.count} times — the output will contain it ${entry.count} times.`);
      }
    }
    return out;
  }, [files, tool]);

  const canRun = blockers.length === 0;
  const signature = useMemo(
    () => JSON.stringify({ id: tool?.id ?? null, files: files.map((f) => `${f.name}:${f.size}`), values: checked, password }),
    [checked, files, password, tool],
  );

  // Mirror the lifecycle into the store. A finished run keeps its `done` phase
  // until the inputs change, at which point the result is stale by definition.
  useEffect(() => {
    const state = store.getState();
    if (isRunning || state.phase === 'running') return;
    const resting: ToolPhase = files.length === 0 ? 'idle' : pageCount == null ? 'inspecting' : 'ready';
    if (state.phase === 'done') {
      if (ranSignature.current !== null && ranSignature.current !== signature) state.setPhase(resting);
      return;
    }
    if (state.phase === 'error') return;
    if (state.phase !== resting) state.setPhase(resting);
  }, [isRunning, files.length, pageCount, signature, store]);

  const run = useCallback(
    async (overrides?: ToolValues) => {
      if (!tool) return null;
      const activeFiles = files.filter(Boolean);
      if (activeFiles.length === 0) {
        store.getState().setError('Add a file first — nothing to work on yet.');
        return null;
      }
      if (blockers.length > 0 && !tool.mainComponent) {
        store.getState().setError(blockers[0]);
        return null;
      }
      controller.current?.abort();
      const local = new AbortController();
      controller.current = local;

      const state = store.getState();
      state.startProcessing(tool.name, tool.outputSuffix);
      state.setSizeBefore(activeFiles.reduce((sum, file) => sum + file.size, 0));
      for (const file of activeFiles) state.setFileState(file.name, { percent: 0, error: null, size: file.size });
      setIsRunning(true);
      setLocked(false);

      const lines: string[] = [];
      try {
        const outcome = await runPdfTool({
          toolId: tool.id,
          files: activeFiles,
          values: { ...checked, ...values, ...overrides },
          password: password || undefined,
          onProgress: (fraction, message) => {
            const live = store.getState();
            const percent = Math.round(fraction * 100);
            live.setPercent(percent, message);
            if (activeFiles.length === 1) {
              live.setFileState(activeFiles[0].name, { percent, message });
              return;
            }
            // The runner reports one 0..1 sweep for the whole job, so spread it
            // evenly across the inputs: earlier files finish first, later ones
            // have not started. It is an estimate, and the label says so.
            const share = 1 / activeFiles.length;
            activeFiles.forEach((file, index) => {
              const local01 = (fraction - index * share) / share;
              live.setFileState(file.name, {
                percent: Math.max(0, Math.min(100, Math.round(local01 * 100))),
                message: local01 <= 0 || local01 >= 1 ? undefined : message,
              });
            });
          },
          onLog: (line) => {
            lines.push(line);
            store.getState().appendLog(line);
          },
          signal: local.signal,
        });
        // Cancelled while the tool was still working: a late result is stale
        // output, and the user would download a file they asked to abandon (E19).
        if (local.signal.aborted) return null;
        for (let index = 0; index < outcome.outputs.length; index++) {
          const output = outcome.outputs[index];
          const url = URL.createObjectURL(output.blob);
          if (index === 0) store.getState().setOutput(output.blob, url, output.name);
          else store.getState().addOutput(output.blob, url, output.name);
        }
        if (outcome.report) store.getState().setReport(outcome.report);
        if (outcome.outputs.length === 0 && !outcome.report) {
          store.getState().complete(outcome.message ?? 'Done.');
        }
        const finished = store.getState();
        finished.setWarnings(outcome.warnings);
        for (const file of activeFiles) finished.setFileState(file.name, { percent: 100, error: null });
        finished.setPhase('done');
        ranSignature.current = signature;
        return outcome;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Processing failed.';
        if (isPasswordRequired(error)) setLocked(true);
        const cancelled = local.signal.aborted;
        const failed = store.getState();
        failed.setError(cancelled ? 'Cancelled.' : message, isToolInputError(error) ? error.hint : null);
        // Name the file that broke (E1/E2/E4): the message when it quotes one,
        // otherwise the only input, otherwise the first of them.
        const atFault = activeFiles.find((file) => message.includes(file.name))
          ?? (activeFiles.length === 1 ? activeFiles[0] : undefined);
        if (atFault && !cancelled) failed.setFileState(atFault.name, { error: message, percent: 0 });
        return null;
      } finally {
        setIsRunning(false);
        if (controller.current === local) controller.current = null;
      }
    },
    [blockers, checked, files, password, signature, store, tool, values],
  );

  const cancel = useCallback(() => {
    controller.current?.abort();
    setIsRunning(false);
    store.getState().reset();
    ranSignature.current = null;
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
    phase,
    pageCount,
    notices,
    issues,
    blockers,
    advisories,
    canRun,
    checked,
    verb: tool ? verbFor(tool) : 'Run',
    promise: tool ? promiseFor(tool as PanelTool) : '',
    groups: groupFields(tool?.fields ?? []),
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

export type { ToolField };
