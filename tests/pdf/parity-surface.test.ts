/**
 * Parity sweep: does the reshaped tool page actually cover every tool?
 *
 * The claim under test is not "merge looks nice" but "every tool got the new
 * shape". That is easy to assert and easy to fake: a test that drives one tool and
 * a comment saying "the rest are generated" proves nothing about the tool whose
 * definition landed on a shelf nobody clicked. So everything here is driven from
 * the live registry — the same list the dashboard and the router read — and the
 * only tools allowed to skip the intake assertion are the ones the shell hands to a
 * hand-written pane, listed by id so the exception is auditable rather than silent.
 *
 * Three questions, in the order a visitor meets them:
 *   1. before a file: one primary action, one promise line, no options anywhere;
 *   2. after a file: the cards, the options bar and the pinned verb;
 *   3. after a run: the result screen, not the drop zone.
 * Plus the two classes that would open on an unstyled fallback: a tool with neither
 * a `run` nor a bespoke pane, and a bespoke id whose module does not resolve.
 *
 * Before all three, one question about the list itself: does the catalogue describe
 * jobs, or ids? A tool that exists twice (under a secondary id) is counted twice,
 * searched twice and offered twice, which is how one job ended up as two cards on
 * the dashboard and two rows in the palette. The answers are the registry's —
 * `TOOL_CATALOGUE` and the alias map behind it — and the routing tables must agree
 * with them, so a pane key that answers no tool is a failure, not a footnote.
 *
 * jsdom has no canvas, so page rasters are pumped as empty strings and nothing here
 * asserts a pixel — only DOM and state invariants.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { PDF_TOOLS, TOOL_CATALOGUE, canonicalToolId, getPdfTool, hasCustomMainView, isToolAlias, mainViewFor } from '@/lib/pdf/tools/registry';
import { TOOLS } from '@/lib/constants';
import { PdfToolPanel } from '@/components/tools/pdf/shared/PdfToolPanel';
import { ToolWorkspace } from '@/components/layout/ToolWorkspace';
import { promiseFor, verbFor } from '@/components/tools/pdf/shared/toolForm';
import { TOOL_JOBS, cardEntries } from '@/components/dashboard/toolJobs';
import { PdfDashboard } from '@/components/dashboard/PdfDashboard';
import { useFileStore } from '@/stores/file-store';
import { useProcessStore } from '@/stores/process-store';
import type { PdfToolDefinition } from '@/lib/pdf/tools/types';

// Page rasters are pumped by hand: jsdom has no 2-D context.
vi.mock('@/lib/pdf/core/render', () => ({
  openRender: vi.fn(async () => ({
    numPages: 1,
    fingerprint: 'parity-session',
    page: async () => ({ getViewport: () => ({ width: 612, height: 792, rotation: 0 }), cleanup() {} }),
    renderToCanvas: async () => ({}),
    destroy: async () => {},
  })),
  thumbnails: vi.fn(async (_session: unknown, options: { pages?: number[] }) => (options?.pages ?? []).map(() => '')),
}));

interface PaneRoute {
  id: string;
  /** The module the shell lazy-loads, exactly as written in its source. */
  module: string;
  /** The export it names, or `default` when the module is imported bare. */
  export: string;
}

/**
 * Pull a tool-id → component map out of a source file.
 *
 * Both maps are private consts in files another worker owns. Copying them here
 * would be a list that silently rots; parsing them means this test fails the moment
 * the shell's routing changes, which is the point of writing an exception down.
 */
function paneMapFrom(file: string, mapName: string, adapter: string): PaneRoute[] {
  const source = readFileSync(resolve(process.cwd(), file), 'utf8');
  const start = source.indexOf(`const ${mapName}`);
  if (start < 0) throw new Error(`${file} no longer declares ${mapName}`);
  const block = source.slice(start, source.indexOf('\n};', start));
  const pattern = new RegExp(
    `^\\s{2}'?([a-z0-9]+(?:-[a-z0-9]+)*)'?:\\s*(?:lazy|lazyPanel)\\(\\(\\) => import\\('([^']+)'\\)(?:\\.then\\(${adapter}\\('([^']+)'\\)\\))?`,
    'gm',
  );
  return [...block.matchAll(pattern)].map((match) => ({
    id: String(match[1]),
    module: String(match[2]),
    export: match[3] ? String(match[3]) : 'default',
  }));
}

