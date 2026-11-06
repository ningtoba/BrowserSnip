/**
 * Engine status UI.
 *
 * Three engines are optional downloads, so every engine-backed tool needs the
 * same two things: a pill saying whether the engine is reachable, and a way to
 * point it somewhere else when it is not. `EngineGate` wraps a tool's panel and
 * replaces it with an explanation plus the settings dialog; `EngineSettingsDialog`
 * is also opened directly from the app navigation.
 *
 * The URL field is deliberately blunt about what it does: whatever is saved
 * here is fetched and executed as JavaScript in this page's origin, so the
 * dialog tests the address before it will save it, and says which host it is
 * about to trust.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { easeOut, fadeUp, scaleIn, springSoft, staggerParent, tapDown } from '@/lib/motion';
import {
  ENGINE_DEFAULTS,
  ENGINE_FEATURES,
  ENGINE_IDS,
  ENGINE_LABELS,
  ENGINE_LICENCE_NOTE,
  ENGINE_ROLES,
  engines,
  type EngineId,
} from './provider';

export interface EngineStatus {
  configured: boolean;
  /** The address the engine would load from right now. */
  url: string;
  /** True when that address came from the user rather than the built-in default. */
  fromUser: boolean;
}

type EngineStatusMap = Record<EngineId, EngineStatus>;

/** Live status for all three engines; re-renders whenever the provider changes. */
export function useEngineStatus(): EngineStatusMap {
  const [revision, setRevision] = useState(0);

  useEffect(() => engines.subscribe(() => setRevision((r) => r + 1)), []);

  return useMemo(() => {
    const urls = engines.snapshot();
    const statuses = {} as EngineStatusMap;
    for (const id of ENGINE_IDS) {
      statuses[id] = {
        configured: engines.isConfigured(id),
        url: urls[id],
        fromUser: engines.isUserConfigured(id),
      };
    }
    return statuses;
  }, [revision]);
}

const TONE_CLASSES = {
  ready: 'border-success/30 bg-success/10 text-success',
  user: 'border-accent/30 bg-accent/10 text-accent',
  missing: 'border-warn/30 bg-warn/10 text-warn',
} as const;

function statusView(status: EngineStatus): { tone: keyof typeof TONE_CLASSES; label: string } {
  if (!status.configured) return { tone: 'missing', label: 'Not configured' };
  if (status.fromUser) return { tone: 'user', label: 'Your mirror' };
  return { tone: 'ready', label: 'Default CDN' };
}

/** Small pill showing where an engine would load from. */
export function EngineBadge({ id }: { id: EngineId }) {
  const status = useEngineStatus()[id];
  const view = statusView(status);
  return (
    <motion.span
      variants={scaleIn}
      initial="hidden"
      animate="visible"
      title={`${ENGINE_LABELS[id]} — ${status.url}`}
      className={`inline-flex shrink-0 items-center gap-1 rounded-doodle border px-2 py-0.5 text-[10px] font-semibold ${TONE_CLASSES[view.tone]}`}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {ENGINE_LABELS[id]} · {view.label}
    </motion.span>
  );
}

/**
 * Show `children` when the engine has an address, otherwise an explanation of
 * what is missing and what the engine would unlock.
 */
