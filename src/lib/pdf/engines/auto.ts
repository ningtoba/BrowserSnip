/**
 * Automatic engine provisioning.
 *
 * The engines are not bundled and there is no engine UI: a tool that needs one
 * asks for it here, and this module resolves the address from `provider`
 * (the built-in jsDelivr default unless a trusted mirror is stored) and runs the
 * matching loader. Nothing is fetched at page load — Ghostscript is about 15 MB
 * and PyMuPDF about 54 MB, so a download only ever starts behind a run the user
 * asked for.
 *
 * `ensureEngine` never throws. It reports the reason instead, so the caller can
 * either carry on with a degraded path and say so, or refuse with a sentence
 * that names what was skipped. A failure is therefore recoverable rather than a
 * crash, and it is not remembered: coming back online and running the tool
 * again tries the network again.
 *
 * Every wait on the network is bounded. A fetch that neither resolves nor
 * rejects — a captive portal, a blocked CDN, a proxy that swallows the request
 * — must not hang the run that asked for it, because a spinner with no message
 * is worse than an error. `ENGINE_PROVISION_TIMEOUT_MS` is that bound, and a
 * caller holding an `AbortSignal` can give up sooner.
 */
import { cpdf, resetCpdf } from './cpdf';
import { ghostscript, resetGhostscript } from './ghostscript';
import { ENGINE_DOWNLOAD_SIZE, ENGINE_LABELS, EngineUnavailable, engines } from './provider';
import { pymupdf, resetPymupdf } from './pymupdf';
import type { EngineId } from './provider';

export interface EngineProvisionOk {
  ok: true;
  /** True when this call is what loaded the module, rather than reusing it. */
  loaded: boolean;
  /** The live module instance, typed by whoever asked for it. */
  module: unknown;
}

export interface EngineProvisionFailed {
  ok: false;
  /** Short cause, safe to quote inside the caller's own sentence. */
  reason: string;
}

export type EngineProvision = EngineProvisionOk | EngineProvisionFailed;

/**
 * How long an engine may take to arrive before the run goes without it.
 *
 * Sized for the worst case this repo ships: PyMuPDF is about 54 MB, so a slow
 * but honest link needs minutes, while a dead one should stop lying inside a
 * single screenful of waiting. Zero disables the bound.
 */
export const ENGINE_PROVISION_TIMEOUT_MS = 120_000;

export interface EngineProvisionHooks {
  /** Status lines for the run log: what is being fetched, and what happened. */
  onStatus?: (line: string) => void;
  /**
   * Stop waiting for this run. The download the tab already started is kept —
   * it is shared, and a second attempt would fetch the same 54 MB again.
   */
  signal?: AbortSignal;
  /** Override `ENGINE_PROVISION_TIMEOUT_MS` for this wait; 0 means no bound. */
  timeoutMs?: number;
}

/** The loaders, keyed by engine. Each one memoises its own instance. */
const LOADER: Record<EngineId, () => Promise<unknown>> = {
  pymupdf,
  ghostscript,
  cpdf,
};

const inFlight = new Map<EngineId, Promise<EngineProvision>>();
const loaded = new Set<EngineId>();
const modules = new Map<EngineId, unknown>();

/** True once the module is live in this tab, so a run needs no download. */
export function engineLoaded(id: EngineId): boolean {
  return loaded.has(id);
}

/** Host an engine would be fetched from, for copy that has to name it. */
export function engineHost(id: EngineId): string {
  try {
    return new URL(engines.getUrl(id)).hostname;
  } catch {
    return 'the CDN';
  }
}

/**
 * The honest line printed *before* waiting on the network: which engine, from
 * where, how big, and the fact that the document itself is never uploaded.
 */
export function engineFetchLine(id: EngineId): string {
  return (
    `${ENGINE_LABELS[id]} is being fetched from ${engineHost(id)} ` +
    `(${ENGINE_DOWNLOAD_SIZE[id]}, once, then cached by your browser). ` +
    `Your PDF stays on this device.`
  );
}