const MAIN_VIEWS = paneMapFrom('src/lib/pdf/tools/registry.ts', 'MAIN_VIEWS', 'asDefault');
const PANELS = paneMapFrom('src/components/layout/ToolWorkspace.tsx', 'PDF_PANELS', 'named');

/** Ids the catalogue folds into another tool, so they are never listed or counted. */
const aliasIds = PDF_TOOLS.filter((tool: PdfToolDefinition) => isToolAlias(tool.id)).map((tool: PdfToolDefinition) => tool.id);

/** The ids a card, a palette row or a bookmark can open, one per job. */
const catalogueIds = TOOL_CATALOGUE.map((tool: PdfToolDefinition) => tool.id);

const bespokeIds = new Set<string>([
  ...PDF_TOOLS.filter((tool: PdfToolDefinition) => Boolean(tool.mainComponent)).map((tool: PdfToolDefinition) => tool.id),
  ...MAIN_VIEWS.map((route: PaneRoute) => route.id),
  ...PANELS.map((route: PaneRoute) => route.id),
]);

const bespoke = PDF_TOOLS.filter((tool: PdfToolDefinition) => bespokeIds.has(tool.id));
const generated = PDF_TOOLS.filter((tool: PdfToolDefinition) => !bespokeIds.has(tool.id));

/**
 * The tools the generated page does not own, by id.
 *
 * `redact` and `compare` are folded ids: their routes answer at the canonical
 * address, but the pane maps still resolve them, because a definition looked up
 * directly by id has to keep working.
 */
const EXPECTED_BESPOKE = [
  'add-stamps',
  'compare',
  'compare-pdfs',
  'edit-pdf',
  'edit-pdf-text',
  'form-creator',
  'form-filler',
  'organize',
  'pdf-crop',
  'redact',
  'redact-pdf',
  'scan-to-pdf',
  'sign',
];

/**
 * Keys in the shell's pane maps that no registered tool answers.
 *
 * The list is empty and that is the finding: an entry here is a live defect, not a
 * backlog item. `crop` was the one that cost a user something — the video tools use
 * that id, and the shell renders the panel map in the same sidebar as the video
 * component, so the video Crop page grew a second, PDF-shaped control set.
 * `annotate` and `pdf-compare` were keys left behind when those ids were settled:
 * dead code that reads like a live surface. Closing an entry meant deleting the
 * key, and a fourth key cannot appear quietly.
 */
const STRANDED_PANE_KEYS: string[] = [];

/** One sample document, reused for every tool. */
let sample: File;

function surface(): Element | null {
  return document.querySelector('[data-surface]');
}

function loadFile(): void {
  act(() => {
    // Deliberately not a parseable PDF: the pre-flight then reports "unknown page
    // count" instead of spending one document parse per tool on a fact this file
    // does not assert. The shape under test is the page, not the engine.
    useFileStore.setState({ file: sample, files: [sample], metadata: null });
  });
}

/** Back to a clean slate between tools; a leaked `done` is a false result screen. */
function resetStores(): void {
  useProcessStore.getState().reset();
  useProcessStore.setState({ activeTool: null, sessions: {}, notice: null });
  useFileStore.setState({ file: null, files: [], metadata: null, activeTool: null, sessions: {} });
}

/** Put the store where a finished run leaves it, without running an engine. */
function finishRun(): void {
  act(() => {
    const store = useProcessStore.getState();
    store.setOutput(new Blob(['%PDF-1.7 output'], { type: 'application/pdf' }), 'blob:parity', 'result.pdf');
    store.complete('Done.');
    store.setPhase('done');
  });
}

function toolPage(toolId: string) {
  return render(createElement(PdfToolPanel, { toolId }));
}

/**
 * Where the router actually ended up.
 *
 * A folded id is allowed to move the page, so "the alias still routes" needs the
 * resolved address, not just the address that was asked for.
 */
