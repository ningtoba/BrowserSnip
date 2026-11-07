/**
 * The single source of truth for PDF tools.
 *
 * The dashboard cards, the sidebar form, the workspace routing, the output
 * filename and the `ToolId` union are all derived from this list. Adding a
 * tool means adding one definition — nothing else in the app has to change.
 *
 * `PDF_TOOLS` is every id that answers a lookup; `TOOL_CATALOGUE` is the subset
 * the app shows and counts, with the secondary spellings in `TOOL_ALIASES`
 * folded into the tool that owns each job. A tool that is the same job as
 * another one is declared there rather than given a second card.
 */
import { lazy } from 'react';
import type { ComponentType } from 'react';
import { organizeTools } from './organize';
import { optimizeTools } from './optimize';
import { editTools } from './edit';
import { securityTools } from './security';
import { convertToTools } from './convert-to';
import { convertFromTools } from './convert-from';
import { legacyTools } from './legacy';
import { legacyOfficeTools, officeTools } from './office';

import type { PdfToolCategory, PdfToolDefinition, ToolField, ToolValues } from './types';

const GROUPS = [
  organizeTools,
  optimizeTools,
  editTools,
  securityTools,
  convertToTools,
  convertFromTools,
  officeTools,
  legacyOfficeTools,
  legacyTools,
] as const;

/**
 * Flatten the groups and refuse silent shadowing.
 *
 * Two tools with the same id used to be possible — the dashboard showed both
 * cards and only the last one's handler ever ran, so a tool could look broken at
 * random. A duplicate is a build-time mistake, so it is reported loudly.
 */
function flattenGroups(groups: readonly PdfToolDefinition[][]): PdfToolDefinition[] {
  const byId = new Map<string, PdfToolDefinition>();
  const duplicates: string[] = [];
  for (const tool of groups.flat()) {
    const existing = byId.get(tool.id);
    if (existing) {
      duplicates.push(`${tool.id} (in "${existing.category}" and "${tool.category}")`);
      // The more specific definition wins: a hand-written tool beats a legacy
      // placeholder that only names the id.
      if (!existing.run && tool.run) byId.set(tool.id, tool);
      continue;
    }
    byId.set(tool.id, tool);
  }
  if (duplicates.length > 0 && import.meta.env.DEV) {
    console.warn(
      `[BrowserSnip] duplicate PDF tool ids registered: ${duplicates.join(', ')}. The first definition wins.`,
    );
  }
  return [...byId.values()];
}

/** Every PDF tool definition, in dashboard order. */
export const PDF_TOOLS: PdfToolDefinition[] = flattenGroups(GROUPS);

export type PdfToolId = (typeof PDF_TOOLS)[number]['id'];

const BY_ID = new Map<string, PdfToolDefinition>(PDF_TOOLS.map((tool) => [tool.id, tool]));

export function getPdfTool(id: string | undefined | null): PdfToolDefinition | undefined {
  if (!id) return undefined;
  return BY_ID.get(id);
}

/**
 * Secondary spellings of a tool that is already in the catalogue.
 *
 * `redact` and `compare` were registered before `redact-pdf` and `compare-pdfs`,
 * and the older ids have to keep answering their URLs — bookmarks and shared
 * links point at them, so deleting a definition would 404 someone's saved page.
 * But they are the same job under the same display name, and a list that shows
 * both shows a visitor two identical cards. The fold therefore lives here, once:
 * the definitions stay addressable by id (the runner and the tool tests drive
 * them directly), while everything that *counts or lists* reads `TOOL_CATALOGUE`
 * and everything that *routes* resolves through `canonicalToolId` first.
 */
const TOOL_ALIASES: Record<string, string> = {
  redact: 'redact-pdf',
  compare: 'compare-pdfs',
};

/** The id that owns this job: an alias answers with its canonical tool, all others with themselves. */
export function canonicalToolId(id: string): string {
  // `hasOwnProperty`, not `in`: an id like `constructor` would otherwise read the
  // object's own prototype and be folded into a function.
  const target = Object.prototype.hasOwnProperty.call(TOOL_ALIASES, id) ? TOOL_ALIASES[id] : undefined;
  return target && BY_ID.has(target) ? target : id;
}

/** Whether `id` is a secondary spelling that the catalogue must not list twice. */
export function isToolAlias(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_ALIASES, id);
}

/**
 * The public catalogue: one entry per job, aliases folded away.
 *
 * The dashboard cards, the ⌘K palette and every "N tools" sentence derive from
 * this list, so the number the app advertises is the number of things a visitor
 * can actually do.
 */
export const TOOL_CATALOGUE: PdfToolDefinition[] = PDF_TOOLS.filter(
  (tool) => !isToolAlias(tool.id),
);

if (import.meta.env.DEV) {
  for (const [alias, target] of Object.entries(TOOL_ALIASES)) {
    if (!BY_ID.has(target)) {
      console.warn(`[BrowserSnip] the alias "${alias}" points at "${target}", which is not a registered tool id.`);
    }
    if (Object.prototype.hasOwnProperty.call(TOOL_ALIASES, target)) {
      console.warn(`[BrowserSnip] the alias "${alias}" chains to "${target}", which is itself an alias; name the canonical tool.`);
    }
  }
}

export function isPdfToolId(id: string): id is PdfToolId {
  return BY_ID.has(id);
}