function reasonFor(err: unknown): string {
  if (err instanceof EngineUnavailable) return err.detail ?? err.message;
  return err instanceof Error ? err.message : String(err);
}

/** The copy a bounded wait produces: what, from where, for how long, what next. */
function timeoutReason(id: EngineId, timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  return (
    `${ENGINE_LABELS[id]} did not finish loading from ${engineHost(id)} within ${seconds}s. ` +
    `Check the connection and run again — the part of this result that needs it was skipped.`
  );
}

function cancelledReason(id: EngineId): string {
  return `${ENGINE_LABELS[id]} was still downloading from ${engineHost(id)} when this run was cancelled.`;
}

/**
 * Wait for a provisioning attempt without ever waiting forever.
 *
 * The attempt itself is untouched: giving up here does not cancel the shared
 * download, so an engine that lands a minute late is still cached and the next
 * run needs no second fetch. Only this caller's wait ends.
 */
function waitForProvision(
  id: EngineId,
  attempt: Promise<EngineProvision>,
  hooks: EngineProvisionHooks,
): Promise<EngineProvision> {
  const timeoutMs = hooks.timeoutMs ?? ENGINE_PROVISION_TIMEOUT_MS;
  const signal = hooks.signal;
  if (signal?.aborted) {
    return Promise.resolve({ ok: false, reason: cancelledReason(id) });
  }
  if (timeoutMs <= 0 && !signal) return attempt;

  return new Promise<EngineProvision>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: EngineProvision): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = (): void => finish({ ok: false, reason: cancelledReason(id) });
    if (timeoutMs > 0) {
      timer = setTimeout(() => finish({ ok: false, reason: timeoutReason(id, timeoutMs) }), timeoutMs);
      // A bound must not be the reason a Node test process stays alive.
      (timer as { unref?: () => void }).unref?.();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    void attempt.then((result) => {
      // Each waiter logs into its own run, so a shared download still reads as
      // one line per tool that waited for it.
      if (result.ok && result.loaded) hooks.onStatus?.(`${ENGINE_LABELS[id]} is ready.`);
      finish(result);
    });
  });
}

/**
 * Load an engine now, from whatever address the provider resolves.
 *
 * Concurrent callers share one attempt, and only the first prints the status
 * line — two tools asking for Ghostscript together must not queue two 15 MB
 * downloads or two notices. This is the only place a loader is called from, so
 * a tool cannot accidentally start a second download for the same module.
 *
 * The returned promise always settles: success, a named failure, a timeout, or
 * a cancellation. `ok: false` carries a short reason the caller puts inside its
 * own sentence, and is never cached, so the next run tries the network again.
 */
export function ensureEngine(
  id: EngineId,
  hooks: EngineProvisionHooks = {},
): Promise<EngineProvision> {
  if (loaded.has(id)) {
    return Promise.resolve({ ok: true, loaded: false, module: modules.get(id) });
  }

  const running = inFlight.get(id);
  if (running) return waitForProvision(id, running, hooks);

  hooks.onStatus?.(engineFetchLine(id));
  const attempt: Promise<EngineProvision> = LOADER[id]().then(
    (instance): EngineProvision => {
      loaded.add(id);
      modules.set(id, instance);
      return { ok: true, loaded: true, module: instance };
    },
    (err: unknown): EngineProvision => ({ ok: false, reason: reasonFor(err) }),
  );

  inFlight.set(id, attempt);
  // Dropped when the *loader* settles, not when a waiter gives up: the shared
  // download keeps its single owner either way.
  void attempt.then(() => {
    if (inFlight.get(id) === attempt) inFlight.delete(id);
  }, () => {
    if (inFlight.get(id) === attempt) inFlight.delete(id);
  });

  return waitForProvision(id, attempt, hooks);
}

/**
 * Forget the provisioning state and the loaded modules.
 *
 * Used by tests, and the only sane follow-up to changing a mirror address: a
 * loader memoises the instance it built from the old URL.
 */
export function resetEngines(): void {
  inFlight.clear();
  loaded.clear();
  modules.clear();
  resetGhostscript();
  resetCpdf();
  resetPymupdf();
}