let routedPath = '';

function RouteProbe() {
  routedPath = useLocation().pathname;
  return null;
}

function routePage(toolId: string) {
  routedPath = `/tool/${toolId}`;
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: [`/tool/${toolId}`] },
      createElement(RouteProbe, null),
      createElement(
        Routes,
        null,
        createElement(Route, { path: '/tool/:toolId', element: createElement(ToolWorkspace) }),
      ),
    ),
  );
}

beforeAll(async () => {
  URL.createObjectURL = vi.fn(() => 'blob:parity') as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  // A header and nothing else. The pre-flight cannot read a page count out of it,
  // which is the state a real file passes through anyway, and the whole-catalogue
  // sweeps do not each pay for a document parse.
  sample = new File(['%PDF-1.4\n'], 'quarterly-report.pdf', { type: 'application/pdf' });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  useProcessStore.getState().reset();
  useProcessStore.setState({ activeTool: null, sessions: {}, notice: null });
  useFileStore.setState({ file: null, files: [], metadata: null, activeTool: null, sessions: {} });
});

describe('the catalogue lists jobs, not ids', () => {
  it('names each tool exactly once', () => {
    // Two definitions with one display name is how the same tool ended up as two
    // cards and two palette rows: the visitor cannot tell which one to trust,
    // and every count built on the list is a lie by one.
    const seen = new Map<string, string[]>();
    for (const tool of TOOL_CATALOGUE) {
      const key = tool.name.trim().toLowerCase();
      seen.set(key, [...(seen.get(key) ?? []), tool.id]);
    }
    const clashes = [...seen]
      .filter((entry: [string, string[]]) => entry[1].length > 1)
      .map(([name, ids]: [string, string[]]) => `${name}: ${ids.join(', ')}`);
    expect(clashes).toEqual([]);
  });

  it('folds the secondary ids out of the list and the count', () => {
    // The fold is registry metadata, not a dashboard patch: whatever asks, it
    // gets the same answer, and the count follows the list rather than the file.
    expect(aliasIds.length).toBeGreaterThan(0);
    expect(catalogueIds.some((id: string) => aliasIds.includes(id))).toBe(false);
    expect(TOOL_CATALOGUE.length).toBe(PDF_TOOLS.length - aliasIds.length);
    for (const alias of aliasIds) {
      const canonical = canonicalToolId(alias);
      expect(canonical, `${alias} folds to itself`).not.toBe(alias);
      expect(getPdfTool(canonical), `${alias} → ${canonical} is not a registered tool`).toBeTruthy();
      expect(isToolAlias(canonical), `${canonical} is itself an alias`).toBe(false);
      // The old spelling is still a tool the registry can answer for.
      expect(getPdfTool(alias), `${alias} is no longer resolvable`).toBeTruthy();
    }
  });

  it('resolves every catalogue entry to a surface a visitor can use', () => {
    const unreachable = TOOL_CATALOGUE.filter(
      (tool: PdfToolDefinition) =>
        !tool.run
        && !tool.mainComponent
        && !tool.unavailable
        && !hasCustomMainView(tool.id)
        && !PANELS.some((route: PaneRoute) => route.id === tool.id),
    ).map((tool: PdfToolDefinition) => tool.id);
    expect(unreachable).toEqual([]);
  });

  it('routes a folded id to the tool that owns the job', async () => {
    const problems: string[] = [];
    for (const alias of aliasIds) {
      const canonical = canonicalToolId(alias);
      routePage(alias);
      try {
        // The URL the visitor shared stays valid, the page it lands on is the
        // canonical one, and the session key — which the star and the recents
        // hang off — is the canonical tool too, not a second memory for one job.
        await waitFor(() => {
          expect(routedPath).toBe(`/tool/${canonical}`);
          if (!document.querySelector('[data-intake]')) throw new Error('the canonical page never opened its intake');
        });
        expect(useFileStore.getState().activeTool).toBe(canonical);
      } catch (error) {
        problems.push(`${alias}: ${(error as Error).message}`);
      }
      cleanup();
      resetStores();
    }
    expect(problems).toEqual([]);
  });

  it('keeps the PDF panes out of the video pages', async () => {
    // The shell renders the panel map into the same sidebar as the video
    // component, so a PDF panel keyed by a video id mounts two control sets at
    // once. Read the map out of the source rather than trusting this file's copy.
    const videoIds = new Set(TOOLS.filter((entry) => entry.category === 'video').map((entry) => entry.id));
    const collisions = [...new Set(PANELS.map((route: PaneRoute) => route.id))]
      .filter((id: string) => videoIds.has(id));
    expect(collisions).toEqual([]);

    routePage('crop');
    await screen.findByRole('button', { name: '9:16 (TikTok / Reels)' });
    // A PDF panel would have said "Loading controls…" and then its own run
    // button, whose id the shared rail also uses for `#tool-process-btn`.
    expect(screen.queryByText(/Loading controls/)).toBeNull();
    expect(document.querySelector('#tool-process-btn, [data-crop-kept], [data-crop-doc-pages]')).toBeNull();
    expect(screen.queryByText(/No PDF is loaded/)).toBeNull();
    cleanup();
  });
});