export const PDF_CATEGORIES: { id: PdfToolCategory; label: string; icon: string; blurb: string }[] = [
  {
    id: 'organize',
    label: 'Organize PDF',
    icon: '📑',
    blurb: 'Merge, split, reorder, rotate and impose pages.',
  },
  {
    id: 'optimize',
    label: 'Optimize PDF',
    icon: '⚡',
    blurb: 'Shrink, repair, clean and future-proof files.',
  },
  {
    id: 'convert-to',
    label: 'Convert to PDF',
    icon: '📥',
    blurb: 'Turn images, text, markup and documents into PDF.',
  },
  {
    id: 'convert-from',
    label: 'Convert from PDF',
    icon: '📤',
    blurb: 'Get text, tables, images and data back out.',
  },
  {
    id: 'edit',
    label: 'Edit PDF',
    icon: '✏️',
    blurb: 'Annotate, redact, stamp, number and rewrite content.',
  },
  {
    id: 'security',
    label: 'PDF Security',
    icon: '🔒',
    blurb: 'Passwords, permissions, signatures and sanitizing.',
  },
];

export type { PdfToolCategory, PdfToolDefinition, ToolField, ToolValues };

export function toolsByCategory(category: PdfToolCategory): PdfToolDefinition[] {
  return PDF_TOOLS.filter((tool) => tool.category === category);
}

/**
 * Search across name, description, keywords and category.
 *
 * Answers with every id, aliases included, because a caller looking up one
 * legacy id by name should still find it. The lists a visitor reads — the
 * dashboard and the palette — search `TOOL_CATALOGUE` instead.
 */
export function searchTools(query: string): PdfToolDefinition[] {
  const q = query.trim().toLowerCase();
  if (!q) return PDF_TOOLS;
  return PDF_TOOLS.filter((tool) => {
    const haystack = [
      tool.name,
      tool.description,
      tool.category,
      ...(tool.keywords ?? []),
    ]
      .join(' ')
      .toLowerCase();
    return q.split(/\s+/).every((word) => haystack.includes(word));
  });
}

/** Initial form state for a tool, from its field defaults. */
export function initialValues(tool: PdfToolDefinition | undefined): ToolValues {
  const values: ToolValues = {};
  for (const field of tool?.fields ?? []) {
    values[field.key] = field.default ?? null;
  }
  return values;
}

export function visibleFields(
  tool: PdfToolDefinition | undefined,
  values: ToolValues,
): ToolField[] {
  return (tool?.fields ?? []).filter((field) => !field.when || field.when(values));
}

/**
 * Bespoke full-pane editors, keyed by tool id. Loaded lazily so the annotation
 * and content editors — the two heaviest components — never block the first
 * paint of a simple tool like Rotate. Each adapter names the exact export so a
 * renamed component fails loudly here instead of rendering a blank pane.
 */
const MAIN_VIEWS: Record<string, LazyExoticType> = {
  organize: lazy(() => import('@/components/tools/pdf/organize/PageOrganizer')),
  'pdf-crop': lazy(() => import('@/components/tools/pdf/edit/CropMain').then(asDefault('CropMain'))),
  sign: lazy(() => import('@/components/tools/pdf/security/SignMain').then(asDefault('SignMain'))),
  redact: lazy(() => import('@/components/tools/pdf/security/RedactMain').then(asDefault('RedactMain'))),
  'redact-pdf': lazy(() => import('@/components/tools/pdf/security/RedactMain').then(asDefault('RedactMain'))),
  compare: lazy(() => import('@/components/tools/pdf/security/CompareMain').then(asDefault('CompareMain'))),
  'compare-pdfs': lazy(() => import('@/components/tools/pdf/security/CompareMain').then(asDefault('CompareMain'))),
  'scan-to-pdf': lazy(() => import('@/components/tools/pdf/scan/ScanMain').then(asDefault('ScanMain'))),
  'edit-pdf': lazy(() => import('@/components/tools/pdf/editor/AnnotationEditor').then(asDefault('AnnotationEditor'))),
  'add-stamps': lazy(() => import('@/components/tools/pdf/editor/AnnotationEditor').then(asDefault('AnnotationEditor'))),
  'edit-pdf-text': lazy(() => import('@/components/tools/pdf/text-editor/TextEditor').then(asDefault('TextEditor'))),
  'form-filler': lazy(() => import('@/components/tools/pdf/edit/FormFillMain')),
  'form-creator': lazy(() => import('@/components/tools/pdf/edit/FormCreatorMain')),
};

/** The component type produced by `lazy()`, without re-importing React's internals. */
type LazyExoticType = ComponentType<Record<string, unknown>>;

/** Adapt a module with a named export to the default-export shape `lazy` needs. */
function asDefault<K extends string>(name: K) {
  return (module: Record<string, unknown>) => {
    const component = module[name];
    if (typeof component !== 'function') {
      throw new Error(`Expected a named export "${name}" from the tool's main view module.`);
    }
    return { default: component as ComponentType<Record<string, unknown>> };
  };
}

export function mainViewFor(
  id: string,
): ComponentType<Record<string, unknown>> | undefined {
  return MAIN_VIEWS[id];
}

/** Tools whose pane replaces the generic preview entirely. */
export function hasCustomMainView(id: string): boolean {
  return id in MAIN_VIEWS;
}

/** Filename suffix, resolved from the tool definition rather than a switch. */
export function suffixFor(id: string): string {
  return getPdfTool(id)?.outputSuffix ?? '_processed.pdf';
}

/** Engines a tool needs, so the workspace can warn before a long run. */
export function enginesFor(id: string) {
  return getPdfTool(id)?.engines ?? [];
}

