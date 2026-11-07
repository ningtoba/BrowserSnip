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
import { engineReady } from '@/lib/pdf/core/engine-ops';
import { ENGINE_LABELS } from '@/lib/pdf/engines/provider';
import { inspectPdf, isPasswordRequired, isToolInputError } from '@/lib/pdf/core/guard';
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
  /** Page count per loaded file, once the pre-flight has read it. */
  pagesByFile: Record<string, number | null>;
  /**
   * Pages across every loaded file, or `null` while any of them is unread.
   *
   * A result that says "12 in" has to know it started with 12; guessing from the
   * first file would misreport a merge (E6/E7).
   */
  pagesIn: number | null;
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
  // Nothing writes `file-store.metadata` for a PDF, so a page count has to be
  // read from the file. Without it every page-range field validates against
  // `null`: the rail never says "this document has 3 pages" (E6) and the panel
  // sits on "Reading file" forever while the preview next to it shows page 10.
  const [pagesByFile, setPagesByFile] = useState<Record<string, number | null>>({});
  useEffect(() => {
    let alive = true;
    for (const file of files) {
      const key = `${file.name}:${file.size}`;
      if (pagesByFile[key] !== undefined) continue;
      void (async () => {
        let pages: number | null = null;
        try {
          const inspection = await inspectPdf(new Uint8Array(await file.arrayBuffer()), file.name);
          const known = inspection.pages ?? inspection.declaredPages ?? 0;
          // Zero is not a page count. A header-only or damaged file reports 0,
          // and treating that as "known" would flip the rail to ready and let a
          // range field validate against nothing (E3, E6).
          pages = known > 0 ? known : null;
        } catch {
          pages = null;
        }
        if (!alive) return;
        // The queue row is the only place a user reads "how big is this job"
        // for the second, third and fourth file, so the count has to reach the
        // store as well as the range validator.
        useProcessStore.getState().setFileState(file.name, { pages, size: file.size });
        setPagesByFile((prev) => (key in prev ? prev : { ...prev, [key]: pages }));
      })();
    }
    return () => {
      alive = false;
    };
  }, [files, pagesByFile]);

  const primary = files[0];
  const pageCount = options.pageCount ?? (primary ? pagesByFile[`${primary.name}:${primary.size}`] ?? null : null);

  const [values, setValues] = useState<ToolValues>(() => defaultValues(tool?.fields));
  const [password, setPassword] = useState('');
  const [locked, setLocked] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const ranSignature = useRef<string | null>(null);
  // Which inputs the in-flight run is actually working on. When the selection
  // changes under a run its result describes files the user no longer has, so
  // it must not be published (E19).
  const inputsRef = useRef<string>('');

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
    if (!tool) return ['Wait for this tool to finish loading.'];
    if (tool.unavailable) return [tool.unavailable];
    if (!tool.run && !tool.mainComponent) {
      out.push('Pick another tool — this one has no action yet.');
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
      // Imperative, and it names the thing: "needs the optional X module" read
      // as a state the user could not act on once the engines UI went away.
      out.push(
        missing.length === 1
          ? `Connect to the internet to load ${ENGINE_LABELS[missing[0]]} — this tool cannot run without it.`
          : `Connect to the internet to load ${missing.map((id) => ENGINE_LABELS[id]).join(' and ')} — this tool cannot run without them.`,
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

  const advisories = useMemo(() => {    const out: string[] = [];
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
  const pagesIn = useMemo(() => {
    if (files.length === 0) return null;
    let total = 0;
    for (const file of files) {
      const count = pagesByFile[`${file.name}:${file.size}`];
      if (count == null) return null;
      total += count;
    }
    return total > 0 ? total : null;
  }, [files, pagesByFile]);
  const signature = useMemo(
    () => JSON.stringify({ id: tool?.id ?? null, files: files.map((f) => `${f.name}:${f.size}`), values: checked, password }),
    [checked, files, password, tool],
  );
  // Inputs only — no option values. Editing a slider mid-run does not change
  // what the running job is holding.
  const inputs = useMemo(
    () => JSON.stringify({ id: tool?.id ?? null, files: files.map((f) => `${f.name}:${f.size}`) }),
    [files, tool],
  );
  useEffect(() => {
    inputsRef.current = inputs;
  }, [inputs]);

  // Mirror the lifecycle into the store. A finished run keeps its `done` phase
  // until the inputs change, at which point the result is stale by definition.
  useEffect(() => {
    const state = store.getState();
    if (isRunning || state.phase === 'running') return;
    let resting: ToolPhase = 'ready';
    if (files.length === 0) resting = 'idle';
    else if (pageCount == null) resting = 'inspecting';
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
      const startedInputs = inputs;

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
            // A cancelled run keeps reporting until its loop notices; those
            // writes would refill a bar the user just threw away.
            if (local.signal.aborted) return;
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
            if (local.signal.aborted) return;
            lines.push(line);
            store.getState().appendLog(line);
          },
          signal: local.signal,
        });
        // Cancelled while the tool was still working: a late result is stale
        // output, and the user would download a file they asked to abandon (E19).
        if (local.signal.aborted) return null;
        // The selection moved under this run. Same rule, said out loud.
        if (inputsRef.current !== startedInputs) {
          if (controller.current === local) {
            store.getState().abandonRun(
              'You changed the files while this was running, so the result was discarded.',
            );
          }
          return null;
        }
        for (let index = 0; index < outcome.outputs.length; index++) {
          const output = outcome.outputs[index];
          const url = URL.createObjectURL(output.blob);
          if (index === 0) store.getState().setOutput(output.blob, url, output.name);
          else store.getState().addOutput(output.blob, url, output.name);
        }
        if (outcome.report) store.getState().setReport(outcome.report);
        // The last progress line is a stage, not a result: "Rewriting images"
        // is what the rail said while it worked, and printing it under a
        // finished card reads as an answer that was never given. A tool with
        // nothing to say gets nothing said for it (E13).
        store.getState().complete(
          outcome.message ?? (outcome.outputs.length === 0 && !outcome.report ? 'Done.' : ''),
        );
        const finished = store.getState();
        finished.setWarnings(outcome.warnings);
        for (const file of activeFiles) finished.setFileState(file.name, { percent: 100, error: null });
        finished.setPhase('done');
        ranSignature.current = signature;
        return outcome;
      } catch (error) {
        // A cancel is the user's own action: `cancel()` already cleared the slot
        // and said so, so it must not come back as a red panel with a Retry.
        if (local.signal.aborted) return null;
        const message = error instanceof Error ? error.message : 'Processing failed.';
        if (isPasswordRequired(error)) setLocked(true);
        const failed = store.getState();
        failed.setError(message, isToolInputError(error) ? error.hint : null);
        // Name the file that broke (E1/E2/E4): the message when it quotes one,
        // otherwise the only input, otherwise the first of them.
        const atFault = activeFiles.find((file) => message.includes(file.name))
          ?? (activeFiles.length === 1 ? activeFiles[0] : undefined);
        if (atFault) failed.setFileState(atFault.name, { error: message, percent: 0 });
        return null;
      } finally {
        // Only the newest run owns the rail's idea of "working"; a superseded
        // one must not flip the button back while the current job is running.
        if (controller.current === local) {
          controller.current = null;
          setIsRunning(false);
        }
      }
    },
    [blockers, checked, files, inputs, password, signature, store, tool, values],
  );

  const cancel = useCallback(() => {
    controller.current?.abort();
    setIsRunning(false);
    // The abort reaches the store before the tool notices, so the rail stops
    // moving immediately; the acknowledgement is what tells the user the bar
    // went away because they asked, not because the run finished.
    store.getState().abandonRun('Cancelled — nothing was saved.');
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
    pagesByFile,
    pagesIn,
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