describe('the catalogue divides cleanly', () => {
  it('is the whole registry, counted once', () => {
    expect(bespoke.length + generated.length).toBe(PDF_TOOLS.length);
    expect(PDF_TOOLS.length).toBeGreaterThan(100);
  });

  it('lists its exceptions by id, and no others', () => {
    // Adding a bespoke pane is a deliberate act; this forces it to be written down.
    const routed = [...bespokeIds].filter((id: string) => Boolean(getPdfTool(id))).sort();
    expect(routed).toEqual(EXPECTED_BESPOKE.filter((id: string) => Boolean(getPdfTool(id))).sort());
  });

  it('names the tools that would open on an unstyled fallback', () => {
    // Neither generated nor bespoke-capable: no `run`, no main component, no pane in
    // either map, and no `unavailable` sentence to print in its place.
    const deadWeight = PDF_TOOLS.filter(
      (tool: PdfToolDefinition) =>
        !tool.run && !tool.mainComponent && !bespokeIds.has(tool.id) && !tool.unavailable,
    ).map((tool: PdfToolDefinition) => tool.id);
    expect(deadWeight).toEqual([]);
  });

  it('resolves every bespoke id to a module and an export that exist', async () => {
    const routes: PaneRoute[] = [...MAIN_VIEWS, ...PANELS];
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      const path = route.module.replace(/^@\//, '../../src/');
      const module = (await import(/* @vite-ignore */ path)) as Record<string, unknown>;
      const component = route.export === 'default' ? module.default : module[route.export];
      expect(typeof component, `${route.id} → ${route.module}#${route.export}`).toBe('function');
    }
  });

  it('keeps every pane route pointed at a tool that is still registered', () => {
    // A map entry whose id was renamed or deleted is dead code that also strands the
    // route on the generic viewer, which is the unstyled fallback this file hunts.
    const stranded = [...MAIN_VIEWS, ...PANELS]
      .filter((route: PaneRoute) => !getPdfTool(route.id))
      .map((route: PaneRoute) => route.id)
      .sort();
    expect(stranded).toEqual(STRANDED_PANE_KEYS);
  });

  it('gives every bespoke tool a promise and a verb anyway', () => {
    // The pane owns its controls, but it shares the intake and the result screen,
    // and both print these two strings.
    const missing = bespoke
      .filter((tool: PdfToolDefinition) => !tool.promise?.trim() || !tool.actionLabel?.trim())
      .map((tool: PdfToolDefinition) => tool.id);
    expect(missing).toEqual([]);
  });
});