export function EngineGate({ id, children }: { id: EngineId; children: ReactNode }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const status = useEngineStatus()[id];

  if (status.configured) return <>{children}</>;

  return (
    <>
      <motion.div
        initial="hidden"
        animate="visible"
        variants={staggerParent}
        className="doodle-section space-y-3"
      >
        <motion.p
          variants={fadeUp}
          className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted"
        >
          Optional module needed
        </motion.p>
        <motion.div variants={fadeUp} className="space-y-1">
          <p className="text-sm font-semibold text-ink">
            {ENGINE_LABELS[id]} adds {ENGINE_ROLES[id]}.
          </p>
          <p className="text-[11px] leading-relaxed text-ink-muted">
            Everything else here still works without it — this tool just has fewer
            output formats. {ENGINE_LABELS[id]} is downloaded on first use, and your
            PDF is never uploaded anywhere.
          </p>
        </motion.div>
        <motion.ul variants={fadeUp} className="space-y-1">
          {ENGINE_FEATURES[id].map((feature) => (
            <li key={feature} className="flex items-start gap-1.5 text-[11px] text-ink-soft">
              <span aria-hidden className="mt-px text-success">
                ✓
              </span>
              {feature}
            </li>
          ))}
        </motion.ul>
        <motion.div variants={fadeUp} className="flex gap-2">
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="doodle-btn"
          >
            Configure {ENGINE_LABELS[id]}
          </button>
        </motion.div>
        <motion.p variants={fadeUp} className="text-[10px] leading-relaxed text-ink-muted">
          {ENGINE_LICENCE_NOTE}
        </motion.p>
      </motion.div>
      <EngineSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}

interface RowResult {
  ok: boolean;
  message: string;
}

async function copyToClipboard(text: string): Promise<boolean> {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function EngineRow({ id }: { id: EngineId }) {
  const status = useEngineStatus()[id];
  const [draft, setDraft] = useState(status.url);
  const [result, setResult] = useState<RowResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const view = statusView(status);

  // Keep the field in step with the provider (Reset, and edits made elsewhere).
  useEffect(() => setDraft(status.url), [status.url]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const isDefault = draft.trim() === ENGINE_DEFAULTS[id];

  const test = useCallback(async () => {
    setBusy(true);
    setResult(null);
    try {
      const outcome = await engines.validateUrl(id, draft);
      setResult(
        outcome.valid
          ? { ok: true, message: 'Reachable — this address can be saved.' }
          : { ok: false, message: outcome.error ?? 'That address did not respond.' },
      );
    } finally {
      setBusy(false);
    }
  }, [draft, id]);

  const save = useCallback(() => {
    try {
      engines.setUrl(id, draft);
      setResult({
        ok: true,
        message: isDefault
          ? 'That is the built-in address, so no override is stored.'
          : `Saved. ${new URL(draft.trim()).hostname} will be trusted for this session.`,
      });
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  }, [draft, id, isDefault]);

  return (
    <motion.section variants={fadeUp} className="rounded-doodle-md border border-cream-border bg-white p-3 shadow-doodle-card">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-ink">{ENGINE_LABELS[id]}</p>
          <p className="truncate text-[10px] text-ink-muted">{ENGINE_ROLES[id]}</p>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-doodle border px-2 py-0.5 text-[10px] font-semibold ${TONE_CLASSES[view.tone]}`}
        >
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
          {view.label}
        </span>
      </div>

      <input
        type="text"
        className="doodle-input mt-2 text-[11px]"
        value={draft}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={ENGINE_DEFAULTS[id]}
        aria-label={`${ENGINE_LABELS[id]} CDN address`}
      />

      <div className="mt-2 flex flex-wrap items-center gap-1">
        <button
          type="button"
          className={`doodle-chip !w-auto !flex-none !px-2 !py-1 !text-[10px] ${
            isDefault ? 'doodle-chip-active' : 'doodle-chip-inactive'
          }`}
          onClick={() => setDraft(ENGINE_DEFAULTS[id])}
        >
          Recommended
        </button>
        <button
          type="button"
          className="doodle-chip !w-auto !flex-none !px-2 !py-1 !text-[10px] doodle-chip-inactive"
          onClick={async () => setCopied(await copyToClipboard(ENGINE_DEFAULTS[id]))}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div className="mt-2 flex gap-2">
        <button type="button" className="doodle-btn-secondary" onClick={test} disabled={busy}>
          {busy ? 'Testing…' : 'Test'}
        </button>
        <button type="button" className="doodle-btn" onClick={save} disabled={busy || draft.trim() === ''}>
          Save
        </button>
        <button
          type="button"
          className="doodle-btn-secondary"
          onClick={() => {
            engines.removeUrl(id);
            setResult(null);
          }}
          disabled={!status.fromUser}
        >
          Reset
        </button>
      </div>

      {result && (
        <motion.p
          initial={{ opacity: 0, y: -2 }}
          animate={{ opacity: 1, y: 0 }}
          transition={easeOut}
          className={`mt-2 break-words text-[10px] leading-relaxed ${
            result.ok ? 'text-success' : 'text-danger'
          }`}
        >
          {result.message}
        </motion.p>
      )}
    </motion.section>
  );
}

/** CDN addresses for the optional engines. Reached from the app navigation. */
export function EngineSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={easeOut}
          onClick={onClose}
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-subtle"
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Optional PDF engines"
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={springSoft}
            onClick={(event) => event.stopPropagation()}
            className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-doodle-lg border border-cream-border bg-cream p-4 shadow-doodle-card"
          >
            <motion.div
              initial="hidden"
              animate="visible"
              variants={staggerParent}
              className="space-y-3"
            >
              <motion.div variants={fadeUp} className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
                    Advanced
                  </p>
                  <h2 className="text-base font-semibold text-ink">Optional PDF engines</h2>
                </div>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close engine settings"
                  className="cursor-pointer rounded-doodle px-2 py-1 text-[11px] font-medium text-ink-muted transition-colors hover:bg-cream-soft hover:text-ink"
                >
                  Close
                </button>
              </motion.div>

              {ENGINE_IDS.map((id) => (
                <EngineRow key={id} id={id} />
              ))}

              <motion.p
                variants={fadeUp}
                className="rounded-doodle-md border border-cream-border bg-white p-3 text-[10px] leading-relaxed text-ink-muted"
              >
                {ENGINE_LICENCE_NOTE}
              </motion.p>

              <motion.div variants={fadeUp} className="flex gap-2">
                <motion.button
                  type="button"
                  whileTap={tapDown}
                  className="doodle-btn-secondary"
                  onClick={() => engines.reset()}
                >
                  Reset all to defaults
                </motion.button>
                <motion.button type="button" whileTap={tapDown} className="doodle-btn" onClick={onClose}>
                  Done
                </motion.button>
              </motion.div>
            </motion.div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