describe('the intake state, for every generated tool', () => {
  it('offers one action, one promise and nothing else', async () => {
    const problems: string[] = [];
    for (const tool of generated) {
      toolPage(tool.id);
      try {
        // The definition arrives through a dynamic import, so wait until the page is
        // holding this tool before judging it.
        await screen.findByRole('heading', { level: 1, name: tool.name }, { timeout: 4000 });
      } catch {
        problems.push(`${tool.id}: the intake never printed its title`);
        cleanup();
        continue;
      }

      if (surface()?.getAttribute('data-surface') !== 'intake') {
        problems.push(`${tool.id}: opened on "${surface()?.getAttribute('data-surface')}" instead of intake`);
      }

      const drop = document.querySelectorAll('[data-drop-target]');
      if (drop.length !== 1) problems.push(`${tool.id}: ${drop.length} primary actions on the empty page`);

      const promise = document.querySelector('[data-intake] p');
      if (!promise) problems.push(`${tool.id}: no promise line under the title`);
      else if ((promise.textContent ?? '').trim() !== promiseFor(tool)) {
        problems.push(`${tool.id}: promise reads "${promise.textContent}" not "${promiseFor(tool)}"`);
      }

      // Nothing may compete with the one decision the page is asking for.
      const competing: Record<string, number> = {
        'an options panel': document.querySelectorAll('[data-options-panel]').length,
        'a run bar': document.querySelectorAll('[data-run-bar]').length,
        'a run button': document.querySelectorAll('#tool-process-btn').length,
        'a progress bar': document.querySelectorAll('[role="progressbar"]').length,
        'a file card': document.querySelectorAll('[data-card]').length,
      };
      for (const [name, count] of Object.entries(competing)) {
        if (count > 0) problems.push(`${tool.id}: ${name} visible before a file was chosen`);
      }
      if (document.querySelector('aside')) problems.push(`${tool.id}: a settings rail came back`);
      cleanup();
    }
    expect(problems).toEqual([]);
  });

  it('asks each tool for the format it can read', async () => {
    const problems: string[] = [];
    for (const tool of generated) {
      toolPage(tool.id);
      await screen.findByRole('heading', { level: 1, name: tool.name }, { timeout: 4000 });
      const input = document.querySelector('input[type="file"]');
      const expected = (tool.accept ?? '.pdf,application/pdf').toLowerCase();
      const actual = (input?.getAttribute('accept') ?? '').toLowerCase();
      if (actual !== expected) problems.push(`${tool.id}: the picker accepts "${actual}", not "${expected}"`);
      cleanup();
    }
    expect(problems).toEqual([]);
  });
});

describe('a loaded file and a finished run, for every generated tool', () => {
  /**
   * ~110 mounts is a minute of work, so the sweep is cut into labelled batches.
   *
   * One test for the whole catalogue means the first slow tool hides every tool
   * behind it; a named batch says which stretch of the registry broke.
   */
  const BATCH = 20;
  for (let start = 0; start < generated.length; start += BATCH) {
    const batch = generated.slice(start, start + BATCH);
    it(`shows the cards, the pinned verb and the result screen — tools ${start + 1} to ${start + batch.length}`, async () => {
      const problems: string[] = [];
      for (const tool of batch) {
        loadFile();
        toolPage(tool.id);
        try {
          await waitFor(
            () => {
              if (!document.querySelector('[data-run-bar]')) throw new Error('no options bar');
              const button = document.getElementById('tool-process-btn');
              if (!button) throw new Error('no pinned primary action');
              if ((button.textContent ?? '').trim() !== verbFor(tool)) {
                throw new Error(`verb reads "${button.textContent}" not "${verbFor(tool)}"`);
              }
              if (!document.querySelector('[data-card]')) throw new Error('no file card');
            },
            { timeout: 3000, interval: 25 },
          );
          if (surface()?.getAttribute('data-surface') !== 'ready') problems.push(`${tool.id}: never reached the ready state`);

          finishRun();
          await waitFor(
            () => {
              if (surface()?.getAttribute('data-surface') !== 'result') throw new Error('still not on the result screen');
            },
            { timeout: 3000, interval: 25 },
          );
          if (!document.querySelector('[data-checkmark]')) problems.push(`${tool.id}: the result screen has no confirmation`);
          if (![...document.querySelectorAll('button, a')].some((node: Element) => /download/i.test(node.textContent ?? ''))) {
            problems.push(`${tool.id}: the result screen offers no download`);
          }
        } catch (error) {
          problems.push(`${tool.id}: ${(error as Error).message}`);
        }
        cleanup();
        resetStores();
      }
      expect(problems).toEqual([]);
    }, 180_000);
  }

  it('reaches it for every tool that can run, which is all but the refused ones', () => {
    const runnable = generated.filter((tool: PdfToolDefinition) => Boolean(tool.run));
    expect(runnable.length).toBeGreaterThan(100);
    const refused = generated.filter((tool: PdfToolDefinition) => !tool.run);
    expect(refused.every((tool: PdfToolDefinition) => Boolean(tool.unavailable))).toBe(true);
  });

  it('explains a tool it cannot run instead of showing a live button', async () => {
    const refused = generated.filter((tool: PdfToolDefinition) => !tool.run);
    expect(refused.length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const tool of refused) {
      loadFile();
      toolPage(tool.id);
      const button = (await screen.findByRole('button', { name: verbFor(tool) })) as HTMLButtonElement;
      await waitFor(() => expect(button.disabled).toBe(true));
      const reason = document.getElementById('tool-run-reason')?.textContent ?? '';
      const opening = String(tool.unavailable).slice(0, 24).toLowerCase();
      if (!reason.toLowerCase().includes(opening)) {
        problems.push(`${tool.id}: the disabled button says "${reason}" instead of explaining itself`);
      }
      cleanup();
    }
    expect(problems).toEqual([]);
  }, 120_000);
});

describe('the bespoke surfaces', () => {
  /**
   * Panes the shell opens on their own surface rather than on the shared intake.
   *
   * `ToolWorkspace` carves out `isImageTool` and `isNoFileTool`: the Scan camera and
   * the typed-HTML source work with nothing loaded, so an intake that asks for a PDF
   * first would be a lie. Written down by id so the exception stays auditable; the
   * test below still requires each of them to mount a real surface.
   */
  const PANE_WITHOUT_INTAKE = ['scan-to-pdf'];

  it('opens on the same intake as every other tool', async () => {
    const problems: string[] = [];
    for (const tool of bespoke) {
      // `crop` is a video id that the panel map also answers; it has no PDF definition.
      if (!getPdfTool(tool.id)) continue;
      routePage(tool.id);
      try {
        await waitFor(
          () => {
            if (document.body.textContent?.includes('Tool not found')) throw new Error('fell through to not-found');
            if (PANE_WITHOUT_INTAKE.includes(tool.id)) {
              if (document.body.children.length === 0) throw new Error('nothing mounted');
              return;
            }
            if (!document.querySelector('[data-intake]')) throw new Error('the route did not open on an intake');
          },
          { timeout: 6000 },
        );
        if (!PANE_WITHOUT_INTAKE.includes(tool.id) && document.querySelectorAll('[data-drop-target]').length !== 1) {
          problems.push(`${tool.id}: the intake is not one primary action`);
        }
      } catch (error) {
        problems.push(`${tool.id}: ${(error as Error).message}`);
      }
      cleanup();
    }
    expect(problems).toEqual([]);
  }, 180_000);

  it('mounts the real pane once a file exists, instead of an empty room', async () => {
    const problems: string[] = [];
    for (const tool of bespoke) {
      if (!getPdfTool(tool.id)) continue;
      // The route first, the file second — the order a visitor uses. Going the other
      // way lands on `file-store`'s per-tool session restore, which clears a file
      // that was never part of this tool's session.
      routePage(tool.id);
      try {
        await waitFor(
          () => {
            if (document.body.children.length === 0) throw new Error('the route mounted nothing');
          },
          { timeout: 8000 },
        );
        act(() => {
          useFileStore.getState().setActiveTool(tool.id as never);
          useFileStore.getState().setFiles([sample]);
        });
        await waitFor(
          () => {
            if (document.querySelector('[data-intake]')) throw new Error('still on the intake with a file loaded');
            if (document.body.textContent?.includes('Tool not found')) throw new Error('fell through to not-found');
          },
          { timeout: 12_000 },
        );
      } catch (error) {
        problems.push(`${tool.id}: ${(error as Error).message}`);
      }
      cleanup();
      resetStores();
    }
    expect(problems).toEqual([]);
  }, 240_000);

  it('is registered with the shell for each of the listed ids', () => {
    for (const id of EXPECTED_BESPOKE) {
      const routed = Boolean(mainViewFor(id)) || PANELS.some((route: PaneRoute) => route.id === id);
      expect(routed, `${id} has no pane the shell can load`).toBe(true);
    }
  });
});

describe('the dashboard covers the catalogue it claims to', () => {
  it('groups every tool into exactly one job', () => {
    const shelves = TOOL_JOBS.flatMap((job) => job.toolIds);
    const duplicated = shelves.filter((id: string, index: number) => shelves.indexOf(id) !== index);
    expect(duplicated).toEqual([]);
    const missing = catalogueIds.filter((id: string) => !shelves.includes(id));
    expect(missing).toEqual([]);
    const ghost = shelves.filter((id: string) => !getPdfTool(id));
    expect(ghost).toEqual([]);
    // A folded id has no card to open, so it is not a shelf item either; the
    // registry decides that, and the shelves follow.
    expect(shelves.filter((id: string) => isToolAlias(id))).toEqual([]);
  });

  it('shows one card per job, and no job is named after a module', () => {
    const cards = cardEntries();
    expect(cards.length).toBe(TOOL_CATALOGUE.length);
    for (const alias of aliasIds) {
      expect(cards.some((entry) => entry.tool.id === alias), `${alias} should not have its own card`).toBe(false);
    }
    render(createElement(MemoryRouter, null, createElement(PdfDashboard)));
    const buttons = [...document.querySelectorAll('button[data-tool]')];
    expect(buttons.length).toBe(cards.length);
    const names = buttons.map((node: Element) => node.querySelector('h3')?.textContent?.trim() ?? '');
    expect(names.filter((name: string, index: number) => names.indexOf(name) !== index)).toEqual([]);
    // The internal category labels are how the code is split, not how a visitor
    // thinks; the shelves must not reprint them.
    for (const heading of TOOL_JOBS.map((job) => job.label)) {
      expect(heading).not.toMatch(/^(Organize|Optimize|Convert to|Convert from|Edit|PDF Security) PDF$/);
    }
    cleanup();
  });

  it('advertises the count of jobs it shows, not the count of ids it stores', () => {
    // The headline is the one number the page claims out loud. Deriving it from
    // the folded catalogue is what keeps it from drifting when a tool gains a
    // second id, or an id is folded away.
    render(createElement(MemoryRouter, null, createElement(PdfDashboard)));
    const line = [...document.querySelectorAll('p')].find((node: Element) =>
      /tools that run on your own computer/i.test(node.textContent ?? ''),
    );
    expect(line?.textContent).toContain(`${TOOL_CATALOGUE.length} tools`);
    expect(line?.textContent).not.toContain(`${PDF_TOOLS.length} tools`);
    cleanup();
  });

  it('says, where the user decides, that nothing is uploaded', () => {
    render(createElement(MemoryRouter, null, createElement(PdfDashboard)));
    expect(screen.getByText(/no upload/i)).toBeInTheDocument();
    expect(screen.getByText(/never sent anywhere|never leaves/i)).toBeInTheDocument();
    cleanup();
  });

  it('answers a job word, not just a tool name', async () => {
    render(createElement(MemoryRouter, null, createElement(PdfDashboard)));
    const field = screen.getByRole('searchbox', { name: /search the pdf tools/i });
    fireEvent.change(field, { target: { value: 'make this smaller' } });
    await waitFor(() => {
      const first = document.querySelector('button[data-tool]');
      if (!first) throw new Error('the search returned no cards');
      expect(first.getAttribute('data-tool')).toBe('pdf-compress');
    });
    cleanup();
  });

  it('keeps every card on a shelf that is labelled', () => {
    render(createElement(MemoryRouter, null, createElement(PdfDashboard)));
    const sections = [...document.querySelectorAll('section[aria-labelledby]')];
    expect(sections.length).toBe(TOOL_JOBS.length);
    for (const section of sections) {
      const id = section.getAttribute('aria-labelledby');
      expect(document.getElementById(String(id))?.textContent).toBeTruthy();
    }
    cleanup();
  });
});
